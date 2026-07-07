# OpenCode Session 状态检测机制

## 概览

本文记录 session-panel 如何检测 OpenCode session 的状态变化（idle / working / retrying），包括：

- SSE 代理基础设施（认证机制、`read1()` 转发修复）
- OpenCode SSE 事件的实际行为（与预期的差异）
- `/session/status` 的 per-directory 作用域问题
- 面板的三层状态检测机制
- 轻量状态探测端点 `/api/statuses`

## SSE 代理基础设施

### OpenCode serve 与认证

OpenCode serve 监听 `127.0.0.1:4097`，使用 Basic Auth（用户名 `opencode`，密码从 `~/.config/opencode/server-password` 读取）。

面板代理所有请求到 OpenCode 时，认证信息解析优先级：

```
请求 header (x-opencode-*) → query param → 环境变量 → 默认值
```

普通 API 请求通过 `x-opencode-*` header 传递配置。SSE 请求特殊处理——`EventSource` 不支持自定义 header，改用 query param：

```js
const params = new URLSearchParams({
  baseUrl: state.config.baseUrl,
  username: state.config.username,
  password: state.config.password,
});
eventSource = new EventSource(`/api/events?${params}`);
```

当浏览器 `localStorage` 中未存储密码时（`password=` 为空），`server.py` 回退到环境变量 `OPENCODE_SERVER_PASSWORD`（由面板的 systemd service 设置）。因此即使浏览器端密码为空，SSE 连接仍能通过认证。

### SSE 代理的 `read1()` 转发

`server.py` 的 `handle_events()` 将 OpenCode 的 SSE 流转发给浏览器。关键实现：

```python
while True:
    chunk = response.read1(4096)   # 不是 read()，是 read1()
    if not chunk:
        break
    self.wfile.write(chunk)
    self.wfile.flush()
```

**为什么用 `read1()` 而不是 `read()`？**

Python `urllib` 的 `HTTPResponse.read(n)` 对 chunked transfer encoding 会**连续读取多个 chunk 直到累计 n 字节**。SSE 事件每个约 100 字节，`read(4096)` 需要约 40 个事件才能填满，按 ~10s/事件计算要等 **~400 秒**才返回一次——浏览器实际上永远收不到数据。

`read1(n)` 只读取**一个 chunk** 就立即返回，适合 SSE 这种小而稀疏的事件流。

### 谁决定 SSE 推送什么事件

**由 OpenCode serve（Go 后端）决定。** `/event` 端点、事件类型、推送时机都写死在 OpenCode 源码里。`server.py` 是透明代理——用 `read1()` 读一个 chunk 就立即转发，不检查、不过滤、不生成事件。面板无法控制 SSE 推送什么，只能接收和响应。

## OpenCode SSE 事件行为

### 预期 vs 实际

最初的设计假设 OpenCode 的 SSE 端点 (`/event`) 会推送数据事件：

| 事件类型 | 预期触发时机 | 实际是否推送 |
|---|---|---|
| `server.connected` | SSE 连接建立时 | ✅ 推送 |
| `server.heartbeat` | 约每 10 秒 | ✅ 推送 |
| `session.status` | session 状态变化时 | ❌ **不推送** |
| `session.updated` | session 元数据更新时 | ❌ **不推送** |
| `message.updated` | 消息更新时 | ❌ **不推送** |
| `message.part` | 消息流式更新时 | ❌ **不推送** |

### 验证方法

直接抓取 OpenCode 的 SSE 流，过滤心跳后观察是否有数据事件：

```bash
PASS=$(cat ~/.config/opencode/server-password)
timeout 45 curl -s -u "opencode:$PASS" -N http://127.0.0.1:4097/event | grep -v heartbeat | grep -v "^$"
```

结果：45 秒内只收到一个 `server.connected` 事件，没有任何 `session.status` 或 `message.*` 事件。即使有 session 正处于 busy 状态，也没有任何数据事件推送。

### 结论

**OpenCode 的 SSE 纯粹是保活机制，不是数据推送通道。** SSE 连接只用于：
1. 检测连接是否存活（心跳）
2. 在连接断开时触发重连

不能依赖 SSE 推送 session 状态变化或消息更新。

## `/session/status` 作用域问题

### per-directory scoping

OpenCode 1.17.x 的 `/session/status` 端点使用 `InstanceState ScopedCache`，**按目录隔离**状态缓存。

- 请求**不带** `x-opencode-directory` header → 只返回 serve 进程 cwd 的状态，通常为空 `{}`
- 请求**带** `x-opencode-directory` header → 返回该目录下所有 session 的状态

```bash
# 不带 directory — 返回空
curl -s -u "opencode:$PASS" http://127.0.0.1:4097/session/status
# → {}

# 带目录 — 返回该目录的 session 状态
curl -s -u "opencode:$PASS" -H "x-opencode-directory: /mnt/d/Other/projects/session-panel" \
  http://127.0.0.1:4097/session/status
# → {"ses_xxx": {"type": "busy"}}
```

### 面板的处理

`server.py` 的 `collect_statuses` 方法会：
1. 获取所有 session 列表
2. 提取所有唯一的 `directory` 值
3. 对每个目录单独查询 `/session/status`
4. 合并所有状态 map

**不要将这个逻辑简化为单次 `/session/status` 调用**——会丢失大部分 session 的状态。

## `/session/:id` 不包含状态

OpenCode 的 `/session/:id` 端点返回 session 元数据（title、cost、tokens、time 等），但**不包含 `status` 字段**。

状态必须单独从 `/session/status` 获取。`server.py` 的 `handle_session_detail` 方法在代理 `/api/session/:id` 时，会额外查询 `/session/status`（带上 session 的 directory）并将结果合并到响应中：

```python
def handle_session_detail(self, session_id: str) -> None:
    session = self.opencode_json(f"/session/{encoded_id}")
    directory = session.get("directory")
    status = self.opencode_json("/session/status", fallback={}, directory=directory)
    # ... messages, todos, children ...
    self.send_json({
        "session": session,
        "status": status.get(session_id),  # 从 status map 中提取该 session 的状态
        "messages": messages,
        "todos": todos,
        "children": children,
    })
```

## 面板的三层状态检测机制

由于 SSE 不推送数据事件，面板使用三层机制检测状态变化：

### 第一层：心跳触发轻量状态探测（~10s）

SSE 心跳每 ~10 秒到达一次，触发 `checkStatuses()`：

1. 从缓存的 snapshots 中收集所有 tracked session 的 directory
2. 调用 `/api/statuses?dirs=dir1,dir2,...`（轻量，只查状态）
3. 将返回的状态与缓存的 snapshot 状态对比
4. 如果状态变了 → 触发 `refreshSessionDebounced(id)` 拉取完整数据
5. 如果 session 正处于 busy/retrying → 也触发刷新（获取最新消息）
6. 如果 idle 且未变 → 什么都不做

```
SSE heartbeat (~10s)
  └─ checkStatuses()
       └─ /api/statuses?dirs=... (轻量，只查 /session/status)
            ├─ 状态变了 → refreshSessionDebounced(id) → 全量拉取 → renderBoard()
            ├─ session 在忙 → refreshSessionDebounced(id) → 刷新消息
            └─ idle 没变 → 不做任何事
```

### 第二层：定向全量刷新

当 `checkStatuses()` 检测到状态变化或 session 处于 busy 时，触发 `refreshSessionDebounced(id)`：

- 300ms debounce，避免短时间内多次触发
- 只拉取受影响的 session（不是所有 tracked session）
- 调用 `/api/session/:id` 获取完整数据（session 元数据 + status + messages + todos + children）
- 更新 snapshot，调用 `renderBoard()`

### 第三层：5 分钟全量轮询（兜底）

`POLL_INTERVAL_MS = 300000`（5 分钟），调用 `refreshAll()` 刷新所有 tracked session。作为前两层漏检的兜底机制。

## `/api/statuses` 端点

### 用途

轻量状态探测——只查询 `/session/status`，不拉取 session 详情。用于心跳触发的定期检查。

### 请求

```
GET /api/statuses?dirs=/path/to/dir1,/path/to/dir2
```

- `dirs`：逗号分隔的目录列表（URL 编码）
- 目录从 tracked session 的 snapshot 中提取

### 响应

```json
{
  "ses_abc123": {"type": "busy"},
  "ses_def456": {"type": "retry", "attempt": 2}
}
```

- 只包含 busy/retry 状态的 session
- 不在 map 中的 session = idle

### server.py 实现

```python
def handle_statuses(self) -> None:
    parsed = urlparse(self.path)
    params = parse_qs(parsed.query)
    dirs_param = params.get("dirs", [""])[0]
    dirs = [d for d in dirs_param.split(",") if d]
    merged: dict[str, Any] = {}
    for d in dirs:
        partial = self.opencode_json("/session/status", fallback={}, directory=d)
        if isinstance(partial, dict):
            merged.update(partial)
    self.send_json(merged)
```

## 状态分类

`app.js` 的 `classifyStatus` 函数将原始状态映射为 UI 状态：

| 原始状态 | UI 状态 | 说明 |
|---|---|---|
| `{type: "busy"}` | `working` | session 正在处理 |
| `{type: "retry", attempt: N}` | `retrying` | session 重试中（第 N 次） |
| `null` / `undefined` / 不在 status map 中 | `idle` | session 空闲 |

## 排查方法

### 检查 SSE 连接是否正常

```bash
# 通过面板代理
timeout 25 curl -s -N "http://127.0.0.1:7878/api/events?baseUrl=http%3A%2F%2F127.0.0.1%3A4097&username=opencode&password="
# 应每 ~10s 收到一个 heartbeat

# 直接连 OpenCode
PASS=$(cat ~/.config/opencode/server-password)
timeout 25 curl -s -u "opencode:$PASS" -N http://127.0.0.1:4097/event
```

### 检查 session 状态

```bash
PASS=$(cat ~/.config/opencode/server-password)
# 查看所有 session
curl -s -u "opencode:$PASS" http://127.0.0.1:4097/session | python3 -m json.tool

# 查看特定目录的状态
curl -s -u "opencode:$PASS" -H "x-opencode-directory: /path/to/dir" \
  http://127.0.0.1:4097/session/status | python3 -m json.tool

# 通过面板的轻量端点
curl -s "http://127.0.0.1:7878/api/statuses?dirs=%2Fpath%2Fto%2Fdir" | python3 -m json.tool
```

### 检查面板服务状态

```bash
systemctl --user status opencode-session-panel.service
journalctl --user -u opencode-session-panel.service -f
```

## 经验总结

| 要点 | 说明 |
|---|---|
| `read1()` 不是 `read()` | SSE 代理必须用 `read1(n)` 转发 chunked 流，`read(n)` 会阻塞直到填满 n 字节 |
| 认证回退 | 浏览器端密码为空时，`server.py` 回退到环境变量，SSE 连接仍能通过认证 |
| SSE 不推送数据 | OpenCode 的 SSE 只有心跳，不能依赖它推送状态/消息变化 |
| 心跳做探测触发 | 利用 ~10s 心跳作为轻量状态探测的定时器，而非全量刷新的触发器 |
| 轻量优先 | 先查 `/session/status`（1 次 API/目录），状态变了才拉完整数据（4-5 次 API/session） |
| 状态按目录隔离 | `/session/status` 必须带 `x-opencode-directory`，否则返回空 |
| `/session/:id` 不含状态 | 状态必须从 `/session/status` 单独获取 |
| idle 不动 | 状态没变且不忙的 session 不做任何操作，避免不必要的网络请求和 UI 闪烁 |
