from __future__ import annotations

from typing import Any, Dict, List, Optional

from core.downloader_base import BaseDownloader, DownloadResult
from core.url_parser import URLParser
from core.user_modes.base_strategy import BaseUserModeStrategy
from utils.logger import setup_logger

logger = setup_logger("MusicDownloader")


class MusicDownloader(BaseDownloader):
    async def download(self, parsed_url: Dict[str, Any]) -> DownloadResult:
        result = DownloadResult()

        music_id = self._resolve_music_id(parsed_url)
        if not music_id:
            logger.error("No music_id found in parsed URL")
            return result

        music_detail = await self._get_music_detail(str(music_id))
        music_author = self._extract_music_author(music_detail)

        aweme_list = await self._collect_music_aweme_list(str(music_id))
        aweme_list = self._filter_by_time(aweme_list)
        aweme_list = self._limit_count(aweme_list, "music")

        result.total = len(aweme_list)
        self._progress_set_item_total(result.total, "音乐原声视频待下载")
        self._progress_update_step(
            "下载音乐原声视频",
            f"music_id={music_id}，待处理 {result.total} 条",
        )

        async def _process_aweme(item: Dict[str, Any]):
            aweme_id = item.get("aweme_id")
            if not aweme_id:
                self._progress_advance_item("failed", "missing_aweme_id")
                return {"status": "failed", "aweme_id": None}

            item_sec_uid = item.get("author", {}).get("sec_uid")
            if not await self._should_download(str(aweme_id), sec_uid=item_sec_uid, mode="music"):
                self._progress_advance_item("skipped", str(aweme_id))
                return {"status": "skipped", "aweme_id": aweme_id}

            author_name = (item.get("author") or {}).get("nickname", music_author)
            success, _error_message = await self._download_aweme_assets(item, author_name, mode="music")
            status = "success" if success else "failed"
            self._progress_advance_item(status, str(aweme_id))
            return {"status": status, "aweme_id": aweme_id}

        download_results = await self.queue_manager.download_batch(_process_aweme, aweme_list)
        for entry in download_results:
            status = entry.get("status") if isinstance(entry, dict) else None
            if status == "success":
                result.success += 1
            elif status == "skipped":
                result.skipped += 1
            else:
                result.failed += 1
        return result

    def _resolve_music_id(self, parsed_url: Dict[str, Any]) -> Optional[str]:
        music_id = parsed_url.get("music_id")
        if music_id:
            return str(music_id)

        original_url = parsed_url.get("original_url", "")
        if original_url:
            return URLParser._extract_music_id(str(original_url))
        return None

    async def _collect_music_aweme_list(self, music_id: str) -> List[Dict[str, Any]]:
        fetcher = getattr(self.api_client, "get_music_aweme_list", None)
        if not callable(fetcher):
            fetcher = getattr(self.api_client, "get_music_aweme", None)
        if not callable(fetcher):
            logger.error("API client has no music aweme fetcher implementation")
            return []

        aweme_list: List[Dict[str, Any]] = []
        has_more = True
        cursor = 0
        number_limit = int(self.config.get("number", {}).get("music", 0) or 0)

        while has_more:
            await self.rate_limiter.acquire()
            request_cursor = cursor
            raw_page = await fetcher(music_id, cursor=request_cursor, count=20)
            page = BaseUserModeStrategy._normalize_page_data(raw_page)
            items = page.get("items", [])
            if not items:
                break

            for item in items:
                aweme = self._extract_aweme_from_item(item)
                if aweme:
                    aweme_list.append(aweme)

            if number_limit > 0 and len(aweme_list) >= number_limit:
                aweme_list = aweme_list[:number_limit]
                break

            has_more = bool(page.get("has_more", False))
            next_cursor = int(page.get("max_cursor", 0) or 0)
            if has_more and next_cursor == request_cursor:
                logger.warning(
                    "Music pagination cursor did not advance (%s), stop to avoid loop",
                    request_cursor,
                )
                break
            cursor = next_cursor

        return aweme_list

    async def _get_music_detail(self, music_id: str) -> Optional[Dict[str, Any]]:
        getter = getattr(self.api_client, "get_music_detail", None)
        if not callable(getter):
            return None
        try:
            return await getter(music_id)
        except Exception as exc:
            logger.warning("Get music detail failed: %s", exc)
            return None

    @staticmethod
    def _extract_music_author(detail: Optional[Dict[str, Any]]) -> str:
        if not isinstance(detail, dict):
            return "music"
        return (
            detail.get("author_name")
            or (detail.get("owner") or {}).get("nickname")
            or "music"
        )

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
