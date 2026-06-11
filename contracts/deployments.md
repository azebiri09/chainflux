# ChainFlux Deployments

Network: Arbitrum Sepolia (Chain ID 421614)

## Contracts

| Contract | Address |
|---|---|
| ChainFlux Logic V5 (current active) | 0x1A989e3f818DA166c23898742519006119D87135 |
| ChainFluxProxy (permanent, never redeploy) | 0x615d3801019D33609Eed27EB39D40AB49fa44fAF |
| ChainFluxKeeper (price pusher) | 0xCB2E158022A7d741c01e73D56FAe5FB2e2cB38Ba |

## Key Addresses

| Role | Address |
|---|---|
| Keeper Wallet / Owner | 0xbfcB136f6e15511312557c613792839A666e0843 |
| Founder Wallet | 0x67FccFd9c5e0A8863478D6561dcB49279B209E62 |

## Perps Markets

| Slot | Market |
|---|---|
| 0 | GAS |
| 1 | LIQUIDATIONS (reserved) |
| 2 | TXS PER BLOCK |
| 3 to 7 | RESERVED |

## Token

CFT is built into the proxy contract at 0x615d3801019D33609Eed27EB39D40AB49fa44fAF

Total Supply: 1,000,000,000 CFT

| Allocation | Amount | Wallet |
|---|---|---|
| Trading Rewards Pool | 700,000,000 CFT | Proxy contract |
| Founder | 300,000,000 CFT | 0x67FccFd9c5e0A8863478D6561dcB49279B209E62 |

## Verification

V5 logic contract is verified on Arbiscan. Compiler 0.8.34, optimization enabled, 200 runs.

## Infrastructure

Keeper live at https://chainflux-production.up.railway.app

Pushes prices every 15 seconds. Market data refreshes every 60 seconds.

## Deployed

May 2026
