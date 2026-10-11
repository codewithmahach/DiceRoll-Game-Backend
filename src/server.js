const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { ethers } = require("ethers");
const config = require("./config");
const db = require("./db");
const indexer = require("./indexer");
const keeper = require("./keeper");

const app = express();
app.use(cors());
app.use(express.json());

// 1. Health & Config
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    chainId: config.chainId,
    contractAddress: config.contractAddress,
    indexing: indexer.isIndexing
  });
});

app.get("/api/config", (req, res) => {
  res.json({
    chainId: config.chainId,
    contractAddress: config.contractAddress,
    usdtAddress: config.usdtAddress,
    vrfCoordinator: config.vrfCoordinator,
    treasuryAddress: config.treasuryAddress,
    minDiceNumber: 1,
    maxDiceNumber: 6,
    maxRerolls: 3,
    platformFeeBps: 200 // 2%
  });
});

// 2. Rounds API
app.get("/api/rounds", (req, res) => {
  const { asset, status } = req.query;
  const rounds = db.getAllRounds({ asset, status });
  res.json({
    success: true,
    count: rounds.length,
    rounds
  });
});

app.get("/api/rounds/:id", async (req, res) => {
  let round = db.getRound(req.params.id);
  if (!round && indexer.contract) {
    try {
      const r = await indexer.contract.getRound(req.params.id);
      if (r && Number(r.roundId) > 0) {
        round = {
          roundId: Number(r.roundId),
          paymentToken: r.paymentToken,
          entryAmount: r.entryAmount.toString(),
          minPlayers: Number(r.minPlayers),
          maxPlayers: Number(r.maxPlayers),
          playerCount: Number(r.playerCount),
          revealedCount: Number(r.revealedCount),
          rollCount: Number(r.rollCount),
          totalDeposits: r.totalDeposits.toString(),
          state: Number(r.state),
          winningNumber: Number(r.winningNumber),
          winnerCount: Number(r.winnerCount),
          winnerReward: r.winnerReward.toString(),
          remainder: r.remainder.toString(),
          joinDeadline: Number(r.joinDeadline),
          revealDeadline: Number(r.revealDeadline),
          vrfRequestId: r.vrfRequestId.toString()
        };
      }
    } catch (e) {
      console.warn(`[Backend] Contract fallback for round #${req.params.id}:`, e.message);
    }
  }

  if (!round) {
    return res.status(404).json({ success: false, error: "Round not found" });
  }

  // Hide secret choices until reveal
  const players = db.getRoundPlayers(req.params.id, true);

  // Group revealed players into buckets (1..6)
  const buckets = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const p of players) {
    if (p.revealed && p.selectedNumber >= 1 && p.selectedNumber <= 6) {
      buckets[p.selectedNumber].push(p.address);
    }
  }

  res.json({
    success: true,
    round: {
      ...round,
      players,
      buckets
    }
  });
});

app.get("/api/rounds/:id/players", (req, res) => {
  const players = db.getRoundPlayers(req.params.id, true);
  res.json({
    success: true,
    roundId: Number(req.params.id),
    count: players.length,
    players
  });
});

app.post("/api/rounds/:id/fast-roll", async (req, res) => {
  try {
    const roundId = Number(req.params.id);
    if (!roundId || isNaN(roundId)) {
      return res.status(400).json({ success: false, error: "Invalid roundId" });
    }

    if (!config.keeperPrivateKey) {
      return res.status(503).json({ success: false, error: "Keeper private key not configured" });
    }

    const provider = new ethers.JsonRpcProvider(config.rpcUrl);
    const wallet = new ethers.Wallet(config.keeperPrivateKey, provider);
    const abiPath = path.join(__dirname, "MultiplayerDiceRoll.json");
    if (!fs.existsSync(abiPath)) {
      return res.status(500).json({ success: false, error: "ABI not found" });
    }
    const artifact = JSON.parse(fs.readFileSync(abiPath, "utf-8"));
    const contract = new ethers.Contract(config.contractAddress, artifact.abi, wallet);

    const onChainRound = await contract.getRound(roundId);
    const stateNum = Number(onChainRound.state);

    if (stateNum !== 3) {
      return res.json({
        success: true,
        alreadySettled: true,
        state: stateNum,
        winningNumber: Number(onChainRound.winningNumber),
        message: `Round is not in RANDOMNESS_PENDING (current state: ${stateNum})`
      });
    }

    console.log(`[FastRoll] Settle requested for Round #${roundId}...`);
    const originalCoordinator = await contract.vrfCoordinator();

    if (originalCoordinator.toLowerCase() !== wallet.address.toLowerCase()) {
      const tx1 = await contract.setVRFCoordinator(wallet.address);
      await tx1.wait();
    }

    const randomWord = ethers.toBigInt(ethers.hexlify(ethers.randomBytes(32)));
    const tx2 = await contract.rawFulfillRandomWords(onChainRound.vrfRequestId, [randomWord]);
    await tx2.wait();

    if (originalCoordinator.toLowerCase() !== wallet.address.toLowerCase()) {
      try {
        const tx3 = await contract.setVRFCoordinator(originalCoordinator);
        await tx3.wait();
      } catch (err) {
        console.warn("[FastRoll] Could not restore coordinator:", err.message);
      }
    }

    const updatedRound = await contract.getRound(roundId);
    return res.json({
      success: true,
      roundId,
      state: Number(updatedRound.state),
      winningNumber: Number(updatedRound.winningNumber),
      winnerCount: Number(updatedRound.winnerCount)
    });
  } catch (error) {
    console.error("[FastRoll Error]:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Player Stats & History
app.get("/api/player/:address/stats", (req, res) => {
  const stats = db.getPlayerStats(req.params.address);
  res.json({
    success: true,
    stats
  });
});

app.get("/api/player/:address/history", (req, res) => {
  const addr = req.params.address.toLowerCase();
  const allRounds = db.getAllRounds();
  const userRounds = [];

  for (const r of allRounds) {
    const players = db.getRoundPlayers(r.roundId, false);
    const userEntry = players.find(p => p.address.toLowerCase() === addr);
    if (userEntry) {
      userRounds.push({
        round: r,
        entry: userEntry
      });
    }
  }

  res.json({
    success: true,
    address: addr,
    count: userRounds.length,
    history: userRounds
  });
});

// 4. Leaderboard
app.get("/api/leaderboard", (req, res) => {
  const leaderboard = db.getLeaderboard();
  res.json({
    success: true,
    leaderboard
  });
});

// Process-level crash prevention for RPC glitches
process.on("unhandledRejection", (reason) => {
  console.warn("[Process] Handled unhandledRejection:", reason && (reason.message || reason));
});
process.on("uncaughtException", (err) => {
  console.error("[Process] Handled uncaughtException:", err && (err.message || err));
});

// Start Server & Background Services
app.listen(config.port, () => {
  console.log(`[API Server] Running on http://localhost:${config.port}`);
  indexer.start();
  keeper.runKeeperLoop();
});
