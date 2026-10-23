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
    }
  }
}
