import asyncio
import json
from pathlib import Path

from lib.compat import ensure_backend_path

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
        # 基线：首页可达性
        try:
            async with api._session.get(
                "https://www.douyin.com/", headers=api.headers
            ) as resp:
                body = await resp.read()
                print(
                    json.dumps(
                        {"probe": "home", "status": resp.status, "len": len(body)},
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"probe": "home", "error": repr(exc)}, ensure_ascii=False), flush=True)

        # 复刻 get_user_post 的签名请求，抓取 403 响应体
        params = await api._build_user_page_params(SEC_UID, 0, 18)
        params.update(
            {
                "show_live_replay_strategy": "1",
                "need_time_list": "1",
                "time_list_query": "0",
                "whale_cut_token": "",
                "cut_version": "1",
                "publish_video_strategy_type": "2",
            }
        )
        signed_url, ua = api.build_signed_path("/aweme/v1/web/aweme/post/", params)
        async with api._session.get(
            signed_url, headers={**api.headers, "User-Agent": ua}
        ) as resp:
            body = await resp.read()
            snippet = body[:500].decode("utf-8", errors="replace")
            print(
                json.dumps(
                    {
                        "probe": "post_api",
                        "status": resp.status,
                        "len": len(body),
                        "snippet": snippet,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )


asyncio.run(main())
