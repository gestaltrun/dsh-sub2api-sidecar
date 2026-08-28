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
  /** Route panel heading. */
  'routes.title': string
  /** Saved-routes reload action. */
  'routes.refresh': string
  /** Saved-routes block heading. */
  'routes.savedTitle': string
  /** Saved-routes table empty state. */
  'routes.empty': string
  /** Saved-routes table columns. */
  'routes.colModel': string
  'routes.colTarget': string
  'routes.colScope': string
  'routes.colOps': string
  /** Priority prefix inside the scope cell. */
  'routes.priority': string
  /** Row actions. */
  'routes.edit': string
  'routes.delete': string
  /** Delete confirmation; `{model}` interpolates the public model. */
  'routes.deleteConfirm': string
  /** Form headings. */
  'routes.addTitle': string
  'routes.editTitle': string
  /** Form field labels. */
  'routes.fieldModel': string
  'routes.fieldMatch': string
  'routes.fieldEndpoint': string
  'routes.fieldPlatform': string
  'routes.fieldPriority': string
  'routes.fieldUpstream': string
  'routes.fieldNotes': string
  'routes.fieldEnabled': string
  /** Explanation under the upstream-model field. */
  'routes.upstreamHint': string
  /** Form submit actions. */
  'routes.create': string
  'routes.save': string
  'routes.cancelEdit': string
  /** Match-kind labels. */
  'routes.matchExact': string
  'routes.matchPrefix': string
  /** The `any` endpoint scope label. */
  'routes.endpointAny': string
  /** Badge on a disabled route row. */
  'routes.disabled': string
  /** Preview block heading and controls. */
  'routes.previewTitle': string
  'routes.previewAction': string
  /** Preview result labels. */
  'routes.previewMatched': string
  'routes.previewMissed': string
  'routes.previewTarget': string
  'routes.previewUpstream': string
  /** Failure copies. */
  'routes.loadFailed': string
  'routes.submitFailed': string
  'routes.deleteFailed': string
  'routes.modelRequired': string
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
  'routes.title': '路由管理',
  'routes.refresh': '刷新',
  'routes.savedTitle': '已保存路由',
  'routes.empty': '暂无已保存路由',
  'routes.colModel': '公开模型',
  'routes.colTarget': '目标',
  'routes.colScope': '范围',
  'routes.colOps': '操作',
  'routes.priority': '优先级',
  'routes.edit': '编辑',
  'routes.delete': '删除',
  'routes.deleteConfirm': '删除路由「{model}」？',
  'routes.addTitle': '添加路由',
  'routes.editTitle': '编辑路由',
  'routes.fieldModel': '公开模型',
  'routes.fieldMatch': '匹配方式',
  'routes.fieldEndpoint': '端点',
  'routes.fieldPlatform': '目标平台',
  'routes.fieldPriority': '优先级',
  'routes.fieldUpstream': '上游模型',
  'routes.fieldNotes': '备注',
  'routes.fieldEnabled': '启用',
  'routes.upstreamHint': '留空表示透传原始请求模型：前缀匹配下每个命中模型各自原样转发（如 deepseek-v4-flash、deepseek-v4-pro 分别转发）；填写则所有命中请求都固定转发该模型。',
  'routes.create': '创建',
  'routes.save': '保存',
  'routes.cancelEdit': '取消',
  'routes.matchExact': '精确',
  'routes.matchPrefix': '前缀',
  'routes.endpointAny': '任意',
  'routes.disabled': '停用',
  'routes.previewTitle': '预览',
  'routes.previewAction': '查询',
  'routes.previewMatched': '命中',
  'routes.previewMissed': '未命中',
  'routes.previewTarget': '目标平台',
  'routes.previewUpstream': '上游模型',
  'routes.loadFailed': '路由加载失败',
  'routes.submitFailed': '保存失败',
  'routes.deleteFailed': '删除失败',
  'routes.modelRequired': '请填写公开模型',
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
  'routes.title': 'Route Management',
  'routes.refresh': 'Refresh',
  'routes.savedTitle': 'Saved Routes',
  'routes.empty': 'No saved routes yet',
  'routes.colModel': 'Public Model',
  'routes.colTarget': 'Target',
  'routes.colScope': 'Scope',
  'routes.colOps': 'Actions',
  'routes.priority': 'Priority',
  'routes.edit': 'Edit',
  'routes.delete': 'Delete',
  'routes.deleteConfirm': 'Delete route "{model}"?',
  'routes.addTitle': 'Add Route',
  'routes.editTitle': 'Edit Route',
  'routes.fieldModel': 'Public Model',
  'routes.fieldMatch': 'Match',
  'routes.fieldEndpoint': 'Endpoint',
  'routes.fieldPlatform': 'Target Platform',
  'routes.fieldPriority': 'Priority',
  'routes.fieldUpstream': 'Upstream Model',
  'routes.fieldNotes': 'Notes',
  'routes.fieldEnabled': 'Enabled',
  'routes.upstreamHint': 'Leave empty to pass the original request model through: with prefix matching each matched model forwards as-is (e.g. deepseek-v4-flash and deepseek-v4-pro forward separately); when filled, every matched request forwards to this model.',
  'routes.create': 'Create',
  'routes.save': 'Save',
  'routes.cancelEdit': 'Cancel',
  'routes.matchExact': 'Exact',
  'routes.matchPrefix': 'Prefix',
  'routes.endpointAny': 'Any',
  'routes.disabled': 'Disabled',
  'routes.previewTitle': 'Preview',
  'routes.previewAction': 'Resolve',
  'routes.previewMatched': 'Matched',
  'routes.previewMissed': 'No match',
  'routes.previewTarget': 'Target platform',
  'routes.previewUpstream': 'Upstream model',
  'routes.loadFailed': 'Failed to load routes',
  'routes.submitFailed': 'Failed to save',
  'routes.deleteFailed': 'Failed to delete',
  'routes.modelRequired': 'Please enter a public model',
}
