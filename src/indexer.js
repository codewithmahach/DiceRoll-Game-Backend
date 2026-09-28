const { ethers } = require("ethers");
const config = require("./config");
const db = require("./db");
const path = require("path");
const fs = require("fs");

class Indexer {
  constructor() {
    this.provider = null;
    this.contract = null;
    this.isIndexing = false;
    this.pollTimer = null;
  }

  async init() {
    if (!config.contractAddress) {
      console.warn("[Indexer] Contract address not configured yet. Waiting for deployment.");
      return false;
    }

    try {
      this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
      const abiPath = path.join(__dirname, "MultiplayerDiceRoll.json");
      if (!fs.existsSync(abiPath)) {
        console.warn("[Indexer] MultiplayerDiceRoll.json ABI not found yet.");
        return false;
      }
      const artifact = JSON.parse(fs.readFileSync(abiPath, "utf-8"));
      this.contract = new ethers.Contract(config.contractAddress, artifact.abi, this.provider);

      // Validate Sepolia START_BLOCK requirement
      const lastBlock = db.getLastIndexedBlock();
      const currentBlock = await this.provider.getBlockNumber();

      if (config.chainId === 11155111 && lastBlock === 0) {
        if (config.startBlock === null || config.startBlock === undefined || isNaN(config.startBlock)) {
          console.error("\n==================================================================");
          console.error("[FATAL INDEXER CONFIG ERROR] START_BLOCK is required on Sepolia!");
          console.error("Querying from block 0 on Sepolia violates RPC block range limits.");
          console.error("Please set START_BLOCK in backend/.env (to contract deployment block).");
          console.error("==================================================================\n");
          return false;
        }
      }

      const effectiveStart = (lastBlock > 0 && (!config.startBlock || lastBlock >= config.startBlock))
        ? (lastBlock + 1)
        : (config.startBlock || 0);

      console.log("\n==================================================================");
      console.log("               DiceClash Backend Indexer Service                  ");
      console.log("==================================================================");
      console.log(`Network:             ${config.chainId === 11155111 ? "Sepolia Testnet (11155111)" : `Local/Custom (${config.chainId})`}`);
      console.log(`Contract Address:    ${config.contractAddress}`);
      console.log(`Config START_BLOCK:  ${config.startBlock !== null ? config.startBlock : "None (Localhost default: 0)"}`);
      console.log(`Last Indexed Block:  ${lastBlock}`);
      console.log(`Current Block:       ${currentBlock}`);
      console.log(`Effective Start:     ${effectiveStart}`);
      console.log(`Chunk Size:          ${config.chunkSize || 2000} blocks`);
      console.log(`RPC URL:             ${config.rpcUrl}`);
      console.log("==================================================================\n");

      return true;
    } catch (e) {
      console.error("[Indexer] Init failed:", e.message);
      return false;
    }
  }

  getEventId(eventLog) {
    if (!eventLog) return `evt_${Date.now()}_${Math.random()}`;
    const txHash = eventLog.transactionHash || (eventLog.log && eventLog.log.transactionHash) || "unknown_tx";
    const logIndex = eventLog.index !== undefined ? eventLog.index : (eventLog.log && eventLog.log.index !== undefined ? eventLog.log.index : 0);
    return `${txHash}_${logIndex}`;
  }

  async handleEvent(eventName, args, eventLog) {
    const eventId = this.getEventId(eventLog);
    if (db.isEventProcessed(eventId)) {
      return; // Idempotency check: already processed
    }

    const blockNumber = eventLog.blockNumber || (eventLog.log && eventLog.log.blockNumber) || 0;

    switch (eventName) {
      case "RoundCreated": {
        const [roundId, paymentToken, entryAmount, minPlayers, maxPlayers, joinDeadline] = args;
        console.log(`[Event:RoundCreated] Round #${roundId} (${paymentToken === ethers.ZeroAddress ? "ETH" : "USDT"})`);
        db.upsertRound({
          roundId: Number(roundId),
          paymentToken,
          isETH: paymentToken === ethers.ZeroAddress,
          entryAmount: entryAmount.toString(),
          minPlayers: Number(minPlayers),
          maxPlayers: Number(maxPlayers),
          joinDeadline: Number(joinDeadline),
          playerCount: 0,
          revealedCount: 0,
          rollCount: 0,
          state: 0,
          stateName: "OPEN",
          totalDeposits: "0"
        });
        break;
      }

      case "PlayerCommitted": {
        const [roundId, player, commitment, amount] = args;
        console.log(`[Event:PlayerCommitted] Player ${player} joined Round #${roundId}`);
        // NOTE: Secret number is hidden and NOT indexed here!
        db.upsertPlayer(roundId, player, {
          commitment,
          amount: amount.toString(),
          revealed: false,
          selectedNumber: 0
        });

        // Compute idempotent player count & deposits from unique players
        const allRoundPlayers = db.getRoundPlayers(roundId, false);
        const totalDep = allRoundPlayers.reduce((sum, p) => sum + BigInt(p.amount || "0"), 0n);

        db.upsertRound({
          roundId: Number(roundId),
          playerCount: allRoundPlayers.length,
          totalDeposits: totalDep.toString()
        });

        const r = db.getRound(roundId);
        db.recordPlayerActivity(player, {
          isETH: !r || r.isETH,
          wagered: amount.toString()
        });
        break;
      }

      case "RoundLocked": {
        const [roundId, revealDeadline] = args;
        console.log(`[Event:RoundLocked] Round #${roundId} locked. Reveal deadline: ${revealDeadline}`);
        db.upsertRound({
          roundId: Number(roundId),
          state: 2,
          stateName: "REVEAL_PHASE",
          revealDeadline: Number(revealDeadline)
        });
        break;
      }

      case "PlayerRevealed": {
        const [roundId, player, selectedNumber] = args;
        console.log(`[Event:PlayerRevealed] Player ${player} revealed #${selectedNumber} in Round #${roundId}`);
        db.upsertPlayer(roundId, player, {
          revealed: true,
          selectedNumber: Number(selectedNumber)
        });

        const allRoundPlayers = db.getRoundPlayers(roundId, false);
        const revealed = allRoundPlayers.filter(p => p.revealed).length;
        db.upsertRound({
          roundId: Number(roundId),
          revealedCount: revealed
        });
        break;
      }

      case "PlayerRevealExpired": {
        const [roundId, player] = args;
        console.log(`[Event:PlayerRevealExpired] Player ${player} forfeited selection in Round #${roundId}`);
        break;
      }

      case "RandomnessRequested": {
        const [roundId, requestId] = args;
        console.log(`[Event:RandomnessRequested] Round #${roundId} -> VRF Request #${requestId}`);
        db.upsertRound({
          roundId: Number(roundId),
          state: 3,
          stateName: "RANDOMNESS_PENDING",
          vrfRequestId: requestId.toString()
        });
        break;
      }

      case "DiceRolled": {
        const [roundId, winningNumber, winnerCount, distributablePool, winnerReward] = args;
        console.log(`[Event:DiceRolled] Round #${roundId} -> Result: ${winningNumber} with ${winnerCount} winners!`);
        db.upsertRound({
          roundId: Number(roundId),
          winningNumber: Number(winningNumber),
          winnerCount: Number(winnerCount),
          distributablePool: distributablePool.toString(),
          winnerReward: winnerReward.toString(),
          state: 4,
          stateName: "RESULT_READY"
        });

        const players = db.getRoundPlayers(roundId, false);
        for (const p of players) {
          if (p.revealed && p.selectedNumber === Number(winningNumber)) {
            const r = db.getRound(roundId);
            db.recordPlayerActivity(p.address, {
              isETH: r ? r.isETH : true,
              won: winnerReward.toString(),
              wonRoundId: Number(roundId)
            });
          }
        }
        break;
      }

      case "NoWinnerRolled": {
        const [roundId, rolledNumber, rollCount] = args;
        console.log(`[Event:NoWinnerRolled] Round #${roundId} rolled ${rolledNumber} (Zero Winners). Roll #${rollCount}`);
        db.upsertRound({
          roundId: Number(roundId),
          state: 5,
          stateName: "NO_WINNER",
          rollCount: Number(rollCount),
          lastRolledNumber: Number(rolledNumber),
          winningNumber: Number(rolledNumber)
        });
        break;
      }

      case "RoundRerolled": {
        const [roundId, rollCount] = args;
        console.log(`[Event:RoundRerolled] Round #${roundId} rerolled (Attempt #${rollCount})`);
        db.upsertRound({
          roundId: Number(roundId),
          state: 3,
          stateName: "RANDOMNESS_PENDING",
          rollCount: Number(rollCount)
        });
        break;
      }

      case "RewardClaimed": {
        const [roundId, player, amount] = args;
        console.log(`[Event:RewardClaimed] Player ${player} claimed ${amount} for Round #${roundId}`);
        db.upsertPlayer(roundId, player, { claimed: true });
        break;
      }

      case "RoundRefunded": {
        const [roundId, player, amount] = args;
        console.log(`[Event:RoundRefunded] Player ${player} refunded ${amount} from Round #${roundId}`);
        db.upsertPlayer(roundId, player, { refunded: true });
        break;
      }

      case "RoundCancelled": {
        const [roundId, reason] = args;
        console.log(`[Event:RoundCancelled] Round #${roundId} cancelled: ${reason}`);
        db.upsertRound({
          roundId: Number(roundId),
          state: 7,
          stateName: "CANCELLED",
          cancelReason: reason
        });
        break;
      }

      default:
        break;
    }

    db.markEventProcessed(eventId);
    if (blockNumber > db.getLastIndexedBlock()) {
      db.setLastIndexedBlock(blockNumber);
    }
  }

  async catchUpHistoricalEvents() {
    try {
      const currentBlock = await this.provider.getBlockNumber();
      const lastBlock = db.getLastIndexedBlock();

      let fromBlock;
      if (lastBlock > 0) {
        fromBlock = lastBlock + 1;
      } else {
        if (config.chainId === 11155111) {
          if (config.startBlock === null || config.startBlock === undefined || isNaN(config.startBlock)) {
            console.error("[Indexer] Fatal: START_BLOCK is required on Sepolia when no previous block is indexed.");
            return;
          }
          fromBlock = Number(config.startBlock);
        } else {
          fromBlock = (config.startBlock !== null && config.startBlock !== undefined) ? Number(config.startBlock) : 0;
        }
      }

      if (fromBlock > currentBlock) {
        return; // Up to date
      }

      const chunkSize = config.chunkSize || 2000;
      const totalBlocks = currentBlock - fromBlock + 1;

      if (totalBlocks > 1) {
        console.log(`[Indexer] Catching up historical events: blocks ${fromBlock} to ${currentBlock} (${totalBlocks} blocks, chunk size ${chunkSize})...`);
      }

      const eventNames = [
        "RoundCreated",
        "PlayerCommitted",
        "RoundLocked",
        "PlayerRevealed",
        "PlayerRevealExpired",
        "RandomnessRequested",
        "DiceRolled",
        "NoWinnerRolled",
        "RoundRerolled",
        "RewardClaimed",
        "RoundRefunded",
        "RoundCancelled"
      ];

      // Process in safe RPC chunks
      let chunkStart = fromBlock;
      while (chunkStart <= currentBlock) {
        const chunkEnd = Math.min(chunkStart + chunkSize - 1, currentBlock);

        for (const evName of eventNames) {
          try {
            const filter = this.contract.filters[evName]();
            const logs = await this.contract.queryFilter(filter, chunkStart, chunkEnd);
            for (const log of logs) {
              await this.handleEvent(evName, log.args, log);
            }
          } catch (filterErr) {
            console.warn(`[Indexer] Warning querying ${evName} [${chunkStart}-${chunkEnd}]:`, filterErr.message);
          }
        }

        db.setLastIndexedBlock(chunkEnd);
        chunkStart = chunkEnd + 1;
      }

      if (totalBlocks > 1) {
        console.log(`[Indexer] Historical catch-up completed at block ${currentBlock}.`);
      }
    } catch (err) {
      console.error("[Indexer] Historical event catch-up error:", err.message);
    }
  }

  async start() {
    if (this.isIndexing) return;
    const ready = await this.init();
    if (!ready) {
      setTimeout(() => this.start(), 4000);
      return;
    }

    this.isIndexing = true;
    console.log("[Indexer] Starting indexer service loop...");

    // 1. Initial catch-up of historical events
    await this.catchUpHistoricalEvents();

    // 2. Continuous reliable polling via eth_getLogs (queryFilter)
    this.pollTimer = setInterval(async () => {
      await this.catchUpHistoricalEvents();
    }, config.pollIntervalMs || 3000);
  }
}

module.exports = new Indexer();
