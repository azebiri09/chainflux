import { ethers } from "ethers";
import fetch from "node-fetch";

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
const LIQ_WINDOW  = 20;
const TXS_WINDOW  = 20;

const gasHistory  = [];
const liqHistory  = [];
const txsHistory  = [];

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

// ─── SLOT 0 — FETCH GAS — ETHEREUM MAINNET ───────────────────────────────────

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

// ─── SLOT 1 — FETCH LIQUIDATIONS — AAVE V3 ETHERSCAN EVENT LOGS ──────────────

async function fetchLiquidations() {
  try {
    // Aave V3 Pool on Ethereum mainnet
    const AAVE_V3_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
    const LIQ_TOPIC    = "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286";

    // Look back ~50 blocks (~10 mins on mainnet)
    const blockRes  = await fetch(
      `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_blockNumber&apikey=${ETHERSCAN_API_KEY}`
    );
    const blockData = await blockRes.json();
    const latestBlock = parseInt(blockData.result, 16);
    const fromBlock   = latestBlock - 50;

    const url = `https://api.etherscan.io/v2/api?chainid=1&module=logs&action=getLogs` +
      `&address=${AAVE_V3_POOL}` +
      `&topic0=${LIQ_TOPIC}` +
      `&fromBlock=${fromBlock}` +
      `&toBlock=latest` +
      `&apikey=${ETHERSCAN_API_KEY}`;

    const res  = await fetch(url);
    const data = await res.json();

    const events = data?.result ?? [];
    const count  = Array.isArray(events) ? events.length : 0;

    // Scale: count * 1e18, minimum 1e18 so price is never 0
    const scaled = BigInt(count) * PRICE_PRECISION + PRICE_PRECISION;

    pushToWindow(liqHistory, scaled, LIQ_WINDOW);

    const smoothed = rollingAverage(liqHistory);

    console.log(`  LIQUIDATIONS last 50 blocks: ${count} events | smoothed: ${smoothed}`);

    return smoothed;
  } catch (err) {
    console.error(`  LIQUIDATIONS fetch error: ${err.message}`);
    return liqHistory.length > 0
      ? rollingAverage(liqHistory)
      : PRICE_PRECISION;
  }
}

// ─── SLOT 2 — FETCH ETH TXS PER BLOCK ────────────────────────────────────────

async function fetchTxsPerBlock() {
  try {
    const url =
      `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_getBlockByNumber&tag=latest&boolean=false&apikey=${ETHERSCAN_API_KEY}`;

    const res  = await fetch(url);
    const data = await res.json();

    const txs   = data?.result?.transactions ?? [];
    const count = txs.length;

    if (count === 0) throw new Error("empty block or bad response");

    // Typical range 150–250 txs. Scale to 1e18 range.
    // Multiply count by 1e16 so 200 txs ≈ 2e18 — a clean readable price
    const scaled = BigInt(count) * BigInt("10000000000000000");

    pushToWindow(txsHistory, scaled, TXS_WINDOW);

    const smoothed = rollingAverage(txsHistory);

    console.log(`  TXS PER BLOCK: ${count} txs | smoothed: ${smoothed}`);

    return smoothed;
  } catch (err) {
    console.error(`  TXS PER BLOCK fetch error: ${err.message}`);
    return txsHistory.length > 0
      ? rollingAverage(txsHistory)
      : BigInt("2000000000000000000");
  }
}

// ─── MAIN LOOP ───────────────────────────────────────────────────────────────

async function pushPrices() {
  try {
    console.log(`[${new Date().toISOString()}] Fetching prices...`);

    const [gas, liquidations, txsPerBlock] = await Promise.all([
      fetchGas(),
      fetchLiquidations(),
      fetchTxsPerBlock()
    ]);

    console.log("  Pushing to chain...");

    const tx = await contract.pushPrices([
      gas,
      liquidations,
      txsPerBlock
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
