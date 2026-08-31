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
import { describeReason, EMBED_ROUTE, EMBED_SRC, embedUrl, hostLocale, hostTheme, readReadiness, Sub2apiSection } from '../src/client/Sub2apiSection.tsx'
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
    expect(dictionaries['dsh-sub2api-sidecar']?.zh?.nav).toBe('订阅转 API')
    expect(dictionaries['dsh-sub2api-sidecar']?.en?.nav).toBe('Subscribe-to-API')
    expect(state.registration?.options['name']).toBe('settings.section')
    expect(state.registration?.options['id']).toBe('sub2api')
    expect(state.registration?.options['order']).toBe(20)
    expect(state.registration?.options['locale']).toBe('dsh-sub2api-sidecar')
    const label = state.registration?.options['label'] as () => string
    expect(label()).toBe('订阅转 API')
  })
})

describe('readiness derivation', () => {
  it('maps a ready snapshot to the ready phase', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ status: 'ready', generatedAt: '2026-08-28T03:04:05.000Z', accounts: [1, 2, 3] }))
    expect(await readReadiness(fetchImpl as unknown as typeof fetch)).toEqual({ phase: 'ready' })
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
      expect(frame?.getAttribute('src')).toBe(`${EMBED_SRC}${EMBED_ROUTE}?embed=desktop&theme=${hostTheme()}&lang=${hostLocale()}`)
      expect(frame?.getAttribute('title')).toBe('订阅转 API')
    } finally {
      await view.unmount()
    }
  })

  it('renders only the native account surface without a host toolbar or route panel', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      Response.json({ status: 'ready', generatedAt: '2026-08-28T11:46:17.347Z', accounts: [{}, {}] })))
    const view = await renderSection()
    try {
      const frame = view.container.querySelector('iframe')
      expect(frame).not.toBeNull()
      expect(view.container.querySelector('aside')).toBeNull()
      expect(view.container.querySelector('a')).toBeNull()
      expect(view.container.textContent).not.toContain('快照')
    } finally {
      await view.unmount()
    }
  })

  it('passes the host theme and locale through to the Desktop account embed URL', async () => {
    expect(hostTheme()).toBe('light') // jsdom has no matchMedia; the fallback is light
    expect(hostLocale()).toBe('en')
    document.documentElement.lang = 'zh-CN'
    document.documentElement.classList.add('dark')
    expect(hostTheme()).toBe('dark')
    expect(hostLocale()).toBe('zh')
    expect(embedUrl()).toBe(`${EMBED_SRC}${EMBED_ROUTE}?embed=desktop&theme=dark&lang=zh`)
    document.documentElement.classList.remove('dark')
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
        expect(view.container.querySelector('iframe')?.getAttribute('src')).toBe(`${EMBED_SRC}${EMBED_ROUTE}?embed=desktop&theme=dark&lang=zh`)
      } finally {
        await view.unmount()
      }
    } finally {
      document.documentElement.lang = ''
      delete (window as { matchMedia?: unknown }).matchMedia
    }
  })

  it('reloads the native account surface when Desktop theme or language changes', async () => {
    document.documentElement.style.colorScheme = 'light'
    document.documentElement.lang = 'en'
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'ready' })))
    const view = await renderSection()
    try {
      const frame = view.container.querySelector('iframe')
      expect(frame?.getAttribute('src')).toBe(`${EMBED_SRC}${EMBED_ROUTE}?embed=desktop&theme=light&lang=en`)
      await act(async () => {
        document.documentElement.style.colorScheme = 'dark'
        document.documentElement.lang = 'zh-CN'
        await new Promise((resolve) => { setTimeout(resolve, 0) })
      })
      expect(frame?.getAttribute('src')).toBe(`${EMBED_SRC}${EMBED_ROUTE}?embed=desktop&theme=dark&lang=zh`)
    } finally {
      document.documentElement.style.colorScheme = ''
      document.documentElement.lang = ''
      await view.unmount()
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
