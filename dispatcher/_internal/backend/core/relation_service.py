from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator, Dict, List, Optional

from control import RateLimiter
from core.api_client import DouyinAPIClient, LoginRequiredError
from utils.logger import setup_logger

logger = setup_logger("RelationService")


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
            "location": "relation_service.py",
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


@dataclass
class RelationResult:
    """Result of a single follow/unfollow operation."""

    sec_uid: str
    action: str  # "follow" or "unfollow"
    success: bool = False
    status_code: int = 0
    status_msg: str = ""
    error: str = ""
    dry_run: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "sec_uid": self.sec_uid,
            "action": self.action,
            "success": self.success,
            "status_code": self.status_code,
            "status_msg": self.status_msg,
            "error": self.error,
            "dry_run": self.dry_run,
        }


@dataclass
class BatchRelationSummary:
    """Aggregated result of a batch follow/unfollow run."""

    action: str
    total: int = 0
    success: int = 0
    failed: int = 0
    skipped: int = 0
    results: List[RelationResult] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "action": self.action,
            "total": self.total,
            "success": self.success,
            "failed": self.failed,
            "skipped": self.skipped,
            "results": [r.to_dict() for r in self.results],
        }


class RelationService:
    """Batch follow/unfollow operations with rate limiting and safety guards.

    The service wraps :py:meth:`DouyinAPIClient.follow_user` and
    :py:meth:`DouyinAPIClient.unfollow_user`. It enforces a minimum delay
    between requests, stops on authentication errors, and exposes both a
    per-user async generator and a high-level batch helper.
    """

    DEFAULT_MIN_DELAY = 2.0
    DEFAULT_MAX_DELAY = 4.0
    DEFAULT_LIMIT = 0  # 0 means no limit

    def __init__(
        self,
        api_client: DouyinAPIClient,
        *,
        rate_limiter: Optional[RateLimiter] = None,
        min_delay: float = DEFAULT_MIN_DELAY,
        max_delay: float = DEFAULT_MAX_DELAY,
    ):
        self.api = api_client
        self.rate_limiter = rate_limiter
        self.min_delay = max(0.0, float(min_delay))
        self.max_delay = max(self.min_delay, float(max_delay))

    def _validate_sec_uids(self, sec_uids: List[str]) -> List[str]:
        """Return a deduplicated list of non-empty sec_uids."""
        seen: Dict[str, None] = {}
        valid: List[str] = []
        for sec_uid in sec_uids:
            sec_uid = str(sec_uid or "").strip()
            if not sec_uid or sec_uid in seen:
                continue
            seen[sec_uid] = None
            valid.append(sec_uid)
        return valid

    async def _apply_delay(self) -> None:
        """Wait between operations to avoid triggering anti-bot measures."""
        if self.rate_limiter is not None:
            await self.rate_limiter.acquire()
            return
        delay = random.uniform(self.min_delay, self.max_delay)
        if delay > 0:
            await asyncio.sleep(delay)

    async def _execute_single(
        self,
        sec_uid: str,
        action: str,
        *,
        dry_run: bool = False,
    ) -> RelationResult:
        """Execute or simulate one follow/unfollow call."""
        result = RelationResult(sec_uid=sec_uid, action=action)
        if dry_run:
            result.success = True
            result.dry_run = True
            result.status_msg = "dry-run"
            return result

        try:
            if action == "follow":
                resp = await self.api.follow_user(sec_uid)
            elif action == "unfollow":
                resp = await self.api.unfollow_user(sec_uid)
            else:
                result.error = f"unknown action: {action}"
                return result
        except LoginRequiredError as exc:
            raise
        except Exception as exc:
            logger.warning("%s %s failed: %s", action, sec_uid, exc)
            result.error = str(exc)
            return result

        if not isinstance(resp, dict):
            result.error = "empty or invalid response"
            return result

        result.status_code = int(resp.get("status_code") or 0)
        result.status_msg = str(resp.get("status_msg") or "")

        # Status code 0 usually means success; some endpoints return 2096 or
        # other codes when the relationship already matches the requested state.
        # We treat known "already in target state" codes as success to make
        # idempotent batches safe.
        already_state_codes = {2096, 2097, 2100}
        if result.status_code == 0 or result.status_code in already_state_codes:
            result.success = True
        else:
            result.error = result.status_msg or f"status_code={result.status_code}"
        # #region debug-point C:result-parse
        _debug_log("C", f"parsed {action} result sec_uid={sec_uid}", {
            "status_code": result.status_code,
            "status_msg": result.status_msg,
            "success": result.success,
            "error": result.error,
        })
        # #endregion
        return result

    async def iter_batch(
        self,
        sec_uids: List[str],
        action: str,
        *,
        limit: int = DEFAULT_LIMIT,
        dry_run: bool = False,
    ) -> AsyncGenerator[RelationResult, None]:
        """Yield per-user results for a batch follow/unfollow operation.

        Args:
            sec_uids: Target user sec_uids.
            action: ``"follow"`` or ``"unfollow"``.
            limit: Maximum number of users to process (0 = unlimited).
            dry_run: If True, do not call the API; mark all results as success.
        """
        if action not in {"follow", "unfollow"}:
            raise ValueError(f"action must be 'follow' or 'unfollow', got {action!r}")

        targets = self._validate_sec_uids(sec_uids)
        if limit and limit > 0:
            targets = targets[:limit]

        for index, sec_uid in enumerate(targets, 1):
            if index > 1:
                await self._apply_delay()
            result = await self._execute_single(sec_uid, action, dry_run=dry_run)
            yield result

    async def batch_follow(
        self,
        sec_uids: List[str],
        *,
        limit: int = DEFAULT_LIMIT,
        dry_run: bool = False,
    ) -> BatchRelationSummary:
        """Follow a list of users safely.

        Returns a summary with per-user results. Already-followed users are
        counted as success where Douyin reports an "already in state" code.
        """
        summary = BatchRelationSummary(action="follow")
        async for result in self.iter_batch(
            sec_uids, "follow", limit=limit, dry_run=dry_run
        ):
            summary.total += 1
            summary.results.append(result)
            if result.success:
                summary.success += 1
            elif result.error:
                summary.failed += 1
            else:
                summary.skipped += 1
        return summary

    async def batch_unfollow(
        self,
        sec_uids: List[str],
        *,
        limit: int = DEFAULT_LIMIT,
        dry_run: bool = False,
    ) -> BatchRelationSummary:
        """Unfollow a list of users safely.

        Returns a summary with per-user results. Already-unfollowed users are
        counted as success where Douyin reports an "already in state" code.
        """
        summary = BatchRelationSummary(action="unfollow")
        async for result in self.iter_batch(
            sec_uids, "unfollow", limit=limit, dry_run=dry_run
        ):
            summary.total += 1
            summary.results.append(result)
            if result.success:
                summary.success += 1
            elif result.error:
                summary.failed += 1
            else:
                summary.skipped += 1
        return summary
