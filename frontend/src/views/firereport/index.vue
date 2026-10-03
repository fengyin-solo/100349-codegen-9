<template>
  <section class="page" data-module="firereport">
    <header class="page-head">
      <div>
        <h2>火情报告管理</h2>
        <p class="page-desc">维护火情报告，围绕报告编号、起火地点、起火时间、火势等级做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn primary" to="/fireops">进入处置作战视图</RouterLink>
        <button class="btn" type="button" @click="exportRows">导出火情报告清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <template v-if="actionsFor(String(row.status)).length">
              <button
                v-for="action in actionsFor(String(row.status))"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
            <span v-else class="terminal-text">终态，不可再推进</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无火情报告数据，可先登记火情报告</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条火情报告记录；状态只能从待核实逐段推进，误报与扑灭互斥不可倒回</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { availableActions, isTerminal, type FireAction } from '@/data/fire-ops'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('firereport')
const columns = ["报告编号", "起火地点", "起火时间", "火势等级", "过火面积", "扑救情况", "报告人", "报告状态"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const statuses = ["待核实", "已确认", "已出警", "已扑灭", "误报"]
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  { label: "今日报告数", value: rows.value.length },
  { label: "已确认火情", value: rows.value.filter((r) => ["已确认", "已出警", "已扑灭"].includes(String(r.status))).length },
  { label: "扑救中火情", value: rows.value.filter((r) => String(r.status) === "已出警").length },
  { label: "终态闭环", value: rows.value.filter((r) => isTerminal(String(r.status))).length },
])

function actionsFor(status: string): FireAction[] {
  return availableActions(status)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  if (action === '出动扑救') {
    errorMessage.value = `${result.message}；扑火队伍待命台账与无人机巡查清单已各新增一份联动任务`
  }
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '火情报告列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.terminal-text { color: var(--muted); font-size: 12px; }
</style>
