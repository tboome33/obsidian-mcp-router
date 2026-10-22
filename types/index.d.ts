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
}

export type Secondary = VaultRow & { mode: SecondaryMode }

export type Snapshot = {
  primary: VaultRow | null
  /** The binding restricts the session to the primary. */
  isLocked: boolean
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
      filter: string
      tab: Tab
    }
  }
}
