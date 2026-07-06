export const accountSections = [
  "overview",
  "wallet-overview",
  "funding",
  "trading",
  "simulation",
  "ledger",
  "onchain-deposits",
  "trade-orders",
] as const;

export const tokenIconSrc = "/assets/xingheng-logo@2x.png";
export const bscTestnetLabel = "BNB Smart Chain Testnet";
export const bscTestnetChainId = "0x61";
export const bscTestnetRpcUrls = [
  "https://bsc-testnet-dataseed.bnbchain.org",
  "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
];
export const requiredConfirmations = 1;
export const currentSimulationAccountKey = "xingheng.trading.currentSimulationAccountId";
export const transferAccountOptions = [
  { value: "wallet", label: "钱包" },
  { value: "funding", label: "资金账户" },
  { value: "realTrading", label: "交易账户" },
];
