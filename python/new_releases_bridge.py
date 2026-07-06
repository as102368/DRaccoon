"""新发布发现桥接脚本。

从已同步的关注列表中找出本地下载过视频的博主，拉取他们最近的作品，
过滤掉已经下载过的 aweme_id，把新作品元数据返回给前端展示。
"""
from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Any, Dict, List, Set

from lib.bridge import BridgeContext, BridgeOutput, safe_main
from lib.compat import ensure_backend_path

ensure_backend_path()

from auth import CookieManager  # noqa: E402
from config import ConfigLoader  # noqa: E402
from control import RateLimiter  # noqa: E402
from core.api_client import DouyinAPIClient  # noqa: E402
from storage import Database  # noqa: E402
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


def _build_config(job: dict[str, Any]) -> ConfigLoader:
    config = ConfigLoader(None)
    config.config.update(job.get("config", {}))
    return config


def _build_cookie_manager(job: dict[str, Any], config: ConfigLoader) -> CookieManager:
    cookies = _parse_cookies(job.get("cookies"))
    output_path = config.get("path") or "."
    Path(output_path).mkdir(parents=True, exist_ok=True)
    cookie_manager = CookieManager(
        cookie_file=str(Path(output_path) / ".cookies.json")
    )
    cookie_manager.set_cookies(cookies)
    return cookie_manager


async def _init_database(config: ConfigLoader) -> Database | None:
    if not config.get("database"):
        return None
    output_path = config.get("path") or "."
    db_path = config.get("database_path") or str(Path(output_path) / "dy_downloader.db")
    database = Database(db_path=str(db_path))
    await database.initialize()
    return database


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
            create_time = int(
                time.mktime(time.strptime(raw["create_time_str"], "%Y-%m-%d %H:%M:%S"))
            )
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
            "avatar": (
                (author.get("avatar") or {}).get("url_list", [""])[0]
                if isinstance(author.get("avatar"), dict)
                else ""
            ),
        },
        "duration": video.get("duration", 0),
        "digg_count": stats.get("digg_count", 0),
        "comment_count": stats.get("comment_count", 0),
    }


async def _fetch_author_new_awemes(
    sec_uid: str,
    nickname: str,
    per_author_limit: int,
    existing_ids: Set[str],
    api: DouyinAPIClient,
    rate_limiter: RateLimiter,
    out: BridgeOutput,
) -> List[dict]:
    """拉取单个博主的最新作品，过滤已下载的 aweme_id。"""
    results: List[dict] = []
    cursor = 0
    page = 0
    has_more = True

    while has_more and len(results) < per_author_limit:
        page += 1
        await rate_limiter.acquire()
        out.emit(
            "progress",
            {
                "message": f"正在检查 {nickname} 第 {page} 页",
            },
        )

        try:
            resp = await api.get_user_post(sec_uid, max_cursor=cursor, count=18)
        except Exception as exc:
            out.log(f"获取 {nickname} 作品失败: {exc}", level="warning")
            break

        status_code = resp.get("status_code", 0)
        status_msg = resp.get("status_msg", "")
        items = resp.get("items") or resp.get("aweme_list") or []
        out.log(
            f"{nickname} 第 {page} 页返回 {len(items)} 条，status_code={status_code}, "
            f"has_more={resp.get('has_more', False)}, max_cursor={resp.get('max_cursor', 0)}"
        )
        if status_code != 0:
            out.log(
                f"获取 {nickname} 作品接口返回 status_code={status_code}, msg={status_msg}",
                level="warning",
            )
            break

        page_has_new = False
        for raw in items:
            formatted = _format_aweme(raw)
            aid = formatted.get("aweme_id")
            if not aid:
                continue
            if aid in existing_ids:
                continue
            results.append(formatted)
            page_has_new = True
            if len(results) >= per_author_limit:
                break

        has_more = bool(resp.get("has_more", False))
        next_cursor = resp.get("max_cursor", 0)
        if not has_more or next_cursor == cursor:
            break
        # 作品列表按时间倒序，当前页已无新作品时，后续页面不可能再出现新作品
        if not page_has_new:
            break
        cursor = next_cursor

        # 防止过快触发风控
        await asyncio.sleep(0.8 if page <= 3 else 1.5)

    return results


async def _diagnose_empty_authors(database: Database, out: BridgeOutput) -> None:
    """当没有匹配到已下载的关注博主时，输出数据库统计帮助排查。"""
    try:
        db = await database._get_conn()
        cursor = await db.execute("SELECT COUNT(*) FROM following")
        following_count = int((await cursor.fetchone())[0] or 0)
        cursor = await db.execute("SELECT COUNT(*) FROM aweme")
        aweme_count = int((await cursor.fetchone())[0] or 0)
        cursor = await db.execute(
            "SELECT COUNT(*) FROM aweme WHERE author_sec_uid IS NOT NULL AND author_sec_uid != ''"
        )
        aweme_with_sec_uid = int((await cursor.fetchone())[0] or 0)
        cursor = await db.execute(
            "SELECT COUNT(*) FROM download_history WHERE status = 'success'"
        )
        history_success = int((await cursor.fetchone())[0] or 0)
        cursor = await db.execute(
            "SELECT COUNT(DISTINCT sec_uid) FROM download_history "
            "WHERE status = 'success' AND sec_uid IS NOT NULL AND sec_uid != ''"
        )
        history_authors = int((await cursor.fetchone())[0] or 0)
        out.log(f"诊断：关注 {following_count} 人，aweme 记录 {aweme_count} 条")
        out.log(f"诊断：aweme 有 author_sec_uid 的 {aweme_with_sec_uid} 条，download_history 成功 {history_success} 条，涉及 {history_authors} 位博主")
    except Exception as exc:
        out.log(f"诊断统计失败: {exc}", level="warning")


async def _run(ctx: BridgeContext, job: dict[str, Any], out: BridgeOutput) -> None:
    config = _build_config(job)
    cookie_manager = _build_cookie_manager(job, config)
    database = await _init_database(config)

    if database is None:
        raise RuntimeError("新发布功能需要开启 SQLite 去重，请在设置中启用数据库")

    limits = job.get("limits") or {}
    max_authors = int(limits.get("newReleasesAuthors") or 200)
    per_author_limit = int(limits.get("newReleasesPerAuthor") or 30)
    proxy = str(job.get("proxy") or config.get("proxy") or "")

    try:
        authors = await database.get_downloaded_following_authors(limit=max_authors)
        if not authors:
            out.log("没有匹配到已下载的关注博主，准备输出诊断信息")
            await _diagnose_empty_authors(database, out)
            out.emit(
                "done",
                {
                    "total": 0,
                    "authors_checked": 0,
                    "authors_with_new": 0,
                    "items": [],
                },
            )
            out.finished(success=True, data={"total": 0})
            return

        author_sec_uids = [a["sec_uid"] for a in authors if a.get("sec_uid")]
        existing_ids = await database.get_downloaded_aweme_id_set_for_authors(author_sec_uids)

        out.emit(
            "start",
            {
                "authors_total": len(authors),
                "per_author_limit": per_author_limit,
            },
        )

        rate_limiter = RateLimiter(max_per_second=1.0)
        all_items: List[dict] = []
        authors_with_new = 0

        async with DouyinAPIClient(
            cookie_manager.get_cookies(), proxy=proxy or None
        ) as api:
            for idx, author in enumerate(authors, 1):
                sec_uid = author.get("sec_uid")
                nickname = author.get("nickname") or "未知博主"
                if not sec_uid:
                    continue

                out.emit(
                    "progress",
                    {
                        "current_author_index": idx,
                        "total_authors": len(authors),
                        "nickname": nickname,
                        "sec_uid": sec_uid,
                        "message": f"正在检查 {nickname} ({idx}/{len(authors)})",
                    },
                )

                try:
                    items = await _fetch_author_new_awemes(
                        sec_uid=sec_uid,
                        nickname=nickname,
                        per_author_limit=per_author_limit,
                        existing_ids=existing_ids,
                        api=api,
                        rate_limiter=rate_limiter,
                        out=out,
                    )
                except Exception as exc:
                    out.log(f"检查 {nickname} 时出错: {exc}", level="warning")
                    items = []

                if items:
                    authors_with_new += 1
                    all_items.extend(items)
                    out.emit(
                        "items",
                        {
                            "items": items,
                            "total": len(all_items),
                        },
                    )

                # 作者之间也留一点间隔，降低风控概率
                await asyncio.sleep(0.3)

        out.emit(
            "done",
            {
                "total": len(all_items),
                "authors_checked": len(authors),
                "authors_with_new": authors_with_new,
                "items": all_items,
            },
        )
        out.finished(
            success=True,
            data={
                "total": len(all_items),
                "authors_checked": len(authors),
                "authors_with_new": authors_with_new,
            },
        )
    finally:
        if database is not None:
            try:
                await database.close()
            except Exception:
                pass


def main(ctx: BridgeContext, job: dict[str, Any], out: BridgeOutput) -> None:
    asyncio.run(_run(ctx, job, out))


if __name__ == "__main__":
    safe_main(main)
