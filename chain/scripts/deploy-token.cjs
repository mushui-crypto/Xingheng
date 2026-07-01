function requiredEnv(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

async function main() {
  const { network } = await import("hardhat");
  const { ethers } = await network.connect("bscTestnet");
  const tokenName = requiredEnv("BSC_TESTNET_TOKEN_NAME", "StellarX Test USD");
  const tokenSymbol = requiredEnv("BSC_TESTNET_TOKEN_SYMBOL", "sUSDT");
  const tokenDecimals = Number(requiredEnv("BSC_TESTNET_TOKEN_DECIMALS", "18"));
  const [deployer] = await ethers.getSigners();
  const owner = deployer?.address;

  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 255) {
    throw new Error(`Invalid BSC_TESTNET_TOKEN_DECIMALS: ${tokenDecimals}`);
  }

  if (!deployer) {
    throw new Error("No deployer signer available. Check BSC_TESTNET_PRIVATE_KEY.");
  }

  const factory = await ethers.getContractFactory("StellarXTestToken");
  const contract = await factory.deploy(tokenName, tokenSymbol, tokenDecimals, owner);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(JSON.stringify({
    network: "bscTestnet",
    deployer: deployer.address,
    owner,
    tokenName,
    tokenSymbol,
    tokenDecimals,
    tokenAddress: address,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
