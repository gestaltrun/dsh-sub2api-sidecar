/**
 * The composite-route panel (console v1.2 S3): the host-side route
 * management surface rendered left of the embedded console iframe. It owns
 * the saved-routes table (edit/delete/refresh), the add/edit form, and the
 * resolution preview, all over the same-origin admin plane — see
 * {@link composite-routes} for the data layer this component drives.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CompositeRoute, Endpoint, MatchType, Platform, RouteDraft, RoutePreview } from './composite-routes.ts'
import { createRoute, deleteRoute, draftOf, emptyRouteDraft, ENDPOINTS, listRoutes, MATCH_TYPES, PLATFORMS, previewRoute, resolveCompositeGroupId, updateRoute } from './composite-routes.ts'
import { ProxyPanel } from './ProxyPanel.tsx'
import css from './CompositeRoutesPanel.module.css'

/** The panel component's props: the standard locale seat of the slot share. */
export interface CompositeRoutesPanelProps {
  /**
   * The framework-bound translate seat for this plugin's locale namespace.
   * @param key - dictionary key.
   * @param params - interpolation parameters.
   * @returns the translated copy.
   */
  readonly t: (key: string, params?: Record<string, unknown>) => string
}

/** Product-name display labels (language-independent). */
const PLATFORM_LABELS: Record<Platform, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  grok: 'Grok',
  kimi: 'Kimi',
  zhipu: '智谱',
  deepseek: 'DeepSeek',
}

/** The list lifecycle: routes stay `undefined` until the first load answers. */
type ListState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly routes: readonly CompositeRoute[] }
  | { readonly phase: 'failed'; readonly message: string }

/** The preview lifecycle. */
type PreviewState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'loading' }
  | { readonly phase: 'done'; readonly result: RoutePreview }
  | { readonly phase: 'failed'; readonly message: string }

/**
 * Render the route panel: saved-routes table, add/edit form, and the
 * resolution preview. All admin calls go through the injected-key host
 * proxy; failures land in the block that produced them, never in the
 * embedded console next to the panel.
 * @param props - the panel props (locale seat).
 * @returns the panel element tree.
 */
export function CompositeRoutesPanel({ t }: CompositeRoutesPanelProps) {
  const groupId = useRef<number | undefined>(undefined)
  const [list, setList] = useState<ListState>({ phase: 'loading' })
  const [draft, setDraft] = useState<RouteDraft>(emptyRouteDraft)
  const [editingId, setEditingId] = useState<number | undefined>(undefined)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | undefined>(undefined)
  const [previewModel, setPreviewModel] = useState('')
  const [previewEndpoint, setPreviewEndpoint] = useState<Endpoint>('any')
  const [preview, setPreview] = useState<PreviewState>({ phase: 'idle' })

  const reload = useCallback(async (): Promise<void> => {
    try {
      groupId.current ??= await resolveCompositeGroupId()
      const routes = await listRoutes(groupId.current)
      setList({ phase: 'ready', routes })
    } catch (error) {
      setList({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const patchDraft = useCallback((patch: Partial<RouteDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }))
  }, [])

  const startEdit = useCallback((route: CompositeRoute): void => {
    setEditingId(route.id)
    setDraft(draftOf(route))
    setFormError(undefined)
  }, [])

  const cancelEdit = useCallback((): void => {
    setEditingId(undefined)
    setDraft(emptyRouteDraft())
    setFormError(undefined)
  }, [])

  const submit = useCallback(async (): Promise<void> => {
    if (draft.public_model.trim() === '') {
      setFormError(t('routes.modelRequired'))
      return
    }
    if (groupId.current === undefined) return
    setSubmitting(true)
    setFormError(undefined)
    try {
      const payload: RouteDraft = { ...draft, public_model: draft.public_model.trim(), upstream_model: draft.upstream_model.trim(), notes: draft.notes.trim() }
      if (editingId === undefined) {
        await createRoute(groupId.current, payload)
        setDraft(emptyRouteDraft())
      } else {
        await updateRoute(groupId.current, editingId, payload)
        setEditingId(undefined)
        setDraft(emptyRouteDraft())
      }
      await reload()
    } catch (error) {
      setFormError(`${t('routes.submitFailed')}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSubmitting(false)
    }
  }, [draft, editingId, reload, t])

  const remove = useCallback(async (route: CompositeRoute): Promise<void> => {
    if (groupId.current === undefined) return
    if (!window.confirm(t('routes.deleteConfirm').replace('{model}', route.public_model))) return
    try {
      await deleteRoute(groupId.current, route.id)
      if (editingId === route.id) cancelEdit()
      await reload()
    } catch (error) {
      setList({ phase: 'failed', message: `${t('routes.deleteFailed')}: ${error instanceof Error ? error.message : String(error)}` })
    }
  }, [cancelEdit, editingId, reload, t])

  const runPreview = useCallback(async (): Promise<void> => {
    if (groupId.current === undefined || previewModel.trim() === '') return
    setPreview({ phase: 'loading' })
    try {
      const result = await previewRoute(groupId.current, previewModel.trim(), previewEndpoint)
      setPreview({ phase: 'done', result })
    } catch (error) {
      setPreview({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }, [previewEndpoint, previewModel])

  const matchLabel = (match: MatchType): string => (match === 'exact' ? t('routes.matchExact') : t('routes.matchPrefix'))
  const endpointLabel = (endpoint: string): string => (endpoint === 'any' ? t('routes.endpointAny') : endpoint)

  return (
    <aside className={css.panel} aria-label={t('routes.title')}>
      <div className={css.panelHead}>
        <h2 className={css.panelTitle}>{t('routes.title')}</h2>
      </div>
      <section className={css.card}>
        <div className={css.cardHead}>
          <h2 className={css.heading}>{t('routes.savedTitle')}</h2>
          <button type="button" className={css.ghostButton} onClick={() => { void reload() }}>{t('routes.refresh')}</button>
        </div>
        {list.phase === 'loading' && <p className={css.muted}>…</p>}
        {list.phase === 'failed' && <p className={css.error}>{`${t('routes.loadFailed')}: ${list.message}`}</p>}
        {list.phase === 'ready' && list.routes.length === 0 && <p className={css.muted}>{t('routes.empty')}</p>}
        {list.phase === 'ready' && list.routes.length > 0 && (
          <table className={css.table}>
            <thead>
              <tr>
                <th>{t('routes.colModel')}</th>
                <th>{t('routes.colTarget')}</th>
                <th>{t('routes.colScope')}</th>
                <th>{t('routes.colOps')}</th>
              </tr>
            </thead>
            <tbody>
              {list.routes.map((route) => (
                <tr key={route.id}>
                  <td>
                    <div className={css.cellMain}>{route.public_model}</div>
                    <div className={css.cellMeta}>
                      <span className={css.badge}>{matchLabel(route.match_type)}</span>
                      {!route.enabled && <span className={css.badgeDisabled}>{t('routes.disabled')}</span>}
                    </div>
                  </td>
                  <td>
                    <div className={css.cellMain}>{PLATFORM_LABELS[route.target_platform] ?? route.target_platform}</div>
                    <div className={css.cellSub}>{route.upstream_model || route.public_model}</div>
                  </td>
                  <td>
                    <div className={css.cellMain}>{endpointLabel(route.endpoint)}</div>
                    <div className={css.cellSub}>{`${t('routes.priority')}: ${String(route.priority)}`}</div>
                  </td>
                  <td>
                    <div className={css.ops}>
                      <button type="button" className={css.opButton} onClick={() => { startEdit(route) }}>{t('routes.edit')}</button>
                      <button type="button" className={`${css.opButton} ${css.opDanger}`} onClick={() => { void remove(route) }}>{t('routes.delete')}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className={css.card}>
        <div className={css.cardHead}>
          <h2 className={css.heading}>{editingId === undefined ? t('routes.addTitle') : t('routes.editTitle')}</h2>
        </div>
        <form className={css.form} onSubmit={(event) => { event.preventDefault(); void submit() }}>
          <label className={css.field}>
            <span className={css.label}>{t('routes.fieldModel')}</span>
            <input className={css.input} type="text" value={draft.public_model} placeholder="openrouter/gpt-5" onChange={(event) => { patchDraft({ public_model: event.target.value }) }} />
          </label>
          <div className={css.fieldRow}>
            <label className={css.field}>
              <span className={css.label}>{t('routes.fieldMatch')}</span>
              <select className={css.input} value={draft.match_type} onChange={(event) => { patchDraft({ match_type: event.target.value as MatchType }) }}>
                {MATCH_TYPES.map((match) => <option key={match} value={match}>{matchLabel(match)}</option>)}
              </select>
            </label>
            <label className={css.field}>
              <span className={css.label}>{t('routes.fieldEndpoint')}</span>
              <select className={css.input} value={draft.endpoint} onChange={(event) => { patchDraft({ endpoint: event.target.value as Endpoint }) }}>
                {ENDPOINTS.map((endpoint) => <option key={endpoint} value={endpoint}>{endpointLabel(endpoint)}</option>)}
              </select>
            </label>
          </div>
          <div className={css.fieldRow}>
            <label className={css.field}>
              <span className={css.label}>{t('routes.fieldPlatform')}</span>
              <select className={css.input} value={draft.target_platform} onChange={(event) => { patchDraft({ target_platform: event.target.value as Platform }) }}>
                {PLATFORMS.map((platform) => <option key={platform} value={platform}>{PLATFORM_LABELS[platform]}</option>)}
              </select>
            </label>
            <label className={css.field}>
              <span className={css.label}>{t('routes.fieldPriority')}</span>
              <input className={css.input} type="number" value={draft.priority} onChange={(event) => { patchDraft({ priority: Number(event.target.value) || 100 }) }} />
            </label>
          </div>
          <label className={css.field}>
            <span className={css.label}>{t('routes.fieldUpstream')}</span>
            <input className={css.input} type="text" value={draft.upstream_model} placeholder="gpt-5" onChange={(event) => { patchDraft({ upstream_model: event.target.value }) }} />
            <span className={css.hint}>{t('routes.upstreamHint')}</span>
          </label>
          <label className={css.field}>
            <span className={css.label}>{t('routes.fieldNotes')}</span>
            <textarea className={css.input} rows={2} value={draft.notes} onChange={(event) => { patchDraft({ notes: event.target.value }) }} />
          </label>
          {formError !== undefined && <p className={css.error}>{formError}</p>}
          <div className={css.formFoot}>
            <label className={css.check}>
              <input type="checkbox" checked={draft.enabled} onChange={(event) => { patchDraft({ enabled: event.target.checked }) }} />
              <span>{t('routes.fieldEnabled')}</span>
            </label>
            <div className={css.formActions}>
              {editingId !== undefined && (
                <button type="button" className={css.ghostButton} onClick={cancelEdit}>{t('routes.cancelEdit')}</button>
              )}
              <button type="submit" className={css.primaryButton} disabled={submitting}>
                {editingId === undefined ? t('routes.create') : t('routes.save')}
              </button>
            </div>
          </div>
        </form>
      </section>

      <section className={css.card}>
        <div className={css.cardHead}>
          <h2 className={css.heading}>{t('routes.previewTitle')}</h2>
        </div>
        <div className={css.previewRow}>
          <input className={css.input} type="text" value={previewModel} placeholder="openrouter/gpt-5" onChange={(event) => { setPreviewModel(event.target.value) }} />
          <select className={css.input} value={previewEndpoint} onChange={(event) => { setPreviewEndpoint(event.target.value as Endpoint) }}>
            {ENDPOINTS.map((endpoint) => <option key={endpoint} value={endpoint}>{endpointLabel(endpoint)}</option>)}
          </select>
          <button type="button" className={css.ghostButton} disabled={preview.phase === 'loading' || previewModel.trim() === ''} onClick={() => { void runPreview() }}>
            {t('routes.previewAction')}
          </button>
        </div>
        {preview.phase === 'done' && preview.result.matched && (
          <div className={css.previewResult}>
            <span className={css.badgeHit}>{t('routes.previewMatched')}</span>
            <span>{`${t('routes.previewTarget')}: ${preview.result.target_platform}`}</span>
            <span>{`${t('routes.previewUpstream')}: ${preview.result.upstream_model || previewModel.trim()}`}</span>
          </div>
        )}
        {preview.phase === 'done' && !preview.result.matched && (
          <div className={css.previewResult}>
            <span className={css.badgeMiss}>{t('routes.previewMissed')}</span>
            {preview.result.reason !== undefined && <span className={css.cellSub}>{preview.result.reason}</span>}
          </div>
        )}
        {preview.phase === 'failed' && <p className={css.error}>{preview.message}</p>}
      </section>

      <ProxyPanel t={t} />
    </aside>
  )
}
