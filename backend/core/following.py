from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from typing import Any, AsyncGenerator, Dict, List, Optional

from core.api_client import DouyinAPIClient
from storage.database import Database
from utils.logger import setup_logger

logger = setup_logger("FollowingService")


def _extract_follow_time(target: Dict[str, Any]) -> int:
    """从关注列表条目中提取关注时间（秒级时间戳）。

    抖音 Web API 返回的关注时间可能位于 ``follow_time``、``create_time``、
    ``follow_time_stamp`` 等字段，且可能是秒/毫秒时间戳或字符串。
    这里优先尝试明确的关注时间字段，再回退到通用字段。
    """
    for key in ("follow_time", "create_time", "follow_time_stamp"):
        value = target.get(key)
        if isinstance(value, (int, float)):
            ts = int(value)
            # 毫秒时间戳转换为秒
            return ts // 1000 if ts > 1_000_000_000_000 else ts
        if isinstance(value, str):
            value = value.strip()
            if not value:
                continue
            # 先尝试纯数字时间戳
            try:
                ts = int(value)
                return ts // 1000 if ts > 1_000_000_000_000 else ts
            except ValueError:
                pass
            # 再尝试常见日期字符串格式
            for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
                try:
                    return int(time.mktime(time.strptime(value, fmt)))
                except ValueError:
                    continue
    return 0


@dataclass
class FollowingUser:
    """A followed user extracted from Douyin's following list."""

    sec_uid: str
    nickname: str
    avatar: str
    signature: str
    follower_count: int
    following_count: int = 0
    aweme_count: int = 0
    unique_id: str = ""
    create_time: int = 0
    extra: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_api(cls, item: Dict[str, Any]) -> "FollowingUser":
        """Build a FollowingUser from a raw following-list item.

        Douyin returns user info either flat on the item or nested under
        ``user`` / ``author``. We try the common shapes so callers don't
        need to pre-normalize the payload.
        """
        user = item if isinstance(item, dict) else {}

        # Some endpoints wrap the user under a "user" key.
        nested = user.get("user") or {}
        if not isinstance(nested, dict):
            nested = {}
        target = nested if nested.get("sec_uid") else user

        avatar_url = ""
        for avatar_key in (
            "avatar_larger",
            "avatar_thumb",
            "avatar_medium",
            "avatar_168x168",
            "avatar_300x300",
            "avatar",
        ):
            avatar = target.get(avatar_key)
            if isinstance(avatar, dict):
                urls = avatar.get("url_list") or []
                if urls:
                    avatar_url = urls[0]
                    break
            elif isinstance(avatar, str) and avatar:
                avatar_url = avatar
                break

        stats = target.get("stats") or target.get("user_stats") or {}
        if not isinstance(stats, dict):
            stats = {}

        follower_count = int(
            stats.get("follower_count")
            or stats.get("mplatform_followers_count")
            or target.get("follower_count")
            or target.get("mplatform_followers_count")
            or 0
        )
        following_count = int(
            stats.get("following_count") or target.get("following_count") or 0
        )
        raw_aweme_count = stats.get("aweme_count") or target.get("aweme_count")
        raw_video_count = stats.get("video_count") or target.get("video_count")
        aweme_count = int(raw_aweme_count or 0)
        video_count = int(raw_video_count or 0)
        # 关注列表接口有时会只返回 video_count（仅视频数），把 aweme_count 回落成
        # video_count 会导致前端把视频数当成全部作品数。这里把两个值分开保存，
        # 并在 extra 里标记来源，便于后续用主页接口补全真实的总作品数。
        extra = {
            "video_count": video_count,
            "aweme_count_source": "aweme_count" if raw_aweme_count else ("video_count" if raw_video_count else "unknown"),
        }

        create_time = _extract_follow_time(user)
        if create_time == 0:
            create_time = _extract_follow_time(nested)

        return cls(
            sec_uid=target.get("sec_uid", ""),
            nickname=target.get("nickname", ""),
            avatar=avatar_url,
            signature=target.get("signature", ""),
            follower_count=follower_count,
            following_count=following_count,
            aweme_count=aweme_count,
            unique_id=target.get("unique_id", ""),
            create_time=create_time,
            extra=extra,
        )


class FollowingService:
    """Sync the logged-in Douyin account's full following list.

    The service uses time-based pagination (``max_time`` / ``min_time``)
    exposed by ``DouyinAPIClient.get_following_page``. It can stream users
    one-by-one via ``iter_following`` or persist the whole list to the
    SQLite ``Database`` via ``sync_following``.
    """

    DEFAULT_PAGE_SIZE = 20
    DEFAULT_LIMIT = 2000

    def __init__(
        self,
        api_client: DouyinAPIClient,
        database: Optional[Database] = None,
        *,
        page_size: int = DEFAULT_PAGE_SIZE,
    ):
        self.api = api_client
        self.db = database
        self.page_size = min(max(int(page_size or self.DEFAULT_PAGE_SIZE), 1), 20)

    async def _resolve_self_sec_uid(self) -> Optional[str]:
        """Fetch the current user's sec_uid via ``get_self_info``."""
        info = await self.api.get_self_info()
        if not isinstance(info, dict):
            return None
        sec_uid = info.get("sec_uid")
        if not sec_uid:
            sec_uid = info.get("uid")
        return sec_uid

    async def iter_following(
        self,
        *,
        sec_uid: Optional[str] = None,
        max_time: int = 0,
        limit: Optional[int] = None,
    ) -> AsyncGenerator[FollowingUser, None]:
        """Yield followed users lazily, page by page.

        Args:
            sec_uid: Target account. Defaults to the logged-in user.
            max_time: Pagination cursor (0 means the first page).
            limit: Optional hard cap on the number of users yielded.
        """
        target_sec_uid = sec_uid
        if target_sec_uid is None:
            target_sec_uid = await self._resolve_self_sec_uid()
        if not target_sec_uid:
            raise RuntimeError("无法获取当前登录用户信息，请检查 Cookie")

        current_max_time = int(max_time or 0)
        yielded = 0
        effective_limit = None
        if limit is not None:
            effective_limit = max(int(limit), 0)
            if effective_limit == 0:
                return

        while True:
            resp = await self.api.get_following_page(
                target_sec_uid,
                max_time=current_max_time,
                count=self.page_size,
            )
            items = resp.get("items") or []
            has_more = bool(resp.get("has_more", False))
            min_time = int(resp.get("min_time") or 0)

            if not items:
                logger.debug(
                    "following page empty: max_time=%s has_more=%s",
                    current_max_time,
                    has_more,
                )
                if not has_more:
                    break
                # Guard against a stuck cursor: if the page is empty but
                # Douyin claims there is more, advance the cursor anyway.
                if min_time > 0 and min_time != current_max_time:
                    current_max_time = min_time
                    continue
                break

            for raw in items:
                if not isinstance(raw, dict):
                    continue
                user = FollowingUser.from_api(raw)
                if not user.sec_uid:
                    continue
                yield user
                yielded += 1
                if effective_limit is not None and yielded >= effective_limit:
                    return

            if not has_more:
                break
            if min_time <= 0 or min_time == current_max_time:
                break
            current_max_time = min_time

    async def sync_following(
        self,
        *,
        sec_uid: Optional[str] = None,
        max_time: int = 0,
        limit: Optional[int] = None,
        batch_size: int = 100,
    ) -> Dict[str, Any]:
        """Pull the full following list and persist to SQLite.

        Args:
            sec_uid: Target account. Defaults to the logged-in user.
            max_time: Starting pagination cursor.
            limit: Optional cap on the number of users to sync.
            batch_size: Number of users to buffer before a DB write.

        Returns:
            A summary dict with ``total``, ``added``, ``updated``,
            ``cached`` (previous count) and ``limit``.
        """
        if self.db is None:
            raise RuntimeError("未提供 Database 实例，无法持久化关注列表")

        cached = await self.db.get_following_count()
        total = 0
        added = 0
        updated = 0
        buffer: List[Dict[str, Any]] = []

        async def _flush() -> None:
            nonlocal added, updated
            if not buffer:
                return
            existing: Dict[str, bool] = {}
            for user_data in buffer:
                sec = user_data.get("sec_uid")
                if sec:
                    existing[sec] = await self.db.is_following_exists(sec)
            await self.db.upsert_following_batch(buffer)
            for user_data in buffer:
                sec = user_data.get("sec_uid")
                if existing.get(sec):
                    updated += 1
                else:
                    added += 1
            buffer.clear()

        try:
            async for user in self.iter_following(
                sec_uid=sec_uid,
                max_time=max_time,
                limit=limit,
            ):
                user_dict = user.to_dict()
                # 抖音 Web 接口没有返回精确的关注时间戳，create_time 实际是账号/作品时间，
                # 不能当作关注时间展示，统一置 0 避免误导。
                user_dict["create_time"] = 0
                buffer.append(user_dict)
                total += 1
                if len(buffer) >= batch_size:
                    await _flush()
            await _flush()
        except Exception:
            await _flush()
            raise

        return {
            "total": total,
            "added": added,
            "updated": updated,
            "cached": cached,
            "limit": limit,
        }

    async def get_following_count(self) -> int:
        """Return the number of persisted followed users."""
        if self.db is None:
            return 0
        return await self.db.get_following_count()

    async def get_following_list(
        self,
        *,
        page: int = 1,
        size: int = 50,
        search: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Return paginated persisted followed users."""
        if self.db is None:
            return {"total": 0, "page": page, "size": size, "items": []}
        return await self.db.get_following_list(page=page, size=size, search=search)

    async def export_to_json(self, path: str) -> Dict[str, Any]:
        """Export all persisted following users to a JSON file."""
        result = await self.get_following_list(page=1, size=100_000)
        items = result.get("items", [])
        from pathlib import Path

        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"path": str(target), "count": len(items)}
