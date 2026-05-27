import { ethers } from "ethers";
import fetch from "node-fetch";

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const ARBISCAN_API_KEY = process.env.ARBISCAN_API_KEY;
const KEEPER_PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY;
const PROXY_ADDRESS = "0x615d3801019D33609Eed27EB39D40AB49fa44fAF";
const RPC_URL = "https://sepolia-rollup.arbitrum.io/rpc";
const INTERVAL_MS = 10000;
// ────────────────────────────────────────────────────────────────────────────

const ABI = [
  "function updatePrices(uint256 gas, uint256 activity, uint256 flow) external"
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(KEEPER_PRIVATE_KEY, provider);
const contract = new ethers.Contract(PROXY_ADDRESS, ABI, wallet);

// Track last prices for smooth movement
let lastGas = BigInt(20000000000000000n); // 0.02
let lastActivity = BigInt(50000000000000000000n); // 50
let lastFlow = BigInt(1000000000000000000000n); // 1000

function applyJitter(last, minPct, maxPct) {
  const pct = minPct + Math.random() * (maxPct - minPct);
  const multiplier = 1 + (pct / 100);
  const next = BigInt(Math.floor(Number(last) * multiplier));
  return next > 0n ? next : last;
}

async function fetchGas() {
  try {
    const url = `https://api.etherscan.io/v2/api?chainid=421614&module=proxy&action=eth_gasPrice&apikey=${ARBISCAN_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    const result = data.result;
    if (!result || result === "0x") throw new Error("bad response");
    const base = BigInt(result) * BigInt(1e9);
    // Apply ±8% jitter so price moves
    lastGas = applyJitter(base, -8, 8);
    return lastGas;
  } catch {
    // If API fails, drift from last known price
    lastGas = applyJitter(lastGas, -5, 5);
    return lastGas;
  }
}

async function fetchActivity() {
  try {
    const blockRes = await fetch(
      `https://api.etherscan.io/v2/api?chainid=421614&module=proxy&action=eth_blockNumber&apikey=${ARBISCAN_API_KEY}`
    );
    const blockData = await blockRes.json();
    const blockNum = parseInt(blockData.result, 16);
    if (isNaN(blockNum)) throw new Error("bad block");
    const base = ((blockNum % 190) + 10);
    const jittered = base * (1 + (Math.random() * 0.2 - 0.1)); // ±10%
    lastActivity = BigInt(Math.floor(jittered)) * BigInt(1e18);
    return lastActivity;
  } catch {
    lastActivity = applyJitter(lastActivity, -8, 8);
    return lastActivity;
  }
}

async function fetchFlow() {
  try {
    const url = `https://api.etherscan.io/v2/api?chainid=421614&module=stats&action=ethsupply&apikey=${ARBISCAN_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    const result = data.result;
    if (!result) throw new Error("no result");
    const base = BigInt(result) / BigInt(1e12);
    lastFlow = applyJitter(base, -6, 6);
    return lastFlow;
  } catch {
    lastFlow = applyJitter(lastFlow, -6, 6);
    return lastFlow;
  }
}

async function pushPrices() {
  try {
    console.log(`[${new Date().toISOString()}] Fetching prices...`);

    const [gas, activity, flow] = await Promise.all([
      fetchGas(),
      fetchActivity(),
      fetchFlow()
    ]);

    console.log(`  GAS:      ${gas}`);
    console.log(`  ACTIVITY: ${activity}`);
    console.log(`  FLOW:     ${flow}`);

    const tx = await contract.updatePrices(gas, activity, flow);
    console.log(`  TX sent:  ${tx.hash}`);
    await tx.wait();
    console.log(`  ✅ Confirmed.`);
  } catch (err) {
    console.error(`  ❌ Error: ${err.message}`);
  }
}

console.log("⚡ ChainFlux Keeper starting...");
pushPrices();
setInterval(pushPrices, INTERVAL_MS);
