const { ethers } = require("ethers");
const config = require("./config");
const db = require("./db");
const path = require("path");
const fs = require("fs");

class Keeper {
  constructor() {
    this.wallet = null;
    this.contract = null;
    this.running = false;
  }

  init() {
    if (!config.enableDevKeeper) {
      console.log("[Keeper] Background keeper is DISABLED (ENABLE_DEV_KEEPER is not true). Contract functions are driven permissionlessly.");
      return false;
    }

    if (!config.contractAddress) {
      console.warn("[Keeper] Contract address not configured yet. Waiting for deployment.");
      return false;
    }

    if (!config.keeperPrivateKey) {
      console.error("\n[FATAL KEEPER CONFIG ERROR] ENABLE_DEV_KEEPER=true, but KEEPER_PRIVATE_KEY is missing!");
      console.error("Provide a dedicated funded private key via KEEPER_PRIVATE_KEY or set ENABLE_DEV_KEEPER=false.\n");
      return false;
    }

    // Safety: ensure Hardhat default key is never used on Sepolia
    const KNOWN_HARDHAT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    if (config.chainId === 11155111 && config.keeperPrivateKey.toLowerCase() === KNOWN_HARDHAT_KEY.toLowerCase()) {
      console.error("\n[FATAL KEEPER SECURITY ERROR] Attempted to use known Hardhat Account #0 private key on Sepolia!");
      console.error("Refusing to initialize keeper with an insecure publicly known development key.\n");
      return false;
    }

    try {
      const provider = new ethers.JsonRpcProvider(config.rpcUrl);
      this.wallet = new ethers.Wallet(config.keeperPrivateKey, provider);
      const abiPath = path.join(__dirname, "MultiplayerDiceRoll.json");
      if (!fs.existsSync(abiPath)) return false;
      const artifact = JSON.parse(fs.readFileSync(abiPath, "utf-8"));
      this.contract = new ethers.Contract(config.contractAddress, artifact.abi, this.wallet);
      console.log(`[Keeper] Initialized keeper with wallet: ${this.wallet.address}`);
      return true;
    } catch (e) {
      console.error("[Keeper] Init error:", e.message);
      return false;
    }
  }

  async runKeeperLoop() {
    if (!config.enableDevKeeper) {
      console.log("[Keeper] Background keeper loop skipped (ENABLE_DEV_KEEPER=false).");
      return;
    }

    if (this.running) return;
    const ready = this.init();
    if (!ready) {
      console.warn("[Keeper] Keeper failed initialization. Automated keeper service will not run.");
      return;
    }

    this.running = true;
    console.log("[Keeper] Background keeper loop started (monitoring rounds for locks & reveals)...");

    setInterval(async () => {
      try {
        const rounds = db.getAllRounds();
        const now = Math.floor(Date.now() / 1000);

        for (const round of rounds) {
          // Query live on-chain round data to prevent stale state reverts
          let onChainRound;
          try {
            onChainRound = await this.contract.getRound(round.roundId);
          } catch {
            continue;
          }

          const onChainState = Number(onChainRound.state);

          // 1. Check if an OPEN round has passed joinDeadline
          if (onChainState === 0 && onChainRound.joinDeadline && now >= Number(onChainRound.joinDeadline)) {
            const pCount = Number(onChainRound.playerCount);
            const minP = Number(onChainRound.minPlayers);
            if (pCount >= minP || pCount > 0) {
              console.log(`[Keeper] Round #${round.roundId} passed join deadline. Triggering lockRound...`);
              const tx = await this.contract.lockRound(round.roundId);
              await tx.wait();
            }
          }

          // 2. Check if a REVEAL_PHASE round has reveal deadline passed
          // If all players revealed, reveal() already auto-requested VRF (moving state to 3).
          // Keeper only calls closeRevealAndRequestRoll when state is still 2 and deadline passed.
          if (onChainState === 2 && onChainRound.revealDeadline) {
            const deadlinePassed = now >= Number(onChainRound.revealDeadline);
            if (deadlinePassed) {
              console.log(`[Keeper] Round #${round.roundId} reveal deadline passed. Triggering closeRevealAndRequestRoll...`);
              const tx = await this.contract.closeRevealAndRequestRoll(round.roundId);
              await tx.wait();
            }
          }
        }
      } catch (e) {
        // Suppress expected blockchain reverted/timing errors in loop
        if (!e.message.includes("RoundNotLocked") && !e.message.includes("RevealPeriodActive")) {
          // console.warn("[Keeper] Tick warning:", e.message);
        }
      }
    }, 4000);
  }
}

module.exports = new Keeper();
