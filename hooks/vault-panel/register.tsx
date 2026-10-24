import { atom, read, update } from 'claude-code'
import type { EngineInterface, McpToolResult, Register, Timer } from 'claude-code'

import type { AdminForm, CreateForm, Secondary, SecondaryMode, Snapshot, Tab, VaultRow, WireguardState } from '../../types'
import { FR } from './locale-fr'

const PANE = 'vault-panel'
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
// The add list's tab: a key of its own since the redesign, so that a tab kept
// by an older panel ("locaux") does not hold "all" back.
const tab = atom({ plugin: 'obsidian-router', key: 'addTab' } as const, 'tous' as Tab)
// The two folded parts of the pane: the closed secondaries, and adding one.
const showClosed = atom({ plugin: 'obsidian-router', key: 'showClosed' } as const, false)
const showAdd = atom({ plugin: 'obsidian-router', key: 'showAdd' } as const, false)
// The "add a vault" grid's search and its order (A → Z, or Z → A).
const addQuery = atom({ plugin: 'obsidian-router', key: 'addQuery' } as const, '')
const addSort = atom({ plugin: 'obsidian-router', key: 'addSort' } as const, 'az' as 'az' | 'za')
// Bumped at every open and close of the pane: the band reads it so that it is
// drawn again; what the toggle says comes from isPanePlaced.
const paneVersion = atom({ plugin: 'obsidian-router', key: 'paneVersion' } as const, 0)
// The language the texts are drawn in: written on a change, so every drawing
// that reads it is drawn again in the new language.
const language = atom({ plugin: 'obsidian-router', key: 'language' } as const, 'fr')
// The administration console: folded by default; its form; the vault whose
// removal waits for a second press; WireGuard as last detected.
const showAdmin = atom({ plugin: 'obsidian-router', key: 'showAdmin' } as const, false)
// The pane's menu folded into "☰" on a narrow pane: whether its list is open.
const navOpen = atom({ plugin: 'obsidian-router', key: 'navOpen' } as const, false)
// Whether Claude in Chrome answers this session (see `checkChrome`).
const chromeState = atom({ plugin: 'obsidian-router', key: 'chrome' } as const, 'unknown')
const EMPTY_FORM: AdminForm = { kind: 'local', name: '', host: '127.0.0.1', port: '', uiPort: '', apiKey: '', scheme: 'https' }
const adminForm = atom({ plugin: 'obsidian-router', key: 'adminForm' } as const, EMPTY_FORM)
const confirmRemove = atom({ plugin: 'obsidian-router', key: 'confirmRemove' } as const, null)
const removePick = atom({ plugin: 'obsidian-router', key: 'removePick' } as const, null)
const updateState = atom({ plugin: 'obsidian-router', key: 'update' } as const, null)
const EMPTY_CREATE: CreateForm = { name: '', path: '', mode: 'personal', conventions: [], languages: '', bind: true }
const createForm = atom({ plugin: 'obsidian-router', key: 'createForm' } as const, EMPTY_CREATE)
const bandListOpen = atom({ plugin: 'obsidian-router', key: 'bandListOpen' } as const, false)
const pendingConventions = atom({ plugin: 'obsidian-router', key: 'pendingConventions' } as const, null)
const wireguard = atom({ plugin: 'obsidian-router', key: 'wireguard' } as const, null)

// ---- Texts ----------------------------------------------------------------
// Every text the pane and the band show comes from locales/<code>.json in the
// plugin's folder (one file per language: copy fr.json, translate the values,
// keep the keys and the {variables}). French is also compiled in (FR): what is
// drawn before the files are read, and where a key a file lacks falls back.
let strings: Record<string, string> = FR

function t(key: string, vars: Record<string, string | number> = {}) {
  const text = strings[key] ?? FR[key] ?? key

  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))
}
// The one/other forms of a counted text (`<key>.one`, `<key>.other`).
const tn = (key: string, count: number, vars: Record<string, string | number> = {}) =>
  t(`${key}.${count > 1 ? 'other' : 'one'}`, { count, ...vars })

// The plugin's folder; null where the engine gives none (the test kit).
function pluginRoot($: EngineInterface): string | null {
  try {
    return $.plugin.root || null
  } catch {
    return null
  }
}

// One language file, or null where it cannot be read or is not an object of
// strings (a hand-edited file with a typo falls back to French, key by key).
async function readLocale($: EngineInterface, code: string): Promise<Record<string, string> | null> {
  const root = pluginRoot($)
  if (!root || !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(code)) {
    return null
  }
  try {
    const parsed = JSON.parse(await $.fs.read(`${root}/locales/${code}.json`)) as unknown
    if (!parsed || typeof parsed !== 'object') {
      return null
    }

    return Object.fromEntries(Object.entries(parsed).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
  } catch {
    return null
  }
}

async function loadLanguage($: EngineInterface, code: string) {
  const fr = (await readLocale($, 'fr')) ?? {}
  const chosen = code === 'fr' ? {} : ((await readLocale($, code)) ?? {})
  strings = { ...FR, ...fr, ...chosen }
}

// The languages the plugin ships or the person added: every locales/*.json,
// named by its own `_meta.name`.
async function availableLanguages($: EngineInterface) {
  const root = pluginRoot($)
  const found: { code: string; name: string }[] = []
  try {
    const entries = root ? await $.fs.list(`${root}/locales`) : []
    for (const entry of entries) {
      const code = entry.kind === 'file' && entry.name.endsWith('.json') ? entry.name.slice(0, -5) : null
      const file = code ? await readLocale($, code) : null
      if (code && file) {
        found.push({ code, name: file['_meta.name'] ?? code })
      }
    }
  } catch {
    // The two shipped ones below.
  }

  // French is compiled in: always offered, even with its file unread.
  if (!found.some(l => l.code === 'fr')) {
    found.push({ code: 'fr', name: FR['_meta.name'] ?? 'Français' })
  }
  if (found.length === 1) {
    found.push({ code: 'en', name: 'English' })
  }

  return found.sort((a, b) => a.name.localeCompare(b.name))
}

// The language a session starts in: the one chosen in the console (kept in
// the plugin's store), else OBSIDIAN_ROUTER_LANG, else French.
async function startLanguage($: EngineInterface) {
  const stored = await $.store.get('language').catch(() => undefined)
  const fromEnv = await $.env.get('OBSIDIAN_ROUTER_LANG')
  const code = typeof stored === 'string' && stored ? stored : (fromEnv ?? '').trim().toLowerCase() || 'fr'
  await loadLanguage($, code)
  await update($, language, () => code)
}

async function setLanguage($: EngineInterface, code: string) {
  await $.store.set('language', code).catch(() => undefined)
  await loadLanguage($, code)
  await update($, language, () => code)
  $.ui.toast(t('admin.languageSaved', { language: strings['_meta.name'] ?? code }))
}

// The status marks, all on one 12×12 box.
const MARK = {
  open: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="#2da44e"/></svg>',
  closed:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="#8c8c8c" stroke-width="1.5"/></svg>',
  unreachable:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><path d="M2 2L10 10M10 2L2 10" stroke="#d1242f" stroke-width="1.8" stroke-linecap="round"/></svg>',
}

// Each tier's badge: the pane's menu and the band above the prompt show the
// same one, so the band reads without a legend of its own.
const MODES: { mode: SecondaryMode; icon: string }[] = [
  { mode: 'locked', icon: '🔒' },
  { mode: 'soft', icon: '✋' },
  { mode: 'writable', icon: '✏️' },
]
const iconOf = (mode: SecondaryMode) => MODES.find(m => m.mode === mode)?.icon ?? '🔒'
const modeLabel = (mode: SecondaryMode) => t(`mode.${mode}`)

// What the band shows of the secondaries in `columns` cells: as many as fit
// after the primary and the toggle, in binding order, the rest counted as
// "… +N". The line as the band draws it, cell by cell: "Principal :", a gap,
// the primary, a gap, a one-cell spacer, a gap, "Secondaires :", then per
// secondary a gap, "|" and a gap after the first, its name, a gap and its badge
// (an emoji, two cells); "… +N" after a gap; the toggle after a gap of two,
// with room for its chrome. In the current language's words. Measured in
// cells: the band also cuts any text that still runs over, so a misjudged
// width costs a cut, never a second line.
// A character's cells on a terminal line: two for the East Asian wide ranges
// (CJK, Hangul, full-width forms) and the emoji planes, none for a joiner, a
// variation selector or a combining mark, one otherwise.
const charCells = (code: number) =>
  code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0x0300 && code <= 0x036f)
    ? 0
    : (code >= 0x1100 && code <= 0x115f) ||
        (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe30 && code <= 0xfe4f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x23e9 && code <= 0x23fa) ||
        (code >= 0x1f300 && code <= 0x1faff) ||
        (code >= 0x20000 && code <= 0x3fffd)
      ? 2
      : 1
const cells = (text: string) => [...text].reduce((sum, char) => sum + charCells(char.codePointAt(0) ?? 0), 0)
// The band's chip: the secondaries the line could not show ("… +3"), of which
// so many paused ("⏸ 1"); a press unfolds them upward.
function chipText(hidden: number, paused: number) {
  return [hidden > 0 ? `… +${hidden}` : '', paused > 0 ? `⏸ ${paused}` : ''].filter(Boolean).join(' ')
}
// The secondaries on the band's line, in the binding's order, each as its
// name, its badge and its ▶; `paused[i]` says which are paused (counted in the
// chip, the ▶ the same width either way).
// `marks[i]` (and `primaryMark`): the cells that name's marks take beside it.
// `isChip`: each vault drawn in its own frame (a graphical surface), its frame
// and padding four cells, in place of the "│ " between secondaries.
function bandFit(
  primary: string | null,
  secondaries: string[],
  columns: number,
  paused: boolean[] = [],
  marks: number[] = [],
  primaryMark = 0,
  isChip = false,
) {
  const toggle = 2 + Math.max(cells(t('band.show')), cells(t('band.hide'))) + 4
  const base =
    cells(t('band.primary')) +
    1 +
    primaryMark +
    (isChip && primary ? 4 : 0) +
    cells(primary ?? t('band.none')) +
    1 +
    1 +
    1 +
    cells(t('band.secondaries')) +
    toggle
  // A gap, its frame (or "│ " after the first), the marks and the name, a gap
  // and its badge, a gap and its control (▶, dimmed while paused).
  const widths = secondaries.map((name, i) => 1 + (isChip ? 4 : i > 0 ? 2 : 0) + (marks[i] ?? 0) + cells(name) + 1 + 2 + 1 + 1)
  // The most secondaries that fit with the chip their remainder needs.
  for (let shown = secondaries.length; shown > 0; shown -= 1) {
    const chip = chipText(secondaries.length - shown, paused.slice(shown).filter(Boolean).length)
    // The chip's room: "… +N ▾", the same width open ("… +N ▴").
    const room = chip ? 1 + cells(chip) + 2 : 0
    const used = base + widths.slice(0, shown).reduce((a, b) => a + b, 0) + room
    if (used <= columns) {
      return { shown, hidden: secondaries.length - shown }
    }
  }

  return { shown: 0, hidden: secondaries.length }
}

type Binding = {
  vault: string
  also: string[]
  locked: boolean
  confirmedVia?: string
  alsoLocked?: string[]
  alsoWritable?: string[]
  /** The secondaries this project paused (router v0.107.0+): bound, unreachable. */
  alsoPaused?: string[]
}

// A `remoteVaults` entry on the loopback is a vault of this machine's own
// Obsidian, registered by its REST address: shown as local.
function isLoopbackUrl(url: string | undefined) {
  try {
    const host = new URL(url ?? '').hostname

    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
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
// The pane is on screen, not only asked for: a pane opened unasked in a narrow
// terminal waits undrawn (`isPlaced: false`). What the band's toggle says.
let isPanePlaced = false
// This session turned the band above the prompt off (OBSIDIAN_ROUTER_NO_VAULT_BAND).
let isBandOptedOut = false
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

// The engine's words when Claude Code's permissions refuse a call the panel
// makes on its own: `$.mcp.call(<server>, <tool>) refused: <reason>` (in auto
// mode the classifier has no request of the model's to judge the call against,
// so it gives no verdict). The router was never reached, and asking again in
// 3 s gets the same answer. Only this form: the engine's other error,
// `$.mcp.call: no connected MCP tool …`, is a server not (yet) connected, which
// the next server name or the next startup try may well reach.
const REFUSED = /\$\.mcp\.call\([^()]*\) refused: (.*)$/s
const WRITE_TOOLS = ['confirm_workspace_binding', 'set_secondary_vault_mode', 'register_remote_vault', 'unregister_vault']

class Refused extends Error {
  constructor(server: string, tool: string, reason: string) {
    const rule = (t: string) => `mcp__${server.replace(/:/g, '_')}__${t}`
    const by = /auto mode/i.test(reason) ? t('refused.byAuto') : t('refused.byPermissions')
    const writes = t('refused.writesWarning', { rules: WRITE_TOOLS.map(rule).join(', ') })
    super(
      WRITE_TOOLS.includes(tool)
        ? t('refused.write', { by, tool, writes })
        : t('refused.read', {
            by,
            tool,
            writes,
            list: rule('list_vaults'),
            links: `${rule('list_files')}, ${rule('get_view_link')}`,
          }),
    )
  }
}

// Every refusal's text starts with the lead: how the pane tells it from a
// router that does not answer.
const isRefusal = (text: string | null) => !!text && text.startsWith(t('refused.lead'))

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
  let lastError = t('error.routerMissing')
  for (const name of names) {
    try {
      const result = await $.mcp.call(name, tool, args)
      server = name
      const text = result.content.map(block => block.text ?? '').join('\n')
      if (result.isError) {
        throw new Error(text || t('error.toolFailed', { tool }))
      }

      return text
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      const refused = REFUSED.exec(lastError)
      if (refused) {
        throw new Refused(name, tool, refused[1]!)
      }
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
  let lastError = t('error.noLauncher')
  for (const argv of launchers) {
    try {
      const ran = await $.process.run(argv, { timeoutMs: 10_000 })
      if (ran.exitCode !== 0) {
        throw new Error(ran.stderr.trim() || t('error.launcherExit', { program: argv[0] ?? '', code: ran.exitCode }))
      }
      await update($, failure, () => null)

      return
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }
  await update($, failure, () => t('error.browser', { error: lastError }))
}

// Claude in Chrome, the extension that drives the user's own Chrome (debug
// mode): the planet opens a remote vault's web UI there, and is drawn only
// while it answers this session.
const CHROME = 'claude-in-chrome'

// Asks Claude in Chrome for its tab group. A refusal saying the server or its
// extension is absent, disconnected or off — or a throw — means it is not
// there; any other answer, "no group yet" included, means it is. One call at
// a time, shared; each asker waits CHROME_TIMEOUT_MS at most, after which the
// state stays as it was (the call, still running, is not started again).
const CHROME_TIMEOUT_MS = 3000
let chromeCall: Promise<McpToolResult | null> | null = null
async function checkChrome($: EngineInterface): Promise<void> {
  chromeCall ??= $.mcp
    .call(CHROME, 'tabs_context_mcp', {})
    .catch(() => null)
    .finally(() => {
      chromeCall = null
    })
  const result = await Promise.race([chromeCall, $.clock.sleep(CHROME_TIMEOUT_MS).then(() => undefined)])
  if (result === undefined) {
    return
  }
  const text = result ? result.content.map(block => block.text ?? '').join(' ') : ''
  const isOff =
    !result ||
    (result.isError &&
      /disconnect|not connected|not (?:found|available|installed)|unknown server|no (?:such )?server|disabled|turned off/i.test(text))
  await update($, chromeState, () => (isOff ? 'off' : 'on'))
}

// The tab a Claude in Chrome answer names: "Tab ID: 123", or a "tabId": 123
// key; nothing else is taken for one (a window's number is no tab's).
function tabIdOf(text: string): number | null {
  const id = /\bTab ID:\s*(\d+)/i.exec(text)?.[1] ?? /"tabId"\s*:\s*(\d+)/.exec(text)?.[1]

  return id ? Number(id) : null
}

// Opens a remote vault's web UI in Chrome through Claude in Chrome: in the
// empty tab of a group it has just made, else in a new tab of its own; never
// in a tab it did not name. One open at a time: two quick presses would
// otherwise both take the same empty tab.
let chromeOpening: Promise<void> = Promise.resolve()
function openInChrome($: EngineInterface, row: VaultRow): Promise<void> {
  chromeOpening = chromeOpening.then(() => openInChromeNow($, row)).catch(() => undefined)

  return chromeOpening
}
async function openInChromeNow($: EngineInterface, row: VaultRow) {
  if (!row.uiUrl) {
    return
  }
  const url = await uiTarget($, { ...row, uiUrl: row.uiUrl })
  const said = (result: McpToolResult) => result.content.map(block => block.text ?? '').join(' ')
  try {
    const context = await $.mcp.call(CHROME, 'tabs_context_mcp', { createIfEmpty: true })
    if (context.isError) {
      throw new Error(said(context))
    }
    let tabs: { tabId?: number; url?: string }[] = []
    try {
      tabs = (JSON.parse(said(context).split('\n')[0] ?? '') as { availableTabs?: { tabId?: number; url?: string }[] }).availableTabs ?? []
    } catch {
      tabs = []
    }
    const fresh = tabs.length === 1 && /^chrome:\/\/newtab\/?$/.test(tabs[0]?.url ?? '') ? (tabs[0]?.tabId ?? null) : null
    let tabId = fresh
    if (tabId === null) {
      const created = await $.mcp.call(CHROME, 'tabs_create_mcp', {})
      if (created.isError) {
        throw new Error(said(created))
      }
      tabId = tabIdOf(said(created))
    }
    if (tabId === null) {
      throw new Error(t('error.chromeNoTab'))
    }
    const result = await $.mcp.call(CHROME, 'navigate', { url, tabId })
    if (result.isError) {
      throw new Error(said(result))
    }
    await update($, failure, () => null)
  } catch (err) {
    await update($, failure, () => t('error.chrome', { error: err instanceof Error ? err.message : String(err) }))
  }
}

// Shows a remote vault's web UI in the app's own browser pane.
async function openUi($: EngineInterface, row: VaultRow) {
  if (!row.uiUrl) {
    return
  }
  const url = await uiTarget($, { ...row, uiUrl: row.uiUrl })
  let lastError = t('error.innerBrowserMissing')
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
    () => t('error.innerBrowser', { error: lastError }),
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
  let lastError = t('error.noLauncher')
  for (const argv of launchers) {
    try {
      const ran = await $.process.run(argv, { timeoutMs: 10_000 })
      // A non-zero exit is a failure, and the next launcher is tried.
      if (ran.exitCode !== 0) {
        throw new Error(ran.stderr.trim() || t('error.launcherExit', { program: argv[0] ?? '', code: ran.exitCode }))
      }
      $.ui.toast(t('toast.openingObsidian', { name: row.name }))
      await update($, failure, () => null)

      return
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }
  await update($, failure, () => t('error.obsidian', { name: row.name, error: lastError }))
}

function toSnapshot(data: ListVaults, fetchedAt: number): Snapshot {
  const byName = new Map(data.vaults.map(v => [v.name, v]))
  const row = (name: string): VaultRow => {
    const v = byName.get(name)
    const isLoopback = v?.type === 'remote' && isLoopbackUrl(v.baseUrl)
    return {
      name,
      online: v?.online ?? null,
      type: isLoopback ? 'local' : (v?.type ?? null),
      description: v?.description ?? null,
      uiUrl: v?.type === 'remote' && !isLoopback ? uiUrlOf(v.baseUrl, v.description) : null,
      path: v?.type === 'remote' ? null : (v?.path ?? null),
    }
  }
  const b = data.workspaceBinding
  const bound = new Set(b ? [b.vault, ...(b.also ?? [])] : [])
  // A paused secondary stays in the binding; the router keeps it out of reach.
  const pausedNames = new Set((b?.alsoPaused ?? []).filter(n => n !== b?.vault && (b?.also ?? []).includes(n)))
  const modeOf = (name: string): SecondaryMode =>
    b?.alsoLocked?.includes(name) ? 'locked' : b?.alsoWritable?.includes(name) ? 'writable' : 'soft'
  const disabledRow = (name: string) => {
    const d = data.disabled.find(x => x.name === name)

    return d ? { name, online: null, type: d.type ?? null, description: null, uiUrl: null } : null
  }
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
    secondaries: (b?.also ?? []).filter(name => !pausedNames.has(name)).map(name => ({ ...row(name), mode: modeOf(name) })),
    available,
    paused: [...pausedNames].map(name => ({
      ...(byName.has(name) ? row(name) : (disabledRow(name) ?? row(name))),
      mode: modeOf(name),
    })),
    routerVersion: data.routerBuild?.version ?? null,
    order: (b?.also ?? []).filter(name => name !== b?.vault),
    fetchedAt,
  }
}

type RouterConfig = {
  remoteVaults?: { name?: string; baseUrl?: string; description?: string }[]
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

// A paused vault is out of the router's list (it is not pinged), so its row
// comes with no address: a remote one's web UI is read from the router
// config, as for any vault this workspace does not reach; a local one gets its
// folder in markObsidianKnown.
async function keepPausedOpeners($: EngineInterface, snap: Snapshot, configPath: string | undefined) {
  const rows = (snap.paused ?? []).filter(r => !r.uiUrl && r.type !== 'local')
  if (rows.length === 0 || !configPath) {
    return
  }
  try {
    const config = JSON.parse(await $.fs.read(configPath)) as RouterConfig
    for (const r of rows) {
      const entry = (config.remoteVaults ?? []).find(v => v.name === r.name)
      if (!entry?.baseUrl) {
        continue
      }
      if (isLoopbackUrl(entry.baseUrl)) {
        r.type = 'local'
      } else {
        r.type = 'remote'
        r.uiUrl = uiUrlOf(entry.baseUrl, entry.description)
      }
    }
  } catch {
    // No config to read: the row opens nothing, and says so when pressed.
  }
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
  const rows = [snap.primary, ...snap.secondaries, ...snap.available, ...(snap.paused ?? [])].filter(
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
// And its refusal when a hand edit stored this workspace twice (ifNoOtherSpellings).
const SPELLINGS = /several spellings/
const plainly = (text: string) => (STALE.test(text) ? t('error.stale') : SPELLINGS.test(text) ? t('error.spellings') : text)

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Reads the state back and draws it. Only the newest refresh writes, checked
// before EACH write: an older answer landing late never overwrites a newer one.
// A read that never answers (a router call made while the server was still
// connecting can stay pending) is given up after READ_TIMEOUT_MS: it then
// counts as a failure, so the startup tries go on and the pane is not left
// on "Lecture du router…" for good.
function withTimeout<T>($: EngineInterface, work: Promise<T>): Promise<T> {
  const late = $.clock.sleep(READ_TIMEOUT_MS).then(() => {
    throw new Error(t('error.timeout'))
  })

  return Promise.race([work, late])
}

async function refresh($: EngineInterface): Promise<boolean> {
  const id = ++lastRefresh
  reading += 1
  // Claude in Chrome asked beside the router, and its answer awaited with the
  // read's, so a drawing from this read knows whether to draw the planet.
  // Bounded by its own timeout: a Chrome that never answers holds nothing up.
  const chrome = checkChrome($).catch(() => undefined)
  try {
    const data = JSON.parse(await withTimeout($, call($, 'list_vaults'))) as ListVaults
    await chrome
    const next = toSnapshot(data, await $.clock.now())
    next.defaultRoot = data.configPath ? await defaultVaultRoot($, data.configPath) : null
    await keepPausedOpeners($, next, data.configPath)
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
  /** The router's answer, read before anything is drawn or said. */
  answer?: (text: string) => void
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
// What happened: `busy` (another action held the pane, nothing was sent),
// `done`, or `failed` (the reason is in `failure`).
async function act($: EngineInterface, action: Action): Promise<'busy' | 'done' | 'failed'> {
  if (await read($, busy)) {
    return 'busy'
  }
  let outcome: 'done' | 'failed' = 'done'
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
    action.answer?.(text)
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
    outcome = 'failed'
    await update($, failure, () => plainly(message(err)))
  }
  await update($, busy, () => null)
  background($)

  return outcome
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
      throw new Error(t('error.configUnread'))
    }

    return fromOnFile(lastOnFile)
  }
  const live = data.workspaceBinding
  const precondition: Precondition = {}

  return { vault: live?.vault ?? null, also: live?.also ?? [], precondition }
}

function fromOnFile(onFile: OnFile) {
  if ((onFile.aliases ?? 0) > 0) {
    throw new Error(t('error.spellings'))
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
  return act($, {
    ...words,
    tool: 'confirm_workspace_binding',
    shows: options.shows,
    args: async fresh => {
      const now = await bindingNow($, fresh)
      if (now.vault !== shown) {
        throw new Error(
          t('error.primaryChanged', { primary: now.vault ?? t('band.none') }),
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
    doing: t('action.choosePrimary.doing', { name }),
    done: t('action.choosePrimary.done', { name }),
    tool: 'confirm_workspace_binding',
    args: async fresh => {
      const now = await bindingNow($, fresh)
      if (now.vault) {
        throw new Error(
          t('error.primaryChosen', { primary: now.vault }),
        )
      }

      return { vault: name, ...now.precondition }
    },
  })
}

// The pane is up: it polls, and the model's binding calls redraw it.
// Called while the pane is drawn too: so it writes no state (refused while a
// ui.render hook draws). A pane drawing is a pane on screen.
function adoptPane($: EngineInterface) {
  isPaneOpen = true
  if (!isPanePlaced) {
    isPanePlaced = true
    // A pane the app drew on its own (restored) went through no openPane: the
    // band learns of it from a timer, which runs after this drawing.
    $.clock.after(0, () => void update($, paneVersion, v => v + 1).catch(() => undefined))
  }
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
  const opened = await $.ui.open({ id: PANE, title: t('pane.title') })
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
  // Asked for but waiting undrawn (a narrow terminal): the band offers to
  // show it; drawing it later adopts it as placed.
  isPanePlaced = opened.isPlaced !== false
  await update($, paneVersion, v => v + 1)
}

// ---- WireGuard ----------------------------------------------------------------
// Where the remote vaults live, they are reached through a WireGuard tunnel.
// Windows: the client's own path and its tunnel services (WireGuardTunnel$<name>,
// running while the tunnel is on); a Mac or Linux: the `wg` tool's list of the
// interfaces it runs (which may need root: then the state stays unknown).
const WG_EXE = 'C:\\Program Files\\WireGuard\\wireguard.exe'
const WG_SERVICES =
  "Get-Service -Name 'WireGuardTunnel$*' -ErrorAction SilentlyContinue | Where-Object Status -eq 'Running' | ForEach-Object { $_.Name.Substring(16) }"
const WG_INSTALL_URL = 'https://www.wireguard.com/install/'
const DOCS = 'https://github.com/tboome33/obsidian-mcp-router/blob/main/docs/deploy/remote-vault'
const GUIDE_URL = `${DOCS}/README.md`
const PROMPT_URL = `${DOCS}/PROMPT.md`

async function detectWireguard($: EngineInterface): Promise<WireguardState> {
  if (await $.env.get('APPDATA')) {
    const isInstalled = await $.fs.stat(WG_EXE).then(
      () => true,
      () => false,
    )
    if (!isInstalled) {
      return { state: 'absent', tunnels: [] }
    }
    try {
      const ran = await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', WG_SERVICES], {
        timeoutMs: 10_000,
      })
      if (ran.exitCode !== 0) {
        // PowerShell answered with an error: the tunnels were not read.
        return { state: 'unknown', tunnels: [] }
      }
      const tunnels = ran.stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)

      return tunnels.length > 0 ? { state: 'active', tunnels } : { state: 'inactive', tunnels: [] }
    } catch {
      // No answer at all: not "off" — unknown.
      return { state: 'unknown', tunnels: [] }
    }
  }
  try {
    const ran = await $.process.run(['wg', 'show', 'interfaces'], { timeoutMs: 5_000 })
    if (ran.exitCode !== 0) {
      return { state: 'unknown', tunnels: [] }
    }
    const tunnels = ran.stdout.trim().split(/\s+/).filter(Boolean)

    return tunnels.length > 0 ? { state: 'active', tunnels } : { state: 'inactive', tunnels: [] }
  } catch (err) {
    // No `wg` to run: the client is not installed. Anything else (a timeout,
    // a refusal) says nothing about it: unknown.
    return /ENOENT|not found|no such file/i.test(message(err)) ? { state: 'absent', tunnels: [] } : { state: 'unknown', tunnels: [] }
  }
}

// Detects WireGuard and keeps the answer; `start` is the session.start that
// asked for it, when one did: a later start drops it. At start, a tunnel that
// is off while a bound vault is remote is asked for, once.
async function checkWireguard($: EngineInterface, start?: number) {
  await update($, wireguard, () => ({ state: 'checking' as const, tunnels: [] }))
  const found = await detectWireguard($)
  if (start !== undefined && start !== generation) {
    return
  }
  await update($, wireguard, () => found)
  if (start !== undefined && found.state === 'inactive') {
    const snap = await read($, snapshot)
    const bound = snap ? [snap.primary, ...snap.secondaries] : []
    if (bound.some(r => r?.type === 'remote')) {
      $.ui.toast(t('wg.toastInactive'))
    }
  }
}

// Opens the WireGuard client, where the person turns a tunnel on.
async function openWireguard($: EngineInterface) {
  const isWindows = !!(await $.env.get('APPDATA'))
  const argv = isWindows ? ['cmd', '/c', 'start', '', WG_EXE] : ['open', '-a', 'WireGuard']
  try {
    const ran = await $.process.run(argv, { timeoutMs: 10_000 })
    if (ran.exitCode !== 0) {
      throw new Error(ran.stderr.trim() || t('error.launcherExit', { program: argv[0] ?? '', code: ran.exitCode }))
    }
  } catch (err) {
    await update($, failure, () => t('error.link', { error: message(err) }))
  }
}

// Hands an https address to the default browser, as the 🌐 button does.
async function openUrl($: EngineInterface, url: string) {
  const launchers = (await $.env.get('APPDATA'))
    ? [['rundll32', 'url.dll,FileProtocolHandler', url]]
    : [['open', url], ['xdg-open', url]]
  let lastError = t('error.noLauncher')
  for (const argv of launchers) {
    try {
      const ran = await $.process.run(argv, { timeoutMs: 10_000 })
      if (ran.exitCode === 0) {
        return
      }
      lastError = ran.stderr.trim() || t('error.launcherExit', { program: argv[0] ?? '', code: ran.exitCode })
    } catch (err) {
      lastError = message(err)
    }
  }
  await update($, failure, () => t('error.link', { error: lastError }))
}

// ---- Registering and removing a vault ------------------------------------------
const isPort = (text: string) => /^\d{1,5}$/.test(text) && Number(text) >= 1 && Number(text) <= 65535

// Where each kind of vault may be: a local one on this machine's loopback, a
// remote one at a private address — the tunnel's side (WireGuard 10.x, a LAN,
// Tailscale's 100.64/10). The key then never travels over a public network,
// in clear (HTTP) or to a certificate nobody checks (the plugin's own, taken
// with tlsInsecure).
// An IPv4 address in plain decimal only: "010.0.0.1" or "0x0a.0.0.1" are
// octal or hex to a URL parser ("010.0.0.1" is 8.0.0.1, a public address), so
// they are refused before anything is judged on them.
const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const DECIMAL_IPV4 = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`)
const isLoopbackHost = (host: string) =>
  (DECIMAL_IPV4.test(host) && host.startsWith('127.')) || host === 'localhost' || host === '::1' || host === '[::1]'
function isPrivateIpv4(host: string) {
  if (!DECIMAL_IPV4.test(host)) {
    return false
  }
  const [a, b] = host.split('.').map(Number) as [number, number, number, number]

  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

// The vault's REST address from the form, parsed and normalised; null when
// the parts do not make one.
function formUrl(form: AdminForm) {
  const host = form.host.trim()
  const literal = host === '::1' ? '[::1]' : host
  try {
    const url = new URL(`${form.scheme}://${literal}:${form.port.trim()}`)

    return url.origin
  } catch {
    return null
  }
}

// Checks the console's form; the first problem, in words, or null.
function formProblem(form: AdminForm, wg: WireguardState | null) {
  const host = form.host.trim()
  if (!form.name.trim()) {
    return t('register.invalidName')
  }
  if (!/^[A-Za-z0-9.\-:\[\]]+$/.test(host)) {
    return t('register.invalidHost')
  }
  if (form.kind === 'local' && !isLoopbackHost(host)) {
    return t('register.invalidLocalHost')
  }
  if (form.kind === 'remote' && !isPrivateIpv4(host)) {
    return t('register.invalidRemoteHost')
  }
  if (!isPort(form.port.trim())) {
    return t('register.invalidPort')
  }
  if (form.uiPort.trim() && !isPort(form.uiPort.trim())) {
    return t('register.invalidUiPort')
  }
  // And on the host the URL keeps, not only on what was typed: whatever a
  // parser would turn the text into must still be on the right side.
  const url = formUrl(form)
  const kept = url ? new URL(url).hostname : null
  if (!url || !kept || (form.kind === 'local' ? !isLoopbackHost(kept) : !isPrivateIpv4(kept))) {
    return t('register.invalidHost')
  }
  if (!form.apiKey.trim()) {
    return t('register.invalidKey')
  }
  // Refused only when WireGuard was READ as off or missing: a state the
  // system would not say (unknown) does not block.
  if (form.kind === 'remote' && (wg?.state === 'inactive' || wg?.state === 'absent')) {
    return t('register.needWireguard')
  }

  return null
}

// The router reloads its config when the file changes, a moment after the
// write: the pane reads again then, twice to be sure.
function readSoon($: EngineInterface) {
  $.clock.after(1_500, () => background($))
  $.clock.after(5_000, () => background($))
}

// Bumped by every registration sent: an older one finishing late leaves the
// form alone.
let submission = 0

async function registerVault($: EngineInterface) {
  // Another action under way: nothing is consumed, the form stays as typed.
  if (await read($, busy)) {
    return
  }
  const form = await read($, adminForm)
  const problem = formProblem(form, await read($, wireguard))
  if (problem) {
    await update($, failure, () => problem)

    return
  }
  const name = form.name.trim()
  const uiPort = form.uiPort.trim()
  const description =
    form.kind === 'remote'
      ? `${t('register.descriptionRemote')}${uiPort ? ` (UI :${uiPort})` : ''}`
      : t('register.descriptionLocal')
  const args = {
    name,
    baseUrl: formUrl(form) ?? '',
    apiKey: form.apiKey.trim(),
    // The plugin's own certificate is self-signed: over the loopback or the
    // tunnel (the only places the form accepts), the transport is the protection.
    tlsInsecure: form.scheme === 'https',
    description,
  }
  // The key leaves the form (and the session's state) BEFORE the call: it is
  // held only in `args`, for as long as the call takes.
  const mine = ++submission
  await update($, adminForm, now => ({ ...now, apiKey: '' }))
  const outcome = await act($, {
    doing: t('action.register.doing', { name }),
    done: t('action.register.done', { name }),
    tool: 'register_remote_vault',
    args: () => args,
  })
  if (outcome === 'busy') {
    // Another action took the pane in between: give the key back, unsent.
    await update($, adminForm, now => (now.apiKey ? now : { ...now, apiKey: args.apiKey }))

    return
  }
  if (outcome === 'done' && mine === submission) {
    // Cleared for the next vault — unless something was typed meanwhile.
    await update($, adminForm, now =>
      // The whole form as it was sent (its key aside, already cleared):
      // any field changed meanwhile — a new key, the kind, the scheme — is a
      // new entry, kept.
      JSON.stringify({ ...now, apiKey: '' }) === JSON.stringify({ ...form, apiKey: '' }) && now.apiKey === ''
        ? { ...EMPTY_FORM, kind: now.kind, host: now.host, scheme: now.scheme }
        : now,
    )
    readSoon($)
  }
}

async function unregisterVault($: EngineInterface, name: string) {
  await update($, confirmRemove, () => null)
  await act($, {
    doing: t('action.unregister.doing', { name }),
    done: t('action.unregister.done', { name }),
    tool: 'unregister_vault',
    args: () => ({ name }),
    shows: snap => ({ ...snap, available: snap.available.filter(r => r.name !== name) }),
  })
  readSoon($)
}

// ---- Pausing a secondary ------------------------------------------------------
// A paused secondary stays in the binding with its write tier, and the router
// refuses it from this project until it is resumed: set_secondary_vault_mode's
// `paused`, one write in the router's own config. The panel keeps nothing of
// its own, so a pause holds by every route and survives any panel state.
// The router that knows `paused` (set_secondary_vault_mode, v0.107.0).
const PAUSE_ROUTER: [number, number, number] = [0, 107, 0]

async function setPaused($: EngineInterface, s: Secondary, paused: boolean) {
  const routerVersion = (await read($, snapshot))?.routerVersion ?? null
  if (!atLeast(routerVersion ?? undefined, PAUSE_ROUTER)) {
    // The app keeps the router it started with until it restarts: the panel
    // can be newer than the router it talks to.
    await update($, failure, () => t('action.pauseNeedsRouter', { version: routerVersion ?? '?' }))

    return
  }
  const words = paused ? 'action.pause' : 'action.resume'
  // What the router's session applies once written: a session started before
  // another one's answer keeps it until restarted (pausedInForceHere).
  let isInForce = true
  const outcome = await act($, {
    doing: t(`${words}.doing`, { name: s.name }),
    done: t(`${words}.done`, { name: s.name }),
    tool: 'set_secondary_vault_mode',
    args: () => ({ vault: s.name, paused }),
    answer: text => {
      try {
        const here = (JSON.parse(text) as { pausedInForceHere?: unknown }).pausedInForceHere
        isInForce = typeof here !== 'boolean' || here === paused
      } catch {
        isInForce = true
      }
    },
    shows: snap =>
      !isInForce
        ? snap
        : paused
        ? {
            ...snap,
            secondaries: snap.secondaries.filter(r => r.name !== s.name),
            paused: [...(snap.paused ?? []).filter(r => r.name !== s.name), s],
          }
        : {
            ...snap,
            paused: (snap.paused ?? []).filter(r => r.name !== s.name),
            secondaries: [...snap.secondaries.filter(r => r.name !== s.name), s],
          },
  })
  if (outcome === 'done' && !isInForce) {
    await update($, failure, () => t('action.pauseNotHere', { name: s.name }))
  }
  readSoon($)
}

// ---- Opening a vault from the band ------------------------------------------------
// A local vault in Obsidian, a remote one's web UI in the default browser
// (Chrome on this machine): what its row in the pane offers as 💎 and 🌐.
// What each mark shows, for a reader that cannot see it — and the desktop's
// band drew an empty space for a mark with no description (seen on screen in
// v0.110.2), where the pane's described dots were drawn.
const markAlt = (source: string) =>
  source === OBSIDIAN_MARK
    ? 'Obsidian'
    : source === CLAUDE_PANE_MARK
      ? 'Claude'
      : source === ROUTER_MARK
        ? 'obsidian-mcp-router'
        : source === GITHUB_MARK
          ? 'GitHub'
          : t('mark.browser')

// The router's mark, at the left of the pane's menu: the left of the
// repository's logo (docs/assets/logo.png), 64 px, its white made transparent.
const ROUTER_MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><image width="64" height="64" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAASDUlEQVR42u1baZRU1bX+9jn33pq76AaUJrAEI4oMCaHV6Iva3WLiEJYaY3UMBjGDkKfGBPGZQU1RBtSVxGV8xKHxAYo+MFUKiY+ACtKNOAB2GzAMShQiykwP1UMN995z9vtxq6AhoIjNo9d67rWqerh179nn2/vsuYDP6XM6IjGYmFkws4jHvRczU4/nmw/m+5h4Zhz5pp4MQjweF5+GZ+MIWyQCMTOLDzfg1HR7uyksN3NyuNRtfv8f+4go31MlT0R6dd3ufiWhaJQ5z2bQzebbZScRNReuc9d7xOHVHsTr2VpX1/5yW3NuY75d/d1Oi407d2bf7fSfvGbTJo70tOOQTLIkIl5b13ptiVn2Tmdr/u1cO2/obDI2mBR6r3FZ6y1ExMkky48FAAxBRHrtnvTksl6Rqnw+K6VBkkDBvJ0LlUVLvtTxYdPdiQTpVAqip0h+wwbw+hday+w8ZiitoySUKSQZ2kXEzqtSQcb0jQ0d5bEYNDOLwwLAcRZEpNbVdQ7QrryruaVdAYDWzEopBqD3NbUp0/BNXrs6fXpNDamuDzuBJBIJ0hnSd0RLon0y2Q4HTOS6irVWnLczTigQKulstacTEadSoMMCkBoOYmbScBIlJeGwqx0AJFiDACICCYaLUChocEb/ticcgaLQNryRHhII+G7K5ts1gQytAdZERERCktGZS+tgwHf9upX7zq2pIZVMJuVBADAz1dSQwgaYyuFv5HJZTRBERCACGAwGACLK523NmkY3NjYaRKQ/zmMcb6qvqhcAoG0xOugPRmzbZiGJhABAADNDa5BrK+0zgpKVeQ4A9O0bo4MAICLmJEsaQTYJPd0yfUJpzVozmAECgbyHcjDgF8KkP5x11llOXR0bhIMt6/8lVVVVKWYmletYlE63vh0ORiSYFXusghlgZm1afpluT+80rJKnGUxVVVD/cgSohnQ8zmL0mLKZ7Z1t60LBMIHYJmIFYgVmx2cEuaMz89a21n88Fo+zKD7oRBERMVIQoy4p7wyE/T81TJEDkRLELogVCIoZjt8KkgbfPeLfqLm+rl4W3eGhBoyHDwcRkSbJt1o+S0TCJVYoWCJDwagMBiJmSchn/O3N9zZeccVZmf47G+WhfvVEUE0qBQBY9MLijRve/qcVjfSyAsGwEYlEZSgUlv3LS30Zp2XNWWN6zUkmWVZXV7tHDIRqakhxnAWNoVcalzdN8fnCF+eyGU0Srs8y3XY388bKJX+/eMpVCx6cNPOsyZWIGyuQUACOGYhkjGUsCX0sYCZjSVmTqlFLnmooTz357ottA7fd+cXT+w1VmvtCKIeInI5M0LYCxnQi0hw/Sq/1cRa+bn1d+KbL5q/+xVXP3w8CKhE3GDgGQ8gEdA1dP50xjRc2s2rx5pJJlz7z7q1jU5O718UkWSYPedXWNphFgG657Jm3fnrV/Mc9EOqMT7OBWMxzQyDgd1PevGZGvLH/x8XyR4r5655v6HPTZcltk69eOAUA4rGkdSjfzCyPWvKfAnnaxtsCP7r46ZV31vz1IQCoqKg1j+b+ysq4AQCvvropcsM35s353vl/5kd++XYDM5uxWFJ+UnxRBG/p0tW9b7z46W1Trl5wDwBMPMr1uzXrYmb6yeXJxp9fs+AhwDsOR9IE756YBIA7J/75wusueGbTVaP+xJeMnJl79Pb3+Yl7Ns8FgLo4G5+07uKHNvu+XzV3061XPjPNW7fOOAGpJwuAaTtvD97yzeSau2KLHizaBBxiE4pSN0zCbd9Zcts1Zz/lXDZsFl8+8nHnm1+ew9NvfNN56td7eO7vNt5yJBCKmrc02RD9fuXcxju+vfA3n0bzDutGu0MTEomEZmbzZ1ek1sJwX33oL+MmTfxKrTmzcZJT+JQAEnrejFf7v7BgS21n2hybtbPwglUWeSeH884ZyacOGqiEJB0qVRddc+tpryWTLGtqSHV5BgNxuu6rpzSUlPlffHTJuF9WoNZsRHGdEwBAUTKJBGnmbYGbvrnyDZ/hX/yH57/9q1gsKYcN28D33JPQt0/4n8u3b+6c2Z62v+DoTpekkIIMb30SGDVsBMrLg9q0fEKY+HDwMDp75bun7vVWmIpEIsETa2uNfY+Kl0/qG3rlsaXj7qqoqDUbG499890GwCGaYNx4UfJ55fJLc1Ze+wcANGns3Cl7d4jfZbJ5kNCKiCR7GRYUM4YMHIne0XKwyCPam1Wfk6JSWOkl43955uXxOBuJBLkAKFbx+MslJdaaWXUTflFRMdFsbJzpfFa+qbsNYwEEcfPY51b7wnjsPxfEZl165gMtdjYUFSa0IJIgggDBdvLo1+cUDC4fBlfbheyF4Asqt3xAxDDCrdN/cPeIuyZULuyVz7ctKI36Vj/64rWfWe2PGwBdj8Nzz7120rtvtpe8t2nLeVvf7pjrs6IuGdLQrCFIQGsHJeEynD5wVDHLBMAgEJjBQkANGBQx+g+1L6l7cXWDJH/s98kramNIyhRqui3/OE5pLBNADAIuG31fY9OOzFcCoRId9JdJQEO5Lny+AIYNOgeGNKFZFQA4iCktyUIwrFoGDLFHjr9r2M7KyjpjxYoDcXx3kDwe24/FhsvYxmF03sRJ52x9p+nOvJ2BhisDviiIARKEIQNGIeALQ7ELAh0QBe9HgZRylcpZ4e37/pn+wvDca2d3nk0rPnhSd2sp6bgoQApIUEK///ddN9o5LaRhaNYays0DIJw6YAQioVK4ygYVJc4AcSGjIIBZQ0ohOvLNvKc5fV0ymaTEiupuT727HQAGUwo1Kvmn18taWjJXa+WCCJJZI5dvQ3nvQegVOgmOa3uS7xI0cvGNPTUQJEROdXA2w2dM+8nyC4vZX48GoApTJQAsmr36O9msW8rCcYmZGA4ydit6hfvAqzKxV2UsSn+/7h/4qbVGPp/RUAZ2fZQZB4BTPV0DVgCaebNv767MRNdx2eW8yDodyDsZZHNpbNv9Dnw+A0IIMHtAoFC6OkSVADBcVtJxc0ins1csWvRBaSpVo7qzBtnNAHgh76O/3xrd17L3zPbcPrIdm7TWAAsYhondzduxc882SJZemZUKFu8Ql0QgaNaw3Rxpzis3T31XJDdeCoCmVtbLHgpAQscQkzffcemeUNiab8kgQKw8cWpodgFysGXHJmTtLKirEyICMx2wAQy4rgNX5WFIydAGt7Xa40FgVNXrHnsEhmEYMzOGjzjtPssSNhTJokIrlYOjM3CUjY/2/QOGFN4VKho+LlSjPA1wtePZBxLStjvRmXbG1E5rGJpIJHS8mwoc3Q5AAgkNxOTDyYmbI2XWAgIRs1IAg8gEQcIyfdjTsh1N6d0wpAnWfODcFz2hEHCUA61dAEwMBkFa+VymNwBs3JiiHgmAFwjFAAadUznsj4GwhNZeCiCocO5BIGZs2b4etpOFELJLOHzABjjKLobISggJ6XcaJt9b9RoQF6lU94TDxwUAj7k4/fax618r7997md+ICCIoIoKrslAqDwhGxu7AR01bYAjpqT11MYpEcFQODM+E+H1BOvnkSK1SGvHKKtFjbUCXcJiUq3H68MH3BEJ+sAYxMxyVBUOBiGCZPuzc9080t++BIcyCS/Q2z2A4bh4EYkk+6QugaWzNsOcAYGp9lerxABS0QDww+/qVMmgvB0gQkZJkQpBRCIA0tHbw3o510GxDkAQJzxAoV8FWeQgylM8qQTBKCy8Ye0pLLJbs1mbMcW1tV1ZCXKB/bQwc3O/egD8EYklaO9DseE1LVjCERGc2je1N78MyzWILFsyep2NNAkZOD/hiYFY8HhexbubxeHZ1qejXhEGoHnrnqqZd7ecokdel4VOkYQRB+5NA733E4K8iFCwDs4KrHGzdvV5pl0RJb1o7Z9l3RkMDccSF52l6sAYUStfMzDTl2oX3rVmlzUFD+zxg+U1ixSAICBIH4eS6eWz+aB20cr1rpKFYIRQKUr8vlN5/21XPDp0ybtEpCSR0rBsTInE8Np9ITGXDJEy48KnlLbtyJ2/ZktL/lfrpwmDYt8ESUSGEpQgCYIZmDa0VpJRoz7ZgR/MWmMKE47osyCeFz9177+yvP9vS3jF419Y9L90eW9QvlapR3QVCtwLAzJRIJCANydeeO3up69rvzq7/7g8ertlAROT2PblkumkJclS2kAgVgh7yMgFLWvhoz/voyKahmZUpA4j2Mp8hIj1n6Q1LoqX+qft2NC+/6fI53QaC6E7JE00lwyI94WtP1Ftk7Zr3xo9+7HWPpyoAlKy/I0X+zGatHAFifcBYCO9YQEIrG5t3vIW9rR8JTZ3uoCEnzQa8nt8ji8fNlwF3Wkda1t1+efdogug+tQekcY++4cKn6wzT+ODJ168bX1lZ3DxxZWVcEpF76hn9Hw74ogSWDgDFWrNSDhyVQ85pg+10YHfTByqfh+hTGn79tvu/uhaIi0Sqxp5YUWvOWvaDecES/292NO9ePqHys2sCdYfaExEZltATzpuzTJqi9fG68dewikkgqVEYn/E+B6zavDpy3/hVq9v2qaG2nYer8gApl4USAAliQEifGtT/bDn4DN8P731izOx4ZZ2RKBRDJ1Z4HacffuPJcTpr3t27X3n171PVu2KxpDyW8Fh89s1PJWmQnnD+3HpW5taZy8Zfc6GKG8wHNu+F+V6ce+7p57Zd9eMvnzdkZMkN/foHXwhFZE6awmBNgjUY0I5mh7TRvPeKmoHPHhr5zWyc5EysqDVnvTRhXjBs/GbHB+/VTaj8Y7caxn/ZZNfXIa6ODIvw75fMf/nGi56eJwwghk9sbx+Y0TOAGfGlp19/6SM/v+RL96256Ixp/LWBv+Yxp83gm7/1/AwvmIoftutbbIjeUP34uPFfe2LTz771XLkXgnsgHInvT3k8Dn8jF7rChiUw6evP1N90WSrp6VJMHl25iqnA6H4NNC0D8Z/85dyr/+23D323cua6h+9qPBMAfVzeX5wHuPXKZ8d9v3rupusuqS0/4orHWj/grezfWsf+urqtft7K/uL/vc3/97JJ1fOfgDgqyR/RgB4qZct39JpcBGHi2CfHjT//iU1XDp89sLa2wdz0572RV1/dG3k9uS2wePFmX1ErPtEIMpjAIADiby+nF1qWf7RtZ7XWgGH4hMv2Rotz33to2vL5zPrD2Su+NwFISqBG4zMMSu1X31QKKaTU/u7SUYIws3GSM+78ObFRZw/+xZXXnhdqa8lGITRJg+xQIIKOTNudFWPKnjq45X44AJglEak1L+z72Ul9ej/Ykm6HlF7BQrkagUAAb9Sv37Yk9eaC59bfOPkCN27U81R1IsflmJkmTZppzJr9Y6dxaXpzMBAZ0tHZBiklwAzLDCBn55oCpIeeUR9pngogkSD9L14gXpi7feuVtr6GYd3d0tqhHMdV+XxeO3Zea23rTKZDjaw4pX/ybz+6T7ugm5NT+UTPCtbX18uZMyc5b76091eRUGRIa7rJUa7Ltm2z4zjc3pl2wsFQ7w6t4pQgPXz4EYalvSFJwM2604OBcJmjbAgBCYIAIEAklHYRCESMVYubZjCf8BlJxOMsqqur3XdWtQw2Td/t7Z3esDTIG3MGgUiQ0d6Z1qY0J659reUrXafcD5rRq6khtXx5nSEEf91181pQ8SmAZoA1QCSIYbPPb54PwPDO04kblq6q8vbg5sWFIV+4NJ/PM3kz3l0rzKS10pFIyCJXVHpag0MB8Ialq6urXWnQA36/JRjM+5MWr2oJrTUH/AEyTK4lIoeZJU7osDQUM5Oh6a8t6ZYP/f6AAKCpa8NZs5bkk21tbXtDUTEPwOGHpVEYlh5VVfpoc3PzJksGSWm2AVbCgBKCHZ8RQHNL2w6zb/TBglvRJ/IIFOyPGFpdso8E/9zvD5DW7CqXldasiKBIwAkGQuTaatppoyJ7mFkcdliaDgxLK5LW7eGIX5RESqxwqEQG/RHp94XNaK+gFFL9x5lnUjtSED1hWJrI+wLE6DG956dbWxv6lpVZgUBIhkMlMuAPyj6lpb72TOuGdqv0kcLZ1x+bDBUQ0uteab3TbwWrW1s6NJgQiQSFotyakedHf8VxFlRwJT2Bijw3LG0f6fdb9ys3bzqOJq2IA8GAY2snXlEdaih+7qh8K/6/U2HQWDCzSCaT3u+HfO2sp1E8zqLId5Hn4t/4nD6nz+lQ+l8X2a9qS4S4ygAAAABJRU5ErkJggg=="/></svg>`

// Where a vault opens from the band: Obsidian for a local one Obsidian lists
// (or may list: not checked yet), the browser for a remote one with a web UI;
// null when it opens nowhere, and the band then draws its name alone.
function openTarget(row: VaultRow): 'obsidian' | 'browser' | null {
  if (row.type !== 'remote' && row.path) {
    return row.isKnownToObsidian === false ? null : 'obsidian'
  }

  return row.uiUrl ? 'browser' : null
}

async function openVault($: EngineInterface, row: VaultRow) {
  if (row.type !== 'remote' && row.path) {
    await openInObsidian($, row)
  } else if (row.uiUrl) {
    await openInBrowser($, row)
  } else {
    $.ui.toast(t('band.noOpen', { name: row.name }))
  }
}

// ---- Plugin update ------------------------------------------------------------------
const REPO_URL = 'https://github.com/tboome33/obsidian-mcp-router'
const LATEST_MANIFEST = 'https://raw.githubusercontent.com/tboome33/obsidian-mcp-router/main/.claude-plugin/plugin.json'
// Obsidian's mark, in its purple, before the button that opens a local vault in
// Obsidian (a surface with no SVG element keeps 💎). From LobeHub's icons
// (@lobehub/icons-static-svg 1.98.0, obsidian-color.svg, MIT).
const OBSIDIAN_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M9.643 14.012c.615-.183 1.605-.465 2.745-.534-.684-1.725-.849-3.235-.716-4.579.153-1.552.7-2.847 1.234-3.95.114-.235.223-.454.328-.664.149-.297.289-.577.42-.86.217-.47.378-.885.46-1.27.08-.38.08-.719-.014-1.044-.095-.325-.297-.675-.681-1.06a1.6 1.6 0 00-1.475.36l-4.95 4.453a1.602 1.602 0 00-.512.952l-.427 2.83c.67.592 2.327 2.317 3.335 4.71.09.213.174.432.253.656zM5.855 9.937c-.024.1-.057.197-.099.29L3.14 16.058a1.602 1.602 0 00.313 1.772l4.117 4.24c2.102-3.102 1.795-6.02.835-8.3-.728-1.73-1.832-3.083-2.55-3.833z" fill="#A88BFA"/><path d="M8.52 22.57c.073.01.146.018.22.02.781.023 2.095.091 3.16.288.87.16 2.593.642 4.011 1.056 1.082.316 2.197-.548 2.354-1.664.115-.814.33-1.735.725-2.58l-.009.004c-.67-1.87-1.523-3.077-2.417-3.847a5.294 5.294 0 00-2.777-1.258c-1.541-.216-2.952.189-3.841.45.532 2.218.368 4.828-1.425 7.53z" fill="#A88BFA"/><path d="M19.676 18.538a69.072 69.072 0 001.858-2.952.811.811 0 00-.061-.901c-.516-.684-1.504-2.075-2.042-3.362-.554-1.323-.636-3.378-.64-4.378a1.708 1.708 0 00-.359-1.051L15.235 1.83a3.757 3.757 0 01-.076.545c-.107.503-.307 1.004-.536 1.498-.135.29-.29.601-.446.915-.105.21-.21.42-.31.626-.517 1.068-.998 2.227-1.132 3.59-.125 1.262.046 2.73.814 4.484.128.01.257.025.386.043a6.364 6.364 0 013.327 1.506c.916.79 1.743 1.921 2.414 3.5z" fill="#A88BFA"/></svg>'
// The marks before a vault's open links (the panel redesign): a remote vault's
// web UI in the browser, the same in Claude's own browser pane.
const GLOBE_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.8" fill="#2A78D6"/><path d="M5.2 6.6c1.2.5 2.4.4 3.4-.2M6.4 10.4c1-.4 2.2-.3 3.4.4" fill="none" stroke="#9CC4F2" stroke-width="0.9" stroke-linecap="round"/><ellipse cx="8" cy="8" rx="7.3" ry="2.3" fill="none" stroke="#2A78D6" stroke-width="1.1" transform="rotate(-22 8 8)"/></svg>'
// Claude's own mark: the app's built-in browser. From LobeHub's icons
// (@lobehub/icons-static-svg 1.98.0, claude-color.svg, MIT).
const CLAUDE_PANE_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" fill="#D97757" fill-rule="nonzero"/></svg>'
// The octicon "mark-github" (MIT), grey so it reads on a light and a dark pane.
const GITHUB_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#6e7681" d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>'

// SemVer: x.y.z, an optional -prerelease (below its release), +build ignored.
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const isVersion = (v: unknown): v is string => typeof v === 'string' && SEMVER.test(v)
function compareVersions(x: string, y: string) {
  const a = SEMVER.exec(x)
  const b = SEMVER.exec(y)
  if (!a || !b) {
    return 0
  }
  for (let i = 1; i <= 3; i += 1) {
    if (Number(a[i]) !== Number(b[i])) {
      return Number(a[i]) > Number(b[i]) ? 1 : -1
    }
  }
  if (!a[4] || !b[4]) {
    return a[4] ? -1 : b[4] ? 1 : 0
  }
  const pa = a[4].split('.')
  const pb = b[4].split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if (pa[i] === undefined || pb[i] === undefined) {
      return pa[i] === undefined ? -1 : 1
    }
    const na = /^\d+$/.test(pa[i]!) ? Number(pa[i]) : null
    const nb = /^\d+$/.test(pb[i]!) ? Number(pb[i]) : null
    if (pa[i] !== pb[i]) {
      if (na !== null && nb !== null) {
        return na > nb ? 1 : -1
      }
      if (na !== null || nb !== null) {
        return na !== null ? -1 : 1
      }

      return pa[i]! > pb[i]! ? 1 : -1
    }
  }

  return 0
}
// A vault's tile, in cells, at the least: a name of about 18 fits. The pane
// widens it to the tier menu's width, the same for every tile.
const TILE_WIDTH = 24
const isNewer = (latest: string, installed: string) => compareVersions(latest, installed) > 0

async function installedVersion($: EngineInterface) {
  const root = pluginRoot($)
  try {
    const manifest = root ? (JSON.parse(await $.fs.read(`${root}/.claude-plugin/plugin.json`)) as { version?: string }) : null

    return isVersion(manifest?.version) ? manifest.version : null
  } catch {
    return null
  }
}

// GitHub's manifest on main against the plugin's own: the pane's badge.
async function checkUpdate($: EngineInterface) {
  const installed = await installedVersion($)
  // GitHub silent: the version it last announced stands, badge included.
  const known = (await read($, updateState))?.latest ?? null
  let latest: string | null = null
  try {
    const answer = $.http.fetch(LATEST_MANIFEST).then(res => (res.ok ? (JSON.parse(res.text) as { version?: string }).version : undefined))
    const late = $.clock.sleep(8_000).then(() => undefined)
    const found = await Promise.race([answer, late])
    latest = isVersion(found) ? found : known
  } catch {
    latest = known
  }
  await update($, updateState, now => ({
    installed,
    latest,
    isAvailable: !!installed && !!latest && isNewer(latest, installed),
    isRunning: false,
    log: now?.log ?? null,
  }))
}

// The marketplace the plugin was installed from, read off its folder
// (…/cache/<marketplace>/obsidian-router/<version>); the project's own else.
function marketplaceOf($: EngineInterface) {
  const parts = (pluginRoot($) ?? '').split(/[\\/]/)
  const at = parts.lastIndexOf('obsidian-router')

  const found = at > 1 && parts[at - 2] === 'cache' ? parts[at - 1]! : ''

  // It reaches cmd /c: a plain name only — no &, |, quotes or spaces.
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(found) ? found : 'obsidian-mcp-router-marketplace'
}

// The versions Claude Code now has installed, read back from it per scope:
// what the update reports is what landed, not what GitHub announced.
type Installs = { user: string | null; project: string | null }
// This session's project folder, from session.start: the list holds every
// project's installs, and only this one's is what its update changed.
let projectDir: string | null = null
async function installedNow($: EngineInterface, plugin: string): Promise<Installs | null> {
  try {
    const listed = await runClaude($, ['plugin', 'list', '--json'])
    const entries = JSON.parse(listed.stdout) as { id?: string; version?: string; scope?: string; projectPath?: string }[]
    const isHere = (e: { scope?: string; projectPath?: string }) =>
      e.scope === 'user' || (!!projectDir && !!e.projectPath && samePath(e.projectPath) === samePath(projectDir))
    // The lowest of a scope's installs: one left behind is not "updated".
    const of = (scopes: string[]) =>
      entries
        .filter(e => e.id === plugin && isVersion(e.version) && scopes.includes(e.scope ?? '') && isHere(e))
        .map(e => e.version as string)
        .reduce<string | null>((x, y) => (x === null || compareVersions(y, x) < 0 ? y : x), null)

    return { user: of(['user']), project: of(['project', 'local']) }
  } catch {
    return null
  }
}

// Claude Code's own commands, through cmd on Windows (claude is a .cmd shim
// there): the marketplace is fetched again, then the plugin updated where it
// is installed — this project and the user's own scope.
async function runClaude($: EngineInterface, args: string[]) {
  const argv = (await $.env.get('APPDATA')) ? ['cmd', '/c', 'claude', ...args] : ['claude', ...args]

  return $.process.run(argv, { timeoutMs: 180_000 })
}

async function updatePlugin($: EngineInterface) {
  const now = await read($, updateState)
  if (now?.isRunning || (await read($, busy))) {
    return
  }
  await update($, updateState, s => (s ? { ...s, isRunning: true, log: null } : s))
  await update($, busy, () => t('update.doing'))
  const market = marketplaceOf($)
  const plugin = `obsidian-router@${market}`
  try {
    const fetched = await runClaude($, ['plugin', 'marketplace', 'update', market])
    if (fetched.exitCode !== 0) {
      throw new Error(fetched.stderr.trim() || fetched.stdout.trim() || `exit ${fetched.exitCode}`)
    }
    const project = await runClaude($, ['plugin', 'update', plugin, '--scope', 'project'])
    const user = await runClaude($, ['plugin', 'update', plugin, '--scope', 'user'])
    if (project.exitCode !== 0 && user.exitCode !== 0) {
      throw new Error(project.stderr.trim() || user.stderr.trim() || `exit ${project.exitCode}`)
    }
    await checkUpdate($)
    const state = await read($, updateState)
    const latest = state?.latest ?? null
    const installs = await installedNow($, plugin)
    // The scopes whose update ran, read back; the lowest is what this says.
    const ran = [project.exitCode === 0 ? installs?.project : undefined, user.exitCode === 0 ? installs?.user : undefined]
    const found = ran.filter((v): v is string => typeof v === 'string')
    const landed = found.length > 0 ? found.reduce((x, y) => (compareVersions(y, x) < 0 ? y : x)) : null
    const failedScope = project.exitCode !== 0 ? 'project' : user.exitCode !== 0 ? 'user' : null
    const before = state?.installed ?? null
    const log =
      (landed === null
        ? t('update.unverified')
        : before && compareVersions(landed, before) <= 0
          ? t('update.unchanged', { version: landed })
          : latest && compareVersions(landed, latest) < 0
            ? t('update.partial', { version: landed, latest })
            : t('update.done', { version: landed })) +
      (failedScope
        ? ` ${t('update.scopeFailed', {
            scope: failedScope,
            error: (failedScope === 'project' ? project : user).stderr.trim() || `exit ${(failedScope === 'project' ? project : user).exitCode}`,
          })}`
        : '')
    const isCurrent = !failedScope && !!landed && (!latest || compareVersions(landed, latest) >= 0)
    await update($, updateState, s => (s ? { ...s, isRunning: false, isAvailable: s.isAvailable && !isCurrent, log } : s))
    $.ui.toast(log)
  } catch (err) {
    await update($, updateState, s => (s ? { ...s, isRunning: false, log: t('update.failed', { error: message(err) }) } : s))
  }
  await update($, busy, () => null)
}

// ---- Creating a vault --------------------------------------------------------------
// The library's conventions, by id: the snippet files the router ships.
const RECOMMENDED_CONVENTIONS = [
  'roadmap-discipline',
  'default-vault-health-check',
  'wiki-query-first',
  'path-disambiguation',
  'source-type',
  'languages',
  'heading-hierarchy',
  'auto-enrichment',
]

async function conventionIds($: EngineInterface) {
  const root = pluginRoot($)
  try {
    const entries = root ? await $.fs.list(`${root}/skills/conventions/snippets`) : []
    const ids = entries
      .filter(e => e.kind === 'file' && e.name.endsWith('.md'))
      .map(e => e.name.slice(0, -3))
      .filter(id => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id))

    return ids.length > 0 ? ids.sort() : RECOMMENDED_CONVENTIONS
  } catch {
    return RECOMMENDED_CONVENTIONS
  }
}

// Where a new vault goes by default: the config's vaultsRoot, else the
// folder most registered vaults sit in.
async function defaultVaultRoot($: EngineInterface, configPath: string) {
  try {
    const config = JSON.parse(await $.fs.read(configPath)) as RouterConfig & { vaultsRoot?: string }
    if (typeof config.vaultsRoot === 'string' && config.vaultsRoot) {
      return config.vaultsRoot
    }
    const counts = new Map<string, number>()
    for (const entry of Object.values(config.vaultsById ?? {})) {
      const parent = entry.path?.replace(/[\\/][^\\/]+[\\/]?$/, '')
      if (parent) {
        counts.set(parent, (counts.get(parent) ?? 0) + 1)
      }
    }

    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  } catch {
    return null
  }
}

// The vault's languages, read as the router reads them (parseLanguagesValue,
// src/helpers/convention-languages.mjs): ISO 639-1 codes, none twice. Null
// when the field holds none, or anything else — nothing is dropped in silence,
// and nothing is created that its conventions would then refuse.
const ISO_639_1 = new Set(
  (
    'aa ab ae af ak am an ar as av ay az ba be bg bi bm bn bo br bs ca ce ch co cr cs cu cv cy ' +
    'da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht ' +
    'hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky ' +
    'la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny ' +
    'oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss ' +
    'st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo ' +
    'za zh zu'
  ).split(' '),
)
const languagesOf = (text: string) => {
  const tokens = text.replace(/[[\]]/g, ' ').split(/[\s,;]+/).filter(Boolean)
  const codes = tokens.map(code => code.toLowerCase())
  const isEach = tokens.every(code => /^[A-Za-z]{2}$/.test(code) && ISO_639_1.has(code.toLowerCase()))

  return codes.length > 0 && isEach && new Set(codes).size === codes.length ? codes : null
}

async function installConventions($: EngineInterface, vault: string, ids: string[], languages: string[]) {
  const outcome = await act($, {
    doing: t('create.conventionsDoing', { name: vault }),
    done: t('create.conventionsDone', { name: vault }),
    tool: 'install_conventions',
    args: () => ({ vault, ids, ...(ids.includes('languages') ? { languages } : {}) }),
  })
  if (outcome === 'done') {
    await update($, pendingConventions, () => null)
  } else if (outcome === 'failed') {
    const why = (await read($, failure)) ?? ''
    await update($, pendingConventions, () => ({ vault, ids, languages }))
    await update($, failure, () => t('create.conventionsPending', { name: vault, error: why }))
  }
}

// A new local vault: the router's sealed preview (plan_vault), then the
// creation with that seal (provision_vault, opened in Obsidian and probed),
// then the conventions chosen (install_conventions), which need its REST API
// up — kept for a retry when it is not yet.
async function createVault($: EngineInterface, defaultRoot: string | null | undefined) {
  if (await read($, busy)) {
    return
  }
  const form = await read($, createForm)
  const name = form.name.trim()
  if (!name) {
    await update($, failure, () => t('create.invalidName'))

    return
  }
  const codes = form.conventions.includes('languages') ? languagesOf(form.languages) : []
  if (!codes) {
    await update($, failure, () => t('create.invalidLanguages'))

    return
  }
  const sep = defaultRoot?.includes('\\') ? '\\' : '/'
  const path = form.path.trim() || (defaultRoot ? `${defaultRoot}${sep}${name}` : '')
  const base = {
    name,
    ...(path ? { path } : {}),
    wikiMode: { mode: form.mode },
    open: true,
    probe: true,
    bindToWorkspace: form.bind,
  }
  let seal: string | null = null
  try {
    const plan = JSON.parse(await call($, 'plan_vault', base)) as { approvedPlanSha256?: string }
    seal = typeof plan.approvedPlanSha256 === 'string' ? plan.approvedPlanSha256 : null
  } catch (err) {
    await update($, failure, () => plainly(message(err)))

    return
  }
  if (!seal) {
    await update($, failure, () => t('create.noSeal'))

    return
  }
  const sealed = seal
  // The router names the vault it registers (its slug): the conventions go to that name.
  let created = name
  const outcome = await act($, {
    doing: t('create.doing', { name }),
    done: t('create.done', { name }),
    tool: 'provision_vault',
    args: () => ({ ...base, approvedPlanSha256: sealed }),
    answer: text => {
      try {
        const slug = (JSON.parse(text) as { slug?: unknown }).slug
        created = typeof slug === 'string' && slug !== '' ? slug : name
      } catch {
        created = name
      }
    },
  })
  if (outcome !== 'done') {
    return
  }
  // The conventions stay chosen, for a retry to correct.
  await update($, createForm, now => ({ ...EMPTY_CREATE, conventions: now.conventions, languages: now.languages, mode: now.mode }))
  readSoon($)
  if (form.conventions.length > 0) {
    await installConventions($, created, form.conventions, codes)
  }
}

// The pane is gone: its polling stops, and the band's toggle offers it again.
async function markClosed($: EngineInterface) {
  paneEpoch += 1
  stopTicker()
  isPaneOpen = false
  isPanePlaced = false
  await update($, paneVersion, v => v + 1)
  // A key typed but not sent does not outlive the pane.
  await update($, adminForm, now => (now.apiKey ? { ...now, apiKey: '' } : now))
}

// The band's toggle: the pane opens (and reads the router again), or closes.
// A plugin's own ui.close is not seen by its own hook, so the close is marked
// here.
// Shown, it closes; asked for but waiting (or closed), the press opens it —
// a person's open is placed at any width. Hiding also cancels the startup's
// own open, before any await: a startup read still under way would otherwise
// reopen what was just hidden.
async function togglePane($: EngineInterface) {
  if (isPanePlaced) {
    isStartupCancelled = true
    await $.ui.close({ id: PANE }).catch(() => undefined)
    await markClosed($)

    return
  }
  isStartupCancelled = false
  await openPane($)
  background($)
}

// The band is drawn in this session: neither the panel nor the band is off.
const isBandOn = () => isEnvKnown && !isOptedOut && !isBandOptedOut

// The pane's menu: the vaults, the adding list, the console. Each key shows
// its view and brings it into the window: the top, or the adding bar. The
// console folded drops a key typed but not sent; opened, it reads WireGuard.
type PaneView = 'vaults' | 'add' | 'admin'
// Each press of the menu: a later one supersedes it, whose scroll then stands.
let navGeneration = 0
// Claude in Chrome asked once at the pane's first drawing; a refresh asks again.
let isChromeAsked = false
async function showView($: EngineInterface, view: PaneView) {
  navGeneration += 1
  const generation = navGeneration
  await update($, navOpen, () => false)
  const wasAdmin = await read($, showAdmin)
  await update($, showAdmin, () => view === 'admin')
  if (view !== 'admin') {
    await update($, showAdd, () => view === 'add')
  }
  if (view === 'admin' && !wasAdmin) {
    void checkWireguard($).catch(() => undefined)
  }
  if (view !== 'admin' && wasAdmin) {
    await update($, adminForm, now => (now.apiKey ? { ...now, apiKey: '' } : now))
  }
  // The adding list (and a folded menu) is drawn at the next redraw, not when
  // the atom is set: each try waits a redraw first, then asks for the head
  // until it is there (a refusal is an answer, not a throw), and stops as
  // soon as a later press has taken over. The head, not the bar: the pinned
  // menu covers the window's first rows, the tabs come just under the head.
  // An unload (the pane closed, the session over) ends the asking quietly.
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await $.clock.sleep(50)
      if (generation !== navGeneration) {
        return
      }
      const moved = await $.ui
        .scroll(view === 'add' ? { in: PANE, to: { key: 'add-head' }, block: 'start' } : { in: PANE, to: 'start' })
        .catch(() => ({ deny: 'failed' }))
      if (!moved.deny) {
        return
      }
    }
  } catch {
    // Nothing left to scroll.
  }
}

// What the pane's window does, as this module sees it: each `ui.scroll` for
// the pane and each drawing's `scroll`, the last 60, in a file of the
// temporary directory (obsidian-router-pane-scroll.json). The sticky status
// bar draws from `scroll.offset`; this says whether a surface reports it.
const scrollTrace: Record<string, unknown>[] = []
let lastTracedOffset = -1
let lastTracedBand = ''
// One writer: an entry while a write runs marks the trace dirty, and the
// writer writes again, the latest state, so no older snapshot lands last.
let isTraceWriting = false
let isTraceDirty = false
async function traceScroll($: EngineInterface, entry: Record<string, unknown>) {
  scrollTrace.push({ at: Date.now(), ...entry })
  scrollTrace.splice(0, Math.max(0, scrollTrace.length - 60))
  isTraceDirty = true
  if (isTraceWriting) {
    return
  }
  isTraceWriting = true
  try {
    const dir = (await $.env.get('TEMP')) ?? (await $.env.get('TMPDIR')) ?? '/tmp'
    while (isTraceDirty) {
      isTraceDirty = false
      await $.fs.write(`${dir}/obsidian-router-pane-scroll.json`, JSON.stringify(scrollTrace, null, 1)).catch(() => undefined)
    }
  } finally {
    isTraceWriting = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const start = ++generation
    projectDir = e.cwd
    // An open still pending from before this start (a /vaults, the band's
    // toggle) finds the epoch moved and adopts nothing.
    paneEpoch += 1
    stopTicker()
    isPaneOpen = false
    isPanePlaced = false
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
    const bandOptOut = await $.env.get('OBSIDIAN_ROUTER_NO_VAULT_BAND')
    isBandOptedOut = TRUTHY.has((bandOptOut ?? '').trim().toLowerCase())
    isEnvKnown = true
    await startLanguage($).catch(() => undefined)
    if (isOptedOut) {
      // A pane an earlier start opened while this one read its environment
      // is closed: the earlier start's own check ran before this answer.
      // Closing a pane that is not open does nothing.
      await $.ui.close({ id: PANE }).catch(() => undefined)

      return next(e)
    }
    await $.command.register({
      name: 'vaults',
      description: t('command.description'),
    })
    await $.command.register({
      name: 'vault-setup',
      description: t('command.setupDescription'),
    })
    // The plugin's version against GitHub's, once per session.
    void checkUpdate($).catch(() => undefined)
    // WireGuard, once per session in the background: the pane says whether
    // the remote vaults can be reached, and asks for the tunnel when not.
    void checkWireguard($, start).catch(() => undefined)
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
          // No vault for this project yet: where to set one up.
          if (start === generation && !(await read($, snapshot))?.primary) {
            $.ui.toast(t('setup.toast'))
          }

          return
        }
        // Refused by Claude Code's permissions: no retry will change that.
        // The pane stays shut, but a toast says why and where to look.
        if (isRefusal(await read($, error))) {
          if (start === generation && !isStartupCancelled && !isPaneOpen) {
            await $.ui.toast(t('startup.refusedToast'))
          }

          return
        }
        await $.clock.sleep(STARTUP_RETRY_MS)
      }
    })().catch(() => undefined)

    return next(e)
  })

  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const moved = await next(e)
    void traceScroll($, {
      kind: 'scroll',
      offset: e.offset,
      by: e.by,
      bodyRows: e.bodyRows,
      contentRows: e.contentRows,
      origin: e.origin.kind,
      deny: moved.deny,
    }).catch(() => undefined)

    return moved
  })

  // Closing the pane stops its polling and its redraws after tool calls.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    await markClosed($)
    // The person's close, or an unload, also cancels the startup open; a
    // plugin's close (this module's own clean-up included) does not, so it
    // never poisons a later start that wants the pane.
    if (e.origin.kind !== 'plugin') {
      isStartupCancelled = true
    }

    return next(e)
  })

  // /vault-setup: the pane, with its administration unfolded on creating or
  // registering a vault — not a conversation with the model.
  on('command.run', { command: 'vault-setup' }, async $ => {
    isStartupCancelled = false
    await update($, showAdmin, () => true)
    await openPane($)
    await refresh($)
    void checkWireguard($).catch(() => undefined)

    return { text: t('command.setupOpened') }
  })

  on('command.run', { command: 'vaults' }, async $ => {
    isStartupCancelled = false
    await openPane($)
    await refresh($)
    const err = await read($, error)

    return {
      text: !err
        ? t('command.opened')
        : isRefusal(err)
          ? t('command.openedBut', { error: err })
          : t('command.openedUnreachable', { error: err }),
    }
  })

  // The model may change the binding too: redraw after its router calls.
  // An observer, not a guard: no .catch, so a failure here fails open and the
  // tool's own result stands. Only while the pane is open or the band is drawn:
  // nobody reads the snapshot otherwise.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if ((isPaneOpen || isBandOn()) && ROUTER_TOOL.test(e.tool)) {
      background($)
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // A close (or a new start) during this drawing's reads bumps the epoch:
    // the drawing then adopts nothing.
    const drawnFor = paneEpoch
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
    if (isEnvKnown && !isOptedOut && drawnFor === paneEpoch) {
      adoptPane($)
      if (!snap && !err && reading === 0) {
        background($)
      }
    }
    const storedTab = await read($, tab)
    const current: Tab = storedTab === 'locaux' || storedTab === 'distants' ? storedTab : 'tous'
    const addTyped = await read($, addQuery)
    const order = (await read($, addSort)) === 'za' ? 'za' : 'az'
    const typed = await read($, filter)
    // A surface with no field to type in (the phone) ignores the filter: one
    // typed elsewhere would otherwise hide rows it cannot bring back.
    const query = Input ? typed.trim().toLowerCase() : ''
    const isAddShown = await read($, showAdd)
    const Select = !isPhone && 'Select' in els ? els.Select : null
    const Svg = 'Svg' in els ? els.Svg : null
    // Read so that a change of language draws the pane again.
    const languageCode = await read($, language)
    const isAdminShown = await read($, showAdmin)
    const isNavOpen = await read($, navOpen)
    const isChrome = (await read($, chromeState)) === 'on'
    if (!isChromeAsked) {
      isChromeAsked = true
      void checkChrome($).catch(() => undefined)
    }
    const form = await read($, adminForm)
    const removing = await read($, confirmRemove)
    const picked = await read($, removePick)
    const wg = await read($, wireguard)
    const languages = isAdminShown ? await availableLanguages($) : []
    const upd = await read($, updateState)
    const creating = await read($, createForm)
    const pending = await read($, pendingConventions)
    const conventions = isAdminShown ? await conventionIds($) : []
    // The tier menu's width, in the surface's cells: the longest label in the
    // current language, its badge (two cells and a space), and room for the
    // menu's own arrow and padding.
    const modeWidth = Math.max(...MODES.map(m => cells(modeLabel(m.mode)))) + 9

    // A glyph per state, the colour on top: a closed local vault is no fault
    // (opening it is one click), an unreachable remote one is. A surface that
    // draws SVG gets the marks at one size; the terminal keeps the characters.
    // Drawn in a fixed-width cell, so the names line up whatever the glyph.
    const dot = (online: boolean | null, isRemote: boolean) => (
      <Box width={2} justifyContent="center" flexShrink={0}>
        {Svg && online !== null ? (
          <Svg
            source={online ? MARK.open : isRemote ? MARK.unreachable : MARK.closed}
            alt={online ? t('alt.open') : isRemote ? t('alt.unreachable') : t('alt.closed')}
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
    // A section's title: in the body's colour and bold, so it stands apart
    // from the grey captions under it.
    const section = (text: string) => (
      <Text size="footnote" weight="semibold">
        {text}
      </Text>
    )
    // A small grey label above a group inside a section: what it is, and how many.
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
    // The vaults bound to this project, paused ones included; the ones to check
    // are the active ones that do not answer (or whose state is not known).
    const boundCount = bound.length + (snap?.paused ?? []).length
    const toCheck = bound.filter(r => r.online !== true).length
    const closedLocal = bound.filter(r => r.online === false && r.type !== 'remote').length
    const headline = snap
      ? `${tn('summary.bound', boundCount)} · ${toCheck === 0 ? t('status.allOpen') : tn('status.toCheck', toCheck)}`
      : isRefusal(err)
        ? t('summary.blocked')
        : err
          ? t('summary.unreachable')
          : t('summary.reading')

    // The panel's state in one line: how many vaults, whether they all answer,
    // when it was read; the refresh beside it. `prefix` keys a second copy
    // apart (none is drawn today).
    const statusBar = (prefix: string) => (
      <Box key={`${prefix}status`} flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} flexWrap="wrap">
        <Box flexDirection="column" flexShrink={1}>
          <Box flexDirection="row" gap={1} alignItems="center">
            {snap && <Text color={toCheck === 0 ? 'success' : 'warning'}>●</Text>}
            <Text weight="semibold">{headline}</Text>
          </Box>
          <Box paddingLeft={snap ? 2 : 0}>
            {working ? (
              <Text size="caption" color="warning">
                {working}…
              </Text>
            ) : (
              snap && (
                <Text size="caption" dimColor>
                  {t('status.updated', { time: time(snap.fetchedAt) })}
                </Text>
              )
            )}
          </Box>
        </Box>
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
          {closedLocal > 0 && (
            // Re-confirming the binding as it stands opens EVERY bound local
            // vault whose Obsidian does not answer — the router's own way, which
            // also opens one Obsidian has never listed.
            <Button
              key={`${prefix}open-closed`}
              label={closedLocal > 1 ? t('secondaries.openAll', { count: closedLocal }) : t('secondaries.openOne')}
              plain
              onPress={() =>
                void rebind(
                  $,
                  { doing: t('action.openClosed.doing'), done: t('action.openClosed.done') },
                  snap?.primary?.name ?? '',
                  current => current,
                  { isOpening: true },
                )
              }
            />
          )}
          <Button key={`${prefix}refresh`} label={t('refresh')} variant="secondary" onPress={() => background($)} />
        </Box>
      </Box>
    )
    // The menu stays at the top while the body scrolls: a copy, drawn over the
    // content at the first row the window shows, on an opaque ground, the menu
    // in the flow scrolling away under it. No `position: sticky` exists; the
    // engine asks again at every move of the window, so the copy follows it
    // (a move the terminal's engine makes on its own, a clamp or a focus kept
    // in view, waits for the next drawing). Nothing while the window is at the
    // top.
    const scrolled = Math.max(0, Math.floor(e.props.scroll?.offset ?? 0))
    if (scrolled !== lastTracedOffset) {
      lastTracedOffset = scrolled
      void traceScroll($, { kind: 'render', surface: e.surface, offset: scrolled, bodyRows: e.props.scroll?.bodyRows }).catch(
        () => undefined,
      )
    }
    const statusLine = statusBar('')
    // The menu at the top of the pane: Vaults, + Ajouter un vault, ⚙
    // Administration, the one in view marked, a rule under it. The copy pinned
    // at the first row the window shows (`sticky`) is the same line, its keys
    // under `sticky-`, on an opaque ground and no frame.
    const view: PaneView = isAdminShown ? 'admin' : isAddShown ? 'add' : 'vaults'
    const menuItem = (prefix: string, id: PaneView, label: string) =>
      id === view ? (
        <Button key={`${prefix}nav-${id}`} label={label} variant="primary" onPress={() => void showView($, id)} />
      ) : (
        <Button key={`${prefix}nav-${id}`} label={label} plain dimColor onPress={() => void showView($, id)} />
      )
    // A mark that is a control: a Button holds text only and a mark is no
    // button, so the mark is drawn and a blank Button laid over it, the one
    // the click lands on; a surface with no SVG has a glyph key instead.
    // The terminal draws no SVG (its element draws nothing there): a glyph.
    const Mark = e.surface !== 'terminal' ? Svg : null
    const iconKey = (source: string, glyph: string, key: string, onPress: () => void) =>
      Mark ? (
        <Box key={`icon-${key}`} flexDirection="row" alignItems="center" flexShrink={0}>
          <Mark source={source} alt={markAlt(source)} width={16} height={16} />
          <Box position="absolute" top={0} left={0}>
            <Button key={key} label={'  '} plain onPress={onPress} />
          </Box>
        </Box>
      ) : (
        <Button key={key} label={glyph} plain dimColor onPress={onPress} />
      )
    // The router's mark at the menu's left; the version, the update badge and
    // the repository at its right. On a pane too narrow for the three on one
    // line, they fold into "☰" and the view in sight (a press unfolds them one
    // under the other), with only the mark and the repository beside it.
    // Counted as the terminal draws them: each label in "[ ]" (4 cells), 2-cell
    // gaps, the mark (3) and what stands at the right. Nothing to add before
    // the router is read: no "+ Ajouter un vault" then.
    const menuLabels: [PaneView, string][] = [
      ['vaults', t('nav.vaults')],
      ...(snap ? [['add', t('add.open')] as [PaneView, string]] : []),
      ['admin', t('nav.admin')],
    ]
    const menuColumns = e.props.bodyColumns ?? 60
    const version = upd?.installed ? `v${upd.installed}` : ''
    const endCells =
      (version ? cells(version) + 2 : 0) + (upd?.isAvailable ? cells(t('update.badge')) + 2 : 0) + (Mark ? 3 : cells(t('footer.github')) + 1)
    const isBurger = menuLabels.reduce((sum, [, label]) => sum + cells(label) + 4 + 2, 0) + (Mark ? 3 : 0) + endCells > menuColumns
    const rule = (
      <Text dimColor wrap="truncate-end">
        {'─'.repeat(Math.max(1, menuColumns))}
      </Text>
    )
    const brand = Mark ? <Mark source={ROUTER_MARK} alt={markAlt(ROUTER_MARK)} width={22} height={22} /> : null
    const repository = (prefix: string) =>
      iconKey(GITHUB_MARK, t('footer.github'), `${prefix}github`, () => void openUrl($, REPO_URL))
    const menuEnd = (prefix: string) => (
      <Box key={`${prefix}nav-end`} flexDirection="row" gap={2} alignItems="center" flexShrink={0}>
        {version && (
          <Text size="caption" dimColor>
            {version}
          </Text>
        )}
        {upd?.isAvailable && (
          <Button key={`${prefix}update-badge`} label={t('update.badge')} plain onPress={() => void showView($, 'admin')} />
        )}
        {repository(prefix)}
      </Box>
    )
    const navMenu = (prefix: string) =>
      isBurger ? (
        <Box key={`${prefix}nav`} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
            <Box flexDirection="row" gap={1} alignItems="center">
              {brand}
              <Button
                key={`${prefix}nav-burger`}
                label={`☰ ${menuLabels.find(([id]) => id === view)?.[1] ?? ''}`}
                plain
                onPress={() => void update($, navOpen, open => !open)}
              />
            </Box>
            {repository(prefix)}
          </Box>
          {isNavOpen && (
            <Box key={`${prefix}nav-list`} flexDirection="column" paddingLeft={2}>
              {menuLabels.map(([id, label]) => menuItem(prefix, id, label))}
            </Box>
          )}
          {rule}
        </Box>
      ) : (
        <Box key={`${prefix}nav`} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2}>
            <Box flexDirection="row" gap={2} alignItems="center">
              {brand}
              {menuLabels.map(([id, label]) => menuItem(prefix, id, label))}
            </Box>
            {menuEnd(prefix)}
          </Box>
          {rule}
        </Box>
      )
    // What each mark does, under the menu: Obsidian's, Claude's, the planet —
    // or, while Claude in Chrome does not answer, how to turn it on.
    const legendItem = (key: string, source: string, glyph: string, text: string) => (
      <Box key={key} flexDirection="row" gap={1} alignItems="center">
        {Mark ? <Mark source={source} alt={markAlt(source)} width={14} height={14} /> : <Text>{glyph}</Text>}
        <Text size="caption" dimColor>
          {text}
        </Text>
      </Box>
    )
    const legend = (
      <Box key="legend" flexDirection="row" flexWrap="wrap" columnGap={2} alignItems="center">
        {legendItem('legend-obsidian', OBSIDIAN_MARK, '💎', t('legend.obsidian'))}
        <Text size="caption" dimColor>
          |
        </Text>
        {legendItem('legend-claude', CLAUDE_PANE_MARK, '✳', t('legend.claude'))}
        <Text size="caption" dimColor>
          |
        </Text>
        {isChrome ? (
          legendItem('legend-chrome', GLOBE_MARK, '🌐', t('legend.chrome'))
        ) : (
          <Box key="legend-chrome-off" flexDirection="row" gap={1} alignItems="center">
            <Text size="caption" dimColor>
              {t('legend.chromeOff')}
            </Text>
            <Button key="legend-chrome-enable" label={t('legend.chromeEnable')} plain onPress={() => void showView($, 'admin')} />
          </Box>
        )}
      </Box>
    )
    const sticky =
      scrolled > 0 ? (
        <Box key="sticky-bar" position="absolute" top={scrolled} left={0} right={0} flexDirection="column" backgroundColor="inverseText">
          {navMenu('sticky-')}
        </Box>
      ) : null

    // At the bottom: the administration console's fold (the version, the
    // repository and the update badge are in the menu).
    const footer = (
      <Box key="pane-footer" flexDirection="row" justifyContent="flex-end" alignItems="center" gap={1} flexWrap="wrap">
        <Button
          key="toggle-admin"
          label={isAdminShown ? t('footer.back') : t('footer.admin')}
          variant="secondary"
          onPress={() =>
            void update($, showAdmin, shownNow => !shownNow).then(async () => {
              if (await read($, showAdmin)) {
                await checkWireguard($)
              } else {
                // Folded: a key typed but not sent is dropped.
                await update($, adminForm, now => (now.apiKey ? { ...now, apiKey: '' } : now))
              }
            })
          }
        />
      </Box>
    )

    const problems = (
      <Box flexDirection="column">
        {!!err && <Text color="error">{snap || isRefusal(err) ? err : t('error.unreachable', { error: err })}</Text>}
        {!!failed && failed !== err && <Text color="error">{failed}</Text>}
      </Box>
    )

    // The administration console: the language, WireGuard, registering and
    // removing a vault. Built before the snapshot check: the language and
    // WireGuard are of use while the router does not answer.
    const field = (key: keyof AdminForm, title: string, placeholder = '') =>
      Input ? (
        <Box key={`field-${key}`} flexDirection="column">
          <Text size="caption" dimColor>
            {title}
          </Text>
          <Input
            key={`admin-${key}`}
            placeholder={placeholder}
            value={String(form[key])}
            submitLabel={t('register.enter')}
            onInput={(value: string) => void update($, adminForm, now => ({ ...now, [key]: value }))}
            onSubmit={() => void registerVault($)}
          />
        </Box>
      ) : null
    const choice = <V extends string>(key: string, options: { value: V; label: string }[], value: V, pick: (v: V) => void) => (
      <Box key={key} flexDirection="row" flexWrap="wrap" gap={1}>
        {options.map(o => (
          <Button
            key={`${key}-${o.value}`}
            label={o.label}
            variant={o.value === value ? 'primary' : 'secondary'}
            onPress={() => pick(o.value)}
          />
        ))}
      </Box>
    )
    const wgLine =
      !wg || wg.state === 'checking'
        ? t('wg.checking')
        : wg.state === 'active'
          ? wg.tunnels.length > 0
            ? t('wg.active', { tunnels: wg.tunnels.join(', ') })
            : t('wg.activeNoName')
          : wg.state === 'inactive'
            ? t('wg.inactive')
            : wg.state === 'absent'
              ? t('wg.absent')
              : t('wg.unknown')
    const removable = snap ? snap.available : []
    // The console's sections (the redesign): each a framed card under its grey
    // title; side by side, three to a line, in a wide pane.
    const cardColumns = e.props.bodyColumns ?? 60
    const cardWidth = (() => {
      for (let n = 3; n > 1; n -= 1) {
        const width = Math.floor((cardColumns - (n - 1)) / n)
        if (width >= 40) {
          return width
        }
      }

      return Math.max(40, cardColumns)
    })()
    const card = (key: string, title: string, body: unknown) => (
      <Box key={key} flexDirection="column" width={cardWidth} minWidth={Math.min(cardWidth, 30)}>
        <Text size="footnote" weight="semibold" dimColor>
          {title}
        </Text>
        <Box key={`${key}-card`} flexDirection="column" gap={1} borderStyle="bold" borderColor="inactive" paddingX={1}>
          {body as never}
        </Box>
      </Box>
    )
    // Two or more choices side by side, the one in force framed and lit.
    const toggle = <V extends string>(key: string, options: { value: V; label: string; mark?: string }[], value: V, pick: (v: V) => void) => (
      <Box key={key} flexDirection="row" flexWrap="wrap" gap={1}>
        {options.map(o => (
          <Box
            key={`${key}-box-${o.value}`}
            flexDirection="row"
            gap={1}
            alignItems="center"
            borderStyle="round"
            borderDimColor={o.value !== value}
            backgroundColor={o.value === value ? 'diffAddedDimmed' : undefined}
            paddingX={1}
          >
            {o.mark && Svg && <Svg source={o.mark} alt={markAlt(o.mark)} width={14} height={14} />}
            <Button key={`${key}-${o.value}`} label={o.label} plain dimColor={o.value !== value} onPress={() => pick(o.value)} />
          </Box>
        ))}
      </Box>
    )
    const isUpToDate = !!upd?.installed && !!upd.latest && !upd.isAvailable
    const admin = (
      <Box key="admin" flexDirection="row" flexWrap="wrap" gap={1}>
        {isAdminShown && [
          card(
            'admin-general',
            t('admin.general'),
            <Box key="admin-general-body" flexDirection="column" gap={1}>
            <Box key="admin-language" flexDirection="column">
              <Text size="caption" dimColor>
                {t('admin.language')}
              </Text>
              {Select ? (
                <Select
                  key="admin-language-select"
                  options={languages.map(l => ({ value: l.code, label: l.name }))}
                  value={languageCode}
                  onSelect={(code: string) => void setLanguage($, code)}
                />
              ) : (
                choice('admin-language-choice', languages.map(l => ({ value: l.code, label: l.name })), languageCode, code =>
                  void setLanguage($, code),
                )
              )}
            </Box>

            <Box key="admin-update" flexDirection="column" gap={1}>
              <Box key="admin-update-line" flexDirection="row" flexWrap="wrap" gap={1} alignItems="center">
                <Text size="caption" dimColor>
                  {t('admin.plugin')}
                </Text>
                {upd?.installed && <Text>v{upd.installed}</Text>}
                {isUpToDate && <Text color="success">●</Text>}
                <Text size="caption" color={upd?.isAvailable ? 'warning' : undefined} dimColor={!upd?.isAvailable}>
                  {!upd?.installed || !upd.latest
                    ? t('update.unknown')
                    : upd.isAvailable
                      ? t('update.versions', { installed: upd.installed, latest: upd.latest })
                      : t('admin.upToDate')}
                </Text>
                <Button key="update-check" label={t('update.check')} plain dimColor onPress={() => void checkUpdate($)} />
              </Box>
              {upd?.isAvailable && (
                <Box key="admin-update-actions" flexDirection="row">
                  <Button key="update-run" label={t('update.button')} variant="primary" onPress={() => void updatePlugin($)} />
                </Box>
              )}
              {upd?.log && (
                <Text size="caption" color={upd.log.startsWith(t('update.failed', { error: '' }).trim()) ? 'error' : 'success'}>
                  {upd.log}
                </Text>
              )}
            </Box>
            </Box>,
          ),
          card(
            'admin-chrome',
            t('admin.chrome'),
            <Box key="admin-chrome-body" flexDirection="column" gap={1}>
              <Text size="caption" color={isChrome ? 'success' : 'warning'}>
                {isChrome ? t('admin.chromeOn') : t('admin.chromeOff')}
              </Text>
              <Button key="chrome-check" label={t('admin.chromeCheck')} plain dimColor onPress={() => void checkChrome($)} />
            </Box>,
          ),
          card(
            'admin-create',
            t('create.title'),
            !Input ? (
                <Text size="caption" dimColor>
                  {t('register.phone')}
                </Text>
              ) : (
                <Box key="admin-create-form" flexDirection="column" gap={1}>
                  <Box key="create-name" flexDirection="column">
                    <Text size="caption" dimColor>
                      {t('create.name')}
                    </Text>
                    <Input
                      key="create-name-field"
                      value={creating.name}
                      submitLabel={t('register.enter')}
                      onInput={(value: string) => void update($, createForm, now => ({ ...now, name: value }))}
                      onSubmit={() => void createVault($, snap?.defaultRoot)}
                    />
                  </Box>
                  <Box key="create-path" flexDirection="column">
                    <Text size="caption" dimColor>
                      {t('create.path')}
                    </Text>
                    <Input
                      key="create-path-field"
                      value={creating.path}
                      placeholder={
                        snap?.defaultRoot
                          ? `${snap.defaultRoot}${snap.defaultRoot.includes('\\') ? '\\' : '/'}${creating.name.trim() || '…'}`
                          : ''
                      }
                      submitLabel={t('register.enter')}
                      onInput={(value: string) => void update($, createForm, now => ({ ...now, path: value }))}
                      onSubmit={() => void createVault($, snap?.defaultRoot)}
                    />
                  </Box>
                  <Text size="caption" dimColor>
                    {t('create.mode')}
                  </Text>
                  {toggle<CreateForm['mode']>(
                    'create-mode',
                    (['personal', 'research', 'business', 'code'] as const).map(mode => ({ value: mode, label: t(`create.mode.${mode}`) })),
                    creating.mode,
                    mode => void update($, createForm, now => ({ ...now, mode })),
                  )}
                  <Box key="create-conventions-head" flexDirection="row" flexWrap="wrap" gap={1} alignItems="center">
                    <Text size="caption" dimColor>
                      {t('create.conventions')}
                    </Text>
                    <Text size="caption">
                      {t('create.conventionsCount', {
                        count: creating.conventions.filter(id => conventions.includes(id)).length,
                        total: conventions.length,
                      })}
                    </Text>
                    <Button
                      key="conventions-all"
                      label={t('create.conventionsAll')}
                      plain
                      dimColor
                      onPress={() => void update($, createForm, now => ({ ...now, conventions: [...conventions] }))}
                    />
                    <Button
                      key="conventions-none"
                      label={t('create.conventionsNone')}
                      plain
                      dimColor
                      onPress={() => void update($, createForm, now => ({ ...now, conventions: [] }))}
                    />
                  </Box>
                  <Box key="create-conventions" flexDirection="row" flexWrap="wrap" columnGap={2}>
                    {conventions.map(id => (
                      <Button
                        key={`convention-${id}`}
                        label={`${creating.conventions.includes(id) ? '✓' : '·'} ${id}`}
                        plain
                        dimColor={!creating.conventions.includes(id)}
                        onPress={() =>
                          void update($, createForm, now => ({
                            ...now,
                            conventions: now.conventions.includes(id)
                              ? now.conventions.filter(c => c !== id)
                              : [...now.conventions, id],
                          }))
                        }
                      />
                    ))}
                  </Box>
                  {creating.conventions.includes('languages') && (
                    <Box key="create-languages" flexDirection="column">
                      <Text size="caption" dimColor>
                        {t('create.languages')}
                      </Text>
                      <Input
                        key="create-languages-field"
                        value={creating.languages}
                        placeholder={languageCode}
                        submitLabel={t('register.enter')}
                        onInput={(value: string) => void update($, createForm, now => ({ ...now, languages: value }))}
                        onSubmit={() => void createVault($, snap?.defaultRoot)}
                      />
                    </Box>
                  )}
                  <Button
                    key="create-bind"
                    label={`${creating.bind ? '☑' : '☐'} ${t('create.bind')}`}
                    plain
                    onPress={() => void update($, createForm, now => ({ ...now, bind: !now.bind }))}
                  />
                  <Box key="create-actions" flexDirection="row" flexWrap="wrap" gap={1}>
                    <Button key="create-submit" label={t('create.submit')} variant="primary" onPress={() => void createVault($, snap?.defaultRoot)} />
                    {pending && (
                      <Button
                        key="create-conventions-retry"
                        label={t('create.conventionsRetry')}
                        onPress={() => {
                          // What the field says now, so a wrong code can be corrected.
                          const codes = pending.ids.includes('languages') ? languagesOf(creating.languages) : []
                          if (!codes) {
                            void update($, failure, () => t('create.invalidLanguages'))

                            return
                          }
                          void installConventions($, pending.vault, pending.ids, codes)
                        }}
                      />
                    )}
                  </Box>
                </Box>
              ),
          ),
          card(
            'admin-wireguard',
            t('wg.title'),
            <Box key="admin-wireguard-body" flexDirection="column" gap={1}>
              <Box key="admin-wireguard-line" flexDirection="row" flexWrap="wrap" gap={1} alignItems="center">
                {wg?.state === 'active' && <Text color="success">●</Text>}
                <Text size="caption" color={wg?.state === 'active' ? undefined : wg?.state === 'checking' || !wg ? undefined : 'warning'} dimColor={!wg || wg.state === 'checking'}>
                  {wgLine}
                </Text>
                <Button key="wg-check" label={t('wg.check')} plain dimColor onPress={() => void checkWireguard($)} />
              </Box>
              <Box key="admin-wireguard-actions" flexDirection="row" flexWrap="wrap" gap={1}>
                {wg?.state === 'inactive' && (
                  <Button key="wg-open" label={t('wg.openApp')} variant="primary" onPress={() => void openWireguard($)} />
                )}
                {wg?.state === 'absent' && (
                  <Button key="wg-install" label={t('wg.install')} variant="primary" onPress={() => void openUrl($, WG_INSTALL_URL)} />
                )}
                <Button key="wg-guide" label={t('wg.guide')} plain onPress={() => void openUrl($, GUIDE_URL)} />
                <Button key="wg-prompt" label={t('wg.prompt')} plain onPress={() => void openUrl($, PROMPT_URL)} />
              </Box>
            </Box>,
          ),
          card(
            'admin-register',
            t('register.title'),
            !Input ? (
                <Text size="caption" dimColor>
                  {t('register.phone')}
                </Text>
              ) : (
                <Box key="admin-register-form" flexDirection="column" gap={1}>
                  {toggle<AdminForm['kind']>(
                    'admin-kind',
                    [
                      { value: 'local', label: t('register.kindLocal'), mark: OBSIDIAN_MARK },
                      { value: 'remote', label: t('register.kindRemote'), mark: GLOBE_MARK },
                    ],
                    form.kind,
                    kind =>
                      void update($, adminForm, now => ({
                        ...now,
                        kind,
                        host: kind === 'local' ? '127.0.0.1' : '10.8.0.1',
                        scheme: kind === 'local' ? ('https' as const) : ('http' as const),
                      })),
                  )}
                  <Text size="caption" dimColor>
                    {form.kind === 'local'
                      ? t('register.descLocal')
                      : wg?.state === 'active' && wg.tunnels.length > 0
                        ? t('register.descRemoteTunnel', { tunnel: wg.tunnels.join(', ') })
                        : t('register.descRemote')}
                  </Text>
                  {field('name', t('register.name'))}
                  <Box key="admin-address" flexDirection="row" gap={1} flexWrap="wrap">
                    <Box key="admin-host-box" flexGrow={1} flexShrink={1} minWidth={16}>
                      {field('host', form.kind === 'local' ? t('register.host') : t('register.hostWg'), form.kind === 'local' ? '127.0.0.1' : '10.8.0.1')}
                    </Box>
                    <Box key="admin-port-box" width={12} minWidth={10} flexShrink={0}>
                      {field('port', t('register.port'), form.kind === 'local' ? '27124' : '27180')}
                    </Box>
                  </Box>
                  <Text size="caption" dimColor>
                    {t('register.protocol')}
                  </Text>
                  {toggle<AdminForm['scheme']>(
                    'admin-scheme',
                    [
                      { value: 'https', label: t('register.https') },
                      { value: 'http', label: t('register.http') },
                    ],
                    form.scheme,
                    scheme => void update($, adminForm, now => ({ ...now, scheme })),
                  )}
                  {form.kind === 'remote' && field('uiPort', t('register.uiPort'), '3001')}
                  {field('apiKey', t('register.apiKey'))}
                  <Text size="caption" dimColor>
                    {t('register.keyNote')}
                  </Text>
                  {form.kind === 'remote' && (wg?.state === 'inactive' || wg?.state === 'absent') && (
                    <Text size="caption" color="warning">
                      {t('register.needWireguard')}
                    </Text>
                  )}
                  <Box key="admin-register-actions" flexDirection="row">
                    <Button key="admin-register-submit" label={t('register.submit')} variant="primary" onPress={() => void registerVault($)} />
                  </Box>
                </Box>
              ),
          ),
          card(
            'admin-unregister',
            t('unregister.title'),
            <Box key="admin-unregister-body" flexDirection="column" gap={1}>
              {removable.length === 0 && (
                <Text size="caption" dimColor>
                  {t('unregister.none')}
                </Text>
              )}
              {Select && removable.length > 0 && (
                <Box key="admin-remove" flexDirection="column" gap={1}>
                  {removing ? (
                    <Box key="admin-remove-ask" flexDirection="row" flexWrap="wrap" gap={1} alignItems="center">
                      <Text color="warning">{t('unregister.ask', { name: removing })}</Text>
                      <Button key="admin-remove-confirm" label={t('unregister.confirm')} variant="primary" onPress={() => void unregisterVault($, removing)} />
                      <Button key="admin-remove-cancel" label={t('unregister.cancel')} plain dimColor onPress={() => void update($, confirmRemove, () => null)} />
                    </Box>
                  ) : (
                    <Box key="admin-remove-pick" flexDirection="row" flexWrap="wrap" gap={1} alignItems="center">
                      <Select
                        key="admin-remove-select"
                        options={removable.map(v => ({
                          value: v.name,
                          label: `${v.name} (${v.type === 'remote' ? t('place.remote') : t('place.local')})`,
                        }))}
                        value={picked && removable.some(v => v.name === picked) ? picked : removable[0]!.name}
                        onSelect={(name: string) => void update($, removePick, () => name)}
                      />
                      <Button
                        key="admin-remove-button"
                        label={t('unregister.button')}
                        onPress={() =>
                          void update($, confirmRemove, () =>
                            picked && removable.some(v => v.name === picked) ? picked : removable[0]!.name,
                          )
                        }
                      />
                    </Box>
                  )}
                </Box>
              )}
              {!Select && removable.map(v => (
                <Box key={`rm-${v.name}`} flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" columnGap={1}>
                  <Box flexDirection="row" gap={1} flexShrink={1} alignItems="center">
                    {dot(v.online, v.type === 'remote')}
                    <Text wrap="truncate-end">{v.name}</Text>
                    <Text size="caption" dimColor>
                      {v.type === 'remote' ? t('place.remote') : t('place.local')}
                    </Text>
                  </Box>
                  {removing === v.name ? (
                    <Box key={`rm-confirm-${v.name}`} flexDirection="row" gap={1}>
                      <Button key={`unregister-confirm-${v.name}`} label={t('unregister.confirm')} variant="primary" onPress={() => void unregisterVault($, v.name)} />
                      <Button key={`unregister-cancel-${v.name}`} label={t('unregister.cancel')} plain dimColor onPress={() => void update($, confirmRemove, () => null)} />
                    </Box>
                  ) : (
                    <Button key={`unregister-${v.name}`} label={t('unregister.button')} plain dimColor onPress={() => void update($, confirmRemove, () => v.name)} />
                  )}
                </Box>
              ))}
              <Text size="caption" dimColor>
                {t('unregister.hint')}
              </Text>
            </Box>,
          ),
        ]}
      </Box>
    )

    // The console open, it is the pane's whole content: the vaults wait behind
    // "‹ Retour aux vaults" in the footer.
    if (isAdminShown) {
      // What the vaults view would say on top, said here too: the operation
      // under way, and every remote vault silent at once.
      const remoteRows = snap ? [...bound, ...snap.available].filter(isRemote) : []
      const areRemotesDown = remoteRows.length > 0 && remoteRows.every(r => r.online === false)

      return (
        <Box flexDirection="column" gap={1}>
          {navMenu('')}
          {working && (
            <Text size="caption" color="warning">
              {working}…
            </Text>
          )}
          {areRemotesDown && (
            <Text color="warning">
              {wg?.state === 'inactive' ? t('wg.inactive') : wg?.state === 'absent' ? t('wg.absent') : t('tunnel.down')}
            </Text>
          )}
          {problems}
          {admin}
          {footer}
          {sticky}
        </Box>
      )
    }
    if (!snap) {
      return (
        <Box flexDirection="column" gap={1}>
          {navMenu('')}
          {statusLine}
          {problems}
          {footer}
          {sticky}
        </Box>
      )
    }

    // The primary every binding button was drawn for: rebind refuses another.
    const shown = snap.primary?.name ?? ''
    const matches = (r: VaultRow) => !query || r.name.toLowerCase().includes(query)

    // A drawn mark before a link (a Button holds text only, so the mark sits
    // beside it); a surface without SVG draws the link alone.
    const mark = (source: string) => (Svg ? <Svg source={source} alt={markAlt(source)} width={14} height={14} /> : null)
    // Where a vault opens, as its marks alone — the legend under the menu says
    // what each one does: Obsidian's for a local vault, Claude's (its own
    // browser) and the planet (Chrome, while Claude in Chrome answers) for a
    // remote one. A remote one that does not answer says so, with a retry; a
    // local one Obsidian has never listed says to open it once by hand.
    const links = (row: VaultRow) => {
      if (isRemote(row)) {
        // Its REST API silent: said, with a retry. Its web UI may answer all
        // the same, so its marks stay.
        const down =
          row.online === false
            ? [
                <Text key={`down-${row.name}`} size="caption" color="error">
                  {t('secondaries.unreachable')}
                </Text>,
                <Button key={`retry-${row.name}`} label={t('link.retry')} plain onPress={() => background($)} />,
              ]
            : []

        return [
          ...(row.uiUrl
            ? [
                ...(isChrome ? [iconKey(GLOBE_MARK, '🌐', `web-${row.name}`, () => void openInChrome($, row))] : []),
                iconKey(CLAUDE_PANE_MARK, '✳', `ui-${row.name}`, () => void openUi($, row)),
              ]
            : []),
          ...down,
        ]
      }
      if (!row.path) {
        return []
      }
      if (row.isKnownToObsidian === false) {
        return [
          <Text key={`once-${row.name}`} size="caption" color="warning">
            {t('obsidian.openOnce')}
          </Text>,
        ]
      }

      return [iconKey(OBSIDIAN_MARK, '💎', `obsidian-${row.name}`, () => void openInObsidian($, row))]
    }

    // The tiles' grid, from the pane's width: as many per line as fit at the
    // least width, up to three bound vaults and four to add; one per line in
    // the narrow side panel.
    const columns = e.props.bodyColumns ?? 60
    const fit = (most: number, least: number) => {
      for (let n = most; n > 1; n -= 1) {
        const width = Math.floor((columns - (n - 1)) / n)
        if (width >= least) {
          return width
        }
      }

      return Math.max(least, columns)
    }
    // Wide enough for the tier's radios where the pane allows, never wider than
    // the pane: a narrow one cuts the longest label instead.
    const boundWidth = fit(3, Math.min(Math.max(TILE_WIDTH, modeWidth + 4), columns))
    // A tile to add holds less, but not so little that two squeeze in the side panel.
    const addWidth = fit(4, TILE_WIDTH + 4)
    // A vault's tile: its state and name on top, with what acts on the tile
    // as a whole on the right; then its lines, each wrapping inside it.
    const tile = (
      key: string,
      row: VaultRow,
      right: unknown,
      lines: unknown[],
      opts: { width: number; isDim?: boolean; isHighlighted?: boolean; foot?: unknown },
    ) => (
      <Box
        key={key}
        flexDirection="column"
        width={opts.width}
        minWidth={opts.width}
        borderStyle="bold"
        borderColor={opts.isHighlighted ? 'claude' : 'inactive'}
        paddingX={1}
      >
        <Box key={`${key}-head`} flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1}>
            {dot(row.online, isRemote(row))}
            <Text weight="semibold" dimColor={opts.isDim || row.online === false} wrap="truncate-end">
              {row.name}
            </Text>
          </Box>
          {right as never}
        </Box>
        {lines.filter(line => !(Array.isArray(line) && line.length === 0)).map((line, i) => (
          <Box
            key={i === 0 ? `${key}-controls` : `${key}-line-${i}`}
            flexDirection="row"
            flexWrap="wrap"
            gap={1}
            alignItems="center"
            paddingLeft={2}
          >
            {line as never}
          </Box>
        ))}
        {opts.foot !== undefined && (
          // The tile's action, at its bottom right: a spacer takes what height
          // the row's tallest tile leaves, then the foot sits on its own line.
          // Keyed before the tile's key, never after: "av-x-foot" would be the
          // tile of a vault named "x-foot".
          <Box key={`spacer-${key}`} flexGrow={1} />
        )}
        {opts.foot !== undefined && (
          <Box key={`foot-${key}`} flexDirection="row" justifyContent="flex-end" alignItems="center">
            {opts.foot as never}
          </Box>
        )}
      </Box>
    )
    // Tiles side by side, wrapping to the next line when the pane is narrow.
    const grid = (key: string, tiles: unknown[]) => (
      <Box key={key} flexDirection="row" flexWrap="wrap" gap={1}>
        {tiles as never}
      </Box>
    )

    const primary = (
      <Box flexDirection="column" gap={1}>
        {section(t('primary.title'))}
        {snap.primary ? (
          tile(
            'primary-row',
            snap.primary,
            <Box key="primary-badge" flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
              <Text color="claude">●</Text>
              <Text size="caption">{t('primary.badge')}</Text>
            </Box>,
            [
              links(snap.primary),
              <Text key="primary-access" size="caption" dimColor>
                {snap.isLocked ? t('primary.locked') : t('primary.access')}
              </Text>,
            ],
            { width: boundWidth, isHighlighted: true },
          )
        ) : (
          <Box key="primary-none" flexDirection="row" flexWrap="wrap" gap={1} alignItems="center">
            <Text color="warning">{t('primary.none')}</Text>
            <Button key="primary-setup" label={t('primary.setup')} variant="primary" onPress={() => void update($, showAdmin, () => true)} />
          </Box>
        )}
        {snap.isImported && snap.primary && (
          <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
            <Text size="caption" color="warning">
              {t('primary.imported')}
            </Text>
            <Button
              key="confirm-binding"
              label={t('primary.confirm')}
              plain
              onPress={() =>
                void rebind($, { doing: t('action.confirm.doing'), done: t('action.confirm.done') }, shown, current => current)
              }
            />
          </Box>
        )}
        {snap.isLocked && (
          <Text size="caption" color="warning">
            {t('primary.sessionLocked')}
          </Text>
        )}
        {snap.lockedTo && (
          <Text size="caption" color="warning">
            {t('primary.routerLocked', { vault: snap.lockedTo })}
          </Text>
        )}
      </Box>
    )

    // One secondary, one line where the pane is wide enough: where it stands,
    // its write tier as one menu, and the two links it may need. Narrower, the
    // controls wrap to a second line, indented under the name.
    const setMode = (s: Secondary, value: string) => {
      const next = MODES.find(m => m.mode === value)
      if (next && next.mode !== s.mode) {
        void act($, {
          doing: t('action.mode.doing', { name: s.name, mode: modeLabel(next.mode).toLowerCase() }),
          done: t('action.mode.done', { name: s.name, mode: modeLabel(next.mode).toLowerCase() }),
          tool: 'set_secondary_vault_mode',
          args: () => ({ vault: s.name, mode: next.mode }),
          shows: snap => ({
            ...snap,
            secondaries: snap.secondaries.map(r => (r.name === s.name ? { ...r, mode: next.mode } : r)),
            paused: (snap.paused ?? []).map(r => (r.name === s.name ? { ...r, mode: next.mode } : r)),
          }),
        })
      }
    }
    // A secondary's state, as two keys side by side: ▶ Actif and ❚❚ Pause, the
    // one in force on a tinted ground (green, soft red): a ground the desktop
    // draws, where a native button keeps no colour of its own text.
    const stateSwitch = (s: Secondary, isPaused: boolean) => (
      <Box key={`state-${s.name}`} flexDirection="row" alignItems="center">
        <Box key={`state-on-${s.name}`} backgroundColor={isPaused ? undefined : 'diffAddedDimmed'}>
          <Button
            key={`resume-${s.name}`}
            label={t('state.active')}
            plain
            dimColor={isPaused}
            onPress={() => {
              if (isPaused) {
                void setPaused($, s, false)
              }
            }}
          />
        </Box>
        <Box key={`state-off-${s.name}`} backgroundColor={isPaused ? 'diffRemovedDimmed' : undefined}>
          <Button
            key={`pause-${s.name}`}
            label={t('state.pause')}
            plain
            dimColor={!isPaused}
            onPress={() => {
              if (!isPaused) {
                void setPaused($, s, true)
              }
            }}
          />
        </Box>
      </Box>
    )
    // Its write tier as three radio buttons under a title, the one in force
    // marked ◉ and lit, the others ○ and dim; a press sets it.
    const tierMenu = (s: Secondary) => (
      <Box key={`mode-${s.name}`} flexDirection="column" flexShrink={1}>
        <Text size="caption" dimColor>
          {t('mode.radioTitle')}
        </Text>
        {MODES.map(m => (
          <Button
            key={`tier-${m.mode}-${s.name}`}
            label={`${s.mode === m.mode ? '◉' : '○'} ${m.icon} ${modeLabel(m.mode)}`}
            plain
            dimColor={s.mode !== m.mode}
            onPress={() => setMode(s, m.mode)}
          />
        ))}
      </Box>
    )
    // A secondary's tile, paused or not, in its place: ✕ removes it from the
    // project, the links open it, the menu sets its tier, the switch pauses it.
    const secondaryTile = (s: Secondary, isPaused: boolean) =>
      tile(
        `sec-${s.name}`,
        s,
        <Button
          key={`remove-${s.name}`}
          label="✕"
          plain
          dimColor
          onPress={() =>
            void rebind(
              $,
              { doing: t('action.remove.doing', { name: s.name }), done: t('action.remove.done', { name: s.name }) },
              shown,
              current => current.filter(n => n !== s.name),
              {
                shows: snap => ({
                  ...snap,
                  secondaries: snap.secondaries.filter(r => r.name !== s.name),
                  paused: (snap.paused ?? []).filter(r => r.name !== s.name),
                }),
              },
            )
          }
        />,
        [links(s), [tierMenu(s), stateSwitch(s, isPaused)]],
        { width: boundWidth, isDim: isPaused },
      )

    // Every secondary in the binding's own order, the paused ones in their place.
    const rank = (name: string) => {
      const at = (snap.order ?? []).indexOf(name)

      return at === -1 ? Number.MAX_SAFE_INTEGER : at
    }
    const allSecondaries = [
      ...snap.secondaries.map(row => ({ row, isPaused: false })),
      ...(snap.paused ?? []).map(row => ({ row, isPaused: true })),
    ].sort((x, y) => rank(x.row.name) - rank(y.row.name))
    const shownSecondaries = allSecondaries.filter(entry => matches(entry.row))

    const secondaries = (
      <Box flexDirection="column" gap={1}>
        <Box key="secondaries-head" flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} flexWrap="wrap">
          {section(t('secondaries.title', { count: allSecondaries.length }))}
          {Input && allSecondaries.length > 0 && (
            <Box key="filter-box" width={22} minWidth={16} flexShrink={1}>
              <Input
                key="filter"
                placeholder={t('filter.placeholder')}
                value={typed}
                submitLabel={t('filter.submit')}
                onInput={(value: string) => void update($, filter, () => value)}
                onSubmit={(value: string) => void update($, filter, () => value)}
              />
            </Box>
          )}
        </Box>
        {allSecondaries.length === 0 && (
          <Text size="caption" dimColor>
            {t('secondaries.none')}
          </Text>
        )}
        {allSecondaries.length > 0 && shownSecondaries.length === 0 && (
          <Text size="caption" dimColor>
            {t('secondaries.noMatch')}
          </Text>
        )}
        {shownSecondaries.length > 0 &&
          grid(
            'sec-tiles',
            shownSecondaries.map(({ row, isPaused }) => secondaryTile(row, isPaused)),
          )}
      </Box>
    )

    // Adding: folded away until asked for — unless there is no primary yet,
    // which is the one thing the pane cannot do without. Then: all, local or
    // remote ones, a search and an order, as tiles.
    const remotes = snap.available.filter(isRemote)
    const locals = snap.available.filter(v => !isRemote(v))
    const isTunnelDown =
      [...bound, ...remotes].some(isRemote) && [...bound, ...remotes].filter(isRemote).every(r => r.online === false)
    const isAddOpen = isAddShown || !snap.primary
    const searched = Input ? addTyped.trim().toLowerCase() : ''
    const list = (current === 'locaux' ? locals : current === 'distants' ? remotes : snap.available)
      .filter(v => !searched || v.name.toLowerCase().includes(searched))
      .sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }) * (order === 'za' ? -1 : 1))
    const tabs: { id: Tab; label: string }[] = [
      { id: 'tous', label: t('add.tabAll', { count: snap.available.length }) },
      { id: 'locaux', label: t('add.tabLocal', { count: locals.length }) },
      { id: 'distants', label: t('add.tabRemote', { count: remotes.length }) },
    ]
    const placeOf = (v: VaultRow) =>
      isRemote(v) ? t('link.remoteShort') : v.online === true ? t('add.localOpen') : t('link.localShort')
    const adding = isAddOpen ? (
      <Box flexDirection="column" gap={1}>
        <Box key="add-head" flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} flexWrap="wrap">
          <Box flexDirection="row" gap={1} alignItems="center">
            {section(snap.primary ? t('add.title') : t('add.titlePrimary'))}
            <Text size="caption" dimColor>
              {tn('add.count', snap.available.length)}
            </Text>
          </Box>
          {snap.primary && (
            <Button key="toggle-add" label={t('add.close')} plain dimColor onPress={() => void update($, showAdd, () => false)} />
          )}
        </Box>
        {/* Three real buttons (the open one is the primary one, so which list
            shows is plain at a glance), then the search and the order: one line
            in a wide pane, wrapping in the side panel. */}
        <Box key="add-bar" flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
        <Box key="tabs" flexDirection="row" gap={1} flexWrap="wrap">
          {tabs.map(one => (
            <Button
              key={`tab-${one.id}`}
              label={one.label}
              variant={current === one.id ? 'primary' : 'secondary'}
              onPress={() => void update($, tab, () => one.id)}
            />
          ))}
        </Box>
        {(Input || Select) && (
          <Box key="add-tools" flexDirection="row" gap={1} alignItems="center" flexWrap="wrap" flexGrow={1} flexShrink={1}>
            {Input && (
              <Box key="add-search-box" flexGrow={1} flexShrink={1} minWidth={16}>
                <Input
                  key="add-search"
                  placeholder={t('add.search')}
                  value={addTyped}
                  submitLabel={t('add.filter')}
                  onInput={(value: string) => void update($, addQuery, () => value)}
                  onSubmit={(value: string) => void update($, addQuery, () => value)}
                />
              </Box>
            )}
            {Select && (
              <Box key="add-sort-box" width={10} minWidth={10} flexShrink={0}>
                <Select
                  key="add-sort"
                  options={[
                    { value: 'az', label: t('add.sortAz') },
                    { value: 'za', label: t('add.sortZa') },
                  ]}
                  value={order}
                  onSelect={(value: string) => void update($, addSort, () => (value === 'za' ? 'za' : 'az'))}
                />
              </Box>
            )}
          </Box>
        )}
        </Box>
        {list.length === 0 && (
          <Text size="caption" dimColor>
            {t('add.noMatch')}
          </Text>
        )}
        {grid(
          'av-tiles',
          list.map(v =>
            tile(
              `av-${v.name}`,
              v,
              null,
              [
                // Where it opens — a vault can be looked at before it is added.
                <Box key={`av-where-${v.name}`} flexDirection="row" gap={1} alignItems="center" flexWrap="wrap" flexShrink={1}>
                  {links(v)}
                </Box>,
              ],
              {
                width: addWidth,
                // The one action, "+ Ajouter", plain to see at the tile's bottom right.
                foot: (
                  snap.primary ? (
                    <Button
                      key={`add-${v.name}`}
                      label={t('add.button')}
                      variant="secondary"
                      onPress={() =>
                        void rebind(
                          $,
                          { doing: t('action.add.doing', { name: v.name }), done: t('action.add.done', { name: v.name }) },
                          shown,
                          current => (current.includes(v.name) ? current : [...current, v.name]),
                          {
                            shows: snap => ({
                              ...snap,
                              // Already a secondary (another session added it, the retry
                              // kept it): the tile on screen, tier and all, stays as is.
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
                    <Button key={`primary-${v.name}`} label={t('add.primaryButton')} variant="secondary" onPress={() => void choosePrimary($, v.name)} />
                  )
                ),
              },
            ),
          ),
        )}
      </Box>
    ) : (
      <Box key="add-row" flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
        <Button key="toggle-add" label={t('add.open')} variant="secondary" onPress={() => void update($, showAdd, () => true)} />
        <Text size="caption" dimColor>
          {tn('add.count', snap.available.length)}
        </Text>
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {navMenu('')}
        {legend}
        {statusLine}
        {problems}
        {isTunnelDown && (
          // Every remote vault silent at once: the tunnel, not the vaults. Said
          // from WireGuard's own state when the pane could read it (off, or
          // not installed, with the button that helps), else only guessed
          // (hence "semble"). A tunnel that is off while the remote vaults
          // answer is not nagged about: they come some other way.
          <Box key="tunnel-down" flexDirection="column" gap={1} borderStyle="round" borderColor="warning" paddingX={1}>
            <Text color="warning" weight="semibold">
              {wg?.state === 'inactive' ? t('wg.inactive') : wg?.state === 'absent' ? t('wg.absent') : t('tunnel.down')}
            </Text>
            <Box key="tunnel-actions" flexDirection="row" flexWrap="wrap" gap={1}>
              {wg?.state === 'inactive' && (
                <Button key="tunnel-open" label={t('wg.openApp')} variant="primary" onPress={() => void openWireguard($)} />
              )}
              {wg?.state === 'absent' && (
                <Button key="tunnel-install" label={t('wg.install')} variant="primary" onPress={() => void openUrl($, WG_INSTALL_URL)} />
              )}
              {wg?.state === 'absent' && (
                <Button key="tunnel-guide" label={t('wg.guide')} plain onPress={() => void openUrl($, GUIDE_URL)} />
              )}
              <Text size="caption" dimColor>
                {t('tunnel.hint')}
              </Text>
            </Box>
          </Box>
        )}
        {primary}
        {secondaries}
        {adding}
        {footer}
        {sticky}
      </Box>
    )
  })

  // The band above the prompt: one line with the primary, the secondaries and
  // their write badge, and a toggle for the pane. It draws only from what the
  // pane's reads left (the startup read, a refresh, a click, the model's
  // binding calls): it never calls the router itself. Another plugin's band,
  // or the engine's own, stays under it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (!isBandOn() || e.props.hasSurvey) {
      return below
    }
    const snap = await read($, snapshot)
    if (!snap) {
      return below
    }
    const bandEls = $.ui.resolve(e)
    const { Box, Text, Button } = bandEls
    // The terminal draws no SVG (its element draws nothing there): no mark is
    // drawn, and none is counted.
    const BandSvg = e.surface !== 'terminal' && 'Svg' in bandEls ? bandEls.Svg : null
    // A graphical surface frames each vault in its own chip; the terminal,
    // where a frame costs two rows, keeps one line and a "│" between them.
    const isChip = !!BandSvg
    const isBandChrome = (await read($, chromeState)) === 'on'
    // The cells a name's controls take beyond the name: Obsidian's mark (2 and
    // a gap) for a local vault; for a remote one the planet and Claude's mark
    // (a gap and 2 each), on the terminal 🌐 and ✳ (a gap and 2, a gap and 1).
    const markCells = (row: VaultRow) => {
      const target = openTarget(row)

      return !target ? 0 : target === 'browser' ? (BandSvg ? 3 : 2) + (isBandChrome ? 3 : 0) : BandSvg ? 3 : 0
    }
    // Read for its redraws only: the toggle says what the module knows, and
    // the texts follow the language.
    await read($, paneVersion)
    await read($, language)
    const isShown = isPanePlaced
    const isListOpen = await read($, bandListOpen)
    const names = snap.secondaries.map(s => s.name)
    const paused = snap.paused ?? []
    // Every secondary on the line, in the binding's order, paused or not: each
    // with its own ▶ (pause) or ❚❚ (resume), right where it is named. A pause
    // changes the control, never the place.
    const rank = (name: string) => {
      const at = (snap.order ?? []).indexOf(name)

      return at === -1 ? Number.MAX_SAFE_INTEGER : at
    }
    const entries: { row: Secondary; isPaused: boolean }[] = [
      ...snap.secondaries.map(row => ({ row, isPaused: false })),
      ...paused.map(row => ({ row, isPaused: true })),
    ].sort((x, y) => rank(x.row.name) - rank(y.row.name))
    const fit = bandFit(
      snap.primary?.name ?? null,
      entries.map(entry => entry.row.name),
      e.props.bodyColumns,
      entries.map(entry => entry.isPaused),
      entries.map(entry => markCells(entry.row)),
      snap.primary ? markCells(snap.primary) : 0,
      isChip,
    )
    const chip = chipText(fit.hidden, entries.slice(fit.shown).filter(entry => entry.isPaused).length)
    // The band's width and what fitted, in the trace (see `traceScroll`): what
    // `bandFit` counts, beside what a surface draws, sets the count right.
    const bandLine = JSON.stringify([
      e.surface,
      e.props.bodyColumns,
      fit.shown,
      snap.primary?.name ?? '',
      entries.map(entry => [entry.row.name, entry.isPaused]),
    ])
    if (bandLine !== lastTracedBand) {
      lastTracedBand = bandLine
      void traceScroll($, {
        kind: 'band',
        surface: e.surface,
        bodyColumns: e.props.bodyColumns,
        shown: fit.shown,
        hidden: fit.hidden,
        names: entries.map(entry => entry.row.name),
      }).catch(() => undefined)
    }
    // A mark that is a control. A Button holds text only and a mark is no
    // button, so the mark is drawn and a blank Button laid over it, the one
    // the click lands on; the terminal, which draws no mark, has a glyph key.
    // Blank, since the desktop draws a label whole (v0.110.1): the mark's
    // `alt` beside it is what names it to a reader.
    const iconKey = (source: string, glyph: string, key: string, onPress: () => void) =>
      BandSvg ? (
        <Box key={`icon-${key}`} flexDirection="row" alignItems="center" flexShrink={0}>
          <BandSvg source={source} alt={markAlt(source)} width={14} height={14} />
          <Box position="absolute" top={0} left={0}>
            <Button key={key} label={'  '} plain onPress={onPress} />
          </Box>
        </Box>
      ) : (
        <Button key={key} label={glyph} plain dimColor onPress={onPress} />
      )
    // A vault's name and where it opens. A local one: Obsidian's mark before
    // its name, both opening it in Obsidian. A remote one: its name, then the
    // planet (the default browser) and Claude's mark (Claude's own browser),
    // each its own control; the name opens nothing. `list` keys the dropdown's
    // copy (`list-`) and the primary's (`main-`) apart from the secondaries'.
    // Every key ends with the vault's name, after a word of the band's own: no
    // key is another's with a suffix.
    const opener = (row: VaultRow, name: string, isDim = false, list = '') => {
      const target = openTarget(row)
      if (!target) {
        return (
          <Text key={`band-${list}plain-${name}`} dimColor wrap="truncate-end">
            {row.name}
          </Text>
        )
      }
      if (target === 'obsidian') {
        return (
          <Box key={`band-${list}box-${name}`} flexDirection="row" gap={1} alignItems="center">
            {BandSvg && iconKey(OBSIDIAN_MARK, '', `band-${list}obsidian-${name}`, () => void openVault($, row))}
            {/* No label: the desktop draws a Button's label in place of its
                children, and a sentence pushed the band's names off its line
                (seen on screen in v0.110.1). The name is the control's text. */}
            <Button key={`band-${list}open-${name}`} plain onPress={() => void openVault($, row)}>
              <Text dimColor={isDim} wrap="truncate-end">
                {row.name}
              </Text>
            </Button>
          </Box>
        )
      }

      return (
        <Box key={`band-${list}box-${name}`} flexDirection="row" gap={1} alignItems="center">
          <Text key={`band-${list}name-${name}`} dimColor={isDim} wrap="truncate-end">
            {row.name}
          </Text>
          {isBandChrome && iconKey(GLOBE_MARK, '🌐', `band-${list}web-${name}`, () => void openInChrome($, row))}
          {iconKey(CLAUDE_PANE_MARK, '✳', `band-${list}ui-${name}`, () => void openUi($, row))}
        </Box>
      )
    }
    // The chip opens a dropdown under the line: every secondary, one per row,
    // with its controls; pressed again, it folds.
    const isUnfolded = isListOpen && fit.hidden > 0
    const onLine = entries.slice(0, fit.shown)
    // A secondary's control: ▶ on a green ground while it runs (a press pauses
    // it); while it is paused, the same ▶ dimmed on no ground, a key that
    // reads as off (a press resumes it). Asked for in place of a red ❚❚.
    const control = (row: Secondary, isPaused: boolean, list = '') =>
      isPaused ? (
        <Box key={`band-${list}state-${row.name}`}>
          <Button key={`band-${list}resume-${row.name}`} label="▶" plain dimColor onPress={() => void setPaused($, row, false)} />
        </Box>
      ) : (
        <Box key={`band-${list}state-${row.name}`} backgroundColor="diffAddedDimmed">
          <Button key={`band-${list}pause-${row.name}`} label="▶" plain onPress={() => void setPaused($, row, true)} />
        </Box>
      )
    const caption = (text: string) => (
      <Text size="caption" dimColor wrap="truncate-end">
        {text}
      </Text>
    )
    // "Principal :" and "Secondaires :" in bold, the names after them plain.
    const heading = (text: string) => (
      <Text weight="semibold" wrap="truncate-end">
        {text}
      </Text>
    )
    // A vault's place on the line: framed on a graphical surface, so each
    // stands apart; on the terminal, after a "│" from the one before.
    const slot = (key: string, isFirst: boolean, children: unknown) =>
      isChip ? (
        <Box
          key={key}
          flexDirection="row"
          alignItems="center"
          columnGap={1}
          flexShrink={0}
          borderStyle="round"
          borderColor="inactive"
          paddingX={1}
        >
          {children as never}
        </Box>
      ) : (
        <Box key={key} flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
          {!isFirst && caption('│')}
          {children as never}
        </Box>
      )
    const entry = (row: Secondary, isPaused: boolean, list = '') => [
      opener(row, row.name, isPaused, list),
      <Text key={`band-${list}tier-${row.name}`} dimColor={isPaused} wrap="truncate-end">
        {iconOf(row.mode)}
      </Text>,
      control(row, isPaused, list),
    ]
    // The dropdown's rows in columns of fixed widths, so each control stands
    // under the one above: Obsidian's mark (a local vault), the name, the
    // planet and Claude's mark (a remote one), the tier, the ▶. A row draws
    // what its vault has and leaves the other cells empty.
    // Capped to what the band leaves the name once the frame, its padding, the
    // four 2-cell columns, the ▶ and the gaps are counted: a long name is cut,
    // never a control pushed off the band.
    const nameWidth = Math.max(
      6,
      Math.min(Math.max(0, ...entries.map(({ row }) => cells(row.name))) + 1, e.props.bodyColumns - (2 + 2 + 4 * 2 + 1 + 5)),
    )
    const column = (key: string, width: number, child: unknown) => (
      <Box key={key} width={width} minWidth={width} flexShrink={0} flexDirection="row" alignItems="center">
        {child as never}
      </Box>
    )
    const listRow = (row: Secondary, isPaused: boolean) => {
      const target = openTarget(row)
      const name = row.name

      return [
        column(
          `band-list-lead-${name}`,
          2,
          target === 'obsidian' && BandSvg
            ? iconKey(OBSIDIAN_MARK, '', `band-list-obsidian-${name}`, () => void openVault($, row))
            : null,
        ),
        column(
          `band-list-label-${name}`,
          nameWidth,
          target === 'obsidian' ? (
            <Button key={`band-list-open-${name}`} plain onPress={() => void openVault($, row)}>
              <Text dimColor={isPaused} wrap="truncate-end">
                {name}
              </Text>
            </Button>
          ) : (
            <Text key={`band-list-name-${name}`} dimColor={isPaused || !target} wrap="truncate-end">
              {name}
            </Text>
          ),
        ),
        column(
          `band-list-webcell-${name}`,
          2,
          target === 'browser' && isBandChrome
            ? iconKey(GLOBE_MARK, '🌐', `band-list-web-${name}`, () => void openInChrome($, row))
            : null,
        ),
        column(
          `band-list-uicell-${name}`,
          2,
          target === 'browser' ? iconKey(CLAUDE_PANE_MARK, '✳', `band-list-ui-${name}`, () => void openUi($, row)) : null,
        ),
        column(
          `band-list-tiercell-${name}`,
          2,
          <Text key={`band-list-tier-${name}`} dimColor={isPaused} wrap="truncate-end">
            {iconOf(row.mode)}
          </Text>,
        ),
        control(row, isPaused, 'list-'),
      ]
    }

    return (
      <Box flexDirection="column">
        <Box key="vault-band" flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={2}>
          <Box key="vault-band-names" flexDirection="row" flexWrap="nowrap" alignItems="center" columnGap={1} flexShrink={1} overflow="hidden">
            {heading(t('band.primary'))}
            {snap.primary ? (
              slot('band-main-row', true, opener(snap.primary, snap.primary.name, false, 'main-'))
            ) : (
              <Text wrap="truncate-end">{t('band.none')}</Text>
            )}
            <Box width={1} />
            {heading(t('band.secondaries'))}
            {names.length === 0 && paused.length === 0 && caption(t('band.none'))}
            {onLine.map(({ row, isPaused }, i) => slot(`band-row-${row.name}`, i === 0, entry(row, isPaused)))}
            {chip && (
              <Button key="band-more" plain dimColor onPress={() => void update($, bandListOpen, open => !open)}>
                <Text dimColor>{`${chip} ${isUnfolded ? '▴' : '▾'}`}</Text>
              </Button>
            )}
          </Box>
          <Button
            key="toggle-pane"
            label={isShown ? t('band.hide') : t('band.show')}
            plain
            dimColor
            onPress={() => void togglePane($)}
          />
        </Box>
        {isUnfolded && (
          // The dropdown: every secondary, in the binding's order, with what
          // acts on it — open it (Obsidian, the browser, Claude's browser),
          // pause or resume it.
          <Box key="band-list" flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1} alignSelf="flex-start">
            {entries.map(({ row, isPaused }) => (
              <Box key={`band-list-row-${row.name}`} flexDirection="row" alignItems="center" columnGap={1}>
                {listRow(row, isPaused)}
              </Box>
            ))}
          </Box>
        )}
        {below}
      </Box>
    )
  })
}
