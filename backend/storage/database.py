import asyncio
import json
from datetime import datetime
from typing import Any, Dict, List, Optional, Set

import aiosqlite


class Database:
    def __init__(self, db_path: str = "dy_downloader.db"):
        self.db_path = db_path
        self._initialized = False
        self._conn: Optional[aiosqlite.Connection] = None
        # 延迟到首次 _get_conn 调用时在当前 event loop 上创建 Lock，
        # 避免在 __init__ 阶段抢到错误的 loop。
        self._conn_lock: Optional[asyncio.Lock] = None

    async def _get_conn(self) -> aiosqlite.Connection:
        if self._conn is not None:
            return self._conn
        if self._conn_lock is None:
            self._conn_lock = asyncio.Lock()
        async with self._conn_lock:
            if self._conn is None:
                self._conn = await aiosqlite.connect(self.db_path)
        return self._conn

    async def initialize(self):
        if self._initialized:
            return

        db = await self._get_conn()

        # WAL gives concurrent reader/writer; NORMAL avoids fsync on every commit
        # (loses at most last few txns on power loss — acceptable for download history).
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute("PRAGMA synchronous=NORMAL")

        await db.execute("""
            CREATE TABLE IF NOT EXISTS aweme (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                aweme_id TEXT UNIQUE NOT NULL,
                aweme_type TEXT NOT NULL,
                title TEXT,
                author_id TEXT,
                author_name TEXT,
                create_time INTEGER,
                download_time INTEGER,
                file_path TEXT,
                metadata TEXT
            )
        """)

        await db.execute("""
            CREATE TABLE IF NOT EXISTS download_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                aweme_id TEXT,
                sec_uid TEXT,
                mode TEXT,
                status TEXT NOT NULL DEFAULT 'success',
                file_path TEXT,
                error_message TEXT,
                url TEXT,
                url_type TEXT,
                download_time INTEGER,
                total_count INTEGER,
                success_count INTEGER,
                config TEXT,
                created_at INTEGER,
                updated_at INTEGER
            )
        """)

        await db.execute("""
            CREATE TABLE IF NOT EXISTS transcript_job (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                aweme_id TEXT NOT NULL,
                video_path TEXT NOT NULL,
                transcript_dir TEXT,
                text_path TEXT,
                json_path TEXT,
                model TEXT NOT NULL,
                status TEXT NOT NULL,
                skip_reason TEXT,
                error_message TEXT,
                created_at INTEGER,
                updated_at INTEGER,
                UNIQUE(aweme_id, video_path, model)
            )
        """)

        # `job` persists the task-center JobManager records so they survive
        # a sidecar restart. Only terminal jobs (success / failed / cancelled)
        # are ever written here — see server/jobs.py. `last_retry_summary`
        # and `overrides` are stored as JSON text.
        await db.execute("""
            CREATE TABLE IF NOT EXISTS job (
                job_id              TEXT PRIMARY KEY,
                url                 TEXT NOT NULL,
                status              TEXT NOT NULL,
                created_at          TEXT NOT NULL,
                started_at          TEXT,
                finished_at         TEXT,
                total               INTEGER NOT NULL DEFAULT 0,
                success             INTEGER NOT NULL DEFAULT 0,
                failed              INTEGER NOT NULL DEFAULT 0,
                skipped             INTEGER NOT NULL DEFAULT 0,
                error               TEXT,
                author_nickname     TEXT,
                author_sec_uid      TEXT,
                retry_count         INTEGER NOT NULL DEFAULT 0,
                last_retry_at       TEXT,
                last_retry_summary  TEXT,
                retry_history       TEXT,
                overrides           TEXT
            )
        """)

        await db.execute("CREATE INDEX IF NOT EXISTS idx_aweme_id ON aweme(aweme_id)")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_author_id ON aweme(author_id)")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_download_time ON aweme(download_time)")
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_transcript_aweme_id ON transcript_job(aweme_id)"
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_transcript_status ON transcript_job(status)"
        )
        await db.execute("CREATE INDEX IF NOT EXISTS idx_job_created_at ON job(created_at)")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_job_status ON job(status)")

        # Following list synced from the logged-in account.
        await db.execute("""
            CREATE TABLE IF NOT EXISTS following (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sec_uid TEXT UNIQUE NOT NULL,
                nickname TEXT,
                avatar TEXT,
                signature TEXT,
                follower_count INTEGER NOT NULL DEFAULT 0,
                following_count INTEGER NOT NULL DEFAULT 0,
                aweme_count INTEGER NOT NULL DEFAULT 0,
                unique_id TEXT,
                extra TEXT,
                create_time INTEGER NOT NULL DEFAULT 0,
                follow_order INTEGER,
                updated_at INTEGER NOT NULL
            )
        """)
        await db.execute("CREATE INDEX IF NOT EXISTS idx_following_sec_uid ON following(sec_uid)")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_following_updated_at ON following(updated_at)")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_following_follow_order ON following(follow_order)")

        # Incremental migration: add missing columns to legacy following tables.
        cursor = await db.execute("PRAGMA table_info(following)")
        existing_following_columns = {row[1] for row in await cursor.fetchall()}
        if "create_time" not in existing_following_columns:
            await db.execute("ALTER TABLE following ADD COLUMN create_time INTEGER NOT NULL DEFAULT 0")
        if "aweme_count" not in existing_following_columns:
            await db.execute("ALTER TABLE following ADD COLUMN aweme_count INTEGER NOT NULL DEFAULT 0")
        if "follow_order" not in existing_following_columns:
            await db.execute("ALTER TABLE following ADD COLUMN follow_order INTEGER")

        # 历史遗留：following.create_time 曾被误用作“关注时间”展示，实际对应的是
        # 抖音账号/作品时间。现在统一重置为 0，避免旧数据继续误导用户；后续同步
        # 也会将 create_time 覆盖为 0，真正的关注顺序由 follow_order 维护。
        await db.execute("UPDATE following SET create_time = 0 WHERE create_time > 0")

        # Sync cursor state for incremental pagination (collections, mixes, etc.).
        await db.execute("""
            CREATE TABLE IF NOT EXISTS sync_cursor (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                cursor INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL,
                UNIQUE(kind, entity_id)
            )
        """)
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_sync_cursor_lookup ON sync_cursor(kind, entity_id)"
        )

        # Incremental migration: add author_sec_uid column to legacy aweme tables.
        # Running initialize() twice must be a no-op.
        cursor = await db.execute("PRAGMA table_info(aweme)")
        existing_columns = {row[1] for row in await cursor.fetchall()}
        if "author_sec_uid" not in existing_columns:
            await db.execute("ALTER TABLE aweme ADD COLUMN author_sec_uid TEXT")

        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_aweme_author_sec_uid ON aweme(author_sec_uid)"
        )

        # Incremental migration: add retry_history column to legacy job
        # tables so pre-existing DB files (created before retry-history
        # persistence landed) continue to work. NULL for old rows; the
        # restore path maps NULL -> [] so the renderer gracefully shows
        # no history for those jobs.
        cursor = await db.execute("PRAGMA table_info(job)")
        existing_job_columns = {row[1] for row in await cursor.fetchall()}
        if "retry_history" not in existing_job_columns:
            await db.execute("ALTER TABLE job ADD COLUMN retry_history TEXT")

        # Incremental migration: extend legacy download_history tables with the
        # per-aweme deduplication columns added for (aweme_id, sec_uid, mode).
        cursor = await db.execute("PRAGMA table_info(download_history)")
        existing_history_columns = {row[1] for row in await cursor.fetchall()}
        for col, ddl in (
            ("aweme_id", "ALTER TABLE download_history ADD COLUMN aweme_id TEXT"),
            ("sec_uid", "ALTER TABLE download_history ADD COLUMN sec_uid TEXT"),
            ("mode", "ALTER TABLE download_history ADD COLUMN mode TEXT"),
            ("status", "ALTER TABLE download_history ADD COLUMN status TEXT NOT NULL DEFAULT 'success'"),
            ("file_path", "ALTER TABLE download_history ADD COLUMN file_path TEXT"),
            ("error_message", "ALTER TABLE download_history ADD COLUMN error_message TEXT"),
            ("created_at", "ALTER TABLE download_history ADD COLUMN created_at INTEGER"),
            ("updated_at", "ALTER TABLE download_history ADD COLUMN updated_at INTEGER"),
        ):
            if col not in existing_history_columns:
                await db.execute(ddl)

        # Create the per-aweme deduplication index after the table and columns
        # are guaranteed to exist (including on legacy databases).
        await db.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_download_history_unique "
            "ON download_history(aweme_id, sec_uid, mode)"
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_download_history_aweme_id_status "
            "ON download_history(aweme_id, status)"
        )

        await db.commit()
        self._initialized = True

    async def is_downloaded(self, aweme_id: str) -> bool:
        db = await self._get_conn()
        cursor = await db.execute("SELECT id FROM aweme WHERE aweme_id = ?", (aweme_id,))
        result = await cursor.fetchone()
        return result is not None

    async def add_aweme(
        self,
        aweme_data: Dict[str, Any],
        *,
        author_sec_uid: Optional[str] = None,
    ):
        db = await self._get_conn()
        # Prefer the explicit kwarg; fall back to a key on the payload so existing
        # callers (tests, legacy downloaders) keep working.
        sec_uid = author_sec_uid if author_sec_uid is not None else aweme_data.get("author_sec_uid")
        await db.execute(
            """
            INSERT OR REPLACE INTO aweme
            (aweme_id, aweme_type, title, author_id, author_name, author_sec_uid,
             create_time, download_time, file_path, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
            (
                aweme_data.get("aweme_id"),
                aweme_data.get("aweme_type"),
                aweme_data.get("title"),
                aweme_data.get("author_id"),
                aweme_data.get("author_name"),
                sec_uid,
                aweme_data.get("create_time"),
                int(datetime.now().timestamp()),
                aweme_data.get("file_path"),
                aweme_data.get("metadata"),
            ),
        )
        await db.commit()

    async def add_aweme_batch(self, items: List[Dict[str, Any]]) -> None:
        """Insert N awemes in a single transaction. Replaces existing rows by aweme_id."""
        if not items:
            return
        db = await self._get_conn()
        now_ts = int(datetime.now().timestamp())
        rows = [
            (
                item.get("aweme_id"),
                item.get("aweme_type"),
                item.get("title"),
                item.get("author_id"),
                item.get("author_name"),
                item.get("author_sec_uid"),
                item.get("create_time"),
                now_ts,
                item.get("file_path"),
                item.get("metadata"),
            )
            for item in items
        ]
        await db.executemany(
            """
            INSERT OR REPLACE INTO aweme
            (aweme_id, aweme_type, title, author_id, author_name, author_sec_uid,
             create_time, download_time, file_path, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
            rows,
        )
        await db.commit()

    async def get_latest_aweme_time(self, author_id: str) -> Optional[int]:
        db = await self._get_conn()
        cursor = await db.execute(
            "SELECT MAX(create_time) FROM aweme WHERE author_id = ?", (author_id,)
        )
        result = await cursor.fetchone()
        return result[0] if result and result[0] else None

    async def get_aweme_id_set(self, aweme_type: Optional[str] = None) -> Set[str]:
        """Return the set of aweme_ids persisted in the aweme table.

        When ``aweme_type`` is provided, only rows matching that type are
        returned. Used by sync services to avoid re-fetching items already
        seen in previous likes/favorites/collect syncs.
        """
        db = await self._get_conn()
        if aweme_type:
            cursor = await db.execute(
                "SELECT aweme_id FROM aweme WHERE aweme_type = ?", (aweme_type,)
            )
        else:
            cursor = await db.execute("SELECT aweme_id FROM aweme")
        rows = await cursor.fetchall()
        return {str(r[0]) for r in rows if r[0] is not None}

    async def get_downloaded_aweme_id_set_for_authors(
        self,
        sec_uids: List[str],
    ) -> Set[str]:
        """Return the set of aweme_ids already downloaded for the given authors.

        Combines the aweme table (records with a local file path) and
        download_history table (successful downloads, even if the file was later
        moved or deleted).
        """
        if not sec_uids:
            return set()
        db = await self._get_conn()
        placeholders = ",".join("?" for _ in sec_uids)

        cursor = await db.execute(
            f"""
            SELECT aweme_id FROM aweme
            WHERE author_sec_uid IN ({placeholders})
              AND file_path IS NOT NULL AND file_path != ''
            """,
            sec_uids,
        )
        rows = await cursor.fetchall()
        result = {str(r[0]) for r in rows if r[0] is not None}

        cursor = await db.execute(
            f"""
            SELECT aweme_id FROM download_history
            WHERE sec_uid IN ({placeholders})
              AND aweme_id IS NOT NULL AND aweme_id != ''
              AND status = 'success'
            """,
            sec_uids,
        )
        rows = await cursor.fetchall()
        result.update({str(r[0]) for r in rows if r[0] is not None})
        return result

    async def get_all_downloaded_aweme_ids(self) -> Set[str]:
        """Return the set of all aweme_ids already downloaded.

        Combines the aweme table (records with a local file path) and
        download_history table (successful downloads). This is used by the
        new-releases bridge to filter out videos that have already been
        downloaded, regardless of which author they belong to.
        """
        db = await self._get_conn()
        result: Set[str] = set()

        cursor = await db.execute(
            """
            SELECT aweme_id FROM aweme
            WHERE file_path IS NOT NULL AND file_path != ''
            """
        )
        rows = await cursor.fetchall()
        result.update({str(r[0]) for r in rows if r[0] is not None})

        cursor = await db.execute(
            """
            SELECT aweme_id FROM download_history
            WHERE aweme_id IS NOT NULL AND aweme_id != ''
              AND status = 'success'
            """
        )
        rows = await cursor.fetchall()
        result.update({str(r[0]) for r in rows if r[0] is not None})
        return result

    async def get_aweme_rows_by_type(self, aweme_type: str) -> List[Dict[str, Any]]:
        """Return all aweme rows of a given sync type, newest first."""
        db = await self._get_conn()
        cursor = await db.execute(
            "SELECT aweme_id, aweme_type, title, author_id, author_name, "
            "author_sec_uid, create_time, download_time, file_path, metadata "
            "FROM aweme WHERE aweme_type = ? ORDER BY download_time DESC, id DESC",
            (aweme_type,),
        )
        rows = await cursor.fetchall()
        return [
            {
                "aweme_id": r[0],
                "aweme_type": r[1],
                "title": r[2],
                "author_id": r[3],
                "author_name": r[4],
                "author_sec_uid": r[5],
                "create_time": r[6],
                "download_time": r[7],
                "file_path": r[8],
                "metadata": r[9],
            }
            for r in rows
        ]

    async def add_history(self, history_data: Dict[str, Any]):
        db = await self._get_conn()
        now_ts = int(datetime.now().timestamp())
        await db.execute(
            """
            INSERT INTO download_history
            (url, url_type, download_time, total_count, success_count, config,
             aweme_id, sec_uid, mode, status, file_path, error_message,
             created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
            (
                history_data.get("url"),
                history_data.get("url_type"),
                now_ts,
                history_data.get("total_count"),
                history_data.get("success_count"),
                history_data.get("config"),
                history_data.get("aweme_id"),
                history_data.get("sec_uid"),
                history_data.get("mode"),
                history_data.get("status", "success"),
                history_data.get("file_path"),
                history_data.get("error_message"),
                now_ts,
                now_ts,
            ),
        )
        await db.commit()

    async def get_download_history(
        self,
        aweme_id: str,
        *,
        sec_uid: Optional[str] = None,
        mode: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Return the newest download_history row for (aweme_id, sec_uid, mode).

        ``sec_uid`` / ``mode`` match NULL on both sides so legacy rows and new
        records without these dimensions can still be looked up.
        """
        db = await self._get_conn()
        cursor = await db.execute(
            """
            SELECT id, aweme_id, sec_uid, mode, status, file_path, error_message,
                   url, url_type, download_time, total_count, success_count, config,
                   created_at, updated_at
            FROM download_history
            WHERE aweme_id = ?
              AND (sec_uid = ? OR (sec_uid IS NULL AND ? IS NULL))
              AND (mode = ? OR (mode IS NULL AND ? IS NULL))
            ORDER BY updated_at DESC, id DESC
            LIMIT 1
            """,
            (aweme_id, sec_uid, sec_uid, mode, mode),
        )
        row = await cursor.fetchone()
        if not row:
            return None
        return {
            "id": row[0],
            "aweme_id": row[1],
            "sec_uid": row[2],
            "mode": row[3],
            "status": row[4],
            "file_path": row[5],
            "error_message": row[6],
            "url": row[7],
            "url_type": row[8],
            "download_time": row[9],
            "total_count": row[10],
            "success_count": row[11],
            "config": row[12],
            "created_at": row[13],
            "updated_at": row[14],
        }

    async def record_download_history(
        self,
        *,
        aweme_id: str,
        sec_uid: Optional[str] = None,
        mode: Optional[str] = None,
        status: str = "success",
        file_path: Optional[str] = None,
        error_message: Optional[str] = None,
        url: Optional[str] = None,
        url_type: Optional[str] = None,
        total_count: Optional[int] = None,
        success_count: Optional[int] = None,
        config: Optional[str] = None,
    ) -> None:
        """Upsert a per-aweme download history record.

        Uses the ``(aweme_id, sec_uid, mode)`` unique index for deduplication.
        Existing rows have their ``status``, ``file_path`` and timestamps
        refreshed; ``created_at`` is preserved from the first insert.
        """
        now_ts = int(datetime.now().timestamp())
        db = await self._get_conn()
        await db.execute(
            """
            INSERT INTO download_history
            (aweme_id, sec_uid, mode, status, file_path, error_message,
             url, url_type, download_time, total_count, success_count, config,
             created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(aweme_id, sec_uid, mode) DO UPDATE SET
                status = excluded.status,
                file_path = COALESCE(excluded.file_path, download_history.file_path),
                error_message = excluded.error_message,
                url = COALESCE(excluded.url, download_history.url),
                url_type = COALESCE(excluded.url_type, download_history.url_type),
                download_time = COALESCE(excluded.download_time, download_history.download_time),
                total_count = COALESCE(excluded.total_count, download_history.total_count),
                success_count = COALESCE(excluded.success_count, download_history.success_count),
                config = COALESCE(excluded.config, download_history.config),
                updated_at = excluded.updated_at
        """,
            (
                aweme_id,
                sec_uid,
                mode,
                status,
                file_path,
                error_message,
                url,
                url_type,
                now_ts,
                total_count,
                success_count,
                config,
                now_ts,
                now_ts,
            ),
        )
        await db.commit()

    async def get_aweme_history(
        self,
        *,
        page: int = 1,
        size: int = 50,
        author: Optional[str] = None,
        date_from: Optional[int] = None,
        date_to: Optional[int] = None,
        aweme_type: Optional[str] = None,
        title: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Paginated aweme history, newest download first.

        `date_from` / `date_to` are unix-seconds (filter against `create_time`).
        `aweme_type` matches the `aweme_type` column (e.g. 'video', 'gallery').
        `title` is a case-insensitive substring match on the title column.
        """
        db = await self._get_conn()
        where: list = []
        params: list = []
        if author:
            where.append("author_name = ?")
            params.append(author)
        if date_from is not None:
            where.append("create_time >= ?")
            params.append(int(date_from))
        if date_to is not None:
            where.append("create_time <= ?")
            params.append(int(date_to))
        if aweme_type:
            where.append("aweme_type = ?")
            params.append(aweme_type)
        if title:
            where.append("LOWER(COALESCE(title, '')) LIKE ?")
            params.append(f"%{title.lower()}%")
        where_sql = ("WHERE " + " AND ".join(where)) if where else ""

        cursor = await db.execute(f"SELECT COUNT(*) FROM aweme {where_sql}", params)
        row = await cursor.fetchone()
        total = int(row[0]) if row else 0

        offset = max(0, (page - 1) * size)
        cursor = await db.execute(
            f"SELECT aweme_id, aweme_type, title, author_id, author_name, "
            f"author_sec_uid, create_time, download_time, file_path FROM aweme "
            f"{where_sql} ORDER BY download_time DESC, id DESC LIMIT ? OFFSET ?",
            params + [int(size), int(offset)],
        )
        rows = await cursor.fetchall()
        items = [
            {
                "aweme_id": r[0],
                "aweme_type": r[1],
                "title": r[2],
                "author_id": r[3],
                "author_name": r[4],
                "author_sec_uid": r[5],
                "create_time": r[6],
                "download_time": r[7],
                "file_path": r[8],
            }
            for r in rows
        ]
        return {"total": total, "page": int(page), "size": int(size), "items": items}

    async def get_aweme_count_by_author(self, author_id: str) -> int:
        db = await self._get_conn()
        cursor = await db.execute("SELECT COUNT(*) FROM aweme WHERE author_id = ?", (author_id,))
        result = await cursor.fetchone()
        return result[0] if result else 0

    async def get_top_authors(self, *, days: int, limit: int) -> List[Dict[str, Any]]:
        """Return the most-downloaded authors in the last ``days`` days.

        Aggregates rows in `aweme` with ``create_time >= now - days*86400`` and
        non-empty / non-null ``author_sec_uid``. Groups by ``author_sec_uid``
        and orders by ``COUNT(*) DESC, author_sec_uid ASC`` (stable tie-break
        so property tests are deterministic). Truncates to ``limit`` rows.

        ``author_name`` for each result row is the latest non-empty
        ``author_name`` for that ``sec_uid`` (ordered by ``download_time``
        descending). If all rows for that sec_uid have empty/null names,
        falls back to the Chinese placeholder ``"未知作者"``.

        Each returned dict contains ``sec_uid`` / ``author_name`` /
        ``download_count``.
        """
        cutoff = int(datetime.now().timestamp()) - int(days) * 86400
        db = await self._get_conn()
        cursor = await db.execute(
            """
            SELECT a.author_sec_uid,
                   (SELECT a2.author_name FROM aweme a2
                     WHERE a2.author_sec_uid = a.author_sec_uid
                       AND a2.author_name IS NOT NULL
                       AND a2.author_name != ''
                     ORDER BY a2.download_time DESC
                     LIMIT 1) AS author_name,
                   COUNT(*) AS download_count
              FROM aweme a
             WHERE a.create_time >= ?
               AND a.author_sec_uid IS NOT NULL
               AND a.author_sec_uid != ''
             GROUP BY a.author_sec_uid
             ORDER BY download_count DESC, a.author_sec_uid ASC
             LIMIT ?
            """,
            (cutoff, int(limit)),
        )
        rows = await cursor.fetchall()
        return [
            {
                "sec_uid": row[0],
                "author_name": row[1] if row[1] else "未知作者",
                "download_count": int(row[2]),
            }
            for row in rows
        ]

    async def get_download_report(
        self,
        *,
        date_from: Optional[int] = None,
        date_to: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Aggregate download history by local date, author, and mode.

        Returns one dict per (date_bucket, author, mode) with download counts
        and success/failure breakdown. ``date_from`` / ``date_to`` are Unix
        seconds (inclusive). When omitted the report covers all history rows
        that have a non-null ``download_time``.
        """
        db = await self._get_conn()
        where: list = ["h.download_time IS NOT NULL"]
        params: list = []
        if date_from is not None:
            where.append("h.download_time >= ?")
            params.append(int(date_from))
        if date_to is not None:
            where.append("h.download_time <= ?")
            params.append(int(date_to))
        where_sql = "WHERE " + " AND ".join(where)

        cursor = await db.execute(
            f"""
            SELECT date(h.download_time, 'unixepoch', 'localtime') AS date_bucket,
                   COALESCE(a.author_name, '未知作者') AS author,
                   COALESCE(h.mode, 'unknown') AS mode,
                   COUNT(*) AS download_count,
                   SUM(CASE WHEN h.status = 'success' THEN 1 ELSE 0 END) AS success_count,
                   SUM(CASE WHEN h.status != 'success' THEN 1 ELSE 0 END) AS failed_count
              FROM download_history h
              LEFT JOIN aweme a ON h.aweme_id = a.aweme_id
              {where_sql}
             GROUP BY date_bucket, author, mode
             ORDER BY date_bucket DESC, download_count DESC, author ASC, mode ASC
            """,
            params,
        )
        rows = await cursor.fetchall()
        return [
            {
                "date_bucket": row[0],
                "author": row[1],
                "mode": row[2],
                "download_count": int(row[3]),
                "success_count": int(row[4]),
                "failed_count": int(row[5]),
            }
            for row in rows
        ]

    async def get_report_file_paths(
        self,
        *,
        date_from: Optional[int] = None,
        date_to: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Return distinct save directories per report group.

        Each row contains a (date_bucket, author, mode) tuple and a single
        ``file_path`` (preferring ``aweme.file_path``, falling back to
        ``download_history.file_path``). Used by the report generator to
        compute occupied disk space without double-counting repeated paths
        within the same group.
        """
        db = await self._get_conn()
        where: list = ["h.download_time IS NOT NULL"]
        params: list = []
        if date_from is not None:
            where.append("h.download_time >= ?")
            params.append(int(date_from))
        if date_to is not None:
            where.append("h.download_time <= ?")
            params.append(int(date_to))
        where_sql = "WHERE " + " AND ".join(where)

        cursor = await db.execute(
            f"""
            SELECT date(h.download_time, 'unixepoch', 'localtime') AS date_bucket,
                   COALESCE(a.author_name, '未知作者') AS author,
                   COALESCE(h.mode, 'unknown') AS mode,
                   COALESCE(a.file_path, h.file_path) AS file_path
              FROM download_history h
              LEFT JOIN aweme a ON h.aweme_id = a.aweme_id
              {where_sql}
               AND COALESCE(a.file_path, h.file_path) IS NOT NULL
               AND COALESCE(a.file_path, h.file_path) != ''
             GROUP BY date_bucket, author, mode, COALESCE(a.file_path, h.file_path)
             ORDER BY date_bucket DESC, author ASC, mode ASC, COALESCE(a.file_path, h.file_path) ASC
            """,
            params,
        )
        rows = await cursor.fetchall()
        return [
            {
                "date_bucket": row[0],
                "author": row[1],
                "mode": row[2],
                "file_path": row[3],
            }
            for row in rows
        ]

    async def upsert_transcript_job(self, job_data: Dict[str, Any]):
        now_ts = int(datetime.now().timestamp())
        db = await self._get_conn()
        await db.execute(
            """
            INSERT INTO transcript_job (
                aweme_id,
                video_path,
                transcript_dir,
                text_path,
                json_path,
                model,
                status,
                skip_reason,
                error_message,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(aweme_id, video_path, model) DO UPDATE SET
                transcript_dir = excluded.transcript_dir,
                text_path = excluded.text_path,
                json_path = excluded.json_path,
                status = excluded.status,
                skip_reason = excluded.skip_reason,
                error_message = excluded.error_message,
                updated_at = excluded.updated_at
        """,
            (
                job_data.get("aweme_id"),
                job_data.get("video_path"),
                job_data.get("transcript_dir"),
                job_data.get("text_path"),
                job_data.get("json_path"),
                job_data.get("model") or "gpt-4o-mini-transcribe",
                job_data.get("status"),
                job_data.get("skip_reason"),
                job_data.get("error_message"),
                now_ts,
                now_ts,
            ),
        )
        await db.commit()

    async def get_transcript_job(self, aweme_id: str) -> Optional[Dict[str, Any]]:
        db = await self._get_conn()
        cursor = await db.execute(
            """
            SELECT aweme_id, video_path, transcript_dir, text_path, json_path,
                   model, status, skip_reason, error_message, created_at, updated_at
            FROM transcript_job
            WHERE aweme_id = ?
            ORDER BY updated_at DESC, id DESC
            LIMIT 1
            """,
            (aweme_id,),
        )
        row = await cursor.fetchone()
        if not row:
            return None
        return {
            "aweme_id": row[0],
            "video_path": row[1],
            "transcript_dir": row[2],
            "text_path": row[3],
            "json_path": row[4],
            "model": row[5],
            "status": row[6],
            "skip_reason": row[7],
            "error_message": row[8],
            "created_at": row[9],
            "updated_at": row[10],
        }

    async def delete_aweme_by_ids(self, aweme_ids: List[str]) -> int:
        """Delete aweme rows by their string id. Returns the number of rows removed.

        Empty input is a no-op that returns 0 without issuing any SQL.

        Uses a parameterized ``DELETE ... WHERE aweme_id IN (?,?,...)`` statement
        because ``aiosqlite.Cursor.rowcount`` is not reliably populated after
        ``executemany`` across all versions. Chunked at 500 ids per statement to
        stay well below SQLite's host-parameter limit (historically 999).
        """
        if not aweme_ids:
            return 0
        # De-duplicate input while preserving a stable order. Duplicate ids would
        # otherwise match the same row twice in different chunks and inflate the
        # returned count beyond the rows actually affected.
        seen: Dict[str, None] = {}
        for aid in aweme_ids:
            if aid not in seen:
                seen[aid] = None
        unique_ids = list(seen.keys())

        db = await self._get_conn()
        if self._conn_lock is None:
            self._conn_lock = asyncio.Lock()
        deleted = 0
        chunk_size = 500
        async with self._conn_lock:
            for start in range(0, len(unique_ids), chunk_size):
                chunk = unique_ids[start : start + chunk_size]
                placeholders = ",".join("?" for _ in chunk)
                cursor = await db.execute(
                    f"DELETE FROM aweme WHERE aweme_id IN ({placeholders})",
                    chunk,
                )
                if cursor.rowcount is not None and cursor.rowcount > 0:
                    deleted += cursor.rowcount
            await db.commit()
        return deleted

    async def truncate_history(self) -> None:
        """Delete every row from `aweme` and `download_history`.

        Does not touch disk files or any other table (e.g. transcript_job).
        """
        db = await self._get_conn()
        if self._conn_lock is None:
            self._conn_lock = asyncio.Lock()
        async with self._conn_lock:
            await db.execute("DELETE FROM aweme")
            await db.execute("DELETE FROM download_history")
            await db.commit()

    # ------------------------------------------------------------------
    # Task-center job persistence (see server/jobs.py)
    # ------------------------------------------------------------------

    async def upsert_job(self, job_dict: Dict[str, Any]) -> None:
        """Insert or replace a task-center job record.

        Accepts the dict produced by :py:meth:`server.jobs.DownloadJob.to_dict`
        plus an optional ``overrides`` key (the JobManager stores overrides
        separately on the in-memory job but we persist them too so future
        retries/re-runs can inherit them). Unknown keys are ignored — any
        renderer-only computed fields (``url_type``, ``duration_ms`` etc.)
        are recomputed from raw columns on read.
        """
        db = await self._get_conn()
        if self._conn_lock is None:
            self._conn_lock = asyncio.Lock()

        last_retry_summary = job_dict.get("last_retry_summary")
        retry_history = job_dict.get("retry_history")
        overrides = job_dict.get("overrides")
        params = (
            job_dict.get("job_id"),
            job_dict.get("url") or "",
            job_dict.get("status") or "",
            job_dict.get("created_at") or "",
            job_dict.get("started_at"),
            job_dict.get("finished_at"),
            int(job_dict.get("total") or 0),
            int(job_dict.get("success") or 0),
            int(job_dict.get("failed") or 0),
            int(job_dict.get("skipped") or 0),
            job_dict.get("error"),
            job_dict.get("author_nickname"),
            job_dict.get("author_sec_uid"),
            int(job_dict.get("retry_count") or 0),
            job_dict.get("last_retry_at"),
            json.dumps(last_retry_summary) if last_retry_summary else None,
            json.dumps(retry_history) if retry_history else None,
            json.dumps(overrides) if overrides else None,
        )
        async with self._conn_lock:
            await db.execute(
                """
                INSERT OR REPLACE INTO job (
                    job_id, url, status, created_at, started_at, finished_at,
                    total, success, failed, skipped, error,
                    author_nickname, author_sec_uid,
                    retry_count, last_retry_at, last_retry_summary,
                    retry_history, overrides
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                params,
            )
            await db.commit()

    async def delete_jobs(self, job_ids: List[str]) -> int:
        """Delete job rows by id. Returns the number of rows deleted."""
        if not job_ids:
            return 0
        seen: Dict[str, None] = {}
        for jid in job_ids:
            if jid and jid not in seen:
                seen[jid] = None
        unique_ids = list(seen.keys())
        if not unique_ids:
            return 0

        db = await self._get_conn()
        if self._conn_lock is None:
            self._conn_lock = asyncio.Lock()
        deleted = 0
        chunk_size = 500
        async with self._conn_lock:
            for start in range(0, len(unique_ids), chunk_size):
                chunk = unique_ids[start : start + chunk_size]
                placeholders = ",".join("?" for _ in chunk)
                cursor = await db.execute(
                    f"DELETE FROM job WHERE job_id IN ({placeholders})",
                    chunk,
                )
                if cursor.rowcount is not None and cursor.rowcount > 0:
                    deleted += cursor.rowcount
            await db.commit()
        return deleted

    async def load_terminal_jobs(self, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        """Load persisted terminal jobs ordered by created_at DESC.

        Only rows whose ``status`` is a terminal value (success / failed /
        cancelled) are returned. Running/pending rows shouldn't exist on
        disk — see server/jobs.py — but we filter defensively in case an
        older build left stale rows.
        """
        db = await self._get_conn()
        if self._conn_lock is None:
            self._conn_lock = asyncio.Lock()

        sql = (
            "SELECT job_id, url, status, created_at, started_at, finished_at, "
            "total, success, failed, skipped, error, author_nickname, "
            "author_sec_uid, retry_count, last_retry_at, last_retry_summary, "
            "retry_history, overrides FROM job "
            "WHERE status IN ('success', 'failed', 'cancelled') "
            "ORDER BY created_at DESC"
        )
        if limit is not None and limit > 0:
            sql += f" LIMIT {int(limit)}"

        async with self._conn_lock:
            cursor = await db.execute(sql)
            rows = await cursor.fetchall()

        result: List[Dict[str, Any]] = []
        for row in rows:
            summary_raw = row[15]
            history_raw = row[16]
            overrides_raw = row[17]
            try:
                summary = json.loads(summary_raw) if summary_raw else None
            except (TypeError, ValueError):
                summary = None
            try:
                history = json.loads(history_raw) if history_raw else []
                if not isinstance(history, list):
                    history = []
            except (TypeError, ValueError):
                history = []
            try:
                overrides = json.loads(overrides_raw) if overrides_raw else None
            except (TypeError, ValueError):
                overrides = None
            result.append(
                {
                    "job_id": row[0],
                    "url": row[1],
                    "status": row[2],
                    "created_at": row[3],
                    "started_at": row[4],
                    "finished_at": row[5],
                    "total": row[6] or 0,
                    "success": row[7] or 0,
                    "failed": row[8] or 0,
                    "skipped": row[9] or 0,
                    "error": row[10],
                    "author_nickname": row[11],
                    "author_sec_uid": row[12],
                    "retry_count": row[13] or 0,
                    "last_retry_at": row[14],
                    "last_retry_summary": summary,
                    "retry_history": history,
                    "overrides": overrides,
                }
            )
        return result

    # ------------------------------------------------------------------
    # Following list persistence (see core/following.py)
    # ------------------------------------------------------------------

    async def upsert_following(self, user_data: Dict[str, Any]) -> None:
        """Insert or update a followed user row.

        Expected keys: sec_uid, nickname, avatar, signature, follower_count,
        following_count, unique_id, extra (optional JSON string).
        """
        db = await self._get_conn()
        now_ts = int(datetime.now().timestamp())
        extra = user_data.get("extra")
        if extra is not None and not isinstance(extra, str):
            extra = json.dumps(extra, ensure_ascii=False)
        await db.execute(
            """
            INSERT INTO following
            (sec_uid, nickname, avatar, signature, follower_count,
             following_count, aweme_count, unique_id, extra, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(sec_uid) DO UPDATE SET
                nickname = excluded.nickname,
                avatar = excluded.avatar,
                signature = excluded.signature,
                follower_count = excluded.follower_count,
                following_count = excluded.following_count,
                aweme_count = excluded.aweme_count,
                unique_id = excluded.unique_id,
                extra = excluded.extra,
                updated_at = excluded.updated_at
            """,
            (
                user_data.get("sec_uid"),
                user_data.get("nickname"),
                user_data.get("avatar"),
                user_data.get("signature"),
                int(user_data.get("follower_count") or 0),
                int(user_data.get("following_count") or 0),
                int(user_data.get("aweme_count") or 0),
                user_data.get("unique_id"),
                extra,
                now_ts,
            ),
        )
        await db.commit()

    async def upsert_following_batch(self, users: List[Dict[str, Any]]) -> None:
        """Batch insert/update followed users in a single transaction."""
        if not users:
            return
        db = await self._get_conn()
        now_ts = int(datetime.now().timestamp())
        rows: List[tuple] = []
        for user_data in users:
            extra = user_data.get("extra")
            if extra is not None and not isinstance(extra, str):
                extra = json.dumps(extra, ensure_ascii=False)
            rows.append(
                (
                    user_data.get("sec_uid"),
                    user_data.get("nickname"),
                    user_data.get("avatar"),
                    user_data.get("signature"),
                    int(user_data.get("follower_count") or 0),
                    int(user_data.get("following_count") or 0),
                    int(user_data.get("aweme_count") or 0),
                    user_data.get("unique_id"),
                    extra,
                    int(user_data.get("create_time") or 0),
                    user_data.get("follow_order"),
                    now_ts,
                )
            )
        await db.executemany(
            """
            INSERT INTO following
            (sec_uid, nickname, avatar, signature, follower_count,
             following_count, aweme_count, unique_id, extra, create_time, follow_order, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(sec_uid) DO UPDATE SET
                nickname = excluded.nickname,
                avatar = excluded.avatar,
                signature = excluded.signature,
                follower_count = excluded.follower_count,
                following_count = excluded.following_count,
                aweme_count = excluded.aweme_count,
                unique_id = excluded.unique_id,
                extra = excluded.extra,
                create_time = excluded.create_time,
                follow_order = CASE
                    WHEN excluded.follow_order IS NULL THEN following.follow_order
                    WHEN following.follow_order IS NULL OR excluded.follow_order < following.follow_order
                        THEN excluded.follow_order
                    ELSE following.follow_order
                END,
                updated_at = excluded.updated_at
            """,
            rows,
        )
        await db.commit()

    async def is_following_exists(self, sec_uid: str) -> bool:
        db = await self._get_conn()
        cursor = await db.execute("SELECT id FROM following WHERE sec_uid = ?", (sec_uid,))
        result = await cursor.fetchone()
        return result is not None

    async def reset_following_follow_order(self) -> None:
        """将所有关注用户的 follow_order 重置为 NULL，用于全量重新同步时按 API 返回流重新编号。"""
        db = await self._get_conn()
        await db.execute("UPDATE following SET follow_order = NULL")
        await db.commit()

    async def get_following_count(self) -> int:
        db = await self._get_conn()
        cursor = await db.execute("SELECT COUNT(*) FROM following")
        result = await cursor.fetchone()
        return int(result[0]) if result and result[0] else 0

    async def get_following_list(
        self,
        *,
        page: int = 1,
        size: int = 50,
        search: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Paginated followed users ordered by API follow order (newest first)."""
        db = await self._get_conn()
        where: list = []
        params: list = []
        if search:
            where.append("LOWER(COALESCE(nickname, '')) LIKE ?")
            params.append(f"%{search.lower()}%")
        where_sql = ("WHERE " + " AND ".join(where)) if where else ""

        cursor = await db.execute(f"SELECT COUNT(*) FROM following {where_sql}", params)
        row = await cursor.fetchone()
        total = int(row[0]) if row else 0

        offset = max(0, (page - 1) * size)
        cursor = await db.execute(
            f"""
            SELECT sec_uid, nickname, avatar, signature, follower_count,
                   following_count, aweme_count, unique_id, extra, create_time, follow_order, updated_at
            FROM following
            {where_sql}
            ORDER BY CASE WHEN follow_order IS NULL THEN 1 ELSE 0 END,
                     follow_order ASC,
                     updated_at DESC,
                     id DESC
            LIMIT ? OFFSET ?
            """,
            params + [int(size), int(offset)],
        )
        rows = await cursor.fetchall()
        items = [
            {
                "sec_uid": r[0],
                "nickname": r[1],
                "avatar": r[2],
                "signature": r[3],
                "follower_count": r[4],
                "following_count": r[5],
                "aweme_count": r[6],
                "unique_id": r[7],
                "extra": r[8],
                "create_time": r[9],
                "follow_order": r[10],
                "updated_at": r[11],
            }
            for r in rows
        ]
        return {"total": total, "page": int(page), "size": int(size), "items": items}

    async def delete_following_not_in(self, sec_uids: List[str]) -> int:
        """Delete followed users whose sec_uid is not in the given list.

        Used after a full sync to remove accounts that are no longer followed.
        Returns the number of deleted rows.
        """
        if not sec_uids:
            db = await self._get_conn()
            cursor = await db.execute("DELETE FROM following")
            await db.commit()
            return cursor.rowcount
        placeholders = ",".join("?" for _ in sec_uids)
        db = await self._get_conn()
        cursor = await db.execute(
            f"DELETE FROM following WHERE sec_uid NOT IN ({placeholders})",
            tuple(sec_uids),
        )
        await db.commit()
        return cursor.rowcount

    async def get_downloaded_following_authors(
        self,
        *,
        limit: int = 200,
    ) -> List[Dict[str, Any]]:
        """Return followed users who have at least one local download record.

        Matches against both the aweme table (author_sec_uid) and the
        download_history table (sec_uid) so creators are not missed when older
        aweme rows lack an author_sec_uid value.

        Ordered by the most recent download time for that author so the most
        active creators are checked first.
        """
        db = await self._get_conn()
        cursor = await db.execute(
            """
            SELECT f.sec_uid, f.nickname, f.avatar, f.signature, f.follower_count,
                   f.following_count, f.unique_id, f.extra, f.create_time, f.updated_at,
                   MAX(d.last_download_time) AS last_download_time
            FROM following f
            INNER JOIN (
                SELECT author_sec_uid AS sec_uid, MAX(download_time) AS last_download_time
                FROM aweme
                WHERE author_sec_uid IS NOT NULL AND author_sec_uid != ''
                  AND file_path IS NOT NULL AND file_path != ''
                GROUP BY author_sec_uid
                UNION
                SELECT sec_uid, MAX(download_time) AS last_download_time
                FROM download_history
                WHERE sec_uid IS NOT NULL AND sec_uid != ''
                  AND status = 'success'
                  AND (
                      (aweme_id IS NOT NULL AND aweme_id != '')
                      OR (url_type IN ('user', 'mix', 'music', 'live'))
                  )
                GROUP BY sec_uid
            ) d ON d.sec_uid = f.sec_uid
            GROUP BY f.sec_uid
            ORDER BY last_download_time DESC, f.updated_at DESC
            LIMIT ?
            """,
            (int(limit),),
        )
        rows = await cursor.fetchall()
        return [
            {
                "sec_uid": r[0],
                "nickname": r[1],
                "avatar": r[2],
                "signature": r[3],
                "follower_count": r[4],
                "following_count": r[5],
                "unique_id": r[6],
                "extra": r[7],
                "create_time": r[8],
                "updated_at": r[9],
                "last_download_time": r[10],
            }
            for r in rows
        ]

    async def get_all_following_authors(
        self,
        *,
        limit: int = 200,
    ) -> List[Dict[str, Any]]:
        """Return all followed users regardless of download history.

        Used by the new-releases bridge when the user selects "all followed"
        as the author source so that creators never downloaded from are still
        checked for new works. Ordered by follow order (newest followed first)
        then by updated_at so recently followed creators are checked first.
        """
        db = await self._get_conn()
        cursor = await db.execute(
            """
            SELECT sec_uid, nickname, avatar, signature, follower_count,
                   following_count, unique_id, extra, create_time, updated_at
            FROM following
            WHERE sec_uid IS NOT NULL AND sec_uid != ''
            ORDER BY CASE WHEN follow_order IS NULL THEN 1 ELSE 0 END,
                     follow_order ASC,
                     updated_at DESC,
                     id DESC
            LIMIT ?
            """,
            (int(limit),),
        )
        rows = await cursor.fetchall()
        return [
            {
                "sec_uid": r[0],
                "nickname": r[1],
                "avatar": r[2],
                "signature": r[3],
                "follower_count": r[4],
                "following_count": r[5],
                "unique_id": r[6],
                "extra": r[7],
                "create_time": r[8],
                "updated_at": r[9],
                "last_download_time": None,
            }
            for r in rows
        ]

    async def delete_following_by_sec_uids(self, sec_uids: List[str]) -> int:
        """Delete followed users by sec_uid. Returns number of rows removed."""
        if not sec_uids:
            return 0
        seen: Dict[str, None] = {}
        for suid in sec_uids:
            if suid and suid not in seen:
                seen[suid] = None
        unique_ids = list(seen.keys())
        if not unique_ids:
            return 0

        db = await self._get_conn()
        if self._conn_lock is None:
            self._conn_lock = asyncio.Lock()
        deleted = 0
        chunk_size = 500
        async with self._conn_lock:
            for start in range(0, len(unique_ids), chunk_size):
                chunk = unique_ids[start : start + chunk_size]
                placeholders = ",".join("?" for _ in chunk)
                cursor = await db.execute(
                    f"DELETE FROM following WHERE sec_uid IN ({placeholders})",
                    chunk,
                )
                if cursor.rowcount is not None and cursor.rowcount > 0:
                    deleted += cursor.rowcount
            await db.commit()
        return deleted

    # ------------------------------------------------------------------
    # Sync cursor state for incremental pagination
    # ------------------------------------------------------------------

    async def get_sync_cursor(self, kind: str, entity_id: str) -> Optional[int]:
        """Return the stored cursor for (kind, entity_id), or None if absent."""
        db = await self._get_conn()
        cursor = await db.execute(
            "SELECT cursor FROM sync_cursor WHERE kind = ? AND entity_id = ?",
            (kind, entity_id),
        )
        row = await cursor.fetchone()
        return int(row[0]) if row and row[0] is not None else None

    async def set_sync_cursor(self, kind: str, entity_id: str, cursor: int) -> None:
        """Upsert the cursor for (kind, entity_id)."""
        now_ts = int(datetime.now().timestamp())
        db = await self._get_conn()
        await db.execute(
            """
            INSERT INTO sync_cursor (kind, entity_id, cursor, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(kind, entity_id) DO UPDATE SET
                cursor = excluded.cursor,
                updated_at = excluded.updated_at
        """,
            (kind, entity_id, int(cursor), now_ts),
        )
        await db.commit()

    async def reset_sync_cursor(self, kind: str, entity_id: str) -> None:
        """Remove the cursor record for (kind, entity_id)."""
        db = await self._get_conn()
        await db.execute(
            "DELETE FROM sync_cursor WHERE kind = ? AND entity_id = ?",
            (kind, entity_id),
        )
        await db.commit()

    async def close(self):
        if self._conn is not None:
            try:
                await self._conn.close()
            except RuntimeError as exc:
                # aiosqlite 在 event loop 关闭过程中可能抛出 RuntimeError，
                # 此时连接已不可达，忽略即可避免进程异常退出。
                if "cannot schedule new futures" not in str(exc) and "Event loop is closed" not in str(exc):
                    raise
            finally:
                self._conn = None
