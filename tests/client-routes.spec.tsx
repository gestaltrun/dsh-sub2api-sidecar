// @vitest-environment jsdom
/**
 * The composite-route panel (console v1.2 S3): the data layer's envelope
 * unwrapping and endpoint shapes, and the component's user-visible behavior —
 * the saved-routes table, the add/edit form's submissions, the delete flow,
 * and the resolution preview.
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CompositeRoutesPanel } from '../src/client/CompositeRoutesPanel.tsx'
import { ADMIN_API, createRoute, deleteRoute, listRoutes, previewRoute, resolveCompositeGroupId, updateRoute, type CompositeRoute } from '../src/client/composite-routes.ts'
import { zh, type SectionKeys } from '../src/client/locales.ts'

/** The zh translate seat the tests render with; without params it returns the raw template, matching the host bind. */
const t = (key: string, params?: Record<string, unknown>): string => {
  const raw = zh[key as keyof SectionKeys] ?? key
  if (params === undefined) return raw
  return raw.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ''))
}

/** One saved route fixture. */
function route(overrides: Partial<CompositeRoute> = {}): CompositeRoute {
  return {
    id: 3,
    group_id: 8,
    public_model: 'claude-sonnet-4-5',
    match_type: 'exact',
    target_platform: 'openai',
    upstream_model: 'gpt-5.3-codex-spark',
    endpoint: 'any',
    priority: 100,
    enabled: true,
    notes: '',
    ...overrides,
  }
}

/** One recorded request the fetch double answered. */
interface RecordedCall {
  url: string
  method: string
  body?: unknown
}

/**
 * Build a fetch double answering the admin plane from a route table; unmatched
 * URLs answer an empty success envelope.
 */
function stubAdminPlane(handlers: Record<string, unknown>): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined })
    const key = `${method} ${url}`
    const data = handlers[key] ?? handlers[`${method} ${url.split('?')[0] ?? ''}`]
    return Response.json({ code: 0, message: 'success', data })
  }))
  return { calls }
}

/** The groups answer pinning composite at id 8. */
const GROUPS = { items: [{ id: 2, platform: 'anthropic' }, { id: 8, platform: 'composite' }] }

/** Mount the panel and return its DOM container. */
async function renderPanel(): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<CompositeRoutesPanel t={t} />)
  })
  await act(async () => {})
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
    },
  }
}

/** Change one input/select/textarea through its native setter so React observes it. */
async function setValue(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string): Promise<void> {
  const prototype = element instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  await act(async () => {
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/** Click one element inside act. */
async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('data layer', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves the composite group id from the first composite-platform group', async () => {
    const { calls } = stubAdminPlane({ [`GET ${ADMIN_API}/groups`]: GROUPS })
    expect(await resolveCompositeGroupId()).toBe(8)
    expect(calls[0]?.url).toContain(`${ADMIN_API}/groups?page=1&page_size=100`)
  })

  it('refuses when no composite group exists', async () => {
    stubAdminPlane({ [`GET ${ADMIN_API}/groups`]: { items: [{ id: 2, platform: 'anthropic' }] } })
    await expect(resolveCompositeGroupId()).rejects.toThrow('no composite group')
  })

  it('lists, creates, updates, and deletes routes against the group-scoped endpoints', async () => {
    const saved = route()
    const { calls } = stubAdminPlane({
      [`GET ${ADMIN_API}/groups/8/composite-routes`]: [saved],
      [`POST ${ADMIN_API}/groups/8/composite-routes`]: saved,
      [`PUT ${ADMIN_API}/groups/8/composite-routes/3`]: saved,
      [`DELETE ${ADMIN_API}/groups/8/composite-routes/3`]: null,
    })
    expect(await listRoutes(8)).toEqual([saved])
    const draft = {
      public_model: 'gpt-5', match_type: 'prefix', target_platform: 'openai',
      upstream_model: '', endpoint: 'messages', priority: 50, enabled: false, notes: 'n',
    } as const
    await createRoute(8, draft)
    await updateRoute(8, 3, draft)
    await deleteRoute(8, 3)
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${ADMIN_API}/groups/8/composite-routes`,
      `POST ${ADMIN_API}/groups/8/composite-routes`,
      `PUT ${ADMIN_API}/groups/8/composite-routes/3`,
      `DELETE ${ADMIN_API}/groups/8/composite-routes/3`,
    ])
    expect(calls[1]?.body).toMatchObject({ public_model: 'gpt-5', match_type: 'prefix', endpoint: 'messages', priority: 50, enabled: false })
    expect(calls[2]?.body).toMatchObject({ public_model: 'gpt-5' })
  })

  it('previews a model against the preview endpoint', async () => {
    const { calls } = stubAdminPlane({
      [`POST ${ADMIN_API}/groups/8/composite-routes/preview`]: {
        matched: true, source: 'route', target_platform: 'openai', upstream_model: 'gpt-5.3-codex-spark', endpoint: 'any',
      },
    })
    const result = await previewRoute(8, 'claude-sonnet-4-5', 'any')
    expect(result.matched).toBe(true)
    expect(calls[0]?.body).toEqual({ model: 'claude-sonnet-4-5', endpoint: 'any' })
  })

  it('throws upstream messages on non-zero envelopes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 400, message: 'Invalid request body' })))
    await expect(listRoutes(8)).rejects.toThrow('Invalid request body')
  })
})

describe('route panel component', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders the saved routes with platform, scope, and actions', async () => {
    stubAdminPlane({
      [`GET ${ADMIN_API}/groups`]: GROUPS,
      [`GET ${ADMIN_API}/groups/8/composite-routes`]: [route(), route({ id: 4, public_model: 'deepseek-v4', match_type: 'prefix', target_platform: 'deepseek', upstream_model: '', endpoint: 'messages', priority: 10, enabled: false })],
    })
    const view = await renderPanel()
    try {
      expect(view.container.textContent).toContain('已保存路由')
      expect(view.container.textContent).toContain('claude-sonnet-4-5')
      expect(view.container.textContent).toContain('OpenAI')
      expect(view.container.textContent).toContain('gpt-5.3-codex-spark')
      expect(view.container.textContent).toContain('前缀')
      expect(view.container.textContent).toContain('DeepSeek')
      expect(view.container.textContent).toContain('停用')
      expect(view.container.textContent).toContain('优先级: 10')
      expect(view.container.textContent).toContain('编辑')
      expect(view.container.textContent).toContain('删除')
      expect(view.container.textContent).toContain('添加路由')
      expect(view.container.textContent).toContain('预览')
    } finally {
      await view.unmount()
    }
  })

  it('shows the empty state when no routes are saved', async () => {
    stubAdminPlane({
      [`GET ${ADMIN_API}/groups`]: GROUPS,
      [`GET ${ADMIN_API}/groups/8/composite-routes`]: [],
    })
    const view = await renderPanel()
    try {
      expect(view.container.textContent).toContain('暂无已保存路由')
    } finally {
      await view.unmount()
    }
  })

  it('submits the add form to the create endpoint and reloads', async () => {
    const { calls } = stubAdminPlane({
      [`GET ${ADMIN_API}/groups`]: GROUPS,
      [`GET ${ADMIN_API}/groups/8/composite-routes`]: [],
      [`POST ${ADMIN_API}/groups/8/composite-routes`]: route({ id: 5 }),
    })
    const view = await renderPanel()
    try {
      const modelInput = view.container.querySelector<HTMLInputElement>('input[placeholder="openrouter/gpt-5"]')
      expect(modelInput).not.toBeNull()
      await setValue(modelInput!, 'glm-4.6')
      const platformSelect = view.container.querySelectorAll<HTMLSelectElement>('select')[2]
      await setValue(platformSelect!, 'zhipu')
      const submit = [...view.container.querySelectorAll('button')].find((button) => button.textContent === '创建')
      await click(submit!)
      await act(async () => {})
      const create = calls.find((call) => call.method === 'POST' && call.url.endsWith('/composite-routes'))
      expect(create?.body).toMatchObject({
        public_model: 'glm-4.6',
        match_type: 'exact',
        target_platform: 'zhipu',
        upstream_model: '',
        endpoint: 'any',
        priority: 100,
        enabled: true,
      })
      // The list reloads after a successful save.
      expect(calls.filter((call) => call.method === 'GET' && call.url.endsWith('/composite-routes')).length).toBeGreaterThanOrEqual(2)
    } finally {
      await view.unmount()
    }
  })

  it('refuses an empty public model without calling the API', async () => {
    const { calls } = stubAdminPlane({
      [`GET ${ADMIN_API}/groups`]: GROUPS,
      [`GET ${ADMIN_API}/groups/8/composite-routes`]: [],
    })
    const view = await renderPanel()
    try {
      const submit = [...view.container.querySelectorAll('button')].find((button) => button.textContent === '创建')
      await click(submit!)
      expect(view.container.textContent).toContain('请填写公开模型')
      expect(calls.some((call) => call.method === 'POST')).toBe(false)
    } finally {
      await view.unmount()
    }
  })

  it('fills the form from a row edit and saves through the update endpoint', async () => {
    const { calls } = stubAdminPlane({
      [`GET ${ADMIN_API}/groups`]: GROUPS,
      [`GET ${ADMIN_API}/groups/8/composite-routes`]: [route()],
      [`PUT ${ADMIN_API}/groups/8/composite-routes/3`]: route(),
    })
    const view = await renderPanel()
    try {
      const edit = [...view.container.querySelectorAll('button')].find((button) => button.textContent === '编辑')
      await click(edit!)
      expect(view.container.textContent).toContain('编辑路由')
      const modelInput = view.container.querySelector<HTMLInputElement>('input[placeholder="openrouter/gpt-5"]')
      expect(modelInput?.value).toBe('claude-sonnet-4-5')
      await setValue(modelInput!, 'claude-sonnet-4-6')
      const save = [...view.container.querySelectorAll('button')].find((button) => button.textContent === '保存')
      await click(save!)
      await act(async () => {})
      const update = calls.find((call) => call.method === 'PUT')
      expect(update?.url).toBe(`${ADMIN_API}/groups/8/composite-routes/3`)
      expect(update?.body).toMatchObject({ public_model: 'claude-sonnet-4-6', upstream_model: 'gpt-5.3-codex-spark' })
    } finally {
      await view.unmount()
    }
  })

  it('deletes a row after confirmation and skips the call when cancelled', async () => {
    const { calls } = stubAdminPlane({
      [`GET ${ADMIN_API}/groups`]: GROUPS,
      [`GET ${ADMIN_API}/groups/8/composite-routes`]: [route()],
      [`DELETE ${ADMIN_API}/groups/8/composite-routes/3`]: null,
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const view = await renderPanel()
    try {
      const remove = [...view.container.querySelectorAll('button')].find((button) => button.textContent === '删除')
      await click(remove!)
      expect(confirmSpy).toHaveBeenCalledWith('删除路由「claude-sonnet-4-5」？')
      expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
      confirmSpy.mockReturnValue(true)
      await click(remove!)
      await act(async () => {})
      expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/composite-routes/3'))).toBe(true)
    } finally {
      await view.unmount()
    }
  })

  it('previews a model and renders the resolution', async () => {
    const { calls } = stubAdminPlane({
      [`GET ${ADMIN_API}/groups`]: GROUPS,
      [`GET ${ADMIN_API}/groups/8/composite-routes`]: [route()],
      [`POST ${ADMIN_API}/groups/8/composite-routes/preview`]: {
        matched: true, source: 'route', target_platform: 'openai', upstream_model: 'gpt-5.3-codex-spark', endpoint: 'any',
      },
    })
    const view = await renderPanel()
    try {
      const previewInputs = [...view.container.querySelectorAll<HTMLInputElement>('input[placeholder="openrouter/gpt-5"]')]
      await setValue(previewInputs[1]!, 'claude-sonnet-4-5')
      const query = [...view.container.querySelectorAll('button')].find((button) => button.textContent === '查询')
      await click(query!)
      await act(async () => {})
      expect(calls.some((call) => call.url.endsWith('/composite-routes/preview') && call.method === 'POST')).toBe(true)
      expect(view.container.textContent).toContain('命中')
      expect(view.container.textContent).toContain('目标平台: openai')
      expect(view.container.textContent).toContain('上游模型: gpt-5.3-codex-spark')
    } finally {
      await view.unmount()
    }
  })

  it('renders the miss reason when the preview matches nothing', async () => {
    stubAdminPlane({
      [`GET ${ADMIN_API}/groups`]: GROUPS,
      [`GET ${ADMIN_API}/groups/8/composite-routes`]: [],
      [`POST ${ADMIN_API}/groups/8/composite-routes/preview`]: {
        matched: false, source: '', target_platform: '', upstream_model: '', endpoint: 'any', reason: 'no explicit route or built-in detector match',
      },
    })
    const view = await renderPanel()
    try {
      const previewInputs = [...view.container.querySelectorAll<HTMLInputElement>('input[placeholder="openrouter/gpt-5"]')]
      await setValue(previewInputs[1]!, 'no-such-model')
      const query = [...view.container.querySelectorAll('button')].find((button) => button.textContent === '查询')
      await click(query!)
      await act(async () => {})
      expect(view.container.textContent).toContain('未命中')
      expect(view.container.textContent).toContain('no explicit route or built-in detector match')
    } finally {
      await view.unmount()
    }
  })

  it('surfaces a load failure inside the panel', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 500, message: 'boom' })))
    const view = await renderPanel()
    try {
      expect(view.container.textContent).toContain('路由加载失败')
      expect(view.container.textContent).toContain('boom')
    } finally {
      await view.unmount()
    }
  })
})
