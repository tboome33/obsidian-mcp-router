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

// The engine's two $.mcp.call errors, as Claude Code words them (read off its
// binary, 2026-10-23). A permission refusal, which a test hook cannot make it
// say: carried as the call's text, which the panel reads the same way. One
// difference: an answered call keeps its server name, a real (rejected) one
// does not, so in a session the panel asks mcp.connect again, at most 10 times.
const refusal = (server: string, tool: string) =>
  `obsidian-router: $.mcp.call(${server}, ${tool}) refused: The server-side auto mode classifier gave no verdict ` +
  `for mcp__x__${tool}: the request that produced this action did not ask for one.`
// A server not connected: a hook's `{ deny }` makes the engine reject the call
// with `<plugin>: $.mcp.call: <reason>`, the very words it uses for this one.
const notConnected = (server: string, tool: string) => ({
  deny: `no connected MCP tool "${tool}" on a server named "${server}"`,
})

// Answers every engine call the panel makes; `list` is read at each list_vaults.
// `hold`, when set, holds the next list_vaults answer until the test calls
// the function it returns: the way to make two reads overlap.
function wire(on: On, state: { list: unknown; answers?: Record<string, unknown>; refuse?: string; refuseOnce?: string; unreachable?: string; refuseText?: string; writeAnswer?: unknown; held?: Promise<void>; env?: Record<string, string>; opens?: number; closes?: number; openHeld?: Promise<void>; blocked?: string[]; toasts?: string[]; unplaced?: boolean; clock?: ReturnType<typeof mock.clock> }) {
  const calls: { server: string; tool: string; args: Record<string, unknown> }[] = []
  on('env.get', (_, e) => ({ value: state.env?.[e.name] }))
  on('mcp.call', async (_, e) => {
    calls.push(e)
    // What this answer says is read now; when it lands is the hold's call.
    const list = JSON.stringify(state.list)
    const held = e.tool === 'list_vaults' ? state.held : undefined
    state.held = undefined
    await held
    // A server the session does not run: the call itself rejects.
    if (e.tool === state.unreachable) {
      throw new Error(`${e.server}: server not found`)
    }
    // Claude Code's permissions refusing the call, in the engine's words. A
    // test hook's `{ deny }` makes the engine say `$.mcp.call: <reason>`, not
    // the `(server, tool) refused:` form a real refusal takes, so the words
    // are carried as the call's text: the panel reads both the same way.
    if (state.blocked?.includes(e.tool)) {
      return { value: { content: [{ type: 'text', text: refusal(e.server, e.tool) }], isError: true } }
    }
    if (e.tool === state.refuse || e.tool === state.refuseOnce) {
      if (e.tool === state.refuseOnce) {
        state.refuseOnce = undefined
      }
      const text = state.refuseText ?? `${e.tool} refused: binding changed meanwhile`

      return { value: { content: [{ type: 'text', text }], isError: true } }
    }
    const answer = state.answers?.[e.tool]
    const answered = typeof answer === 'function' ? answer(e.args) : answer
    const text = e.tool === 'list_vaults' ? list : JSON.stringify(answered ?? state.writeAnswer ?? { ok: true })

    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  on('command.register', () => ({ value: { command: 'vaults' } }))
  on('ui.open', async () => {
    state.opens = (state.opens ?? 0) + 1
    const held = state.openHeld
    state.openHeld = undefined
    await held

    // A narrow terminal answers an unasked open without drawing it.
    return { value: state.unplaced ? { isPlaced: false as const, reason: 'narrow terminal' } : { isPlaced: true as const } }
  })
  on('ui.close', () => {
    state.closes = (state.closes ?? 0) + 1

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    state.toasts?.push(e.text)

    return { value: undefined }
  })
  state.clock = mock.clock(on)
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
    // The plugin's own update check reads GitHub: not a vault probe.
    if (!e.url.startsWith('https://raw.githubusercontent.com/')) {
      fetched.push(e.url)
    }

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

test('the layout: a status line, every secondary as a tile, adding folded away, a filter over secondaries', async ($, on) => {
  wire(on, { list: LIST })
  await begin($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // main and docs answer, notes does not: 3 bound, 1 to check.
    expect(await ui.find({ type: 'Text', text: /^3 liés · 1 à vérifier$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Mis à jour à / })).toBeTruthy()
    // The closed secondary is a tile like the others, and the open-all is in the status line.
    expect(await ui.find({ key: 'mode-notes' })).toBeTruthy()
    expect(await ui.find({ key: 'mode-docs' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'open-closed' })).toBeTruthy()
    // Adding is folded, while there is a primary: one button and how many.
    expect(await ui.find({ type: 'Button', key: 'toggle-add' })).toMatchObject({ props: { label: '+ Ajouter un vault' } })
    expect(await ui.find({ type: 'Text', text: /^2 disponibles$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'tab-locaux' })).toBeFalsy()
    await ui.unmount()
  }

  // The filter narrows the secondaries.
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

test('an open local vault keeps its 💎: the same address brings its window to the front', async ($, on) => {
  const open = {
    ...LOCAL_LIST,
    vaults: LOCAL_LIST.vaults.map(v => (v.name === 'notes' ? { ...v, online: true } : v)),
  }
  wire(on, { list: open, env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } })
  obsidianKnows(on, ['C:\\VAULTS\\Notes'])
  const launched: (readonly string[])[] = []
  on('process.run', (_, e) => {
    // The WireGuard read (PowerShell) runs at every start: not a launch.
    if (e.argv[0] !== 'powershell') {
      launched.push(e.argv)
    }

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openClosed(ui)
  await ui.press({ key: 'obsidian-notes' })
  expect(launched).toEqual([['cmd', '/c', 'start', '', 'obsidian://open?vault=id0']])
  await ui.unmount()
})

test("a closed local vault shows Obsidian's purple mark, \"Obsidian fermé\" and its own open button", async ($, on) => {
  wire(on, { list: LOCAL_LIST, env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } })
  obsidianKnows(on, ['C:\\VAULTS\\Notes'])
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  await begin($)
  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openClosed(desktop)
  // The folder is matched to Obsidian's list after the read: waited for.
  await eventually(() => desktop.find({ type: 'Button', key: 'obsidian-notes' }))
  const box = nodesOf(await desktop.drawn()).find(n => keyOf(n) === 'obsidian-box-notes')
  const mark = nodesOf(box as never).find(n => n.type === 'Svg')
  expect(String(mark?.props?.source)).toContain('#A88BFA')
  expect(await desktop.find({ type: 'Text', text: /^Local · Obsidian fermé$/ })).toBeTruthy()
  expect(await desktop.find({ type: 'Button', key: 'obsidian-notes' })).toMatchObject({ props: { label: 'Ouvrir Obsidian ↗' } })
  await desktop.unmount()
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await openClosed(terminal)
  expect(await eventually(() => terminal.find({ type: 'Button', key: 'obsidian-notes' }))).toMatchObject({ props: { label: 'Ouvrir Obsidian ↗' } })
  await terminal.unmount()
})

test('a closed local vault Obsidian knows gets its own 💎, which launches it; one it does not know says so instead', async ($, on) => {
  wire(on, { list: LOCAL_LIST, env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } })
  obsidianKnows(on, ['C:\\VAULTS\\Notes'])
  const launched: (readonly string[])[] = []
  on('process.run', (_, e) => {
    // The WireGuard read (PowerShell) runs at every start: not a launch.
    if (e.argv[0] !== 'powershell') {
      launched.push(e.argv)
    }

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openClosed(ui)
  expect(await ui.find({ type: 'Button', key: 'obsidian-notes' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'obsidian-lost' })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^à ouvrir une fois dans Obsidian$/ })).toBeTruthy()
  await ui.press({ key: 'obsidian-notes' })
  // By Obsidian's own id for that folder, not its name: two folders may share
  // one. Through `start`, with its empty title: explorer.exe opened nothing.
  expect(launched).toEqual([['cmd', '/c', 'start', '', 'obsidian://open?vault=id0']])
  expect(await ui.find({ type: 'Text', text: /n'a pas pu être lancé/ })).toBeFalsy()
  await ui.unmount()
})

test('a 💎 launch that exits non-zero says so', async ($, on) => {
  wire(on, { list: LOCAL_LIST, env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } })
  obsidianKnows(on, ['C:\\VAULTS\\Notes'])
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: 'protocol not registered', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openClosed(ui)
  await ui.press({ key: 'obsidian-notes' })
  expect(await ui.find({ type: 'Text', text: /Obsidian n'a pas pu être lancé pour notes : protocol not registered/ })).toBeTruthy()
  await ui.unmount()
})

const GO = 'http://10.8.0.1:27200/go?v=extra&n=Welcome.md&s=sig'
const launches = (on: On) => {
  const launched: (readonly string[])[] = []
  on('process.run', (_, e) => {
    // The WireGuard read (PowerShell) runs at every start: not a launch.
    if (e.argv[0] !== 'powershell') {
      launched.push(e.argv)
    }

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  return launched
}

test('a remote vault with a web UI, no view agent: 🌐 and 🪟 open its own address', async ($, on) => {
  // get_view_link is not served: a router without a view agent hides it.
  const calls = wire(on, {
    list: LIST,
    answers: { list_files: { files: ['Welcome.md'] } },
    refuse: 'get_view_link',
    refuseText: 'Unknown tool: get_view_link',
    env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
  })
  const launched = launches(on)
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openAdd(ui)
  await ui.press({ key: 'tab-distants' })
  await ui.press({ key: 'web-extra' })
  expect(launched).toEqual([['rundll32', 'url.dll,FileProtocolHandler', 'https://10.8.0.1:3002/']])
  await ui.press({ key: 'ui-extra' })
  expect(calls.find(c => c.tool === 'preview_start')?.args).toEqual({ url: 'https://10.8.0.1:3002/' })
  await ui.unmount()
})

test('with a view agent, 🌐 and 🪟 go through its link to a note of the vault, which brings it to the front', async ($, on) => {
  const calls = wire(on, {
    list: LIST,
    answers: {
      // No note at the root: the first one in wiki/.
      list_files: (args: { directory: string }) =>
        args.directory === '' ? { files: ['wiki/', 'Untitled.base'] } : { files: ['index.md', 'log.md'] },
      get_view_link: { url: GO },
    },
    env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
  })
  const launched = launches(on)
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openAdd(ui)
  await ui.press({ key: 'tab-distants' })
  await ui.press({ key: 'web-extra' })
  expect(calls.find(c => c.tool === 'get_view_link')?.args).toEqual({ vault: 'extra', note: 'wiki/index.md' })
  expect(launched).toEqual([['rundll32', 'url.dll,FileProtocolHandler', GO]])
  await ui.press({ key: 'ui-extra' })
  expect(calls.find(c => c.tool === 'preview_start')?.args).toEqual({ url: GO })
  await ui.unmount()
})

test('a 🌐 launch that exits non-zero says so', async ($, on) => {
  wire(on, { list: LIST, env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } })
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: 'no browser', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openAdd(ui)
  await ui.press({ key: 'tab-distants' })
  await ui.press({ key: 'web-extra' })
  expect(await ui.find({ type: 'Text', text: /Navigateur : no browser/ })).toBeTruthy()
  await ui.unmount()
})

test('🪟 opens the vault in the app browser, and brings the browser pane into view', async ($, on) => {
  const calls = wire(on, { list: LIST })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openAdd(ui)
  await ui.press({ key: 'tab-distants' })
  await ui.press({ key: 'ui-extra' })
  expect(calls.some(c => c.tool === 'preview_start')).toBe(true)
  // The tab alone opens in a hidden pane: the pane is brought into view after it.
  const shown = await eventually(async () => calls.find(c => c.tool === 'show_pane'))
  expect(shown).toEqual({ server: 'ccd_view', tool: 'show_pane', args: { pane: 'preview' } })
  expect(calls.indexOf(shown!)).toBeGreaterThan(calls.findIndex(c => c.tool === 'preview_start'))
  await ui.unmount()
})

for (const how of ['refused', 'unreachable'] as const) {
test(`a pane that cannot be brought into view (${how}) leaves 🪟 silent: the tab is open`, async ($, on) => {
  const calls = wire(on, how === 'refused' ? { list: LIST, refuse: 'show_pane', refuseText: 'server not found' } : { list: LIST, unreachable: 'show_pane' })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openAdd(ui)
  await ui.press({ key: 'tab-distants' })
  await ui.press({ key: 'ui-extra' })
  expect(await eventually(async () => calls.find(c => c.tool === 'show_pane'))).toBeTruthy()
  expect(calls.filter(c => c.tool === 'preview_start').length).toBe(1)
  expect(await ui.find({ type: 'Text', text: /Navigateur interne/ })).toBeFalsy()
  await ui.unmount()
})
}

test('when the app browser cannot be reached, the panel points to the 🌐 link', async ($, on) => {
  // No browser pane answers under either name.
  const calls = wire(on, { list: LIST, refuse: 'preview_start', refuseText: 'server not found' })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openAdd(ui)
  await ui.press({ key: 'tab-distants' })
  await ui.press({ key: 'ui-extra' })
  expect(calls.filter(c => c.tool === 'preview_start').length).toBeGreaterThan(0)
  expect(await ui.find({ type: 'Text', text: /Le bouton 🌐 ouvre la même interface/ })).toBeTruthy()
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
  // No WireGuard read answers here (no `wg` to run): the banner is there,
  // in the words of whatever the pane could tell.
  expect(await ui.find({ key: 'tunnel-down' })).toBeTruthy()
  state.list = LIST
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ key: 'tunnel-down' })).toBeFalsy()
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

// What the pane and /vaults must name when Claude Code's permissions refuse
// the read: the rules to add, under the server the call went to.
const READ_RULES =
  /permissions\.allow.*mcp__plugin_obsidian-router_router__list_vaults\. Pour ses liens 🌐 et 🪟 : mcp__plugin_obsidian-router_router__list_files, mcp__plugin_obsidian-router_router__get_view_link\. Pour que ses clics changent la liaison : mcp__plugin_obsidian-router_router__confirm_workspace_binding, mcp__plugin_obsidian-router_router__set_secondary_vault_mode, mcp__plugin_obsidian-router_router__register_remote_vault, mcp__plugin_obsidian-router_router__unregister_vault — ces règles laissent aussi le modèle/s

test('a read refused by auto mode names the permissions to add, never "router injoignable"', async ($, on) => {
  wire(on, { list: LIST, blocked: ['list_vaults'] })
  await $.session.start(START)
  const said = await $.command.run({
    command: 'vaults',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(JSON.stringify(said)).toMatch(/Claude Code a bloqué \(mode auto\)/)
  expect(JSON.stringify(said)).not.toMatch(/le router ne répond pas/)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^bloqué par les permissions de Claude Code$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: READ_RULES })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /injoignable/i })).toBeFalsy()
  await ui.unmount()
})

test('a server not connected is no refusal: the next name is tried, and the panel fills', async ($, on) => {
  const servers: string[] = []
  mock.env(on, {})
  mock.clock(on)
  on('mcp.call', (_, e) => {
    servers.push(e.server)
    // A router declared by hand: no plugin server under the first name.
    if (e.server === 'plugin:obsidian-router:router') {
      return notConnected(e.server, e.tool)
    }

    return { value: { content: [{ type: 'text', text: JSON.stringify(LIST) }], isError: false } }
  })
  on('command.register', () => ({ value: { command: 'vaults' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: '' }))
  await begin($)
  expect(servers).toContain('obsidian-router')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Principal$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /bloqué/ })).toBeFalsy()
  await ui.unmount()
})

test('a router never connected still reads "router injoignable", never as a refusal', async ($, on) => {
  mock.env(on, {})
  mock.clock(on)
  on('mcp.call', (_, e) => notConnected(e.server, e.tool))
  on('command.register', () => ({ value: { command: 'vaults' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  const said = await $.command.run({
    command: 'vaults',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(JSON.stringify(said)).toMatch(/le router ne répond pas/)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^router injoignable$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Router injoignable : / })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /bloqué/ })).toBeFalsy()
  await ui.unmount()
})

test('a router still connecting at start is retried, opens, and raises no toast', async ($, on) => {
  let failures = 4
  let opens = 0
  const toasts: string[] = []
  mock.env(on, {})
  const clock = mock.clock(on)
  on('mcp.call', (_, e) => {
    if (failures > 0) {
      failures -= 1

      return notConnected(e.server, e.tool)
    }

    return { value: { content: [{ type: 'text', text: JSON.stringify(LIST) }], isError: false } }
  })
  on('command.register', () => ({ value: { command: 'vaults' } }))
  on('ui.open', () => {
    opens += 1

    return { value: { isPlaced: true } }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  // Each try asks both names: two failed tries, three seconds apart.
  await clock.advance(3_000)
  await clock.advance(3_000)
  expect(opens).toBe(1)
  expect(toasts).toEqual([])
})

test('a click refused by auto mode says nothing changed and names the two write rules', async ($, on) => {
  wire(on, { list: LIST, blocked: ['set_secondary_vault_mode'] })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openClosed(ui)
  await ui.select({ key: 'mode-notes', value: 'writable' })
  expect(
    await ui.find({
      type: 'Text',
      text: /rien n'a été changé.*mcp__plugin_obsidian-router_router__confirm_workspace_binding, mcp__plugin_obsidian-router_router__set_secondary_vault_mode, mcp__plugin_obsidian-router_router__register_remote_vault, mcp__plugin_obsidian-router_router__unregister_vault — ces règles laissent aussi le modèle/s,
    }),
  ).toBeTruthy()
  // Only the write rules: the read ones are not what this click needs.
  expect(await ui.find({ type: 'Text', text: /rien n'a été changé.*list_vaults/s })).toBeFalsy()
  await ui.unmount()
})

test('a startup read refused by auto mode is not retried: no pane, one toast pointing to /vaults', async ($, on) => {
  let reads = 0
  let opens = 0
  const toasts: string[] = []
  mock.env(on, {})
  const clock = mock.clock(on)
  on('mcp.call', (_, e) => {
    reads += 1

    return { value: { content: [{ type: 'text', text: refusal(e.server, e.tool) }], isError: true } }
  })
  on('command.register', () => ({ value: { command: 'vaults' } }))
  on('ui.open', () => {
    opens += 1

    return { value: { isPlaced: true } }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start(START)
  await eventually(async () => (toasts.length > 0 ? true : undefined))
  for (let i = 0; i < 4; i += 1) {
    await clock.advance(3_000)
  }
  expect(reads).toBe(1)
  expect(opens).toBe(0)
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toMatch(/\/vaults/)
})

// A drawn node, as ui.drawn() hands it back: what the layout tests walk.
type Drawn = { type?: string; key?: string; props?: Record<string, unknown>; children?: unknown }
const nodesOf = (tree: unknown): Drawn[] => {
  const out: Drawn[] = []
  const walk = (n: unknown) => {
    if (Array.isArray(n)) {
      n.forEach(walk)
    } else if (n && typeof n === 'object') {
      out.push(n as Drawn)
      walk((n as Drawn).children)
    }
  }
  walk(tree)
  return out
}
const keyOf = (n: Drawn) => n.key ?? (n.props?.key as string | undefined)
const textOf = (n: Drawn): string =>
  typeof n.children === 'string' ? n.children : Array.isArray(n.children) ? n.children.map(c => (typeof c === 'string' ? c : textOf(c as Drawn))).join('') : ''

test('the primary, the secondaries and the vaults to add are the same tile, in grids that wrap', async ($, on) => {
  wire(on, { list: LIST })
  await begin($)
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // The add list is folded by default: unfold it, on all of its vaults.
    await openAdd(ui)
    const nodes = nodesOf(await ui.drawn())
    // In LIST: one primary, two secondaries (one open, one closed), two vaults to add.
    const tiles = nodes.filter(n => n.props?.borderStyle === 'bold' && /^(primary-row|sec-|av-)/.test(keyOf(n) ?? ''))
    expect(tiles.map(n => keyOf(n))).toEqual(['primary-row', 'sec-docs', 'sec-notes', 'av-closed', 'av-extra'])
    const width = tiles[0]!.props?.width
    for (const tile of tiles) {
      // One tile for all three: same width (the side panel holds one per line), same border, same parts.
      expect(tile.props?.width).toBe(width)
      expect(tile.props?.borderStyle).toBe('bold')
      expect(tile.props?.flexDirection).toBe('column')
      const nameText = nodesOf(tile as never).find(n => n.type === 'Text' && n.props?.weight === 'semibold')
      expect(nameText).toBeTruthy()
      // Its controls wrap inside the tile rather than run past its edge.
      expect(nodes.find(n => keyOf(n) === `${keyOf(tile)}-controls`)?.props?.flexWrap).toBe('wrap')
    }
    // A bold frame for every tile, the primary's in Claude's colour.
    expect(tiles.map(n => n.props?.borderColor)).toEqual(['claude', 'inactive', 'inactive', 'inactive', 'inactive'])
    // The grids wrap.
    for (const key of ['sec-tiles', 'av-tiles']) {
      expect(nodes.find(n => keyOf(n) === key)?.props?.flexWrap).toBe('wrap')
    }
    // The phone has no menu: its three tier buttons wrap too.
    const modes = nodes.filter(n => /^modes-/.test(keyOf(n) ?? ''))
    expect(modes.length).toBe(surface === 'mobile' ? 2 : 0)
    for (const m of modes) {
      expect(m.props?.flexWrap).toBe('wrap')
      // Without shrinking, a wrapping box keeps its one-line width: no wrap.
      expect(m.props?.flexShrink).toBe(1)
    }
    await ui.unmount()
  }
})

test('section titles are bold and in the body colour; the pane title is not repeated', async ($, on) => {
  wire(on, { list: LIST })
  await begin($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const texts = nodesOf(await ui.drawn()).filter(n => n.type === 'Text')
    for (const title of [/^Principal$/, /^Secondaires · 2$/]) {
      const t = texts.find(n => title.test(textOf(n)))
      expect(t).toBeTruthy()
      expect(t?.props?.weight).toBe('semibold')
      expect(t?.props?.dimColor).toBeFalsy()
    }
    expect(texts.some(n => textOf(n) === 'Vaults')).toBe(false)
    await ui.unmount()
  }
})

test('the filter sits in the secondaries\' head, in a box of its own width', async ($, on) => {
  wire(on, { list: LIST })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const nodes = nodesOf(await ui.drawn())
  const head = nodes.find(n => keyOf(n) === 'secondaries-head')
  const box = nodesOf(head as never).find(n => keyOf(n) === 'filter-box')
  expect(box?.props?.width).toBe(22)
  expect(nodesOf(box as never).some(n => n.type === 'Input')).toBe(true)
  await ui.unmount()
})

test('no legend: the status line says how many are bound and whether they all answer', async ($, on) => {
  wire(on, { list: { ...LIST, vaults: LIST.vaults.map(v => ({ ...v, online: true })) } })
  await begin($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^3 liés · tous ouverts$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^local fermé$/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /^Principal$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Par défaut$/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('the Locaux and Distants tabs are real buttons, the open one lit', async ($, on) => {
  wire(on, { list: LIST })
  await begin($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await openAdd(ui)
    await ui.press({ key: 'tab-locaux' })
    const tabOf = async (key: string) => nodesOf(await ui.drawn()).find(n => n.type === 'Button' && keyOf(n) === key)
    expect((await tabOf('tab-locaux'))?.props?.variant).toBe('primary')
    expect((await tabOf('tab-distants'))?.props?.variant).toBe('secondary')
    expect((await tabOf('tab-locaux'))?.props?.plain).toBeFalsy()
    await ui.press({ key: 'tab-distants' })
    expect((await tabOf('tab-distants'))?.props?.variant).toBe('primary')
    expect((await tabOf('tab-locaux'))?.props?.variant).toBe('secondary')
    await ui.unmount()
  }
})

const BAND = {
  plugin: 'obsidian-router',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

// What stands for the engine's own band, under the plugin's.
function engineBand(on: On) {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine band</Text>
  })
}

const bandTexts = async (ui: { drawn(): Promise<unknown> }) =>
  nodesOf(await ui.drawn())
    .filter(n => n.type === 'Text')
    .map(textOf)

test('the band shows the primary, each secondary with its write badge, and keeps the band under it', async ($, on) => {
  wire(on, { list: LIST })
  engineBand(on)
  await begin($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const texts = await bandTexts(ui)
    expect(texts).toContain('main')
    // docs is read-only, notes writes on request: one badge each, in order.
    expect(texts.slice(texts.indexOf('docs'), texts.indexOf('notes') + 2)).toEqual(['docs', '🔒', '|', 'notes', '✋'])
    expect(texts.some(t => t.startsWith('…'))).toBe(false)
    expect(texts).toContain('engine band')
    await ui.unmount()
  }
})

test('a band too narrow for every secondary ends with "…" and how many it left out', async ($, on) => {
  const names = ['alpha-vault', 'beta-vault', 'gamma-vault', 'delta-vault', 'epsilon-vault']
  const many = { ...LIST, workspaceBinding: { ...LIST.workspaceBinding, also: names } }
  wire(on, { list: many })
  engineBand(on)
  await begin($)
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 90 }, surface: 'desktop' })
  const texts = await bandTexts(ui)
  const shown = names.filter(n => texts.includes(n))
  expect(shown.length).toBeGreaterThan(0)
  expect(shown.length).toBeLessThan(5)
  // Binding order: the first ones are kept, the tail is counted.
  expect(shown).toEqual(names.slice(0, shown.length))
  expect(texts).toContain(`… +${5 - shown.length}`)
  await ui.unmount()

  // Wide enough, all of them and no "…".
  const wide = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 200 }, surface: 'desktop' })
  const all = await bandTexts(wide)
  expect(names.every(n => all.includes(n))).toBe(true)
  expect(all.some(t => t.startsWith('…'))).toBe(false)
  await wide.unmount()
})

test("the band's toggle closes the pane, then opens it again", async ($, on) => {
  const state: { list: unknown; opens?: number; closes?: number } = { list: LIST }
  wire(on, state)
  engineBand(on)
  // /vaults opened the pane: the toggle offers to hide it.
  await begin($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const toggle = async () => nodesOf(await ui.drawn()).find(n => n.type === 'Button' && keyOf(n) === 'toggle-pane')
  expect((await toggle())?.props?.label).toBe('◧ Masquer le panneau')
  const closesBefore = state.closes ?? 0
  await ui.press({ key: 'toggle-pane' })
  expect(state.closes).toBe(closesBefore + 1)
  expect((await toggle())?.props?.label).toBe('◧ Afficher le panneau')
  const opensBefore = state.opens ?? 0
  await ui.press({ key: 'toggle-pane' })
  expect(state.opens).toBe(opensBefore + 1)
  expect((await toggle())?.props?.label).toBe('◧ Masquer le panneau')
  await ui.unmount()
})

test('the band yields to an unread router, to OBSIDIAN_ROUTER_NO_VAULT_BAND and to a survey', async ($, on) => {
  const state = { list: LIST as unknown, env: { OBSIDIAN_ROUTER_NO_VAULT_BAND: '1' } as Record<string, string> }
  wire(on, state)
  engineBand(on)
  // Not read yet: the engine's band only.
  const before = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await before.find({ type: 'Button', key: 'toggle-pane' })).toBeFalsy()
  expect(await before.find({ type: 'Text', text: /^engine band$/ })).toBeTruthy()
  await before.unmount()

  await begin($)
  // Opted out: the band is the engine's, the pane still works.
  const off = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await off.find({ type: 'Button', key: 'toggle-pane' })).toBeFalsy()
  expect(await off.find({ type: 'Text', text: /^engine band$/ })).toBeTruthy()
  await off.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /^Principal$/ })).toBeTruthy()
  await pane.unmount()

  // Opted in again: drawn, but a survey up makes it yield.
  state.env = {}
  await begin($)
  const shown = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await shown.find({ type: 'Button', key: 'toggle-pane' })).toBeTruthy()
  await shown.unmount()
  const survey = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true }, surface: 'desktop' })
  expect(await survey.find({ type: 'Button', key: 'toggle-pane' })).toBeFalsy()
  await survey.unmount()
})

test('the tier menu shows each tier with the badge the band uses', async ($, on) => {
  wire(on, { list: LIST })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const menu = nodesOf(await ui.drawn()).find(n => n.type === 'Select' && keyOf(n) === 'mode-docs')
  expect((menu?.props?.options as { label: string }[] | undefined)?.map(o => o.label)).toEqual([
    '🔒 Lecture seule',
    '✋ Écriture sur accord',
    '✏️ Lecture/écriture',
  ])
  await ui.unmount()
})

test('a pane asked for but waiting undrawn is offered by the band, and its press opens it', async ($, on) => {
  // A narrow terminal: the open is answered, not placed.
  const state: { list: unknown; opens?: number; unplaced?: boolean } = { list: LIST, unplaced: true }
  wire(on, state)
  engineBand(on)
  await begin($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const toggle = async () => nodesOf(await ui.drawn()).find(n => n.type === 'Button' && keyOf(n) === 'toggle-pane')
  expect((await toggle())?.props?.label).toBe('◧ Afficher le panneau')
  const opensBefore = state.opens ?? 0
  await ui.press({ key: 'toggle-pane' })
  expect(state.opens).toBe(opensBefore + 1)
  await ui.unmount()
})

test('hiding the pane while the startup read is under way keeps it hidden', async ($, on) => {
  let release = () => {}
  const state: { list: unknown; opens?: number; closes?: number; held?: Promise<void> } = {
    list: LIST,
    held: new Promise<void>(resolve => {
      release = resolve
    }),
  }
  wire(on, state)
  engineBand(on)
  // The startup read takes the hold; /vaults reads past it and opens the pane.
  await $.session.start(START)
  await $.command.run({
    command: 'vaults',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'toggle-pane' })).toBeTruthy()
  await ui.press({ key: 'toggle-pane' })
  const opensAfterHide = state.opens ?? 0
  // The startup read answers now: it must not reopen what was hidden.
  release()
  for (let i = 0; i < 50; i += 1) {
    await ui.drawn()
  }
  expect(state.opens ?? 0).toBe(opensAfterHide)
  const label = nodesOf(await ui.drawn()).find(n => n.type === 'Button' && keyOf(n) === 'toggle-pane')?.props?.label
  expect(label).toBe('◧ Afficher le panneau')
  await ui.unmount()
})

test('a band too narrow for even one secondary counts them all', async ($, on) => {
  wire(on, { list: LIST })
  engineBand(on)
  await begin($)
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 40 }, surface: 'desktop' })
  const texts = await bandTexts(ui)
  expect(texts.includes('docs') || texts.includes('notes')).toBe(false)
  expect(texts).toContain('… +2')
  await ui.unmount()
})

// The band's line, cell by cell, for main + docs + notes: "Principal : main",
// spacer, "Secondaires :" and the toggle take 59; "docs 🔒" 8 more; "| notes ✋"
// 11. At 69, docs would fit alone but not with "… +1" after it: the counter's
// room is kept, so nothing is shown and both are counted. At 78, both fit.
test('the band keeps room for "… +N" before it shows a secondary', async ($, on) => {
  wire(on, { list: LIST })
  engineBand(on)
  await begin($)
  const at = async (bodyColumns: number) => {
    const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns }, surface: 'desktop' })
    const texts = await bandTexts(ui)
    await ui.unmount()

    return texts
  }
  const firstShowing = async (name: string) => {
    for (let columns = 40; columns < 160; columns += 1) {
      if ((await at(columns)).includes(name)) {
        return columns
      }
    }

    return -1
  }
  const docsAt = await firstShowing('docs')
  const notesAt = await firstShowing('notes')
  // Below docs' width, both are counted in the chip; at it, docs and "… +1".
  expect(await at(docsAt - 1)).toContain('… +2')
  expect(await at(docsAt)).toContain('… +1')
  // notes, once it fits, takes the chip's room: no "…" any more.
  expect((await at(notesAt)).some(t => t.startsWith('…'))).toBe(false)
  // Neither opens anywhere (no folder, no web UI): no mark. notes' own width
  // (gap, "| ", 5 cells, badge, control) less the chip it frees.
  expect(notesAt - docsAt).toBe(1 + 2 + 5 + 1 + 2 + 1 + 1 - (1 + 4))
  expect([docsAt, notesAt]).toEqual([74, 82])
})

test('the band counts a name\'s mark where it is drawn: on the desktop, for a vault that opens', async ($, on) => {
  const openable = {
    ...LIST,
    workspaceBinding: { ...LIST.workspaceBinding, also: ['extra', 'notes'] },
    vaults: [...LIST.vaults.filter(v => v.name !== 'notes'), { name: 'notes', type: 'local', online: false, path: 'C:\\VAULTS\\Notes' }],
  }
  wire(on, { list: openable })
  engineBand(on)
  await begin($)
  const firstShowing = async (name: string, surface: 'desktop' | 'terminal') => {
    for (let columns = 40; columns < 160; columns += 1) {
      const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: columns }, surface })
      const has = (await bandTexts(ui)).includes(name)
      await ui.unmount()
      if (has) {
        return columns
      }
    }

    return -1
  }
  // The terminal draws no mark and counts none. The desktop: notes (local) its
  // Obsidian mark, 3 cells; extra (remote) the planet, 3, and Claude's mark with
  // its "↗", 5 more.
  expect([await firstShowing('extra', 'terminal'), await firstShowing('notes', 'terminal')]).toEqual([75, 83])
  expect([await firstShowing('extra', 'desktop'), await firstShowing('notes', 'desktop')]).toEqual([83, 94])
})

// Two cells per CJK character: "資料庫一" is 8 cells, not 4. With main + two
// such names the line needs 59 + 12 + 16 = 87; at 80 only the first fits.
test('the band counts a wide character as two cells', async ($, on) => {
  const wide = { ...LIST, workspaceBinding: { ...LIST.workspaceBinding, also: ['資料庫一', '文書庫二三'] } }
  wire(on, { list: wide })
  engineBand(on)
  await begin($)
  const at = async (bodyColumns: number) => {
    const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns }, surface: 'terminal' })
    const texts = await bandTexts(ui)
    await ui.unmount()

    return texts
  }
  let first = -1
  let second = -1
  for (let columns = 40; columns < 160 && second === -1; columns += 1) {
    const texts = await at(columns)
    if (first === -1 && texts.includes('資料庫一')) {
      first = columns
    }
    if (texts.includes('文書庫二三')) {
      second = columns
    }
  }
  expect(first).toBeGreaterThan(-1)
  // "文書庫二三" is 10 cells, not 5: its entry less the chip it frees.
  expect(second - first).toBe(1 + 2 + 10 + 1 + 2 + 1 + 1 - (1 + 4))
})

test('a pane the app draws on its own is told to the band', async ($, on) => {
  const state: { list: unknown; clock?: ReturnType<typeof mock.clock> } = { list: LIST }
  wire(on, state)
  engineBand(on)
  await begin($)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const label = async () => nodesOf(await band.drawn()).find(n => n.type === 'Button' && keyOf(n) === 'toggle-pane')?.props?.label
  // Hidden from the band: it offers the pane again.
  await band.press({ key: 'toggle-pane' })
  expect(await label()).toBe('◧ Afficher le panneau')
  // The app draws the pane from its saved layout, through no open of the
  // module's and with no read behind it: only the pane's own drawing says so.
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await state.clock?.advance(0)
  expect(await label()).toBe('◧ Masquer le panneau')
  await pane.unmount()
  await band.unmount()
})

test('the band names "Principal :" and "Secondaires :" in bold, the vault names plain', async ($, on) => {
  wire(on, { list: LIST })
  engineBand(on)
  await begin($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const texts = nodesOf(await ui.drawn()).filter(n => n.type === 'Text')
  const byText = (words: string) => texts.find(n => textOf(n) === words)
  expect(byText('Principal :')?.props?.weight).toBe('semibold')
  expect(byText('Secondaires :')?.props?.weight).toBe('semibold')
  expect(byText('main')?.props?.weight).toBeFalsy()
  expect(byText('docs')?.props?.weight).toBeFalsy()
  await ui.unmount()
})

// What the plugin's folder holds in these tests: an English file that lacks
// one key (the band's "Secondaries:"), so the French one shows through.
const EN = {
  '_meta.name': 'English',
  'band.primary': 'Primary:',
  'band.show': '◧ Show the pane',
  'band.hide': '◧ Hide the pane',
  'primary.title': 'Primary',
  'admin.general': 'General',
}
function localeFiles(on: On, extra: (path: string) => string | undefined = () => undefined) {
  on('fs.read', (_, e) => {
    if (/locales[\\/]en\.json$/.test(e.path)) {
      return { value: JSON.stringify(EN) }
    }
    const other = extra(e.path)
    if (other !== undefined) {
      return { value: other }
    }
    throw new Error(`no such file: ${e.path}`)
  })
  on('fs.list', () => ({
    value: [
      { name: 'en.json', kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false },
      { name: 'fr.json', kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false },
    ],
  }))
}

test('OBSIDIAN_ROUTER_LANG=en draws the English file, French where it lacks a key', async ($, on) => {
  wire(on, { list: LIST, env: { OBSIDIAN_ROUTER_LANG: 'en' } })
  localeFiles(on)
  engineBand(on)
  await begin($)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const texts = await bandTexts(band)
  expect(texts).toContain('Primary:')
  // Missing from the English file: the compiled French.
  expect(texts).toContain('Secondaires :')
  await band.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /^Primary$/ })).toBeTruthy()
  await pane.unmount()
})

const openAdmin = async (ui: Mounted) => {
  if (!(await ui.find({ type: 'Button', key: 'admin-register-submit' }))) {
    await ui.press({ key: 'toggle-admin' })
  }
}

test('the console lists the language files and switches the language', async ($, on) => {
  wire(on, { list: LIST })
  localeFiles(on)
  engineBand(on)
  await begin($)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openAdmin(pane)
  const select = nodesOf(await pane.drawn()).find(n => n.type === 'Select' && keyOf(n) === 'admin-language-select')
  expect((select?.props?.options as { value: string; label: string }[] | undefined)?.map(o => o.label)).toEqual([
    'English',
    'Français',
  ])
  await pane.select({ key: 'admin-language-select', value: 'en' })
  // The console, in English, holds the pane; back to the vaults, they are in English too.
  expect(await pane.find({ type: 'Text', text: /^General$/ })).toBeTruthy()
  await pane.press({ key: 'toggle-admin' })
  expect(await pane.find({ type: 'Text', text: /^Primary$/ })).toBeTruthy()
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await bandTexts(band)).toContain('Primary:')
  await band.unmount()
  await pane.unmount()
})

// WireGuard on Windows, as the console reads it: the client's path, and the
// tunnels PowerShell lists as running.
function windowsWireguard(on: On, state: { isInstalled: boolean; tunnels: string[]; launched: (readonly string[])[] }) {
  on('fs.stat', (_, e) => {
    if (state.isInstalled && /WireGuard[\\/]wireguard\.exe$/i.test(e.path)) {
      return { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }
    }
    throw new Error(`no such file: ${e.path}`)
  })
  on('process.run', (_, e) => {
    if (e.argv[0] === 'powershell') {
      return {
        value: { exitCode: 0, stdout: state.tunnels.join('\r\n'), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
      }
    }
    state.launched.push(e.argv)

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

const SILENT_REMOTES = {
  ...LIST,
  vaults: LIST.vaults.map(v => (v.type === 'remote' ? { ...v, online: false } : v)),
}

test('WireGuard installed but off, remote vaults silent: the banner says so and opens the client', async ($, on) => {
  const toasts: string[] = []
  wire(on, { list: SILENT_REMOTES, env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, toasts })
  const wg = { isInstalled: true, tunnels: [] as string[], launched: [] as (readonly string[])[] }
  windowsWireguard(on, wg)
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openAdmin(ui)
  expect(await ui.find({ type: 'Text', text: /^installé, mais aucun tunnel actif/ })).toBeTruthy()
  // The banner is the vaults' own: back to them, it opens the client.
  await ui.press({ key: 'toggle-admin' })
  await ui.press({ key: 'tunnel-open' })
  expect(wg.launched).toContainEqual(['cmd', '/c', 'start', '', 'C:\\Program Files\\WireGuard\\wireguard.exe'])
  await ui.unmount()
})

test('WireGuard not installed: the console offers the client, the guide and the setup prompt', async ($, on) => {
  wire(on, { list: SILENT_REMOTES, env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } })
  const wg = { isInstalled: false, tunnels: [] as string[], launched: [] as (readonly string[])[] }
  windowsWireguard(on, wg)
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openAdmin(ui)
  expect(await ui.find({ type: 'Text', text: /^non installé/ })).toBeTruthy()
  await ui.press({ key: 'wg-install' })
  await ui.press({ key: 'wg-guide' })
  await ui.press({ key: 'wg-prompt' })
  expect(wg.launched.map(argv => argv[2])).toEqual([
    'https://www.wireguard.com/install/',
    'https://github.com/tboome33/obsidian-mcp-router/blob/main/docs/deploy/remote-vault/README.md',
    'https://github.com/tboome33/obsidian-mcp-router/blob/main/docs/deploy/remote-vault/PROMPT.md',
  ])
  await ui.unmount()
})

test('a local vault is registered by its REST address, and the key does not stay in the form', async ($, on) => {
  const state = { list: LIST as unknown, env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } }
  const calls = wire(on, state)
  windowsWireguard(on, { isInstalled: true, tunnels: ['wg0'], launched: [] })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openAdmin(ui)
  // A missing key: refused in words, nothing sent.
  await ui.input({ key: 'admin-name', text: 'notes2', kind: 'change' })
  await ui.input({ key: 'admin-port', text: '27124', kind: 'change' })
  await ui.press({ key: 'admin-register-submit' })
  expect(await ui.find({ type: 'Text', text: /^Colle la clé API/ })).toBeTruthy()
  expect(calls.some(c => c.tool === 'register_remote_vault')).toBe(false)
  await ui.input({ key: 'admin-apiKey', text: 'KEY-123', kind: 'change' })
  await ui.press({ key: 'admin-register-submit' })
  expect(calls.find(c => c.tool === 'register_remote_vault')?.args).toEqual({
    name: 'notes2',
    baseUrl: 'https://127.0.0.1:27124',
    apiKey: 'KEY-123',
    tlsInsecure: true,
    description: 'Vault local enregistré depuis le panneau des vaults',
  })
  const keyField = nodesOf(await ui.drawn()).find(n => n.type === 'Input' && keyOf(n) === 'admin-apiKey')
  expect(keyField?.props?.value).toBe('')
  expect(JSON.stringify(await ui.drawn()).includes('KEY-123')).toBe(false)
  await ui.unmount()
})

test('a remote vault needs WireGuard on; with it, its web UI port goes into the description', async ($, on) => {
  const calls = wire(on, { list: LIST, env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } })
  const wg = { isInstalled: true, tunnels: [] as string[], launched: [] as (readonly string[])[] }
  windowsWireguard(on, wg)
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openAdmin(ui)
  await ui.press({ key: 'admin-kind-remote' })
  await ui.input({ key: 'admin-name', text: 'IB', kind: 'change' })
  await ui.input({ key: 'admin-port', text: '27186', kind: 'change' })
  await ui.input({ key: 'admin-uiPort', text: '3009', kind: 'change' })
  await ui.input({ key: 'admin-apiKey', text: 'KEY-IB', kind: 'change' })
  await ui.press({ key: 'admin-register-submit' })
  expect(calls.some(c => c.tool === 'register_remote_vault')).toBe(false)
  expect(await ui.find({ type: 'Text', text: /^Active WireGuard pour enregistrer un vault distant/ })).toBeTruthy()
  // The tunnel comes up; checked again from the console.
  wg.tunnels = ['wg0']
  await ui.press({ key: 'wg-check' })
  expect(await ui.find({ type: 'Text', text: /^actif \(wg0\)$/ })).toBeTruthy()
  await ui.input({ key: 'admin-apiKey', text: 'KEY-IB', kind: 'change' })
  await ui.press({ key: 'admin-register-submit' })
  expect(calls.find(c => c.tool === 'register_remote_vault')?.args).toEqual({
    name: 'IB',
    baseUrl: 'http://10.8.0.1:27186',
    apiKey: 'KEY-IB',
    tlsInsecure: false,
    description: 'Vault distant enregistré depuis le panneau des vaults (UI :3009)',
  })
  await ui.unmount()
})

test('removing a vault from the router: one menu, one button, a confirming second press', async ($, on) => {
  const calls = wire(on, { list: LIST })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openAdmin(ui)
  // Bound vaults cannot be removed: the menu lists only the registered, unbound ones.
  const menu = nodesOf(await ui.drawn()).find(n => n.type === 'Select' && keyOf(n) === 'admin-remove-select')
  const values = ((menu?.props?.options as { value: string }[] | undefined) ?? []).map(o => o.value)
  expect(values).toContain('extra')
  expect(values).not.toContain('docs')
  await ui.select({ key: 'admin-remove-select', value: 'extra' })
  await ui.press({ key: 'admin-remove-button' })
  expect(calls.some(c => c.tool === 'unregister_vault')).toBe(false)
  expect(await ui.find({ type: 'Text', text: /^Retirer extra du router \?$/ })).toBeTruthy()
  await ui.press({ key: 'admin-remove-cancel' })
  expect(await ui.find({ type: 'Button', key: 'admin-remove-confirm' })).toBeFalsy()
  await ui.press({ key: 'admin-remove-button' })
  await ui.press({ key: 'admin-remove-confirm' })
  expect(calls.find(c => c.tool === 'unregister_vault')?.args).toEqual({ name: 'extra' })
  await ui.unmount()
})

test('a vault registered on the loopback is listed as local, with no web UI button', async ($, on) => {
  const withLoop = {
    ...LIST,
    vaults: [...LIST.vaults, { name: 'loop', type: 'remote', online: true, baseUrl: 'https://127.0.0.1:27124', description: 'UI :3001' }],
  }
  wire(on, { list: withLoop })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openAdd(ui)
  await ui.press({ key: 'tab-locaux' })
  expect(await ui.find({ type: 'Button', key: 'add-loop' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'ui-loop' })).toBeFalsy()
  await ui.press({ key: 'tab-distants' })
  expect(await ui.find({ type: 'Button', key: 'add-loop' })).toBeFalsy()
  await ui.unmount()
})

test('the console keeps the key off the public network: a local vault on the loopback, a remote one at a private address', async ($, on) => {
  const calls = wire(on, { list: LIST, env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } })
  windowsWireguard(on, { isInstalled: true, tunnels: ['wg0'], launched: [] })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openAdmin(ui)
  await ui.input({ key: 'admin-name', text: 'x', kind: 'change' })
  await ui.input({ key: 'admin-host', text: 'vault.example.com', kind: 'change' })
  await ui.input({ key: 'admin-port', text: '27124', kind: 'change' })
  await ui.input({ key: 'admin-apiKey', text: 'K', kind: 'change' })
  await ui.press({ key: 'admin-register-submit' })
  expect(await ui.find({ type: 'Text', text: /^Un vault local s'enregistre sur cette machine/ })).toBeTruthy()
  await ui.press({ key: 'admin-kind-remote' })
  await ui.input({ key: 'admin-host', text: '8.8.8.8', kind: 'change' })
  await ui.input({ key: 'admin-apiKey', text: 'K', kind: 'change' })
  await ui.press({ key: 'admin-register-submit' })
  expect(await ui.find({ type: 'Text', text: /^Un vault distant passe par le tunnel/ })).toBeTruthy()
  expect(calls.some(c => c.tool === 'register_remote_vault')).toBe(false)
  // ::1 is a loopback too, written as a URL can hold it.
  await ui.press({ key: 'admin-kind-local' })
  await ui.input({ key: 'admin-host', text: '::1', kind: 'change' })
  await ui.input({ key: 'admin-apiKey', text: 'K', kind: 'change' })
  await ui.press({ key: 'admin-register-submit' })
  expect(calls.find(c => c.tool === 'register_remote_vault')?.args?.baseUrl).toBe('https://[::1]:27124')
  await ui.unmount()
})

test('a WireGuard read that fails is "unknown", and does not block a remote vault', async ($, on) => {
  const calls = wire(on, { list: LIST, env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } })
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }))
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: 'access denied', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openAdmin(ui)
  expect(await ui.find({ type: 'Text', text: /^état inconnu/ })).toBeTruthy()
  await ui.press({ key: 'admin-kind-remote' })
  await ui.input({ key: 'admin-name', text: 'IB', kind: 'change' })
  await ui.input({ key: 'admin-port', text: '27186', kind: 'change' })
  await ui.input({ key: 'admin-apiKey', text: 'K', kind: 'change' })
  await ui.press({ key: 'admin-register-submit' })
  expect(calls.find(c => c.tool === 'register_remote_vault')?.args?.baseUrl).toBe('http://10.8.0.1:27186')
  await ui.unmount()
})

test('a key typed but not sent is dropped when the console is folded', async ($, on) => {
  wire(on, { list: LIST })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openAdmin(ui)
  await ui.input({ key: 'admin-apiKey', text: 'SECRET-1', kind: 'change' })
  await ui.press({ key: 'toggle-admin' })
  await ui.press({ key: 'toggle-admin' })
  const keyField = nodesOf(await ui.drawn()).find(n => n.type === 'Input' && keyOf(n) === 'admin-apiKey')
  expect(keyField?.props?.value).toBe('')
  await ui.unmount()
})

test('an IPv4 a URL would read as octal ("010.0.0.1" is 8.0.0.1) is refused, never sent', async ($, on) => {
  const calls = wire(on, { list: LIST, env: { APPDATA: 'C:\Users\me\AppData\Roaming' } })
  windowsWireguard(on, { isInstalled: true, tunnels: ['wg0'], launched: [] })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openAdmin(ui)
  await ui.press({ key: 'admin-kind-remote' })
  await ui.input({ key: 'admin-name', text: 'x', kind: 'change' })
  await ui.input({ key: 'admin-port', text: '27180', kind: 'change' })
  for (const host of ['010.0.0.1', '172.016.0.1', '0x0a.0.0.1']) {
    await ui.input({ key: 'admin-host', text: host, kind: 'change' })
    await ui.input({ key: 'admin-apiKey', text: 'K', kind: 'change' })
    await ui.press({ key: 'admin-register-submit' })
  }
  expect(calls.some(c => c.tool === 'register_remote_vault')).toBe(false)
  await ui.unmount()
})

// The plugin's own manifest and GitHub's, for the update check.
function versions(on: On, installed: string, latest: string, extra: (path: string) => string | undefined = () => undefined) {
  on('fs.read', (_, e) => {
    if (/\.claude-plugin[\\/]plugin\.json$/.test(e.path)) {
      return { value: JSON.stringify({ name: 'obsidian-router', version: installed }) }
    }
    const other = extra(e.path)
    if (other !== undefined) {
      return { value: other }
    }
    throw new Error(`no such file: ${e.path}`)
  })
  on('http.fetch', (_, e) => {
    if (e.url.startsWith('https://raw.githubusercontent.com/')) {
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ version: latest }) } }
    }
    throw new Error(`unreachable: ${e.url}`)
  })
}

test('the footer holds the version, the repository and, when GitHub has a newer one, the badge', async ($, on) => {
  const launched: (readonly string[])[] = []
  wire(on, { list: LIST, env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } })
  versions(on, '0.107.0', '0.108.0')
  on('process.run', (_, e) => {
    if (e.argv[0] !== 'powershell') {
      launched.push(e.argv)
    }

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await eventually(() => ui.find({ type: 'Text', text: /^v0\.107\.0$/ }))).toBeTruthy()
  expect(await eventually(() => ui.find({ type: 'Button', key: 'update-badge' }))).toBeTruthy()
  const nodes = nodesOf(await ui.drawn())
  const footer = nodes.find(n => keyOf(n) === 'pane-footer')
  expect(nodesOf(footer as never).some(n => keyOf(n) === 'github')).toBe(true)
  expect(nodesOf(footer as never).some(n => keyOf(n) === 'toggle-admin')).toBe(true)
  await ui.press({ key: 'github' })
  expect(launched).toContainEqual(['rundll32', 'url.dll,FileProtocolHandler', 'https://github.com/tboome33/obsidian-mcp-router'])
  // The badge unfolds the console, where the update is.
  await ui.press({ key: 'update-badge' })
  expect(await ui.find({ type: 'Button', key: 'update-run' })).toBeTruthy()
  await ui.unmount()
})


test('no badge when GitHub has the installed version', async ($, on) => {
  wire(on, { list: LIST })
  versions(on, '0.107.0', '0.107.0')
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await eventually(() => ui.find({ type: 'Text', text: /^v0\.107\.0$/ }))
  expect(await ui.find({ type: 'Button', key: 'update-badge' })).toBeFalsy()
  await ui.unmount()
})

// Claude Code's answers to the update: the commands succeed, and its list
// reports the version that landed.
function claudeCli(on: On, runs: (readonly string[])[], landed: string, project = landed, failing?: 'project' | 'user') {
  on('process.run', (_, e) => {
    if (e.argv[0] !== 'powershell') {
      runs.push(e.argv)
    }
    const id = 'obsidian-router@obsidian-mcp-router-marketplace'
    const stdout = e.argv.includes('list')
      ? JSON.stringify([
          { id, version: landed, scope: 'user' },
          { id, version: project, scope: 'project', projectPath: START.cwd },
          // Another project's older install: not this update's business.
          { id, version: '0.91.1', scope: 'project', projectPath: 'C:\elsewhere' },
        ])
      : 'ok'
    const isFailing = !!failing && e.argv.includes('update') && e.argv.includes(failing) && e.argv.includes('--scope')

    return {
      value: {
        exitCode: isFailing ? 1 : 0,
        stdout,
        stderr: isFailing ? 'permission denied' : '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
}

test('the console updates the plugin through Claude Code: the marketplace, then this project and the user scope', async ($, on) => {
  const runs: (readonly string[])[] = []
  wire(on, { list: LIST, env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } })
  versions(on, '0.107.0', '0.108.0')
  claudeCli(on, runs, '0.108.0')
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await eventually(() => ui.find({ type: 'Button', key: 'update-badge' }))
  await ui.press({ key: 'update-badge' })
  await ui.press({ key: 'update-run' })
  expect(runs).toEqual([
    ['cmd', '/c', 'claude', 'plugin', 'marketplace', 'update', 'obsidian-mcp-router-marketplace'],
    ['cmd', '/c', 'claude', 'plugin', 'update', 'obsidian-router@obsidian-mcp-router-marketplace', '--scope', 'project'],
    ['cmd', '/c', 'claude', 'plugin', 'update', 'obsidian-router@obsidian-mcp-router-marketplace', '--scope', 'user'],
    // What landed is read back, not assumed.
    ['cmd', '/c', 'claude', 'plugin', 'list', '--json'],
  ])
  expect(await ui.find({ type: 'Text', text: /^Plugin mis à jour en v0\.108\.0/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'update-badge' })).toBeFalsy()
  await ui.unmount()
})

test('an update that installs nothing new says so, and keeps the badge', async ($, on) => {
  const runs: (readonly string[])[] = []
  wire(on, { list: LIST, env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } })
  versions(on, '0.107.0', '0.108.0')
  claudeCli(on, runs, '0.107.0')
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await eventually(() => ui.find({ type: 'Button', key: 'update-badge' }))
  await ui.press({ key: 'update-badge' })
  await ui.press({ key: 'update-run' })
  expect(await ui.find({ type: 'Text', text: /^Rien n'a changé : Claude Code a toujours la v0\.107\.0/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'update-badge' })).toBeTruthy()
  await ui.unmount()
})

test('a project left behind is not "updated": the lowest install is said, and the badge stays', async ($, on) => {
  const runs: (readonly string[])[] = []
  wire(on, { list: LIST, env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } })
  versions(on, '0.107.0', '0.108.0')
  claudeCli(on, runs, '0.108.0', '0.107.0', 'project')
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await eventually(() => ui.find({ type: 'Button', key: 'update-badge' }))
  await ui.press({ key: 'update-badge' })
  await ui.press({ key: 'update-run' })
  // Only the user scope ran: it is what is read back, and the project's failure is said.
  expect(await ui.find({ type: 'Text', text: /La mise à jour \(project\) a échoué : permission denied/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'update-badge' })).toBeTruthy()
  await ui.unmount()
})

test('a prerelease is older than its release: the badge shows for 0.108.0-rc.1 → 0.108.0', async ($, on) => {
  wire(on, { list: LIST })
  versions(on, '0.108.0-rc.1', '0.108.0')
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await eventually(() => ui.find({ type: 'Button', key: 'update-badge' }))).toBeTruthy()
  await ui.unmount()
})

test('a vault is not created while its languages field holds no valid code', async ($, on) => {
  const state = { list: { ...LIST, workspaceBinding: null } as unknown, answers: { plan_vault: { approvedPlanSha256: 'f'.repeat(64) } } }
  const calls = wire(on, state)
  await $.session.start(START)
  await $.command.run({ command: 'vault-setup', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'create-name-field', text: 'N', kind: 'change' })
  await ui.input({ key: 'create-path-field', text: 'C:\\VAULTS\\N', kind: 'change' })
  await ui.press({ key: 'convention-languages' })
  // Codes the router itself would refuse: not ISO 639-1, three letters, twice.
  for (const text of ['fr, english', 'xx', 'eng', 'fr, fr']) {
    await ui.input({ key: 'create-languages-field', text, kind: 'change' })
    await ui.press({ key: 'create-submit' })
    expect(calls.some(c => c.tool === 'plan_vault' || c.tool === 'provision_vault')).toBe(false)
    expect(await ui.find({ type: 'Text', text: /^Langues du vault : des codes ISO/ })).toBeTruthy()
  }
  await ui.unmount()
})

test('/vault-setup opens the pane on the console, where a vault is created with its conventions', async ($, on) => {
  const state = {
    list: { ...LIST, workspaceBinding: null } as unknown,
    answers: { plan_vault: { approvedPlanSha256: 'f'.repeat(64) }, provision_vault: { slug: 'notes pro' } },
  }
  const calls = wire(on, state)
  await $.session.start(START)
  await $.command.run({ command: 'vault-setup', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The console holds the pane, the vaults behind "‹ Retour aux vaults".
  expect(await ui.find({ type: 'Button', key: 'create-submit' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'toggle-admin' })).toMatchObject({ props: { label: '‹ Retour aux vaults' } })
  expect(await ui.find({ type: 'Text', text: /^Principal$/ })).toBeFalsy()
  await ui.input({ key: 'create-name-field', text: 'Notes Pro', kind: 'change' })
  await ui.input({ key: 'create-path-field', text: 'C:\\VAULTS\\Notes Pro', kind: 'change' })
  await ui.press({ key: 'create-mode-code' })
  await ui.press({ key: 'convention-source-type' })
  await ui.press({ key: 'create-submit' })
  const base = {
    name: 'Notes Pro',
    path: 'C:\\VAULTS\\Notes Pro',
    wikiMode: { mode: 'code' },
    open: true,
    probe: true,
    bindToWorkspace: true,
  }
  expect(calls.find(c => c.tool === 'plan_vault')?.args).toEqual(base)
  expect(calls.find(c => c.tool === 'provision_vault')?.args).toEqual({ ...base, approvedPlanSha256: 'f'.repeat(64) })
  // To the vault by the name the router registered it under.
  expect(calls.find(c => c.tool === 'install_conventions')?.args).toEqual({ vault: 'notes pro', ids: ['source-type'] })
  // Plan, creation, conventions: in that order.
  const order = calls.map(c => c.tool).filter(tool => ['plan_vault', 'provision_vault', 'install_conventions'].includes(tool))
  expect(order).toEqual(['plan_vault', 'provision_vault', 'install_conventions'])
  await ui.unmount()
})

test('conventions that cannot be installed yet are kept, with a retry', async ($, on) => {
  const state = {
    list: { ...LIST, workspaceBinding: null } as unknown,
    answers: { plan_vault: { approvedPlanSha256: 'f'.repeat(64) } },
    refuse: 'install_conventions',
    refuseText: 'vault not reachable yet',
  }
  const calls = wire(on, state)
  await $.session.start(START)
  await $.command.run({ command: 'vault-setup', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'create-name-field', text: 'N', kind: 'change' })
  await ui.input({ key: 'create-path-field', text: 'C:\\VAULTS\\N', kind: 'change' })
  await ui.press({ key: 'convention-languages' })
  await ui.input({ key: 'create-languages-field', text: 'fr, en', kind: 'change' })
  await ui.press({ key: 'create-submit' })
  expect(await ui.find({ type: 'Text', text: /^Les conventions n'ont pas pu être installées dans N/ })).toBeTruthy()
  state.refuse = ''
  await ui.press({ key: 'create-conventions-retry' })
  expect(calls.filter(c => c.tool === 'install_conventions').at(-1)?.args).toEqual({ vault: 'N', ids: ['languages'], languages: ['fr', 'en'] })
  expect(await ui.find({ type: 'Button', key: 'create-conventions-retry' })).toBeFalsy()
  await ui.unmount()
})

test("a name in the band opens its vault: a remote one's web UI in the browser", async ($, on) => {
  const withExtra = { ...LIST, workspaceBinding: { ...LIST.workspaceBinding, also: ['extra'] } }
  const launched: (readonly string[])[] = []
  wire(on, { list: withExtra, env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } })
  on('process.run', (_, e) => {
    if (e.argv[0] !== 'powershell') {
      launched.push(e.argv)
    }

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  engineBand(on)
  await begin($)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'band-open-extra' })
  expect(launched).toContainEqual(['rundll32', 'url.dll,FileProtocolHandler', 'https://10.8.0.1:3002/'])
  await band.unmount()
})

test('❚❚ Pause pauses a secondary through the router, which keeps it in place with its tier; ▶ Actif resumes it', async ($, on) => {
  const ROUTER = { routerBuild: { version: '0.107.0' } }
  const state = { list: { ...LIST, ...ROUTER } as unknown }
  const calls = wire(on, state)
  engineBand(on)
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const ground = async (key: string) => nodesOf(await ui.drawn()).find(n => keyOf(n) === key)?.props?.backgroundColor
  // Active: the Actif key is on a green ground.
  expect(await ground('state-on-docs')).toBe('diffAddedDimmed')
  expect(await ground('state-off-docs')).toBeUndefined()
  // Pressing the key already in force does nothing.
  await ui.press({ key: 'resume-docs' })
  expect(calls.some(c => c.tool === 'set_secondary_vault_mode')).toBe(false)
  // docs is read-only (locked): the pause is one router write, nothing else.
  await ui.press({ key: 'pause-docs' })
  expect(calls.filter(c => c.tool === 'set_secondary_vault_mode').at(-1)?.args).toEqual({ vault: 'docs', paused: true })
  expect(calls.some(c => c.tool === 'confirm_workspace_binding')).toBe(false)
  // The router now reports docs paused, still in the binding: its tile stays, Pause on a red ground.
  state.list = { ...LIST, ...ROUTER, workspaceBinding: { ...LIST.workspaceBinding, alsoPaused: ['docs'] } }
  await ui.press({ key: 'refresh' })
  await eventually(async () => (await ground('state-off-docs')) === 'diffRemovedDimmed')
  expect(await ground('state-off-docs')).toBe('diffRemovedDimmed')
  expect(await ground('state-on-docs')).toBeUndefined()
  expect(await ui.find({ key: 'mode-docs' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'add-docs' })).toBeFalsy()
  // The band shows it on its line, with its ❚❚ (a press resumes it).
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Button', key: 'band-resume-docs' })).toMatchObject({ props: { label: '❚❚' } })
  expect(await band.find({ type: 'Button', key: 'band-pause-notes' })).toBeTruthy()
  await band.unmount()
  await ui.press({ key: 'resume-docs' })
  expect(calls.filter(c => c.tool === 'set_secondary_vault_mode').at(-1)?.args).toEqual({ vault: 'docs', paused: false })
  state.list = { ...LIST, ...ROUTER }
  await ui.press({ key: 'refresh' })
  await eventually(async () => (await ground('state-on-docs')) === 'diffAddedDimmed')
  expect(await ground('state-on-docs')).toBe('diffAddedDimmed')
  await ui.unmount()
})

test("a paused remote vault, which the router no longer lists, still opens from the band's list", async ($, on) => {
  const launched: (readonly string[])[] = []
  const paused = {
    ...LIST,
    workspaceBinding: { ...LIST.workspaceBinding, also: [...LIST.workspaceBinding.also, 'extra'], alsoPaused: ['extra'] },
    vaults: LIST.vaults.filter(v => v.name !== 'extra'),
    disabled: [{ name: 'extra', type: 'remote', awaitingDeclaration: false }],
    configPath: 'C:\\cfg\\config.json',
  }
  wire(on, { list: paused, env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } })
  on('fs.read', (_, e) => {
    if (e.path === 'C:\\cfg\\config.json') {
      return { value: JSON.stringify({ remoteVaults: [{ name: 'extra', baseUrl: 'http://10.8.0.1:27181', description: 'Conteneur (UI :3002), fichiers : x' }] }) }
    }
    throw new Error(`no such file: ${e.path}`)
  })
  on('process.run', (_, e) => {
    if (e.argv[0] !== 'powershell') {
      launched.push(e.argv)
    }

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  engineBand(on)
  await begin($)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // On the band's line, where a paused vault is named too.
  await band.press({ key: 'band-open-extra' })
  expect(launched).toContainEqual(['rundll32', 'url.dll,FileProtocolHandler', 'https://10.8.0.1:3002/'])
  await band.unmount()
})

test("a resume this session's router does not apply yet is said, and the vault stays paused here", async ($, on) => {
  const state = {
    list: { ...LIST, routerBuild: { version: '0.107.0' }, workspaceBinding: { ...LIST.workspaceBinding, alsoPaused: ['docs'] } } as unknown,
    answers: { set_secondary_vault_mode: { paused: false, pausedInForceHere: true } },
  }
  wire(on, state)
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await eventually(() => ui.find({ type: 'Button', key: 'resume-docs' }))
  await ui.press({ key: 'resume-docs' })
  expect(await ui.find({ type: 'Text', text: /^C'est enregistré pour docs, mais le router de cette session/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'resume-docs' })).toBeTruthy()
  await ui.unmount()
})

test("a router older than the pause is said, and sent nothing it would refuse", async ($, on) => {
  const calls = wire(on, { list: { ...LIST, routerBuild: { version: '0.105.0' } } })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'pause-docs' })
  expect(calls.some(c => c.tool === 'set_secondary_vault_mode')).toBe(false)
  expect(await ui.find({ type: 'Text', text: /^La pause demande le router v0\.107\.0 ou plus, et celui de cette session est en v0\.105\.0/ })).toBeTruthy()
  await ui.unmount()
})

test('"… +N" unfolds the rest on the band\'s line, wrapping to a second line; pressed again it folds them', async ($, on) => {
  const names = ['alpha-vault', 'beta-vault', 'gamma-vault', 'delta-vault', 'epsilon-vault']
  const toasts: string[] = []
  wire(on, { list: { ...LIST, workspaceBinding: { ...LIST.workspaceBinding, also: names } }, toasts })
  engineBand(on)
  await begin($)
  const band = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 100 }, surface: 'desktop' })
  const line = async () => nodesOf(await band.drawn()).find(n => keyOf(n) === 'vault-band-names')
  // Folded: the line holds what fits, no wrapping, and nothing above it.
  expect((await line())?.props?.flexWrap).toBe('nowrap')
  expect(await band.find({ type: 'Button', key: 'band-open-epsilon-vault' })).toBeFalsy()
  await band.press({ key: 'band-more' })
  // Unfolded: every secondary on the line, which wraps; the chip folds them back.
  expect((await line())?.props?.flexWrap).toBe('wrap')
  for (const name of names) {
    expect(await bandTexts(band)).toContain(name)
    expect(await band.find({ type: 'Button', key: `band-pause-${name}` })).toBeTruthy()
  }
  expect(await bandTexts(band)).toContain('‹ réduire')
  // Nothing is drawn above the line any more.
  const nodes = nodesOf(await band.drawn())
  expect(nodes.findIndex(n => keyOf(n) === 'vault-band')).toBeLessThan(nodes.findIndex(n => keyOf(n) === 'band-state-epsilon-vault'))
  // These open nowhere (no folder, no web UI): their names are not buttons.
  expect(await band.find({ type: 'Button', key: 'band-open-epsilon-vault' })).toBeFalsy()
  void toasts
  await band.press({ key: 'band-more' })
  expect((await line())?.props?.flexWrap).toBe('nowrap')
  expect(await band.find({ type: 'Button', key: 'band-pause-epsilon-vault' })).toBeFalsy()
  await band.unmount()
})

test('a paused secondary keeps its place on the band: ▶ on green while it runs, ❚❚ on red while paused', async ($, on) => {
  // docs comes first in the binding: paused, it stays first. extra opens in the browser.
  wire(on, {
    list: {
      ...LIST,
      routerBuild: { version: '0.108.0' },
      workspaceBinding: { ...LIST.workspaceBinding, also: ['docs', 'notes', 'extra'], alsoPaused: ['docs'] },
    },
  })
  engineBand(on)
  await begin($)
  const band = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 160 }, surface: 'desktop' })
  const nodes = nodesOf(await band.drawn())
  const at = (key: string) => nodes.findIndex(n => keyOf(n) === key)
  const prop = (key: string, name: string) => nodes.find(n => keyOf(n) === key)?.props?.[name]
  expect(at('band-state-docs')).toBeGreaterThan(-1)
  expect(at('band-state-docs')).toBeLessThan(at('band-state-notes'))
  // One key each, its glyph on its ground: a Button's label is what the desktop draws.
  expect(prop('band-resume-docs', 'label')).toBe('❚❚')
  expect(prop('band-state-docs', 'backgroundColor')).toBe('diffRemovedDimmed')
  expect(prop('band-pause-notes', 'label')).toBe('▶')
  expect(prop('band-state-notes', 'backgroundColor')).toBe('diffAddedDimmed')
  expect(at('band-pause-docs')).toBe(-1)
  expect(at('band-resume-notes')).toBe(-1)
  // A name that opens has its mark and a button named for where; one that opens nowhere is its name alone.
  // A remote vault: the planet (the default browser) before its name, then Claude's
  // mark and its own key (Claude's browser). Every mark says what it shows.
  const marks = nodesOf(nodes.find(n => keyOf(n) === 'band-open-extra-box') as never).filter(n => n.type === 'Svg')
  expect(marks.map(n => n.props?.alt)).toEqual(['Navigateur', 'Claude'])
  expect(prop('band-ui-extra', 'label')).toBe('↗')
  // Its name is the button's text, never a sentence: the desktop draws a label in its place.
  expect(textOf(nodes.find(n => keyOf(n) === 'band-open-extra')!)).toBe('extra')
  expect(['extra', undefined]).toContain(prop('band-open-extra', 'label'))
  expect(at('band-open-docs')).toBe(-1)
  await band.unmount()
})

test('■ and ▶ stand on the band\'s line, by each secondary: a press pauses or resumes it there', async ($, on) => {
  const state = {
    list: { ...LIST, routerBuild: { version: '0.108.0' }, workspaceBinding: { ...LIST.workspaceBinding, alsoPaused: ['notes'] } } as unknown,
  }
  const calls = wire(on, state)
  engineBand(on)
  await begin($)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // Nothing hidden at this width: no chip, every control on the line.
  expect(await band.find({ type: 'Button', key: 'band-more' })).toBeFalsy()
  await band.press({ key: 'band-pause-docs' })
  expect(calls.filter(c => c.tool === 'set_secondary_vault_mode').at(-1)?.args).toEqual({ vault: 'docs', paused: true })
  await band.press({ key: 'band-resume-notes' })
  expect(calls.filter(c => c.tool === 'set_secondary_vault_mode').at(-1)?.args).toEqual({ vault: 'notes', paused: false })
  await band.unmount()
})


// Five vaults to add: three local, two remote.
const MANY = {
  ...LIST,
  vaults: [
    ...LIST.vaults,
    { name: 'Zeta', type: 'local', online: true, path: 'C:\\VAULTS\\Zeta' },
    { name: 'alpha', type: 'local', online: false, path: 'C:\\VAULTS\\alpha' },
    { name: 'Remote2', type: 'remote', online: true },
  ],
}
const addedNames = async (ui: { drawn(): Promise<unknown> }) =>
  nodesOf(await ui.drawn())
    .filter(n => n.props?.borderStyle === 'bold' && /^av-/.test(keyOf(n) ?? ''))
    .map(n => keyOf(n)!.slice(3))

test('adding: all, local or remote ones, a search, and A → Z or Z → A regardless of case', async ($, on) => {
  wire(on, { list: MANY })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'toggle-add' })
  // All of them by default, A → Z whatever the case.
  expect(await ui.find({ type: 'Button', key: 'tab-tous' })).toMatchObject({ props: { label: 'Tous · 5', variant: 'primary' } })
  expect(await addedNames(ui)).toEqual(['alpha', 'closed', 'extra', 'Remote2', 'Zeta'])
  await ui.select({ key: 'add-sort', value: 'za' })
  expect(await addedNames(ui)).toEqual(['Zeta', 'Remote2', 'extra', 'closed', 'alpha'])
  await ui.press({ key: 'tab-locaux' })
  expect(await addedNames(ui)).toEqual(['Zeta', 'closed', 'alpha'])
  await ui.press({ key: 'tab-distants' })
  expect(await addedNames(ui)).toEqual(['Remote2', 'extra'])
  await ui.press({ key: 'tab-tous' })
  await ui.input({ key: 'add-search', text: 'TA', kind: 'change' })
  expect(await addedNames(ui)).toEqual(['Zeta'])
  // An open local one can be looked at in Obsidian before it is added, "+ Ajouter" beside it.
  expect(await ui.find({ type: 'Button', key: 'obsidian-Zeta' })).toMatchObject({ props: { label: 'Local · Obsidian ↗' } })
  expect(await ui.find({ type: 'Button', key: 'add-Zeta' })).toMatchObject({ props: { label: '+ Ajouter', variant: 'secondary' } })
  // "+ Ajouter" sits on the tile's last line, pushed to its right, under a spacer that takes the height left.
  const tileNodes = nodesOf(nodesOf(await ui.drawn()).find(n => keyOf(n) === 'av-Zeta') as never)
  const foot = tileNodes.find(n => keyOf(n) === 'foot-av-Zeta')
  expect(foot?.props?.justifyContent).toBe('flex-end')
  expect(nodesOf(foot as never).some(n => keyOf(n) === 'add-Zeta')).toBe(true)
  expect(tileNodes.find(n => keyOf(n) === 'spacer-av-Zeta')?.props?.flexGrow).toBe(1)
  expect(nodesOf(tileNodes.find(n => keyOf(n) === 'av-where-Zeta') as never).some(n => keyOf(n) === 'add-Zeta')).toBe(false)
  // The tabs, the search and the order share one bar; "Fermer" folds the list back.
  const bar = nodesOf(await ui.drawn()).find(n => keyOf(n) === 'add-bar')
  expect(bar?.props?.flexDirection).toBe('row')
  for (const key of ['tab-tous', 'add-search', 'add-sort']) {
    expect(nodesOf(bar as never).some(n => keyOf(n) === key)).toBe(true)
  }
  expect(nodesOf(bar as never).find(n => keyOf(n) === 'add-search')?.props?.submitLabel).toBe('Filtrer')
  await ui.press({ key: 'toggle-add' })
  expect(await ui.find({ type: 'Button', key: 'tab-tous' })).toBeFalsy()
  await ui.unmount()
})

test('a wide pane lays the tiles in a grid: three bound ones, four to add per line', async ($, on) => {
  wire(on, { list: MANY })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 130 }, surface: 'desktop' })
  await ui.press({ key: 'toggle-add' })
  const nodes = nodesOf(await ui.drawn())
  const width = (key: string) => nodes.find(n => keyOf(n) === key)?.props?.width as number
  // (130 - 2) / 3 and (130 - 3) / 4, rounded down.
  expect(width('primary-row')).toBe(42)
  expect(width('sec-docs')).toBe(42)
  expect(width('av-closed')).toBe(31)
  // The narrow side panel: one per line.
  await ui.unmount()
  const narrow = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(nodesOf(await narrow.drawn()).find(n => keyOf(n) === 'sec-docs')?.props?.width).toBe(50)
  await narrow.unmount()
})

test('a remote vault whose REST API is silent keeps its web UI links beside its retry', async ($, on) => {
  const down = {
    ...LIST,
    workspaceBinding: { ...LIST.workspaceBinding, also: ['docs', 'notes', 'extra'] },
    vaults: LIST.vaults.map(v => (v.name === 'extra' ? { ...v, online: false } : v)),
  }
  wire(on, { list: down })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'retry-extra' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'web-extra' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'ui-extra' })).toBeTruthy()
  await ui.unmount()
})

test('a tier set on a paused secondary shows at once', async ($, on) => {
  const paused = { ...LIST, routerBuild: { version: '0.108.0' }, workspaceBinding: { ...LIST.workspaceBinding, alsoPaused: ['notes'] } }
  const state: { list: unknown; refuse?: string } = { list: paused }
  const calls = wire(on, state as never)
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The read-back after the change fails: what shows is the change itself.
  state.refuse = 'list_vaults'
  await ui.select({ key: 'mode-notes', value: 'writable' })
  expect(calls.filter(c => c.tool === 'set_secondary_vault_mode').at(-1)?.args).toEqual({ vault: 'notes', mode: 'writable' })
  expect(await ui.find({ key: 'mode-notes' })).toMatchObject({ props: { value: 'writable' } })
  await ui.unmount()
})

test('a remote vault that does not answer says so on its tile, with a retry that reads again', async ($, on) => {
  const down = { ...LIST, vaults: LIST.vaults.map(v => (v.name === 'docs' ? { ...v, online: false } : v)) }
  const calls = wire(on, { list: down })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^injoignable$/ })).toBeTruthy()
  const before = calls.filter(c => c.tool === 'list_vaults').length
  await ui.press({ key: 'retry-docs' })
  await eventually(async () => calls.filter(c => c.tool === 'list_vaults').length > before)
  expect(calls.filter(c => c.tool === 'list_vaults').length).toBeGreaterThan(before)
  await ui.unmount()
})

test('the console holds the pane while open: its cards, wiki types and conventions counter; three cards to a line when wide', async ($, on) => {
  wire(on, { list: LIST })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 130 }, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'toggle-admin' })).toMatchObject({ props: { label: '⚙ Administration ›', variant: 'secondary' } })
  await ui.press({ key: 'toggle-admin' })
  // The vaults hidden, the five cards drawn, three to a line.
  expect(await ui.find({ type: 'Text', text: /^Principal$/ })).toBeFalsy()
  const nodes = nodesOf(await ui.drawn())
  for (const key of ['admin-general', 'admin-create', 'admin-wireguard', 'admin-register', 'admin-unregister']) {
    expect(nodes.find(n => keyOf(n) === key)?.props?.width).toBe(42)
    expect(nodes.find(n => keyOf(n) === `${key}-card`)?.props?.borderStyle).toBe('bold')
  }
  // The wiki type: the one in force framed and lit.
  await ui.press({ key: 'create-mode-research' })
  const after = nodesOf(await ui.drawn())
  expect(after.find(n => keyOf(n) === 'create-mode-box-research')?.props?.backgroundColor).toBe('diffAddedDimmed')
  expect(after.find(n => keyOf(n) === 'create-mode-box-personal')?.props?.backgroundColor).toBeUndefined()
  // The conventions: a counter, all, none.
  await ui.press({ key: 'conventions-all' })
  expect(await ui.find({ type: 'Text', text: /^[1-9]\d* sur \d+$/ })).toBeTruthy()
  await ui.press({ key: 'conventions-none' })
  expect(await ui.find({ type: 'Text', text: /^0 sur \d+$/ })).toBeTruthy()
  // Back to the vaults.
  await ui.press({ key: 'toggle-admin' })
  expect(await ui.find({ type: 'Text', text: /^Principal$/ })).toBeTruthy()
  await ui.unmount()
})

test('the console says what the vaults view would: every remote vault silent, and the operation under way', async ($, on) => {
  wire(on, { list: SILENT_REMOTES })
  await begin($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'toggle-admin' })
  expect(nodesOf(await ui.drawn()).some(n => n.type === 'Text' && textOf(n) === "WireGuard semble inactif : les vaults distants ne sont pas disponibles.")).toBe(true)
  await ui.unmount()
})

test("on the band, a local vault's name has Obsidian's mark, and a remote one's \"↗\" opens it in Claude's browser", async ($, on) => {
  const list = {
    ...LIST,
    workspaceBinding: { ...LIST.workspaceBinding, also: ['extra', 'notes'] },
    vaults: [...LIST.vaults.filter(v => v.name !== 'notes'), { name: 'notes', type: 'local', online: false, path: 'C:\VAULTS\Notes' }],
  }
  const calls = wire(on, { list, env: { APPDATA: 'C:\Users\me\AppData\Roaming' } })
  engineBand(on)
  await begin($)
  const band = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 160 }, surface: 'desktop' })
  const nodes = nodesOf(await band.drawn())
  const local = nodesOf(nodes.find(n => keyOf(n) === 'band-open-notes-box') as never).filter(n => n.type === 'Svg')
  expect(local.map(n => n.props?.alt)).toEqual(['Obsidian'])
  expect(String(local[0]?.props?.source)).toContain('#A88BFA')
  await band.press({ key: 'band-ui-extra' })
  expect(calls.find(c => c.tool === 'preview_start')?.args).toEqual({ url: 'https://10.8.0.1:3002/' })
  await band.unmount()
})

test('the band keys each Claude key by its vault name: a vault named "x-ui" collides with nothing', async ($, on) => {
  const list = {
    ...LIST,
    workspaceBinding: { ...LIST.workspaceBinding, also: ['extra', 'extra-ui'] },
    vaults: [...LIST.vaults, { name: 'extra-ui', type: 'remote', online: true, baseUrl: 'http://10.8.0.1:27190', description: 'Conteneur (UI :3009)' }],
  }
  wire(on, { list })
  engineBand(on)
  await begin($)
  const band = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 200 }, surface: 'desktop' })
  const keys = nodesOf(await band.drawn()).map(n => keyOf(n)).filter((k): k is string => !!k)
  expect(keys.length).toBe(new Set(keys).size)
  expect(keys).toEqual(expect.arrayContaining(['band-open-extra', 'band-ui-extra', 'band-open-extra-ui', 'band-ui-extra-ui']))
  await band.unmount()
})
