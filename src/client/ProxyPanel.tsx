/**
 * The proxy panel (console v1.2 S6): proxy management folded into the left
 * column as a collapsible card, so no second menu entry appears. Upstream's
 * account add/edit form reads the same proxies table for its 代理 dropdown,
 * so a proxy saved here is selectable there without refreshing the iframe —
 * the card says so in a hint line. Import/export stay excluded (they are
 * step-up 2FA flows).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FallbackMode, Proxy, ProxyDraft, ProxyProtocol, ProxyQualityResult, ProxyTestResult } from './proxies.ts'
import { checkProxyQuality, createProxy, deleteProxy, emptyProxyDraft, FALLBACK_MODES, listProxies, PROXY_PROTOCOLS, proxyDraftOf, testProxy, updateProxy } from './proxies.ts'
import shared from './CompositeRoutesPanel.module.css'
import css from './ProxyPanel.module.css'

/** The panel component's props: the standard locale seat of the slot share. */
export interface ProxyPanelProps {
  /**
   * The framework-bound translate seat for this plugin's locale namespace.
   * @param key - dictionary key.
   * @param params - interpolation parameters.
   * @returns the translated copy.
   */
  readonly t: (key: string, params?: Record<string, unknown>) => string
}

/** The list lifecycle; `idle` until the card is first expanded. */
type ListState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly proxies: readonly Proxy[] }
  | { readonly phase: 'failed'; readonly message: string }

/** One row's in-flight or settled action outcome. */
type RowAction =
  | { readonly kind: 'test'; readonly phase: 'loading' }
  | { readonly kind: 'test'; readonly phase: 'done'; readonly result: ProxyTestResult }
  | { readonly kind: 'quality'; readonly phase: 'loading' }
  | { readonly kind: 'quality'; readonly phase: 'done'; readonly result: ProxyQualityResult }
  | { readonly kind: 'test' | 'quality'; readonly phase: 'failed'; readonly message: string }

/** The status filter's values; `expired` is derived from the expiry date. */
type StatusFilter = '' | 'active' | 'inactive' | 'expired'

/** Whether one proxy counts as expired right now. */
function isExpired(proxy: Proxy): boolean {
  return proxy.expires_at !== null && new Date(proxy.expires_at).getTime() < Date.now()
}

/** The displayed location: city/region/country joined, or a dash. */
function locationOf(proxy: Proxy): string {
  const parts = [proxy.city, proxy.region, proxy.country].filter((part) => part !== undefined && part !== '')
  return [...new Set(parts)].join(' ') || '—'
}

/**
 * Render the proxy card: collapsed by default; expanding lazily loads the
 * list and reveals the toolbar (search + protocol + status filters), the
 * table, and the add/edit form.
 * @param props - the panel props (locale seat).
 * @returns the proxy card element tree.
 */
export function ProxyPanel({ t }: ProxyPanelProps) {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<ListState>({ phase: 'idle' })
  const [query, setQuery] = useState('')
  const [protocol, setProtocol] = useState<'' | ProxyProtocol>('')
  const [status, setStatus] = useState<StatusFilter>('')
  const [formOpen, setFormOpen] = useState(false)
  const [draft, setDraft] = useState<ProxyDraft>(emptyProxyDraft)
  const [editingId, setEditingId] = useState<number | undefined>(undefined)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | undefined>(undefined)
  const [rowActions, setRowActions] = useState<Readonly<Record<number, RowAction>>>({})
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(new Set())
  const loaded = useRef(false)

  const reload = useCallback(async (): Promise<void> => {
    setList((current) => current.phase === 'ready' ? current : { phase: 'loading' })
    try {
      const proxies = await listProxies()
      setList({ phase: 'ready', proxies })
    } catch (error) {
      setList({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  useEffect(() => {
    if (open && !loaded.current) {
      loaded.current = true
      void reload()
    }
  }, [open, reload])

  const patchDraft = useCallback((patch: Partial<ProxyDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }))
  }, [])

  const startAdd = useCallback((): void => {
    setEditingId(undefined)
    setDraft(emptyProxyDraft())
    setFormError(undefined)
    setFormOpen(true)
  }, [])

  const startEdit = useCallback((proxy: Proxy): void => {
    setEditingId(proxy.id)
    setDraft(proxyDraftOf(proxy))
    setFormError(undefined)
    setFormOpen(true)
  }, [])

  const cancelForm = useCallback((): void => {
    setFormOpen(false)
    setEditingId(undefined)
    setDraft(emptyProxyDraft())
    setFormError(undefined)
  }, [])

  const submit = useCallback(async (): Promise<void> => {
    if (draft.name.trim() === '' || draft.host.trim() === '') {
      setFormError(t('proxies.required'))
      return
    }
    if (draft.port < 1 || draft.port > 65535) {
      setFormError(t('proxies.portInvalid'))
      return
    }
    setSubmitting(true)
    setFormError(undefined)
    try {
      if (editingId === undefined) {
        await createProxy(draft)
      } else {
        await updateProxy(editingId, draft)
      }
      cancelForm()
      await reload()
    } catch (error) {
      setFormError(`${t('proxies.submitFailed')}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSubmitting(false)
    }
  }, [cancelForm, draft, editingId, reload, t])

  const remove = useCallback(async (proxy: Proxy): Promise<void> => {
    if (!window.confirm(t('proxies.deleteConfirm').replace('{name}', proxy.name))) return
    try {
      await deleteProxy(proxy.id)
      if (editingId === proxy.id) cancelForm()
      await reload()
    } catch (error) {
      // Upstream's binding refusal propagates unchanged.
      setList({ phase: 'failed', message: `${t('proxies.deleteFailed')}: ${error instanceof Error ? error.message : String(error)}` })
    }
  }, [cancelForm, editingId, reload, t])

  const runRowAction = useCallback(async (proxy: Proxy, kind: 'test' | 'quality'): Promise<void> => {
    setRowActions((current) => ({ ...current, [proxy.id]: { kind, phase: 'loading' } }))
    try {
      if (kind === 'test') {
        const result = await testProxy(proxy.id)
        setRowActions((current) => ({ ...current, [proxy.id]: { kind, phase: 'done', result } }))
      } else {
        const result = await checkProxyQuality(proxy.id)
        setRowActions((current) => ({ ...current, [proxy.id]: { kind, phase: 'done', result } }))
      }
    } catch (error) {
      setRowActions((current) => ({ ...current, [proxy.id]: { kind, phase: 'failed', message: error instanceof Error ? error.message : String(error) } }))
    }
  }, [])

  const toggleReveal = useCallback((id: number): void => {
    setRevealed((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const statusLabel = (proxy: Proxy): string =>
    isExpired(proxy) ? t('proxies.statusExpired') : proxy.status === 'active' ? t('proxies.statusActive') : t('proxies.statusInactive')

  const visible = list.phase === 'ready'
    ? list.proxies.filter((proxy) => {
      const needle = query.trim().toLowerCase()
      if (needle !== '' && !proxy.name.toLowerCase().includes(needle) && !proxy.host.toLowerCase().includes(needle)) return false
      if (protocol !== '' && proxy.protocol !== protocol) return false
      if (status === 'expired') return isExpired(proxy)
      if (status !== '') return proxy.status === status && !isExpired(proxy)
      return true
    })
    : []

  const fallbackLabel = (mode: FallbackMode): string =>
    mode === 'none' ? t('proxies.fallbackNone') : mode === 'direct' ? t('proxies.fallbackDirect') : t('proxies.fallbackProxy')

  return (
    <section className={shared.card} aria-label={t('proxies.title')}>
      <div className={shared.cardHead}>
        <button type="button" className={css.collapse} onClick={() => { setOpen((current) => !current) }} aria-expanded={open}>
          <span className={css.chevron}>{open ? '▾' : '▸'}</span>
          <h2 className={shared.heading}>{t('proxies.title')}</h2>
          {list.phase === 'ready' && <span className={shared.badge}>{list.proxies.length}</span>}
        </button>
        {open && (
          <div className={css.headActions}>
            <button type="button" className={shared.ghostButton} onClick={() => { void reload() }}>{t('proxies.refresh')}</button>
            <button type="button" className={shared.primaryButton} onClick={startAdd}>{t('proxies.add')}</button>
          </div>
        )}
      </div>
      {!open && <p className={shared.hint}>{t('proxies.hint')}</p>}
      {open && (
        <>
          <p className={shared.hint}>{t('proxies.hint')}</p>
          <div className={css.toolbar}>
            <input className={shared.input} type="text" value={query} placeholder={t('proxies.search')} onChange={(event) => { setQuery(event.target.value) }} />
            <select className={shared.input} value={protocol} onChange={(event) => { setProtocol(event.target.value as '' | ProxyProtocol) }}>
              <option value="">{t('proxies.allProtocols')}</option>
              {PROXY_PROTOCOLS.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
            <select className={shared.input} value={status} onChange={(event) => { setStatus(event.target.value as StatusFilter) }}>
              <option value="">{t('proxies.allStatus')}</option>
              <option value="active">{t('proxies.statusActive')}</option>
              <option value="inactive">{t('proxies.statusInactive')}</option>
              <option value="expired">{t('proxies.statusExpired')}</option>
            </select>
          </div>
          {list.phase === 'loading' && <p className={shared.muted}>…</p>}
          {list.phase === 'failed' && <p className={shared.error}>{list.message}</p>}
          {list.phase === 'ready' && list.proxies.length === 0 && <p className={shared.muted}>{t('proxies.empty')}</p>}
          {list.phase === 'ready' && list.proxies.length > 0 && visible.length === 0 && <p className={shared.muted}>{t('proxies.noMatch')}</p>}
          {visible.length > 0 && (
            <table className={shared.table}>
              <thead>
                <tr>
                  <th>{t('proxies.colName')}</th>
                  <th>{t('proxies.colAddress')}</th>
                  <th>{t('proxies.colAuth')}</th>
                  <th>{t('proxies.colLatency')}</th>
                  <th>{t('routes.colOps')}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((proxy) => {
                  const action = rowActions[proxy.id]
                  return (
                    <tr key={proxy.id}>
                      <td>
                        <div className={shared.cellMain}>{proxy.name}</div>
                        <div className={shared.cellMeta}>
                          <span className={shared.badge}>{proxy.protocol}</span>
                          <span className={shared.badge}>{statusLabel(proxy)}</span>
                        </div>
                        <div className={shared.cellSub}>
                          {`${t('proxies.colAccounts')}: ${String(proxy.account_count ?? 0)} · ${t('proxies.colExpiry')}: ${proxy.expires_at === null ? t('proxies.noExpiry') : proxy.expires_at.slice(0, 10)}`}
                        </div>
                      </td>
                      <td>
                        <div className={shared.cellMain}>{`${proxy.host}:${String(proxy.port)}`}</div>
                        <div className={shared.cellSub}>{locationOf(proxy)}</div>
                      </td>
                      <td>
                        {proxy.username === '' ? (
                          <span className={shared.muted}>{t('proxies.noAuth')}</span>
                        ) : (
                          <span className={css.auth}>
                            <span>{revealed.has(proxy.id) ? proxy.username : '••••••'}</span>
                            <button type="button" className={shared.opButton} title={t('proxies.revealAuth')} aria-label={t('proxies.revealAuth')} onClick={() => { toggleReveal(proxy.id) }}>
                              {revealed.has(proxy.id) ? '🙈' : '👁'}
                            </button>
                          </span>
                        )}
                      </td>
                      <td>
                        <div className={shared.cellMain}>
                          {typeof proxy.latency_ms === 'number' ? `${String(proxy.latency_ms)} ms` : '—'}
                        </div>
                        {proxy.latency_message !== undefined && proxy.latency_message !== '' && (
                          <div className={shared.cellSub}>{proxy.latency_message}</div>
                        )}
                        {action?.phase === 'loading' && <div className={shared.cellSub}>…</div>}
                        {action?.phase === 'done' && action.kind === 'test' && (
                          <div className={action.result.success ? shared.cellSub : shared.error}>
                            {`${action.result.message}${typeof action.result.latency_ms === 'number' ? ` · ${String(action.result.latency_ms)} ms` : ''}`}
                          </div>
                        )}
                        {action?.phase === 'done' && action.kind === 'quality' && (
                          <div className={shared.cellSub}>
                            {t('proxies.qualityResult').replace('{score}', String(action.result.score)).replace('{grade}', action.result.grade)}
                          </div>
                        )}
                        {action?.phase === 'failed' && <div className={shared.error}>{action.message}</div>}
                      </td>
                      <td>
                        <div className={css.rowOps}>
                          <button type="button" className={shared.opButton} onClick={() => { void runRowAction(proxy, 'test') }}>{t('proxies.test')}</button>
                          <button type="button" className={shared.opButton} onClick={() => { void runRowAction(proxy, 'quality') }}>{t('proxies.quality')}</button>
                          <button type="button" className={shared.opButton} onClick={() => { startEdit(proxy) }}>{t('proxies.edit')}</button>
                          <button type="button" className={`${shared.opButton} ${shared.opDanger}`} onClick={() => { void remove(proxy) }}>{t('proxies.delete')}</button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          {formOpen && (
            <form className={shared.form} onSubmit={(event) => { event.preventDefault(); void submit() }}>
              <h3 className={shared.heading}>{editingId === undefined ? t('proxies.addTitle') : t('proxies.editTitle')}</h3>
              <div className={shared.fieldRow}>
                <label className={shared.field}>
                  <span className={shared.label}>{t('proxies.fieldName')}</span>
                  <input className={shared.input} type="text" value={draft.name} onChange={(event) => { patchDraft({ name: event.target.value }) }} />
                </label>
                <label className={shared.field}>
                  <span className={shared.label}>{t('proxies.fieldProtocol')}</span>
                  <select className={shared.input} value={draft.protocol} onChange={(event) => { patchDraft({ protocol: event.target.value as ProxyProtocol }) }}>
                    {PROXY_PROTOCOLS.map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                </label>
              </div>
              <div className={shared.fieldRow}>
                <label className={shared.field}>
                  <span className={shared.label}>{t('proxies.fieldHost')}</span>
                  <input className={shared.input} type="text" value={draft.host} placeholder="proxy.example.com" onChange={(event) => { patchDraft({ host: event.target.value }) }} />
                </label>
                <label className={shared.field}>
                  <span className={shared.label}>{t('proxies.fieldPort')}</span>
                  <input className={shared.input} type="number" value={draft.port} onChange={(event) => { patchDraft({ port: Number(event.target.value) }) }} />
                </label>
              </div>
              <div className={shared.fieldRow}>
                <label className={shared.field}>
                  <span className={shared.label}>{t('proxies.fieldUsername')}</span>
                  <input className={shared.input} type="text" value={draft.username} onChange={(event) => { patchDraft({ username: event.target.value }) }} />
                </label>
                <label className={shared.field}>
                  <span className={shared.label}>{t('proxies.fieldPassword')}</span>
                  <input className={shared.input} type="password" value={draft.password} onChange={(event) => { patchDraft({ password: event.target.value }) }} />
                </label>
              </div>
              <div className={shared.fieldRow}>
                <label className={shared.field}>
                  <span className={shared.label}>{t('proxies.fieldExpiry')}</span>
                  <input className={shared.input} type="date" value={draft.expiresAt} onChange={(event) => { patchDraft({ expiresAt: event.target.value }) }} />
                </label>
                <label className={shared.field}>
                  <span className={shared.label}>{t('proxies.fieldWarnDays')}</span>
                  <input className={shared.input} type="number" value={draft.expiryWarnDays} onChange={(event) => { patchDraft({ expiryWarnDays: Number(event.target.value) || 0 }) }} />
                </label>
              </div>
              <div className={shared.fieldRow}>
                <label className={shared.field}>
                  <span className={shared.label}>{t('proxies.fieldFallback')}</span>
                  <select className={shared.input} value={draft.fallbackMode} onChange={(event) => { patchDraft({ fallbackMode: event.target.value as FallbackMode }) }}>
                    {FALLBACK_MODES.map((mode) => <option key={mode} value={mode}>{fallbackLabel(mode)}</option>)}
                  </select>
                </label>
                {draft.fallbackMode === 'proxy' && list.phase === 'ready' && (
                  <label className={shared.field}>
                    <span className={shared.label}>{t('proxies.fieldBackup')}</span>
                    <select className={shared.input} value={draft.backupProxyId ?? ''} onChange={(event) => { patchDraft({ backupProxyId: event.target.value === '' ? null : Number(event.target.value) }) }}>
                      <option value="">—</option>
                      {list.proxies.filter((proxy) => proxy.id !== editingId).map((proxy) => (
                        <option key={proxy.id} value={proxy.id}>{`${proxy.name} (${proxy.host}:${String(proxy.port)})`}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              {editingId !== undefined && (
                <label className={shared.check}>
                  <input type="checkbox" checked={draft.changePassword} onChange={(event) => { patchDraft({ changePassword: event.target.checked }) }} />
                  <span>{t('proxies.changePassword')}</span>
                </label>
              )}
              {formError !== undefined && <p className={shared.error}>{formError}</p>}
              <div className={css.formActions}>
                <button type="button" className={shared.ghostButton} onClick={cancelForm}>{t('proxies.cancel')}</button>
                <button type="submit" className={shared.primaryButton} disabled={submitting}>
                  {editingId === undefined ? t('proxies.create') : t('proxies.save')}
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  )
}
