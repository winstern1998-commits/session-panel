# OpenCode Session 列表拉取机制

## 概览

本文记录 session-panel 的「远端 → 拉取列表」功能如何获取 OpenCode session 列表，包括：

- OpenCode `/session` 端点的 per-project 作用域机制
- `projectID` 的计算逻辑与目录映射关系
- 面板的多目录并发拉取与合并去重实现
- 关注目录管理（手动添加 + 导入自动跟踪）
- 已知限制

## OpenCode `/session` 端点的 per-project 作用域

OpenCode 的 `/session` 列表端点**按 `projectID` 过滤**，不是全局返回所有 session。服务端收到请求后，先从 `x-opencode-directory` header（或 `?directory=` query）解析出 directory，再通过 `Project.resolve()` 算出该 directory 的 `projectID`，最后执行 `WHERE project_id = ?` 过滤。

| 请求方式 | 返回范围 |
|---|---|
| 不带 `x-opencode-directory` | serve 进程 cwd 所属 project 的 session |
| 带 `x-opencode-directory: /path` | 该 path 所属 project 的 session |

### 实测对照（OpenCode 1.17.14）

serve 进程 cwd 为 `/home/lee`（非 git 目录，projectID = `"global"`）：

```
# 不带 header → 只返回 global project 的 session
GET /session
→ 78 个 session，全部 projectID = "global"，跨 16 个 directory

# 带 notes_vault directory → 返回该 git 仓库 project 的 session
GET /session  +  x-opencode-directory: /mnt/d/Note/notes_vault
→ 87 个 session，全部 projectID = "b3acc554..."，directory 都是 notes_vault

# 两个列表零交集
```

### 与 `/session/status` 的区别

`/session/status` 是 **per-directory scoped**（每个 directory 一份独立的 `Map<sessionID, status>`），而 `/session` 列表是 **per-project scoped**（按 `projectID` 过滤）。两者是独立的 scoping 机制，不能互相替代。详见 [status-detection.md](status-detection.md) 的「`/session/status` 作用域问题」章节。

## projectID 的计算逻辑

`projectID` 是 OpenCode 内部用来分组 session 的标识符，存在 session 数据库的 `project_id` 字段里。计算逻辑在 `packages/core/src/project.ts` 的 `resolve()` 函数中，按优先级短路：

| 优先级 | 来源 | 产出 | 触发条件 |
|---|---|---|---|
| 1 | git remote URL | `SHA1("git-remote:" + 归一化URL)` | 目录在 git 仓库内且有 origin remote |
| 2 | `.git/opencode` 缓存文件 | 文件内容 | 之前算过并缓存了 |
| 3 | 根 commit hash | `git rev-list --max-parents=0 HEAD \| sort \| head -1` | git 仓库无 remote 但有 commit |
| 兜底 | 字面量字符串 | `"global"` | 目录不在任何 git 仓库内；或 git 仓库无 remote、无 commit |

### 一个 projectID 可对应多个 directory

- 所有非 git 目录都归 `"global"`，它们的 session 共享 `project_id = "global"` 但各自保留不同的 `directory` 值。
- 同一个 git 仓库的子目录共享仓库的 `projectID`。

### 验证示例

```
# notes_vault 是独立 git 仓库，无 remote，有 commit
$ git -C /mnt/d/Note/notes_vault rev-list --max-parents=0 HEAD | sort | head -1
b3acc5547538f6f43d3d3e904dd6db31f5bd415c   ← 与 projectID 完全一致

# session-panel 目录下的旧 session 创建时该目录还不是 git 仓库
# → project_id 写死为 "global"，即使后来 init 了 git 也不会变
```

## 面板的多目录拉取实现

### 后端：`?directory=` 参数透传

`server.py` 的 `handle_sessions` 从 query 参数读取 directory，透传给 OpenCode：

```python
def handle_sessions(self) -> None:
    params = parse_qs(urlparse(self.path).query)
    directory = params.get("directory", [None])[0]
    sessions = self.opencode_json("/session", directory=directory)
    status = self.collect_statuses(sessions)
    self.send_json({"sessions": sessions, "status": status})
```

`opencode_json` 的 `directory` 参数会变成 `x-opencode-directory` header 发给 OpenCode。`collect_statuses` 从返回的 session 列表里提取各自的真实 `directory` 字段，再逐个查 `/session/status` 合并——这部分逻辑不需要改动，因为带 directory 查 `/session` 返回的 session 自带正确的 `directory` 值。

### 前端：并发请求 + 合并去重

`app.js` 的 `loadRemoteSessions` 同时请求默认端点（global project）和每个关注目录，按 session id 合并去重：

```js
const dirs = state.watchDirectories || [];
const requests = [
  api("/api/sessions"),
  ...dirs.map((d) => api(`/api/sessions?directory=${encodeURIComponent(d)}`)),
];
const results = await Promise.allSettled(requests);

const sessionsMap = new Map();  // id -> session（去重）
const statusMap = {};            // id -> status
for (const result of results) {
  if (result.status !== "fulfilled") continue;
  const { sessions, status } = result.value;
  for (const session of sessions || []) {
    const id = session.id || session.sessionID || session.sessionId;
    if (id && !sessionsMap.has(id)) sessionsMap.set(id, session);
  }
  Object.assign(statusMap, status || {});
}
```

用 `Promise.allSettled` 而非 `Promise.all`，这样某个目录拉取失败不会导致整体失败，其余目录的结果仍然可用。

### 处理前 / 处理后对照

**处理前**（只查默认端点）：

```
GET /api/sessions
→ 78 个 session，全部 projectID = "global"
→ notes_vault 的 87 个 session 完全不可见
```

**处理后**（并发查默认 + 关注目录）：

```
GET /api/sessions                              → 78 个 global session
GET /api/sessions?directory=/mnt/d/Note/notes_vault  → 87 个 notes_vault session
合并去重 → 116 个 session（78 + 87 - 重叠 49 个子 session 过滤后）
```

## 关注目录管理

### 数据持久化

关注目录列表存在 `localStorage` 的 `opencode-session-panel:v1` key 下，字段名 `watchDirectories`（字符串数组）。`loadState` / `saveState` 负责读写。

### 手动添加 / 删除

远端 drawer 顶部有输入框和「添加」按钮。输入路径后回车或点「添加」，会：

1. 去重后加入 `state.watchDirectories`
2. `saveState()` 持久化
3. 重新渲染目录标签列表
4. 自动触发一次 `loadRemoteSessions()` 拉取新目录的 session

每个目录标签右侧有「×」按钮可删除。

### 导入 session 时自动跟踪

`refreshSession(id)` 拿到 session 详情后，会检查 `session.directory` 是否已在关注列表里，不在就自动加入：

```js
async function refreshSession(id) {
  // ... 拉取 session 详情 ...
  snapshots.set(id, snapshot);
  // Auto-track the session's directory so future "拉取列表" covers its project.
  const dir = snapshot.session?.directory;
  if (dir) addWatchDirectory(dir);
}
```

`addWatchDirectory` 内部去重，所以已跟踪的 directory 不会重复添加。这个机制覆盖所有触发 `refreshSession` 的路径：

- 「导入」表单输入 session ID 后加入
- 远端列表点「加入」按钮
- 定期刷新 / SSE 触发的刷新

这样用户导入一个新 project 的 session 后，该 project 的 directory 自动加入关注列表，下次「拉取列表」就能覆盖到该 project 的所有 session。

## 已知限制

- **无法自动发现所有 projectID**：OpenCode 没有提供「列出所有 project」的 API。面板只能覆盖 serve cwd 的默认 project + 用户配置的关注目录。如果用户在某个从未导入过的目录下启动 session，该 session 仍然不可见，直到用户手动添加该目录或导入该 session。
- **`projectID` 在 session 创建时写死**：session 的 `project_id` 字段在创建时确定并写入数据库。如果目录后来变成了 git 仓库（或反过来），旧 session 的 `project_id` 不会更新。
- **关注目录列表无上限保护**：大量关注目录会导致 `loadRemoteSessions` 发起大量并发请求。目前没有做节流或缓存。
