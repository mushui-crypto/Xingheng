import { Button } from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";
import { formatWalletNetwork } from "../lib/walletNetwork";
import type { HyperliquidSessionController } from "../lib/useHyperliquidSessionSigner";

export function WalletNetworkGateModal({ session }: { session: HyperliquidSessionController }) {
  const { networkGate } = session;
  return (
    <Modal
      closeDisabled={networkGate.switching}
      description="Agent 授权签名需要使用产品固定网络。"
      onClose={session.cancelNetworkSwitch}
      open={networkGate.open}
      shellClassName="xh-wallet-network-modal"
      title="切换钱包网络"
    >
      <div className="xh-wallet-network-summary">
        <div><span>当前网络</span><strong>{formatWalletNetwork(networkGate.currentChainId)}</strong></div>
        <div><span>目标网络</span><strong>Arbitrum Sepolia · 421614</strong></div>
      </div>
      <p className="xh-wallet-network-note" role="note">
        切链仅用于浏览器本地 Agent 授权签名，不会转移资产，也不会消耗 Gas。
      </p>
      {networkGate.error ? <p className="xh-wallet-network-error" role="alert">{networkGate.error}</p> : null}
      <div className="xh-real-confirm-actions">
        <Button disabled={networkGate.switching} onClick={session.cancelNetworkSwitch} type="button" variant="secondary">取消</Button>
        <Button autoFocus disabled={networkGate.switching} onClick={() => void session.switchNetwork()} type="button">
          {networkGate.switching ? "切换中" : "切换到 Arbitrum Sepolia"}
        </Button>
      </div>
    </Modal>
  );
}
