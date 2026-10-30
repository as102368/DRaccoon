#!/usr/bin/env python3
"""Electron 与 Python 下载后端的桥接脚本。

从 stdin 或 --job 文件读取 JSON 任务，逐条执行下载，并通过 stdout 输出 NDJSON 事件。
"""

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from auth import CookieManager
from config import ConfigLoader
from storage import Database
from utils.logger import set_console_log_level

# 静默原本输出到 stderr 的进度日志，由 Electron 通过 stderr 原样转发。
set_console_log_level(logging.CRITICAL)

from cli import main as cli_main  # noqa: E402


class DummyDisplay:
    """屏蔽 CLI 的 Rich 终端交互。"""

    def show_banner(self): pass
    def print_info(self, _msg): pass
    def print_warning(self, _msg): pass
    def print_error(self, _msg): pass
    def print_success(self, _msg): pass
    def start_download_session(self, _total): pass
    def stop_download_session(self): pass
    def start_url(self, _idx, _total, _url): pass
    def complete_url(self, _result): pass
    def fail_url(self, _msg): pass


cli_main.display = DummyDisplay()


class JsonProgressReporter:
    def __init__(self, url: str):
        self.url = url

    def _emit(self, event: str, **kwargs):
        payload = {"event": event, "url": self.url, **kwargs}
        print(json.dumps(payload, ensure_ascii=False), flush=True)

    def update_step(self, step: str, detail: str = ""):
        self._emit("step", step=step, detail=detail)

    def advance_step(self, step: str, detail: str = ""):
        self._emit("step", step=step, detail=detail)

    def set_item_total(self, total: int, detail: str = ""):
        self._emit("item_total", total=total, detail=detail)

    def advance_item(self, status: str, detail: str = ""):
        self._emit("item_advanced", status=status, detail=detail)

    def on_author(self, *, nickname=None, sec_uid=None):
        if nickname:
            self._emit("author", nickname=nickname, sec_uid=sec_uid)


def emit(event: str, **kwargs):
    print(json.dumps({"event": event, **kwargs}, ensure_ascii=False), flush=True)


async def run_job(job: dict):
    config = ConfigLoader(None)
    config.config.update(job.get("config", {}))

    cookies = job.get("cookies") or {}
    if isinstance(cookies, str):
        from utils.cookie_utils import parse_cookie_header
        cookies = parse_cookie_header(cookies)

    cookie_manager = CookieManager(
        cookie_file=str(Path(config.get("path", ".")) / ".cookies.json")
    )
    cookie_manager.set_cookies(cookies)

    database = None
    if config.get("database"):
        db_path = config.get("database_path", "dy_downloader.db") or "dy_downloader.db"
        database = Database(db_path=str(db_path))
        await database.initialize()

    try:
        urls = job.get("urls", [])
        if not urls:
            emit("error", message="任务中没有 URL")
            return

        for idx, url in enumerate(urls, 1):
            emit("url_start", index=idx, total=len(urls), url=url)
            reporter = JsonProgressReporter(url)
            try:
                result = await cli_main.download_url(
                    url,
                    config,
                    cookie_manager,
                    database,
                    progress_reporter=reporter,
                )
                if result:
                    emit(
                        "url_result",
                        url=url,
                        total=result.total,
                        success=result.success,
                        failed=result.failed,
                        skipped=result.skipped,
                    )
                else:
                    emit(
                        "url_result",
                        url=url,
                        total=0,
                        success=0,
                        failed=1,
                        skipped=0,
                    )
            except Exception as exc:
                logging.exception("下载失败：%s", url)
                emit("url_error", url=url, message=str(exc))

        emit("done")
    finally:
        if database is not None:
            try:
                await database.close()
            except Exception:
                pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", help="JSON 任务文件路径")
    args = parser.parse_args()

    if args.job:
        job = json.loads(Path(args.job).read_text(encoding="utf-8"))
    else:
        job = json.loads(sys.stdin.read())

    asyncio.run(run_job(job))


if __name__ == "__main__":
    main()
