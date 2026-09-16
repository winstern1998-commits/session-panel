# OpenCode Session Panel

一个本地面板，用来连接 WSL 内运行的 `opencode` server，集中跟踪多个工作主线下的 session。

## 功能

- 连接 `opencode serve` 或 TUI 自带 server。
- 导入指定 `session_id`，也可以从远端 session 列表一键加入面板。
- 实时显示 session 状态、最后消息、todo、子 session 数、更新时间。
- 修改会话标题，对应调用 `PATCH /session/:id`。
- 当 session 从 busy/working 变为 idle/完成态时，浏览器通知并可向 opencode TUI 发 toast。
- 按工作主线分组，适合多个需求同时开发时快速定位。

## 启动

先在 WSL 内启动 opencode server：

```bash
opencode serve --hostname 127.0.0.1 --port 4097 --cors http://127.0.0.1:7878
```

如果 server 设置了 Basic Auth：

```bash
OPENCODE_SERVER_PASSWORD=your-password opencode serve --port 4097
```

再启动面板：

```bash
cd session-panel
python3 server.py
```

浏览器打开：

```text
http://127.0.0.1:7878
```

## 配置

可用环境变量：

```bash
PANEL_PORT=7878
OPENCODE_BASE_URL=http://127.0.0.1:4097
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=your-password
```

也可以在页面右上角直接改 server 地址、用户名、密码。页面配置会保存在浏览器本地。

## WSL 连接提示

如果面板运行在 WSL 内，默认 `http://127.0.0.1:4097` 即可。

如果你从 Windows 浏览器访问 WSL 中的 server，通常 Windows 会转发 localhost；不行时先在 WSL 里执行：

```bash
hostname -I
```

然后把面板里的 Server URL 改成：

```text
http://<WSL-IP>:4097
```

同时 opencode server 需要监听局域网地址，例如：

```bash
opencode serve --hostname 0.0.0.0 --port 4097 --cors http://127.0.0.1:7878
```

## 说明

本项目只通过 opencode 官方 HTTP API 操作 session，不读取或修改 opencode 内部数据文件。

## License

[MIT](LICENSE)
