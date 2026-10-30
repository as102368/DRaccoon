from __future__ import annotations

from abc import ABC
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Set

from core.downloader_base import DownloadResult
from utils.logger import setup_logger

if TYPE_CHECKING:
    from core.user_downloader import UserDownloader

logger = setup_logger("UserModeStrategy")

_MEDIA_TYPE_CHOICES = {"video", "gallery"}


class BaseUserModeStrategy(ABC):
    mode_name = ""
    api_method_name = ""

    def __init__(self, downloader: "UserDownloader"):
        self.downloader = downloader

    async def download_mode(
        self,
        sec_uid: str,
        user_info: Dict[str, Any],
        seen_aweme_ids: Optional[set[str]] = None,
    ) -> DownloadResult:
        items = await self.collect_items(sec_uid, user_info)
        items = self.apply_filters(items)
        author_name = user_info.get("nickname", "unknown")
        if seen_aweme_ids is None:
            seen_aweme_ids = set()
        return await self.downloader._download_mode_items(
            mode=self.mode_name,
            items=items,
            author_name=author_name,
            seen_aweme_ids=seen_aweme_ids,
            sec_uid=sec_uid,
        )

    async def collect_items(self, sec_uid: str, user_info: Dict[str, Any]) -> List[Dict[str, Any]]:
        return await self._collect_paged_aweme(sec_uid, user_info)

    def apply_filters(self, items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        filtered = self._filter_pinned_items(items)
        filtered = self.downloader._filter_by_time(filtered)
        filtered = self._filter_by_media_type(filtered)
        return self.downloader._limit_count(filtered, self.mode_name)

    def _filter_pinned_items(self, items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        filterer = getattr(self.downloader, "_filter_pinned_items", None)
        if callable(filterer):
            return filterer(items)
        return items

    def _configured_media_types(self) -> Optional[Set[str]]:
        if self.mode_name == "music":
            return None
        raw = self.downloader.config.get("media_types", None)
        if not isinstance(raw, (list, tuple, set)):
            return None
        media_types = {value for value in raw if isinstance(value, str)}
        selected = media_types.intersection(_MEDIA_TYPE_CHOICES)
        if not selected or selected == _MEDIA_TYPE_CHOICES:
            return None
        return selected

    def _media_type_filter_enabled(self) -> bool:
        return self._configured_media_types() is not None

    def _filter_by_media_type(self, items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        selected = self._configured_media_types()
        if selected is None:
            return items
        detector = getattr(self.downloader, "_detect_media_type", None)
        if not callable(detector):
            return items
        return [item for item in items if detector(item) in selected]

    def _gated_error_message(self, page: Dict[str, Any], context: str) -> Optional[str]:
        """若分页响应携带 Argus/bridge/rate-limit 标记，返回对应的明确错误文案；否则返回 None。

        与 _raise_if_gated_error 共享同一套判定，供上层在「确定性失败」时选择
        降级（例如改走 CDP 浏览器采集）而非直接抛异常。
        """
        risk_flags = page.get("risk_flags") or {}
        if risk_flags.get("argus_rejected"):
            return (
                f"{context}：请求被抖音 Argus 风控确定性拒绝（403），页面通道无法代签请求，"
                "重试和重新登录均无效。"
            )
        if risk_flags.get("page_bridge_error"):
            bridge_err = (page.get("raw") or {}).get("error") or "桌面端页面通道异常"
            return f"{context}：{bridge_err}，请检查 DRaccoon 主窗口是否正常运行后重试。"
        if risk_flags.get("rate_limited"):
            return f"{context}：请求触发抖音限流（429），建议降低并发或稍后再试。"
        return None

    def _raise_if_gated_error(self, page: Dict[str, Any], context: str) -> None:
        """如果分页响应携带 Argus/bridge/rate-limit 标记，立即抛出带明确原因的异常。

        避免把「被抖音拒绝」误判成「本页没有作品」，也避免对确定性失败进行徒劳重试。
        """
        msg = self._gated_error_message(page, context)
        if msg:
            raise RuntimeError(msg)

    async def _collect_paged_aweme(
        self, sec_uid: str, user_info: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        fetcher = getattr(self.downloader.api_client, self.api_method_name, None)
        if not callable(fetcher):
            logger.warning(
                "Mode %s skipped: API method %s not implemented",
                self.mode_name,
                self.api_method_name,
            )
            return []

        aweme_list: List[Dict[str, Any]] = []
        max_cursor = 0
        has_more = True
        page_index = 0

        number_limit = int(self.downloader.config.get("number", {}).get(self.mode_name, 0) or 0)
        media_filter_enabled = self._media_type_filter_enabled()
        increase_enabled = bool(
            self.downloader.config.get("increase", {}).get(self.mode_name, False)
        )
        stop_at_downloaded_aweme = (
            increase_enabled and self.mode_name == "like" and self.downloader.database
        )
        latest_time = None
        if increase_enabled and self.downloader.database and not stop_at_downloaded_aweme:
            latest_time = await self.downloader.database.get_latest_aweme_time(user_info.get("uid"))

        while has_more:
            await self.downloader.rate_limiter.acquire()
            request_cursor = max_cursor
            page_data = await fetcher(sec_uid, request_cursor, 20)
            page = self._normalize_page_data(page_data)
            self._raise_if_gated_error(page, f"拉取 {self.mode_name} 列表失败")
            page_items = self.select_items(page)
            if not page_items:
                # 借鉴上游 douyin-downloader：区分「接口请求失败/被风控」与「真的没有作品」。
                # _request_json 在 403（Argus 风控）、非 JSON 响应、重试耗尽时一律静默返回 {}，
                # 规范化后 raw 仍是空字典、不含任何状态字段；真实的「0 作品」成功响应
                # 至少会带 status_code / aweme_list 等键。
                # 此前二者都被当成「无内容」直接 break，导致 mix/music/collect 等走基类
                # 分页的模式「下载返回空值」且毫无提示（like/post 已有各自的兜底逻辑）。
                if page_index == 0 and self._is_blocked_empty_response(page):
                    diag_msg = self._blocked_diagnostic(page)
                    # 通过进度条透出诊断（quiet_logs 下 logger 可能不可见）
                    self.downloader._progress_update_step("拉取作品列表", diag_msg)
                    logger.error(
                        "Mode %s first page empty due to blocked/failed API: %s",
                        self.mode_name,
                        diag_msg,
                    )
                    await self._try_browser_recovery(sec_uid, user_info, aweme_list)
                    if not aweme_list:
                        raise RuntimeError(
                            f"抖音接口未返回 {self.mode_name} 作品列表（{diag_msg}），"
                            "浏览器兜底也未采集到内容。请检查 Cookie 是否有效"
                            "（特别是 sessionid / sid_tt / sid_guard 等登录凭证），"
                            "或重新登录抖音后刷新 Cookie；若遇到验证码，"
                            "请在弹出的浏览器窗口中手动完成验证。"
                        )
                break
            page_index += 1

            if stop_at_downloaded_aweme:
                new_items = []
                for item in page_items:
                    if await self._is_downloaded_aweme(item):
                        break
                    new_items.append(item)
                aweme_list.extend(new_items)
                if len(new_items) < len(page_items):
                    break
            elif increase_enabled and latest_time:
                new_items = [a for a in page_items if a.get("create_time", 0) > latest_time]
                aweme_list.extend(new_items)
                if len(new_items) < len(page_items):
                    break
            else:
                aweme_list.extend(page_items)

            if number_limit > 0:
                if media_filter_enabled:
                    if len(self._filter_by_media_type(aweme_list)) >= number_limit:
                        break
                elif len(aweme_list) >= number_limit:
                    aweme_list = aweme_list[:number_limit]
                    break

            has_more = bool(page.get("has_more", False))
            max_cursor = int(page.get("max_cursor", 0) or 0)
            if has_more and max_cursor == request_cursor:
                logger.warning(
                    "Mode %s cursor did not advance (%s), stop paging",
                    self.mode_name,
                    max_cursor,
                )
                break

        return aweme_list

    @staticmethod
    def _is_blocked_empty_response(page: Dict[str, Any]) -> bool:
        """判断「首页无条目」是接口失败/被风控，还是真的没有作品。

        ``_request_json`` 在被 Argus 风控拦截（403）、响应非 JSON、或重试耗尽时
        一概静默返回 ``{}``；``_normalize_paged_response`` 规范化后其 ``raw`` 仍是
        空字典，且不含 ``status_code`` / ``aweme_list`` 等任何状态字段。
        真实的「0 作品」成功响应至少会带其中一个键。据此即可区分二者。
        """
        raw = page.get("raw")
        if not isinstance(raw, dict) or not raw:
            return True
        return not any(
            key in raw
            for key in ("status_code", "status", "aweme_list", "items", "has_more", "max_cursor")
        )

    def _blocked_diagnostic(self, page: Dict[str, Any]) -> str:
        """生成面向用户的风控/失败诊断文案。

        优先复用已有的 gated 判定（Argus 拒绝 / 页面通道异常 / 限流），
        其次才回落到通用的空响应文案。
        """
        gated = self._gated_error_message(page, f"拉取 {self.mode_name} 列表")
        if gated:
            return gated
        risk_flags = page.get("risk_flags") or {}
        if isinstance(risk_flags, dict):
            if risk_flags.get("login_tip"):
                return "接口返回登录提示（Cookie 登录态已失效）"
            if risk_flags.get("verify_page"):
                return "接口返回验证码（触发风控）"
        status_code = page.get("status_code")
        return f"接口返回空响应（status_code={status_code}，疑似 Argus 风控拦截或 Cookie 失效）"

    async def _try_browser_recovery(
        self,
        sec_uid: str,
        user_info: Dict[str, Any],
        aweme_list: List[Dict[str, Any]],
    ) -> None:
        """若该模式存在浏览器兜底方法（如 _recover_user_like_with_browser），尝试回补。

        当前 post / like 已实现浏览器兜底；其余模式没有对应方法时静默跳过，
        由调用方依据最终是否取到内容决定是否报错。
        """
        recover = getattr(self.downloader, f"_recover_user_{self.mode_name}_with_browser", None)
        if not callable(recover):
            return
        try:
            await recover(sec_uid, user_info, aweme_list)
        except Exception as exc:  # noqa: BLE001 - 兜底失败不应掩盖主流程错误
            logger.warning("Browser recovery failed for mode %s: %s", self.mode_name, exc)

    async def _is_downloaded_aweme(self, item: Dict[str, Any]) -> bool:
        aweme_id = str(item.get("aweme_id") or "").strip()
        if not aweme_id or not self.downloader.database:
            return False
        return await self.downloader.database.is_downloaded(aweme_id)

    def select_items(self, page_data: Dict[str, Any]) -> List[Dict[str, Any]]:
        items = page_data.get("items")
        if isinstance(items, list):
            return [item for item in items if isinstance(item, dict)]
        return []

    async def _collect_paged_entries(
        self,
        fetcher,
        *fetch_args: Any,
        count: int = 20,
    ) -> List[Dict[str, Any]]:
        entries: List[Dict[str, Any]] = []
        max_cursor = 0
        has_more = True

        while has_more:
            await self.downloader.rate_limiter.acquire()
            request_cursor = max_cursor
            page_data = await fetcher(*fetch_args, request_cursor, count)
            page = self._normalize_page_data(page_data)
            self._raise_if_gated_error(page, f"拉取 {self.mode_name} 列表失败")
            page_items = self.select_items(page)
            if not page_items:
                break

            entries.extend(page_items)
            has_more = bool(page.get("has_more", False))
            max_cursor = int(page.get("max_cursor", 0) or 0)
            if has_more and max_cursor == request_cursor:
                logger.warning(
                    "Mode %s cursor did not advance (%s), stop paging",
                    self.mode_name,
                    max_cursor,
                )
                break

        return entries

    async def _expand_metadata_items(
        self,
        raw_items: List[Dict[str, Any]],
        id_field: str,
        id_aliases: List[str],
        fetch_method_name: str,
    ) -> List[Dict[str, Any]]:
        """Shared expansion logic for mix/music strategies that receive metadata
        items instead of aweme items. Fetches the actual aweme list for each
        metadata entry using the given API method."""
        fetcher = getattr(self.downloader.api_client, fetch_method_name, None)
        if not callable(fetcher):
            return []

        expanded: List[Dict[str, Any]] = []
        seen_aweme: set[str] = set()

        for item in raw_items:
            entry_id = item.get(id_field)
            if not entry_id:
                for alias in id_aliases:
                    candidate = item.get(alias)
                    if not candidate:
                        info = item.get(f"{id_field.split('_')[0]}_info")
                        if isinstance(info, dict):
                            candidate = info.get(id_field) or info.get("id")
                    if candidate:
                        entry_id = candidate
                        break
            if not entry_id:
                continue

            cursor = 0
            has_more = True
            while has_more:
                await self.downloader.rate_limiter.acquire()
                try:
                    page_data = await fetcher(str(entry_id), cursor=cursor, count=20)
                except Exception as exc:
                    logger.warning(
                        "Expansion fetch failed for %s=%s: %s",
                        id_field,
                        entry_id,
                        exc,
                    )
                    break
                page = self._normalize_page_data(page_data)
                self._raise_if_gated_error(page, f"展开 {self.mode_name} 作品失败")
                page_items = page.get("items", [])
                if not page_items:
                    break

                for aweme in page_items:
                    extracted = self._extract_aweme_from_item(aweme)
                    if not extracted:
                        continue
                    aweme_id = str(extracted.get("aweme_id") or "")
                    if not aweme_id or aweme_id in seen_aweme:
                        continue
                    seen_aweme.add(aweme_id)
                    expanded.append(extracted)

                has_more = bool(page.get("has_more", False))
                next_cursor = int(page.get("max_cursor", 0) or 0)
                if has_more and next_cursor == cursor:
                    logger.warning(
                        "%s %s cursor did not advance",
                        id_field,
                        entry_id,
                    )
                    break
                cursor = next_cursor

        return expanded

    @staticmethod
    def _extract_aweme_from_item(item: Any) -> Optional[Dict[str, Any]]:
        if not isinstance(item, dict):
            return None
        if item.get("aweme_id"):
            return item
        for key in ("aweme", "aweme_info", "aweme_detail"):
            value = item.get(key)
            if isinstance(value, dict) and value.get("aweme_id"):
                return value
        return None

    @staticmethod
    def _normalize_page_data(data: Any) -> Dict[str, Any]:
        if not isinstance(data, dict):
            return {"items": [], "has_more": False, "max_cursor": 0, "status_code": -1}

        if isinstance(data.get("items"), list):
            return {
                "items": data.get("items") or [],
                "has_more": bool(data.get("has_more")),
                "max_cursor": int(data.get("max_cursor", 0) or 0),
                "status_code": int(data.get("status_code", 0) or 0),
                "raw": data.get("raw", data),
                "risk_flags": data.get("risk_flags", {}),
            }

        raw_items = data.get("aweme_list") or []
        return {
            "items": raw_items if isinstance(raw_items, list) else [],
            "has_more": bool(data.get("has_more")),
            "max_cursor": int(data.get("max_cursor", 0) or 0),
            "status_code": int(data.get("status_code", 0) or 0),
            "raw": data,
            "risk_flags": {},
        }
