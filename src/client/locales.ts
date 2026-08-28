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
  /** Proxy panel heading and the shared-table hint. */
  'proxies.title': string
  'proxies.hint': string
  /** Proxy toolbar: search placeholder, filter labels, actions. */
  'proxies.search': string
  'proxies.allProtocols': string
  'proxies.allStatus': string
  'proxies.refresh': string
  'proxies.add': string
  /** Proxy status labels. */
  'proxies.statusActive': string
  'proxies.statusInactive': string
  'proxies.statusExpired': string
  /** Proxy table columns. */
  'proxies.colName': string
  'proxies.colAddress': string
  'proxies.colAuth': string
  'proxies.colLocation': string
  'proxies.colAccounts': string
  'proxies.colLatency': string
  'proxies.colExpiry': string
  /** Proxy auth cell states. */
  'proxies.noAuth': string
  'proxies.revealAuth': string
  /** Proxy expiry cell when the proxy never expires. */
  'proxies.noExpiry': string
  /** Proxy row actions. */
  'proxies.test': string
  'proxies.quality': string
  'proxies.edit': string
  'proxies.delete': string
  /** Delete confirmation; `{name}` interpolates the proxy name. */
  'proxies.deleteConfirm': string
  /** Proxy form headings and actions. */
  'proxies.addTitle': string
  'proxies.editTitle': string
  'proxies.create': string
  'proxies.save': string
  'proxies.cancel': string
  /** Proxy form field labels. */
  'proxies.fieldName': string
  'proxies.fieldProtocol': string
  'proxies.fieldHost': string
  'proxies.fieldPort': string
  'proxies.fieldUsername': string
  'proxies.fieldPassword': string
  'proxies.fieldExpiry': string
  'proxies.fieldFallback': string
  'proxies.fallbackNone': string
  'proxies.fallbackDirect': string
  'proxies.fallbackProxy': string
  'proxies.fieldBackup': string
  'proxies.fieldWarnDays': string
  'proxies.changePassword': string
  /** Quality result line; `{score}`/`{grade}` interpolate. */
  'proxies.qualityResult': string
  /** Proxy failure copies. */
  'proxies.loadFailed': string
  'proxies.submitFailed': string
  'proxies.deleteFailed': string
  'proxies.required': string
  'proxies.portInvalid': string
  /** Proxy list states. */
  'proxies.empty': string
  'proxies.noMatch': string
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
  'proxies.title': '代理管理',
  'proxies.hint': '与账号表单的代理下拉共用同一张表：此处保存后下拉自动出现，无需刷新页面。',
  'proxies.search': '搜索代理…',
  'proxies.allProtocols': '全部协议',
  'proxies.allStatus': '全部状态',
  'proxies.refresh': '刷新',
  'proxies.add': '添加代理',
  'proxies.statusActive': '启用',
  'proxies.statusInactive': '停用',
  'proxies.statusExpired': '已过期',
  'proxies.colName': '名称',
  'proxies.colAddress': '地址',
  'proxies.colAuth': '认证',
  'proxies.colLocation': '地理位置',
  'proxies.colAccounts': '账号数',
  'proxies.colLatency': '延迟 / 质量',
  'proxies.colExpiry': '有效期',
  'proxies.noAuth': '无',
  'proxies.revealAuth': '显示/隐藏用户名',
  'proxies.noExpiry': '永久',
  'proxies.test': '测试',
  'proxies.quality': '质检',
  'proxies.edit': '编辑',
  'proxies.delete': '删除',
  'proxies.deleteConfirm': '删除代理「{name}」？',
  'proxies.addTitle': '添加代理',
  'proxies.editTitle': '编辑代理',
  'proxies.create': '创建',
  'proxies.save': '保存',
  'proxies.cancel': '取消',
  'proxies.fieldName': '名称',
  'proxies.fieldProtocol': '协议',
  'proxies.fieldHost': '地址',
  'proxies.fieldPort': '端口',
  'proxies.fieldUsername': '用户名',
  'proxies.fieldPassword': '密码',
  'proxies.fieldExpiry': '有效期',
  'proxies.fieldFallback': '回退模式',
  'proxies.fallbackNone': '无',
  'proxies.fallbackDirect': '直连',
  'proxies.fallbackProxy': '备用代理',
  'proxies.fieldBackup': '备用代理',
  'proxies.fieldWarnDays': '过期提醒（天）',
  'proxies.changePassword': '修改密码',
  'proxies.qualityResult': '评分 {score}（{grade}）',
  'proxies.loadFailed': '代理加载失败',
  'proxies.submitFailed': '保存失败',
  'proxies.deleteFailed': '删除失败',
  'proxies.required': '请填写名称与地址',
  'proxies.portInvalid': '端口需在 1-65535 之间',
  'proxies.empty': '暂无代理',
  'proxies.noMatch': '无匹配代理',
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
  'proxies.title': 'Proxy Management',
  'proxies.hint': 'Shares the same table as the account form\'s proxy dropdown: a proxy saved here appears in the dropdown without any page refresh.',
  'proxies.search': 'Search proxies…',
  'proxies.allProtocols': 'All protocols',
  'proxies.allStatus': 'All statuses',
  'proxies.refresh': 'Refresh',
  'proxies.add': 'Add Proxy',
  'proxies.statusActive': 'Active',
  'proxies.statusInactive': 'Inactive',
  'proxies.statusExpired': 'Expired',
  'proxies.colName': 'Name',
  'proxies.colAddress': 'Address',
  'proxies.colAuth': 'Auth',
  'proxies.colLocation': 'Location',
  'proxies.colAccounts': 'Accounts',
  'proxies.colLatency': 'Latency / Quality',
  'proxies.colExpiry': 'Expiry',
  'proxies.noAuth': 'None',
  'proxies.revealAuth': 'Show/hide username',
  'proxies.noExpiry': 'Never',
  'proxies.test': 'Test',
  'proxies.quality': 'Quality',
  'proxies.edit': 'Edit',
  'proxies.delete': 'Delete',
  'proxies.deleteConfirm': 'Delete proxy "{name}"?',
  'proxies.addTitle': 'Add Proxy',
  'proxies.editTitle': 'Edit Proxy',
  'proxies.create': 'Create',
  'proxies.save': 'Save',
  'proxies.cancel': 'Cancel',
  'proxies.fieldName': 'Name',
  'proxies.fieldProtocol': 'Protocol',
  'proxies.fieldHost': 'Host',
  'proxies.fieldPort': 'Port',
  'proxies.fieldUsername': 'Username',
  'proxies.fieldPassword': 'Password',
  'proxies.fieldExpiry': 'Expiry',
  'proxies.fieldFallback': 'Fallback',
  'proxies.fallbackNone': 'None',
  'proxies.fallbackDirect': 'Direct',
  'proxies.fallbackProxy': 'Backup proxy',
  'proxies.fieldBackup': 'Backup Proxy',
  'proxies.fieldWarnDays': 'Expiry warning (days)',
  'proxies.changePassword': 'Change password',
  'proxies.qualityResult': 'Score {score} ({grade})',
  'proxies.loadFailed': 'Failed to load proxies',
  'proxies.submitFailed': 'Failed to save',
  'proxies.deleteFailed': 'Failed to delete',
  'proxies.required': 'Please enter a name and a host',
  'proxies.portInvalid': 'Port must be within 1-65535',
  'proxies.empty': 'No proxies yet',
  'proxies.noMatch': 'No matching proxies',
}
