import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional

from utils.cookie_utils import sanitize_cookies
from utils.logger import setup_logger

logger = setup_logger("CookieManager")


class CookieManager:
    DEFAULT_COOKIE_FILE = ".cookies.json"

    def __init__(
        self,
        cookie_file: str = DEFAULT_COOKIE_FILE,
        profile: Optional[str] = None,
    ):
        self.profile = profile
        self.cookie_file = self._resolve_cookie_file(cookie_file, profile)
        self.cookies: Dict[str, str] = {}

    @staticmethod
    def _resolve_cookie_file(cookie_file: str, profile: Optional[str]) -> Path:
        path = Path(cookie_file)
        if not profile:
            return path
        suffix = path.suffix
        stem = path.name[: -len(suffix)] if suffix else path.name
        return path.with_name(f"{stem}.{profile}{suffix}")

    @classmethod
    def list_profiles(cls, cookie_file: str = DEFAULT_COOKIE_FILE) -> List[str]:
        path = Path(cookie_file)
        suffix = path.suffix
        stem = path.name[: -len(suffix)] if suffix else path.name
        pattern = f"{stem}.*{suffix}"
        profiles: set[str] = set()
        for candidate in path.parent.glob(pattern):
            name = candidate.name
            if not name.startswith(stem + "."):
                continue
            middle = name[len(stem) + 1 : -len(suffix)] if suffix else name[len(stem) + 1 :]
            if middle:
                profiles.add(middle)
        return sorted(profiles)

    def set_cookies(self, cookies: Dict[str, str]):
        self.cookies = sanitize_cookies(cookies)
        self._save_cookies()

    def get_cookies(self) -> Dict[str, str]:
        if not self.cookies:
            self._load_cookies()
        return self.cookies

    def get_cookie_string(self) -> str:
        cookies = self.get_cookies()
        return "; ".join([f"{k}={v}" for k, v in cookies.items()])

    def _save_cookies(self):
        try:
            # The cookie file lives alongside the config.yml in the
            # per-user app-data dir. The directory is normally created by
            # Electron (for config.yml) well before login, but create it
            # defensively so a first-run login can't lose cookies to a
            # missing parent dir.
            self.cookie_file.parent.mkdir(parents=True, exist_ok=True)
            with open(self.cookie_file, "w", encoding="utf-8") as f:
                json.dump(self.cookies, f, ensure_ascii=False, indent=2)
            # Restrict perms to owner-only on POSIX. Windows uses ACL-based
            # isolation so chmod is a no-op there.
            if sys.platform != "win32":
                try:
                    os.chmod(self.cookie_file, 0o600)
                except OSError as exc:
                    logger.warning("Could not chmod cookie file: %s", exc)
        except Exception as e:
            logger.error("Failed to save cookies to %s: %s", self.cookie_file, e)

    def _load_cookies(self):
        if not self.cookie_file.exists():
            return

        try:
            with open(self.cookie_file, "r", encoding="utf-8") as f:
                self.cookies = sanitize_cookies(json.load(f))
        except Exception as e:
            logger.error("Failed to load cookies: %s", e)

    def validate_cookies(self) -> bool:
        # 扫码登录后不一定能拿到 odin_tt（它是设备/匿名标识），
        # 但 ttwid 与 passport_csrf_token 加上 sessionid 通常已足够维持登录态。
        required_keys = {"ttwid", "passport_csrf_token"}
        cookies = self.get_cookies()
        missing = [key for key in required_keys if key not in cookies or not cookies.get(key)]
        if missing:
            logger.warning("Cookie validation failed, missing: %s", ", ".join(missing))
            return False
        if not cookies.get("odin_tt"):
            logger.info("odin_tt not found, login may still work without it")
        if not cookies.get("msToken"):
            logger.info("msToken not found, it will be generated automatically if needed")
        return True

    def clear_cookies(self):
        self.cookies = {}
        if self.cookie_file.exists():
            self.cookie_file.unlink()
