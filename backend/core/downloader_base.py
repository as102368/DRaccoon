import json
import os
import re
from abc import ABC, abstractmethod
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Protocol, Tuple, Union
from urllib.parse import urlparse

import aiofiles
import aiohttp

from auth import CookieManager
from config import ConfigLoader
from control import QueueManager, RateLimiter, RetryHandler
from core.api_client import DouyinAPIClient
from core.metadata import extract_author_sec_uid
from core.transcoder import TranscodeManager
from core.transcript_manager import TranscriptManager
from storage import Database, FileManager, MetadataHandler
from utils.logger import setup_logger
from utils.naming import (
    DEFAULT_FILE_TEMPLATE,
    DEFAULT_FOLDER_TEMPLATE,
    build_aweme_context,
    render_template,
)

logger = setup_logger("BaseDownloader")


class ProgressReporter(Protocol):
    def update_step(self, step: str, detail: str = "") -> None: ...

    def set_item_total(self, total: int, detail: str = "") -> None: ...

    def advance_item(self, status: str, detail: str = "") -> None: ...


class DownloadResult:
    def __init__(self):
        self.total = 0
        self.success = 0
        self.failed = 0
        self.skipped = 0
        # Optional metadata for history/relationship tracking. Populated by
        # downloaders that process a single author or a single aweme.
        self.aweme_id: Optional[str] = None
        self.sec_uid: Optional[str] = None

    def __str__(self):
        return f"Total: {self.total}, Success: {self.success}, Failed: {self.failed}, Skipped: {self.skipped}"


class BaseDownloader(ABC):
    def __init__(
        self,
        config: ConfigLoader,
        api_client: DouyinAPIClient,
        file_manager: FileManager,
        cookie_manager: CookieManager,
        database: Optional[Database] = None,
        rate_limiter: Optional[RateLimiter] = None,
        retry_handler: Optional[RetryHandler] = None,
        queue_manager: Optional[QueueManager] = None,
        progress_reporter: Optional[ProgressReporter] = None,
    ):
        self.config = config
        self.api_client = api_client
        self.file_manager = file_manager
        self.cookie_manager = cookie_manager
        self.database = database
        self.rate_limiter = rate_limiter or RateLimiter()
        self.retry_handler = retry_handler or RetryHandler()
        thread_count = int(self.config.get("thread", 5) or 5)
        self.queue_manager = queue_manager or QueueManager(max_workers=thread_count)
        self.progress_reporter = progress_reporter
        self.metadata_handler = MetadataHandler()
        self.transcript_manager = TranscriptManager(self.config, self.file_manager, self.database)
        self.transcode_manager = TranscodeManager(self.config, self.file_manager)
        self._local_aweme_ids: Optional[set[str]] = None
        self._aweme_id_pattern = re.compile(r"(?<!\d)(\d{15,20})(?!\d)")
        self._local_media_suffixes = {
            ".mp4",
            ".jpg",
            ".jpeg",
            ".png",
            ".webp",
            ".gif",
            ".mp3",
            ".m4a",
        }
        # 控制终端错误日志量，避免进度条被大量日志打断后出现重复重绘。
        self._download_error_log_count = 0
        self._download_error_log_limit = 5

    def _progress_update_step(self, step: str, detail: str = "") -> None:
        if not self.progress_reporter:
            return
        try:
            self.progress_reporter.update_step(step, detail)
        except Exception as exc:
            logger.debug("Progress update_step failed: %s", exc)

    def _progress_set_item_total(self, total: int, detail: str = "") -> None:
        if not self.progress_reporter:
            return
        try:
            self.progress_reporter.set_item_total(total, detail)
        except Exception as exc:
            logger.debug("Progress set_item_total failed: %s", exc)

    def _progress_advance_item(self, status: str, detail: str = "") -> None:
        if not self.progress_reporter:
            return
        try:
            self.progress_reporter.advance_item(status, detail)
        except Exception as exc:
            logger.debug("Progress advance_item failed: %s", exc)

    def _progress_report_author(
        self,
        nickname: Optional[str] = None,
        sec_uid: Optional[str] = None,
    ) -> None:
        """Surface author metadata to the reporter so the hosting job can
        cache it for retry and display.

        Downloaders call this as soon as author info is known (user_info
        lookup for batch jobs, aweme_data.author for single-video jobs).
        Safe to call with `None` values — the reporter drops empty payloads.
        """
        if not self.progress_reporter:
            return
        try:
            fn = getattr(self.progress_reporter, "on_author", None)
            if callable(fn):
                fn(nickname=nickname, sec_uid=sec_uid)
        except Exception as exc:  # pragma: no cover — defensive
            logger.debug("Progress on_author failed: %s", exc)

    def _category_path(self) -> Optional[str]:
        """Build a category-based folder path for favorites-page downloads.

        When the Electron GUI starts a download from the likes/favorites page
        it sets ``config.download_context`` with category/sub-category names.
        This path replaces the usual ``author/mode`` layout so collection
        content is grouped by type instead of by creator.
        """
        context = self.config.get("download_context")
        if not isinstance(context, dict):
            return None
        category = str(context.get("category") or "").strip()
        if not category:
            return None

        category_names = {
            "likes": "我的喜欢",
            "favorites": "我的收藏",
        }
        parts = [category_names.get(category, category)]

        if category == "favorites":
            sub = str(context.get("subCategory") or "").strip()
            sub_names = {
                "folders": "我的收藏夹",
                "videos": "视频",
                "music": "音乐",
                "mixes": "合集",
                "topics": "话题",
            }
            if sub:
                parts.append(sub_names.get(sub, sub))
                name = None
                if sub == "folders":
                    name = str(context.get("collectionName") or "").strip()
                elif sub == "mixes":
                    name = str(context.get("mixName") or "").strip()
                elif sub == "music":
                    name = str(context.get("musicName") or "").strip()
                elif sub == "topics":
                    name = str(context.get("topicName") or "").strip()
                if name:
                    parts.append(name)

        from utils.validators import sanitize_filename

        return "/".join(sanitize_filename(p) for p in parts)

    def _log_download_error(self, log_fn, message: str) -> None:
        if self._download_error_log_count < self._download_error_log_limit:
            log_fn(message)
        elif self._download_error_log_count == self._download_error_log_limit:
            logger.error("Too many download errors, suppressing further per-file logs...")
        self._download_error_log_count += 1

    def _download_headers(self, user_agent: Optional[str] = None) -> Dict[str, str]:
        headers = {
            "Referer": f"{self.api_client.BASE_URL}/",
            "Origin": self.api_client.BASE_URL,
            "Accept": "*/*",
        }

        headers["User-Agent"] = user_agent or self.api_client.headers.get("User-Agent", "")
        return headers

    @abstractmethod
    async def download(self, parsed_url: Dict[str, Any]) -> DownloadResult:
        pass

    async def _should_download(
        self,
        aweme_id: str,
        sec_uid: Optional[str] = None,
        mode: Optional[str] = None,
    ) -> bool:
        if not aweme_id:
            return False

        in_local = self._is_locally_downloaded(aweme_id)

        if self.database:
            # 1. Precise deduplication using the (aweme_id, sec_uid, mode) index.
            history = await self.database.get_download_history(
                aweme_id, sec_uid=sec_uid, mode=mode
            )
            if history:
                status = history.get("status")
                if status == "success":
                    if in_local:
                        logger.info(
                            "Aweme %s already downloaded for (%s, %s), skipping",
                            aweme_id,
                            sec_uid,
                            mode,
                        )
                        return False
                    logger.info(
                        "Aweme %s history success but file missing for (%s, %s), retrying",
                        aweme_id,
                        sec_uid,
                        mode,
                    )
                    return True
                if status == "failed":
                    logger.info(
                        "Aweme %s previously failed for (%s, %s), retrying",
                        aweme_id,
                        sec_uid,
                        mode,
                    )
                    return True

            # 2. Fallback to the legacy aweme table for records created before
            # the per-mode history feature existed.
            in_db = await self.database.is_downloaded(aweme_id)
            if in_db and in_local:
                return False
            if in_db and not in_local:
                logger.info(
                    "Aweme %s exists in database but media file not found locally, retry download",
                    aweme_id,
                )
                return True

        if in_local:
            logger.info("Aweme %s already exists locally, skipping", aweme_id)
            return False

        return True

    def _is_locally_downloaded(self, aweme_id: str) -> bool:
        if not aweme_id:
            return False

        if self._local_aweme_ids is None:
            self._build_local_aweme_index()

        if self._local_aweme_ids is None:
            return False
        return aweme_id in self._local_aweme_ids

    def _build_local_aweme_index(self):
        base_path = self.file_manager.base_path
        aweme_ids: set[str] = set()

        if base_path.exists():
            for path in base_path.rglob("*"):
                if not path.is_file():
                    continue
                if path.suffix.lower() not in self._local_media_suffixes:
                    continue
                try:
                    if path.stat().st_size <= 0:
                        continue
                except OSError:
                    continue
                for match in self._aweme_id_pattern.finditer(path.name):
                    aweme_ids.add(match.group(1))

        self._local_aweme_ids = aweme_ids

    def _mark_local_aweme_downloaded(self, aweme_id: str):
        if not aweme_id:
            return

        if self._local_aweme_ids is None:
            self._local_aweme_ids = set()
        self._local_aweme_ids.add(aweme_id)

    def _filter_by_time(self, aweme_list: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        start_time = self.config.get("start_time")
        end_time = self.config.get("end_time")

        if not start_time and not end_time:
            return aweme_list

        start_ts = (
            int(datetime.strptime(start_time, "%Y-%m-%d").timestamp()) if start_time else None
        )
        end_ts = int(datetime.strptime(end_time, "%Y-%m-%d").timestamp()) if end_time else None

        filtered: List[Dict[str, Any]] = []
        for aweme in aweme_list:
            create_time = aweme.get("create_time", 0)
            if start_ts is not None and create_time < start_ts:
                continue
            if end_ts is not None and create_time > end_ts:
                continue
            filtered.append(aweme)

        return filtered

    def _limit_count(self, aweme_list: List[Dict[str, Any]], mode: str) -> List[Dict[str, Any]]:
        number_config = self.config.get("number", {})
        limit = number_config.get(mode, 0)

        if limit > 0:
            return aweme_list[:limit]
        return aweme_list

    async def _do_download_aweme_assets(
        self,
        aweme_data: Dict[str, Any],
        author_name: str,
        mode: Optional[str] = None,
        *,
        db_batch: Optional[List[Dict[str, Any]]] = None,
    ) -> Tuple[bool, Optional[Path], Optional[str]]:
        aweme_id = aweme_data.get("aweme_id")
        if not aweme_id:
            logger.error("Missing aweme_id in aweme data")
            return False, None, "作品数据缺少 aweme_id"

        desc = (aweme_data.get("desc", "no_title") or "").strip() or "no_title"
        save_dir: Optional[Path] = None
        publish_ts, publish_date = self._resolve_publish_time(aweme_data.get("create_time"))
        if not publish_date:
            publish_date = datetime.now().strftime("%Y-%m-%d")
            logger.warning(
                "Aweme %s missing/invalid create_time, fallback to current date %s",
                aweme_id,
                publish_date,
            )
        media_type = self._detect_media_type(aweme_data)
        template_context = build_aweme_context(
            aweme_id=str(aweme_id),
            title=desc,
            author_name=author_name,
            author_sec_uid=extract_author_sec_uid(aweme_data),
            publish_date=publish_date,
            publish_ts=publish_ts,
            media_type=media_type,
            mode=mode,
        )
        filename_template = self.config.get("filename_template") or DEFAULT_FILE_TEMPLATE
        folder_template = self.config.get("folder_template") or DEFAULT_FOLDER_TEMPLATE
        file_stem = render_template(
            filename_template,
            template_context,
            fallback=f"{publish_date}_{aweme_id}",
        )
        folder_name = render_template(
            folder_template,
            template_context,
            fallback=f"{publish_date}_{aweme_id}",
        )

        save_dir = self.file_manager.get_save_path(
            author_name=author_name,
            mode=mode,
            aweme_title=desc,
            aweme_id=aweme_id,
            folderstyle=self.config.get("folderstyle", False),
            download_date=publish_date,
            folder_name=folder_name,
            author_sec_uid=extract_author_sec_uid(aweme_data),
            author_dir_style=self.config.get("author_dir") or "nickname",
            group_by_mode=self.config.get("group_by_mode", False),
            category_path=self._category_path(),
        )
        downloaded_files: List[Path] = []

        session = await self.api_client.get_session()
        video_path: Optional[Path] = None

        if media_type == "video":
            video_info = self._build_no_watermark_url(aweme_data)
            if not video_info:
                logger.error("No playable video URL found for aweme %s", aweme_id)
                return False, save_dir, "未找到可播放的视频地址"

            video_url, video_headers = video_info
            video_path = save_dir / f"{file_stem}.mp4"
            if not await self._download_with_retry(
                video_url, video_path, session, headers=video_headers, resumable=True
            ):
                return False, save_dir, "视频下载失败，请检查网络或磁盘空间"
            downloaded_files.append(video_path)

            if self.config.get("cover"):
                cover_source = aweme_data.get("video", {}).get("cover")
                if self._extract_urls(cover_source):
                    cover_path = save_dir / f"{file_stem}_cover.jpg"
                    if await self._download_first_available(
                        cover_source,
                        cover_path,
                        session,
                        headers=self._download_headers(),
                        optional=True,
                    ):
                        downloaded_files.append(cover_path)

            if self.config.get("music"):
                music_url = self._extract_first_url(aweme_data.get("music", {}).get("play_url"))
                if music_url:
                    music_path = save_dir / f"{file_stem}_music.mp3"
                    if await self._download_with_retry(
                        music_url,
                        music_path,
                        session,
                        headers=self._download_headers(),
                        optional=True,
                    ):
                        downloaded_files.append(music_path)

        elif media_type == "gallery":
            image_url_candidates = self._collect_image_url_candidates(aweme_data)
            image_live_urls = self._collect_image_live_urls(aweme_data)
            download_images = bool(self.config.get("download_images", True))
            download_live_photos = bool(self.config.get("download_live_photos", True))
            logger.info(
                "Gallery aweme %s: %d image(s), %d live photo(s), "
                "download_images=%s, download_live_photos=%s",
                aweme_id,
                len(image_url_candidates),
                len(image_live_urls),
                download_images,
                download_live_photos,
            )
            if not image_url_candidates and not image_live_urls:
                logger.error(
                    "No gallery assets found for aweme %s (aweme_type=%s, "
                    "has image_post_info=%s, has images=%s)",
                    aweme_id,
                    aweme_data.get("aweme_type"),
                    "image_post_info" in aweme_data,
                    "images" in aweme_data,
                )
                return False, save_dir, "未找到图片或 Live 图资源"

            if download_images:
                for index, candidates in enumerate(image_url_candidates, start=1):
                    download_result: bool | Path = False
                    for image_url in candidates:
                        suffix = self._infer_image_extension(image_url)
                        image_path = save_dir / f"{file_stem}_{index}{suffix}"
                        download_result = await self._download_with_retry(
                            image_url,
                            image_path,
                            session,
                            headers=self._download_headers(),
                            prefer_response_content_type=True,
                            return_saved_path=True,
                        )
                        if download_result:
                            downloaded_files.append(
                                download_result if isinstance(download_result, Path) else image_path
                            )
                            break
                    if not download_result:
                        logger.error(f"Failed downloading image {index} for aweme {aweme_id}")
                        return False, save_dir, f"第 {index} 张图片下载失败"

            if download_live_photos:
                for index, live_url in enumerate(image_live_urls, start=1):
                    suffix = Path(urlparse(live_url).path).suffix or ".mp4"
                    live_path = save_dir / f"{file_stem}_live_{index}{suffix}"
                    success = await self._download_with_retry(
                        live_url,
                        live_path,
                        session,
                        headers=self._download_headers(),
                    )
                    if not success:
                        logger.error(f"Failed downloading live image {index} for aweme {aweme_id}")
                        return False, save_dir, f"第 {index} 个 Live 图下载失败"
                    downloaded_files.append(live_path)

            if not downloaded_files:
                logger.info(
                    "Gallery aweme %s skipped: no enabled media types to download "
                    "(download_images=%s, download_live_photos=%s)",
                    aweme_id,
                    download_images,
                    download_live_photos,
                )
        else:
            logger.error("Unsupported media type for aweme %s: %s", aweme_id, media_type)
            return False, save_dir, f"不支持的媒体类型: {media_type}"

        if self.config.get("avatar"):
            author = aweme_data.get("author", {})
            avatar_source = author.get("avatar_larger")
            if self._extract_urls(avatar_source):
                avatar_path = save_dir / f"{file_stem}_avatar.jpg"
                if await self._download_first_available(
                    avatar_source,
                    avatar_path,
                    session,
                    headers=self._download_headers(),
                    optional=True,
                ):
                    downloaded_files.append(avatar_path)

        if self.config.get("json"):
            json_path = save_dir / f"{file_stem}_data.json"
            if await self.metadata_handler.save_metadata(aweme_data, json_path):
                downloaded_files.append(json_path)

        comments_cfg = self.config.get("comments") or {}
        if isinstance(comments_cfg, dict) and comments_cfg.get("enabled"):
            from core.comments_collector import CommentsCollector

            formats_cfg = comments_cfg.get("formats") or ["json", "csv"]
            if isinstance(formats_cfg, str):
                formats_cfg = [f.strip() for f in formats_cfg.split(",") if f.strip()]
            collector = CommentsCollector(
                self.api_client,
                self.metadata_handler,
                include_replies=bool(comments_cfg.get("include_replies", False)),
                max_comments=int(comments_cfg.get("max_comments", 0) or 0),
                page_size=int(comments_cfg.get("page_size", 20) or 20),
                reply_page_size=int(comments_cfg.get("reply_page_size", 20) or 20),
            )
            comments_path = save_dir / f"{file_stem}_comments.json"
            saved = await collector.collect_and_save(
                aweme_id, comments_path, formats=set(formats_cfg)
            )
            if saved is not None:
                if "json" in formats_cfg:
                    downloaded_files.append(save_dir / f"{file_stem}_comments.json")
                if "csv" in formats_cfg:
                    downloaded_files.append(save_dir / f"{file_stem}_comments.csv")

        author = aweme_data.get("author", {})
        if self.database:
            metadata_json = json.dumps(aweme_data, ensure_ascii=False)
            record = {
                "aweme_id": aweme_id,
                "aweme_type": media_type,
                "title": desc,
                "author_id": author.get("uid"),
                "author_name": author.get("nickname", author_name),
                "create_time": aweme_data.get("create_time"),
                "file_path": str(save_dir),
                "metadata": metadata_json,
                # Attach sec_uid onto the payload so both the batched path
                # (add_aweme_batch iterates `record["author_sec_uid"]`) and
                # the single-write path (add_aweme reads the payload as
                # fallback when the kwarg is None) pick it up identically.
                "author_sec_uid": extract_author_sec_uid(aweme_data),
            }
            # Caller may opt into batched DB writes by passing a list; we just
            # accumulate the record and let the caller commit them all at once.
            if db_batch is not None:
                db_batch.append(record)
            else:
                await self.database.add_aweme(record)

        if self.config.get("write_media_metadata", False):
            metadata_sidecars: List[Path] = []
            for file_path in downloaded_files:
                if file_path.suffix.lower() not in self._local_media_suffixes:
                    continue
                try:
                    sidecar = await self.metadata_handler.write_aweme_metadata(
                        aweme_data, file_path
                    )
                    if sidecar and sidecar not in downloaded_files:
                        metadata_sidecars.append(sidecar)
                except Exception as exc:
                    logger.warning("Failed to write metadata for %s: %s", file_path, exc)
            downloaded_files.extend(metadata_sidecars)

        manifest_record = {
            "date": publish_date,
            "aweme_id": aweme_id,
            "author_name": author.get("nickname", author_name),
            "desc": desc,
            "media_type": media_type,
            "tags": self._extract_tags(aweme_data),
            "file_names": [path.name for path in downloaded_files],
            "file_paths": [self._to_manifest_path(path) for path in downloaded_files],
        }
        if publish_ts:
            manifest_record["publish_timestamp"] = publish_ts
        if self.config.get("download_manifest", False):
            await self.metadata_handler.append_download_manifest(
                self.file_manager.base_path, manifest_record
            )

        if media_type == "video" and video_path is not None:
            transcript_result = await self.transcript_manager.process_video(
                video_path, aweme_id=aweme_id
            )
            transcript_status = transcript_result.get("status")
            if transcript_status == "skipped":
                logger.info(
                    "Transcript skipped for aweme %s: %s",
                    aweme_id,
                    transcript_result.get("reason", "unknown"),
                )
            elif transcript_status == "failed":
                logger.warning(
                    "Transcript failed for aweme %s: %s",
                    aweme_id,
                    transcript_result.get("error", "unknown"),
                )

        if media_type == "video" and video_path is not None:
            transcode_result = await self.transcode_manager.process_video(
                video_path, aweme_id=aweme_id
            )
            transcode_status = transcode_result.get("status")
            if transcode_status == "skipped":
                logger.info(
                    "Transcode skipped for aweme %s: %s",
                    aweme_id,
                    transcode_result.get("reason", "unknown"),
                )
            elif transcode_status == "failed":
                logger.warning(
                    "Transcode failed for aweme %s: %s",
                    aweme_id,
                    transcode_result.get("error", "unknown"),
                )

        self._mark_local_aweme_downloaded(aweme_id)
        logger.info("Downloaded %s: %s (%s)", media_type, desc, aweme_id)
        return True, save_dir, None

    async def _download_aweme_assets(
        self,
        aweme_data: Dict[str, Any],
        author_name: str,
        mode: Optional[str] = None,
        *,
        db_batch: Optional[List[Dict[str, Any]]] = None,
    ) -> Tuple[bool, Optional[str]]:
        aweme_id = aweme_data.get("aweme_id")
        if not aweme_id:
            logger.error("Missing aweme_id in aweme data")
            return False, "作品数据缺少 aweme_id"

        sec_uid = extract_author_sec_uid(aweme_data)
        success = False
        save_dir: Optional[Path] = None
        error_message: Optional[str] = None
        try:
            success, save_dir, error_message = await self._do_download_aweme_assets(
                aweme_data, author_name, mode=mode, db_batch=db_batch
            )
        except Exception as exc:
            logger.exception("Unhandled error downloading aweme %s: %s", aweme_id, exc)
            error_message = str(exc)

        if self.database:
            try:
                await self.database.record_download_history(
                    aweme_id=aweme_id,
                    sec_uid=sec_uid,
                    mode=mode,
                    status="success" if success else "failed",
                    file_path=str(save_dir) if save_dir else None,
                    error_message=error_message,
                )
            except Exception as exc:
                logger.warning("Failed to record download history for aweme %s: %s", aweme_id, exc)

        if not success and error_message:
            self._progress_update_step("下载作品", f"失败：{error_message}")

        return success, error_message

    async def _download_with_retry(
        self,
        url: str,
        save_path: Path,
        session,
        *,
        headers: Optional[Dict[str, str]] = None,
        optional: bool = False,
        prefer_response_content_type: bool = False,
        return_saved_path: bool = False,
        resumable: bool = False,
    ) -> bool | Path:
        async def _task():
            proxy = (
                self.api_client.resolve_proxy()
                if hasattr(self.api_client, "resolve_proxy")
                else getattr(self.api_client, "proxy", None)
            )
            try:
                if resumable:
                    download_result = await self._download_file_resumable(
                        url,
                        save_path,
                        session,
                        headers=headers,
                        proxy=proxy,
                        return_saved_path=return_saved_path,
                    )
                else:
                    download_result = await self.file_manager.download_file(
                        url,
                        save_path,
                        session,
                        headers=headers,
                        proxy=proxy,
                        prefer_response_content_type=prefer_response_content_type,
                        return_saved_path=return_saved_path,
                    )
                if not download_result:
                    raise RuntimeError(f"Download failed for {url}")
                return download_result
            except Exception:
                if proxy and getattr(self.api_client, "proxy_pool", None):
                    self.api_client.proxy_pool.mark_failed(proxy)
                raise

        try:
            return await self.retry_handler.execute_with_retry(_task)
        except Exception as error:
            log_fn = logger.warning if optional else logger.error
            self._log_download_error(
                log_fn,
                f"Download error for {save_path.name}: {error}",
            )
            return False

    async def _download_file_resumable(
        self,
        url: str,
        save_path: Path,
        session,
        *,
        headers: Optional[Dict[str, str]] = None,
        proxy: Optional[str] = None,
        return_saved_path: bool = False,
    ) -> Union[bool, Path]:
        """Download a video with HTTP Range resume support.

        Uses a ``.part`` sibling file to record progress. If a partial file
        already exists, only the remaining bytes are requested. When the
        download completes the ``.part`` file is atomically renamed to the
        final path. Servers that ignore ``Range`` (return 200) are handled by
        restarting from scratch; servers that reply 416 because the partial
        file already contains the whole resource are handled by renaming the
        partial file to the final path.
        """
        if self.file_manager.file_exists(save_path):
            logger.debug("Resumable download skipped, final file exists: %s", save_path)
            return save_path if return_saved_path else True

        part_path = save_path.with_suffix(save_path.suffix + ".part")
        initial_size = 0
        if part_path.exists():
            try:
                initial_size = part_path.stat().st_size
            except OSError:
                initial_size = 0

        request_headers: Dict[str, str] = dict(headers) if headers else {}
        if initial_size > 0:
            request_headers["Range"] = f"bytes={initial_size}-"
        else:
            request_headers.pop("Range", None)

        if proxy is None and hasattr(self.api_client, "resolve_proxy"):
            proxy = self.api_client.resolve_proxy()
        elif proxy is None:
            proxy = getattr(self.api_client, "proxy", None)
        timeout = aiohttp.ClientTimeout(total=300)

        async with session.get(
            url,
            headers=request_headers,
            proxy=proxy or None,
            timeout=timeout,
        ) as response:
            if response.status == 416:
                if initial_size > 0 and part_path.exists():
                    os.replace(str(part_path), str(save_path))
                    return save_path if return_saved_path else True
                raise RuntimeError(f"Range not satisfiable for {url}")

            if response.status not in (200, 206):
                raise RuntimeError(
                    f"Unexpected status {response.status} for {url}"
                )

            total_size: Optional[int] = None
            if response.status == 206:
                total_size = self._parse_content_range_total(
                    response.headers.get("Content-Range", "")
                )
                if total_size is None and response.content_length is not None:
                    total_size = initial_size + response.content_length
            else:
                total_size = response.content_length
                initial_size = 0

            mode = "ab" if response.status == 206 else "wb"
            written = 0
            async with aiofiles.open(part_path, mode) as f:
                async for chunk in response.content.iter_chunked(8192):
                    await f.write(chunk)
                    written += len(chunk)

            if total_size is not None:
                actual_size = initial_size + written
                if actual_size != total_size:
                    raise RuntimeError(
                        f"Size mismatch for {save_path.name}: "
                        f"expected {total_size}, got {actual_size}"
                    )

            os.replace(str(part_path), str(save_path))
            return save_path if return_saved_path else True

    @staticmethod
    def _parse_content_range_total(content_range: str) -> Optional[int]:
        """Extract the total resource length from a ``Content-Range`` header."""
        if not content_range:
            return None
        try:
            _, total_part = content_range.split("/", 1)
            return int(total_part)
        except (ValueError, IndexError):
            return None

    async def _download_first_available(
        self,
        source: Any,
        save_path: Path,
        session,
        *,
        headers: Optional[Dict[str, str]] = None,
        optional: bool = False,
        **kwargs,
    ) -> bool | Path:
        """Download an asset, falling back across every mirror in ``url_list``.

        Douyin serves images from multiple CDN mirrors (e.g. p3/p9). The first
        mirror occasionally returns 403 while a later one succeeds, so try each
        URL in turn and return on the first success instead of giving up after
        ``url_list[0]`` and silently dropping the asset.
        """
        urls = self._extract_urls(source)
        result: bool | Path = False
        for index, url in enumerate(urls):
            is_last = index == len(urls) - 1
            result = await self._download_with_retry(
                url,
                save_path,
                session,
                headers=headers,
                # Keep earlier-mirror failures quiet; only the final attempt
                # reflects the caller's chosen log level.
                optional=optional or not is_last,
                **kwargs,
            )
            if result:
                return result
        return result

    # aweme_type codes that indicate image/note content
    _GALLERY_AWEME_TYPES = {2, 68, 150}
    _PLAY_ADDR_KEYS = (
        "play_addr_h264",
        "play_addr_265",
        "play_addr_256",
        "play_addr",
    )

    def _detect_media_type(self, aweme_data: Dict[str, Any]) -> str:
        if self._iter_gallery_items(aweme_data):
            return "gallery"
        aweme_type = aweme_data.get("aweme_type")
        if isinstance(aweme_type, int) and aweme_type in self._GALLERY_AWEME_TYPES:
            video = aweme_data.get("video") if isinstance(aweme_data.get("video"), dict) else {}
            if self._has_video_source(video):
                logger.info(
                    "Detected note video via aweme_type=%s for aweme %s",
                    aweme_type,
                    aweme_data.get("aweme_id"),
                )
                return "video"
            logger.info(
                "Detected gallery via aweme_type=%s for aweme %s",
                aweme_type,
                aweme_data.get("aweme_id"),
            )
            return "gallery"
        return "video"

    def _build_no_watermark_url(
        self, aweme_data: Dict[str, Any]
    ) -> Optional[Tuple[str, Dict[str, str]]]:
        video = aweme_data.get("video", {})
        quality = str(self.config.get("video_quality") or "highest")
        play_addr = self._pick_preferred_play_addr(video, quality) or {}
        url_candidates = [c for c in (play_addr.get("url_list") or []) if c]
        url_candidates.sort(key=lambda u: 0 if "watermark=0" in u else 1)

        fallback_candidate: Optional[Tuple[str, Dict[str, str]]] = None
        watermarked_candidate: Optional[Tuple[str, Dict[str, str]]] = None

        for candidate in url_candidates:
            parsed = urlparse(candidate)
            headers = self._download_headers()
            is_watermarked = self._is_watermarked_media_url(candidate)

            if parsed.netloc.endswith("douyin.com"):
                if "X-Bogus=" not in candidate:
                    signed_url, ua = self.api_client.sign_url(candidate)
                    headers = self._download_headers(user_agent=ua)
                    if is_watermarked:
                        watermarked_candidate = watermarked_candidate or (
                            signed_url,
                            headers,
                        )
                        continue
                    return signed_url, headers
                if is_watermarked:
                    watermarked_candidate = watermarked_candidate or (candidate, headers)
                    continue
                return candidate, headers

            if is_watermarked:
                watermarked_candidate = watermarked_candidate or (candidate, headers)
            else:
                fallback_candidate = fallback_candidate or (candidate, headers)

        # Prefer direct CDN URLs (e.g. douyinvod.com) over the /aweme/v1/play/
        # signed endpoint: the latter redirects to a URL that returns 403 Forbidden.
        if fallback_candidate:
            return fallback_candidate

        uri = play_addr.get("uri") or video.get("vid") or video.get("download_addr", {}).get("uri")
        if uri:
            # Douyin /aweme/v1/play/ accepts a limited set of ratio strings.
            # Map "highest"/"lowest" to 1080p/540p respectively; pass through
            # recognised <N>p values; fall back to 1080p for unknowns so the
            # legacy default is preserved.
            ratio_map = {
                "highest": "1080p",
                "lowest": "540p",
            }
            ratio = ratio_map.get(quality, quality if quality in self._QUALITY_TARGET_WIDTH else "1080p")
            params = {
                "video_id": uri,
                "ratio": ratio,
                "line": "0",
                "is_play_url": "1",
                "watermark": "0",
                "source": "PackSourceEnum_PUBLISH",
            }
            signed_url, ua = self.api_client.build_signed_path("/aweme/v1/play/", params)
            return signed_url, self._download_headers(user_agent=ua)

        if watermarked_candidate:
            return watermarked_candidate

        return None

    # 视频画质选择支持的规格名称。用于 `_pick_play_addr_by_quality` 按
    # 分辨率（width）匹配最接近的档位；匹配不到时自动降级到最高可用档。
    _QUALITY_TARGET_WIDTH: Dict[str, int] = {
        "1440p": 2560,
        "1080p": 1920,
        "720p": 1280,
        "540p": 960,
        "480p": 854,
        "360p": 640,
    }

    @staticmethod
    def _pick_highest_quality_play_addr(video: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Shortcut for highest-quality selection (backward-compatible).

        Kept for older callers; new code should use
        :meth:`_pick_play_addr_by_quality` with an explicit quality string.
        """
        return BaseDownloader._pick_play_addr_by_quality(video, "highest")

    @staticmethod
    def _pick_play_addr_by_quality(
        video: Dict[str, Any], quality: str = "highest"
    ) -> Optional[Dict[str, Any]]:
        """从 video.bit_rate 多档率中按目标画质挑选 play_addr。

        抖音 API 的 ``video.bit_rate`` 是按质量排序的字典列表，每项含
        ``bit_rate``（码率）与 ``play_addr``（内含 ``url_list`` 与 ``width``）。

        - ``highest`` / 未知值 / 空：取 bit_rate 最大的档；同码率按 width 决胜。
        - ``lowest``：取 bit_rate 最小的档；同码率按 width 小者优先。
        - ``<N>p``（如 ``1080p``）：按 width 最接近目标值的档；完全没有 bit_rate
          数据时返回 ``None``，让调用方回退到 ``video.play_addr``。
        """
        bit_rates = video.get("bit_rate") if isinstance(video, dict) else None
        if not isinstance(bit_rates, list) or not bit_rates:
            return None

        # Normalise + collect valid (bit_rate, width, play_addr) triples.
        entries: List[Tuple[int, int, Dict[str, Any]]] = []
        for entry in bit_rates:
            if not isinstance(entry, dict):
                continue
            play_addr = entry.get("play_addr")
            if not isinstance(play_addr, dict):
                continue
            try:
                br = int(entry.get("bit_rate") or 0)
            except (TypeError, ValueError):
                br = 0
            width = int(play_addr.get("width") or entry.get("width") or 0)
            entries.append((br, width, play_addr))
        if not entries:
            return None

        normalised = (quality or "highest").strip().lower()

        if normalised == "lowest":
            # Lowest bit_rate; tie-break by smaller width.
            entries.sort(key=lambda t: (t[0], t[1]))
            return entries[0][2]

        target_width = BaseDownloader._QUALITY_TARGET_WIDTH.get(normalised)
        if target_width is not None:
            # Closest width to target; tie-break by higher bit_rate so we
            # don't accidentally pick a re-encoded low-bitrate copy.
            entries.sort(key=lambda t: (abs(t[1] - target_width), -t[0]))
            return entries[0][2]

        # Default / "highest": highest bit_rate, tie-break by higher width.
        entries.sort(key=lambda t: (-t[0], -t[1]))
        return entries[0][2]

    @staticmethod
    def _pick_preferred_play_addr(
        video: Dict[str, Any], quality: str = "highest"
    ) -> Optional[Dict[str, Any]]:
        preferred = BaseDownloader._pick_play_addr_by_quality(video, quality)
        if preferred:
            return preferred
        if not isinstance(video, dict):
            return None
        primary = video.get("play_addr")
        if isinstance(primary, dict) and primary.get("uri"):
            return primary
        for key in BaseDownloader._PLAY_ADDR_KEYS:
            candidate = video.get(key)
            if isinstance(candidate, dict) and (
                BaseDownloader._extract_first_url(candidate) or candidate.get("uri")
            ):
                return candidate
        return None

    @staticmethod
    def _has_video_source(video: Dict[str, Any]) -> bool:
        if BaseDownloader._pick_preferred_play_addr(video):
            return True
        if not isinstance(video, dict):
            return False
        return bool(
            video.get("vid")
            or (isinstance(video.get("download_addr"), dict) and video["download_addr"].get("uri"))
        )

    def _collect_image_urls(self, aweme_data: Dict[str, Any]) -> List[str]:
        return [
            candidates[0]
            for candidates in self._collect_image_url_candidates(aweme_data)
            if candidates
        ]

    def _collect_image_url_candidates(self, aweme_data: Dict[str, Any]) -> List[List[str]]:
        image_urls = []
        gallery_items = self._iter_gallery_items(aweme_data)
        for item in gallery_items:
            if not isinstance(item, dict):
                continue
            candidates = self._collect_media_urls(
                item.get("watermark_free_download_url_list"),
                item,
                item.get("origin_image"),
                item.get("display_image"),
                item.get("download_url"),
                item.get("download_addr"),
                item.get("download_url_list"),
                item.get("owner_watermark_image"),
            )
            if candidates:
                image_urls.append(candidates)
        if not image_urls:
            logger.warning(
                "No image URLs extracted for aweme %s; gallery items count=%d",
                aweme_data.get("aweme_id"),
                len(gallery_items),
            )
        return image_urls

    def _collect_image_live_urls(self, aweme_data: Dict[str, Any]) -> List[str]:
        live_urls: List[str] = []
        quality = str(self.config.get("video_quality") or "highest")
        for item in self._iter_gallery_items(aweme_data):
            if not isinstance(item, dict):
                continue
            video = item.get("video") if isinstance(item.get("video"), dict) else {}
            # 实况图同样会有 bit_rate 多档，按配置的画质偏好选择对应档位。
            preferred_play_addr = self._pick_preferred_play_addr(video, quality)
            live_url = self._pick_first_media_url(
                preferred_play_addr,
                video.get("play_addr_h264"),
                video.get("play_addr_265"),
                video.get("play_addr_256"),
                video.get("play_addr"),
                video.get("download_addr"),
                item.get("video_play_addr"),
                item.get("video_download_addr"),
            )
            if live_url:
                live_urls.append(live_url)
        return self._deduplicate_urls(live_urls)

    @staticmethod
    def _iter_gallery_items(aweme_data: Dict[str, Any]) -> List[Any]:
        image_post = aweme_data.get("image_post_info")
        if isinstance(image_post, dict):
            for key in ("images", "image_list"):
                candidate = image_post.get(key)
                if isinstance(candidate, list) and candidate:
                    return candidate
        images = aweme_data.get("images") or aweme_data.get("image_list") or []
        if isinstance(images, list):
            return images
        return []

    @staticmethod
    def _deduplicate_urls(urls: List[str]) -> List[str]:
        deduped: List[str] = []
        seen: set[str] = set()
        for url in urls:
            if not url or url in seen:
                continue
            seen.add(url)
            deduped.append(url)
        return deduped

    @staticmethod
    def _pick_first_media_url(*sources: Any) -> Optional[str]:
        for source in sources:
            candidate = BaseDownloader._extract_first_url(source)
            if candidate:
                return candidate
        return None

    @staticmethod
    def _collect_media_urls(*sources: Any) -> List[str]:
        urls: List[str] = []
        seen: set[str] = set()
        for source in sources:
            for candidate in sorted(
                BaseDownloader._extract_urls(source),
                key=BaseDownloader._media_url_priority,
            ):
                if candidate in seen:
                    continue
                seen.add(candidate)
                urls.append(candidate)
        return urls

    @staticmethod
    def _media_url_priority(url: str) -> int:
        normalized = url.lower()
        path = (urlparse(url).path or "").lower()
        score = 100 if BaseDownloader._is_watermarked_media_url(normalized) else 0
        return score + (1 if ".webp" in path else 0)

    @staticmethod
    def _is_watermarked_media_url(url: str) -> bool:
        normalized = url.lower()
        watermark_hints = (
            "tplv-dy-water",
            "dy-water",
            "owner_watermark",
            "watermark_image",
            "watermark=1",
            "playwm",
        )
        return any(hint in normalized for hint in watermark_hints)

    @staticmethod
    def _extract_first_url(source: Any) -> Optional[str]:
        urls = BaseDownloader._extract_urls(source)
        return urls[0] if urls else None

    @staticmethod
    def _extract_urls(source: Any) -> List[str]:
        if isinstance(source, dict):
            url_list = source.get("url_list") or source.get("urlList")
            if isinstance(url_list, list) and url_list:
                return [item for item in url_list if isinstance(item, str) and item]
        elif isinstance(source, list) and source:
            return [item for item in source if isinstance(item, str) and item]
        elif isinstance(source, str) and source:
            return [source]
        return []

    @staticmethod
    def _infer_image_extension(image_url: str) -> str:
        allowed_exts = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
        if not image_url:
            return ".jpg"

        image_path = (urlparse(image_url).path or "").lower()
        raw_suffix = Path(image_path).suffix.lower()
        if raw_suffix in allowed_exts:
            return raw_suffix

        matches = re.findall(r"\.(?:jpe?g|png|webp|gif)(?=[^a-z0-9]|$)", image_path)
        if matches:
            return matches[-1].lower()

        return ".jpg"

    @staticmethod
    def _resolve_publish_time(create_time: Any) -> Tuple[Optional[int], str]:
        if create_time in (None, ""):
            return None, ""

        try:
            publish_ts = int(create_time)
            if publish_ts <= 0:
                return None, ""
            return publish_ts, datetime.fromtimestamp(publish_ts).strftime("%Y-%m-%d")
        except (TypeError, ValueError, OSError, OverflowError):
            return None, ""

    @staticmethod
    def _extract_tags(aweme_data: Dict[str, Any]) -> List[str]:
        tags: List[str] = []

        def _append_tag(raw_tag: Any):
            if not raw_tag:
                return
            normalized_tag = str(raw_tag).strip().lstrip("#")
            if normalized_tag and normalized_tag not in tags:
                tags.append(normalized_tag)

        for item in aweme_data.get("text_extra") or []:
            if not isinstance(item, dict):
                continue
            _append_tag(item.get("hashtag_name"))
            _append_tag(item.get("tag_name"))

        for item in aweme_data.get("cha_list") or []:
            if not isinstance(item, dict):
                continue
            _append_tag(item.get("cha_name"))
            _append_tag(item.get("name"))

        desc = aweme_data.get("desc") or ""
        for hashtag in re.findall(r"#([^\s#]+)", desc):
            _append_tag(hashtag)

        return tags

    def _to_manifest_path(self, path: Path) -> str:
        try:
            return str(path.relative_to(self.file_manager.base_path))
        except ValueError:
            return str(path)
