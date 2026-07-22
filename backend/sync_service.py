#!/usr/bin/env python3
"""抖音个人数据同步服务（收藏、喜欢、关注、收藏合集）。

为 Electron 前端提供可独立运行的数据抓取入口：读取 job 文件，分页拉取数据，
缓存到本地 JSON，并通过 stdout 输出 NDJSON 进度事件。
"""

import argparse
import asyncio
import json
import logging
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set

BACKEND_ROOT = Path(__file__).resolve().parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from auth import CookieManager
from config import ConfigLoader
from control import RateLimiter
from core.api_client import DouyinAPIClient
from core.following import FollowingUser, _extract_follow_time
from storage import Database
from utils.cookie_utils import parse_cookie_header
from utils.logger import set_console_log_level
from utils.proxy_pool import ProxyPool

set_console_log_level(logging.CRITICAL)


def emit(event: str, **kwargs):
    print(json.dumps({"event": event, **kwargs}, ensure_ascii=False), flush=True)


def _ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def _save_cache(cache_path: Path, data: dict):
    _ensure_dir(cache_path.parent)
    text = json.dumps(data, ensure_ascii=False, indent=2)
    # 先写入临时文件再重命名，避免旧文件被占用时无法覆盖（Windows 常见 PermissionError）。
    tmp_path = cache_path.with_suffix(cache_path.suffix + ".tmp")
    try:
        tmp_path.write_text(text, encoding="utf-8")
        tmp_path.replace(cache_path)
    except PermissionError:
        # 若仍被占用，尝试备份旧文件后重试一次。
        try:
            if cache_path.exists():
                backup = cache_path.with_suffix(cache_path.suffix + f".bak-{int(time.time())}")
                cache_path.replace(backup)
            tmp_path.write_text(text, encoding="utf-8")
            tmp_path.replace(cache_path)
        except Exception:
            # 最后一次尝试：直接覆盖原文件。
            cache_path.write_text(text, encoding="utf-8")
    except Exception:
        cache_path.write_text(text, encoding="utf-8")


def _load_cache(cache_path: Path) -> dict:
    if cache_path.exists():
        try:
            return json.loads(cache_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _parse_cookies(cookies: Any) -> Dict[str, str]:
    if not cookies:
        return {}
    if isinstance(cookies, str):
        return parse_cookie_header(cookies)
    if isinstance(cookies, dict):
        return {str(k): str(v) for k, v in cookies.items()}
    return {}


def _extract_aweme(item: Any) -> Optional[dict]:
    """从可能嵌套的条目里取出 aweme 对象。"""
    if not isinstance(item, dict):
        return None
    if item.get("aweme_id"):
        return item
    for key in ("aweme", "aweme_info", "aweme_detail"):
        value = item.get(key)
        if isinstance(value, dict) and value.get("aweme_id"):
            return value
    return None


def _format_aweme(item: dict) -> dict:
    """从 aweme 对象提取前端需要的字段。"""
    raw = _extract_aweme(item) or {}
    author = raw.get("author", {}) or {}
    stats = raw.get("statistics", {}) or {}
    return {
        "aweme_id": raw.get("aweme_id") or raw.get("awemeId"),
        "title": raw.get("desc", ""),
        "create_time": raw.get("create_time"),
        "cover": (raw.get("video", {}) or {}).get("cover", {}).get("url_list", [""])[0],
        "author": {
            "sec_uid": author.get("sec_uid"),
            "nickname": author.get("nickname", ""),
            "unique_id": author.get("unique_id", ""),
            "avatar": (author.get("avatar", {}) or {}).get("url_list", [""])[0],
        },
        "share_url": raw.get("share_url", ""),
        "duration": (raw.get("video", {}) or {}).get("duration", 0),
        "digg_count": stats.get("digg_count", 0),
        "comment_count": stats.get("comment_count", 0),
        "is_invalid": False,
    }


def _mark_invalid_items(items: List[dict], fetched_ids: Set[str]) -> None:
    """将本次同步未返回的作品标记为失效，已返回的作品清除失效标记。

    用于「喜欢」和「收藏视频」等单一来源列表：同步完成后本地仍保留记录，
    但不存在的作品会显示暗灰色蒙版和「作品已失效」提示，且无法下载。
    """
    for it in items:
        aweme_id = it.get("aweme_id")
        if not aweme_id:
            continue
        it["is_invalid"] = aweme_id not in fetched_ids


def _format_collection(item: dict) -> dict:
    return {
        "collects_id": item.get("collects_id") or item.get("collection_id"),
        "name": item.get("name", "未命名收藏夹"),
        "cover": (item.get("cover", {}) or {}).get("url_list", [""])[0]
        if isinstance(item.get("cover"), dict)
        else item.get("cover", ""),
        "video_count": item.get("video_count", item.get("aweme_count", 0)),
        "create_time": item.get("create_time"),
    }


def _format_collect_mix(item: dict) -> dict:
    return {
        "mix_id": item.get("mix_id") or item.get("mixid"),
        "name": item.get("mix_name", item.get("name", "未命名合集")),
        "cover": (item.get("cover", {}) or {}).get("url_list", [""])[0]
        if isinstance(item.get("cover"), dict)
        else item.get("cover", ""),
        "video_count": item.get("aweme_count", item.get("video_count", 0)),
    }


def _format_music(item: dict) -> dict:
    music_id = item.get("music_id") or item.get("mid") or item.get("id")
    author = item.get("author") or item.get("owner") or item.get("owner_info") or {}
    cover = item.get("cover") or item.get("cover_thumb") or item.get("avatar_thumb") or {}
    play_url = item.get("play_url") or item.get("play_url_") or {}
    if isinstance(play_url, str):
        play_url = {"uri": play_url, "url_list": [play_url]}
    duration = item.get("duration", 0)
    if isinstance(duration, dict):
        duration = int(duration.get("time", 0) or 0)
    return {
        "music_id": str(music_id) if music_id else None,
        "title": item.get("title") or item.get("music_name") or item.get("name") or "未知音乐",
        "author": {
            "sec_uid": author.get("sec_uid"),
            "nickname": author.get("nickname") or author.get("owner_nickname") or "",
            "avatar": (author.get("avatar") or {}).get("url_list", [""])[0]
            if isinstance(author.get("avatar"), dict)
            else "",
        },
        "cover": (cover.get("url_list") or [""])[0] if isinstance(cover, dict) else str(cover or ""),
        "play_url": (play_url.get("url_list") or [""])[0]
        if isinstance(play_url, dict)
        else str(play_url or ""),
        "duration": duration,
        "usage_count": item.get("user_count") or item.get("usage_count") or 0,
    }


def _parse_extra(extra: Any) -> Dict[str, Any]:
    """把 extra 字段统一解析为 dict（可能来自 JSON 缓存或数据库 json 字符串）。"""
    if isinstance(extra, str):
        try:
            return json.loads(extra)
        except Exception:
            return {}
    if isinstance(extra, dict):
        return extra
    return {}


def _format_user(item: dict) -> dict:
    """从原始关注条目或 FollowingUser.to_dict() 提取前端所需字段。"""
    avatar = item.get("avatar", "")
    if isinstance(avatar, dict):
        avatar = (avatar.get("url_list") or [""])[0]
    # 抖音 Web 接口没有返回精确的关注时间戳，create_time 通常是账号/作品时间，
    # 不能直接当作关注时间展示，否则会出现“最近关注”显示为几年前的情况。
    # 这里固定为 0，真正的“关注顺序”由同步时的 follow_order 保证。
    create_time = 0
    follow_order = item.get("follow_order") if isinstance(item, dict) else None

    extra = _parse_extra(item.get("extra"))
    video_count = item.get("video_count") or extra.get("video_count", 0)
    return {
        "sec_uid": item.get("sec_uid"),
        "nickname": item.get("nickname", ""),
        "unique_id": item.get("unique_id", ""),
        "signature": item.get("signature", ""),
        "avatar": avatar,
        "following_count": item.get("following_count", 0),
        "follower_count": item.get("follower_count", item.get("mplatform_followers_count", 0)),
        "aweme_count": item.get("aweme_count", 0),
        "video_count": video_count,
        "create_time": create_time,
        "follow_order": follow_order,
        "extra": extra,
    }


def _merge_aweme_count(existing: dict, new: dict) -> None:
    """合并作品数：优先保留更可靠的总作品数，并在数字变化时触发重新补全。"""
    new_extra = _parse_extra(new.get("extra"))
    new_source = new_extra.get("aweme_count_source")
    if not existing.get("aweme_count"):
        return
    old_extra = _parse_extra(existing.get("extra"))
    old_source = old_extra.get("aweme_count_source")

    # 已经通过主页接口确认过的数据最可靠；如果关注列表接口给出的数字发生变化，
    # 说明博主可能发布了新作品或删除了旧作品，需要重新用主页接口确认。
    if old_source == "profile_api" and new_source in ("aweme_count", "video_count", "unknown"):
        new_aweme_count = int(new.get("aweme_count") or 0)
        old_aweme_count = int(existing.get("aweme_count") or 0)
        if new_aweme_count and new_aweme_count != old_aweme_count:
            # 数字发生变化，降级为 aweme_count 来源以便再次走主页接口补全
            new_extra["aweme_count_source"] = "aweme_count"
            new["extra"] = new_extra
            return
        # 数字没变化，保留主页接口确认过的值，避免被关注列表接口的缓存/子集覆盖
        new["aweme_count"] = existing["aweme_count"]
        new["video_count"] = existing.get("video_count", new.get("video_count"))
        new["extra"] = old_extra
        return

    if new_source != "video_count":
        return
    if old_source in ("aweme_count", "profile_api"):
        new["aweme_count"] = existing["aweme_count"]
        new["video_count"] = existing.get("video_count", new.get("video_count"))
        new["extra"] = old_extra


def _resolve_topic_id(query: str) -> Optional[str]:
    """从用户输入中解析话题 ID（ch_id）。

    支持：
    - 纯数字 ID
    - 抖音话题链接：https://www.douyin.com/hashtag/123456 或 /challenge/123456
    - 分享域话题链接：https://www.iesdouyin.com/share/challenge/123456
    """
    if not query:
        return None
    query = query.strip()
    # URL 路径匹配
    m = re.search(r"/(?:hashtag|challenge|tag)/([A-Za-z0-9_-]+)", query)
    if m:
        return m.group(1)
    # 纯数字
    if re.fullmatch(r"\d+", query):
        return query
    return None


def _extract_search_topic_name(query: str) -> Optional[str]:
    """从抖音搜索 URL 中提取话题名（# 后面的内容）。

    支持：
    - https://www.douyin.com/search/%23话题名?type=general
    - https://www.douyin.com/search/#话题名
    - https://www.douyin.com/search?keyword=%23话题名
    """
    if not query:
        return None
    from urllib.parse import parse_qs, unquote, urlparse

    parsed = urlparse(query.strip())
    host = (parsed.netloc or "").lower()
    if "douyin.com" not in host:
        return None

    # 路径形式 /search/%23话题名（unquote 后变成 /search/#话题名）
    path = unquote(parsed.path or "")
    m = re.search(r"/search/#\s*([^/]+)", path)
    if m:
        return m.group(1).strip()

    # #话题名 也可能被浏览器解析为 fragment，例如 /search/#cosplay
    fragment = unquote(parsed.fragment or "").strip()
    if fragment:
        return fragment

    # 查询参数 keyword=#话题名 或 keyword=%23话题名
    qs = parse_qs(parsed.query)
    keyword = (qs.get("keyword") or [None])[0]
    if keyword:
        decoded = unquote(keyword).strip()
        if decoded.startswith("#"):
            return decoded[1:].strip()
    return None


def _format_topic(item: dict) -> dict:
    """从 challenge 详情中提取前端需要的字段。"""
    return {
        "ch_id": str(item.get("ch_id") or ""),
        "name": item.get("challenge_name") or item.get("name") or "未命名话题",
        "cover": item.get("cover", ""),
        "description": item.get("description", ""),
        "user_count": int(item.get("user_count") or 0),
        "view_count": int(item.get("view_count") or 0),
    }


class SyncService:
    def __init__(self, config: ConfigLoader, cookies: Any, cookie_file: Optional[str] = None):
        self.config = config
        self.cookies = _parse_cookies(cookies)
        cookie_file = str(cookie_file or "").strip()
        if cookie_file and self.cookies:
            from auth import CookieManager
            Path(cookie_file).parent.mkdir(parents=True, exist_ok=True)
            CookieManager(cookie_file=cookie_file).set_cookies(self.cookies)
        self.output_path = Path(config.get("path", "."))
        self.sync_dir = _ensure_dir(self.output_path / ".sync")
        self.proxy_pool = ProxyPool.from_config(config)
        self.proxy = ProxyPool.single_proxy_from_config(config)
        self.database: Optional[Database] = None
        rate_limit = config.get("rate_limit", 2)
        try:
            rate_limit = float(rate_limit) if rate_limit is not None else 2.0
        except (TypeError, ValueError):
            rate_limit = 2.0
        self.rate_limiter = RateLimiter(max_per_second=rate_limit)

    def _cache_path(self, name: str) -> Path:
        return self.sync_dir / f"{name}.json"

    def _cursor_path(self) -> Path:
        return self.sync_dir / "favorites_cursor.json"

    async def _init_database(self) -> None:
        if not self.config.get("database", True):
            return
        db_path = self.config.get("database_path")
        if not db_path:
            db_path = str(self.output_path / "dy_downloader.db")
        try:
            db = Database(db_path=str(db_path))
            await db.initialize()
            self.database = db
        except Exception as exc:
            logging.warning("SyncService 数据库初始化失败，降级为 JSON cursor: %s", exc)
            self.database = None

    def _load_cursor_state(self) -> Dict[str, Dict[str, int]]:
        path = self._cursor_path()
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    return {k: dict(v) for k, v in data.items() if isinstance(v, dict)}
            except Exception:
                pass
        return {}

    def _save_cursor_state(self, state: Dict[str, Dict[str, int]]) -> None:
        path = self._cursor_path()
        _ensure_dir(path.parent)
        path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")

    async def _get_cursor(self, kind: str, entity_id: str) -> int:
        if self.database:
            try:
                value = await self.database.get_sync_cursor(kind, entity_id)
                return value if value is not None else 0
            except Exception as exc:
                logging.warning("读取 sync_cursor 失败 %s/%s: %s", kind, entity_id, exc)
        state = self._load_cursor_state()
        return int(state.get(kind, {}).get(entity_id, 0) or 0)

    async def _set_cursor(self, kind: str, entity_id: str, cursor: int) -> None:
        if self.database:
            try:
                await self.database.set_sync_cursor(kind, entity_id, cursor)
                return
            except Exception as exc:
                logging.warning("保存 sync_cursor 失败 %s/%s: %s", kind, entity_id, exc)
        state = self._load_cursor_state()
        state.setdefault(kind, {})[entity_id] = int(cursor)
        self._save_cursor_state(state)

    async def _load_existing_aweme_ids_from_db(self, *kinds: str) -> Set[str]:
        """Load already-synced aweme ids for the given kinds from SQLite."""
        if not self.database:
            return set()
        result: Set[str] = set()
        for kind in kinds:
            try:
                result.update(await self.database.get_aweme_id_set(kind))
            except Exception as exc:
                logging.warning("SyncService 从数据库加载 %s aweme_id 失败: %s", kind, exc)
        return result

    async def _upsert_awemes_to_db(self, items: List[dict], aweme_type: str) -> None:
        """Batch persist awemes seen during a sync to the dedup table."""
        if not items or not self.database:
            return
        rows = []
        for it in items:
            author = it.get("author") or {}
            rows.append(
                {
                    "aweme_id": it.get("aweme_id"),
                    "aweme_type": aweme_type,
                    "title": it.get("title"),
                    "author_id": author.get("sec_uid"),
                    "author_name": author.get("nickname"),
                    "author_sec_uid": author.get("sec_uid"),
                    "create_time": it.get("create_time"),
                    "file_path": None,
                    "metadata": json.dumps(it, ensure_ascii=False),
                }
            )
        try:
            await self.database.add_aweme_batch(rows)
        except Exception as exc:
            logging.warning("SyncService 批量保存 %s aweme 失败: %s", aweme_type, exc)

    @staticmethod
    def _is_login_error(status_code: int, status_msg: str) -> bool:
        return status_code in (2483,) or "请先登录" in status_msg

    @staticmethod
    def _is_permission_error(status_code: int, status_msg: str) -> bool:
        msg = str(status_msg or "").lower()
        return any(
            keyword in msg
            for keyword in (
                "私密",
                "私有",
                "不可见",
                "无权限",
                "没有权限",
                "权限",
                "查看权限",
                "无法查看",
            )
        ) or status_code in (2112, 2113, 2200)

    async def _client(self):
        return DouyinAPIClient(
            self.cookies,
            proxy=self.proxy,
            proxy_pool=self.proxy_pool,
            config=self.config.config if self.config else None,
        )

    async def _enrich_following_aweme_count(
        self,
        api: DouyinAPIClient,
        items_index: Dict[str, dict],
    ) -> int:
        """用用户主页接口补全关注列表中的作品数。

        抖音关注列表接口返回的 ``aweme_count`` 可能只是公开/可见作品数、缓存值或子集，
        并不总是准确的总作品数。``/aweme/v1/web/user/profile/other/`` 能拿到更可靠的
        总作品数，因此只要本地记录还没有通过主页接口确认过（即 ``aweme_count_source``
        不是 ``profile_api``），都会调用主页接口补全。补全后更新 ``extra`` 标记来源，
        后续同步不再重复请求。
        """

        def _needs_enrich(it: dict) -> bool:
            extra = _parse_extra(it.get("extra"))
            source = extra.get("aweme_count_source")
            # 已经通过主页接口补全过的不再重复请求
            if source == "profile_api":
                return False
            if not it.get("aweme_count"):
                return True
            # 关注列表接口返回的 aweme_count 可能只是公开/可见作品数、缓存值或子集，
            # 只要不是已经通过主页接口确认过的，都用主页接口重新补全，确保数字准确。
            return True

        enrich_targets = [
            (sec, it)
            for sec, it in items_index.items()
            if _needs_enrich(it)
        ]
        if not enrich_targets:
            return 0

        fixed = 0
        pending_db: List[dict] = []
        emit("sync_progress", kind="following_enrich", total=len(enrich_targets), fixed=0)

        # 限制并发，避免对主页接口造成过大压力或触发风控
        semaphore = asyncio.Semaphore(5)

        async def _enrich_one(sec: str, it: dict) -> Optional[dict]:
            async with semaphore:
                await self.rate_limiter.acquire()
                try:
                    info = await api.get_user_info(sec)
                except Exception as exc:
                    logging.debug("补全作品数失败 %s: %s", sec, exc)
                    return None
                if not isinstance(info, dict):
                    return None
                real_aweme_count = int(info.get("aweme_count") or 0)
                if real_aweme_count <= 0:
                    return None
                it["aweme_count"] = real_aweme_count
                it["video_count"] = real_aweme_count
                extra = _parse_extra(it.get("extra"))
                extra["aweme_count_source"] = "profile_api"
                extra["video_count"] = real_aweme_count
                it["extra"] = extra
                return it

        # 分批并发，避免一次性创建过多协程
        BATCH = 30
        for i in range(0, len(enrich_targets), BATCH):
            batch = enrich_targets[i : i + BATCH]
            results = await asyncio.gather(*[_enrich_one(sec, it) for sec, it in batch])
            for enriched in results:
                if enriched:
                    pending_db.append(enriched)
                    fixed += 1
                    if len(pending_db) >= 20:
                        if self.database:
                            try:
                                await self.database.upsert_following_batch(pending_db)
                            except Exception as exc:
                                logging.warning("SyncService 补全作品数写入数据库失败: %s", exc)
                        pending_db = []
            emit("sync_progress", kind="following_enrich", total=len(enrich_targets), fixed=fixed)

        if pending_db and self.database:
            try:
                await self.database.upsert_following_batch(pending_db)
            except Exception as exc:
                logging.warning("SyncService 补全作品数写入数据库失败: %s", exc)

        if fixed > 0:
            logging.info("SyncService 补全 %d 位用户的作品数", fixed)
        return fixed

    async def probe_proxies(self) -> None:
        """下载前探活代理池并按延迟排序。"""
        if self.proxy_pool:
            await self.proxy_pool.probe()

    async def _sync_paged_awemes(
        self,
        api: DouyinAPIClient,
        kind: str,
        entity_id: str,
        entity_name: str,
        fetch_fn: Callable[[int], Any],
        existing_ids: Set[str],
        all_items: List[dict],
        total_added: int,
        limit: int,
        aweme_type: str = "favorite",
    ) -> int:
        """分页拉取某个收藏夹/合集的视频，使用并持久化 cursor。

        只有该实体完整拉完（has_more=False）时才保存 cursor；
        因全局 limit 提前退出时不保存，下次从旧 cursor 重试，重复项由 existing_ids 去重。
        遇到私密/无权限收藏夹时跳过该实体，不影响其他收藏夹。
        """
        cursor = await self._get_cursor(kind, entity_id)
        drained = False
        progress_kind = "collect_mix_items" if kind == "collectmix" else "favorites_items"
        pending_db_items: List[dict] = []
        fetched_ids: Set[str] = set()

        while total_added < limit:
            resp = await fetch_fn(cursor)
            status_code = int(resp.get("status_code") or 0)
            status_msg = str(resp.get("status_msg") or "")

            if self._is_login_error(status_code, status_msg):
                emit("sync_error", kind="favorites", message=f"登录已失效：{status_code} {status_msg}".strip())
                break

            if self._is_permission_error(status_code, status_msg):
                emit(
                    "sync_progress",
                    kind=progress_kind,
                    collection=entity_name,
                    collection_id=entity_id,
                    skipped=True,
                    reason="私密或无权访问",
                    status_code=status_code,
                    status_msg=status_msg,
                )
                logging.warning("SyncService %s/%s permission denied, skip: %s %s", kind, entity_id, status_code, status_msg)
                break

            raw_page_items = resp.get("items", [])
            page_items = [_format_aweme(i) for i in raw_page_items if _extract_aweme(i)]
            added = 0
            for it in page_items:
                fetched_ids.add(it["aweme_id"])
                if it["aweme_id"] not in existing_ids:
                    existing_ids.add(it["aweme_id"])
                    it["collection_id"] = entity_id
                    it["collection_name"] = entity_name
                    it["_aweme_type"] = aweme_type
                    all_items.append(it)
                    pending_db_items.append(it)
                    total_added += 1
                    added += 1

            if added or page_items:
                emit(
                    "sync_progress",
                    kind=progress_kind,
                    collection=entity_name,
                    collection_id=entity_id,
                    added=added,
                    total=len(all_items),
                    cursor=cursor,
                    status_code=status_code,
                    status_msg=status_msg,
                )

            # 每满 100 条批量写入一次数据库，兼顾性能与中断安全
            if len(pending_db_items) >= 100:
                await self._upsert_awemes_to_db(pending_db_items, aweme_type)
                pending_db_items = []

            has_more = bool(resp.get("has_more", False))
            next_cursor = int(resp.get("max_cursor", 0) or 0)
            if not has_more:
                drained = True
                # 完成时保存接口返回的下一个游标，避免下次重复拉取最后一页
                cursor = next_cursor if next_cursor else cursor
                break
            if next_cursor == cursor:
                logging.warning("SyncService %s/%s cursor did not advance (%s), stop paging", kind, entity_id, cursor)
                break
            cursor = next_cursor
            await self.rate_limiter.acquire()

        if pending_db_items:
            await self._upsert_awemes_to_db(pending_db_items, aweme_type)

        # 收藏夹/合集内作品被博主删除后，接口不再返回该作品。只有完整拉完本实体
        # 时，才将未返回的作品标记为失效，避免 limit 中途退出导致误判。
        if drained:
            for it in all_items:
                if it.get("collection_id") == entity_id and it.get("aweme_id"):
                    it["is_invalid"] = it["aweme_id"] not in fetched_ids
            await self._set_cursor(kind, entity_id, cursor)
        return total_added

    async def sync_likes(self, limit: int = 1000) -> dict:
        cache_path = self._cache_path("likes")
        cache = _load_cache(cache_path)
        # 旧缓存/数据库里的顺序不可信（可能来自上次有 bug 的同步），
        # 只用来收集已有作品数据（去重、合并字段、识别新增），最终顺序由本次 API 返回决定。
        existing_items: Dict[str, dict] = {}
        for it in cache.get("items", []):
            aid = it.get("aweme_id")
            if aid:
                existing_items[aid] = it

        db_items: List[dict] = []
        await self._init_database()
        if self.database:
            try:
                db_rows = await self.database.get_aweme_rows_by_type("like")
                for row in db_rows:
                    meta = row.get("metadata")
                    if meta:
                        try:
                            item = json.loads(meta)
                        except Exception:
                            item = {}
                    else:
                        item = {
                            "aweme_id": row.get("aweme_id"),
                            "title": row.get("title"),
                            "author": {
                                "sec_uid": row.get("author_sec_uid"),
                                "nickname": row.get("author_name"),
                            },
                        }
                    if item.get("aweme_id"):
                        db_items.append(item)
                        existing_items[item["aweme_id"]] = item
            except Exception as exc:
                logging.warning("SyncService 从数据库加载喜欢列表失败: %s", exc)

        # 最终列表：由本次 API 返回顺序填充，最新点赞在前。
        items: List[dict] = []
        existing_ids = set(existing_items.keys())

        emit("sync_start", kind="likes", cached=len(existing_ids), limit=limit)

        sec_uid = "self"
        # 喜欢列表按时间倒序排列，新内容永远在 cursor=0 的最前面。
        # 为了识别被博主删除的失效作品，需要拉取到 limit 或 has_more=false，
        # 然后根据本次实际拉取到的作品 ID 统一标记失效状态。
        cursor = 0
        added = 0
        page = 0
        pending_db_items: List[dict] = []
        # 记录本次同步实际从接口拉取到的所有作品 ID，用于识别被博主删除的失效作品
        fetched_ids: Set[str] = set()

        async with await self._client() as api:
            while len(items) < limit:
                page += 1
                resp = await api.get_user_like(sec_uid, max_cursor=cursor, count=20)
                status_code = int(resp.get("status_code") or 0)
                status_msg = str(resp.get("status_msg") or "")
                has_more = bool(resp.get("has_more", False))
                raw_page_items = resp.get("items", [])
                page_items = [_format_aweme(i) for i in raw_page_items if _extract_aweme(i)]

                emit("sync_progress", kind="likes", added=added, total=len(items), page=page, page_size=len(page_items), status_code=status_code, status_msg=status_msg, has_more=has_more)

                if self._is_login_error(status_code, status_msg):
                    emit("sync_error", kind="likes", message=f"登录已失效：{status_code} {status_msg}".strip())
                    return cache

                if self._is_permission_error(status_code, status_msg):
                    emit("sync_error", kind="likes", message=f"喜欢列表无法访问（可能已设为私密）：{status_code} {status_msg}".strip())
                    return cache

                if not page_items:
                    if status_code not in (0, None) and not items:
                        emit("sync_error", kind="likes", message=f"获取喜欢列表失败：{status_code} {status_msg}".strip())
                        return cache
                    break

                new_items: List[dict] = []
                for it in page_items:
                    fetched_ids.add(it["aweme_id"])
                    if it["aweme_id"] not in existing_ids:
                        added += 1
                    new_items.append(it)
                    pending_db_items.append(it)

                # Douyin 喜欢接口按点赞时间倒序返回（cursor=0 是最新的），
                # 因此把后续页追加到列表末尾即可保持“最新在前”。
                items = items + new_items

                if len(pending_db_items) >= 100:
                    await self._upsert_awemes_to_db(pending_db_items, "like")
                    pending_db_items = []

                if not has_more:
                    break

                next_cursor = int(resp.get("max_cursor", 0) or 0)
                if next_cursor == cursor:
                    logging.warning("SyncService likes cursor did not advance (%s), stop paging", cursor)
                    break
                cursor = next_cursor
                await self.rate_limiter.acquire()

        # 把本地有但本次接口未返回的作品追加到末尾。
        # 这些通常是已经被删除或不在前 limit 条中的作品，保持最新在前的顺序。
        for it in existing_items.values():
            if it.get("aweme_id") and it["aweme_id"] not in fetched_ids:
                items.append(it)

        # 将本次同步未返回的作品标记为失效（被博主删除），已返回的清除失效标记。
        # 仅对实际参与本次同步的前 limit 条记录做判断，超出 limit 未拉取的部分保持原状态。
        _mark_invalid_items(items[:limit], fetched_ids)

        # 抖音接口不返回点赞时间戳，但返回顺序即「最新点赞在前」。
        # 用本次同步列表顺序作为点赞顺序的代理，数值越小表示点赞越新，0 为最新。
        for idx, it in enumerate(items[:limit]):
            it["like_order"] = idx

        # 将带有最终 like_order 的数据再次持久化到数据库，保证下次从数据库
        # 回填缓存时仍能保持正确的点赞排序。
        if items[:limit]:
            await self._upsert_awemes_to_db(items[:limit], "like")

        cache.update({"items": items[:limit], "updated_at": _now(), "count": len(items[:limit])})
        _save_cache(cache_path, cache)

        # 喜欢列表没有断点续传的意义，始终重置游标，避免旧断点导致跳过新内容。
        await self._set_cursor("likes", sec_uid, 0)

        invalid_count = sum(1 for it in items[:limit] if it.get("is_invalid"))
        emit("sync_done", kind="likes", total=len(items[:limit]), added=added, invalid=invalid_count)
        return cache

    async def _sync_favorites_music(self, api: DouyinAPIClient, limit: int = 1000) -> List[dict]:
        """同步「我的收藏 → 音乐」列表。"""
        items: List[dict] = []
        cursor = 0
        page = 0
        while len(items) < limit:
            page += 1
            resp = await api.get_user_music("self", max_cursor=cursor, count=20)
            status_code = int(resp.get("status_code") or 0)
            status_msg = str(resp.get("status_msg") or "")
            has_more = bool(resp.get("has_more", False))
            page_items = [_format_music(i) for i in resp.get("items", []) if _format_music(i).get("music_id")]

            emit("sync_progress", kind="favorites_music", added=len(page_items), total=len(items) + len(page_items), page=page, status_code=status_code, status_msg=status_msg, has_more=has_more)

            if self._is_login_error(status_code, status_msg):
                emit("sync_error", kind="favorites", message=f"登录已失效：{status_code} {status_msg}".strip())
                break

            if not page_items:
                if status_code not in (0, None) and not items:
                    logging.warning("SyncService 获取收藏音乐列表失败: %s %s", status_code, status_msg)
                break

            items.extend(page_items)

            if not has_more:
                break
            next_cursor = int(resp.get("max_cursor", 0) or 0)
            if next_cursor == cursor:
                logging.warning("SyncService favorites music cursor did not advance (%s), stop paging", cursor)
                break
            cursor = next_cursor
            await self.rate_limiter.acquire()

        return items[:limit]

    async def _sync_favorite_videos(self, api: DouyinAPIClient, limit: int = 1000) -> List[dict]:
        """同步「我的收藏 → 视频」默认收藏视频列表（点击收藏直接存入的页面）。

        该列表按时间倒序排列，新内容总在 cursor=0 的最前面。为了实现真正的同步
        并识别被博主删除的作品，这里从 newest 开始持续翻页，直到达到 limit 或
        has_more=false，然后根据本次实际拉取到的作品 ID 标记失效作品。
        """
        cache_path = self._cache_path("favorites")
        cache = _load_cache(cache_path)
        items: List[dict] = list(cache.get("favorite_videos", []))
        existing_ids = {i.get("aweme_id") for i in items if i.get("aweme_id")}

        # 若 JSON 缓存为空，从数据库回填，避免重复拉取
        await self._init_database()
        if not items and self.database:
            try:
                db_rows = await self.database.get_aweme_rows_by_type("favorite")
                existing_ids = set()
                for row in db_rows:
                    meta = row.get("metadata")
                    if meta:
                        try:
                            item = json.loads(meta)
                        except Exception:
                            item = {}
                    else:
                        item = {
                            "aweme_id": row.get("aweme_id"),
                            "title": row.get("title"),
                            "author": {
                                "sec_uid": row.get("author_sec_uid"),
                                "nickname": row.get("author_name"),
                            },
                        }
                    if item.get("aweme_id") and item["aweme_id"] not in existing_ids:
                        existing_ids.add(item["aweme_id"])
                        items.append(item)
            except Exception as exc:
                logging.warning("SyncService 从数据库加载默认收藏视频失败: %s", exc)

        added = 0
        cursor = 0
        page = 0
        pending_db_items: List[dict] = []
        fetched_ids: Set[str] = set()
        while len(items) < limit:
            page += 1
            resp = await api.get_user_favorite_videos(max_cursor=cursor, count=20)
            status_code = int(resp.get("status_code") or 0)
            status_msg = str(resp.get("status_msg") or "")
            has_more = bool(resp.get("has_more", False))
            page_items = [_format_aweme(i) for i in resp.get("items", []) if _extract_aweme(i)]

            emit(
                "sync_progress",
                kind="favorites_videos",
                added=added,
                total=len(items) + len(page_items),
                page=page,
                page_size=len(page_items),
                status_code=status_code,
                status_msg=status_msg,
                has_more=has_more,
            )

            if self._is_login_error(status_code, status_msg):
                emit("sync_error", kind="favorites", message=f"登录已失效：{status_code} {status_msg}".strip())
                break

            if not page_items:
                if status_code not in (0, None) and not items:
                    emit("sync_error", kind="favorites", message=f"获取收藏视频失败：{status_code} {status_msg}".strip())
                break

            new_items: List[dict] = []
            for it in page_items:
                fetched_ids.add(it["aweme_id"])
                if it["aweme_id"] not in existing_ids:
                    existing_ids.add(it["aweme_id"])
                    new_items.append(it)
                    pending_db_items.append(it)
                    added += 1

            # 新收藏放在列表最前面，保持“最新在前”的展示顺序
            items = new_items + items

            if len(pending_db_items) >= 100:
                await self._upsert_awemes_to_db(pending_db_items, "favorite")
                pending_db_items = []

            if not has_more:
                break
            next_cursor = int(resp.get("max_cursor", 0) or 0)
            if next_cursor == cursor:
                logging.warning("SyncService favorite videos cursor did not advance (%s), stop paging", cursor)
                break
            cursor = next_cursor
            await self.rate_limiter.acquire()

        # 标记被博主删除的收藏视频（本次同步未返回的作品）
        _mark_invalid_items(items[:limit], fetched_ids)

        # 默认收藏视频接口按收藏时间倒序返回，用列表顺序作为收藏顺序代理。
        for idx, it in enumerate(items[:limit]):
            it["favorite_order"] = idx

        # 把带最终 favorite_order 的数据落库，保证数据库回填时排序一致。
        if items[:limit]:
            await self._upsert_awemes_to_db(items[:limit], "favorite")

        return items[:limit]

    async def sync_favorites(
        self,
        limit: int = 1000,
        collection_limit: int = 200,
        music_limit: int = 1000,
        sub_kind: Optional[str] = None,
    ) -> dict:
        """同步收藏相关数据。

        sub_kind 用于仅同步某一类数据：
        - folders: 只同步收藏夹列表及收藏夹内视频
        - videos: 只同步「收藏 → 视频」默认收藏视频
        - music: 只同步收藏音乐
        - mixes: 只同步我收藏的合集及合集内视频
        - None: 全部同步
        """
        cache_path = self._cache_path("favorites")
        cache = _load_cache(cache_path)
        collections: List[dict] = list(cache.get("collections", []))
        collect_mixes: List[dict] = list(cache.get("collect_mixes", []))
        all_items: List[dict] = list(cache.get("items", []))
        existing_ids = {i.get("aweme_id") for i in all_items if i.get("aweme_id")}

        # 初始化数据库；若 JSON 缓存为空，用数据库历史数据回填，避免重复拉取
        await self._init_database()
        if not all_items and self.database and sub_kind in (None, "folders", "mixes"):
            try:
                db_rows = await self.database.get_aweme_rows_by_type("favorite") \
                    + await self.database.get_aweme_rows_by_type("collect") \
                    + await self.database.get_aweme_rows_by_type("collectmix")
                existing_ids = set()
                for row in db_rows:
                    meta = row.get("metadata")
                    if meta:
                        try:
                            item = json.loads(meta)
                        except Exception:
                            item = {}
                    else:
                        item = {
                            "aweme_id": row.get("aweme_id"),
                            "title": row.get("title"),
                            "author": {
                                "sec_uid": row.get("author_sec_uid"),
                                "nickname": row.get("author_name"),
                            },
                        }
                    if item.get("aweme_id") and item["aweme_id"] not in existing_ids:
                        existing_ids.add(item["aweme_id"])
                        # 记录原始 aweme_type，便于最终按类型落库并保持 favorite_order
                        item["_aweme_type"] = row.get("aweme_type") or "collect"
                        all_items.append(item)
            except Exception as exc:
                logging.warning("SyncService 从数据库加载收藏作品失败: %s", exc)

        emit("sync_start", kind="favorites", cached_collections=len(collections), cached_items=len(all_items), limit=limit, collection_limit=collection_limit, sub_kind=sub_kind)

        favorite_videos: List[dict] = list(cache.get("favorite_videos", []))
        music_items: List[dict] = list(cache.get("music_items", []))
        total_added = 0

        async with await self._client() as api:
            if sub_kind in (None, "folders"):
                # 1. 同步收藏夹列表
                cursor = 0
                added_coll = 0
                while len(collections) < collection_limit:
                    resp = await api.get_user_collects("self", max_cursor=cursor, count=20)
                    page_items = [_format_collection(i) for i in resp.get("items", [])]
                    status_code = int(resp.get("status_code") or 0)
                    status_msg = str(resp.get("status_msg") or "")
                    has_more = bool(resp.get("has_more", False))

                    if self._is_login_error(status_code, status_msg):
                        emit("sync_error", kind="favorites", message=f"登录已失效：{status_code} {status_msg}".strip())
                        return cache

                    if not page_items:
                        if status_code not in (0, None) and not collections:
                            emit("sync_error", kind="favorites", message=f"获取收藏夹列表失败：{status_code} {status_msg}".strip())
                            return cache
                        break
                    existing_coll_ids = {c.get("collects_id") for c in collections}
                    for it in page_items:
                        if it["collects_id"] and it["collects_id"] not in existing_coll_ids:
                            existing_coll_ids.add(it["collects_id"])
                            collections.append(it)
                            added_coll += 1
                    emit("sync_progress", kind="favorites_collections", added=added_coll, total=len(collections), status_code=status_code, status_msg=status_msg, has_more=has_more)
                    if not has_more:
                        break
                    next_cursor = int(resp.get("max_cursor", 0) or 0)
                    if next_cursor == cursor:
                        logging.warning("SyncService collects cursor did not advance (%s), stop paging", cursor)
                        break
                    cursor = next_cursor
                    await self.rate_limiter.acquire()

                # 2. 同步每个收藏夹里的视频（默认/未分类收藏夹没有 collects_id，使用 "0"）
                for coll in collections:
                    coll_id = coll.get("collects_id") or "0"
                    coll_name = coll.get("name", "默认")
                    emit("sync_progress", kind="favorites_collection_items", collection=coll_name, collection_id=coll_id)
                    total_added = await self._sync_paged_awemes(
                        api,
                        kind="collect",
                        entity_id=coll_id,
                        entity_name=coll_name,
                        fetch_fn=lambda cursor, cid=coll_id: api.get_collect_aweme(cid, max_cursor=cursor, count=20),
                        existing_ids=existing_ids,
                        all_items=all_items,
                        total_added=total_added,
                        limit=limit,
                        aweme_type="collect",
                    )
                    await self.rate_limiter.acquire()

            if sub_kind in (None, "videos"):
                # 3. 同步「收藏 → 视频」默认收藏视频列表（与收藏夹数据相互独立）
                favorite_videos = await self._sync_favorite_videos(api, limit)

            if sub_kind in (None, "mixes"):
                # 4. 同步我收藏的合集
                cm_cursor = 0
                added_mix = 0
                while len(collect_mixes) < collection_limit:
                    resp = await api.get_user_collect_mix("self", max_cursor=cm_cursor, count=20)
                    page_items = [_format_collect_mix(i) for i in resp.get("items", [])]
                    status_code = int(resp.get("status_code") or 0)
                    status_msg = str(resp.get("status_msg") or "")
                    has_more = bool(resp.get("has_more", False))

                    if self._is_login_error(status_code, status_msg):
                        emit("sync_error", kind="favorites", message=f"登录已失效：{status_code} {status_msg}".strip())
                        return cache

                    if not page_items:
                        if status_code not in (0, None) and not collect_mixes:
                            emit("sync_error", kind="favorites", message=f"获取合集列表失败：{status_code} {status_msg}".strip())
                            return cache
                        break
                    existing_mix_ids = {m.get("mix_id") for m in collect_mixes}
                    for it in page_items:
                        if it["mix_id"] and it["mix_id"] not in existing_mix_ids:
                            existing_mix_ids.add(it["mix_id"])
                            collect_mixes.append(it)
                            added_mix += 1
                    emit("sync_progress", kind="collect_mixes", added=added_mix, total=len(collect_mixes), status_code=status_code, status_msg=status_msg, has_more=has_more)
                    if not has_more:
                        break
                    next_cursor = int(resp.get("max_cursor", 0) or 0)
                    if next_cursor == cm_cursor:
                        logging.warning("SyncService collect_mix cursor did not advance (%s), stop paging", cm_cursor)
                        break
                    cm_cursor = next_cursor
                    await self.rate_limiter.acquire()

                # 5. 同步收藏合集里的视频
                for mix in collect_mixes:
                    mix_id = mix.get("mix_id")
                    if not mix_id:
                        continue
                    mix_name = mix.get("name", "未命名合集")
                    emit("sync_progress", kind="collect_mix_items", collection=mix_name, collection_id=mix_id)
                    total_added = await self._sync_paged_awemes(
                        api,
                        kind="collectmix",
                        entity_id=mix_id,
                        entity_name=mix_name,
                        fetch_fn=lambda cursor, mid=mix_id: api.get_mix_aweme(mid, cursor=cursor, count=20),
                        existing_ids=existing_ids,
                        all_items=all_items,
                        total_added=total_added,
                        limit=limit,
                        aweme_type="collectmix",
                    )
                    await self.rate_limiter.acquire()

            if sub_kind in (None, "music"):
                # 6. 同步收藏音乐
                music_items = await self._sync_favorites_music(api, music_limit)

        # 收藏夹内视频按接口返回顺序保留了「最新收藏在前」的相对顺序，
        # 统一为收藏夹作品和默认收藏视频附加 favorite_order 用于前端排序。
        for idx, it in enumerate(all_items[:limit]):
            it["favorite_order"] = idx

        # 将收藏夹/合集作品按原始 aweme_type 分组，带最终 favorite_order 落库，
        # 保证数据库回填时排序一致且不改变作品类型。
        if all_items[:limit]:
            collect_items = [it for it in all_items[:limit] if it.get("_aweme_type") == "collect"]
            collectmix_items = [it for it in all_items[:limit] if it.get("_aweme_type") == "collectmix"]
            if collect_items:
                await self._upsert_awemes_to_db(collect_items, "collect")
            if collectmix_items:
                await self._upsert_awemes_to_db(collectmix_items, "collectmix")

        # 清理内部字段，避免进入 JSON 缓存。
        for it in all_items[:limit]:
            it.pop("_aweme_type", None)

        cache.update({
            "collections": collections[:collection_limit],
            "collect_mixes": collect_mixes[:collection_limit],
            "items": all_items[:limit],
            "favorite_videos": favorite_videos,
            "music_items": music_items,
            "updated_at": _now(),
            "count": len(all_items[:limit]),
        })
        _save_cache(cache_path, cache)
        invalid_count = sum(
            1
            for it in (all_items[:limit] + favorite_videos)
            if it.get("is_invalid")
        )
        emit("sync_done", kind="favorites", total=len(all_items[:limit]), favorite_videos=len(favorite_videos), collections=len(collections[:collection_limit]), music=len(music_items), invalid=invalid_count)
        return cache

    async def _resolve_topic_query(self, query: str, api: DouyinAPIClient) -> Optional[str]:
        """解析话题 query，支持数字 ID、话题长链接、抖音短链接、搜索话题链接。"""
        ch_id = _resolve_topic_id(query)
        if ch_id:
            return ch_id
        # 抖音短链，通过跟随重定向拿到最终 URL 再解析
        if re.search(r"https?://v\.douyin\.com/\w+", query):
            try:
                import aiohttp
                session = await api.get_session()
                async with session.get(
                    query,
                    allow_redirects=True,
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    final_url = str(resp.url)
                    ch_id = _resolve_topic_id(final_url)
                    if ch_id:
                        return ch_id
                    # 短链也可能重定向到搜索话题页
                    topic_name = _extract_search_topic_name(final_url)
                    if topic_name:
                        return await self._search_topic_by_name(topic_name, api)
            except Exception as exc:
                logging.warning("解析抖音短链失败 %s: %s", query, exc)
        # 抖音搜索话题链接，通过话题名搜索获取 challenge ID
        topic_name = _extract_search_topic_name(query)
        if topic_name:
            return await self._search_topic_by_name(topic_name, api)
        return None

    async def _search_topic_by_name(self, name: str, api: DouyinAPIClient) -> Optional[str]:
        """通过话题名搜索作品，从结果中匹配同名话题的 hashtag_id/ch_id。"""
        if not name:
            return None
        try:
            result = await api.search_aweme_stream(name, offset=0, count=10)
        except Exception as exc:
            logging.warning("搜索话题名失败 %s: %s", name, exc)
            return None
        items = result.get("items") or []
        name_lower = name.lower()
        for item in items:
            if not isinstance(item, dict):
                continue
            # 优先从 text_extra 中匹配 hashtag
            for te in item.get("text_extra") or []:
                if not isinstance(te, dict):
                    continue
                te_name = te.get("hashtag_name") or te.get("hash_tag_name") or ""
                if te_name.lower() == name_lower:
                    topic_id = te.get("hashtag_id") or te.get("hash_tag_id")
                    if topic_id:
                        return str(topic_id)
            # 回退到 challenges 字段
            chs = item.get("challenges") or item.get("challenge") or []
            if isinstance(chs, dict):
                chs = [chs]
            if not isinstance(chs, list):
                continue
            for ch in chs:
                if not isinstance(ch, dict):
                    continue
                ch_name = ch.get("cha_name") or ch.get("challenge_name") or ""
                if ch_name.lower() == name_lower:
                    return str(ch.get("cid") or ch.get("ch_id") or "")
        return None

    async def sync_topics(
        self,
        query: str,
        limit: int = 200,
        sort_strategy: str = "default",
    ) -> dict:
        """同步指定话题下的视频列表。

        query 可以是：
        - 话题数字 ID（ch_id）
        - 抖音话题链接，如 https://www.douyin.com/hashtag/123456
        - 抖音短链接，如 https://v.douyin.com/xxxxx
        - 抖音搜索话题链接，如 https://www.douyin.com/search/%23话题名?type=general

        sort_strategy 支持：
        - default: 抖音推荐顺序
        - random: 从候选池中随机打乱
        - latest: 按发布时间从新到旧
        - oldest: 按发布时间从旧到新
        - hottest: 按点赞数从高到低
        - auto: 每次随机选择一种策略

        结果缓存到 topics.json，结构包含 topic 元信息和 items 视频列表。
        """
        import random

        cache_path = self._cache_path("topics")
        cache = _load_cache(cache_path)

        async with await self._client() as api:
            ch_id = await self._resolve_topic_query(query, api)
            if not ch_id:
                emit("sync_error", kind="topics", message="无法识别话题 ID，请输入数字 ID 或抖音话题链接")
                return cache

            # 读取旧缓存中的同话题数据，用于去重和增量同步
            existing_topic = cache.get("topic") or {}
            existing_items: List[dict] = list(cache.get("items", []))
            existing_ids = {i.get("aweme_id") for i in existing_items if i.get("aweme_id")}
            if existing_topic.get("ch_id") != ch_id:
                existing_items = []
                existing_ids = set()

            # 非默认策略需要重新组织数据，不使用旧缓存
            if sort_strategy != "default":
                existing_items = []
                existing_ids = set()

            # auto 策略：随机选择一种具体策略
            applied_strategy = sort_strategy
            if sort_strategy == "auto":
                applied_strategy = random.choice(["default", "random", "latest", "oldest", "hottest"])

            emit("sync_start", kind="topics", query=query, ch_id=ch_id, cached=len(existing_items), limit=limit, strategy=applied_strategy)

            topic_info = await api.get_challenge_detail(ch_id)
            if not topic_info:
                emit("sync_error", kind="topics", message=f"未找到话题（{query}），请检查 ID 或链接是否正确")
                return cache

            topic = _format_topic(topic_info)
            topic["query"] = query
            emit("sync_progress", kind="topics", step="resolve", topic=topic, total=0)

            items: List[dict] = list(existing_items)
            added = 0
            cursor = 0
            page = 0
            pending_db_items: List[dict] = []

            # 非默认策略需要更大的候选池，以便排序/随机后有足够选择
            target_count = limit
            if applied_strategy != "default":
                target_count = max(limit, min(limit * 2, 300))
                if limit < 50:
                    target_count = max(100, limit)

            while len(items) < target_count:
                page += 1
                resp = await api.get_challenge_aweme(ch_id, cursor=cursor, count=20)
                status_code = int(resp.get("status_code") or 0)
                status_msg = str(resp.get("status_msg") or "")
                has_more = bool(resp.get("has_more", False))
                page_items = [_format_aweme(i) for i in resp.get("items", []) if _extract_aweme(i)]

                emit(
                    "sync_progress",
                    kind="topics",
                    step="fetch",
                    added=added,
                    total=len(items) + len(page_items),
                    page=page,
                    page_size=len(page_items),
                    status_code=status_code,
                    status_msg=status_msg,
                    has_more=has_more,
                    topic=topic,
                )

                if self._is_login_error(status_code, status_msg):
                    emit("sync_error", kind="topics", message=f"登录已失效：{status_code} {status_msg}".strip())
                    break

                if not page_items:
                    if status_code not in (0, None) and not items:
                        emit("sync_error", kind="topics", message=f"获取话题视频失败：{status_code} {status_msg}".strip())
                    break

                new_items: List[dict] = []
                for it in page_items:
                    if it["aweme_id"] and it["aweme_id"] not in existing_ids:
                        existing_ids.add(it["aweme_id"])
                        new_items.append(it)
                        pending_db_items.append(it)
                        added += 1

                # 新视频放在列表最前面，保持“最新在前”
                items = new_items + items

                if len(pending_db_items) >= 100:
                    await self._upsert_awemes_to_db(pending_db_items, "topic")
                    pending_db_items = []

                if not has_more:
                    break
                next_cursor = int(resp.get("max_cursor", 0) or 0)
                if next_cursor == cursor:
                    logging.warning("SyncService topics cursor did not advance (%s), stop paging", cursor)
                    break
                cursor = next_cursor
                await self.rate_limiter.acquire()

            if pending_db_items:
                await self._upsert_awemes_to_db(pending_db_items, "topic")

            # 应用排序/随机策略
            if applied_strategy == "random":
                random.shuffle(items)
            elif applied_strategy == "latest":
                items.sort(key=lambda x: int(x.get("create_time") or 0), reverse=True)
            elif applied_strategy == "oldest":
                items.sort(key=lambda x: int(x.get("create_time") or 0))
            elif applied_strategy == "hottest":
                items.sort(key=lambda x: int(x.get("digg_count") or 0), reverse=True)

            cache.update({
                "topic": topic,
                "items": items[:limit],
                "updated_at": _now(),
                "count": len(items[:limit]),
                "strategy": applied_strategy,
                "target_count": target_count,
            })
            _save_cache(cache_path, cache)
            emit("sync_done", kind="topics", total=len(items[:limit]), added=added, topic=topic, strategy=applied_strategy)
            return cache

    async def sync_following(self, limit: int = 2000) -> dict:
        cache_path = self._cache_path("following")
        cache = _load_cache(cache_path)
        items: List[dict] = list(cache.get("items", []))
        items_index: Dict[str, dict] = {i.get("sec_uid"): i for i in items if i.get("sec_uid")}

        # 数据库初始化，用于持久化关注列表
        await self._init_database()

        # 如果 JSON 缓存为空但数据库有历史数据，先回填到缓存，避免重复拉取
        if not items and self.database:
            try:
                db_page = await self.database.get_following_list(page=1, size=100_000)
                db_items = [_format_user(u) for u in db_page.get("items", [])]
                items = db_items
                items_index = {i.get("sec_uid"): i for i in items if i.get("sec_uid")}
            except Exception as exc:
                logging.warning("SyncService 从数据库加载关注列表失败: %s", exc)

        emit("sync_start", kind="following", cached=len(items), limit=limit)

        async with await self._client() as api:
            self_info = await api.get_self_info()
            sec_uid = (self_info or {}).get("sec_uid")
            if not sec_uid:
                emit("sync_error", kind="following", message="无法获取当前登录用户信息，请检查 Cookie")
                return cache

            # 读取断点游标：大于 0 表示上次同步被中断，从该位置继续；否则从 newest 开始全量同步
            max_time = await self._get_cursor("following", sec_uid)
            added = 0
            page = 0
            drained = False
            last_max_time = max_time
            seen_sec_uids: Set[str] = set()

            # follow_order 越小代表越新；已缓存/数据库中的记录延续已有序号，新记录递增。
            # 全量重新同步（max_time == 0）时，必须按 API 返回流重新编号，否则新关注会排到末尾。
            if max_time == 0:
                for it in items:
                    it["follow_order"] = None
                if self.database:
                    try:
                        await self.database.reset_following_follow_order()
                    except Exception as exc:
                        logging.warning("SyncService 重置关注顺序失败: %s", exc)

            existing_orders = [i.get("follow_order") for i in items if i.get("follow_order") is not None]
            next_order = max(existing_orders, default=-1) + 1

            # 批量写入数据库的缓冲；按 100 条批量 flush，减少 IO
            pending_db_items: List[dict] = []
            DB_BATCH_SIZE = 100

            while len(items) < limit:
                page += 1
                resp = await api.get_following_page(sec_uid, max_time=max_time, count=20)
                raw_items = resp.get("items", [])
                has_more = bool(resp.get("has_more", False))
                status_code = int(resp.get("status_code") or 0)
                status_msg = str(resp.get("status_msg") or "")
                next_min_time = int(resp.get("min_time") or 0)

                # 使用 FollowingUser.from_api 统一处理嵌套/扁平字段，减少漏数据
                page_items = []
                for raw in raw_items:
                    if not isinstance(raw, dict):
                        continue
                    user = FollowingUser.from_api(raw)
                    if not user.sec_uid:
                        continue
                    page_items.append(_format_user(user.to_dict()))

                new_items: List[dict] = []
                for it in page_items:
                    sec = it["sec_uid"]
                    seen_sec_uids.add(sec)
                    # 每个在 API 返回流中的位置都对应一个全局 follow_order；
                    # 重复出现时保留更小的序号（更靠前 = 更新关注）。
                    order = next_order
                    next_order += 1
                    if sec not in items_index:
                        it["follow_order"] = order
                        items_index[sec] = it
                        items.append(it)
                        added += 1
                        new_items.append(it)
                    else:
                        existing = items_index[sec]
                        old_order = existing.get("follow_order")
                        if old_order is None or order < old_order:
                            existing["follow_order"] = order
                        # 把最终 follow_order 同步回当前 it，确保 pending_db_items 写入数据库时携带正确序号
                        it["follow_order"] = existing.get("follow_order")
                        # 合并作品数，避免 video_count（仅视频数）覆盖已确认的总作品数
                        _merge_aweme_count(existing, it)
                        # 用最新接口数据刷新已有记录（头像、昵称、签名、粉丝数等）
                        existing.update({k: v for k, v in it.items() if k != "follow_order"})

                pending_db_items.extend(page_items)
                if len(pending_db_items) >= DB_BATCH_SIZE:
                    if self.database:
                        try:
                            await self.database.upsert_following_batch(pending_db_items)
                        except Exception as exc:
                            logging.warning("SyncService 批量保存关注用户失败: %s", exc)
                    pending_db_items = []

                # 进度事件在写入后发出，total 为当前已去重数量
                emit(
                    "sync_progress",
                    kind="following",
                    added=added,
                    total=len(items),
                    page=page,
                    page_size=len(page_items),
                    status_code=status_code,
                    status_msg=status_msg,
                    has_more=has_more,
                )

                if status_code != 0 and not items and not page_items:
                    emit("sync_error", kind="following", message=f"获取关注列表失败：{status_code} {status_msg}".strip())
                    return cache

                if not has_more:
                    drained = True
                    break

                # 处理抖音返回空页但声称还有下一页的卡住情况
                if not raw_items and next_min_time > 0 and next_min_time != max_time:
                    max_time = next_min_time
                    last_max_time = max_time
                    await asyncio.sleep(1.2)
                    continue

                if next_min_time <= 0 or next_min_time == max_time:
                    break
                max_time = next_min_time
                last_max_time = max_time

                # 关注列表接口风控较严，分页间加短暂延迟；前 3 页快一些，后面更保守
                delay = 0.4 if page <= 3 else 0.8
                await asyncio.sleep(delay)

            if pending_db_items and self.database:
                try:
                    await self.database.upsert_following_batch(pending_db_items)
                except Exception as exc:
                    logging.warning("SyncService 批量保存关注用户失败: %s", exc)
                pending_db_items = []

            # 关注列表接口返回的作品数偶尔为 0，用用户主页接口补全
            await self._enrich_following_aweme_count(api, items_index)

        # 只有在完整跑完所有页时，才清理本地已不在关注列表中的记录
        if drained:
            stale_removed = 0
            if self.database:
                try:
                    stale_removed = await self.database.delete_following_not_in(list(seen_sec_uids))
                except Exception as exc:
                    logging.warning("SyncService 清理已取关用户失败: %s", exc)
            if stale_removed > 0:
                items = [it for it in items if it.get("sec_uid") in seen_sec_uids]
                items_index = {it.get("sec_uid"): it for it in items if it.get("sec_uid")}
                emit("sync_progress", kind="following", removed=stale_removed, total=len(items))

        # 缓存按关注顺序从新到旧排列（follow_order 越小代表越新关注）
        items.sort(key=lambda x: x.get("follow_order") if x.get("follow_order") is not None else float("inf"))
        cache.update({"items": items[:limit], "updated_at": _now(), "count": len(items[:limit])})
        _save_cache(cache_path, cache)

        # 先发送完成事件，再保存 cursor；避免 cursor 写入异常导致 UI 一直显示同步中
        emit("sync_done", kind="following", total=len(items[:limit]), added=added, drained=drained)

        # 同步完成则重置游标，下次从 newest 开始；未完成（中断/限流/达到上限）则保存断点便于续传
        if drained:
            await self._set_cursor("following", sec_uid, 0)
        elif last_max_time > 0:
            await self._set_cursor("following", sec_uid, last_max_time)

        return cache


async def run_job(job: dict):
    kind = job.get("kind", "favorites")
    sub_kind = job.get("subKind") or None
    emit("sync_init", kind=kind, sub_kind=sub_kind)

    config = ConfigLoader(None)
    config.config.update(job.get("config", {}))
    service = SyncService(config, job.get("cookies", {}), cookie_file=job.get("cookieFile"))
    await service._init_database()

    limits = job.get("limits", {})
    try:
        if kind == "favorites" and sub_kind == "topics":
            query = str(job.get("query") or "").strip()
            if not query:
                emit("sync_error", kind="topics", message="缺少话题 query 参数")
                raise ValueError("topics sync requires query")
            await service.sync_topics(
                query=query,
                limit=int(limits.get("topics", 200)),
                sort_strategy=str(limits.get("topicsSortStrategy", "default")),
            )
        elif kind == "favorites":
            await service.sync_favorites(
                limit=int(limits.get("favorites", 1000)),
                collection_limit=int(limits.get("collections", 200)),
                music_limit=int(limits.get("favoritesMusic", 1000)),
                sub_kind=sub_kind,
            )
        elif kind == "likes":
            await service.sync_likes(limit=int(limits.get("likes", 1000)))
        elif kind == "following":
            await service.sync_following(limit=int(limits.get("following", 2000)))
        elif kind == "topics":
            query = str(job.get("query") or "").strip()
            if not query:
                emit("sync_error", kind="topics", message="缺少话题 query 参数")
                raise ValueError("topics sync requires query")
            await service.sync_topics(
                query=query,
                limit=int(limits.get("topics", 200)),
                sort_strategy=str(limits.get("topicsSortStrategy", "default")),
            )
        else:
            emit("sync_error", message=f"未知同步类型: {kind}")
            raise ValueError(f"未知同步类型: {kind}")
    except Exception as exc:
        logging.exception("同步失败")
        emit("sync_error", message=str(exc))
        raise
    finally:
        if service.database:
            try:
                await service.database.close()
            except Exception:
                pass
            # aiosqlite 后台工作线程需要一点时间才能完全退出；
            # 若 event loop 在其之前关闭，会抛出 "Event loop is closed" 异常。
            await asyncio.sleep(0.2)


def _now() -> str:
    from datetime import datetime
    return datetime.now().isoformat(timespec="seconds")


def _debug_log(msg: str):
    try:
        sys.stderr.write(f"[DEBUG] {_now()} {msg}\n")
        sys.stderr.flush()
    except Exception:
        pass


def _redirect_to_files(stdout_log: Optional[str], stderr_log: Optional[str]):
    """将 stdout/stderr 重定向到指定日志文件，避免依赖 Electron 的 stdio 事件。"""
    if stdout_log:
        try:
            Path(stdout_log).parent.mkdir(parents=True, exist_ok=True)
            sys.stdout = open(stdout_log, "w", encoding="utf-8", buffering=1)
        except Exception as exc:
            _debug_log(f"redirect stdout failed: {exc}")
    if stderr_log:
        try:
            Path(stderr_log).parent.mkdir(parents=True, exist_ok=True)
            sys.stderr = open(stderr_log, "w", encoding="utf-8", buffering=1)
        except Exception as exc:
            _debug_log(f"redirect stderr failed: {exc}")


def main():
    _debug_log("main() entered")
    parser = argparse.ArgumentParser()
    parser.add_argument("--sync-job", help="JSON 同步任务文件路径")
    parser.add_argument("--stdout-log", help="stdout 重定向目标日志文件")
    parser.add_argument("--stderr-log", help="stderr 重定向目标日志文件")
    args = parser.parse_args()
    _debug_log(f"args: {args}")

    # 尽早重定向，确保后续所有进度/错误输出都进入 Electron 可轮询的日志文件。
    _redirect_to_files(args.stdout_log, args.stderr_log)

    if args.sync_job:
        try:
            job = json.loads(Path(args.sync_job).read_text(encoding="utf-8"))
            _debug_log(f"job loaded: kind={job.get('kind')}")
        except Exception as exc:
            _debug_log(f"job load failed: {exc}")
            raise
    else:
        job = json.loads(sys.stdin.read())

    exit_code = 0
    try:
        asyncio.run(run_job(job))
    except Exception as exc:
        logging.exception("同步任务异常退出")
        emit("sync_error", message=f"同步异常：{exc}")
        exit_code = 1
    finally:
        _debug_log(f"exiting with code={exit_code}")
        try:
            sys.stdout.flush()
        except Exception:
            pass
        try:
            sys.stderr.flush()
        except Exception:
            pass
        # 先尝试正常退出；若 aiosqlite 后台线程仍卡住，由 Electron 3 分钟 stall 保护强制终止。
        sys.exit(exit_code)


if __name__ == "__main__":
    main()
