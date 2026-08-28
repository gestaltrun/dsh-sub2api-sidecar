/**
 * Chinese product copy and the English fallback for the embedded console's
 * Settings section.
 */

/** The locale namespace owned by this plugin. */
export const SECTION_LOCALE_NAMESPACE = 'dsh-sub2api-sidecar'

/** Dictionary keys used by the section component. */
export type SectionKeys = {
  /** Left-nav entry of the settings shell. */
  'nav': string
  /** Status line while the readiness poll has not answered yet. */
  'checking': string
  /** Heading of the not-ready fallback card. */
  'unreadyTitle': string
  /** Rendered reason why the console is unavailable. */
  'reason.sidecar-not-ready': string
  'reason.admin-key-unavailable': string
  'reason.accounts-list-failed': string
  'reason.no-poll-yet': string
  'reason.unreachable': string
  /** Retry button of the fallback card. */
  'retry': string
  /** Loopback direct-console fallback link. */
  'directLink': string
  /** Hint explaining what the direct console is and where its password lives. */
  'directHint': string
  /** Ready-state toolbar summary: account count plus snapshot time. */
  'toolbarSummary': string
  /** Ready-state toolbar action opening the console in a new window. */
  'openExternal': string
}

/** Chinese copy (the product's primary language). */
export const zh: SectionKeys = {
  'nav': '订阅账号池',
  'checking': '正在检查 sidecar 状态…',
  'unreadyTitle': 'sidecar 未就绪',
  'reason.sidecar-not-ready': 'sidecar 进程未运行，等待监督器拉起。',
  'reason.admin-key-unavailable': '管理密钥尚未完成签发。',
  'reason.accounts-list-failed': 'sidecar 已启动，但账号列表读取失败。',
  'reason.no-poll-yet': '正在等待首次状态轮询。',
  'reason.unreachable': '状态接口不可达（插件代理未启用或未挂载）。',
  'retry': '重试',
  'directLink': '打开本地管理台直连',
  'directHint': '直连将打开 sidecar 自带管理台的登录页；管理员密码存于 ~/.dsh/sub2api/run/admin-password。',
  'toolbarSummary': '共 {count} 个账号 · 快照 {time}',
  'openExternal': '在新窗口打开',
}

/** English copy. */
export const en: SectionKeys = {
  'nav': 'Subscription Account Pool',
  'checking': 'Checking sidecar status…',
  'unreadyTitle': 'sidecar is not ready',
  'reason.sidecar-not-ready': 'The sidecar process is not running; waiting for the supervisor.',
  'reason.admin-key-unavailable': 'The admin key has not been issued yet.',
  'reason.accounts-list-failed': 'The sidecar is up, but the account list could not be read.',
  'reason.no-poll-yet': 'Waiting for the first status poll.',
  'reason.unreachable': 'The status endpoint is unreachable (plugin proxy disabled or not mounted).',
  'retry': 'Retry',
  'directLink': 'Open the local console directly',
  'directHint': 'The direct link opens the sidecar console with its own login page; the admin password is kept in ~/.dsh/sub2api/run/admin-password.',
  'toolbarSummary': '{count} accounts · snapshot {time}',
  'openExternal': 'Open in new window',
}
