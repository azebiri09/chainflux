import { ethers } from "ethers";
import fetch from "node-fetch";
import WebSocket from "ws";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const ETHERSCAN_API_KEY =
  process.env.ETHERSCAN_API_KEY ||
  process.env.ARBISCAN_API_KEY;

const KEEPER_PRIVATE_KEY =
  process.env.KEEPER_PRIVATE_KEY;

const PROXY_ADDRESS =
  "0x615d3801019D33609Eed27EB39D40AB49fa44fAF";

const RPC_URL =
  "https://sepolia-rollup.arbitrum.io/rpc";

const INTERVAL_MS = 10000;

const PRICE_PRECISION =
  BigInt("1000000000000000000");

// ─────────────────────────────────────────────────────────────────────────────

const ABI = [
  "function pushPrices(uint256[3] calldata prices) external"
];

const provider =
  new ethers.JsonRpcProvider(RPC_URL);

const wallet =
  new ethers.Wallet(
    KEEPER_PRIVATE_KEY,
    provider
  );

const contract =
  new ethers.Contract(
    PROXY_ADDRESS,
    ABI,
    wallet
  );

// ─── ROLLING AVERAGE WINDOWS ─────────────────────────────────────────────────

const GAS_WINDOW  = 20;
const LIQ_WINDOW  = 360;
const FLOW_WINDOW = 8640;

const gasHistory  = [];
const liqHistory  = [];
const flowHistory = [];

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function pushToWindow(arr, value, maxLen) {
  arr.push(value);
  if (arr.length > maxLen) arr.shift();
}

function rollingAverage(arr) {
  if (arr.length === 0) return 0n;
  const sum = arr.reduce((a, b) => a + b, 0n);
  return sum / BigInt(arr.length);
}

// ─── FETCH GAS — ETHEREUM MAINNET ────────────────────────────────────────────

async function fetchGas() {
  try {
    const url =
      `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_gasPrice&apikey=${ETHERSCAN_API_KEY}`;

    const res  = await fetch(url);
    const data = await res.json();

    if (!data.result || data.result === "0x") {
      throw new Error("bad gas response");
    }

    const rawGwei = Number(BigInt(data.result)) / 1e9;
    const scaled  = BigInt(Math.round(rawGwei * 1e15));

    pushToWindow(gasHistory, scaled, GAS_WINDOW);

    const smoothed = rollingAverage(gasHistory);

    console.log(`  GAS raw: ${rawGwei.toFixed(2)} gwei | smoothed: ${smoothed}`);

    return smoothed;
  } catch (err) {
    console.error(`  GAS fetch error: ${err.message}`);
    return gasHistory.length > 0
      ? rollingAverage(gasHistory)
      : BigInt("20000000000000000");
  }
}

// ─── FETCH LIQUIDATIONS — DEFILLAMA (no auth needed) ─────────────────────────
// Uses DeFiLlama liquidations endpoint — public, no API key required

async function fetchLiquidations() {
  try {
    // DeFiLlama liquidations: returns 1h liquidation data per protocol
    const res  = await fetch("https://api.llama.fi/liquidations/1h");
    const data = await res.json();

    // Sum all liquidations across all protocols in USD
    let totalUsd = 0;

    if (Array.isArray(data)) {
      for (const item of data) {
        const val = item.liquidationVolumeUSD ?? item.volume ?? item.usd ?? 0;
        totalUsd += Number(val);
      }
    } else if (data && typeof data === "object") {
      // Sometimes returned as { protocols: [...] } or { data: [...] }
      const arr = data.protocols ?? data.data ?? data.liquidations ?? [];
      for (const item of arr) {
        const val = item.liquidationVolumeUSD ?? item.volume ?? item.usd ?? 0;
        totalUsd += Number(val);
      }
    }

    // Fallback: if still 0 try alternate endpoint
    if (totalUsd === 0) {
      const res2  = await fetch("https://api.llama.fi/overview/liquidations");
      const data2 = await res2.json();
      const arr2  = data2?.protocols ?? data2?.data ?? [];
      for (const item of arr2) {
        totalUsd += Number(item.liquidationVolumeUSD ?? item.volume ?? 0);
      }
    }

    const normalized = totalUsd / 1_000_000;
    const scaled     = BigInt(Math.round(normalized * 1e18));

    pushToWindow(liqHistory, scaled > 0n ? scaled : PRICE_PRECISION, LIQ_WINDOW);

    const smoothed = rollingAverage(liqHistory);

    console.log(`  LIQUIDATIONS 1h: $${totalUsd.toFixed(0)} | smoothed: ${smoothed}`);

    return smoothed > 0n ? smoothed : PRICE_PRECISION;
  } catch (err) {
    console.error(`  LIQUIDATIONS fetch error: ${err.message}`);
    return liqHistory.length > 0
      ? rollingAverage(liqHistory)
      : PRICE_PRECISION;
  }
}

// ─── FETCH STABLECOIN NETFLOWS — DEFILLAMA 24H CHANGE ────────────────────────
// Compares current vs 24h-ago circulating supply to get real netflow

async function fetchStablecoinNetflows() {
  try {
    // Get per-stablecoin data which includes 24h change
    const res  = await fetch("https://stablecoins.llama.fi/stablecoins?includePrices=true");
    const data = await res.json();

    const coins = data?.peggedAssets ?? [];

    let totalNetflow = 0;

    for (const coin of coins) {
      // Only USDT and USDC on Ethereum
      const name = coin.symbol?.toUpperCase();
      if (name !== "USDT" && name !== "USDC") continue;

      const chainData = coin.chainCirculating?.Ethereum;
      if (!chainData) continue;

      const current = chainData.current?.peggedUSD ?? 0;
      const prev24h = chainData.circulatingPrevDay?.peggedUSD ?? current;

      totalNetflow += Math.abs(current - prev24h);
    }

    // If still 0, fall back to total ETH stablecoin supply as proxy
    if (totalNetflow === 0) {
      const res2  = await fetch("https://stablecoins.llama.fi/stablecoinchains");
      const data2 = await res2.json();
      const eth   = data2?.find(c => c.name?.toLowerCase() === "ethereum");
      totalNetflow = eth?.totalCirculatingUSD?.peggedUSD ?? 0;
    }

    const scaled = BigInt(Math.round(totalNetflow / 1e6)) * BigInt(1e6);

    pushToWindow(flowHistory, scaled > 0n ? scaled : PRICE_PRECISION, FLOW_WINDOW);

    const smoothed = rollingAverage(flowHistory);

    console.log(`  STABLECOIN NETFLOWS: 24h delta $${(totalNetflow / 1e6).toFixed(2)}M | smoothed: ${smoothed}`);

    return smoothed > 0n ? smoothed : PRICE_PRECISION;
  } catch (err) {
    console.error(`  STABLECOIN NETFLOWS fetch error: ${err.message}`);
    return flowHistory.length > 0
      ? rollingAverage(flowHistory)
      : PRICE_PRECISION;
  }
}

// ─── MAIN LOOP ───────────────────────────────────────────────────────────────

async function pushPrices() {
  try {
    console.log(`[${new Date().toISOString()}] Fetching prices...`);

    const [gas, liquidations, stablecoinNetflows] = await Promise.all([
      fetchGas(),
      fetchLiquidations(),
      fetchStablecoinNetflows()
    ]);

    console.log("  Pushing to chain...");

    const tx = await contract.pushPrices([
      gas,
      liquidations,
      stablecoinNetflows
    ]);

    console.log(`  TX sent: ${tx.hash}`);

    await tx.wait();

    console.log("  ✅ Confirmed.");
  } catch (err) {
    console.error(`  ❌ Error: ${err.message}`);
  }
}

console.log("⚡ ChainFlux Keeper V2 starting...");

pushPrices();

setInterval(pushPrices, INTERVAL_MS);
