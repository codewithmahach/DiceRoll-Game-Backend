const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");

const backendEnvPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(backendEnvPath)) {
  dotenv.config({ path: backendEnvPath });
}
const rootEnvPath = path.join(__dirname, "..", "..", ".env");
if (fs.existsSync(rootEnvPath)) {
  dotenv.config({ path: rootEnvPath });
}
dotenv.config();

let deployed = {};
const deployedPath = path.join(__dirname, "deployedAddresses.json");
if (fs.existsSync(deployedPath)) {
  try {
    deployed = JSON.parse(fs.readFileSync(deployedPath, "utf-8"));
  } catch (err) {
    console.warn("[Config] Could not read deployedAddresses.json, using defaults or env");
  }
}

const targetChainId = Number(process.env.CHAIN_ID || deployed.chainId || 11155111);
const networkDeployed = (deployed.networks && deployed.networks[targetChainId]) ? deployed.networks[targetChainId] : deployed;

// Calculate startBlock: env START_BLOCK > deployed.startBlock > (0 for localhost, null for Sepolia)
let parsedStartBlock = null;
if (process.env.START_BLOCK !== undefined && process.env.START_BLOCK !== "") {
  parsedStartBlock = Number(process.env.START_BLOCK);
} else if (networkDeployed.startBlock !== undefined && networkDeployed.startBlock !== null) {
  parsedStartBlock = Number(networkDeployed.startBlock);
} else if (targetChainId === 31337) {
  parsedStartBlock = 0;
}

// Strict boolean parsing: Must be explicitly "true", defaults to false
const enableDevKeeper = process.env.ENABLE_DEV_KEEPER === "true";

module.exports = {
  port: Number(process.env.PORT || 5001),
  rpcUrl: process.env.RPC_URL || process.env.SEPOLIA_RPC_URL || (targetChainId === 11155111 ? "https://ethereum-sepolia-rpc.publicnode.com" : "http://127.0.0.1:8545"),
  chainId: targetChainId,
  contractAddress: process.env.CONTRACT_ADDRESS || networkDeployed.multiplayerDiceRoll || "",
  usdtAddress: process.env.USDT_ADDRESS || networkDeployed.mockUSDT || networkDeployed.usdtAddress || "",
  vrfCoordinator: process.env.VRF_COORDINATOR || networkDeployed.vrfCoordinator || networkDeployed.mockVRFCoordinator || "",
  treasuryAddress: process.env.TREASURY_ADDRESS || networkDeployed.treasury || "",
  startBlock: parsedStartBlock,
  // NEVER provide a fallback private key. Must be explicitly supplied in env when keeper is enabled.
  keeperPrivateKey: process.env.KEEPER_PRIVATE_KEY || null,
  enableDevKeeper: enableDevKeeper,
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 3000),
  chunkSize: Number(process.env.INDEXER_CHUNK_SIZE || 2000),
};
