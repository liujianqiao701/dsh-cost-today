import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { bootstrap, loadState, recordCall, saveState } from '../lib/store.js'
import { summarize } from '../lib/ledger.js'
import { localDayKey } from '../lib/meter.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cost-today-store-'))
}

function legacyFixture() {
  return {
    config: { currency: 'CNY', exchangeRate: 7.2 },
    historyDays: 180,
    days: {
      '2026-08-14': { date: '2026-08-14', input: 1000, output: 100, cacheRead: 50, calls: 2, cost: 1.5 },
      '2026-10-25': { date: '2026-10-25', input: 2000, output: 200, cacheRead: 60, calls: 3, cost: 2.5 },
      'bad-key': { cost: 999 },
    },
  }
}

test('首次启动：建自己的账本并导入历史', () => {
  const dir = tmpDir()
  const ownFile = path.join(dir, 'cost-today', 'ledger.json')
  const legacyFile = path.join(dir, 'cost-meter', 'ledger.json')
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true })
  fs.writeFileSync(legacyFile, JSON.stringify(legacyFixture()), 'utf8')

  const result = bootstrap({ ownFile, legacyFile, nowMs: Date.UTC(2026, 9, 26) })
  assert.equal(result.created, true)
  assert.equal(result.imported, 2, '两个合法日期被导入，bad-key 被跳过')
  assert.equal(fs.existsSync(ownFile), true, '必须落盘')

  const state = loadState(ownFile)
  assert.equal(state.days['2026-08-14'].cost, 1.5, '金额保留原值')
  assert.equal(state.days['bad-key'], undefined)
})

test('第二次启动：不再重复导入', () => {
  const dir = tmpDir()
  const ownFile = path.join(dir, 'own.json')
  const legacyFile = path.join(dir, 'legacy.json')
  fs.writeFileSync(legacyFile, JSON.stringify(legacyFixture()), 'utf8')

  bootstrap({ ownFile, legacyFile })
  const second = bootstrap({ ownFile, legacyFile })
  assert.equal(second.created, false)
  assert.equal(second.imported, 0)
  const state = loadState(ownFile)
  assert.equal(Object.keys(state.days).length, 2, '不许重复累加')
})

test('没有旧账本也能启动（全新机器）', () => {
  const dir = tmpDir()
  const ownFile = path.join(dir, 'own.json')
  const result = bootstrap({ ownFile, legacyFile: path.join(dir, 'nope.json') })
  assert.equal(result.created, true)
  assert.equal(result.imported, 0)
  assert.deepEqual(loadState(ownFile).days, {})
})

test('坏账本文件不会让 bootstrap 崩，而是重建', () => {
  const dir = tmpDir()
  const ownFile = path.join(dir, 'own.json')
  fs.writeFileSync(ownFile, '{ 半截 JSON', 'utf8')
  assert.equal(loadState(ownFile), null, '坏文件应当读成 null 而不是抛')
  const result = bootstrap({ ownFile, legacyFile: '' })
  assert.equal(result.created, true)
})

test('原子写：写完后不留临时文件', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'a.json')
  saveState(file, { days: {}, meta: {}, dedupe: {} })
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp-'))
  assert.deepEqual(leftovers, [], '临时文件必须已被 rename 掉')
})

test('recordCall 落盘后能被 summarize 读出来（端到端）', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'own.json')
  bootstrap({ ownFile: file, legacyFile: '' })

  const at = new Date(2026, 9, 26, 10, 0, 0)
  const result = recordCall({
    file,
    call: {
      callId: 'e2e-1',
      at,
      model: 'deepseek-v4-flash:deepseek-flash',
      cacheMiss: 1e6,
      cacheHit: 0,
      output: 0,
      sessionId: 's1',
    },
  })
  assert.equal(result.applied, true)
  assert.ok(result.costUsd > 0)

  const state = loadState(file)
  const dayKey = localDayKey(at)
  const summary = summarize({ config: { currency: 'CNY', exchangeRate: 7.2 }, days: state.days }, { dayKey })
  assert.equal(summary.calls, 1)
  assert.equal(summary.total.days, 1)
  assert.ok(summary.cost > 0)
})

test('recordCall：外部计量器复活时停手并在账本上留痕', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'own.json')
  const boot = bootstrap({ ownFile: file, legacyFile: '', nowMs: 1000 })
  boot.state.meta.importAtMs = 1000
  saveState(file, boot.state)

  const result = recordCall({
    file,
    call: { callId: 'x', at: new Date(), model: 'deepseek-flash', cacheMiss: 10 },
    foreignMtimeMs: 9_000_000,
  })
  assert.equal(result.applied, false)
  assert.equal(result.reason, 'foreign-meter-resumed')
  const state = loadState(file)
  assert.equal(state.meta.foreignMeterResumed, true, '要在账本里留痕，用户能看到为什么停了')
})

test('账本丢了（文件被删）：recordCall 说 no-ledger，而不是抛', () => {
  const dir = tmpDir()
  const result = recordCall({
    file: path.join(dir, 'missing.json'),
    call: { callId: 'x', at: new Date(), model: 'deepseek-flash', cacheMiss: 10 },
  })
  assert.equal(result.applied, false)
  assert.equal(result.reason, 'no-ledger')
})
