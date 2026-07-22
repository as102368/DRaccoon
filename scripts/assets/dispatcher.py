"""DRaccoon 统一 Python 桥接调度器。

将所有后端 Python 脚本（download_bridge / sync_service / login_service 等）
统一由一个 PyInstaller 打包后的 dispatcher.exe 入口调度，避免为每个脚本
单独打包一个 exe，减小体积并集中管理依赖。

调用方式：
    dispatcher.exe <script_name> [args...]

其中 script_name 不带 .py 后缀，例如：
    dispatcher.exe download_bridge --job xxx.json --task-id t1
    dispatcher.exe sync_service --sync-job xxx.json
    dispatcher.exe login_service --cookie-file xxx.txt
"""
from __future__ import annotations

import io
import os
import runpy
import sys
from pathlib import Path


def _ensure_utf8_stdio() -> None:
    """强制 stdout/stderr 使用 UTF-8，避免中文在 Windows 打包环境下被 GBK 编码导致乱码。"""
    try:
        if getattr(sys.stdout, "buffer", None) and sys.stdout.encoding != "utf-8":
            sys.stdout = io.TextIOWrapper(
                sys.stdout.buffer, encoding="utf-8", line_buffering=True
            )
        if getattr(sys.stderr, "buffer", None) and sys.stderr.encoding != "utf-8":
            sys.stderr = io.TextIOWrapper(
                sys.stderr.buffer, encoding="utf-8", line_buffering=True
            )
    except Exception:
        # 若重定向失败也不应阻塞主流程
        pass


_ensure_utf8_stdio()


def _resolve_base() -> Path:
    """获取打包后或源码运行时的根目录。"""
    if getattr(sys, "frozen", False):
        # PyInstaller 打包后：sys._MEIPASS 指向解压后的临时目录（onefile）
        # 或 exe 同级的 _internal 目录（onedir）
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            return Path(meipass)
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def _setup_paths() -> tuple[Path, Path]:
    """把 backend 与 python 源码目录加入 sys.path，供 runpy 执行的脚本导入。"""
    base = _resolve_base()
    backend = base / "backend"
    python_dir = base / "python"

    # 优先插入到 sys.path 最前，确保打包后的源码优先于系统已安装的同名包
    for p in (str(backend), str(python_dir)):
        if p not in sys.path:
            sys.path.insert(0, p)

    # 设置环境变量，供后端脚本通过环境变量定位自身目录
    if backend.exists():
        os.environ["DRACCOON_BACKEND"] = str(backend)
    if python_dir.exists():
        os.environ["DRACCOON_PYTHON"] = str(python_dir)

    return backend, python_dir


def _resolve_script(script_name: str, backend: Path, python_dir: Path) -> Path:
    """根据脚本名找到对应的脚本文件路径。

    支持两种格式：
    - .pyc 字节码文件（生产环境，源码已被编译为 .pyc 以保护代码）
    - .py 源码文件（开发环境）
    """
    # backend 中的入口脚本
    backend_scripts = {"sync_service", "login_service"}
    # python/ 中的桥接脚本
    bridge_scripts = {
        "download_bridge", "user_works_bridge", "new_releases_bridge",
        "relation_bridge", "report_bridge", "cloud_bridge",
        "archive_status_bridge", "transcript_bridge",
    }

    if script_name in backend_scripts:
        search_root = backend
    elif script_name in bridge_scripts:
        search_root = python_dir
    else:
        # 允许直接传脚本名，自动在两个目录中查找
        search_root = None
        for root in (python_dir, backend):
            for ext in (".pyc", ".py"):
                probe = root / f"{script_name}{ext}"
                if probe.exists():
                    return probe
        raise SystemExit(f"[dispatcher] 未知脚本名: {script_name}")

    # 优先查找 .pyc（生产环境），其次 .py（开发环境）
    for ext in (".pyc", ".py"):
        candidate = search_root / f"{script_name}{ext}"
        if candidate.exists():
            return candidate

    raise SystemExit(f"[dispatcher] 脚本不存在: {search_root}/{script_name}.pyc 或 .py")


def main() -> int:
    if len(sys.argv) < 2:
        print("[dispatcher] 用法: dispatcher.exe <script_name> [args...]", file=sys.stderr)
        return 2

    script_name = sys.argv[1]
    backend, python_dir = _setup_paths()
    script_path = _resolve_script(script_name, backend, python_dir)

    # 重写 sys.argv，让被调度的脚本看到正确的参数
    # argv[0] 设为脚本路径，与 "python script.py args" 行为一致
    sys.argv = [str(script_path)] + sys.argv[2:]

    try:
        runpy.run_path(str(script_path), run_name="__main__")
        return 0
    except SystemExit as e:
        # 被调度脚本调用 sys.exit() 时，返回其退出码
        code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
        return code
    except Exception:
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
