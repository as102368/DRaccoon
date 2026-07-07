"""测试抖音 commit/follow/user 关注/取关接口。"""
from __future__ import annotations

import asyncio
import json

from lib.compat import ensure_backend_path

ensure_backend_path()

from core.api_client import DouyinAPIClient  # noqa: E402


async def main():
    with open(r"D:\DOU\douzy-electron\python\.cookies.json", "r", encoding="utf-8") as f:
        cookies = json.load(f)

    # 先用已关注博主测试取关
    sec_uid = "MS4wLjABAAAA7LsIeUOS5ooTa0Cc3ontMSyRhl6A1BcSoyTMoveerqU"

    async with DouyinAPIClient(cookies) as api:
        info = await api.get_user_info(sec_uid)
        user_id = str(info.get("uid") or "") if info else ""
        print("sec_uid:", sec_uid)
        print("user_id:", user_id)
        print("short_id:", info.get("short_id") if info else "")

        if not user_id:
            print("无法获取 user_id")
            return

        print("\n=== unfollow_user (new commit endpoint) ===")
        resp = await api.unfollow_user(sec_uid)
        print(json.dumps(resp, ensure_ascii=False, indent=2))

        print("\n=== follow_user (new commit endpoint) ===")
        resp2 = await api.follow_user(sec_uid)
        print(json.dumps(resp2, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
