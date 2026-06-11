# ChainFlux
### Markets powered by Blockchain activities.

ChainFlux is a two-layer platform built on Arbitrum Sepolia that transforms live Ethereum network activity into tradeable perpetual markets. Blockchain data has always been observable but never tradeable. ChainFlux is the first market for it.

---

## Two Layers

**Attention Layer** — for everyone. Builders, researchers, protocols, traders, curious people. Answers the question "what is happening on Ethereum right now and what does it mean." Not raw data. Interpreted signals. Eight live metrics aggregated into a single Attention Score from 0 to 100.

**Trading Layer** — for traders. Perpetual markets on Gas Price and Transactions Per Block. Act on the signals the Attention Layer surfaces.

---

## Markets

| Slot | Market | Tracks |
|---|---|---|
| 0 | GAS | Ethereum gas price in gwei |
| 2 | TXS PER BLOCK | Transactions per block |

---

## How It Works

1. Connect your wallet on Arbitrum Sepolia
2. Pick a market and direction (LONG or SHORT)
3. Choose your leverage (tier gated, up to 30x)
4. Hold for at least 20 minutes to earn CFT rewards
5. Close anytime and collect your PnL in ETH

Prices update every 15 seconds from live Ethereum data via the keeper.

---

## Tech Stack

- Solidity 0.8.34 — Smart contracts
- OpenZeppelin — Upgradeable proxy (UUPS)
- Arbitrum Sepolia — Testnet deployment
- Node.js — Keeper script (price and network feed)
- Railway — Keeper hosting
- React, TanStack Router, Tailwind CSS — Frontend
- Lovable — Frontend hosting
- Alchemy — RPC provider
- Etherscan API v2 — Network data
- DeFiLlama API — DeFi metrics (TVL, DEX volume, stablecoin flows)

---

## Smart Contracts

See [deployments.md](./deployments.md) for all contract addresses.

| Contract | Role |
|---|---|
| ChainFlux.sol | Core logic — trading, PnL, liquidations, CFT token |
| ChainFluxProxy.sol | Permanent proxy address — never changes |
| ChainFluxKeeper.sol | Authorized price pusher |

---

## Token: CFT (ChainFlux Token)

CFT is a full ERC-20 built into ChainFlux.sol.

- Total supply: 1,000,000,000 CFT
- 700,000,000 CFT allocated to trading rewards pool
- 300,000,000 CFT allocated to founder wallet
- Earned by holding positions for at least 20 minutes
- Win bonus: 2x CFT on profitable closes
- Formula: collateral in ETH x leverage x 1000

---

## Tier System

| Tier | CFT Required | Max Leverage |
|---|---|---|
| Unranked | 0 | 5x |
| Bronze | 5,000 | 10x |
| Silver | 50,000 | 20x |
| Gold | 200,000 | 25x |
| Diamond | 500,000 | 30x |

---

## Attention Score

Eight live Ethereum signals weighted into a composite score from 0 to 100.

| Signal | Weight |
|---|---|
| Gas Price | 20% |
| Transactions Per Block | 20% |
| Network Utilization | 15% |
| Active Addresses | 10% |
| DEX Volume | 10% |
| DeFi TVL Change | 10% |
| Liquidations | 10% |
| Stablecoin Flows | 5% |

Labels: 0-30 Attention Cooling, 31-60 Attention Rising, 61-85 Attention Surging, 86-100 Attention Critical.

---

## Fee Model

- 0.3% fee on every trade
- Goes to protocol treasury

---

## Live

Frontend: https://chainfluxio.lovable.app
Keeper: https://chainflux-production.up.railway.app

---

## Roadmap

- [x] Smart contracts deployed and verified on Arbiscan
- [x] UUPS upgradeable proxy live
- [x] Keeper authorized and running on Railway
- [x] Attention Layer live with 8 real-time signals
- [x] Perpetual markets live on Gas and TXS Per Block
- [x] CFT token and tier system live
- [x] Frontend live
- [ ] Mainnet launch
