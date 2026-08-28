/**
 * The 订阅账号池 section content: the embed container for the sidecar's own
 * admin console, served same-origin under the host passthrough. While the
 * readiness poll (the quota snapshot, an existing host-side surface) has not
 * reported a healthy sidecar, the container shows an actionable state —
 * status copy, a retry action, and the loopback direct-console link — instead
 * of a blank frame; once ready, the section splits into two columns: the
 * host-side composite-route panel on the left, the console iframe on the
 * right.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { CompositeRoutesPanel } from './CompositeRoutesPanel.tsx'
import css from './Sub2apiSection.module.css'

/** The section component's props: the standard locale seat of the slot share. */
export interface Sub2apiSectionProps {
  /**
   * The framework-bound translate seat for this plugin's locale namespace.
   * @param key - dictionary key.
   * @param params - interpolation parameters.
   * @returns the translated copy.
   */
  readonly t: (key: string, params?: Record<string, unknown>) => string
}

/** Host-relative URL the embedded console is served under. */
export const EMBED_SRC = '/plugins/dsh-sub2api/ui/'

/** The console's inner route the embed lands on: the account pool view. */
export const EMBED_ROUTE = 'admin/accounts'

/** Host-relative readiness surface the container polls (the quota snapshot). */
export const SNAPSHOT_URL = '/plugins/dsh-sub2api/quota-snapshot'

/** Poll cadence while the container has not seen a ready snapshot. */
export const ACTIVE_POLL_MS = 4_000

/** Poll cadence once ready, so a later sidecar stop flips the container back. */
export const SETTLED_POLL_MS = 30_000

/** The container's readiness, derived from the snapshot surface. */
export type EmbedReadiness =
  | { readonly phase: 'checking' }
  | { readonly phase: 'ready'; readonly accountCount: number; readonly snapshotAt: string | undefined }
  | { readonly phase: 'unavailable'; readonly reason: string; readonly sidecarPort: number | undefined }

/** The subset of the snapshot payload the container reads. */
interface SnapshotView {
  readonly status: string
  readonly reason?: string
  readonly sidecarPort?: number
  readonly generatedAt?: string
  readonly accounts?: readonly unknown[]
}

/**
 * Read one readiness view off the snapshot surface.
 * @param fetchImpl - fetch implementation; defaults to globalThis.fetch.
 * @returns the container readiness.
 */
export async function readReadiness(fetchImpl: typeof fetch = fetch): Promise<EmbedReadiness> {
  let payload: SnapshotView | undefined
  try {
    const response = await fetchImpl(SNAPSHOT_URL, { headers: { accept: 'application/json' } })
    if (!response.ok) return { phase: 'unavailable', reason: 'unreachable', sidecarPort: undefined }
    payload = (await response.json()) as SnapshotView
  } catch {
    return { phase: 'unavailable', reason: 'unreachable', sidecarPort: undefined }
  }
  if (payload?.status === 'ready') {
    return {
      phase: 'ready',
      accountCount: Array.isArray(payload.accounts) ? payload.accounts.length : 0,
      snapshotAt: typeof payload.generatedAt === 'string' ? payload.generatedAt : undefined,
    }
  }
  return {
    phase: 'unavailable',
    reason: payload?.reason ?? 'no-poll-yet',
    sidecarPort: typeof payload?.sidecarPort === 'number' ? payload.sidecarPort : undefined,
  }
}

/**
 * Map a snapshot unavailability reason onto copy. Unknown reasons fall
 * through to their raw code — the surface is the plugin's own contract.
 * @param reason - the snapshot's `reason` field.
 * @param t - the locale seat.
 * @returns the rendered reason copy.
 */
export function describeReason(reason: string, t: (key: string) => string): string {
  if (reason === 'unreachable') return t('reason.unreachable')
  const key = `reason.${reason}`
  const rendered = t(key)
  // The locale seat echoes unknown keys; those carry the raw snapshot code.
  return rendered === key ? t('reason.no-poll-yet') : rendered
}

/**
 * The host's current color scheme. The host shell follows the OS setting
 * through its alias tokens, so `prefers-color-scheme` is the authoritative
 * signal; light is the fallback when matchMedia is unavailable.
 * @returns 'dark' or 'light'.
 */
export function hostTheme(): 'light' | 'dark' {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/**
 * The console embed URL for the current host theme. The `theme` query is
 * consumed by the passthrough shim, which writes upstream's theme storage
 * before the upstream app boots.
 * @returns the host-relative iframe URL.
 */
export function embedUrl(): string {
  return `${EMBED_SRC}${EMBED_ROUTE}?theme=${hostTheme()}`
}

/**
 * Format the snapshot's generation time as HH:mm for the toolbar.
 * @param iso - the snapshot's `generatedAt`.
 * @returns the local HH:mm, or an empty string for a missing/invalid time.
 */
export function formatSnapshotTime(iso: string | undefined): string {
  if (iso === undefined) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Render the section content: the slim toolbar plus the console embed, or
 * the actionable fallback card while the sidecar is not ready.
 * @param props - the section props (locale seat).
 * @returns the section element tree.
 */
export function Sub2apiSection({ t }: Sub2apiSectionProps) {
  const [readiness, setReadiness] = useState<EmbedReadiness>({ phase: 'checking' })
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const disposed = useRef(false)

  const poll = useCallback(async (interval: number): Promise<void> => {
    const next = await readReadiness()
    if (disposed.current) return
    setReadiness(next)
    timer.current = setTimeout(() => { void poll(next.phase === 'ready' ? SETTLED_POLL_MS : ACTIVE_POLL_MS) }, interval)
  }, [])

  useEffect(() => {
    disposed.current = false
    void poll(ACTIVE_POLL_MS)
    return () => {
      disposed.current = true
      if (timer.current !== undefined) clearTimeout(timer.current)
    }
  }, [poll])

  const retry = useCallback((): void => {
    if (timer.current !== undefined) clearTimeout(timer.current)
    setReadiness({ phase: 'checking' })
    void poll(ACTIVE_POLL_MS)
  }, [poll])

  if (readiness.phase === 'ready') {
    const url = embedUrl()
    return (
      <div className={css.container}>
        <div className={css.toolbar}>
          <span className={css.toolbarMeta}>
            {t('toolbarSummary')
              .replace('{count}', String(readiness.accountCount))
              .replace('{time}', formatSnapshotTime(readiness.snapshotAt))}
          </span>
          <a className={css.openExternal} href={url} target="_blank" rel="noreferrer">{t('openExternal')}</a>
        </div>
        <div className={css.body}>
          <CompositeRoutesPanel t={t} />
          <iframe className={css.frame} src={url} title={t('nav')} />
        </div>
      </div>
    )
  }
  if (readiness.phase === 'checking') {
    return (
      <div className={`${css.container} ${css.fallback}`}>
        <p className={css.status}>{t('checking')}</p>
      </div>
    )
  }
  const directHref = readiness.sidecarPort === undefined ? undefined : `http://127.0.0.1:${String(readiness.sidecarPort)}/`
  return (
    <div className={`${css.container} ${css.fallback}`}>
      <p className={css.title}>{t('unreadyTitle')}</p>
      <p className={css.status}>{describeReason(readiness.reason, t)}</p>
      <div className={css.actions}>
        <button type="button" className={css.retry} onClick={retry}>{t('retry')}</button>
        {directHref !== undefined && (
          <a className={css.direct} href={directHref} target="_blank" rel="noreferrer">{t('directLink')}</a>
        )}
      </div>
      {directHref !== undefined && <p className={css.hint}>{t('directHint')}</p>}
    </div>
  )
}
