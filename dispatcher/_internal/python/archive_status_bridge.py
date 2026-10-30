"""查询已下载作者的 sec_uid 状态。

用于替代基于文件夹名的档案匹配，解决 folderstyle=false 或文件夹名与昵称不一致时
getDownloadStatus 误判的问题。
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from lib.bridge import BridgeContext, BridgeOutput, safe_main
from lib.compat import ensure_backend_path

ensure_backend_path()

from storage import Database  # noqa: E402


async def _run(ctx: BridgeContext, job: dict[str, Any], out: BridgeOutput) -> None:
    db_path = job.get("dbPath")
    sec_uids = job.get("secUids", [])
    if not db_path or not isinstance(sec_uids, list) or not sec_uids:
        out.finished(success=True, data={})
        return

    db_file = Path(db_path)
    if not db_file.exists():
        out.finished(success=True, data={})
        return

    database = Database(str(db_file))
    try:
        await database.initialize()
        conn = await database._get_conn()

        placeholders = ",".join("?" * len(sec_uids))

        # 1) aweme 表：作者有作品被下载且文件路径非空
        cursor = await conn.execute(
            f"""
            SELECT author_sec_uid AS sec_uid, MAX(download_time) AS dt
            FROM aweme
            WHERE author_sec_uid IN ({placeholders})
              AND file_path IS NOT NULL AND file_path != ''
            GROUP BY author_sec_uid
            """,
            tuple(sec_uids),
        )
        aweme_rows = await cursor.fetchall()

        # 2) download_history 表：per-aweme 或 user/mix/music/live 级别记录
        cursor = await conn.execute(
            f"""
            SELECT sec_uid, MAX(download_time) AS dt
            FROM download_history
            WHERE sec_uid IN ({placeholders})
              AND status = 'success'
              AND (
                  (aweme_id IS NOT NULL AND aweme_id != '')
                  OR (url_type IN ('user', 'mix', 'music', 'live'))
              )
            GROUP BY sec_uid
            """,
            tuple(sec_uids),
        )
        history_rows = await cursor.fetchall()

        result: dict[str, dict[str, Any]] = {}
        for sec_uid, dt in aweme_rows:
            result[sec_uid] = {"status": "downloaded", "date": _fmt_date(dt)}
        for sec_uid, dt in history_rows:
            existing = result.get(sec_uid)
            date = _fmt_date(dt)
            if existing is None or date > existing.get("date", ""):
                result[sec_uid] = {"status": "downloaded", "date": date}

        out.finished(success=True, data=result)
    except Exception as exc:
        out.error(f"查询下载状态失败：{exc}")
    finally:
        try:
            await database.close()
        except Exception:
            pass


def _fmt_date(ts: Any) -> str:
    if not ts:
        return ""
    if isinstance(ts, int):
        from datetime import datetime
        return datetime.fromtimestamp(ts).strftime("%Y-%m-%d")
    return str(ts)[:10]


def main(ctx: BridgeContext, job: dict[str, Any], out: BridgeOutput) -> None:
    asyncio.run(_run(ctx, job, out))


if __name__ == "__main__":
    safe_main(main)
