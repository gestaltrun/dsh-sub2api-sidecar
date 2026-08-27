/**
 * Ambient module declarations pinning the harness client-runtime surfaces
 * this browser half consumes — the client-side counterpart of `src/seam.ts`.
 * The bundle is loaded by the harness module loader, which provides the real
 * `slots` and `locale` services; the declarations carry the exact member
 * subset the plugin calls so this package builds and tests standalone
 * without importing the private harness packages. React types come from the
 * react dev dependency; both react specifiers are the bundle's only runtime
 * externals, resolved from the loader module table.
 *
 * @module dsh-sub2api-sidecar/client-seams
 */

/**
 * Ambient declaration of the harness client runtime. The real module owns
 * the full plugin context; only the subset below is pinned here. The file
 * stays a global script (no top-level imports) so the declaration declares
 * the module rather than augmenting it; ReactNode is referenced through the
 * type-only `import('react')` form.
 */
declare module '@deepseek-ai/dsh-client-runtime/client' {
  /** One settings section's registration options (a list-slot contribution). */
  export interface DshSlotRegistration {
    /** The slot to contribute to (`settings.section`). */
    readonly name: string
    /** Stable entry id inside the list slot; required by list registrations. */
    readonly id: string
    /** Sort key of the section's nav row. */
    readonly order?: number
    /** Nav label; a string or a locale-following thunk. */
    readonly label?: string | (() => string)
    /** Locale namespace registered by this plugin for the label keys. */
    readonly locale?: string
  }

  /** The `ctx.locale` subset this plugin uses. */
  export interface DshClientLocale {
    /**
     * Register one dictionary namespace.
     * @param namespace - the plugin-owned namespace id.
     * @param dictionaries - the `zh`/`en` dictionaries.
     * @returns the registration disposer.
     */
    register(
      namespace: string,
      dictionaries: Record<string, Record<string, string>>,
    ): () => void
    /**
     * Bind the translate seat of one namespace.
     * @param namespace - the plugin-owned namespace id.
     * @returns the translate function.
     */
    bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
  }

  /** The `ctx.slots` subset this plugin uses. */
  export interface DshClientSlots {
    /**
     * Register one contribution into a declared slot.
     * @param options - the registration options.
     * @param component - the contributing component, typed by its own props.
     * @returns the registration disposer.
     */
    register<TProps extends object>(
      options: DshSlotRegistration,
      component: (props: TProps) => import('react').ReactNode,
    ): () => void
    /**
     * Register once the named slot's declaration exists; the contribution
     * leaves with the caller's plugin fiber.
     * @param slot - the slot name to wait for.
     * @param register - the deferred registration.
     */
    inject(slot: string, register: () => unknown): void
  }

  /** The client root context subset this plugin consumes in `apply`. */
  export interface DshClientContext {
    /**
     * Register one effect whose disposer runs when the plugin fiber unloads.
     * @param execute - body returning the disposer.
     * @param reason - effect label for diagnostics.
     * @returns the effect disposer.
     */
    effect(execute: () => () => unknown, reason?: string): () => unknown
    /** The locale service. */
    readonly locale: DshClientLocale
    /** The slot service. */
    readonly slots: DshClientSlots
  }

  /** The name the plugin imports the context type under. */
  export type ClientContext = DshClientContext
}
