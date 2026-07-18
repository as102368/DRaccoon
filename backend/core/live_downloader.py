"""抖音直播录制。

技术路径：
- 通过 `/webcast/room/web/enter/` 获取 stream_url，常见字段：
    * flv_pull_url: {SD, HD, FULL_HD, ORIGIN}
    * hls_pull_url_map: {HD1, HD2, HD3}
- 选择最高清可用的流，优先 FLV（单文件落盘简单）
- 使用 aiohttp 分块写入到 `.flv` 临时文件，完成后原子重命名
- 时长限制：read_timeout 自然结束或 max_duration_seconds 触发
- 支持后台轮询 + 分段录制：满足 segment_duration 后关闭当前流，转封装为 MP4，
  再继续拉取下一片

限制：
- 不处理多人房间 / 连麦切换
- 不采集弹幕（后续可扩展）
- HLS 源首期通过 ffmpeg 直接 ingest URL 录制，FLV 源走 aiohttp 直连
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple

import aiofiles
import aiohttp

from core.downloader_base import BaseDownloader, DownloadResult
from utils.logger import setup_logger
from utils.naming import (
    DEFAULT_FILE_TEMPLATE,
    DEFAULT_FOLDER_TEMPLATE,
    build_live_context,
    render_template,
)

logger = setup_logger("LiveDownloader")


# 质量优先级：数字越大越高清
_FLV_QUALITY_ORDER = {
    "ORIGIN": 100,
    "FULL_HD1": 90,
    "FULL_HD": 90,
    "HD1": 70,
    "HD": 70,
    "SD1": 50,
    "SD2": 50,
    "SD": 50,
    "LD": 30,
}


class LiveDownloader(BaseDownloader):
    async def download(self, parsed_url: Dict[str, Any]) -> DownloadResult:
        result = DownloadResult()

        room_id = parsed_url.get("room_id")
        if not room_id:
            logger.error("No room_id found in parsed URL")
            return result

        result.total = 1
        self._progress_set_item_total(1, "直播录制")
        self._progress_update_step("获取直播间信息", f"room_id={room_id}")

        info = await self.api_client.get_live_room_info(str(room_id))
        if not info:
            logger.error("Live room not available or fetch failed: %s", room_id)
            result.failed += 1
            self._progress_update_step("录制直播流", "失败：无法获取直播间信息")
            self._progress_advance_item("failed", str(room_id))
            return result

        room = info.get("room") or {}
        user = info.get("user") or {}

        status = room.get("status")
        if status is not None and int(status or 0) != 2:
            # 2 = 正在直播；其他状态不录
            logger.warning("Room %s not live (status=%s); skipping", room_id, status)
            result.skipped += 1
            self._progress_advance_item("skipped", str(room_id))
            return result

        stream_url, quality = self._select_best_stream_url(room)
        if not stream_url:
            logger.error("No playable live stream URL for room %s", room_id)
            result.failed += 1
            self._progress_update_step("录制直播流", "失败：未找到可播放的直播流地址")
            self._progress_advance_item("failed", str(room_id))
            return result

        author_name = (user.get("nickname") or "unknown").strip() or "unknown"
        title = (room.get("title") or "直播").strip() or "直播"
        save_dir, file_stem = self._plan_output_paths(author_name, title, str(room_id))

        # 保存元数据
        if self.config.get("json"):
            meta_path = save_dir / f"{file_stem}_room.json"
            try:
                async with aiofiles.open(meta_path, "w", encoding="utf-8") as f:
                    await f.write(json.dumps(info, ensure_ascii=False, indent=2))
            except Exception as exc:
                logger.debug("Save room meta failed: %s", exc)

        live_cfg = self._live_config()
        max_duration = float(live_cfg.get("max_duration_seconds") or 0)
        chunk_size = int(live_cfg.get("chunk_size") or 65536)
        idle_timeout = float(live_cfg.get("idle_timeout_seconds") or 30.0)
        output_format = str(live_cfg.get("output_format") or "mp4").lower()
        ffmpeg_path = live_cfg.get("ffmpeg_path") or None

        is_hls = self._is_hls_url(stream_url)
        # 单次下载保持历史行为：FLV 保存为 .flv；HLS 按 output_format 输出
        suffix = ".flv" if not is_hls else (".mp4" if output_format == "mp4" else ".ts")

        target_path = save_dir / f"{file_stem}{suffix}"

        self._progress_update_step(
            "录制直播流",
            f"quality={quality} | -> {target_path.name}",
        )

        # 单次 CLI/URL 下载保持原有单文件录制行为
        if is_hls:
            ok = await self._record_hls_segment(
                stream_url,
                target_path,
                max_duration=max_duration,
                ffmpeg_path=ffmpeg_path,
            )
        else:
            ok = await self._record_one_segment(
                stream_url,
                target_path,
                max_duration=max_duration,
                chunk_size=chunk_size,
                idle_timeout=idle_timeout,
                stop_event=asyncio.Event(),
            )

        if ok:
            result.success += 1
            self._progress_advance_item("success", str(room_id))
            logger.info("Live recording finished: %s", target_path)
        else:
            result.failed += 1
            self._progress_update_step("录制直播流", "失败：直播录制失败，请检查网络或磁盘空间")
            self._progress_advance_item("failed", str(room_id))

        return result

    async def record_live_session(
        self,
        room_id: str,
        info: Dict[str, Any],
        save_dir: Path,
        file_stem: str,
        *,
        emit: Optional[Callable[[str, Any], None]] = None,
        stop_event: asyncio.Event,
    ) -> bool:
        """供 LiveMonitor 调用的单场直播录制入口。

        已经确认房间处于直播中，info 由调用方通过 get_live_room_info 获取。
        方法内部负责选择流地址、分段录制、转封装 MP4，并在主播下播或 stop_event
        触发时干净退出。
        """
        room = info.get("room") or {}

        stream_url, quality = self._select_best_stream_url(room)
        if not stream_url:
            logger.error("No playable live stream URL for room %s", room_id)
            if emit:
                emit("live:error", room_id=room_id, message="无可用直播流地址", fatal=True)
            return False

        # 保存元数据
        if self.config.get("json"):
            meta_path = save_dir / f"{file_stem}_room.json"
            try:
                async with aiofiles.open(meta_path, "w", encoding="utf-8") as f:
                    await f.write(json.dumps(info, ensure_ascii=False, indent=2))
            except Exception as exc:
                logger.debug("Save room meta failed: %s", exc)

        live_cfg = self._live_config()
        max_duration = float(live_cfg.get("max_duration_seconds") or 0)
        chunk_size = int(live_cfg.get("chunk_size") or 65536)
        idle_timeout = float(live_cfg.get("idle_timeout_seconds") or 30.0)
        segment_duration = float(live_cfg.get("segment_duration_seconds") or 3600)
        output_format = str(live_cfg.get("output_format") or "mp4").lower()
        ffmpeg_path = live_cfg.get("ffmpeg_path") or None

        return await self._record_stream_segmented(
            stream_url,
            save_dir,
            file_stem,
            segment_duration=segment_duration,
            max_duration=max_duration,
            chunk_size=chunk_size,
            idle_timeout=idle_timeout,
            output_format=output_format,
            ffmpeg_path=ffmpeg_path,
            emit=emit,
            stop_event=stop_event,
            room_id=room_id,
        )

    # --- helpers ---

    def _live_config(self) -> Dict[str, Any]:
        cfg = self.config.get("live") or {}
        return cfg if isinstance(cfg, dict) else {}

    def _plan_output_paths(self, author_name: str, title: str, room_id: str) -> Tuple[Path, str]:
        started_at = datetime.now()
        date = started_at.strftime("%Y-%m-%d_%H%M")
        template_context = build_live_context(
            room_id=str(room_id),
            title=title,
            author_name=author_name,
            started_at=started_at,
        )
        filename_template = self.config.get("filename_template") or DEFAULT_FILE_TEMPLATE
        folder_template = self.config.get("folder_template") or DEFAULT_FOLDER_TEMPLATE
        microsecond = started_at.strftime("%f")
        file_stem = render_template(
            filename_template,
            template_context,
            fallback=f"{date}_{room_id}_{microsecond}",
        )
        folder_name = render_template(
            folder_template,
            template_context,
            fallback=f"{date}_{room_id}_{microsecond}",
        )
        save_dir = self.file_manager.get_save_path(
            author_name=author_name,
            mode="live",
            aweme_title=title,
            aweme_id=room_id,
            folderstyle=self.config.get("folderstyle", False),
            download_date=date,
            folder_name=folder_name,
            author_sec_uid=None,
            author_dir_style=self.config.get("author_dir") or "nickname",
            group_by_mode=self.config.get("group_by_mode", False),
            category_path=self._category_path(),
        )
        return save_dir, file_stem

    @staticmethod
    def _select_best_stream_url(room: Dict[str, Any]) -> Tuple[Optional[str], str]:
        """从 room.stream_url 中挑一条最佳地址。优先 FLV 高清。"""
        stream = room.get("stream_url") if isinstance(room, dict) else None
        if not isinstance(stream, dict):
            return None, ""

        # FLV 优先
        flv_map = stream.get("flv_pull_url")
        if isinstance(flv_map, dict) and flv_map:
            best_key = max(
                flv_map.keys(),
                key=lambda k: _FLV_QUALITY_ORDER.get(k.upper(), 0),
            )
            url = flv_map.get(best_key)
            if isinstance(url, str) and url:
                return url, best_key

        # 其次 HLS
        hls_map = stream.get("hls_pull_url_map")
        if isinstance(hls_map, dict) and hls_map:
            best_key = max(
                hls_map.keys(),
                key=lambda k: _FLV_QUALITY_ORDER.get(k.upper(), 0),
            )
            url = hls_map.get(best_key)
            if isinstance(url, str) and url:
                return url, best_key

        # 兜底：直接取根字段
        for key in ("flv_pull_url", "hls_pull_url", "rtmp_pull_url"):
            url = stream.get(key)
            if isinstance(url, str) and url:
                return url, key

        return None, ""

    @staticmethod
    def _is_hls_url(url: str) -> bool:
        return ".m3u8" in url.split("?")[0].lower()

    async def _record_stream_segmented(
        self,
        url: str,
        save_dir: Path,
        file_stem: str,
        *,
        segment_duration: float,
        max_duration: float,
        chunk_size: int,
        idle_timeout: float,
        output_format: str,
        ffmpeg_path: Optional[str],
        emit: Optional[Callable[[str, Any], None]],
        stop_event: asyncio.Event,
        room_id: Optional[str] = None,
    ) -> bool:
        """循环录制多个分片，直到主播下播、达到 max_duration 或 stop_event 触发。"""
        if segment_duration <= 0:
            segment_duration = float("inf")

        is_hls = self._is_hls_url(url)
        session_start = time.monotonic()
        segment_index = 0
        any_success = False
        live_cfg = self._live_config()
        reconnect_delay = float(live_cfg.get("reconnect_delay_seconds") or 5)

        while not stop_event.is_set():
            segment_index += 1
            now = datetime.now()
            segment_stem = f"{file_stem}_part{segment_index:03d}_{now.strftime('%H%M%S')}"

            if output_format == "mp4":
                src_suffix = ".ts" if is_hls else ".flv"
                dst_suffix = ".mp4"
            else:
                src_suffix = ".ts" if is_hls else ".flv"
                dst_suffix = src_suffix

            src_path = save_dir / f"{segment_stem}{src_suffix}"
            dst_path = save_dir / f"{segment_stem}{dst_suffix}"

            if emit:
                emit("live:recording", room_id=room_id, segment_index=segment_index, path=str(src_path))

            remaining_max = float("inf")
            if max_duration:
                elapsed = time.monotonic() - session_start
                remaining_max = max(0.0, max_duration - elapsed)
                if remaining_max <= 0:
                    logger.info("Live session max_duration reached")
                    break

            this_segment_duration = min(segment_duration, remaining_max)
            segment_start_ts = time.monotonic()

            if is_hls:
                ok = await self._record_hls_segment(
                    url,
                    src_path,
                    max_duration=this_segment_duration,
                    ffmpeg_path=ffmpeg_path,
                    stop_event=stop_event,
                )
            else:
                ok = await self._record_one_segment(
                    url,
                    src_path,
                    max_duration=this_segment_duration,
                    chunk_size=chunk_size,
                    idle_timeout=idle_timeout,
                    stop_event=stop_event,
                )

            if ok:
                any_success = True

            bytes_written = src_path.stat().st_size if src_path.exists() else 0
            actual_duration = (
                time.monotonic() - segment_start_ts
                if ok and bytes_written > 0
                else 0.0
            )

            if output_format == "mp4" and src_path.exists() and bytes_written > 0:
                remux_ok = await self._remux_to_mp4(
                    src_path, dst_path, ffmpeg_path=ffmpeg_path
                )
                if remux_ok and dst_path.exists() and dst_path.stat().st_size > 0:
                    try:
                        src_path.unlink()
                    except Exception as exc:
                        logger.debug("Remove source segment failed: %s", exc)
                    if emit:
                        emit(
                            "live:segment",
                            room_id=room_id,
                            segment_index=segment_index,
                            src=str(src_path),
                            dst=str(dst_path),
                            duration=actual_duration,
                            bytes=dst_path.stat().st_size,
                        )
                else:
                    # 转封装失败：保留原始片段并通知前端
                    if emit:
                        emit(
                            "live:segment",
                            room_id=room_id,
                            segment_index=segment_index,
                            src=str(src_path),
                            dst=str(src_path),
                            duration=actual_duration,
                            bytes=bytes_written,
                        )
            else:
                if emit and src_path.exists() and bytes_written > 0:
                    emit(
                        "live:segment",
                        room_id=room_id,
                        segment_index=segment_index,
                        src=str(src_path),
                        dst=str(src_path),
                        duration=actual_duration,
                        bytes=bytes_written,
                    )

            # 分片因达到时长结束，说明直播可能仍在继续，继续下一片
            # 若因下播/错误结束，则退出循环
            if not ok:
                logger.info("Live segment ended unsuccessfully, stopping session")
                break

            # 检查是否达到总时长
            if max_duration and (time.monotonic() - session_start) >= max_duration:
                logger.info("Live session max_duration reached after segment")
                break

            # 检查是否被停止
            if stop_event.is_set():
                break

            try:
                await asyncio.wait_for(stop_event.wait(), timeout=reconnect_delay)
            except asyncio.TimeoutError:
                pass

        return any_success

    async def _record_one_segment(
        self,
        url: str,
        target_path: Path,
        *,
        max_duration: float,
        chunk_size: int,
        idle_timeout: float,
        stop_event: asyncio.Event,
    ) -> bool:
        """录制单个 FLV 分片。返回是否成功写入有效数据。"""
        target_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = target_path.with_suffix(".tmp" + target_path.suffix)
        start = time.monotonic()
        bytes_written = 0
        last_chunk_ts = start

        headers = self._download_headers()
        headers["Referer"] = "https://live.douyin.com/"
        headers["Origin"] = "https://live.douyin.com"

        def _promote_if_nonempty(reason: str) -> bool:
            if bytes_written <= 0:
                try:
                    tmp_path.unlink(missing_ok=True)
                except Exception:
                    pass
                return False
            try:
                os.replace(str(tmp_path), str(target_path))
            except Exception as exc:
                logger.error("Live tmp → final rename failed: %s", exc)
                return False
            logger.info(
                "Live segment recorded (%s): %s (%.1fs, %.1f MiB)",
                reason,
                target_path.name,
                last_chunk_ts - start,
                bytes_written / (1024 * 1024),
            )
            return True

        session = await self.api_client.get_session()
        try:
            async with session.get(
                url,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=None, sock_read=idle_timeout),
            ) as resp:
                if resp.status != 200:
                    logger.error("Live stream HTTP %s for %s", resp.status, target_path.name)
                    return False
                async with aiofiles.open(tmp_path, "wb") as f:
                    async for chunk in resp.content.iter_chunked(chunk_size):
                        if stop_event.is_set():
                            break
                        if not chunk:
                            continue
                        await f.write(chunk)
                        bytes_written += len(chunk)
                        now = time.monotonic()
                        last_chunk_ts = now
                        if max_duration and (now - start) >= max_duration:
                            logger.info(
                                "Live segment max_duration reached (%.1fs), stopping.",
                                max_duration,
                            )
                            break
                return _promote_if_nonempty("segment ended")
        except asyncio.CancelledError:
            _promote_if_nonempty("cancelled")
            raise
        except aiohttp.ClientPayloadError as exc:
            logger.info("Live payload ended: %s", exc)
            return _promote_if_nonempty("payload ended")
        except (asyncio.TimeoutError, aiohttp.ServerTimeoutError) as exc:
            logger.info("Live stream idle timeout after %ss: %s", idle_timeout, exc)
            return _promote_if_nonempty("idle timeout")
        except Exception as exc:
            logger.error("Live stream recording failed: %s", exc)
            return _promote_if_nonempty("unexpected error")

    async def _record_hls_segment(
        self,
        url: str,
        target_path: Path,
        *,
        max_duration: float,
        ffmpeg_path: Optional[str],
        stop_event: Optional[asyncio.Event] = None,
    ) -> bool:
        """使用 ffmpeg 直接 ingest HLS URL 录制单个分片。"""
        target_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = target_path.with_suffix(".tmp" + target_path.suffix)

        ffmpeg_exe = await self._resolve_ffmpeg_path(ffmpeg_path)
        if not ffmpeg_exe:
            logger.error("ffmpeg not available for HLS recording: %s", target_path.name)
            return False

        duration_arg = []
        if max_duration and max_duration != float("inf"):
            duration_arg = ["-t", str(int(max_duration))]

        cmd = [
            ffmpeg_exe,
            "-y",
            "-fflags", "+discardcorrupt",
            "-i", url,
            *duration_arg,
            "-c", "copy",
            "-movflags", "+faststart",
            str(tmp_path),
        ]

        # 直播 CDN 常校验 Referer
        env = os.environ.copy()
        env["HTTP_REFERER"] = "https://live.douyin.com/"

        proc: Optional[asyncio.subprocess.Process] = None
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
            # 允许外部取消通过 stop_event 终止 ffmpeg
            if stop_event is not None:
                async def _watch_stop():
                    await stop_event.wait()
                    if proc.returncode is None:
                        proc.terminate()

                watcher = asyncio.create_task(_watch_stop())
            else:
                watcher = None

            try:
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(), timeout=max_duration + 60 if max_duration and max_duration != float("inf") else None
                )
            finally:
                if watcher is not None:
                    watcher.cancel()
                    try:
                        await watcher
                    except asyncio.CancelledError:
                        pass

            if proc.returncode != 0:
                logger.warning(
                    "ffmpeg HLS recording exited %s: %s",
                    proc.returncode,
                    stderr.decode("utf-8", errors="ignore")[-500:] if stderr else "",
                )
                # 即使退出码非零，只要 tmp 有数据就保留
                if tmp_path.exists() and tmp_path.stat().st_size > 0:
                    try:
                        os.replace(str(tmp_path), str(target_path))
                        logger.info("Live HLS segment preserved despite ffmpeg error: %s", target_path.name)
                        return True
                    except Exception as exc:
                        logger.error("Live HLS tmp rename failed: %s", exc)
                return False

            if not tmp_path.exists() or tmp_path.stat().st_size <= 0:
                return False

            os.replace(str(tmp_path), str(target_path))
            logger.info("Live HLS segment recorded: %s", target_path.name)
            return True
        except asyncio.CancelledError:
            if proc is not None and proc.returncode is None:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=5.0)
                except Exception:
                    proc.kill()
            if tmp_path.exists() and tmp_path.stat().st_size > 0:
                try:
                    os.replace(str(tmp_path), str(target_path))
                except Exception:
                    pass
            raise
        except Exception as exc:
            logger.error("Live HLS recording failed: %s", exc)
            if tmp_path.exists() and tmp_path.stat().st_size > 0:
                try:
                    os.replace(str(tmp_path), str(target_path))
                    return True
                except Exception:
                    pass
            return False

    async def _remux_to_mp4(
        self,
        src: Path,
        dst: Path,
        ffmpeg_path: Optional[str] = None,
    ) -> bool:
        """用 ffmpeg 把 FLV/TS 转封装为 MP4，-c copy 不重新编码。"""
        ffmpeg_exe = await self._resolve_ffmpeg_path(ffmpeg_path)
        if not ffmpeg_exe:
            logger.warning("ffmpeg not available, keep original: %s", src)
            return False

        dst_tmp = dst.with_suffix(".tmp" + dst.suffix)
        cmd = [
            ffmpeg_exe,
            "-y",
            "-fflags", "+discardcorrupt",
            "-i", str(src),
            "-c", "copy",
            "-movflags", "+faststart",
            str(dst_tmp),
        ]

        proc: Optional[asyncio.subprocess.Process] = None
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=300)
            if proc.returncode != 0:
                logger.warning(
                    "ffmpeg remux failed (exit %s): %s",
                    proc.returncode,
                    stderr.decode("utf-8", errors="ignore")[-500:] if stderr else "",
                )
                if dst_tmp.exists():
                    try:
                        dst_tmp.unlink()
                    except Exception:
                        pass
                return False

            if not dst_tmp.exists() or dst_tmp.stat().st_size <= 0:
                return False

            os.replace(str(dst_tmp), str(dst))
            logger.info("Live remuxed to MP4: %s", dst.name)
            return True
        except asyncio.TimeoutError:
            if proc is not None:
                proc.kill()
                try:
                    await proc.wait()
                except Exception:
                    pass
            if dst_tmp.exists():
                try:
                    dst_tmp.unlink()
                except Exception:
                    pass
            logger.warning("ffmpeg remux timeout for %s", src)
            return False
        except Exception as exc:
            logger.error("ffmpeg remux error: %s", exc)
            if dst_tmp.exists():
                try:
                    dst_tmp.unlink()
                except Exception:
                    pass
            return False

    async def _resolve_ffmpeg_path(self, override: Optional[str] = None) -> Optional[str]:
        """定位 ffmpeg 可执行文件。优先使用用户覆盖路径，其次 imageio_ffmpeg。"""
        if override:
            path = str(override)
            if os.path.isfile(path) and os.access(path, os.X_OK):
                return path
            # 也尝试 PATH 查找
            found = shutil.which(path)
            if found:
                return found
            return None

        try:
            import imageio_ffmpeg
            path = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception as exc:
            logger.debug("imageio_ffmpeg not available: %s", exc)
            path = shutil.which("ffmpeg")

        if path and os.path.isfile(path):
            return path
        return None
