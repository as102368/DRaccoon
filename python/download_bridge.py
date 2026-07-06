"""下载桥接脚本。

支持单条和批量抖音链接下载，复用 douyin-downloader 的下载内核，并通过
stdout 输出 JSON Lines 事件给 Electron 主进程。
"""
from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path
from typing import Any

from lib.bridge import BridgeContext, BridgeOutput, safe_main
from lib.compat import ensure_backend_path

ensure_backend_path()

from auth import CookieManager
from cli import main as cli_main
from config import ConfigLoader
from storage import Database
from utils.cookie_utils import parse_cookie_header
from utils.logger import set_console_log_level

# 静默原本输出到 stderr 的进度日志，由 Electron 通过 stdout 事件转发。
set_console_log_level(logging.CRITICAL)


class DummyDisplay:
    """屏蔽 CLI 的 Rich 终端交互，避免在 Electron 子进程中写入控制台。

    同时将进度回调委托给 ProgressReporter，确保 CLI 通过 display 发出的进度也能被转发。
    """

    def __init__(self, reporter: ProgressReporter | None = None):
        self._reporter = reporter

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
        if self._reporter:
            self._reporter.advance_step(step, detail)

    def update_step(self, step: str, detail: str = "") -> None:
        if self._reporter:
            self._reporter.update_step(step, detail)

    def set_item_total(self, total: int, detail: str = "") -> None:
        if self._reporter:
            self._reporter.set_item_total(total, detail)

    def advance_item(self, status: str, detail: str = "") -> None:
        if self._reporter:
            self._reporter.advance_item(status, detail)

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
    return config


def _build_cookie_manager(job: dict[str, Any], config: ConfigLoader) -> CookieManager:
    cookies = job.get("cookies") or {}
    if isinstance(cookies, str):
        cookies = parse_cookie_header(cookies)

    output_path = config.get("path") or "."
    Path(output_path).mkdir(parents=True, exist_ok=True)

    cookie_manager = CookieManager(
        cookie_file=str(Path(output_path) / ".cookies.json")
    )
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


async def _run(ctx: BridgeContext, job: dict[str, Any], out: BridgeOutput) -> None:
    urls = _normalize_urls(job)
    if not urls:
        raise ValueError("没有可下载的 URL")

    config = _build_config(job)
    cookie_manager = _build_cookie_manager(job, config)
    database = await _init_database(config)

    total_success = 0
    total_failed = 0
    total_skipped = 0

    try:
        out.log(f"任务开始，共 {len(urls)} 个链接待处理")
        for idx, url in enumerate(urls, 1):
            out.emit(
                "url_start",
                data={"index": idx, "total": len(urls), "url": url},
            )
            reporter = ProgressReporter(out, url, idx, len(urls))
            # 屏蔽 Rich 控制台输出，所有进度通过 BridgeOutput 发出。
            cli_main.display = DummyDisplay(reporter)
            try:
                result = await cli_main.download_url(
                    url,
                    config,
                    cookie_manager,
                    database,
                    progress_reporter=reporter,
                )
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
        if database is not None:
            try:
                await database.close()
            except Exception:
                pass


def main(ctx: BridgeContext, job: dict[str, Any], out: BridgeOutput) -> None:
    asyncio.run(_run(ctx, job, out))


if __name__ == "__main__":
    safe_main(main)
