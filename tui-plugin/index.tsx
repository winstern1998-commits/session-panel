/** @jsxImportSource @opentui/solid */

import type { TuiPluginApi, TuiPluginMeta, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal } from "solid-js"

const PLUGIN_ID = "session-panel.track"
const PLUGIN_VERSION = "0.1.0"
const PANEL_URL = "http://127.0.0.1:7878"

function getActiveSessionID(api: TuiPluginApi): string | undefined {
  const route = api.route.current
  if (route.name !== "session") return undefined
  const sessionID = route.params?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

async function fetchTracked(): Promise<string[]> {
  try {
    const res = await fetch(`${PANEL_URL}/api/tracked`)
    const data = await res.json()
    return Array.isArray(data.tracked) ? data.tracked : []
  } catch {
    return []
  }
}

async function postTrack(sessionID: string): Promise<boolean> {
  try {
    const res = await fetch(`${PANEL_URL}/api/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sessionID }),
    })
    return res.ok
  } catch {
    return false
  }
}

async function deleteTrack(sessionID: string): Promise<boolean> {
  try {
    const res = await fetch(`${PANEL_URL}/api/track/${encodeURIComponent(sessionID)}`, {
      method: "DELETE",
    })
    return res.ok
  } catch {
    return false
  }
}

function TrackWidget(props: {
  api: TuiPluginApi
  sessionID: string
  tracked: boolean
  busy: boolean
  onToggle: () => void
}) {
  const theme = props.api.theme.current
  const label = props.busy
    ? "处理中…"
    : props.tracked
      ? "✓ 已监控"
      : "+ 加入监控"
  const bg = props.tracked ? theme.success : theme.accent

  return (
    <box width="100%" flexDirection="column" paddingTop={1} paddingBottom={1} paddingLeft={1} paddingRight={1}>
      <box width="100%" flexDirection="row" justifyContent="space-between" alignItems="center">
        <box backgroundColor={theme.accent} paddingLeft={1} paddingRight={1}>
          <text fg={theme.background}>Session Panel</text>
        </box>
        <text fg={theme.textMuted}>{`v${PLUGIN_VERSION}`}</text>
      </box>
      <box width="100%" flexDirection="row" justifyContent="center" marginTop={1}>
        <box
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={bg}
          onMouseUp={() => !props.busy && props.onToggle()}
        >
          <text fg={theme.background}>{label}</text>
        </box>
      </box>
    </box>
  )
}

async function tui(api: TuiPluginApi, _options?: Record<string, unknown>, _meta?: TuiPluginMeta) {
  const [tracked, setTracked] = createSignal(false)
  const [busy, setBusy] = createSignal(false)

  async function refreshStatus() {
    const sid = getActiveSessionID(api)
    if (!sid) return
    const ids = await fetchTracked()
    const isTracked = ids.includes(sid)
    if (isTracked !== tracked()) {
      setTracked(isTracked)
      api.renderer.requestRender()
    }
  }

  // Initial check + periodic poll
  refreshStatus()
  const timer = setInterval(refreshStatus, 3000)
  api.lifecycle.onDispose(() => clearInterval(timer))

  api.slots.register({
    order: 950,
    slots: {
      sidebar_content() {
        const sessionID = getActiveSessionID(api)
        if (!sessionID) return null
        return (
          <TrackWidget
            api={api}
            sessionID={sessionID}
            tracked={tracked()}
            busy={busy()}
            onToggle={async () => {
              const sid = getActiveSessionID(api)
              if (!sid) return
              setBusy(true)
              api.renderer.requestRender()
              if (tracked()) {
                const ok = await deleteTrack(sid)
                if (ok) {
                  setTracked(false)
                  api.ui.toast({ variant: "info", message: "已从监控面板移除", duration: 1500 })
                } else {
                  api.ui.toast({ variant: "error", message: "移除失败，面板未运行？" })
                }
              } else {
                const ok = await postTrack(sid)
                if (ok) {
                  setTracked(true)
                  api.ui.toast({ variant: "success", message: "已加入监控面板", duration: 1500 })
                } else {
                  api.ui.toast({ variant: "error", message: "加入失败，面板未运行？" })
                }
              }
              setBusy(false)
              api.renderer.requestRender()
            }}
          />
        )
      },
    },
  })
}

export default {
  id: PLUGIN_ID,
  tui,
} satisfies TuiPluginModule & { id: string }
