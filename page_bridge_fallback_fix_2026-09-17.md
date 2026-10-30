# 页面通道异常修复（post 模式拉不到作品）— 2026-09-17

## 问题
下载用户主页（post 模式）时报：`拉取作品列表失败：桌面端页面通道异常`，拿不到任何作品。

## 根因
- post 模式的 `get_user_post`（`api_client.py:699`）调用 `_request_json_gated`
  （`api_client.py:1791`），对 `/aweme/v1/web/aweme/post/` 这类被 Argus 门禁的端点，
  走 `_fetch_via_page_bridge`（`api_client.py:1754`）→ Electron 本地服务 `/v1/browser-fetch`。
- `/v1/browser-fetch` 由 `fetchViaPageBridge`（`main.js:2752`）在隐藏的 douyin.com 窗口内用
  **注入的 `window.fetch` / `XMLHttpRequest` / 直接导航** 代发请求。
- 但抖音风控 SDK **不会给注入请求补 `x-secsdk-web-signature` / `a_bogus` 签名**
  （`main.js:2556` 注释已确认："SDK 并不会自动给注入的 window.fetch 补签名"），
  所以所有 gated 端点被 Argus **确定性拒绝**：返回 `403 + ArgusSecurityPlugin`，
  或请求整体失败返回 `status 0` → 归类为 `argus_rejected` / `page_bridge_error`。
- 原 `post_strategy.collect_items`（`post_strategy.py:84`）对 gated 错误**直接 raise**，
  导致后文更可靠的 **CDP 浏览器采集兜底**（`_recover_user_post_with_browser`
  → `collect_user_post_ids_via_browser` → `_collect_via_electron_bridge`
  用 CDP 拦截抖音**自有签名**的 `aweme/post` 响应）永远没机会执行。

## 修复（Python 侧，未改 main.js）
1. `base_strategy.py`
   - 新增 `_gated_error_message(page, context)`：返回对应文案或 `None`（与 `_raise_if_gated_error` 共享判定）。
   - `_raise_if_gated_error` 改写为调用 `_gated_error_message` 后按需 raise（行为不变，供其它模式复用）。
2. `post_strategy.py`（`collect_items`）
   - 把「gated 错误即 raise」改为：捕获 `_gated_error_message`，置 `bridge_blocked=True` 并 `break` 跳出分页循环（不再徒劳重试直连）。
   - 循环结束后落入已有的浏览器兜底块，走 CDP 拦截抖音自有签名请求这条可靠路径。
   - 若兜底仍为空且 `bridge_blocked=True`，抛出清晰错误：页面通道被 Argus 拦截 + 浏览器兜底也未取到，并提示检查主窗口/登录态/采集窗口、必要时开 `browser_fallback.headless=false`。

## 验证
- `py_compile` 通过（`base_strategy.py`、`post_strategy.py`）。

## 生效方式（重要）
改的是 `dispatcher` 里的 Python，但仍需**彻底退出 DRaccoon 托盘进程再重开**，
否则老进程加载旧代码（历史多次"还是不行"的根因）。

## 局限 / 后续
- 本次只修 post 模式。collect / mix / music / favorite 仍走已失效的 `/v1/browser-fetch` 页面通道，
  需为各模式补 CDP 采集器（导航到对应页并拦截各自 API 响应）才能彻底修复。
- 请实测：post 模式应弹出可见「DRaccoon 作品采集」窗口并通过 CDP 取到作品；
  若仍失败，排查采集窗口是否被关、是否出现验证码/登录页。
