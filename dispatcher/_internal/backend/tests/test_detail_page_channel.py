"""作品详情获取链路回归测试。

背景：桌面端曾为每个作品新开一个 Chromium 窗口抓 aweme/detail（约 20s/条，
频繁失败且会弹窗）。改造后主路径改为「页内 XHR 通道 + 批量并发」，开窗口仅作
单作品下载的最后兜底。这里锁定该优先级不被后续改动破坏。
"""

from __future__ import annotations

import asyncio
import json

import pytest

from core.api_client import DouyinAPIClient


@pytest.fixture
def client(monkeypatch):
    # 绕过 __init__（需要 cookie / 配置文件），只测试详情获取链路
    api = object.__new__(DouyinAPIClient)

    async def _default_query():
        return {"device_platform": "webapp", "aid": "6383"}

    def _build_signed_path(path, params, **_kwargs):
        return (f"https://www.douyin.com{path}?aweme_id={params.get('aweme_id')}", "UA")

    monkeypatch.setattr(api, "_default_query", _default_query)
    monkeypatch.setattr(api, "build_signed_path", _build_signed_path)
    monkeypatch.setenv("DOUZY_BRIDGE_PORT", "12345")
    return api


def test_detail_prefers_page_channel_and_skips_window(monkeypatch, client):
    """页内通道命中时不该再开 Chromium 窗口。"""
    calls = {"page": 0, "window": 0}

    async def fake_page(aweme_id):
        calls["page"] += 1
        return {"aweme_id": aweme_id}

    async def fake_window(aweme_id, **_kwargs):
        calls["window"] += 1
        return {"aweme_id": aweme_id, "source": "window"}

    monkeypatch.setattr(client, "_get_detail_via_page_bridge", fake_page)
    monkeypatch.setattr(client, "_get_detail_via_electron_bridge", fake_window)

    detail = asyncio.run(client.get_video_detail("7690812702357076479"))

    assert detail == {"aweme_id": "7690812702357076479"}
    assert calls["page"] == 1
    assert calls["window"] == 0


def test_detail_batch_mode_never_opens_window(monkeypatch, client):
    """批量补详情场景（allow_window=False）即使页内失败也不开窗口。"""

    async def fake_page(_aweme_id):
        return None

    async def fake_window(_aweme_id, **_kwargs):  # pragma: no cover - 不应被调用
        pytest.fail("批量场景不应打开 Chromium 窗口")

    monkeypatch.setattr(client, "_get_detail_via_page_bridge", fake_page)
    monkeypatch.setattr(client, "_get_detail_via_electron_bridge", fake_window)

    assert asyncio.run(client.get_video_detail("123", allow_window=False)) is None


def test_batch_details_uses_single_batch_request(monkeypatch, client):
    """批量详情走 /v1/browser-fetch-batch，一次请求覆盖全部 id。"""
    seen = {}

    async def fake_post(path, payload, **_kwargs):
        seen["path"] = path
        seen["items"] = payload["items"]
        results = {
            item["key"]: {
                "status": 200,
                "text": json.dumps({"aweme_detail": {"aweme_id": item["key"]}}),
            }
            for item in payload["items"]
        }
        return {"ok": True, "results": results}

    monkeypatch.setattr(client, "_post_bridge_json", fake_post)

    out = asyncio.run(client.get_video_details_batch(["1", "2", "3"]))

    assert set(out) == {"1", "2", "3"}
    assert seen["path"] == "/v1/browser-fetch-batch"
    assert len(seen["items"]) == 3


def test_batch_details_falls_back_to_single_page_channel(monkeypatch, client):
    """批量未命中的 id 再用单条页内通道补一次。"""
    retried = []

    async def fake_post(path, payload, **_kwargs):
        results = {}
        for item in payload["items"]:
            if item["key"] == "1":
                results[item["key"]] = {
                    "status": 200,
                    "text": json.dumps({"aweme_detail": {"aweme_id": "1"}}),
                }
            else:
                results[item["key"]] = {"status": 403, "text": "ArgusSecurityPlugin"}
        return {"ok": True, "results": results}

    async def fake_page(aweme_id):
        retried.append(aweme_id)
        return {"aweme_id": aweme_id}

    monkeypatch.setattr(client, "_post_bridge_json", fake_post)
    monkeypatch.setattr(client, "_get_detail_via_page_bridge", fake_page)

    out = asyncio.run(client.get_video_details_batch(["1", "2"]))

    assert set(out) == {"1", "2"}
    assert retried == ["2"]


def test_extract_aweme_detail_supports_item_list():
    assert DouyinAPIClient._extract_aweme_detail(
        json.dumps({"item_list": [{"aweme_id": "9"}]})
    ) == {"aweme_id": "9"}
    assert DouyinAPIClient._extract_aweme_detail("not-json") is None
    assert DouyinAPIClient._extract_aweme_detail(json.dumps({"aweme_detail": None})) is None
