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
  const recipient = requiredEnv("MINT_TO");
  const amount = requiredEnv("MINT_AMOUNT");

  const contract = await ethers.getContractAt("StellarXTestToken", tokenAddress);
  const decimals = await contract.decimals();
  const parsedAmount = ethers.parseUnits(amount, decimals);

  const tx = await contract.mint(recipient, parsedAmount);
  const receipt = await tx.wait();

  console.log(JSON.stringify({
    network: "bscTestnet",
    tokenAddress,
    recipient,
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
