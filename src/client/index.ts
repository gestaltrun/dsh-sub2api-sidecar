/**
 * Browser half of `dsh-sub2api-sidecar`: registers the 订阅账号池 Settings
 * section whose content embeds the sidecar's own admin console through the
 * host-side passthrough. The section owns no business UI — the console is
 * the upstream product surface, and the container's only job is readiness
 * presentation and the same-origin iframe.
 *
 * Export discipline: this module exports exactly what cordis loading needs
 * (`inject` and `apply`); everything else stays internal.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { Sub2apiSection } from './Sub2apiSection.tsx'
import { en, SECTION_LOCALE_NAMESPACE, zh } from './locales.ts'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * the settings shell; the registration waits on it through `slots.inject`.
 */
export const inject = ['slots', 'locale']

/**
 * Register the `dsh-sub2api-sidecar` dictionaries and the 订阅账号池 section.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(SECTION_LOCALE_NAMESPACE, { zh, en }),
    'dsh-sub2api-sidecar: dictionaries',
  )
  const t = ctx.locale.bind(SECTION_LOCALE_NAMESPACE)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'sub2api',
    order: 20,
    label: () => t('nav'),
    locale: SECTION_LOCALE_NAMESPACE,
  }, Sub2apiSection))
}
