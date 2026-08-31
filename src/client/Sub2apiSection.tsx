/**
 * The 订阅账号池 section content: the embed container for the sidecar's own
 * admin console, served same-origin under the host passthrough. While the
 * readiness poll (the quota snapshot, an existing host-side surface) has not
 * reported a healthy sidecar, the container shows an actionable state —
 * status copy, a retry action, and the loopback direct-console link — instead
 * of a blank frame. Once ready, the section contains only the native Sub2API
 * account surface; proxy and Composite-route management are composed by that
 * surface instead of duplicated in the host plugin.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
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
  | { readonly phase: 'ready' }
  | { readonly phase: 'unavailable'; readonly reason: string; readonly sidecarPort: number | undefined }

/** The subset of the snapshot payload the container reads. */
interface SnapshotView {
  readonly status: string
  readonly reason?: string
  readonly sidecarPort?: number
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
    return { phase: 'ready' }
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
 * The host's current color scheme. The Desktop theme presenter writes the
 * active scheme onto the root element; the media query remains the boot-time
 * fallback before the presenter activates.
 * @returns 'dark' or 'light'.
 */
export function hostTheme(): 'light' | 'dark' {
  const presented = document.documentElement.style.colorScheme
  if (presented === 'dark' || presented === 'light') return presented
  if (document.documentElement.classList.contains('dark')) return 'dark'
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/**
 * Map the Desktop document language onto the locales Sub2API ships.
 * @returns 'zh' for Chinese Desktop locales, otherwise 'en'.
 */
export function hostLocale(): 'zh' | 'en' {
  return document.documentElement.lang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/**
 * The native account embed URL for the current host theme and locale. The
 * `embed` query enables the Desktop-only composition points in Sub2API; the
 * other queries are consumed by the passthrough shim before the app boots.
 * @returns the host-relative iframe URL.
 */
export function embedUrl(): string {
  return `${EMBED_SRC}${EMBED_ROUTE}?embed=desktop&theme=${hostTheme()}&lang=${hostLocale()}`
}

/** Follow live Desktop theme and locale changes by replacing the iframe URL. */
function useEmbedUrl(): string {
  const [url, setUrl] = useState(embedUrl)
  useEffect(() => {
    const sync = (): void => {
      const next = embedUrl()
      setUrl((current) => next === current ? current : next)
    }
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'lang'] })
    let media: MediaQueryList | undefined
    try {
      media = window.matchMedia('(prefers-color-scheme: dark)')
      media.addEventListener('change', sync)
    } catch {
      media = undefined
    }
    sync()
    return () => {
      observer.disconnect()
      media?.removeEventListener('change', sync)
    }
  }, [])
  return url
}

/**
 * Render the native console embed or the actionable fallback card while the
 * sidecar is not ready.
 * @param props - the section props (locale seat).
 * @returns the section element tree.
 */
export function Sub2apiSection({ t }: Sub2apiSectionProps) {
  const [readiness, setReadiness] = useState<EmbedReadiness>({ phase: 'checking' })
  const url = useEmbedUrl()
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
    return (
      <div className={css.container}>
        <iframe className={css.frame} src={url} title={t('nav')} />
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
