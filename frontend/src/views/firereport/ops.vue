<template>
  <section class="page" data-module="fireops">
    <header class="page-head">
      <div>
        <h2>火情处置作战视图</h2>
        <p class="page-desc">
          按火势等级从高到低排列，沿「报告 → 巡护核查 → 队伍出警 → 扑灭结论」逐段推进；误报与扑灭为互斥终态，不可回退。
        </p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" to="/firereport">返回火情报告列表</RouterLink>
        <button class="btn" type="button" @click="reload">刷新战况</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p v-if="message" class="ops-message" :class="{ error: !lastOk }">{{ message }}</p>

    <div class="ops-board">
      <article v-for="card in cards" :key="Number(card.row.id)" class="ops-card" :class="{ terminal: card.terminal }">
        <header class="ops-card-head">
          <strong>{{ card.row['报告编号'] }}</strong>
          <span class="level-badge" :data-rank="card.levelRank">{{ card.row['火势等级'] || '等级未定' }}</span>
          <span class="status-chip" :data-status="card.row.status">{{ card.row.status }}</span>
        </header>
        <p class="ops-meta">
          起火地点：{{ card.row['起火地点'] ?? '—' }} ｜ 起火时间：{{ card.row['起火时间'] ?? '—' }} ｜
          报告人：{{ card.row['报告人'] ?? '—' }} ｜ 过火面积：{{ card.row['过火面积'] ?? '—' }}
        </p>
        <ol class="timeline">
          <li
            v-for="node in card.timeline"
            :key="node.stage"
            class="timeline-node"
            :class="{ reached: node.reached }"
          >
            <span class="node-dot"></span>
            <span class="node-stage">{{ node.stage }}</span>
            <span class="node-at">{{ node.at || '—' }}</span>
            <span v-if="node.outcome" class="node-outcome">{{ node.outcome }}</span>
          </li>
        </ol>
        <footer class="ops-card-foot">
          <template v-if="card.allowedActions.length">
            <button
              v-for="action in card.allowedActions"
              :key="action"
              class="btn"
              :class="{ primary: action === '出动扑救' }"
              type="button"
              @click="act(action, card)"
            >
              {{ action }}
            </button>
          </template>
          <span v-else class="terminal-label">已终态（{{ card.row.status }}），不再接受处置动作</span>
        </footer>
      </article>
      <p v-if="!cards.length" class="empty-state">暂无火情报告，可先在火情报告列表登记</p>
    </div>

    <footer class="page-foot">
      <span>共 {{ cards.length }} 条火情在册</span>
      <span>两处入口并发推进同一条报告时，只有先落库的路径生效</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { advanceFireReport, loadOpsBoard } from '@/api/fire-ops'
import type { FireOpsCard } from '@/api/fire-ops'
import { storageKey } from '@/data/local-store'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()
const cards = ref<FireOpsCard[]>([])
const message = ref('')
const lastOk = ref(true)

const stats = computed(() => [
  { label: '在处置火情', value: cards.value.filter((card) => !card.terminal).length },
  { label: '已出警', value: cards.value.filter((card) => card.row.status === '已出警').length },
  { label: '已扑灭', value: cards.value.filter((card) => card.row.status === '已扑灭').length },
  { label: '误报', value: cards.value.filter((card) => card.row.status === '误报').length },
])

const TERMINAL_ACTIONS = ['确认扑灭', '确认误报']

function act(action: string, card: FireOpsCard) {
  let tips = ''
  if (TERMINAL_ACTIONS.includes(action)) {
    tips = `「${action}」会把报告 ${String(card.row['报告编号'])} 推进到终态，误报与扑灭互斥且不可回退，确认执行？`
  } else if (action === '出动扑救') {
    tips = '出警落库后，扑火队伍待命台账和无人机巡查清单会各生成一份任务，确认出警？'
  }
  if (tips && !window.confirm(tips)) {
    return
  }
  const result = advanceFireReport(Number(card.row.id), action, card.version, store.operator)
  reload()
  lastOk.value = result.ok
  message.value = result.message
}

function reload() {
  cards.value = loadOpsBoard()
}

function onStorage(event: StorageEvent) {
  if (event.key === storageKey()) {
    reload()
  }
}

onMounted(() => {
  reload()
  window.addEventListener('storage', onStorage)
})

onBeforeUnmount(() => {
  window.removeEventListener('storage', onStorage)
})
</script>

<style scoped>
.ops-board {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ops-card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 16px;
}
.ops-card.terminal {
  opacity: 0.85;
}
.ops-card-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.level-badge {
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  color: #fff;
  background: #94a3b8;
}
.level-badge[data-rank='0'] {
  background: #b42318;
}
.level-badge[data-rank='1'] {
  background: #d92d20;
}
.level-badge[data-rank='2'] {
  background: #d97706;
}
.level-badge[data-rank='3'] {
  background: #1f6feb;
}
.status-chip {
  margin-left: auto;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 10px;
}
.status-chip[data-status='已出警'] {
  color: #d97706;
  border-color: #d97706;
}
.status-chip[data-status='已扑灭'] {
  color: #067647;
  border-color: #067647;
}
.status-chip[data-status='误报'] {
  color: #b42318;
  border-color: #b42318;
}
.ops-meta {
  color: var(--muted);
  font-size: 12px;
  margin: 8px 0 0;
}
.timeline {
  display: flex;
  list-style: none;
  margin: 14px 0 6px;
  padding: 0;
}
.timeline-node {
  position: relative;
  flex: 1;
  padding-top: 18px;
  text-align: center;
  font-size: 12px;
  color: var(--muted);
}
.timeline-node::before {
  content: '';
  position: absolute;
  top: 5px;
  left: -50%;
  right: 50%;
  height: 2px;
  background: var(--border);
}
.timeline-node:first-child::before {
  display: none;
}
.timeline-node.reached {
  color: #1f2937;
}
.timeline-node.reached::before {
  background: var(--brand);
}
.node-dot {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--border);
  background: #fff;
}
.timeline-node.reached .node-dot {
  background: var(--brand);
  border-color: var(--brand);
}
.node-stage {
  display: block;
  font-weight: 600;
}
.node-at {
  display: block;
}
.node-outcome {
  display: inline-block;
  margin-top: 2px;
  border-radius: 999px;
  padding: 0 8px;
  font-size: 12px;
  background: #eef2f7;
}
.ops-card-foot {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 10px;
}
.terminal-label {
  color: var(--muted);
  font-size: 12px;
}
.ops-message {
  font-size: 13px;
  color: #067647;
}
.ops-message.error {
  color: #b42318;
}
</style>
