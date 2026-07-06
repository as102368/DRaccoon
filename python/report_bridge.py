"""下载报表导出桥接脚本。

复用 douyin-downloader 的 ReportGenerator/ReportExporter，支持按日期/作者/模式
再聚合，并导出 Excel/HTML。
"""
from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

from lib.bridge import BridgeContext, BridgeOutput, safe_main
from lib.compat import ensure_backend_path

ensure_backend_path()

from cli.report import (  # noqa: E402
    ReportExporter,
    ReportGenerator,
    ReportRow,
    _parse_date_range,
)
from storage.database import Database  # noqa: E402
from utils.helpers import format_size  # noqa: E402


GROUP_BY_FIELDS = {"date": "date_bucket", "author": "author", "mode": "mode"}


def _aggregate(rows: list[ReportRow], group_by: str) -> list[ReportRow]:
    """按单一维度对明细行做内存聚合。"""
    if group_by not in GROUP_BY_FIELDS:
        return rows

    field = GROUP_BY_FIELDS[group_by]
    groups: dict[str, dict[str, Any]] = defaultdict(
        lambda: {
            "date_bucket": "-",
            "author": "-",
            "mode": "-",
            "download_count": 0,
            "success_count": 0,
            "failed_count": 0,
            "size_bytes": 0,
        }
    )

    for row in rows:
        key = getattr(row, field)
        g = groups[key]
        g["date_bucket"] = row.date_bucket if field == "date_bucket" else "-"
        g["author"] = row.author if field == "author" else "-"
        g["mode"] = row.mode if field == "mode" else "-"
        g["download_count"] += row.download_count
        g["success_count"] += row.success_count
        g["failed_count"] += row.failed_count
        g["size_bytes"] += row.size_bytes

    aggregated: list[ReportRow] = []
    for key in sorted(groups.keys()):
        g = groups[key]
        total = g["download_count"]
        success = g["success_count"]
        success_rate = (success / total * 100.0) if total > 0 else 0.0
        aggregated.append(
            ReportRow(
                date_bucket=g["date_bucket"],
                author=g["author"],
                mode=g["mode"],
                download_count=total,
                success_count=success,
                failed_count=g["failed_count"],
                success_rate=round(success_rate, 2),
                size_bytes=g["size_bytes"],
                size_human=format_size(g["size_bytes"]),
            )
        )
    return aggregated


async def _run(ctx: BridgeContext, job: dict[str, Any], out: BridgeOutput) -> None:
    db_path = job.get("dbPath")
    output_dir = job.get("outputDir")
    date_from = job.get("dateFrom")
    date_to = job.get("dateTo")
    group_by = str(job.get("groupBy") or "all").strip().lower()
    formats = job.get("formats") or ["excel"]

    if not db_path or not Path(db_path).exists():
        raise ValueError(f"数据库不存在：{db_path}")
    if not output_dir:
        raise ValueError("outputDir 为空")

    output_root = Path(output_dir)
    output_root.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_prefix = output_root / f"report_{timestamp}"

    # 标准化格式名称
    normalized_formats = []
    for fmt in formats:
        fmt = str(fmt).strip().lower()
        if fmt in {"excel", "xlsx"}:
            normalized_formats.append("excel")
        elif fmt == "html":
            normalized_formats.append("html")
        else:
            raise ValueError(f"不支持的报表格式：{fmt}")

    out.log("正在查询数据库并计算占用空间…")

    database = Database(db_path=str(db_path))
    await database.initialize()
    try:
        date_from_ts, date_to_ts = _parse_date_range(date_from, date_to)
        generator = ReportGenerator()
        rows = await generator.build(database, date_from=date_from_ts, date_to=date_to_ts)
        out.log(f"查询完成，明细行 {len(rows)} 条")

        if group_by != "all":
            rows = _aggregate(rows, group_by)
            out.log(f"按 '{group_by}' 聚合后 {len(rows)} 条")

        exporter = ReportExporter()
        exported: list[Path] = []
        for fmt in normalized_formats:
            if fmt == "excel":
                path = Path(str(output_prefix) + ".xlsx")
                exporter.export_excel(rows, path)
            else:
                path = Path(str(output_prefix) + ".html")
                exporter.export_html(rows, path)
            exported.append(path.resolve())
            out.log(f"已导出 {fmt.upper()}：{path}")

        out.finished(
            success=True,
            data={
                "files": [str(p) for p in exported],
                "total_downloads": sum(r.download_count for r in rows),
                "total_success": sum(r.success_count for r in rows),
                "total_size_bytes": sum(r.size_bytes for r in rows),
            },
        )
    finally:
        await database.close()


def main(ctx: BridgeContext, job: dict[str, Any], out: BridgeOutput) -> None:
    asyncio.run(_run(ctx, job, out))


if __name__ == "__main__":
    safe_main(main)
