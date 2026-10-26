/**
 * 账本汇总的单元测试 —— 钱算错是这类插件最不可接受的错误，所以每个口径都钉住：
 *   · 「今天」必须是**本地日期**（用 UTC 会在凌晨 0–8 点算到前一天）
 *   · 币种换算方向不能反
 *   · 缺数据 / 缺账本要给得出人话，不能抛
 *
 * 跑：`node test/ledger.test.mjs`
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_EXCHANGE_RATE,
  collect,
  convert,
  currencyOf,
  formatMoney,
  formatTokens,
  ledgerPath,
  localDayKey,
  summarize,
} from '../lib/ledger.js'

/** 与真实账本同形状的夹具（数值取自实测账本，便于核对）。 */
function fixture() {
  return {
    version: 3,
    config: { currency: 'CNY', symbol: '¥', exchangeRate: 7.2, pricingCurrency: 'USD' },
    days: {
      '2026-10-26': {
        date: '2026-10-26',
        input: 17340289,
        output: 139021,
        cacheRead: 6614272,
        cacheWrite: 0,
        reasoning: 0,
        calls: 160,
        cost: 5.408597532,
        apiCost: 5.408597532,
        byProviderModel: {
          'deepseek-v4-flash:deepseek-flash': {
            input: 17340289,
            output: 139021,
            cacheRead: 6614272,
            calls: 160,
            cost: 5.408597532,
          },
        },
        sessions: [
          { id: 'session-a', title: '小会话', calls: 46, cost: 1.693494708, input: 5387691, output: 55071, cacheRead: 1850368 },
          { id: 'session-b', title: '测试框架AI插件开发', calls: 114, cost: 3.715102824, input: 11952598, output: 83950, cacheRead: 4763904 },
        ],
      },
    },
  }
}

test('localDayKey 用本地日期（不是 UTC）', () => {
  // 本地时间 2026-10-26 07:30 —— 此时 UTC 还是 2026-10-25 23:30，
  // 若误用 toISOString() 会得到 10-25，凌晨的账全算到前一天。
  const localMorning = new Date(2026, 9, 26, 7, 30, 0)
  assert.equal(localDayKey(localMorning), '2026-10-26')

  const localLateNight = new Date(2026, 9, 26, 23, 59, 59)
  assert.equal(localDayKey(localLateNight), '2026-10-26')

  const firstOfMonth = new Date(2026, 0, 1, 0, 0, 1)
  assert.equal(localDayKey(firstOfMonth), '2026-01-01')
})

test('ledgerPath 走 $DSH_HOME，缺省落在 ~/.dsh', () => {
  assert.equal(
    ledgerPath({ DSH_HOME: 'D:\\custom' }),
    path.join('D:\\custom', 'storages', 'cost-meter', 'ledger.json'),
  )
  const fallback = ledgerPath({})
  assert.ok(fallback.endsWith(path.join('storages', 'cost-meter', 'ledger.json')))
  // 空字符串要当没配置，不能拼出相对路径
  assert.equal(ledgerPath({ DSH_HOME: '   ' }), fallback)
})

test('currencyOf 解析显示币种，坏值回落而不是崩', () => {
  assert.deepEqual(currencyOf({ currency: 'CNY', symbol: '¥', exchangeRate: 7.2, pricingCurrency: 'USD' }), {
    currency: 'CNY',
    symbol: '¥',
    rate: 7.2,
    pricingCurrency: 'USD',
  })
  const empty = currencyOf({})
  assert.equal(empty.currency, 'CNY')
  assert.equal(empty.symbol, '¥')
  assert.equal(empty.rate, DEFAULT_EXCHANGE_RATE)
  assert.equal(empty.pricingCurrency, 'USD')
  // 汇率是 0 / 负数 / NaN 时必须回落，否则金额会变 0 或负
  assert.equal(currencyOf({ exchangeRate: 0 }).rate, DEFAULT_EXCHANGE_RATE)
  assert.equal(currencyOf({ exchangeRate: -3 }).rate, DEFAULT_EXCHANGE_RATE)
  assert.equal(currencyOf({ exchangeRate: Number.NaN }).rate, DEFAULT_EXCHANGE_RATE)
  assert.equal(currencyOf({ pricingCurrency: 'CNY' }).pricingCurrency, 'CNY')
})

test('convert 换算方向正确', () => {
  const cny = { currency: 'CNY', rate: 7.2, pricingCurrency: 'USD' }
  assert.equal(convert(5.408597532, cny), 5.408597532 * 7.2)
  const usd = { currency: 'USD', rate: 7.2, pricingCurrency: 'USD' }
  assert.equal(convert(5, usd), 5)
  const reverse = { currency: 'USD', rate: 7.2, pricingCurrency: 'CNY' }
  assert.equal(convert(7.2, reverse), 1)
  assert.equal(convert(Number.NaN, cny), 0)
})

test('summarize 汇总今日：金额、命中率、排序都对', () => {
  const s = summarize(fixture(), { dayKey: '2026-10-26' })
  assert.equal(s.ok, true)
  assert.equal(s.hasData, true)
  assert.equal(s.dayKey, '2026-10-26')
  assert.equal(s.currency, 'CNY')
  assert.equal(s.symbol, '¥')
  // 5.408597532 USD × 7.2 = 38.9419...
  assert.ok(Math.abs(s.cost - 38.9419) < 0.001, `今日金额应为 ¥38.94，实际 ${s.cost}`)
  assert.ok(Math.abs(s.costUsd - 5.408597532) < 1e-9)
  assert.equal(s.calls, 160)
  // 命中率 = 6614272 / (17340289 + 6614272) = 27.6%
  assert.ok(Math.abs(s.cacheHitRate - 0.276) < 0.002, `命中率应约 27.6%，实际 ${s.cacheHitRate}`)
  // 每次平均 = 38.94 / 160 ≈ 0.243
  assert.ok(Math.abs(s.costPerCall - 0.2434) < 0.002, `平均每次应约 ¥0.243，实际 ${s.costPerCall}`)
  // 会话按金额降序
  assert.equal(s.sessions.length, 2)
  assert.equal(s.sessions[0].title, '测试框架AI插件开发')
  assert.ok(s.sessions[0].cost > s.sessions[1].cost)
  assert.ok(Math.abs(s.sessions[0].cost - 3.715102824 * 7.2) < 1e-6)
  // 按模型
  assert.equal(s.models.length, 1)
  assert.equal(s.models[0].key, 'deepseek-v4-flash:deepseek-flash')
})

test('summarize 遇到没有记录的那一天：给零，不报错', () => {
  const s = summarize(fixture(), { dayKey: '1999-01-01' })
  assert.equal(s.ok, true)
  assert.equal(s.hasData, false)
  assert.equal(s.cost, 0)
  assert.equal(s.calls, 0)
  assert.equal(s.cacheHitRate, null)
  assert.deepEqual(s.sessions, [])
})

test('summarize 容忍账本字段缺失/类型不对', () => {
  const broken = { config: {}, days: { '2026-10-26': { calls: 'x', cost: null, sessions: 'nope' } } }
  const s = summarize(broken, { dayKey: '2026-10-26' })
  assert.equal(s.calls, 0)
  assert.equal(s.cost, 0)
  assert.deepEqual(s.sessions, [])
  assert.deepEqual(s.models, [])
})

test('collect 读真实文件；文件不存在时返回 ok:false 而不是抛', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-today-'))
  const file = path.join(dir, 'ledger.json')
  fs.writeFileSync(file, JSON.stringify(fixture()), 'utf8')
  const ok = collect({ file, dayKey: '2026-10-26' })
  assert.equal(ok.ok, true)
  assert.equal(ok.cost > 38 && ok.cost < 39, true)
  assert.ok(typeof ok.ledgerMtime === 'string', '应当带上账本更新时间')

  const missing = collect({ file: path.join(dir, 'nope.json'), dayKey: '2026-10-26' })
  assert.equal(missing.ok, false)
  assert.ok(typeof missing.error === 'string' && missing.error.length > 0)

  const garbage = path.join(dir, 'bad.json')
  fs.writeFileSync(garbage, 'not json', 'utf8')
  const bad = collect({ file: garbage, dayKey: '2026-10-26' })
  assert.equal(bad.ok, false)
})

test('格式化：金额两位小数，大数缩写', () => {
  assert.equal(formatMoney({ cost: 38.9419, symbol: '¥' }), '¥38.94')
  assert.equal(formatMoney({ cost: 0, symbol: '¥' }), '¥0.00')
  assert.equal(formatMoney({ cost: 1.005, symbol: '$' }, 1), '$1.0')
  assert.equal(formatTokens(17340289), '17.34M')
  assert.equal(formatTokens(139021), '139.0k')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(2_500_000_000), '2.50B')
  assert.equal(formatTokens(null), '—')
})
