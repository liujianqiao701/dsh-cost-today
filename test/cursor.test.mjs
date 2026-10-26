import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { bootstrap, loadState, markBackfilled, recordCall, saveState } from '../lib/store.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cost-today-cursor-'))
}

function aCall(callId, atMs) {
  return {
    callId,
    at: new Date(atMs),
    model: 'deepseek-v4-flash:deepseek-flash',
    cacheMiss: 1000,
    cacheHit: 0,
    output: 10,
  }
}

test('回补游标落盘后，用内存里那份 state 继续记账不会把它抹掉', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'ledger.json')
  try {
    const boot = bootstrap({ ownFile: file, legacyFile: path.join(dir, 'nope.json'), nowMs: 1000 })
    // 模拟 index.js：手里握着 bootstrap 返回的 state 对象
    const inMemory = boot.state

    // 回补跑完 → 游标推进（markBackfilled 内部是另读一份再写回）
    const cursor = 5_000
    assert.equal(markBackfilled(file, cursor), true)
    // 关键动作：把游标同步到内存那份（index.js 里做的就是这个）
    inMemory.meta.backfillUntilMs = cursor

    // 之后来了一次实时记账，走的是内存那份 state
    const result = recordCall({ file, call: aCall('s:1', 6_000), state: inMemory })
    assert.equal(result.applied, true)

    const onDisk = loadState(file)
    assert.equal(onDisk.meta.backfillUntilMs, cursor, '游标必须还在 —— 否则每次启动都会重扫')
    // 游标活着的同时，这次调用也得真的落进账本（1970 = epoch 6000ms 的本地日）
    const day = onDisk.days['1970-01-01']
    assert.ok(day !== undefined, '这次调用应当写进 1970-01-01')
    assert.equal(day.calls, 1)
    assert.equal(day.input, 1000)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('markBackfilled 对不存在的账本返回 false，而不是抛', () => {
  const dir = tmpDir()
  try {
    assert.equal(markBackfilled(path.join(dir, 'none.json'), 123), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('saveState 写出去的 meta 字段完整保留（含导入来源与游标）', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'ledger.json')
  try {
    bootstrap({ ownFile: file, legacyFile: path.join(dir, 'nope.json'), nowMs: 1000 })
    const state = loadState(file)
    state.meta.backfillUntilMs = 7_777
    state.meta.importedDays = 39
    saveState(file, state)
    const back = loadState(file)
    assert.equal(back.meta.backfillUntilMs, 7_777)
    assert.equal(back.meta.importedDays, 39)
    assert.equal(back.meta.foreignMeterResumed, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
