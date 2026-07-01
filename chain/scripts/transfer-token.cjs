function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

async function main() {
  const { network } = await import("hardhat");
  const { ethers } = await network.connect("bscTestnet");
  const tokenAddress = requiredEnv("BSC_TESTNET_TOKEN_ADDRESS");
  const recipient = requiredEnv("TRANSFER_TO");
  const amount = requiredEnv("TRANSFER_AMOUNT");

  const [sender] = await ethers.getSigners();
  if (!sender) {
    throw new Error("No sender signer available. Check BSC_TESTNET_PRIVATE_KEY.");
  }

  const contract = await ethers.getContractAt("StellarXTestToken", tokenAddress);
  const decimals = await contract.decimals();
  const parsedAmount = ethers.parseUnits(amount, decimals);

  const tx = await contract.transfer(recipient, parsedAmount);
  const receipt = await tx.wait();

  console.log(JSON.stringify({
    network: "bscTestnet",
    tokenAddress,
    from: sender.address,
    to: recipient,
    amount,
    decimals: Number(decimals),
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
