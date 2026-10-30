# 参考 Douzy Desktop 0.11.6 更新 DRaccoon 下载逻辑

> 依据：jiji262/douyin-downloader 的 Desktop 0.11.6 发布说明（截图文字）。
> 核心思路：Argus 403 接口统一走应用内抖音页面通道；失败不再一律提示重新登录；各下载模式失败隔离。

## 已修改文件

| 文件 | 改动要点 |
|------|----------|
| `dispatcher/_internal/backend/core/api_client.py` | 页面通道失败返回带风险标记的响应（Argus 拒绝 / 桥接错误 / 限流）；`get_video_detail` 在桥接可用时不再回退到直连 403；`get_mix_detail` / `get_music_detail` 识别错误响应并返回 None |
| `dispatcher/_internal/backend/core/user_modes/base_strategy.py` | `_collect_paged_aweme` / `_collect_paged_entries` / `_expand_metadata_items` 增加 `_raise_if_gated_error`，遇到 Argus/桥接/限流立即抛出明确原因，避免误判为「0 项成功」 |
| `dispatcher/_internal/backend/core/user_modes/post_strategy.py` | `collect_items` 分页后调用 `_raise_if_gated_error`，确定性失败不再徒劳重试 |
| `dispatcher/_internal/backend/core/user_modes/collect_strategy.py` | 收藏夹分页同样增加 `_raise_if_gated_error` 检查 |
| `dispatcher/_internal/backend/core/user_downloader.py` | `download()` 每个模式加 try/except；任一模式失败不连坐其他模式；仅当全部模式都没拿到内容时才判定任务失败 |
| `dispatcher/_internal/backend/control/retry_handler.py` | 可选传入 `config`，每次执行前动态读取 `retry_times`，实现「保存后立即生效」 |
| `dispatcher/_internal/backend/config/config_loader.py` | 新增 `reload()` 方法，支持从磁盘重新加载配置 |
| `dispatcher/_internal/backend/server/app.py` | 每次任务执行前调用 `deps.config.reload()`；RetryHandler 传入 config |
| `dispatcher/_internal/backend/cli/main.py` | RetryHandler 传入 config |
| `dispatcher/_internal/backend/core/downloader_base.py` | 默认 RetryHandler 传入 config |

## 关键行为变化

1. **失败分类明确**
   - 被抖音 Argus 拒绝（403）：提示「重试和重新登录均无效」，不再徒劳重试。
   - 抖音页面通道出错：提示检查 DRaccoon 主窗口是否正常运行。
   - 限流（429）：提示降低并发或稍后重试。

2. **主页多模式任务隔离**
   - 以前：作品翻页被拒 → 同一任务里的合集/点赞/收藏/音乐全部不跑。
   - 现在：各模式独立跑完；仅当所有模式都没拿到内容时才整体失败。

3. **合集/收藏/音乐列表失败不再显示「全部成功 · 0 项」**
   - 列表请求被 Argus/桥接/限流拒绝时，按失败结案并写明原因。

4. **重试次数保存后立即生效**
   - `RetryHandler` 每次执行前读取最新 `retry_times`。
   - Server 场景每次任务前 `config.reload()`。

5. **重试失败项走页面通道**
   - `retry_executor` 通过 `api_client.get_video_detail` 获取详情。
   - 桥接可用时 `get_video_detail` 不再回退到直连（直连会 403）。

## 生效方式

- 本次修改均为后端源码，**重启 DRaccoon 后生效**。
- 建议验证顺序：单作品链接 → 博主主页（多模式）→ 合集/音乐 → 任务中心重试失败项。
- 观察 `AppData/Roaming/DRaccoon/logs/main.log` 中 `browser-fetch` / `browser-detail` / `browser-collect` 日志确认桥接正常。
