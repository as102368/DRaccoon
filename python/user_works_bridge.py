"""博主作品列表桥接脚本。

根据 sec_uid 拉取指定博主的所有作品（仅元数据，不下载文件），并通过 stdout
输出 JSON Lines 事件给 Electron 主进程。
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Dict, List

from lib.bridge import BridgeContext, BridgeOutput, safe_main
from lib.compat import ensure_backend_path

ensure_backend_path()

from auth import CookieManager  # noqa: E402
from control import RateLimiter  # noqa: E402
from core.api_client import DouyinAPIClient  # noqa: E402
from utils.cookie_utils import parse_cookie_header  # noqa: E402
from utils.logger import set_console_log_level  # noqa: E402

set_console_log_level(logging.CRITICAL)


def _parse_cookies(cookies: Any) -> Dict[str, str]:
    if not cookies:
        return {}
    if isinstance(cookies, str):
        return parse_cookie_header(cookies)
    if isinstance(cookies, dict):
        return {str(k): str(v) for k, v in cookies.items()}
    return {}


def _format_aweme(item: dict) -> dict:
    """提取前端展示需要的字段。"""
    raw = item or {}
    author = raw.get("author") or {}
    stats = raw.get("statistics") or {}
    video = raw.get("video") or {}
    cover_url = ""
    if isinstance(video.get("cover"), dict):
        cover_url = (video["cover"].get("url_list") or [""])[0]
    elif isinstance(raw.get("cover"), dict):
        cover_url = (raw["cover"].get("url_list") or [""])[0]
    elif isinstance(raw.get("cover"), str):
        cover_url = raw["cover"]

    create_time = raw.get("create_time")
    if create_time is None and raw.get("create_time_str"):
        try:
            create_time = int(time.mktime(time.strptime(raw["create_time_str"], "%Y-%m-%d %H:%M:%S")))
        except Exception:
            create_time = None

    return {
        "aweme_id": raw.get("aweme_id") or raw.get("awemeId"),
        "title": raw.get("desc", ""),
        "create_time": create_time,
        "cover": cover_url,
        "share_url": raw.get("share_url", ""),
        "author": {
            "sec_uid": author.get("sec_uid", ""),
            "nickname": author.get("nickname", ""),
            "unique_id": author.get("unique_id", ""),
            "avatar": (author.get("avatar") or {}).get("url_list", [""])[0] if isinstance(author.get("avatar"), dict) else "",
        },
        "duration": video.get("duration", 0),
        "digg_count": stats.get("digg_count", 0),
        "comment_count": stats.get("comment_count", 0),
    }


async def _fetch_user_works(
    sec_uid: str,
    cookies: Dict[str, str],
    limit: int,
    proxy: str,
    out: BridgeOutput,
) -> List[dict]:
    cookie_manager = CookieManager(cookie_file=".cookies.json")
    cookie_manager.set_cookies(cookies)
    rate_limiter = RateLimiter(max_per_second=1.5)

    results: List[dict] = []
    cursor = 0
    page = 0
    has_more = True

    async with DouyinAPIClient(cookie_manager.get_cookies(), proxy=proxy or None) as api:
        while has_more and (limit <= 0 or len(results) < limit):
            page += 1
            await rate_limiter.acquire()
            out.emit("progress", {"current": len(results), "total": limit or 0, "message": f"第 {page} 页"})

            resp = await api.get_user_post(sec_uid, max_cursor=cursor, count=18)
            status_code = resp.get("status_code", 0)
            status_msg = resp.get("status_msg", "")

            if status_code != 0:
                out.emit("log", {"level": "warning", "message": f"接口返回 status_code={status_code}, msg={status_msg}"})

            items = resp.get("items") or resp.get("aweme_list") or []
            if items:
                formatted = [_format_aweme(it) for it in items]
                results.extend(formatted)
                out.emit("items", {"items": formatted, "total": len(results)})

            has_more = bool(resp.get("has_more", False))
            cursor = resp.get("max_cursor", 0)

            if not has_more or (limit > 0 and len(results) >= limit):
                break

            # 防止过快触发风控
            await asyncio.sleep(0.8 if page <= 3 else 1.5)

    if limit > 0 and len(results) > limit:
        results = results[:limit]
    return results


def main(ctx: BridgeContext, job: dict[str, Any], out: BridgeOutput) -> None:
    sec_uid = job.get("sec_uid") or ""
    if not sec_uid:
        out.error("缺少 sec_uid")
        return

    cookies = _parse_cookies(job.get("cookies"))
    if not cookies:
        out.error("缺少 Cookie")
        return

    limit = int(job.get("limit") or 0)
    proxy = str(job.get("proxy") or "")

    out.emit("start", {"sec_uid": sec_uid, "limit": limit})

    try:
        results = asyncio.run(_fetch_user_works(sec_uid, cookies, limit, proxy, out))
    except Exception as exc:
        out.error(f"获取作品失败：{exc}")
        return

    out.emit("done", {"total": len(results), "items": results})
    out.finished(success=True, data={"total": len(results)})


if __name__ == "__main__":
    safe_main(main)
