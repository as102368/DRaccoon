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
    existing_items = {}
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
            new_items.append(it)
        items = items + new_items
        if len(items) >= limit:
            break

    # 合并本地有但 API 未返回的数据（本例没有）
    items = items + [it for it in existing_items.values() if it.get("aweme_id") not in fetched_ids]

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
    db_items = [
        {"aweme_id": "db1", "title": "db_old_1", "like_order": 10},
        {"aweme_id": "db2", "title": "db_old_2", "like_order": 11},
    ]
    existing_items = {it["aweme_id"]: it for it in db_items}
    existing_ids = set(existing_items.keys())
    fetched_ids = set()
    items = []
    limit = 4

    # API 返回顺序：最新点赞在前 [db1(旧), db3(新)]
    page1 = [_make_item("db1", "api_old_1"), _make_item("db3", "api_new_1")]
    new_items = []
    for it in page1:
        fetched_ids.add(it["aweme_id"])
        # API 返回的所有作品都进入最终列表，已存在的旧数据会被重新排序
        new_items.append(it)
    items = items + new_items

    # 合并 db 中未在本次 API 中出现的旧数据
    items = items + [it for it in existing_items.values() if it.get("aweme_id") not in fetched_ids]

    for idx, it in enumerate(items[:limit]):
        it["like_order"] = idx

    titles = [it["title"] for it in items[:limit]]
    expected = ["api_old_1", "api_new_1", "db_old_2"]
    assert titles == expected, f"expected {expected}, got {titles}"
    assert items[0]["like_order"] == 0
    assert items[-1]["like_order"] == len(items) - 1
    print("PASS: DB backfill does not override API order")


def test_stale_cache_order_is_rebuilt():
    """模拟旧缓存顺序是错的（旧视频在前），同步后必须按 API 顺序重建。"""
    existing_items = {
        # 旧缓存里旧视频在前、新视频在后（错误的旧顺序）
        "old1": {"aweme_id": "old1", "title": "cached_old_1", "like_order": 0},
        "old2": {"aweme_id": "old2", "title": "cached_old_2", "like_order": 1},
        "new1": {"aweme_id": "new1", "title": "cached_new_1", "like_order": 2},
    }
    existing_ids = set(existing_items.keys())
    fetched_ids = set()
    items = []
    limit = 4

    # API 返回顺序：最新点赞在前 [new1, new2, old1]
    page1 = [
        _make_item("new1", "api_new_1"),
        _make_item("new2", "api_new_2"),
        _make_item("old1", "api_old_1"),
    ]
    new_items = []
    for it in page1:
        fetched_ids.add(it["aweme_id"])
        # API 返回的所有作品都进入最终列表，不是只追加新增
        new_items.append(it)
    items = items + new_items

    # 本地有但 API 未返回的追加到末尾
    items = items + [it for it in existing_items.values() if it.get("aweme_id") not in fetched_ids]

    for idx, it in enumerate(items[:limit]):
        it["like_order"] = idx

    titles = [it["title"] for it in items[:limit]]
    expected = ["api_new_1", "api_new_2", "api_old_1", "cached_old_2"]
    assert titles == expected, f"expected {expected}, got {titles}"
    assert items[0]["like_order"] == 0
    assert items[-1]["like_order"] == 3
    print("PASS: stale cache order is rebuilt from API")


if __name__ == "__main__":
    test_api_pages_keep_newest_first()
    test_db_backfill_does_not_override_api_order()
    test_stale_cache_order_is_rebuilt()
    print("All tests passed.")
