import asyncio
from typing import Any, Callable, Optional, TypeVar

from utils.logger import setup_logger

logger = setup_logger("RetryHandler")

T = TypeVar("T")


class RetryHandler:
    def __init__(self, max_retries: int = 3, config: Optional[Any] = None):
        # max_retries = number of retries AFTER the initial attempt;
        # total attempts = max_retries + 1.
        # 传入 config 后每次执行前动态读取 retry_times，保存后立即生效。
        self._max_retries = max(int(max_retries), 0)
        self._config = config
        self.retry_delays = [1, 2, 5]

    @property
    def max_retries(self) -> int:
        if self._config is not None:
            try:
                val = self._config.get("retry_times")
                if val is not None:
                    return max(int(val), 0)
            except Exception:
                pass
        return self._max_retries

    async def execute_with_retry(self, func: Callable[..., T], *args, **kwargs) -> T:
        max_retries = self.max_retries
        last_error = None
        total_attempts = max_retries + 1

        for attempt in range(total_attempts):
            try:
                return await func(*args, **kwargs)
            except Exception as e:
                last_error = e
                if attempt < max_retries:
                    delay = self.retry_delays[min(attempt, len(self.retry_delays) - 1)]
                    logger.warning(
                        "Attempt %d failed: %s, retrying in %ds...", attempt + 1, e, delay
                    )
                    await asyncio.sleep(delay)

        logger.error("All %d attempts failed: %s", total_attempts, last_error)
        raise last_error
