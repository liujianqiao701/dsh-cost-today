/**
 * 客户端半身的接线测试。
 *
 * 这类前端模块最阴的地方是**错了也不报错** —— 注册不进插槽、id 不匹配，页面就是安安静静
 * 什么都不多。上下文雷达那次就是全绿却一个徽标都没渲染出来，所以这里把 ABI 每一步都钉住：
 *   ① `window.__ModuleLoader__.load({ id, factory })`，id === 包名；
 *   ② factory(require) 返回 `{ apply, inject }`，且 **inject 含 'slots'**；
 *   ③ apply 往两个插槽各注册一个组件；
 *   ④ 拿不到 slots 服务时不抛；
 *   ⑤ package.json 同时声明 `dsh.client` 与 `exports["./client"]`。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const clientPath = path.join(root, 'lib', 'client.js')
const pkgPath = path.join(root, 'package.json')

function fakeReact() {
  return {
    createElement: () => null,
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
  }
}

function loadClient() {
  const source = fs.readFileSync(clientPath, 'utf8')
  const calls = []
  const fakeWindow = {
    __ModuleLoader__: { load: (payload) => calls.push(payload) },
    setInterval: () => 0,
    clearInterval: () => {},
  }
  const run = new Function('window', 'document', 'fetch', source)
  run(fakeWindow, { addEventListener: () => {}, removeEventListener: () => {} }, () => {
    throw new Error('测试里不该真的发请求')
  })
  return calls
}

function fakeCtx({ withSlots = true } = {}) {
  const recorded = { registered: [] }
  const slots = {
    register: (options, component) => {
      recorded.registered.push({ options, component })
      return () => {}
    },
    inject: (name, factory) => factory(),
  }
  return {
    ctx: {
      slots: withSlots ? slots : undefined,
      get: (name) => (name === 'slots' && withSlots ? slots : undefined),
      effect: (fn) => {
        const dispose = fn()
        if (typeof dispose === 'function') dispose()
        return () => {}
      },
    },
    recorded,
  }
}

const factoryOf = () => loadClient()[0].factory((name) => {
  if (name === 'react') return fakeReact()
  throw new Error(`未预期的 require: ${name}`)
})

test('包声明：dsh.client + exports["./client"] + slots 模块依赖都在', () => {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  assert.ok(pkg.dsh.client !== undefined, '必须声明 dsh.client')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.ok(fs.existsSync(clientPath))
  const inject = pkg.dsh.client.inject || []
  assert.ok(
    inject.includes('@deepseek-ai/dsh-client-ui-slots'),
    `dsh.client.inject 必须声明 slots 模块，实际 ${JSON.stringify(inject)}`,
  )
})

test('ABI：load 一次，id 等于包名', () => {
  const calls = loadClient()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, 'dsh-cost-today', 'id 必须等于包名，否则加载器报 loaded without registering')
  assert.equal(typeof calls[0].factory, 'function')
})

test('导出的 inject 必须含 "slots"（漏了会静默消失）', () => {
  const mod = factoryOf()
  assert.equal(typeof mod.apply, 'function')
  assert.ok(Array.isArray(mod.inject))
  assert.ok(mod.inject.includes('slots'), `inject 必须含 "slots"，实际 ${JSON.stringify(mod.inject)}`)
})

test('apply 往两个插槽各注册一个组件', () => {
  const mod = factoryOf()
  const { ctx, recorded } = fakeCtx()
  mod.apply(ctx)
  assert.equal(recorded.registered.length, 2, `应当注册 2 处，实际 ${recorded.registered.length}`)
  const names = recorded.registered.map((r) => r.options.name).sort()
  assert.deepEqual(names, ['conversation.composer.dock', 'conversation.session.header.actions'])
  for (const entry of recorded.registered) {
    assert.equal(typeof entry.component, 'function', '组件必须是函数')
    assert.ok(entry.options.id.length > 0, '插槽条目必须有唯一 id')
  }
})

test('拿不到 slots 服务时安静退出，不抛', () => {
  const mod = factoryOf()
  const { ctx, recorded } = fakeCtx({ withSlots: false })
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.equal(recorded.registered.length, 0)
})

test('客户端只依赖 react', () => {
  const source = fs.readFileSync(clientPath, 'utf8')
  const required = [...new Set([...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]))]
  assert.deepEqual(required, ['react'])
})
