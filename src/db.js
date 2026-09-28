const fs = require("fs");
const path = require("path");

const config = require("./config");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, `store-${config.chainId || 31337}.json`);

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let state = {
  lastIndexedBlock: 0,
  processedEvents: {}, // `${txHash}_${logIndex}` => true
  rounds: {},
  players: {}, // `${roundId}_${address.toLowerCase()}` => PlayerEntry
  stats: {},   // `${address.toLowerCase()}` => PlayerStats
};

function load() {
  if (fs.existsSync(DB_FILE)) {
    try {
      state = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
      if (!state.processedEvents) state.processedEvents = {};
    } catch (e) {
      console.error("Error reading db file, initialized with clean state", e.message);
    }
  }
}

function save() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("Error saving db file", e.message);
  }
}

load();

module.exports = {
  getLastIndexedBlock() {
    return state.lastIndexedBlock || 0;
  },
  setLastIndexedBlock(blockNum) {
    state.lastIndexedBlock = blockNum;
    save();
  },

  isEventProcessed(eventId) {
    if (!state.processedEvents) state.processedEvents = {};
    return !!state.processedEvents[eventId];
  },

  markEventProcessed(eventId) {
    if (!state.processedEvents) state.processedEvents = {};
    state.processedEvents[eventId] = true;
    save();
  },

  upsertRound(roundData) {
    const id = roundData.roundId.toString();
    state.rounds[id] = {
      ...(state.rounds[id] || {}),
      ...roundData,
      updatedAt: new Date().toISOString()
    };
    save();
    return state.rounds[id];
  },

  getRound(roundId) {
    return state.rounds[roundId.toString()] || null;
  },

  getAllRounds(filter = {}) {
    let list = Object.values(state.rounds);
    if (filter.asset) {
      if (filter.asset.toUpperCase() === "ETH") {
        list = list.filter(r => !r.paymentToken || r.paymentToken === "0x0000000000000000000000000000000000000000");
      } else if (filter.asset.toUpperCase() === "USDT") {
        list = list.filter(r => r.paymentToken && r.paymentToken !== "0x0000000000000000000000000000000000000000");
      }
    }
    if (filter.status !== undefined) {
      list = list.filter(r => r.state === Number(filter.status) || r.stateName === filter.status);
    }
    return list.sort((a, b) => Number(b.roundId) - Number(a.roundId));
  },

  upsertPlayer(roundId, address, playerData) {
    const key = `${roundId}_${address.toLowerCase()}`;
    state.players[key] = {
      roundId: Number(roundId),
      address: address.toLowerCase(),
      commitment: playerData.commitment || "",
      amount: playerData.amount || "0",
      selectedNumber: playerData.selectedNumber !== undefined ? playerData.selectedNumber : 0,
      revealed: !!playerData.revealed,
      claimed: !!playerData.claimed,
      refunded: !!playerData.refunded,
      updatedAt: new Date().toISOString(),
      ...(state.players[key] || {}),
      ...playerData
    };
    save();
    return state.players[key];
  },

  getRoundPlayers(roundId, hideSecretChoices = true) {
    const players = Object.values(state.players).filter(p => p.roundId === Number(roundId));
    if (hideSecretChoices) {
      return players.map(p => ({
        roundId: p.roundId,
        address: p.address,
        amount: p.amount,
        revealed: p.revealed,
        // Only return selectedNumber if revealed
        selectedNumber: p.revealed ? p.selectedNumber : null,
        claimed: p.claimed,
        refunded: p.refunded
      }));
    }
    return players;
  },

  getPlayerStats(address) {
    const addr = address.toLowerCase();
    return state.stats[addr] || {
      address: addr,
      roundsPlayed: 0,
      roundsWon: 0,
      totalWageredETH: "0",
      totalWageredUSDT: "0",
      totalWonETH: "0",
      totalWonUSDT: "0",
      claimableRewards: []
    };
  },

  recordPlayerActivity(address, { isETH, wagered, won, wonRoundId, claimable }) {
    const addr = address.toLowerCase();
    const current = state.stats[addr] || {
      address: addr,
      roundsPlayed: 0,
      roundsWon: 0,
      totalWageredETH: "0",
      totalWageredUSDT: "0",
      totalWonETH: "0",
      totalWonUSDT: "0",
      claimableRewards: []
    };

    if (wagered) {
      current.roundsPlayed++;
      if (isETH) {
        current.totalWageredETH = (BigInt(current.totalWageredETH) + BigInt(wagered)).toString();
      } else {
        current.totalWageredUSDT = (BigInt(current.totalWageredUSDT) + BigInt(wagered)).toString();
      }
    }

    if (won && wonRoundId) {
      current.roundsWon++;
      if (isETH) {
        current.totalWonETH = (BigInt(current.totalWonETH) + BigInt(won)).toString();
      } else {
        current.totalWonUSDT = (BigInt(current.totalWonUSDT) + BigInt(won)).toString();
      }
    }

    state.stats[addr] = current;
    save();
  },

  getLeaderboard() {
    return Object.values(state.stats)
      .sort((a, b) => b.roundsWon - a.roundsWon)
      .slice(0, 20);
  }
};
