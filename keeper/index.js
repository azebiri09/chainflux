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
  AAVE_BORROWS: 0,
  TXS_PER_BLOCK: 0,
  updatedAt: 0,
};

// ─── ROLLING AVERAGE WINDOWS ─────────────────────────────────────────────────

const GAS_WINDOW     = 20;
const BORROWS_WINDOW = 20;
const TXS_WINDOW     = 20;

const gasHistory     = [];
const borrowsHistory = [];
const txsHistory     = [];

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

// ─── ETHERSCAN CALL HELPER ────────────────────────────────────────────────────

async function ethCall(to, data) {
  const url =
    `https://api.etherscan.io/v2/api?chainid=1` +
    `&module=proxy&action=eth_call` +
    `&to=${to}` +
    `&data=${data}` +
    `&tag=latest` +
    `&apikey=${ETHERSCAN_API_KEY}`;

  const res  = await fetch(url);
  const json = await res.json();

  if (
    !json.result ||
    json.result === "0x" ||
    json.result.length < 10 ||
    typeof json.result !== "string" ||
    !json.result.startsWith("0x")
  ) {
    throw new Error(
      `bad response: ${typeof json.result === "string"
        ? json.result.slice(0, 60)
        : JSON.stringify(json.result)}`
    );
  }

  return json.result;
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

// ─── SLOT 1 — AAVE BORROWS ───────────────────────────────────────────────────

const AAVE_DATA_PROVIDER = "0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3";

const GET_RESERVE_TOKENS_SIG = "0xd2493b6c";
const TOTAL_SUPPLY_SIG       = "0x18160ddd";

const BORROW_ASSETS = [
  { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC" },
  { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH" },
];

async function fetchBorrows() {
  try {
    let totalBorrows = 0n;
    let successCount = 0;

    for (const asset of BORROW_ASSETS) {
      try {
        if (successCount > 0) await sleep(400);

        const paddedAsset    = asset.address.slice(2).toLowerCase().padStart(64, "0");
        const reserveResult  = await ethCall(AAVE_DATA_PROVIDER, GET_RESERVE_TOKENS_SIG + paddedAsset);

        const hex = reserveResult.slice(2);
        const variableDebtAddress = "0x" + hex.slice(2 * 64, 3 * 64).slice(24);

        if (
          !variableDebtAddress ||
          variableDebtAddress === "0x0000000000000000000000000000000000000000"
        ) {
          console.warn(`  BORROWS: could not resolve variableDebt for ${asset.symbol}`);
          continue;
        }

        await sleep(400);
        const supplyResult = await ethCall(variableDebtAddress, TOTAL_SUPPLY_SIG);
        const supply       = BigInt(supplyResult);

        if (supply === 0n) {
          console.warn(`  BORROWS: zero supply for ${asset.symbol}, skipping`);
          continue;
        }

        console.log(`  BORROWS: ${asset.symbol} → variableDebt ${variableDebtAddress} → supply ${supply}`);

        totalBorrows += supply;
        successCount++;

      } catch (innerErr) {
        console.warn(`  BORROWS: ${asset.symbol} error — ${innerErr.message}`);
      }
    }

    if (successCount === 0 || totalBorrows === 0n) {
      throw new Error("all asset calls failed or returned zero");
    }

    const scaled  = (totalBorrows * PRICE_PRECISION) / BigInt("1000000000000000000000000");
    const floored = scaled > 0n ? scaled : PRICE_PRECISION;

    pushToWindow(borrowsHistory, floored, BORROWS_WINDOW);

    const smoothed = rollingAverage(borrowsHistory);

    console.log(`  AAVE BORROWS total: ${totalBorrows} | scaled: ${floored} | smoothed: ${smoothed}`);

    return smoothed;

  } catch (err) {
    console.error(`  AAVE BORROWS fetch error: ${err.message}`);
    return borrowsHistory.length > 0
      ? rollingAverage(borrowsHistory)
      : PRICE_PRECISION;
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

    const gas         = await fetchGas();
    await sleep(400);
    const borrows     = await fetchBorrows();
    await sleep(400);
    const txsPerBlock = await fetchTxsPerBlock();

    console.log("  Pushing to chain...");

    const tx = await contract.pushPrices([
      gas,
      borrows,
      txsPerBlock
    ]);

    console.log(`  TX sent: ${tx.hash}`);

    await tx.wait();

    console.log("  ✅ Confirmed.");

    // ── Update price cache after confirmed push ──
    latestPrices = {
      GAS:          Number(gas)         / 1e18,
      AAVE_BORROWS: Number(borrows)     / 1e18,
      TXS_PER_BLOCK: Number(txsPerBlock) / 1e18,
      updatedAt:    Date.now(),
    };

    console.log(`  📡 Cache updated: GAS=${latestPrices.GAS} | BORROWS=${latestPrices.AAVE_BORROWS} | TXS=${latestPrices.TXS_PER_BLOCK}`);

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
