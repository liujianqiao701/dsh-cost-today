// 单价与峰谷时段 —— 全部取自 DeepSeek 官方价目页，**不猜、不从别处推断**。
// 来源：https://api-docs.deepseek.com/quick_start/pricing（2026-10-26 抓取核对）
//
// 官方口径（原文）：
//   · "Off-peak rates are half of the peak rates."
//   · "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday,
//      excluding Chinese public holidays. All other hours are off-peak, including
//      weekends and Chinese public holidays in full."
//   · "Use `deepseek-flash` as the model name. The legacy names `deepseek-v4-flash`
//      and `deepseek-v4-flash-vision-exp` are still accepted ... billed at the Flash price."
//
// 单位：USD / 1M tokens。本文件只存 **off-peak**，peak 一律 ×2 推导 ——
// 两边各写一遍，迟早会写歪其中一个，而且写歪了没人看得出来。

export const PRICE_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing'
export const PRICE_CHECKED_AT = '2026-10-26'

/** 峰时窗口，UTC 小时，左闭右开：[[1,4], [6,10]] = 01:00–04:00 与 06:00–10:00。 */
export const PEAK_WINDOWS_UTC = [
  [1, 4],
  [6, 10],
]

/** off-peak 单价（USD / 1M tokens）。 */
export const OFF_PEAK = {
  'deepseek-flash': { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
  'deepseek-v4-pro': { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
}

/** 峰时相对平时价的倍数（官方口径：峰时全部翻倍）。 */
export const PEAK_MULTIPLIER = 2

/** 旧名 / 带 provider 前缀的写法 → 规范模型名。 */
export const MODEL_ALIASES = {
  'deepseek-flash': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4-pro': 'deepseek-v4-pro',
  'deepseek-pro': 'deepseek-v4-pro',
}

/**
 * 把内核给的模型串归一成价目表里的键。
 * 账本里实测的形态是 `deepseek-v4-flash:deepseek-flash`（provider:model），
 * 所以取最后一段；认不出来返回 null（**不猜价格**，让上层显式标记"未计价"）。
 */
export function normalizeModel(raw) {
  if (typeof raw !== 'string') return null
  const text = raw.trim().toLowerCase()
  if (text === '') return null
  const tail = text.split(/[:/]/u).filter((part) => part !== '').pop()
  if (tail === undefined) return null
  if (Object.prototype.hasOwnProperty.call(MODEL_ALIASES, tail)) return MODEL_ALIASES[tail]
  if (Object.prototype.hasOwnProperty.call(MODEL_ALIASES, text)) return MODEL_ALIASES[text]
  return null
}

function toDate(at) {
  if (at instanceof Date) return at
  if (typeof at === 'number') return new Date(at)
  if (typeof at === 'string') {
    const parsed = new Date(at)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return null
}

/** 北京时间的日历日（`YYYY-MM-DD`）—— 法定节假日按北京日历算，不是 UTC 日历。 */
export function beijingDayKey(at) {
  const date = toDate(at)
  if (date === null) return null
  const shifted = new Date(date.getTime() + 8 * 3600 * 1000)
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${month}-${day}`
}

/**
 * 这一刻是不是峰时？
 *
 * 三条判据缺一不可：① UTC 小时落在窗口内；② UTC 星期一到星期五；③ 不是中国法定节假日。
 *
 * ⚠️ `holidays` 必须由调用方给（`['2026-10-01', ...]`，北京日历日）。**默认空数组**：
 * 节假日整整一天都该按 off-peak，漏掉的后果是节假日那 7 个小时被按峰时**多算一倍**。
 * 宁可让它露出来，也不要假装知道节假日 —— 我不知道 2027 年的放假安排，编一份出来比留空更糟。
 */
export function isPeak(at, options = {}) {
  const date = toDate(at)
  if (date === null) return false
  const holidays = Array.isArray(options.holidays) ? options.holidays : []
  const dayKey = beijingDayKey(date)
  if (dayKey !== null && holidays.includes(dayKey)) return false
  const weekday = date.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const hour = date.getUTCHours()
  return PEAK_WINDOWS_UTC.some(([from, to]) => hour >= from && hour < to)
}

/**
 * 某模型在某时刻的实际单价。
 * 认不出模型 → 返回 flash 的价 + `unknownModel: true`（上层据此在面板上标注）。
 */
export function unitPrice(model, at, options = {}) {
  const canonical = normalizeModel(model)
  const base = OFF_PEAK[canonical === null ? 'deepseek-flash' : canonical]
  const peak = isPeak(at, options)
  const factor = peak ? PEAK_MULTIPLIER : 1
  return {
    canonicalModel: canonical,
    unknownModel: canonical === null,
    peak,
    cacheHit: base.cacheHit * factor,
    cacheMiss: base.cacheMiss * factor,
    output: base.output * factor,
  }
}

/**
 * 面板展示用的价目表：每个模型摊成「平时 / 峰时」两行、三列（命中 / 未命中 / 输出）。
 *
 * **只从 `OFF_PEAK` + `PEAK_MULTIPLIER` 推出来**，不另写一份字面量 ——
 * 界面上显示的单价必须和真正算钱的单价同源，否则改价那天必然对不上。
 */
export function priceTable() {
  return Object.keys(OFF_PEAK).map((model) => {
    const off = OFF_PEAK[model]
    return {
      model,
      offPeak: { cacheHit: off.cacheHit, cacheMiss: off.cacheMiss, output: off.output },
      peak: {
        cacheHit: off.cacheHit * PEAK_MULTIPLIER,
        cacheMiss: off.cacheMiss * PEAK_MULTIPLIER,
        output: off.output * PEAK_MULTIPLIER,
      },
    }
  })
}

function num(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 一次调用的金额（USD）。
 *
 * 入参里 `cacheMiss` / `cacheHit` / `output` 都是 token 数。
 * 若调用方只拿得到「输入总数」（promptTokens），先自己减去 cacheHit 再传 —— 这个函数
 * **不做那种猜测**：猜错方向会让金额翻倍或腰斩，而且账面上看不出来。
 */
export function priceCall(call, options = {}) {
  const item = call === null || typeof call !== 'object' ? {} : call
  const price = unitPrice(item.model, item.at, options)
  const cacheMiss = num(item.cacheMiss)
  const cacheHit = num(item.cacheHit)
  const output = num(item.output)
  const costUsd =
    (cacheMiss * price.cacheMiss + cacheHit * price.cacheHit + output * price.output) / 1e6
  return {
    costUsd,
    peak: price.peak,
    canonicalModel: price.canonicalModel,
    unknownModel: price.unknownModel,
    price,
    tokens: { cacheMiss, cacheHit, output },
  }
}
