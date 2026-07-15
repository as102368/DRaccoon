# IPC 与通信协议

## 1. Electron IPC 通道总览

前端（渲染进程）与主进程通过 `ipcRenderer.invoke` / `ipcMain.handle` 进行**请求-响应**通信，通过 `ipcRenderer.on` / `webContents.send` 进行**事件推送**通信。

### 请求-响应通道（Invoke / Handle）

| 通道名 | 方向 | 说明 |
|--------|------|------|
| `window-minimize` | R -> M | 最小化主窗口 |
| `window-maximize` | R -> M | 最大化/还原主窗口 |
| `window-close` | R -> M | 关闭应用 |
| `window-is-maximized` | R -> M | 查询窗口是否最大化 |
| `settings:get` | R -> M | 读取用户设置 |
| `settings:set` | R -> M | 保存用户设置 |
| `folder:select` | R -> M | 打开目录选择对话框 |
| `folder:open` | R -> M | 在系统文件管理器中打开目录 |
| `archive:list` | R -> M | 列出作品档案文件夹 |
| `archive:delete` | R -> M | 删除档案文件夹 |
| `video:open` | R -> M | 用系统默认播放器打开视频 |
| `sync:get` | R -> M | 读取同步缓存（favorites/likes/following） |
| `sync:clear` | R -> M | 清除同步缓存 |
| `download:start` | R -> M | 启动下载任务 |
| `download:cancel` | R -> M | 取消下载任务 |
| `sync:start` | R -> M | 启动同步任务 |
| `sync:cancel` | R -> M | 取消同步任务 |
| `userWorks:start` | R -> M | 启动博主作品列表任务 |
| `userWorks:cancel` | R -> M | 取消博主作品任务 |
| `newReleases:start` | R -> M | 启动新发布发现任务 |
| `newReleases:cancel` | R -> M | 取消新发布任务 |
| `auth:loginWithBrowser` | R -> M | 打开内置浏览器登录窗口 |
| `auth:validate` | R -> M | 校验 Cookie 字符串 |
| `auth:completeLogin` | R(登录窗) -> M | 登录窗口通知完成登录 |
| `relation:start` | R -> M | 启动批量关注/取关任务 |
| `relation:cancel` | R -> M | 取消关系任务 |
| `report:export` | R -> M | 启动报表导出任务 |
| `report:cancel` | R -> M | 取消报表任务 |
| `transcript:start` | R -> M | 启动字幕生成任务 |
| `transcript:cancel` | R -> M | 取消字幕任务 |
| `cloud:backup` | R -> M | 启动云备份任务 |
| `cloud:restore` | R -> M | 启动云恢复任务 |
| `cloud:cancel` | R -> M | 取消云任务 |

### 事件推送通道（Send / On）

所有长任务均采用 **三事件模型**：`progress`、`log`、`finished`。

| 命名空间 | Progress | Log | Finished |
|----------|----------|-----|----------|
| 下载 | `download:progress` | `download:log` | `download:finished` |
| 同步 | `sync:progress` | `sync:log` | `sync:finished` |
| 博主作品 | `userWorks:progress` | `userWorks:log` | `userWorks:finished` |
| 新发布 | `newReleases:progress` | `newReleases:log` | `newReleases:finished` |
| 关系操作 | `relation:progress` | `relation:log` | `relation:finished` |
| 报表 | `report:progress` | `report:log` | `report:finished` |
| 字幕 | `transcript:progress` | `transcript:log` | `transcript:finished` |
| 云同步 | `cloud:progress` | `cloud:log` | `cloud:finished` |
| 全局快捷键 | - | - | `shortcut:triggered` |

---

## 2. JSON Lines 协议（Python -> Main Process）

Python 桥接脚本通过 **stdout 每行输出一个 JSON 对象** 与主进程通信。该协议由 `lib.bridge.BridgeOutput` 封装。

### 标准事件格式

```json
{
  "event": "log",
  "task_id": "uuid",
  "task_type": "download",
  "level": "info",
  "message": "..."
}
```

### 事件类型定义

| event | 字段 | 说明 |
|-------|------|------|
| `log` | `level`, `message` | 普通日志（info/warn/error）。 |
| `progress` | `current`, `total`, `message` | 进度更新。 |
| `step` | `step`, `detail` | 步骤变更（如“解析链接”、“下载视频”）。 |
| `item_total` | `total`, `detail` | 设置子任务总数。 |
| `item_advanced` | `status`, `detail` | 单个子任务完成（success/failed/skipped）。 |
| `url_start` | `index`, `total`, `url` | 开始处理某条 URL。 |
| `url_result` | `url`, `total`, `success`, `failed`, `skipped` | 某条 URL 处理结果汇总。 |
| `url_error` | `url`, `message`, `detail?` | 某条 URL 处理失败。 |
| `author` | `nickname`, `sec_uid` | 识别到作者信息。 |
| `title` | `title` | 识别到作品标题。 |
| `items` | `items`, `total` | 批量返回作品元数据（博主作品/新发布）。 |
| `start` | ... | 任务开始信号（可携带初始参数）。 |
| `done` | `total`, `items?`, ... | 任务完成信号（可携带结果摘要）。 |
| `finished` | `success`, `error?`, ... | 最终结束事件（**必须且仅发送一次**）。 |

### 注意事项
- 每行必须是一个合法 JSON，不能有多余前缀。
- 主进程使用 `stdoutBuffer` 按 `\r?\n` 分割，最后一行若未完整则留到下次 `data` 事件。
- 所有输出均经过 `SensitiveRedactor.redact_text()` 脱敏。
- `finished` 事件具有幂等性（`BridgeOutput` 内部标记 `_finished`，重复调用无效）。

---

## 3. 登录窗口专用通信

登录窗口使用独立的 `login-preload.js`，仅暴露：
- `window.electronAPI.completeLogin()` -> `ipcRenderer.invoke('auth:completeLogin')`

主进程在创建登录窗口时动态注册 `auth:completeLogin` handler：
1. 提取当前登录窗口的抖音域名 Cookie。
2. 检查是否包含 `sessionid` 或 (`ttwid` + `passport_csrf_token`)。
3. 调用 `login_service.py` 后端校验。
4. 校验通过后向渲染层返回 `{ success: true, cookieString, user }`。
5. 登录窗口关闭时自动移除 handler。
