"""作品本地整文件哈希去重桥接脚本。

递归扫描下载目录中的媒体文件，按完整文件内容哈希分组，直接删除重复文件。
"""
from __future__ import annotations

import asyncio
import hashlib
import os
from collections import defaultdict
from pathlib import Path
from typing import Any

from lib.bridge import BridgeContext, BridgeOutput, safe_main
from lib.compat import ensure_backend_path

ensure_backend_path()

# 与主进程 listVideos 保持一致，并加入常见图片格式
MEDIA_EXTS = {
    ".mp4", ".mov", ".mkv", ".avi", ".flv", ".wmv", ".webm", ".m4v",
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic",
}

HASH_CHUNK_SIZE = 1024 * 1024  # 1MB


def _format_size(size: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    idx = 0
    value = float(size)
    while value >= 1024 and idx < len(units) - 1:
        value /= 1024
        idx += 1
    if idx == 0:
        return f"{int(value)} B"
    return f"{value:.2f} {units[idx]}"


def _file_hash(path: Path) -> str:
    hasher = hashlib.md5()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(HASH_CHUNK_SIZE)
            if not chunk:
                break
            hasher.update(chunk)
    return hasher.hexdigest()


def _collect_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for dirpath, _dirnames, filenames in os.walk(root):
        dir_path = Path(dirpath)
        for name in filenames:
            if name.startswith(".") or name.startswith("~"):
                continue
            ext = Path(name).suffix.lower()
            if ext not in MEDIA_EXTS:
                continue
            files.append(dir_path / name)
    return files


async def _run(ctx: BridgeContext, job: dict[str, Any], out: BridgeOutput) -> None:
    output_dir = job.get("outputDir")
    if not output_dir:
        raise ValueError("outputDir 为空")

    root = Path(output_dir)
    if not root.exists() or not root.is_dir():
        raise ValueError(f"输出目录不存在：{output_dir}")

    out.log("正在扫描媒体文件…")
    files = await asyncio.to_thread(_collect_files, root)
    total = len(files)
    if total == 0:
        out.log("未找到可去重的媒体文件")
        out.finished(
            success=True,
            data={
                "duplicateGroups": 0,
                "duplicateFiles": 0,
                "deletedFiles": 0,
                "freedBytes": 0,
            },
        )
        return

    out.log(f"发现 {total} 个媒体文件，开始计算哈希…")

    hash_to_files: dict[str, list[Path]] = defaultdict(list)
    for idx, file_path in enumerate(files, start=1):
        try:
            file_hash = await asyncio.to_thread(_file_hash, file_path)
            hash_to_files[file_hash].append(file_path)
            out.progress(idx, total, f"正在计算哈希 {idx}/{total}")
        except Exception as exc:
            out.log(f"读取失败：{file_path} -> {exc}", level="error")

    duplicate_groups = 0
    duplicate_files = 0
    deleted_files = 0
    freed_bytes = 0

    for file_hash, paths in hash_to_files.items():
        if len(paths) <= 1:
            continue
        duplicate_groups += 1
        duplicate_files += len(paths) - 1

        # 保留每组中路径最短（通常位于原始作者目录）的文件作为原件
        paths.sort(key=lambda p: (len(str(p)), str(p)))
        keeper = paths[0]
        duplicates = paths[1:]

        out.log(f"发现重复组 hash={file_hash[:12]}…，保留 {keeper.name}，共 {len(duplicates)} 个重复")

        for dup_path in duplicates:
            try:
                file_size = dup_path.stat().st_size
                os.remove(dup_path)
                deleted_files += 1
                freed_bytes += file_size
                out.log(f"已删除：{dup_path}")
            except Exception as exc:
                out.log(f"删除失败：{dup_path} -> {exc}", level="error")

    out.progress(total, total, "去重完成")
    out.log(
        f"去重完成：{duplicate_groups} 组重复，删除 {deleted_files} 个文件，"
        f"释放 {_format_size(freed_bytes)}"
    )

    out.finished(
        success=True,
        data={
            "duplicateGroups": duplicate_groups,
            "duplicateFiles": duplicate_files,
            "deletedFiles": deleted_files,
            "freedBytes": freed_bytes,
        },
    )


def main(ctx: BridgeContext, job: dict[str, Any], out: BridgeOutput) -> None:
    asyncio.run(_run(ctx, job, out))


if __name__ == "__main__":
    safe_main(main)
