"""验证 PostUserModeStrategy 空页场景：风控标记诊断 + 浏览器兜底激活。

直接 import backend 包会拉起 aiohttp 等第三方依赖，因此这里通过 sys.modules
打桩，只加载策略文件本身及其轻量依赖（base_strategy / downloader_base / logger）。
"""
import asyncio
import logging
import sys
import types
from pathlib import Path
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parent.parent

# --- 打桩重依赖，保证测试只依赖标准库 ---
core_pkg = types.ModuleType("core")
core_pkg.__path__ = [str(BACKEND_ROOT / "core")]
sys.modules["core"] = core_pkg

user_modes_pkg = types.ModuleType("core.user_modes")
user_modes_pkg.__path__ = [str(BACKEND_ROOT / "core" / "user_modes")]
sys.modules["core.user_modes"] = user_modes_pkg

downloader_base_stub = types.ModuleType("core.downloader_base")


class DownloadResult:
    def __init__(self, *args, **kwargs):
        self.total = 0
        self.success = 0
        self.failed = 0
        self.skipped = 0


downloader_base_stub.DownloadResult = DownloadResult
sys.modules["core.downloader_base"] = downloader_base_stub

utils_pkg = types.ModuleType("utils")
# __path__ 指向真实的 utils 目录：只打桩包本身（避免执行 __init__ 拉起重依赖），
# 但保留子模块查找能力，否则会污染 sys.modules，让同批次的其它用例
# （如 test_sync_likes_order.py）在 import utils.cookie_utils 时失败。
utils_pkg.__path__ = [str(BACKEND_ROOT / "utils")]
sys.modules["utils"] = utils_pkg

logger_stub = types.ModuleType("utils.logger")
logger_stub.setup_logger = lambda name, *a, **k: logging.getLogger(name)
sys.modules["utils.logger"] = logger_stub

_STUB_MODULE_NAMES = (
    "core",
    "core.user_modes",
    "core.downloader_base",
    "utils",
    "utils.logger",
)

from core.user_modes import post_strategy as post_strategy_module  # noqa: E402
from core.user_modes.post_strategy import PostUserModeStrategy  # noqa: E402

# 导入完成后立刻撤销桩模块：post_strategy / base_strategy 已经拿到了所需对象，
# 继续把这些桩留在 sys.modules 会污染同批次后续用例（如 test_sync_likes_order.py），
# 让它们导入真实的 core / utils 时拿到残缺版本（例如 utils.logger 缺少
# set_console_log_level、core.downloader_base 缺少 BaseDownloader）。
for _stub_name in _STUB_MODULE_NAMES:
    sys.modules.pop(_stub_name, None)


# --- 测试替身 ---
class _FakeRateLimiter:
    async def acquire(self):
        return None


class _FakeAPIClient:
    """按顺序返回预设页面；取完后重复最后一页。"""

    def __init__(self, pages):
        self._pages = pages
        self.calls = 0

    async def get_user_post(self, sec_uid, max_cursor, count):
        page = self._pages[min(self.calls, len(self._pages) - 1)]
        self.calls += 1
        return page


class _FakeDownloader:
    def __init__(self, pages, fallback_items=None, with_fallback=True):
        self.api_client = _FakeAPIClient(pages)
        self.config = {"number": {"post": 0}}
        self.database = None
        self.rate_limiter = _FakeRateLimiter()
        self.steps = []
        self.fallback_called = False
        self._fallback_items = list(fallback_items or [])
        if not with_fallback:
            # 模拟没有兜底能力的下载器：getattr 返回 None，callable 为 False。
            self._recover_user_post_with_browser = None

    def _progress_update_step(self, step, detail):
        self.steps.append((step, detail))

    async def _recover_user_post_with_browser(self, sec_uid, user_info, aweme_list):
        self.fallback_called = True
        aweme_list.extend(self._fallback_items)


def _empty_page(**risk_flags):
    return {
        "items": [],
        "aweme_list": [],
        "has_more": False,
        "max_cursor": 0,
        "status_code": 0,
        "risk_flags": risk_flags,
    }


def _items_page(*aweme_ids):
    return {
        "items": [
            {"aweme_id": aid, "author": {"sec_uid": "s1"}} for aid in aweme_ids
        ],
        "has_more": False,
        "max_cursor": 0,
        "status_code": 0,
        "risk_flags": {},
    }


def _collect(strategy, sec_uid="s1"):
    async def _run():
        return await strategy.collect_items(sec_uid, {"nickname": "n"})

    return asyncio.run(_run())


def _collect_fast(strategy):
    """空页重试内部有真实 sleep，这里把策略模块里的 asyncio.sleep 置空。"""
    fake_asyncio = types.SimpleNamespace(
        sleep=lambda *a, **k: _noop_coro(),
    )
    with mock.patch.object(post_strategy_module, "asyncio", fake_asyncio):
        return _collect(strategy)


async def _noop_coro():
    return None


def _assert_raises(strategy, expect_substrs):
    try:
        _collect_fast(strategy)
    except RuntimeError as exc:
        message = str(exc)
        for part in expect_substrs:
            assert part in message, f"期望错误信息包含 {part!r}，实际：{message}"
        return message
    raise AssertionError("期望抛出 RuntimeError，但没有抛出")


# --- 用例 ---
def test_empty_pages_with_login_tip_raise_login_message():
    """接口提示需要登录（空列表+login_tip）时，应明确指出 Cookie 失效。"""
    dl = _FakeDownloader([_empty_page(login_tip=True, verify_page=False)])
    message = _assert_raises(PostUserModeStrategy(dl), ["Cookie 已失效", "重新登录"])
    assert dl.fallback_called, "空页后应先尝试浏览器兜底"
    print(f"PASS: login_tip 诊断 -> {message}")


def test_empty_pages_with_verify_page_raise_verify_message():
    """响应包含验证码/风控票据时，应提示完成验证。"""
    dl = _FakeDownloader([_empty_page(login_tip=False, verify_page=True)])
    message = _assert_raises(PostUserModeStrategy(dl), ["验证", "验证码"])
    assert dl.fallback_called
    print(f"PASS: verify_page 诊断 -> {message}")


def test_empty_pages_without_flags_keep_generic_message():
    """没有任何风控标记时，给出通用的「被风控 / 登录态」提示。

    说明：早期版本的兜底文案是「反爬限制 … 重新登录抖音刷新 Cookie」，
    现已改为更具体的 Argus 风控诊断（见 post_strategy._empty_list_message），
    这里跟着断言新文案。
    """
    dl = _FakeDownloader([_empty_page()])
    message = _assert_raises(PostUserModeStrategy(dl), ["Argus 风控拦截", "浏览器兜底"])
    assert dl.fallback_called
    print(f"PASS: 无标记时通用提示 -> {message}")


def test_browser_fallback_recovers_empty_list():
    """浏览器兜底回补到作品时，应正常返回，不再报错。"""
    dl = _FakeDownloader(
        [_empty_page()],
        fallback_items=[{"aweme_id": "recovered-1", "author": {"sec_uid": "s1"}}],
    )
    items = _collect_fast(PostUserModeStrategy(dl))
    assert dl.fallback_called
    assert [it["aweme_id"] for it in items] == ["recovered-1"]
    print("PASS: 浏览器兜底回补成功")


def test_normal_pages_skip_browser_fallback():
    """接口正常返回时不应触发浏览器兜底。"""
    dl = _FakeDownloader([_items_page("a1", "a2")])
    items = _collect_fast(PostUserModeStrategy(dl))
    assert not dl.fallback_called
    assert [it["aweme_id"] for it in items] == ["a1", "a2"]
    print("PASS: 正常分页不触发兜底")


def test_downloader_without_fallback_still_raises():
    """下载器没有兜底方法时，空页仍应抛出明确错误。"""
    dl = _FakeDownloader([_empty_page(login_tip=True)], with_fallback=False)
    assert dl._recover_user_post_with_browser is None
    _assert_raises(PostUserModeStrategy(dl), ["Cookie 已失效"])
    print("PASS: 无兜底方法时按诊断报错")


if __name__ == "__main__":
    test_empty_pages_with_login_tip_raise_login_message()
    test_empty_pages_with_verify_page_raise_verify_message()
    test_empty_pages_without_flags_keep_generic_message()
    test_browser_fallback_recovers_empty_list()
    test_normal_pages_skip_browser_fallback()
    test_downloader_without_fallback_still_raises()
    print("All tests passed.")
