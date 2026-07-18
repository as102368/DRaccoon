from typing import Any, Dict, Optional, Tuple

from core.downloader_base import BaseDownloader, DownloadResult
from core.metadata import extract_author_sec_uid
from utils.logger import setup_logger

logger = setup_logger("VideoDownloader")


class VideoDownloader(BaseDownloader):
    async def download(self, parsed_url: Dict[str, Any]) -> DownloadResult:
        result = DownloadResult()

        aweme_id = parsed_url.get("aweme_id")
        if not aweme_id:
            logger.error("No aweme_id found in parsed URL")
            return result

        result.total = 1
        self._progress_set_item_total(1, "单作品下载")
        self._progress_update_step("下载作品", "单作品资源下载中")

        if not await self._should_download(aweme_id):
            logger.info("Video %s already downloaded, skipping", aweme_id)
            result.skipped += 1
            self._progress_advance_item("skipped", str(aweme_id))
            return result

        await self.rate_limiter.acquire()

        aweme_data = await self.api_client.get_video_detail(aweme_id)
        if not aweme_data:
            logger.error("Failed to get video detail: %s", aweme_id)
            result.failed += 1
            self._progress_update_step("下载作品", "失败：无法获取作品详情")
            self._progress_advance_item("failed", str(aweme_id))
            return result

        sec_uid = extract_author_sec_uid(aweme_data)
        if not await self._should_download(aweme_id, sec_uid=sec_uid, mode="single"):
            logger.info("Video %s already downloaded for (%s, single), skipping", aweme_id, sec_uid)
            result.skipped += 1
            self._progress_advance_item("skipped", str(aweme_id))
            return result

        success, _error_message = await self._download_aweme(aweme_data)
        if success:
            result.success += 1
            self._progress_advance_item("success", str(aweme_id))
        else:
            result.failed += 1
            self._progress_advance_item("failed", str(aweme_id))

        result.aweme_id = str(aweme_id)
        result.sec_uid = sec_uid
        return result

    async def _download_aweme(self, aweme_data: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
        author = aweme_data.get("author", {}) or {}
        author_name = author.get("nickname", "unknown")
        # Cache author on the hosting job so JobRow can display the nickname
        # and `retry_failed_awemes` doesn't need to re-fetch user info.
        self._progress_report_author(
            nickname=author_name if author_name != "unknown" else None,
            sec_uid=author.get("sec_uid"),
        )
        return await self._download_aweme_assets(aweme_data, author_name, mode="single")
