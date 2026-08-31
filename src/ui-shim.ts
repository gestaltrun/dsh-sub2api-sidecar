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
 * Console v1.2 adds two account-surface behaviors on top:
 *
 * 1. Shell masking (spec S1): one `<style>` narrows the embed to the
 *    account-management content area — the upstream sidebar (including its
 *    bottom 我的账户 group) and the complete upstream header are hidden, and
 *    the content column's sidebar margin is released. Desktop owns the outer
 *    title, status, lifecycle actions, theme, and locale. The same mask
 *    applies on deep links because the shim runs on every passthrough page.
 *    `style-src 'unsafe-inline'` in upstream's CSP permits the injected tag.
 * 2. Composite-group auto-join (spec S2): the fetch/XHR wrappers intercept
 *    account create (`POST /api/v1/admin/accounts`) and update
 *    (`PUT /api/v1/admin/accounts/<id>`) JSON bodies and merge the composite
 *    group's id into `group_ids` when the body does not already carry it —
 *    the form's group picker (`[data-tour="account-form-groups"]`) is hidden
 *    by the mask, so embedded accounts always land in the composite group.
 *    The id is resolved once through the injected-key admin plane and
 *    cached; XHR sends are deferred onto that promise (XHR is asynchronous,
 *    so the caller observes no semantic change).
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

/**
 * The shell-mask stylesheet (spec v1.2 S1/S2): narrows the embed to the
 * account-management content area and hides the account form's group picker.
 * Every selector is structural or build-stable (`data-tour`), never
 * locale-dependent text. Kept as one constant so the passthrough tests can
 * assert each rule's presence.
 */
export const UI_EMBED_MASK_CSS = [
  // The whole upstream sidebar: every entry it holds (including the bottom
  // 我的账户 group) leaves the accounts page.
  'aside.sidebar{display:none!important}',
  // Release the content column's sidebar margin (`lg:ml-64` on the wrapper).
  '.sidebar~div{margin-left:0!important}',
  // Desktop owns the surrounding title, status, theme, and locale controls.
  'header{display:none!important}',
  // The add/edit account form's group picker; the shim's body rewrite below
  // is what keeps group membership correct while the control is hidden.
  '[data-tour="account-form-groups"]{display:none!important}',
].join('\n')

/** The shim source; executed once per embedded page load, before any module script. */
export const UI_EMBED_SHIM = `(function () {
  var PREFIX = ${JSON.stringify(UI_PREFIX)}
  var MASK_CSS = ${JSON.stringify(UI_EMBED_MASK_CSS)}
  var SESSION_TOKEN = 'dsh-embedded-session'
  // The host section passes its current theme and locale on the iframe URL.
  // Read them before the history rewrite below and write the upstream storage
  // keys before its app mounts.
  var themeMatch = /[?&]theme=(light|dark)(?=&|$)/.exec(location.search)
  var langMatch = /[?&]lang=(zh|en)(?=&|$)/.exec(location.search)
  try {
    if (themeMatch && window.localStorage) {
      window.localStorage.setItem('theme', themeMatch[1])
    }
    if (langMatch && window.localStorage) {
      window.localStorage.setItem('sub2api_locale', langMatch[1])
    }
  } catch (_) {}
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
    // Suppress upstream's 21-step welcome tour inside the embed: the tour
    // auto-starts unless its seen flag is set. Upstream derives the flag key
    // in useOnboardingTour as storageKey + '_' + userId + '_' + role +
    // '_v4_interactive' with storageKey 'admin_guide' for admins; the
    // embedded identity seeded above is id 0 / role admin, so the key is
    // deterministic.
    if (window.localStorage.getItem('admin_guide_0_admin_v4_interactive') !== 'true') {
      window.localStorage.setItem('admin_guide_0_admin_v4_interactive', 'true')
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
  // Shell mask (spec v1.2 S1/S2): one style tag narrows the embed to the
  // account-management content area and hides the account form's group
  // picker. The shim runs inside <head>, so the tag attaches immediately and
  // covers asynchronously rendered dialogs without an observer.
  try {
    if (typeof document !== 'undefined' && document.head &&
        !document.head.querySelector('style[data-dsh-embed-mask]')) {
      var mask = document.createElement('style')
      mask.setAttribute('data-dsh-embed-mask', '')
      mask.textContent = MASK_CSS
      document.head.appendChild(mask)
    }
  } catch (_) {}
  // Composite-group auto-join (spec v1.2 S2): the composite group id is
  // resolved once through the injected-key admin plane and cached; account
  // create/update JSON bodies get the id merged into group_ids when absent.
  var compositeGroupIdPromise = null
  function compositeGroupId() {
    if (compositeGroupIdPromise === null && typeof nativeFetch === 'function') {
      compositeGroupIdPromise = nativeFetch(PREFIX + '/api/v1/admin/groups?page=1&page_size=100')
        .then(function (response) { return response.json() })
        .then(function (envelope) {
          var items = envelope && envelope.data && envelope.data.items
          if (!Array.isArray(items)) return undefined
          for (var i = 0; i < items.length; i++) {
            if (items[i] && items[i].platform === 'composite') return items[i].id
          }
          return undefined
        })
        .catch(function () {
          // A failed lookup must not poison later mutations: retry next time.
          compositeGroupIdPromise = null
          return undefined
        })
    }
    return compositeGroupIdPromise || Promise.resolve(undefined)
  }
  // Whether one raw (pre-rewrite) request mutates one account's groups.
  function isAccountMutation(method, url) {
    if (typeof url !== 'string') return false
    var path = url.split('?')[0]
    if (method === 'POST' && path === '/api/v1/admin/accounts') return true
    if (method === 'PUT' && /^\\/api\\/v1\\/admin\\/accounts\\/[^/]+$/.test(path)) return true
    return false
  }
  // Merge the composite id into one JSON body; anything unparseable or
  // non-object passes through untouched.
  function ensureCompositeGroup(body, id) {
    try {
      var parsed = JSON.parse(body)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return body
      var ids = parsed.group_ids
      if (!Array.isArray(ids) || ids.length === 0) parsed.group_ids = [id]
      else if (ids.indexOf(id) === -1) parsed.group_ids = ids.concat([id])
      return JSON.stringify(parsed)
    } catch (_) { return body }
  }
  var nativeFetch = window.fetch
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        var rawUrl = typeof input === 'string' ? input : undefined
        var method = String((init && init.method) || 'GET').toUpperCase()
        if (typeof input === 'string') input = rewrite(input)
        if (isAccountMutation(method, rawUrl) && init && typeof init.body === 'string') {
          var originalBody = init.body
          return compositeGroupId().then(function (id) {
            var nextInit = id === undefined ? init : Object.assign({}, init, { body: ensureCompositeGroup(originalBody, id) })
            return nativeFetch.call(window, input, nextInit)
          })
        }
      } catch (_) {}
      return nativeFetch.call(this, input, init)
    }
  }
  var nativeOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function () {
    var args = Array.prototype.slice.call(arguments)
    try {
      this.__dshMethod = String(args[0] || 'GET').toUpperCase()
      this.__dshUrl = args[1]
      if (args.length > 1) args[1] = rewrite(args[1])
    } catch (_) {}
    return nativeOpen.apply(this, args)
  }
  var nativeSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (isAccountMutation(this.__dshMethod, this.__dshUrl) && typeof body === 'string') {
        var self = this
        compositeGroupId().then(function (id) {
          nativeSend.call(self, id === undefined ? body : ensureCompositeGroup(body, id))
        })
        return
      }
    } catch (_) {}
    return nativeSend.apply(this, arguments)
  }
})();`
