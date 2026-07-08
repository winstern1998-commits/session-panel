/* ============================================================
   OpenCode Session Panel — frontend logic
   Pure HTML/CSS/JS, no dependencies.
   ============================================================ */

const STORAGE_KEY = "opencode-session-panel:v1";
const DEFAULT_BASE_URL = "http://127.0.0.1:4097";
const OLD_DEFAULT_BASE_URL = "http://127.0.0.1:4096";

const HEALTH_INTERVAL_MS = 8000;
const POLL_INTERVAL_MS = 300000;
const SSE_BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000];

/* ---------- state ---------- */
const state = loadState();
const tracked = new Map(state.tracked.map((item) => [item.id, item]));
const collapsedLanes = new Set(state.collapsedLanes || []);
const snapshots = new Map();
const liveStatuses = new Map();

let eventSource = null;
let sseRetryIndex = 0;
let sseRetryTimer = null;
let healthTimer = null;
let pollTimer = null;
let connectionState = "unknown"; // "connected" | "disconnected" | "unknown"
let healthVersion = "";
let lastRenderSig = "";
let remoteFilterDir = null;
let watchDirDropdown = null;
const refreshFromEvent = debounce(refreshAll, 500);

/* Per-session debounced refresh — only re-fetches the session that changed,
   instead of refreshing all tracked sessions on every SSE event. */
const refreshSessionTimers = new Map();
function refreshSessionDebounced(id) {
  if (refreshSessionTimers.has(id)) clearTimeout(refreshSessionTimers.get(id));
  refreshSessionTimers.set(id, setTimeout(async () => {
    refreshSessionTimers.delete(id);
    if (!tracked.has(id)) return;
    try {
      await refreshSession(id);
    } catch (error) {
      snapshots.set(id, { error: error.message, checkedAt: Date.now() });
    }
    renderBoard();
  }, 300));
}

/* Lightweight status check triggered by SSE heartbeats. OpenCode's SSE only
   sends heartbeats (no data events), so we use the ~10s heartbeat as a poll
   trigger. We query /session/status (cheap) and only do a full refreshSession
   for sessions whose status actually changed or are currently busy. */
async function checkStatuses() {
  if (!tracked.size) return;
  const dirs = new Set();
  for (const snap of snapshots.values()) {
    if (snap?.session?.directory) dirs.add(snap.session.directory);
  }
  if (!dirs.size) return;
  try {
    const statuses = await api(`/api/statuses?dirs=${encodeURIComponent([...dirs].join(","))}`);
    for (const [id] of tracked) {
      if (!snapshots.has(id)) continue;
      const snap = snapshots.get(id);
      const prev = snap.status || null;
      const next = statuses[id] || null;
      const statusChanged = JSON.stringify(prev) !== JSON.stringify(next);
      const isBusy = next && (next.type === "busy" || next.type === "retry");
      if (statusChanged || isBusy) {
        refreshSessionDebounced(id);
      }
    }
  } catch {
    // Silently ignore — heartbeat will retry
  }
}

/* ---------- element refs ---------- */
const $ = (sel) => document.querySelector(sel);

const els = {
  connDot: $("#connDot"),
  connMeta: $("#connMeta"),
  brand: $("#brand"),
  toggleImport: $("#toggleImport"),
  toggleRemote: $("#toggleRemote"),
  themeToggle: $("#themeToggle"),
  enableNotifications: $("#enableNotifications"),
  refreshAll: $("#refreshAll"),
  openSettings: $("#openSettings"),
  importDrawer: $("#importDrawer"),
  importForm: $("#importForm"),
  sessionId: $("#sessionId"),
  lane: $("#lane"),
  note: $("#note"),
  remoteDrawer: $("#remoteDrawer"),
  loadRemote: $("#loadRemote"),
  remoteSessions: $("#remoteSessions"),
  watchDirInput: $("#watchDirInput"),
  addWatchDir: $("#addWatchDir"),
  watchDirList: $("#watchDirList"),
  closeImport: $("#closeImport"),
  closeRemote: $("#closeRemote"),
  summary: $("#summary"),
  tabList: $("#tabList"),
  tabListResizer: $("#tabListResizer"),
  workspace: $("#workspace"),
  sidebarToggle: $("#sidebarToggle"),
  detailPanel: $("#detailPanel"),
  settingsOverlay: $("#settingsOverlay"),
  closeSettings: $("#closeSettings"),
  baseUrl: $("#baseUrl"),
  username: $("#username"),
  password: $("#password"),
  saveConfig: $("#saveConfig"),
  testConnection: $("#testConnection"),
};

/* ============================================================
   State persistence
   ============================================================ */
function loadState() {
  const fallback = {
    config: { baseUrl: DEFAULT_BASE_URL, username: "opencode", password: "" },
    tracked: [],
    theme: "dark",
    collapsedLanes: [],
    selectedSession: null,
    watchDirectories: [],
    tabListWidth: null,
    sidebarCollapsed: false,
    readState: {},
  };
  try {
    const loaded = { ...fallback, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
    if (!loaded.config) loaded.config = fallback.config;
    if (loaded.config.baseUrl === OLD_DEFAULT_BASE_URL) loaded.config.baseUrl = DEFAULT_BASE_URL;
    if (!Array.isArray(loaded.tracked)) loaded.tracked = [];
    if (!["dark", "light"].includes(loaded.theme)) loaded.theme = fallback.theme;
    if (!Array.isArray(loaded.collapsedLanes)) loaded.collapsedLanes = [];
    if (typeof loaded.selectedSession !== "string") loaded.selectedSession = null;
    if (!Array.isArray(loaded.watchDirectories)) loaded.watchDirectories = [];
  if (typeof loaded.tabListWidth !== "number") loaded.tabListWidth = null;
    if (typeof loaded.sidebarCollapsed !== "boolean") loaded.sidebarCollapsed = false;
    if (!loaded.readState || typeof loaded.readState !== "object") loaded.readState = {};
    return loaded;
  } catch {
    return fallback;
  }
}

function saveState() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      config: state.config,
      tracked: [...tracked.values()],
      theme: state.theme,
      collapsedLanes: [...collapsedLanes],
      selectedSession: state.selectedSession,
      watchDirectories: state.watchDirectories,
      tabListWidth: state.tabListWidth,
      sidebarCollapsed: state.sidebarCollapsed,
      readState: state.readState || {},
    })
  );
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  els.themeToggle.innerHTML =
    state.theme === "light"
      ? `<span class="btn-ico">☀</span>`
      : `<span class="btn-ico">☾</span>`;
  els.themeToggle.title = state.theme === "light" ? "切换到黑夜模式" : "切换到白天模式";
}

/* ---------- unread tracking ---------- */
function computeUnread(id) {
  const snap = snapshots.get(id);
  if (!snap?.messages?.length) return 0;
  const rs = state.readState[id];
  if (!rs?.lastReadMessageId) return 0;
  const messages = snap.messages;
  const idx = messages.findIndex((m) => m?.info?.id === rs.lastReadMessageId);
  if (idx === -1) return messages.length;
  return messages.length - 1 - idx;
}

function markSessionRead(id) {
  const snap = snapshots.get(id);
  const latestId = snap?.messages?.length
    ? snap.messages[snap.messages.length - 1]?.info?.id
    : null;
  if (!state.readState) state.readState = {};
  state.readState[id] = { lastReadMessageId: latestId };
}

function toggleTheme() {
  state.theme = state.theme === "light" ? "dark" : "light";
  applyTheme();
  saveState();
}

function syncConfigFromInputs() {
  state.config.baseUrl = els.baseUrl.value.trim().replace(/\/$/, "") || DEFAULT_BASE_URL;
  state.config.username = els.username.value.trim() || "opencode";
  state.config.password = els.password.value;
}

function initConfigInputs() {
  els.baseUrl.value = state.config.baseUrl;
  els.username.value = state.config.username;
  els.password.value = state.config.password;
}

/* ============================================================
   API
   ============================================================ */
function headers() {
  return {
    "x-opencode-base-url": state.config.baseUrl,
    "x-opencode-username": state.config.username,
    "x-opencode-password": state.config.password,
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...headers(),
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed: ${response.status}`);
  return body;
}

/* ============================================================
   Connection state + health
   ============================================================ */
function setConnectionState(next) {
  if (connectionState === next) return;
  connectionState = next;
  els.connDot.dataset.state = next;
  renderConnMeta();
}

function renderConnMeta() {
  if (connectionState === "connected") {
    els.connMeta.textContent = healthVersion ? `connected · ${healthVersion}` : "connected";
  } else if (connectionState === "disconnected") {
    els.connMeta.textContent = "disconnected · retrying";
  } else {
    els.connMeta.textContent = "connecting…";
  }
}

async function checkHealth() {
  try {
    const health = await api("/api/health");
    healthVersion = health.version ? `v${health.version}` : "connected";
    setConnectionState("connected");
    // If SSE was down, reconnect now that opencode is back.
    if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
      connectEvents();
    }
  } catch {
    setConnectionState("disconnected");
    healthVersion = "";
  }
}

function startHealthChecks() {
  if (healthTimer) clearInterval(healthTimer);
  checkHealth();
  healthTimer = setInterval(checkHealth, HEALTH_INTERVAL_MS);
}

/* ============================================================
   SSE with exponential backoff reconnect
   ============================================================ */
function connectEvents() {
  if (eventSource) {
    eventSource.onmessage = null;
    eventSource.onerror = null;
    eventSource.close();
    eventSource = null;
  }
  if (sseRetryTimer) {
    clearTimeout(sseRetryTimer);
    sseRetryTimer = null;
  }

  const params = new URLSearchParams({
    baseUrl: state.config.baseUrl,
    username: state.config.username,
    password: state.config.password,
  });

  try {
    eventSource = new EventSource(`/api/events?${params}`);
  } catch {
    scheduleSseReconnect();
    return;
  }

  eventSource.onopen = () => {
    sseRetryIndex = 0;
  };

  eventSource.onmessage = handleEventStreamMessage;
  for (const type of [
    "session.status",
    "session.updated",
    "message.updated",
    "message.part.updated",
    "message.part",
  ]) {
    eventSource.addEventListener(type, handleEventStreamMessage);
  }

  eventSource.onerror = () => {
    // EventSource auto-reconnects internally, but if the server is gone it
    // will keep firing onerror. We close and apply our own backoff so the
    // health check can drive reconnection when opencode comes back.
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    scheduleSseReconnect();
  };
}

function handleEventStreamMessage(event) {
  const payload = parseServerEvent(event.data);
  if (!payload) return;
  if (!payload.type && event.type && event.type !== "message") payload.type = event.type;

  // Heartbeats trigger a lightweight status check — OpenCode SSE doesn't
  // push data events, so we use the ~10s heartbeat as a poll trigger.
  if (payload.type === "server.heartbeat") {
    checkStatuses();
    return;
  }

  // session.status: fast path, update directly from payload
  if (handleServerEvent(event)) return;

  // server.connected: full refresh to catch up after (re)connect
  if (payload.type === "server.connected") {
    refreshFromEvent();
    return;
  }

  // Data events (session.updated, message.*): targeted refresh of just
  // the affected session, not all tracked sessions.
  const sessionID = eventSessionID(payload);
  if (sessionID && tracked.has(sessionID)) {
    refreshSessionDebounced(sessionID);
  }
}

function handleServerEvent(event) {
  const payload = parseServerEvent(event.data);
  if (!payload) return false;
  if (!payload.type && event.type && event.type !== "message") payload.type = event.type;

  if (payload.type !== "session.status") return false;

  const sessionID = eventSessionID(payload);
  if (!sessionID) return false;
  const status = payload.properties?.status || payload.data?.status || payload.status;
  if (!status) return false;

  if (status.type === "idle") liveStatuses.delete(sessionID);
  else liveStatuses.set(sessionID, { status, seenAt: Date.now() });

  if (tracked.has(sessionID)) {
    const snapshot = snapshots.get(sessionID) || { checkedAt: Date.now() };
    const previousRaw = snapshot.status;
    snapshot.status = status.type === "idle" ? null : status;
    snapshot.checkedAt = Date.now();
    observeStatusTransition(sessionID, previousRaw, snapshot.status, snapshot);
    snapshots.set(sessionID, snapshot);
    renderBoard();
  }
  return true;
}

function eventSessionID(payload) {
  return payload.properties?.sessionID || payload.properties?.sessionId || payload.data?.sessionID || payload.data?.sessionId || payload.sessionID || payload.sessionId;
}

function parseServerEvent(data) {
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function scheduleSseReconnect() {
  if (sseRetryTimer) return;
  const delay = SSE_BACKOFF[Math.min(sseRetryIndex, SSE_BACKOFF.length - 1)];
  sseRetryIndex += 1;
  sseRetryTimer = setTimeout(() => {
    sseRetryTimer = null;
    connectEvents();
  }, delay);
}

/* ============================================================
   Polling
   ============================================================ */
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshAll, POLL_INTERVAL_MS);
}

/* ============================================================
   Refresh logic
   ============================================================ */
async function refreshAll() {
  if (!tracked.size) {
    renderBoard();
    return;
  }
  await Promise.all(
    [...tracked.keys()].map((id) =>
      refreshSession(id).catch((error) => {
        snapshots.set(id, { error: error.message, checkedAt: Date.now() });
      })
    )
  );
  renderBoard();
}

async function refreshSession(id) {
  const previous = snapshots.get(id);
  const snapshot = await api(`/api/session/${encodeURIComponent(id)}`);
  snapshot.status = effectiveRawStatus(id, snapshot.status);
  snapshot.checkedAt = Date.now();
  if (previous?.lastBusyEnd) snapshot.lastBusyEnd = previous.lastBusyEnd;
  observeStatusTransition(id, previous?.status, snapshot.status, snapshot);
  snapshots.set(id, snapshot);
  // First fetch of a newly-tracked session counts as read (user just added it).
  if (!state.readState[id]) {
    markSessionRead(id);
    saveState();
  }
  // Auto-track the session's directory so future "拉取列表" covers its project.
  const dir = snapshot.session?.directory;
  if (dir) addWatchDirectory(dir);
}

/* ============================================================
   ★ Status classification
   opencode 1.17.x: /session/status is scoped per-directory.
   server.py now forwards x-opencode-directory, so the poll is
   authoritative. SSE session.status events supplement real-time.
   - status.type === "busy"    → working
   - status.type === "retry"   → retrying
   - absent                     → idle
   ============================================================ */
function classifyStatus(raw) {
  if (raw && raw.type === "busy") {
    return { kind: "working", label: "working", busy: true };
  }
  if (raw && raw.type === "retry") {
    const attempt = raw.attempt ? ` #${raw.attempt}` : "";
    return { kind: "retrying", label: `retrying${attempt}`, busy: true, retry: raw };
  }
  return { kind: "idle", label: "idle", busy: false };
}

function isBusyRawStatus(raw) {
  return raw && (raw.type === "busy" || raw.type === "retry");
}

function effectiveRawStatus(id, rawStatus) {
  if (isBusyRawStatus(rawStatus)) return rawStatus;
  // SSE live status only overrides the poll if it's newer than the
  // last successful poll — prevents stale busy entries from sticking
  // after a missed idle event.
  const live = liveStatuses.get(id);
  const lastPoll = snapshots.get(id)?.checkedAt || 0;
  if (live && isBusyRawStatus(live.status) && live.seenAt > lastPoll) {
    return live.status;
  }
  return rawStatus || null;
}

function observeStatusTransition(id, previousRaw, nextRaw, snapshot) {
  if (!tracked.has(id)) return;
  if (isBusyRawStatus(previousRaw) && !isBusyRawStatus(nextRaw)) {
    snapshot.lastBusyEnd = Date.now();
    notifyOk(snapshot);
  }
}

function mergeRemoteSnapshot(session, rawStatus) {
  const id = session.id || session.sessionID || session.sessionId;
  const previous = snapshots.get(id);
  const status = effectiveRawStatus(id, rawStatus);
  const next = {
    ...(previous || {}),
    session,
    status,
    checkedAt: Date.now(),
  };
  observeStatusTransition(id, previous?.status, status, next);
  snapshots.set(id, next);
}

function isChildSession(session) {
  return Boolean(session.parentID || session.parentId || session.parent);
}

/* ============================================================
   Remote sessions
   ============================================================ */
function addWatchDirectory(dir) {
  dir = (dir || "").trim();
  if (!dir) return false;
  if (!state.watchDirectories.includes(dir)) {
    state.watchDirectories.push(dir);
    saveState();
    renderWatchDirs();
    return true;
  }
  return false;
}

function removeWatchDirectory(dir) {
  state.watchDirectories = state.watchDirectories.filter((x) => x !== dir);
  saveState();
  renderWatchDirs();
}

function renderWatchDirs() {
  const dirs = state.watchDirectories || [];
  els.watchDirList.innerHTML = dirs
    .map(
      (d) => `
      <span class="watch-dir-item">
        <span class="watch-dir-path" title="${escapeHtml(d)}">${escapeHtml(d)}</span>
        <button class="watch-dir-remove" data-dir="${escapeHtml(d)}" title="移除">×</button>
      </span>`
    )
    .join("");
  for (const btn of els.watchDirList.querySelectorAll(".watch-dir-remove")) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeWatchDirectory(btn.dataset.dir);
    });
  }
}

async function loadRemoteSessions() {
  els.remoteSessions.innerHTML = `<p class="empty-hint">读取中…</p>`;
  try {
    // Fetch default (serve cwd project) + each watched directory in parallel,
    // then merge by session id. OpenCode scopes /session per projectID, so a
    // single unscoped request only returns the serve cwd's project sessions.
    const dirs = state.watchDirectories || [];
    const requests = [
      api("/api/sessions"),
      ...dirs.map((d) => api(`/api/sessions?directory=${encodeURIComponent(d)}`)),
    ];
    const results = await Promise.allSettled(requests);

    const sessionsMap = new Map();
    const statusMap = {};
    let failedCount = 0;
    for (const result of results) {
      if (result.status !== "fulfilled") { failedCount++; continue; }
      const { sessions, status } = result.value;
      for (const session of sessions || []) {
        const id = session.id || session.sessionID || session.sessionId;
        if (id && !sessionsMap.has(id)) sessionsMap.set(id, session);
      }
      if (status && typeof status === "object") {
        for (const [id, s] of Object.entries(status)) {
          if (!statusMap[id]) statusMap[id] = s;
        }
      }
    }

    const visibleSessions = [...sessionsMap.values()].filter(
      (session) => !isChildSession(session)
    );
    if (!visibleSessions.length) {
      const hint = failedCount
        ? `远端没有 session（${failedCount} 个目录拉取失败）。`
        : "远端没有 session。";
      els.remoteSessions.innerHTML = `<p class="empty-hint">${escapeHtml(hint)}</p>`;
      return;
    }

    renderRemoteList(visibleSessions, statusMap);
  } catch (error) {
    els.remoteSessions.innerHTML = `<p class="empty-hint">读取失败：${escapeHtml(error.message)}</p>`;
  }
}

function shortenDirPath(dir) {
  const parts = dir.replace(/\/+$/, "").split("/");
  const last = parts[parts.length - 1];
  const prev = parts[parts.length - 2];
  return prev ? `${prev}/${last}` : last || dir;
}

function renderRemoteList(visibleSessions, statusMap) {
  els.remoteSessions.innerHTML = "";
  const uniqueDirs = [...new Set(visibleSessions.map((s) => s.directory).filter(Boolean))];

  // Filter bar
  if (uniqueDirs.length) {
    const bar = document.createElement("div");
    bar.className = "remote-filter-bar";
    const allChip = document.createElement("button");
    allChip.type = "button";
    allChip.className = "remote-filter-chip" + (remoteFilterDir === null ? " active" : "");
    allChip.textContent = "全部";
    allChip.addEventListener("click", (e) => {
      e.stopPropagation();
      remoteFilterDir = null;
      renderRemoteList(visibleSessions, statusMap);
    });
    bar.append(allChip);
    for (const dir of uniqueDirs) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "remote-filter-chip" + (remoteFilterDir === dir ? " active" : "");
      chip.textContent = shortenDirPath(dir);
      chip.title = dir;
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        remoteFilterDir = dir;
        renderRemoteList(visibleSessions, statusMap);
      });
      bar.append(chip);
    }
    els.remoteSessions.append(bar);
  }

  const filtered = remoteFilterDir
    ? visibleSessions.filter((s) => s.directory === remoteFilterDir)
    : visibleSessions;

  if (!filtered.length) {
    const hint = document.createElement("p");
    hint.className = "empty-hint";
    hint.textContent = "该目录下没有 session。";
    els.remoteSessions.append(hint);
    return;
  }

  let touchedTracked = false;
  for (const session of filtered) {
    const id = session.id || session.sessionID || session.sessionId;
    const rawStatus = effectiveRawStatus(id, statusMap[id]);
    if (tracked.has(id)) {
      mergeRemoteSnapshot(session, rawStatus);
      touchedTracked = true;
    }
    const statusInfo = classifyStatus(rawStatus);
    const existing = tracked.get(id);
    const item = document.createElement("div");
    item.className = "remote-item";
    item.dataset.id = id;
    item.innerHTML = `
      <div>
        <div class="remote-title">${escapeHtml(session.title || "Untitled")}</div>
        <p class="remote-sub">
          <span>${escapeHtml(id)}</span>
          <span class="tag remote-status ${statusInfo.kind}">${escapeHtml(statusInfo.label)}</span>
          ${session.agent ? `<span class="tag">${escapeHtml(session.agent)}</span>` : ""}
          ${session.directory ? `<span class="tag">${escapeHtml(session.directory)}</span>` : ""}
        </p>
      </div>
      <div class="remote-fields">
        <label class="mini-field">
          <span>工作主线</span>
          <input class="remote-lane" value="${escapeHtml(existing?.lane || els.lane.value.trim() || "默认主线")}" autocomplete="off" />
        </label>
        <label class="mini-field">
          <span>备注</span>
          <input class="remote-note" value="${escapeHtml(existing?.note || "")}" autocomplete="off" />
        </label>
      </div>
      <button class="btn primary sm remote-add">${existing ? "更新" : "加入"}</button>
    `;
    item.querySelector(".remote-add").addEventListener("click", async () => {
      const laneInput = item.querySelector(".remote-lane");
      const noteInput = item.querySelector(".remote-note");
      tracked.set(id, {
        id,
        lane: laneInput.value.trim() || "默认主线",
        note: noteInput.value.trim(),
        importedAt: existing?.importedAt || Date.now(),
      });
      saveState();
      renderBoard();
      await refreshSession(id).catch(() => {});
      renderBoard();
      item.querySelector(".remote-add").textContent = "更新";
    });
    els.remoteSessions.append(item);
  }
  if (touchedTracked) renderBoard();
}

/* ============================================================
   Rendering
   ============================================================ */
function renderSignature() {
  const parts = [state.selectedSession || "", "\n"];
  parts.push([...collapsedLanes].sort().join(","), "\n");
  for (const [id, item] of tracked) {
    const snap = snapshots.get(id);
    parts.push(id, "\t", item.lane || "", "\t", item.note || "", "\t",
      item.importedAt);
    if (snap) {
      parts.push("\t", snap.session?.title || "",
        "\t", JSON.stringify(snap.status || null),
        "\t", snap.error || "",
        "\t", snap.lastBusyEnd || "",
        "\t", lastMessageText(snap.messages) || "",
        "\t", (snap.todos || []).map(t => `${t.status||t.state||""}:${t.content||t.title||""}`).join(","),
        "\t", String(computeUnread(id)));
    }
    parts.push("\n");
  }
  return parts.join("");
}

function renderBoard() {
  const sig = renderSignature();
  if (sig === lastRenderSig) return;
  lastRenderSig = sig;

  els.tabList.innerHTML = "";
  els.detailPanel.innerHTML = "";

  if (!tracked.size) {
    els.tabList.innerHTML = `<p class="tab-list-empty">暂无 session</p>`;
    els.detailPanel.innerHTML = `
      <div class="detail-empty">
        <h3>还没有跟踪任何 session</h3>
        <p>点击顶部「导入」输入 session ID，或点击「远端」从 opencode 拉取列表后一键加入。</p>
      </div>
    `;
    renderSummary(0, 0, 0, 0, 0);
    els.detailPanel.classList.add("board-ready");
    return;
  }

  // Sort: by last message time (most recent first).
  const items = [...tracked.values()].map((item) => {
    const snapshot = snapshots.get(item.id);
    const status = classifyStatus(snapshot?.status);
    const unread = computeUnread(item.id);
    return { item, snapshot, status, unread };
  }).sort((a, b) => {
    const ta = lastMessageTime(a.snapshot);
    const tb = lastMessageTime(b.snapshot);
    return tb - ta;
  });

  const counts = { working: 0, retrying: 0, idle: 0 };
  for (const entry of items) counts[entry.status.kind] += 1;

  // Auto-select: if none selected, or selected no longer tracked, pick the
  // first item (top of the sorted list — usually the busiest session).
  if (!state.selectedSession || !tracked.has(state.selectedSession)) {
    state.selectedSession = items[0].item.id;
    markSessionRead(items[0].item.id);
    saveState();
  }

  renderTabList(items);
  const selected = items.find((entry) => entry.item.id === state.selectedSession);
  if (selected) {
    els.detailPanel.append(renderDetail(selected.item, selected.snapshot, selected.status));
  } else {
    els.detailPanel.innerHTML = `
      <div class="detail-empty">
        <h3>选择左侧的 session 查看详情</h3>
        <p>点击左侧任意一个 tab 即可展开该 session 的完整信息。</p>
      </div>
    `;
  }

  renderSummary(tracked.size, counts.working, counts.retrying, counts.idle);
  syncRemoteStatusesFromSnapshots();
  els.detailPanel.classList.add("board-ready");
}

function renderTabList(items) {
  // Group by lane, preserving sort order within each group.
  const groups = new Map();
  for (const entry of items) {
    const lane = entry.item.lane || "默认主线";
    if (!groups.has(lane)) groups.set(lane, []);
    groups.get(lane).push(entry);
  }

  for (const [lane, entries] of groups) {
    const header = document.createElement("div");
    header.className = "lane-header";
    const collapsed = collapsedLanes.has(lane);
    if (collapsed) header.classList.add("collapsed");
    header.textContent = `${lane} (${entries.length})`;
    header.addEventListener("click", () => {
      if (collapsedLanes.has(lane)) collapsedLanes.delete(lane);
      else collapsedLanes.add(lane);
      saveState();
      renderBoard();
    });
    els.tabList.append(header);

    if (collapsed) continue;

    for (const { item, status, unread } of entries) {
      const snapshot = snapshots.get(item.id);
      const session = snapshot?.session || {};
      const title = session.title || item.id;
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "tab-item";
      tab.dataset.id = item.id;
      tab.setAttribute("aria-selected", String(item.id === state.selectedSession));
      const badgeText = unread > 99 ? "99+" : String(unread);
      const badgeHtml = unread > 0
        ? `<span class="tab-badge">${escapeHtml(badgeText)}</span>`
        : "";
      const timeStr = formatRelativeTime(lastMessageTime(snapshot));
      tab.innerHTML = `
        <span class="tab-dot ${status.kind}"></span>
        <span class="tab-title">${escapeHtml(title)}</span>
        ${badgeHtml}
        <span class="tab-remove" title="移除" role="button" aria-label="移除">×</span>
        <span class="tab-time">${escapeHtml(timeStr)}</span>
      `;
      tab.querySelector(".tab-remove").addEventListener("click", (event) => {
        event.stopPropagation();
        tracked.delete(item.id);
        snapshots.delete(item.id);
        if (state.readState) delete state.readState[item.id];
        if (state.selectedSession === item.id) state.selectedSession = null;
        saveState();
        renderBoard();
      });
      tab.addEventListener("click", () => {
        state.selectedSession = item.id;
        markSessionRead(item.id);
        saveState();
        renderBoard();
      });
      els.tabList.append(tab);
    }
  }
}

function renderDetail(item, snapshot, status) {
  const session = snapshot?.session || {};
  const title = session.title || item.id;
  const lane = item.lane || "默认主线";
  const card = document.createElement("article");
  card.className = "session-card";
  card.dataset.id = item.id;
  card.dataset.status = status.kind;

  const todos = snapshot?.todos || [];
  const todoHtml = todos.length
    ? todos
        .map((todo) => {
          const state = (todo.status || todo.state || "pending").toLowerCase();
          const label = todo.content || todo.title || JSON.stringify(todo);
          return `<div class="todo-item" data-state="${escapeHtml(state)}">
            <span class="todo-mark"></span>
            <span>${escapeHtml(label)}</span>
          </div>`;
        })
        .join("")
    : `<div class="todo-item" data-state="pending"><span class="todo-mark"></span><span style="color:var(--muted)">无 todo</span></div>`;

  const lastMsg = snapshot?.error
    ? `<p class="last-message error">${escapeHtml(snapshot.error)}</p>`
    : `<p class="last-message">${escapeHtml(lastMessageText(snapshot?.messages) || "暂无消息摘要")}</p>`;

  const updated = snapshot?.checkedAt
    ? `刷新 ${formatTime(snapshot.checkedAt)}`
    : "未刷新";

  card.innerHTML = `
    <div class="card-top">
      <span class="tag state-${status.kind}">${escapeHtml(status.label)}</span>
      <div class="card-title-wrap">
        <input class="title-input" value="${escapeHtml(title)}" />
        <p class="session-id">${escapeHtml(item.id)}</p>
      </div>
    </div>
    <div class="meta-row">
      <input class="lane-input" value="${escapeHtml(lane)}" title="编辑主线标签，Enter 保存" />
      <span class="updated">${escapeHtml(updated)}</span>
    </div>
    <p class="note">${escapeHtml(item.note || "")}</p>
    <div>
      <div class="detail-section-label">最近消息</div>
      ${lastMsg}
    </div>
    <div>
      <div class="detail-section-label">Todos · ${todos.length}</div>
      <div class="todo-list">${todoHtml}</div>
    </div>
    <div class="card-actions">
      <button class="btn ghost sm act-save">改名</button>
      <button class="btn ghost sm act-notify">提醒 OK</button>
    </div>
  `;

  card.querySelector(".act-save")?.addEventListener("click", async () => {
    const titleInput = card.querySelector(".title-input");
    if (!titleInput) return;
    try {
      await api(`/api/session/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ title: titleInput.value.trim() }),
      });
      await refreshSession(item.id);
      renderBoard();
    } catch (err) {
      alert(`改名失败：${err.message}`);
    }
  });

  const laneInput = card.querySelector(".lane-input");
  const saveLane = () => {
    const val = laneInput.value.trim() || "默认主线";
    const tracked_item = tracked.get(item.id);
    if (tracked_item && tracked_item.lane !== val) {
      tracked_item.lane = val;
      saveState();
      renderBoard();
    }
  };
  laneInput?.addEventListener("blur", saveLane);
  laneInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); laneInput.blur(); }
  });

  card.querySelector(".act-notify")?.addEventListener("click", () => {
    notifyOk(snapshot || { session: { id: item.id, title } }, true);
  });

  return card;
}

function syncRemoteStatusesFromSnapshots() {
  for (const node of els.remoteSessions.querySelectorAll(".remote-item")) {
    const id = node.dataset.id;
    const snapshot = snapshots.get(id);
    if (!snapshot) continue;
    const status = classifyStatus(snapshot.status);
    const tag = node.querySelector(".remote-status");
    if (!tag) continue;
    tag.classList.remove("working", "retrying", "idle");
    tag.classList.add(status.kind);
    tag.textContent = status.label;
  }
}

function renderSummary(total, working, retrying, idle) {
  els.summary.innerHTML = `
    <span class="chip tracked"><strong>${total}</strong> tracked</span>
    <span class="chip working"><span class="swatch working"></span><strong>${working}</strong> working</span>
    <span class="chip retrying"><span class="swatch retrying"></span><strong>${retrying}</strong> retrying</span>
    <span class="chip idle"><span class="swatch idle"></span><strong>${idle}</strong> idle</span>
  `;
}

/* ============================================================
   Message helpers
   ============================================================ */
function lastMessageText(messages = []) {
  for (const entry of [...messages].reverse()) {
    for (const part of [...(entry.parts || [])].reverse()) {
      const text = part.text || part.content || part.message || part.title;
      if (typeof text === "string" && text.trim()) return text.trim();
    }
  }
  return "";
}

function lastMessageTime(snapshot) {
  const msgs = snapshot?.messages;
  if (!msgs?.length) return 0;
  return msgs[msgs.length - 1]?.info?.time?.created || 0;
}

function formatRelativeTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const hms = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hms;
  return `${d.getMonth() + 1}/${d.getDate()} ${hms}`;
}

/* ============================================================
   Notifications
   ============================================================ */
function notifyOk(snapshot, manual = false) {
  const title = snapshot?.session?.title || snapshot?.session?.id || "OpenCode session";
  const message = manual ? `${title}：手动提醒` : `${title} 已结束 busy 状态。`;
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("OpenCode Session", { body: message });
  }
  if (snapshot?.session?.id) {
    api(`/api/session/${encodeURIComponent(snapshot.session.id)}/toast`, {
      method: "POST",
      body: JSON.stringify({ title: "Session OK", message, variant: "info" }),
    }).catch(() => {});
  }
}

async function enableNotifications() {
  if (!("Notification" in window)) {
    alert("当前浏览器不支持通知。");
    return;
  }
  const permission = await Notification.requestPermission();
  els.enableNotifications.textContent =
    permission === "granted" ? "通知已开启" : "通知未授权";
}

/* ============================================================
   Settings modal
   ============================================================ */
function openSettings() {
  initConfigInputs();
  els.settingsOverlay.hidden = false;
}
function closeSettings() {
  els.settingsOverlay.hidden = true;
}

async function testConnection() {
  els.testConnection.textContent = "测试中…";
  els.testConnection.disabled = true;
  try {
    syncConfigFromInputs();
    const health = await api("/api/health");
    healthVersion = health.version ? `v${health.version}` : "connected";
    setConnectionState("connected");
    els.testConnection.textContent = `OK · ${healthVersion}`;
  } catch (err) {
    setConnectionState("disconnected");
    els.testConnection.textContent = `失败：${err.message}`;
  } finally {
    els.testConnection.disabled = false;
    setTimeout(() => (els.testConnection.textContent = "测试连接"), 2500);
  }
}

function saveConfig() {
  syncConfigFromInputs();
  saveState();
  closeSettings();
  // Reset SSE backoff and reconnect with new credentials.
  sseRetryIndex = 0;
  if (sseRetryTimer) {
    clearTimeout(sseRetryTimer);
    sseRetryTimer = null;
  }
  connectEvents();
  startHealthChecks();
  refreshAll();
}

/* ============================================================
   Drawers — floating overlays, mutually exclusive
   ============================================================ */
function closeDrawer(drawer, btn) {
  drawer.hidden = true;
  btn.setAttribute("aria-expanded", "false");
}

function openDrawer(drawer, btn) {
  // Mutual exclusion: close the other drawer first.
  if (drawer === els.importDrawer && !els.remoteDrawer.hidden) {
    closeDrawer(els.remoteDrawer, els.toggleRemote);
  }
  if (drawer === els.remoteDrawer && !els.importDrawer.hidden) {
    closeDrawer(els.importDrawer, els.toggleImport);
  }
  drawer.hidden = false;
  btn.setAttribute("aria-expanded", "true");
}

function toggleDrawer(drawer, btn) {
  if (drawer.hidden) openDrawer(drawer, btn);
  else closeDrawer(drawer, btn);
}

/* ============================================================
   Utilities
   ============================================================ */
function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function formatTime(time) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(time);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char])
  );
}

/* ============================================================
   Wire up events
   ============================================================ */
els.brand.addEventListener("click", openSettings);
els.openSettings.addEventListener("click", openSettings);
els.themeToggle.addEventListener("click", toggleTheme);
els.closeSettings.addEventListener("click", closeSettings);
els.settingsOverlay.addEventListener("click", (e) => {
  if (e.target === els.settingsOverlay) closeSettings();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.settingsOverlay.hidden) closeSettings();
});

els.saveConfig.addEventListener("click", saveConfig);
els.testConnection.addEventListener("click", testConnection);

els.toggleImport.addEventListener("click", () =>
  toggleDrawer(els.importDrawer, els.toggleImport)
);
els.toggleRemote.addEventListener("click", () => {
  toggleDrawer(els.remoteDrawer, els.toggleRemote);
  if (!els.remoteDrawer.hidden && !els.remoteSessions.children.length) loadRemoteSessions();
});
els.closeImport.addEventListener("click", () =>
  closeDrawer(els.importDrawer, els.toggleImport)
);
els.closeRemote.addEventListener("click", () =>
  closeDrawer(els.remoteDrawer, els.toggleRemote)
);

// Click outside any open drawer to close it
document.addEventListener("click", (e) => {
  if (e.target.closest(".drawer")) return;
  if (e.target.closest(".topbar-actions")) return;
  if (!els.importDrawer.hidden) closeDrawer(els.importDrawer, els.toggleImport);
  if (!els.remoteDrawer.hidden) closeDrawer(els.remoteDrawer, els.toggleRemote);
});

els.loadRemote.addEventListener("click", loadRemoteSessions);
els.refreshAll.addEventListener("click", () => refreshAll());
els.enableNotifications.addEventListener("click", enableNotifications);

function handleAddWatchDir() {
  const dir = els.watchDirInput.value.trim();
  if (!dir) return;
  if (addWatchDirectory(dir)) {
    els.watchDirInput.value = "";
    hideWatchDirDropdown();
    loadRemoteSessions();
  }
}
els.addWatchDir.addEventListener("click", handleAddWatchDir);

/* ---------- Watch dir autocomplete ---------- */
function initWatchDirAutocomplete() {
  const input = els.watchDirInput;
  const row = input.closest(".watch-dirs-row");
  if (!row) return;
  row.style.position = "relative";

  watchDirDropdown = document.createElement("div");
  watchDirDropdown.className = "autocomplete-dropdown";
  watchDirDropdown.hidden = true;
  row.append(watchDirDropdown);

  let debounceTimer = null;
  let currentItems = []; // [{ path, label }]

  function parseInput(value) {
    // The server expands ~ via os.path.expanduser, so we pass ~ paths through.
    // Split into parentDir (up to and including last /) and prefix (after).
    const v = value === "~" ? "~/" : value;
    const lastSlash = v.lastIndexOf("/");
    if (lastSlash === -1) {
      // No slash yet: list home (empty path) and filter by the typed prefix.
      return { parentDir: "", prefix: v };
    }
    return {
      parentDir: v.slice(0, lastSlash + 1),
      prefix: v.slice(lastSlash + 1),
    };
  }

  async function refreshSuggestions() {
    const value = input.value;
    const { parentDir, prefix } = parseInput(value);
    try {
      const res = await api(`/api/listdir?path=${encodeURIComponent(parentDir)}`);
      const dirs = Array.isArray(res?.dirs) ? res.dirs : [];
      currentItems = dirs
        .map((full) => {
          if (typeof full !== "string") return null;
          const seg = full.split("/").filter(Boolean).pop() || full;
          return { path: full, label: seg };
        })
        .filter((entry) => entry && entry.label.startsWith(prefix));
      renderSuggestions();
    } catch {
      hideWatchDirDropdown();
    }
  }

  function renderSuggestions() {
    if (!currentItems.length) {
      hideWatchDirDropdown();
      return;
    }
    watchDirDropdown.innerHTML = "";
    for (let i = 0; i < currentItems.length; i++) {
      const entry = currentItems[i];
      const node = document.createElement("div");
      node.className = "autocomplete-item" + (i === 0 ? " active" : "");
      node.textContent = entry.label;
      node.title = entry.path;
      node.dataset.path = entry.path;
      node.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep input focus
        selectItem(entry);
      });
      watchDirDropdown.append(node);
    }
    watchDirDropdown.hidden = false;
  }

  function selectItem(entry) {
    input.value = entry.path + "/";
    input.focus();
    scheduleRefresh();
  }

  function getActiveIndex() {
    const nodes = watchDirDropdown.querySelectorAll(".autocomplete-item");
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].classList.contains("active")) return i;
    }
    return -1;
  }

  function setActiveIndex(idx) {
    const nodes = watchDirDropdown.querySelectorAll(".autocomplete-item");
    if (!nodes.length) return;
    nodes.forEach((n) => n.classList.remove("active"));
    if (idx < 0) idx = nodes.length - 1;
    if (idx >= nodes.length) idx = 0;
    nodes[idx].classList.add("active");
    nodes[idx].scrollIntoView({ block: "nearest" });
  }

  function scheduleRefresh() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refreshSuggestions, 150);
  }

  function hideWatchDirDropdown() {
    if (watchDirDropdown) watchDirDropdown.hidden = true;
  }

  input.addEventListener("input", scheduleRefresh);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      if (!watchDirDropdown.hidden) {
        e.preventDefault();
        const idx = getActiveIndex();
        if (idx >= 0 && currentItems[idx]) {
          selectItem(currentItems[idx]);
        }
      }
      return;
    }
    if (e.key === "ArrowDown") {
      if (!watchDirDropdown.hidden) {
        e.preventDefault();
        setActiveIndex(getActiveIndex() + 1);
      }
      return;
    }
    if (e.key === "ArrowUp") {
      if (!watchDirDropdown.hidden) {
        e.preventDefault();
        setActiveIndex(getActiveIndex() - 1);
      }
      return;
    }
    if (e.key === "Enter") {
      if (!watchDirDropdown.hidden) {
        const idx = getActiveIndex();
        if (idx >= 0 && currentItems[idx]) {
          e.preventDefault();
          selectItem(currentItems[idx]);
          return;
        }
      }
      e.preventDefault();
      hideWatchDirDropdown();
      handleAddWatchDir();
      return;
    }
    if (e.key === "Escape") {
      hideWatchDirDropdown();
      return;
    }
  });

  input.addEventListener("blur", () => {
    setTimeout(hideWatchDirDropdown, 150);
  });
}

els.importForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = els.sessionId.value.trim();
  if (!id) return;
  tracked.set(id, {
    id,
    lane: els.lane.value.trim() || "默认主线",
    note: els.note.value.trim(),
    importedAt: Date.now(),
  });
  els.sessionId.value = "";
  els.note.value = "";
  saveState();
  renderBoard();
  await refreshSession(id).catch(() => {});
  renderBoard();
});

/* ============================================================
   Tab list resizer
   ============================================================ */
function initTabListResizer() {
  const resizer = els.tabListResizer;
  if (!resizer) return;

  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  resizer.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    const cssVal = getComputedStyle(document.documentElement)
      .getPropertyValue("--tab-list-width")
      .trim();
    startWidth = parseInt(cssVal) || 300;
    resizer.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const newWidth = Math.max(180, Math.min(500, startWidth + dx));
    document.documentElement.style.setProperty("--tab-list-width", newWidth + "px");
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    const cssVal = getComputedStyle(document.documentElement)
      .getPropertyValue("--tab-list-width")
      .trim();
    state.tabListWidth = parseInt(cssVal) || 300;
    saveState();
  });
}

/* ============================================================
   Boot
   ============================================================ */
function applySidebarState() {
  els.workspace.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
  els.sidebarToggle.title = state.sidebarCollapsed ? "展开侧栏" : "收起侧栏";
}
els.sidebarToggle.addEventListener("click", () => {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  applySidebarState();
  saveState();
});

if (state.tabListWidth) {
  document.documentElement.style.setProperty("--tab-list-width", state.tabListWidth + "px");
}
initConfigInputs();
applyTheme();
renderWatchDirs();
initWatchDirAutocomplete();
initTabListResizer();
applySidebarState();
renderBoard();
startHealthChecks();
startPolling();
connectEvents();
refreshAll().catch(() => {});
