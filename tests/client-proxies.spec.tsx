// @vitest-environment jsdom
/**
 * The proxy panel (console v1.2 S6): the data layer's payload transforms and
 * endpoint shapes, and the component's user-visible behavior — the
 * collapsible card, the filtered table with masked auth, the add/edit form,
 * delete confirmation with upstream error passthrough, and the per-row
 * test/quality actions.
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProxyPanel } from '../src/client/ProxyPanel.tsx'
import { ADMIN_API } from '../src/client/composite-routes.ts'
import { checkProxyQuality, createProxy, deleteProxy, listProxies, testProxy, updateProxy, type Proxy, type ProxyDraft } from '../src/client/proxies.ts'
import { zh, type SectionKeys } from '../src/client/locales.ts'

/** The zh translate seat the tests render with; without params it returns the raw template, matching the host bind. */
const t = (key: string, params?: Record<string, unknown>): string => {
  const raw = zh[key as keyof SectionKeys] ?? key
  if (params === undefined) return raw
  return raw.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ''))
}

/** One saved proxy fixture. */
function proxy(overrides: Partial<Proxy> = {}): Proxy {
  return {
    id: 1,
    name: 'dsh-local-system',
    protocol: 'http',
    host: '127.0.0.1',
    port: 6152,
    username: '',
    status: 'active',
    expires_at: null,
    fallback_mode: 'none',
    backup_proxy_id: null,
    expiry_warn_days: 0,
    account_count: 1,
    latency_ms: 637,
    latency_status: 'success',
    latency_message: 'Proxy is accessible',
    ip_address: '42.120.75.52',
    country: '中国',
    region: '浙江',
    city: '杭州',
    ...overrides,
  }
}

/** One recorded request the fetch double answered. */
interface RecordedCall {
  url: string
  method: string
  body?: Record<string, unknown>
}

/** Build a fetch double answering the admin plane from a route table. */
function stubAdminPlane(handlers: Record<string, unknown>): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined })
    const data = handlers[`${method} ${url}`] ?? handlers[`${method} ${url.split('?')[0] ?? ''}`]
    return Response.json({ code: 0, message: 'success', data })
  }))
  return { calls }
}

/** Mount the panel and return its DOM container. */
async function renderPanel(): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<ProxyPanel t={t} />)
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

/** Change one input/select through its native setter so React observes it. */
async function setValue(element: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
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

/** Expand the card and flush the first list load. */
async function expand(container: HTMLElement): Promise<void> {
  const toggle = container.querySelector('button[aria-expanded]')
  expect(toggle).not.toBeNull()
  await click(toggle!)
  await act(async () => {})
}

describe('proxy data layer', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists proxies from the paged endpoint', async () => {
    const { calls } = stubAdminPlane({ [`GET ${ADMIN_API}/proxies`]: { items: [proxy()], total: 1 } })
    expect(await listProxies()).toEqual([proxy()])
    expect(calls[0]?.url).toContain(`${ADMIN_API}/proxies?page=1&page_size=200`)
  })

  it('creates with the upstream payload transform', async () => {
    const { calls } = stubAdminPlane({ [`POST ${ADMIN_API}/proxies`]: proxy({ id: 9 }) })
    const draft: ProxyDraft = {
      name: '  edge-1 ', protocol: 'socks5', host: ' 10.0.0.2 ', port: 1080,
      username: ' user ', password: ' secret ', changePassword: false,
      expiresAt: '2026-12-31', fallbackMode: 'proxy', backupProxyId: 1, expiryWarnDays: 7,
    }
    await createProxy(draft)
    expect(calls[0]?.body).toEqual({
      name: 'edge-1',
      protocol: 'socks5',
      host: '10.0.0.2',
      port: 1080,
      username: 'user',
      password: 'secret',
      expires_at: Math.floor(new Date('2026-12-31').getTime() / 1000),
      fallback_mode: 'proxy',
      backup_proxy_id: 1,
      expiry_warn_days: 7,
    })
  })

  it('nulls empty credentials and expiry on create', async () => {
    const { calls } = stubAdminPlane({ [`POST ${ADMIN_API}/proxies`]: proxy({ id: 9 }) })
    await createProxy({
      name: 'plain', protocol: 'http', host: '10.0.0.3', port: 8080,
      username: '', password: '', changePassword: false,
      expiresAt: '', fallbackMode: 'none', backupProxyId: null, expiryWarnDays: 7,
    })
    expect(calls[0]?.body).toMatchObject({ username: null, password: null, expires_at: null, backup_proxy_id: null })
  })

  it('omits the password on update unless 修改密码 is checked', async () => {
    const { calls } = stubAdminPlane({ [`PUT ${ADMIN_API}/proxies/1`]: proxy() })
    const base: ProxyDraft = {
      name: 'renamed', protocol: 'http', host: '127.0.0.1', port: 6152,
      username: '', password: 'ignored', changePassword: false,
      expiresAt: '', fallbackMode: 'none', backupProxyId: null, expiryWarnDays: 3,
    }
    await updateProxy(1, base)
    expect(calls[0]?.url).toBe(`${ADMIN_API}/proxies/1`)
    expect(calls[0]?.body).not.toHaveProperty('password')
    await updateProxy(1, { ...base, changePassword: true })
    expect(calls[1]?.body).toMatchObject({ password: 'ignored' })
  })

  it('deletes, tests, and quality-checks against the row endpoints', async () => {
    const { calls } = stubAdminPlane({
      [`DELETE ${ADMIN_API}/proxies/1`]: null,
      [`POST ${ADMIN_API}/proxies/1/test`]: { success: true, message: 'Proxy is accessible', latency_ms: 654 },
      [`POST ${ADMIN_API}/proxies/1/quality-check`]: { score: 100, grade: 'A', summary: '通过 5 项' },
    })
    await deleteProxy(1)
    const tested = await testProxy(1)
    const quality = await checkProxyQuality(1)
    expect(tested).toMatchObject({ success: true, latency_ms: 654 })
    expect(quality).toMatchObject({ score: 100, grade: 'A' })
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `DELETE ${ADMIN_API}/proxies/1`,
      `POST ${ADMIN_API}/proxies/1/test`,
      `POST ${ADMIN_API}/proxies/1/quality-check`,
    ])
  })

  it('propagates upstream refusal messages unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 400, message: 'proxy is bound to 2 accounts' })))
    await expect(deleteProxy(1)).rejects.toThrow('proxy is bound to 2 accounts')
  })
})

describe('proxy panel component', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('stays collapsed with the shared-table hint until expanded, then lazy-loads', async () => {
    const { calls } = stubAdminPlane({ [`GET ${ADMIN_API}/proxies`]: { items: [proxy()] } })
    const view = await renderPanel()
    try {
      expect(view.container.textContent).toContain('代理管理')
      expect(view.container.textContent).toContain('无需刷新页面')
      expect(view.container.querySelector('table')).toBeNull()
      expect(calls).toHaveLength(0)
      await expand(view.container)
      expect(calls.some((call) => call.url.includes('/admin/proxies'))).toBe(true)
      expect(view.container.textContent).toContain('dsh-local-system')
      expect(view.container.textContent).toContain('127.0.0.1:6152')
      expect(view.container.textContent).toContain('637 ms')
      expect(view.container.textContent).toContain('杭州 浙江 中国')
      expect(view.container.textContent).toContain('账号数: 1')
      expect(view.container.textContent).toContain('有效期: 永久')
    } finally {
      await view.unmount()
    }
  })

  it('masks the username until the eye toggles it', async () => {
    stubAdminPlane({ [`GET ${ADMIN_API}/proxies`]: { items: [proxy({ username: 'proxy-user' })] } })
    const view = await renderPanel()
    try {
      await expand(view.container)
      expect(view.container.textContent).toContain('••••••')
      expect(view.container.textContent).not.toContain('proxy-user')
      const eye = view.container.querySelector('button[aria-label="显示/隐藏用户名"]')
      await click(eye!)
      expect(view.container.textContent).toContain('proxy-user')
    } finally {
      await view.unmount()
    }
  })

  it('filters by search, protocol, and status client-side', async () => {
    stubAdminPlane({
      [`GET ${ADMIN_API}/proxies`]: {
        items: [
          proxy({ id: 1, name: 'alpha', protocol: 'http', host: '10.0.0.1' }),
          proxy({ id: 2, name: 'beta', protocol: 'socks5', host: '10.0.0.2', status: 'inactive' }),
          proxy({ id: 3, name: 'gamma', protocol: 'http', host: '10.0.0.3', expires_at: '2020-01-01T00:00:00Z' }),
        ],
      },
    })
    const view = await renderPanel()
    try {
      await expand(view.container)
      expect(view.container.textContent).toContain('alpha')
      expect(view.container.textContent).toContain('beta')
      expect(view.container.textContent).toContain('gamma')
      const search = view.container.querySelector('input[placeholder="搜索代理…"]') as HTMLInputElement
      await setValue(search, 'alp')
      expect(view.container.textContent).toContain('alpha')
      expect(view.container.textContent).not.toContain('beta')
      await setValue(search, '')
      const selects = view.container.querySelectorAll('select')
      await setValue(selects[0] as HTMLSelectElement, 'socks5')
      expect(view.container.textContent).not.toContain('alpha')
      expect(view.container.textContent).toContain('beta')
      await setValue(selects[0] as HTMLSelectElement, '')
      await setValue(selects[1] as HTMLSelectElement, 'expired')
      expect(view.container.textContent).toContain('gamma')
      expect(view.container.textContent).not.toContain('alpha')
    } finally {
      await view.unmount()
    }
  })

  it('submits the add form to the create endpoint and reloads', async () => {
    const { calls } = stubAdminPlane({
      [`GET ${ADMIN_API}/proxies`]: { items: [] },
      [`POST ${ADMIN_API}/proxies`]: proxy({ id: 9, name: 'edge-1' }),
    })
    const view = await renderPanel()
    try {
      await expand(view.container)
      const add = [...view.container.querySelectorAll('button')].find((button) => button.textContent === '添加代理')
      await click(add!)
      expect(view.container.textContent).toContain('添加代理')
      const form = view.container.querySelector('form')
      const [nameInput, hostInput] = [...form!.querySelectorAll('input[type="text"]')]
      await setValue(nameInput as HTMLInputElement, 'edge-1')
      await setValue(hostInput as HTMLInputElement, '10.0.0.2')
      const submit = [...form!.querySelectorAll('button')].find((button) => button.textContent === '创建')
      await click(submit!)
      await act(async () => {})
      const create = calls.find((call) => call.method === 'POST')
      expect(create?.body).toMatchObject({ name: 'edge-1', protocol: 'http', host: '10.0.0.2', port: 8080, fallback_mode: 'none' })
      expect(calls.filter((call) => call.method === 'GET').length).toBeGreaterThanOrEqual(2)
    } finally {
      await view.unmount()
    }
  })

  it('refuses an incomplete form without calling the API', async () => {
    const { calls } = stubAdminPlane({ [`GET ${ADMIN_API}/proxies`]: { items: [] } })
    const view = await renderPanel()
    try {
      await expand(view.container)
      const add = [...view.container.querySelectorAll('button')].find((button) => button.textContent === '添加代理')
      await click(add!)
      const submit = [...view.container.querySelectorAll('button')].find((button) => button.textContent === '创建')
      await click(submit!)
      expect(view.container.textContent).toContain('请填写名称与地址')
      expect(calls.some((call) => call.method === 'POST')).toBe(false)
    } finally {
      await view.unmount()
    }
  })

  it('fills the form from a row edit and saves through the update endpoint', async () => {
    const { calls } = stubAdminPlane({
      [`GET ${ADMIN_API}/proxies`]: { items: [proxy()] },
      [`PUT ${ADMIN_API}/proxies/1`]: proxy({ name: 'renamed' }),
    })
    const view = await renderPanel()
    try {
      await expand(view.container)
      const edit = [...view.container.querySelectorAll('button')].find((button) => button.textContent === '编辑')
      await click(edit!)
      expect(view.container.textContent).toContain('编辑代理')
      const form = view.container.querySelector('form')
      const nameInput = form!.querySelector('input[type="text"]') as HTMLInputElement
      expect(nameInput.value).toBe('dsh-local-system')
      await setValue(nameInput, 'renamed')
      const save = [...form!.querySelectorAll('button')].find((button) => button.textContent === '保存')
      await click(save!)
      await act(async () => {})
      const update = calls.find((call) => call.method === 'PUT')
      expect(update?.url).toBe(`${ADMIN_API}/proxies/1`)
      expect(update?.body).toMatchObject({ name: 'renamed', host: '127.0.0.1', port: 6152 })
      expect(update?.body).not.toHaveProperty('password')
    } finally {
      await view.unmount()
    }
  })

  it('deletes after confirmation and passes an upstream binding refusal through', async () => {
    const { calls } = stubAdminPlane({ [`GET ${ADMIN_API}/proxies`]: { items: [proxy()] } })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const view = await renderPanel()
    try {
      await expand(view.container)
      const remove = [...view.container.querySelectorAll('button')].find((button) => button.textContent === '删除')
      await click(remove!)
      expect(confirmSpy).toHaveBeenCalledWith('删除代理「dsh-local-system」？')
      expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
      confirmSpy.mockReturnValue(true)
      vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string }) => {
        if (init?.method === 'DELETE') return Response.json({ code: 400, message: 'proxy is bound to 1 account' })
        return Response.json({ code: 0, message: 'success', data: { items: [proxy()] } })
      }))
      await click(remove!)
      await act(async () => {})
      expect(view.container.textContent).toContain('proxy is bound to 1 account')
    } finally {
      await view.unmount()
    }
  })

  it('runs the per-row test and quality actions and renders their results', async () => {
    stubAdminPlane({
      [`GET ${ADMIN_API}/proxies`]: { items: [proxy()] },
      [`POST ${ADMIN_API}/proxies/1/test`]: { success: true, message: 'Proxy is accessible', latency_ms: 654 },
      [`POST ${ADMIN_API}/proxies/1/quality-check`]: { score: 100, grade: 'A', summary: '通过 5 项' },
    })
    const view = await renderPanel()
    try {
      await expand(view.container)
      const test = [...view.container.querySelectorAll('button')].find((button) => button.textContent === '测试')
      await click(test!)
      await act(async () => {})
      expect(view.container.textContent).toContain('Proxy is accessible · 654 ms')
      const quality = [...view.container.querySelectorAll('button')].find((button) => button.textContent === '质检')
      await click(quality!)
      await act(async () => {})
      expect(view.container.textContent).toContain('评分 100（A）')
    } finally {
      await view.unmount()
    }
  })
})
