import { ethers } from "ethers";
import fetch from "node-fetch";

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const ARBISCAN_API_KEY = process.env.ARBISCAN_API_KEY;
const KEEPER_PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY;
const PROXY_ADDRESS = "0x615d3801019D33609Eed27EB39D40AB49fa44fAF";
const RPC_URL = "https://sepolia-rollup.arbitrum.io/rpc";
const INTERVAL_MS = 24000;
// ────────────────────────────────────────────────────────────────────────────

const ABI = [
  "function updatePrices(uint256 gas, uint256 activity, uint256 flow) external"
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(KEEPER_PRIVATE_KEY, provider);
const contract = new ethers.Contract(PROXY_ADDRESS, ABI, wallet);

async function fetchGas() {
  const url = `https://api.etherscan.io/v2/api?chainid=421614&module=proxy&action=eth_gasPrice&apikey=${ARBISCAN_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  console.log("  GAS raw:", JSON.stringify(data));
  const result = data.result;
  if (!result || result === "0x") return BigInt(100000000);
  return BigInt(result) / BigInt(10);
}

async function fetchActivity() {
  const blockRes = await fetch(
    `https://api.etherscan.io/v2/api?chainid=421614&module=proxy&action=eth_blockNumber&apikey=${ARBISCAN_API_KEY}`
  );
  const blockData = await blockRes.json();
  console.log("  BLOCK raw:", JSON.stringify(blockData));
  const blockNum = blockData.result;
  if (!blockNum || blockNum === "0x") return BigInt(50) * BigInt(1e8);

  const txRes = await fetch(
    `https://api.etherscan.io/v2/api?chainid=421614&module=proxy&action=eth_getBlockTransactionCountByNumber&tag=${blockNum}&apikey=${ARBISCAN_API_KEY}`
  );
  const txData = await txRes.json();
  console.log("  TX raw:", JSON.stringify(txData));
  const txCount = parseInt(txData.result, 16);
  if (isNaN(txCount)) return BigInt(50) * BigInt(1e8);
  return BigInt(txCount) * BigInt(1e8);
}

async function fetchFlow() {
  const url = `https://api.etherscan.io/v2/api?chainid=421614&module=stats&action=ethsupply&apikey=${ARBISCAN_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  console.log("  FLOW raw:", JSON.stringify(data));
  const result = data.result;
  if (!result) return BigInt(1000000000000);
  return BigInt(result) / BigInt(1e12);
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
