import asyncio
import html
from dataclasses import dataclass
from datetime import datetime, time, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from storage.database import Database
from utils.helpers import format_size


@dataclass(frozen=True)
class ReportRow:
    date_bucket: str
    author: str
    mode: str
    download_count: int
    success_count: int
    failed_count: int
    success_rate: float
    size_bytes: int
    size_human: str


class ReportGenerator:
    def __init__(self):
        self._size_cache: Dict[str, int] = {}

    async def build(
        self,
        database: Database,
        *,
        date_from: Optional[int] = None,
        date_to: Optional[int] = None,
    ) -> List[ReportRow]:
        """Aggregate download history and compute occupied disk space."""
        stats = await database.get_download_report(date_from=date_from, date_to=date_to)
        path_rows = await database.get_report_file_paths(date_from=date_from, date_to=date_to)

        size_by_group = self._compute_sizes(path_rows)

        rows: List[ReportRow] = []
        for stat in stats:
            key = (stat["date_bucket"], stat["author"], stat["mode"])
            size_bytes = size_by_group.get(key, 0)
            download_count = stat["download_count"]
            success_count = stat["success_count"]
            success_rate = (success_count / download_count * 100.0) if download_count > 0 else 0.0
            rows.append(
                ReportRow(
                    date_bucket=stat["date_bucket"],
                    author=stat["author"],
                    mode=stat["mode"],
                    download_count=download_count,
                    success_count=success_count,
                    failed_count=stat["failed_count"],
                    success_rate=round(success_rate, 2),
                    size_bytes=size_bytes,
                    size_human=format_size(size_bytes),
                )
            )
        return rows

    def _compute_sizes(self, path_rows: List[Dict[str, Any]]) -> Dict[Tuple[str, str, str], int]:
        """Sum directory sizes per report group, caching directory totals."""
        size_by_group: Dict[Tuple[str, str, str], int] = {}
        for row in path_rows:
            key = (row["date_bucket"], row["author"], row["mode"])
            file_path = row["file_path"]
            if not file_path:
                continue
            size = self._dir_size(file_path)
            size_by_group[key] = size_by_group.get(key, 0) + size
        return size_by_group

    def _dir_size(self, path_str: str) -> int:
        if path_str in self._size_cache:
            return self._size_cache[path_str]

        path = Path(path_str)
        if not path.exists():
            self._size_cache[path_str] = 0
            return 0

        total = 0
        try:
            if path.is_dir():
                for item in path.rglob("*"):
                    try:
                        if item.is_file(follow_symlinks=False):
                            total += item.stat().st_size
                    except (OSError, ValueError):
                        pass
            elif path.is_file():
                total = path.stat().st_size
        except (OSError, ValueError):
            total = 0

        self._size_cache[path_str] = total
        return total


class ReportExporter:
    COLUMNS = [
        ("日期", "date_bucket"),
        ("作者", "author"),
        ("模式", "mode"),
        ("下载数", "download_count"),
        ("成功数", "success_count"),
        ("失败数", "failed_count"),
        ("成功率 (%)", "success_rate"),
        ("占用空间", "size_human"),
    ]

    def export_excel(self, rows: List[ReportRow], path: Path) -> Path:
        try:
            from openpyxl import Workbook
        except ImportError as exc:
            raise RuntimeError(
                "导出 Excel 需要 openpyxl，请安装：pip install openpyxl"
            ) from exc

        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "下载报表"

        headers = [label for label, _ in self.COLUMNS]
        sheet.append(headers)

        for row in rows:
            sheet.append([
                row.date_bucket,
                row.author,
                row.mode,
                row.download_count,
                row.success_count,
                row.failed_count,
                row.success_rate,
                row.size_human,
            ])

        # Auto column width with a reasonable cap.
        for col_idx, column in enumerate(sheet.columns, start=1):
            max_length = 0
            for cell in column:
                try:
                    length = len(str(cell.value))
                    if length > max_length:
                        max_length = length
                except Exception:
                    pass
            sheet.column_dimensions[cell.column_letter].width = min(max_length + 2, 50)

        path.parent.mkdir(parents=True, exist_ok=True)
        workbook.save(str(path))
        return path

    def export_html(self, rows: List[ReportRow], path: Path) -> Path:
        headers = [label for label, _ in self.COLUMNS]
        table_rows = []
        for row in rows:
            table_rows.append(
                "<tr>"
                f"<td>{html.escape(row.date_bucket)}</td>"
                f"<td>{html.escape(row.author)}</td>"
                f"<td>{html.escape(row.mode)}</td>"
                f"<td>{row.download_count}</td>"
                f"<td>{row.success_count}</td>"
                f"<td>{row.failed_count}</td>"
                f"<td>{row.success_rate:.2f}</td>"
                f"<td>{html.escape(row.size_human)}</td>"
                "</tr>"
            )

        header_cells = "".join(f"<th>{html.escape(h)}</th>" for h in headers)
        table_body = "\n".join(table_rows) if table_rows else (
            f"<tr><td colspan='{len(headers)}' style='text-align:center;'>暂无数据</td></tr>"
        )

        html_content = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>下载报表</title>
<style>
body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; margin: 24px; color: #333; }}
h1 {{ font-size: 20px; margin-bottom: 16px; }}
table {{ border-collapse: collapse; width: 100%; font-size: 14px; }}
th, td {{ border: 1px solid #ddd; padding: 8px 12px; text-align: left; }}
th {{ background-color: #f5f5f5; font-weight: 600; }}
tr:nth-child(even) {{ background-color: #fafafa; }}
.summary {{ margin-top: 16px; color: #666; font-size: 13px; }}
</style>
</head>
<body>
<h1>下载报表</h1>
<table>
<thead><tr>{header_cells}</tr></thead>
<tbody>
{table_body}
</tbody>
</table>
<div class="summary">共 {len(rows)} 条记录，生成时间：{datetime.now().strftime("%Y-%m-%d %H:%M:%S")}</div>
</body>
</html>"""

        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(html_content, encoding="utf-8")
        return path


def _resolve_output_path(output: str, fmt: str) -> Path:
    path = Path(output)
    suffixes = {"excel": ".xlsx", "html": ".html"}
    expected = suffixes.get(fmt)
    if expected is None:
        raise ValueError(f"不支持的报表格式: {fmt}")
    if path.suffix.lower() != expected:
        path = path.with_suffix(expected)
    return path


def _parse_date_range(
    date_from_str: Optional[str],
    date_to_str: Optional[str],
) -> Tuple[Optional[int], Optional[int]]:
    """Convert YYYY-MM-DD strings to inclusive Unix seconds."""
    date_from: Optional[int] = None
    date_to: Optional[int] = None

    if date_from_str:
        try:
            dt = datetime.strptime(date_from_str, "%Y-%m-%d")
            date_from = int(dt.timestamp())
        except ValueError as exc:
            raise ValueError(f"--report-from 日期格式错误，应为 YYYY-MM-DD: {date_from_str}") from exc

    if date_to_str:
        try:
            dt = datetime.strptime(date_to_str, "%Y-%m-%d")
            # Inclusive: end of the day.
            dt_end = datetime.combine(dt.date(), time.max)
            date_to = int(dt_end.timestamp())
        except ValueError as exc:
            raise ValueError(f"--report-to 日期格式错误，应为 YYYY-MM-DD: {date_to_str}") from exc

    return date_from, date_to


async def generate_report(
    db_path: str,
    output: str,
    formats: List[str],
    *,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    progress_callback: Optional[Any] = None,
) -> Dict[str, Any]:
    """Generate and export download reports.

    Args:
        db_path: Path to the SQLite database.
        output: Output path prefix; the correct suffix is appended per format.
        formats: List of formats, e.g. ["excel", "html"].
        date_from: Optional start date (YYYY-MM-DD).
        date_to: Optional end date (YYYY-MM-DD).
        progress_callback: Optional callable(message) for progress updates.

    Returns:
        Dict with ``rows`` and ``exported`` paths.
    """
    date_from_ts, date_to_ts = _parse_date_range(date_from, date_to)

    database = Database(db_path=str(db_path))
    await database.initialize()
    try:
        if progress_callback:
            progress_callback("正在查询数据库并计算占用空间…")
        generator = ReportGenerator()
        rows = await generator.build(database, date_from=date_from_ts, date_to=date_to_ts)

        exporter = ReportExporter()
        exported: List[Path] = []
        for fmt in formats:
            fmt = fmt.strip().lower()
            path = _resolve_output_path(output, fmt)
            if progress_callback:
                progress_callback(f"正在导出 {fmt.upper()}：{path}")
            if fmt == "excel":
                exporter.export_excel(rows, path)
            elif fmt == "html":
                exporter.export_html(rows, path)
            else:
                raise ValueError(f"不支持的报表格式: {fmt}")
            exported.append(path)

        return {
            "rows": rows,
            "exported": exported,
            "total_downloads": sum(r.download_count for r in rows),
            "total_success": sum(r.success_count for r in rows),
            "total_size_bytes": sum(r.size_bytes for r in rows),
        }
    finally:
        await database.close()
