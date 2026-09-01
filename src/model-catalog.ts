/** Keep the Gestalt provider catalog aligned with Sub2API's live gateway models. */

import type { SidecarConfig } from './config.ts'
import { reconcileProfile } from './llm-profile.ts'
import type { CredentialsService, LoggerLike, SettingsService } from './seam.ts'
import { Sub2apiClient } from './sub2api-client.ts'

/** Dependencies for the live model-catalog synchronizer. */
export interface ProviderModelCatalogOptions {
  readonly config: SidecarConfig
  readonly credentials: CredentialsService
  readonly settings: SettingsService
  readonly logger: LoggerLike
  readonly sidecar: { readonly port: number | undefined }
  readonly fetchImpl?: typeof fetch
}

/** Poll and mutation-triggered synchronizer for one provider route. */
export class ProviderModelCatalogService {
  private timer: NodeJS.Timeout | undefined
  private cycle: Promise<void> | undefined
  private stopped = false

  /** @param options - live sidecar, credentials, settings, and polling configuration. */
  constructor(private readonly options: ProviderModelCatalogOptions) {}

  /** Begin with an immediate refresh and retain the configured polling fallback. */
  start(): void {
    if (this.stopped || this.timer !== undefined || this.cycle !== undefined) return
    void this.runCycle()
  }

  /** Queue a refresh after any in-flight refresh and wait for its settings write. */
  refresh(): Promise<void> {
    const previous = this.cycle ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => this.refreshOnce())
    const settled = next.finally(() => {
      if (this.cycle === settled) this.cycle = undefined
    })
    this.cycle = settled
    return settled
  }

  /** Stop future polling and wait for the current catalog write. */
  async dispose(): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    await this.cycle?.catch(() => {})
  }

  private async runCycle(): Promise<void> {
    await this.refresh().catch((error) => {
      this.options.logger.warn('dsh-sub2api-sidecar: provider model catalog refresh failed (%s)', describe(error))
    })
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.runCycle()
    }, this.options.config.modelCatalogPollMs)
    this.timer.unref()
  }

  private async refreshOnce(): Promise<void> {
    const port = this.options.sidecar.port
    if (port === undefined) return
    const credential = await this.options.credentials.resolve(this.options.config.credentials.inferenceRef)
    const adminCredential = await this.options.credentials.resolve(this.options.config.credentials.adminRef)
    if (credential === undefined || adminCredential === undefined) return
    const client = new Sub2apiClient({
      baseUrl: `http://127.0.0.1:${String(port)}`,
      timeoutMs: this.options.config.proxy.timeoutMs,
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
    })
    const groups = await client.listGroups({ kind: 'adminKey', key: adminCredential.value }, 'composite')
    const group = groups.find(candidate => candidate.name === this.options.config.group.name)
    const accountModels = group === undefined
      ? []
      : await client.listGroupAccountModels({ kind: 'adminKey', key: adminCredential.value }, group.id)
    const allowed = new Set(accountModels)
    const models = (await client.listGatewayModels(credential.value)).filter(model => allowed.has(model.id))
    if (models.length === 0) {
      await reconcileProfile(
        this.options.settings,
        this.options.config,
        port,
        [],
        this.options.logger,
      )
      return
    }
    await reconcileProfile(
      this.options.settings,
      this.options.config,
      port,
      models,
      this.options.logger,
    )
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
