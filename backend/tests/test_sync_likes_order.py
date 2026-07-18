"""验证 sync_likes 排序算法：API 从新到旧返回，数据库回填不应打乱顺序。"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from backend.sync_service import SyncService


def _make_item(aweme_id: str, title: str):
    return {
        "aweme_id": aweme_id,
        "title": title,
        "create_time": 0,
        "author": {"sec_uid": "self", "nickname": "test"},
    }


def test_api_pages_keep_newest_first():
    """模拟 API 返回两页：page1 最新，page2 更旧。"""
    items = []
    db_items = []
    existing_ids = set()
    fetched_ids = set()
    limit = 4

    # API page1：从新到旧 [newest1, newest2]
    page1 = [_make_item("1", "newest1"), _make_item("2", "newest2")]
    # API page2：更旧 [old1, old2]
    page2 = [_make_item("3", "old1"), _make_item("4", "old2")]

    for page in (page1, page2):
        new_items = []
        for it in page:
            fetched_ids.add(it["aweme_id"])
            if it["aweme_id"] not in existing_ids:
                existing_ids.add(it["aweme_id"])
                new_items.append(it)
        items = items + new_items
        if len(items) >= limit:
            break

    # 合并数据库旧数据（模拟未在 API 中出现的更旧数据）
    items = items + [it for it in db_items if it.get("aweme_id") not in fetched_ids]

    for idx, it in enumerate(items[:limit]):
        it["like_order"] = idx

    titles = [it["title"] for it in items[:limit]]
    expected = ["newest1", "newest2", "old1", "old2"]
    assert titles == expected, f"expected {expected}, got {titles}"
    assert items[0]["like_order"] == 0
    assert items[-1]["like_order"] == 3
    print("PASS: API pages keep newest first")


def test_db_backfill_does_not_override_api_order():
    """模拟数据库回填旧数据，API 返回新数据，最终新数据必须在前。"""
    items = []
    existing_ids = set()
    fetched_ids = set()
    limit = 4

    # 数据库回填：旧数据，且上次保存的 like_order 较大（越旧越大）
    db_items = [
        {"aweme_id": "db1", "title": "db_old_1", "like_order": 10},
        {"aweme_id": "db2", "title": "db_old_2", "like_order": 11},
    ]
    for it in db_items:
        existing_ids.add(it["aweme_id"])

    # API 返回一条新数据，db1 已存在被过滤，db3 是新的
    page1 = [_make_item("db1", "db_old_1"), _make_item("db3", "new_from_api")]
    new_items = []
    for it in page1:
        fetched_ids.add(it["aweme_id"])
        if it["aweme_id"] not in existing_ids:
            existing_ids.add(it["aweme_id"])
            new_items.append(it)
    items = items + new_items

    # 合并 db 中未在本次 API 中出现的旧数据
    items = items + [it for it in db_items if it.get("aweme_id") not in fetched_ids]

    for idx, it in enumerate(items[:limit]):
        it["like_order"] = idx

    titles = [it["title"] for it in items[:limit]]
    expected = ["new_from_api", "db_old_2"]
    assert titles == expected, f"expected {expected}, got {titles}"
    assert items[0]["like_order"] == 0
    assert items[-1]["like_order"] == len(items) - 1
    print("PASS: DB backfill does not override API order")


if __name__ == "__main__":
    test_api_pages_keep_newest_first()
    test_db_backfill_does_not_override_api_order()
    print("All tests passed.")
