# 美股永续机会：首批扩展

## 范围与核对边界

用户允许同一股票、不同指数来源的双永续进入机会筛选，显示“指数源差异”，不显示“精确匹配”。不修改执行能力、Start/Exit、安全门禁或交易授权；不部署，不交易。

本批新增 19 个标的、73 个永续市场。与既有 90 个市场合计 163 个。不是四家全部股票产品的自动发现或完整接入。

- 四家：AAPL、AMZN、META、COIN、PLTR、MSTR、HOOD、INTC、AVGO、ORCL、NFLX、CRM、WMT、CRCL、SNDK、QCOM。
- Binance / Bybit / Bitget：UBER、JPM、V。未生成未经确认的 OKX 合约。
- 保留原有 MU、NVDA、GOOGL、MSFT、TSLA；其双永续也应用指数源差异标识。
- 新增标的仅含 perpetual，不通过拼接创建代币化股票现货。
- 特殊别名、股权类别或倍率尚未确认的标的不纳入；例如 AMDSTOCK、CATSTOCK、PENGSTOCK 需要单独映射审核。不自动合并 GOOG/GOOGL。
- ETF、杠杆 ETF、Pre-IPO、非美股、tradeXYZ 不属于本批新增范围。

2026-09-06 通过公开 GET 核对四家完整合约目录：Binance 897 条；Bybit linear 855 条且无下一页；OKX SWAP 473 条；Bitget USDT-FUTURES 778 条。目录计数包括非股票，不代表美股数量。确认所选具体合约处于 TRADING / Trading / live / normal，USDT 结算；OKX 所选合约为 linear，ctVal=1、ctMult=1。目录证明上市状态和合约规格，不证明各平台法律权利、指数或公司行动处理完全一致。

公开目录：

- https://fapi.binance.com/fapi/v1/exchangeInfo
- https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000
- https://www.okx.com/api/v5/public/instruments?instType=SWAP
- https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES

产品口径参考：

- https://www.bitget.com/amp/academy/bitget-stock-futures-introduction
- https://www.okx.com/pt/help/stock-perpetuals
- https://www.bybit.com/en/help-center/article/Introduction-to-TradFi-Perpetual-Contracts

同一股票的双永续沿用现有 oracle 风险等级及评分，保留公司行动、交易时段和价格源风险提示。股票间不形成组合。现有黄金 oracle 文案与非股票 exact 匹配保持不变。机会展示不是执行许可。

## 请求与性能

未增加新 endpoint 类型、polling、websocket/SSE；未改变 TTL、缓存、并发数。但扩展清单会增加真实公开 GET 量：在资金历史缓存已热的测试中，盘口缓存冷时每次 raw refresh 从 113 次变为 202 次，其中盘口 90→163、ticker/current funding 23→39；盘口缓存命中时为 39 次。另有原机制下的新增标的历史费率分页读取，不能宣称零新增 Provider reads。

上线前应单独验证扩展后的生产 Raw Snapshot 延迟与限频；本批测试不证明生产性能。不要借本批修改行情基础设施。

## 验证

测试覆盖新增标的按真实 venue 清单生成、无虚构现货/OKX leg、同股票双永续匹配、不同股票不配对、原匹配不回归，以及批量 ticker/盘口缓存请求量。历史不足及读取失败沿用既有降级处理，不伪造历史或价格。
