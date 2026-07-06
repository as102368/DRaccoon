"""批量测试可能的抖音关注/取关接口路径。"""
from __future__ import annotations

import asyncio
import json

from lib.compat import ensure_backend_path

ensure_backend_path()

from core.api_client import DouyinAPIClient  # noqa: E402


async def try_path(api: DouyinAPIClient, path: str, sec_uid: str):
    params = await api._default_query()
    params.update({
        "sec_user_id": sec_uid,
        "anti_csrf": api._get_anti_csrf_token(),
        "source_type": "1",
    })
    import aiohttp
    from urllib.parse import urlencode
    query = urlencode(params)
    signed_url, ua = api.sign_url(f"{api.BASE_URL}{path}?{query}")
    headers = {**api.headers, "User-Agent": ua}
    async with aiohttp.ClientSession(headers=headers, cookies=api.cookies) as session:
        async with session.post(signed_url) as resp:
            body = await resp.read()
            try:
                data = json.loads(body)
            except Exception:
                data = {"raw": body.decode("utf-8", errors="replace")}
            return resp.status, data


async def main():
    with open(r"D:\DOU\douzy-electron\python\.cookies.json", "r", encoding="utf-8") as f:
        cookies = json.load(f)

    test_sec_uid = "MS4wLjABAAAA7LsIeUOS5ooTa0Cc3ontMSyRhl6A1BcSoyTMoveerqU"

    paths = [
        "/aweme/v1/web/user/follow/",
        "/aweme/v1/web/user/unfollow/",
        "/aweme/v1/web/commit/follow/user/",
        "/aweme/v1/web/commit/unfollow/user/",
        "/aweme/v1/web/follow/",
        "/aweme/v1/web/unfollow/",
        "/aweme/v1/commit/follow/user/",
        "/aweme/v1/commit/unfollow/user/",
    ]

    async with DouyinAPIClient(cookies) as api:
        for path in paths:
            try:
                status, data = await try_path(api, path, test_sec_uid)
                print(f"\n=== {path} ===")
                print(f"HTTP {status}")
                print(json.dumps(data, ensure_ascii=False, indent=2)[:1000])
            except Exception as e:
                print(f"\n=== {path} ===")
                print(f"ERROR: {e}")


if __name__ == "__main__":
    asyncio.run(main())
