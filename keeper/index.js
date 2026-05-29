import { ethers } from "ethers";
import fetch from "node-fetch";
import http from "http";

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

const INTERVAL_MS = 15000;

const PRICE_PRECISION =
  BigInt("1000000000000000000"); // 1e18

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

// ─── PRICE CACHE (served via HTTP) ───────────────────────────────────────────

let latestPrices = {
  GAS: 0,
  ACTIVE_ADDRESSES: 0,
  TXS_PER_BLOCK: 0,
  updatedAt: 0,
};

// ─── ROLLING AVERAGE WINDOWS ─────────────────────────────────────────────────

const GAS_WINDOW      = 20;
const ACTIVE_WINDOW   = 20;
const TXS_WINDOW      = 20;

const gasHistory      = [];
const activeHistory   = [];
const txsHistory      = [];

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── SLOT 0 — GAS ────────────────────────────────────────────────────────────

async function fetchGas() {
  try {
    const url =
      `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_gasPrice&apikey=${ETHERSCAN_API_KEY}`;

    const res  = await fetch(url);
    const data = await res.json();

    if (
      !data.result ||
      data.result === "0x" ||
      typeof data.result !== "string" ||
      !data.result.startsWith("0x")
    ) {
      throw new Error("bad gas response");
    }

    const rawGwei = Number(BigInt(data.result)) / 1e9;
    const scaled  = BigInt(Math.round(rawGwei * 1e18));

    pushToWindow(gasHistory, scaled, GAS_WINDOW);

    const smoothed = rollingAverage(gasHistory);

    console.log(`  GAS raw: ${rawGwei.toFixed(4)} gwei | smoothed: ${smoothed}`);

    return smoothed;
  } catch (err) {
    console.error(`  GAS fetch error: ${err.message}`);
    return gasHistory.length > 0
      ? rollingAverage(gasHistory)
      : BigInt("220000000000000000");
  }
}

// ─── SLOT 1 — ACTIVE ADDRESSES ───────────────────────────────────────────────

async function fetchActiveAddresses() {
  try {
    // Fetch latest block with full tx list
    const url =
      `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_getBlockByNumber&tag=latest&boolean=true&apikey=${ETHERSCAN_API_KEY}`;

    const res  = await fetch(url);
    const data = await res.json();

    const txs = data?.result?.transactions ?? [];

    if (txs.length === 0) throw new Error("empty block or bad response");

    // Count unique addresses (from + to) in this block
    const addressSet = new Set();
    for (const tx of txs) {
      if (tx.from) addressSet.add(tx.from.toLowerCase());
      if (tx.to)   addressSet.add(tx.to.toLowerCase());
    }

    const count  = addressSet.size;
    const scaled = BigInt(count) * PRICE_PRECISION;

    pushToWindow(activeHistory, scaled, ACTIVE_WINDOW);

    const smoothed = rollingAverage(activeHistory);

    console.log(`  ACTIVE ADDRESSES: ${count} unique | smoothed: ${smoothed}`);

    return smoothed;
  } catch (err) {
    console.error(`  ACTIVE ADDRESSES fetch error: ${err.message}`);
    return activeHistory.length > 0
      ? rollingAverage(activeHistory)
      : BigInt("500000000000000000000"); // fallback ~500 addresses
  }
}

// ─── SLOT 2 — TXS PER BLOCK ──────────────────────────────────────────────────

async function fetchTxsPerBlock() {
  try {
    const url =
      `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_getBlockByNumber&tag=latest&boolean=false&apikey=${ETHERSCAN_API_KEY}`;

    const res  = await fetch(url);
    const data = await res.json();

    const txs   = data?.result?.transactions ?? [];
    const count = txs.length;

    if (count === 0) throw new Error("empty block or bad response");

    const scaled = BigInt(count) * PRICE_PRECISION;

    pushToWindow(txsHistory, scaled, TXS_WINDOW);

    const smoothed = rollingAverage(txsHistory);

    console.log(`  TXS PER BLOCK: ${count} txs | smoothed: ${smoothed}`);

    return smoothed;
  } catch (err) {
    console.error(`  TXS PER BLOCK fetch error: ${err.message}`);
    return txsHistory.length > 0
      ? rollingAverage(txsHistory)
      : BigInt("200000000000000000000");
  }
}

// ─── MAIN LOOP ───────────────────────────────────────────────────────────────

async function pushPrices() {
  try {
    console.log(`[${new Date().toISOString()}] Fetching prices...`);

    const gas            = await fetchGas();
    await sleep(400);
    const activeAddresses = await fetchActiveAddresses();
    await sleep(400);
    const txsPerBlock    = await fetchTxsPerBlock();

    console.log("  Pushing to chain...");

    const tx = await contract.pushPrices([
      gas,
      activeAddresses,
      txsPerBlock
    ]);

    console.log(`  TX sent: ${tx.hash}`);

    await tx.wait();

    console.log("  ✅ Confirmed.");

    // ── Update price cache after confirmed push ──
    latestPrices = {
      GAS:              Number(gas)            / 1e18,
      ACTIVE_ADDRESSES: Number(activeAddresses) / 1e18,
      TXS_PER_BLOCK:    Number(txsPerBlock)    / 1e18,
      updatedAt:        Date.now(),
    };

    console.log(`  📡 Cache updated: GAS=${latestPrices.GAS} | ACTIVE=${latestPrices.ACTIVE_ADDRESSES} | TXS=${latestPrices.TXS_PER_BLOCK}`);

  } catch (err) {
    console.error(`  ❌ Error: ${err.message}`);
  }
}

// ─── HTTP PRICE SERVER ───────────────────────────────────────────────────────

http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(latestPrices));
}).listen(process.env.PORT || 3000, () => {
  console.log(`📡 Price API listening on port ${process.env.PORT || 3000}`);
});

// ─── START ───────────────────────────────────────────────────────────────────

console.log("⚡ ChainFlux Keeper V2 starting...");

pushPrices();

setInterval(pushPrices, INTERVAL_MS);
