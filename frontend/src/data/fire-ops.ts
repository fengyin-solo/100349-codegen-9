/** 火情处置作战域：状态机、火势等级、时间轴与跨模块联动都在这里收口。
 *  纯前端没有后端事务，用「版本号 + 整份数据原子落库」模拟乐观锁，
 *  同一火情被两处入口并发推进时，只有先落库（CAS 成功）的路径生效。 */

import { listRows, nextId, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

export const FIRE_KEY = 'firereport'
export const FIRETEAM_KEY = 'fireteam'
export const DRONE_KEY = 'drone'

/** 待核实 → 已确认 → 已出警 → 已扑灭，只能逐段向前；误报与扑灭为互斥终态。 */
export const FIRE_STATUSES = ['待核实', '已确认', '已出警', '已扑灭', '误报'] as const
/** 扑灭是唯一正向终态；误报是异常终态。冲突时扑灭优先（详见 advanceReport 末尾规则）。 */
export const FIRE_TERMINAL = ['已扑灭', '误报'] as const

export type FireAction = '核实火情' | '出动扑救' | '确认扑灭' | '确认误报'
export type EntryChannel = '作战视图' | '火情报告台账' | string

/** 动作 → 目标状态。两处入口共用同一张流转表，避免规则各写一份。 */
export const FIRE_ACTION_TARGET: Record<FireAction, (typeof FIRE_STATUSES)[number]> = {
  核实火情: '已确认',
  出动扑救: '已出警',
  确认扑灭: '已扑灭',
  确认误报: '误报',
}

/** 允许从哪些状态发起动作。确认误报在出警前后都可能成立，出警后与确认扑灭构成互斥终态竞争。 */
const FIRE_ALLOWED_FROM: Record<FireAction, readonly string[]> = {
  核实火情: ['待核实'],
  出动扑救: ['已确认'],
  确认扑灭: ['已出警'],
  确认误报: ['待核实', '已确认', '已出警'],
}

/** 时间轴四段，按处置发生顺序固定排列。 */
export const TIMELINE_STAGES = [
  { key: 'report', label: '火情报告', status: '待核实' },
  { key: 'verify', label: '巡护核查', status: '已确认' },
  { key: 'dispatch', label: '队伍出警', status: '已出警' },
  { key: 'conclusion', label: '扑灭结论', status: '已扑灭' },
] as const

export type TimelineStageKey = (typeof TIMELINE_STAGES)[number]['key']

/** 火势等级：中文名、数字、I~V、颜色写法都识别，统一换算成 1~5 用于排序。 */
const LEVEL_PATTERNS: { re: RegExp; rank: number }[] = [
  { re: /(?:一|Ⅰ|I)(?![IVX])|(?:等级\s*)?1/, rank: 1 },
  { re: /(?:二|Ⅱ|II)(?![IVX])|(?:等级\s*)?2/, rank: 2 },
  { re: /(?:三|Ⅲ|III)(?![IVX])|(?:等级\s*)?3/, rank: 3 },
  { re: /(?:四|Ⅳ|IV)(?![IVX])|(?:等级\s*)?4/, rank: 4 },
  { re: /(?:五|Ⅴ|V)(?![IVX])|(?:等级\s*)?5/, rank: 5 },
]
const LEVEL_COLOR: [RegExp, number][] = [
  [/蓝/, 1],
  [/黄/, 2],
  [/橙/, 3],
  [/红/, 4],
]
const LEVEL_LABEL = ['', '一级（一般）', '二级（较大）', '三级（重大）', '四级（特大）', '五级（特别重大）']

export function levelRank(text: unknown): number {
  const raw = String(text ?? '').trim()
  if (!raw) return 0
  for (const { re, rank } of LEVEL_PATTERNS) {
    if (re.test(raw)) return rank
  }
  for (const [re, rank] of LEVEL_COLOR) {
    if (re.test(raw)) return rank
  }
  return 0
}

export function levelLabel(text: unknown): string {
  const rank = levelRank(text)
  if (rank <= 0) return String(text ?? '未分级')
  return LEVEL_LABEL[rank]
}

export function isTerminal(status: string): boolean {
  return (FIRE_TERMINAL as readonly string[]).includes(status)
}

/** 该报告当前可执行的动作：终态为空，其余严格按状态机给出，保证不能倒回。 */
export function availableActions(status: string): FireAction[] {
  if (isTerminal(status)) return []
  return (['核实火情', '出动扑救', '确认扑灭', '确认误报'] as FireAction[]).filter((action) =>
    FIRE_ALLOWED_FROM[action].includes(status),
  )
}

/** 时间轴每段的完成时间（取自落库时记录的阶段时间戳，未到达的阶段为空）。 */
export type TimelinePoint = { stage: TimelineStageKey; label: string; at: string; done: boolean; terminal: boolean }

export function buildTimeline(row: EntryRow): TimelinePoint[] {
  const status = String(row.status)
  const reportAt = String(row['起火时间'] ?? '')
  const times = JSON.parse(String(row['阶段时间'] ?? '{}')) as Partial<Record<TimelineStageKey, string>>
  return TIMELINE_STAGES.map((stage) => {
    // 误报终态下「扑灭结论」不点亮，结论改为误报单独提示。
    const done = stage.key === 'conclusion'
      ? status === '已扑灭'
      : status !== '误报' && !!times[stage.key]
    return {
      stage: stage.key,
      label: stage.label,
      at: stage.key === 'report' ? (times.report ?? reportAt) : (times[stage.key] ?? ''),
      done,
      terminal: status === '误报' && stage.key === 'conclusion',
    }
  })
}

/** 补齐老数据：版本号、阶段时间戳、关联任务标记，保证旧 localStorage 也能进作战视图。 */
function normalize(row: EntryRow, index: number): EntryRow {
  if (typeof row.version === 'number') return row
  const status = String(row.status)
  const stageTimes: Partial<Record<TimelineStageKey, string>> = {
    report: String(row['起火时间'] ?? '') || `2026-09-0${index + 1} 08:00`,
  }
  if (['已确认', '已出警', '已扑灭'].includes(status)) stageTimes.verify = `2026-09-0${index + 1} 09:00`
  if (['已出警', '已扑灭'].includes(status)) stageTimes.dispatch = `2026-09-0${index + 1} 10:00`
  if (status === '已扑灭') stageTimes.conclusion = `2026-09-0${index + 1} 12:00`
  return { ...row, version: 0, 阶段时间: JSON.stringify(stageTimes) }
}

export function normalizedFireRows(): EntryRow[] {
  const rows = listRows(FIRE_KEY)
  let changed = false
  const next = rows.map((row, index) => {
    const fixed = normalize(row, index)
    if (fixed !== row) changed = true
    return fixed
  })
  if (changed) saveRows(FIRE_KEY, next)
  return next
}

function nowText(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

type AdvanceOptions = {
  expectedVersion?: number
  channel?: EntryChannel
  remark?: string
}

export type AdvanceResult = ActionResult & {
  version?: number
  conflict?: boolean
  priorityWinner?: boolean
}

/**
 * 推进一条火情报告。
 * - 状态机：只允许 FIRE_ALLOWED_FROM 内的正向跳转，终态/倒回一律拒绝。
 * - 乐观锁：expectedVersion 与库内版本不一致时判为并发冲突，本次不生效。
 * - 出警成功后向 fireteam / drone 各追加一份联动任务。
 */
export function advanceReport(id: number, action: FireAction, options: AdvanceOptions = {}): AdvanceResult {
  const target = FIRE_ACTION_TARGET[action]
  if (!target) return { ok: false, message: `没有登记「${action}」这个处置动作` }

  const rows = normalizedFireRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) return { ok: false, message: `没有找到编号为 ${id} 的火情报告` }

  const current = rows[index]
  const currentStatus = String(current.status)
  // 乐观锁优先判定：基于过期版本的提交一律算并发冲突，哪怕它想做的跳转也已不合法。
  if (typeof options.expectedVersion === 'number' && Number(options.expectedVersion) !== Number(current.version)) {
    return {
      ok: false,
      conflict: true,
      message: `该火情已被「${String(current['最后入口'] ?? '另一处入口')}」先推进到「${currentStatus}」，本次并发操作不生效`,
    }
  }
  if (isTerminal(currentStatus)) {
    return { ok: false, conflict: true, message: `火情已闭环为「${currentStatus}」，终态不能再推进` }
  }
  if (!FIRE_ALLOWED_FROM[action].includes(currentStatus)) {
    return {
      ok: false,
      message: `「${currentStatus}」不能执行「${action}」，状态只能从待核实逐段推进，不能倒回`,
    }
  }

  const times = JSON.parse(String(current['阶段时间'] ?? '{}')) as Partial<Record<TimelineStageKey, string>>
  const stageKey = TIMELINE_STAGES.find((s) => s.status === target)?.key
  if (stageKey) times[stageKey] = nowText()

  const updated: EntryRow = {
    ...current,
    status: target,
    version: Number(current.version ?? 0) + 1,
    pending: !isTerminal(target),
    abnormal: target === '误报',
    阶段时间: JSON.stringify(times),
    最后动作: action,
    最后入口: options.channel ?? '作战视图',
    最后说明: options.remark ?? '',
  }
  const next = [...rows]
  next[index] = updated
  // 整份数据一次落库：先改版本的路径先成功，后到者 CAS 失败。
  saveRows(FIRE_KEY, next)

  if (action === '出动扑救') {
    spawnLinkedTasks(updated, options.channel ?? '作战视图')
  }
  return { ok: true, version: Number(updated.version), message: `火情报告已${action}，当前状态「${target}」` }
}

/**
 * 模拟同一火情被两处入口并发推进：两条路径都基于同一个库内版本做 CAS。
 * 同版本竞争时，若涉及「扑灭 vs 误报」互斥终态，由本函数按「扑灭优先」
 * 选择正确终态落库，另一条返回冲突；其余按数组顺序首条先落库。
 */
export function advanceConcurrent(
  id: number,
  attempts: { action: FireAction; channel: EntryChannel; remark?: string }[],
): AdvanceResult[] {
  const rows = normalizedFireRows()
  const current = rows.find((row) => Number(row.id) === id)
  if (!current) {
    return attempts.map(() => ({ ok: false, conflict: true, message: `没有找到编号为 ${id} 的火情报告` }))
  }
  const expectedVersion = Number(current.version)

  // 终态冲突时自行裁决：扑灭（正向终态）优先于误报（异常终态）。
  const ordered = [...attempts].sort((a, b) => {
    const ta = FIRE_ACTION_TARGET[a.action]
    const tb = FIRE_ACTION_TARGET[b.action]
    if (ta === '已扑灭' && tb === '误报') return -1
    if (ta === '误报' && tb === '已扑灭') return 1
    return 0
  })

  return ordered.map((attempt, i) => {
    const result = advanceReport(id, attempt.action, {
      expectedVersion,
      channel: attempt.channel,
      remark: attempt.remark,
    })
    // 只有首条可能落库；后到者携带同一期望版本必然 CAS 失败。
    if (i === 0 && result.ok && ordered.length > 1 && attempts.length > 1) result.priorityWinner = true
    return result
  })
}

/** 出警联动：扑火队伍待命台账、无人机巡查清单各追加一份任务。幂等，重复出警不重复追加。 */
function spawnLinkedTasks(report: EntryRow, channel: EntryChannel): void {
  const reportNo = String(report['报告编号'] ?? `#${report.id}`)
  const place = String(report['起火地点'] ?? '起火现场')
  const tag = `${reportNo}`

  const teams = listRows(FIRETEAM_KEY)
  const existsTeam = teams.some((r) => String(r['联动火情'] ?? '') === tag)
  if (!existsTeam) {
    saveRows(FIRETEAM_KEY, [
      ...teams,
      {
        id: nextId(FIRETEAM_KEY),
        status: '在营待命',
        pending: true,
        abnormal: false,
        队伍编号: `TEAM-${String(Date.now()).slice(-6)}`,
        队伍名称: `${place}火情扑救队`,
        所属林场: '联动调度',
        队长姓名: '待指派',
        队员人数: 0,
        集结半径: place,
        值班状态: '待命接警',
        出动状态: `由${channel}出警联动`,
        联动火情: tag,
      },
    ])
  }

  const drones = listRows(DRONE_KEY)
  const existsDrone = drones.some((r) => String(r['联动火情'] ?? '') === tag)
  if (!existsDrone) {
    saveRows(DRONE_KEY, [
      ...drones,
      {
        id: nextId(DRONE_KEY),
        status: '待执行',
        pending: true,
        abnormal: false,
        任务编号: `DRON-${String(Date.now()).slice(-6)}`,
        飞行区域: place,
        飞行路线: `${place}上空盘旋侦察`,
        飞手姓名: '待指派',
        起飞时间: nowText(),
        降落时间: '',
        发现异常数: 0,
        任务状态: `由${channel}出警联动`,
        联动火情: tag,
      },
    ])
  }
}
