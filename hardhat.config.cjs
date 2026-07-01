const hardhatEthersPlugin = require("@nomicfoundation/hardhat-ethers").default;
require("dotenv").config();

const PRIVATE_KEY = process.env.BSC_TESTNET_PRIVATE_KEY;
const RPC_URL =
  process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.bnbchain.org:8545";

if (!PRIVATE_KEY) {
  console.warn(
    "[hardhat] Missing BSC_TESTNET_PRIVATE_KEY. Deployment and write scripts will fail until it is set.",
  );
}

module.exports = {
  plugins: [hardhatEthersPlugin],
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  paths: {
    sources: "./chain/contracts",
    tests: "./chain/test",
    cache: "./chain/cache",
    artifacts: "./chain/artifacts",
  },
  networks: {
    bscTestnet: {
      type: "http",
      chainType: "l1",
      url: RPC_URL,
      chainId: 97,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
};
