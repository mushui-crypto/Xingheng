import { Contract, EventLog, formatUnits, isAddress, JsonRpcProvider, parseUnits, Wallet } from "ethers";
import type { OnchainDeposit, WalletNetwork, WithdrawalRequest } from "../types";
import type { TradingStore } from "../storage/TradingStore";

const transferEventAbi = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const network: WalletNetwork = "BSC_TESTNET";
const defaultRpcUrl = "https://data-seed-prebsc-1-s1.bnbchain.org:8545";
const defaultTokenAddress = "0x3a9f78bC0Cd5C05186904DaCcB07678444f1a02c";
const defaultStartBlock = 116_536_899;
const defaultScanBatchSize = 1;
const maxRpcRetryAttempts = 3;

export type OnchainWalletConfig = {
  network: WalletNetwork;
  rpcUrl: string;
  chainId: number;
  tokenAddress: string;
  tokenDecimals: number;
  confirmations: number;
  scanStartBlock: number;
  scanBatchSize: number;
};

export type OnchainScanResult = {
  fromBlock: number;
  toBlock: number;
  scannedBlocks: number;
  deposits: number;
  saved: number;
  status: "ok" | "rate_limited";
  rateLimited?: boolean;
  message?: string;
};

export class OnchainWalletService {
  readonly config: OnchainWalletConfig;
  private provider: JsonRpcProvider;
  private token: Contract;

  constructor(private store: TradingStore) {
    this.config = {
      network,
      rpcUrl: process.env.BSC_TESTNET_RPC_URL?.trim() || defaultRpcUrl,
      chainId: Number(process.env.BSC_TESTNET_CHAIN_ID ?? 97),
      tokenAddress: process.env.BSC_TESTNET_TOKEN_ADDRESS?.trim() || defaultTokenAddress,
      tokenDecimals: Number(process.env.BSC_TESTNET_TOKEN_DECIMALS ?? 18),
      confirmations: Math.max(1, Number(process.env.BSC_TESTNET_CONFIRMATIONS ?? 1)),
      scanStartBlock: Number(process.env.BSC_TESTNET_SCAN_START_BLOCK ?? defaultStartBlock),
      scanBatchSize: Math.max(1, Number(process.env.BSC_TESTNET_SCAN_BATCH_SIZE ?? defaultScanBatchSize)),
    };
    this.provider = new JsonRpcProvider(this.config.rpcUrl, this.config.chainId, { batchMaxCount: 1 });
    this.token = new Contract(this.config.tokenAddress, transferEventAbi, this.provider);
  }

  getPublicConfig() {
    return {
      network: this.config.network,
      chainId: this.config.chainId,
      tokenAddress: this.config.tokenAddress,
      tokenSymbol: "STLX",
      displayAsset: "USDT",
      tokenDecimals: this.config.tokenDecimals,
      confirmations: this.config.confirmations,
    };
  }

  async scanDeposits(): Promise<OnchainScanResult> {
    const cursor = this.store.getChainScanCursor(this.config.network, this.config.tokenAddress);
    const fromBlock = Math.max(cursor ? cursor.lastScannedBlock + 1 : this.config.scanStartBlock, this.config.scanStartBlock);
    let latestBlock: number;
    try {
      latestBlock = await this.withRpcRetry(() => this.provider.getBlockNumber(), "getBlockNumber");
    } catch (error) {
      if (isRateLimitError(error)) {
        return createRateLimitedScanResult(fromBlock, fromBlock - 1, error);
      }
      throw error;
    }

    if (fromBlock > latestBlock) {
      try {
        await this.refreshPendingDepositConfirmations(latestBlock);
      } catch (error) {
        if (isRateLimitError(error)) {
          return createRateLimitedScanResult(fromBlock, latestBlock, error);
        }
        throw error;
      }
      return createScanResult(fromBlock, latestBlock, 0);
    }

    const toBlock = Math.min(latestBlock, fromBlock + this.config.scanBatchSize - 1);
    let logs: Array<EventLog | unknown>;
    try {
      logs = await this.withRpcRetry(() => this.token.queryFilter(this.token.filters.Transfer(), fromBlock, toBlock), "queryTransferLogs");
    } catch (error) {
      if (isRateLimitError(error)) {
        return createRateLimitedScanResult(fromBlock, toBlock, error);
      }
      throw error;
    }
    let saved = 0;
    const now = Date.now();

    for (const log of logs) {
      if (!(log instanceof EventLog)) {
        continue;
      }
      const toAddress = String(log.args.to);
      const assignedAddress = this.store.getDepositAddressByAddress(toAddress);
      if (!assignedAddress) {
        continue;
      }
      const txHash = log.transactionHash;
      const logIndex = log.index;
      if (this.store.findOnchainDepositByTransfer(this.config.network, txHash, logIndex)) {
        continue;
      }

      const rawAmount = log.args.value as bigint;
      const confirmations = Math.max(0, latestBlock - log.blockNumber + 1);
      const confirmed = confirmations >= this.config.confirmations;
      const deposit: OnchainDeposit = {
        id: `DEP-${txHash.slice(2, 10).toUpperCase()}-${logIndex}`,
        userId: assignedAddress.userId,
        asset: "USDT",
        network: this.config.network,
        chainId: this.config.chainId,
        tokenAddress: this.config.tokenAddress,
        fromAddress: String(log.args.from),
        toAddress,
        amount: rawAmount.toString(),
        amountDecimal: toDecimalAmount(rawAmount, this.config.tokenDecimals),
        txHash,
        logIndex,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        confirmations,
        status: confirmed ? "confirmed" : "confirming",
        creditedLedgerId: null,
        failedReason: null,
        detectedAt: now,
        confirmedAt: confirmed ? now : null,
        createdAt: now,
        updatedAt: now,
      };
      this.store.saveOnchainDeposit(deposit);
      saved += 1;
    }

    this.store.saveChainScanCursor({
      id: `CURSOR-${this.config.network}-${this.config.tokenAddress.toLowerCase()}`,
      network: this.config.network,
      chainId: this.config.chainId,
      tokenAddress: this.config.tokenAddress,
      lastScannedBlock: toBlock,
      updatedAt: Date.now(),
    });
    try {
      await this.refreshPendingDepositConfirmations(latestBlock);
    } catch (error) {
      if (isRateLimitError(error)) {
        return createRateLimitedScanResult(fromBlock, toBlock, error, saved);
      }
      throw error;
    }
    return createScanResult(fromBlock, toBlock, saved);
  }

  async refreshPendingDepositConfirmations(latestBlock = 0) {
    const currentBlock = latestBlock || (await this.withRpcRetry(() => this.provider.getBlockNumber(), "getBlockNumber"));
    for (const deposit of this.store.listPendingOnchainDeposits()) {
      const confirmations = Math.max(0, currentBlock - deposit.blockNumber + 1);
      const confirmed = confirmations >= this.config.confirmations;
      this.store.saveOnchainDeposit({
        ...deposit,
        confirmations,
        status: confirmed ? "confirmed" : "confirming",
        confirmedAt: confirmed ? (deposit.confirmedAt ?? Date.now()) : deposit.confirmedAt,
        updatedAt: Date.now(),
      });
    }
  }

  async broadcastWithdrawal(request: WithdrawalRequest) {
    const privateKey = process.env.BSC_TESTNET_PRIVATE_KEY?.trim();
    if (!privateKey) {
      throw new Error("缺少 BSC_TESTNET_PRIVATE_KEY，无法广播测试网提现。");
    }
    if (!request.toAddress || !isAddress(request.toAddress)) {
      throw new Error("提现目标地址格式不正确。");
    }

    const wallet = new Wallet(privateKey, this.provider);
    const tokenWithSigner = this.token.connect(wallet) as Contract;
    const value = parseUnits(String(request.amount), this.config.tokenDecimals);
    const tx = await tokenWithSigner.transfer(request.toAddress, value);
    return {
      txHash: tx.hash as string,
      fromAddress: wallet.address,
      toAddress: request.toAddress,
    };
  }

  async getTransactionStatus(txHash: string) {
    const receipt = await this.withRpcRetry(() => this.provider.getTransactionReceipt(txHash), "getTransactionReceipt");
    if (!receipt) {
      return { found: false, confirmations: 0, failed: false };
    }
    const latestBlock = await this.withRpcRetry(() => this.provider.getBlockNumber(), "getBlockNumber");
    const confirmations = Math.max(0, latestBlock - receipt.blockNumber + 1);
    return {
      found: true,
      confirmations,
      failed: receipt.status === 0,
      confirmed: confirmations >= this.config.confirmations,
    };
  }

  private async withRpcRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxRpcRetryAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!isRateLimitError(error) || attempt >= maxRpcRetryAttempts) {
          break;
        }
        const waitMs = 800 * 2 ** (attempt - 1);
        console.warn(`[wallet:onchain] RPC rate limited during ${label}; retry ${attempt}/${maxRpcRetryAttempts - 1} in ${waitMs}ms`);
        await delay(waitMs);
      }
    }
    throw lastError;
  }
}

function toDecimalAmount(value: bigint, decimals: number) {
  return Number(formatUnits(value, decimals));
}

function createScanResult(fromBlock: number, toBlock: number, saved: number): OnchainScanResult {
  return {
    fromBlock,
    toBlock,
    scannedBlocks: fromBlock <= toBlock ? toBlock - fromBlock + 1 : 0,
    deposits: saved,
    saved,
    status: "ok",
  };
}

function createRateLimitedScanResult(fromBlock: number, toBlock: number, error: unknown, saved = 0): OnchainScanResult {
  return {
    ...createScanResult(fromBlock, toBlock, saved),
    scannedBlocks: 0,
    status: "rate_limited",
    rateLimited: true,
    message: `BSC Testnet RPC 当前限流，扫描未推进；请稍后重试或更换 RPC。${getErrorMessage(error)}`,
  };
}

function isRateLimitError(error: unknown) {
  const message = getErrorMessage(error);
  return /rate limit|too many requests|429|limit exceeded/i.test(message);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
