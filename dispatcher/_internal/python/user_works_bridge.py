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


_FAILED_RECORDS_FILENAME = "failed_user_works.json"


def _failed_records_path(config: ConfigLoader) -> Path:
    output_path = config.get("path") or "."
    return Path(output_path) / _FAILED_RECORDS_FILENAME


def _load_failed_record(config: ConfigLoader, sec_uid: str) -> Optional[dict]:
    path = _failed_records_path(config)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        record = data.get("records", {}).get(sec_uid)
        if record and record.get("items"):
            return record
    except Exception as exc:
        _write_debug_log(f"load failed record error: {exc}")
    return None


def _save_failed_record(config: ConfigLoader, sec_uid: str, record: dict) -> None:
    path = _failed_records_path(config)
    try:
        data: dict = {"records": {}}
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {"records": {}}
        records = data.setdefault("records", {})
        records[sec_uid] = record
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as exc:
        _write_debug_log(f"save failed record error: {exc}")


def _remove_failed_record(config: ConfigLoader, sec_uid: str) -> None:
    path = _failed_records_path(config)
    if not path.exists():
        return
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        records = data.get("records", {})
        if sec_uid in records:
            del records[sec_uid]
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as exc:
        _write_debug_log(f"remove failed record error: {exc}")


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
    initial_cursor: int = 0,
    is_retry: bool = False,
) -> dict:
    """通过抖音 API 低速拉取作品列表。遇到风控/空页/游标卡住时直接失败，不再浏览器兜底。

    返回字典包含：
    - items: 拉取到的作品列表
    - has_more: API 是否声明还有下一页
    - cursor: 最后使用的游标
    - stopped_reason: 提前终止的原因（rate_limited / empty_page / cursor_stall / limit_reached / none）
    """
    Path(cookie_file).parent.mkdir(parents=True, exist_ok=True)
    cookie_manager = CookieManager(cookie_file=cookie_file)
    if cookies:
        cookie_manager.set_cookies(cookies)
    # 用户要求重试时更慢，降低触发风控概率
    rate_limiter = RateLimiter(max_per_second=0.3)

    results: List[dict] = []
    cursor = initial_cursor
    page = 0
    has_more = True
    empty_retries = 0
    cursor_retries = 0
    rate_limit_backoff = 0
    stopped_reason: Optional[str] = None

    async with DouyinAPIClient(
        cookie_manager.get_cookies(),
        proxy=proxy or None,
        config=config.config if config else {},
    ) as api:
        if is_retry:
            cooldown = random.uniform(30, 60)
            out.emit("log", {"level": "warning", "message": f"失败重试，先冷却 {cooldown:.0f}s 再以低速继续..."})
            await asyncio.sleep(cooldown)

        while has_more and (limit <= 0 or len(results) < limit):
            page += 1
            await rate_limiter.acquire()
            action = "继续" if is_retry else "获取"
            out.emit("progress", {"current": len(results), "total": limit or 0, "message": f"第 {page} 页（{action}）"})

            resp = await api.get_user_post(sec_uid, max_cursor=cursor, count=18)
            status_code = resp.get("status_code", 0)
            status_msg = resp.get("status_msg", "")
            page_has_more = bool(resp.get("has_more", False))
            _write_debug_log(
                f"page={page} cursor={cursor} status_code={status_code} "
                f"msg={status_msg} has_more={page_has_more} "
                f"items={len(resp.get('items') or resp.get('aweme_list') or [])}"
            )

            if _is_rate_limited(resp):
                rate_limit_backoff = min(rate_limit_backoff + 1, 5)
                wait = min(2 ** rate_limit_backoff + random.uniform(0, 1), 120)
                out.emit(
                    "log",
                    {"level": "warning", "message": f"触发接口风控，{wait:.1f}s 后重试（第 {rate_limit_backoff} 次）"},
                )
                if rate_limit_backoff >= 3:
                    out.emit("log", {"level": "error", "message": "接口请求过于频繁，已停止获取，请稍后再试"})
                    has_more = True
                    stopped_reason = "rate_limited"
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
                if limit > 0:
                    formatted = formatted[:limit - len(results)]
                results.extend(formatted)
                out.emit("items", {"items": formatted, "total": len(results)})
                empty_retries = 0
                cursor_retries = 0
            elif page == 1 and empty_retries < 1:
                empty_retries += 1
                out.emit("log", {"level": "warning", "message": f"首页为空，第 {empty_retries} 次重试..."})
                _write_debug_log(f"first page empty, retry {empty_retries}")
                await asyncio.sleep(3.0 + empty_retries * 2.0)
                continue
            elif page_has_more and empty_retries < 2:
                # API 声明还有下一页但本页为空，可能是 transient 风控或数据抖动，继续重试
                empty_retries += 1
                out.emit("log", {"level": "warning", "message": f"第 {page} 页返回为空但 has_more=true，第 {empty_retries} 次重试..."})
                _write_debug_log(f"page {page} empty but has_more, retry {empty_retries}")
                await asyncio.sleep(4.0 + empty_retries * 2.0)
                continue
            else:
                stopped_reason = "empty_page"
                break

            has_more = page_has_more
            next_cursor = resp.get("max_cursor", 0)

            if has_more and next_cursor == cursor:
                if cursor_retries < 1:
                    cursor_retries += 1
                    out.emit("log", {"level": "warning", "message": f"游标未推进，第 {cursor_retries} 次重试..."})
                    await asyncio.sleep(5.0 + cursor_retries * 2.0)
                    continue
                stopped_reason = "cursor_stall"
                break

            cursor = next_cursor

            if not has_more or (limit > 0 and len(results) >= limit):
                if limit > 0 and len(results) >= limit:
                    stopped_reason = "limit_reached"
                break

            # 分页间隔比后台同步更保守，降低连续请求触发风控的概率
            await asyncio.sleep(random.uniform(3.0, 5.0))

    if limit > 0 and len(results) > limit:
        results = results[:limit]
    return {
        "items": results,
        "has_more": has_more,
        "cursor": cursor,
        "stopped_reason": stopped_reason,
    }


async def _fetch_user_works(
    sec_uid: str,
    cookies: Dict[str, str],
    limit: int,
    proxy: str,
    config: ConfigLoader,
    out: BridgeOutput,
    cookie_file: str = ".cookies.json",
    force_refresh: bool = False,
    expected_total: int = 0,
    retry: bool = False,
    nickname: str = "",
) -> dict:
    """获取博主作品列表。失败时记录失败信息，不再浏览器兜底，重试时低速续传。"""
    _write_debug_log(
        f"start sec_uid={sec_uid} limit={limit} expected_total={expected_total} "
        f"retry={retry} proxy={proxy} force_refresh={force_refresh} cookies_keys={list(cookies.keys())}"
    )

    output_path = config.get("path") or "."
    Path(output_path).mkdir(parents=True, exist_ok=True)

    # 1. 重试时读取上次失败记录
    recorded_items: List[dict] = []
    initial_cursor = 0
    is_retry = False
    if retry and not force_refresh:
        failure_record = _load_failed_record(config, sec_uid)
        if failure_record:
            recorded_items = failure_record.get("items") or []
            initial_cursor = int(failure_record.get("cursor") or 0)
            is_retry = True
            out.emit("log", {
                "level": "info",
                "message": f"读取到失败记录，已缓存 {len(recorded_items)} 个作品，将从游标 {initial_cursor} 继续",
            })

    # 2. 优先从本地数据库读取；强制刷新时跳过缓存
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
                _remove_failed_record(config, sec_uid)
                return {
                    "items": db_results[:limit],
                    "is_complete": True,
                    "expected_total": expected_total,
                    "actual_total": len(db_results[:limit]),
                    "failed_count": 0,
                    "source_counts": {"db": len(db_results), "recorded": 0, "api": 0},
                }

    # 3. 缓存不足或强制刷新时，调用 API 低速补充/获取数据
    need_count = limit
    if not force_refresh and db_results and limit > 0:
        need_count = limit - len(db_results)
        _write_debug_log(f"db cache partial, need {need_count} more from api")

    api_info = await _fetch_from_api(
        sec_uid, cookies, proxy, need_count if need_count > 0 else limit, config, out, cookie_file,
        initial_cursor=initial_cursor, is_retry=is_retry,
    )
    api_results: List[dict] = api_info.get("items", [])
    api_has_more: bool = bool(api_info.get("has_more", False))
    api_stopped: Optional[str] = api_info.get("stopped_reason")
    last_cursor = int(api_info.get("cursor") or 0)

    if not api_results and not db_results and not recorded_items:
        out.emit("progress", {
            "current": 0,
            "total": limit or 0,
            "message": "接口未返回数据，请检查 Cookie 或稍后刷新",
        })

    # 4. 合并数据库缓存 + 已记录缓存 + API 结果
    merged = _merge_aweme_results(db_results, recorded_items + api_results)
    if limit > 0 and len(merged) > limit:
        merged = merged[:limit]

    actual_total = len(merged)
    target_count = expected_total if expected_total > 0 else limit
    if target_count > 0:
        is_complete = actual_total >= target_count
        failed_count = max(0, target_count - actual_total)
    else:
        is_complete = not api_has_more and api_stopped != "rate_limited"
        failed_count = 0

    if is_complete:
        _remove_failed_record(config, sec_uid)
    else:
        _save_failed_record(config, sec_uid, {
            "sec_uid": sec_uid,
            "nickname": nickname,
            "expected_total": expected_total,
            "actual_total": actual_total,
            "failed_count": failed_count,
            "cursor": last_cursor,
            "has_more": api_has_more,
            "stopped_reason": api_stopped,
            "items": merged,
            "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        })
        out.emit("log", {
            "level": "error",
            "message": f"拉取不完整：已获取 {actual_total}/{target_count} 个作品，失败 {failed_count} 个，已记录失败信息",
        })

    _write_debug_log(
        f"done total={actual_total} complete={is_complete} failed={failed_count} "
        f"(db={len(db_results)}, recorded={len(recorded_items)}, api={len(api_results)})"
    )
    return {
        "items": merged,
        "is_complete": is_complete,
        "expected_total": expected_total,
        "actual_total": actual_total,
        "failed_count": failed_count,
        "source_counts": {
            "db": len(db_results),
            "recorded": len(recorded_items),
            "api": len(api_results),
        },
    }


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
    expected_total = int(job.get("expected_total") or 0)
    proxy = str(job.get("proxy") or config.get("proxy") or "")
    nickname = str(job.get("nickname") or "")
    retry = bool(job.get("retry", False))

    cookie_file = str(job.get("cookieFile") or "").strip()
    if not cookie_file:
        output_path = config.get("path") or "."
        Path(output_path).mkdir(parents=True, exist_ok=True)
        cookie_file = str(Path(output_path) / ".cookies.json")
    else:
        Path(cookie_file).parent.mkdir(parents=True, exist_ok=True)

    out.emit("start", {"sec_uid": sec_uid, "limit": limit, "expected_total": expected_total, "retry": retry})

    force_refresh = bool(job.get("force_refresh", False))
    try:
        result = asyncio.run(_fetch_user_works(
            sec_uid, cookies, limit, proxy, config, out,
            cookie_file=cookie_file, force_refresh=force_refresh, expected_total=expected_total,
            retry=retry, nickname=nickname,
        ))
    except Exception as exc:
        out.error(f"获取作品失败：{exc}")
        return

    items = result.get("items", [])
    is_complete = bool(result.get("is_complete", True))
    actual_total = int(result.get("actual_total", len(items)))
    failed_count = int(result.get("failed_count", 0))
    source_counts = result.get("source_counts", {})

    out.emit("done", {
        "total": actual_total,
        "items": items,
        "is_complete": is_complete,
        "expected_total": expected_total,
        "failed_count": failed_count,
        "source_counts": source_counts,
    })
    # success 保持 true：未完整获取不是程序异常，前端根据 is_complete 展示失败/重试提示
    out.finished(
        success=True,
        data={
            "total": actual_total,
            "is_complete": is_complete,
            "expected_total": expected_total,
            "failed_count": failed_count,
            "source_counts": source_counts,
        },
    )


if __name__ == "__main__":
    safe_main(main)
