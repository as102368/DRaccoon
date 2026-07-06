"""兼容层：将 d:\\DOU\\douyin-downloader 加入 sys.path，供本项目的 Python 模块复用。"""
from __future__ import annotations

import sys
from pathlib import Path


def ensure_backend_path() -> Path | None:
    """把相邻的 douyin-downloader 目录加入 sys.path（如果存在）。"""
    backend = (Path(__file__).resolve().parents[2] / ".." / "douyin-downloader").resolve()
    if backend.exists() and str(backend) not in sys.path:
        sys.path.insert(0, str(backend))
    return backend if backend.exists() else None


def backend_root() -> Path | None:
    path = (Path(__file__).resolve().parents[2] / ".." / "douyin-downloader").resolve()
    return path if path.exists() else None
