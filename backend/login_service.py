#!/usr/bin/env python3
"""抖音登录校验服务。

为 Electron 桌面端提供一次性 Cookie 校验入口：先检查必要字段，
再调用 /aweme/v1/web/user/profile/self/ 获取当前登录用户信息，
通过 stdout 输出 NDJSON 结果。
"""

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path
from typing import Optional

BACKEND_ROOT = Path(__file__).resolve().parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from auth import CookieManager  # noqa: E402
from core.api_client import DouyinAPIClient  # noqa: E402
from core.following import FollowingUser  # noqa: E402
from utils.cookie_utils import parse_cookie_header  # noqa: E402
from utils.logger import set_console_log_level  # noqa: E402

set_console_log_level(logging.CRITICAL)


def emit(obj: dict):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def parse_cookies(raw) -> dict:
    if not raw:
        return {}
    if isinstance(raw, str):
        return parse_cookie_header(raw)
    if isinstance(raw, dict):
        return {str(k): str(v) for k, v in raw.items()}
    return {}


async def validate(cookie_raw: str, profile: Optional[str] = None):
    cookies = parse_cookies(cookie_raw)
    if not cookies:
        emit({"valid": False, "reason": "Cookie 为空"})
        return

    cookie_file = Path.cwd() / ".cookies.json"
    cookie_manager = CookieManager(cookie_file=str(cookie_file), profile=profile)
    cookie_manager.set_cookies(cookies)

    if not cookie_manager.validate_cookies():
        emit({"valid": False, "reason": "Cookie 缺少必要字段（ttwid / passport_csrf_token）"})
        return

    try:
        async with DouyinAPIClient(cookie_manager.get_cookies()) as api:
            user = await api.get_self_info()
            if not user or not user.get("sec_uid"):
                emit({"valid": False, "reason": "无法获取用户信息，Cookie 可能已过期"})
                return
            normalized = FollowingUser.from_api(user)
            emit({
                "valid": True,
                "user": {
                    "sec_uid": normalized.sec_uid or user.get("sec_uid"),
                    "nickname": normalized.nickname or user.get("nickname", ""),
                    "avatar": normalized.avatar,
                    "unique_id": normalized.unique_id or user.get("unique_id", ""),
                },
            })
    except Exception as exc:
        emit({"valid": False, "reason": f"校验失败：{exc}"})


def _redirect_to_files(stdout_log: Optional[str], stderr_log: Optional[str]):
    if stdout_log:
        try:
            Path(stdout_log).parent.mkdir(parents=True, exist_ok=True)
            sys.stdout = open(stdout_log, "w", encoding="utf-8", buffering=1)
        except Exception as exc:
            sys.stderr.write(f"无法重定向 stdout 到文件: {exc}\n")
    if stderr_log:
        try:
            Path(stderr_log).parent.mkdir(parents=True, exist_ok=True)
            sys.stderr = open(stderr_log, "w", encoding="utf-8", buffering=1)
        except Exception as exc:
            # 如果 stderr 重定向失败，至少尝试写到原始的 stderr
            try:
                sys.__stderr__.write(f"无法重定向 stderr 到文件: {exc}\n")
            except Exception:
                pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cookie", default="", help="完整 Cookie 字符串")
    parser.add_argument("--cookie-file", default="", help="包含 Cookie 字符串的文件路径")
    parser.add_argument(
        "--profile",
        type=str,
        default=None,
        metavar="NAME",
        help="保存 Cookie 到指定账号的配置文件（默认 .cookies.json；指定后为 .cookies.NAME.json）",
    )
    parser.add_argument("--stdout-log", default=None, help="stdout 重定向目标日志文件")
    parser.add_argument("--stderr-log", default=None, help="stderr 重定向目标日志文件")
    args = parser.parse_args()

    _redirect_to_files(args.stdout_log, args.stderr_log)

    cookie = args.cookie
    if args.cookie_file:
        try:
            cookie = Path(args.cookie_file).read_text(encoding="utf-8")
        except Exception as exc:
            emit({"valid": False, "reason": f"读取 Cookie 文件失败：{exc}"})
            return
    if not cookie and sys.stdin is not None:
        cookie = sys.stdin.read()

    asyncio.run(validate(cookie, profile=args.profile))


if __name__ == "__main__":
    main()
