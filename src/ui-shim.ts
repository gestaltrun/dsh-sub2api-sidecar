/**
 * The runtime shim served by the passthrough at `dsh-embed-shim.js` and
 * referenced as an external same-origin script in every transformed HTML
 * response. It is the whole browser-side login bypass (spec v1.1 Q18=2,
 * gestaltrun/deepseek-harness-gestalt#349): the upstream SPA must never see
 * the login page inside the embed, so the shim seeds the local-storage
 * session keys upstream's auth store reads before its first navigation,
 * rewrites the SPA's path-absolute `/api/v1/*` API calls onto the same-origin
 * passthrough prefix (path-absolute URLs ignore `<base href>`), and rewrites
 * the history entry to the unprefixed inner path so the upstream router —
 * built with the absolute base `/` — resolves its routes. External delivery
 * is required by upstream's CSP (`script-src 'self' 'nonce-…'` refuses
 * inline scripts).
 *
 * The session itself carries no credential: the seeded token is a constant
 * placeholder, the authoritative key is injected host-side on the admin plane
 * and never reaches the renderer, and the session identity comes from the
 * passthrough's fabricated `/api/v1/auth/*` answers. If the upstream
 * storage-key contract changes, this script is the only place to update.
 *
 * @module dsh-sub2api-sidecar/ui-shim
 */

/** Host-side pathname prefix the embedded console is served under. */
const UI_PREFIX = '/plugins/dsh-sub2api/ui'

/** The shim source; executed once per embedded page load, before any module script. */
export const UI_EMBED_SHIM = `(function () {
  var PREFIX = ${JSON.stringify(UI_PREFIX)}
  var SESSION_TOKEN = 'dsh-embedded-session'
  // The upstream router is built with the absolute base '/' (baked at its
  // build time), so it must observe an unprefixed pathname. Rewrite the
  // history entry to the inner path before any module script runs; dynamic
  // chunks keep resolving against the module URLs under the prefix, and the
  // <base href> keeps runtime-relative URLs there too.
  try {
    if (location.pathname === PREFIX) {
      history.replaceState(null, '', '/' + location.search)
    } else if (location.pathname.indexOf(PREFIX + '/') === 0) {
      history.replaceState(null, '', location.pathname.slice(PREFIX.length) + location.search)
    }
  } catch (_) {}
  try {
    if (window.localStorage && !window.localStorage.getItem('auth_token')) {
      var now = Date.now()
      window.localStorage.setItem('auth_token', SESSION_TOKEN)
      window.localStorage.setItem('refresh_token', SESSION_TOKEN)
      window.localStorage.setItem('token_expires_at', String(now + 400 * 86400000))
      window.localStorage.setItem('auth_user', JSON.stringify({
        id: 0, username: 'dsh-embedded', role: 'admin', status: 'active',
      }))
    }
  } catch (_) {}
  // Rebase path-absolute element URLs: the upstream preload helper resolves
  // its code-split CSS/JS dependencies as base + '/assets/…', ignoring
  // <base href>, and a single failed preload aborts route mounting. <link>
  // href and <img> src that name the upstream root therefore belong to the
  // passthrough prefix; API paths ride the fetch/XHR rewrite below.
  function rebase(url) {
    if (typeof url !== 'string') return url
    if (url === PREFIX || url.indexOf(PREFIX + '/') === 0) return url
    if (url.charAt(0) !== '/' || url.charAt(1) === '/') return url
    if (url.indexOf('/api/') === 0) return url
    return PREFIX + url
  }
  function patch(proto, prop) {
    try {
      var desc = Object.getOwnPropertyDescriptor(proto, prop)
      if (!desc || !desc.set) return
      Object.defineProperty(proto, prop, {
        enumerable: desc.enumerable,
        configurable: true,
        get: function () { return desc.get.call(this) },
        set: function (value) { desc.set.call(this, rebase(value)) },
      })
    } catch (_) {}
  }
  if (typeof HTMLLinkElement !== 'undefined') patch(HTMLLinkElement.prototype, 'href')
  if (typeof HTMLImageElement !== 'undefined') patch(HTMLImageElement.prototype, 'src')
  // Defense in depth: if a preload still fails, let the route import run
  // rather than leaving the shell blank.
  try {
    window.addEventListener('vite:preloadError', function (event) { event.preventDefault() })
  } catch (_) {}
  function rewrite(url) {
    if (typeof url !== 'string') return url
    if (url === '/api/v1') return PREFIX + '/api/v1'
    if (url.indexOf('/api/v1/') === 0) return PREFIX + url
    return url
  }
  var nativeFetch = window.fetch
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string') input = rewrite(input)
      } catch (_) {}
      return nativeFetch.call(this, input, init)
    }
  }
  var nativeOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function () {
    var args = Array.prototype.slice.call(arguments)
    try {
      if (args.length > 1) args[1] = rewrite(args[1])
    } catch (_) {}
    return nativeOpen.apply(this, args)
  }
})();`
