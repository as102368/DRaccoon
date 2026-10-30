from __future__ import annotations

from typing import Any, Dict, List, Optional, Set

from core.downloader_base import BaseDownloader, DownloadResult
from core.user_mode_registry import UserModeRegistry
from utils.logger import setup_logger

logger = setup_logger("UserDownloader")


class UserDownloader(BaseDownloader):
    SELF_COLLECT_MODES = {"collect", "collectmix"}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.mode_registry = UserModeRegistry()
        self._mode_strategy_cache: Dict[str, Any] = {}

    async def download(self, parsed_url: Dict[str, Any]) -> DownloadResult:
        result = DownloadResult()

        sec_uid = parsed_url.get("sec_uid")
        if not sec_uid:
            # URL parser already validates this; treat as fatal instead of
            # a silent empty result so the UI surfaces a real error rather
            # than "已完成 0 项".
            raise RuntimeError("无法从链接中解析出用户 ID，请确认链接是否完整")

        modes_config = self.config.get("mode", ["post"])
        if isinstance(modes_config, str):
            modes = [modes_config]
        elif isinstance(modes_config, list):
            modes = [str(mode).strip() for mode in modes_config if str(mode).strip()]
        else:
            modes = ["post"]

        if not self._validate_mode_scope(sec_uid, modes):
            return result

        user_info = await self._resolve_user_info(sec_uid, modes)
        if not user_info:
            logger.error("Failed to get user info: %s", sec_uid)
            # Raising here instead of returning an empty result means the
            # job ends in `failed` state with a clear message. Returning
            # {total:0,success:0,failed:0} made JobManager mark it as
            # `success`, which rendered as "已完成 0 项" — a silent failure
            # that's indistinguishable from "nothing happened" in the UI.
            raise RuntimeError("获取用户信息失败，请检查 Cookie 是否有效或重新登录抖音")

        # Cache author metadata on the hosting job so retry doesn't have
        # to re-fetch user_info, and so JobRow can display the nickname.
        self._progress_report_author(
            nickname=user_info.get("nickname"),
            sec_uid=user_info.get("sec_uid") or sec_uid,
        )

        self._progress_update_step("下载模式", f"模式: {', '.join(modes)}")

        # 用户作品下载完全依赖桌面端自带 Chromium 桥（CDP 拦截）；桥不可用则所有模式都会
        # 静默拿到 0 条，UI 显示"已完成 0 项"极难排查。提前给出可操作报错。
        if not getattr(self.api_client, "is_bridge_available", lambda: False)():
            raise RuntimeError(
                "下载失败：桌面端桥接不可用。请先打开 DRaccoon 桌面端并保持抖音登录，"
                "然后在桌面端内触发下载（不要单独运行 dispatcher 后端）。"
            )

        seen_aweme_ids: Set[str] = set()
        mode_errors: Dict[str, str] = {}
        for mode in modes:
            strategy = self._get_mode_strategy(mode)
            if strategy is None:
                logger.warning("Unsupported user mode: %s", mode)
                mode_errors[mode] = "不支持的下载模式"
                continue

            self._progress_update_step("下载模式", f"开始处理 {mode} 作品")
            try:
                mode_result = await strategy.download_mode(
                    sec_uid, user_info, seen_aweme_ids=seen_aweme_ids
                )
            except Exception as exc:
                # 参考 Douzy 0.11.6：各模式互不影响跑完，任一模式失败不连坐其他模式。
                msg = str(exc) or f"{mode} 模式处理失败"
                logger.error("Mode %s failed: %s", mode, msg)
                self._progress_update_step("下载模式", f"{mode} 失败：{msg}")
                mode_errors[mode] = msg
                continue

            result.total += mode_result.total
            result.success += mode_result.success
            result.failed += mode_result.failed
            result.skipped += mode_result.skipped

        result.sec_uid = sec_uid

        # 仅当所有模式都没拿到内容时才判定任务失败；任一模式成功即返回结果，
        # 失败的 mode 原因会写入日志和进度流。
        if result.total == 0 and mode_errors:
            summary = "；".join(f"{mode}：{err}" for mode, err in mode_errors.items())
            raise RuntimeError(f"全部模式均未拿到内容：{summary}")

        if mode_errors:
            summary = "；".join(f"{mode}：{err}" for mode, err in mode_errors.items())
            logger.warning("部分模式失败但仍继续完成：%s", summary)

        return result

    def _validate_mode_scope(self, sec_uid: str, modes: List[str]) -> bool:
        normalized_modes = {str(mode or "").strip() for mode in modes}
        has_collect_mode = bool(normalized_modes & self.SELF_COLLECT_MODES)
        has_regular_mode = bool(normalized_modes - self.SELF_COLLECT_MODES)

        if has_collect_mode and sec_uid != "self":
            # Desktop "我的内容 / 下载本收藏夹" sends the real self sec_uid
            # together with a ``collects_id`` filter — by the time the
            # request reaches here the sidecar has already verified via
            # the cookie scope (``_resolve_viewer_sec_uid``) that the
            # caller is the logged-in user, so a real sec_uid + collect
            # mode + collects_id is the legit my-content path. Without
            # this branch ``download()`` would short-circuit and produce
            # an empty DownloadResult, which the JobManager renders as
            # the silent "已完成 0 项" failure.
            collects_id = (str(self.config.get("collects_id") or "")).strip()
            if not collects_id:
                logger.error(
                    "Modes collect/collectmix only support "
                    "/user/self?showTab=favorite_collection or "
                    "my-content 下载本收藏夹 (collects_id required)"
                )
                return False
        if has_collect_mode and has_regular_mode:
            logger.error("Modes collect/collectmix cannot be combined with post/like/mix/music")
            return False
        return True

    def _filter_pinned_items(self, items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        if self._download_pinned_enabled():
            return items
        return [item for item in items if not self._is_pinned_aweme(item)]

    def _download_pinned_enabled(self) -> bool:
        return self._as_bool(self.config.get("download_pinned", False))

    @staticmethod
    def _is_pinned_aweme(item: Dict[str, Any]) -> bool:
        value = item.get("is_top")
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)

    @staticmethod
    def _as_bool(value: Any) -> bool:
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)

    async def _resolve_user_info(self, sec_uid: str, modes: List[str]) -> Optional[Dict[str, Any]]:
        normalized_modes = {str(mode or "").strip() for mode in modes}
        if sec_uid == "self" and normalized_modes.issubset(self.SELF_COLLECT_MODES):
            self._progress_update_step("获取作者信息", "使用当前登录账号收藏夹上下文")
            return {
                "uid": "self",
                "sec_uid": "self",
                "nickname": "self",
            }

        # Desktop my-content "下载本收藏夹" path: real sec_uid + collect
        # mode + collects_id filter. The cookie scope upstream already
        # guarantees this is the viewer themselves, so we can skip the
        # network round-trip via ``api_client.get_user_info``.
        if (
            normalized_modes.issubset(self.SELF_COLLECT_MODES)
            and (str(self.config.get("collects_id") or "")).strip()
        ):
            self._progress_update_step("获取作者信息", "使用当前登录账号收藏夹上下文")
            return {
                "uid": sec_uid,
                "sec_uid": sec_uid,
                "nickname": "self",
            }

        self._progress_update_step("获取作者信息", f"sec_uid={sec_uid}")
        return await self.api_client.get_user_info(sec_uid)

    def _get_mode_strategy(self, mode: str):
        normalized_mode = (mode or "").strip()

        # The "collect" strategy supports an optional ``collects_id`` filter
        # that constrains paging to a single folder (desktop "我的收藏 / 下载
        # 本收藏夹"). When the filter is set we bypass the cache so the next
        # call with a different (or absent) filter doesn't reuse a stale
        # strategy bound to the previous folder. The no-filter path keeps
        # caching to preserve the existing CLI behaviour.
        if normalized_mode == "collect":
            return self._make_collect_strategy()

        if normalized_mode in self._mode_strategy_cache:
            return self._mode_strategy_cache[normalized_mode]

        strategy_cls = self.mode_registry.get(normalized_mode)
        if strategy_cls is None:
            return None

        strategy = strategy_cls(self)
        self._mode_strategy_cache[normalized_mode] = strategy
        return strategy

    def _make_collect_strategy(self):
        """Construct the collect strategy, threading ``collects_id`` from
        the per-job config when present. Caches only the no-filter path
        (matching the historic CLI behaviour) so a subsequent call with a
        different filter doesn't pick up a stale binding.
        """
        strategy_cls = self.mode_registry.get("collect")
        if strategy_cls is None:
            return None

        raw_filter = self.config.get("collects_id")
        collects_id = (str(raw_filter).strip() if raw_filter is not None else "") or None

        if collects_id is None:
            cached = self._mode_strategy_cache.get("collect")
            if cached is not None:
                return cached
            strategy = strategy_cls(self)
            self._mode_strategy_cache["collect"] = strategy
            return strategy

        # Filtered path is request-scoped — never cached.
        return strategy_cls(self, collects_id=collects_id)

    async def _download_mode_items(
        self,
        mode: str,
        items: List[Dict[str, Any]],
        author_name: str,
        seen_aweme_ids: Optional[Set[str]] = None,
        sec_uid: Optional[str] = None,
    ) -> DownloadResult:
        if seen_aweme_ids is None:
            seen_aweme_ids = set()
        deduped_items: List[Dict[str, Any]] = []
        local_seen: Set[str] = set()

        for item in items:
            aweme_id = str(item.get("aweme_id") or "").strip()
            if not aweme_id:
                continue
            if aweme_id in seen_aweme_ids or aweme_id in local_seen:
                continue
            local_seen.add(aweme_id)
            seen_aweme_ids.add(aweme_id)
            deduped_items.append(item)

        result = DownloadResult()
        result.total = len(deduped_items)
        self._progress_set_item_total(result.total, "作品待下载")
        self._progress_update_step("下载作品", f"待处理 {result.total} 条")

        # Accumulate per-aweme DB records and flush in a single transaction
        # at the end — avoids one fsync per item across the whole batch.
        db_batch: Optional[List[Dict[str, Any]]] = [] if self.database else None

        async def _process_aweme(item: Dict[str, Any]):
            aweme_id = item.get("aweme_id")
            item_sec_uid = sec_uid or item.get("author", {}).get("sec_uid")
            if not await self._should_download(
                str(aweme_id or ""), sec_uid=item_sec_uid, mode=mode
            ):
                self._progress_advance_item("skipped", str(aweme_id or "unknown"))
                return {"status": "skipped", "aweme_id": aweme_id}

            success, _error_message = await self._download_aweme_assets(
                item, author_name, mode=mode, db_batch=db_batch
            )
            status = "success" if success else "failed"
            self._progress_advance_item(status, str(aweme_id or "unknown"))
            return {
                "status": status,
                "aweme_id": aweme_id,
            }

        download_results = await self.queue_manager.download_batch(_process_aweme, deduped_items)

        if db_batch:
            await self.database.add_aweme_batch(db_batch)

        for entry in download_results:
            status = entry.get("status") if isinstance(entry, dict) else None
            if status == "success":
                result.success += 1
            elif status == "failed":
                result.failed += 1
            elif status == "skipped":
                result.skipped += 1
            else:
                result.failed += 1
                self._progress_advance_item("failed", "unknown")

        return result

    # 向后兼容：旧测试仍直接调用 post 下载入口。
    async def _download_user_post(self, sec_uid: str, user_info: Dict[str, Any]) -> DownloadResult:
        strategy = self._get_mode_strategy("post")
        if strategy is None:
            return DownloadResult()
        return await strategy.download_mode(sec_uid, user_info, seen_aweme_ids=set())

    async def _batch_fetch_details(
        self,
        missing_ids: List[str],
        browser_aweme_items: Dict[str, Dict[str, Any]],
    ) -> Dict[str, Dict[str, Any]]:
        """批量补拉缺失的作品详情。

        浏览器采集已拿到的完整对象直接复用；其余走页内并发 XHR 通道一次性取回。
        历史实现是逐个作品调 get_video_detail，桌面端会为每个作品新开一个 Chromium
        窗口（约 20s/条且频繁失败），批量化后可做到数十条详情数秒返回且全程无窗口。
        """
        need_ids = [str(aweme_id) for aweme_id in missing_ids if str(aweme_id) not in browser_aweme_items]
        if not need_ids:
            return {}
        fetcher = getattr(self.api_client, "get_video_details_batch", None)
        if fetcher is None:
            return {}
        try:
            self._progress_update_step("浏览器回补", f"批量补详情 {len(need_ids)} 个（页内通道）")
            return await fetcher(need_ids) or {}
        except Exception as exc:  # noqa: BLE001
            logger.warning("批量详情失败，回退逐条获取：%s", exc)
            return {}

    async def _recover_user_post_with_browser(
        self,
        sec_uid: str,
        user_info: Dict[str, Any],
        aweme_list: List[Dict[str, Any]],
    ) -> None:
        browser_cfg = self.config.get("browser_fallback") or self.config.get("browserFallback") or {}
        if not browser_cfg.get("enabled", True):
            return

        number_limit = self.config.get("number", {}).get("post", 0)
        # 在分页受限场景下，user_info.aweme_count 常常不可靠（经常只返回 20）
        # 因此仅在用户显式设置 number_limit 时才限制浏览器采集目标数量。
        expected_count = int(number_limit or 0)
        if expected_count and len(aweme_list) >= expected_count:
            return

        # 作品多的作者需要更多滚动次数；按作者估算数量动态保底。
        author_count = int(user_info.get("aweme_count") or 0)
        configured_max_scrolls = int(browser_cfg.get("max_scrolls", 240) or 240)
        max_scrolls = configured_max_scrolls
        if author_count > expected_count:
            # 每页约 15~20 条，留一定余量。
            needed_scrolls = int(author_count / 15) + 50
            max_scrolls = max(max_scrolls, needed_scrolls)

        headless = bool(browser_cfg.get("headless", True))
        if headless:
            self._progress_update_step(
                "浏览器回补",
                "使用无头浏览器采集（如遇验证码请改为可见模式）",
            )

        try:
            browser_aweme_ids = await self.api_client.collect_user_post_ids_via_browser(
                sec_uid,
                expected_count=expected_count,
                headless=headless,
                max_scrolls=max_scrolls,
                idle_rounds=int(browser_cfg.get("idle_rounds", 8) or 8),
                wait_timeout_seconds=int(browser_cfg.get("wait_timeout_seconds", 600) or 600),
            )
        except Exception as exc:
            logger.error("Browser fallback failed: %s", exc)
            self._progress_update_step("浏览器回补", f"失败：{exc}")
            return

        browser_aweme_items: Dict[str, Dict[str, Any]] = {}
        browser_post_stats: Dict[str, int] = {}
        if hasattr(self.api_client, "pop_browser_post_aweme_items"):
            try:
                browser_aweme_items = self.api_client.pop_browser_post_aweme_items() or {}
            except Exception as exc:
                logger.debug("Fetch browser post items skipped: %s", exc)
        if hasattr(self.api_client, "pop_browser_post_stats"):
            try:
                browser_post_stats = self.api_client.pop_browser_post_stats() or {}
            except Exception as exc:
                logger.debug("Fetch browser post stats skipped: %s", exc)

        if not browser_aweme_ids:
            logger.warning("Browser fallback returned no aweme_id")
            self._progress_update_step(
                "浏览器回补",
                "未采集到作品 ID：可能遇到验证码、Cookie 失效或浏览器被关闭",
            )
            return

        self._progress_update_step(
            "浏览器回补",
            f"已采集 {len(browser_aweme_ids)} 个作品 ID，准备补全详情",
        )

        existing_ids = {str(item.get("aweme_id")) for item in aweme_list if item.get("aweme_id")}
        missing_ids = [aweme_id for aweme_id in browser_aweme_ids if aweme_id not in existing_ids]
        if not missing_ids:
            return

        logger.warning(
            "Recovering aweme details from browser list, missing count=%s",
            len(missing_ids),
        )
        detail_failed = 0
        detail_success = 0
        reused_from_browser_items = 0
        total_missing = len(missing_ids)
        # 批量页内通道一次性补齐缺失详情，避免"每个作品开一个浏览器窗口"（约 20s/条）。
        batch_details = await self._batch_fetch_details(missing_ids, browser_aweme_items)
        for index, aweme_id in enumerate(missing_ids, start=1):
            if number_limit > 0 and len(aweme_list) >= number_limit:
                break

            if index == 1 or index == total_missing or index % 5 == 0:
                self._progress_update_step("浏览器回补", f"补全详情 {index}/{total_missing}")

            detail = browser_aweme_items.get(str(aweme_id)) or batch_details.get(str(aweme_id))
            if not detail:
                await self.rate_limiter.acquire()
                detail = await self.api_client.get_video_detail(aweme_id, suppress_error=True, allow_window=False)
            if detail:
                if str(aweme_id) in browser_aweme_items:
                    reused_from_browser_items += 1
                else:
                    detail_success += 1
            if not detail:
                detail_failed += 1
                continue
            author = detail.get("author", {}) if isinstance(detail, dict) else {}
            detail_sec_uid = author.get("sec_uid") if isinstance(author, dict) else None
            if detail_sec_uid and str(detail_sec_uid) != str(sec_uid):
                logger.warning(
                    "Skip aweme_id=%s due to mismatched sec_uid (%s)",
                    aweme_id,
                    detail_sec_uid,
                )
                continue
            aweme_list.append(detail)

        self._progress_update_step(
            "浏览器回补",
            f"回补完成，复用 {reused_from_browser_items}，补拉成功 {detail_success}，失败 {detail_failed}",
        )
        logger.warning(
            "Browser fallback summary: merged_ids=%s selected_ids=%s post_items=%s post_pages=%s reused=%s detail_success=%s detail_failed=%s",
            browser_post_stats.get("merged_ids", 0),
            browser_post_stats.get("selected_ids", len(browser_aweme_ids)),
            browser_post_stats.get("post_items", len(browser_aweme_items)),
            browser_post_stats.get("post_pages", 0),
            reused_from_browser_items,
            detail_success,
            detail_failed,
        )

        if detail_failed > 0:
            logger.warning(
                "Browser fallback detail fetch failed: %s/%s",
                detail_failed,
                total_missing,
            )

    async def _recover_user_like_with_browser(
        self,
        sec_uid: str,
        user_info: Dict[str, Any],
        aweme_list: List[Dict[str, Any]],
    ) -> None:
        """「我的喜欢」列表接口（aweme/favorite/）同样被抖音 Argus 风控确定性拒绝，
        因此复用桌面端自带 Chromium 窗口做 CDP 拦截兜底（拦截 aweme/favorite/ 响应）。

        逻辑与 _recover_user_post_with_browser 完全一致，仅调用 collect_user_like_ids_via_browser。
        """
        browser_cfg = self.config.get("browser_fallback") or self.config.get("browserFallback") or {}
        if not browser_cfg.get("enabled", True):
            return

        number_limit = self.config.get("number", {}).get("like", 0)
        expected_count = int(number_limit or 0)
        if expected_count and len(aweme_list) >= expected_count:
            return

        author_count = int(user_info.get("aweme_count") or 0)
        configured_max_scrolls = int(browser_cfg.get("max_scrolls", 240) or 240)
        max_scrolls = configured_max_scrolls
        if author_count > expected_count:
            needed_scrolls = int(author_count / 15) + 50
            max_scrolls = max(max_scrolls, needed_scrolls)

        headless = bool(browser_cfg.get("headless", True))
        if headless:
            self._progress_update_step(
                "浏览器回补",
                "使用无头浏览器采集（如遇验证码请改为可见模式）",
            )

        try:
            browser_aweme_ids = await self.api_client.collect_user_like_ids_via_browser(
                sec_uid,
                expected_count=expected_count,
                headless=headless,
                max_scrolls=max_scrolls,
                idle_rounds=int(browser_cfg.get("idle_rounds", 8) or 8),
                wait_timeout_seconds=int(browser_cfg.get("wait_timeout_seconds", 600) or 600),
            )
        except Exception as exc:
            logger.error("Like browser fallback failed: %s", exc)
            self._progress_update_step("浏览器回补", f"失败：{exc}")
            return

        browser_aweme_items: Dict[str, Dict[str, Any]] = {}
        browser_post_stats: Dict[str, int] = {}
        if hasattr(self.api_client, "pop_browser_post_aweme_items"):
            try:
                browser_aweme_items = self.api_client.pop_browser_post_aweme_items() or {}
            except Exception as exc:
                logger.debug("Fetch browser like items skipped: %s", exc)
        if hasattr(self.api_client, "pop_browser_post_stats"):
            try:
                browser_post_stats = self.api_client.pop_browser_post_stats() or {}
            except Exception as exc:
                logger.debug("Fetch browser like stats skipped: %s", exc)

        if not browser_aweme_ids:
            logger.warning("Like browser fallback returned no aweme_id")
            self._progress_update_step(
                "浏览器回补",
                "未采集到喜欢的作品 ID：可能遇到验证码、Cookie 失效或浏览器被关闭",
            )
            return

        self._progress_update_step(
            "浏览器回补",
            f"已采集 {len(browser_aweme_ids)} 个喜欢的作品 ID，准备补全详情",
        )

        existing_ids = {str(item.get("aweme_id")) for item in aweme_list if item.get("aweme_id")}
        missing_ids = [aweme_id for aweme_id in browser_aweme_ids if aweme_id not in existing_ids]
        if not missing_ids:
            return

        logger.warning(
            "Recovering like aweme details from browser list, missing count=%s",
            len(missing_ids),
        )
        detail_failed = 0
        detail_success = 0
        reused_from_browser_items = 0
        total_missing = len(missing_ids)
        # 批量页内通道一次性补齐缺失详情，避免"每个作品开一个浏览器窗口"（约 20s/条）。
        batch_details = await self._batch_fetch_details(missing_ids, browser_aweme_items)
        for index, aweme_id in enumerate(missing_ids, start=1):
            if number_limit > 0 and len(aweme_list) >= number_limit:
                break

            if index == 1 or index == total_missing or index % 5 == 0:
                self._progress_update_step("浏览器回补", f"补全详情 {index}/{total_missing}")

            detail = browser_aweme_items.get(str(aweme_id)) or batch_details.get(str(aweme_id))
            if not detail:
                await self.rate_limiter.acquire()
                detail = await self.api_client.get_video_detail(aweme_id, suppress_error=True, allow_window=False)
            if detail:
                if str(aweme_id) in browser_aweme_items:
                    reused_from_browser_items += 1
                else:
                    detail_success += 1
            if not detail:
                detail_failed += 1
                continue
            author = detail.get("author", {}) if isinstance(detail, dict) else {}
            detail_sec_uid = author.get("sec_uid") if isinstance(author, dict) else None
            if detail_sec_uid and str(detail_sec_uid) != str(sec_uid):
                logger.warning(
                    "Skip like aweme_id=%s due to mismatched sec_uid (%s)",
                    aweme_id,
                    detail_sec_uid,
                )
                continue
            aweme_list.append(detail)

        self._progress_update_step(
            "浏览器回补",
            f"喜欢回补完成，复用 {reused_from_browser_items}，补拉成功 {detail_success}，失败 {detail_failed}",
        )
        logger.warning(
            "Like browser fallback summary: merged_ids=%s selected_ids=%s post_items=%s post_pages=%s reused=%s detail_success=%s detail_failed=%s",
            browser_post_stats.get("merged_ids", 0),
            browser_post_stats.get("selected_ids", len(browser_aweme_ids)),
            browser_post_stats.get("post_items", len(browser_aweme_items)),
            browser_post_stats.get("post_pages", 0),
            reused_from_browser_items,
            detail_success,
            detail_failed,
        )

        if detail_failed > 0:
            logger.warning(
                "Like browser fallback detail fetch failed: %s/%s",
                detail_failed,
                total_missing,
            )

    async def _recover_user_mode_with_browser(
        self,
        mode: str,
        sec_uid: str,
        user_info: Dict[str, Any],
        aweme_list: List[Dict[str, Any]],
    ) -> None:
        """通用浏览器兜底：收藏 / 合集 / 音乐 / 收藏合集 等模式共用。

        这些端点同样被抖音 Argus 门禁（实测 mix/aweme 403、music/list 404），
        与「作者作品页」一样改走桌面端自带 Chromium 的 CDP 拦截采集。
        """
        browser_cfg = self.config.get("browser_fallback") or self.config.get("browserFallback") or {}
        if not browser_cfg.get("enabled", True):
            return

        number_limit = self.config.get("number", {}).get(mode, 0)
        expected_count = int(number_limit or 0)
        if expected_count and len(aweme_list) >= expected_count:
            return

        headless = bool(browser_cfg.get("headless", True))

        try:
            browser_aweme_ids = await self.api_client.collect_user_ids_via_browser(
                sec_uid,
                expected_count=expected_count,
                headless=headless,
                max_scrolls=int(browser_cfg.get("max_scrolls", 240) or 240),
                idle_rounds=int(browser_cfg.get("idle_rounds", 8) or 8),
                wait_timeout_seconds=int(browser_cfg.get("wait_timeout_seconds", 600) or 600),
                kind=mode,
            )
        except Exception as exc:
            logger.error("%s browser fallback failed: %s", mode, exc)
            self._progress_update_step("浏览器回补", f"失败：{exc}")
            return

        browser_aweme_items: Dict[str, Dict[str, Any]] = {}
        if hasattr(self.api_client, "pop_browser_post_aweme_items"):
            try:
                browser_aweme_items = self.api_client.pop_browser_post_aweme_items() or {}
            except Exception as exc:  # noqa: BLE001
                logger.debug("Fetch browser %s items skipped: %s", mode, exc)

        if not browser_aweme_ids:
            logger.warning("%s browser fallback returned no aweme_id", mode)
            self._progress_update_step(
                "浏览器回补",
                f"未采集到 {mode} 作品 ID：可能遇到验证码、Cookie 失效或浏览器被关闭",
            )
            return

        self._progress_update_step(
            "浏览器回补",
            f"已采集 {len(browser_aweme_ids)} 个作品 ID，准备补全详情",
        )

        existing_ids = {str(item.get("aweme_id")) for item in aweme_list if item.get("aweme_id")}
        missing_ids = [aweme_id for aweme_id in browser_aweme_ids if aweme_id not in existing_ids]
        if not missing_ids:
            return

        # 自身账号类模式（收藏/合集/音乐）sec_uid 可能是 'self'，此时不做作者一致性校验
        self_mode = str(sec_uid or "") in ("", "self")

        detail_failed = 0
        detail_success = 0
        reused = 0
        total_missing = len(missing_ids)
        # 批量页内通道一次性补齐缺失详情，避免"每个作品开一个浏览器窗口"（约 20s/条）。
        batch_details = await self._batch_fetch_details(missing_ids, browser_aweme_items)
        for index, aweme_id in enumerate(missing_ids, start=1):
            if number_limit > 0 and len(aweme_list) >= number_limit:
                break
            if index == 1 or index == total_missing or index % 5 == 0:
                self._progress_update_step("浏览器回补", f"补全详情 {index}/{total_missing}")

            detail = browser_aweme_items.get(str(aweme_id)) or batch_details.get(str(aweme_id))
            if not detail:
                await self.rate_limiter.acquire()
                detail = await self.api_client.get_video_detail(aweme_id, suppress_error=True, allow_window=False)
            if detail:
                if str(aweme_id) in browser_aweme_items:
                    reused += 1
                else:
                    detail_success += 1
            if not detail:
                detail_failed += 1
                continue

            if not self_mode:
                author = detail.get("author", {}) if isinstance(detail, dict) else {}
                detail_sec_uid = author.get("sec_uid") if isinstance(author, dict) else None
                if detail_sec_uid and str(detail_sec_uid) != str(sec_uid):
                    logger.warning(
                        "Skip %s aweme_id=%s due to mismatched sec_uid (%s)",
                        mode,
                        aweme_id,
                        detail_sec_uid,
                    )
                    continue
            aweme_list.append(detail)

        self._progress_update_step(
            "浏览器回补",
            f"{mode} 回补完成，复用 {reused}，补拉成功 {detail_success}，失败 {detail_failed}",
        )
        logger.warning(
            "%s browser fallback summary: missing=%s reused=%s detail_success=%s detail_failed=%s",
            mode,
            total_missing,
            reused,
            detail_success,
            detail_failed,
        )

    async def _recover_user_collect_with_browser(
        self,
        sec_uid: str,
        user_info: Dict[str, Any],
        aweme_list: List[Dict[str, Any]],
    ) -> None:
        """「我的收藏」：collects/video/list 端点同样走浏览器 CDP 拦截兜底。"""
        await self._recover_user_mode_with_browser("collect", sec_uid, user_info, aweme_list)

    async def _recover_user_mix_with_browser(
        self,
        sec_uid: str,
        user_info: Dict[str, Any],
        aweme_list: List[Dict[str, Any]],
    ) -> None:
        """「合集」：mix/aweme 端点被 Argus 确定性 403，走浏览器 CDP 拦截兜底。"""
        await self._recover_user_mode_with_browser("mix", sec_uid, user_info, aweme_list)

    async def _recover_user_music_with_browser(
        self,
        sec_uid: str,
        user_info: Dict[str, Any],
        aweme_list: List[Dict[str, Any]],
    ) -> None:
        """「音乐」：music/list 端点已 404，走浏览器 CDP 拦截兜底。"""
        await self._recover_user_mode_with_browser("music", sec_uid, user_info, aweme_list)

    async def _recover_user_collectmix_with_browser(
        self,
        sec_uid: str,
        user_info: Dict[str, Any],
        aweme_list: List[Dict[str, Any]],
    ) -> None:
        """「收藏的合集」：mix/listcollection 下的合集内容走浏览器 CDP 拦截兜底。"""
        await self._recover_user_mode_with_browser("collectmix", sec_uid, user_info, aweme_list)
