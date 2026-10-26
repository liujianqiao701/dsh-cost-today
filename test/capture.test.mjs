import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  attachCapture,
  backfill,
  callIdOf,
  callOfEvent,
  modelOfEvent,
  usageFromStream,
  usageOfEvent,
} from '../lib/capture.js'

function messageEvent(overrides = {}) {
  return {
    type: 'assistant/message',
    seq: 7,
    time: Date.UTC(2026, 9, 26, 2, 0, 0),
    data: {
      usage: { inputTokens: 22242, outputTokens: 127, totalTokens: 59233, cacheReadTokens: 36864 },
      message: { id: 'uuid-1', source: { kind: 'model', provider: 'deepseek-v4-flash', model: 'deepseek-flash' } },
    },
    ...overrides,
  }
}

test('usage 字段：inputTokens 是未命中缓存那部分', () => {
  const event = messageEvent()
  const usage = usageOfEvent(event)
  assert.equal(usage.inputTokens, 22242)
  assert.equal(usage.cacheReadTokens, 36864)
  assert.equal(usage.totalTokens, 59233)
  // 内核口径：total = input + output + cacheRead + cacheWrite
  assert.equal(usage.inputTokens + usage.outputTokens + usage.cacheReadTokens, usage.totalTokens)
})

test('非计费事件一律返回 null', () => {
  for (const type of ['request/header', 'user/message', 'tool/result', 'assistant/chunk']) {
    assert.equal(usageOfEvent({ type, data: { usage: { inputTokens: 1 } } }), null, `${type} 不该被当成计费事件`)
  }
  assert.equal(usageOfEvent(null), null)
  assert.equal(usageOfEvent(undefined), null)
})

test('assistant/attempt 没有 data.usage 时，从 stream 倒查 usage 帧', () => {
  const event = {
    type: 'assistant/attempt',
    seq: 9,
    time: Date.now(),
    data: {
      turn: 1,
      step: 1,
      stream: [
        { type: 'chunk', chunk: { type: 'text', text: 'hi' } },
        { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 2, cacheReadTokens: 5 } } },
        { type: 'chunk', chunk: { type: 'done' } },
      ],
    },
  }
  const usage = usageOfEvent(event)
  assert.equal(usage.inputTokens, 100, '要能从 stream 里倒查到')
  assert.equal(usage.cacheReadTokens, 5)
})

test('stream 里没有 usage 帧时返回 null（而不是编一个 0 用量去记账）', () => {
  assert.equal(usageFromStream([{ type: 'chunk', chunk: { type: 'text', text: 'x' } }]), null)
  assert.equal(usageFromStream([]), null)
  assert.equal(usageFromStream(null), null)
})

test('模型串拼成 provider:model，用于对上账本里的键', () => {
  assert.equal(modelOfEvent(messageEvent()), 'deepseek-v4-flash:deepseek-flash')
  assert.equal(
    modelOfEvent({ data: { message: { source: { kind: 'model', provider: 'p', model: 'm' } } } }),
    'p:m',
  )
  assert.equal(modelOfEvent({ data: { message: { source: { kind: 'agent', model: 'm' } } } }), null, '非 model 来源不算')
  assert.equal(modelOfEvent({ data: {} }), null)
  assert.equal(modelOfEvent(null), null)
})

test('去重键 = sessionId:seq；拿不到 seq 就不给键', () => {
  assert.equal(callIdOf('session-a', { seq: 7 }), 'session-a:7')
  assert.equal(callIdOf('session-a', { seq: '7' }), null, 'seq 必须是数字')
  assert.equal(callIdOf('session-a', {}), null)
  assert.equal(callIdOf('', { seq: 7 }), null)
  assert.equal(callIdOf(null, { seq: 7 }), null)
})

test('归一成一次调用：cacheMiss 取 inputTokens，cacheHit 取 cacheReadTokens', () => {
  const call = callOfEvent('session-a', messageEvent())
  assert.equal(call.callId, 'session-a:7')
  assert.equal(call.cacheMiss, 22242)
  assert.equal(call.cacheHit, 36864)
  assert.equal(call.output, 127)
  assert.equal(call.model, 'deepseek-v4-flash:deepseek-flash')
  assert.equal(call.sessionId, 'session-a')
  assert.equal(call.at.getTime(), Date.UTC(2026, 9, 26, 2, 0, 0))
})

test('用量全为 0 的事件不记账（避免把空事件记成一次 0 元调用）', () => {
  const event = messageEvent({ data: { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } } })
  assert.equal(callOfEvent('s', event), null)
})

test('attachCapture 通过 ctx.on 订阅 session/event，并在 effect 里可清理', () => {
  const calls = []
  const listeners = []
  let cleaned = 0
  const ctx = {
    on(name, fn) {
      listeners.push({ name, fn })
      return () => {
        cleaned += 1
      }
    },
    effect(fn) {
      const off = fn()
      assert.equal(typeof off, 'function', 'effect 回调应返回清理函数')
      return () => {}
    },
  }
  const result = attachCapture(ctx, { onCall: (call) => calls.push(call) })
  assert.equal(result.attached, true)
  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].name, 'session/event')

  listeners[0].fn({ id: 'session-a' }, messageEvent())
  assert.equal(calls.length, 1, '计费事件应当被采集到')
  assert.equal(calls[0].callId, 'session-a:7')

  listeners[0].fn({ id: 'session-a' }, { type: 'user/message', seq: 8, data: {} })
  assert.equal(calls.length, 1, '非计费事件不该产生调用')
})

test('同一个 seq 重复推送只算一次（去重靠 callId，由记账层执行）', () => {
  const seen = new Set()
  const applied = []
  const listeners = []
  const ctx = { on: (name, fn) => { listeners.push(fn); return () => {} }, effect: (fn) => { fn(); return () => {} } }
  attachCapture(ctx, {
    onCall: (call) => {
      if (seen.has(call.callId)) return
      seen.add(call.callId)
      applied.push(call)
    },
  })
  listeners[0]({ id: 's' }, messageEvent())
  listeners[0]({ id: 's' }, messageEvent())
  assert.equal(applied.length, 1)
})

test('采集回调里抛错不会炸掉监听器（内核会吞异常，等于静默丢账）', () => {
  const listeners = []
  const skips = []
  const ctx = { on: (name, fn) => { listeners.push(fn); return () => {} }, effect: (fn) => { fn(); return () => {} } }
  attachCapture(ctx, {
    onCall: () => {
      throw new Error('记账炸了')
    },
    onSkip: (message) => skips.push(message),
  })
  assert.doesNotThrow(() => listeners[0]({ id: 's' }, messageEvent()))
  assert.equal(skips.length, 1)
  assert.equal(skips[0], '记账炸了')
})

test('ctx 没有 on 时安静返回 attached:false，不抛', () => {
  const result = attachCapture({}, {})
  assert.equal(result.attached, false)
  assert.equal(typeof result.dispose, 'function')
})

test('backfill 只补 sinceMs 之后的事件（否则会把已导入的历史再加一遍）', async () => {
  const cutoff = Date.UTC(2026, 9, 26, 0, 0, 0)
  const oldEvent = messageEvent({ seq: 1, time: cutoff - 1000 })
  const newEvent = messageEvent({ seq: 2, time: cutoff + 1000 })
  const ctx = {
    get(name) {
      if (name !== 'sessionQuery') return undefined
      return {
        async listSessions() {
          return [{ header: { id: 'session-a' }, live: false, persisted: true }]
        },
        async readSession(id) {
          assert.equal(id, 'session-a')
          return { session: { id }, events: [oldEvent, newEvent] }
        },
      }
    },
  }
  const calls = []
  const result = await backfill(ctx, { sinceMs: cutoff, onCall: (call) => calls.push(call) })
  assert.equal(result.calls, 1, '只该补回 cutoff 之后那一条')
  assert.equal(calls[0].callId, 'session-a:2')
})

test('backfill 在没有 sessionQuery 时给出说明而不是抛', async () => {
  const result = await backfill({ get: () => undefined }, { sinceMs: 0 })
  assert.equal(result.calls, 0)
  assert.equal(typeof result.error, 'string')
  assert.ok(result.error.length > 0)
})
