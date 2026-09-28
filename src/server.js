const express = require("express");
const cors = require("cors");
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

app.get("/api/rounds/:id", (req, res) => {
  const round = db.getRound(req.params.id);
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
