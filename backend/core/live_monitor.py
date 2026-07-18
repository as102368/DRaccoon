"""抖音直播自动监控与录制调度器。

为 Electron 前端提供常驻后台能力：持续轮询多个直播间状态，检测到
status == 2（直播中）时自动开始分段录制，并通过 emit 回调输出进度事件。
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, Set

from auth import CookieManager
from config import ConfigLoader
from core.api_client import DouyinAPIClient
from core.live_downloader import LiveDownloader
from storage import Database, FileManager
from utils.logger import setup_logger

logger = setup_logger("LiveMonitor")


class LiveMonitor:
    """多房间直播监控器。

    每个房间对应一个独立的 asyncio.Task，任务内部持有自己的 DouyinAPIClient
    与 LiveDownloader，互不阻塞。通过 ``stop()`` 可统一停止所有监控。
    """

    def __init__(
        self,
        config: ConfigLoader,
        cookie_manager: CookieManager,
        database: Optional[Database] = None,
        emit: Optional[Callable[[str, Any], None]] = None,
    ):
        self.config = config
        self.cookie_manager = cookie_manager
        self.database = database
        self._emit = emit or (lambda _event, **_kwargs: None)
        self._stop_event = asyncio.Event()
        self._tasks: Set[asyncio.Task] = set()
        self._running = False
        self._last_record_end_time: Dict[str, float] = {}

    async def start(self, room_ids: List[str]) -> None:
        """启动对给定房间列表的监控。"""
        if self._running:
            logger.warning("LiveMonitor already running")
            return

        live_cfg = self._live_config()
        max_rooms = int(live_cfg.get("max_monitor_rooms") or 10)
        if len(room_ids) > max_rooms:
            logger.warning(
                "Too many rooms (%d), limiting to %d",
                len(room_ids),
                max_rooms,
            )
            room_ids = room_ids[:max_rooms]

        if not room_ids:
            self._emit("live:error", room_id="", message="没有需要监控的房间", fatal=True)
            return

        self._running = True
        self._stop_event.clear()
        for room_id in room_ids:
            task = asyncio.create_task(
                self._monitor_room(str(room_id)),
                name=f"live-monitor-{room_id}",
            )
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

        logger.info("LiveMonitor started for %d room(s)", len(room_ids))

    async def stop(self) -> None:
        """停止所有监控任务并等待它们收尾。"""
        if not self._running:
            return

        self._stop_event.set()
        logger.info("LiveMonitor stopping...")

        if self._tasks:
            for task in list(self._tasks):
                task.cancel()
            await asyncio.gather(*self._tasks, return_exceptions=True)
            self._tasks.clear()

        self._running = False
        logger.info("LiveMonitor stopped")

    async def _monitor_room(self, room_id: str) -> None:
        """单个房间的轮询循环。"""
        recording_task: Optional[asyncio.Task] = None
        poll_interval = float(self._live_config().get("poll_interval_seconds") or 30)

        try:
            file_manager = FileManager(self.config.get("path"))
            async with DouyinAPIClient(
                self.cookie_manager.get_cookies(),
                proxy=self.config.get("proxy"),
            ) as api_client:
                downloader = LiveDownloader(
                    self.config,
                    api_client,
                    file_manager,
                    self.cookie_manager,
                    database=self.database,
                    progress_reporter=None,
                )

                while not self._stop_event.is_set():
                    # 若上一轮录制任务已自然结束，先记录结束时间并清理引用，
                    # 避免状态抖动期间重复启动录制。
                    if recording_task is not None and recording_task.done():
                        try:
                            await recording_task
                        except asyncio.CancelledError:
                            pass
                        self._last_record_end_time[room_id] = time.monotonic()
                        recording_task = None

                    try:
                        info = await api_client.get_live_room_info(room_id)
                    except Exception as exc:
                        logger.warning("Poll room %s failed: %s", room_id, exc)
                        self._emit(
                            "live:error",
                            room_id=room_id,
                            message=f"轮询失败: {exc}",
                            fatal=False,
                        )
                        try:
                            await asyncio.wait_for(
                                self._stop_event.wait(), timeout=poll_interval
                            )
                        except asyncio.TimeoutError:
                            continue
                        break

                    status = self._extract_status(info)
                    self._emit(
                        "live:polling",
                        room_id=room_id,
                        status=status,
                        timestamp=datetime.now().isoformat(timespec="seconds"),
                    )

                    if status == 2:
                        now_ts = time.monotonic()
                        last_end = self._last_record_end_time.get(room_id, 0)
                        cooldown = poll_interval * 2
                        in_cooldown = now_ts - last_end <= cooldown

                        if in_cooldown:
                            logger.debug(
                                "Room %s recording restart cooldown active (%.1fs left)",
                                room_id,
                                cooldown - (now_ts - last_end),
                            )

                        if not in_cooldown and (
                            recording_task is None or recording_task.done()
                        ):
                            room = (info or {}).get("room") or {}
                            user = (info or {}).get("user") or {}
                            author_name = (
                                user.get("nickname") or "unknown"
                            ).strip() or "unknown"
                            title = (room.get("title") or "直播").strip() or "直播"
                            save_dir, file_stem = downloader._plan_output_paths(
                                author_name, title, room_id
                            )

                            stream_url, quality = LiveDownloader._select_best_stream_url(room)
                            self._emit(
                                "live:start",
                                room_id=room_id,
                                title=title,
                                author=author_name,
                                quality=quality,
                                save_dir=str(save_dir),
                            )

                            stop_event = asyncio.Event()

                            async def _record_wrapper():
                                try:
                                    await downloader.record_live_session(
                                        room_id,
                                        info or {},
                                        save_dir,
                                        file_stem,
                                        emit=self._emit,
                                        stop_event=stop_event,
                                    )
                                except asyncio.CancelledError:
                                    stop_event.set()
                                    raise
                                except Exception as exc:
                                    logger.exception(
                                        "Recording task error for room %s", room_id
                                    )
                                    self._emit(
                                        "live:error",
                                        room_id=room_id,
                                        message=f"录制异常: {exc}",
                                        fatal=False,
                                    )

                            recording_task = asyncio.create_task(
                                _record_wrapper(),
                                name=f"live-record-{room_id}",
                            )
                    else:
                        if recording_task is not None and not recording_task.done():
                            recording_task.cancel()
                            try:
                                await recording_task
                            except asyncio.CancelledError:
                                pass
                            self._last_record_end_time[room_id] = time.monotonic()
                            recording_task = None
                            self._emit(
                                "live:offline",
                                room_id=room_id,
                                status=status,
                                timestamp=datetime.now().isoformat(timespec="seconds"),
                            )

                    try:
                        await asyncio.wait_for(
                            self._stop_event.wait(), timeout=poll_interval
                        )
                    except asyncio.TimeoutError:
                        pass

        except asyncio.CancelledError:
            logger.info("Monitor task for room %s cancelled", room_id)
        except Exception as exc:
            logger.exception("Monitor task for room %s failed", room_id)
            self._emit(
                "live:error",
                room_id=room_id,
                message=f"监控异常: {exc}",
                fatal=True,
            )
        finally:
            if recording_task is not None and not recording_task.done():
                recording_task.cancel()
                try:
                    await recording_task
                except asyncio.CancelledError:
                    pass
            self._last_record_end_time[room_id] = time.monotonic()
            self._emit(
                "live:stopped",
                room_id=room_id,
                reason="stopped" if self._stop_event.is_set() else "error",
            )

    def _live_config(self) -> Dict[str, Any]:
        cfg = self.config.get("live") or {}
        return cfg if isinstance(cfg, dict) else {}

    @staticmethod
    def _extract_status(info: Optional[Dict[str, Any]]) -> int:
        if not info:
            return 0
        room = info.get("room") or {}
        status = room.get("status")
        try:
            return int(status) if status is not None else 0
        except (ValueError, TypeError):
            return 0
