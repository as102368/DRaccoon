"""视频转码与音频抽取管线。

下载完成后可选调用 ffmpeg：
- 按目标分辨率/码率重新压缩视频（保留原文件）。
- 单独抽取音频轨道保存为 MP3。

ffmpeg 二进制复用 ``core.audio_extraction`` 中的 ``FfmpegLocator``，
运行时不依赖系统 PATH 上的 ffmpeg。
"""
from __future__ import annotations

import asyncio
import collections
import re
from pathlib import Path
from typing import Any, Dict, Optional

from core.audio_extraction import (
    FfmpegLocator,
    FfmpegNotAvailable,
    _kill_and_reap as _base_kill_and_reap,
    _safe_unlink,
)
from storage import FileManager
from utils.logger import setup_logger

logger = setup_logger("Transcoder")


# ---------------------------------------------------------------------------
# Public exceptions
# ---------------------------------------------------------------------------


class TranscodeError(Exception):
    """所有转码/音频抽取失败的基类。"""

    cause: str = "unknown"

    def __init__(self, detail: str = "") -> None:
        prefix = f"transcode_failed: {self.cause}"
        super().__init__(f"{prefix}: {detail}" if detail else prefix)


class TranscodeFfmpegNotAvailable(TranscodeError):
    """ffmpeg 二进制不可用。"""

    cause = "ffmpeg_not_available"


class TranscodeTimeout(TranscodeError):
    """ffmpeg 子进程在超时内未结束。"""

    cause = "transcode_timeout"


class TranscodeNonZeroExit(TranscodeError):
    """ffmpeg 子进程以非零退出码结束。"""

    cause = "nonzero_exit_code"


class TranscodeOutputEmpty(TranscodeError):
    """ffmpeg 退出码为 0，但输出文件不存在或大小为 0 字节。"""

    cause = "output_empty"


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------


_FFMPEG_TIMEOUT_SECONDS = 3600.0
"""ffmpeg 转码子进程硬超时。"""

_STDERR_RING_LIMIT_BYTES = 1 * 1024 * 1024
"""stderr 环形缓冲上限。"""

_STDERR_TAIL_BYTES = 4096
"""非零退出时返回给上层的 stderr 末尾字节数。"""

_RESOLUTION_RE = re.compile(r"^(\d+)\s*p?$", re.IGNORECASE)
"""解析 "720p" / "720" 等简写分辨率。"""

_DEFAULT_VIDEO_CODEC = "libx264"
_DEFAULT_AUDIO_CODEC = "aac"
_DEFAULT_AUDIO_EXTRACT_CODEC = "libmp3lame"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parse_resolution(value: str) -> Optional[int]:
    """把 ``720p`` / ``720`` 解析为高度数值；无法解析返回 None。"""
    value = str(value or "").strip().lower()
    if not value:
        return None
    match = _RESOLUTION_RE.match(value)
    if match:
        return int(match.group(1))
    return None


def _resolution_to_scale_filter(height: int) -> str:
    """生成保持宽高比的缩放滤镜：宽度调整为 2 的倍数。"""
    return f"scale=-2:{height}"


def _ensure_bitrate(value: Any) -> str:
    """把配置值规范化为 ffmpeg 可识别的码率字符串。"""
    value = str(value or "").strip()
    if not value:
        return ""
    value = value.replace(" ", "")
    if value.lower().endswith("k") or value.lower().endswith("m"):
        return value
    try:
        int(value)
        return f"{value}k"
    except ValueError:
        return value


def _build_output_path(
    video_path: Path,
    suffix: str,
    output_dir: Optional[Path] = None,
) -> Path:
    """构造不覆盖原文件的输出路径。"""
    directory = output_dir or video_path.parent
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{video_path.stem}{suffix}"


async def _kill_and_reap(proc: asyncio.subprocess.Process) -> None:
    """复用 audio_extraction 的进程清理逻辑。"""
    await _base_kill_and_reap(proc)


async def _run_ffmpeg(
    args: tuple,
    output_path: Path,
    timeout: Optional[float] = None,
) -> None:
    """执行 ffmpeg 命令，处理超时、非零退出、空输出等失败路径。"""
    if timeout is None:
        timeout = _FFMPEG_TIMEOUT_SECONDS
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )

    stderr_ring: collections.deque = collections.deque(
        maxlen=_STDERR_RING_LIMIT_BYTES
    )

    async def _drain_stderr() -> None:
        assert proc.stderr is not None
        while True:
            chunk = await proc.stderr.read(8192)
            if not chunk:
                break
            stderr_ring.extend(chunk)

    try:
        await asyncio.wait_for(
            asyncio.gather(_drain_stderr(), proc.wait()),
            timeout=timeout,
        )
    except asyncio.TimeoutError:
        await _kill_and_reap(proc)
        _safe_unlink(output_path)
        raise TranscodeTimeout(f"timeout after {int(timeout)}s")
    except BaseException:
        await _kill_and_reap(proc)
        _safe_unlink(output_path)
        raise

    if proc.returncode != 0:
        tail_bytes = bytes(stderr_ring)[-_STDERR_TAIL_BYTES:]
        tail = tail_bytes.decode("utf-8", errors="replace")
        _safe_unlink(output_path)
        raise TranscodeNonZeroExit(
            f"exit={proc.returncode}; stderr_tail={tail!r}"
        )

    try:
        size = output_path.stat().st_size if output_path.exists() else 0
    except OSError:
        size = 0
    if size <= 0:
        _safe_unlink(output_path)
        raise TranscodeOutputEmpty(
            f"output missing or empty at {output_path}"
        )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def transcode_video(
    video_path: Path,
    output_path: Path,
    cfg: Dict[str, Any],
    *,
    locator: Optional[FfmpegLocator] = None,
) -> Path:
    """把 ``video_path`` 按配置重新编码并写入 ``output_path``。

    Args:
        video_path: 源视频路径。
        output_path: 输出视频路径（通常以 ``_compressed.mp4`` 结尾）。
        cfg: 转码配置字典，支持的键见 ``config/default_config.py`` 的
            ``transcode`` 段。
        locator: 可选的 ``FfmpegLocator`` 实例；默认使用单例。

    Returns:
        实际输出路径（与 ``output_path`` 相同）。

    Raises:
        TranscodeFfmpegNotAvailable: ffmpeg 不可用。
        TranscodeTimeout: 子进程超时。
        TranscodeNonZeroExit: 子进程非零退出。
        TranscodeOutputEmpty: 输出文件为空或缺失。
    """
    locator = locator or FfmpegLocator.instance()
    try:
        ffmpeg_path = await locator.locate()
    except FfmpegNotAvailable as exc:
        raise TranscodeFfmpegNotAvailable(str(exc)) from exc

    output_path.parent.mkdir(parents=True, exist_ok=True)

    video_codec = str(cfg.get("video_codec") or _DEFAULT_VIDEO_CODEC).strip() or _DEFAULT_VIDEO_CODEC
    audio_codec = str(cfg.get("audio_codec") or _DEFAULT_AUDIO_CODEC).strip() or _DEFAULT_AUDIO_CODEC
    preset = str(cfg.get("preset") or "medium").strip() or "medium"

    video_bitrate = _ensure_bitrate(cfg.get("video_bitrate"))
    audio_bitrate = _ensure_bitrate(cfg.get("audio_bitrate"))

    resolution_value = str(cfg.get("video_resolution") or "").strip()
    height = _parse_resolution(resolution_value)

    crf = cfg.get("crf")
    try:
        crf = int(crf) if crf is not None else None
    except (TypeError, ValueError):
        crf = None

    args: list = [ffmpeg_path]
    if cfg.get("overwrite"):
        args.append("-y")
    else:
        args.append("-n")

    args.extend(["-i", str(video_path)])
    args.extend(["-c:v", video_codec])
    args.extend(["-preset", preset])

    if height is not None:
        args.extend(["-vf", _resolution_to_scale_filter(height)])

    if video_bitrate:
        args.extend(["-b:v", video_bitrate])
    elif crf is not None:
        args.extend(["-crf", str(crf)])

    args.extend(["-c:a", audio_codec])
    if audio_bitrate:
        args.extend(["-b:a", audio_bitrate])

    args.extend(["-movflags", "+faststart"])
    args.append(str(output_path))

    await _run_ffmpeg(tuple(args), output_path)
    return output_path


async def extract_audio_track(
    video_path: Path,
    output_path: Path,
    cfg: Dict[str, Any],
    *,
    locator: Optional[FfmpegLocator] = None,
) -> Path:
    """把 ``video_path`` 的音频轨道抽取为 MP3 并写入 ``output_path``。

    Args:
        video_path: 源视频路径。
        output_path: 输出 MP3 路径（通常以 ``_audio.mp3`` 结尾）。
        cfg: 转码配置字典。
        locator: 可选的 ``FfmpegLocator`` 实例；默认使用单例。

    Returns:
        实际输出路径。

    Raises:
        TranscodeFfmpegNotAvailable: ffmpeg 不可用。
        TranscodeTimeout: 子进程超时。
        TranscodeNonZeroExit: 子进程非零退出。
        TranscodeOutputEmpty: 输出文件为空或缺失。
    """
    locator = locator or FfmpegLocator.instance()
    try:
        ffmpeg_path = await locator.locate()
    except FfmpegNotAvailable as exc:
        raise TranscodeFfmpegNotAvailable(str(exc)) from exc

    output_path.parent.mkdir(parents=True, exist_ok=True)

    audio_bitrate = _ensure_bitrate(cfg.get("audio_bitrate")) or "128k"

    args: list = [ffmpeg_path]
    if cfg.get("overwrite"):
        args.append("-y")
    else:
        args.append("-n")

    args.extend([
        "-i",
        str(video_path),
        "-vn",
        "-c:a",
        _DEFAULT_AUDIO_EXTRACT_CODEC,
        "-b:a",
        audio_bitrate,
        str(output_path),
    ])

    await _run_ffmpeg(tuple(args), output_path)
    return output_path


# ---------------------------------------------------------------------------
# Manager
# ---------------------------------------------------------------------------


class TranscodeManager:
    """与 ``TranscriptManager`` 对齐的下载后转码管理器。"""

    def __init__(
        self,
        config,
        file_manager: Optional[FileManager] = None,
    ):
        self.config = config
        self.file_manager = file_manager

    def _cfg(self) -> Dict[str, Any]:
        return self.config.get("transcode", {}) or {}

    def _enabled(self) -> bool:
        return bool(self._cfg().get("enabled", False))

    def _audio_only(self) -> bool:
        return bool(self._cfg().get("audio_only", False))

    def _keep_original(self) -> bool:
        return bool(self._cfg().get("keep_original", True))

    def resolve_output_dir(self, video_path: Path) -> Path:
        """根据 ``output_dir`` 配置决定输出目录；空则与视频同目录。"""
        video_path = Path(video_path)
        output_dir = str(self._cfg().get("output_dir", "")).strip()
        if not output_dir:
            return video_path.parent

        output_root = Path(output_dir)
        if self.file_manager is None:
            return output_root

        try:
            relative_dir = video_path.parent.resolve().relative_to(
                self.file_manager.base_path.resolve()
            )
            return output_root / relative_dir
        except Exception:
            logger.warning(
                "Failed to mirror transcode path for video %s, fallback to video dir",
                video_path,
            )
            return video_path.parent

    def build_output_paths(self, video_path: Path) -> tuple[Path, Path]:
        """返回 (compressed_video_path, audio_mp3_path)。"""
        output_dir = self.resolve_output_dir(video_path)
        video_out = _build_output_path(video_path, "_compressed.mp4", output_dir)
        audio_out = _build_output_path(video_path, "_audio.mp3", output_dir)
        return video_out, audio_out

    async def process_video(
        self, video_path: Path, aweme_id: str
    ) -> Dict[str, Any]:
        """根据配置执行压缩或音频抽取。

        返回约定与 ``TranscriptManager.process_video`` 一致：
        ``{"status": "skipped" | "success" | "failed", ...}``。
        """
        video_path = Path(video_path)

        if not self._enabled():
            return {"status": "skipped", "reason": "disabled"}

        cfg = self._cfg()
        compressed_path, audio_path = self.build_output_paths(video_path)

        try:
            if self._audio_only():
                result_path = await extract_audio_track(video_path, audio_path, cfg)
                return {
                    "status": "success",
                    "type": "audio",
                    "output_path": str(result_path),
                }

            result_path = await transcode_video(video_path, compressed_path, cfg)

            if not self._keep_original():
                try:
                    video_path.unlink()
                except OSError as exc:
                    logger.warning(
                        "Transcode keep_original=False but failed to remove %s: %r",
                        video_path,
                        exc,
                    )

            return {
                "status": "success",
                "type": "video",
                "output_path": str(result_path),
            }
        except TranscodeFfmpegNotAvailable as exc:
            logger.error("Transcode failed for aweme %s: %s", aweme_id, exc)
            return {"status": "failed", "reason": "ffmpeg_not_available", "error": str(exc)}
        except TranscodeTimeout as exc:
            logger.error("Transcode timeout for aweme %s: %s", aweme_id, exc)
            return {"status": "failed", "reason": "timeout", "error": str(exc)}
        except TranscodeNonZeroExit as exc:
            logger.error("Transcode nonzero exit for aweme %s: %s", aweme_id, exc)
            return {"status": "failed", "reason": "nonzero_exit", "error": str(exc)}
        except TranscodeOutputEmpty as exc:
            logger.error("Transcode empty output for aweme %s: %s", aweme_id, exc)
            return {"status": "failed", "reason": "empty_output", "error": str(exc)}
        except Exception as exc:
            logger.exception("Unhandled transcode error for aweme %s", aweme_id)
            return {"status": "failed", "reason": "unknown", "error": str(exc)}


__all__ = [
    "TranscodeError",
    "TranscodeFfmpegNotAvailable",
    "TranscodeTimeout",
    "TranscodeNonZeroExit",
    "TranscodeOutputEmpty",
    "transcode_video",
    "extract_audio_track",
    "TranscodeManager",
]
