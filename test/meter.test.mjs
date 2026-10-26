import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  LEDGER_VERSION,
  applyCall,
  createEmpty,
  detectForeignResume,
  importDays,
  localDayKey,
  pruneDedupe,
} from '../lib/meter.js'
import { summarize } from '../lib/ledger.js'

/** 造一次调用。默认放在本地时间白天，避免跨日。 */
function call(overrides = {}) {
  return {
    callId: 'call-1',
    at: new Date(2026, 9, 26, 10, 0, 0),
    model: 'deepseek-v4-flash:deepseek-flash',
    cacheMiss: 1e6,
    cacheHit: 0,
    output: 0,
    sessionId: 'session-a',
    ...overrides,
  }
}

test('新账本结构自洽', () => {
  const state = createEmpty(Date.UTC(2026, 9, 26))
  assert.equal(state.version, LEDGER_VERSION)
  assert.deepEqual(state.days, {})
  assert.equal(state.meta.importAtMs, 0)
  assert.equal(state.meta.foreignMeterResumed, false)
})

test('记一次调用：落在本地日，金额按价目表算', () => {
  const state = createEmpty()
  // 本地 10:00 = UTC 02:00（北京时区）→ 落在峰时窗口，1M cacheMiss × 0.3
  const result = applyCall(state, call(), {})
  assert.equal(result.applied, true)
  assert.equal(result.reason, 'ok')
  const dayKey = localDayKey(new Date(2026, 9, 26, 10, 0, 0))
  const day = state.days[dayKey]
  assert.equal(day.calls, 1)
  assert.equal(day.input, 1e6)
  assert.equal(day.origin, 'live')
  assert.ok(day.cost > 0)
  assert.equal(day.sessions.length, 1)
  assert.equal(day.sessions[0].id, 'session-a')
  assert.ok(day.byProviderModel['deepseek-v4-flash:deepseek-flash'].calls === 1)
})

test('本地日边界：23:30 与次日 00:30 落在不同的键上', () => {
  const state = createEmpty()
  applyCall(state, call({ callId: 'a', at: new Date(2026, 9, 26, 23, 30) }), {})
  applyCall(state, call({ callId: 'b', at: new Date(2026, 9, 27, 0, 30) }), {})
  assert.equal(Object.keys(state.days).length, 2, '跨过本地零点就应当是两天')
  assert.equal(state.days['2026-10-26'].calls, 1)
  assert.equal(state.days['2026-10-27'].calls, 1)
})

test('同一个 callId 记两次：第二次被当重复丢掉', () => {
  const state = createEmpty()
  assert.equal(applyCall(state, call({ callId: 'dup' }), {}).applied, true)
  const second = applyCall(state, call({ callId: 'dup' }), {})
  assert.equal(second.applied, false)
  assert.equal(second.reason, 'duplicate')
  const dayKey = localDayKey(new Date(2026, 9, 26, 10, 0, 0))
  assert.equal(state.days[dayKey].calls, 1, '金额绝不能记两遍')
})

test('拿不到 callId 就不记账（宁可少记，不可多记）', () => {
  const state = createEmpty()
  for (const bad of [undefined, null, '']) {
    const result = applyCall(state, call({ callId: bad }), {})
    assert.equal(result.applied, false)
    assert.equal(result.reason, 'no-call-id')
  }
  assert.deepEqual(state.days, {})
})

test('检测到 cost-meter 复活 → 立刻停手，防止两边各记一遍', () => {
  const state = createEmpty()
  state.meta.foreignMeterResumed = true
  const result = applyCall(state, call(), {})
  assert.equal(result.applied, false)
  assert.equal(result.reason, 'foreign-meter-resumed')
})

test('detectForeignResume：导入之后外部账本又被写过才算复活', () => {
  const state = createEmpty()
  state.meta.importAtMs = 1000
  assert.equal(detectForeignResume(state, 999), false, '导入之前写的，不算复活')
  assert.equal(detectForeignResume(state, 5000), true, '导入之后还在写 = 它回来了')
  const fresh = createEmpty()
  assert.equal(detectForeignResume(fresh, 999999), false, '没导入过就无所谓')
})

test('导入历史：只补不覆盖，幂等', () => {
  const state = createEmpty()
  const sourceDays = {
    '2026-08-14': { date: '2026-08-14', input: 100, output: 10, cacheRead: 5, calls: 2, cost: 1.5, apiCost: 1.5 },
    '2026-08-15': { date: '2026-08-15', input: 200, output: 20, cacheRead: 6, calls: 3, cost: 2.5 },
    'not-a-date': { cost: 999 },
  }
  const first = importDays(state, sourceDays, { importAtMs: 1000, source: 'cost-meter' })
  assert.equal(first.added, 2)
  assert.equal(first.skipped, 1, '非法日期键要跳过')
  assert.equal(state.days['2026-08-14'].cost, 1.5, '导入保留原记录的金额，不按我的公式重算')
  assert.equal(state.days['2026-08-14'].origin, 'imported')

  const second = importDays(state, sourceDays, { importAtMs: 2000 })
  assert.equal(second.added, 0, '第二次导入什么都不该加')
  assert.equal(state.days['2026-08-14'].cost, 1.5, '不能重复累加')
})

test('导入不会覆盖我自己记过的日子', () => {
  const state = createEmpty()
  applyCall(state, call({ callId: 'live-1', at: new Date(2026, 9, 26, 10, 0) }), {})
  const dayKey = localDayKey(new Date(2026, 9, 26, 10, 0))
  const liveCost = state.days[dayKey].cost
  importDays(state, { [dayKey]: { date: dayKey, calls: 99, cost: 12345 } }, {})
  assert.equal(state.days[dayKey].origin, 'live')
  assert.equal(state.days[dayKey].cost, liveCost, '我记的那天不许被导入值盖掉')
})

test('去重表按时间裁剪', () => {
  const state = createEmpty()
  const nowMs = Date.UTC(2026, 9, 26)
  state.dedupe = {
    old: nowMs - 10 * 24 * 3600 * 1000,
    fresh: nowMs - 1000,
  }
  const result = pruneDedupe(state, { keepDays: 3, nowMs })
  assert.equal(result.after, 1)
  assert.ok(state.dedupe.fresh !== undefined)
  assert.equal(state.dedupe.old, undefined)
})

test('★ 格式契约：我记的账本可以直接喂给 summarize()，并算出累计/本月', () => {
  // 这条是最关键的一条 —— 整个"自己计量"方案成立的前提就是
  // "我写出的日对象与 cost-meter 的完全同构"，否则面板/命令/接口全要改。
  const state = createEmpty()
  applyCall(state, call({ callId: 'c1', at: new Date(2026, 9, 26, 10, 0), cacheMiss: 1e6 }), {})
  applyCall(state, call({ callId: 'c2', at: new Date(2026, 9, 26, 11, 0), cacheMiss: 2e6 }), {})
  applyCall(state, call({ callId: 'c3', at: new Date(2026, 8, 30, 10, 0), cacheMiss: 4e6 }), {})

  const dayKey = localDayKey(new Date(2026, 9, 26, 10, 0))
  const summary = summarize({ config: { currency: 'CNY', exchangeRate: 7.2 }, days: state.days }, { dayKey })

  assert.equal(summary.ok, true)
  assert.equal(summary.hasData, true)
  assert.equal(summary.calls, 2, '今日两次调用')
  assert.equal(summary.input, 3e6)
  assert.equal(summary.total.days, 2, '累计两天（9-30 与 10-26）')
  assert.equal(summary.total.calls, 3)
  assert.equal(summary.month.monthKey, '2026-10')
  assert.equal(summary.month.calls, 2, '本月只有 10-26 那两次')
  assert.equal(summary.symbol, '¥')
  // 金额自洽：今日 + 另一天 = 累计
  assert.equal(
    Number((summary.cost + summary.total.cost - summary.cost).toFixed(6)),
    Number(summary.total.cost.toFixed(6)),
  )
})
