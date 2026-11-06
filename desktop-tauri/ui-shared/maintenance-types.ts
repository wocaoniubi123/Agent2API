export type MaintenanceTaskId = 'credentialMaintenance' | 'modelRefresh'
export type MaintenanceSource = 'automatic' | 'manual' | 'passive'
export type MaintenanceResultStatus = 'refreshed' | 'skipped' | 'failed'
export type MaintenanceRunStatus = 'running' | 'completed' | 'partial' | 'failed' | 'skipped' | 'interrupted'

export type MaintenanceTask = {
  id: MaintenanceTaskId
  enabled: boolean
  interval: number
  min: number
  max: number
  running: boolean
  lastRunAt: number | null
  lastResult: string | null
  lastError: string | null
  nextRunAt: number | null
  retryAt: number | null
  saved?: boolean
}

export type MaintenanceItem = {
  id: string
  provider: string
  providerLabel: string
  accountId: string | null
  accountName: string | null
  status: MaintenanceResultStatus
  message: string | null
  count: number | null
  refreshedAt: number | null
  expiresBefore: number | null
  expiresAfter: number | null
  credentialChanged: boolean | null
  durationMs: number | null
  fixed: boolean | null
  retryAt: number | null
  forced: boolean
}

export type MaintenanceRun = {
  id: string
  taskId: MaintenanceTaskId
  source: MaintenanceSource
  retryOf: string | null
  startedAt: number
  finishedAt: number | null
  durationMs: number | null
  status: MaintenanceRunStatus
  refreshed: number
  skipped: number
  failed: number
  total: number
  error: string | null
  metadata: MaintenanceItem | null
}

export type MaintenanceDetail = MaintenanceRun & { results: MaintenanceItem[] }
export type MaintenanceQuery = {
  taskId: MaintenanceTaskId | ''
  source: 'automatic' | 'manual' | ''
  status: 'failed' | 'success' | ''
  keyword: string
  offset: number
  limit: number
}
export type MaintenanceOverview = {
  tasks: MaintenanceTask[]
  latest: Partial<Record<MaintenanceTaskId, MaintenanceRun>>
  records: { items: MaintenanceRun[]; total: number; offset: number; limit: number }
  retentionDays: number
  maxRecords: number
  /** 每日全量强刷（凭证维护那一组下面的开关与时刻）；旧网关没有这个字段。 */
  dailySweep?: { enabled: boolean; at: string }
}
export type MaintenanceApi = {
  overview(query: MaintenanceQuery): Promise<MaintenanceOverview>
  detail(id: string): Promise<MaintenanceDetail>
  run(taskId: MaintenanceTaskId): Promise<MaintenanceDetail>
  retry(id: string, itemId?: string): Promise<MaintenanceDetail>
  save(taskId: MaintenanceTaskId, patch: { enabled: boolean; interval: number }): Promise<MaintenanceTask>
  /** 保存每日全量强刷（可选：没有这个能力的调用方不传）。 */
  saveDailySweep?(patch: { enabled: boolean; at: string }): Promise<{ enabled: boolean; at: string } | undefined>
  /** 立刻执行一次全量强刷（不等每日时刻）；服务端异步起，立刻返回 started。 */
  runDailySweep?(): Promise<{ started?: boolean } | undefined>
}

export const MAINTENANCE_TASKS: readonly MaintenanceTaskId[] = ['credentialMaintenance', 'modelRefresh']
