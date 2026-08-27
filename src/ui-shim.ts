/**
 * The runtime shim injected into every HTML response of the embedded-console
 * passthrough. It is the whole browser-side login bypass (spec v1.1 Q18=2,
 * gestaltrun/deepseek-harness-gestalt#349): the upstream SPA must never see
 * the login page inside the embed, so the shim seeds the local-storage
 * session keys upstream's auth store reads before its first navigation, and
 * rewrites the SPA's path-absolute `/api/v1/*` API calls onto the same-origin
 * passthrough prefix (path-absolute URLs ignore `<base href>`).
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
