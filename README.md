# OpenCode Canvas

一个**可视化的无限画布**，把 OpenCode 会话变成画布上可拖拽、可缩放、可**会话分支**的终端节点。同一段对话可以随时分叉出多条平行线路，互不干扰——像 Git 分支一样管理你的 AI 编码会话。

![stack](https://img.shields.io/badge/Electron-33-47848F) ![stack](https://img.shields.io/badge/React-18-61DAFB) ![stack](https://img.shields.io/badge/React%20Flow-12-FF4B4B) ![stack](https://img.shields.io/badge/xterm.js-5-2D2D2D)

---

## 特性

| 能力 | 说明 |
|------|------|
| 无限缩放画布 | React Flow 点阵画布，滚轮缩放、拖拽平移、小地图、控件 |
| 终端节点 | 每个节点是一个真实终端（node-pty + xterm.js），完全可交互 |
| **会话分支** | 右键/`⑂` 基于 OpenCode `--fork` 复制对话历史，分叉出独立会话，并行互不干扰 |
| 独立全屏 | 每个节点可单独全屏（Portal 覆盖），滚动历史完整保留 |
| 右键菜单 | 画布右键增删终端、fit view；节点右键全屏 / 分支 / 重启 / 删除 |
| 画布管理 | 侧栏多画布：新建 / 重命名 / 复制 / 删除，localStorage 持久化 |
| 分支血缘 | 主线→分支用紫色虚线边表示"fork 关系"，非数据管道 |

---

## 工作原理

```
┌─ 画布层 (React Flow + xterm.js) ──────────────────────┐
│   主会话节点 ──fork edge──▶ 分支A (session A')         │
│                          └▶ 分支B (session A'')        │
├─ Electron 主进程 ─────────────────────────────────────┤
│   node-pty        每个 = 一个独立 pty                  │
│   opencode CLI    会话状态全部归 OpenCode 的 SQLite    │
└────────────────────────────────────────────────────────┘
```

**会话分支的核心**：画布只管"节点 + 血缘 + pty 容器"，对话状态完全交给 OpenCode。分叉时新节点执行：

```bash
opencode --session <父会话id> --fork
```

OpenCode 原生把父对话历史**完整复制**到新 session，两条线从分叉点各自独立演进。画布通过 `created` 时间戳 + `directory` 定位每个节点对应的 session（CLI 列表无 parentID，故用时间+目录匹配）。

---

## 技术栈

- **Electron 33** — 桌面壳，主进程管理 pty / IPC / OpenCode CLI
- **node-pty 1.x** — 真实终端（N-API，Electron 下免重编）
- **React 18 + Vite** — 渲染层
- **React Flow (@xyflow/react) 12** — 无限画布、节点、边
- **xterm.js** — 终端渲染（FitAddon / WebLinksAddon / SerializeAddon）
- **zustand** — 画布状态 + localStorage 持久化
- **Tailwind CSS** — 样式
- **electron-vite** — 构建

---

## 快速开始

### 前置要求

- Node.js ≥ 20
- [OpenCode](https://opencode.ai) CLI 已安装并登录（`opencode` 可在终端运行）
- Windows / macOS / Linux

### 安装

```bash
git clone https://github.com/dfytensor/OpenCodeCanvas.git
cd OpenCodeCanvas
npm install
```

> Windows 上首次安装会下载 Electron 二进制；若网络慢，可设置镜像：
> `set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后再 `npm install`。

### 开发模式

```bash
npm run dev
```

### 生产构建

```bash
npm run build      # 输出到 out/
npm run preview    # 用构建产物启动
```

### 类型检查

```bash
npm run typecheck
```

---

## 使用方法

1. 启动后，左栏 **Pick directory** 选择一个工作目录。
2. 顶栏 **+ OpenCode** 或画布右键 **Add OpenCode terminal** 创建一个 OpenCode 终端节点。
3. 在终端里**先发一条消息**（这会真正创建会话）。
4. 状态点变绿后，点节点右上角 **⑂**（或右键 → Fork from here）分叉出新会话节点。
5. 点 **⤢** 单节点全屏；滚轮缩放画布、拖空白处平移。

---

## 项目结构

```
src/
├── main/              # Electron 主进程
│   ├── index.ts       # 窗口创建
│   ├── pty.ts         # node-pty 终端管理
│   ├── opencode.ts    # opencode CLI 封装（session list 等）
│   ├── worktree.ts    # git 封装（预留：diff/文件隔离）
│   └── ipc.ts         # IPC 通道注册
├── preload/
│   └── index.ts       # contextBridge 安全 API
├── renderer/          # React 渲染层
│   ├── App.tsx
│   ├── components/    # CanvasView / TerminalNode / Sidebar / Toolbar / ContextMenu
│   ├── store/         # canvasStore (zustand + persist)
│   └── lib/           # pty 路由 / 终端注册表
└── shared/
    └── types.ts       # 主/预加载/渲染共享类型
```

---

## 平台说明

- **Windows**：`opencode` 是 npm 全局 shim（`.cmd`），主进程 pty 与 CLI 调用均通过 `cmd.exe /c` 包装以解析 PATH+PATHEXT。
- **node-pty**：基于 N-API，跨 Node/Electron ABI 稳定，无需 `electron-rebuild`。

---

## 路线图

- [x] **分支节点标题显示对话摘要** — 检测到会话后自动把 OpenCode session 的 `title` 写到节点上
- [x] **文件级隔离** — 每次 fork 直接 **copy 整份当前项目**（含未提交改动）到 `.opencode-canvas/{snapshots,copies}/<id>`：`snapshots` 是冻结的 fork 起点（diff 基线），`copies` 是分支运行的工作副本。各分支文件完全独立、可并行操作，不依赖 git
- [x] **diff 预览节点** — fork 节点上点 `⌗` 生成 diff 节点：`git diff --no-index <snapshot> <copy>`（无需仓库），带 +/- 着色、可 `↻` 刷新
- [x] **apply 回主线** — fork 节点上点 `⬇`：解析 `git diff --no-index --name-status` 得到分支改动的文件，仅把这些文件回写到主项目（主项目自己改的其它文件不受影响）

> 为什么不用 git worktree？`git worktree` 从最近一次 commit 分叉，**不包含工作区未提交改动**——而 OpenCode agent 通常只改工作区不 commit，分叉出的对话上下文与分支文件状态会对不上。改用"整份 copy 当前状态"后，fork 起点 = 主线此刻的真实状态，对话与文件完全一致；diff/apply 也只靠 `git diff --no-index`（不需要仓库），逻辑统一。



---

## License

MIT
