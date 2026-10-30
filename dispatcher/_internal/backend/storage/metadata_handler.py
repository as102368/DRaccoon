import asyncio
import json
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

import aiofiles

from utils.logger import setup_logger

logger = setup_logger("MetadataHandler")


class MetadataHandler:
    def __init__(self):
        self._manifest_lock = asyncio.Lock()

    async def save_metadata(self, data: Dict[str, Any], save_path: Path) -> bool:
        try:
            async with aiofiles.open(save_path, "w", encoding="utf-8") as f:
                await f.write(json.dumps(data, ensure_ascii=False, indent=2))
            return True
        except Exception as e:
            logger.error("Failed to save metadata: %s, error: %s", save_path, e)
            return False

    async def append_download_manifest(self, base_path: Path, record: Dict[str, Any]) -> bool:
        manifest_path = base_path / "download_manifest.jsonl"
        normalized_record = {
            "recorded_at": datetime.now().isoformat(timespec="seconds"),
            **record,
        }

        try:
            async with self._manifest_lock:
                async with aiofiles.open(manifest_path, "a", encoding="utf-8") as f:
                    await f.write(json.dumps(normalized_record, ensure_ascii=False))
                    await f.write("\n")
            return True
        except Exception as e:
            logger.error("Failed to append download manifest: %s, error: %s", manifest_path, e)
            return False

    async def load_metadata(self, file_path: Path) -> Dict[str, Any]:
        try:
            async with aiofiles.open(file_path, "r", encoding="utf-8") as f:
                content = await f.read()
                return json.loads(content)
        except Exception as e:
            logger.error("Failed to load metadata: %s, error: %s", file_path, e)
            return {}

    # ------------------------------------------------------------------
    # Media metadata embedding / sidecar
    # ------------------------------------------------------------------

    _FFMPEG_METADATA_TIMEOUT_SECONDS = 30.0
    _VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".m4a", ".mkv", ".avi", ".webm"}
    _AUDIO_SUFFIXES = {".mp3", ".m4a", ".m4p", ".ogg", ".flac", ".wma"}

    @staticmethod
    def build_media_metadata(aweme_data: Dict[str, Any]) -> Dict[str, Any]:
        """从原始作品数据中提取规范化的媒体元数据字段。"""
        author = aweme_data.get("author", {}) or {}
        music = aweme_data.get("music", {}) or {}
        music_title = (music.get("title") or "").strip()
        music_author = (music.get("author") or "").strip()
        music_full = ""
        if music_title and music_author:
            music_full = f"{music_title} - {music_author}"
        elif music_title:
            music_full = music_title
        elif music_author:
            music_full = music_author

        create_time = aweme_data.get("create_time")
        publish_time = ""
        if create_time is not None:
            try:
                publish_time = datetime.fromtimestamp(int(create_time)).isoformat()
            except (TypeError, ValueError, OSError):
                pass

        return {
            "title": (aweme_data.get("desc") or "").strip() or "no_title",
            "author": author.get("nickname") or "",
            "author_sec_uid": author.get("sec_uid") or "",
            "description": (aweme_data.get("desc") or "").strip() or "no_title",
            "music": music_full,
            "music_title": music_title,
            "music_author": music_author,
            "publish_time": publish_time,
            "aweme_id": aweme_data.get("aweme_id") or "",
        }

    async def write_aweme_metadata(
        self, aweme_data: Dict[str, Any], file_path: Path
    ) -> Optional[Path]:
        """为已下载的媒体文件写入元数据。

        视频优先尝试写入容器内元数据（ffmpeg → mutagen），失败时回退到同目录
        JSON sidecar；图片直接写同目录 JSON sidecar；音乐文件同时尝试 mutagen
        ID3 写入。

        Returns:
            如果生成了 JSON sidecar，返回 sidecar 路径；容器内写入成功或失败
            但没有产生 sidecar 时返回 None。
        """
        metadata = self.build_media_metadata(aweme_data)
        suffix = file_path.suffix.lower()

        if suffix in self._VIDEO_SUFFIXES:
            if await self._write_video_metadata_ffmpeg(file_path, metadata):
                return None

        if suffix in self._VIDEO_SUFFIXES | self._AUDIO_SUFFIXES:
            if await self._write_media_metadata_mutagen(file_path, metadata):
                return None

        sidecar_path = file_path.with_suffix(file_path.suffix + ".meta.json")
        if await self._write_metadata_sidecar(file_path, metadata):
            return sidecar_path
        return None

    async def _write_video_metadata_ffmpeg(
        self, file_path: Path, metadata: Dict[str, Any]
    ) -> bool:
        ffmpeg_path = await self._get_ffmpeg_path()
        if not ffmpeg_path:
            return False

        temp_path = file_path.with_suffix(file_path.suffix + ".tmp")
        try:
            cmd = [
                ffmpeg_path,
                "-y",
                "-i",
                str(file_path),
                "-c",
                "copy",
                "-metadata",
                f"title={metadata.get('title', '')}",
                "-metadata",
                f"artist={metadata.get('author', '')}",
                "-metadata",
                f"description={metadata.get('description', '')}",
                "-metadata",
                f"comment={self._format_comment(metadata)}",
                "-metadata",
                f"date={metadata.get('publish_time', '')[:10]}",
                str(temp_path),
            ]
            proc = await asyncio.wait_for(
                asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                ),
                timeout=self._FFMPEG_METADATA_TIMEOUT_SECONDS,
            )
            stdout, stderr = await proc.communicate()
            if proc.returncode != 0:
                logger.warning(
                    "ffmpeg metadata write failed for %s: %s",
                    file_path,
                    stderr.decode(errors="ignore")[:300],
                )
                return False
            if not temp_path.exists() or temp_path.stat().st_size <= 0:
                return False
            shutil.move(str(temp_path), str(file_path))
            return True
        except asyncio.TimeoutError:
            logger.warning("ffmpeg metadata write timed out for %s", file_path)
            return False
        except Exception as exc:
            logger.warning("ffmpeg metadata write error for %s: %s", file_path, exc)
            return False
        finally:
            if temp_path.exists():
                try:
                    temp_path.unlink()
                except OSError:
                    pass

    async def _write_media_metadata_mutagen(
        self, file_path: Path, metadata: Dict[str, Any]
    ) -> bool:
        try:
            suffix = file_path.suffix.lower()
            if suffix == ".mp3":
                from mutagen.id3 import COMM, TIT2, TPE1
                from mutagen.mp3 import MP3

                audio = MP3(str(file_path))
                if audio.tags is None:
                    audio.add_tags()
                audio.tags["TIT2"] = TIT2(encoding=3, text=metadata.get("title", ""))
                audio.tags["TPE1"] = TPE1(encoding=3, text=metadata.get("author", ""))
                audio.tags["COMM"] = COMM(
                    encoding=3,
                    lang="eng",
                    desc="description",
                    text=self._format_comment(metadata),
                )
                audio.save()
                return True

            # MP4 容器（mp4/m4v/m4a/m4p）
            from mutagen.mp4 import MP4

            mp4 = MP4(str(file_path))
            mp4["\xa9nam"] = [metadata.get("title", "")]
            mp4["\xa9ART"] = [metadata.get("author", "")]
            mp4["\xa9cmt"] = [self._format_comment(metadata)]
            mp4["\xa9day"] = [metadata.get("publish_time", "")[:10]]
            mp4.save()
            return True
        except Exception as exc:
            logger.debug("mutagen metadata write failed for %s: %s", file_path, exc)
            return False

    async def _write_metadata_sidecar(
        self, file_path: Path, metadata: Dict[str, Any]
    ) -> bool:
        sidecar_path = file_path.with_suffix(file_path.suffix + ".meta.json")
        try:
            async with aiofiles.open(sidecar_path, "w", encoding="utf-8") as f:
                await f.write(json.dumps(metadata, ensure_ascii=False, indent=2))
            return True
        except Exception as exc:
            logger.warning(
                "Failed to write metadata sidecar: %s, error: %s", sidecar_path, exc
            )
            return False

    @staticmethod
    def _format_comment(metadata: Dict[str, Any]) -> str:
        lines = []
        if metadata.get("description"):
            lines.append(f"Description: {metadata['description']}")
        if metadata.get("music"):
            lines.append(f"Music: {metadata['music']}")
        if metadata.get("publish_time"):
            lines.append(f"Published: {metadata['publish_time']}")
        if metadata.get("aweme_id"):
            lines.append(f"Aweme ID: {metadata['aweme_id']}")
        return "\n".join(lines)

    async def _get_ffmpeg_path(self) -> Optional[str]:
        try:
            from core.audio_extraction import FfmpegLocator

            return await FfmpegLocator.instance().locate()
        except Exception:
            return None
