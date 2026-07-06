"""统一的 JSON Lines 桥接基类。

所有后端桥接脚本都按同一协议向 stdout 输出 JSON 行，主进程读取后通过 IPC
推送给渲染层。
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from typing import Any, Callable

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
        """输出一条 JSON Lines 事件。"""
        payload = {"event": event}
        if self.context:
            payload["task_id"] = self.context.task_id
            payload["task_type"] = self.context.task_type
        if data:
            payload.update(data)
        line = json.dumps(payload, ensure_ascii=False)
        line = SensitiveRedactor.redact_text(line)
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
    args = parser.parse_args()

    try:
        job = read_job_file(args.job)
    except Exception as e:
        out = BridgeOutput()
        out.error(f"读取任务文件失败: {e}")
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
