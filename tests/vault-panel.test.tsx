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
    expect(await ui.find({ type: 'Text', text: /^VAULT PRINCIPAL$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^VAULTS SECONDAIRES \(2\)$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'open-notes' })).toBeTruthy()
    // The add list holds the unbound vaults only, by tab; the
    // operator-disabled vault is left out.
    await ui.press({ key: 'tab-locaux' })
    expect((await ui.find({ type: 'Text', text: /^closed$/ }))?.text).toBe('closed')
    expect(await ui.find({ type: 'Text', text: /^off$/ })).toBeFalsy()
    expect(await ui.find({ type: 'Button', key: 'add-extra' })).toBeFalsy()
    await ui.press({ key: 'tab-distants' })
    expect(await ui.find({ type: 'Button', key: 'add-extra' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'add-closed' })).toBeFalsy()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'mode-notes-writable' })
  expect(calls.find(c => c.tool === 'set_secondary_vault_mode')?.args).toEqual({ vault: 'notes', mode: 'writable' })

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
  })

  await ui.press({ key: 'open-notes' })
  expect(calls.filter(c => c.tool === 'confirm_workspace_binding').at(-1)?.args).toEqual({
    vault: 'main',
    also: ['docs', 'notes'],
  })

  await ui.press({ key: 'remove-docs' })
  expect(calls.filter(c => c.tool === 'confirm_workspace_binding').at(-1)?.args).toEqual({
    vault: 'main',
    also: ['notes'],
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
function wire(on: On, state: { list: unknown; refuse?: string; refuseText?: string; held?: Promise<void>; env?: Record<string, string>; opens?: number; closes?: number; openHeld?: Promise<void> }) {
  const calls: { server: string; tool: string; args: Record<string, unknown> }[] = []
  on('env.get', (_, e) => ({ value: state.env?.[e.name] }))
  on('mcp.call', async (_, e) => {
    calls.push(e)
    // What this answer says is read now; when it lands is the hold's call.
    const list = JSON.stringify(state.list)
    const held = e.tool === 'list_vaults' ? state.held : undefined
    state.held = undefined
    await held
    if (e.tool === state.refuse) {
      const text = state.refuseText ?? `${e.tool} refused: binding changed meanwhile`

      return { value: { content: [{ type: 'text', text }], isError: true } }
    }
    const text = e.tool === 'list_vaults' ? list : '{"ok":true}'

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
  await ui.press({ key: 'tab-distants' })

  // Another session locks the workspace and drops `docs` after this pane drew.
  state.list = { ...LIST, workspaceBinding: { ...LIST.workspaceBinding, locked: true, also: ['notes'] } }
  await ui.press({ key: 'add-extra' })
  const sent = calls.filter(c => c.tool === 'confirm_workspace_binding').at(-1)?.args
  expect(sent).toEqual({ vault: 'main', also: ['notes', 'extra'] })
  expect(sent && 'locked' in sent).toBe(false)
  await ui.unmount()
})

// A router of v0.101.0+ also says what the FILE holds, with the digest of it.
const ON_FILE = {
  ...LIST,
  // The live copy lags: it still lists `docs`, which the file has dropped.
  workspaceBindingOnFile: { digest: 'd'.repeat(64), vault: 'main', also: ['notes'] },
}

test('a click is computed from the entry on file and sent with its digest', async ($, on) => {
  const state: { list: unknown } = { list: ON_FILE }
  const calls = wire(on, state)
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-distants' })
  await ui.press({ key: 'add-extra' })
  expect(calls.filter(c => c.tool === 'confirm_workspace_binding').at(-1)?.args).toEqual({
    vault: 'main',
    also: ['notes', 'extra'],
    ifBindingDigest: 'd'.repeat(64),
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
  await ui.press({ key: 'tab-locaux' })
  await ui.press({ key: 'primary-notes' })
  expect(calls.filter(c => c.tool === 'confirm_workspace_binding').at(-1)?.args).toEqual({
    vault: 'notes',
    ifBindingDigest: 'e'.repeat(64),
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
  await ui.press({ key: 'tab-distants' })
  await ui.press({ key: 'add-extra' })
  expect(await ui.find({ type: 'Text', text: /La liaison a été modifiée pendant l'envoi/ })).toBeTruthy()
  await ui.unmount()
})

test('a refused change keeps its error on screen after the read-back', async ($, on) => {
  wire(on, { list: LIST, refuse: 'set_secondary_vault_mode' })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'mode-notes-writable' })
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
  expect(await ui.find({ type: 'Text', text: /^VAULTS SECONDAIRES \(2\)$/ })).toBeTruthy()
  // The model drops a secondary: the pane shows it once the call is back.
  state.list = { ...LIST, workspaceBinding: { ...LIST.workspaceBinding, also: ['notes'] } }
  const before = lists()
  await $.tool.call({ tool: 'mcp__plugin_obsidian-router_router__lock_vault', vault: 'main' })
  // The redraw runs detached from the tool's result: wait for it, boundedly,
  // then count — the read is done once the pane shows its answer.
  expect(await eventually(() => ui.find({ type: 'Text', text: /^VAULTS SECONDAIRES \(1\)$/ }))).toBeTruthy()
  expect(lists()).toBe(before + 1)
  await $.tool.call({ tool: 'mcp__plugin_obsidian-router_router__get_file', path: 'a.md' })
  // A read it started would also run detached: give it the same round trips.
  for (let i = 0; i < 50; i += 1) {
    await ui.find({ type: 'Text', text: /^VAULT PRINCIPAL$/ })
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
      await ui.find({ type: 'Text', text: /^VAULT PRINCIPAL$/ })

      return calls.length > sent || undefined
    }),
  ).toBe(true)
  state.list = { ...LIST, workspaceBinding: { ...LIST.workspaceBinding, also: ['notes'] } }
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /^VAULTS SECONDAIRES \(1\)$/ })).toBeTruthy()
  release()
  await older
  expect(await ui.find({ type: 'Text', text: /^VAULTS SECONDAIRES \(1\)$/ })).toBeTruthy()
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
  expect(await ui.find({ type: 'Text', text: /^VAULTS SECONDAIRES \(0\)$/ })).toBeTruthy()
  await ui.press({ key: 'tab-distants' })
  await ui.press({ key: 'add-extra' })
  expect(calls.filter(c => c.tool === 'confirm_workspace_binding').at(-1)?.args).toEqual({ vault: 'main', also: ['extra'] })
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
  expect(await ui.find({ type: 'Text', text: /^VAULT PRINCIPAL$/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /Lecture du router/ })).toBeTruthy()
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
  expect(await ui.find({ type: 'Text', text: /^VAULT PRINCIPAL$/ })).toBeTruthy()
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
  expect(await ui.find({ type: 'Text', text: /^VAULT PRINCIPAL$/ })).toBeFalsy()
  // The router is up now, and the model changes the binding.
  state.list = { ...LIST, workspaceBinding: { ...LIST.workspaceBinding, also: ['notes'] } }
  const before = calls.filter(c => c.tool === 'list_vaults').length
  await $.tool.call({ tool: 'mcp__plugin_obsidian-router_router__lock_vault', vault: 'main' })
  expect(await eventually(() => ui.find({ type: 'Text', text: /^VAULTS SECONDAIRES \(1\)$/ }))).toBeTruthy()
  expect(calls.filter(c => c.tool === 'list_vaults').length).toBe(before + 1)
  await ui.unmount()
})
