"""临时测试：使用用户 cookie 测试 get_user_post 接口。"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

backend = Path("d:/DOU/douyin-downloader").resolve()
if str(backend) not in sys.path:
    sys.path.insert(0, str(backend))

from auth import CookieManager
from core.api_client import DouyinAPIClient
from utils.cookie_utils import parse_cookie_header
from urllib.parse import unquote

SETTINGS = Path("C:/Users/EDY/AppData/Roaming/douzy-electron/settings.json")

print("backend path:", backend)
print("backend exists:", backend.exists())
print("sys.path[0]:", sys.path[0])

async def main():
    settings = json.loads(SETTINGS.read_text("utf-8"))
    cookies = parse_cookie_header(settings.get("cookieString", ""))
    print("cookie keys:", list(cookies.keys()))
    print("sessionid:", cookies.get("sessionid", "")[:20], "...")

    # 测试：使用数据库中“茄子酱”的 sec_uid
    sec_uid = "MS4wLjABAAAApf_0GDlvcTOMZtRcYIf4UL189EVR3ausoUoo2pIFGJFepEj75q9U55ynmC1YQvEb"
    print("test sec_uid:", sec_uid)

    if not sec_uid:
        print("无法获取 sec_uid")
        return

    cookie_manager = CookieManager(cookie_file=".cookies.json")
    cookie_manager.set_cookies(cookies)

    async with DouyinAPIClient(cookie_manager.get_cookies(), proxy=None) as api:
        resp = await api.get_user_post(sec_uid, max_cursor=0, count=18)
        print("status_code:", resp.get("status_code"))
        print("has_more:", resp.get("has_more"))
        print("max_cursor:", resp.get("max_cursor"))
        print("items count:", len(resp.get("items", [])))
        if resp.get("items"):
            for it in resp["items"][:3]:
                print(" -", it.get("aweme_id"), it.get("desc", "")[:40])
        else:
            print("raw keys:", list(resp.get("raw", {}).keys())[:30])
            print("raw sample:", json.dumps(resp.get("raw", {})[:400] if isinstance(resp.get("raw"), str) else resp.get("raw"), ensure_ascii=False)[:800])

if __name__ == "__main__":
    asyncio.run(main())
