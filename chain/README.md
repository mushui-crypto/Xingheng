# BSC Testnet 最小 ERC-20 模块

这个子目录只负责一件事：在 `BNB Chain Testnet` 上部署一个最小可用的测试代币，并提供最小 `mint / transfer` 脚本。

适用场景：

- 平台链上充值 / 出金联调
- 钱包地址之间测试转账
- 后端监听 `Transfer` 事件

不负责：

- 主网部署
- 多签
- 升级代理
- 生产级密钥托管

## 1. 安装依赖

在仓库根目录执行：

```bash
npm install
```

## 2. 配置环境变量

复制 `.env.example` 到 `.env`，至少补这几个值：

```bash
BSC_TESTNET_RPC_URL=https://data-seed-prebsc-1-s1.bnbchain.org:8545
BSC_TESTNET_PRIVATE_KEY=你的测试网热钱包私钥
```

说明：

- 热钱包 = 平台用于部署合约、mint 测试币、后续广播测试网出金的钱包。
- 当前最小实现里，合约 `owner` 会直接使用这把热钱包私钥对应的钱包地址，不再单独配置 `TOKEN_OWNER_ADDRESS`。

可选代币参数：

```bash
BSC_TESTNET_TOKEN_NAME=StellarX Test USD
BSC_TESTNET_TOKEN_SYMBOL=sUSDT
BSC_TESTNET_TOKEN_DECIMALS=18
```

## 3. 编译

```bash
npm run chain:compile
```

## 4. 部署

```bash
npm run chain:deploy:bscTestnet
```

部署成功后会输出：

- `tokenAddress`
- `deployer`
- `owner`

把 `tokenAddress` 写回 `.env`：

```bash
BSC_TESTNET_TOKEN_ADDRESS=0x...
```

## 5. Mint 测试币

```bash
MINT_TO=0x接收地址
MINT_AMOUNT=1000
npm run chain:mint
```

## 6. 转账

```bash
TRANSFER_TO=0x目标地址
TRANSFER_AMOUNT=25
npm run chain:transfer
```

## 7. 建议的后端接入方式

后端实际要关心的是：

- 代币合约地址
- 用户充值地址
- `Transfer` 事件
- `txHash`
- 区块确认数

推荐接入顺序：

1. 先部署测试代币
2. 后端保存 `BSC_TESTNET_TOKEN_ADDRESS`
3. 监听充值地址收到的 `Transfer`
4. 达到确认数后记账到 `Funding Account`
5. 出金审核通过后由热钱包真实广播链上转账

## 8. 风险说明

- `BSC_TESTNET_PRIVATE_KEY` 只应用于测试网
- 不要复用主网私钥
- `mint` 只有合约 owner 能调用
- `transfer` 由当前私钥对应钱包发起
