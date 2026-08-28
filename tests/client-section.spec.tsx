// @vitest-environment jsdom
/**
 * The browser half: the `settings.section` registration shape (locale
 * namespace, section id, order, and the locale-following nav label), the
 * readiness derivation from the snapshot surface, and the section
 * component's user-visible states — the actionable fallback card with the
 * loopback direct-console link while the sidecar is down, and the
 * full-bleed console iframe once it is ready.
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { describeReason, EMBED_ROUTE, EMBED_SRC, formatSnapshotTime, hostTheme, readReadiness, Sub2apiSection } from '../src/client/Sub2apiSection.tsx'
import { en, zh, type SectionKeys } from '../src/client/locales.ts'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/** The zh translate seat the tests render with; without params it returns the raw template, matching the host bind. */
const t = (key: string, params?: Record<string, unknown>): string => {
  const raw = zh[key as keyof SectionKeys] ?? key
  if (params === undefined) return raw
  return raw.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ''))
}

/** Record what apply registers, standing in for the client context. */
function stubContext(): {
  ctx: ClientContext
  dictionaries: Record<string, Record<string, Record<string, string>>>
  injected: string[]
  state: { registration: { options: Record<string, unknown>; component: unknown } | undefined }
} {
  const dictionaries: Record<string, Record<string, Record<string, string>>> = {}
  const injected: string[] = []
  const state: { registration: { options: Record<string, unknown>; component: unknown } | undefined } = {
    registration: undefined,
  }
  const ctx = {
    effect: (execute: () => () => unknown) => execute(),
    locale: {
      register: (namespace: string, dict: Record<string, Record<string, string>>) => {
        dictionaries[namespace] = dict
        return () => {}
      },
      bind: (namespace: string) => (key: string) =>
        dictionaries[namespace]?.zh?.[key] ?? key,
    },
    slots: {
      register: (options: Record<string, unknown>, component: unknown) => {
        state.registration = { options, component }
        return () => {}
      },
      inject: (slot: string, register: () => unknown) => {
        injected.push(slot)
        register()
      },
    },
  }
  return { ctx: ctx as unknown as ClientContext, dictionaries, injected, state }
}

/** Mount the section component and return its DOM container. */
async function renderSection(): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<Sub2apiSection t={t} />)
  })
  // Flush the first readiness poll (its promise resolves within act above,
  // the follow-up state update settles on the next microtask turn).
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

describe('registration', () => {
  it('registers the section with its locale namespace and a live nav label', () => {
    const { ctx, dictionaries, injected, state } = stubContext()
    apply(ctx)
    expect(inject).toEqual(['slots', 'locale'])
    expect(injected).toEqual(['settings.section'])
    expect(dictionaries['dsh-sub2api-sidecar']?.zh?.nav).toBe('订阅账号池')
    expect(dictionaries['dsh-sub2api-sidecar']?.en?.nav).toBe('Subscription Account Pool')
    expect(state.registration?.options['name']).toBe('settings.section')
    expect(state.registration?.options['id']).toBe('sub2api')
    expect(state.registration?.options['order']).toBe(20)
    expect(state.registration?.options['locale']).toBe('dsh-sub2api-sidecar')
    const label = state.registration?.options['label'] as () => string
    expect(label()).toBe('订阅账号池')
  })
})

describe('readiness derivation', () => {
  it('maps a ready snapshot to the ready phase with the toolbar data', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ status: 'ready', generatedAt: '2026-08-28T03:04:05.000Z', accounts: [1, 2, 3] }))
    expect(await readReadiness(fetchImpl as unknown as typeof fetch)).toEqual({
      phase: 'ready', accountCount: 3, snapshotAt: '2026-08-28T03:04:05.000Z',
    })
  })

  it('carries the unavailability reason and the sidecar port', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ status: 'unavailable', reason: 'sidecar-not-ready', sidecarPort: 45123 }))
    expect(await readReadiness(fetchImpl as unknown as typeof fetch)).toEqual({
      phase: 'unavailable', reason: 'sidecar-not-ready', sidecarPort: 45123,
    })
  })

  it('reports unreachable when the snapshot surface refuses or fails', async () => {
    const refused = vi.fn(async () => new Response('no', { status: 404 }))
    expect(await readReadiness(refused as unknown as typeof fetch)).toMatchObject({ phase: 'unavailable', reason: 'unreachable' })
    const failing = vi.fn(async () => {
      throw new Error('down')
    })
    expect(await readReadiness(failing as unknown as typeof fetch)).toMatchObject({ phase: 'unavailable', reason: 'unreachable' })
  })

  it('renders unknown reasons as the waiting copy', () => {
    expect(describeReason('no-poll-yet', t)).toBe(zh['reason.no-poll-yet'])
    expect(describeReason('accounts-list-failed', t)).toBe(zh['reason.accounts-list-failed'])
  })
})

describe('section component', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the fallback card with the direct-console link while the sidecar is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      Response.json({ status: 'unavailable', reason: 'sidecar-not-ready', sidecarPort: 45123 })))
    const view = await renderSection()
    try {
      expect(view.container.textContent).toContain('sidecar 未就绪')
      expect(view.container.textContent).toContain(zh['reason.sidecar-not-ready'])
      expect(view.container.textContent).toContain('重试')
      const link = view.container.querySelector('a')
      expect(link?.getAttribute('href')).toBe('http://127.0.0.1:45123/')
      expect(link?.textContent).toBe('打开本地管理台直连')
      expect(view.container.querySelector('iframe')).toBeNull()
    } finally {
      await view.unmount()
    }
  })

  it('omits the direct link when no sidecar port is known', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      Response.json({ status: 'unavailable', reason: 'admin-key-unavailable' })))
    const view = await renderSection()
    try {
      expect(view.container.textContent).toContain(zh['reason.admin-key-unavailable'])
      expect(view.container.querySelector('a')).toBeNull()
    } finally {
      await view.unmount()
    }
  })

  it('fills the section with the console iframe once the snapshot is ready', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      Response.json({ status: 'ready', accounts: [] })))
    const view = await renderSection()
    try {
      const frame = view.container.querySelector('iframe')
      expect(frame?.getAttribute('src')).toBe(`${EMBED_SRC}${EMBED_ROUTE}?theme=${hostTheme()}`)
      expect(frame?.getAttribute('title')).toBe('订阅账号池')
    } finally {
      await view.unmount()
    }
  })

  it('renders the slim toolbar with the account count, snapshot time, and the new-window action', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      Response.json({ status: 'ready', generatedAt: '2026-08-28T11:46:17.347Z', accounts: [{}, {}] })))
    const view = await renderSection()
    try {
      const summary = view.container.querySelector('span')
      expect(summary?.textContent).toBe(`共 2 个账号 · 快照 ${formatSnapshotTime('2026-08-28T11:46:17.347Z')}`)
      expect(formatSnapshotTime('2026-08-28T11:46:17.347Z')).toMatch(/^\d{2}:\d{2}$/)
      const open = view.container.querySelector('a')
      expect(open?.textContent).toBe('在新窗口打开')
      expect(open?.getAttribute('href')).toBe(`${EMBED_SRC}${EMBED_ROUTE}?theme=${hostTheme()}`)
      expect(open?.getAttribute('target')).toBe('_blank')
      const frame = view.container.querySelector('iframe')
      expect(frame?.getAttribute('src')).toBe(open?.getAttribute('href'))
      // The toolbar strip sits above the two-column body, which holds the
      // route panel and the console frame.
      const body = open?.parentElement?.nextSibling as HTMLElement | null
      expect(body?.querySelector('iframe')).toBe(frame)
      expect(body?.querySelector('aside')).not.toBeNull()
    } finally {
      await view.unmount()
    }
  })

  it('passes the host color scheme through to the embed URL', async () => {
    expect(hostTheme()).toBe('light') // jsdom has no matchMedia; the fallback is light
    window.matchMedia = ((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia
    try {
      expect(hostTheme()).toBe('dark')
      vi.stubGlobal('fetch', vi.fn(async () =>
        Response.json({ status: 'ready', accounts: [] })))
      const view = await renderSection()
      try {
        expect(view.container.querySelector('iframe')?.getAttribute('src')).toBe(`${EMBED_SRC}${EMBED_ROUTE}?theme=dark`)
      } finally {
        await view.unmount()
      }
    } finally {
      delete (window as { matchMedia?: unknown }).matchMedia
    }
  })

  it('shows the checking copy before the first poll answers', async () => {
    let release: ((value: Response) => void) | undefined
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { release = resolve })))
    const view = await renderSection()
    try {
      expect(view.container.textContent).toContain('正在检查 sidecar 状态…')
      expect(view.container.querySelector('iframe')).toBeNull()
    } finally {
      release?.(Response.json({ status: 'ready' }))
      await act(async () => {})
      await view.unmount()
    }
  })
})
