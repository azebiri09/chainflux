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

// ─── BINANCE ETH LIQUIDATION STREAM ─────────────────────────────────────────

const liquidationEvents = [];

const liqWs = new WebSocket(
  "wss://fstream.binance.com/ws/!forceOrder@arr"
);

liqWs.on("open", () => {
  console.log(
    "🟢 Binance liquidation stream connected"
  );
});

liqWs.on("message", (msg) => {
  try {
    const payload = JSON.parse(msg);

    if (!payload.o) return;

    const orders = Array.isArray(payload.o)
      ? payload.o
      : [payload.o];

    for (const liq of orders) {
      // ETH only
      if (liq.s !== "ETHUSDT") continue;

      const price =
        parseFloat(liq.ap || "0");

      const qty =
        parseFloat(liq.q || "0");

      if (!price || !qty) continue;

      const usdValue = price * qty;

      liquidationEvents.push({
        value: usdValue,
        ts: Date.now()
      });
    }
  } catch (err) {
    console.error(
      "Liquidation WS parse error:",
      err.message
    );
  }
});

liqWs.on("error", (err) => {
  console.error(
    "Liquidation WS error:",
    err.message
  );
});

liqWs.on("close", () => {
  console.log(
    "🔴 Liquidation WS disconnected"
  );
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function pushToWindow(arr, value, maxLen) {
  arr.push(value);

  if (arr.length > maxLen) {
    arr.shift();
  }
}

function rollingAverage(arr) {
  if (arr.length === 0) return 0n;

  const sum =
    arr.reduce((a, b) => a + b, 0n);

  return sum / BigInt(arr.length);
}

// ─── FETCH GAS — ETHEREUM MAINNET ───────────────────────────────────────────

async function fetchGas() {
  try {
    const url =
      `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_gasPrice&apikey=${ETHERSCAN_API_KEY}`;

    const res = await fetch(url);

    const data = await res.json();

    if (!data.result || data.result === "0x") {
      throw new Error("bad gas response");
    }

    const rawGwei =
      Number(BigInt(data.result)) / 1e9;

    const scaled =
      BigInt(Math.round(rawGwei * 1e15));

    pushToWindow(
      gasHistory,
      scaled,
      GAS_WINDOW
    );

    const smoothed =
      rollingAverage(gasHistory);

    console.log(
      `  GAS raw: ${rawGwei.toFixed(2)} gwei | smoothed: ${smoothed}`
    );

    return smoothed;
  } catch (err) {
    console.error(
      `  GAS fetch error: ${err.message}`
    );

    return gasHistory.length > 0
      ? rollingAverage(gasHistory)
      : BigInt("20000000000000000");
  }
}

// ─── FETCH LIQUIDATIONS — BINANCE ETH FORCED ORDERS ────────────────────────

async function fetchLiquidations() {
  try {
    const oneHourAgo =
      Date.now() - 60 * 60 * 1000;

    while (
      liquidationEvents.length > 0 &&
      liquidationEvents[0].ts < oneHourAgo
    ) {
      liquidationEvents.shift();
    }

    const totalUsd =
      liquidationEvents.reduce(
        (sum, liq) => sum + liq.value,
        0
      );

    const normalized =
      totalUsd / 1_000_000;

    const scaled = BigInt(
      Math.round(normalized * 1e18)
    );

    pushToWindow(
      liqHistory,
      scaled,
      LIQ_WINDOW
    );

    const smoothed =
      rollingAverage(liqHistory);

    console.log(
      `  LIQUIDATIONS 1h: $${totalUsd.toFixed(0)} | smoothed: ${smoothed}`
    );

    return smoothed > 0n
      ? smoothed
      : PRICE_PRECISION;

  } catch (err) {
    console.error(
      `  LIQUIDATIONS fetch error: ${err.message}`
    );

    return liqHistory.length > 0
      ? rollingAverage(liqHistory)
      : PRICE_PRECISION;
  }
}

// ─── FETCH STABLECOIN NETFLOWS — DEFI LLAMA ────────────────────────────────

async function fetchStablecoinNetflows() {
  try {
    const res = await fetch(
      "https://stablecoins.llama.fi/stablecoinchains"
    );

    const data = await res.json();

    const eth = data?.find(
      c => c.name?.toLowerCase() === "ethereum"
    );

    const totalCirculating =
      eth?.totalCirculatingUSD?.peggedUSD ?? 0;

    const scaled =
      totalCirculating > 0
        ? BigInt(
            Math.round(totalCirculating / 1e6)
          ) * BigInt(1e6)
        : PRICE_PRECISION;

    pushToWindow(
      flowHistory,
      scaled,
      FLOW_WINDOW
    );

    const smoothed =
      rollingAverage(flowHistory);

    console.log(
      `  STABLECOIN NETFLOWS: $${(totalCirculating / 1e9).toFixed(2)}B | smoothed: ${smoothed}`
    );

    return smoothed > 0n
      ? smoothed
      : PRICE_PRECISION;

  } catch (err) {
    console.error(
      `  STABLECOIN NETFLOWS fetch error: ${err.message}`
    );

    return flowHistory.length > 0
      ? rollingAverage(flowHistory)
      : PRICE_PRECISION;
  }
}

// ─── MAIN LOOP ──────────────────────────────────────────────────────────────

async function pushPrices() {
  try {
    console.log(
      `[${new Date().toISOString()}] Fetching prices...`
    );

    const [
      gas,
      liquidations,
      stablecoinNetflows
    ] = await Promise.all([
      fetchGas(),
      fetchLiquidations(),
      fetchStablecoinNetflows()
    ]);

    console.log(
      "  Pushing to chain..."
    );

    const tx =
      await contract.pushPrices([
        gas,
        liquidations,
        stablecoinNetflows
      ]);

    console.log(
      `  TX sent: ${tx.hash}`
    );

    await tx.wait();

    console.log(
      "  ✅ Confirmed."
    );

  } catch (err) {
    console.error(
      `  ❌ Error: ${err.message}`
    );
  }
}

console.log(
  "⚡ ChainFlux Keeper V2 starting..."
);

pushPrices();

setInterval(
  pushPrices,
  INTERVAL_MS
);
