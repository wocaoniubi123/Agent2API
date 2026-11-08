/**
 * 「今日积分获得」汇总弹窗 —— 按**平台 → 账号**两级展开。
 *
 * ── 它回答什么问题 ─────────────────────────────────────────────
 * 「今天有没有拿到积分、哪家平台拿了多少、那家下面哪些号拿的、通过什么拿的」。
 *
 * 之前这件事只能在单个账号的「积分明细」弹层里逐份翻：那些 `credits[]` 行会写
 * 「11-07 10:32 领取 · 成长计划奖励」，但要看「今天一共拿了多少」得自己一份份加。
 * 而排程/成长任务那几处的 `lastResult` 只留最近一趟，被一趟全 skip 覆盖后就看不出
 * 今天其实领过分（2026-11 排查猫猫旅行那次就是这么被误导的）。
 *
 * ── 数据从哪来 ────────────────────────────────────────────────
 * `core::usage_query` 的定时余额查询结果快照（`GET /api/accounts/usage/snapshot`）
 * 已经在前端缓存里：`syncBalancesSnapshot()` 把它写进 `accounts-usage-cache`，
 * 这里用 `usageEntryOf(account)` 逐账号读，再从 `credits[]` 里筛今天的发放。
 *
 * 所以本组件**不新增后端接口**：打开时主动同步一次快照，之后就只读缓存。
 *
 * ── 口径（与「积分明细」那一列同一套，不许各算各的）──────────────
 *   ① 今天按**北京时间**日期判（`beijingDay`，与签到、连登同一份实现）
 *   ② 只认 `grantAt`（上游的发放时刻）；只有 `startAt`（生效时刻）的包不计入
 *   ③ 钱包快照（`snapshot`）与流水（`record`）不算发放，跳过
 *   ④ 金额取 `total`（面额），不取 `remain`：问的是「拿到多少」，不是「还剩多少」
 *   ⑤ 没有 `grantAt` 的包一律不计入
 *   ⑥ 只统计余额里有 `credits[]` 的家（WorkBuddy 两版、Trae、OfficeAce、
 *      AutoClaw 两版、Qoder 两版、小浣熊）；其余家没有这个数组，自然不出现
 */

import * as React from 'react'
import {
  Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@ui'
import { t } from '../i18n'
import { formatTime, numberText, shared } from './accounts-shared'
import { allAccounts } from './accounts-store'
import { beijingDay, displayNameOf, providerOf } from './accounts-domain'
import { syncBalancesSnapshot, usageEntryOf, usageUpdatedAtOf } from './accounts-usage'
import { creditPacksOf } from '../../../ui-shared/usage-readings'

/** 今日的一笔发放 */
type GainRow = {
  accountId: string
  accountName: string
  provider: string
  /** 发放来源：上游的 `grantReason`，缺了退回积分包名称，再缺就是「未标注来源」 */
  reason: string
  /** 面额（`total`） */
  amount: number
  /** 发放时刻（`grantAt`，毫秒） */
  at: number
}

/** 一个平台下的一个账号 */
type AccountGain = {
  id: string
  name: string
  amount: number
  count: number
  /** 出现过的来源（去重、保持首次出现顺序） */
  reasons: string[]
  /** 该账号的逐笔（时间倒序） */
  rows: GainRow[]
}

/** 一个平台 */
type PlatformGain = {
  provider: string
  label: string
  amount: number
  count: number
  accounts: AccountGain[]
}

/** `HH:mm`（明细列只到分钟，与积分明细弹层同款） */
function clockText(at: number): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** provider 的中文名（插件申报的注册名；拿不到就退回 id） */
function providerLabelOf(provider: string): string {
  const label = shared().wbProviders?.labelOf?.(provider)
  return (typeof label === 'string' && label.trim()) || provider || t('未标注平台')
}

/**
 * 扫一遍余额缓存，取出「今天发放」的行。
 *
 * 纯函数（除了读全局缓存）：不写状态、不发请求 —— 刷新与否由调用方决定。
 */
export function todayGainRows(now = Date.now()): GainRow[] {
  const today = beijingDay(now)
  const rows: GainRow[] = []
  for (const account of allAccounts()) {
    const entry = usageEntryOf(account)
    if (!entry) continue
    const name = displayNameOf(account)
    const provider = providerOf(account) || ''
    for (const pack of creditPacksOf(entry)) {
      // ② ③ 钱包快照 / 流水不是发放
      if (pack.snapshot === true || pack.record === true) continue
      const grantAt = Number(pack.grantAt)
      if (!Number.isFinite(grantAt) || grantAt <= 0) continue
      // ① 今天按北京时间判
      if (beijingDay(grantAt) !== today) continue
      const total = Number(pack.total)
      const packName = String(pack.name || '').trim()
      const reason = String(pack.grantReason || '').trim() || packName || t('未标注来源')
      rows.push({
        accountId: account.id,
        accountName: name,
        provider,
        reason,
        amount: Number.isFinite(total) && total > 0 ? total : 0,
        at: grantAt,
      })
    }
  }
  return rows.sort((a, b) => b.at - a.at)
}

/** 行 → 平台桶（平台按金额降序；平台内账号也按金额降序） */
export function platformsOf(rows: GainRow[]): PlatformGain[] {
  const platforms = new Map<string, PlatformGain>()
  /**
   * 账号索引：`platform + accountId → AccountGain`。
   *
   * 原来在 `platform.accounts` 上做 `find`，是 O(行数 × 账号数)：今天 70 笔 × 39 个
   * 账号看着不多，但这份函数每次展开/收起都会重算一次，累起来就拖交互 ——
   * 一张 Map 直接降到 O(行数)。
   */
  const accountIndex = new Map<string, AccountGain>()
  for (const row of rows) {
    const provider = row.provider
    let platform = platforms.get(provider)
    if (!platform) {
      platform = { provider, label: providerLabelOf(provider), amount: 0, count: 0, accounts: [] }
      platforms.set(provider, platform)
    }
    platform.amount += row.amount
    platform.count += 1
    const key = `${provider}\u0000${row.accountId}`
    let account = accountIndex.get(key)
    if (!account) {
      account = { id: row.accountId, name: row.accountName, amount: 0, count: 0, reasons: [], rows: [] }
      accountIndex.set(key, account)
      platform.accounts.push(account)
    }
    account.amount += row.amount
    account.count += 1
    account.rows.push(row)
    if (!account.reasons.includes(row.reason)) account.reasons.push(row.reason)
  }
  const list = [...platforms.values()]
  for (const platform of list) {
    platform.accounts.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name))
  }
  return list.sort((a, b) => b.amount - a.amount)
}

/** 平台行左侧色条：按 provider 名字取一个稳定颜色（同名永远同色） */
const PLATFORM_TONES = [
  'bg-sky-500',
  'bg-violet-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-teal-500',
  'bg-indigo-500',
  'bg-orange-500',
  'bg-cyan-500',
]

function toneOf(provider: string): string {
  let hash = 0
  for (let i = 0; i < provider.length; i += 1) hash = (hash * 31 + provider.charCodeAt(i)) % 9973
  return PLATFORM_TONES[hash % PLATFORM_TONES.length]
}

/**
 * 金额：纯文字 + 三档深浅，不加底色。
 *
 * 之前给它套了 chip 底色，39 行铺下来满屏绿色块，反而更花。现在只保留
 * 「同色不同权重」：500+ 加粗、100+ 正常、其余淡一档 —— 扫一眼能分出大小，
 * 但视觉重量跟旁边的文字是同一层的。
 */
function amountClass(small?: boolean): string {
  // 统一一个绿：三档深浅虽然能突出重点，但满屏都是带色文字反而更花；
  // 大小只靠字号与平台行的加粗区分就够（顺带少几次字符串拼接）
  return `${small ? 'text-[11.5px]' : 'text-[12.5px]'} text-emerald-600 dark:text-emerald-400`
}

/**
 * 一个账号行。
 *
 * 单独 memo 化：今天 WorkBuddy 有 33 个号，展开后每次点任意一行都会让父组件重跑，
 * 33 个 button 全量重渲染就是「点一下卡一下」的来源。props 都是稳定的
 * （`account` 引用来自 useMemo 的分组结果、`onToggle` 用 useCallback 固定），
 * memo 之后只有被点的那一行真正重渲染。
 */
const AccountRow = React.memo(function AccountRow({
  account,
  open,
  onToggle,
}: {
  account: AccountGain
  open: boolean
  onToggle: (id: string) => void
}) {
  return (
    <div>
      <button
        type='button'
        onClick={() => onToggle(account.id)}
        aria-expanded={open}
        className={`flex w-full items-center gap-3 border-0 bg-transparent py-1.5 pl-8 pr-2 text-left text-[12.5px] outline-none ${open ? 'bg-muted/40' : 'hover:bg-muted/30'}`}
      >
        <span className='w-3 shrink-0 text-subtle'>{open ? '▾' : '▸'}</span>
        <span className='min-w-0 flex-1 truncate' title={account.name}>{account.name}</span>
        <span className='min-w-0 flex-1 truncate text-right text-[11.5px] text-subtle'>
          {account.reasons.slice(0, 3).join(' · ')}
          {account.count > account.reasons.length ? ` · ${t('共 {n} 笔', { n: account.count })}` : ''}
        </span>
        <RowAmount value={account.amount} />
      </button>
      {open ? (
        <div className='pb-1 pl-14 pr-2'>
          {account.rows.map((row, index) => (
            <div
              key={`${row.at}-${index}`}
              className='flex items-center gap-3 py-1 text-[11.5px]'
              title={formatTime(row.at)}
            >
              <span className='w-12 shrink-0 tabular-nums text-subtle'>{clockText(row.at)}</span>
              <span className='min-w-0 flex-1 truncate text-subtle'>{row.reason}</span>
              <RowAmount value={row.amount} small />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
})

/** 平台行右侧的读数（比账号行大一号） */
function PlatformAmount({ value }: { value: number }) {
  return (
    <span className='shrink-0 text-[14px] font-semibold tabular-nums text-emerald-600 dark:text-emerald-400'>
      {value > 0 ? `+${numberText(value)}` : '0'}
    </span>
  )
}

/** 账号 / 逐笔行的读数 */
function RowAmount({ value, small }: { value: number; small?: boolean }) {
  return (
    <span className={`shrink-0 tabular-nums ${amountClass(small)}`}>
      {value > 0 ? `+${numberText(value)}` : '0'}
    </span>
  )
}

function SectionTitle({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div className='mb-1.5 mt-4 flex items-baseline gap-2 text-[12px] font-medium text-subtle'>
      <span>{children}</span>
      {typeof count === 'number' ? <span className='tabular-nums'>{t('{count} 项', { count })}</span> : null}
    </div>
  )
}

/**
 * 今日积分获得弹窗。
 *
 * 打开时先 `syncBalancesSnapshot()` 拉一次最新快照（33 个号约 5–8 秒），
 * 但**不阻塞渲染**：缓存里已有的先显示，同步完再改一次状态。
 */
export function TodayGainDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): React.ReactElement {
  const [rows, setRows] = React.useState<GainRow[]>([])
  const [syncing, setSyncing] = React.useState(false)
  const [failed, setFailed] = React.useState('')
  const [stamp, setStamp] = React.useState(0)
  /** 展开的平台（默认全收起：一屏先看清「哪家拿了多少」） */
  const [openPlatforms, setOpenPlatforms] = React.useState<string[]>([])
  /** 二次展开：某平台里已展开逐笔的账号 */
  const [openAccounts, setOpenAccounts] = React.useState<string[]>([])

  const recompute = React.useCallback(() => {
    setRows(todayGainRows())
    setStamp(Date.now())
  }, [])

  const refresh = React.useCallback(async () => {
    setSyncing(true)
    setFailed('')
    try {
      await syncBalancesSnapshot()
      recompute()
    } catch (error) {
      setFailed(String((error as Error)?.message || error))
      recompute()
    } finally {
      setSyncing(false)
    }
  }, [recompute])

  React.useEffect(() => {
    if (!open) return
    recompute()
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const platforms = React.useMemo(() => platformsOf(rows), [rows])
  const total = platforms.reduce((sum, platform) => sum + platform.amount, 0)
  const accountCount = platforms.reduce((sum, platform) => sum + platform.accounts.length, 0)
  const togglePlatform = (provider: string) => {
    setOpenPlatforms(list => (list.includes(provider) ? list.filter(item => item !== provider) : [...list, provider]))
  }
  const toggleAccount = React.useCallback((id: string) => {
    setOpenAccounts(list => (list.includes(id) ? list.filter(item => item !== id) : [...list, id]))
  }, [])

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent overlayForceRender className='w-[min(760px,calc(100vw-48px))]'>
        <DialogHeader>
          <DialogTitle>{t('今日积分获得')}</DialogTitle>
        </DialogHeader>

        <DialogBody>
          {/* ── 总览 ───────────────────────────────────────── */}
          <div className='flex flex-wrap items-baseline gap-x-4 gap-y-1'>
            <span className='text-lg font-semibold tabular-nums'>
              {total > 0 ? `+${numberText(total)}` : '0'} <span className='text-sm font-normal text-subtle'>{t('分')}</span>
            </span>
            <span className='text-xs text-subtle'>
              {t('{count} 笔 · {accounts} 个账号 · {platforms} 个平台', {
                count: rows.length,
                accounts: accountCount,
                platforms: platforms.length,
              })}
            </span>
            <span className='ml-auto text-xs text-subtle'>
              {stamp ? t('统计于 {time}', { time: clockText(stamp) }) : ''}
            </span>
          </div>

          {failed ? (
            <p className='mt-2 rounded-md bg-muted px-2 py-1 text-xs text-destructive'>
              {t('同步余额失败：{message}（下面是缓存里的数据）', { message: failed })}
            </p>
          ) : null}

          {rows.length === 0 && !syncing ? (
            <p className='mt-4 text-sm text-subtle'>
              {t('今天还没有发放记录。上游发积分集中在早间与活动时段；余额快照最多滞后 10 分钟。')}
            </p>
          ) : null}

          {/* ── 按平台 → 按账号 ─────────────────────────────── */}
          {platforms.length > 0 ? (
            <>
              <SectionTitle count={platforms.length}>{t('按平台')}</SectionTitle>
              {/* 固定高度的滚动容器：33 个账号铺开会把弹窗撑到视口外，
                  滚动时整页重排就是「卡」的来源（第一版有这个约束，第二版删掉了） */}
              <div className='max-h-[52vh] divide-y divide-border/50 overflow-y-auto overscroll-contain pr-1'>
                {platforms.map(platform => {
                  const expanded = openPlatforms.includes(platform.provider)
                  return (
                    <div key={platform.provider || '(unknown)'}>
                      <button
                        type='button'
                        onClick={() => togglePlatform(platform.provider)}
                        aria-expanded={expanded}
                        className={`flex w-full items-center gap-3 border-0 border-l-2 border-l-primary/70 px-2 py-2.5 text-left text-[13.5px] font-semibold outline-none ${expanded ? 'bg-muted' : 'bg-muted/60 hover:bg-muted'}`}
                      >
                        <span className='w-3 shrink-0 text-subtle'>{expanded ? '▾' : '▸'}</span>
                        <span className='min-w-0 flex-1 truncate font-semibold'>{platform.label}</span>
                        <span className='shrink-0 text-xs text-subtle tabular-nums'>
                          {t('{accounts} 个账号 · {count} 笔', { accounts: platform.accounts.length, count: platform.count })}
                        </span>
                        <PlatformAmount value={platform.amount} />
                      </button>

                      {expanded ? (
                        <div className='divide-y divide-border/40'>
                          {platform.accounts.map(account => (
                            <AccountRow
                              key={account.id}
                              account={account}
                              open={openAccounts.includes(account.id)}
                              onToggle={toggleAccount}
                            />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </>
          ) : null}


        </DialogBody>

        <DialogFooter>
          <span className='mr-auto text-[11.5px] text-subtle'>
            {syncing
              ? t('正在同步余额快照…')
              : (() => {
                const at = allAccounts()
                  .map(account => usageUpdatedAtOf(account))
                  .reduce((max, value) => (value > max ? value : max), 0)
                return at ? t('余额数据更新于 {time}', { time: formatTime(at) }) : t('还没有查询过余额')
              })()}
          </span>
          <Button variant='outline' onClick={onClose}>{t('关闭')}</Button>
          <Button disabled={syncing} onClick={() => void refresh()}>
            {syncing ? t('同步中…') : t('重新查询')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}