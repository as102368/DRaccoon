"""统一的 JSON Lines 桥接基类。

所有后端桥接脚本都按同一协议向 stdout 输出 JSON 行，主进程读取后通过 IPC
推送给渲染层。
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

from .redactor import SensitiveRedactor


@dataclass
class BridgeContext:
    """桥接任务上下文。"""

    task_id: str
    task_type: str


class BridgeOutput:
    """封装桥接脚本输出，自动脱敏并 flush。"""

    def __init__(self, context: BridgeContext | None = None):
        self.context = context
        self._finished = False

    def emit(self, event: str, data: dict[str, Any] | None = None):
        """输出一条 JSON Lines 事件。

        使用 redact_dict 对 payload 做键级脱敏，避免 redact_text 的正则
        匹配到 URL 中的 key=value 片段（如 x-signature=xxx）从而破坏 JSON
        引号和逗号，导致前端 JSON.parse 失败、事件丢失。
        """
        payload = {"event": event}
        if self.context:
            payload["task_id"] = self.context.task_id
            payload["task_type"] = self.context.task_type
        if data:
            payload.update(data)
        payload = SensitiveRedactor.redact_dict(payload)
        line = json.dumps(payload, ensure_ascii=False)
        print(line, flush=True)

    def log(self, message: str, level: str = "info"):
        """输出脱敏后的日志行。"""
        safe = SensitiveRedactor.redact_text(message)
        self.emit("log", {"level": level, "message": safe})

    def progress(self, current: int, total: int, message: str = ""):
        self.emit("progress", {"current": current, "total": total, "message": message})

    def finished(self, success: bool = True, data: dict[str, Any] | None = None):
        if self._finished:
            return
        self._finished = True
        out = {"success": success}
        if data:
            out.update(data)
        self.emit("finished", out)

    def error(self, message: str):
        if self._finished:
            return
        self.log(message, level="error")
        self.finished(success=False, data={"error": SensitiveRedactor.redact_text(message)})


def read_job_file(path: str) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _is_log_path_allowed(log_path: str) -> bool:
    """检查日志路径是否位于允许的日志目录内，防止 taskId 路径穿越。"""
    user_data = os.environ.get("DOUZY_USER_DATA")
    if not user_data:
        return True  # 无环境变量时不做限制，保持向后兼容
    try:
        resolved = Path(log_path).resolve()
        allowed_root = Path(user_data).resolve() / "logs" / "bridges"
        resolved.relative_to(allowed_root)
        return True
    except Exception:
        return False


def _redirect_to_files(stdout_log: Optional[str], stderr_log: Optional[str]) -> None:
    """将 stdout/stderr 重定向到日志文件，避免 Electron GUI 进程的 stdio 事件不可靠。"""
    if stdout_log:
        try:
            if not _is_log_path_allowed(stdout_log):
                sys.stderr.write(f"拒绝写入非法日志路径: {stdout_log}\n")
                return
            Path(stdout_log).parent.mkdir(parents=True, exist_ok=True)
            sys.stdout = open(stdout_log, "w", encoding="utf-8", buffering=1)
        except Exception:
            pass
    if stderr_log:
        try:
            if not _is_log_path_allowed(stderr_log):
                return
            Path(stderr_log).parent.mkdir(parents=True, exist_ok=True)
            sys.stderr = open(stderr_log, "w", encoding="utf-8", buffering=1)
        except Exception:
            pass


def _flush_streams() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except Exception:
            pass


def safe_main(main_func: Callable[[BridgeContext, dict[str, Any], BridgeOutput], Any]):
    """桥接脚本入口装饰器。

    用法：
        def main(ctx, job, out):
            ...

        if __name__ == '__main__':
            safe_main(main)
    """
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True, help="任务 JSON 文件路径")
    parser.add_argument("--task-id", default=None, help="任务 ID")
    parser.add_argument("--stdout-log", default=None, help="stdout 重定向目标日志文件")
    parser.add_argument("--stderr-log", default=None, help="stderr 重定向目标日志文件")
    args = parser.parse_args()

    # 尽早重定向，确保后续所有 JSON Lines 事件都写入 Electron 可轮询的日志文件。
    _redirect_to_files(args.stdout_log, args.stderr_log)

    try:
        job = read_job_file(args.job)
    except Exception as e:
        out = BridgeOutput()
        out.error(f"读取任务文件失败: {e}")
        _flush_streams()
        sys.exit(1)

    task_id = args.task_id or job.get("task_id") or "unknown"
    task_type = job.get("task_type") or "unknown"
    ctx = BridgeContext(task_id=task_id, task_type=task_type)
    out = BridgeOutput(ctx)

    try:
        main_func(ctx, job, out)
        out.finished(success=True)
    except Exception as e:
        out.error(str(e))
        sys.exit(1)
    finally:
        _flush_streams()
