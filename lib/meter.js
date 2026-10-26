// 自记账本 —— 不再依赖 dsh-cost-meter。
//
// 设计取舍（为什么要抄 cost-meter 的日记录格式）：
//   `ledger.js` 里的 `summarize()` 只认 `days[<YYYY-MM-DD>]` 里那几个字段
//   （date / input / output / cacheRead / cacheWrite / reasoning / calls / cost /
//   byProviderModel / sessions）。**只要我写出的日对象长得一样**，汇总、面板、
//   `/cost` 命令、HTTP 接口就全都不用动 —— 换掉的只是"谁来写这个文件"。
//   反过来，如果我自己另发明一套结构，就得同时改 5 个地方，每处都可能写漏。
//
// 去重：一次调用必须只记一次。重启后内核可能重放历史事件，所以记一条之前先查
// `dedupe[callId]`。callId 拿不到时**宁可拒绝记账**也不要盲记 —— 少记能发现（数字不涨），
// 多记发现不了（数字偏大，用户无从核对）。

import { priceCall, normalizeModel } from './pricing.js'

export const LEDGER_VERSION = 1
/** 去重表最多保留多少条（防止账本无限膨胀；按天推进，旧的自动清）。 */
export const DEDUPE_LIMIT = 20000

export function localDayKey(at) {
  const date = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(date.getTime())) return null
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function createEmpty(nowMs = Date.now()) {
  return {
    version: LEDGER_VERSION,
    createdAt: new Date(nowMs).toISOString(),
    meta: {
      importAtMs: 0,
      importSource: null,
      importedDays: 0,
      foreignMeterResumed: false,
    },
    dedupe: {},
    days: {},
  }
}

function ensureDay(state, dayKey) {
  if (!Object.prototype.hasOwnProperty.call(state.days, dayKey)) {
    state.days[dayKey] = {
      date: dayKey,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      calls: 0,
      cost: 0,
      apiCost: 0,
      // 只有 import 进来的日子才有 origin='imported'；其余就是我自己记的。
      origin: 'live',
      byProviderModel: {},
      sessions: [],
    }
  }
  return state.days[dayKey]
}

function ensureSession(day, sessionId) {
  const id = typeof sessionId === 'string' && sessionId !== '' ? sessionId : '(未知会话)'
  let found = day.sessions.find((item) => item.id === id)
  if (found === undefined) {
    found = { id, calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0 }
    day.sessions.push(found)
  }
  return found
}

/**
 * 把一次调用记进去（**原地修改** state，调用方负责落盘）。
 *
 * @returns {{applied: boolean, reason: string, costUsd: number}}
 *   reason: 'ok' | 'duplicate' | 'no-call-id' | 'foreign-meter-resumed'
 */
export function applyCall(state, call, options = {}) {
  const item = call === null || typeof call !== 'object' ? {} : call

  if (state.meta !== undefined && state.meta !== null && state.meta.foreignMeterResumed === true) {
    // 检测到 cost-meter 又回来了：立刻停手，否则同一次调用被两边各记一遍，总额翻倍。
    return { applied: false, reason: 'foreign-meter-resumed', costUsd: 0 }
  }

  const callId = typeof item.callId === 'string' && item.callId !== '' ? item.callId : null
  if (callId === null) {
    // 没有唯一标识就不记账。见文件头：少记可发现、多记不可发现。
    return { applied: false, reason: 'no-call-id', costUsd: 0 }
  }
  if (Object.prototype.hasOwnProperty.call(state.dedupe, callId)) {
    return { applied: false, reason: 'duplicate', costUsd: 0 }
  }

  const at = item.at instanceof Date ? item.at : new Date(item.at === undefined ? Date.now() : item.at)
  const dayKey = localDayKey(at)
  if (dayKey === null) return { applied: false, reason: 'bad-timestamp', costUsd: 0 }

  const priced = priceCall(
    {
      model: item.model,
      at,
      cacheMiss: item.cacheMiss,
      cacheHit: item.cacheHit,
      output: item.output,
    },
    options,
  )

  const day = ensureDay(state, dayKey)
  const session = ensureSession(day, item.sessionId)
  const cacheMiss = priced.tokens.cacheMiss
  const cacheHit = priced.tokens.cacheHit
  const output = priced.tokens.output

  day.input += cacheMiss
  day.cacheRead += cacheHit
  day.output += output
  day.cacheWrite += Number(item.cacheWrite) > 0 ? Number(item.cacheWrite) : 0
  day.reasoning += Number(item.reasoning) > 0 ? Number(item.reasoning) : 0
  day.calls += 1
  day.cost += priced.costUsd
  day.apiCost += priced.costUsd

  session.calls += 1
  session.cost += priced.costUsd
  session.input += cacheMiss
  session.cacheRead += cacheHit
  session.output += output

  const modelKey = typeof item.model === 'string' && item.model !== '' ? item.model : '(未知模型)'
  if (day.byProviderModel[modelKey] === undefined) {
    day.byProviderModel[modelKey] = {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0, cost: 0, apiCost: 0,
    }
  }
  const bucket = day.byProviderModel[modelKey]
  bucket.input += cacheMiss
  bucket.cacheRead += cacheHit
  bucket.output += output
  bucket.calls += 1
  bucket.cost += priced.costUsd
  bucket.apiCost += priced.costUsd

  state.dedupe[callId] = at.getTime()
  return { applied: true, reason: 'ok', costUsd: priced.costUsd }
}

/** 去重表按时间裁剪（保留 `keepDays` 天内、且总数不超过 LIMIT）。 */
export function pruneDedupe(state, options = {}) {
  const keepDays = Number.isFinite(options.keepDays) ? options.keepDays : 3
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now()
  const cutoff = nowMs - keepDays * 24 * 3600 * 1000
  const entries = Object.entries(state.dedupe)
  const kept = entries.filter(([, ts]) => Number(ts) >= cutoff)
  const trimmed = kept.length > DEDUPE_LIMIT ? kept.slice(kept.length - DEDUPE_LIMIT) : kept
  state.dedupe = Object.fromEntries(trimmed)
  return { before: entries.length, after: trimmed.length }
}

/**
 * 一次性导入 cost-meter 的账本（幂等：已有的日子不覆盖、不重复累加）。
 *
 * `sourceDays` 就是 cost-meter `ledger.json` 的 `days` 对象。
 * 导入的日子标 `origin: 'imported'`，并保留它记下的 `cost` —— **不按我的公式重算**：
 * 重算会让"累计"从我上一条消息里的 ¥732.48 变成别的数，用户会以为钱变了。
 */
export function importDays(state, sourceDays, options = {}) {
  const importAtMs = Number.isFinite(options.importAtMs) ? options.importAtMs : Date.now()
  const source = typeof options.source === 'string' ? options.source : 'cost-meter'
  let added = 0
  let skipped = 0
  if (sourceDays === null || typeof sourceDays !== 'object') {
    return { added, skipped, state }
  }
  for (const [dayKey, raw] of Object.entries(sourceDays)) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(dayKey)) {
      skipped += 1
      continue
    }
    if (raw === null || typeof raw !== 'object') {
      skipped += 1
      continue
    }
    const existing = state.days[dayKey]
    // 这一天已经有数据就跳过 —— **不管数据是我记的还是上次导入的**。
    // 只按 origin==='live' 判断会让"第二次导入"把同一天再累加一遍（实测就是这个 bug：幂等性测试直接抓到）。
    const hasData = existing !== undefined &&
      ((Number(existing.calls) || 0) > 0 ||
        (Number(existing.cost) || 0) > 0 ||
        (Number(existing.input) || 0) > 0)
    if (hasData) {
      skipped += 1
      continue
    }
    const day = ensureDay(state, dayKey)
    day.origin = 'imported'
    day.input = Number(raw.input) || 0
    day.output = Number(raw.output) || 0
    day.cacheRead = Number(raw.cacheRead) || 0
    day.cacheWrite = Number(raw.cacheWrite) || 0
    day.reasoning = Number(raw.reasoning) || 0
    day.calls = Number(raw.calls) || 0
    day.cost = Number(raw.cost) || 0
    day.apiCost = Number(raw.apiCost) || day.cost
    if (raw.byProviderModel !== null && typeof raw.byProviderModel === 'object') {
      day.byProviderModel = raw.byProviderModel
    }
    if (Array.isArray(raw.sessions)) {
      day.sessions = raw.sessions
        .filter((s) => s !== null && typeof s === 'object' && typeof s.id === 'string')
        .map((s) => ({
          id: s.id,
          calls: Number(s.calls) || 0,
          cost: Number(s.cost) || 0,
          input: Number(s.input) || 0,
          output: Number(s.output) || 0,
          cacheRead: Number(s.cacheRead) || 0,
        }))
    }
    added += 1
  }
  state.meta.importAtMs = importAtMs
  state.meta.importSource = source
  state.meta.importedDays = Object.values(state.days).filter((d) => d.origin === 'imported').length
  return { added, skipped, state }
}

/**
 * cost-meter 的账本是否在我导入之后又被写过 —— 是则说明它被装回来了。
 * 这道闸是防"两边各记一遍"的：一旦为真，`applyCall` 立刻停手。
 */
export function detectForeignResume(state, foreignMtimeMs) {
  if (state.meta === undefined || state.meta === null) return false
  const importedAt = Number(state.meta.importAtMs) || 0
  if (importedAt === 0) return false
  return Number(foreignMtimeMs) > importedAt + 1000
}
