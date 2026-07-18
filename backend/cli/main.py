import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path
from typing import Any, Dict

from auth import CookieManager
from cli.login_flow import can_interactive_login, interactive_relogin
from cli.progress_display import ProgressDisplay
from cli.report import generate_report
from config import ConfigLoader
from control import QueueManager, RateLimiter, RetryHandler
from core import (
    DouyinAPIClient,
    DownloaderFactory,
    FollowingService,
    LoginRequiredError,
    RelationService,
    URLParser,
)
from storage import Database, FileManager
from utils.helpers import format_size
from utils.logger import set_console_log_level, setup_logger
from utils.notifier import build_notifier
from utils.proxy_pool import ProxyPool
from utils.validators import is_short_url, normalize_short_url

logger = setup_logger("CLI")
display = ProgressDisplay()


def _as_bool(value: Any, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def _read_url_file(path: str) -> list[str]:
    """从文本文件读取链接列表，忽略空行与 # 注释行。"""
    file_path = Path(path)
    if not file_path.exists():
        display.print_error(f"URL file not found: {path}")
        return []

    urls = []
    try:
        with file_path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                urls.append(line)
    except Exception as exc:
        display.print_error(f"Failed to read URL file {path}: {exc}")
        return []
    return urls


def _read_sec_uid_file(path: str) -> list[str]:
    """从文本文件读取 sec_uid 列表，忽略空行与 # 注释行。"""
    file_path = Path(path)
    if not file_path.exists():
        display.print_error(f"sec_uid file not found: {path}")
        return []

    sec_uids: list[str] = []
    try:
        with file_path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                sec_uids.append(line)
    except Exception as exc:
        display.print_error(f"Failed to read sec_uid file {path}: {exc}")
        return []
    return sec_uids


def _build_cookie_manager(args, config: ConfigLoader) -> CookieManager:
    """Create a CookieManager that respects --profile.

    When --profile is given, cookies are loaded from the profile-specific file
    (``.cookies.{profile}.json``). Config cookies are ignored in that mode to
    avoid mixing accounts. Without --profile, the historical behaviour is kept:
    load from config (inline YAML key, env var, or auto-detected
    ``.cookies.json``) and fall back to the default cookie file.
    """
    if args.profile:
        cookie_manager = CookieManager(profile=args.profile)
        cookie_manager.get_cookies()
        return cookie_manager

    cookies = config.get_cookies()
    cookie_manager = CookieManager()
    if cookies:
        cookie_manager.set_cookies(cookies)
    return cookie_manager


async def _run_with_relogin(make_coro, cookie_manager, *, serve=False):
    """Run make_coro(); on LoginRequiredError, relogin once and retry.

    make_coro is a zero-arg callable returning a fresh coroutine each call,
    so the retry re-creates its own DouyinAPIClient with refreshed cookies.
    Refreshed cookies propagate through ``cookie_manager`` as a clean replace
    (not a merge), and both call sites read their cookies from it on retry.
    """
    for attempt in range(2):
        try:
            return await make_coro()
        except LoginRequiredError as exc:
            interactive = can_interactive_login(serve=serve)
            if attempt == 1 or not interactive:
                display.print_error(
                    f"登录态失效，需要重新登录（status {exc.status_code}）："
                    f"{exc.status_msg or '请先登录'}。"
                )
                if not interactive:
                    display.print_warning(
                        "当前为非交互环境，未自动打开浏览器。请手动更新 "
                        "config/cookies.json（或运行 python tools/cookie_fetcher.py 登录）。"
                    )
                raise
            display.print_warning(
                f"检测到未登录（status {exc.status_code}），开始重新登录…"
            )
            new_cookies = await interactive_relogin()
            if not new_cookies:
                display.print_error("重新登录未完成，已中止。")
                raise
            cookie_manager.set_cookies(new_cookies)
            display.print_success("已更新登录态，正在重试…")


async def download_url(
    url: str,
    config: ConfigLoader,
    cookie_manager: CookieManager,
    database: Database = None,
    progress_reporter: ProgressDisplay = None,
):
    if progress_reporter:
        progress_reporter.advance_step("初始化", "创建下载组件")
    file_manager = FileManager(config.get("path"))
    rate_limiter = RateLimiter(max_per_second=float(config.get("rate_limit", 2) or 2))
    retry_handler = RetryHandler(max_retries=config.get("retry_times", 3))
    queue_manager = QueueManager(max_workers=int(config.get("thread", 5) or 5))

    original_url = url

    proxy_pool = ProxyPool.from_config(config)
    async with DouyinAPIClient(
        cookie_manager.get_cookies(),
        proxy=ProxyPool.single_proxy_from_config(config),
        proxy_pool=proxy_pool,
    ) as api_client:
        if proxy_pool:
            await proxy_pool.probe()
        if progress_reporter:
            progress_reporter.advance_step("解析链接", "检查短链并解析 URL")
        # 支持多种短链变体：v.douyin.com / v.iesdouyin.com / 无 scheme 的裸链接
        if is_short_url(url):
            resolved_url = await api_client.resolve_short_url(normalize_short_url(url))
            if resolved_url:
                url = resolved_url
            else:
                if progress_reporter:
                    progress_reporter.update_step("解析链接", "短链解析失败")
                display.print_error(f"Failed to resolve short URL: {url}")
                return None

        parsed = URLParser.parse(url)
        if not parsed:
            if progress_reporter:
                progress_reporter.update_step("解析链接", "URL 解析失败")
            display.print_error(f"Failed to parse URL: {url}")
            return None

        if not progress_reporter:
            display.print_info(f"URL type: {parsed['type']}")
        if progress_reporter:
            progress_reporter.advance_step("创建下载器", f"URL 类型: {parsed['type']}")

        downloader = DownloaderFactory.create(
            parsed["type"],
            config,
            api_client,
            file_manager,
            cookie_manager,
            database,
            rate_limiter,
            retry_handler,
            queue_manager,
            progress_reporter=progress_reporter,
        )

        if not downloader:
            if progress_reporter:
                progress_reporter.update_step("创建下载器", "未找到匹配下载器")
            display.print_error(f"No downloader found for type: {parsed['type']}")
            return None

        if progress_reporter:
            progress_reporter.advance_step("执行下载", "开始拉取与下载资源")
        try:
            result = await downloader.download(parsed)
        except Exception as exc:
            # Surface fatal downloader errors (e.g. user_info fetch failed
            # because cookies are invalid) as a per-URL failure instead of
            # crashing the whole batch. Keeps multi-URL CLI runs robust while
            # still telling the user why the URL was skipped.
            if progress_reporter:
                progress_reporter.update_step("执行下载", f"失败：{exc}")
            display.print_error(f"Download failed for {url}: {exc}")
            return None

        if progress_reporter:
            progress_reporter.advance_step(
                "记录历史",
                "写入数据库历史" if (result and database) else "数据库未启用，跳过",
            )
        if result and database:
            safe_config = {
                k: v
                for k, v in config.config.items()
                if k not in ("cookies", "cookie", "transcript")
            }
            # Aggregate URL-level history record (no aweme_id/sec_uid) for
            # reporting/auditing. Per-aweme records are already written by
            # BaseDownloader.record_download_history for deduplication.
            await database.add_history(
                {
                    "url": original_url,
                    "url_type": parsed["type"],
                    "total_count": result.total,
                    "success_count": result.success,
                    "config": json.dumps(safe_config, ensure_ascii=False),
                }
            )

        if progress_reporter:
            if result:
                progress_reporter.advance_step(
                    "收尾",
                    f"成功 {result.success} / 失败 {result.failed} / 跳过 {result.skipped}",
                )
            else:
                progress_reporter.advance_step("收尾", "无可统计结果")

        return result


async def main_async(args):
    if not args.serve:
        display.show_banner()

    if args.config:
        config_path = args.config
    else:
        config_path = "config.yml"

    # 若 config 不存在且使用了 --hot-board / --search / --serve 等独立子命令，
    # 允许以默认配置运行（只要命令行提供了 --path）。
    relation_mode = bool(
        args.follow or args.unfollow or args.follow_file or args.unfollow_file
    )

    if not Path(config_path).exists():
        if not (
            args.hot_board is not None
            or args.search
            or args.serve
            or relation_mode
            or args.report
        ):
            display.print_error(f"Config file not found: {config_path}")
            return
        # For ``--serve`` we still pass the (yet-missing) path so later
        # ``config.save()`` calls from the REST settings endpoint create
        # the file in the right place (e.g. Electron's userData dir).
        # Other subcommands keep the historical behaviour of in-memory
        # defaults.
        if args.serve and args.config:
            config = ConfigLoader(config_path)
        else:
            config = ConfigLoader(None)
    else:
        config = ConfigLoader(config_path)

    if args.path:
        config.update(path=args.path)

    # 独立子命令：热榜 / 搜索 / 服务
    if args.hot_board is not None or args.search:
        discovery_cm = _build_cookie_manager(args, config)
        await _run_with_relogin(
            lambda: _run_discovery_subcommand(args, config, discovery_cm),
            discovery_cm,
            serve=False,
        )
        return
    if args.serve:
        await _run_serve_subcommand(args, config)
        return

    if args.sync_following:
        cookie_manager = _build_cookie_manager(args, config)
        await _run_sync_following_subcommand(args, config, cookie_manager)
        return

    if args.report:
        await _run_report_subcommand(args, config)
        return

    if args.follow or args.unfollow or args.follow_file or args.unfollow_file:
        cookie_manager = _build_cookie_manager(args, config)
        await _run_relation_subcommand(args, config, cookie_manager)
        return

    if args.export_comments:
        await _run_export_comments_subcommand(args, config)
        return

    if args.url:
        urls = args.url if isinstance(args.url, list) else [args.url]
        for url in urls:
            if url not in config.get("link", []):
                config.update(link=config.get("link", []) + [url])

    if args.url_file:
        file_urls = _read_url_file(args.url_file)
        existing = config.get("link", [])
        for url in file_urls:
            if url not in existing:
                existing.append(url)
        if file_urls:
            config.update(link=existing)

    if args.thread:
        config.update(thread=args.thread)

    transcode_cfg: Dict[str, Any] = dict(config.get("transcode") or {})
    if args.transcode:
        transcode_cfg["enabled"] = True
    if args.transcode_audio_only:
        transcode_cfg["audio_only"] = True
    if args.transcode_resolution:
        transcode_cfg["video_resolution"] = args.transcode_resolution
    if args.transcode_video_bitrate:
        transcode_cfg["video_bitrate"] = args.transcode_video_bitrate
    if args.transcode_audio_bitrate:
        transcode_cfg["audio_bitrate"] = args.transcode_audio_bitrate
    if args.transcode_keep_original:
        transcode_cfg["keep_original"] = True
    if transcode_cfg:
        config.update(transcode=transcode_cfg)

    if not config.validate():
        display.print_error("Invalid configuration: missing required fields")
        return

    cookie_manager = _build_cookie_manager(args, config)

    if not cookie_manager.validate_cookies():
        display.print_warning("Cookies may be invalid or incomplete")

    database = None
    if config.get("database"):
        db_path = config.get("database_path", "dy_downloader.db") or "dy_downloader.db"
        database = Database(db_path=str(db_path))
        await database.initialize()
        display.print_success("Database initialized")

    urls = config.get_links()
    display.print_info(f"Found {len(urls)} URL(s) to process")

    all_results = []
    progress_config = config.get("progress", {}) or {}
    quiet_by_config = _as_bool(progress_config.get("quiet_logs", True), default=True)
    quiet_progress_logs = quiet_by_config and not (args.verbose or args.show_warnings)
    if quiet_progress_logs:
        # Progress 运行期间若有大量错误日志会触发 rich 反复重绘，导致屏幕出现重复块。
        # 默认静默控制台日志，下载完成后再恢复。
        set_console_log_level(logging.CRITICAL)

    display.start_download_session(len(urls))
    try:
        for i, url in enumerate(urls, 1):
            display.start_url(i, len(urls), url)

            result = await _run_with_relogin(
                lambda u=url: download_url(
                    u,
                    config,
                    cookie_manager,
                    database,
                    progress_reporter=display,
                ),
                cookie_manager,
                serve=False,
            )
            if result:
                all_results.append(result)
                display.complete_url(result)
            else:
                display.fail_url("下载失败或链接无效")
    finally:
        display.stop_download_session()
        if database is not None:
            await database.close()
        if quiet_progress_logs:
            set_console_log_level(logging.ERROR)

    if all_results:
        from core.downloader_base import DownloadResult

        total_result = DownloadResult()
        for r in all_results:
            total_result.total += r.total
            total_result.success += r.success
            total_result.failed += r.failed
            total_result.skipped += r.skipped

        display.print_success("\n=== Overall Summary ===")
        display.show_result(total_result)

        await _dispatch_notifications(config, total_result, len(urls))
    else:
        # 所有链接都失败时，也发通知（若启用）
        await _dispatch_notifications(config, None, len(urls))


async def _run_discovery_subcommand(
    args, config: ConfigLoader, cookie_manager: CookieManager
) -> None:
    """处理 --hot-board 与 --search 子命令。"""
    from core.discovery import dump_hot_board, search_and_dump

    base_path = Path(config.get("path") or "./Downloaded/")

    proxy_pool = ProxyPool.from_config(config)
    async with DouyinAPIClient(
        cookie_manager.get_cookies(),
        proxy=ProxyPool.single_proxy_from_config(config),
        proxy_pool=proxy_pool,
    ) as api_client:
        if proxy_pool:
            await proxy_pool.probe()
        if args.hot_board is not None:
            display.print_info("拉取抖音热搜榜...")
            result = await dump_hot_board(api_client, base_path, limit=int(args.hot_board or 0))
            display.print_success(f"热榜已保存：{result['count']} 条 -> {result['path']}")
        if args.search:
            display.print_info(f"搜索关键词：{args.search}")
            result = await search_and_dump(
                api_client,
                args.search,
                base_path,
                max_items=int(args.search_max or 50),
            )
            display.print_success(f"搜索结果已保存：{result['count']} 条 -> {result['path']}")


async def _run_serve_subcommand(args, config: ConfigLoader) -> None:
    """启动 REST API 服务模式（fastapi + uvicorn 为可选依赖）。"""
    try:
        from server.app import run_server
    except ImportError as exc:
        display.print_error(
            f"REST 服务模式需要安装可选依赖 fastapi + uvicorn："
            f"\n  pip install fastapi uvicorn\n原始错误：{exc}"
        )
        return

    display.print_info(f"启动 REST 服务：http://{args.serve_host}:{args.serve_port}")
    await run_server(
        config, host=args.serve_host, port=args.serve_port, profile=args.profile
    )


async def _run_sync_following_subcommand(
    args, config: ConfigLoader, cookie_manager: CookieManager
) -> None:
    """同步当前登录用户的关注列表到 SQLite。"""
    if not cookie_manager.validate_cookies():
        display.print_warning("Cookies may be invalid or incomplete")

    db_path = config.get("database_path", "dy_downloader.db") or "dy_downloader.db"
    database = Database(db_path=str(db_path))
    await database.initialize()

    async def _do_sync():
        proxy_pool = ProxyPool.from_config(config)
        async with DouyinAPIClient(
            cookie_manager.get_cookies(),
            proxy=ProxyPool.single_proxy_from_config(config),
            proxy_pool=proxy_pool,
        ) as api_client:
            if proxy_pool:
                await proxy_pool.probe()
            service = FollowingService(api_client, database)
            display.print_info("开始同步关注列表...")
            summary = await service.sync_following(limit=args.sync_following_limit)
            display.print_success(
                f"关注列表同步完成：新增 {summary['added']} / 更新 {summary['updated']} / "
                f"总计 {summary['total']}（同步前 {summary['cached']} 条）"
            )
            return summary

    try:
        await _run_with_relogin(_do_sync, cookie_manager, serve=False)
    finally:
        await database.close()


async def _run_relation_subcommand(
    args, config: ConfigLoader, cookie_manager: CookieManager
) -> None:
    """批量关注或取关指定用户。"""
    if not cookie_manager.validate_cookies():
        display.print_warning("Cookies may be invalid or incomplete")

    follow_uids: list[str] = list(args.follow or [])
    unfollow_uids: list[str] = list(args.unfollow or [])
    if args.follow_file:
        follow_uids.extend(_read_sec_uid_file(args.follow_file))
    if args.unfollow_file:
        unfollow_uids.extend(_read_sec_uid_file(args.unfollow_file))

    if not follow_uids and not unfollow_uids:
        display.print_error("未提供任何 sec_uid，请使用 --follow / --unfollow 或对应 --*-file 参数")
        return

    async def _do_relation():
        proxy_pool = ProxyPool.from_config(config)
        async with DouyinAPIClient(
            cookie_manager.get_cookies(),
            proxy=ProxyPool.single_proxy_from_config(config),
            proxy_pool=proxy_pool,
        ) as api_client:
            if proxy_pool:
                await proxy_pool.probe()

            delay = float(args.relation_delay or 2.0)
            service = RelationService(
                api_client,
                min_delay=delay,
                max_delay=max(delay * 1.5, delay + 1.0),
            )

            async def _run_action(action: str, sec_uids: list[str]) -> None:
                if not sec_uids:
                    return
                display.print_info(f"开始批量{ '关注' if action == 'follow' else '取消关注' }，共 {len(sec_uids)} 个用户…")
                if args.relation_dry_run:
                    display.print_warning("当前为 dry-run 模式，不会真正调用 API")
                if action == "follow":
                    summary = await service.batch_follow(
                        sec_uids,
                        limit=int(args.relation_limit or 0),
                        dry_run=bool(args.relation_dry_run),
                    )
                else:
                    summary = await service.batch_unfollow(
                        sec_uids,
                        limit=int(args.relation_limit or 0),
                        dry_run=bool(args.relation_dry_run),
                    )
                action_label = "关注" if action == "follow" else "取消关注"
                display.print_success(
                    f"批量{action_label}完成：成功 {summary.success} / 失败 {summary.failed} / "
                    f"跳过 {summary.skipped} / 总计 {summary.total}"
                )
                if summary.failed:
                    display.print_warning(
                        f"有 {summary.failed} 个用户{action_label}失败，可检查日志了解详情"
                    )

            await _run_action("follow", follow_uids)
            await _run_action("unfollow", unfollow_uids)

    await _run_with_relogin(_do_relation, cookie_manager, serve=False)


async def _run_export_comments_subcommand(args, config: ConfigLoader) -> None:
    """导出指定作品的评论到 JSON / CSV。"""
    from core.comments_collector import CommentsCollector
    from storage.metadata_handler import MetadataHandler

    aweme_id = str(args.export_comments or "").strip()
    if not aweme_id:
        display.print_error("请提供作品 ID：--export-comments <aweme_id>")
        return

    output_path = Path(args.export_comments_output or "./comments_export")
    if output_path.is_dir() or not output_path.suffix:
        output_path = output_path / f"{aweme_id}_comments.json"

    formats = {f.strip().lower() for f in (args.export_comments_format or "json").split(",")}
    formats.discard("")
    if not formats:
        formats = {"json"}

    cookie_manager = _build_cookie_manager(args, config)

    if not cookie_manager.validate_cookies():
        display.print_warning("Cookies may be invalid or incomplete")

    async def _do_export():
        async with DouyinAPIClient(
            cookie_manager.get_cookies(),
            proxy=config.get("proxy"),
        ) as api_client:
            collector = CommentsCollector(
                api_client,
                MetadataHandler(),
                include_replies=bool(args.export_comments_include_replies),
                max_comments=int(args.export_comments_max or 0),
                page_size=int(args.export_comments_page_size or 20),
                reply_page_size=int(args.export_comments_reply_page_size or 20),
            )
            display.print_info(f"开始导出作品 {aweme_id} 的评论…")
            payload = await collector.collect_and_save(
                aweme_id,
                output_path,
                formats=formats,
            )
            if payload is None:
                display.print_error("评论导出失败，请检查作品 ID 与登录态")
                return None
            display.print_success(
                f"评论导出完成：共 {payload['count']} 条顶级评论 "
                f"（含楼中楼：{payload['include_replies']}）"
            )
            display.print_info(f"输出路径：{output_path.parent}")
            return payload

    await _run_with_relogin(_do_export, cookie_manager, serve=False)


async def _run_report_subcommand(args, config: ConfigLoader) -> None:
    """生成下载报表并导出为 Excel / HTML。"""
    db_path = config.get("database_path", "dy_downloader.db") or "dy_downloader.db"
    output = args.report_output or "./download_report"
    formats = [f.strip().lower() for f in (args.report_format or "excel,html").split(",")]
    formats = [f for f in formats if f]
    if not formats:
        formats = ["excel", "html"]

    invalid = {f for f in formats if f not in {"excel", "html"}}
    if invalid:
        display.print_error(f"不支持的报表格式：{', '.join(sorted(invalid))}")
        return

    try:
        result = await generate_report(
            db_path=str(db_path),
            output=output,
            formats=formats,
            date_from=args.report_from,
            date_to=args.report_to,
            progress_callback=lambda msg: display.print_info(msg),
        )
    except Exception as exc:
        display.print_error(f"报表生成失败：{exc}")
        logger.exception("Report generation failed")
        return

    for path in result["exported"]:
        display.print_success(f"报表已导出：{path}")
    display.print_info(
        f"汇总：下载 {result['total_downloads']} / 成功 {result['total_success']} / "
        f"占用 {format_size(result['total_size_bytes'])}"
    )


async def _dispatch_notifications(config: ConfigLoader, total_result: Any, url_count: int) -> None:
    notifier = build_notifier(config)
    if not notifier.enabled:
        return

    if total_result is None:
        title = "抖音下载器：全部失败"
        body = f"共处理 {url_count} 个链接，无成功结果"
        level = "failure"
    else:
        fail_or_partial = total_result.failed > 0 or total_result.success == 0
        level = "failure" if fail_or_partial else "success"
        title = "抖音下载完成" if level == "success" else "抖音下载部分失败"
        body = (
            f"链接 {url_count} / 总作品 {total_result.total} / "
            f"成功 {total_result.success} / 失败 {total_result.failed} / "
            f"跳过 {total_result.skipped}"
        )

    try:
        summary = await notifier.send(title=title, body=body, level=level)
        if summary:
            succ = sum(1 for ok in summary.values() if ok)
            logger.info(
                "Notification dispatched to %d provider(s), %d ok",
                len(summary),
                succ,
            )
    except Exception as exc:  # 通知失败不应影响主流程
        logger.warning("Notification dispatch error: %s", exc)


def main():
    parser = argparse.ArgumentParser(description="Douyin Downloader - 抖音批量下载工具")
    parser.add_argument("-u", "--url", action="append", help="Download URL(s)")
    parser.add_argument(
        "--url-file",
        metavar="PATH",
        help="读取文本文件中的链接列表，逐行解析并批量下载（支持 # 注释与空行）",
    )
    parser.add_argument("-c", "--config", help="Config file path (default: config.yml)")
    parser.add_argument(
        "--profile",
        type=str,
        default=None,
        metavar="NAME",
        help="使用指定账号的 Cookie 配置文件（默认 .cookies.json；指定后为 .cookies.NAME.json）",
    )
    parser.add_argument("-p", "--path", help="Save path")
    parser.add_argument("-t", "--thread", type=int, help="Thread count")
    parser.add_argument("--show-warnings", action="store_true", help="Show warning logs in console")
    parser.add_argument("-v", "--verbose", action="store_true", help="Enable verbose console logs")
    parser.add_argument(
        "--hot-board",
        type=int,
        nargs="?",
        const=0,
        default=None,
        metavar="N",
        help="拉取抖音热搜榜并导出 JSONL，可选上限 N（默认全部）",
    )
    parser.add_argument(
        "--search",
        type=str,
        default=None,
        metavar="KEYWORD",
        help="按关键词搜索作品并导出 JSONL",
    )
    parser.add_argument(
        "--search-max",
        type=int,
        default=50,
        help="--search 场景下最多拉取条数（默认 50）",
    )
    parser.add_argument(
        "--serve",
        action="store_true",
        help="以 REST API 服务模式运行（需要安装 fastapi + uvicorn）",
    )
    parser.add_argument("--serve-host", type=str, default="127.0.0.1", help="REST 服务监听地址")
    parser.add_argument("--serve-port", type=int, default=8000, help="REST 服务监听端口")
    parser.add_argument(
        "--sync-following",
        action="store_true",
        help="同步当前登录用户的关注列表到数据库",
    )
    parser.add_argument(
        "--sync-following-limit",
        type=int,
        default=2000,
        help="--sync-following 最多同步人数（默认 2000）",
    )
    parser.add_argument(
        "--follow",
        action="append",
        metavar="SEC_UID",
        help="关注指定用户 sec_uid（可多次使用）",
    )
    parser.add_argument(
        "--unfollow",
        action="append",
        metavar="SEC_UID",
        help="取消关注指定用户 sec_uid（可多次使用）",
    )
    parser.add_argument(
        "--follow-file",
        metavar="PATH",
        help="从文本文件读取要关注的 sec_uid 列表",
    )
    parser.add_argument(
        "--unfollow-file",
        metavar="PATH",
        help="从文本文件读取要取消关注的 sec_uid 列表",
    )
    parser.add_argument(
        "--relation-delay",
        type=float,
        default=2.0,
        metavar="SECONDS",
        help="批量关注/取关时两次请求之间的最小间隔（默认 2.0 秒）",
    )
    parser.add_argument(
        "--relation-limit",
        type=int,
        default=0,
        metavar="N",
        help="批量关注/取关最多处理 N 个用户（0 表示不限，默认 0）",
    )
    parser.add_argument(
        "--relation-dry-run",
        action="store_true",
        help="模拟执行关注/取关，不真正调用 API",
    )
    parser.add_argument(
        "--export-comments",
        type=str,
        default=None,
        metavar="AWEME_ID",
        help="导出指定作品的评论（可与 --export-comments-format 搭配使用）",
    )
    parser.add_argument(
        "--export-comments-output",
        type=str,
        default=None,
        metavar="PATH",
        help="评论导出输出路径（文件或目录，默认 ./comments_export/<aweme_id>_comments.json）",
    )
    parser.add_argument(
        "--export-comments-format",
        type=str,
        default="json",
        metavar="FORMATS",
        help="评论导出格式，支持 json,csv，多个用逗号分隔（默认 json）",
    )
    parser.add_argument(
        "--export-comments-include-replies",
        action="store_true",
        help="导出评论时递归拉取楼中楼回复",
    )
    parser.add_argument(
        "--export-comments-max",
        type=int,
        default=0,
        metavar="N",
        help="最多导出 N 条顶级评论（0 表示不限，默认 0）",
    )
    parser.add_argument(
        "--export-comments-page-size",
        type=int,
        default=20,
        metavar="N",
        help="评论分页大小（默认 20）",
    )
    parser.add_argument(
        "--export-comments-reply-page-size",
        type=int,
        default=20,
        metavar="N",
        help="楼中楼回复分页大小（默认 20）",
    )
    parser.add_argument(
        "--report",
        action="store_true",
        help="生成下载报表（按日期/作者/模式统计并导出）",
    )
    parser.add_argument(
        "--report-output",
        type=str,
        default=None,
        metavar="PATH",
        help="报表输出路径前缀（默认 ./download_report）",
    )
    parser.add_argument(
        "--report-format",
        type=str,
        default="excel,html",
        metavar="FORMATS",
        help="报表格式，支持 excel,html，多个用逗号分隔（默认 excel,html）",
    )
    parser.add_argument(
        "--report-from",
        type=str,
        default=None,
        metavar="YYYY-MM-DD",
        help="统计起始日期",
    )
    parser.add_argument(
        "--report-to",
        type=str,
        default=None,
        metavar="YYYY-MM-DD",
        help="统计结束日期",
    )
    parser.add_argument("--transcode", action="store_true", help="启用下载后转码/压缩")
    parser.add_argument("--transcode-audio-only", action="store_true", help="仅提取音频 MP3")
    parser.add_argument(
        "--transcode-resolution",
        type=str,
        default="",
        metavar="RES",
        help="目标分辨率，如 720p/480p",
    )
    parser.add_argument(
        "--transcode-video-bitrate",
        type=str,
        default="",
        metavar="BITRATE",
        help="视频码率，如 800k",
    )
    parser.add_argument(
        "--transcode-audio-bitrate",
        type=str,
        default="",
        metavar="BITRATE",
        help="音频码率，如 128k",
    )
    parser.add_argument("--transcode-keep-original", action="store_true", help="保留原视频")
    try:
        from __init__ import __version__
    except ImportError:
        __version__ = "2.0.0"
    parser.add_argument("--version", action="version", version=__version__)

    args = parser.parse_args()

    if args.verbose:
        set_console_log_level(logging.INFO)
    elif args.show_warnings:
        set_console_log_level(logging.WARNING)
    else:
        set_console_log_level(logging.ERROR)

    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        display.print_warning("\nDownload interrupted by user")
        sys.exit(0)
    except Exception as e:
        display.print_error(f"Fatal error: {e}")
        logger.exception("Fatal error occurred")
        sys.exit(1)


if __name__ == "__main__":
    main()
