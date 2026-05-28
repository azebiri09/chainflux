import { ethers } from "ethers";
import fetch from "node-fetch";

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const KEEPER_PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY;
const PROXY_ADDRESS = "0x615d3801019D33609Eed27EB39D40AB49fa44fAF";
const RPC_URL = "https://sepolia-rollup.arbitrum.io/rpc";
const INTERVAL_MS = 10000;
const PRICE_PRECISION = BigInt("1000000000000000000"); // 1e18
// ────────────────────────────────────────────────────────────────────────────

const ABI = [
  "function pushPrices(uint256[3] calldata prices) external"
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(KEEPER_PRIVATE_KEY, provider);
const contract = new ethers.Contract(PROXY_ADDRESS, ABI, wallet);

// ─── ROLLING AVERAGE WINDOWS ────────────────────────────────────────────────
const GAS_WINDOW        = 20;   // 20 samples (~200 seconds)
const LIQ_WINDOW        = 360;  // 360 samples (~1 hour)
const FLOW_WINDOW       = 8640; // 8640 samples (~24 hours)

const gasHistory        = [];
const liqHistory        = [];
const flowHistory       = [];

function pushToWindow(arr, value, maxLen) {
  arr.push(value);
  if (arr.length > maxLen) arr.shift();
}

function rollingAverage(arr) {
  if (arr.length === 0) return 0n;
  const sum = arr.reduce((a, b) => a + b, 0n);
  return sum / BigInt(arr.length);
}

// ─── FETCH GAS — Ethereum Mainnet ────────────────────────────────────────────
// 20-block rolling average of Ethereum mainnet gas price
async function fetchGas() {
  try {
    const url = `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_gasPrice&apikey=${ETHERSCAN_API_KEY}`;
    const res  = await fetch(url);
    const data = await res.json();
    if (!data.result || data.result === "0x") throw new Error("bad gas response");

    // Raw gas price in wei, scale to 1e18
    const rawGwei = Number(BigInt(data.result)) / 1e9; // convert wei to gwei
    const scaled  = BigInt(Math.round(rawGwei * 1e15)); // gwei * 1e15 = 1e18 scale

    pushToWindow(gasHistory, scaled, GAS_WINDOW);
    const smoothed = rollingAverage(gasHistory);
    console.log(`  GAS raw: ${rawGwei.toFixed(2)} gwei | smoothed: ${smoothed}`);
    return smoothed;
  } catch (err) {
    console.error(`  GAS fetch error: ${err.message}`);
    return gasHistory.length > 0 ? rollingAverage(gasHistory) : BigInt("20000000000000000");
  }
}

// ─── FETCH LIQUIDATIONS — 1hr rolling sum ────────────────────────────────────
// Pulls DeFi liquidation events from Ethereum mainnet via Etherscan logs
// Uses Aave V3 LiquidationCall event topic
// topic0 = keccak256("LiquidationCall(address,address,address,uint256,uint256,address,bool)")
const AAVE_V3_POOL      = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const LIQ_TOPIC         = "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286";

async function fetchLiquidations() {
  try {
    const blockRes  = await fetch(
      `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_blockNumber&apikey=${ETHERSCAN_API_KEY}`
    );
    const blockData = await blockRes.json();
    const toBlock   = parseInt(blockData.result, 16);
    if (isNaN(toBlock)) throw new Error("bad block number");

    const fromBlock = toBlock - 300; // ~1 hour of blocks

    const logRes  = await fetch(
      `https://api.etherscan.io/v2/api?chainid=1&module=logs&action=getLogs&address=${AAVE_V3_POOL}&topic0=${LIQ_TOPIC}&fromBlock=${fromBlock}&toBlock=${toBlock}&apikey=${ETHERSCAN_API_KEY}`
    );
    const logData = await logRes.json();

    const count  = Array.isArray(logData.result) ? logData.result.length : 0;
    const scaled = BigInt(count) * PRICE_PRECISION;

    pushToWindow(liqHistory, scaled, LIQ_WINDOW);
    const smoothed = rollingAverage(liqHistory);
    console.log(`  LIQUIDATIONS count: ${count} | smoothed: ${smoothed}`);
    return smoothed > 0n ? smoothed : PRICE_PRECISION; // floor at 1
  } catch (err) {
    console.error(`  LIQUIDATIONS fetch error: ${err.message}`);
    return liqHistory.length > 0 ? rollingAverage(liqHistory) : PRICE_PRECISION;
  }
}

// ─── FETCH STABLECOIN NETFLOWS — 24hr rolling average ────────────────────────
// Tracks USDT transfer volume on Ethereum mainnet as a proxy for stablecoin flows
// Uses USDT Transfer event topic
const USDT_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function fetchStablecoinNetflows() {
  try {
    const blockRes  = await fetch(
      `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_blockNumber&apikey=${ETHERSCAN_API_KEY}`
    );
    const blockData = await blockRes.json();
    const toBlock   = parseInt(blockData.result, 16);
    if (isNaN(toBlock)) throw new Error("bad block number");

    const fromBlock = toBlock - 300; // ~1 hour window per sample

    const logRes  = await fetch(
      `https://api.etherscan.io/v2/api?chainid=1&module=logs&action=getLogs&address=${USDT_ADDRESS}&topic0=${TRANSFER_TOPIC}&fromBlock=${fromBlock}&toBlock=${toBlock}&apikey=${ETHERSCAN_API_KEY}`
    );
    const logData = await logRes.json();

    const count  = Array.isArray(logData.result) ? logData.result.length : 0;
    const scaled = BigInt(count) * PRICE_PRECISION;

    pushToWindow(flowHistory, scaled, FLOW_WINDOW);
    const smoothed = rollingAverage(flowHistory);
    console.log(`  STABLECOIN NETFLOWS count: ${count} | smoothed: ${smoothed}`);
    return smoothed > 0n ? smoothed : PRICE_PRECISION; // floor at 1
  } catch (err) {
    console.error(`  STABLECOIN NETFLOWS fetch error: ${err.message}`);
    return flowHistory.length > 0 ? rollingAverage(flowHistory) : PRICE_PRECISION;
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

    console.log(`  Pushing to chain...`);
    const tx = await contract.pushPrices([gas, liquidations, stablecoinNetflows]);
    console.log(`  TX sent: ${tx.hash}`);
    await tx.wait();
    console.log(`  ✅ Confirmed.`);
  } catch (err) {
    console.error(`  ❌ Error: ${err.message}`);
  }
}

console.log("⚡ ChainFlux Keeper V2 starting...");
pushPrices();
setInterval(pushPrices, INTERVAL_MS);
