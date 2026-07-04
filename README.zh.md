[English](README.md) | [中文](README.zh.md)

# Pi Intercom — RP Fork

> **⚠️ 这是魔改 fork 版。**
> 上游版本：npm `pi-intercom` v0.6.0 by @mariozechner。
>
> 本 fork 专为**角色扮演（RP）场景**设计：
> 一个终端跑角色 agent，另一个终端跑游戏/故事进程，让它们自然交流。

---

## 与上游的关键差异

| 功能 | 上游 | 本 fork |
|------|------|---------|
| `/connect <name>` 双工对话 | ✗ | ✓ 一次连接，双方消息自动注入为真实用户输入，回复自动转发，无需 tool |
| `send_message` tool | ✗ | ✓ 支持**通话模式**（阻塞等待对方回复）和**留言模式**（发完就跑） |
| `deliverAsUser` 消息注入 | ✗ | ✓ 消息以真实用户身份送达对方 |
| `contact_supervisor`（subagent 集成） | ✓ | ✗ **已移除**，本 fork 不接入 pi-subagents |

---

## 为什么需要这个（RP 场景）

你在跑多个 pi 终端做故事演绎：一个**角色 agent** 以角色身份说话，另一个**游戏/故事进程**管理世界状态、NPC、剧情走向。Pi-intercom 让你：

- **角色 ↔ 游戏双工通道** — `/connect story` 一次连接，角色的对白直接进入游戏 session 成为用户输入，游戏的叙述也直接成为角色 session 的用户输入。就像两个玩家在聊天。
- **Agent 间通信** — 游戏 agent 可以 `send_message` 推送给角色 agent：推一段新场景、触发一次对话、告诉角色某个后果。
- **Session 可见性** — 随时查看哪些角色/故事进程在线，是发呆还是在思考。

---

## 一分钟上手

每个加载了 `pi-intercom` 的 pi session 会通过本地 IPC 连接到一个微型 broker。Broker 维护连接列表，按名字或 ID 路由消息。

### 安装

```bash
# 安装本 fork（需要 GitHub 认证）
pi install github:2722550596/pi-intercom

# 或从 npm 安装上游原版
pi install npm:pi-intercom
```

然后重启 Pi。扩展会自动在启动时连接 broker。

---

## 双工对话（推荐方式）

不用任何 tool，像两个人聊天一样。

```bash
# 终端 1 — 游戏/故事进程
/name story

# 终端 2 — 角色 agent
/name lian

# 从角色终端连接游戏
/connect story
# 或者从游戏终端连接角色
/connect lian
```

连接后：

- **角色说话** → 自动注入到游戏 session，游戏 agent 看到的是用户输入
- **游戏叙述** → 自动注入到角色 session，角色 agent 看到的是用户输入
- **不需要任何 tool 调用**，正常对话即可

### 断开

```bash
/disconnect
```

---

## send_message tool

如果你不想建立双工通道，也可以用 tool 发单次消息：

### 通话模式（阻塞等待回复）

```typescript
send_message({
  to: "story",
  message: "我小心翼翼地推开那扇吱呀作响的门……"
})
// → 阻塞，直到游戏 session 回复门后面是什么
```

### 留言模式（发完就跑）

```typescript
send_message({
  to: "lian",
  message: "走廊尽头传来脚步声。",
  blocking: false
})
// → 立即返回，消息以真实用户输入送达角色 session
```

---

## intercom tool

原有的通用 tool，用于发现 session 和发送传统消息：

```typescript
// 列出所有在线 session
intercom({ action: "list" })

// 传统方式发消息（对方收到通知）
intercom({ action: "send", to: "story", message: "..." })

// 发消息并等待回复（内置回复追踪）
intercom({ action: "ask", to: "kaito", message: "你觉得这个洞穴里有什么？" })

// 回复一条待回复的询问
intercom({ action: "reply", message: "我觉得有陷阱。" })

// 查看所有待回复的询问
intercom({ action: "pending" })

// 查看连接状态
intercom({ action: "status" })
```

### 接收消息

- 如果已通过 `/connect` 建立双工通道：消息以真实用户输入注入
- 如果未建立双工：消息以行内通知显示，附带发送者信息和回复提示

---

## 配什么提示词

在角色的 `AGENTS.md` 或 `.pi/AGENTS.md` 里加上这段，让 agent 理解该怎么用：

```xml
<pi-intercom>
本 session 是一个角色 agent，通过 pi-intercom 与游戏/故事进程通信。
使用 `/skill:pi-intercom` 了解通信模式。

**规则：**
- /connect 建立双工通道后，正常说话即可
- 需要向游戏发动作/询问时，用 send_message() 通话模式
- 游戏推送过来的消息直接作为用户输入出现
</pi-intercom>
```

---

## 键盘快捷键

| 按键 | 功能 |
|------|------|
| Alt+M | 打开 session 列表界面 |
| ↑/↓ | 导航 session 列表 |
| Enter | 选择 session / 发送消息 |
| Escape | 取消 / 关闭界面 |

---

## 配置

在 `~/.pi/agent/intercom/config.json`：

```json
{
  "brokerCommand": "npx",
  "brokerArgs": ["--no-install", "tsx"],
  "confirmSend": false,
  "enabled": true,
  "replyHint": true
}
```

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `brokerCommand` | `"npx"` | 启动 broker 进程的命令 |
| `brokerArgs` | `["--no-install", "tsx"]` | 传给 broker 命令的参数 |
| `confirmSend` | false | 交互式 session 是否在发送前弹出确认 |
| `enabled` | true | 启用/禁用 intercom |
| `replyHint` | true | 在收到的消息中附带回复提示 |

---

## 工作原理

```
Pi Session A             Intercom Broker           Pi Session B
  ┌─────────┐             ┌──────────────┐           ┌─────────┐
  │ Client  │◄─Socket──►│  Session 表  │◄─Socket──►│ Client  │
  │ intercom│             │  消息路由器  │           │ intercom│
  │ UI 界面 │             └──────────────┘           │ UI 界面 │
  └─────────┘                                        └─────────┘
```

- **本地 IPC**：Unix socket（macOS/Linux）或命名管道（Windows），仅限本机
- **自动启动**：第一个 session 连接时自动 spawn broker，最后一条 session 断开后 5 秒自动退出
- **文件锁**：防止多个 session 同时启动重复的 broker

运行时目录 `~/.pi/agent/intercom/`：

| 文件 | 说明 |
|------|------|
| `broker.sock` | Unix socket（macOS/Linux） |
| `broker.pid` | Broker 进程 ID |
| `config.json` | 用户配置 |
| `broker-launch.vbs` | Windows 隐藏启动脚本 |

---

## 文件结构

```
pi-intercom/
├── package.json
├── index.ts              # 扩展入口
├── types.ts              # SessionInfo, Message, 协议类型
├── config.ts             # 配置加载
├── broker/
│   ├── broker.ts         # Broker 进程
│   ├── client.ts         # IntercomClient 类
│   ├── framing.ts        # 长度前缀 JSON 协议
│   ├── paths.ts          # 平台相关的 socket/pipe 路径
│   └── spawn.ts          # 自动启动逻辑（文件锁）
├── ui/
│   ├── session-list.ts   # Session 选择界面
│   ├── compose.ts        # 消息编辑界面
│   └── inline-message.ts # 收消息显示组件
└── skills/
    └── pi-intercom/
        └── SKILL.md      # 内置 skill
```

---

## 局限

- **仅限本机** — 使用本地 socket/pipe，不支持网络
- **无独立消息记录** — 消息存在 pi session 历史中，没有单独的 intercom 收件箱
- **附件仅协议支持** — `file`/`snippet`/`context` 附件协议支持，但编辑界面不支持
- **仅显示已连接的 session** — 列表只显示加载了 pi-intercom 并成功注册的 session
- **Broker 生命周期** — broker 自动启动、空闲退出；session 会自动重连