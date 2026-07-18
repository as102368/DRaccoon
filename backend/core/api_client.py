from __future__ import annotations

import asyncio
import json
import random
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlencode

import aiohttp

from auth import MsTokenManager
from utils.cookie_utils import sanitize_cookies
from utils.logger import setup_logger
from utils.proxy_pool import ProxyPool
from utils.xbogus import XBogus

try:
    from utils.abogus import ABogus, BrowserFingerprintGenerator
except Exception:  # pragma: no cover - optional dependency
    ABogus = None
    BrowserFingerprintGenerator = None

logger = setup_logger("APIClient")


# #region debug-point helper
def _debug_log(hypothesis_id: str, msg: str, data: Optional[Dict[str, Any]] = None) -> None:
    """Send a debug event to the local TRAE debug server if available."""
    try:
        import json
        import os
        import urllib.request

        env_path = r"D:\DOU\douzy-electron\.dbg\batch-unfollow-no-effect.env"
        url = "http://127.0.0.1:7777/event"
        session_id = "batch-unfollow-no-effect"
        if os.path.exists(env_path):
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    if line.startswith("DEBUG_SERVER_URL="):
                        url = line.split("=", 1)[1].strip()
                    elif line.startswith("DEBUG_SESSION_ID="):
                        session_id = line.split("=", 1)[1].strip()
        payload = {
            "sessionId": session_id,
            "runId": "pre-fix",
            "hypothesisId": hypothesis_id,
            "location": "api_client.py",
            "msg": f"[DEBUG] {msg}",
            "data": data or {},
        }
        req = urllib.request.Request(
            url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=1).read()
    except Exception:
        pass
# #endregion

_LOGIN_REQUIRED_STATUS_CODES = {2483}


class LoginRequiredError(Exception):
    """Raised when Douyin rejects a request because the session is not logged in.

    Signalled by ``status_code == 2483`` (or a ``status_msg`` asking to log in).
    Higher layers (CLI) catch this to trigger an interactive re-login + retry.
    """

    def __init__(self, status_code: int, status_msg: str, path: str):
        self.status_code = status_code
        self.status_msg = status_msg
        self.path = path
        super().__init__(
            f"login required (status_code={status_code}) at {path}: {status_msg}"
        )


def _is_login_required(data: object) -> bool:
    if not isinstance(data, dict):
        return False
    code = data.get("status_code")
    msg = str(data.get("status_msg") or "")
    return code in _LOGIN_REQUIRED_STATUS_CODES or "请先登录" in msg


_USER_AGENT_POOL = [
    (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
    ),
    (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
    ),
]


class DouyinAPIClient:
    BASE_URL = "https://www.douyin.com"
    _BROWSER_COOKIE_BLOCKLIST = {
        # sessionid/sessionid_ss 需要传给浏览器才能保持登录态，
        # 否则回补时会被当作未登录，导致作品列表为空。
        "sid_tt",
        "sid_guard",
        "uid_tt",
        "uid_tt_ss",
        "passport_auth_status",
        "passport_auth_status_ss",
        "passport_assist_user",
        "passport_auth_mix_state",
        "passport_mfa_token",
        "login_time",
    }

    def __init__(
        self,
        cookies: Dict[str, str],
        proxy: Optional[str] = None,
        proxy_pool: Optional[ProxyPool] = None,
        config: Optional[Dict[str, Any]] = None,
    ):
        self.cookies = sanitize_cookies(cookies or {})
        self.proxy = str(proxy or "").strip()
        self.proxy_pool = proxy_pool
        self.config = config or {}
        self._session: Optional[aiohttp.ClientSession] = None
        self._browser_post_aweme_items: Dict[str, Dict[str, Any]] = {}
        self._browser_post_stats: Dict[str, int] = {}
        selected_ua = random.choice(_USER_AGENT_POOL)
        self.headers = {
            "User-Agent": selected_ua,
            "Referer": "https://www.douyin.com/?recommend=1",
            "Accept": "*/*",
            "Accept-Encoding": "gzip, deflate",
            "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        }
        self._signer = XBogus(self.headers["User-Agent"])
        self._ms_token_manager = MsTokenManager(user_agent=self.headers["User-Agent"])
        self._ms_token = (self.cookies.get("msToken") or "").strip()
        self._abogus_enabled = ABogus is not None and BrowserFingerprintGenerator is not None

        # Lazy Playwright state used for browser-based relation actions.
        self._playwright: Optional[Any] = None
        self._browser: Optional[Any] = None
        self._browser_context: Optional[Any] = None
        self._browser_page: Optional[Any] = None

    async def __aenter__(self) -> "DouyinAPIClient":
        await self._ensure_session()
        return self

    async def __aexit__(self, exc_type, exc, tb):
        await self.close()

    async def _ensure_session(self):
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                headers=self.headers,
                cookies=self.cookies,
                timeout=aiohttp.ClientTimeout(total=30),
                raise_for_status=False,
            )

    async def close(self):
        if self._session and not self._session.closed:
            await self._session.close()
        await self._close_browser()

    async def _ensure_browser_context(self):
        """Lazy-start a headed Playwright browser page for relation actions.

        The page is kept on ``https://www.douyin.com/`` so that relative
        ``fetch`` calls inherit the origin and Douyin's JS can attach the
        required anti-bot headers / signatures automatically.
        """
        try:
            from playwright.async_api import async_playwright
        except Exception as exc:
            raise RuntimeError("Playwright is required for relation actions") from exc

        if self._browser_page is not None:
            try:
                if not self._browser_page.is_closed():
                    return self._browser_page
            except Exception:
                pass

        self._playwright = await async_playwright().start()
        browser_cfg = self.config.get("browser_fallback", {}) or {}
        headless = bool(browser_cfg.get("headless", False))
        self._browser = await self._playwright.chromium.launch(
            headless=headless,
            args=["--disable-blink-features=AutomationControlled"],
        )
        self._browser_context = await self._browser.new_context(
            user_agent=self.headers.get("User-Agent", ""),
            viewport={"width": 1280, "height": 800},
            locale="zh-CN",
        )
        cookies = self._browser_cookie_payload()
        if cookies:
            await self._browser_context.add_cookies(cookies)
        self._browser_page = await self._browser_context.new_page()
        await self._browser_page.goto(
            "https://www.douyin.com/",
            wait_until="domcontentloaded",
            timeout=60000,
        )
        # Give Douyin's JS (including fetch interceptors / signers) a moment to
        # bootstrap; this only happens once because the page is reused.
        await self._browser_page.wait_for_timeout(3000)
        return self._browser_page

    async def _close_browser(self):
        """Close the lazy Playwright browser used for relation actions."""
        if self._browser_page is not None:
            try:
                await self._browser_page.close()
            except Exception:
                pass
            self._browser_page = None
        if self._browser_context is not None:
            try:
                await self._browser_context.close()
            except Exception:
                pass
            self._browser_context = None
        if self._browser is not None:
            try:
                await self._browser.close()
            except Exception:
                pass
            self._browser = None
        if self._playwright is not None:
            try:
                await self._playwright.stop()
            except Exception:
                pass
            self._playwright = None

    def resolve_proxy(self) -> Optional[str]:
        """Return the current proxy, preferring the proxy pool if configured."""
        if self.proxy_pool:
            return self.proxy_pool.get_proxy()
        return self.proxy or None

    async def get_session(self) -> aiohttp.ClientSession:
        await self._ensure_session()
        if self._session is None:
            raise RuntimeError("Failed to create aiohttp session")
        return self._session

    async def _ensure_ms_token(self) -> str:
        if self._ms_token:
            return self._ms_token

        token = await asyncio.to_thread(
            self._ms_token_manager.ensure_ms_token,
            self.cookies,
        )
        self._ms_token = token.strip()
        if self._ms_token:
            self.cookies["msToken"] = self._ms_token
            if self._session and not self._session.closed:
                self._session.cookie_jar.update_cookies({"msToken": self._ms_token})
        return self._ms_token

    async def _default_query(self) -> Dict[str, Any]:
        ms_token = await self._ensure_ms_token()
        return {
            "device_platform": "webapp",
            "aid": "6383",
            "channel": "channel_pc_web",
            "update_version_code": "170400",
            "pc_client_type": "1",
            "pc_libra_divert": "Windows",
            "version_code": "290100",
            "version_name": "29.1.0",
            "cookie_enabled": "true",
            "screen_width": "1536",
            "screen_height": "864",
            "browser_language": "zh-CN",
            "browser_platform": "Win32",
            "browser_name": "Chrome",
            "browser_version": "139.0.0.0",
            "browser_online": "true",
            "engine_name": "Blink",
            "engine_version": "139.0.0.0",
            "os_name": "Windows",
            "os_version": "10",
            "cpu_core_num": "16",
            "device_memory": "8",
            "platform": "PC",
            "downlink": "10",
            "effective_type": "4g",
            "round_trip_time": "200",
            "support_h265": "1",
            "support_dash": "1",
            "uifid": "",
            "msToken": ms_token,
        }

    def sign_url(self, url: str) -> Tuple[str, str]:
        signed_url, _xbogus, ua = self._signer.build(url)
        return signed_url, ua

    def build_signed_path(
        self, path: str, params: Dict[str, Any], body: str = "", base_url: Optional[str] = None
    ) -> Tuple[str, str]:
        query = urlencode(params)
        base_url = (base_url or self.BASE_URL).rstrip("/")
        full_url = f"{base_url}{path}"
        ab_signed = self._build_abogus_url(full_url, query, body=body)
        if ab_signed:
            return ab_signed
        return self.sign_url(f"{full_url}?{query}")

    def _build_abogus_url(
        self, base_url: str, query: str, body: str = ""
    ) -> Optional[Tuple[str, str]]:
        if not self._abogus_enabled:
            return None

        try:
            browser_fp = BrowserFingerprintGenerator.generate_fingerprint("Chrome")
            signer = ABogus(fp=browser_fp, user_agent=self.headers["User-Agent"])
            params_with_ab, _ab, ua, _body = signer.generate_abogus(query, body)
            return f"{base_url}?{params_with_ab}", ua
        except Exception as exc:
            logger.warning("Failed to generate a_bogus, fallback to X-Bogus: %s", exc)
            return None

    async def _request_json(
        self,
        path: str,
        params: Dict[str, Any],
        *,
        suppress_error: bool = False,
        max_retries: int = 3,
        method: str = "GET",
        extra_headers: Optional[Dict[str, str]] = None,
        data: Optional[Any] = None,
        base_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        await self._ensure_session()
        delays = [1, 2, 5]
        last_exc: Optional[Exception] = None
        method = (method or "GET").upper()
        request_body = ""
        if isinstance(data, str):
            request_body = data
        elif isinstance(data, bytes):
            request_body = data.decode("utf-8")

        for attempt in range(max_retries):
            signed_url, ua = self.build_signed_path(
                path, params, body=request_body or "", base_url=base_url
            )
            proxy = self.resolve_proxy()
            request_headers = {**self.headers, "User-Agent": ua}
            if extra_headers:
                request_headers.update(extra_headers)
            try:
                if method == "POST":
                    request_coro = self._session.post(
                        signed_url,
                        headers=request_headers,
                        proxy=proxy,
                        data=data,
                    )
                else:
                    request_coro = self._session.get(
                        signed_url,
                        headers=request_headers,
                        proxy=proxy,
                    )
                async with request_coro as response:
                    if response.status == 200:
                        body = await response.read()
                        if not body:
                            # Empty 200 response is a common anti-bot signal
                            # from Douyin. Retry with a fresh signature.
                            logger.warning(
                                "Empty 200 response for %s (attempt %d/%d), "
                                "likely anti-bot; will retry",
                                path,
                                attempt + 1,
                                max_retries,
                            )
                            last_exc = RuntimeError(f"Empty 200 response for {path} (anti-bot)")
                            if attempt < max_retries - 1:
                                delay = delays[min(attempt, len(delays) - 1)]
                                await asyncio.sleep(delay)
                            continue
                        try:
                            data = await response.json(content_type=None)
                        except Exception:
                            import json as _json

                            try:
                                data = _json.loads(body)
                            except Exception:
                                logger.warning(
                                    "Non-JSON 200 response for %s, length=%d",
                                    path,
                                    len(body),
                                )
                                return {}
                        result = data if isinstance(data, dict) else {}
                        if _is_login_required(result):
                            raise LoginRequiredError(
                                int(result.get("status_code") or 0),
                                str(result.get("status_msg") or ""),
                                path,
                            )
                        return result
                    if response.status < 500 and response.status != 429:
                        log_fn = logger.debug if suppress_error else logger.error
                        log_fn(
                            "Request failed: path=%s, status=%s",
                            path,
                            response.status,
                        )
                        return {}
                    last_exc = RuntimeError(f"HTTP {response.status} for {path}")
            except LoginRequiredError:
                raise
            except (
                aiohttp.ClientConnectionError,
                aiohttp.ClientHttpProxyError,
                aiohttp.ServerDisconnectedError,
                asyncio.TimeoutError,
            ) as exc:
                last_exc = exc
                if self.proxy_pool and proxy:
                    self.proxy_pool.mark_failed(proxy)
            except Exception as exc:
                last_exc = exc

            if attempt < max_retries - 1:
                delay = delays[min(attempt, len(delays) - 1)]
                logger.debug(
                    "Request retry %d/%d for %s in %ds",
                    attempt + 1,
                    max_retries,
                    path,
                    delay,
                )
                await asyncio.sleep(delay)

        log_fn = logger.debug if suppress_error else logger.error
        log_fn("Request failed after %d attempts: path=%s, error=%s", max_retries, path, last_exc)
        return {}

    @staticmethod
    def _normalize_paged_response(
        raw_data: Any,
        *,
        item_keys: Optional[List[str]] = None,
        source: str = "api",
    ) -> Dict[str, Any]:
        raw = raw_data if isinstance(raw_data, dict) else {}
        keys = item_keys or []
        keys = ["items", *keys, "aweme_list", "mix_list", "music_list"]

        items: List[Dict[str, Any]] = []
        for key in keys:
            value = raw.get(key)
            if isinstance(value, list):
                items = value
                break

        has_more_value = raw.get("has_more", False)
        try:
            has_more = bool(int(has_more_value))
        except (TypeError, ValueError):
            has_more = bool(has_more_value)

        max_cursor_value = raw.get("max_cursor")
        if max_cursor_value is None:
            max_cursor_value = raw.get("cursor", 0)
        try:
            max_cursor = int(max_cursor_value or 0)
        except (TypeError, ValueError):
            max_cursor = 0

        status_code_value = raw.get("status_code", 0)
        try:
            status_code = int(status_code_value or 0)
        except (TypeError, ValueError):
            status_code = 0

        risk_flags = {
            "login_tip": bool(
                ((raw.get("not_login_module") or {}).get("guide_login_tip_exist"))
                if isinstance(raw.get("not_login_module"), dict)
                else False
            ),
            "verify_page": bool(raw.get("verify_ticket")),
        }

        normalized = {
            "items": items,
            "aweme_list": items,  # 兼容旧调用方
            "has_more": has_more,
            "max_cursor": max_cursor,
            "status_code": status_code,
            "source": source,
            "risk_flags": risk_flags,
            "raw": raw,
        }
        for key, value in raw.items():
            if key not in normalized:
                normalized[key] = value
        return normalized

    async def _build_user_page_params(
        self, sec_uid: str, max_cursor: int, count: int
    ) -> Dict[str, Any]:
        params = await self._default_query()
        params.update(
            {
                "sec_user_id": sec_uid,
                "max_cursor": max_cursor,
                "count": count,
                "locate_query": "false",
            }
        )
        return params

    # aid=1128 works for videos but filters out image/note content;
    # aid=6383 works for notes/gallery but may miss some video content.
    _DETAIL_AID_CANDIDATES = ("6383", "1128")

    async def get_video_detail(
        self, aweme_id: str, *, suppress_error: bool = False
    ) -> Optional[Dict[str, Any]]:
        for aid in self._DETAIL_AID_CANDIDATES:
            params = await self._default_query()
            params.update(
                {
                    "aweme_id": aweme_id,
                    "aid": aid,
                }
            )

            data = await self._request_json(
                "/aweme/v1/web/aweme/detail/",
                params,
                suppress_error=(suppress_error or aid != self._DETAIL_AID_CANDIDATES[-1]),
            )
            if not data:
                continue

            detail = data.get("aweme_detail")
            if detail:
                return detail

            # API returned data but aweme_detail is null — check if content was
            # filtered (e.g. filter_reason="images_base" for note/gallery).
            filter_info = data.get("filter_detail")
            if isinstance(filter_info, dict) and filter_info.get("filter_reason"):
                logger.info(
                    "Aweme %s filtered with aid=%s (reason=%s), retrying",
                    aweme_id,
                    aid,
                    filter_info["filter_reason"],
                )
                continue

            # aweme_detail is null without a filter reason — no retry needed
            break

        return None

    async def get_user_post(
        self, sec_uid: str, max_cursor: int = 0, count: int = 18
    ) -> Dict[str, Any]:
        params = await self._build_user_page_params(sec_uid, max_cursor, count)
        params.update(
            {
                "show_live_replay_strategy": "1",
                "need_time_list": "1",
                "time_list_query": "0",
                "whale_cut_token": "",
                "cut_version": "1",
                "publish_video_strategy_type": "2",
            }
        )
        raw = await self._request_json("/aweme/v1/web/aweme/post/", params)
        return self._normalize_paged_response(raw, item_keys=["aweme_list"])

    async def get_user_like(
        self, sec_uid: str, max_cursor: int = 0, count: int = 20
    ) -> Dict[str, Any]:
        params = await self._build_user_page_params(sec_uid, max_cursor, count)
        raw = await self._request_json("/aweme/v1/web/aweme/favorite/", params)
        return self._normalize_paged_response(raw, item_keys=["aweme_list"])

    async def get_user_mix(
        self, sec_uid: str, max_cursor: int = 0, count: int = 20
    ) -> Dict[str, Any]:
        params = await self._build_user_page_params(sec_uid, max_cursor, count)
        raw = await self._request_json("/aweme/v1/web/mix/list/", params)
        return self._normalize_paged_response(raw, item_keys=["mix_list"])

    async def get_user_music(
        self, sec_uid: str, max_cursor: int = 0, count: int = 20
    ) -> Dict[str, Any]:
        params = await self._build_user_page_params(sec_uid, max_cursor, count)
        raw = await self._request_json("/aweme/v1/web/music/list/", params)
        return self._normalize_paged_response(raw, item_keys=["music_list"])

    async def get_following_page(
        self,
        sec_uid: str,
        *,
        max_time: int = 0,
        count: int = 20,
    ) -> Dict[str, Any]:
        """Fetch a single page of the logged-in account's following list.

        Desktop-only: used by ``core/following.FollowingService`` to sync the
        "My Following" tab. Douyin's web endpoint paginates via time-based
        cursoring: the response contains ``min_time`` which must be passed as
        ``max_time`` in the next request to get the next page. The ``count``
        parameter is capped at 20 by the server regardless of what we send.

        Returns a normalized dict with ``items``, ``has_more``, ``min_time``,
        ``max_time``, ``status_code``, and ``raw`` (the full response).
        """
        params = await self._default_query()
        params.update(
            {
                "user_id": sec_uid,
                "sec_user_id": sec_uid,
                "offset": 0,
                "count": count,
                "source_type": "1",
                "gps_access": "0",
                "address_book_access": "0",
                "min_change": "0",
            }
        )
        if max_time > 0:
            params["max_time"] = max_time
        raw = await self._request_json("/aweme/v1/web/user/following/list/", params)
        normalized = self._normalize_paged_response(
            raw,
            item_keys=["followings", "follow_list", "user_list"],
        )
        # Expose the time-based pagination fields for the sync loop.
        normalized["min_time"] = int(raw.get("min_time") or 0) if isinstance(raw, dict) else 0
        normalized["max_time_resp"] = int(raw.get("max_time") or 0) if isinstance(raw, dict) else 0
        return normalized

    def _get_anti_csrf_token(self) -> str:
        """Return the anti-CSRF token used by write endpoints.

        Douyin Web stores the token in the ``passport_csrf_token`` cookie.
        Some endpoints also accept it via the ``passport_csrf_token_default``
        cookie; we prefer the former and fall back to the latter.
        """
        return (
            self.cookies.get("passport_csrf_token", "")
            or self.cookies.get("passport_csrf_token_default", "")
            or ""
        ).strip()

    async def _resolve_user_id(self, sec_uid: str) -> str:
        """Resolve a numeric Douyin ``user_id`` from a ``sec_uid``."""
        if not sec_uid:
            return ""
        info = await self.get_user_info(sec_uid)
        if isinstance(info, dict):
            uid = info.get("uid")
            if uid is not None:
                return str(uid)
        return ""

    async def _build_commit_relation_params(self) -> Dict[str, Any]:
        """Build query parameters for the ``/aweme/v1/web/commit/follow/user/`` endpoint."""
        params = await self._default_query()
        # The commit/follow/user endpoint uses the older 17.4.0 version codes
        # seen in Douyin's web UI relation actions.
        params["version_code"] = "170400"
        params["version_name"] = "17.4.0"
        params["uifid"] = self.cookies.get("UIFID") or params.get("uifid") or ""
        sv = self.cookies.get("s_v_web_id", "")
        if sv:
            params["verifyFp"] = sv
            params["fp"] = sv
        anti_csrf = self._get_anti_csrf_token()
        if anti_csrf:
            params["anti_csrf"] = anti_csrf
        return params

    async def _commit_relation_via_browser(
        self, sec_uid: str, action_type: int
    ) -> Dict[str, Any]:
        """Execute a follow/unfollow commit by driving the real Douyin web UI.

        The relation endpoint is protected by anti-bot signatures generated by
        Douyin's own JavaScript. Instead of reconstructing the request, we
        navigate to the user's profile page and click the follow/unfollow
        button, letting the page's own event handlers issue the signed request.
        """
        action_name = "follow" if action_type == 1 else "unfollow"
        target_url = f"https://www.douyin.com/user/{sec_uid}"

        page = await self._ensure_browser_context()
        # #region debug-point A:relation-request
        _debug_log(
            "A",
            f"{action_name} browser UI navigate sec_uid={sec_uid}",
            {"url": target_url},
        )
        # #endregion
        try:
            await page.goto(target_url, wait_until="domcontentloaded", timeout=60000)
            # Wait for the follow area to render.
            await page.wait_for_timeout(2000)
        except Exception as exc:
            logger.warning("Browser navigate for %s %s failed: %s", action_name, sec_uid, exc)
            return {"status_code": -1, "status_msg": f"navigate failed: {exc}"}

        async def _find_follow_button_state() -> Tuple[Optional[str], Optional[Any]]:
            """Return (state, locator) for the follow button on the current page.

            States:
                "following"     -> button text is "已关注" / "互相关注"
                "not_following" -> button text is "关注" / "回关"
                None            -> could not determine
            """
            candidates = [
                ("following", "button:has-text('互相关注')"),
                ("following", "button:has-text('已关注')"),
                ("not_following", "button:has-text('回关')"),
                ("not_following", "button:has-text('关注')"),
            ]
            for state, selector in candidates:
                locator = page.locator(selector).first
                try:
                    if await locator.count() > 0 and await locator.is_visible():
                        return state, locator
                except Exception:
                    continue
            return None, None

        async def _click_confirm_unfollow() -> bool:
            """Click the '取消关注' confirmation button if it appears."""
            try:
                confirm = page.locator("button:has-text('取消关注')").first
                await confirm.wait_for(state="visible", timeout=3000)
                await confirm.click()
                await page.wait_for_timeout(1500)
                return True
            except Exception:
                return False

        try:
            current_state, button = await _find_follow_button_state()
        except Exception as exc:
            logger.warning("Failed to locate follow button for %s: %s", sec_uid, exc)
            return {"status_code": -1, "status_msg": f"locate button failed: {exc}"}

        if current_state is None or button is None:
            logger.warning("Could not determine follow state for sec_uid=%s", sec_uid)
            return {"status_code": -1, "status_msg": "follow button not found"}

        desired_state = "following" if action_type == 1 else "not_following"
        if current_state == desired_state:
            # Already in the target state; treat as idempotent success.
            logger.info("User %s already in target state %s", sec_uid, desired_state)
            return {"status_code": 0, "status_msg": "already in target state"}

        # #region debug-point A:relation-request
        _debug_log(
            "A",
            f"{action_name} browser UI click sec_uid={sec_uid} current={current_state}",
            {},
        )
        # #endregion
        try:
            await button.click()
            await page.wait_for_timeout(1500)
            if action_type == 0:
                await _click_confirm_unfollow()
        except Exception as exc:
            logger.warning("Browser click for %s %s failed: %s", action_name, sec_uid, exc)
            return {"status_code": -1, "status_msg": f"click failed: {exc}"}

        # Verify the button state actually changed.
        try:
            new_state, _ = await _find_follow_button_state()
        except Exception as exc:
            logger.warning("Failed to verify follow state for %s: %s", sec_uid, exc)
            return {"status_code": -1, "status_msg": f"verify state failed: {exc}"}

        success = new_state == desired_state
        # #region debug-point B:relation-response
        _debug_log(
            "B",
            f"{action_name} browser UI result sec_uid={sec_uid}",
            {"current": current_state, "new": new_state, "success": success},
        )
        # #endregion
        if success:
            return {"status_code": 0, "status_msg": "success"}

        logger.warning(
            "Browser relation action did not change state: action=%s sec_uid=%s current=%s new=%s",
            action_name,
            sec_uid,
            current_state,
            new_state,
        )
        return {"status_code": -1, "status_msg": "state did not change"}

    @staticmethod
    def _is_relation_success(resp: Any) -> bool:
        if not isinstance(resp, dict):
            return False
        code = int(resp.get("status_code") or 0)
        if code == 0:
            return True
        # Known "already in target state" codes are also acceptable.
        return code in {2096, 2097, 2100}

    async def _commit_relation_via_http(
        self, sec_uid: str, action_type: int, user_id: str
    ) -> Dict[str, Any]:
        """Call the commit/follow/user endpoint directly via HTTP."""
        params = await self._build_commit_relation_params()
        body = f"type={action_type}&user_id={user_id}"
        anti_csrf = self._get_anti_csrf_token()
        extra_headers = {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Secsdk-Csrf-Token": anti_csrf or "DOWNGRADE",
            "Origin": "https://www.douyin.com",
            "Referer": f"https://www.douyin.com/user/{sec_uid}",
            "uifid": self.cookies.get("UIFID", ""),
        }
        action_name = "follow" if action_type == 1 else "unfollow"
        # #region debug-point A:relation-request
        _debug_log(
            "A",
            f"{action_name} http request sec_uid={sec_uid} user_id={user_id}",
            {"params": params, "headers": extra_headers, "body": body},
        )
        # #endregion
        resp = await self._request_json(
            "/aweme/v1/web/commit/follow/user/",
            params,
            method="POST",
            extra_headers=extra_headers,
            data=body.encode("utf-8"),
        )
        # #region debug-point B:relation-response
        _debug_log("B", f"{action_name} http response sec_uid={sec_uid}", {"response": resp})
        # #endregion
        return resp

    async def _commit_relation(self, sec_uid: str, action_type: int) -> Dict[str, Any]:
        """Send a follow (type=1) or unfollow (type=0) commit request.

        By default we call the direct HTTP endpoint so no browser window is
        opened. If the direct call fails and ``browser_fallback.enabled`` is
        truthy, we fall back to the browser automation path.
        """
        user_id = await self._resolve_user_id(sec_uid)
        if not user_id:
            logger.warning("Cannot resolve user_id for sec_uid=%s", sec_uid)
            return {"status_code": -1, "status_msg": "cannot resolve user_id"}

        action_name = "follow" if action_type == 1 else "unfollow"

        # 1. Try the direct HTTP endpoint first (no browser).
        resp = await self._commit_relation_via_http(sec_uid, action_type, user_id)
        if self._is_relation_success(resp):
            return resp

        # 2. Fallback to browser automation only when explicitly enabled.
        browser_cfg = self.config.get("browser_fallback", {}) or {}
        if browser_cfg.get("enabled"):
            logger.warning(
                "%s %s HTTP failed (status_code=%s status_msg=%s error=%s), trying browser fallback",
                action_name,
                sec_uid,
                resp.get("status_code"),
                resp.get("status_msg"),
                resp.get("error"),
            )
            browser_resp = await self._commit_relation_via_browser(sec_uid, action_type)
            if browser_resp:
                return browser_resp

        return resp

    async def follow_user(self, sec_uid: str) -> Dict[str, Any]:
        """Follow a user via the Douyin Web ``commit/follow/user`` endpoint.

        Args:
            sec_uid: The target user's ``sec_uid``.

        Returns:
            The parsed JSON response from Douyin.
        """
        if not sec_uid:
            logger.warning("follow_user called with empty sec_uid")
            return {"status_code": -1, "status_msg": "empty sec_uid"}
        return await self._commit_relation(sec_uid, 1)

    async def unfollow_user(self, sec_uid: str) -> Dict[str, Any]:
        """Unfollow a user via the Douyin Web ``commit/follow/user`` endpoint.

        Args:
            sec_uid: The target user's ``sec_uid``.

        Returns:
            The parsed JSON response from Douyin.
        """
        if not sec_uid:
            logger.warning("unfollow_user called with empty sec_uid")
            return {"status_code": -1, "status_msg": "empty sec_uid"}
        return await self._commit_relation(sec_uid, 0)

    async def _build_collect_page_params(self, max_cursor: int, count: int) -> Dict[str, Any]:
        params = await self._default_query()
        params.update(
            {
                "cursor": max_cursor,
                "count": count,
                "version_code": "170400",
                "version_name": "17.4.0",
            }
        )
        return params

    async def get_user_collects(
        self, sec_uid: str, max_cursor: int = 0, count: int = 10
    ) -> Dict[str, Any]:
        if sec_uid and sec_uid != "self":
            logger.warning("Collect folders currently require self sec_uid, got=%s", sec_uid)
            return self._normalize_paged_response({}, item_keys=["collects_list"], source="api")

        params = await self._build_collect_page_params(max_cursor, count)
        raw = await self._request_json("/aweme/v1/web/collects/list/", params)
        return self._normalize_paged_response(raw, item_keys=["collects_list"])

    async def get_collect_aweme(
        self, collects_id: str, max_cursor: int = 0, count: int = 10
    ) -> Dict[str, Any]:
        params = await self._build_collect_page_params(max_cursor, count)
        params.update({"collects_id": collects_id})
        raw = await self._request_json("/aweme/v1/web/collects/video/list/", params)
        return self._normalize_paged_response(raw, item_keys=["aweme_list"])

    async def get_user_favorite_videos(
        self, max_cursor: int = 0, count: int = 20
    ) -> Dict[str, Any]:
        """获取「我的收藏 → 视频」默认收藏视频列表（非收藏夹）。

        抖音 Web 端该接口为 POST，分页参数放在 form body 中；query string
        仅用于签名与公共参数。浏览器实际请求发往 www-hj.douyin.com。
        """
        params = await self._default_query()
        params.update(
            {
                "version_code": "170400",
                "version_name": "17.4.0",
            }
        )
        body = f"count={count}&cursor={max_cursor}"
        extra_headers = {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        }
        raw = await self._request_json(
            "/aweme/v1/web/aweme/listcollection/",
            params,
            method="POST",
            extra_headers=extra_headers,
            data=body.encode("utf-8"),
            base_url="https://www-hj.douyin.com",
        )
        return self._normalize_paged_response(raw, item_keys=["aweme_list"])

    async def get_user_collect_mix(
        self, sec_uid: str, max_cursor: int = 0, count: int = 12
    ) -> Dict[str, Any]:
        if sec_uid and sec_uid != "self":
            logger.warning("Collect mix currently require self sec_uid, got=%s", sec_uid)
            return self._normalize_paged_response({}, item_keys=["mix_infos"], source="api")

        params = await self._build_collect_page_params(max_cursor, count)
        raw = await self._request_json("/aweme/v1/web/mix/listcollection/", params)
        return self._normalize_paged_response(raw, item_keys=["mix_infos"])

    async def get_challenge_detail(self, ch_id: str) -> Optional[Dict[str, Any]]:
        """获取话题（challenge）详情。

        返回话题基础信息 dict，包含 ch_id、challenge_name、description、user_count 等；
        失败或话题不存在时返回 None。
        """
        if not ch_id:
            return None
        params = await self._default_query()
        params.update({"ch_id": str(ch_id)})
        data = await self._request_json("/aweme/v1/web/challenge/detail/", params, suppress_error=True)
        if not isinstance(data, dict):
            return None
        status_code = int(data.get("status_code") or 0)
        if status_code != 0:
            logger.warning("Challenge detail failed: ch_id=%s status_code=%s", ch_id, status_code)
            return None
        challenge = data.get("ch_info") or data.get("challenge_info") or data.get("challenge") or data
        if not isinstance(challenge, dict):
            return None
        cover = ""
        if isinstance(challenge.get("cover"), dict):
            cover = (challenge.get("cover") or {}).get("url_list", [""])[0]
        elif challenge.get("hashtag_profile"):
            cover = challenge["hashtag_profile"]
        return {
            "ch_id": str(challenge.get("cid") or ch_id),
            "challenge_name": challenge.get("cha_name") or challenge.get("challenge_name") or "",
            "description": challenge.get("desc") or challenge.get("description") or "",
            "cover": cover,
            "user_count": int(challenge.get("user_count") or challenge.get("user_count_str") or 0),
            "view_count": int(challenge.get("view_count") or challenge.get("view_count_str") or 0),
            "raw": challenge,
        }

    async def get_challenge_aweme(
        self, ch_id: str, cursor: int = 0, count: int = 20
    ) -> Dict[str, Any]:
        """获取话题下的视频列表（一页）。"""
        if not ch_id:
            return self._normalize_paged_response({}, item_keys=["aweme_list"], source="api")
        params = await self._default_query()
        params.update(
            {
                "ch_id": str(ch_id),
                "cursor": cursor,
                "count": count,
                "query_type": "0",
            }
        )
        raw = await self._request_json(
            "/aweme/v1/web/challenge/aweme/", params, suppress_error=True
        )
        return self._normalize_paged_response(raw, item_keys=["aweme_list"])

    async def get_user_info(self, sec_uid: str) -> Optional[Dict[str, Any]]:
        params = await self._default_query()
        params.update({"sec_user_id": sec_uid})

        data = await self._request_json("/aweme/v1/web/user/profile/other/", params)
        if data:
            return data.get("user")
        return None

    async def get_self_info(self) -> Optional[Dict[str, Any]]:
        """Fetch the logged-in user's own profile.

        Uses the ``/aweme/v1/web/user/profile/self/`` endpoint which
        identifies the user from the session cookies — no ``sec_uid``
        parameter needed. Returns the ``user`` dict (containing
        ``sec_uid``, ``uid``, ``nickname``, etc.) or ``None`` on failure.

        Desktop-only: used by the Following sync to resolve the
        logged-in user's ``sec_uid`` before calling
        ``get_following_page``.
        """
        params = await self._default_query()
        data = await self._request_json(
            "/aweme/v1/web/user/profile/self/", params
        )
        if data:
            return data.get("user")
        return None

    async def get_mix_detail(self, mix_id: str) -> Optional[Dict[str, Any]]:
        params = await self._default_query()
        params.update({"mix_id": mix_id})
        data = await self._request_json("/aweme/v1/web/mix/detail/", params)
        if not data:
            return None
        return data.get("mix_info") or data.get("mix_detail") or data

    async def get_mix_aweme(self, mix_id: str, cursor: int = 0, count: int = 20) -> Dict[str, Any]:
        params = await self._default_query()
        params.update({"mix_id": mix_id, "cursor": cursor, "count": count})
        raw = await self._request_json("/aweme/v1/web/mix/aweme/", params)
        return self._normalize_paged_response(raw, item_keys=["aweme_list"])

    async def get_music_detail(self, music_id: str) -> Optional[Dict[str, Any]]:
        params = await self._default_query()
        params.update({"music_id": music_id})
        data = await self._request_json("/aweme/v1/web/music/detail/", params)
        if not data:
            return None
        return data.get("music_info") or data.get("music_detail") or data

    async def get_music_aweme(
        self, music_id: str, cursor: int = 0, count: int = 20
    ) -> Dict[str, Any]:
        params = await self._default_query()
        params.update({"music_id": music_id, "cursor": cursor, "count": count})
        raw = await self._request_json("/aweme/v1/web/music/aweme/", params)
        return self._normalize_paged_response(raw, item_keys=["aweme_list"])

    async def get_music_aweme_list(
        self, music_id: str, cursor: int = 0, count: int = 20
    ) -> Dict[str, Any]:
        """音乐详情页：拉取使用了该音乐的所有视频（music_id 分页）。"""
        params = await self._default_query()
        params.update({"music_id": music_id, "cursor": cursor, "count": count})
        raw = await self._request_json("/aweme/v1/web/music/list/", params)
        return self._normalize_paged_response(raw, item_keys=["aweme_list"])

    async def get_live_room_info(
        self, room_id: str, *, sec_user_id: str = ""
    ) -> Optional[Dict[str, Any]]:
        """通过房间号（web_rid）拉取直播间信息。

        返回包含 room_info + stream_url 的 dict；若房间不在直播中或接口失败返回 None。
        """
        params = await self._default_query()
        params.update(
            {
                "web_rid": room_id,
                "room_id_str": room_id,
                "enter_source": "",
                "is_need_double_stream": "false",
                "cookie_enabled": "true",
            }
        )
        if sec_user_id:
            params["sec_user_id"] = sec_user_id

        raw = await self._request_json(
            "/webcast/room/web/enter/",
            params,
            suppress_error=True,
        )
        if not raw:
            return None

        data_section = raw.get("data") if isinstance(raw.get("data"), dict) else raw
        if not isinstance(data_section, dict):
            return None

        room_list = data_section.get("data")
        room = None
        if isinstance(room_list, list) and room_list:
            first = room_list[0]
            if isinstance(first, dict):
                room = first
        elif isinstance(data_section.get("room"), dict):
            room = data_section.get("room")
        elif isinstance(raw.get("room"), dict):
            room = raw.get("room")

        if not isinstance(room, dict):
            return None

        user = data_section.get("user") if isinstance(data_section, dict) else None
        return {
            "room": room,
            "user": user if isinstance(user, dict) else {},
            "raw": raw,
        }

    async def get_hot_search_board(self) -> Dict[str, Any]:
        """获取抖音热搜榜。返回归一化 dict，items 为热搜词条列表。"""
        params = await self._default_query()
        params.update({"detail_list": "1", "source": "6"})
        raw = await self._request_json(
            "/aweme/v1/web/hot/search/list/", params, suppress_error=True
        )
        # 热榜返回结构中数据在 data.word_list 或 word_list
        data_root = raw.get("data") if isinstance(raw.get("data"), dict) else raw
        word_list = data_root.get("word_list") if isinstance(data_root, dict) else None
        status_code = int(raw.get("status_code") or 0)
        items = word_list if isinstance(word_list, list) else []
        # 响应为空 + 非正常状态码时显式告警，方便排查 cookie 失效/签名失败
        if not items and (status_code or not raw):
            logger.warning(
                "Hot search board returned no items (status_code=%s). "
                "Check cookies / signature; Douyin may be rejecting the request.",
                status_code,
            )
        return {
            "items": items,
            "has_more": False,
            "max_cursor": 0,
            "status_code": status_code,
            "raw": raw,
        }

    async def search_aweme(
        self,
        keyword: str,
        *,
        offset: int = 0,
        count: int = 10,
        sort_type: int = 0,
        publish_time: int = 0,
    ) -> Dict[str, Any]:
        """搜索作品。

        Args:
            sort_type: 0 综合 / 1 最多点赞 / 2 最新发布
            publish_time: 0 不限 / 1 一天内 / 7 一周内 / 182 半年内
        """
        params = await self._default_query()
        params.update(
            {
                "keyword": keyword,
                "search_channel": "aweme_video_web",
                "sort_type": sort_type,
                "publish_time": publish_time,
                "search_source": "normal_search",
                "query_correct_type": "1",
                "is_filter_search": 1 if (sort_type or publish_time) else 0,
                "offset": offset,
                "count": count,
            }
        )
        raw = await self._request_json(
            "/aweme/v1/web/general/search/single/", params, suppress_error=True
        )
        # 搜索结果每条在 data[].aweme_info；需要拍平
        data_list = raw.get("data") if isinstance(raw.get("data"), list) else []
        items: List[Dict[str, Any]] = []
        for entry in data_list:
            if not isinstance(entry, dict):
                continue
            aweme_info = entry.get("aweme_info")
            if isinstance(aweme_info, dict):
                items.append(aweme_info)

        has_more_value = raw.get("has_more", 0)
        try:
            has_more = bool(int(has_more_value))
        except (TypeError, ValueError):
            has_more = bool(has_more_value)

        cursor_value = raw.get("cursor") or raw.get("offset") or 0
        try:
            next_offset = int(cursor_value)
        except (TypeError, ValueError):
            next_offset = 0

        status_code = int(raw.get("status_code") or 0)
        if not items and (status_code or not raw):
            logger.warning(
                "Search returned no items for keyword=%r (status_code=%s, offset=%s). "
                "Possible causes: cookies expired, signature rejected, or query blocked.",
                keyword,
                status_code,
                offset,
            )

        return {
            "items": items,
            "has_more": has_more,
            "max_cursor": next_offset,
            "status_code": status_code,
            "raw": raw,
        }

    @staticmethod
    def _parse_chunked_json_lines(text: str) -> List[Dict[str, Any]]:
        """解析抖音 chunked/stream 返回的多个 JSON 对象，提取视频信息。"""
        items: List[Dict[str, Any]] = []
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            # 跳过 chunked 长度行（纯十六进制字符）
            if all(c in "0123456789abcdefABCDEF" for c in line):
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if not isinstance(obj, dict):
                continue
            for entry in obj.get("data") or []:
                if not isinstance(entry, dict) or entry.get("type") != 1:
                    continue
                aweme_info = entry.get("aweme_info")
                if isinstance(aweme_info, dict):
                    items.append(aweme_info)
        return items

    async def search_aweme_stream(
        self,
        keyword: str,
        *,
        offset: int = 0,
        count: int = 10,
    ) -> Dict[str, Any]:
        """通过 general search stream 接口搜索作品。

        该接口返回 chunked 编码的多段 JSON，常比 search/single 更稳定，
        适合从搜索结果中反查话题 ID。
        """
        params = await self._default_query()
        params.update(
            {
                "keyword": keyword,
                "search_channel": "aweme_general",
                "search_source": "normal_search",
                "query_correct_type": "1",
                "is_filter_search": 0,
                "offset": offset,
                "count": count,
                "disable_rs": 0,
                "enable_history": 1,
                "need_filter_settings": 1,
            }
        )
        signed_url, ua = self.build_signed_path(
            "/aweme/v1/web/general/search/stream/", params
        )
        await self._ensure_session()
        proxy = self.resolve_proxy()
        async with self._session.get(
            signed_url,
            headers={**self.headers, "User-Agent": ua},
            proxy=proxy,
            timeout=30,
        ) as response:
            text = await response.text()
            if response.status != 200:
                logger.warning(
                    "search_aweme_stream returned %s for keyword=%r",
                    response.status,
                    keyword,
                )
                return {"items": [], "has_more": False, "max_cursor": offset, "status_code": response.status, "raw": text}
            items = self._parse_chunked_json_lines(text)
            return {
                "items": items,
                "has_more": len(items) >= count,
                "max_cursor": offset + len(items),
                "status_code": 0,
                "raw": text,
            }

    async def get_aweme_comments(
        self,
        aweme_id: str,
        *,
        cursor: int = 0,
        count: int = 20,
        include_replies: bool = False,
    ) -> Dict[str, Any]:
        """获取作品评论列表（一页）。

        Args:
            aweme_id: 作品 ID
            cursor: 分页游标（首次传 0）
            count: 每页数量（抖音上限一般为 20）
            include_replies: 是否拉取每条评论的二级回复（额外请求）
        Returns:
            归一化后的分页响应 dict，items 为评论列表。
        """
        params = await self._default_query()
        params.update(
            {
                "aweme_id": aweme_id,
                "cursor": cursor,
                "count": count,
                "item_type": "0",
                "insert_ids": "",
                "whale_cut_token": "",
                "cut_version": "1",
                "rcFT": "",
            }
        )
        raw = await self._request_json("/aweme/v1/web/comment/list/", params)
        normalized = self._normalize_paged_response(raw, item_keys=["comments"])

        if include_replies:
            comments = normalized.get("items") or []
            for comment in comments:
                if not isinstance(comment, dict):
                    continue
                comment_id = comment.get("cid") or comment.get("comment_id")
                if not comment_id or int(comment.get("reply_comment_total") or 0) <= 0:
                    continue
                try:
                    reply_page = await self.get_aweme_comment_replies(
                        aweme_id=aweme_id, comment_id=str(comment_id), count=count
                    )
                    comment["_replies"] = reply_page.get("items") or []
                except Exception as exc:  # noqa: BLE001
                    logger.debug("Fetch reply for comment %s failed: %s", comment_id, exc)
        return normalized

    async def get_aweme_comment_replies(
        self,
        *,
        aweme_id: str,
        comment_id: str,
        cursor: int = 0,
        count: int = 20,
    ) -> Dict[str, Any]:
        """获取某条评论的二级回复列表。"""
        params = await self._default_query()
        params.update(
            {
                "item_id": aweme_id,
                "comment_id": comment_id,
                "cursor": cursor,
                "count": count,
            }
        )
        raw = await self._request_json("/aweme/v1/web/comment/list/reply/", params)
        return self._normalize_paged_response(raw, item_keys=["comments"])

    async def resolve_short_url(
        self, short_url: str, *, timeout_seconds: float = 10.0
    ) -> Optional[str]:
        """跟随短链 302，返回最终 URL。失败时返回 None。

        单独设置较短超时（默认 10s），避免被目标站挂死后拖慢整轮下载。
        HTTP 状态码 ≥ 400 时视为解析失败，返回 None 以避免把错误页 URL
        继续喂给下游 parser，从而在下游触发更隐晦的 "Unsupported URL" 噪声。
        """
        proxy = self.resolve_proxy()
        try:
            await self._ensure_session()
            async with self._session.get(
                short_url,
                allow_redirects=True,
                timeout=aiohttp.ClientTimeout(total=timeout_seconds),
                proxy=proxy,
            ) as response:
                final_url = str(response.url)
                if response.status >= 400:
                    logger.warning(
                        "Short URL resolved with HTTP %s (treated as failure): %s -> %s",
                        response.status,
                        short_url,
                        final_url,
                    )
                    return None
                return final_url
        except asyncio.TimeoutError:
            logger.error(
                "Timeout resolving short URL after %.1fs: %s",
                timeout_seconds,
                short_url,
            )
            if self.proxy_pool and proxy:
                self.proxy_pool.mark_failed(proxy)
            return None
        except (
            aiohttp.ClientConnectionError,
            aiohttp.ClientHttpProxyError,
            aiohttp.ServerDisconnectedError,
        ) as exc:
            logger.error("Failed to resolve short URL via proxy %s: %s, error: %s", proxy, short_url, exc)
            if self.proxy_pool and proxy:
                self.proxy_pool.mark_failed(proxy)
            return None
        except Exception as e:
            logger.error("Failed to resolve short URL: %s, error: %s", short_url, e)
            return None

    async def collect_user_post_ids_via_browser(
        self,
        sec_uid: str,
        *,
        expected_count: int = 0,
        headless: bool = False,
        max_scrolls: int = 240,
        idle_rounds: int = 8,
        wait_timeout_seconds: int = 600,
    ) -> List[str]:
        try:
            from playwright.async_api import async_playwright
        except Exception as exc:
            logger.warning("Playwright not available, browser fallback disabled: %s", exc)
            return []

        target_url = f"{self.BASE_URL}/user/{sec_uid}"
        timeout_ms = max(30, int(wait_timeout_seconds)) * 1000
        ids: List[str] = []
        seen: set[str] = set()
        post_api_ids: List[str] = []
        post_api_seen: set[str] = set()
        post_api_aweme_items: Dict[str, Dict[str, Any]] = {}
        post_api_page_hits = 0
        self._browser_post_aweme_items = {}
        self._browser_post_stats = {}

        def _merge(new_ids: List[str]):
            for aweme_id in new_ids:
                if aweme_id and aweme_id not in seen:
                    seen.add(aweme_id)
                    ids.append(aweme_id)

        logger.warning(
            "API翻页受限，启动浏览器兜底采集（可在弹出页面手动通过验证码/登录）：%s",
            target_url,
        )

        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(
                headless=headless,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--disable-dev-shm-usage",
                    "--no-sandbox",
                ],
            )
            context = await browser.new_context(
                user_agent=self.headers.get("User-Agent", ""),
                locale="zh-CN",
                viewport={"width": 1600, "height": 900},
            )
            cookies = self._browser_cookie_payload()
            if cookies:
                await context.add_cookies(cookies)

            page = await context.new_page()
            pending_response_tasks: List[asyncio.Task] = []

            async def _handle_response(response):
                nonlocal post_api_page_hits
                url = response.url or ""
                if "/aweme/v1/web/aweme/post/" not in url:
                    return
                try:
                    data = await response.json()
                except Exception:
                    return
                aweme_items = data.get("aweme_list") if isinstance(data, dict) else None
                if isinstance(aweme_items, list):
                    post_api_page_hits += 1
                    extracted: List[str] = []
                    for item in aweme_items:
                        if not isinstance(item, dict):
                            continue
                        aweme_id = item.get("aweme_id")
                        if not aweme_id:
                            continue
                        aweme_id_str = str(aweme_id)
                        extracted.append(aweme_id_str)
                        if aweme_id_str not in post_api_aweme_items:
                            post_api_aweme_items[aweme_id_str] = item
                    _merge(extracted)
                    for aweme_id in extracted:
                        if aweme_id not in post_api_seen:
                            post_api_seen.add(aweme_id)
                            post_api_ids.append(aweme_id)

            def _on_response(response):
                pending_response_tasks.append(asyncio.create_task(_handle_response(response)))

            page.on("response", _on_response)

            try:
                try:
                    await page.goto(target_url, wait_until="domcontentloaded", timeout=timeout_ms)
                except Exception as exc:
                    logger.warning(
                        "Browser goto timeout or error, continue with current page state: %s",
                        exc,
                    )

                title = ""
                try:
                    title = await page.title()
                except Exception:
                    pass
                if "验证码" in title:
                    if headless:
                        logger.warning(
                            "检测到验证码页面且当前为 headless 模式，无法人工验证。"
                            "请将 browser_fallback.headless 设为 false。"
                        )
                        return []
                    logger.warning("检测到验证码页面，请在浏览器中完成验证，程序会自动继续采集。")
                    await self._wait_for_manual_verification(
                        page, wait_timeout_seconds=wait_timeout_seconds
                    )
                    if not page.is_closed():
                        try:
                            await page.goto(
                                target_url,
                                wait_until="domcontentloaded",
                                timeout=timeout_ms,
                            )
                        except Exception as exc:
                            logger.warning("Reload user page after verification failed: %s", exc)

                try:
                    warmup_seconds = min(20, max(3, int(wait_timeout_seconds)))
                    for _ in range(warmup_seconds):
                        if page.is_closed():
                            logger.warning("Browser page closed during warmup")
                            break
                        _merge(await self._extract_aweme_ids_from_page(page))
                        if ids:
                            break
                        await page.wait_for_timeout(1000)

                    stable_rounds = 0
                    max_scroll_rounds = max(1, int(max_scrolls))
                    idle_stop_rounds = max(1, int(idle_rounds))

                    for _ in range(max_scroll_rounds):
                        if page.is_closed():
                            logger.warning("Browser page closed during scrolling")
                            break
                        await page.mouse.wheel(0, 3800)
                        await page.wait_for_timeout(1200)

                        before = len(ids)
                        _merge(await self._extract_aweme_ids_from_page(page))
                        if len(ids) == before:
                            stable_rounds += 1
                        else:
                            stable_rounds = 0

                        if expected_count > 0 and len(ids) >= expected_count:
                            break
                        if expected_count <= 0 and stable_rounds >= idle_stop_rounds:
                            break
                except Exception as exc:
                    logger.warning(
                        "Browser collection interrupted, use collected ids so far: %s",
                        exc,
                    )
            finally:
                if pending_response_tasks:
                    await asyncio.gather(*pending_response_tasks, return_exceptions=True)
                try:
                    browser_cookies = await context.cookies(self.BASE_URL)
                    self._sync_browser_cookies(browser_cookies)
                except Exception as exc:
                    logger.debug("Sync browser cookies skipped: %s", exc)
                await context.close()
                await browser.close()

        selected_ids: List[str] = []
        selected_seen: set[str] = set()
        for aweme_id in post_api_ids + ids:
            if aweme_id and aweme_id not in selected_seen:
                selected_seen.add(aweme_id)
                selected_ids.append(aweme_id)
        self._browser_post_aweme_items = post_api_aweme_items
        self._browser_post_stats = {
            "merged_ids": len(ids),
            "post_api_ids": len(post_api_ids),
            "selected_ids": len(selected_ids),
            "post_items": len(post_api_aweme_items),
            "post_pages": post_api_page_hits,
        }
        logger.warning(
            "浏览器兜底采集 aweme_id: merged=%s, from_post_api=%s, selected=%s, post_items=%s",
            len(ids),
            len(post_api_ids),
            len(selected_ids),
            len(post_api_aweme_items),
        )
        return selected_ids

    def pop_browser_post_aweme_items(self) -> Dict[str, Dict[str, Any]]:
        items = self._browser_post_aweme_items
        self._browser_post_aweme_items = {}
        return items

    def pop_browser_post_stats(self) -> Dict[str, int]:
        stats = self._browser_post_stats
        self._browser_post_stats = {}
        return stats

    def _browser_cookie_payload(self) -> List[Dict[str, str]]:
        payload: List[Dict[str, str]] = []
        for name, value in self.cookies.items():
            if not name:
                continue
            if name in self._BROWSER_COOKIE_BLOCKLIST:
                continue
            payload.append(
                {
                    "name": str(name),
                    "value": str(value or ""),
                    "url": f"{self.BASE_URL}/",
                }
            )
        return payload

    async def _extract_aweme_ids_from_page(self, page) -> List[str]:
        script = """
() => {
  const result = [];
  const seen = new Set();
  const push = (id) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    result.push(id);
  };

  const collectFrom = (text, pattern) => {
    if (!text) return;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      push(match[1]);
    }
  };

  const links = document.querySelectorAll("a[href]");
  for (const node of links) {
    const href = node.getAttribute("href") || "";
    collectFrom(href, /\\/video\\/(\\d{15,20})/g);
    collectFrom(href, /\\/note\\/(\\d{15,20})/g);
  }

  const html = document.documentElement ? document.documentElement.innerHTML : "";
  collectFrom(html, /"aweme_id":"(\\d{15,20})"/g);
  collectFrom(html, /"group_id":"(\\d{15,20})"/g);

  return result;
}
"""
        try:
            data = await page.evaluate(script)
            if isinstance(data, list):
                return [str(x) for x in data if x]
        except Exception as exc:
            logger.debug("Extract aweme_id from page failed: %s", exc)
        return []

    async def _wait_for_manual_verification(self, page, *, wait_timeout_seconds: int) -> None:
        deadline = asyncio.get_running_loop().time() + max(30, int(wait_timeout_seconds))
        while asyncio.get_running_loop().time() < deadline:
            if page.is_closed():
                logger.warning("Browser page closed while waiting manual verification")
                return
            title = ""
            try:
                title = await page.title()
            except Exception:
                pass
            if "验证码" not in title:
                logger.warning("验证码页面已退出，继续采集。")
                return
            await page.wait_for_timeout(1000)

        logger.warning("等待手动验证超时（%ss），继续按当前页面状态采集。", wait_timeout_seconds)

    def _sync_browser_cookies(self, browser_cookies: List[Dict[str, Any]]) -> None:
        merged: Dict[str, str] = {}
        for cookie in browser_cookies or []:
            if not isinstance(cookie, dict):
                continue
            name = str(cookie.get("name") or "").strip()
            value = str(cookie.get("value") or "").strip()
            domain = str(cookie.get("domain") or "")
            if not name or not value:
                continue
            if "douyin.com" not in domain:
                continue
            merged[name] = value

        if not merged:
            return

        self.cookies.update(merged)
        if self._session and not self._session.closed:
            self._session.cookie_jar.update_cookies(merged)
        logger.warning("Synced %s browser cookie(s) back to API client", len(merged))
