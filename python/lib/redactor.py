"""敏感信息脱敏工具。

用于在日志、IPC 输出、导出文件中对 Cookie、Authorization、手机号、API Key 等
敏感字段进行打码，防止泄露。
"""
from __future__ import annotations

import re
from typing import Any


class SensitiveRedactor:
    """通用敏感信息脱敏器。

    支持对以下信息进行打码：
    - Cookie 中的敏感键（如 sessionid、ttwid、passport_csrf_token、msToken 等）
    - Authorization / Bearer Token
    - 手机号（1[3-9]\d{9}）
    - API Key / AccessKey / SecretKey
    - 长串疑似 token（>=16 字符的 cookie 值）
    """

    # 敏感 cookie 名（不区分大小写）
    SENSITIVE_COOKIE_NAMES = {
        "sessionid",
        "sessionid_ss",
        "sid_tt",
        "sid_guard",
        "uid_tt",
        "uid_tt_ss",
        "passport_auth_status",
        "passport_auth_status_ss",
        "passport_assist_user",
        "passport_csrf_token",
        "ttwid",
        "msToken",
        "xg_player_user_id",
        "odin_tt",
        "d_ticket",
        "csrftoken",
    }

    # 敏感 HTTP 头名
    SENSITIVE_HEADERS = {"authorization", "cookie", "x-api-key", "api-key"}

    # 字典中需要脱敏的键名（模糊匹配）
    SENSITIVE_KEYS = {
        "cookie",
        "cookies",
        "authorization",
        "api_key",
        "apikey",
        "api-key",
        "accesskey",
        "access_key",
        "accesskeyid",
        "access_key_id",
        "accesskeysecret",
        "access_key_secret",
        "secretkey",
        "secret_key",
        "secret_id",
        "secretid",
        "token",
        "sessionid",
        "password",
        "passwd",
        "pwd",
    }

    @classmethod
    def redact_text(cls, text: Any) -> str:
        """对任意文本进行脱敏。"""
        if text is None:
            return ""
        if not isinstance(text, str):
            text = str(text)
        text = cls._redact_phone(text)
        text = cls._redact_cookie_string(text)
        text = cls._redact_authorization(text)
        text = cls._redact_key_value_pairs(text)
        return text

    @classmethod
    def redact_dict(cls, obj: dict | None, extra_keys: set[str] | None = None) -> dict:
        """对字典中指定键的值进行脱敏，返回新字典。"""
        if not obj:
            return obj or {}
        sensitive = cls.SENSITIVE_KEYS | (extra_keys or set())
        result = {}
        for k, v in obj.items():
            key_lower = str(k).lower().replace("_", "").replace("-", "")
            if key_lower in sensitive or str(k).lower() in sensitive:
                result[k] = cls._mask_value(v)
            elif isinstance(v, dict):
                result[k] = cls.redact_dict(v, extra_keys)
            elif isinstance(v, list):
                result[k] = [cls.redact_dict(i, extra_keys) if isinstance(i, dict) else cls.redact_text(i) for i in v]
            elif isinstance(v, str):
                result[k] = cls.redact_text(v)
            else:
                result[k] = v
        return result

    @staticmethod
    def _mask_value(value: Any) -> str:
        """对单个值进行简短打码：保留前 4 + 后 4，中间 ***。"""
        s = str(value) if value is not None else ""
        if len(s) <= 8:
            return "***"
        return s[:4] + "***" + s[-4:]

    @classmethod
    def _redact_phone(cls, text: str) -> str:
        return re.sub(r"1[3-9]\d{9}", lambda m: m.group(0)[:3] + "****" + m.group(0)[-4:], text)

    @classmethod
    def _redact_cookie_string(cls, text: str) -> str:
        """对 Cookie: name=value; ... 或 name=value; name=value 格式脱敏。"""

        def replace_cookie(match: re.Match) -> str:
            name = match.group(1).strip()
            sep = match.group(2)
            value = match.group(3)
            if name.lower() in {n.lower() for n in cls.SENSITIVE_COOKIE_NAMES} or len(value) >= 16:
                return f"{name}{sep}***"
            return match.group(0)

        # 匹配 name=value; 或 name=value（结尾）
        return re.sub(r"([a-zA-Z0-9_-]+)(=)([^;\s]+)", replace_cookie, text)

    @classmethod
    def _redact_authorization(cls, text: str) -> str:
        # Authorization: Bearer xxx
        text = re.sub(r"(?i)(authorization\s*:\s*)([^\s]+)", r"\1***", text)
        text = re.sub(r"(?i)(bearer\s+)([^\s]+)", r"\1***", text)
        return text

    @classmethod
    def _redact_key_value_pairs(cls, text: str) -> str:
        """对 key=value 中明显敏感的键脱敏。"""

        def replace_sensitive(match: re.Match) -> str:
            key = match.group(1).lower().replace("_", "").replace("-", "")
            sep = match.group(2)
            if key in {
                "accesskeyid",
                "accesskeysecret",
                "secretid",
                "secretkey",
                "apikey",
                "api_key",
            }:
                return f"{match.group(1)}{sep}***"
            return match.group(0)

        return re.sub(r"([a-zA-Z0-9_-]+)(=)([^\s&;]+)", replace_sensitive, text)


if __name__ == "__main__":
    # 简单自检
    sample = (
        "Cookie: sessionid=abc123xyz; ttwid=verylongtokentokentoken; "
        "Authorization: Bearer secret-token-here; "
        "phone=13800138000; AccessKeyId=LTAIabcdefgh1234"
    )
    print(SensitiveRedactor.redact_text(sample))
