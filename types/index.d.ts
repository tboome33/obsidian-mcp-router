/** Write tier of a secondary, as the router's set_secondary_vault_mode names it. */
export type SecondaryMode = 'locked' | 'soft' | 'writable'

/** The panel tabs. */
export type Tab = 'locaux' | 'distants'

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

export type Snapshot = {
  primary: VaultRow | null
  /** The binding restricts the session to the primary. */
  isLocked: boolean
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
      /** The closed secondaries are listed (folded by default). */
      showClosed: boolean
      /** The add list is shown (folded by default, unless there is no primary). */
      showAdd: boolean
      /** Bumped at every open and close of the Vaults pane: the band reads it
       * to be drawn again. What it shows comes from the module, never from a
       * write made while drawing. */
      paneVersion: number
      /** The language the texts are drawn in (a locales/<code>.json). */
      language: string
      /** The administration console is unfolded. */
      showAdmin: boolean
      adminForm: AdminForm
      /** The vault whose removal waits for its confirming press. */
      confirmRemove: string | null
      /** The vault chosen in the removal menu; null: the first one. */
      removePick: string | null
      update: UpdateState | null
      createForm: CreateForm
      /** The band's list of the secondaries it could not show, unfolded upward. */
      bandListOpen: boolean
      /** Conventions a new vault still waits for: its REST API was not up yet. */
      pendingConventions: { vault: string; ids: string[]; languages: string[] } | null
      /** WireGuard as last detected; null before the first read. */
      wireguard: WireguardState | null
    }
  }
}
