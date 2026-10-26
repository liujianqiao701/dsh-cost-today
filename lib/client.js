/**
 * dsh-cost-today · 客户端半身
 *
 * 在**输入框下方**（`conversation.composer.dock`）和**会话头部**（`conversation.session.header.actions`）
 * 各放一处「今日花费」，点开是明细面板。
 *
 * 🔴 三个坑是从 `dsh-context-radar` 带过来的血泪经验，**一条都别删**：
 *   ① 必须导出 **`inject: ['slots']`**，且 package.json 的 `dsh.client.inject` 要声明
 *      `@deepseek-ai/dsh-client-ui-slots`。漏了 cordis 会在 slots 挂载前就调 apply，
 *      注册被静默跳过 —— **没徽标、也没报错**。
 *   ② 颜色用 CSS 系统色 `Canvas` / `CanvasText`；用主题变量配硬编码回退会白底白字。
 *   ③ 插槽只在**有会话打开**时渲染，空态页面看不到是正常的。
 *
 * 数据源：宿主注册的 `/api/dsh-cost-today/report`（同源 fetch）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-cost-today',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const ENDPOINT = '/api/dsh-cost-today/report'
    const REFRESH_MS = 60000

    /**
     * 只读探测点：DevTools 里看 `window.__costToday` 就知道断在哪一步。
     *   factoryRan / applyCalled / slotsType / registered / error
     */
    const DEBUG = (window.__costToday = window.__costToday || {
      factoryRan: false,
      applyCalled: false,
      slotsType: 'not-reached',
      registered: [],
      error: null,
    })
    DEBUG.factoryRan = true

    const money = (value, symbol = '¥') =>
      (typeof value === 'number' && Number.isFinite(value) ? `${symbol}${value.toFixed(2)}` : '—')
    const tokens = (value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
      if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
      if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
      return String(value)
    }

    function useReport() {
      const [state, setState] = React.useState({ loading: true, data: null, error: null })
      const [tick, setTick] = React.useState(0)
      React.useEffect(() => {
        const timer = window.setInterval(() => setTick((n) => n + 1), REFRESH_MS)
        return () => window.clearInterval(timer)
      }, [])
      React.useEffect(() => {
        let cancelled = false
        const load = async () => {
          try {
            const res = await fetch(ENDPOINT, { headers: { accept: 'application/json' } })
            if (res.status === 401 || res.status === 403) throw new Error(`接口需要登录态（HTTP ${res.status}）`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const json = await res.json()
            if (cancelled) return
            if (json && json.ok) setState({ loading: false, data: json, error: null })
            else setState({ loading: false, data: null, error: (json && json.error) || '账本读不到' })
          } catch (error) {
            if (!cancelled) setState({ loading: false, data: null, error: String((error && error.message) || error) })
          }
        }
        load()
        return () => {
          cancelled = true
        }
      }, [tick])
      return state
    }

    // ---- 侧边栏底部（**始终可见**，不依赖有没有打开会话）----------------------
    // 这是最关键的一处：另外两个插槽都只在「打开了一个会话」时才有位置，
    // 重启后落在首页就什么都看不到 —— 用户会以为插件根本没生效（这个坑实测踩过两次）。
    function CostSidebar() {
      const [open, setOpen] = React.useState(false)
      const state = useReport()
      const data = state.data
      const today = state.error !== null
        ? '—'
        : data === null
          ? '…'
          : money(data.cost, (data && data.symbol) || '¥')
      const hasTotal = data !== null && data.total !== null && data.total !== undefined && data.total.days > 0
      const totalLine = hasTotal ? `累计 ${money(data.total.cost, data.symbol)}` : ''
      const title = state.error !== null
        ? `今日花费读不到：${state.error}`
        : `今日 ${today}${hasTotal ? ` · ${totalLine}（${data.total.since} 起，${data.total.days} 天）` : ''}`
      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            title,
            onClick: () => setOpen(true),
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              width: '100%',
              padding: '6px 8px',
              borderRadius: 8,
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              lineHeight: 1.25,
              textAlign: 'left',
              cursor: 'pointer',
            },
          },
          h('span', { style: { fontSize: 15 } }, '💰'),
          h(
            'span',
            { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, minWidth: 0 } },
            // 「标签小、数字大」：标签只是说明，数字才是要一眼看到的。
            h(
              'span',
              { style: { display: 'flex', alignItems: 'baseline', gap: 5 } },
              h('span', { style: { fontSize: 11, opacity: 0.7 } }, '今日'),
              h('span', { style: { fontSize: 12, opacity: 0.9 } }, today),
            ),
            totalLine === ''
              ? null
              : h(
                  'span',
                  { style: { display: 'flex', alignItems: 'baseline', gap: 5 } },
                  h('span', { style: { fontSize: 11, opacity: 0.7 } }, '累计'),
                  h(
                    'span',
                    { style: { fontSize: 15, fontWeight: 600, letterSpacing: '0.2px' } },
                    money(data.total.cost, data.symbol),
                  ),
                ),
          ),
        ),
        open ? h(CostPanel, { state, onClose: () => setOpen(false) }) : null,
      )
    }

    // ---- 输入框下方那一行 ---------------------------------------------------
    function CostDock() {
      const [open, setOpen] = React.useState(false)
      const state = useReport()
      const data = state.data
      if (state.error !== null) {
        return h(
          'div',
          { style: { fontSize: 11, opacity: 0.6, padding: '2px 4px' } },
          `今日花费：${state.error}`,
        )
      }
      const hasTotal = data !== null && data.total !== null && data.total !== undefined && data.total.days > 0
      const totalLabel = hasTotal ? ` · 累计 ${money(data.total.cost, data.symbol)}` : ''
      const label = data === null
        ? (state.loading ? '今日花费 …' : '今日花费 —')
        : data.hasData
          ? `今日 ${money(data.cost, data.symbol)}${totalLabel}`
          : `今日 ${money(0, data.symbol)}（暂无用量）${totalLabel}`
      let detail = data !== null && data.hasData
        ? `${data.calls} 次调用 · 输入 ${tokens(data.input)} · 缓存命中 ${tokens(data.cacheRead)} · 输出 ${tokens(data.output)}`
        : '点开看明细'
      if (hasTotal) {
        detail += `\n累计 ${money(data.total.cost, data.symbol)}（${data.total.since} 起，${data.total.days} 天`
          + (data.retentionDays ? `，账本保留 ${data.retentionDays} 天` : '')
          + '）'
      }
      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            title: `${label}\n${detail}`,
            onClick: () => setOpen(true),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '1px 6px',
              borderRadius: 6,
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              fontSize: 11,
              opacity: 0.75,
              cursor: 'pointer',
            },
          },
          h('span', null, '💰'),
          h('span', null, label),
        ),
        open ? h(CostPanel, { state, onClose: () => setOpen(false) }) : null,
      )
    }

    // ---- 会话头部徽标 -------------------------------------------------------
    function CostBadge() {
      const [open, setOpen] = React.useState(false)
      const state = useReport()
      const data = state.data
      const text = state.error !== null
        ? '💰 —'
        : data === null || !data.hasData
          ? `💰 ${money(0, (data && data.symbol) || '¥')}`
          : `💰 ${money(data.cost, data.symbol)}`
      const hasTotal = data !== null && data.total !== null && data.total !== undefined && data.total.days > 0
      const badgeTitle = '今日花费 —— 点开看明细'
        + (hasTotal ? `\n累计 ${money(data.total.cost, data.symbol)}（${data.total.since} 起，${data.total.days} 天）` : '')
      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            title: badgeTitle,
            onClick: () => setOpen(true),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              padding: '3px 8px',
              borderRadius: 999,
              border: '1px solid rgba(128,128,128,0.5)',
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              fontSize: 12,
              lineHeight: 1.4,
              cursor: 'pointer',
              opacity: 0.9,
            },
          },
          h('span', null, text),
        ),
        open ? h(CostPanel, { state, onClose: () => setOpen(false) }) : null,
      )
    }

    // ---- 明细面板 -----------------------------------------------------------
    function CostPanel(props) {
      const { state, onClose } = props
      const data = state.data
      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])

      const overlay = {
        position: 'fixed',
        inset: 0,
        zIndex: 2147483000,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '6vh 16px',
        background: 'rgba(0,0,0,0.45)',
        overflow: 'auto',
      }
      const card = {
        width: 'min(620px, 96vw)',
        maxHeight: '88vh',
        overflow: 'auto',
        borderRadius: 14,
        border: '1px solid rgba(128,128,128,0.35)',
        // 系统色：随 color-scheme 亮暗自动成对，绝不会白底白字
        background: 'Canvas',
        color: 'CanvasText',
        boxShadow: '0 18px 50px rgba(0,0,0,0.32)',
        padding: '18px 20px 20px',
        fontSize: 13,
        lineHeight: 1.7,
      }
      const muted = { opacity: 0.65 }
      const row = (label, value) =>
        h(
          'div',
          { style: { display: 'flex', gap: 8 } },
          h('span', { style: { ...muted, minWidth: 96 } }, label),
          h('span', null, value),
        )

      const head = h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 } },
        h('div', { style: { fontSize: 15, fontWeight: 600 } }, '💰 今日花费'),
        h('div', { style: { flex: 1 } }),
        h(
          'button',
          {
            type: 'button',
            onClick: onClose,
            style: {
              border: '1px solid rgba(128,128,128,0.4)',
              background: 'transparent',
              color: 'inherit',
              borderRadius: 8,
              padding: '2px 10px',
              cursor: 'pointer',
              font: 'inherit',
            },
          },
          '关闭',
        ),
      )

      let body
      if (state.error !== null) {
        body = h('div', { style: { margin: '8px 0' } }, `读不到账本：${state.error}`, h('div', { style: { ...muted, marginTop: 6 } }, '账本由本插件自记（每次调用后累加）；文件读不到就见不到数字。'))
      } else if (data === null) {
        body = h('div', { style: muted }, state.loading ? '正在读取…' : '没有数据')
      } else if (!data.hasData) {
        body = h(
          'div',
          { style: { margin: '8px 0' } },
          `${data.dayKey} 还没有用量记录 —— 今天还没发起过模型调用，或账本还没落盘。`,
          h('div', { style: { ...muted, marginTop: 6 } }, data.ledgerPath || ''),
        )
      } else {
        const hasTotalRow = data.total !== null && data.total !== undefined && data.total.days > 0
        const retentionText = data.retentionDays ? `，账本保留 ${data.retentionDays} 天` : ''
        body = h(
          React.Fragment,
          null,
          h('div', { style: { fontSize: 30, fontWeight: 700, lineHeight: 1.2 } }, money(data.cost, data.symbol)),
          h(
            'div',
            { style: { ...muted, marginBottom: 12 } },
            `${data.dayKey}`
            + (data.pricingCurrency !== data.currency ? ` · 账本原币 $${(data.costUsd || 0).toFixed(4)} ${data.pricingCurrency} × ${data.exchangeRate}` : ''),
          ),
          hasTotalRow ? row('本月', `${money(data.month.cost, data.symbol)}（${data.month.days} 天）`) : null,
          hasTotalRow ? row('累计', `${money(data.total.cost, data.symbol)}（${data.total.since} 起，${data.total.days} 天${retentionText}）`) : null,
          row('调用次数', `${data.calls} 次${data.calls > 0 ? ` · 平均 ${money(data.costPerCall, data.symbol)}/次` : ''}`),
          row('输入（未命中）', `${tokens(data.input)} token`),
          row('缓存命中', `${tokens(data.cacheRead)} token${data.cacheHitRate === null ? '' : `（命中率 ${(data.cacheHitRate * 100).toFixed(1)}%）`}`),
          row('输出', `${tokens(data.output)} token`),
        )
        if (Array.isArray(data.sessions) && data.sessions.length > 0) {
          body = h(
            React.Fragment,
            null,
            body,
            h('div', { style: { marginTop: 16, fontWeight: 600 } }, '按会话'),
            ...data.sessions.slice(0, 8).map((session, index) =>
              h(
                'div',
                { key: `s-${index}`, style: { display: 'flex', gap: 8 } },
                h('span', { style: { minWidth: 78, fontWeight: 600 } }, money(session.cost, data.symbol)),
                h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: session.title }, session.title),
                h('span', { style: muted }, `${session.calls} 次`),
              ),
            ),
          )
        }
        if (Array.isArray(data.models) && data.models.length > 0) {
          body = h(
            React.Fragment,
            null,
            body,
            h('div', { style: { marginTop: 16, fontWeight: 600 } }, '按模型'),
            ...data.models.slice(0, 6).map((model, index) =>
              h(
                'div',
                { key: `m-${index}`, style: { display: 'flex', gap: 8 } },
                h('span', { style: { minWidth: 78, fontWeight: 600 } }, money(model.cost, data.symbol)),
                h('span', { style: { flex: 1 } }, model.key),
                h('span', { style: muted }, `${model.calls} 次`),
              ),
            ),
          )
        }
        body = h(
          React.Fragment,
          null,
          body,
          h(
            'div',
            { style: { ...muted, marginTop: 16, fontSize: 11 } },
            `账本：${data.ledgerPath || ''}`
            + (data.ledgerMtime ? `（更新于 ${new Date(data.ledgerMtime).toLocaleString('zh-CN')}）` : ''),
          ),
          h(
            'div',
            { style: { ...muted, marginTop: 2, fontSize: 11 } },
            '金额由本插件自记：DeepSeek 官方单价（含 UTC 峰谷、周末与节假日规则）逐次累加；历史一次性导入自 cost-meter。',
          ),
        )
      }

      return h(
        'div',
        { style: overlay, onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() } },
        h('div', { style: card }, head, body),
      )
    }

    // ---- 注册 ---------------------------------------------------------------
    const SLOTS = [
      'sidebar.footer.action',              // ① 侧边栏底部 —— **始终可见**，不依赖会话
      'conversation.composer.dock',          // ② 输入框下方
      'conversation.session.header.actions', // ③ 会话头部徽标
    ]

    function apply(ctx) {
      DEBUG.applyCalled = true
      const slots = ctx.slots ?? (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
      DEBUG.slotsType = slots === null ? 'null' : typeof slots
      if (slots === undefined || slots === null) return
      if (typeof slots.register !== 'function') return

      const targets = [
        { name: SLOTS[0], component: CostSidebar, id: 'cost-today-sidebar', order: 50 },
        { name: SLOTS[1], component: CostDock, id: 'cost-today-dock', order: 20 },
        { name: SLOTS[2], component: CostBadge, id: 'cost-today-badge', order: 41 },
      ]
      for (const target of targets) {
        // 每个插槽**独立** try/catch：一个插槽不存在/契约不符，不能拖累另一个。
        ctx.effect(() => {
          const options = { name: target.name, id: target.id, order: target.order, inject: () => ({}) }
          try {
            const dispose = typeof slots.inject === 'function'
              ? slots.inject(target.name, () => slots.register(options, target.component))
              : slots.register(options, target.component)
            DEBUG.registered.push(target.name)
            return () => {
              if (typeof dispose === 'function') dispose()
            }
          } catch (error) {
            DEBUG.error = String((error && error.message) || error)
            return () => {}
          }
        }, `cost-today: ${target.id}`)
      }
    }

    // inject 让 cordis 等 slots 挂载后再调 apply —— 漏了整套 UI 会静默消失
    return { apply, inject: ['slots'] }
  },
})
