// 自记账本的读写层：原子写、首次启动时一次性导入历史。
//
// 为什么坚持原子写（临时文件 + rename）：这个文件**每次调用都会写**。
// 直接覆盖写的话，写到一半掉电/被杀，账本就成半截 JSON，
// 而 `readLedger` 一抛错，界面上看到的是"读不到账本" —— 一次崩溃把所有历史都变成"没有数据"。
// rename 在 NTFS 上是原子的：要么是旧文件，要么是新文件，不存在半截。

import fs from 'node:fs'
import path from 'node:path'

import {
  applyCall,
  createEmpty,
  detectForeignResume,
  importDays,
  pruneDedupe,
} from './meter.js'

export function loadState(file) {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return null
    if (json.days === null || typeof json.days !== 'object') return null
    // 老版本没有的字段补上，避免读到旧文件后到处 undefined 判断
    if (json.meta === null || typeof json.meta !== 'object') {
      json.meta = { importAtMs: 0, importSource: null, importedDays: 0, foreignMeterResumed: false }
    }
    if (json.dedupe === null || typeof json.dedupe !== 'object') json.dedupe = {}
    return json
  } catch {
    return null
  }
}

export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(state), 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch (error) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 临时文件删不掉就算了，反正下次会覆盖 */
    }
    throw error
  }
  return file
}

/**
 * 确保自己的账本存在：不存在就建一个，并把 cost-meter 的历史**一次性**导入。
 *
 * @returns {{state: object, created: boolean, imported: number, source: string|null}}
 */
export function bootstrap(options = {}) {
  const ownFile = options.ownFile
  const legacyFile = options.legacyFile
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now()

  const existing = loadState(ownFile)
  if (existing !== null) {
    return { state: existing, created: false, imported: 0, source: existing.meta.importSource ?? null }
  }

  const state = createEmpty(nowMs)
  let imported = 0
  let source = null

  if (typeof legacyFile === 'string' && legacyFile !== '') {
    let legacy = null
    try {
      legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8'))
    } catch {
      legacy = null
    }
    if (legacy !== null && typeof legacy === 'object' && legacy.days !== null && typeof legacy.days === 'object') {
      const result = importDays(state, legacy.days, { importAtMs: nowMs, source: legacyFile })
      imported = result.added
      source = legacyFile
    }
  }

  saveState(ownFile, state)
  return { state, created: true, imported, source }
}

/**
 * 记下"回补已经推进到哪一刻"。
 *
 * 只在回补**真的成功**时推进 —— 失败也推进的话，那次没读到的区间会被永久标成"已读"，
 * 那段时间的用量就再也没人补了（静默漏账，而且账面上看不出来）。
 */
export function markBackfilled(file, atMs) {
  const state = loadState(file)
  if (state === null) return false
  state.meta.backfillUntilMs = Number.isFinite(atMs) ? atMs : Date.now()
  saveState(file, state)
  return true
}

/**
 * 记一次调用并立刻落盘。
 *
 * @returns {{applied: boolean, reason: string, costUsd: number}}
 */
export function recordCall(options = {}) {
  const file = options.file
  const call = options.call
  const state = options.state ?? loadState(file)
  if (state === null) return { applied: false, reason: 'no-ledger', costUsd: 0 }

  // 外部计量器复活 → 停手（否则同一次调用被记两遍，总额翻倍且用户无从核对）
  if (typeof options.foreignMtimeMs === 'number' && detectForeignResume(state, options.foreignMtimeMs)) {
    if (state.meta.foreignMeterResumed !== true) {
      state.meta.foreignMeterResumed = true
      state.meta.foreignMeterResumedAt = new Date().toISOString()
      saveState(file, state)
    }
    return { applied: false, reason: 'foreign-meter-resumed', costUsd: 0 }
  }

  const result = applyCall(state, call, options.pricing)
  if (result.applied) {
    pruneDedupe(state, { nowMs: Date.now() })
    saveState(file, state)
  }
  return result
}
