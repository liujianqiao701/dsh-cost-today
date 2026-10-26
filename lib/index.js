/**
 * dsh-cost-today · 宿主半身
 *
 * 三个入口：工具 `cost_today`、命令 `/cost`、数据路由 `/api/dsh-cost-today/report`（供 GUI 面板）。
 *
 * 🔴 三条实测契约（每条都真踩过，改动前别删注释）：
 *   ① **零静态 `@deepseek-ai/*` import** —— link 安装时 Node 解析不到 profile 的 node_modules，
 *      只能用 `serviceOf` 在运行时取服务。
 *   ② `apply()` 执行时 **`tools` / `webServer` 还没挂载** —— 直接取会拿到空、注册静默不发生。
 *      所以每段注册都返回布尔，false 就异步重试。
 *   ③ 工具 `parameters` 必须是**完整 JSON Schema**；`output.schema` 的 `required` 必须放**对象层**。
 *      写错会让整个会话发不出消息，或工具静默注册不上。
 */
import { collect, formatMoney, formatTokens, localDayKey } from './ledger.js'

const TOOL_REGISTER_METHODS = ['register', 'defineTool', 'define', 'add']
const ROUTE_PATH = '/api/dsh-cost-today/report'
const RETRY_DELAYS_MS = [150, 300, 600, 1200, 2000, 3000]

function warn(message) {
  try {
    process.stderr.write(`dsh-cost-today: ${message}\n`)
  } catch {
    /* stderr 都写不了就算了 */
  }
}

function msgOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 取一个 cordis 服务；拿不到返回 undefined，不抛。 */
function serviceOf(ctx, serviceName) {
  for (const getter of [
    () => ctx?.get?.(serviceName),
    () => ctx?.[serviceName],
    () => ctx?.root?.[serviceName],
  ]) {
    try {
      const value = getter()
      if (value !== undefined && value !== null) return value
    } catch {
      /* 换下一个位置找 */
    }
  }
  return undefined
}

/** 在目标对象上按候选名找第一个可调用方法。 */
function pickMethod(target, names) {
  if (target === undefined || target === null) return undefined
  for (const name of names) {
    try {
      const fn = target[name]
      if (typeof fn === 'function') return { fn: fn.bind(target), via: name }
    } catch {
      /* 属性访问本身可能抛（getter），跳过 */
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/** 一行摘要，给徽标/命令用。 */
export function renderOneLine(summary) {
  if (!summary.ok) return `今日花费读不到：${summary.error}`
  if (!summary.hasData) return `今日（${summary.dayKey}）还没有用量记录。`
  return `今日 ${formatMoney(summary)}（${summary.calls} 次调用${summary.cacheHitRate === null ? '' : `，缓存命中 ${(summary.cacheHitRate * 100).toFixed(1)}%`}）`
}

/** 明细报告，给工具/命令用。 */
export function renderReport(summary, options = {}) {
  const lines = []
  const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : 10

  if (!summary.ok) {
    lines.push(`今日花费读不到：${summary.error}`)
    lines.push('')
    lines.push(`账本路径：${summary.ledgerPath}`)
    lines.push('账本由 `dsh-cost-meter` 维护（`$DSH_HOME/storages/cost-meter/ledger.json`）。')
    lines.push('如果它没装或从没跑过，这里就没有数据 —— 本插件**不自己估价**，只读它算好的金额。')
    return lines.join('\n')
  }

  if (!summary.hasData) {
    lines.push(`今日（${summary.dayKey}）还没有用量记录 —— 今天还没发起过模型调用，或账本还没落盘。`)
    lines.push('')
    lines.push(`账本路径：${summary.ledgerPath}`)
    return lines.join('\n')
  }

  const money = (value) => `${summary.symbol}${value.toFixed(2)}`
  lines.push(`今日花费（${summary.dayKey}）：**${formatMoney(summary)}**`)
  lines.push('')
  lines.push(`- 调用次数：${summary.calls} 次${summary.calls > 0 ? `，平均每次 ${money(summary.costPerCall)}` : ''}`)
  if (summary.pricingCurrency !== summary.currency) {
    lines.push(`- 账本原币金额：$${summary.costUsd.toFixed(4)} ${summary.pricingCurrency} × ${summary.exchangeRate}（汇率）`)
  }
  lines.push(`- 输入：${formatTokens(summary.input)} token（未命中缓存）`)
  lines.push(`- 缓存命中：${formatTokens(summary.cacheRead)} token${summary.cacheHitRate === null ? '' : `（命中率 ${(summary.cacheHitRate * 100).toFixed(1)}%）`}`)
  lines.push(`- 输出：${formatTokens(summary.output)} token`)

  if (summary.models.length > 0) {
    lines.push('')
    lines.push('按模型：')
    for (const model of summary.models.slice(0, limit)) {
      lines.push(`- ${money(model.cost)}  ${model.key}（${model.calls} 次）`)
    }
  }

  if (summary.sessions.length > 0) {
    lines.push('')
    lines.push('按会话：')
    for (const session of summary.sessions.slice(0, limit)) {
      lines.push(`- ${money(session.cost)}  ${session.title}（${session.calls} 次）`)
    }
    if (summary.sessions.length > limit) lines.push(`- …另有 ${summary.sessions.length - limit} 个会话`)
  }

  lines.push('')
  lines.push(`账本：${summary.ledgerPath}${summary.ledgerMtime === null || summary.ledgerMtime === undefined ? '' : `（更新于 ${new Date(summary.ledgerMtime).toLocaleString('zh-CN')}）`}`)
  lines.push('金额由 `dsh-cost-meter` 按官方单价 + UTC 峰谷规则算好后写入账本，本插件只做「按本地日汇总 + 币种换算」。')
  return lines.join('\n')
}

/** 收集 + 渲染，工具与命令共用。 */
function reportOf(args = {}) {
  const summary = collect({ dayKey: typeof args.day === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(args.day) ? args.day : localDayKey() })
  return { summary, text: renderReport(summary, { limit: args.limit }) }
}

// ---------------------------------------------------------------------------
// ① 工具
// ---------------------------------------------------------------------------

const TOOL = {
  name: 'cost_today',
  description:
    '查今天（本地日期）花了多少钱：从 dsh-cost-meter 的账本读当日金额，换算成显示币种，'
    + '并给出调用次数、输入/缓存命中/输出 token、按模型与会话的拆分。'
    + '用户问「今天花了多少钱」「今日消费」「这个月烧了多少」「token 花了多少费用」时用它。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      day: {
        type: 'string',
        description: '查哪一天，格式 YYYY-MM-DD（本地日期）。省略 = 今天。',
      },
      limit: {
        type: 'number',
        description: '按模型/按会话各显示前多少条，默认 10。',
      },
    },
    required: [],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'dataJson', 'cost', 'dayKey'],
      properties: {
        text: { type: 'string' },
        dataJson: { type: 'string' },
        cost: { type: 'number' },
        dayKey: { type: 'string' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args) {
    const { summary, text } = reportOf(args ?? {})
    return {
      text,
      dataJson: JSON.stringify({
        ok: summary.ok,
        hasData: summary.hasData,
        dayKey: summary.dayKey,
        cost: summary.cost ?? 0,
        costUsd: summary.costUsd ?? 0,
        calls: summary.calls ?? 0,
        sessions: (summary.sessions ?? []).slice(0, 10),
      }),
      cost: typeof summary.cost === 'number' ? summary.cost : 0,
      dayKey: summary.dayKey ?? '',
    }
  },
}

// ---------------------------------------------------------------------------
// ② 斜杠命令
// ---------------------------------------------------------------------------

/**
 * ⚠️ 命令契约：字段名是 **`handler`**（不是 `run`）；收到一个对象；**必须返回** `{ kind, text }`。
 */
function commandsOf() {
  return [
    {
      name: 'cost',
      description: '看今天花了多少钱（等价于 cost_today 工具，但不消耗模型回合）',
      input: { hint: '可选：YYYY-MM-DD 查某一天' },
      handler: (invocation) => {
        try {
          const raw = String(invocation?.rawInput ?? '').trim()
          const { text } = reportOf(/^\d{4}-\d{2}-\d{2}$/u.test(raw) ? { day: raw } : {})
          return { kind: 'success', text }
        } catch (error) {
          return { kind: 'error', text: `读账本失败：${msgOf(error)}` }
        }
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// ③ 数据路由（GUI 面板用）
// ---------------------------------------------------------------------------

function registerHttpRoute(ctx) {
  const webServer = serviceOf(ctx, 'webServer')
  const register = pickMethod(webServer, ['register'])
  if (register === undefined) return false
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? ROUTE_PATH, 'http://127.0.0.1')
      const day = url.searchParams.get('day')
      const { summary } = reportOf(typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(day) ? { day } : {})
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(summary))
    } catch (error) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, error: msgOf(error) }))
    }
  }
  register.fn({ kind: 'exact', path: ROUTE_PATH, handler })
  warn(`已注册数据路由 ${ROUTE_PATH}（供 GUI 面板读取）。`)
  return true
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

function withRetry(label, step, attempt = 0) {
  let done = true
  try {
    done = step() !== false
  } catch (error) {
    warn(`注册${label}时发生异常（已忽略）—— ${msgOf(error)}`)
  }
  if (done) return
  if (attempt >= RETRY_DELAYS_MS.length) {
    warn(`${label}：服务始终没就绪，放弃注册（其余功能不受影响）。`)
    return
  }
  const timer = setTimeout(() => withRetry(label, step, attempt + 1), RETRY_DELAYS_MS[attempt])
  if (typeof timer?.unref === 'function') timer.unref()
}

function registerToolStep(ctx) {
  const tools = serviceOf(ctx, 'tools')
  const register = pickMethod(tools, TOOL_REGISTER_METHODS)
  if (register === undefined) return false
  register.fn(TOOL)
  warn(`已注册工具 ${TOOL.name}。`)
  return true
}

function registerCommandsStep(ctx) {
  const commands = serviceOf(ctx, 'commands')
  const register = pickMethod(commands, ['register'])
  if (register === undefined) return false
  let ok = 0
  for (const def of commandsOf()) {
    try {
      register.fn(def)
      ok += 1
    } catch (error) {
      warn(`注册命令 /${def.name} 失败（已跳过）—— ${msgOf(error)}`)
    }
  }
  if (ok > 0) warn('已注册命令 /cost。')
  return true
}

export function apply(ctx) {
  withRetry('工具', () => registerToolStep(ctx))
  withRetry('命令', () => registerCommandsStep(ctx))
  withRetry('数据路由', () => registerHttpRoute(ctx))
}

export { ROUTE_PATH }
