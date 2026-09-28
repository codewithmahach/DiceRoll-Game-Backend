# DiceClash Backend Service

Fast, event-driven Web3 backend indexer and REST API for the **DiceClash Multiplayer Dice Roll Game** on Ethereum / Sepolia.

---

## 🚀 Features
- **Event-Driven Indexer**: Listens for on-chain events (`RoundCreated`, `PlayerCommitted`, `PlayerRevealed`, `RoundLocked`, `RoundRolled`, `BountyClaimed`).
- **REST API Endpoints**:
  - `GET /api/health` - Service health status & connected chain ID.
  - `GET /api/config` - Game parameters & deployed contract addresses.
  - `GET /api/rounds` - Active and past game rounds (filtered by asset & status).
  - `GET /api/rounds/:id` - Complete details for a specific round.
  - `GET /api/player/:address/history` - User match history.
  - `GET /api/player/:address/stats` - User stats (wins, volume, earnings).
  - `GET /api/leaderboard` - Top players ranked by earnings and wins.
- **Render Ready**: Automatic port binding via `process.env.PORT` and CORS enabled for frontend connections.

---

## 🛠️ Deployment on Render

1. **New Web Service**: Connect this GitHub repository (`DiceRoll-Game-Backend`) on [Render.com](https://render.com).
2. **Environment**: `Node`
3. **Build Command**: `npm install`
4. **Start Command**: `npm start`
5. **Environment Variables**:
   - `PORT`: `5001` (Render sets this automatically)
   - `RPC_URL`: Your Ethereum Sepolia RPC URL (e.g. Alchemy, Infura, or public RPC)
   - `CHAIN_ID`: `11155111`
   - `CONTRACT_ADDRESS`: Deployed `MultiplayerDiceRoll` contract address
   - `USDT_ADDRESS`: Deployed `MockUSDT` contract address
   - `START_BLOCK`: Block number when contract was deployed (for fast historical sync)
   - `INDEXER_CHUNK_SIZE`: `2000`
   - `POLL_INTERVAL_MS`: `3000`
   - `ENABLE_DEV_KEEPER`: `false` (keep false unless running automated bot)

---

## 💻 Local Development

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env

# 3. Start development server
npm run dev
```
