<template>
  <section class="page battle-page" data-module="firereport-battle">
    <header class="page-head">
      <div>
        <h2>火情处置作战视图</h2>
        <p class="page-desc">
          以时间轴串联火情报告、巡护核查、队伍出警、扑灭结论，默认按火势等级从高到低排列；
          状态只能从待核实逐段推进到扑灭，误报与扑灭互斥，终态不可倒回。
        </p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" to="/firereport">返回火情报告台账</RouterLink>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div class="battle-toolbar">
      <label class="sort-switch">
        火势等级排列：
        <button
          class="btn"
          type="button"
          :class="{ primary: rankDesc }"
          @click="rankDesc = true"
        >高 → 低</button>
        <button
          class="btn"
          type="button"
          :class="{ primary: !rankDesc }"
          @click="rankDesc = false"
        >低 → 高</button>
      </label>
      <span class="rule-hint">终态冲突裁决：扑灭优先于误报；并发推进仅先落库路径生效。</span>
    </div>

    <p v-if="feedback" class="battle-feedback" :class="feedback.kind">{{ feedback.text }}</p>

    <div v-if="!sortedRows.length" class="battle-empty">暂无可处置的火情报告</div>

    <article v-for="row in sortedRows" :key="String(row.id)" class="fire-card">
      <header class="fire-card-head">
        <div class="fire-id">
          <span class="fire-no">{{ row['报告编号'] }}</span>
          <span class="level-badge" :data-rank="levelRank(row['火势等级'])">
            {{ levelLabel(row['火势等级']) }}
          </span>
          <span class="status-badge" :class="statusClass(String(row.status))">{{ row.status }}</span>
        </div>
        <div class="fire-meta">
          <span>📍 {{ row['起火地点'] }}</span>
          <span>🕐 起火 {{ row['起火时间'] }}</span>
          <span>🔥 过火 {{ row['过火面积'] }}</span>
          <span>📣 {{ row['报告人'] }}</span>
        </div>
      </header>

      <ol class="timeline">
        <li
          v-for="point in buildTimeline(row)"
          :key="point.stage"
          class="timeline-item"
          :class="{ done: point.done, muted: point.terminal }"
        >
          <span class="timeline-dot">{{ point.done ? '✓' : '' }}</span>
          <div class="timeline-body">
            <strong>{{ point.label }}</strong>
            <small v-if="point.terminal">误报终态，无扑灭结论</small>
            <small v-else-if="point.at">{{ point.at }}</small>
            <small v-else class="waiting">待推进</small>
          </div>
        </li>
      </ol>

      <p v-if="row['最后动作']" class="last-trace">
        最近一次：{{ row['最后动作'] }}（来源：{{ row['最后入口'] }} · 版本 v{{ row.version ?? 0 }}）
        <template v-if="row['最后说明']">—— {{ row['最后说明'] }}</template>
      </p>

      <div v-if="actionsFor(String(row.status)).length" class="fire-actions">
        <template v-for="action in actionsFor(String(row.status))" :key="action">
          <input
            v-if="needsRemark(action)"
            class="remark-input"
            :value="remarks[row.id]?.[action] ?? ''"
            :placeholder="remarkPlaceholder(action)"
            @input="setRemark(Number(row.id), action, ($event.target as HTMLInputElement).value)"
          />
          <button
            class="btn"
            :class="{ primary: action === '出动扑救', danger: action === '确认误报' }"
            type="button"
            @click="submit(Number(row.id), action)"
          >{{ action }}</button>
        </template>

        <span class="concurrent-hint">两处入口并发推进：</span>
        <button
          v-for="pair in concurrentPairsFor(String(row.status))"
          :key="pair.label"
          class="btn ghost"
          type="button"
          :title="pair.desc"
          @click="simulateConcurrent(Number(row.id), pair.actions, pair.channels)"
        >
          {{ pair.label }}
        </button>
      </div>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { listEntries } from '@/api/local-service'
import {
  advanceConcurrent,
  advanceReport,
  availableActions,
  buildTimeline,
  isTerminal,
  levelLabel,
  levelRank,
  type EntryChannel,
  type FireAction,
} from '@/data/fire-ops'
import type { EntryRow } from '@/data/types'

const rows = ref<EntryRow[]>([])
const rankDesc = ref(true)
const remarks = reactive<Record<number, Partial<Record<FireAction, string>>>>({})
const feedback = ref<{ text: string; kind: 'ok' | 'err' } | null>(null)

const sortedRows = computed(() => {
  const copy = [...rows.value]
  copy.sort((a, b) => {
    const diff = levelRank(b['火势等级']) - levelRank(a['火势等级'])
    if (diff !== 0) return rankDesc.value ? diff : -diff
    return Number(b.id) - Number(a.id)
  })
  return copy
})

const stats = computed(() => [
  { label: '在处火情', value: rows.value.filter((r) => !isTerminal(String(r.status))).length },
  { label: '待核实', value: rows.value.filter((r) => String(r.status) === '待核实').length },
  { label: '已出警/扑救中', value: rows.value.filter((r) => String(r.status) === '已出警').length },
  { label: '已扑灭', value: rows.value.filter((r) => String(r.status) === '已扑灭').length },
  { label: '误报', value: rows.value.filter((r) => String(r.status) === '误报').length },
])

function actionsFor(status: string): FireAction[] {
  return availableActions(status)
}

function needsRemark(action: FireAction): boolean {
  return action === '确认扑灭' || action === '确认误报'
}

function remarkPlaceholder(action: FireAction): string {
  return action === '确认扑灭' ? '填写扑灭结论（过火面积/余火看守）' : '填写误报依据'
}

function setRemark(id: number, action: FireAction, value: string) {
  remarks[id] = { ...(remarks[id] ?? {}), [action]: value }
}

function statusClass(status: string): string {
  if (status === '已扑灭') return 'st-extinguished'
  if (status === '误报') return 'st-false'
  if (status === '已出警') return 'st-dispatched'
  if (status === '已确认') return 'st-confirmed'
  return 'st-pending'
}

/** 同状态下两处入口可能并发提交的动作组合；已出警时含「扑灭 vs 误报」互斥终态竞争。 */
function concurrentPairsFor(status: string): {
  label: string
  desc: string
  actions: [FireAction, FireAction]
  channels: [EntryChannel, EntryChannel]
}[] {
  if (status === '待核实') {
    return [
      {
        label: '并发：台账核实 × 视图核查',
        desc: '火情报告台账与作战视图同时核实同一火情，仅先落库者生效',
        actions: ['核实火情', '核实火情'],
        channels: ['火情报告台账', '作战视图'],
      },
    ]
  }
  if (status === '已确认') {
    return [
      {
        label: '并发：视图出警 × 台账出警',
        desc: '两处入口同时提交出警，仅先落库路径生成联动任务',
        actions: ['出动扑救', '出动扑救'],
        channels: ['作战视图', '火情报告台账'],
      },
    ]
  }
  if (status === '已出警') {
    return [
      {
        label: '并发：扑灭 × 误报（互斥终态）',
        desc: '一处确认扑灭、一处确认误报；终态互斥，按扑灭优先裁决，另一条冲突失败',
        actions: ['确认扑灭', '确认误报'],
        channels: ['作战视图', '火情报告台账'],
      },
    ]
  }
  return []
}

function submit(id: number, action: FireAction) {
  const remark = remarks[id]?.[action] ?? ''
  if (needsRemark(action) && !remark.trim()) {
    feedback.value = { kind: 'err', text: `「${action}」前请先填写${action === '确认扑灭' ? '扑灭结论' : '误报依据'}` }
    return
  }
  const result = advanceReport(id, action, { channel: '作战视图', remark })
  if (result.ok) {
    const extra = action === '出动扑救'
      ? '；扑火队伍待命台账与无人机巡查清单已各新增一份联动任务'
      : ''
    feedback.value = { kind: 'ok', text: `${result.message}${extra}` }
  } else {
    feedback.value = { kind: 'err', text: result.message }
  }
  reload()
}

function simulateConcurrent(
  id: number,
  actions: [FireAction, FireAction],
  channels: [EntryChannel, EntryChannel],
) {
  const results = advanceConcurrent(
    id,
    actions.map((action, i) => ({
      action,
      channel: channels[i],
      remark: action === '确认扑灭' ? '明火扑灭，余火清理中' : action === '确认误报' ? '复核无火点' : '',
    })),
  )
  const winner = results.find((r) => r.ok)
  const losers = results.filter((r) => !r.ok)
  const lines: string[] = []
  if (winner) {
    lines.push(`✔ 先落库路径（${winner.message.replace('火情报告', '')}）已生效`)
  }
  for (const loser of losers) lines.push(`✘ 并发失败：${loser.message}`)
  feedback.value = { kind: winner ? 'ok' : 'err', text: lines.join('　｜　') }
  reload()
}

function reload() {
  const payload = listEntries('firereport')
  rows.value = payload.items
}

onMounted(reload)
</script>

<style scoped>
.battle-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; }
.sort-switch { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); }
.rule-hint { font-size: 12px; color: #b45309; background: #fef3c7; border-radius: 999px; padding: 2px 12px; }
.battle-feedback { margin: 0 0 12px; padding: 8px 12px; border-radius: 6px; font-size: 13px; }
.battle-feedback.ok { background: #ecfdf3; color: #027a48; border: 1px solid #abefc6; }
.battle-feedback.err { background: #fef3f2; color: #b42318; border: 1px solid #fecdca; }
.battle-empty { background: #fff; border: 1px dashed var(--border); border-radius: 8px; padding: 28px; text-align: center; color: var(--muted); }

.fire-card { background: #fff; border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
.fire-card-head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.fire-id { display: flex; align-items: center; gap: 8px; }
.fire-no { font-weight: 700; font-size: 15px; }
.level-badge { font-size: 12px; border-radius: 999px; padding: 2px 10px; color: #fff; background: #94a3b8; }
.level-badge[data-rank="1"] { background: #38a169; }
.level-badge[data-rank="2"] { background: #d69e2e; }
.level-badge[data-rank="3"] { background: #dd6b20; }
.level-badge[data-rank="4"] { background: #e53e3e; }
.level-badge[data-rank="5"] { background: #9b2c2c; }
.status-badge { font-size: 12px; border-radius: 4px; padding: 2px 8px; }
.status-badge.st-pending { background: #eef2f7; color: #475569; }
.status-badge.st-confirmed { background: #fff7ed; color: #c2410c; }
.status-badge.st-dispatched { background: #eff6ff; color: #1d4ed8; }
.status-badge.st-extinguished { background: #ecfdf3; color: #027a48; }
.status-badge.st-false { background: #f5f3ff; color: #6d28d9; }
.fire-meta { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--muted); }

.timeline { list-style: none; margin: 0; padding: 0 0 4px; display: flex; gap: 0; }
.timeline-item { position: relative; flex: 1; display: flex; gap: 8px; padding-right: 12px; }
.timeline-item::before { content: ''; position: absolute; top: 9px; left: 20px; right: 0; height: 2px; background: var(--border); }
.timeline-item:last-child::before { display: none; }
.timeline-item.done::before { background: #2f9e44; }
.timeline-dot { width: 20px; height: 20px; border-radius: 50%; background: #fff; border: 2px solid var(--border); color: transparent; font-size: 11px; display: inline-flex; align-items: center; justify-content: center; flex: none; z-index: 1; }
.timeline-item.done .timeline-dot { background: #2f9e44; border-color: #2f9e44; color: #fff; }
.timeline-item.muted .timeline-dot { border-color: #8b5cf6; }
.timeline-body { display: flex; flex-direction: column; }
.timeline-body strong { font-size: 13px; }
.timeline-body small { font-size: 11px; color: var(--muted); }
.timeline-body small.waiting { color: #94a3b8; }

.last-trace { margin: 8px 0; font-size: 12px; color: var(--muted); }
.fire-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; border-top: 1px dashed var(--border); padding-top: 10px; }
.remark-input { border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 13px; min-width: 260px; }
.btn.danger { color: #b42318; border-color: #fecdca; }
.concurrent-hint { font-size: 12px; color: var(--muted); margin-left: 8px; }
</style>
