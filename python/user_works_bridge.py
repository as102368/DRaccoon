"""博主作品列表桥接脚本。

根据 sec_uid 拉取指定博主的作品元数据（不下载文件），并通过 stdout
输出 JSON Lines 事件给 Electron 主进程。

数据获取优先级：
1. 本地数据库中已下载/已同步的该博主作品（不联网、不弹窗）
2. 抖音 API 直接拉取
3. 仅当用户在设置中显式开启「浏览器回补」时，才滚动作者主页兜底
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

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


def _resolve_database_path(config: ConfigLoader) -> Optional[str]:
    """根据 config 推断 dy_downloader.db 路径。"""
    db_path = config.get("database_path")
    if db_path:
        return str(db_path)
    output_path = config.get("path")
    if output_path:
        return str(Path(output_path) / "dy_downloader.db")
    return str(Path(".") / "dy_downloader.db")


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


def _merge_aweme_results(db_results: List[dict], api_results: List[dict]) -> List[dict]:
    """合并数据库缓存与 API 结果，按 create_time 降序去重。"""
    seen = set()
    merged = []
    for item in db_results + api_results:
        aweme_id = item.get("aweme_id")
        if not aweme_id or aweme_id in seen:
            continue
        seen.add(aweme_id)
        merged.append(item)
    try:
        merged.sort(key=lambda x: (x.get("create_time") or 0), reverse=True)
    except Exception:
        pass
    return merged


def _write_debug_log(message: str) -> None:
    try:
        log_path = Path(__file__).resolve().parent / "user_works_debug.log"
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}\n")
    except Exception:
        pass


def _is_rate_limited(resp: dict) -> bool:
    """判断接口是否因请求频繁而被风控。"""
    status_code = resp.get("status_code", 0)
    status_msg = str(resp.get("status_msg") or "").lower()
    keywords = ("频繁", "太快", "操作太频繁", "risk", "rate limit", "请求过快")
    return status_code in (5, 429) or any(k in status_msg for k in keywords)


async def _load_existing_awemes_from_db(sec_uid: str, config: ConfigLoader) -> List[dict]:
    """从本地数据库读取该博主已缓存的作品元数据。"""
    db_path = _resolve_database_path(config)
    if not db_path or not Path(db_path).exists():
        return []

    try:
        database = Database(db_path=db_path)
        await database.initialize()
    except Exception as exc:
        _write_debug_log(f"db initialize failed: {exc}")
        return []

    results: List[dict] = []
    try:
        conn = await database._get_conn()
        cursor = await conn.execute(
            """
            SELECT metadata FROM aweme
            WHERE author_sec_uid = ?
            ORDER BY COALESCE(create_time, download_time) DESC
            """,
            (sec_uid,),
        )
        rows = await cursor.fetchall()
        for row in rows:
            try:
                metadata = json.loads(row[0] or "{}")
                if metadata:
                    results.append(_format_aweme(metadata))
            except Exception:
                continue
    except Exception as exc:
        _write_debug_log(f"db query failed: {exc}")
    finally:
        try:
            await database.close()
        except Exception:
            pass

    return results


async def _fetch_from_api(
    sec_uid: str,
    cookies: Dict[str, str],
    proxy: str,
    limit: int,
    config: ConfigLoader,
    out: BridgeOutput,
    cookie_file: str,
) -> List[dict]:
    """通过抖音 API 直接拉取作品列表。"""
    Path(cookie_file).parent.mkdir(parents=True, exist_ok=True)
    cookie_manager = CookieManager(cookie_file=cookie_file)
    if cookies:
        cookie_manager.set_cookies(cookies)
    # 作者作品是交互式查询，限速要比后台批量同步更保守
    rate_limiter = RateLimiter(max_per_second=0.7)

    results: List[dict] = []
    cursor = 0
    page = 0
    has_more = True
    empty_retries = 0
    cursor_retries = 0
    rate_limit_backoff = 0

    async with DouyinAPIClient(
        cookie_manager.get_cookies(),
        proxy=proxy or None,
        config=config.config if config else {},
    ) as api:
        while has_more and (limit <= 0 or len(results) < limit):
            page += 1
            await rate_limiter.acquire()
            out.emit("progress", {"current": len(results), "total": limit or 0, "message": f"第 {page} 页"})

            resp = await api.get_user_post(sec_uid, max_cursor=cursor, count=18)
            status_code = resp.get("status_code", 0)
            status_msg = resp.get("status_msg", "")
            _write_debug_log(
                f"page={page} cursor={cursor} status_code={status_code} "
                f"msg={status_msg} has_more={resp.get('has_more')} "
                f"items={len(resp.get('items') or resp.get('aweme_list') or [])}"
            )

            if _is_rate_limited(resp):
                rate_limit_backoff = min(rate_limit_backoff + 1, 5)
                wait = min(2 ** rate_limit_backoff + random.uniform(0, 1), 60)
                out.emit(
                    "log",
                    {"level": "warning", "message": f"触发接口风控，{wait:.1f}s 后重试（第 {rate_limit_backoff} 次）"},
                )
                if rate_limit_backoff >= 4:
                    out.emit("log", {"level": "error", "message": "接口请求过于频繁，已停止获取，请稍后再试"})
                    break
                await asyncio.sleep(wait)
                continue

            if rate_limit_backoff > 0:
                rate_limit_backoff = max(rate_limit_backoff - 1, 0)

            if status_code != 0:
                out.emit("log", {"level": "warning", "message": f"接口返回 status_code={status_code}, msg={status_msg}"})

            items = resp.get("items") or resp.get("aweme_list") or []
            if items:
                formatted = [_format_aweme(it) for it in items]
                results.extend(formatted)
                out.emit("items", {"items": formatted, "total": len(results)})
                empty_retries = 0
                cursor_retries = 0
            elif page == 1 and empty_retries < 2:
                empty_retries += 1
                out.emit("log", {"level": "warning", "message": f"首页为空，第 {empty_retries} 次重试..."})
                _write_debug_log(f"first page empty, retry {empty_retries}")
                await asyncio.sleep(1.0 + empty_retries * 0.8)
                continue
            else:
                break

            has_more = bool(resp.get("has_more", False))
            next_cursor = resp.get("max_cursor", 0)

            if has_more and next_cursor == cursor:
                if cursor_retries < 2:
                    cursor_retries += 1
                    out.emit("log", {"level": "warning", "message": f"游标未推进，第 {cursor_retries} 次重试..."})
                    await asyncio.sleep(1.0 + cursor_retries * 0.8)
                    continue
                break

            cursor = next_cursor

            if not has_more or (limit > 0 and len(results) >= limit):
                break

            # 分页间隔比后台同步更保守，降低连续请求触发风控的概率
            await asyncio.sleep(1.2 if page <= 3 else 2.0)

    if limit > 0 and len(results) > limit:
        results = results[:limit]
    return results


async def _recover_via_browser(
    api: DouyinAPIClient,
    sec_uid: str,
    existing: List[dict],
    limit: int,
    config: ConfigLoader,
    rate_limiter: RateLimiter,
    out: BridgeOutput,
) -> List[dict]:
    """API 分页受限时，通过浏览器滚动用户主页采集作品并补全详情。

    仅在用户显式开启「浏览器回补」时执行，避免未经用户同意弹窗。
    """
    browser_cfg = config.get("browser_fallback") or {}
    if not browser_cfg.get("enabled", False):
        out.log("浏览器兜底未启用，跳过", level="info")
        return existing

    out.log("API 分页受限，启动浏览器兜底采集", level="warning")
    out.emit("progress", {
        "current": len(existing),
        "total": limit or 0,
        "message": "接口受限，启动浏览器兜底",
    })

    try:
        browser_ids = await api.collect_user_post_ids_via_browser(
            sec_uid,
            expected_count=limit if limit > 0 else 0,
            headless=bool(browser_cfg.get("headless", False)),
            max_scrolls=int(browser_cfg.get("max_scrolls", 240) or 240),
            idle_rounds=int(browser_cfg.get("idle_rounds", 8) or 8),
            wait_timeout_seconds=int(browser_cfg.get("wait_timeout_seconds", 600) or 600),
        )
    except Exception as exc:
        out.log(f"浏览器兜底失败：{exc}", level="error")
        return existing

    browser_items: Dict[str, Dict[str, Any]] = {}
    if hasattr(api, "pop_browser_post_aweme_items"):
        try:
            browser_items = api.pop_browser_post_aweme_items() or {}
        except Exception as exc:
            out.log(f"复用浏览器缓存作品失败：{exc}", level="warning")

    if not browser_ids:
        out.log("浏览器兜底未采集到作品 ID", level="warning")
        return existing

    out.emit("progress", {
        "current": len(existing),
        "total": limit or len(existing) + len(browser_ids),
        "message": f"浏览器已采集 {len(browser_ids)} 个作品，补全详情中",
    })

    existing_ids = {str(it.get("aweme_id")) for it in existing if it.get("aweme_id")}
    results = list(existing)
    reused = detail_success = detail_failed = 0

    for idx, aweme_id in enumerate(browser_ids, start=1):
        if limit > 0 and len(results) >= limit:
            break
        aweme_id_str = str(aweme_id)
        if aweme_id_str in existing_ids:
            continue
        existing_ids.add(aweme_id_str)

        detail = browser_items.get(aweme_id_str)
        if detail:
            reused += 1
        else:
            await rate_limiter.acquire()
            detail = await api.get_video_detail(aweme_id_str, suppress_error=True)
            if detail:
                detail_success += 1
            else:
                detail_failed += 1

        if not detail:
            continue

        author = detail.get("author") or {}
        if author.get("sec_uid") and str(author["sec_uid"]) != str(sec_uid):
            out.log(f"作品 {aweme_id_str} 的 sec_uid 不匹配，跳过", level="warning")
            continue

        formatted = _format_aweme(detail)
        results.append(formatted)
        out.emit("items", {"items": [formatted], "total": len(results)})

    out.log(
        f"浏览器兜底完成：复用 {reused}，详情成功 {detail_success}，失败 {detail_failed}",
        level="info",
    )
    return results


async def _fetch_user_works(
    sec_uid: str,
    cookies: Dict[str, str],
    limit: int,
    proxy: str,
    config: ConfigLoader,
    out: BridgeOutput,
    cookie_file: str = ".cookies.json",
    force_refresh: bool = False,
) -> List[dict]:
    _write_debug_log(
        f"start sec_uid={sec_uid} limit={limit} proxy={proxy} force_refresh={force_refresh} cookies_keys={list(cookies.keys())}"
    )

    # 1. 优先从本地数据库读取（不联网、不弹窗）；强制刷新时跳过缓存
    db_results: List[dict] = []
    if not force_refresh:
        db_results = await _load_existing_awemes_from_db(sec_uid, config)
        if db_results:
            out.emit("progress", {
                "current": len(db_results),
                "total": limit or len(db_results),
                "message": f"从本地读取 {len(db_results)} 个作品",
            })
            out.emit("items", {"items": db_results, "total": len(db_results)})
            # 缓存已满足请求数量，直接返回
            if limit > 0 and len(db_results) >= limit:
                _write_debug_log(f"db cache satisfied limit, total={len(db_results)}")
                return db_results[:limit]

    # 2. 缓存不足或强制刷新时，调用 API 补充/获取数据
    need_count = limit
    if not force_refresh and db_results and limit > 0:
        need_count = limit - len(db_results)
        _write_debug_log(f"db cache partial, need {need_count} more from api")

    api_results = await _fetch_from_api(
        sec_uid, cookies, proxy, need_count if need_count > 0 else limit, config, out, cookie_file
    )

    if not api_results:
        out.emit("progress", {
            "current": len(db_results),
            "total": limit or len(db_results),
            "message": "接口未返回数据，请检查 Cookie 或稍后刷新",
        })

    # 3. API 未拿够且用户开启浏览器兜底，才启动浏览器
    current_results = db_results + api_results
    if (limit <= 0 or len(current_results) < limit) and not api_results:
        browser_cfg = config.get("browser_fallback") or {}
        if browser_cfg.get("enabled", False):
            Path(cookie_file).parent.mkdir(parents=True, exist_ok=True)
            cookie_manager = CookieManager(cookie_file=cookie_file)
            cookie_manager.set_cookies(cookies)
            rate_limiter = RateLimiter(max_per_second=1.5)
            async with DouyinAPIClient(
                cookie_manager.get_cookies(),
                proxy=proxy or None,
                config=config.config if config else {},
            ) as api:
                browser_results = await _recover_via_browser(
                    api, sec_uid, api_results, limit, config, rate_limiter, out
                )
                if browser_results:
                    # 合并浏览器兜底结果，去重
                    seen = {item.get("aweme_id") for item in current_results if item.get("aweme_id")}
                    for item in browser_results:
                        aweme_id = item.get("aweme_id")
                        if aweme_id and aweme_id in seen:
                            continue
                        seen.add(aweme_id)
                        api_results.append(item)
        elif not db_results:
            out.log("API 未返回数据且浏览器兜底未启用，如需兜底请在设置中开启", level="warning")

    # 4. 合并数据库缓存与 API 结果，按 create_time 降序去重
    merged = _merge_aweme_results(db_results, api_results)
    if limit > 0 and len(merged) > limit:
        merged = merged[:limit]

    _write_debug_log(f"done total={len(merged)} (db={len(db_results)}, api={len(api_results)})")
    return merged


def main(ctx: BridgeContext, job: dict[str, Any], out: BridgeOutput) -> None:
    sec_uid = job.get("sec_uid") or ""
    if not sec_uid:
        out.error("缺少 sec_uid")
        return

    cookies = _parse_cookies(job.get("cookies"))
    if not cookies:
        out.error("缺少 Cookie")
        return

    config = _build_config(job)
    limit = int(job.get("limit") or 0)
    proxy = str(job.get("proxy") or config.get("proxy") or "")

    cookie_file = str(job.get("cookieFile") or "").strip()
    if not cookie_file:
        output_path = config.get("path") or "."
        Path(output_path).mkdir(parents=True, exist_ok=True)
        cookie_file = str(Path(output_path) / ".cookies.json")
    else:
        Path(cookie_file).parent.mkdir(parents=True, exist_ok=True)

    out.emit("start", {"sec_uid": sec_uid, "limit": limit})

    force_refresh = bool(job.get("force_refresh", False))
    try:
        results = asyncio.run(_fetch_user_works(
            sec_uid, cookies, limit, proxy, config, out, cookie_file=cookie_file, force_refresh=force_refresh
        ))
    except Exception as exc:
        out.error(f"获取作品失败：{exc}")
        return

    out.emit("done", {"total": len(results), "items": results})
    out.finished(success=True, data={"total": len(results)})


if __name__ == "__main__":
    safe_main(main)
