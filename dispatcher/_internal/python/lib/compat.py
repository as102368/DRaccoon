"""兼容层：优先使用本项目 backend，fallback 到相邻的 douyin-downloader 目录。"""
from __future__ import annotations

import sys
from pathlib import Path


def ensure_backend_path() -> Path | None:
    """把本地 backend 目录优先加入 sys.path；不存在时再回退到相邻的 douyin-downloader。"""
    local_backend = (Path(__file__).resolve().parents[2] / ".." / "backend").resolve()
    if local_backend.exists() and str(local_backend) not in sys.path:
        sys.path.insert(0, str(local_backend))
        return local_backend

    legacy_backend = (Path(__file__).resolve().parents[2] / ".." / "douyin-downloader").resolve()
    if legacy_backend.exists() and str(legacy_backend) not in sys.path:
        sys.path.insert(0, str(legacy_backend))
        return legacy_backend

    return None


def backend_root() -> Path | None:
    local_backend = (Path(__file__).resolve().parents[2] / ".." / "backend").resolve()
    if local_backend.exists():
        return local_backend
    legacy_backend = (Path(__file__).resolve().parents[2] / ".." / "douyin-downloader").resolve()
    return legacy_backend if legacy_backend.exists() else None
