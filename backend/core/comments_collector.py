"""评论采集：针对单个作品拉取全部评论（含递归二级回复），导出为 JSON / CSV。

设计要点：
- 复用 DouyinAPIClient 的分页请求与签名
- 与下载流程解耦：作为独立的 helper，由 BaseDownloader 在保存媒体后按需调用
- 输出位置：与媒体同目录，文件名 `{file_stem}_comments.json` / `{file_stem}_comments.csv`
- 支持上限 max_comments（默认 0 = 不限）和 include_replies
- 楼中楼通过独立 reply_list 接口递归/迭代拉取，统一格式化后挂载到根评论的 _replies
"""

from __future__ import annotations

import asyncio
import csv
import io
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, Iterable, List, Optional, Set

from utils.logger import setup_logger

if TYPE_CHECKING:  # pragma: no cover
    from core.api_client import DouyinAPIClient
    from storage.metadata_handler import MetadataHandler

logger = setup_logger("CommentsCollector")

# CSV 统一字段（顺序即导出列顺序）
_COMMENT_CSV_FIELDS = [
    "aweme_id",
    "comment_id",
    "parent_id",
    "root_id",
    "level",
    "text",
    "create_time",
    "digg_count",
    "reply_count",
    "uid",
    "sec_uid",
    "nickname",
    "unique_id",
    "avatar",
    "signature",
]


def _extract_user_info(user: Any) -> Dict[str, str]:
    """从 user / owner / author 等结构中提取统一用户信息。"""
    if not isinstance(user, dict):
        return {
            "uid": "",
            "sec_uid": "",
            "nickname": "",
            "unique_id": "",
            "avatar": "",
            "signature": "",
        }

    avatar = user.get("avatar_thumb") or user.get("avatar") or user.get("avatar_url")
    avatar_url = ""
    if isinstance(avatar, dict):
        avatar_url = (avatar.get("url_list") or [""])[0]
    elif isinstance(avatar, str):
        avatar_url = avatar

    return {
        "uid": str(user.get("uid") or user.get("user_id") or ""),
        "sec_uid": str(user.get("sec_uid") or ""),
        "nickname": str(user.get("nickname") or user.get("display_name") or ""),
        "unique_id": str(user.get("unique_id") or user.get("short_id") or ""),
        "avatar": avatar_url,
        "signature": str(user.get("signature") or ""),
    }


def _flatten_comment(
    item: Dict[str, Any],
    *,
    aweme_id: str,
    parent_id: str = "",
    root_id: str = "",
    level: int = 0,
) -> Dict[str, Any]:
    """把抖音原始评论对象拍平为统一字段，并保留原始字段在 _raw 中。"""
    cid = str(item.get("cid") or item.get("comment_id") or "")
    text = str(item.get("text") or item.get("content") or "")
    create_time = item.get("create_time") or 0
    digg_count = item.get("digg_count") or 0
    reply_total = item.get("reply_comment_total") or item.get("reply_count") or 0

    # 楼中楼字段：回复给某条评论 / 根评论
    reply_to_cid = str(item.get("reply_comment_id") or item.get("reply_id") or "")
    actual_parent = parent_id or reply_to_cid
    actual_root = root_id or (
        reply_to_cid if level == 0 and reply_to_cid and reply_to_cid != cid else ""
    )

    user_info = _extract_user_info(item.get("user"))

    return {
        "aweme_id": aweme_id,
        "comment_id": cid,
        "parent_id": actual_parent,
        "root_id": actual_root,
        "level": level,
        "text": text,
        "create_time": int(create_time or 0),
        "digg_count": int(digg_count or 0),
        "reply_count": int(reply_total or 0),
        **user_info,
        "_raw": item,
    }


def _flatten_comments_tree(
    comments: Iterable[Dict[str, Any]],
    *,
    aweme_id: str,
    include_replies: bool = True,
) -> List[Dict[str, Any]]:
    """把评论树拍平为一级列表（CSV 用），递归展开 _replies。"""
    rows: List[Dict[str, Any]] = []

    def _walk(items: Iterable[Dict[str, Any]], parent_id: str = "", root_id: str = "", level: int = 0):
        for item in items:
            if not isinstance(item, dict):
                continue
            row = _flatten_comment(
                item,
                aweme_id=aweme_id,
                parent_id=parent_id,
                root_id=root_id,
                level=level,
            )
            rows.append(row)

            replies = []
            if include_replies:
                raw_replies = item.get("_replies")
                if isinstance(raw_replies, list):
                    replies = raw_replies
            if replies:
                _walk(
                    replies,
                    parent_id=row["comment_id"],
                    root_id=root_id or row["comment_id"],
                    level=level + 1,
                )

    _walk(comments)
    return rows


class CommentsCollector:
    def __init__(
        self,
        api_client: "DouyinAPIClient",
        metadata_handler: "MetadataHandler",
        *,
        include_replies: bool = False,
        max_comments: int = 0,
        max_replies_per_comment: int = 0,
        page_size: int = 20,
        reply_page_size: int = 20,
        retry_delay_seconds: float = 1.0,
    ):
        self.api_client = api_client
        self.metadata_handler = metadata_handler
        self.include_replies = include_replies
        self.max_comments = int(max_comments or 0)
        self.max_replies_per_comment = int(max_replies_per_comment or 0)
        self.page_size = max(1, int(page_size or 20))
        self.reply_page_size = max(1, int(reply_page_size or 20))
        self.retry_delay_seconds = float(retry_delay_seconds or 1.0)

    async def collect_and_save(
        self,
        aweme_id: str,
        output_path: Path,
        *,
        formats: Optional[Iterable[str]] = None,
    ) -> Optional[Dict[str, Any]]:
        """抓取评论并写入 output_path，失败时返回 None。

        Args:
            output_path: 输出文件路径。若同时导出多种格式，建议传入 JSON 路径；
                CSV 会自动使用同名 `.csv` 后缀。
            formats: 导出的格式集合，如 {"json"}、{"csv"}、{"json", "csv"}。
                默认仅 JSON（保持向后兼容）。
        """
        comments = await self.collect(aweme_id)
        if comments is None:
            return None

        payload = {
            "aweme_id": aweme_id,
            "count": len(comments),
            "include_replies": self.include_replies,
            "comments": comments,
        }

        formats_set: Set[str] = {"json"}
        if formats is not None:
            formats_set = {str(f).lower().strip() for f in formats if f}
        if not formats_set:
            formats_set = {"json"}

        saved_any = False
        base_path = Path(output_path)

        if "json" in formats_set:
            json_path = base_path.with_suffix(".json") if base_path.suffix else base_path
            saved = await self.metadata_handler.save_metadata(payload, json_path)
            if saved:
                saved_any = True
            else:
                logger.warning("Failed to save comments JSON for %s to %s", aweme_id, json_path)

        if "csv" in formats_set:
            csv_path = base_path.with_suffix(".csv") if base_path.suffix else Path(str(base_path) + ".csv")
            saved = await self.export_csv(comments, csv_path, aweme_id=aweme_id)
            if saved:
                saved_any = True
            else:
                logger.warning("Failed to save comments CSV for %s to %s", aweme_id, csv_path)

        if not saved_any:
            return None
        return payload

    async def collect(self, aweme_id: str) -> Optional[List[Dict[str, Any]]]:
        """抓取评论列表（不写盘），失败返回 None。楼中楼递归拉取在 include_replies=True 时启用。"""
        all_comments: List[Dict[str, Any]] = []
        cursor = 0
        seen_ids: set = set()

        while True:
            try:
                page = await self.api_client.get_aweme_comments(
                    aweme_id,
                    cursor=cursor,
                    count=self.page_size,
                    include_replies=False,  # 自己控制楼中楼，避免重复请求
                )
            except Exception as exc:
                logger.warning(
                    "Comments fetch error for %s cursor=%s: %s",
                    aweme_id,
                    cursor,
                    exc,
                )
                return None

            items = page.get("items") or []
            if not items:
                break

            for item in items:
                if not isinstance(item, dict):
                    continue
                cid = item.get("cid") or item.get("comment_id")
                key = str(cid) if cid else None
                if key and key in seen_ids:
                    continue
                if key:
                    seen_ids.add(key)

                if self.include_replies:
                    reply_total = int(item.get("reply_comment_total") or item.get("reply_count") or 0)
                    if reply_total > 0:
                        try:
                            item["_replies"] = await self._collect_all_replies(
                                aweme_id=aweme_id,
                                comment_id=str(cid),
                            )
                        except Exception as exc:  # noqa: BLE001
                            logger.debug("Fetch replies for comment %s failed: %s", cid, exc)
                            item["_replies"] = []

                all_comments.append(item)
                if 0 < self.max_comments <= len(all_comments):
                    return all_comments[: self.max_comments]

            if not page.get("has_more"):
                break
            next_cursor = page.get("max_cursor") or 0
            if next_cursor == cursor:
                logger.warning(
                    "Comments cursor stuck (aweme=%s, cursor=%s, has_more=True); "
                    "stopping to avoid infinite loop.",
                    aweme_id,
                    cursor,
                )
                break
            cursor = next_cursor
            await asyncio.sleep(self.retry_delay_seconds * 0.1)

        return all_comments

    async def _collect_all_replies(
        self,
        *,
        aweme_id: str,
        comment_id: str,
    ) -> List[Dict[str, Any]]:
        """递归拉取某条评论的全部楼中楼回复。"""
        all_replies: List[Dict[str, Any]] = []
        cursor = 0
        seen_ids: set = set()
        max_pages = 1000  # 安全上限，避免极端情况死循环

        for _ in range(max_pages):
            try:
                page = await self.api_client.get_aweme_comment_replies(
                    aweme_id=aweme_id,
                    comment_id=comment_id,
                    cursor=cursor,
                    count=self.reply_page_size,
                )
            except Exception as exc:
                logger.warning(
                    "Reply fetch error for aweme=%s comment=%s cursor=%s: %s",
                    aweme_id,
                    comment_id,
                    cursor,
                    exc,
                )
                break

            items = page.get("items") or []
            if not items:
                break

            for item in items:
                if not isinstance(item, dict):
                    continue
                rid = item.get("cid") or item.get("comment_id")
                key = str(rid) if rid else None
                if key and key in seen_ids:
                    continue
                if key:
                    seen_ids.add(key)
                all_replies.append(item)

                if (
                    self.include_replies
                    and 0 < self.max_replies_per_comment <= len(all_replies)
                ):
                    return all_replies[: self.max_replies_per_comment]

            if not page.get("has_more"):
                break
            next_cursor = page.get("max_cursor") or 0
            if next_cursor == cursor:
                logger.warning(
                    "Reply cursor stuck (aweme=%s comment=%s, cursor=%s); stopping.",
                    aweme_id,
                    comment_id,
                    cursor,
                )
                break
            cursor = next_cursor
            await asyncio.sleep(self.retry_delay_seconds * 0.05)

        return all_replies

    async def export_json(
        self,
        comments: List[Dict[str, Any]],
        output_path: Path,
        *,
        aweme_id: str = "",
    ) -> bool:
        """把评论列表导出为 JSON。"""
        payload = {
            "aweme_id": aweme_id,
            "count": len(comments),
            "include_replies": self.include_replies,
            "comments": comments,
        }
        return await self.metadata_handler.save_metadata(payload, output_path)

    async def export_csv(
        self,
        comments: List[Dict[str, Any]],
        output_path: Path,
        *,
        aweme_id: str = "",
    ) -> bool:
        """把评论（含楼中楼）拍平导出为 CSV。"""
        rows = _flatten_comments_tree(
            comments,
            aweme_id=aweme_id,
            include_replies=self.include_replies,
        )

        def _write() -> None:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            with io.StringIO(newline="") as buf:
                writer = csv.DictWriter(buf, fieldnames=_COMMENT_CSV_FIELDS, extrasaction="ignore")
                writer.writeheader()
                if rows:
                    writer.writerows(rows)
                output_path.write_text(buf.getvalue(), encoding="utf-8-sig")

        try:
            await asyncio.to_thread(_write)
            return True
        except Exception as exc:
            logger.error("Failed to export comments CSV: %s, error: %s", output_path, exc)
            return False

    @staticmethod
    def normalize_comment_row(item: Dict[str, Any], aweme_id: str = "") -> Dict[str, Any]:
        """把原始评论对象转换为统一行格式（供外部调用方使用）。"""
        return _flatten_comment(item, aweme_id=aweme_id)
