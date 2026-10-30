"""端到端验证：打包环境内跑浏览器兜底采集（Argus 风控后的修复路径）。"""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from lib.compat import ensure_backend_path  # noqa: E402

ensure_backend_path()

from core.api_client import DouyinAPIClient  # noqa: E402

COOKIES = json.loads(
    Path(r"C:\Users\USER-PC\AppData\Roaming\DRaccoon\cookies\douyin.cookies.json").read_text(
        encoding="utf-8"
    )
)
SEC_UID = "MS4wLjABAAAAE7JddJ6OYsyIwlQNB_gqsBwyL5qTExec1wRwmwPz_TM"


async def main():
    async with DouyinAPIClient(COOKIES) as api:
        ids = await api.collect_user_post_ids_via_browser(
            SEC_UID,
            expected_count=0,
            headless=False,
            max_scrolls=3,
            idle_rounds=2,
            wait_timeout_seconds=90,
        )
        items = api.pop_browser_post_aweme_items()
        stats = api.pop_browser_post_stats()
        print(
            json.dumps(
                {
                    "ids": len(ids),
                    "items": len(items),
                    "stats": stats,
                    "first_id": ids[0] if ids else None,
                    "first_desc": (items.get(ids[0], {}).get("desc") or "")[:30] if ids else None,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )


asyncio.run(main())
