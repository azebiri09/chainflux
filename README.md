# CHAINFLUX
### Trade the heartbeat of blockchain

A perpetual trading platform where blockchain activity itself becomes the tradable asset. Instead of trading BTC or ETH, users trade live Arbitrum network behavior.

---

## Markets

| Market | Tracks | Represents |
|---|---|---|
| GAS | Arbitrum gas/base fee | Network congestion |
| ACTIVITY | Transaction count | Usage intensity |
| FLOW | ETH transfer volume | Capital movement |

---

## How It Works

1. Connect your wallet
2. Pick a market — GAS, ACTIVITY, or FLOW
3. Go LONG or SHORT
4. Close anytime and collect your PnL

Prices update every ~20 blocks from live Arbitrum data via Arbiscan API.

---

## Tech Stack

- Solidity 0.8.20 — Smart contracts
- OpenZeppelin 5.0.2 — Upgradeable proxy (UUPS)
- Arbitrum Sepolia — Testnet
- Node.js — Keeper script (price feed)
- Railway — Keeper hosting
- Lovable — Frontend

---

## Smart Contracts

See [deployments.md](./deployments.md) for all contract addresses.

| Contract | Role |
|---|---|
| ChainFlux.sol | Core logic — trading, PnL, CFT token |
| ChainFluxProxy.sol | Permanent address — never changes |
| ChainFluxKeeper.sol | Authorized price pusher |

---

## Token — $CFT

CFT (ChainFlux Token) is an internal position receipt token.
- Minted when you open a trade
- Burned when you close
- Represents your market exposure

---

## Fee Model

- 0.3% fee on every trade
- Goes to protocol treasury

---

## Roadmap

- [x] Smart contracts deployed
- [x] Keeper authorized
- [ ] Keeper script live
- [ ] Frontend live on Lovable
- [ ] Chainlink Automation integration
- [ ] Mainnet launch
