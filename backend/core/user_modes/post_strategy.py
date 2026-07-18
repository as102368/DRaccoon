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
        pagination_restricted = False

        number_limit = int(self.downloader.config.get("number", {}).get(self.mode_name, 0) or 0)
        media_filter_enabled = self._media_type_filter_enabled()

        # 抖音接口偶发空页 / 游标卡住，先重试再判定为受限。
        max_api_retries = 3
        retry_count = 0
        processed_cursors: set[int] = set()

        existing_ids = await self._load_existing_aweme_ids(sec_uid)
        if existing_ids:
            self.downloader._progress_update_step(
                "拉取作品列表", f"已记录 {len(existing_ids)} 个已下载作品，将自动跳过"
            )
        else:
            self.downloader._progress_update_step("拉取作品列表", "分页抓取中")

        while has_more:
            await self.downloader.rate_limiter.acquire()
            request_cursor = max_cursor
            page_data = await fetcher(sec_uid, request_cursor, 18)
            page = self._normalize_page_data(page_data)
            page_items = self.select_items(page)

            if not page_items:
                if page.get("status_code") == 0 and retry_count < max_api_retries:
                    retry_count += 1
                    await asyncio.sleep(0.8 + retry_count * 0.7)
                    self.downloader._progress_update_step(
                        "拉取作品列表",
                        f"接口返回空页，第 {retry_count} 次重试...",
                    )
                    continue

                if page.get("status_code") == 0:
                    pagination_restricted = True
                    logger.warning(
                        "User post page empty at cursor=%s (status_code=0); "
                        "will attempt browser fallback",
                        request_cursor,
                    )
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

                # 作品列表按时间倒序，若当前页全部已下载，后续页不可能再出现新作品，
                # 直接停止翻页，避免无意义请求触发风控/浏览器回补。
                page_has_new = self._page_has_new_items(page_items, existing_ids)
                aweme_list.extend(page_items)
                processed_cursors.add(request_cursor)

                detail_parts = [f"已抓取 {len(aweme_list)} 条"]
                if pinned_count > 0:
                    detail_parts.append(f"过滤置顶 {pinned_count} 条")
                self.downloader._progress_update_step("拉取作品列表", "，".join(detail_parts))

                if not page_has_new:
                    self.downloader._progress_update_step(
                        "拉取作品列表",
                        f"本页 {len(page_items)} 个作品均已下载，停止翻页",
                    )
                    break

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
                pagination_restricted = True
                break

            if number_limit > 0:
                if media_filter_enabled:
                    if len(self._filter_by_media_type(aweme_list)) >= number_limit:
                        break
                elif len(aweme_list) >= number_limit:
                    aweme_list = aweme_list[:number_limit]
                    break

        if pagination_restricted:
            self.downloader._progress_update_step("拉取作品列表", "分页受限，尝试浏览器回补")
            await self.downloader._recover_user_post_with_browser(sec_uid, user_info, aweme_list)
            if not aweme_list:
                raise RuntimeError(
                    "抖音接口未返回作品列表（可能触发了反爬限制），"
                    "请稍后重试或尝试重新登录抖音刷新 Cookie"
                )

        return aweme_list
