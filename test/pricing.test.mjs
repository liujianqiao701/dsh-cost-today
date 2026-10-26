import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  PEAK_WINDOWS_UTC,
  OFF_PEAK,
  MODEL_ALIASES,
  PEAK_MULTIPLIER,
  beijingDayKey,
  isPeak,
  normalizeModel,
  priceCall,
  priceTable,
  unitPrice,
} from '../lib/pricing.js'

// 2026-10-26T02:00Z —— 下面每条用例都先用 getUTCDay() 自证"这天真的是周一"，
// 免得某天我记错了星期，测试还在"通过"（那是最难发现的假绿灯）。
const MONDAY = Date.UTC(2026, 9, 26, 2, 0, 0)
const SATURDAY = Date.UTC(2026, 9, 24, 2, 0, 0)

test('前提自检：选的两个日期确实是周一 / 周六', () => {
  assert.equal(new Date(MONDAY).getUTCDay(), 1, '2026-10-26 应当是周一')
  assert.equal(new Date(SATURDAY).getUTCDay(), 6, '2026-10-24 应当是周六')
})

test('官方口径：peak 单价正好是 off-peak 的两倍', () => {
  // 价目页原文："Off-peak rates are half of the peak rates."
  const peakAt = Date.UTC(2026, 9, 26, 2) // 周一 02:00Z，落在 01:00–04:00
  for (const model of Object.keys(OFF_PEAK)) {
    const off = unitPrice(model, Date.UTC(2026, 9, 26, 12), {})
    const peak = unitPrice(model, peakAt, {})
    assert.equal(off.peak, false)
    assert.equal(peak.peak, true)
    for (const key of ['cacheHit', 'cacheMiss', 'output']) {
      assert.equal(
        Number((peak[key] / off[key]).toFixed(10)),
        2,
        `${model}.${key} 峰时应当是平时两倍`,
      )
    }
  }
})

test('峰时窗口边界：左闭右开，01:00 / 06:00 是峰，04:00 / 10:00 已经不是', () => {
  const onMonday = (hour, minute = 0) => Date.UTC(2026, 9, 26, hour, minute)
  assert.equal(isPeak(onMonday(0, 59)), false, '00:59 不在窗口内')
  assert.equal(isPeak(onMonday(1, 0)), true, '01:00 进窗口')
  assert.equal(isPeak(onMonday(3, 59)), true, '03:59 仍在窗口')
  assert.equal(isPeak(onMonday(4, 0)), false, '04:00 出窗口')
  assert.equal(isPeak(onMonday(5, 59)), false, '05:59 两段之间')
  assert.equal(isPeak(onMonday(6, 0)), true, '06:00 进第二段')
  assert.equal(isPeak(onMonday(9, 59)), true, '09:59 仍在第二段')
  assert.equal(isPeak(onMonday(10, 0)), false, '10:00 出第二段')
  assert.equal(isPeak(onMonday(23, 0)), false, '深夜是 off-peak')
  assert.deepEqual(PEAK_WINDOWS_UTC, [[1, 4], [6, 10]])
})

test('周末整日 off-peak（周六 02:00Z 也不是峰时）', () => {
  assert.equal(isPeak(SATURDAY), false)
  assert.equal(new Date(SATURDAY).getUTCHours(), 2, '确认这个时刻本来是峰时窗口内')
})

test('中国法定节假日整日 off-peak（按北京日历日判定）', () => {
  const at = Date.UTC(2026, 9, 26, 2) // 周一 02:00Z = 北京 10:00
  assert.equal(beijingDayKey(at), '2026-10-26')
  assert.equal(isPeak(at), true, '不配节假日时是峰时')
  assert.equal(isPeak(at, { holidays: ['2026-10-26'] }), false, '配了节假日就整日 off-peak')
  assert.equal(isPeak(at, { holidays: ['2026-10-25'] }), true, '别的日期不影响')
})

test('北京时间跨界：UTC 20:00 已经是北京的第二天', () => {
  assert.equal(beijingDayKey(Date.UTC(2026, 9, 26, 20, 0)), '2026-10-27')
  assert.equal(beijingDayKey(Date.UTC(2026, 9, 26, 15, 59)), '2026-10-26')
})

test('模型归一：provider:model 与旧名都归到 flash', () => {
  assert.equal(normalizeModel('deepseek-v4-flash:deepseek-flash'), 'deepseek-flash')
  assert.equal(normalizeModel('deepseek-v4-flash'), 'deepseek-flash')
  assert.equal(normalizeModel('deepseek-flash'), 'deepseek-flash')
  assert.equal(normalizeModel('DeepSeek-Flash'), 'deepseek-flash')
  assert.equal(normalizeModel('deepseek-v4-flash-vision-exp'), 'deepseek-flash')
  assert.equal(normalizeModel('deepseek-v4-pro'), 'deepseek-v4-pro')
  assert.equal(normalizeModel('some-new-model'), null, '认不出来就是 null，不许猜')
  assert.equal(normalizeModel(''), null)
  assert.equal(normalizeModel(null), null)
})

test('认不出的模型：按 flash 计价但必须标记 unknownModel', () => {
  const at = Date.UTC(2026, 9, 26, 12) // 周一 12:00Z = off-peak
  const result = priceCall({ model: 'gpt-unknown', at, cacheMiss: 1e6 }, {})
  assert.equal(result.unknownModel, true, '必须能被上层识别为"未计价模型"')
  assert.equal(result.costUsd, OFF_PEAK['deepseek-flash'].cacheMiss, '先按 flash 兜底')
})

test('金额算术：1M miss + 1M hit + 1M output', () => {
  const offPeakAt = Date.UTC(2026, 9, 26, 12)
  const peakAt = Date.UTC(2026, 9, 26, 2)
  const call = { model: 'deepseek-flash', cacheMiss: 1e6, cacheHit: 1e6, output: 1e6 }

  const off = priceCall({ ...call, at: offPeakAt }, {})
  assert.equal(off.peak, false)
  assert.equal(Number(off.costUsd.toFixed(6)), 0.753) // 0.15 + 0.003 + 0.6

  const peak = priceCall({ ...call, at: peakAt }, {})
  assert.equal(peak.peak, true)
  assert.equal(Number(peak.costUsd.toFixed(6)), 1.506) // 正好两倍
})

test('脏 token 值当 0 处理，不产生 NaN / 负金额', () => {
  const at = Date.UTC(2026, 9, 26, 12)
  for (const bad of [-100, 'abc', null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = priceCall({ model: 'deepseek-flash', at, cacheMiss: bad, cacheHit: bad, output: bad }, {})
    assert.equal(result.costUsd, 0, `脏值 ${String(bad)} 应当算 0`)
    assert.ok(Number.isFinite(result.costUsd))
  }
})

test('字符串 token 数（"1234"）能算，不当成 0', () => {
  const at = Date.UTC(2026, 9, 26, 12)
  const result = priceCall({ model: 'deepseek-flash', at, cacheMiss: '1000000', cacheHit: '0', output: '0' }, {})
  assert.equal(Number(result.costUsd.toFixed(6)), 0.15)
})

test('priceTable 的峰时价 = 平时价 × PEAK_MULTIPLIER（界面标价与实算同源）', () => {
  const table = priceTable()
  assert.ok(table.length >= 1)
  for (const row of table) {
    for (const key of ['cacheHit', 'cacheMiss', 'output']) {
      assert.equal(row.peak[key], row.offPeak[key] * PEAK_MULTIPLIER, `${row.model}.${key} 的峰时价不对`)
    }
  }
})

test('priceTable 报的价和 unitPrice 真正算出来的价一致（防两套数）', () => {
  // 峰时：UTC 03:00 周二；平时：UTC 12:00 周二 —— 两边都必须对得上
  const peakAt = new Date(Date.UTC(2026, 9, 27, 3, 0, 0))
  const offAt = new Date(Date.UTC(2026, 9, 27, 12, 0, 0))
  for (const row of priceTable()) {
    const peak = unitPrice(row.model, peakAt)
    const off = unitPrice(row.model, offAt)
    assert.equal(peak.peak, true)
    assert.equal(off.peak, false)
    for (const key of ['cacheHit', 'cacheMiss', 'output']) {
      assert.equal(peak[key], row.peak[key], `${row.model}.${key} 峰时：表里和算出来不一致`)
      assert.equal(off[key], row.offPeak[key], `${row.model}.${key} 平时：表里和算出来不一致`)
    }
  }
})
