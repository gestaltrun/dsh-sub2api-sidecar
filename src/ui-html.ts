/**
 * HTML transform for the embedded-console passthrough: make the sidecar's
 * SPA work under the host-side prefix without a frontend fork. The upstream
 * build emits path-absolute asset URLs and history-mode routing, so two
 * rewrites are applied to every HTML response:
 *
 * 1. Path-absolute element references (`src`/`href`/`poster`/`action` starting
 *    with a single slash) are prefixed with the passthrough base path —
 *    `<base href>` alone cannot rebase path-absolute URLs.
 * 2. `<base href>` plus the runtime shim script are injected right after the
 *    opening `<head>` tag, before any module script executes: the base fixes
 *    runtime-relative URLs and history-mode pushState, the shim reroutes the
 *    SPA's API calls (see {@link ui-shim}).
 *
 * Inline `src=`/`href=`-shaped JSON (the sidecar injects
 * `window.__APP_CONFIG__` into the HTML) is untouched: the rewrite matches
 * attribute syntax only — an equals sign directly followed by a quote.
 *
 * @module dsh-sub2api-sidecar/ui-html
 */

/** Element attributes carrying URLs the base-path rewrite applies to. */
const REWRITTEN_ATTRIBUTES = /(\b(?:src|href|poster|action)\s*=\s*)(")(\/(?!\/)[^"]*)(")/g

/**
 * Rewrite one HTML document for service under the passthrough base path.
 * @param html - the upstream HTML document.
 * @param basePath - the passthrough base path with a trailing slash.
 * @param shimScript - the runtime shim source, wrapped in a script element.
 * @returns the transformed document.
 */
export function transformUiHtml(html: string, basePath: string, shimScript: string): string {
  const prefix = basePath.replace(/\/$/, '')
  const rewritten = html.replace(
    REWRITTEN_ATTRIBUTES,
    (_match, attribute: string, quote: string, url: string, close: string) =>
      `${attribute}${quote}${prefix}${url}${close}`,
  )
  return injectIntoHead(rewritten, `<base href="${basePath}">${shimScript}`)
}

/** Insert content right after the opening `<head>` tag, falling back to the document start. */
function injectIntoHead(html: string, content: string): string {
  const head = /<head[^>]*>/i.exec(html)
  if (head === null) return `${content}${html}`
  const at = head.index + head[0].length
  return `${html.slice(0, at)}${content}${html.slice(at)}`
}
