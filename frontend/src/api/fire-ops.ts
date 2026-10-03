import { filterRows } from '@/api/local-service'
import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, PageResult } from '@/data/types'

// 火情处置作战视图专用服务：状态机 + 版本闸 + 联动任务 + 处置时间轴。
// 火情报告列表页与作战视图两处入口都走这里推进，保证同一条报告被并发推进时
// 只有先落库的路径生效，后到路径在版本闸上被拦下。
const REPORT_KEY = 'firereport'
const TIMELINE_KEY = 'fireops_timeline'
const TEAM_KEY = 'fireteam'
const DRONE_KEY = 'drone'

// 处置链只能逐段向前：待核实 → 已确认 → 已出警 → 已扑灭；
// 误报只能在核查环节（待核实/已确认）落终，与已扑灭互斥，两个终态都不可逆，
// 任何状态都不允许倒回已出警。
const ACTION_TARGET: Record<string, string> = {
  核实火情: '已确认',
  出动扑救: '已出警',
  确认扑灭: '已扑灭',
  确认误报: '误报',
}

const TRANSITIONS: Record<string, string[]> = {
  待核实: ['核实火情', '确认误报'],
  已确认: ['出动扑救', '确认误报'],
  已出警: ['确认扑灭'],
  已扑灭: [],
  误报: [],
}

const TERMINAL_STATUSES = new Set(['已扑灭', '误报'])

// 作战视图时间轴的四个节点，与处置链一一对应。
export const OPS_STAGES = ['报告', '巡护核查', '队伍出警', '扑灭结论'] as const

const ACTION_STAGE: Record<string, string> = {
  核实火情: '巡护核查',
  出动扑救: '队伍出警',
  确认扑灭: '扑灭结论',
  确认误报: '扑灭结论',
}

// 火势等级排序权重：等级越高越靠前，识别不了的等级排最后。
const LEVEL_RANKS: [RegExp, number][] = [
  [/特别重大|一级/, 0],
  [/重大|二级/, 1],
  [/较大|三级/, 2],
  [/一般|四级/, 3],
]

export type OpsTimelineNode = {
  stage: string
  reached: boolean
  at: string
  outcome: string
}

export type FireOpsCard = {
  row: EntryRow
  version: number
  levelRank: number
  terminal: boolean
  allowedActions: string[]
  timeline: OpsTimelineNode[]
}

type TimelineEvent = {
  id: number
  reportId: number
  stage: string
  action: string
  at: string
  operator: string
  note: string
}

function now(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

// 旧数据没有 version 字段，读取时补上并落库，之后所有推进都要过版本闸。
function ensureVersions(): EntryRow[] {
  const rows = listRows(REPORT_KEY)
  let changed = false
  const stamped = rows.map((row) => {
    if (typeof row.version === 'number') {
      return row
    }
    changed = true
    return { ...row, version: 1 }
  })
  if (changed) {
    saveRows(REPORT_KEY, stamped)
  }
  return stamped
}

function listEvents(): TimelineEvent[] {
  return listRows(TIMELINE_KEY) as unknown as TimelineEvent[]
}

function appendEvent(event: Omit<TimelineEvent, 'id'>, resultingStatus: string): void {
  const events = listRows(TIMELINE_KEY)
  const id = events.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  // 事件也按 EntryRow 形状落库，复用同一套 localStorage 持久化。
  const row: EntryRow = {
    id,
    status: resultingStatus,
    pending: false,
    abnormal: false,
    reportId: event.reportId,
    stage: event.stage,
    action: event.action,
    at: event.at,
    operator: event.operator,
    note: event.note,
  }
  saveRows(TIMELINE_KEY, [...events, row])
}

export function levelRankOf(level: string): number {
  for (const [pattern, rank] of LEVEL_RANKS) {
    if (pattern.test(level)) {
      return rank
    }
  }
  return LEVEL_RANKS.length
}

export function fireReportActions(status: string): string[] {
  return TRANSITIONS[status] ?? []
}

function buildTimeline(row: EntryRow, events: TimelineEvent[]): OpsTimelineNode[] {
  const status = String(row.status)
  const latestByStage = new Map<string, TimelineEvent>()
  for (const event of events) {
    latestByStage.set(event.stage, event)
  }
  const reached: Record<string, boolean> = {
    报告: true,
    巡护核查: status !== '待核实',
    队伍出警: status === '已出警' || status === '已扑灭',
    扑灭结论: TERMINAL_STATUSES.has(status),
  }
  return OPS_STAGES.map((stage) => {
    const event = latestByStage.get(stage)
    let at = event?.at ?? ''
    if (stage === '报告' && !at) {
      at = String(row['起火时间'] ?? '')
    }
    const outcome = stage === '扑灭结论' && TERMINAL_STATUSES.has(status) ? status : ''
    return { stage, reached: reached[stage] ?? false, at, outcome }
  })
}

// 作战视图看板：按火势等级从高到低排列，同等级按报告编号稳定排序。
export function loadOpsBoard(): FireOpsCard[] {
  const rows = ensureVersions()
  const events = listEvents()
  return rows
    .map((row) => {
      const status = String(row.status)
      const reportEvents = events.filter((event) => Number(event.reportId) === Number(row.id))
      return {
        row,
        version: Number(row.version),
        levelRank: levelRankOf(String(row['火势等级'] ?? '')),
        terminal: TERMINAL_STATUSES.has(status),
        allowedActions: fireReportActions(status),
        timeline: buildTimeline(row, reportEvents),
      }
    })
    .sort((a, b) => a.levelRank - b.levelRank || Number(a.row.id) - Number(b.row.id))
}

// 列表页与作战视图共用同一份带版本的数据，两个入口在版本闸上公平竞争。
export function listFireReports(filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(ensureVersions(), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 出警落库后的联动：扑火队伍待命台账、无人机巡查清单各补一份任务。
// 只在「已出警」这一次跃迁里执行，版本闸保证不会重复生成。
function appendDispatchTasks(report: EntryRow): void {
  const reportNo = String(report['报告编号'] ?? report.id)
  const place = String(report['起火地点'] ?? '火场')
  const stamp = now()

  const teams = listRows(TEAM_KEY)
  const teamId = nextId(teams)
  saveRows(TEAM_KEY, [
    ...teams,
    {
      id: teamId,
      status: '已出动',
      pending: true,
      abnormal: false,
      队伍编号: `FIRE-${String(teamId).padStart(4, '0')}`,
      队伍名称: `火情联动分队（${reportNo}）`,
      所属林场: place,
      队长姓名: '值班调度',
      队员人数: 10,
      集结半径: '5公里',
      值班状态: '出动待命',
      出动状态: `驰援${place}`,
    },
  ])

  const drones = listRows(DRONE_KEY)
  const droneId = nextId(drones)
  saveRows(DRONE_KEY, [
    ...drones,
    {
      id: droneId,
      status: '待执行',
      pending: true,
      abnormal: false,
      任务编号: `DRON-${String(droneId).padStart(4, '0')}`,
      飞行区域: place,
      飞行路线: `${place}周边火线巡查`,
      飞手姓名: '值班飞手',
      起飞时间: stamp,
      降落时间: '',
      发现异常数: 0,
      任务状态: `核查${reportNo}火场`,
    },
  ])
}

// 推进火情处置：先过版本闸（并发时只认先落库路径），再过状态机，最后落库并联动。
export function advanceFireReport(
  id: number,
  action: string,
  expectedVersion: number,
  operator = '值班管理员',
): ActionResult {
  const target = ACTION_TARGET[action]
  if (!target) {
    return { ok: false, message: `火情报告没有登记「${action}」这个处置动作` }
  }
  const rows = ensureVersions()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的火情报告` }
  }
  const current = rows[index]
  if (Number(current.version) !== expectedVersion) {
    return {
      ok: false,
      message: `该报告刚被另一入口推进到「${current.status}」，本次「${action}」未生效，请刷新后再处理`,
    }
  }
  const status = String(current.status)
  if (TERMINAL_STATUSES.has(status)) {
    // 终态冲突时先落库的终态优先：误报与扑灭互斥，谁先到谁生效，后到的一律拒绝。
    return { ok: false, message: `该报告已终态（${status}），误报与扑灭互斥且不可回退` }
  }
  if (!fireReportActions(status).includes(action)) {
    return {
      ok: false,
      message: `「${status}」状态下不能执行「${action}」，只能沿待核实→已确认→已出警→已扑灭逐段推进`,
    }
  }
  const updated: EntryRow = {
    ...current,
    status: target,
    报告状态: target,
    version: expectedVersion + 1,
    pending: !TERMINAL_STATUSES.has(target),
    abnormal: target === '误报',
  }
  const next = [...rows]
  next[index] = updated
  saveRows(REPORT_KEY, next)
  if (target === '已出警') {
    appendDispatchTasks(updated)
  }
  appendEvent(
    {
      reportId: id,
      stage: ACTION_STAGE[action],
      action,
      at: now(),
      operator,
      note: `「${status}」→「${target}」`,
    },
    target,
  )
  const extra = target === '已出警' ? '，扑火队伍待命台账与无人机巡查清单已各增一份任务' : ''
  return { ok: true, message: `火情报告已${action}，当前状态「${target}」${extra}` }
}
