from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Set

from core.user_modes.base_strategy import BaseUserModeStrategy
from utils.logger import setup_logger

logger = setup_logger("PostUserModeStrategy")


class PostUserModeStrategy(BaseUserModeStrategy):
    mode_name = "post"
    api_method_name = "get_user_post"

    async def _load_existing_aweme_ids(self, sec_uid: str) -> Set[str]:
        """加载该博主在数据库中已下载的作品 ID 集合。

        注意：这里只统计当前博主的数据库记录，不把全局本地文件索引合并进来，
        否则会把输出目录下所有作者的文件数量误报为当前博主的已下载数。
        单个作品实际下载时仍会通过 _should_download 检查本地文件，避免重复下载。
        """
        existing: Set[str] = set()
        downloader = self.downloader

        # 数据库：aweme 表 + download_history 成功记录，按 sec_uid 过滤
        if downloader.database is not None:
            try:
                existing.update(
                    await downloader.database.get_downloaded_aweme_id_set_for_authors([sec_uid])
                )
            except Exception as exc:
                logger.debug("Failed to load existing aweme ids from database: %s", exc)

        return existing

    @staticmethod
    def _page_has_new_items(page_items: List[Dict[str, Any]], existing_ids: Set[str]) -> bool:
        """判断当前页是否包含未下载的新作品。"""
        if not existing_ids:
            return True
        for item in page_items:
            aweme_id = str(item.get("aweme_id") or "").strip()
            if aweme_id and aweme_id not in existing_ids:
                return True
        return False

    async def collect_items(self, sec_uid: str, user_info: Dict[str, Any]) -> List[Dict[str, Any]]:
        fetcher = getattr(self.downloader.api_client, self.api_method_name, None)
        if not callable(fetcher):
            logger.error("API client missing get_user_post")
            return []

        aweme_list: List[Dict[str, Any]] = []
        max_cursor = 0
        has_more = True

        number_limit = int(self.downloader.config.get("number", {}).get(self.mode_name, 0) or 0)
        media_filter_enabled = self._media_type_filter_enabled()

        # 抖音接口偶发空页 / 游标卡住，先重试再停止。
        max_api_retries = 3
        retry_count = 0
        processed_cursors: set[int] = set()

        # 风控标记：接口对「登录失效/验证码」通常不报错，而是静默返回空列表，
        # 需要靠响应里的风险标记在最终失败时给出明确诊断。
        saw_login_tip = False
        saw_verify_page = False

        existing_ids = await self._load_existing_aweme_ids(sec_uid)
        if existing_ids:
            self.downloader._progress_update_step(
                "拉取作品列表", f"已记录 {len(existing_ids)} 个已下载作品，下载时将自动跳过"
            )
        else:
            self.downloader._progress_update_step("拉取作品列表", "分页抓取中")

        bridge_blocked = False
        while has_more:
            await self.downloader.rate_limiter.acquire()
            request_cursor = max_cursor
            page_data = await fetcher(sec_uid, request_cursor, 18)
            page = self._normalize_page_data(page_data)
            # 页面通道（/v1/browser-fetch 注入的 fetch/XHR/导航）会被抖音 Argus 风控确定性拒绝，
            # 因为抖音 SDK 不会给注入请求补签名（见 main.js 注释）。这类失败是确定性的，
            # 不应徒劳重试，而是中止分页、改走 CDP 浏览器采集兜底（拦截抖音自有签名请求）。
            gated_msg = self._gated_error_message(page, "拉取作品列表失败")
            if gated_msg:
                logger.warning("%s；改走浏览器采集兜底。", gated_msg)
                self.downloader._progress_update_step(
                    "拉取作品列表",
                    "页面通道被抖音风控拦截，改用浏览器窗口采集作品",
                )
                bridge_blocked = True
                break
            page_items = self.select_items(page)

            risk_flags = page.get("risk_flags") or {}
            if risk_flags.get("login_tip"):
                saw_login_tip = True
            if risk_flags.get("verify_page"):
                saw_verify_page = True

            if not page_items:
                if page.get("status_code") == 0 and retry_count < max_api_retries:
                    retry_count += 1
                    await asyncio.sleep(0.8 + retry_count * 0.7)
                    self.downloader._progress_update_step(
                        "拉取作品列表",
                        f"接口返回空页，第 {retry_count} 次重试...",
                    )
                    continue
                break

            if request_cursor in processed_cursors:
                # 游标卡住重试时，同一页作品已经加过，避免重复。
                logger.debug("Skipping duplicate cursor %s", request_cursor)
            else:
                # 真正拿到新一页作品时才重置重试计数
                retry_count = 0
                raw_page_count = len(page_items)
                page_items = self._filter_pinned_items(page_items)
                pinned_count = raw_page_count - len(page_items)

                aweme_list.extend(page_items)
                processed_cursors.add(request_cursor)

                detail_parts = [f"已抓取 {len(aweme_list)} 条"]
                if pinned_count > 0:
                    detail_parts.append(f"过滤置顶 {pinned_count} 条")
                if existing_ids and not self._page_has_new_items(page_items, existing_ids):
                    detail_parts.append(f"本页 {len(page_items)} 个已下载，继续翻页")
                self.downloader._progress_update_step("拉取作品列表", "，".join(detail_parts))

            has_more = bool(page.get("has_more", False))
            max_cursor = int(page.get("max_cursor", 0) or 0)
            if has_more and max_cursor == request_cursor:
                if retry_count < max_api_retries:
                    retry_count += 1
                    await asyncio.sleep(0.8 + retry_count * 0.7)
                    self.downloader._progress_update_step(
                        "拉取作品列表",
                        f"游标未推进，第 {retry_count} 次重试...",
                    )
                    continue

                logger.warning(
                    "max_cursor did not advance (%s), stop paging to avoid loop",
                    max_cursor,
                )
                break

            if number_limit > 0:
                if media_filter_enabled:
                    if len(self._filter_by_media_type(aweme_list)) >= number_limit:
                        break
                elif len(aweme_list) >= number_limit:
                    aweme_list = aweme_list[:number_limit]
                    break

        if not aweme_list:
            # API 空页时尝试浏览器兜底采集（可通过弹出的浏览器窗口手动完成
            # 验证码/登录），成功回补则继续下载。
            recover = getattr(self.downloader, "_recover_user_post_with_browser", None)
            if callable(recover):
                try:
                    await recover(sec_uid, user_info, aweme_list)
                except Exception as exc:
                    logger.warning("Browser fallback raised: %s", exc)
                    self.downloader._progress_update_step("浏览器回补", f"失败：{exc}")

        if not aweme_list:
            if bridge_blocked:
                raise RuntimeError(
                    "拉取作品列表失败：桌面端页面通道被抖音 Argus 风控拦截（无法代签请求），"
                    "且浏览器采集兜底也未取到数据。请确认 DRaccoon 主窗口/登录态正常、"
                    "采集窗口未被关闭；若窗口内出现验证码/登录页请手动完成后重试；"
                    "或在设置中开启 browser_fallback.headless=false 重试。"
                )
            raise RuntimeError(self._empty_list_message(saw_login_tip, saw_verify_page))

        return aweme_list

    @staticmethod
    def _empty_list_message(saw_login_tip: bool, saw_verify_page: bool) -> str:
        """根据分页过程中观测到的风控标记给出明确失败原因。"""
        if saw_login_tip:
            return (
                "抖音接口返回空作品列表且提示需要登录：当前 Cookie 已失效，"
                "请重新登录抖音并刷新 Cookie 后重试"
            )
        if saw_verify_page:
            return (
                "抖音接口触发了验证（响应包含验证码/风控票据），"
                "请在浏览器中打开抖音完成验证后重试，或稍后重试"
            )
        return (
            "抖音接口未返回作品列表：该接口已被抖音 Argus 风控拦截（直连请求一律 403），"
            "桌面端 Chromium 窗口与浏览器兜底都未采集到数据。请确认已在软件内登录抖音"
            "（登录态会随软件保存），且采集窗口未被关闭；若窗口内出现验证码/登录页，"
            "请手动完成后重试。如仍失败，可在设置中开启 browser_fallback.headless=false 重试"
        )
