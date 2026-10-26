// 用量采集层：从内核的会话事件流里取每次调用的 token 用量。
//
// 依据（均来自 DSH 内核 api-catalog 与源码，非猜测）：
//   · `ctx.on('session/event', (session, event) => …)` —— 提交后推送（post-commit feed），
//     源码明写 **"Seed events never publish on 'session/event'"**：
//     所以**重启不会重放历史**，天生不会重复记账。这是它比轮询更好的地方。
//   · 事件信封只有 `type / seq / time / data / surfaceOp? / sourceEventSeqs? / ignorable?`，
//     **没有 `event.id`**。`seq` 就是 `log.length`，每会话内单调唯一、重启不变。
//     所以去重键 = `sessionId + ':' + seq`（**不要**用 turn/step：重试会用同一个 turn/step 再发一条，
//     而重试的两次都该计费，按 turn/step 去重会漏掉其中一次）。
//   · TokenUsage 字段（就这 6 个）：inputTokens / outputTokens / totalTokens? / cacheReadTokens? /
//     cacheWriteTokens? / reasoningTokens?
//     **语义要点：`inputTokens` 是"未命中缓存"的那部分**，不是输入总量。
//   · `assistant/message` 可能带 `data.usage`；`assistant/attempt` **不带**，用量藏在
//     `data.stream` 里 `{type:'chunk', chunk:{type:'usage'}}` 的帧中 → 必须倒查兜底。
//   · 模型串在 `data.message.source = {kind:'model', provider, model}`。

const USAGE_EVENT_TYPES = ['assistant/message', 'assistant/attempt']

function num(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 从 stream 里倒查最后一个 usage 帧（`assistant/attempt` 只能这样取）。 */
export function usageFromStream(stream) {
  if (!Array.isArray(stream)) return null
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const frame = stream[i]
    if (frame !== null && typeof frame === 'object' && frame.type === 'chunk') {
      const chunk = frame.chunk
      if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage' && chunk.usage !== null && typeof chunk.usage === 'object') {
        return chunk.usage
      }
    }
  }
  return null
}

/** 从事件里取 TokenUsage；取不到返回 null。 */
export function usageOfEvent(event) {
  if (event === null || typeof event !== 'object') return null
  if (!USAGE_EVENT_TYPES.includes(event.type)) return null
  const data = event.data
  if (data === null || typeof data !== 'object') return null
  if (data.usage !== null && typeof data.usage === 'object') return data.usage
  return usageFromStream(data.stream)
}

/** 模型串：`provider:model`（与账本里 `deepseek-v4-flash:deepseek-flash` 同形）。 */
export function modelOfEvent(event) {
  const source = event?.data?.message?.source
  if (source === null || typeof source !== 'object') return null
  if (source.kind !== undefined && source.kind !== 'model') return null
  const provider = typeof source.provider === 'string' ? source.provider : ''
  const model = typeof source.model === 'string' ? source.model : ''
  if (provider !== '' && model !== '') return `${provider}:${model}`
  if (model !== '') return model
  if (provider !== '') return provider
  return null
}

/**
 * 去重键。`seq` 每会话单调唯一，重启不变 —— 同一条事件永远同一个键。
 * 拿不到 seq 就返回 null（上层据此拒绝记账，宁可少记）。
 */
export function callIdOf(sessionId, event) {
  const seq = event?.seq
  if (typeof sessionId !== 'string' || sessionId === '') return null
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return null
  return `${sessionId}:${seq}`
}

/**
 * 把一条内核事件归一成记账用的一次调用；不是计费事件/拿不到用量时返回 null。
 * `cacheMiss` 取 `inputTokens`（内核语义就是未命中缓存），`cacheHit` 取 `cacheReadTokens`。
 */
export function callOfEvent(sessionId, event) {
  const usage = usageOfEvent(event)
  if (usage === null) return null
  const callId = callIdOf(sessionId, event)
  if (callId === null) return null
  const cacheMiss = num(usage.inputTokens)
  const cacheHit = num(usage.cacheReadTokens)
  const output = num(usage.outputTokens)
  if (cacheMiss === 0 && cacheHit === 0 && output === 0) return null
  const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now()
  return {
    callId,
    at: new Date(time),
    model: modelOfEvent(event),
    cacheMiss,
    cacheHit,
    output,
    cacheWrite: num(usage.cacheWriteTokens),
    reasoning: num(usage.reasoningTokens),
    sessionId: typeof sessionId === 'string' ? sessionId : null,
    seq: event.seq,
    eventType: event.type,
  }
}

/**
 * 挂上实时采集。返回 dispose 函数。
 *
 * 用 `ctx.effect` 注册（cordis 的清理钩子），插件卸载时自动摘掉，
 * 不会在热重载后残留多个监听器（那样会重复记账）。
 */
export function attachCapture(ctx, options = {}) {
  const onCall = typeof options.onCall === 'function' ? options.onCall : () => {}
  const onSkip = typeof options.onSkip === 'function' ? options.onSkip : () => {}
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {}
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.on !== 'function') {
    return { attached: false, reason: 'no-ctx.on', dispose: () => {} }
  }

  const handle = (session, event) => {
    try {
      // 先让上层看一眼**原始载荷**：内核到底传进来什么形状，
      // 不埋这个探针就只能靠猜（踩过一次：什么都收不到却没有任何报错）。
      onEvent(session, event)
      const sessionId = session?.id ?? session?.sessionId
      const call = callOfEvent(sessionId, event)
      if (call === null) return
      onCall(call, { session, event })
    } catch (error) {
      // 监听器抛错会被内核吞掉，但吞掉就等于"静默丢账" —— 所以自己兜一层并上报
      onSkip(String((error && error.message) || error), event)
    }
  }

  let dispose = () => {}
  const register = () => {
    dispose = ctx.on('session/event', handle)
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }

  if (typeof ctx.effect === 'function') {
    // ctx.effect 的返回值是清理函数；把 on() 的返回值转成"摘监听"
    ctx.effect(() => {
      const off = register()
      return off
    })
    return { attached: true, reason: 'effect', dispose: () => {} }
  }
  const off = register()
  return { attached: true, reason: 'direct', dispose: off }
}

/**
 * 回补历史：把"账本导入之后、第一次启动之前"那段空档补上。
 *
 * 为什么必须限定 `sinceMs`：cost-meter 记过的那些天已经导入进账本了，
 * 无条件重扫历史会话会把同一批用量再加一遍 —— 总额直接翻倍，而且用户无从核对。
 * 所以只补 `time > sinceMs` 的事件（即导入那一刻之后的）。
 *
 * 去重仍然由 `sessionId:seq` 兜底，所以跟实时采集重叠也不会记两遍。
 */
export async function backfill(ctx, options = {}) {
  const onCall = typeof options.onCall === 'function' ? options.onCall : () => {}
  const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : 0
  const maxSessions = Number.isFinite(options.maxSessions) ? options.maxSessions : 200
  const result = { sessions: 0, events: 0, calls: 0, error: null }

  const query = typeof ctx?.get === 'function' ? ctx.get('sessionQuery') : undefined
  if (query === undefined || query === null) {
    result.error = '没有 sessionQuery 服务'
    return result
  }
  const list = typeof query.listSessions === 'function' ? query.listSessions.bind(query) : null
  const read = typeof query.readSession === 'function' ? query.readSession.bind(query) : null
  if (list === null || read === null) {
    result.error = 'sessionQuery 缺少 listSessions/readSession'
    return result
  }

  let records = []
  try {
    records = await list()
  } catch (error) {
    result.error = String((error && error.message) || error)
    return result
  }
  if (!Array.isArray(records)) {
    result.error = 'listSessions 没有返回数组'
    return result
  }

  const candidates = records
    .filter((record) => record !== null && typeof record === 'object' && record.header !== null && typeof record.header === 'object')
    .slice(0, maxSessions)

  for (const record of candidates) {
    // 会话的开始时间早于 sinceMs 也可能有之后的调用（长会话），所以不能按 createdAt 排除，
    // 只能逐个读事件再按 `time` 过滤。
    result.sessions += 1
    let payload = null
    try {
      payload = await read(record.header.id)
    } catch {
      continue
    }
    const events = Array.isArray(payload?.events) ? payload.events : []
    result.events += events.length
    for (const event of events) {
      const call = callOfEvent(record.header.id, event)
      if (call === null) continue
      if (call.at.getTime() <= sinceMs) continue
      onCall(call, { backfill: true })
      result.calls += 1
    }
  }
  return result
}

export { USAGE_EVENT_TYPES }
