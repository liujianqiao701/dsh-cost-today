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


## 为什么是「读账本」而不是自己记账

**不自己重算单价。** 数据源是 `dsh-cost-meter` 的账本
（`$DSH_HOME/storages/cost-meter/ledger.json`），它已经把每次调用按
**官方单价 + UTC 峰谷规则（峰时翻倍）** 算成了金额，还处理了历史单价变更、
模型名匹配、订阅制渠道等一堆边界。再算一遍必然对不上账。

本插件只做三件事：

1. 按**本地日期**取出今天那一条；
2. 把 USD 金额按你的配置换成显示币种；
3. 整理成面板要的形状。

所以：**金额的准确性取决于 dsh-cost-meter**，本插件不产生新口径。

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
| **峰谷** | 沿用 cost-meter 已算好的金额，本插件**不重算** |

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

```bash
node test/ledger.test.mjs   # 12 项：时区、币种换算、命中率、今日/本月/累计、缺数据、格式化
node test/client.test.mjs   # 6 项：模块 ABI、inject、两个插槽注册、只依赖 react
```

## License

MIT
