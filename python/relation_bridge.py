"""批量关注/取关桥接脚本。

读取任务 JSON，调用相邻 douyin-downloader 的 RelationService，按 JSON Lines
协议输出进度、日志和结果。
"""
from __future__ import annotations

import asyncio
from typing import Any

from lib.bridge import BridgeContext, BridgeOutput, safe_main
from lib.compat import ensure_backend_path

ensure_backend_path()

from core.api_client import DouyinAPIClient, LoginRequiredError  # noqa: E402
from core.relation_service import RelationService  # noqa: E402
from utils.cookie_utils import parse_cookie_header  # noqa: E402


async def _run(ctx: BridgeContext, job: dict[str, Any], out: BridgeOutput) -> None:
    action = job.get("action")
    sec_uids = job.get("secUids", [])
    cookies_raw = job.get("cookies", "")
    config = job.get("config") or {}

    if action not in {"follow", "unfollow"}:
        raise ValueError(f"action 必须是 follow 或 unfollow， got {action!r}")
    if not isinstance(sec_uids, list) or not sec_uids:
        raise ValueError("secUids 为空")

    cookies = parse_cookie_header(cookies_raw) if isinstance(cookies_raw, str) else dict(cookies_raw or {})
    if not cookies:
        raise ValueError("Cookie 为空")

    anti_csrf = cookies.get("passport_csrf_token") or cookies.get("passport_csrf_token_default", "")
    if not anti_csrf:
        out.log("警告：Cookie 中未找到 passport_csrf_token，关注/取关接口可能会失败", level="warning")

    proxy = str(job.get("proxy") or "").strip() or None
    min_delay = float(config.get("minDelay", 2.0))
    max_delay = float(config.get("maxDelay", 4.0))
    dry_run = bool(config.get("dryRun", False))

    out.log(f"开始批量{ '关注' if action == 'follow' else '取关' }，共 {len(sec_uids)} 个用户")
    if dry_run:
        out.log("已启用 dryRun，不会真正调用接口")

    async with DouyinAPIClient(cookies, proxy=proxy) as api:
        service = RelationService(api, min_delay=min_delay, max_delay=max_delay)
        total = len(sec_uids)
        success_count = 0
        failed_count = 0
        skipped_count = 0
        results: list[dict[str, Any]] = []

        async for result in service.iter_batch(sec_uids, action, dry_run=dry_run):
            result_dict = result.to_dict()
            results.append(result_dict)
            success_count += 1 if result.success else 0
            failed_count += 1 if (not result.success and result.error) else 0
            skipped_count += 1 if (not result.success and not result.error) else 0

            msg = (
                f"{result.sec_uid[:20]}... "
                f"{'成功' if result.success else '失败'}"
            )
            if result.status_msg:
                msg += f" ({result.status_msg})"
            if result.error:
                msg += f" - {result.error}"
            out.log(msg, level="info" if result.success else "warning")
            out.progress(
                current=success_count + failed_count + skipped_count,
                total=total,
                message=f"成功 {success_count} / 失败 {failed_count} / 跳过 {skipped_count}",
            )

        summary = {
            "action": action,
            "total": total,
            "success": success_count,
            "failed": failed_count,
            "skipped": skipped_count,
            "results": results,
        }
        out.log(f"批量{ '关注' if action == 'follow' else '取关' }完成：{summary}")
        out.finished(success=(failed_count == 0), data={"summary": summary})


def main(ctx: BridgeContext, job: dict[str, Any], out: BridgeOutput) -> None:
    try:
        asyncio.run(_run(ctx, job, out))
    except LoginRequiredError as exc:
        out.error(f"登录已失效（{exc.status_code}）：{exc.status_msg}")


if __name__ == "__main__":
    safe_main(main)
