import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'obsidian-router',
  component: 'Pane',
  requestId: 'vault-panel',
  props: {
    title: 'Vaults',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const LIST = {
  workspaceBinding: {
    vault: 'main',
    also: ['docs', 'notes'],
    locked: false,
    confirmedVia: 'tool',
    alsoLocked: ['docs'],
    alsoWritable: [],
  },
  vaults: [
    { name: 'main', type: 'remote', online: true },
    { name: 'docs', type: 'remote', online: true },
    { name: 'notes', type: 'local', online: false },
    { name: 'extra', type: 'remote', online: true, baseUrl: 'http://10.8.0.1:27181', description: 'Conteneur (UI :3002), fichiers : x' },
  ],
  disabled: [
    { name: 'closed', type: 'local', awaitingDeclaration: true },
    { name: 'off', type: 'local', awaitingDeclaration: false },
  ],
}

test('the panel lists the binding and changes it through the router', async ($, on) => {
  const calls: { server: string; tool: string; args: Record<string, unknown> }[] = []
  mock.env(on, {})
  on('mcp.call', (_, e) => {
    calls.push(e)
    const text = e.tool === 'list_vaults' ? JSON.stringify(LIST) : '{"ok":true}'

    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  on('command.register', () => ({ value: { command: 'vaults' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  mock.clock(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({
    command: 'vaults',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    // Both sections are always drawn; the closed local secondary offers to open.
    expect(await ui.find({ type: 'Text', text: /^Principal$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Secondaires · 2$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'open-closed' })).toBeTruthy()
    // The add list holds the unbound vaults only, by tab; the
    // operator-disabled vault is left out.
    await openAdd(ui)
    await ui.press({ key: 'tab-locaux' })
    expect((await ui.find({ type: 'Text', text: /^closed$/ }))?.text).toBe('closed')
    expect(await ui.find({ type: 'Text', text: /^off$/ })).toBeFalsy()
    expect(await ui.find({ type: 'Button', key: 'add-extra' })).toBeFalsy()
    await openAdd(ui)
    await ui.press({ key: 'tab-distants' })
    expect(await ui.find({ type: 'Button', key: 'add-extra' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'add-closed' })).toBeFalsy()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await openClosed(ui)
  await ui.select({ key: 'mode-notes', value: 'writable' })
  expect(calls.find(c => c.tool === 'set_secondary_vault_mode')?.args).toEqual({ vault: 'notes', mode: 'writable' })

  await openAdd(ui)
  await ui.press({ key: 'tab-distants' })
  // A remote vault opens its web UI in the app's browser; one with no UI in
  // its description (docs) has no button.
  await ui.press({ key: 'ui-extra' })
  expect(calls.find(c => c.server === 'Claude_Browser')).toEqual({
    server: 'Claude_Browser',
    tool: 'preview_start',
    args: { url: 'https://10.8.0.1:3002/' },
  })
  expect(await ui.find({ type: 'Button', key: 'ui-docs' })).toBeFalsy()
  await ui.press({ key: 'add-extra' })
  expect(calls.find(c => c.tool === 'confirm_workspace_binding')?.args).toEqual({
    vault: 'main',
    also: ['docs', 'notes', 'extra'],
    open: false,
  })

  // The open-all is the one binding call that lets the router open the closed
  // vaults: no `open: false` here, where adding and removing carry it.
  await ui.press({ key: 'open-closed' })
  expect(calls.filter(c => c.tool === 'confirm_workspace_binding').at(-1)?.args).toEqual({
    vault: 'main',
    also: ['docs', 'notes'],
  })

  await ui.press({ key: 'remove-docs' })
  expect(calls.filter(c => c.tool === 'confirm_workspace_binding').at(-1)?.args).toEqual({
    vault: 'main',
    also: ['notes'],
    open: false,
  })
  await ui.unmount()
})

test('OBSIDIAN_ROUTER_NO_VAULT_PANEL turns the panel off: no command, no pane, no router call', async ($, on) => {
  const calls: string[] = []
  mock.env(on, { OBSIDIAN_ROUTER_NO_VAULT_PANEL: 'true' })
  on('mcp.call', (_, e) => {
    calls.push(e.tool)

    return { value: { content: [{ type: 'text', text: JSON.stringify(LIST) }], isError: false } }
  })
  on('command.register', (_, e) => {
    calls.push(`register:${e.name}`)

    return { value: { command: e.name } }
  })
  on('ui.open', () => {
    calls.push('ui.open')

    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(calls).toEqual([])
})

// Answers every engine call the panel makes; `list` is read at each list_vaults.
// `hold`, when set, holds the next list_vaults answer until the test calls
// the function it returns: the way to make two reads overlap.
function wire(on: On, state: { list: unknown; refuse?: string; refuseOnce?: string; refuseText?: string; writeAnswer?: unknown; held?: Promise<void>; env?: Record<string, string>; opens?: number; closes?: number; openHeld?: Promise<void> }) {
  const calls: { server: string; tool: string; args: Record<string, unknown> }[] = []
  on('env.get', (_, e) => ({ value: state.env?.[e.name] }))
  on('mcp.call', async (_, e) => {
    calls.push(e)
    // What this answer says is read now; when it lands is the hold's call.
    const list = JSON.stringify(state.list)
    const held = e.tool === 'list_vaults' ? state.held : undefined
    state.held = undefined
    await held
    if (e.tool === state.refuse || e.tool === state.refuseOnce) {
      if (e.tool === state.refuseOnce) {
        state.refuseOnce = undefined
      }
      const text = state.refuseText ?? `${e.tool} refused: binding changed meanwhile`

      return { value: { content: [{ type: 'text', text }], isError: true } }
    }
    const text = e.tool === 'list_vaults' ? list : JSON.stringify(state.writeAnswer ?? { ok: true })

    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  on('command.register', () => ({ value: { command: 'vaults' } }))
  on('ui.open', async () => {
    state.opens = (state.opens ?? 0) + 1
    const held = state.openHeld
    state.openHeld = undefined
    await held

    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    state.closes = (state.closes ?? 0) + 1

    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  mock.clock(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: '' }))

  return calls
}

// Asks again until `probe` finds something, for work a hook left running; a
// bounded number of round trips, never a timer.
async function eventually<T>(probe: () => Promise<T | undefined>): Promise<T | undefined> {
  for (let i = 0; i < 200; i += 1) {
    const found = await probe()
    if (found) {
      return found
    }
  }

  return undefined
}

// What the two helpers below need of a mounted pane, on any surface.
type Mounted = {
  find(query: { type?: 'Button'; key: string }): Promise<unknown>
  press(target: { key: string }): Promise<unknown>
}

// The add list and the closed secondaries are folded by default, and the
// fold is session state: open each one only if it is not open already.
async function openAdd(ui: Mounted) {
  if (!(await ui.find({ type: 'Button', key: 'tab-locaux' }))) {
    await ui.press({ key: 'toggle-add' })
  }
}

async function openClosed(ui: Mounted) {
  if (!(await ui.find({ key: 'mode-notes' }))) {
    await ui.press({ key: 'toggle-closed' })
  }
}

const START = { cwd: '/', surface: 'desktop', isInteractive: true } as const

// Starts the session, then /vaults: unlike the start's own detached read, the
// command awaits the router, so the pane is drawn from it before the test acts.
async function begin($: Parameters<TestBody>[0]) {
  await $.session.start(START)
  await $.command.run({
    command: 'vaults',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
}

test('a click works from the binding as the router has it now, and never sends the lock', async ($, on) => {
  const state: { list: unknown } = { list: LIST }
  const calls = wire(on, state)
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openAdd(ui)
  await ui.press({ key: 'tab-distants' })

  // Another session locks the workspace and drops `docs` after this pane drew.
  state.list = { ...LIST, workspaceBinding: { ...LIST.workspaceBinding, locked: true, also: ['notes'] } }
  await ui.press({ key: 'add-extra' })
  const sent = calls.filter(c => c.tool === 'confirm_workspace_binding').at(-1)?.args
  expect(sent).toEqual({ vault: 'main', also: ['notes', 'extra'], open: false })
  expect(sent && 'locked' in sent).toBe(false)
  await ui.unmount()
})

// A router of v0.101.0+ also says what the FILE holds, with the digest of it.
const ON_FILE = {
  ...LIST,
  // The live copy lags: it still lists `docs`, which the file has dropped.
  workspaceBindingOnFile: { digest: 'd'.repeat(64), vault: 'main', also: ['notes'] },
  // A router that refuses a write collapsing another spelling (v0.102.2+).
  routerBuild: { version: '0.102.2' },
}

test('a click is computed from the entry on file and sent with its digest', async ($, on) => {
  const state: { list: unknown } = { list: ON_FILE }
  const calls = wire(on, state)
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openAdd(ui)
  await ui.press({ key: 'tab-distants' })
  await ui.press({ key: 'add-extra' })
  expect(calls.filter(c => c.tool === 'confirm_workspace_binding').at(-1)?.args).toEqual({
    vault: 'main',
    also: ['notes', 'extra'],
    ifBindingDigest: 'd'.repeat(64), ifNoOtherSpellings: true,
    open: false,
  })
  await ui.unmount()
})

test('a router that has the field but could not read its file gets no write at all', async ($, on) => {
  const calls = wire(on, { list: { ...LIST, workspaceBindingOnFile: null } })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'remove-docs' })
  expect(calls.some(c => c.tool === 'confirm_workspace_binding')).toBe(false)
  expect(await ui.find({ type: 'Text', text: /pas pu relire sa config/ })).toBeTruthy()
  await ui.unmount()
})

test('a config holding the workspace under several spellings gets no write', async ($, on) => {
  const calls = wire(on, {
    list: { ...LIST, workspaceBindingOnFile: { digest: 'd'.repeat(64), vault: 'main', also: ['docs', 'notes'], aliases: 1 } },
  })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'remove-docs' })
  expect(calls.some(c => c.tool === 'confirm_workspace_binding')).toBe(false)
  expect(await ui.find({ type: 'Text', text: /sous plusieurs écritures/ })).toBeTruthy()
  await ui.unmount()
})

test('a Principal pick is sent with the digest of the unbound entry', async ($, on) => {
  const unbound = { ...LIST, workspaceBinding: null, workspaceBindingOnFile: { digest: 'e'.repeat(64), vault: null, also: [] } }
  const calls = wire(on, { list: unbound })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openAdd(ui)
  await ui.press({ key: 'tab-locaux' })
  await ui.press({ key: 'primary-notes' })
  expect(calls.filter(c => c.tool === 'confirm_workspace_binding').at(-1)?.args).toEqual({
    vault: 'notes',
    ifBindingDigest: 'e'.repeat(64), ifNoOtherSpellings: true,
  })
  await ui.unmount()
})

test('a write the router refuses as stale says so plainly', async ($, on) => {
  const state = {
    list: ON_FILE as unknown,
    refuse: 'confirm_workspace_binding',
    // The router's own words for a stale ifBindingDigest.
    refuseText: 'confirm_workspace_binding: this workspace binding entry now differs from the one that diagnostic described',
  }
  wire(on, state)
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openAdd(ui)
  await ui.press({ key: 'tab-distants' })
  await ui.press({ key: 'add-extra' })
  expect(await ui.find({ type: 'Text', text: /La liaison a été modifiée pendant l'envoi/ })).toBeTruthy()
  await ui.unmount()
})

test('a refused change keeps its error on screen after the read-back', async ($, on) => {
  wire(on, { list: LIST, refuse: 'set_secondary_vault_mode' })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openClosed(ui)
  await ui.select({ key: 'mode-notes', value: 'writable' })
  expect(await ui.find({ type: 'Text', text: /binding changed meanwhile/ })).toBeTruthy()
  // A later read of the router, the timer's or the button's, keeps it too.
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /binding changed meanwhile/ })).toBeTruthy()
  await ui.unmount()
})

test('a malformed port in the router config never moves the probe off 127.0.0.1', async ($, on) => {
  const list = {
    workspaceBinding: { vault: 'main', also: [], locked: false },
    vaults: [{ name: 'main', type: 'local', online: true }],
    disabled: [
      { name: 'evil', type: 'local', awaitingDeclaration: true },
      { name: 'good', type: 'local', awaitingDeclaration: true },
    ],
    configPath: '/router/config.json',
  }
  wire(on, { list })
  const fetched: string[] = []
  on('fs.read', () => ({
    value: JSON.stringify({
      vaultsById: {
        a: { path: '/v/evil', ports: { http: '80@example.com' } },
        b: { path: '/v/good', ports: { http: 27124 } },
      },
    }),
  }))
  on('http.fetch', (_, e) => {
    fetched.push(e.url)

    return { value: { status: 200, ok: true, headers: {}, text: '' } }
  })
  await begin($)
  expect(fetched.length).toBeGreaterThan(0)
  expect([...new Set(fetched)]).toEqual(['http://127.0.0.1:27124/'])
})

test('a session lock from lock_vault is shown, apart from the binding', async ($, on) => {
  wire(on, { list: { ...LIST, lockedTo: 'main' } })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Router verrouillé sur main pour cette session/ })).toBeTruthy()
  await ui.unmount()
})

test('an open pane redraws after the model binding calls, and after no other tool', async ($, on) => {
  const state: { list: unknown } = { list: LIST }
  const calls = wire(on, state)
  on('tool.call', () => ({ result: 'ok' }))
  await begin($)
  const lists = () => calls.filter(c => c.tool === 'list_vaults').length

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Secondaires · 2$/ })).toBeTruthy()
  // The model drops a secondary: the pane shows it once the call is back.
  state.list = { ...LIST, workspaceBinding: { ...LIST.workspaceBinding, also: ['notes'] } }
  const before = lists()
  await $.tool.call({ tool: 'mcp__plugin_obsidian-router_router__lock_vault', vault: 'main' })
  // The redraw runs detached from the tool's result: wait for it, boundedly,
  // then count — the read is done once the pane shows its answer.
  expect(await eventually(() => ui.find({ type: 'Text', text: /^Secondaires · 1$/ }))).toBeTruthy()
  expect(lists()).toBe(before + 1)
  await $.tool.call({ tool: 'mcp__plugin_obsidian-router_router__get_file', path: 'a.md' })
  // A read it started would also run detached: give it the same round trips.
  for (let i = 0; i < 50; i += 1) {
    await ui.find({ type: 'Text', text: /^Principal$/ })
  }
  expect(lists()).toBe(before + 1)
  await ui.unmount()
})

test('a click drawn for one primary sends nothing once the router has another', async ($, on) => {
  const state: { list: unknown } = { list: LIST }
  const calls = wire(on, state)
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // Another session makes `extra` the primary, with `docs` as its secondary.
  state.list = { ...LIST, workspaceBinding: { ...LIST.workspaceBinding, vault: 'extra', also: ['docs'] } }
  await ui.press({ key: 'remove-docs' })
  expect(calls.some(c => c.tool === 'confirm_workspace_binding')).toBe(false)
  expect(await ui.find({ type: 'Text', text: /La liaison a changé entre-temps \(principal : extra\)/ })).toBeTruthy()
  await ui.unmount()
})

test('an older read of the router landing last never overwrites a newer one', async ($, on) => {
  const state: { list: unknown; held?: Promise<void> } = { list: LIST }
  const calls = wire(on, state)
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // Read A sees the old binding and is held; read B sees the new one and lands.
  let release = () => {}
  state.held = new Promise<void>(resolve => {
    release = resolve
  })
  const sent = calls.length
  const older = ui.press({ key: 'refresh' })
  // A must have read the OLD list before it changes: wait for its call.
  expect(
    await eventually(async () => {
      await ui.find({ type: 'Text', text: /^Principal$/ })

      return calls.length > sent || undefined
    }),
  ).toBe(true)
  state.list = { ...LIST, workspaceBinding: { ...LIST.workspaceBinding, also: ['notes'] } }
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /^Secondaires · 1$/ })).toBeTruthy()
  release()
  await older
  expect(await ui.find({ type: 'Text', text: /^Secondaires · 1$/ })).toBeTruthy()
  await ui.unmount()
})

test('a start superseded while its pane opens leaves no pane running', async ($, on) => {
  let release = () => {}
  const state: { list: unknown; env: Record<string, string>; opens?: number; closes?: number; openHeld?: Promise<void> } = {
    list: LIST,
    env: {},
    // The first start's ui.open is held; an opted-out start lands meanwhile.
    openHeld: new Promise<void>(resolve => {
      release = resolve
    }),
  }
  const calls = wire(on, state)
  on('tool.call', () => ({ result: 'ok' }))

  await $.session.start(START)
  // Waits for the first start's detached read to reach its held ui.open;
  // each probe is a round trip through the engine.
  const tick = async () => {
    await $.tool.call({ tool: 'Read', file_path: 'a.md' })
  }
  expect(await eventually(async () => (await tick(), state.opens))).toBe(1)
  state.env.OBSIDIAN_ROUTER_NO_VAULT_PANEL = 'true'
  await $.session.start(START)
  release()
  for (let i = 0; i < 20; i += 1) {
    await tick()
  }

  // The pane the first start opened is closed again, and none is live: the
  // model's binding calls redraw nothing.
  expect(state.closes).toBe(1)
  const before = calls.filter(c => c.tool === 'list_vaults').length
  await $.tool.call({ tool: 'mcp__plugin_obsidian-router_router__lock_vault', vault: 'main' })
  expect(calls.filter(c => c.tool === 'list_vaults').length).toBe(before)
})

test('a stale Principal button never replaces a binding made meanwhile', async ($, on) => {
  const unbound = { ...LIST, workspaceBinding: null }
  const state: { list: unknown } = { list: unbound }
  const calls = wire(on, state)
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openAdd(ui)
  await ui.press({ key: 'tab-locaux' })
  expect(await ui.find({ type: 'Button', key: 'primary-notes' })).toBeTruthy()

  // Another session binds the workspace to `main` after this pane drew.
  state.list = LIST
  await ui.press({ key: 'primary-notes' })
  expect(calls.some(c => c.tool === 'confirm_workspace_binding')).toBe(false)
  expect(await ui.find({ type: 'Text', text: /Un principal a été choisi entre-temps \(main\)/ })).toBeTruthy()
  await ui.unmount()
})

test('a binding answer without `also` draws, and a click still sends a list', async ($, on) => {
  const { also: _dropped, ...bare } = LIST.workspaceBinding
  const state: { list: unknown } = { list: { ...LIST, workspaceBinding: bare } }
  const calls = wire(on, state)
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Secondaires · 0$/ })).toBeTruthy()
  await openAdd(ui)
  await ui.press({ key: 'tab-distants' })
  await ui.press({ key: 'add-extra' })
  expect(calls.filter(c => c.tool === 'confirm_workspace_binding').at(-1)?.args).toEqual({ vault: 'main', also: ['extra'], open: false })
  await ui.unmount()
})

test("a read the previous session left running writes nothing into the next one", async ($, on) => {
  let release = () => {}
  const state: { list: unknown; env: Record<string, string>; held?: Promise<void> } = {
    list: LIST,
    env: {},
    // The first start's own read of the router is held.
    held: new Promise<void>(resolve => {
      release = resolve
    }),
  }
  const calls = wire(on, state)
  on('tool.call', () => ({ result: 'ok' }))
  const tick = async () => {
    await $.tool.call({ tool: 'Read', file_path: 'a.md' })
  }

  await $.session.start(START)
  expect(await eventually(async () => (await tick(), calls.some(c => c.tool === 'list_vaults') || undefined))).toBe(true)
  state.env.OBSIDIAN_ROUTER_NO_VAULT_PANEL = 'true'
  await $.session.start(START)
  release()
  for (let i = 0; i < 20; i += 1) {
    await tick()
  }

  // The opted-out session never read the router: its pane state is empty.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Principal$/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /lecture du router/i })).toBeTruthy()
  await ui.unmount()
})

test('the router is reached under the name mcp.connect gives for the plugin server', async ($, on) => {
  const servers: string[] = []
  mock.env(on, {})
  mock.clock(on)
  on('mcp.connect', (_, e) => {
    expect(e.server).toBe('router')

    // The session runs the same server under another name.
    return { value: { isConnected: true, server: 'router-as-the-session-names-it' } }
  })
  on('mcp.call', (_, e) => {
    servers.push(e.server)

    return { value: { content: [{ type: 'text', text: JSON.stringify(LIST) }], isError: false } }
  })
  on('command.register', () => ({ value: { command: 'vaults' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: '' }))
  await begin($)
  expect(servers.length).toBeGreaterThan(0)
  expect([...new Set(servers)]).toEqual(['router-as-the-session-names-it'])
})

test('a router still starting at session start: the startup read retries, then opens the pane', async ($, on) => {
  let failures = 2
  let opens = 0
  mock.env(on, {})
  const clock = mock.clock(on)
  on('mcp.call', () => {
    if (failures > 0) {
      failures -= 1

      return { value: { content: [{ type: 'text', text: 'server not connected yet' }], isError: true } }
    }

    return { value: { content: [{ type: 'text', text: JSON.stringify(LIST) }], isError: false } }
  })
  on('command.register', () => ({ value: { command: 'vaults' } }))
  on('ui.open', () => {
    opens += 1

    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start(START)
  expect(opens).toBe(0)
  // Two failed reads, three seconds apart; the third answers.
  await clock.advance(3_000)
  await clock.advance(3_000)
  expect(opens).toBe(1)
})

test('a pane /vaults opened during the startup retries is not opened a second time', async ($, on) => {
  let failures = 1
  let opens = 0
  mock.env(on, {})
  const clock = mock.clock(on)
  on('mcp.call', (_, e) => {
    if (e.tool === 'list_vaults' && failures > 0) {
      failures -= 1

      return { value: { content: [{ type: 'text', text: 'server not connected yet' }], isError: true } }
    }

    return { value: { content: [{ type: 'text', text: JSON.stringify(LIST) }], isError: false } }
  })
  on('command.register', () => ({ value: { command: 'vaults' } }))
  on('ui.open', () => {
    opens += 1

    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: '' }))

  await $.session.start(START)
  // The first startup read failed; the person opens the pane by hand.
  await $.command.run({
    command: 'vaults',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(opens).toBe(1)
  // The startup retry now succeeds: the pane is already open.
  await clock.advance(3_000)
  expect(opens).toBe(1)
})

test('a router call that never answers at start is given up, and the next try fills the pane', async ($, on) => {
  let calls = 0
  let opens = 0
  mock.env(on, {})
  const clock = mock.clock(on)
  on('mcp.call', async () => {
    calls += 1
    if (calls === 1) {
      // The first read hangs, as a call made while the server connects can.
      await new Promise(() => {})
    }

    return { value: { content: [{ type: 'text', text: JSON.stringify(LIST) }], isError: false } }
  })
  on('command.register', () => ({ value: { command: 'vaults' } }))
  on('ui.open', () => {
    opens += 1

    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start(START)
  expect(opens).toBe(0)
  // The hung read is given up after 15 s — a failure, so nothing opens yet…
  await clock.advance(15_000)
  expect(opens).toBe(0)
  expect(calls).toBe(1)
  // …and the next try, 3 s later, is a second call that answers.
  await clock.advance(3_000)
  expect(calls).toBe(2)
  expect(opens).toBe(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Principal$/ })).toBeTruthy()
  // Drawn with data: the pane starts no read of its own.
  expect(calls).toBe(2)
  await ui.unmount()
})

test('a pane the app drew on its own gets the redraws after the model binding calls', async ($, on) => {
  const state: { list: unknown } = { list: LIST }
  const calls = wire(on, state)
  on('tool.call', () => ({ result: 'ok' }))
  // The session starts with a router that never answers: no pane is opened by
  // the module, and the tries give up.
  state.list = undefined
  await $.session.start(START)
  // The app draws the pane anyway (restored layout): it shows the failed read.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Principal$/ })).toBeFalsy()
  // The router is up now, and the model changes the binding.
  state.list = { ...LIST, workspaceBinding: { ...LIST.workspaceBinding, also: ['notes'] } }
  const before = calls.filter(c => c.tool === 'list_vaults').length
  await $.tool.call({ tool: 'mcp__plugin_obsidian-router_router__lock_vault', vault: 'main' })
  expect(await eventually(() => ui.find({ type: 'Text', text: /^Secondaires · 1$/ }))).toBeTruthy()
  expect(calls.filter(c => c.tool === 'list_vaults').length).toBe(before + 1)
  await ui.unmount()
})

test('the layout: a summary, closed vaults and adding folded away, one open-all, a filter over secondaries', async ($, on) => {
  wire(on, { list: LIST })
  await begin($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // main and docs answer, notes does not: 3 bound, 2 open.
    expect(await ui.find({ type: 'Text', text: /^3 liés · 2 ouverts · màj / })).toBeTruthy()
    // The closed secondary is folded away, behind its group and one open-all.
    expect(await ui.find({ type: 'Button', key: 'toggle-closed' })).toBeTruthy()
    expect(await ui.find({ key: 'mode-notes' })).toBeFalsy()
    expect(await ui.find({ type: 'Button', key: 'open-closed' })).toBeTruthy()
    expect(await ui.find({ key: 'mode-docs' })).toBeTruthy()
    // Adding is folded too, while there is a primary.
    expect(await ui.find({ type: 'Button', key: 'toggle-add' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'tab-locaux' })).toBeFalsy()
    await ui.unmount()
  }

  // The filter narrows the secondaries as well as the add list.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'filter', text: 'nothing-matches', kind: 'change' })
  expect(await ui.find({ key: 'mode-docs' })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^Aucun secondaire ne correspond au filtre\.$/ })).toBeTruthy()
  await ui.input({ key: 'filter', text: '', kind: 'change' })
  expect(await ui.find({ key: 'mode-docs' })).toBeTruthy()
  await ui.unmount()
})

test('with no primary yet, the add list is open without asking', async ($, on) => {
  wire(on, { list: { ...LIST, workspaceBinding: null } })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'tab-locaux' })).toBeTruthy()
  await ui.unmount()
})

test('on the phone (no menu, no field): the tier keeps its three buttons, and a filter typed elsewhere hides nothing', async ($, on) => {
  const calls = wire(on, { list: LIST })
  await begin($)
  // A filter typed on the desktop…
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desk.input({ key: 'filter', text: 'nothing-matches', kind: 'change' })
  await desk.unmount()
  // …does not hide the phone's rows, and the tier is still changeable there.
  const phone = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await phone.find({ type: 'Button', key: 'mode-docs-writable' })).toBeTruthy()
  await phone.press({ key: 'mode-docs-writable' })
  expect(calls.find(c => c.tool === 'set_secondary_vault_mode')?.args).toEqual({ vault: 'docs', mode: 'writable' })
  await phone.unmount()
})

// The router's own words for a stale ifBindingDigest.
const STALE_ROUTER_TEXT =
  'confirm_workspace_binding: this workspace binding entry now differs from the one that diagnostic described'

test('a click starts from the entry the router last reported: no list_vaults before the write', async ($, on) => {
  const state = {
    list: ON_FILE as unknown,
    // The write answers with the entry it left, as router v0.102.2+ does.
    writeAnswer: { workspaceBindingOnFile: { digest: 'e'.repeat(64), vault: 'main', also: ['notes', 'extra'], aliases: 0 } } as unknown,
  }
  const calls = wire(on, state)
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openAdd(ui)
  await ui.press({ key: 'tab-distants' })

  // First click: computed from the refresh's entry, sent straight away. From
  // here every read fails, so the second click can only start from what the
  // write itself answered.
  ;(state as { refuse?: string }).refuse = 'list_vaults'
  const before = calls.length
  await ui.press({ key: 'add-extra' })
  expect(calls[before]?.tool).toBe('confirm_workspace_binding')
  expect(calls[before]?.args).toEqual({ vault: 'main', also: ['notes', 'extra'], ifBindingDigest: 'd'.repeat(64), ifNoOtherSpellings: true, open: false })

  // Second click: computed from what the first write answered — still no read first.
  await openClosed(ui)
  const second = calls.length
  await ui.press({ key: 'remove-notes' })
  expect(calls[second]?.tool).toBe('confirm_workspace_binding')
  expect(calls[second]?.args).toEqual({ vault: 'main', also: ['extra'], ifBindingDigest: 'e'.repeat(64), ifNoOtherSpellings: true, open: false })
  await ui.unmount()
})

test('a write refused as stale is rebuilt once from a fresh read and sent again', async ($, on) => {
  const state = { list: ON_FILE as unknown, refuseOnce: 'confirm_workspace_binding', refuseText: STALE_ROUTER_TEXT }
  const calls = wire(on, state)
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Another session changed the entry: the next read reports it.
  state.list = { ...ON_FILE, workspaceBindingOnFile: { digest: 'f'.repeat(64), vault: 'main', also: ['notes', 'docs'] } }
  const before = calls.length
  await ui.press({ key: 'remove-docs' })
  expect(calls.slice(before, before + 3).map(c => c.tool)).toEqual([
    'confirm_workspace_binding',
    'list_vaults',
    'confirm_workspace_binding',
  ])
  expect(calls[before + 2]?.args).toEqual({ vault: 'main', also: ['notes'], ifBindingDigest: 'f'.repeat(64), ifNoOtherSpellings: true, open: false })
  // It went through: no failure on screen.
  expect(await ui.find({ type: 'Text', text: /modifiée pendant l'envoi/ })).toBeFalsy()
  await ui.unmount()
})

test('with a router older than ifNoOtherSpellings, every click reads the entry afresh before its write', async ($, on) => {
  const calls = wire(on, { list: { ...ON_FILE, routerBuild: { version: '0.102.1' } } })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const before = calls.length
  await ui.press({ key: 'remove-docs' })
  expect(calls.slice(before, before + 2).map(c => c.tool)).toEqual(['list_vaults', 'confirm_workspace_binding'])
  await ui.unmount()
})

// A config, an Obsidian vault list and an environment for the 💎 tests.
const LOCAL_LIST = {
  workspaceBinding: { vault: 'main', also: ['notes', 'lost'], locked: false },
  vaults: [
    { name: 'main', type: 'remote', online: true },
    { name: 'notes', type: 'local', online: false, path: 'C:\\VAULTS\\Notes' },
    { name: 'lost', type: 'local', online: false, path: 'M:\\Drive\\Lost' },
  ],
  disabled: [],
}

function obsidianKnows(on: On, folders: string[]) {
  on('fs.read', (_, e) => {
    // The engine hands the path over in the platform's own separators.
    if (/obsidian[\\/]obsidian\.json$/.test(e.path)) {
      const vaults = Object.fromEntries(folders.map((p, i) => [`id${i}`, { path: p }]))

      return { value: JSON.stringify({ vaults }) }
    }
    throw new Error(`no such file: ${e.path}`)
  })
}

const drawnText = async (ui: { drawn(): Promise<unknown> }) => JSON.stringify(await ui.drawn())

test('a closed local vault Obsidian knows gets its own 💎, which launches it; one it does not know says so instead', async ($, on) => {
  wire(on, { list: LOCAL_LIST, env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } })
  obsidianKnows(on, ['C:\\VAULTS\\Notes'])
  const launched: (readonly string[])[] = []
  on('process.run', (_, e) => {
    launched.push(e.argv)

    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openClosed(ui)
  expect(await ui.find({ type: 'Button', key: 'obsidian-notes' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'obsidian-lost' })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^à ouvrir une fois dans Obsidian$/ })).toBeTruthy()
  await ui.press({ key: 'obsidian-notes' })
  // By Obsidian's own id for that folder, not its name: two folders may share one.
  expect(launched).toEqual([['explorer.exe', 'obsidian://open?vault=id0']])
  await ui.unmount()
})

test('a remote vault with a web UI: 🌐 links to it, 🪟 opens it in the app browser', async ($, on) => {
  const calls = wire(on, { list: LIST })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openAdd(ui)
  await ui.press({ key: 'tab-distants' })
  expect(await drawnText(ui)).toContain('"href":"https://10.8.0.1:3002/"')
  await ui.press({ key: 'ui-extra' })
  expect(calls.some(c => c.tool === 'preview_start')).toBe(true)
  await ui.unmount()
})

test('when the app browser cannot be reached, the panel points to the 🌐 link', async ($, on) => {
  // No browser pane answers under either name.
  const calls = wire(on, { list: LIST, refuse: 'preview_start', refuseText: 'server not found' })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openAdd(ui)
  await ui.press({ key: 'tab-distants' })
  await ui.press({ key: 'ui-extra' })
  expect(calls.filter(c => c.tool === 'preview_start').length).toBeGreaterThan(0)
  expect(await ui.find({ type: 'Text', text: /Le lien 🌐 ouvre la même interface/ })).toBeTruthy()
  await ui.unmount()
})

test('every remote vault silent: a WireGuard banner; one answering: none', async ($, on) => {
  const down = {
    ...LIST,
    vaults: LIST.vaults.map(v => (v.type === 'remote' ? { ...v, online: false } : v)),
  }
  const state: { list: unknown } = { list: down }
  wire(on, state)
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^WireGuard semble inactif/ })).toBeTruthy()
  state.list = LIST
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /^WireGuard semble inactif/ })).toBeFalsy()
  await ui.unmount()
})

test('every tier menu sits in a box of one fixed width, whatever tier it shows', async ($, on) => {
  wire(on, { list: LIST })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openClosed(ui)
  const tree = JSON.stringify(await ui.drawn())
  // docs is read-only (locked), notes write-on-request: two tiers, one width.
  const widths = [...tree.matchAll(/"width":(\d+),"minWidth":\d+,"flexShrink":0},"children":\[\{"type":"Select"/g)].map(m => m[1])
  expect(widths.length).toBe(2)
  expect(new Set(widths).size).toBe(1)
  await ui.unmount()
})
