# DRaccoon 修复总结：「我的喜欢」获取不到 + 「新发布」sec_uid 为空（2026-09-19）

## 现象（用户反馈）
- 「我的喜欢」列表获取不到数据。
- 「新发布」也获取不到数据（post 模式的 CDP 兜底触发了，但报 `error=缺少 secUid`）。

## 根因
1. **「我的喜欢」没有兜底**：`like_strategy.py` 此前只有 7 行（`mode_name`/`api_method_name`），
   实际走基类 `base_strategy._collect_paged_aweme`，该函数在 `aweme/favorite/` 被抖音 Argus
   风控确定性拒绝（403，与 post 同样的根因：页面通道注入请求拿不到签名）时**直接 raise**，
   而基类没有 post 模式那种 CDP 浏览器采集兜底 → 必然失败。
2. **「新发布/我的喜欢」自身账号下载 sec_uid 为空**：下载**自己的账号**时前端不传 `sec_uid`，
   post 模式的 CDP 兜底虽然触发，但 `browser-collect` 收到的 `sec_uid` 为空，采集窗口
   因拿不到目标用户而报「缺少 secUid」。
3. 历史根因不变：Electron `/v1/browser-fetch` 注入请求被 Argus 确定性拒绝（见 `main.js` 注释
   "SDK 并不会自动给注入的 window.fetch 补签名"），因此 post/like/collect/mix/music/favorite
   全部直连失败，只能靠桌面端 Chromium 窗口的 CDP 拦截（拦截抖音**自有签名**请求）。

## 改动清单
### 1. `resources/app/main.js`
- 登录成功时持久化自身用户信息到 `cookies/self_user.json`（`saveSelfUser`，供 `finish` 调用；
  同时 `tryLoginWithExistingCookies` 自动登录路径也保存）。
- `collectUserWorksViaBrowser`：当传入 `sec_uid` 为空时，读 `self_user.json` 兜底使用自身
  `sec_uid`（解决「我的喜欢/新发布」自身账号下载拿不到目标用户）。
- `collectUserWorksViaBrowser`：新增 `kind` 支持——
  `post` 拦截 `/aweme/v1/web/aweme/post/`，`like` 拦截 `/aweme/v1/web/aweme/favorite/`；
  打开主页时 like 带 `?from_tab_name=like`。
- `/v1/browser-collect` 处理把 `payload.kind` 透传给采集器。

### 2. `dispatcher/_internal/backend/core/api_client.py`
- `_collect_via_electron_bridge` 新增 `kind` 参数并写入 `/v1/browser-collect` 请求体。
- `collect_user_post_ids_via_browser` 透传 `kind`。
- 新增 `collect_user_like_ids_via_browser(..., kind="like")`，复用 post 的 CDP 拦截逻辑。

### 3. `dispatcher/_internal/backend/core/user_downloader.py`
- 新增 `_recover_user_like_with_browser`：逻辑与 `_recover_user_post_with_browser` 一致，
  仅调用 `collect_user_like_ids_via_browser`（CDP 拦截 favorite 响应），并补全详情。

### 4. `dispatcher/_internal/backend/core/user_modes/like_strategy.py`
- 重写为完整策略：仿照 `post_strategy.collect_items`，对 Argus/bridge/限流 gated 错误
  **捕获 → 标记 `bridge_blocked` → break 跳出分页**，随后落入浏览器兜底块走 CDP 拦截；
  兜底仍空且确属通道拦截时抛出清晰错误。

## 校验
- `node --check main.js` → NODE_OK
- `py_compile` 全部改动文件 → PY_OK
- `user_mode_registry.py` 已注册 `"like": LikeUserModeStrategy`，新策略自动生效。

## 生效方式（重要）
**彻底退出 DRaccoon 托盘进程再重开**，否则仍跑旧代码（历史多次"还是不行"根因）。

## 实测预期
- 「我的喜欢」：走 CDP 兜底，弹出可见「DRaccoon 作品采集」窗口，导航到用户页 `?from_tab_name=like`，
  拦截 `aweme/favorite/` 响应取到喜欢列表。
- 「新发布」自身账号：sec_uid 为空时自动用 `self_user.json` 兜底，CDP 窗口正常打开。
- 静默模式（`browser_fallback.headless=true`）：隐藏窗口可能不渲染/不触发懒加载导致采不到，
  失败请改回 `headless=false`。

## 局限（后续）
- 本次只补了 **like** + 修复 post 的空 sec_uid。collect / mix / music / favorite 模式仍走失效页面通道，
  需各自补 CDP 采集器（导航到对应页并拦截各自 API 响应）才能彻底修。
- 自身账号收藏/合集类的 `collect`/`collectmix` 模式同样缺兜底。
