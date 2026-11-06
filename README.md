# dsh-qqbot-interceptor

对 `@tencent-connect/dsh-qqbot` 的消息流做**旁路截流**：QQ 机器人收到的消息可以在进入 dsh agent 之前被拦下来，机器人发出的消息会被记录；你通过两个工具函数（收消息 / 发消息）就能自己实现固定回复、按钮互动和更复杂的路由，而不必为每条 QQ 消息付一次 dsh system prompt + 工具上下文的 token。

- 不替换 qqbot 插件，不新开 WebSocket 连接，不修改 `node_modules` 里的 qqbot 代码
- 在进程内 patch `@tencent-connect/qqbot-nodejs` 的 3 个切面（见下）
- 提供两种模式：`intercept`（截流，消息不进 dsh）和 `observe`（只旁路观察，dsh 照常回复）
- 导出两个核心函数：`getInboundMessages()`、`sendOutboundMessage()`
- 同时注册 dsh 工具：`qqbot_inbox`、`qqbot_send`
- 提供本地 HTTP + SSE API，方便用任意语言写控制器
- 自带一个「谁@我说了什么」的固定回复示例

---

## 1. 工作方式

```
QQ 用户
   │  @bot / 私聊
   ▼
QQ WebSocket ──► @tencent-connect/qqbot-nodejs
                   │
                   │ ① handleInboundMessage  ← patch：原始消息先进入 inbox
                   ▼
              SDK 中间件链
              （白名单 / @门控 / 限流 / 斜杠命令 / 附件下载 / 群历史 / 信封）
                   │
                   │ ② emit('message')       ← patch：intercept 时在这里吞掉
                   ├──────────────► observe：原样交给 dsh-qqbot → ctx.agents → LLM
                   │
                   └──────────────► intercept：只进 inbox，不创建 agent / session
                                         │
                          你的控制器 ◄────┘  GET /inbox 或 qqbot_inbox
                              │
                              └──► POST /send 或 qqbot_send
                                        │ ③ bot.send / sendImage ... ← patch：出站记录到 outbox
                                        ▼
                                   QQ 用户
```

三个切面都是 `QQBot.prototype` 上的方法，patch 只安装一次，并委托给当前活动的 bridge；插件热重载不会重复包装。

| 切面 | 作用 |
|---|---|
| `handleInboundMessage` | 在任何中间件之前拿到网关原始消息（群聊未 @ 的消息也能看到） |
| `emit('message' / 'interaction')` | 拿到经过中间件后的「可动作」消息；intercept 时不再调用 qqbot 的 handler |
| `send` / `sendText` / `sendImage` / `sendVideo` / `sendVoice` / `sendFile` / `sendChannelMessage` | 记录机器人真正发出的消息 |

> 为什么不在 dsh 里做？因为 qqbot 的每条消息都会走 `ctx.agents`，把 dsh 的 system prompt、工具 schema、会话历史全部注入。对于「@ 一下就回一句固定话」这类交互，这部分是纯浪费。截流后，控制器只需要处理 `sender + content + wasMentioned`，token 成本趋近于零。

---

## 2. 安装

### 方式 A：作为 bundle 安装（推荐，需要可用的 `dsh plugin` / Plugin Manager）

```bash
dsh plugin --profile desktop add /absolute/path/to/packages/dsh-qqbot-interceptor
```

包内 `cordis.patch.yml` 会插入 `qqbot-interceptor` 行，默认 `mode: intercept`、端口 `7333`。安装后重启或等 HMR 生效。

### 方式 B：手动放到 profile（本仓库开发机使用的方式）

1. 构建：

   ```bash
   cd packages/dsh-qqbot-interceptor
   npm ci            # 或 npm install
   npm run build     # 产出 dist/
   ```

2. 把 `package.json` + `dist/` 复制到 profile 的 `node_modules`：

   ```powershell
   $profile = "$env:DSH_HOME\profiles\desktop"
   $dest = "$profile\node_modules\dsh-qqbot-interceptor"
   New-Item -ItemType Directory -Force $dest | Out-Null
   Copy-Item package.json $dest
   Copy-Item -Recurse -Force dist $dest
   ```

3. 在 `$env:DSH_HOME\profiles\desktop\cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: qqbot-interceptor
         name: dsh-qqbot-interceptor
         config:
           mode: intercept
           host: 127.0.0.1
           port: 7333
   ```

4. 保存后 dsh 会热加载这个 patch 层；验证：

   ```powershell
   curl.exe http://127.0.0.1:7333/health
   ```

   `patched: true` 表示 SDK patch 成功；`botSeen` 在第一条 QQ 消息到达后变为 `true`。

> 手动方式没有改 profile 的 `package.json`，所以下一次 `pnpm install` 可能清掉这个目录；长期使用建议走方式 A，或把包作为 `link:` 依赖写进 profile。

---

## 3. 配置

行配置（`cordis.patch.yml`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `observe`（代码默认）/ `intercept`（bundle patch 默认） | `intercept` 截流，`observe` 只旁路 |
| `host` | `127.0.0.1` | HTTP API 监听地址 |
| `port` | `7333` | HTTP API 端口；`0` 关闭 HTTP |
| `token` | 空 → 随机生成 | HTTP API 的 Bearer token；随机值写到 `api.json` |
| `ringSize` | `500` | inbox/outbox/interactions 各自保留的最大条数 |
| `ackInteractions` | `true` | intercept 时自动 ack 按钮点击，避免用户端一直转圈 |
| `allowRelease` | `true` | 是否允许把截流的消息放回 dsh（`POST /release`） |
| `maxPassiveAgeMs` | `270000`（4.5 分钟） | 超过这个时间的 msgId 不再作为被动回复，改为主动推送 |
| `dataDir` | 空 → `$DSH_HOME/qqbot-interceptor` | `api.json` 的目录 |
| `debug` | `false` | 打印每条消息的简要日志（不打印正文） |

运行时切换模式（不重启）：

```bash
curl -X POST http://127.0.0.1:7333/mode \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"mode":"observe"}'
```

模式是进程内状态，重启后回到配置值。

---

## 4. 两个工具函数

### 4.1 进程内（TS / dsh 插件 / 工具）

```ts
import {
  getInboundMessages,
  sendOutboundMessage,
} from 'dsh-qqbot-interceptor'

// 读消息流；waitMs 是长轮询，最多等 60s
const { messages, nextSince } = await getInboundMessages({
  since: 0,
  limit: 20,
  waitMs: 30_000,
  actionableOnly: true, // 只要「本来会进 dsh」的消息
})

for (const message of messages) {
  if (message.wasMentioned || message.scope === 'c2c') {
    await sendOutboundMessage({
      replyTo: message.id,           // 被动回复这条消息
      text: `${message.senderName ?? message.senderId} 谁@我说了「${message.content}」`,
    })
  }
}
```

辅助函数：`getOutboundMessages()`（机器人发出的消息流）、`getInteractions()`（按钮点击流）。

### 4.2 作为 dsh 工具

插件启动时向 `ctx.tools` 注册两个工具，任何 agent 都可以调用：

- `qqbot_inbox`：参数 `since / limit / waitMs / scope / peerId / actionableOnly`，返回 `{ messages, nextSince }`
- `qqbot_send`：参数 `text / markdown / target / replyTo / format / keyboard`，返回 `{ messageId, target, type }`

> 注意：是**工具注册**，不是让每条 QQ 消息自动进入 agent。截流模式下 QQ 消息不会主动开始一个 dsh turn；只有你（或控制器）显式调用工具时才会用到 agent。

### 4.3 HTTP API（跨进程）

启动后 `api.json`（默认 `~/.dsh/qqbot-interceptor/api.json`，权限 0600）：

```json
{
  "version": 1,
  "url": "http://127.0.0.1:7333",
  "token": "……",
  "pid": 12345,
  "appId": "……",
  "mode": "intercept"
}
```

除 `/health` 外都需要：

```
Authorization: Bearer <token>
# 或 ?token=<token>
```

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 运行状态、patch 状态、计数（无鉴权） |
| GET | `/inbox?since=&limit=&waitMs=&scope=&peerId=&actionable=1` | 收件箱，支持长轮询 |
| GET | `/outbox?since=&limit=&waitMs=` | 机器人发出的消息 |
| GET | `/interactions?since=&limit=&waitMs=` | 按钮/互动事件 |
| GET | `/conversations` | 最近会话（scope + peer + 最后一条） |
| GET | `/mode` | 当前模式 |
| POST | `/mode` | `{"mode":"observe"\|"intercept"}` |
| POST | `/send` | `{"replyTo":"in_12","text":"..."}` 或 `{"target":"group:xxx","markdown":"..."}` |
| POST | `/release` | `{"id":"in_12"}` 把消息放回 dsh 正常链路 |
| GET | `/stream?since=0` | SSE：`inbound` / `outbound` / `interaction` 事件 |

`/inbox` 单条消息的关键字段：

```jsonc
{
  "id": "in_12",
  "seq": 12,
  "scope": "group",
  "peerId": "GROUP_OPENID",
  "senderId": "USER_OPENID",
  "senderName": "张三",
  "content": "你好",            // 中间件清洗后（去 @ 标记）
  "rawContent": "<@!bot> 你好", // 网关原文
  "wasMentioned": true,
  "actionable": true,          // 本来会进入 dsh
  "status": "intercepted",     // intercepted / passed / released
  "attachments": [{ "kind": "image", "localPath": "...", "url": "..." }],
  "envelope": "<from>…</from>\n\n<message>…</message>", // qqbot 会交给 agent 的上下文预览
  "replyTarget": { "scope": "group", "targetId": "GROUP_OPENID", "msgId": "..." }
}
```

`POST /send` 的目标解析顺序：

1. `replyTo` 是 `in_N` → 用该入站消息的 `replyTarget`（4.5 分钟内带 `msg_id`，之后转主动推送）
2. `replyTo` 是 `int_N` → 用互动事件的 `event_id`
3. `replyTo` 是原始 QQ msgId → 需要同时给 `target`
4. 显式 `target`（`c2c:openid` / `group:group_openid`）
5. 都没有 → 取最近一条入站消息的会话

---

## 5. 固定回复示例

`examples/fixed-reply.mjs` 是一个**独立 Node 进程**，只通过 HTTP API 工作：

```bash
node examples/fixed-reply.mjs
# 或
REPLY_TEMPLATE='{sender} 你@我说了「{content}」' node examples/fixed-reply.mjs
ONCE=1 node examples/fixed-reply.mjs
```

它做的事：

1. 读 `api.json`
2. 长轮询 `/inbox?actionable=1`
3. 对 `status === 'intercepted'` 且（`wasMentioned` 或私聊）的消息套模板
4. `POST /send {replyTo: message.id, text}`

这整套流程没有 import dsh，也没有创建 agent，所以每条回复的 dsh token 成本是 0。

---

## 6. 验证清单

1. `GET /health` → `ok: true`, `patched: true`
2. 在 QQ 里 @ 机器人 → `botSeen: true`，`/inbox` 出现 `status: "intercepted"` 的记录，dsh 侧没有新 turn
3. `POST /send` 或跑示例 → QQ 收到回复
4. `POST /release` → 这条消息进入 dsh，正常生成回复
5. 切到 `observe` → @ 机器人，dsh 照常回复，同时 inbox 仍有记录

---

## 7. 开发

```bash
npm install
npm run build        # tsc -> dist/
npm test             # tsx --test（需要能 spawn esbuild）
npm run test:node    # 受限 shell 用：先 tsc 再直接 node 运行编译后的测试
```

测试用真实的 `@tencent-connect/qqbot-nodejs` 类实例验证 patch（不是 mock），覆盖：截流/放行、出站归属、按钮 ack、重复投递去重、HTTP 鉴权与 `/send` `/release` `/mode`。

---

## 8. 兼容性与已知限制

- **依赖 qqbot-nodejs 的私有方法**：`handleInboundMessage` / `emit` 在 TS 里是 private，但在 1.0.5 的运行时是普通原型方法。升级 SDK 后如果改名，`/health` 会返回 `patched: false` + `patchError`，插件不会让宿主崩溃，但截流不生效。
- **bot 实例在第一条入站消息时绑定**：qqbot 插件把 `QQBot` 实例私有持有，没有对外服务。插件加载后、第一条消息到达前，`POST /send` 返回 503 `BOT_NOT_BOUND`；收到任意一条消息后即可主动发送。
- **c2c 流式输出**：observe 模式下 qqbot 的流式分片走 `StreamSession`，不会逐片进入 outbox；群聊/非流式的 markdown 和所有媒体发送会记录。截流模式下不存在 qqbot 的流式输出。
- **截流仍会跑 SDK 中间件**：附件下载、限流、@ 门控、斜杠命令、群历史都会执行。这是有意为之——inbox 里的 `content` / `envelope` / `wasMentioned` 与真正进 dsh 的语义一致。斜杠命令（`/bot-help` 等）仍由 qqbot 直接响应，不经过截流。
- **被动回复窗口**：QQ 的 `msg_id` 被动回复有时效和次数限制；超过 `maxPassiveAgeMs` 后本插件会去掉 `msg_id` 转主动推送，群聊主动推送可能被平台限制。
- **群聊未 @ 的消息**：会出现在 inbox（`actionable: false`），不会触发截流回复；是否处理由控制器决定。
- **热重载**：bridge 存放在 `globalThis`，插件 HMR 重载后缓冲区保留；完整重启 dsh 后清空，控制器应从 `since=0` 开始并处理 `nextSince` 回退。

---

## 9. 安全

- HTTP 默认只监听 `127.0.0.1`，且所有读写接口都要求随机 token（写于权限 0600 的 `api.json`）。
- 不要把 `port` 暴露到公网；如果必须跨机，请自行加反向代理和鉴权。
- 默认不把消息正文写日志；`debug: true` 也只打印 id/scope。
- `POST /send` 能以机器人身份发言，等同于 qqbot 的凭据权限，token 请按密码管理。

---

## 10. 卸载 / 回滚

1. 在 profile 的 `cordis.patch.yml` 删除 `qqbot-interceptor` 的 `insert` 行（或设为 `disabled: true`）。
2. 删除 `node_modules/dsh-qqbot-interceptor`（方式 B）。
3. 保存后热加载，QQ 消息恢复走原 dsh 链路。

如果只想临时恢复原链路，不必卸载：`POST /mode {"mode":"observe"}`。
