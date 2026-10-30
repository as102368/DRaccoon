"""让 tests/ 目录下的用例可以直接用 `pytest backend/tests` 运行。

背景（三个坑叠加）：

1. `test_sync_likes_order.py` 以 `from backend.sync_service import ...` 导入，
   需要能解析 `backend` 包（即 `backend/` 的父目录 `_internal/` 要在 sys.path 上）；
2. 而 `sync_service` 内部又用 `from auth import ...` / `from utils.cookie_utils import ...`，
   需要把 `backend/` 自身也放进模块搜索路径；
3. 但 `_internal/` 里带有为 Python 3.14 编译的标准库/第三方扩展
   （`_sqlite3.pyd` / `unicodedata.pyd` / `aiosqlite` 等）。一旦它排在标准库前面，
   在 3.13 解释器上导入就会报：
   ``ImportError: Module use of python314.dll conflicts with this version of Python``

因此这里采取「只暴露 backend 根目录 + 屏蔽 _internal」的方案：

* 把 `backend/` 根目录插到 sys.path 最前（`core` / `utils` / `auth` / `storage` 可直接导入）；
* 在 sys.modules 中注册一个 `__path__` 指向 backend 根目录的 `backend` 包，
  这样 `import backend.sync_service` 也能成立，无需把 `_internal/` 放进 sys.path；
* 挂一个 `_SafePathFinder`（优先级最高）在解析顶层模块时忽略 `_internal/`，
  避免 pytest 后续把它追加进 sys.path 后再次遮蔽标准库与 venv 依赖。
"""
import os
import sys
import types
from importlib.machinery import PathFinder
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
INTERNAL_ROOT = BACKEND_ROOT.parent
_BACKEND_ROOT_STR = str(BACKEND_ROOT)
_INTERNAL_ROOT_STR = str(INTERNAL_ROOT)


def _is_internal_entry(entry: str) -> bool:
    if not entry:
        return False
    try:
        return os.path.abspath(entry) == _INTERNAL_ROOT_STR
    except OSError:
        return False


class _SafePathFinder(PathFinder):
    """解析顶层模块时忽略 `_internal/`，避免 cp314 扩展遮蔽标准库。"""

    @classmethod
    def find_spec(cls, fullname, path=None, target=None):
        if path is None:
            path = [entry for entry in sys.path if not _is_internal_entry(entry)]
        return super().find_spec(fullname, path, target)


if _BACKEND_ROOT_STR not in sys.path:
    sys.path.insert(0, _BACKEND_ROOT_STR)

if not any(issubclass(finder, _SafePathFinder) for finder in sys.meta_path if isinstance(finder, type)):
    sys.meta_path.insert(0, _SafePathFinder)

if "backend" not in sys.modules:
    backend_pkg = types.ModuleType("backend")
    backend_pkg.__path__ = [_BACKEND_ROOT_STR]
    sys.modules["backend"] = backend_pkg
