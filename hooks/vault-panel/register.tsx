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
}

let server: string | null = null
let ticker: Timer | null = null
let isPaneOpen = false

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
  const bound = new Set(b ? [b.vault, ...b.also] : [])
  const available = [
    ...data.vaults.filter(v => !bound.has(v.name)).map(v => row(v.name)),
    ...data.disabled
      .filter(d => d.awaitingDeclaration && !bound.has(d.name))
      .map(d => ({ name: d.name, online: null, type: d.type ?? null, description: null, uiUrl: null })),
  ].sort((x, y) => x.name.localeCompare(y.name, 'fr', { sensitivity: 'base' }))

  return {
    primary: b ? row(b.vault) : null,
    isLocked: b?.locked ?? false,
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
      const port = entry.ports?.http ?? entry.ports?.https
      if (name && port) {
        ports.set(name.toLowerCase(), entry.ports?.http ? `http://127.0.0.1:${port}/` : `https://127.0.0.1:${port}/`)
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

async function refresh($: EngineInterface): Promise<boolean> {
  try {
    const data = JSON.parse(await call($, 'list_vaults')) as ListVaults
    const next = toSnapshot(data, await $.clock.now())
    await fillUnknown($, next, data.configPath)
    await update($, snapshot, () => next)
    await update($, error, () => null)

    return true
  } catch (err) {
    await update($, error, () => (err instanceof Error ? err.message : String(err)))

    return false
  }
}

// Runs one change against the router, then reads the state back.
async function act($: EngineInterface, label: string, tool: string, args: Record<string, unknown>) {
  if (await read($, busy)) {
    return
  }
  await update($, busy, () => label)
  try {
    await call($, tool, args)
    $.ui.toast(label)
  } catch (err) {
    await update($, error, () => (err instanceof Error ? err.message : String(err)))
  }
  await refresh($)
  await update($, busy, () => null)
}

// Re-confirms the binding with a new list of secondaries: tiers of the
// secondaries that stay are kept by the router, the lock is passed back.
async function rebind($: EngineInterface, label: string, also: string[]) {
  const snap = await read($, snapshot)
  if (!snap?.primary) {
    return
  }
  await act($, label, 'confirm_workspace_binding', {
    vault: snap.primary.name,
    also,
    locked: snap.isLocked,
  })
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: TITLE })
  isPaneOpen = true
  if (!ticker) {
    ticker = $.clock.every(REFRESH_MS, () => void refresh($))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    ticker = null
    isPaneOpen = false
    // Shipped on by default with the plugin, so it carries an opt-out like
    // the plugin's other hooks: no command, no pane, no router call.
    const optOut = await $.env.get('OBSIDIAN_ROUTER_NO_VAULT_PANEL')
    if (TRUTHY.has((optOut ?? '').trim().toLowerCase())) {
      return next(e)
    }
    await $.command.register({
      name: 'vaults',
      description: 'Afficher les vaults du router (principal, secondaires, disponibles)',
    })
    // Opens only where the router answers: the panel follows the MCP's install.
    void refresh($).then(isUp => (isUp ? openPane($) : undefined))

    return next(e)
  })

  on('command.run', { command: 'vaults' }, async $ => {
    await openPane($)
    await refresh($)
    const err = await read($, error)

    return {
      text: err ? `Panneau des vaults ouvert, mais le router ne répond pas : ${err}` : 'Panneau des vaults ouvert.',
    }
  })

  // The model may change the binding too: redraw after its router calls.
  // An observer, not a guard: no .catch, so a failure here fails open and the
  // tool's own result stands. Only once the pane was opened:
  // nobody reads the snapshot otherwise.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (isPaneOpen && ROUTER_TOOL.test(e.tool)) {
      void refresh($)
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
          <Button key="refresh" label="Rafraîchir" dimColor onPress={() => void refresh($)} />
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

    const also = snap.secondaries.map(s => s.name)
    const isRemote = (r: VaultRow) => r.type === 'remote'
    const remotes = snap.available.filter(isRemote)
    const locals = snap.available.filter(v => !isRemote(v))
    const bound = [snap.primary, ...snap.secondaries].filter((r): r is VaultRow => r !== null)
    const isTunnelDown =
      [...bound, ...remotes].some(isRemote) && [...bound, ...remotes].filter(isRemote).every(r => r.online === false)

    // Re-confirming the binding as it stands opens every bound vault whose
    // Obsidian does not answer: the router's own way to open one.
    const reopen = (name: string) => void rebind($, `Ouverture de ${name}`, also)

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
                onPress={() => void rebind($, 'Liaison confirmée', also)}
              />
            </Box>
          </Box>
        )}
        {snap.isLocked && (
          <Text color="warning">Session verrouillée sur le principal : les secondaires ne répondent pas.</Text>
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
                      also.filter(n => n !== s.name),
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
                  onPress={() => void rebind($, `${v.name} ajouté (écriture sur accord)`, [...also, v.name])}
                />
              ) : (
                <Button
                  key={`primary-${v.name}`}
                  label="Principal"
                  onPress={() => void act($, `${v.name} principal`, 'confirm_workspace_binding', { vault: v.name })}
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
        {primary}
        {secondaries}
        {adding}
      </Box>
    )
  })
}
