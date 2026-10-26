# dsh-cost-today

DSH 今日花费插件：把**「今天花了多少钱」**显示在输入框下方与会话头部，点开是明细面板。

```
💰 今日 ¥57.22 / 累计 ¥732.48   ← 侧边栏底部（**始终可见**，不用打开会话）
   ↓ 点开
┌─ 💰 今日花费                              [关闭] ─┐
│  ¥57.22                                          │
│  2026-10-26 · 账本原币 $7.9473 USD × 7.2         │
│  本月      ¥330.43（11 天）                       │
│  累计      ¥732.48（2026-08-14 起，39 天，账本保留 180 天）│
│  调用次数  228 次 · 平均 ¥0.25/次                 │
│  输入（未命中）25.46M token                       │
│  缓存命中  10.23M token（命中率 28.7%）           │
│  输出      206.6k token                          │
│  按会话  ¥39.75 测试框架AI插件开发         168 次 │
│  按模型  ¥57.22 deepseek-v4-flash:deepseek-flash │
└──────────────────────────────────────────────────┘
```

## 三层金额：今日 / 本月 / 累计

| 层 | 怎么算 | 面板位置 |
| --- | --- | --- |
| **今日** | 账本 `days[今天]` 那一条 | 大标题 |
| **本月** | `days` 里所有 `YYYY-MM-*` 前缀等于本月的日期加总 | 「本月」行 |
| **累计** | `days` 里**全部**日期加总 | 「累计」行 |

⚠️ **累计只覆盖账本保留的历史**（`cost-meter` 的 `config.historyDays`，本机是 180 天），面板上会照实写出来。
「累计」不是你的终身账单 —— 账本被裁掉更早的日期后，累计会跟着变小，这是如实反映数据，不是 bug。


## 计量是自己做的，不依赖别的插件

**本插件自己记账。** 账本在 `$DSH_HOME/storages/cost-today/ledger.json`。

数据从哪来 —— 内核在每次追加会话事件后推送 `session/event`：

```js
ctx.on('session/event', (session, event) => { /* event.data.usage 就是这次调用的用量 */ })
```

四个关键细节（都是查内核源码确认的，不是猜的）：

| 细节 | 做法 |
| --- | --- |
| **用量字段** | `event.data.usage` 有 `inputTokens`（**未命中缓存**那部分）/ `cacheReadTokens`（命中）/ `outputTokens` / 可选 `cacheWriteTokens` / `reasoningTokens` |
| **失败/中断的调用** | `assistant/attempt` **不带** `data.usage`，要往 `data.stream` 里倒查 `{type:'chunk', chunk:{type:'usage'}}` |
| **去重** | 键 = `sessionId + ':' + event.seq`（`seq` 每会话单调唯一、重启不变）。**不用 turn/step** —— 重试会复用同一个 turn/step，按它去重会漏账 |
| **重启会不会重放** | 不会。内核明写 `Seed events never publish on 'session/event'`，恢复的历史事件不经过这条通道 |

单价自己带（内核**完全不管价格** —— 91 个服务里没有任何计费服务，全包 grep 单价/峰谷 0 命中）：

- **平时价**：缓存命中 $0.003 / 未命中 $0.15 / 输出 $0.60（每百万 token）
- **峰时** = 平时 × 2，窗口为 **UTC 01:00–04:00 与 06:00–10:00**
- **周末与中国法定节假日整日按平时价**

来源：<https://api-docs.deepseek.com/quick_start/pricing>（`PRICE_CHECKED_AT` 记在 `lib/pricing.js` 里，改价时改那一处）。
未知模型按 flash 价计但会打 `unknownModel` 标记，**不猜**。

### 从旧的 cost-meter 账本迁过来

第一次启动时**一次性导入** cost-meter 的历史（`days` 逐日搬，已有的日子不覆盖、不重复累加），
之后就不再看它。若检测到 cost-meter 的账本又被写过（说明它被装回来了），**立刻停手并在账本 `meta` 里留痕** ——
否则同一次调用被两边各记一遍，总额直接翻倍。

### 空档回补

「最后一次导入」到「本次启动」之间如果有调用（比如刚装好还没重启），启动 3 秒后会扫一遍
`sessionQuery` 把这段时间补上；起点是 `max(导入时刻, 上次回补时刻)`，所以**不会把已经导入的历史再加一遍**，
重叠部分靠 `sessionId:seq` 去重。

### 已知边界（不掩饰）

- **节假日表没配**（`holidays: []`）：法定节假日那 7 小时会按峰时**多算一倍**。给一份日期表就能准，编一份不如留空。
- **拿不到调用 id 就不记账**（宁少记不多记：少记能发现，多记发现不了）。
- **一次失败重试算两次** —— 这是对的（内核自己的用量投影也两次都计）。


## 安装

```bash
# 在 DSH profile 目录下
npm install "link:<本仓库路径>"
# 并把 "dsh-cost-today" 加进 profile package.json 的 dsh.profile.bundles
```

改完**必须重启 DSH**（宿主侧与客户端模块都只在启动时加载）。

## 三个入口

| 入口 | 用法 |
| --- | --- |
| 工具 `cost_today` | 参数 `day`（YYYY-MM-DD，省略=今天）、`limit`。消耗一个模型回合 |
| 命令 `/cost` | 同上，**不消耗模型回合**；可带日期 `/cost 2026-10-25` |
| 数据路由 | `GET /api/dsh-cost-today/report[?day=YYYY-MM-DD]` → JSON |
| GUI | **侧边栏底部**（始终可见）+ 输入框下方一行 + 会话头部徽标，点开面板；每 60 秒自动刷新 |

## 口径（重要）

| 项 | 口径 |
| --- | --- |
| **「今天」** | **本地日期** `YYYY-MM-DD`（与 cost-meter 的 `localDayKey()` 一致）。⚠️ 用 UTC 会在凌晨 0–8 点把账算到前一天 |
| **金额** | 账本 `days[dayKey].cost`（USD）→ 按 `config.currency` / `config.exchangeRate` 换算。累计 = 全部日期键先按 USD 求和再统一换算一次（不逐日四舍五入） |
| **累计只认日期键** | 只加总形如 `YYYY-MM-DD` 的键；`days` 里混进别的键绝不会被算进总额 —— 总额一旦偏大，用户没有任何办法察觉 |
| **币种与汇率** | 读账本 `config`：`currency=CNY`、`symbol=¥`、`exchangeRate=7.2`。坏值回落 `7.2` |
| **缓存命中率** | `cacheRead / (input + cacheRead)` —— `input` 是**未命中缓存**的输入 |
| **峰谷** | 由 `lib/pricing.js` 按 `event.time` 逐次判定（峰时 ×2）；导入的历史沿用 cost-meter 已算好的金额，**不重算** |

## 踩过的坑（都在代码注释里标了位置）

| 坑 | 后果 |
| --- | --- |
| 客户端没导出 `inject: ['slots']` | cordis 在 slots 挂载前就调 `apply` → 注册被静默跳过，**没 UI 也没报错** |
| 只往「会话内」插槽注册 | 首页/空态没有这些插槽 → 用户重启后以为插件没生效。必须同时注册 `sidebar.footer.action` |
| 用主题 CSS 变量配硬编码回退取色 | `--dsw-alias-bg-primary` 未定义→白底，`--dsw-alias-label-primary` 暗色下近白→**白底白字** |
| 用 `toISOString()` 算「今天」 | UTC 差 8 小时，凌晨的账算到前一天 |
| 声明了 `input`/`cacheRead` 却漏了 `output` | `ReferenceError: output is not defined` —— 被单测当场抓住 |

> 自检：DevTools 里看 `window.__costToday` → `{ factoryRan, applyCalled, slotsType, registered[], error }`。

## 测试

`npm test` 跑全部 62 项（node:test，零依赖）：

```bash
node test/ledger.test.mjs    # 12 项：时区、币种换算、命中率、今日/本月/累计、缺数据、格式化
node test/pricing.test.mjs   # 11 项：官方单价、峰谷窗口边界、周末/节假日、未知模型、别名
node test/meter.test.mjs     # 11 项：去重、日记录累加、幂等导入、外部计量器复活
node test/store.test.mjs     #  8 项：建账本、导入一次、坏文件、原子写、端到端
node test/capture.test.mjs   # 14 项：usage 取法（含 stream 兜底）、去重键、订阅与清理、回补边界
node test/client.test.mjs    #  6 项：模块 ABI、inject、三个插槽注册、只依赖 react
```

**实测过的端到端**（不是只跑单测）：临时实例发两条真消息 → 各记 **1 次**调用；
回补把 cost-meter 停写之后的 33 次调用补了回来；去重拒掉 1 条重叠；账目自洽
（导入 228 + 新记 35 = 账本 263）。

## License

MIT
