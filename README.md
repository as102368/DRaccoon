
## 目录结构

```text
D:\DOU\douzy-electron
├── app/                     # 应用源码
│   ├── main.js              # Electron 主进程
│   ├── preload.js           # 预加载脚本（窗口控制 IPC）
│   ├── package.json
│   └── renderer/
│       ├── index.html
│       ├── app.js           # Vue 3 页面与组件
│       ├── style.css        # 暗色主题样式
│       └── vendor/
│           └── vue.global.js
├── electron/                # Electron 预编译二进制（v31.0.2）
├── userdata/                # 本地用户数据（避免写入 AppData）
├── start.bat                # Windows 启动脚本
└── README.md
```

## 运行方式

直接双击 `start.bat`

## 已实现页面

- **关注**：完整复刻截图中的列表、搜索、排序、筛选、分页、下载按钮。
- **收藏 / 下载 / 批量下载 / 任务中心 / 作品档案 / 设置**：已接入侧边栏导航，页面为占位状态，等待后续功能对接。

