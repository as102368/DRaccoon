"""一键修复 DRaccoon 的浏览器兜底采集（抖音 Argus 风控后主页作品解析失败）。

背景：2026-09-14 起抖音对 aweme/post 等接口启用 Argus 风控门禁，非浏览器直连请求
一律 403，只能靠浏览器兜底采集；而打包环境默认缺少 playwright，导致兜底从未运行。

用法（在本机任意 Python 3.9+ 上运行即可，推荐双击或：）
    py -3 fix_browser_fallback.py

脚本做的事：
1. 把与打包环境（嵌入版 Python 3.14 / win_amd64）匹配的 playwright 及其依赖解包进
   dispatcher/_internal（不会污染系统 Python 环境，也不需要下载浏览器本体）；
2. 检查 api_client.py 是否已应用"回退系统 Chrome/Edge"的补丁，缺失时给出提示；
3. 用打包环境真实导入一次 playwright，确认可用。

应用升级/重装后 dispatchr/_internal 会被覆盖，重新运行本脚本即可恢复。
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

BUNDLE_ROOT = Path(__file__).resolve().parent
INTERNAL_DIR = BUNDLE_ROOT / "dispatcher" / "_internal"
PYTHON_DIR = INTERNAL_DIR / "python"
API_CLIENT = INTERNAL_DIR / "backend" / "core" / "api_client.py"
DISPATCHER_EXE = BUNDLE_ROOT / "dispatcher" / "dispatcher.exe"
PROBE_SCRIPT = PYTHON_DIR / "_probe_playwright.py"

# 打包环境为 win_amd64 的嵌入式 Python 3.14，取 cp314 轮子。
WHEEL_SPECS = ("playwright", "greenlet", "pyee")
TARGET_PYTHON_VERSION = "3.14"
TARGET_PLATFORM = "win_amd64"

PROBE_SOURCE = '''import sys

try:
    from playwright.async_api import async_playwright
except Exception as exc:
    print("PLAYWRIGHT_FAIL", repr(exc))
    raise SystemExit(1)

print("PLAYWRIGHT_OK", sys.version.split()[0])
'''


def download_wheels(dest: Path) -> list[Path]:
    cmd = [
        sys.executable,
        "-m",
        "pip",
        "download",
        *WHEEL_SPECS,
        "--python-version",
        TARGET_PYTHON_VERSION,
        "--platform",
        TARGET_PLATFORM,
        "--only-binary=:all:",
        "-d",
        str(dest),
        "-q",
    ]
    subprocess.run(cmd, check=True)
    return sorted(dest.glob("*.whl"))


def unpack_wheels(wheels: list[Path]) -> list[str]:
    installed = []
    for wheel in wheels:
        with zipfile.ZipFile(wheel) as zf:
            zf.extractall(INTERNAL_DIR)
        installed.append(wheel.name)
    return installed


def playwright_installed() -> bool:
    """判断打包环境里 playwright + greenlet 是否已就位（async_api 是包目录）。"""
    has_playwright = (INTERNAL_DIR / "playwright" / "async_api").is_dir() or (
        INTERNAL_DIR / "playwright" / "async_api.py"
    ).exists()
    has_greenlet = (INTERNAL_DIR / "greenlet").is_dir()
    return has_playwright and has_greenlet


def code_patched() -> bool:
    if not API_CLIENT.exists():
        return False
    return "_launch_playwright_browser" in API_CLIENT.read_text(encoding="utf-8")


def verify_in_bundled_runtime() -> str:
    if not DISPATCHER_EXE.exists():
        return "SKIP（未找到 dispatcher.exe）"
    PYTHON_DIR.mkdir(parents=True, exist_ok=True)
    PROBE_SCRIPT.write_text(PROBE_SOURCE, encoding="utf-8")
    proc = subprocess.run(
        [str(DISPATCHER_EXE), "_probe_playwright"],
        capture_output=True,
        text=True,
        timeout=120,
    )
    output = (proc.stdout or "") + (proc.stderr or "")
    if "PLAYWRIGHT_OK" in output:
        return "OK：" + output.strip().splitlines()[-1]
    return "FAIL：" + output.strip().splitlines()[-1][:300]


def main() -> int:
    if not INTERNAL_DIR.exists():
        print(f"[错误] 未找到 {INTERNAL_DIR}，请把本脚本放在 DRaccoon 安装目录下运行。")
        return 1

    print(f"目标环境：{INTERNAL_DIR}")

    if not playwright_installed():
        with tempfile.TemporaryDirectory() as tmp:
            print("正在下载 playwright 依赖（win_amd64 / cp314）...")
            try:
                wheels = download_wheels(Path(tmp))
            except subprocess.CalledProcessError as exc:
                print(f"[错误] 下载失败：{exc}")
                return 1
            print("正在解包到打包环境...")
            for name in unpack_wheels(wheels):
                print(f"  + {name}")
    else:
        print("playwright 依赖：已存在，跳过。")

    print("浏览器兜底代码补丁：" + ("已应用" if code_patched() else "未应用"))
    if not code_patched():
        print(f"[注意] {API_CLIENT.name} 缺少 _launch_playwright_browser 补丁，")
        print("       重装/升级后需要重新打补丁，否则仍会回退失败。")

    print("打包环境导入校验：", end="")
    print(verify_in_bundled_runtime())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
