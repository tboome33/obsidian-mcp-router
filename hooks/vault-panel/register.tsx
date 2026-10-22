import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { SecondaryMode, Snapshot, Tab, VaultRow } from '../../types'

const PANE = 'vault-panel'
const TITLE = 'Vaults'
const REFRESH_MS = 120_000
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

type Binding = {
  vault: string
  also: string[]
  locked: boolean
  confirmedVia?: string
  alsoLocked?: string[]
  alsoWritable?: string[]
}

type ListVaults = {
  workspaceBinding: Binding | null
  vaults: { name: string; type?: string; online?: boolean; description?: string; baseUrl?: string }[]
  disabled: { name: string; type?: string; awaitingDeclaration?: boolean }[]
  configPath?: string
  /** A session lock set by lock_vault: runtime only, not in the binding. */
  lockedTo?: string | null
  /** The binding entry as the config file holds it, read once (router v0.101.0+). */
  workspaceBindingOnFile?: { digest: string; vault: string | null; also: string[]; aliases?: number } | null
}

let server: string | null = null
let ticker: Timer | null = null
let isPaneOpen = false
// The pane was closed (by the person or an unload) since this
// session started: the startup read must not open it any more.
let isStartupCancelled = false
// This session opted out: a pane an earlier start was opening is closed.
let isOptedOut = false
// Bumped by every open and close of the pane (see openPane).
let paneEpoch = 0
// Bumped by every session.start: work a previous start left running reads a
// stale number and drops its result.
let generation = 0
// Bumped by every refresh: a slower, older answer never overwrites a newer one.
let lastRefresh = 0

// Calls a router tool, finding which name the router is connected under.
async function call($: EngineInterface, tool: string, args: Record<string, unknown> = {}) {
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
    return full[1]
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

// Shows a remote vault's web UI in the app's own browser pane.
async function openUi($: EngineInterface, row: VaultRow) {
  if (!row.uiUrl) {
    return
  }
  try {
    const result = await $.mcp.call('Claude_Browser', 'preview_start', { url: row.uiUrl })
    if (result.isError) {
      throw new Error(result.content.map(block => block.text ?? '').join(' '))
    }
  } catch (err) {
    await update($, error, () => `Navigateur interne : ${err instanceof Error ? err.message : String(err)}`)
  }
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

// The router's refusal of a stale precondition speaks of a repair diagnostic;
// for a click, what happened is simpler.
const STALE = /binding entry now differs/
const STALE_TEXT =
  "La liaison a été modifiée pendant l'envoi (par une autre session) : rien n'a été écrit, le panneau est rafraîchi."

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Reads the state back and draws it. Only the newest refresh writes, checked
// before EACH write: an older answer landing late never overwrites a newer one.
async function refresh($: EngineInterface): Promise<boolean> {
  const id = ++lastRefresh
  try {
    const data = JSON.parse(await call($, 'list_vaults')) as ListVaults
    const next = toSnapshot(data, await $.clock.now())
    await fillUnknown($, next, data.configPath)
    if (id === lastRefresh) {
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
  }
}

// A refresh nobody awaits: what it could not write (a session that ended
// meanwhile) is dropped, never left as an unhandled rejection.
function background($: EngineInterface) {
  void refresh($).catch(() => undefined)
}

// Runs one change against the router, then reads the state back. A refused
// change is kept in `failure`, which no refresh clears: only the next action
// does.
async function act($: EngineInterface, label: string, tool: string, args: Record<string, unknown> | (() => Promise<Record<string, unknown>>)) {
  if (await read($, busy)) {
    return
  }
  await update($, busy, () => label)
  await update($, failure, () => null)
  try {
    await call($, tool, typeof args === 'function' ? await args() : args)
    $.ui.toast(label)
  } catch (err) {
    await update($, failure, () => (STALE.test(message(err)) ? STALE_TEXT : message(err)))
  }
  await refresh($)
  await update($, busy, () => null)
}

// The binding entry a click works from, as the config FILE holds it now, with
// the digest that makes the write conditional on it: confirm_workspace_binding
// checks `ifBindingDigest` inside its write lock, so a click lands only on the
// entry it was computed from — never over a change another session made
// between this read and the write. Only a router older than the field — the
// field ABSENT — gets the old, unconditioned write computed from its live
// binding. A router that has the field but could not read its file (null)
// gets nothing: falling back there would silently drop the protection. Nor
// does a config holding this workspace under several spellings: the write
// would collapse them all, and the digest covers one.
async function bindingNow($: EngineInterface) {
  const data = JSON.parse(await call($, 'list_vaults')) as ListVaults
  if ('workspaceBindingOnFile' in data) {
    const onFile = data.workspaceBindingOnFile
    if (!onFile || typeof onFile.digest !== 'string') {
      throw new Error("Le router n'a pas pu relire sa config : rien n'a été envoyé. Réessaie dans un instant.")
    }
    if ((onFile.aliases ?? 0) > 0) {
      throw new Error(
        "La config du router contient ce workspace sous plusieurs écritures (une édition à la main) : rien n'a été envoyé. Répare la liaison d'abord.",
      )
    }

    return { vault: onFile.vault, also: onFile.also ?? [], precondition: { ifBindingDigest: onFile.digest } }
  }
  const live = data.workspaceBinding

  return { vault: live?.vault ?? null, also: live?.also ?? [], precondition: {} }
}

// Re-confirms the binding with a new list of secondaries, computed from the
// binding as the file holds it NOW, not from the snapshot on screen. The click
// names the primary it was drawn for: if the primary is no longer that one,
// nothing is sent. `locked` is left out on purpose: the router keeps the
// binding's own lock when the field is absent, so a click never unlocks (or
// locks) a workspace. Tiers of the secondaries that stay are kept by the
// router.
async function rebind($: EngineInterface, label: string, shown: string, change: (also: string[]) => string[]) {
  await act($, label, 'confirm_workspace_binding', async () => {
    const now = await bindingNow($)
    if (now.vault !== shown) {
      throw new Error(
        `La liaison a changé entre-temps (principal : ${now.vault ?? 'aucun'}) : rien n'a été envoyé, le panneau est rafraîchi.`,
      )
    }

    return { vault: now.vault, also: change(now.also), ...now.precondition }
  })
}

// Picks the primary of an unbound workspace, only if it is still unbound: the
// digest of the absent entry is a precondition like any other.
async function choosePrimary($: EngineInterface, name: string) {
  await act($, `${name} principal`, 'confirm_workspace_binding', async () => {
    const now = await bindingNow($)
    if (now.vault) {
      throw new Error(
        `Un principal a été choisi entre-temps (${now.vault}) : rien n'a été envoyé, le panneau est rafraîchi.`,
      )
    }

    return { vault: name, ...now.precondition }
  })
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
  isPaneOpen = true
  if (!ticker) {
    ticker = $.clock.every(REFRESH_MS, () => background($))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const start = ++generation
    stopTicker()
    isPaneOpen = false
    isStartupCancelled = false
    // A read the previous session left running writes nothing into this one.
    lastRefresh += 1
    // Shipped on by default with the plugin, so it carries an opt-out like
    // the plugin's other hooks: no command, no pane, no router call.
    const optOut = await $.env.get('OBSIDIAN_ROUTER_NO_VAULT_PANEL')
    isOptedOut = TRUTHY.has((optOut ?? '').trim().toLowerCase())
    if (isOptedOut) {
      return next(e)
    }
    await $.command.register({
      name: 'vaults',
      description: 'Afficher les vaults du router (principal, secondaires, disponibles)',
    })
    // Opens only where the router answers: the panel follows the MCP's install.
    // A pane the person closed meanwhile stays closed.
    void refresh($)
      .then(isUp => (isUp && !isStartupCancelled ? openPane($, start) : undefined))
      .catch(() => undefined)

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
    // The phone has no field: the list is drawn unfiltered there.
    const Input = 'Input' in els ? els.Input : null
    const snap = await read($, snapshot)
    const working = await read($, busy)
    const err = await read($, error)
    const failed = await read($, failure)
    // A tab kept from an earlier version of the panel reads as the first one.
    const current: Tab = (await read($, tab)) === 'distants' ? 'distants' : 'locaux'
    const typed = await read($, filter)
    const query = typed.trim().toLowerCase()

    // A glyph per state, the colour on top: a closed local vault is no fault
    // (adding it opens it), an unreachable remote one is.
    // Drawn in a fixed-width cell, so the names line up whatever the glyph.
    const dot = (online: boolean | null, isRemote: boolean) => (
      <Box width={2} justifyContent="center" flexShrink={0}>
        {glyph(online, isRemote)}
      </Box>
    )
    // A surface that draws SVG gets the three marks at one size: the font's
    // own ● and ○ differ. The terminal keeps the characters.
    const Svg = 'Svg' in els ? els.Svg : null
    const glyph = (online: boolean | null, isRemote: boolean) =>
      Svg && online !== null ? (
        <Svg
          source={online ? MARK.open : isRemote ? MARK.unreachable : MARK.closed}
          alt={online ? 'ouvert' : isRemote ? 'injoignable' : 'fermé'}
          width={12}
          height={12}
        />
      ) : online === null ? (
        <Text dimColor>?</Text>
      ) : online ? (
        <Text color="success">●</Text>
      ) : isRemote ? (
        <Text color="error">✕</Text>
      ) : (
        <Text color="text">○</Text>
      )
    const legendItem = (glyph: ReturnType<typeof dot>, label: string) => (
      <Box flexDirection="row" gap={1}>
        {glyph}
        <Text dimColor>{label}</Text>
      </Box>
    )
    const section = (title: string) => (
      <Text bold color="claude">
        {title}
      </Text>
    )
    const time = (ms: number) => {
      const d = new Date(ms)
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }

    const header = (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text bold>Vaults enregistrés dans le router</Text>
        <Box flexDirection="row" gap={1} alignItems="center">
          {working ? <Text color="warning">{working}…</Text> : snap && <Text dimColor>màj {time(snap.fetchedAt)}</Text>}
          <Button key="refresh" label="Rafraîchir" dimColor onPress={() => background($)} />
        </Box>
      </Box>
    )

    if (!snap) {
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Text dimColor>{err ? `Router injoignable : ${err}` : 'Lecture du router…'}</Text>
        </Box>
      )
    }

    // The primary every binding button was drawn for: rebind refuses another.
    const shown = snap.primary?.name ?? ''
    const isRemote = (r: VaultRow) => r.type === 'remote'
    const remotes = snap.available.filter(isRemote)
    const locals = snap.available.filter(v => !isRemote(v))
    const bound = [snap.primary, ...snap.secondaries].filter((r): r is VaultRow => r !== null)
    const isTunnelDown =
      [...bound, ...remotes].some(isRemote) && [...bound, ...remotes].filter(isRemote).every(r => r.online === false)

    // Re-confirming the binding as it stands opens every bound vault whose
    // Obsidian does not answer: the router's own way to open one.
    const reopen = (name: string) => void rebind($, `Ouverture de ${name}`, shown, current => current)

    // What a bound vault that does not answer needs: opening, or the tunnel.
    const down = (row: VaultRow) =>
      row.online !== false ? null : isRemote(row) ? (
        <Text color="error">Injoignable : WireGuard actif ? conteneur démarré sur la dedibox ?</Text>
      ) : (
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
          <Text color="warning">Fermé dans Obsidian.</Text>
          <Button
            key={`open-${row.name}`}
            label="Ouvrir dans Obsidian"
            variant="primary"
            onPress={() => reopen(row.name)}
          />
        </Box>
      )

    // Where a bound vault lives is said in brackets; the add list's tabs say it already.
    const uiButton = (row: VaultRow) =>
      row.uiUrl ? (
        <Button key={`ui-${row.name}`} label="Ouvrir" onPress={() => void openUi($, row)} />
      ) : isRemote(row) ? (
        <Text dimColor>interface inconnue</Text>
      ) : null

    const name = (row: VaultRow, isBold = false, isPlaceShown = true) => (
      <Box flexDirection="row" gap={1} flexShrink={1}>
        {dot(row.online, isRemote(row))}
        <Text bold={isBold} wrap="truncate-end">
          {row.name}
        </Text>
        {isPlaceShown && <Text dimColor>({isRemote(row) ? 'distant' : 'local'})</Text>}
      </Box>
    )

    const primary = (
      <Box flexDirection="column" gap={1}>
        {section('VAULT PRINCIPAL')}
        {snap.primary ? (
          <Box flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between" alignItems="center">
              {name(snap.primary, true)}
              <Box flexDirection="row" gap={1} alignItems="center">
                <Text dimColor>lecture/écriture{snap.isLocked ? ' · verrouillé seul' : ''}</Text>
                {uiButton(snap.primary)}
              </Box>
            </Box>
            {down(snap.primary)}
          </Box>
        ) : (
          <Text color="warning">Aucun : choisis un principal dans la liste ci-dessous.</Text>
        )}
        {snap.isImported && snap.primary && (
          <Box flexDirection="column" gap={1}>
            <Text color="warning">Liaison importée d'un .env, jamais confirmée.</Text>
            <Box flexDirection="row" gap={1}>
              <Button
                key="confirm-binding"
                label={`Confirmer ${snap.primary.name} comme principal`}
                variant="primary"
                onPress={() => void rebind($, 'Liaison confirmée', shown, current => current)}
              />
            </Box>
          </Box>
        )}
        {snap.isLocked && (
          <Text color="warning">Session verrouillée sur le principal : les secondaires ne répondent pas.</Text>
        )}
        {snap.lockedTo && (
          <Text color="warning">
            Router verrouillé sur {snap.lockedTo} pour cette session (lock_vault) : les autres vaults ne répondent pas.
          </Text>
        )}
      </Box>
    )

    const secondaries = (
      <Box flexDirection="column" gap={1}>
        {section(`VAULTS SECONDAIRES (${snap.secondaries.length})`)}
        {snap.secondaries.length === 0 && <Text dimColor>Aucun.</Text>}
        {snap.secondaries.map(s => (
          <Box key={`sec-${s.name}`} flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between" alignItems="center">
              {name(s)}
              <Box flexDirection="row" gap={1} alignItems="center">
                {uiButton(s)}
                <Button
                  key={`remove-${s.name}`}
                  label="Retirer"
                  dimColor
                  onPress={() =>
                    void rebind(
                      $,
                      `${s.name} retiré`,
                      shown,
                      current => current.filter(n => n !== s.name),
                    )
                  }
                />
              </Box>
            </Box>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {MODES.map(m => (
                <Button
                  key={`mode-${s.name}-${m.mode}`}
                  label={m.label}
                  variant={s.mode === m.mode ? 'primary' : 'secondary'}
                  dimColor={s.mode !== m.mode}
                  onPress={() =>
                    s.mode === m.mode
                      ? undefined
                      : void act($, `${s.name} : ${m.label.toLowerCase()}`, 'set_secondary_vault_mode', {
                          vault: s.name,
                          mode: m.mode,
                        })
                  }
                />
              ))}
            </Box>
            {down(s)}
          </Box>
        ))}
      </Box>
    )

    const list = (current === 'locaux' ? locals : remotes).filter(v => !query || v.name.toLowerCase().includes(query))
    const tabs: { id: Tab; label: string }[] = [
      { id: 'locaux', label: `Locaux (${locals.length})` },
      { id: 'distants', label: `Distants (${remotes.length})` },
    ]
    const adding = (
      <Box flexDirection="column" gap={1}>
        {section(snap.primary ? 'AJOUTER UN VAULT SECONDAIRE' : 'CHOISIR LE VAULT PRINCIPAL')}
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {tabs.map(t => (
            <Button
              key={`tab-${t.id}`}
              label={t.label}
              variant={current === t.id ? 'primary' : 'secondary'}
              dimColor={current !== t.id}
              onPress={() => void update($, tab, () => t.id)}
            />
          ))}
        </Box>
        {current === 'distants' && isTunnelDown && (
          <Text color="warning">Aucun vault distant ne répond : WireGuard est-il actif ?</Text>
        )}
        {Input && (
          <Input
            key="filter"
            placeholder="Filtrer…"
            value={typed}
            submitLabel="filtrer"
            onInput={(value: string) => void update($, filter, () => value)}
            onSubmit={(value: string) => void update($, filter, () => value)}
          />
        )}
        {list.length === 0 && <Text dimColor>Aucun vault ne correspond.</Text>}
        {list.map(v => (
          <Box key={`av-${v.name}`} flexDirection="row" justifyContent="space-between" alignItems="center">
            {name(v, false, false)}
            <Box flexDirection="row" gap={1} alignItems="center">
              {uiButton(v)}
              {snap.primary ? (
                <Button
                  key={`add-${v.name}`}
                  label="Ajouter"
                  onPress={() =>
                    void rebind($, `${v.name} ajouté (écriture sur accord)`, shown, current =>
                      current.includes(v.name) ? current : [...current, v.name],
                    )
                  }
                />
              ) : (
                <Button
                  key={`primary-${v.name}`}
                  label="Principal"
                  onPress={() => void choosePrimary($, v.name)}
                />
              )}
            </Box>
          </Box>
        ))}
      </Box>
    )

    const hasUnknown = [...bound, ...snap.available].some(r => r.online === null)
    const legend = (
      <Box flexDirection="row" columnGap={2} flexWrap="wrap">
        {legendItem(dot(true, false), 'ouvert / en ligne')}
        {legendItem(dot(false, false), "local fermé (s'ouvre à l'ajout)")}
        {legendItem(dot(false, true), 'distant injoignable (WireGuard ?)')}
        {hasUnknown && legendItem(dot(null, false), 'état inconnu')}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {legend}
        {err && <Text color="error">{err}</Text>}
        {failed && failed !== err && <Text color="error">{failed}</Text>}
        {primary}
        {secondaries}
        {adding}
      </Box>
    )
  })
}
