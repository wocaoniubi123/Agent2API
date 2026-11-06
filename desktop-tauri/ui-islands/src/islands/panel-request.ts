import { t } from '../i18n'

/**
 * 管理 API 的**双路**请求。
 *
 * ── 为什么不能只用一种 ────────────────────────────────────────
 * - 桌面壳里相对路径的 `fetch('/api/...')` 拿不到 JSON：引擎会返回 HTML 兜底页，
 *   于是 `JSON.parse` 抛 `Unexpected token '<'`（保存并发数时就踩过这个）。
 * - 而桌桥（`__TAURI_INTERNALS__.invoke('api_request')`）只在桌面壳里存在，
 *   网页面板没有它。
 *
 * 所以：有桥走桥，没桥走同源 fetch + 面板 Cookie。两条路都把「success:false」
 * 当失败抛出，调用方只处理正常值。
 */

type PanelWindow = {
  __TAURI_INTERNALS__?: {
    invoke?: (command: string, payload: unknown) => Promise<unknown>
  }
}

/** 解开 `{success, data}` 信封；失败一律抛。 */
function unwrap(payload: unknown, ok: boolean, status: number): unknown {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  if (!ok || record.success === false) {
    const message = record.error ?? record.message ?? `HTTP ${status}`
    throw new Error(String(message))
  }
  return Object.hasOwn(record, 'data') ? record.data : record
}

export async function panelRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const internals = (window as unknown as PanelWindow).__TAURI_INTERNALS__
  if (internals && typeof internals.invoke === 'function') {
    const result = await internals.invoke('api_request', {
      request: { method, path, body: body === undefined ? null : body },
    })
    // 桥已经把 HTTP 状态压成 `{success, data}` 信封，这里只判 success
    return unwrap(result, true, 200)
  }

  const response = await fetch(path, {
    method,
    credentials: 'include',
    cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let payload: unknown = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      // 走到这里说明拿到的不是 JSON（多半是 HTML 兜底页）：把状态码带出去，
      // 别再让调用方对着 `Unexpected token '<'` 猜
      throw new Error(t('服务器返回了非 JSON 响应（HTTP {status}）', { status: String(response.status) }))
    }
  }
  return unwrap(payload, response.ok, response.status)
}

/** 读一个数值型配置项（`{ value: number }`）。 */
export async function readNumberSetting(path: string): Promise<number | undefined> {
  const data = await panelRequest('GET', path) as { value?: unknown } | undefined
  const value = data?.value
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
