"""测试抖音关注/取关接口的实际响应。"""
from __future__ import annotations

import asyncio
import json

from lib.bridge import BridgeContext, BridgeOutput
from lib.compat import ensure_backend_path

ensure_backend_path()

from core.api_client import DouyinAPIClient  # noqa: E402


async def main():
    with open(r"D:\DOU\douzy-electron\python\.cookies.json", "r", encoding="utf-8") as f:
        cookies = json.load(f)

    async with DouyinAPIClient(cookies) as api:
        self_info = await api.get_self_info()
        print("self_info:", json.dumps(self_info, ensure_ascii=False, indent=2) if self_info else "None")

        # 用一个公开博主的 sec_uid 测试 follow 接口（关注后再取消，避免副作用）
        # 这里使用一个示例 sec_uid，你可以替换成任意公开账号
        test_sec_uid = "MS4wLjABAAAA1P-vMtjHB7uVuSijDG6Akq-FhzDPd_fRSFRp2jR3b4s"

        print("\n=== follow_user ===")
        follow_resp = await api.follow_user(test_sec_uid)
        print(json.dumps(follow_resp, ensure_ascii=False, indent=2))

        print("\n=== unfollow_user ===")
        unfollow_resp = await api.unfollow_user(test_sec_uid)
        print(json.dumps(unfollow_resp, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
