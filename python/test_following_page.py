"""获取当前登录用户的关注列表第一页。"""
from __future__ import annotations

import asyncio
import json

from lib.compat import ensure_backend_path

ensure_backend_path()

from core.api_client import DouyinAPIClient  # noqa: E402


async def main():
    with open(r"D:\DOU\douzy-electron\python\.cookies.json", "r", encoding="utf-8") as f:
        cookies = json.load(f)

    async with DouyinAPIClient(cookies) as api:
        self_info = await api.get_self_info()
        sec_uid = self_info.get("sec_uid") if self_info else None
        print("self sec_uid:", sec_uid)
        if sec_uid:
            page = await api.get_following_page(sec_uid, max_time=0, count=20)
            items = page.get("items", [])
            print(f"followed {len(items)} users")
            for u in items[:5]:
                print("-", u.get("nickname"), u.get("sec_uid"), u.get("unique_id"))


if __name__ == "__main__":
    asyncio.run(main())
