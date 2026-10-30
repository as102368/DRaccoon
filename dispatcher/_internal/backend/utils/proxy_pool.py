"""代理池：维护代理列表，下载前探活并按延迟排序，失败时移除并切换。"""

from __future__ import annotations

import asyncio
import re
import time
from typing import Any, Dict, List, Optional, Sequence

import aiohttp

from utils.logger import setup_logger

logger = setup_logger("ProxyPool")

# 轻量级探活目标：robots.txt 体积小、无登录态、返回稳定。
DEFAULT_PROBE_URL = "https://www.douyin.com/robots.txt"
DEFAULT_PROBE_TIMEOUT = 10.0


class ProxyPool:
    """管理一组代理，按延迟排序，并在失败时自动切换。

    用法::

        pool = ProxyPool([
            "http://127.0.0.1:7890",
            "socks5h://127.0.0.1:1080",
        ])
        await pool.probe()
        proxy = pool.get_proxy()      # 返回延迟最低的可用代理
        pool.mark_failed(proxy)       # 失败后移除并切换
    """

    def __init__(
        self,
        proxies: Optional[Sequence[str]] = None,
        probe_url: str = DEFAULT_PROBE_URL,
        probe_timeout: float = DEFAULT_PROBE_TIMEOUT,
    ):
        self.probe_url = probe_url
        self.probe_timeout = probe_timeout
        self._latency: Dict[str, float] = {}
        self._healthy: List[str] = []
        self._failed: List[str] = []
        if proxies:
            for proxy in proxies:
                self.add(proxy)

    @classmethod
    def from_string(cls, value: str, **kwargs) -> "ProxyPool":
        """从逗号/换行分隔的字符串解析代理列表。"""
        if not value or not value.strip():
            return cls([], **kwargs)
        proxies = [p.strip() for p in re.split(r"[\n,]", value) if p.strip()]
        return cls(proxies, **kwargs)

    @classmethod
    def from_config(cls, config: Any, **kwargs) -> Optional["ProxyPool"]:
        """根据配置构造代理池；单条代理返回 None，由调用方使用 proxy 字符串。"""
        if config is None:
            return None
        getter = getattr(config, "get", lambda _k, _d=None: None)

        proxy_pool = getter("proxy_pool")
        if isinstance(proxy_pool, list) and proxy_pool:
            return cls(proxy_pool, **kwargs)

        proxy = getter("proxy")
        if isinstance(proxy, str) and ("," in proxy or "\n" in proxy):
            return cls.from_string(proxy, **kwargs)

        return None

    @staticmethod
    def single_proxy_from_config(config: Any) -> Optional[str]:
        """当配置中只有一条代理时返回该字符串，否则返回 None。"""
        if config is None:
            return None
        proxy = getattr(config, "get", lambda _k, _d=None: None)("proxy")
        if isinstance(proxy, str):
            proxy = proxy.strip()
            if proxy and "," not in proxy and "\n" not in proxy:
                return proxy
        return None

    def add(self, proxy: str) -> None:
        """添加代理；已存在则忽略。"""
        proxy = (proxy or "").strip()
        if not proxy or proxy in self._latency:
            return
        self._latency[proxy] = float("inf")
        self._healthy.append(proxy)

    @property
    def healthy(self) -> List[str]:
        """当前可用代理列表（已按延迟升序排列）。"""
        return list(self._healthy)

    @property
    def failed(self) -> List[str]:
        """已被标记为失败的代理列表。"""
        return list(self._failed)

    def __len__(self) -> int:
        return len(self._healthy)

    def __bool__(self) -> bool:
        return bool(self._healthy)

    def get_proxy(self) -> Optional[str]:
        """返回当前延迟最低的可用代理；没有可用代理时返回 None（直连）。"""
        if self._healthy:
            return self._healthy[0]
        return None

    def mark_failed(self, proxy: Optional[str]) -> None:
        """将代理从可用池移除并切换到下一个。"""
        if not proxy:
            return
        proxy = proxy.strip()
        if proxy not in self._latency:
            return
        if proxy in self._healthy:
            self._healthy.remove(proxy)
        if proxy not in self._failed:
            self._failed.append(proxy)
        logger.warning(
            "代理不可用，已从池中移除: %s (剩余 %d 个可用)",
            proxy,
            len(self._healthy),
        )

    async def probe(self, timeout: Optional[float] = None) -> List[str]:
        """并发探活所有代理，按响应时间排序，返回可用代理列表。"""
        timeout = timeout or self.probe_timeout
        if not self._latency:
            return []

        semaphore = asyncio.Semaphore(20)
        proxies = list(self._latency.keys())
        tasks = [self._probe_one(proxy, timeout, semaphore) for proxy in proxies]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        self._healthy = []
        for proxy, result in zip(proxies, results):
            if isinstance(result, Exception):
                logger.debug("代理探活失败 %s: %s", proxy, result)
                continue
            latency, ok = result
            if ok:
                self._latency[proxy] = latency
                self._healthy.append(proxy)

        self._healthy.sort(key=lambda p: self._latency.get(p, float("inf")))
        self._failed = [p for p in self._latency if p not in self._healthy]

        logger.info(
            "代理探活完成: %d/%d 可用, 最佳延迟 %.3fs",
            len(self._healthy),
            len(self._latency),
            self._latency.get(self._healthy[0]) if self._healthy else 0.0,
        )
        return self._healthy

    async def _probe_one(
        self,
        proxy: str,
        timeout: float,
        semaphore: asyncio.Semaphore,
    ):
        async with semaphore:
            start = time.perf_counter()
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    self.probe_url,
                    proxy=proxy,
                    timeout=aiohttp.ClientTimeout(total=timeout),
                    ssl=False,
                ) as response:
                    await response.read()
                    latency = time.perf_counter() - start
                    return latency, response.status < 400
