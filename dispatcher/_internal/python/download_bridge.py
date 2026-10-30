"""下载桥接脚本。

支持单条和批量抖音链接下载，复用 douyin-downloader 的下载内核，并通过
stdout 输出 JSON Lines 事件给 Electron 主进程。
"""
from __future__ import annotations

import asyncio
import contextvars
import io
import json
import logging
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

import aiofiles
import aiohttp

from lib.bridge import BridgeContext, BridgeOutput, safe_main
from lib.compat import ensure_backend_path


def _ensure_utf8_stdio() -> None:
    """强制 stdout/stderr 使用 UTF-8，避免中文在 Windows 打包环境下被 GBK 编码导致乱码。"""
    try:
        if getattr(sys.stdout, "buffer", None) and sys.stdout.encoding != "utf-8":
            sys.stdout = io.TextIOWrapper(
                sys.stdout.buffer, encoding="utf-8", line_buffering=True
            )
        if getattr(sys.stderr, "buffer", None) and sys.stderr.encoding != "utf-8":
            sys.stderr = io.TextIOWrapper(
                sys.stderr.buffer, encoding="utf-8", line_buffering=True
            )
    except Exception:
        pass


_ensure_utf8_stdio()

ensure_backend_path()

from auth import CookieManager
from cli import main as cli_main
from config import ConfigLoader
from storage import Database, FileManager
from utils.cookie_utils import parse_cookie_header
from utils.logger import set_console_log_level
from utils.proxy_pool import ProxyPool
from utils.validators import sanitize_filename

# 当前 URL 对应的进度 reporter，使用 contextvars 避免并发下载时互相覆盖。
_current_reporter: contextvars.ContextVar["ProgressReporter | None"] = contextvars.ContextVar(
    "current_reporter", default=None
)

# 静默原本输出到 stderr 的进度日志，由 Electron 通过 stdout 事件转发。
set_console_log_level(logging.CRITICAL)

# 心跳间隔，必须小于主进程 DOWNLOAD_STALL_MS，保证看门狗不会误判卡死。
HEARTBEAT_INTERVAL_SECONDS = 25


async def _heartbeat(out: BridgeOutput) -> None:
    """定期发送心跳事件，让主进程知道子进程仍在运行。"""
    try:
        while True:
            await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS)
            out.emit("heartbeat", {"ts": asyncio.get_event_loop().time()})
    except asyncio.CancelledError:
        # 任务结束或进程被终止时正常退出。
        raise


class DummyDisplay:
    """屏蔽 CLI 的 Rich 终端交互，避免在 Electron 子进程中写入控制台。

    进度回调通过 contextvars 读取当前 URL 的 ProgressReporter，避免全局对象被并发覆盖。
    """

    @staticmethod
    def _reporter() -> "ProgressReporter | None":
        return _current_reporter.get()

    def show_banner(self) -> None:
        pass

    def print_info(self, _msg: str) -> None:
        pass

    def print_warning(self, _msg: str) -> None:
        pass

    def print_error(self, _msg: str) -> None:
        pass

    def print_success(self, _msg: str) -> None:
        pass

    def start_download_session(self, _total: int) -> None:
        pass

    def stop_download_session(self) -> None:
        pass

    def start_url(self, _idx: int, _total: int, _url: str) -> None:
        pass

    def complete_url(self, _result=None) -> None:
        pass

    def fail_url(self, _reason: str) -> None:
        pass

    def advance_step(self, step: str, detail: str = "") -> None:
        reporter = self._reporter()
        if reporter:
            reporter.advance_step(step, detail)

    def update_step(self, step: str, detail: str = "") -> None:
        reporter = self._reporter()
        if reporter:
            reporter.update_step(step, detail)

    def set_item_total(self, total: int, detail: str = "") -> None:
        reporter = self._reporter()
        if reporter:
            reporter.set_item_total(total, detail)

    def advance_item(self, status: str, detail: str = "") -> None:
        reporter = self._reporter()
        if reporter:
            reporter.advance_item(status, detail)

    def show_result(self, _result) -> None:
        pass


class ProgressReporter:
    """将 douyin-downloader 的进度回调转换为 JSON Lines 事件。"""

    def __init__(self, out: BridgeOutput, url: str, index: int, total: int):
        self.out = out
        self.url = url
        self.index = index
        self.total = total

    def _emit(self, event: str, **kwargs: Any) -> None:
        self.out.emit(
            event,
            data={"url": self.url, "index": self.index, "total": self.total, **kwargs},
        )

    def update_step(self, step: str, detail: str = "") -> None:
        self._emit("step", step=step, detail=detail)

    def advance_step(self, step: str, detail: str = "") -> None:
        self._emit("step", step=step, detail=detail)

    def set_item_total(self, total: int, detail: str = "") -> None:
        self._emit("item_total", total=total, detail=detail)

    def advance_item(self, status: str, detail: str = "") -> None:
        self._emit("item_advanced", status=status, detail=detail)

    def on_author(self, *, nickname: str | None = None, sec_uid: str | None = None) -> None:
        if nickname:
            self._emit("author", nickname=nickname, sec_uid=sec_uid)

    def on_title(self, title: str | None = None) -> None:
        if title:
            self._emit("title", title=title)


def _normalize_urls(job: dict[str, Any]) -> list[str]:
    urls = job.get("urls") or []
    if isinstance(urls, str):
        urls = [urls]
    return [str(u).strip() for u in urls if str(u).strip()]


def _build_config(job: dict[str, Any]) -> ConfigLoader:
    config = ConfigLoader(None)
    config.config.update(job.get("config", {}))
    download_context = job.get("downloadContext") or job.get("download_context")
    if download_context:
        config.config["download_context"] = download_context
    return config


def _build_cookie_manager(job: dict[str, Any], config: ConfigLoader) -> CookieManager:
    cookies = job.get("cookies") or {}
    if isinstance(cookies, str):
        cookies = parse_cookie_header(cookies)

    cookie_file = str(job.get("cookieFile") or "").strip()
    if not cookie_file:
        output_path = config.get("path") or "."
        Path(output_path).mkdir(parents=True, exist_ok=True)
        cookie_file = str(Path(output_path) / ".cookies.json")
    else:
        Path(cookie_file).parent.mkdir(parents=True, exist_ok=True)

    cookie_manager = CookieManager(cookie_file=cookie_file)
    if cookies:
        cookie_manager.set_cookies(cookies)
    return cookie_manager


async def _init_database(config: ConfigLoader) -> Database | None:
    if not config.get("database"):
        return None
    output_path = config.get("path") or "."
    db_path = config.get("database_path") or str(Path(output_path) / "dy_downloader.db")
    database = Database(db_path=str(db_path))
    await database.initialize()
    return database


def _classify_error(exc: Exception) -> str:
    """把异常转换为客户能看懂的原因。"""
    msg = str(exc).lower()
    if any(k in msg for k in ("rate limit", "429", "too many requests", "请求太频繁", "频繁", "限速")):
        return "请求过于频繁，已被抖音限流，请稍后再试"
    if any(k in msg for k in ("cookie", "login", "未登录", "未授权", " unauthorized", "auth", "login_expire")):
        return "登录状态已失效，请重新登录后再试"
    if any(k in msg for k in ("not found", "404", "无效", "不存在", "deleted", "removed")):
        return "链接无效或作品已删除"
    if any(k in msg for k in ("private", "私密", "权限", "forbidden", "无权限")):
        return "作品未公开或无权限下载"
    if any(k in msg for k in ("timeout", "timed out", "network", "connection", "connect", "ssl", "dns", "无法连接")):
        return "网络连接异常，请检查网络后重试"
    return f"下载失败：{exc}"


def _extract_title(result: Any) -> str | None:
    """尝试从下载结果中提取作品标题。"""
    if result is None:
        return None
    if isinstance(result, dict):
        return result.get("title") or result.get("desc")
    return getattr(result, "title", None) or getattr(result, "desc", None)


def _build_category_path(context: dict[str, Any]) -> Optional[str]:
    """根据前端传入的下载上下文构造分类目录路径。"""
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

    return "/".join(sanitize_filename(p) for p in parts)


def _is_direct_audio_url(url: str) -> bool:
    """粗略判断 URL 是否为音频直链。"""
    url_lower = url.split("?")[0].lower()
    return url_lower.endswith((".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg"))


async def _download_direct_audio(
    url: str,
    config: ConfigLoader,
    database: Database | None,
    reporter: ProgressReporter,
    out: BridgeOutput,
) -> dict[str, Any]:
    """下载收藏音乐直链到分类目录。"""
    context = config.get("download_context") or {}
    category_path = _build_category_path(context)
    if not category_path:
        raise ValueError("音乐直链下载缺少分类目录上下文")

    file_manager = FileManager(config.get("path"))
    save_dir = file_manager.get_save_path(
        author_name="music",
        mode=None,
        folderstyle=False,
        category_path=category_path,
    )

    music_name = str(context.get("musicName") or "未知音乐").strip()
    url_stem = Path(url.split("?")[0]).suffix.lower()
    ext = url_stem if url_stem in {".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg"} else ".mp3"
    save_path = save_dir / f"{sanitize_filename(music_name)}{ext}"

    reporter.update_step("下载音乐", f"{music_name}")
    reporter.set_item_total(1, "音乐文件")

    proxy = ProxyPool.single_proxy_from_config(config)
    timeout = aiohttp.ClientTimeout(total=120, connect=30)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(url, proxy=proxy) as resp:
            resp.raise_for_status()
            save_path.parent.mkdir(parents=True, exist_ok=True)
            async with aiofiles.open(save_path, "wb") as f:
                async for chunk in resp.content.iter_chunked(64 * 1024):
                    await f.write(chunk)

    reporter.advance_item("success", str(save_path.name))
    out.log(f"音乐已保存: {save_path}")

    if database:
        safe_config = {
            k: v
            for k, v in config.config.items()
            if k not in ("cookies", "cookie", "transcript")
        }
        await database.add_history(
            {
                "url": url,
                "url_type": "music",
                "total_count": 1,
                "success_count": 1,
                "config": json.dumps(safe_config, ensure_ascii=False),
                "status": "success",
                "file_path": str(save_path),
            }
        )

    return {"total": 1, "success": 1, "failed": 0, "skipped": 0}


def _per_url_timeout_seconds(job: dict[str, Any]) -> int:
    """从任务配置读取单链接最大运行时间（分钟），默认 30 分钟。"""
    minutes = job.get("perUrlTimeoutMinutes")
    if minutes is None:
        minutes = 30
    try:
        minutes = int(minutes)
    except (TypeError, ValueError):
        minutes = 30
    return max(1, minutes) * 60


async def _run(ctx: BridgeContext, job: dict[str, Any], out: BridgeOutput) -> None:
    urls = _normalize_urls(job)
    if not urls:
        raise ValueError("没有可下载的 URL")

    config = _build_config(job)
    cookie_manager = _build_cookie_manager(job, config)
    database = await _init_database(config)
    per_url_timeout_seconds = _per_url_timeout_seconds(job)

    total_success = 0
    total_failed = 0
    total_skipped = 0

    heartbeat_task = asyncio.create_task(_heartbeat(out))

    # 屏蔽 Rich 控制台输出，所有进度通过 BridgeOutput 发出。
    # DummyDisplay 内部通过 contextvars 读取当前 reporter，避免多 URL 并发时状态串扰。
    cli_main.display = DummyDisplay()

    try:
        out.log(f"任务开始，共 {len(urls)} 个链接待处理")
        for idx, url in enumerate(urls, 1):
            out.emit(
                "url_start",
                data={"index": idx, "total": len(urls), "url": url},
            )
            reporter = ProgressReporter(out, url, idx, len(urls))
            _current_reporter.set(reporter)
            try:
                context = config.get("download_context") or {}
                is_music_context = (
                    isinstance(context, dict) and context.get("subCategory") == "music"
                )
                if is_music_context and _is_direct_audio_url(url):
                    download_coro = _download_direct_audio(
                        url, config, database, reporter, out
                    )
                else:
                    download_coro = cli_main.download_url(
                        url,
                        config,
                        cookie_manager,
                        database,
                        progress_reporter=reporter,
                    )
                result = await asyncio.wait_for(
                    download_coro, timeout=per_url_timeout_seconds
                )
                if is_music_context and _is_direct_audio_url(url):
                    result = SimpleNamespace(**result)
                if result:
                    title = _extract_title(result)
                    if title:
                        reporter.on_title(title)
                    out.emit(
                        "url_result",
                        data={
                            "url": url,
                            "total": result.total,
                            "success": result.success,
                            "failed": result.failed,
                            "skipped": result.skipped,
                        },
                    )
                    total_success += result.success
                    total_failed += result.failed
                    total_skipped += result.skipped
                else:
                    out.log("链接处理未返回结果，请检查链接与 Cookie 是否有效", level="error")
                    out.emit("url_error", data={"url": url, "message": "链接无效或处理失败，请检查 Cookie 与链接"})
                    out.emit(
                        "url_result",
                        data={
                            "url": url,
                            "total": 0,
                            "success": 0,
                            "failed": 1,
                            "skipped": 0,
                        },
                    )
                    total_failed += 1
            except asyncio.TimeoutError:
                logging.exception("下载超时：%s", url)
                timeout_minutes = per_url_timeout_seconds // 60
                reason = f"单链接处理超过 {timeout_minutes} 分钟，已自动跳过"
                out.log(f"下载失败：{reason}", level="error")
                out.emit("url_error", data={"url": url, "message": reason})
                out.emit(
                    "url_result",
                    data={
                        "url": url,
                        "total": 0,
                        "success": 0,
                        "failed": 1,
                        "skipped": 0,
                    },
                )
                total_failed += 1
            except asyncio.CancelledError:
                # 用户取消或主进程终止，停止处理后续链接。
                raise
            except Exception as exc:
                logging.exception("下载失败：%s", url)
                reason = _classify_error(exc)
                out.log(f"下载失败：{reason}", level="error")
                out.emit("url_error", data={"url": url, "message": reason, "detail": str(exc)})
                out.emit(
                    "url_result",
                    data={
                        "url": url,
                        "total": 0,
                        "success": 0,
                        "failed": 1,
                        "skipped": 0,
                    },
                )
                total_failed += 1

        out.log(
            f"任务结束：成功 {total_success} 个，失败 {total_failed} 个，跳过 {total_skipped} 个"
        )
        out.finished(
            success=True,
            data={
                "urls_count": len(urls),
                "total_success": total_success,
                "total_failed": total_failed,
                "total_skipped": total_skipped,
            },
        )
    finally:
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass
        if database is not None:
            try:
                await database.close()
            except Exception:
                pass


def main(ctx: BridgeContext, job: dict[str, Any], out: BridgeOutput) -> None:
    asyncio.run(_run(ctx, job, out))


if __name__ == "__main__":
    safe_main(main)
