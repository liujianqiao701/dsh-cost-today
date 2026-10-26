/**
 * 账本读取与汇总 —— 纯函数，好单测。
 *
 * 🔑 设计原则：**不自己重算单价**。
 *   数据源是 `dsh-cost-meter` 的 `ledger.json`，它已经把每次调用按 **UTC 峰谷价**（峰时翻倍）
 *   算成了金额，还处理了历史单价变更、模型名匹配、订阅制渠道等一堆边界。
 *   我们再算一遍必然对不上账 —— 所以这里只做三件事：
 *     ① 按**本地日期**取出今天那一条；
 *     ② 把它给的 USD 金额按用户配置换成显示币种；
 *     ③ 整理成面板要的形状。
 *
 * ⚠️ 「日」的口径已核实：cost-meter 用 `localDayKey()` = `getFullYear/getMonth/getDate`，
 *    即**本地日期**。所以这里也必须用本地日期，否则凌晨 0–8 点会算到前一天（UTC 差 8 小时）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_EXCHANGE_RATE = 7.2

/** 本地日期键 `YYYY-MM-DD`（与 cost-meter 的 ledger.days 键一致）。 */
export function localDayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 账本默认路径：`$DSH_HOME/storages/cost-meter/ledger.json`。 */
export function ledgerPath(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  const home = configured === '' ? path.join(os.homedir(), '.dsh') : configured
  return path.join(home, 'storages', 'cost-meter', 'ledger.json')
}

/** 读账本（失败抛错，由上层转成人话）。 */
export function readLedger(file = ledgerPath()) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('账本顶层不是对象')
  }
  return json
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** 从 config 解析显示币种 / 符号 / 汇率，坏值一律回落到安全默认。 */
export function currencyOf(config = {}) {
  const rawCurrency = typeof config.currency === 'string' ? config.currency.trim() : ''
  const currency = rawCurrency === '' ? 'CNY' : rawCurrency
  const symbol = typeof config.symbol === 'string' && config.symbol !== ''
    ? config.symbol
    : (currency === 'CNY' ? '¥' : '$')
  const rawRate = config.exchangeRate
  const rate = typeof rawRate === 'number' && Number.isFinite(rawRate) && rawRate > 0
    ? rawRate
    : DEFAULT_EXCHANGE_RATE
  // 账本金额的计价币种：pricingCurrency 缺省按 USD（cost-meter 实测就是 'USD'）
  const pricingCurrency = config.pricingCurrency === 'CNY' ? 'CNY' : 'USD'
  return { currency, symbol, rate, pricingCurrency }
}

/** 金额从计价币种换到显示币种。 */
export function convert(amount, { currency, rate, pricingCurrency }) {
  if (!Number.isFinite(amount)) return 0
  if (pricingCurrency === currency) return amount
  if (pricingCurrency === 'USD' && currency === 'CNY') return amount * rate
  if (pricingCurrency === 'CNY' && currency === 'USD') return amount / rate
  return amount
}

/** 把账本里某一天的原始条目整理成展示用结构。 */
export function summarize(ledger, options = {}) {
  const dayKey = options.dayKey ?? localDayKey(options.now ?? new Date())
  const config = (ledger && ledger.config) || {}
  const money = currencyOf(config)
  const day = ledger && ledger.days && Object.prototype.hasOwnProperty.call(ledger.days, dayKey)
    ? ledger.days[dayKey]
    : null

  const base = {
    ok: true,
    hasData: day !== null,
    dayKey,
    currency: money.currency,
    symbol: money.symbol,
    exchangeRate: money.rate,
    pricingCurrency: money.pricingCurrency,
  }

  if (day === null) {
    return {
      ...base,
      calls: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      costUsd: 0,
      cost: 0,
      apiCost: 0,
      costPerCall: 0,
      cacheHitRate: null,
      sessions: [],
      models: [],
    }
  }

  const input = num(day.input)
  const cacheRead = num(day.cacheRead)
  const output = num(day.output)
  const costUsd = num(day.cost)
  const calls = num(day.calls)
  const sessions = Array.isArray(day.sessions) ? day.sessions : []

  // 缓存命中率 = 命中读 / (未命中读 + 命中读)
  const readTotal = input + cacheRead
  const cacheHitRate = readTotal > 0 ? cacheRead / readTotal : null

  const models = []
  const byModel = day.byProviderModel
  if (byModel && typeof byModel === 'object' && !Array.isArray(byModel)) {
    for (const [key, value] of Object.entries(byModel)) {
      if (value === null || typeof value !== 'object') continue
      models.push({
        key,
        calls: num(value.calls),
        input: num(value.input),
        output: num(value.output),
        cacheRead: num(value.cacheRead),
        cost: convert(num(value.cost), money),
      })
    }
    models.sort((a, b) => b.cost - a.cost)
  }

  return {
    ...base,
    calls,
    input,
    output,
    cacheRead,
    cacheWrite: num(day.cacheWrite),
    reasoning: num(day.reasoning),
    costUsd,
    cost: convert(costUsd, money),
    apiCost: convert(num(day.apiCost), money),
    costPerCall: calls > 0 ? convert(costUsd / calls, money) : 0,
    cacheHitRate,
    sessions: sessions
      .filter((s) => s !== null && typeof s === 'object')
      .map((s) => ({
        id: typeof s.id === 'string' ? s.id : '',
        title: typeof s.title === 'string' && s.title !== '' ? s.title : (typeof s.id === 'string' ? s.id : '（无标题会话）'),
        calls: num(s.calls),
        input: num(s.input),
        output: num(s.output),
        cacheRead: num(s.cacheRead),
        cost: convert(num(s.cost), money),
      }))
      .sort((a, b) => b.cost - a.cost),
    models,
  }
}

/**
 * 一步到位：读文件 → 汇总。
 * 返回 `{ ok: false, error }` 而不是抛，方便工具/路由统一处理。
 */
export function collect(options = {}) {
  const file = options.file ?? ledgerPath(options.env ?? process.env)
  try {
    const ledger = readLedger(file)
    const summary = summarize(ledger, options)
    let mtime = null
    try {
      mtime = fs.statSync(file).mtime.toISOString()
    } catch {
      mtime = null
    }
    return { ...summary, ledgerPath: file, ledgerMtime: mtime }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      hasData: false,
      dayKey: options.dayKey ?? localDayKey(options.now ?? new Date()),
      ledgerPath: file,
      error: message,
    }
  }
}

/** 金额格式化成 `¥38.94`；小数点太多会显得虚（账本原始精度是很长的浮点）。 */
export function formatMoney(summary, decimals = 2) {
  const symbol = summary.symbol ?? '¥'
  const value = typeof summary.cost === 'number' ? summary.cost : 0
  return `${symbol}${value.toFixed(decimals)}`
}

/** 大数缩写：17,340,289 → 17.34M */
export function formatTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return String(value)
}
