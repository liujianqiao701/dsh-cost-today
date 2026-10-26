# dsh-cost-today

DSH 今日花费插件：把**「今天花了多少钱」**显示在输入框下方与会话头部，点开是明细面板。

```
💰 ¥48.58          ← 输入框下方 / 会话头部
   ↓ 点开
┌─ 💰 今日花费                          [关闭] ─┐
│  ¥48.58                                       │
│  2026-10-26 · 账本原币 $6.7479 USD × 7.2      │
│  调用次数     191 次 · 平均 ¥0.25/次          │
│  输入（未命中）21.65M token                    │
│  缓存命中     7.96M token（命中率 26.9%）      │
│  输出         170.5k token                     │
│  按会话  ¥36.39 测试框架AI插件开发        145 次│
│  按模型  ¥48.58 deepseek-v4-flash:deepseek-flash│
└────────────────────────────────────────────────┘
```

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
| GUI | 输入框下方一行 + 会话头部徽标，点开面板；每 60 秒自动刷新 |

## 口径（重要）

| 项 | 口径 |
| --- | --- |
| **「今天」** | **本地日期** `YYYY-MM-DD`（与 cost-meter 的 `localDayKey()` 一致）。⚠️ 用 UTC 会在凌晨 0–8 点把账算到前一天 |
| **金额** | 账本 `days[dayKey].cost`（USD）→ 按 `config.currency` / `config.exchangeRate` 换算 |
| **币种与汇率** | 读账本 `config`：`currency=CNY`、`symbol=¥`、`exchangeRate=7.2`。坏值回落 `7.2` |
| **缓存命中率** | `cacheRead / (input + cacheRead)` —— `input` 是**未命中缓存**的输入 |
| **峰谷** | 沿用 cost-meter 已算好的金额，本插件**不重算** |

## 踩过的坑（都在代码注释里标了位置）

| 坑 | 后果 |
| --- | --- |
| 客户端没导出 `inject: ['slots']` | cordis 在 slots 挂载前就调 `apply` → 注册被静默跳过，**没 UI 也没报错** |
| 用主题 CSS 变量配硬编码回退取色 | `--dsw-alias-bg-primary` 未定义→白底，`--dsw-alias-label-primary` 暗色下近白→**白底白字** |
| 用 `toISOString()` 算「今天」 | UTC 差 8 小时，凌晨的账算到前一天 |
| 声明了 `input`/`cacheRead` 却漏了 `output` | `ReferenceError: output is not defined` —— 被单测当场抓住 |

> 自检：DevTools 里看 `window.__costToday` → `{ factoryRan, applyCalled, slotsType, registered[], error }`。

## 测试

```bash
node test/ledger.test.mjs   # 9 项：时区、币种换算、命中率、缺数据、格式化
node test/client.test.mjs   # 6 项：模块 ABI、inject、两个插槽注册、只依赖 react
```

## License

MIT
