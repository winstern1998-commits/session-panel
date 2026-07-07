# SSE 实时刷新修复记录

## 概览

本文记录了 session-panel SSE（Server-Sent Events）实时刷新失效问题的排查与修复过程，主要包括：

- OpenCode serve 的启动方式与认证机制
- 面板 SSE 代理的原始实现与缺陷
- 排查过程与根因定位
- 修复方案与验证

## OpenCode serve 启动与请求

### systemd user service

OpenCode serve 由 systemd user service 管理，服务文件路径 `~/.config/systemd/user/opencode-serve.service`：

```ini
[Unit]
Description=OpenCode serve
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=HOME=/home/lee
Environment=PATH=/home/lee/.opencode/bin:/mnt/d/Applications/bun/bin:/home/lee/.nvm/versions/node/v22.22.2/bin:/home/lee/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=NODE_OPTIONS=--use-env-proxy
Environment=HTTP_PROXY=http://172.24.80.1:7890
Environment=HTTPS_PROXY=http://172.24.80.1:7890
Environment=http_proxy=http://172.24.80.1:7890
Environment=https_proxy=http://172.24.80.1:7890
Environment=NO_PROXY=127.0.0.1,localhost,::1
Environment=no_proxy=127.0.0.1,localhost,::1
ExecStart=/usr/bin/bash -lc 'OPENCODE_SERVER_PASSWORD="$(< "%h/.config/opencode/server-password")" exec "%h/.opencode/bin/opencode" serve --port 4097 --hostname 127.0.0.1'
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

关键点：

- 监听 `127.0.0.1:4097`，仅本机可访问。
- 使用 Basic Auth：密码从 `~/.config/opencode/server-password` 文件读取，用户名 `opencode`。
- 密码通过环境变量 `OPENCODE_SERVER_PASSWORD` 传入 `opencode serve` 进程，不在命令行明文暴露。

### 面板如何携带认证

面板（`server.py`）代理所有请求到 OpenCode 时，通过 `opencode_config()` 解析认证信息，优先级：

```
请求 header (x-opencode-*) → query param → 环境变量 → 默认值
```

对于普通 API 请求，浏览器通过 `x-opencode-*` header 传递配置。对于 SSE 请求，`EventSource` 不支持自定义 header，改用 query param 传递：

```js
const params = new URLSearchParams({
  baseUrl: state.config.baseUrl,
  username: state.config.username,
  password: state.config.password,
});
eventSource = new EventSource(`/api/events?${params}`);
```

当浏览器 `localStorage` 中未存储密码时（`state.config.password` 为空），query param `password=` 为空，`server.py` 会回退到环境变量 `OPENCODE_SERVER_PASSWORD`（由面板的 systemd service 设置）。因此即使浏览器端密码为空，SSE 连接仍能通过认证。

### OpenCode `/event` 端点

OpenCode serve 的 `/event` 端点提供 SSE 流，响应头：

```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Transfer-Encoding: chunked
x-accel-buffering: no
```

事件类型包括：

| 事件类型 | 触发时机 | 面板处理 |
|---|---|---|
| `server.connected` | SSE 连接建立时 | 触发 `debounce(refreshAll, 500)` |
| `server.heartbeat` | 约每 10 秒一次 | 触发 `debounce(refreshAll, 500)` |
| `session.status` | session 状态变化时 | 快路径：直接更新 snapshot + `renderBoard()` |
| `session.updated` | session 元数据更新时 | 触发 `debounce(refreshAll, 500)` |
| `message.updated` | 消息更新时 | 触发 `debounce(refreshAll, 500)` |
| `message.part` / `message.part.updated` | 消息流式更新时 | 触发 `debounce(refreshAll, 500)` |

## 面板 SSE 代理的原始实现

`server.py` 的 `handle_events()` 方法负责将 OpenCode 的 SSE 流转发给浏览器：

```python
def handle_events(self) -> None:
    try:
        request = self.opencode_request("/event")
        with urlopen(request, timeout=60) as response:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            while True:
                chunk = response.read(4096)   # ← 问题在这
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
    except Exception as exc:
        try:
            self.send_error(502, explain=str(exc))
        except BrokenPipeError:
            pass
```

前端 `app.js` 的 SSE 连接与事件处理：

```js
function connectEvents() {
  // ... 建立 EventSource 连接 ...
  eventSource.onmessage = handleEventStreamMessage;
  for (const type of [
    "session.status", "session.updated",
    "message.updated", "message.part.updated", "message.part",
  ]) {
    eventSource.addEventListener(type, handleEventStreamMessage);
  }
  // ... 指数退避重连 ...
}

function handleEventStreamMessage(event) {
  if (handleServerEvent(event)) return;  // session.status 快路径
  refreshFromEvent();                     // 其他事件 → debounce(refreshAll, 500)
}
```

## 问题现象

用户反馈面板状态不是实时更新的——session 从 idle 变为 working 或从 working 变为 idle 后，面板不会及时反映，需要手动点"刷新"或等待 5 分钟轮询。

## 排查过程

### 第一步：确认 OpenCode serve 在运行

```bash
systemctl --user status opencode-serve.service
# Active: active (running)
```

直接请求 `/global/health`（不带认证）无响应，带 Basic Auth 后正常：

```bash
PASS=$(cat ~/.config/opencode/server-password)
curl -s -u "opencode:$PASS" http://127.0.0.1:4097/global/health
# 返回正常
```

### 第二步：直接连 OpenCode `/event`，确认事件流正常

```bash
PASS=$(cat ~/.config/opencode/server-password)
timeout 70 curl -s -u "opencode:$PASS" -N http://127.0.0.1:4097/event
```

70 秒内收到 7 个事件：1 个 `server.connected` + 6 个 `server.heartbeat`（约每 10 秒一个）。

结论：OpenCode 的 SSE 端点正常，每 ~10 秒发送心跳，60 秒超时不会断连。

### 第三步：测面板 SSE 代理，发现不转发数据

```bash
timeout 25 curl -s -N "http://127.0.0.1:7878/api/events?baseUrl=http%3A%2F%2F127.0.0.1%3A4097&username=opencode&password="
```

结果：25 秒内未收到任何数据，连接保持但为空。

结论：面板的 SSE 代理建连成功（HTTP 200），但不向浏览器转发任何数据。

### 第四步：用 Python 脚本定位阻塞点

```python
import urllib.request, base64, time

req = urllib.request.Request('http://127.0.0.1:4097/event')
# ... 添加 Basic Auth ...
with urllib.request.urlopen(req, timeout=60) as resp:
    print('Headers:', dict(resp.getheaders()))  # Transfer-Encoding: chunked
    start = time.time()
    chunk = resp.read(4096)  # ← 阻塞，30 秒未返回
    elapsed = time.time() - start
    print(f'Got {len(chunk)} bytes in {elapsed:.1f}s')
```

结果：`resp.read(4096)` 阻塞超过 30 秒未返回，即使 OpenCode 每 10 秒发送心跳。

## 根因

Python `urllib` 的 `HTTPResponse.read(n)` 对 chunked transfer encoding 的行为：

**`read(n)` 会连续读取多个 chunk，直到累计达到 n 字节或连接关闭。**

SSE 事件每个约 100 字节，`read(4096)` 需要约 40 个事件才能填满 4096 字节。按 OpenCode 每 10 秒发一个心跳，需要约 **400 秒**才能返回一次。浏览器实际上永远收不到数据。

```
read(4096) 的实际行为：
  chunk 1 (~100B) → 累计 100B，未满 4096，继续读
  chunk 2 (~100B) → 累计 200B，未满 4096，继续读
  ...
  chunk 40 (~100B) → 累计 4000B，未满 4096，继续读
  chunk 41 (~100B) → 累计 4100B ≥ 4096，返回

  每个间隔 ~10s → 总等待 ~400s
```

## 修复

将 `response.read(4096)` 改为 `response.read1(4096)`。

`read1(n)` 只读取**一个 chunk** 就立即返回，不会等待填满 n 字节：

```python
# 修复前
chunk = response.read(4096)

# 修复后
chunk = response.read1(4096)
```

`read1` 是 `io.BufferedIOBase` 的方法，`HTTPResponse` 继承了它。对 chunked 编码，`read1(n)` 读取一个 chunk 的数据（最多 n 字节）后立即返回。

### 修复后代码

```python
def handle_events(self) -> None:
    try:
        request = self.opencode_request("/event")
        with urlopen(request, timeout=60) as response:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            while True:
                chunk = response.read1(4096)   # ← 修复：read → read1
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
    except Exception as exc:
        try:
            self.send_error(502, explain=str(exc))
        except BrokenPipeError:
            pass
```

## 验证

修复后重启面板服务，再次测试 SSE 代理：

```bash
systemctl --user restart opencode-session-panel.service
timeout 25 curl -s -N "http://127.0.0.1:7878/api/events?baseUrl=http%3A%2F%2F127.0.0.1%3A4097&username=opencode&password="
```

输出：

```
data: {"id":"evt_f3b61fc92001fMQJ4PNWOQN3mV","type":"server.connected","properties":{}}

data: {"id":"evt_f3b6223a4001fhCZf32OZUPDTT","type":"server.heartbeat","properties":{}}

data: {"id":"evt_f3b625421001LfstXyjxWUDKJ7","type":"server.heartbeat","properties":{}}
```

25 秒内正确收到 3 个事件，SSE 代理恢复正常。

## 修复后的实时刷新链路

```
OpenCode session 状态变化
  └─ /event SSE 推送 session.status 事件
       └─ server.py read1() 即时转发
            └─ 浏览器 EventSource 接收
                 └─ handleServerEvent() 快路径：直接更新 snapshot + renderBoard()
                     （延迟 < 1 秒）

OpenCode 每 ~10s 发送 server.heartbeat
  └─ server.py read1() 即时转发
       └─ 浏览器 EventSource 接收
            └─ refreshFromEvent() = debounce(refreshAll, 500ms)
                 └─ refreshAll() 拉取所有 tracked session 详情（含状态）
                      └─ renderBoard()
                          （延迟 ~500ms + 网络往返）

5 分钟轮询（POLL_INTERVAL_MS = 300000）
  └─ 兜底：补捞 SSE 可能漏掉的状态
```

## 经验总结

| 要点 | 说明 |
|---|---|
| `read(n)` vs `read1(n)` | 对 chunked / 流式响应，`read(n)` 会阻塞直到填满 n 字节，`read1(n)` 只读一个 chunk 立即返回 |
| SSE 代理不能用 `read(n)` | SSE 事件小且稀疏，`read(4096)` 可能永远填不满 |
| `timeout=60` 不是问题 | OpenCode 每 10s 发心跳，`read1` 在 10s 内返回，远小于 60s 超时 |
| 认证回退机制 | 浏览器端密码为空时，`server.py` 回退到环境变量，SSE 连接仍能通过认证 |
| 排查方法 | 逐段测试链路：OpenCode `/event` 直连 → 面板 SSE 代理 → Python `urllib` 行为验证 |
