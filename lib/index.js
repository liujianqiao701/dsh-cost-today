/**
l*ldsh-cost-today · 宿主半身
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
import { collect, formatMoney, formatTokens, legacyLedgerPath, localDayKey, ownLedgerPath } from './ledger.js'
import { attachCapture, backfill } from './capture.js'
import { bootstrap, markBackfilled, recordCall } from './store.js'

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
  const tail = summary.total !== undefined && summary.total.days > 0
    ? ` · 累计 ${summary.symbol}${summary.total.cost.toFixed(2)}`
    : ''
  if (!summary.hasData) return `今日（${summary.dayKey}）还没有用量记录${tail}。`
  return `今日 ${formatMoney(summary)}（${summary.calls} 次调用${summary.cacheHitRate === null ? '' : `，缓存命中 ${(summary.cacheHitRate * 100).toFixed(1)}%`}）${tail}`
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

  const money = (value) => `${summary.symbol}${value.toFixed(2)}`

  if (!summary.hasData) {
    lines.push(`今日（${summary.dayKey}）还没有用量记录 —— 今天还没发起过模型调用，或账本还没落盘。`)
    if (summary.total !== undefined && summary.total.days > 0) {
      lines.push('')
      lines.push(`- 本月（${summary.month.monthKey}）：${money(summary.month.cost)}（${summary.month.days} 天）`)
      lines.push(`- 累计（${summary.total.since} 起，${summary.total.days} 天）：**${money(summary.total.cost)}**`)
    }
    lines.push('')
    lines.push(`账本路径：${summary.ledgerPath}`)
    return lines.join('\n')
  }

  lines.push(`今日花费（${summary.dayKey}）：**${formatMoney(summary)}**`)
  lines.push('')
  // 本月 / 累计 —— 「今天花了多少」之外，用户还想知道总量。
  if (summary.total !== undefined && summary.total.days > 0) {
    const retention = summary.retentionDays === null || summary.retentionDays === undefined
      ? ''
      : `，账本保留 ${summary.retentionDays} 天`
    lines.push(`- 本月（${summary.month.monthKey}）：${money(summary.month.cost)}（${summary.month.days} 天）`)
    lines.push(`- **累计**（${summary.total.since} 起，${summary.total.days} 天${retention}）：**${money(summary.total.cost)}**`)
    lines.push('')
  }
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
  lines.push('金额由本插件自记账本按 DeepSeek 官方单价（含 UTC 峰谷、周末与节假日规则）逐次累加；历史部分一次性导入自 cost-meter。')
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
    '查今天（本地日期）花了多少钱：从插件自记账本读当日金额，换算成显示币种，'
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
        total: summary.total === undefined ? null : {
          days: summary.total.days,
          since: summary.total.since,
          until: summary.total.until,
          cost: summary.total.cost,
          costUsd: summary.total.costUsd,
          calls: summary.total.calls,
        },
        month: summary.month === undefined ? null : {
          monthKey: summary.month.monthKey,
          days: summary.month.days,
          cost: summary.month.cost,
          calls: summary.month.calls,
        },
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
      res.end(JSON.stringify({ ...summary, capture: captureDebug() }))
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

/**
 * 自计量的运行时状态（`apply` 时初始化一次）。
 * 暴露出来是为了能在测试/排障时直接看"账本建没建起来、导入了几天"。
 */
export const runtime = {
  ownFile: null,
  legacyFile: null,
  state: null,
  created: false,
  imported: 0,
  importAtMs: 0,
  error: null,
  recorded: 0,
  rejected: 0,
  lastRejectReason: null,
  capture: null,
  backfill: null,
  debug: { eventsSeen: 0, lastEvent: null, skips: 0, lastSkip: null },
}

/**
 * 采集诊断快照。
 *
 * 用途很具体：`session/event` 什么都收不到时，**没有任何异常会抛出来** ——
 * 插件看起来一切正常，只是数字不涨。靠这个把"内核实际传进来什么形状"暴露出来，
 * 否则只能靠猜。
 */
export function captureDebug() {
  return {
    attached: runtime.capture === null ? null : runtime.capture.attached === true,
    attachReason: runtime.capture === null ? null : runtime.capture.reason ?? null,
    eventsSeen: runtime.debug.eventsSeen,
    skips: runtime.debug.skips,
    lastSkip: runtime.debug.lastSkip,
    lastEvent: runtime.debug.lastEvent,
    recorded: runtime.recorded,
    rejected: runtime.rejected,
    lastRejectReason: runtime.lastRejectReason,
    backfill: runtime.backfill,
    ledgerPath: runtime.ownFile,
  }
}

/** cost-meter 账本的 mtime —— 用来判断它是否"复活"（复活就停手，防重复计量）。 */
function legacyMtimeMs() {
  try {
    return fs.statSync(runtime.legacyFile).mtimeMs
  } catch {
    return undefined
  }
}

/**
 * 初始化自记账本：不存在就建，并把 cost-meter 的历史一次性导进来。
 * **失败不致命** —— 读数字那条链路仍然能工作（退回读旧账本），
 * 所以这里只告警、不抛，不能因为记账失败把整个插件带崩。
 */
function initMetering() {
  try {
    runtime.ownFile = ownLedgerPath()
    runtime.legacyFile = legacyLedgerPath()
    const result = bootstrap({ ownFile: runtime.ownFile, legacyFile: runtime.legacyFile })
    runtime.state = result.state
    runtime.created = result.created
    runtime.imported = result.imported
    runtime.importAtMs = Number(result.state?.meta?.importAtMs) || 0
    if (result.created) {
      warn(
        result.imported > 0
          ? `自记账本已建立，并从 cost-meter 导入了 ${result.imported} 天历史。`
          : '自记账本已建立（没有可导入的历史）。',
      )
    }
  } catch (error) {
    runtime.error = msgOf(error)
    warn(`自记账本初始化失败（不影响读取已有数字）—— ${runtime.error}`)
  }
}

/** 记一次调用。由使用量钩子调用；记账失败只累加计数，不抛。 */
export function recordUsage(call, options = {}) {
  if (runtime.ownFile === null) return { applied: false, reason: 'not-initialized', costUsd: 0 }
  try {
    const result = recordCall({
      file: runtime.ownFile,
      call,
      state: runtime.state,
      foreignMtimeMs: options.foreignMtimeMs ?? legacyMtimeMs(),
    })
    if (result.applied) {
      runtime.recorded += 1
    } else {
      runtime.rejected += 1
      runtime.lastRejectReason = result.reason
    }
    return result
  } catch (error) {
    runtime.error = msgOf(error)
    return { applied: false, reason: 'record-failed', costUsd: 0 }
  }
}

/**
 * 回补「导入之后、启动之前」那段空档。
 *
 * 起点取 `max(导入时刻, 上次回补时刻)`：只补导入之后的事件，否则会把 cost-meter
 * 已经记过（并已导入）的历史再加一遍，总额翻倍且无人能核对。
 * 用 `sessionQuery` 而不是实时订阅 —— 实时订阅只覆盖"挂上之后"的事件。
 */
async function runBackfill(ctx) {
  const sinceMs = Math.max(runtime.importAtMs, Number(runtime.state?.meta?.backfillUntilMs) || 0)
  const startedAt = Date.now()
  try {
    const result = await backfill(ctx, {
      sinceMs,
      onCall: (call) => recordUsage(call, { foreignMtimeMs: undefined }),
    })
    runtime.backfill = { ...result, sinceMs }
    if (result.calls > 0) warn(`回补历史用量：${result.calls} 次调用（自 ${new Date(sinceMs).toLocaleString('zh-CN')}）。`)
    if (result.error !== null) warn(`回补历史用量没做成（不影响后续记账）—— ${result.error}`)
    // 只在真的跑成功时推进游标；失败就下次再试，不能把没读到的区间标成"已读"
    if (result.error === null) {
      markBackfilled(runtime.ownFile, startedAt)
      // ⚠️ 必须同步到**内存里这份 state**：markBackfilled 落盘的是它自己从磁盘新读的副本，
      // 而之后每次记账写的都是 runtime.state —— 不同步的话下一次记账就把游标覆盖掉了，
      // 结果每次启动都重扫一遍（去重能挡住重复计费，但白扫、且看起来像"又有新数据"）。
      if (runtime.state !== null && runtime.state !== undefined && runtime.state.meta !== undefined) {
        runtime.state.meta.backfillUntilMs = startedAt
      }
    }
  } catch (error) {
    runtime.backfill = { error: msgOf(error), sinceMs }
  }
}

export function apply(ctx) {
  initMetering()

  // ① 实时采集：内核在 append 提交后推送 `session/event`，
  //    且 **seed（恢复的历史）事件不会走这条路** —— 重启不会重放，天然不重复记账。
  try {
    const capture = attachCapture(ctx, {
      onCall: (call) => recordUsage(call),
      onSkip: (message) => {
        runtime.debug.skips += 1
        runtime.debug.lastSkip = message
        warn(`采集异常（该条已跳过，不影响其它记账）—— ${message}`)
      },
      onEvent: (session, event) => {
        runtime.debug.eventsSeen += 1
        let sessionShape = null
        try {
          sessionShape = session === null || session === undefined
            ? String(session)
            : `${typeof session}${typeof session.id === 'string' ? ` id=${session.id.slice(0, 8)}` : ' 无id'}`
        } catch {
          sessionShape = '取形状时抛错'
        }
        let eventShape = null
        try {
          eventShape = event === null || event === undefined
            ? String(event)
            : { keys: Object.keys(event).slice(0, 8), type: event.type ?? null, seq: event.seq ?? null, hasUsage: event.data?.usage !== undefined }
        } catch {
          eventShape = '取形状时抛错'
        }
        runtime.debug.lastEvent = { session: sessionShape, event: eventShape }
      },
    })
    runtime.capture = capture
    if (capture.attached !== true) warn(`实时采集没挂上（${capture.reason}）—— 只有回补会记账。`)
  } catch (error) {
    runtime.capture = { attached: false, reason: msgOf(error) }
    warn(`实时采集挂载失败 —— ${msgOf(error)}`)
  }

  // ② 回补空档：放到启动之后跑，不挡住工具/命令/HTTP 注册
  setTimeout(() => {
    runBackfill(ctx).catch((error) => warn(`回补异常 —— ${msgOf(error)}`))
  }, 3000)

  withRetry('工具', () => registerToolStep(ctx))
  withRetry('命令', () => registerCommandsStep(ctx))
  withRetry('数据路由', () => registerHttpRoute(ctx))
}

export { ROUTE_PATH }
