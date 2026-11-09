/**
 * 「邀请码」弹窗 —— 按**平台**分组（可折叠），逐号显示状态，每行可单独
 * 「填写」/「查看」/「兑换」。
 *
 * ── 视觉语言与「今日积分」对齐 ────────────────────────────────
 * 平台行：左色条 + 浅灰底 + 加粗；账号行：白底 + 细线分隔 + 缩进。
 * 两个弹窗是同一层的汇总面板，样式必须一致，否则切来切去像两套东西。
 *
 * ── 为什么按平台分组 ──────────────────────────────────────────
 * 「邀请码」是厂商各自的能力（Loomy 走 `points/activation` +
 * `invitation-codes` + `redemption-codes/redeem`，WorkBuddy 将来是另一套），
 * 不同平台的码互不通用。分组后：能填的平台才出现、每组的计数各算各的，
 * 将来加一家只需在 `providerFeatures` 里补 `inviteCode: true`。
 *
 * ── 三个层级的操作 ────────────────────────────────────────────
 *   平台头部  点击折叠 / 展开这一组
 *   顶部批量  [填写邀请码] + [填给未填的 N 个号]：一次打多个，只打还没填过的
 *   每行按钮  [填写] 行内展开输入框，只给这一个号绑码
 *             [查看] 行内列出这个号**自己的**邀请码与使用次数（`0/20` 这种）
 *             [兑换] 行内展开输入框，兑一个兑换码
 *
 * ── 一个容易搞错的点：没绑过码的号**也有**自己的邀请码 ──────────
 * 实测：`00687`（`activated: false`）的 `invitation-codes` 照样返回
 * `[{ inviteCode: "4T6AS2", usedCount: 0, maxUses: 20 }]`。所以「查看」为空
 * 只可能是上游没给 / 请求失败，不是「还没绑定所以没有」。
 */

import * as React from 'react'
import {
  Badge, Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input,
} from '@ui'
import { t } from '../i18n'
import { panelRequest } from './panel-request'
import { allAccounts } from './accounts-store'
import { displayNameOf, providerOf, supportsInviteCode } from './accounts-domain'
import { shared, toast } from './accounts-shared'

/** 这个号**自己产出的**一个邀请码 */
type OwnCode = {
  code: string
  used: number
  max: number
  status: string
}

/** 一个号的邀请码状态 */
type InviteRow = {
  id: string
  name: string
  provider: string
  state: 'loading' | 'ready' | 'error'
  activated: boolean
  code: string
  ownCodes: OwnCode[]
  error: string
  busy: boolean
}

/** provider 的中文名（插件申报的注册名；拿不到退回 id） */
function providerLabelOf(provider: string): string {
  const label = shared().wbProviders?.labelOf?.(provider)
  return (typeof label === 'string' && label.trim()) || provider || t('未标注平台')
}

/** 从网关响应里抽出「能不能填 / 填了什么 / 我的码用了几次」 */
function readStatus(payload: unknown): { activated: boolean; code: string; ownCodes: OwnCode[] } {
  const data = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const activated = data.activated === true
  const code = typeof data.appliedInvitationCode === 'string' ? data.appliedInvitationCode : ''
  const raw = Array.isArray(data.invitationCodes) ? data.invitationCodes : []
  const ownCodes: OwnCode[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const value = typeof entry.inviteCode === 'string' ? entry.inviteCode : ''
    if (!value) continue
    ownCodes.push({
      code: value,
      used: Number(entry.usedCount) || 0,
      max: Number(entry.maxUses) || 0,
      status: typeof entry.status === 'string' ? entry.status : '',
    })
  }
  return { activated, code, ownCodes }
}

export function InviteCodeDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): React.ReactElement {
  const [rows, setRows] = React.useState<InviteRow[]>([])
  const [loading, setLoading] = React.useState(false)
  const [batchBusy, setBatchBusy] = React.useState(false)
  const [notice, setNotice] = React.useState('')
  const [collapsed, setCollapsed] = React.useState<string[]>([])
  /** 展开了「批量填写」的平台（平台级，不是全局） */
  const [batchOpen, setBatchOpen] = React.useState<string[]>([])
  /** 每个平台各自的批量输入框草稿 */
  const [batchDraft, setBatchDraft] = React.useState<Record<string, string>>({})
  const [inline, setInline] = React.useState<Record<string, 'fill' | 'view' | 'redeem' | ''>>({})
  const [inlineDraft, setInlineDraft] = React.useState<Record<string, string>>({})

  const platforms = React.useMemo(() => {
    const grouped = new Map<string, InviteRow[]>()
    for (const row of rows) {
      const list = grouped.get(row.provider) || []
      list.push(row)
      grouped.set(row.provider, list)
    }
    return [...grouped.entries()].map(([provider, list]) => ({
      provider,
      label: providerLabelOf(provider),
      rows: list,
      filled: list.filter(item => item.state === 'ready' && item.activated).length,
    }))
  }, [rows])

  const pendingRows = rows.filter(row => row.state === 'ready' && !row.activated)
  const filledCount = rows.filter(row => row.state === 'ready' && row.activated).length

  const refresh = React.useCallback(async () => {
    const targets = allAccounts().filter(account => supportsInviteCode(account))
    const seeded: InviteRow[] = targets.map(account => ({
      id: account.id,
      name: displayNameOf(account),
      provider: providerOf(account) || '',
      state: 'loading',
      activated: false,
      code: '',
      ownCodes: [],
      error: '',
      busy: false,
    }))
    setRows(seeded)
    setInline({})
    setInlineDraft({})
    if (!seeded.length) return
    setLoading(true)
    setNotice('')
    try {
      for (const row of seeded) {
        try {
          const payload = await panelRequest('GET', `/api/accounts/${encodeURIComponent(row.id)}/invite-code`)
          const status = readStatus(payload)
          setRows(current => current.map(item => (item.id === row.id
            ? { ...item, state: 'ready', activated: status.activated, code: status.code, ownCodes: status.ownCodes }
            : item)))
        } catch (error) {
          const message = String((error as Error)?.message || error)
          setRows(current => current.map(item => (item.id === row.id
            ? { ...item, state: 'error', error: message }
            : item)))
        }
      }
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (!open) return
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /**
   * 给单个号提交邀请码。
   *
   * `quiet`：批量调过来时置 true —— 一次打十个号就弹十条 toast 会糊满屏幕，
   * 批量自己用顶部那行 `notice` 汇总（「成功 N 个，失败 M 个」）。
   */
  const submitOne = React.useCallback(async (id: string, code: string, quiet = false) => {
    const trimmed = code.trim()
    if (!trimmed) return false
    setRows(current => current.map(item => (item.id === id ? { ...item, busy: true, error: '' } : item)))
    try {
      const payload = await panelRequest('POST', `/api/accounts/${encodeURIComponent(id)}/invite-code`, { code: trimmed })
      const status = readStatus(payload)
      setRows(current => current.map(item => (item.id === id
        ? { ...item, busy: false, state: 'ready', activated: status.activated, code: status.code || trimmed, ownCodes: status.ownCodes.length ? status.ownCodes : item.ownCodes }
        : item)))
      if (!quiet) {
        const who = rows.find(item => item.id === id)?.name || ''
        toast(t('{account} 已填邀请码 {code}', { account: who, code: trimmed }), 'ok')
      }
      return true
    } catch (error) {
      const message = String((error as Error)?.message || error)
      setRows(current => current.map(item => (item.id === id ? { ...item, busy: false, error: message } : item)))
      if (!quiet) toast(t('填写失败：{message}', { message }), 'err')
      return false
    }
  }, [rows])

  /**
   * 给单个号兑换兑换码。
   *
   * 兑换的响应结构与激活接口不同族（上游只回兑换结果），所以这里**只更新
   * 能确定的部分**：`activated` / `invitationCodes` 若上游没给就保留原值，
   * 避免把「已经填过的码」显示成「未填」。
   *
   * 成功/失败都会弹 toast —— 兑换是「一次性、不可撤回」的动作，用户必须
   * 立刻知道成没成，不能只靠行内那行小字。
   */
  const submitRedeem = React.useCallback(async (id: string, code: string) => {
    const trimmed = code.trim()
    if (!trimmed) return false
    const who = rows.find(item => item.id === id)?.name || ''
    setRows(current => current.map(item => (item.id === id ? { ...item, busy: true, error: '' } : item)))
    try {
      const payload = await panelRequest('POST', `/api/accounts/${encodeURIComponent(id)}/redeem-code`, { code: trimmed })
      const status = readStatus(payload)
      setRows(current => current.map(item => (item.id === id
        ? {
            ...item,
            busy: false,
            state: 'ready',
            activated: status.activated || item.activated,
            code: status.code || item.code,
            ownCodes: status.ownCodes.length ? status.ownCodes : item.ownCodes,
          }
        : item)))
      // 上游若回了积分/奖励数额就带上，没给就只说「成功」
      const data = (payload && typeof payload === 'object' ? (payload as Record<string, unknown>).data : null) as Record<string, unknown> | null
      const reward = Number(
        (data?.reward ?? data?.points ?? data?.amount ?? data?.grantedPoints ?? 0) as number,
      ) || 0
      toast(reward > 0
        ? t('{account} 兑换成功，获得 {n} 积分', { account: who, n: reward })
        : t('{account} 兑换成功', { account: who }), 'ok')
      return true
    } catch (error) {
      const message = String((error as Error)?.message || error)
      setRows(current => current.map(item => (item.id === id ? { ...item, busy: false, error: message } : item)))
      toast(t('兑换失败：{message}', { message }), 'err')
      return false
    }
  }, [rows])

  /**
   * 平台级批量：只打**这个平台**里还没填过的号。
   *
   * 之所以按平台而不是全局：不同平台的邀请码互不通用，一个码只能填给同一家的号。
   * 全局批量会让用户误以为能把 Loomy 的码填给 WorkBuddy。
   */
  const submitPlatform = React.useCallback(async (provider: string) => {
    const code = (batchDraft[provider] || '').trim()
    if (!code) {
      setNotice(t('请先填写邀请码'))
      return
    }
    const targets = rows
      .filter(row => row.provider === provider && row.state === 'ready' && !row.activated)
      .map(row => row.id)
    if (!targets.length) {
      setNotice(t('这个平台没有待填写的账号'))
      return
    }
    setBatchBusy(true)
    setNotice('')
    let ok = 0
    let failed = 0
    try {
      for (const id of targets) {
        const done = await submitOne(id, code, true)
        if (done) ok += 1
        else failed += 1
      }
      setNotice(failed
        ? t('完成：成功 {ok} 个，失败 {failed} 个', { ok, failed })
        : t('完成：成功 {ok} 个', { ok }))
    } finally {
      setBatchBusy(false)
    }
  }, [batchDraft, rows, submitOne])

  const togglePlatform = (provider: string) => {
    setCollapsed(list => (list.includes(provider) ? list.filter(item => item !== provider) : [...list, provider]))
  }
  const toggleInline = (id: string, mode: 'fill' | 'view' | 'redeem') => {
    setInline(current => ({ ...current, [id]: current[id] === mode ? '' : mode }))
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent overlayForceRender className='w-[min(820px,calc(100vw-48px))]'>
        <DialogHeader>
          <DialogTitle>{t('邀请码')}</DialogTitle>
        </DialogHeader>

        <DialogBody>
          {/* 顶部只留总览 + 重新查询（批量入口在各自平台行上） */}
          <div className='flex flex-wrap items-center gap-2'>
            <span className='text-xs text-subtle'>
              {t('共 {total} 个号 · 已填 {filled} 个', { total: rows.length, filled: filledCount })}
            </span>
            <Button variant='outline' className='ml-auto' disabled={loading || batchBusy}
              onClick={() => void refresh()}>
              {loading ? t('查询中…') : t('重新查询')}
            </Button>
          </div>

          {notice ? <p className='mt-2 text-xs text-subtle'>{notice}</p> : null}

          {rows.length === 0 && !loading ? (
            <p className='mt-4 text-sm text-subtle'>
              {t('当前没有支持邀请码的账号。这一项按平台能力显示 —— 目前只有 Loomy 支持。')}
            </p>
          ) : null}

          {/* 按平台分组（样式对齐「今日积分」） */}
          {platforms.length > 0 ? (
            <div className='mt-4 max-h-[52vh] divide-y divide-border/50 overflow-y-auto overscroll-contain pr-1'>
              {platforms.map(platform => {
                const isCollapsed = collapsed.includes(platform.provider)
                return (
                  <div key={platform.provider}>
                    {/* 平台行：左色条 + 浅底 + 加粗；右侧是**这个平台**的批量入口。
                        整行不能是 button（里面还要放按钮），所以拆成「折叠触发区 + 统计 + 批量」 */}
                    <div className={`flex w-full items-center gap-3 border-l-2 border-l-primary/70 px-2 py-2 text-[13.5px] ${isCollapsed ? 'bg-muted/60' : 'bg-muted'}`}>
                      <button type='button'
                        onClick={() => togglePlatform(platform.provider)}
                        aria-expanded={!isCollapsed}
                        className='flex min-w-0 flex-1 items-center gap-3 border-0 bg-transparent text-left font-semibold outline-none'>
                        <span className='w-3 shrink-0 text-subtle'>{isCollapsed ? '▸' : '▾'}</span>
                        <span className='min-w-0 flex-1 truncate'>{platform.label}</span>
                        <span className='shrink-0 text-xs font-normal text-subtle tabular-nums'>
                          {t('{total} 个号 · 已填 {filled} 个', { total: platform.rows.length, filled: platform.filled })}
                        </span>
                      </button>
                      <Button size='sm' variant='outline' disabled={loading || batchBusy}
                        className='shrink-0'
                        onClick={() => setBatchOpen(list => (list.includes(platform.provider)
                          ? list.filter(item => item !== platform.provider)
                          : [...list, platform.provider]))}>
                        {t('批量填写')}
                      </Button>
                    </div>

                    {/* 平台级批量输入：只影响这一家 */}
                    {batchOpen.includes(platform.provider) ? (
                      <div className='flex items-center gap-2 border-t border-border/40 bg-muted/30 px-2 py-2 pl-8'>
                        <Input className='w-[180px]' placeholder={t('这一家的邀请码')}
                          value={batchDraft[platform.provider] || ''}
                          onChange={(event) => setBatchDraft(current => ({ ...current, [platform.provider]: event.target.value }))} />
                        <Button size='sm' disabled={batchBusy || !(batchDraft[platform.provider] || '').trim()
                          || platform.rows.filter(row => row.state === 'ready' && !row.activated).length === 0}
                          onClick={() => void submitPlatform(platform.provider)}>
                          {batchBusy
                            ? t('提交中…')
                            : t('填给未填的 {n} 个号', { n: platform.rows.filter(row => row.state === 'ready' && !row.activated).length })}
                        </Button>
                      </div>
                    ) : null}

                    {isCollapsed ? null : (
                      <div className='divide-y divide-border/40'>
                        {platform.rows.map(row => {
                          const mode = inline[row.id] || ''
                          return (
                            <div key={row.id}>
                              {/* 账号行：缩进 + hover，与今日积分的账号行同一套 */}
                              <div className={`flex items-center gap-3 py-1.5 pl-8 pr-2 text-[12.5px] ${mode ? 'bg-muted/40' : 'hover:bg-muted/30'}`}>
                                <span className='w-3 shrink-0' aria-hidden />
                                <span className='min-w-0 flex-1 truncate' title={row.name}>{row.name}</span>

                                <span className='flex min-w-0 flex-1 items-center justify-end gap-2 truncate text-[11.5px]'>
                                  {row.state === 'loading' ? (
                                    <span className='text-subtle'>{t('查询中…')}</span>
                                  ) : row.state === 'error' ? (
                                    <span className='truncate text-destructive' title={row.error}>{row.error}</span>
                                  ) : row.activated ? (
                                    <>
                                      <Badge variant='success'>{t('已填')}</Badge>
                                      <span className='font-mono text-subtle'>{row.code || '—'}</span>
                                    </>
                                  ) : (
                                    <Badge variant='outline'>{t('未填')}</Badge>
                                  )}
                                </span>

                                <span className='flex shrink-0 items-center gap-1'>
                                  <Button size='sm' variant='ghost' disabled={row.busy}
                                    onClick={() => toggleInline(row.id, 'fill')}>{t('填写')}</Button>
                                  <Button size='sm' variant='ghost' disabled={row.busy}
                                    onClick={() => toggleInline(row.id, 'view')}>{t('查看')}</Button>
                                  <Button size='sm' variant='ghost' disabled={row.busy}
                                    onClick={() => toggleInline(row.id, 'redeem')}>{t('兑换')}</Button>
                                </span>
                              </div>

                              {/*
                                提交失败：**独立一行**，不挤在状态格里。
                                原先只在 `state === 'error'` 时显示 row.error，而填写/兑换
                                失败时 state 仍是 'ready'（账号本身是好的，只是这次动作失败），
                                于是错误被静默吞掉 —— 上游 0.2 秒就回了「请求参数错误」，
                                界面上却什么都没有。
                              */}
                              {row.error ? (
                                <div className='px-3 pb-1 pl-12 text-[11.5px] leading-relaxed text-destructive'
                                  title={row.error}>
                                  {row.error}
                                </div>
                              ) : null}

                              {/* 行内：填写邀请码 */}
                              {mode === 'fill' ? (
                                <div className='flex items-center gap-2 pb-2 pl-12 pr-2'>
                                  <Input className='w-[170px]' placeholder={t('邀请码')}
                                    value={inlineDraft[row.id] || ''}
                                    onChange={(event) => setInlineDraft(current => ({ ...current, [row.id]: event.target.value }))} />
                                  <Button size='sm' disabled={row.busy || !(inlineDraft[row.id] || '').trim()}
                                    onClick={async () => {
                                      const done = await submitOne(row.id, inlineDraft[row.id] || '')
                                      if (done) {
                                        setInlineDraft(current => ({ ...current, [row.id]: '' }))
                                        setInline(current => ({ ...current, [row.id]: '' }))
                                      }
                                    }}>
                                    {row.busy ? t('提交中…') : t('提交')}
                                  </Button>
                                </div>
                              ) : null}

                              {/* 行内：兑换码 */}
                              {mode === 'redeem' ? (
                                <div className='flex items-center gap-2 pb-2 pl-12 pr-2'>
                                  <Input className='w-[220px]' placeholder={t('兑换码')}
                                    value={inlineDraft[`redeem:${row.id}`] || ''}
                                    onChange={(event) => setInlineDraft(current => ({ ...current, [`redeem:${row.id}`]: event.target.value }))} />
                                  <Button size='sm' disabled={row.busy || !(inlineDraft[`redeem:${row.id}`] || '').trim()}
                                    onClick={async () => {
                                      const done = await submitRedeem(row.id, inlineDraft[`redeem:${row.id}`] || '')
                                      if (done) setInlineDraft(current => ({ ...current, [`redeem:${row.id}`]: '' }))
                                    }}>
                                    {row.busy ? t('提交中…') : t('兑换')}
                                  </Button>
                                </div>
                              ) : null}

                              {/* 行内：查看自己产出的码（没绑过码的号也有） */}
                              {mode === 'view' ? (
                                <div className='pb-2 pl-12 pr-2 text-[12px]'>
                                  {row.ownCodes.length === 0 ? (
                                    <span className='text-subtle'>
                                      {row.state === 'error'
                                        ? t('查询失败，先点「重新查询」再试')
                                        : t('上游没有返回邀请码')}
                                    </span>
                                  ) : (
                                    <div className='space-y-0.5'>
                                      {row.ownCodes.map(item => (
                                        <div key={item.code} className='flex items-center gap-3'>
                                          <span className='font-mono'>{item.code}</span>
                                          <span className='tabular-nums text-subtle'>{item.used}/{item.max}</span>
                                          <span className={item.status === 'active' ? 'text-emerald-600' : 'text-subtle'}>
                                            {item.status === 'active' ? t('可用') : t('已用尽')}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              ) : null}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ) : null}

          <p className='mt-3 text-[11.5px] leading-relaxed text-subtle'>
            {t('「已填」是上游返回的状态，重复提交不会再加分。每个号（无论有没有填过别人的码）都有自己的邀请码，可以邀别的号；次数用完会显示「已用尽」。')}
          </p>
        </DialogBody>

        <DialogFooter>
          <Button variant='outline' onClick={onClose}>{t('关闭')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
