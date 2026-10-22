import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Secondary, SecondaryMode, Snapshot, Tab, VaultRow } from '../../types'

const PANE = 'vault-panel'
const TITLE = 'Vaults'
const REFRESH_MS = 120_000
// The startup read: tried every 3 s for 30 s while the router comes up.
const STARTUP_TRIES = 10
const STARTUP_RETRY_MS = 3_000
// list_vaults pings every vault (2 s budget for the view agent): 15 s is
// several times what a healthy read takes.
const READ_TIMEOUT_MS = 15_000
// The same opt-out values as the plugin's other hooks.
const TRUTHY = new Set(['true', '1', 'yes', 'on'])

// The router as /mcp lists it: shipped as a plugin, or declared by hand.
const SERVERS = ['plugin:obsidian-router:router', 'obsidian-router']
const ROUTER_TOOL =
  /^mcp__(plugin_obsidian-router_router|obsidian-router)__(confirm_workspace_binding|set_secondary_vault_mode|lock_vault|unlock_vaults)$/

const snapshot = atom({ plugin: 'obsidian-router', key: 'snapshot' } as const, null)
const busy = atom({ plugin: 'obsidian-router', key: 'busy' } as const, null)
const error = atom({ plugin: 'obsidian-router', key: 'error' } as const, null)
const failure = atom({ plugin: 'obsidian-router', key: 'failure' } as const, null)
const filter = atom({ plugin: 'obsidian-router', key: 'filter' } as const, '')
const tab = atom({ plugin: 'obsidian-router', key: 'tab' } as const, 'locaux')
// The two folded parts of the pane: the closed secondaries, and adding one.
const showClosed = atom({ plugin: 'obsidian-router', key: 'showClosed' } as const, false)
const showAdd = atom({ plugin: 'obsidian-router', key: 'showAdd' } as const, false)

// The status marks, all on one 12×12 box.
const MARK = {
  open: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="#2da44e"/></svg>',
  closed:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="#8c8c8c" stroke-width="1.5"/></svg>',
  unreachable:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><path d="M2 2L10 10M10 2L2 10" stroke="#d1242f" stroke-width="1.8" stroke-linecap="round"/></svg>',
}

const MODES: { mode: SecondaryMode; label: string }[] = [
  { mode: 'locked', label: 'Lecture seule' },
  { mode: 'soft', label: 'Écriture sur accord' },
  { mode: 'writable', label: 'Lecture/écriture' },
]
// The tier menu's width, in the surface's cells: the longest label plus room
// for the menu's own arrow and padding.
const MODE_WIDTH = Math.max(...MODES.map(m => m.label.length)) + 6

type Binding = {
  vault: string
  also: string[]
  locked: boolean
  confirmedVia?: string
  alsoLocked?: string[]
  alsoWritable?: string[]
}

type OnFile = { digest: string; vault: string | null; also: string[]; aliases?: number }

type ListVaults = {
  workspaceBinding: Binding | null
  vaults: { name: string; type?: string; online?: boolean; description?: string; baseUrl?: string; path?: string | null }[]
  disabled: { name: string; type?: string; awaitingDeclaration?: boolean }[]
  configPath?: string
  /** A session lock set by lock_vault: runtime only, not in the binding. */
  lockedTo?: string | null
  /** The router's own version, as it reports it. */
  routerBuild?: { version?: string } | null
  /** The binding entry as the config file holds it, read once (router v0.101.0+). */
  workspaceBindingOnFile?: OnFile | null
}

let server: string | null = null
// How many times this session asked the engine to connect the router.
let connectTries = 0
let ticker: Timer | null = null
let isPaneOpen = false
// The pane was closed (by the person or an unload) since this
// session started: the startup read must not open it any more.
let isStartupCancelled = false
// This session opted out: a pane an earlier start was opening is closed.
let isOptedOut = false
// This session's opt-out has been read: until then a drawn pane reads nothing.
let isEnvKnown = false
// Bumped by every open and close of the pane (see openPane).
let paneEpoch = 0
// Bumped by every session.start: work a previous start left running reads a
// stale number and drops its result.
let generation = 0
// Bumped by every refresh: a slower, older answer never overwrites a newer one.
let lastRefresh = 0
// The binding entry the router last reported, by a read or a write, with its
// digest: what the next click is computed from. null: read it afresh.
let lastOnFile: OnFile | null = null
// The router refuses a write that would collapse another spelling of this
// workspace (ifNoOtherSpellings, v0.102.2+): only then may a click start from
// an entry kept from an earlier read. An older router ignores the ask, so
// each click reads the entry afresh, right before its write.
let canKeepEntry = false

// `version` at least `[major, minor, patch]`; false when it cannot be read.
function atLeast(version: string | undefined, min: [number, number, number]) {
  const parts = (version ?? '').split('.').map(Number)
  if (parts.length < 3 || parts.some(n => !Number.isInteger(n))) {
    return false
  }
  for (let i = 0; i < 3; i += 1) {
    if (parts[i]! !== min[i]!) {
      return parts[i]! > min[i]!
    }
  }

  return true
}
// Reads of the router in flight, whoever started them.
let reading = 0

// Calls a router tool, finding which name the router is connected under.
async function call($: EngineInterface, tool: string, args: Record<string, unknown> = {}) {
  // The plugin's own router (`router` in its .mcp.json) is asked to connect
  // first: at session start it is often still connecting, and a call made
  // then fails. Connecting answers with the exact name to call it by.
  // Bounded per session: a refusal (a router declared by hand, no plugin
  // server) is not asked again at every call. A connect a previous session
  // left pending never names this one's server.
  if (!server && connectTries < STARTUP_TRIES) {
    connectTries += 1
    const asked = generation
    const linked = await $.mcp.connect('router').catch(() => null)
    if (linked?.isConnected && asked === generation) {
      server = linked.server
    }
  }
  const names = server ? [server] : SERVERS
  let lastError = 'router obsidian-mcp introuvable'
  for (const name of names) {
    try {
      const result = await $.mcp.call(name, tool, args)
      server = name
      const text = result.content.map(block => block.text ?? '').join('\n')
      if (result.isError) {
        throw new Error(text || `${tool} a échoué`)
      }

      return text
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      if (server) {
        break
      }
    }
  }
  throw new Error(lastError)
}

// A remote vault's Obsidian runs in a container with a web UI; the router's
// description names it, as a full URL or as a port on the vault's own host.
function uiUrlOf(baseUrl: string | undefined, description: string | undefined) {
  const full = description?.match(/UI\s+(https?:\/\/[^\s,)]+)/)
  if (full?.[1]) {
    // Parsed, not taken as written: only an http(s) address goes on.
    try {
      const url = new URL(full[1])

      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
    } catch {
      return null
    }
  }
  const port = description?.match(/UI\s*:(\d{2,5})/)?.[1]
  if (!port || !baseUrl) {
    return null
  }
  try {
    return `https://${new URL(baseUrl).hostname}:${port}/`
  } catch {
    return null
  }
}

// The app's own browser pane, as the session names it: the tool-name spelling
// first, then the /mcp one.
const BROWSERS = ['Claude_Browser', 'Claude Browser']
// The app's own panes beside the conversation, the browser's among them.
const VIEW = 'ccd_view'

// A note the vault holds: the first one at its root, else in wiki/. The view
// agent only brings a vault's window to the front on its way to a note.
async function someNote($: EngineInterface, vault: string) {
  for (const directory of ['', 'wiki']) {
    const listed = JSON.parse(await call($, 'list_files', { vault, directory })) as { files?: string[] }
    const note = listed.files?.find(f => f.toLowerCase().endsWith('.md'))
    if (note) {
      return directory ? `${directory}/${note}` : note
    }
  }

  return null
}

// Several remote vaults can share one streamed desktop: the address of their
// UI then shows whichever window is in front. The router's view agent, run
// beside them, brings this vault's window to the front first, through a link
// of its own. Where it cannot (no agent on this router, a vault it does not
// serve, no note), the UI's own address, as before.
async function uiTarget($: EngineInterface, row: VaultRow & { uiUrl: string }) {
  try {
    const note = await someNote($, row.name)
    if (note) {
      const link = JSON.parse(await call($, 'get_view_link', { vault: row.name, note })) as { url?: string }
      if (link.url && /^https?:\/\//.test(link.url)) {
        return link.url
      }
    }
  } catch {
    // The UI's own address below.
  }

  return row.uiUrl
}

// Hands an address to the default browser (Chrome): no shell parses it, so
// the `&` of its query is only text. A desktop Link would do it alone, but
// opens https addresses only, and the view agent's links are http.
async function openInBrowser($: EngineInterface, row: VaultRow) {
  if (!row.uiUrl) {
    return
  }
  const url = await uiTarget($, { ...row, uiUrl: row.uiUrl })
  const launchers = (await $.env.get('APPDATA'))
    ? [['rundll32', 'url.dll,FileProtocolHandler', url]]
    : [['open', url], ['xdg-open', url]]
  let lastError = 'aucun lanceur disponible'
  for (const argv of launchers) {
    try {
      const ran = await $.process.run(argv, { timeoutMs: 10_000 })
      if (ran.exitCode !== 0) {
        throw new Error(ran.stderr.trim() || `${argv[0]} a répondu ${ran.exitCode}`)
      }
      await update($, failure, () => null)

      return
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }
  await update($, failure, () => `Navigateur : ${lastError}. Le bouton 🪟 ouvre la même interface ici.`)
}

// Shows a remote vault's web UI in the app's own browser pane.
async function openUi($: EngineInterface, row: VaultRow) {
  if (!row.uiUrl) {
    return
  }
  const url = await uiTarget($, { ...row, uiUrl: row.uiUrl })
  let lastError = 'navigateur interne introuvable'
  for (const name of BROWSERS) {
    try {
      const result = await $.mcp.call(name, 'preview_start', { url })
      if (result.isError) {
        throw new Error(result.content.map(block => block.text ?? '').join(' '))
      }
      // The tab opens in the pane as it stands, often hidden: a click would
      // seem to do nothing. Brought into view after it; where the app cannot,
      // the tab is open all the same.
      await $.mcp.call(VIEW, 'show_pane', { pane: 'preview' }).catch(() => undefined)

      return
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }
  await update(
    $,
    failure,
    () => `Navigateur interne : ${lastError}. Le bouton 🌐 ouvre la même interface dans ton navigateur.`,
  )
}

// A local vault opens alone through Obsidian's own protocol, by the name
// Obsidian registered: its folder's name, casing kept.
// Obsidian's own id for the folder when its list gave one (`vault` takes a
// name or an id), the folder's name otherwise.
const obsidianUri = (row: VaultRow & { path: string }) => {
  const folder = row.path.split(/[\\/]/).filter(Boolean).pop() ?? row.path

  return `obsidian://open?vault=${encodeURIComponent(row.obsidianId ?? folder)}`
}

// Hands the obsidian:// address to the system, the way a click in a browser
// would: cmd's `start` on Windows (the address is percent-encoded, so cmd
// finds none of its own characters in it), `open` on a Mac, `xdg-open`
// elsewhere.
async function openInObsidian($: EngineInterface, row: VaultRow) {
  if (!row.path) {
    return
  }
  const uri = obsidianUri({ ...row, path: row.path })
  // `start` with its empty title argument, as the router launches a vault:
  // explorer.exe was handed the same address and opened nothing.
  const launchers = (await $.env.get('APPDATA')) ? [['cmd', '/c', 'start', '', uri]] : [['open', uri], ['xdg-open', uri]]
  let lastError = 'aucun lanceur disponible'
  for (const argv of launchers) {
    try {
      const ran = await $.process.run(argv, { timeoutMs: 10_000 })
      // A non-zero exit is a failure, and the next launcher is tried.
      if (ran.exitCode !== 0) {
        throw new Error(ran.stderr.trim() || `${argv[0]} a répondu ${ran.exitCode}`)
      }
      $.ui.toast(`Ouverture de ${row.name} dans Obsidian`)
      await update($, failure, () => null)

      return
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }
  await update($, failure, () => `Obsidian n'a pas pu être lancé pour ${row.name} : ${lastError}`)
}

function toSnapshot(data: ListVaults, fetchedAt: number): Snapshot {
  const byName = new Map(data.vaults.map(v => [v.name, v]))
  const row = (name: string): VaultRow => {
    const v = byName.get(name)
    return {
      name,
      online: v?.online ?? null,
      type: v?.type ?? null,
      description: v?.description ?? null,
      uiUrl: v?.type === 'remote' ? uiUrlOf(v.baseUrl, v.description) : null,
      path: v?.type === 'remote' ? null : (v?.path ?? null),
    }
  }
  const b = data.workspaceBinding
  const bound = new Set(b ? [b.vault, ...(b.also ?? [])] : [])
  const available = [
    ...data.vaults.filter(v => !bound.has(v.name)).map(v => row(v.name)),
    ...data.disabled
      .filter(d => d.awaitingDeclaration && !bound.has(d.name))
      .map(d => ({ name: d.name, online: null, type: d.type ?? null, description: null, uiUrl: null })),
  ].sort((x, y) => x.name.localeCompare(y.name, 'fr', { sensitivity: 'base' }))

  return {
    primary: b ? row(b.vault) : null,
    isLocked: b?.locked ?? false,
    lockedTo: data.lockedTo ?? null,
    isImported: b?.confirmedVia === 'migration',
    secondaries: (b?.also ?? []).map(name => ({
      ...row(name),
      mode: b?.alsoLocked?.includes(name) ? 'locked' : b?.alsoWritable?.includes(name) ? 'writable' : 'soft',
    })),
    available,
    fetchedAt,
  }
}

type RouterConfig = {
  vaultNames?: Record<string, string>
  vaultsById?: Record<string, { path?: string; ports?: { http?: number; https?: number } }>
}

// The router pings only the vaults this workspace reaches; a registered local
// vault outside them is probed here, on its Local REST API port: an answer
// means its Obsidian is open. Only paths and ports are taken from the config.
async function localPorts($: EngineInterface, configPath: string) {
  const ports = new Map<string, string>()
  try {
    const config = JSON.parse(await $.fs.read(configPath)) as RouterConfig
    for (const entry of Object.values(config.vaultsById ?? {})) {
      // A vault with no name of its own is named after its folder, lowercased.
      const name = entry.path
        ? (config.vaultNames?.[entry.path] ?? entry.path.split(/[\\/]/).filter(Boolean).pop())
        : undefined
      // A port is a number in range, or nothing: a string from a malformed
      // config could otherwise move the probe off 127.0.0.1.
      const isPort = (p: unknown): p is number => Number.isInteger(p) && (p as number) > 0 && (p as number) < 65536
      const http = entry.ports?.http
      const https = entry.ports?.https
      const url = isPort(http)
        ? `http://127.0.0.1:${http}/`
        : isPort(https)
          ? `https://127.0.0.1:${https}/`
          : null
      if (name && url) {
        ports.set(name.toLowerCase(), url)
      }
    }
  } catch {
    // No config to read: those vaults stay unknown.
  }

  return ports
}

async function probe($: EngineInterface, url: string) {
  const timeout = $.clock.sleep(2000).then(() => false)
  const answer = $.http.fetch(url).then(
    () => true,
    () => false,
  )

  return Promise.race([answer, timeout])
}

async function fillUnknown($: EngineInterface, snap: Snapshot, configPath: string | undefined) {
  const rows = [snap.primary, ...snap.secondaries, ...snap.available].filter(
    (r): r is VaultRow => r !== null && r.online === null,
  )
  if (rows.length === 0 || !configPath) {
    return
  }
  const ports = await localPorts($, configPath)
  await Promise.all(
    rows.map(async r => {
      const url = ports.get(r.name.toLowerCase())
      if (url) {
        r.online = await probe($, url)
        r.type = r.type ?? 'local'
      }
    }),
  )
}

// Where Obsidian keeps the list of the vaults it knows, on each platform.
// The places to look, in order: Windows, then a Mac, then Linux.
async function obsidianRegistries($: EngineInterface) {
  const appData = await $.env.get('APPDATA')
  if (appData) {
    return [`${appData}/obsidian/obsidian.json`]
  }
  const home = await $.env.get('HOME')
  if (!home) {
    return []
  }
  const xdg = await $.env.get('XDG_CONFIG_HOME')

  return [
    `${home}/Library/Application Support/obsidian/obsidian.json`,
    `${xdg || `${home}/.config`}/obsidian/obsidian.json`,
  ]
}

// A folder path as Obsidian's list and the router's config may both spell it.
const samePath = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()

// Marks every local row with its folder and whether Obsidian lists it: the 💎
// link (obsidian://open?vault=…) only opens a vault Obsidian already knows,
// and for one it does not, Obsidian pops "vault not found" up — the panel says
// to open it once by hand instead. Rows the router listed without a folder
// (a vault this workspace has not declared) get theirs from the router config.
async function markObsidianKnown($: EngineInterface, snap: Snapshot, configPath: string | undefined) {
  const rows = [snap.primary, ...snap.secondaries, ...snap.available].filter(
    (r): r is VaultRow => r !== null && r.type !== 'remote',
  )
  if (rows.length === 0) {
    return
  }
  if (configPath && rows.some(r => !r.path)) {
    try {
      const config = JSON.parse(await $.fs.read(configPath)) as RouterConfig
      const byName = new Map<string, string>()
      for (const entry of Object.values(config.vaultsById ?? {})) {
        const name = entry.path
          ? (config.vaultNames?.[entry.path] ?? entry.path.split(/[\\/]/).filter(Boolean).pop())
          : undefined
        if (name && entry.path) {
          byName.set(name.toLowerCase(), entry.path)
        }
      }
      for (const r of rows) {
        r.path = r.path ?? byName.get(r.name.toLowerCase()) ?? null
      }
    } catch {
      // No config to read: those rows keep no folder, and no 💎.
    }
  }
  // Folder → Obsidian's own id for it: the 💎 opens a vault by that id, so two
  // vaults whose folders share a name cannot be mistaken for each other.
  let known: Map<string, string> | null = null
  for (const registry of await obsidianRegistries($)) {
    try {
      const parsed = JSON.parse(await $.fs.read(registry)) as { vaults?: Record<string, { path?: string }> }
      known = new Map(
        Object.entries(parsed.vaults ?? {})
          .filter((pair): pair is [string, { path: string }] => typeof pair[1]?.path === 'string')
          .map(([id, v]) => [samePath(v.path), id]),
      )
      break
    } catch {
      // Not here: the next place, if any. Unreadable everywhere is not
      // evidence that a vault is unknown — the 💎 stays, opening by name.
    }
  }
  for (const r of rows) {
    const id = r.path && known ? known.get(samePath(r.path)) : undefined
    r.isKnownToObsidian = r.path && known ? id !== undefined : null
    r.obsidianId = id ?? null
  }
}

// The router's refusal of a stale precondition speaks of a repair diagnostic;
// for a click, what happened is simpler.
const STALE = /binding entry now differs/
const STALE_TEXT =
  "La liaison a été modifiée pendant l'envoi (par une autre session) : rien n'a été écrit, le panneau est rafraîchi."
// And its refusal when a hand edit stored this workspace twice (ifNoOtherSpellings).
const SPELLINGS = /several spellings/
const SPELLINGS_TEXT =
  "La config du router contient ce workspace sous plusieurs écritures (une édition à la main) : rien n'a été envoyé. Répare la liaison d'abord."
const plainly = (text: string) => (STALE.test(text) ? STALE_TEXT : SPELLINGS.test(text) ? SPELLINGS_TEXT : text)

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Reads the state back and draws it. Only the newest refresh writes, checked
// before EACH write: an older answer landing late never overwrites a newer one.
// A read that never answers (a router call made while the server was still
// connecting can stay pending) is given up after READ_TIMEOUT_MS: it then
// counts as a failure, so the startup tries go on and the pane is not left
// on "Lecture du router…" for good.
function withTimeout<T>($: EngineInterface, work: Promise<T>): Promise<T> {
  const late = $.clock.sleep(READ_TIMEOUT_MS).then(() => {
    throw new Error('le router ne répond pas (délai dépassé)')
  })

  return Promise.race([work, late])
}

async function refresh($: EngineInterface): Promise<boolean> {
  const id = ++lastRefresh
  reading += 1
  try {
    const data = JSON.parse(await withTimeout($, call($, 'list_vaults'))) as ListVaults
    const next = toSnapshot(data, await $.clock.now())
    await fillUnknown($, next, data.configPath)
    await markObsidianKnown($, next, data.configPath)
    if (id === lastRefresh) {
      if ('workspaceBindingOnFile' in data) {
        lastOnFile = data.workspaceBindingOnFile ?? null
        canKeepEntry = atLeast(data.routerBuild?.version, [0, 102, 2])
      }
      await update($, snapshot, () => next)
    }
    if (id === lastRefresh) {
      await update($, error, () => null)
    }

    return true
  } catch (err) {
    if (id === lastRefresh) {
      await update($, error, () => message(err))
    }

    return false
  } finally {
    reading -= 1
  }
}

// A refresh nobody awaits: what it could not write (a session that ended
// meanwhile) is dropped, never left as an unhandled rejection.
function background($: EngineInterface) {
  void refresh($).catch(() => undefined)
}

// The digest, and the ask that the router also refuse when a hand edit added
// another spelling of this workspace since the entry was read: the digest
// does not cover those, and the write would collapse them all.
type Precondition = { ifBindingDigest?: string; ifNoOtherSpellings?: true }

// What one action needs: the words for while it runs and for when it is done,
// the router tool, its arguments — built from the binding as last known, or
// read afresh (`fresh`) — and how the pane may show the result at once.
type Action = {
  doing: string
  done: string
  tool: string
  args: (fresh: boolean) => Promise<Record<string, unknown>> | Record<string, unknown>
  shows?: (snap: Snapshot) => Snapshot
}

// Runs one change against the router. The pane is locked only while the
// write is under way: it shows `doing`, then a toast says `done`, the change
// is drawn at once (`shows`), and the read-back runs behind — a second click
// does not wait for it. A refused change is kept in `failure`, which no
// refresh clears: only the next action does.
//
// A binding write is conditional (ifBindingDigest) and computed from the entry
// as last reported; when the router says it moved meanwhile, the action is
// rebuilt ONCE from a fresh read and sent again — the same intent, applied to
// the binding as it now stands.
async function act($: EngineInterface, action: Action) {
  if (await read($, busy)) {
    return
  }
  await update($, busy, () => action.doing)
  await update($, failure, () => null)
  try {
    let text: string
    let isRetried = false
    try {
      text = await call($, action.tool, await action.args(false))
    } catch (err) {
      if (!STALE.test(message(err))) {
        throw err
      }
      text = await call($, action.tool, await action.args(true))
      // Rebuilt from a fresh read: what it did is for the read-back to draw,
      // not for a guess made against the entry it was first computed from.
      isRetried = true
    }
    noteWrite(text)
    // A read started before this write must not undo it: not the entry just
    // noted, nor the change drawn below.
    lastRefresh += 1
    if (action.shows && !isRetried) {
      const shows = action.shows
      await update($, snapshot, snap => (snap ? shows(snap) : snap))
    }
    $.ui.toast(action.done)
  } catch (err) {
    lastOnFile = null
    await update($, failure, () => plainly(message(err)))
  }
  await update($, busy, () => null)
  background($)
}

// A binding write answers with the entry it left (router v0.102.2+): the next
// click starts from it without a list_vaults round trip. An older router says
// nothing, and the next click reads afresh.
function noteWrite(text: string) {
  try {
    const onFile = (JSON.parse(text) as { workspaceBindingOnFile?: OnFile | null }).workspaceBindingOnFile
    lastOnFile = onFile && typeof onFile.digest === 'string' ? onFile : null
  } catch {
    lastOnFile = null
  }
}

// The binding entry a click works from, with the digest that makes the write
// conditional on it: confirm_workspace_binding checks `ifBindingDigest` inside
// its write lock, so a click lands only on the entry it was computed from —
// never over a change another session made in between. The entry is the one
// the router last reported (a read or a write), unless `fresh` asks for a new
// read. Only a router older than the field — the field ABSENT — gets the old,
// unconditioned write computed from its live binding. A router that has the
// field but could not read its file (null) gets nothing: falling back there
// would silently drop the protection. Nor does a config holding this workspace
// under several spellings: the write would collapse them all, and the digest
// covers one.
async function bindingNow($: EngineInterface, fresh: boolean) {
  if (!fresh && lastOnFile && canKeepEntry) {
    return fromOnFile(lastOnFile)
  }
  const data = JSON.parse(await withTimeout($, call($, 'list_vaults'))) as ListVaults
  if ('workspaceBindingOnFile' in data) {
    lastOnFile = data.workspaceBindingOnFile ?? null
    if (!lastOnFile || typeof lastOnFile.digest !== 'string') {
      throw new Error("Le router n'a pas pu relire sa config : rien n'a été envoyé. Réessaie dans un instant.")
    }

    return fromOnFile(lastOnFile)
  }
  const live = data.workspaceBinding
  const precondition: Precondition = {}

  return { vault: live?.vault ?? null, also: live?.also ?? [], precondition }
}

function fromOnFile(onFile: OnFile) {
  if ((onFile.aliases ?? 0) > 0) {
    throw new Error(SPELLINGS_TEXT)
  }
  const precondition: Precondition = { ifBindingDigest: onFile.digest, ifNoOtherSpellings: true }

  return { vault: onFile.vault, also: onFile.also ?? [], precondition }
}

// Re-confirms the binding with a new list of secondaries, computed from the
// binding entry as the router last reported it, not from the snapshot on
// screen. The click names the primary it was drawn for: if the primary is no
// longer that one, nothing is sent. `locked` is left out on purpose: the
// router keeps the binding's own lock when the field is absent, so a click
// never unlocks (or locks) a workspace. Tiers of the secondaries that stay are
// kept by the router. And the router OPENS every bound vault that does not
// answer unless told `open: false` — so removing or adding one vault would
// launch Obsidian on all the closed ones (a closed vault Obsidian does not
// know by that name pops an error up). Only the open-all asks for that
// (`isOpening`).
async function rebind(
  $: EngineInterface,
  words: { doing: string; done: string },
  shown: string,
  change: (also: string[]) => string[],
  options: { isOpening?: boolean; shows?: (snap: Snapshot) => Snapshot } = {},
) {
  await act($, {
    ...words,
    tool: 'confirm_workspace_binding',
    shows: options.shows,
    args: async fresh => {
      const now = await bindingNow($, fresh)
      if (now.vault !== shown) {
        throw new Error(
          `La liaison a changé entre-temps (principal : ${now.vault ?? 'aucun'}) : rien n'a été envoyé, le panneau est rafraîchi.`,
        )
      }

      return { vault: now.vault, also: change(now.also), ...now.precondition, ...(options.isOpening ? {} : { open: false }) }
    },
  })
}

// Picks the primary of an unbound workspace, only if it is still unbound: the
// digest of the absent entry is a precondition like any other.
async function choosePrimary($: EngineInterface, name: string) {
  await act($, {
    doing: `Choix de ${name} comme principal`,
    done: `${name} principal`,
    tool: 'confirm_workspace_binding',
    args: async fresh => {
      const now = await bindingNow($, fresh)
      if (now.vault) {
        throw new Error(
          `Un principal a été choisi entre-temps (${now.vault}) : rien n'a été envoyé, le panneau est rafraîchi.`,
        )
      }

      return { vault: name, ...now.precondition }
    },
  })
}

// The pane is up: it polls, and the model's binding calls redraw it.
function adoptPane($: EngineInterface) {
  isPaneOpen = true
  if (!ticker) {
    ticker = $.clock.every(REFRESH_MS, () => background($))
  }
}

function stopTicker() {
  ticker?.cancel()
  ticker = null
}

// `start` is the session.start that asked for it, when one did: a later start
// (an opted-out one included) makes it a no-op, checked again once the pane is
// up, since a start can land while ui.open is pending. Every open and every
// close bumps `paneEpoch`: an open that finds it moved on (a close, or another
// open, landed meanwhile) leaves the pane to whoever moved it.
async function openPane($: EngineInterface, start?: number) {
  if (start !== undefined && start !== generation) {
    return
  }
  const mine = ++paneEpoch
  await $.ui.open({ id: PANE, title: TITLE })
  if (mine !== paneEpoch) {
    return
  }
  if (start !== undefined && (start !== generation || isStartupCancelled)) {
    // Opened for a start that no longer wants it: a later, opted-out start,
    // or a person's close that landed while ui.open was pending. A later
    // start that wants the pane opens it itself, so it is left alone.
    if (isOptedOut || isStartupCancelled) {
      await $.ui.close({ id: PANE }).catch(() => undefined)
    }

    return
  }
  adoptPane($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const start = ++generation
    stopTicker()
    isPaneOpen = false
    isStartupCancelled = false
    isEnvKnown = false
    // A read the previous session left running writes nothing into this one,
    // and the router is looked up afresh.
    lastRefresh += 1
    server = null
    connectTries = 0
    lastOnFile = null
    canKeepEntry = false
    // Shipped on by default with the plugin, so it carries an opt-out like
    // the plugin's other hooks: no command, no pane, no router call.
    const optOut = await $.env.get('OBSIDIAN_ROUTER_NO_VAULT_PANEL')
    isOptedOut = TRUTHY.has((optOut ?? '').trim().toLowerCase())
    isEnvKnown = true
    if (isOptedOut) {
      // A pane an earlier start opened while this one read its environment
      // is closed: the earlier start's own check ran before this answer.
      // Closing a pane that is not open does nothing.
      await $.ui.close({ id: PANE }).catch(() => undefined)

      return next(e)
    }
    await $.command.register({
      name: 'vaults',
      description: 'Afficher les vaults du router (principal, secondaires, disponibles)',
    })
    // Opens only where the router answers: the panel follows the MCP's install.
    // The router may still be starting, so the read is tried again for a
    // while before the panel gives up. A pane the person closed meanwhile
    // stays closed, and a later start ends these tries.
    void (async () => {
      for (let attempt = 0; attempt < STARTUP_TRIES; attempt += 1) {
        if (start !== generation || isStartupCancelled) {
          return
        }
        if (await refresh($)) {
          // `/vaults` may have opened it meanwhile: it is not opened twice.
          if (!isStartupCancelled && !isPaneOpen) {
            await openPane($, start)
          }

          return
        }
        await $.clock.sleep(STARTUP_RETRY_MS)
      }
    })().catch(() => undefined)

    return next(e)
  })

  // Closing the pane stops its polling and its redraws after tool calls.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    paneEpoch += 1
    stopTicker()
    isPaneOpen = false
    // The person's close, or an unload, also cancels the startup open; a
    // plugin's close (this module's own clean-up included) does not, so it
    // never poisons a later start that wants the pane.
    if (e.origin.kind !== 'plugin') {
      isStartupCancelled = true
    }

    return next(e)
  })

  on('command.run', { command: 'vaults' }, async $ => {
    isStartupCancelled = false
    await openPane($)
    await refresh($)
    const err = await read($, error)

    return {
      text: err ? `Panneau des vaults ouvert, mais le router ne répond pas : ${err}` : 'Panneau des vaults ouvert.',
    }
  })

  // The model may change the binding too: redraw after its router calls.
  // An observer, not a guard: no .catch, so a failure here fails open and the
  // tool's own result stands. Only while the pane is open: nobody reads the
  // snapshot otherwise.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (isPaneOpen && ROUTER_TOOL.test(e.tool)) {
      background($)
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // The phone draws no field and no menu (its table may still name them):
    // the list is drawn unfiltered there, and the tier as buttons.
    const isPhone = e.surface === 'mobile'
    const Input = !isPhone && 'Input' in els ? els.Input : null
    const snap = await read($, snapshot)
    const working = await read($, busy)
    const err = await read($, error)
    const failed = await read($, failure)
    // A pane the app drew on its own (restored from the last session's layout)
    // is this module's pane all the same: it gets the polling and the redraws
    // after the model's binding calls. And drawn with nothing to show and no
    // read under way, it starts the read itself; its answer (data or error) is
    // written, so this fires once, not at every redraw. Neither happens before
    // this session's opt-out is known, nor in an opted-out session.
    if (isEnvKnown && !isOptedOut) {
      adoptPane($)
      if (!snap && !err && reading === 0) {
        background($)
      }
    }
    // A tab kept from an earlier version of the panel reads as the first one.
    const current: Tab = (await read($, tab)) === 'distants' ? 'distants' : 'locaux'
    const typed = await read($, filter)
    // A surface with no field to type in (the phone) ignores the filter: one
    // typed elsewhere would otherwise hide rows it cannot bring back.
    const query = Input ? typed.trim().toLowerCase() : ''
    const isClosedShown = await read($, showClosed)
    const isAddShown = await read($, showAdd)
    const Select = !isPhone && 'Select' in els ? els.Select : null
    const Svg = 'Svg' in els ? els.Svg : null

    // A glyph per state, the colour on top: a closed local vault is no fault
    // (opening it is one click), an unreachable remote one is. A surface that
    // draws SVG gets the marks at one size; the terminal keeps the characters.
    // Drawn in a fixed-width cell, so the names line up whatever the glyph.
    const dot = (online: boolean | null, isRemote: boolean) => (
      <Box width={2} justifyContent="center" flexShrink={0}>
        {Svg && online !== null ? (
          <Svg
            source={online ? MARK.open : isRemote ? MARK.unreachable : MARK.closed}
            alt={online ? 'ouvert' : isRemote ? 'injoignable' : 'fermé'}
            width={10}
            height={10}
          />
        ) : online === null ? (
          <Text dimColor>?</Text>
        ) : online ? (
          <Text color="success">●</Text>
        ) : isRemote ? (
          <Text color="error">✕</Text>
        ) : (
          <Text dimColor>○</Text>
        )}
      </Box>
    )
    // A small grey label above a group: what it is, and how many.
    const label = (text: string) => (
      <Text size="caption" dimColor>
        {text}
      </Text>
    )
    const time = (ms: number) => {
      const d = new Date(ms)
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }

    const isRemote = (r: VaultRow) => r.type === 'remote'
    const bound = snap ? [snap.primary, ...snap.secondaries].filter((r): r is VaultRow => r !== null) : []
    const openCount = bound.filter(r => r.online === true).length
    const summary = snap
      ? `${bound.length} lié${bound.length > 1 ? 's' : ''} · ${openCount} ouvert${openCount > 1 ? 's' : ''} · màj ${time(snap.fetchedAt)}`
      : err
        ? 'router injoignable'
        : 'lecture du router…'

    const header = (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Box flexDirection="column">
          <Text weight="semibold">Vaults</Text>
          {working ? (
            <Text size="caption" color="warning">
              {working}…
            </Text>
          ) : (
            <Text size="caption" dimColor>
              {summary}
            </Text>
          )}
        </Box>
        <Button key="refresh" label="↻ Rafraîchir" plain dimColor onPress={() => background($)} />
      </Box>
    )

    const problems = (
      <Box flexDirection="column">
        {!!err && <Text color="error">{snap ? err : `Router injoignable : ${err}`}</Text>}
        {!!failed && failed !== err && <Text color="error">{failed}</Text>}
      </Box>
    )

    if (!snap) {
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          {problems}
        </Box>
      )
    }

    // The primary every binding button was drawn for: rebind refuses another.
    const shown = snap.primary?.name ?? ''
    const matches = (r: VaultRow) => !query || r.name.toLowerCase().includes(query)

    // Re-confirming the binding as it stands opens EVERY bound vault whose
    // Obsidian does not answer — the router's own way to open one. So it is
    // one button for all of them, not one per row that would open them all.
    const openAll = () =>
      void rebind($, { doing: 'Ouverture des vaults fermés', done: 'Vaults fermés ouverts' }, shown, current => current, {
        isOpening: true,
      })

    // A remote vault's web UI, two ways: 🌐 the default browser (Chrome), 🪟
    // the app's own browser pane. Buttons both: each asks the view agent for
    // its link at the click.
    const uiLink = (row: VaultRow) =>
      row.uiUrl ? (
        <Box flexDirection="row" gap={1} alignItems="center">
          <Button key={`web-${row.name}`} label="🌐" plain onPress={() => void openInBrowser($, row)} />
          <Button key={`ui-${row.name}`} label="🪟" plain onPress={() => void openUi($, row)} />
        </Box>
      ) : null

    // A local vault in Obsidian (💎): a closed one opens, an open one comes to
    // the front on that vault — the same address does both. One Obsidian does
    // not list yet cannot be opened that way — its protocol only finds vaults
    // it knows — so the row says what to do instead. A button, not a link: on
    // the desktop a link may only be https.
    const obsidianLink = (row: VaultRow) =>
      isRemote(row) || !row.path ? null : row.isKnownToObsidian === false ? (
        <Text size="caption" color="warning">
          à ouvrir une fois dans Obsidian
        </Text>
      ) : (
        <Button key={`obsidian-${row.name}`} label="💎" plain onPress={() => void openInObsidian($, row)} />
      )

    const name = (row: VaultRow, isStrong = false) => (
      <Box flexDirection="row" gap={1} flexShrink={1} alignItems="center">
        {dot(row.online, isRemote(row))}
        <Text weight={isStrong ? 'semibold' : 'regular'} dimColor={row.online === false} wrap="truncate-end">
          {row.name}
        </Text>
        <Text size="caption" dimColor>
          {isRemote(row) ? 'distant' : 'local'}
        </Text>
      </Box>
    )

    const primary = (
      <Box flexDirection="column" gap={1}>
        {label('Principal')}
        {snap.primary ? (
          <Box
            flexDirection="row"
            justifyContent="space-between"
            alignItems="center"
            borderStyle="round"
            borderDimColor
            paddingX={1}
          >
            {name(snap.primary, true)}
            <Box flexDirection="row" gap={1} alignItems="center">
              {snap.isLocked && (
                <Text size="caption" color="warning">
                  verrouillé
                </Text>
              )}
              {obsidianLink(snap.primary)}
              {uiLink(snap.primary)}
            </Box>
          </Box>
        ) : (
          <Text color="warning">Aucun vault principal : choisis-en un ci-dessous.</Text>
        )}
        {snap.primary?.online === false && isRemote(snap.primary) && (
          <Text size="caption" color="error">
            Injoignable : WireGuard actif ? conteneur démarré sur la dedibox ?
          </Text>
        )}
        {snap.isImported && snap.primary && (
          <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
            <Text size="caption" color="warning">
              Liaison importée d'un .env, jamais confirmée.
            </Text>
            <Button
              key="confirm-binding"
              label="Confirmer"
              plain
              onPress={() =>
                void rebind($, { doing: 'Confirmation de la liaison', done: 'Liaison confirmée' }, shown, current => current)
              }
            />
          </Box>
        )}
        {snap.isLocked && (
          <Text size="caption" color="warning">
            Session verrouillée sur le principal : les secondaires ne répondent pas.
          </Text>
        )}
        {snap.lockedTo && (
          <Text size="caption" color="warning">
            Router verrouillé sur {snap.lockedTo} pour cette session (lock_vault) : les autres vaults ne répondent pas.
          </Text>
        )}
      </Box>
    )

    // One secondary, one line: where it stands, its write tier as one menu,
    // and the two links it may need. Nothing heavier.
    const setMode = (s: Secondary, value: string) => {
      const next = MODES.find(m => m.mode === value)
      if (next && next.mode !== s.mode) {
        void act($, {
          doing: `${s.name} : passage en ${next.label.toLowerCase()}`,
          done: `${s.name} : ${next.label.toLowerCase()}`,
          tool: 'set_secondary_vault_mode',
          args: () => ({ vault: s.name, mode: next.mode }),
          shows: snap => ({
            ...snap,
            secondaries: snap.secondaries.map(r => (r.name === s.name ? { ...r, mode: next.mode } : r)),
          }),
        })
      }
    }
    const secondaryRow = (s: Secondary) => (
      <Box key={`sec-${s.name}`} flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
        {name(s)}
        <Box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
          {s.online === false && isRemote(s) && (
            <Text size="caption" color="error">
              injoignable
            </Text>
          )}
          {obsidianLink(s)}
          {uiLink(s)}
          {Select ? (
            // One width for every menu, whatever tier it shows: sized on the
            // longest label, so the column lines up from row to row.
            <Box width={MODE_WIDTH} minWidth={MODE_WIDTH} flexShrink={0}>
              <Select
                key={`mode-${s.name}`}
                options={MODES.map(m => ({ value: m.mode, label: m.label }))}
                value={s.mode}
                onSelect={(value: string) => setMode(s, value)}
              />
            </Box>
          ) : (
            // A surface with no menu (the phone) keeps the three choices, as
            // quiet buttons, the current one lit.
            <Box flexDirection="row" gap={1}>
              {MODES.map(m => (
                <Button
                  key={`mode-${s.name}-${m.mode}`}
                  label={m.label}
                  plain
                  dimColor={s.mode !== m.mode}
                  onPress={() => setMode(s, m.mode)}
                />
              ))}
            </Box>
          )}
          <Button
            key={`remove-${s.name}`}
            label="✕"
            plain
            dimColor
            onPress={() =>
              void rebind(
                $,
                { doing: `Retrait de ${s.name}`, done: `${s.name} retiré` },
                shown,
                current => current.filter(n => n !== s.name),
                { shows: snap => ({ ...snap, secondaries: snap.secondaries.filter(r => r.name !== s.name) }) },
              )
            }
          />
        </Box>
      </Box>
    )

    const shownSecondaries = snap.secondaries.filter(matches)
    const up = shownSecondaries.filter(s => s.online !== false)
    const closed = shownSecondaries.filter(s => s.online === false)
    // What the open-all opens: every bound LOCAL vault that does not answer,
    // the primary included and whatever the filter shows — so it is counted
    // over all of them, not over the rows on screen.
    const closedLocal = bound.filter(r => r.online === false && !isRemote(r)).length
    const openN = up.filter(s => s.online === true).length
    const unknownN = up.length - openN

    const secondaries = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Box flexDirection="column">
            {label(`Secondaires · ${snap.secondaries.length}`)}
            <Text size="caption" dimColor>
              💎 ouvrir dans Obsidian · 🌐 dans ton navigateur · 🪟 dans le navigateur interne
            </Text>
          </Box>
          {Input && (
            <Input
              key="filter"
              placeholder="Filtrer"
              value={typed}
              submitLabel="filtrer"
              onInput={(value: string) => void update($, filter, () => value)}
              onSubmit={(value: string) => void update($, filter, () => value)}
            />
          )}
        </Box>
        {snap.secondaries.length === 0 && (
          <Text size="caption" dimColor>
            Aucun secondaire : ajoute-en un ci-dessous.
          </Text>
        )}
        {snap.secondaries.length > 0 && shownSecondaries.length === 0 && (
          <Text size="caption" dimColor>
            Aucun secondaire ne correspond au filtre.
          </Text>
        )}
        {up.length > 0 && (
          <Box flexDirection="column">
            {(closed.length > 0 || unknownN > 0) &&
              label(unknownN > 0 ? `Ouverts · ${openN} · état inconnu · ${unknownN}` : `Ouverts · ${openN}`)}
            {up.map(secondaryRow)}
          </Box>
        )}
        {closed.length > 0 && (
          <Box flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between" alignItems="center">
              <Button
                key="toggle-closed"
                label={`${isClosedShown ? '▾' : '▸'} Fermés · ${closed.length}`}
                plain
                dimColor
                onPress={() => void update($, showClosed, shownNow => !shownNow)}
              />
              {closedLocal > 0 && (
                <Button
                  key="open-closed"
                  label={closedLocal > 1 ? `Ouvrir les ${closedLocal} vaults locaux fermés` : 'Ouvrir le vault local fermé'}
                  plain
                  onPress={openAll}
                />
              )}
            </Box>
            {isClosedShown && closed.map(secondaryRow)}
          </Box>
        )}
      </Box>
    )

    // Adding: folded away until asked for — unless there is no primary yet,
    // which is the one thing the pane cannot do without.
    const remotes = snap.available.filter(isRemote)
    const locals = snap.available.filter(v => !isRemote(v))
    const isTunnelDown =
      [...bound, ...remotes].some(isRemote) && [...bound, ...remotes].filter(isRemote).every(r => r.online === false)
    const isAddOpen = isAddShown || !snap.primary
    const list = (current === 'locaux' ? locals : remotes).filter(matches)
    const tabs: { id: Tab; label: string }[] = [
      { id: 'locaux', label: `Locaux · ${locals.length}` },
      { id: 'distants', label: `Distants · ${remotes.length}` },
    ]
    const adding = (
      <Box flexDirection="column" gap={1}>
        <Button
          key="toggle-add"
          label={`${isAddOpen ? '▾' : '▸'} ${snap.primary ? 'Ajouter un vault' : 'Choisir le vault principal'} · ${snap.available.length} disponible${snap.available.length > 1 ? 's' : ''}`}
          plain
          dimColor={!isAddOpen}
          onPress={() => void update($, showAdd, shownNow => !shownNow)}
        />
        {isAddOpen && (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="row" gap={2}>
              {tabs.map(t => (
                <Button
                  key={`tab-${t.id}`}
                  label={t.label}
                  plain
                  dimColor={current !== t.id}
                  onPress={() => void update($, tab, () => t.id)}
                />
              ))}
            </Box>
            {list.length === 0 && (
              <Text size="caption" dimColor>
                Aucun vault ne correspond.
              </Text>
            )}
            <Box flexDirection="column">
              {list.map(v => (
                <Box key={`av-${v.name}`} flexDirection="row" justifyContent="space-between" alignItems="center">
                  <Box flexDirection="row" gap={1} flexShrink={1} alignItems="center">
                    {dot(v.online, isRemote(v))}
                    <Text wrap="truncate-end">{v.name}</Text>
                  </Box>
                  <Box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
                    {uiLink(v)}
                    {snap.primary ? (
                      <Button
                        key={`add-${v.name}`}
                        label="Ajouter"
                        plain
                        onPress={() =>
                          void rebind(
                            $,
                            { doing: `Ajout de ${v.name}`, done: `${v.name} ajouté (écriture sur accord)` },
                            shown,
                            current => (current.includes(v.name) ? current : [...current, v.name]),
                            {
                              shows: snap => ({
                                ...snap,
                                // Already a secondary (another session added it, the retry
                                // kept it): the row on screen, tier and all, stays as is.
                                secondaries: snap.secondaries.some(r => r.name === v.name)
                                  ? snap.secondaries
                                  : [...snap.secondaries, { ...v, mode: 'soft' }],
                                available: snap.available.filter(r => r.name !== v.name),
                              }),
                            },
                          )
                        }
                      />
                    ) : (
                      <Button
                        key={`primary-${v.name}`}
                        label="Principal"
                        plain
                        onPress={() => void choosePrimary($, v.name)}
                      />
                    )}
                  </Box>
                </Box>
              ))}
            </Box>
          </Box>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {problems}
        {isTunnelDown && (
          // Every remote vault silent at once: the tunnel, not the vaults. The
          // panel cannot ask WireGuard itself, hence "semble".
          <Box key="tunnel-down" flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
            <Text color="warning" weight="semibold">
              WireGuard semble inactif : les vaults distants ne sont pas disponibles.
            </Text>
            <Text size="caption" dimColor>
              Active le tunnel, puis ↻ Rafraîchir.
            </Text>
          </Box>
        )}
        {primary}
        {secondaries}
        {adding}
      </Box>
    )
  })
}
