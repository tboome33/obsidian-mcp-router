/** Write tier of a secondary, as the router's set_secondary_vault_mode names it. */
export type SecondaryMode = 'locked' | 'soft' | 'writable'

/** The panel tabs. */
export type Tab = 'tous' | 'locaux' | 'distants'

export type VaultRow = {
  name: string
  /** null: the router did not ping it (not loaded by this session). */
  online: boolean | null
  type: string | null
  description: string | null
  /** A remote vault's web UI, from the router's description; null when unknown. */
  uiUrl: string | null
  /** A local vault's folder, as the router has it; null (or absent, in a
   * snapshot an older panel kept) for a remote one. */
  path?: string | null
  /** Whether Obsidian on this machine lists that folder among its vaults (its
   * own `obsidian.json`): only then can `obsidian://open` open it. null: not
   * known (a remote vault, or the file could not be read). */
  isKnownToObsidian?: boolean | null
  /** Obsidian's own id for that folder, from the same list: what the 💎 opens
   * it by, so two vaults whose folders share a name stay apart. */
  obsidianId?: string | null
}

export type Secondary = VaultRow & { mode: SecondaryMode }

/** WireGuard on this machine, as the administration console last read it. */
export type WireguardState = {
  /** `checking` while the read runs; `unknown` where the system does not say. */
  state: 'checking' | 'active' | 'inactive' | 'absent' | 'unknown'
  /** The tunnels that are up, by name. */
  tunnels: string[]
}

/** The router's hooks as they stand in this session's workspace. */
export type WorkspaceHooks = {
  /** The workspace the choices are kept for (the session's folder). */
  workspace: string
  /** The read-only hooks the plugin runs everywhere. */
  alwaysOn: string[]
  /** The others, each switched on or off for this workspace; `global`: still
   * wired machine-wide in ~/.claude/settings.json, so it runs everywhere. */
  optIn: { name: string; enabled: boolean; global: boolean }[]
}

/** The administration console's form: a vault to register by its REST address. */
export type AdminForm = {
  /** Local: this machine's Obsidian (127.0.0.1); remote: over WireGuard. */
  kind: 'local' | 'remote'
  name: string
  host: string
  port: string
  /** A remote vault's web UI port, written into its description. */
  uiPort: string
  /** Kept only until the call is sent: cleared right after, sent or refused. */
  apiKey: string
  scheme: 'https' | 'http'
}

/** The plugin's version against GitHub's, and an update under way. */
export type UpdateState = {
  installed: string | null
  /** null: GitHub did not answer. */
  latest: string | null
  isAvailable: boolean
  isRunning: boolean
  /** What the last update said, in words. */
  log: string | null
}

/** The console's form for a NEW local vault. */
export type CreateForm = {
  name: string
  /** The folder; empty: the default root plus the name. */
  path: string
  mode: 'personal' | 'research' | 'business' | 'code'
  conventions: string[]
  /** Comma-separated codes, for the `languages` convention. */
  languages: string
  /** Bind this project to the new vault. */
  bind: boolean
}

/** A vault's writes through the router: when, and its last files, newest first. */
export type VaultActivity = { lastWriteAt?: string; recent?: { path: string; at: string }[] }

/** A vault folder found on this machine that the router does not know
 * (scripts/find-vaults.mjs scan). Its REST key never reaches the panel. */
export type FoundVault = {
  name: string
  path: string
  hasRestApi: boolean
  hasBridge: boolean
  hasWiki: boolean
  missingPlugins: string[]
  /** Where its Obsidian answers with its own key; null: nothing does from here. */
  address: { baseUrl: string; tlsInsecure: boolean; insecurePort?: number; isLocal: boolean } | null
  key: 'accepted' | 'refused' | 'unanswered' | 'absent'
}

/** One line of the setup checklist. */
export type SetupItem = {
  id: 'create' | 'register' | 'plugins' | 'wiki' | 'bind' | 'conventions'
  state: 'todo' | 'doing' | 'done' | 'failed' | 'manual'
  detail?: string
}

/** The first-run screen: no primary yet → pick an existing vault, or create one step by step. */
export type SetupState = {
  step: 'choose' | 'existing' | 'name' | 'path' | 'mode' | 'conventions' | 'languages' | 'recap'
  /** The last scan of this machine for vaults the router does not know. */
  found: { state: 'scanning' | 'done' | 'failed'; vaults: FoundVault[]; platform?: string; error?: string } | null
  /** The checklist of a creation or an adoption under way, or finished; null: none. */
  progress: {
    vault: string
    items: SetupItem[]
    isRunning: boolean
    conventions: string[]
    languages: string[]
    /** What only the person can do now (reload Obsidian, leave restricted mode); null: nothing. */
    needsYou: string | null
  } | null
}

export type Snapshot = {
  primary: VaultRow | null
  /** The primary's own write tier, when the router keeps one (v0.117.0+). */
  primaryMode?: SecondaryMode
  /** The binding restricts the session to the primary. */
  isLocked: boolean
  /** The wiki's auto-enrichment mode in force (list_vaults.autoEnrichMode). */
  autoEnrichMode?: string | null
  /** A session lock from lock_vault: runtime only, never written to the binding. */
  lockedTo: string | null
  /** The binding came from the one-time .env import, nobody confirmed it. */
  isImported: boolean
  secondaries: Secondary[]
  available: VaultRow[]
  /** Secondaries paused from the pane: out of the binding, kept here with
   * their write tier until resumed. Absent in a snapshot an older panel kept. */
  paused?: Secondary[]
  /** Where a new vault goes by default: the config's vaultsRoot, else the
   * folder most registered vaults sit in. */
  defaultRoot?: string | null
  /** The router's config file (list_vaults.configPath): what scripts/find-vaults.mjs reads. */
  configPath?: string | null
  /** The version the router of this session reports (list_vaults.routerBuild). */
  routerVersion?: string | null
  /** When each vault was last written through the router, and its last files. */
  activity?: Record<string, VaultActivity>
  /** The secondaries in the binding's own order, paused ones included. */
  order?: string[]
  fetchedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'obsidian-router': {
      snapshot: Snapshot | null
      /** The action in flight, drawn in the header; null when idle. */
      busy: string | null
      error: string | null
      /** Why the last button's change was refused; cleared by the next action only. */
      failure: string | null
      filter: string
      tab: Tab
      /** The add list's tab, since the redesign (`tab` is an older panel's). */
      addTab: Tab
      /** The closed secondaries are listed (folded by default). */
      showClosed: boolean
      /** The add list is shown (folded by default, unless there is no primary). */
      showAdd: boolean
      /** The "add a vault" grid's search, and its order. */
      addQuery: string
      addSort: 'az' | 'za'
      /** Bumped at every open and close of the Vaults pane: the band reads it
       * to be drawn again. What it shows comes from the module, never from a
       * write made while drawing. */
      paneVersion: number
      /** The language the texts are drawn in (a locales/<code>.json). */
      language: string
      /** The administration console is unfolded. */
      showAdmin: boolean
      /** The administration's section unfolded (`general`, `open`, `create`,
       * `wireguard`, `register`, `unregister`), or null: all folded. */
      adminSection: string | null
      navOpen: boolean
      openers: { obsidian: boolean; browser: boolean; claude: boolean }
      adminForm: AdminForm
      /** The vault whose removal waits for its confirming press. */
      confirmRemove: string | null
      /** The vault chosen in the removal menu; null: the first one. */
      removePick: string | null
      update: UpdateState | null
      createForm: CreateForm
      /** The secondary picked in the band's menu, whose controls stand on the line; null: the first one. */
      bandPick: string | null
      /** Conventions a new vault still waits for: its REST API was not up yet. */
      pendingConventions: { vault: string; ids: string[]; languages: string[] } | null
      /** WireGuard as last detected; null before the first read. */
      wireguard: WireguardState | null
      /** This workspace's hooks as last read; null before the first read. */
      workspaceHooks: WorkspaceHooks | null
      /** The Configuration tab is in sight (this workspace's hooks and settings). */
      showConfig: boolean
      /** The names picked in each column of "Ajouter un vault". */
      addPick: { left: string[]; right: string[] }
      /** The primary vault's conventions, from audit_vault_conventions (a dry run of install_conventions on an older router). */
      primaryConventions: { vault: string; items: { id: string; installed: boolean }[]; languages: string[] | null } | null
      /** Why the last read of the hooks, or of the conventions, failed; cleared by the next read that works. */
      readFailures: { hooks: string | null; conventions: string | null }
      /** The first-run screen and its creation wizard. */
      setup: SetupState
    }
  }
}
