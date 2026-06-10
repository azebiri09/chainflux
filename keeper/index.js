import { ethers } from "ethers";
import fetch from "node-fetch";
import http from "http";

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const KEEPER_PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY;
const PORT = process.env.PORT || 3000;

const PROXY_ADDRESS = "0x615d3801019D33609Eed27EB39D40AB49fa44fAF";
const RPC_URL = "https://sepolia-rollup.arbitrum.io/rpc";

const PRICE_PRECISION = BigInt("1000000000000000000");
const INTERVAL_MS = 15000;

const PERPS_ABI = [
  "function pushPrices(uint256[3] calldata prices) external"
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(KEEPER_PRIVATE_KEY, provider);
const perpsContract = new ethers.Contract(PROXY_ADDRESS, PERPS_ABI, wallet);

const GAS_WINDOW = 20;
const TXS_WINDOW = 20;
const gasHistory = [];
const txsHistory = [];

function pushToWindow(arr, value, maxLen) {
  arr.push(value);
  if (arr.length > maxLen) arr.shift();
}

function rollingAverage(arr) {
  if (arr.length === 0) return 0n;
  const sum = arr.reduce((a, b) => a + b, 0n);
  return sum / BigInt(arr.length);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let dailyStats = {
  GAS: { high: 0, low: Infinity },
  TXS_PER_BLOCK: { high: 0, low: Infinity },
  ACTIVE_ADDRESSES: { high: 0, low: Infinity }
};
let lastDayReset = new Date().toISOString().slice(0, 10);

function checkDayReset() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastDayReset) {
    dailyStats = {
      GAS: { high: 0, low: Infinity },
      TXS_PER_BLOCK: { high: 0, low: Infinity },
      ACTIVE_ADDRESSES: { high: 0, low: Infinity }
    };
    lastDayReset = today;
    console.log("Daily high/low reset.");
  }
}

function updateDailyStats(key, value) {
  if (value <= 0) return;
  if (value > dailyStats[key].high) dailyStats[key].high = value;
  if (value < dailyStats[key].low) dailyStats[key].low = value;
}

let latestPrices = { GAS: 0, TXS_PER_BLOCK: 0, updatedAt: 0 };
let networkFeed = {
  GAS: 0, GAS_DAILY_HIGH: 0, GAS_DAILY_LOW: 0,
  TXS_PER_BLOCK: 0, TXS_DAILY_HIGH: 0, TXS_DAILY_LOW: 0,
  ACTIVE_ADDRESSES: 0, ACTIVE_DAILY_HIGH: 0, ACTIVE_DAILY_LOW: 0,
  TVL_CHANGE: 0,
  updatedAt: 0
};

async function fetchBlockData() {
  try {
    const url = `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_getBlockByNumber&tag=latest&boolean=true&apikey=${ETHERSCAN_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    const block = data?.result;
    if (!block) throw new Error("No block returned");

    const baseFeeHex = block.baseFeePerGas || "0x0";
    const rawGwei = Number(BigInt(baseFeeHex)) / 1e9;
    const gasGwei = rawGwei > 0 ? rawGwei : (latestPrices.GAS > 0 ? latestPrices.GAS : 0.3);

    const txs = block.transactions ?? [];
    const txCount = txs.length > 0 ? txs.length : (latestPrices.TXS_PER_BLOCK > 0 ? latestPrices.TXS_PER_BLOCK : 200);

    const addressSet = new Set();
    for (const tx of txs) {
      if (tx.from) addressSet.add(tx.from.toLowerCase());
      if (tx.to) addressSet.add(tx.to.toLowerCase());
    }
    const activeCount = addressSet.size > 0 ? addressSet.size : (networkFeed.ACTIVE_ADDRESSES > 0 ? networkFeed.ACTIVE_ADDRESSES : 400);

    console.log(`[${new Date().toISOString()}] Block OK | GAS: ${gasGwei.toFixed(4)} | TXS: ${txCount} | ADDR: ${activeCount}`);
    return { gasGwei, txCount, activeCount };
  } catch (err) {
    console.error(`Block fetch error: ${err.message}`);
    return {
      gasGwei: latestPrices.GAS > 0 ? latestPrices.GAS : 0.3,
      txCount: latestPrices.TXS_PER_BLOCK > 0 ? latestPrices.TXS_PER_BLOCK : 200,
      activeCount: networkFeed.ACTIVE_ADDRESSES > 0 ? networkFeed.ACTIVE_ADDRESSES : 400
    };
  }
}

async function fetchTVLChange() {
  try {
    const res = await fetch("https://api.llama.fi/v2/historicalChainTvl/ethereum");
    const data = await res.json();
    if (Array.isArray(data) && data.length >= 2) {
      const recent = data.slice(-2);
      return Math.abs((recent[1].tvl ?? 0) - (recent[0].tvl ?? 0));
    }
    return 0;
  } catch {
    return networkFeed.TVL_CHANGE > 0 ? networkFeed.TVL_CHANGE : 0;
  }
}

async function updateAllMetrics() {
  checkDayReset();
  const { gasGwei, txCount, activeCount } = await fetchBlockData();
  const tvlChange = await fetchTVLChange();

  const gasScaled = BigInt(Math.round(gasGwei * 1e18));
  const txsScaled = BigInt(Math.round(txCount)) * PRICE_PRECISION;
  pushToWindow(gasHistory, gasScaled, GAS_WINDOW);
  pushToWindow(txsHistory, txsScaled, TXS_WINDOW);
  const smoothedGas = rollingAverage(gasHistory);
  const smoothedTxs = rollingAverage(txsHistory);

  updateDailyStats("GAS", gasGwei);
  updateDailyStats("TXS_PER_BLOCK", txCount);
  updateDailyStats("ACTIVE_ADDRESSES", activeCount);

  latestPrices = {
    GAS: Number(smoothedGas) / 1e18,
    TXS_PER_BLOCK: Number(smoothedTxs) / 1e18,
    updatedAt: Date.now()
  };

  networkFeed = {
    GAS: gasGwei,
    GAS_DAILY_HIGH: dailyStats.GAS.high,
    GAS_DAILY_LOW: dailyStats.GAS.low === Infinity ? 0 : dailyStats.GAS.low,
    TXS_PER_BLOCK: txCount,
    TXS_DAILY_HIGH: dailyStats.TXS_PER_BLOCK.high,
    TXS_DAILY_LOW: dailyStats.TXS_PER_BLOCK.low === Infinity ? 0 : dailyStats.TXS_PER_BLOCK.low,
    ACTIVE_ADDRESSES: activeCount,
    ACTIVE_DAILY_HIGH: dailyStats.ACTIVE_ADDRESSES.high,
    ACTIVE_DAILY_LOW: dailyStats.ACTIVE_ADDRESSES.low === Infinity ? 0 : dailyStats.ACTIVE_ADDRESSES.low,
    TVL_CHANGE: tvlChange,
    updatedAt: Date.now()
  };
}

async function pushPrices() {
  try {
    const gas = rollingAverage(gasHistory);
    const txs = rollingAverage(txsHistory);
    if (gas === 0n || txs === 0n) { console.log("  Skipping perps push — not ready."); return; }
    const tx = await perpsContract.pushPrices([gas, 1n, txs]);
    await tx.wait();
    console.log("  Perps confirmed.");
  } catch (err) {
    console.error(`  Perps push error: ${err.message?.slice(0, 120)}`);
  }
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  if (req.url === "/") {
    res.end(JSON.stringify({ GAS: latestPrices.GAS, TXS_PER_BLOCK: latestPrices.TXS_PER_BLOCK, updatedAt: latestPrices.updatedAt }));
  } else if (req.url === "/feed") {
    res.end(JSON.stringify(networkFeed));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  }
});

server.listen(PORT, () => console.log(`Keeper running on port ${PORT}`));

async function main() {
  console.log("ChainFlux Keeper starting...");
  console.log("Warming up (5 blocks)...");
  for (let i = 0; i < 5; i++) {
    await updateAllMetrics();
    await sleep(3000);
  }
  console.log("Warmup complete.");

  let tick = 0;
  setInterval(async () => {
    tick++;
    console.log(`\n── Tick ${tick} ──`);
    await updateAllMetrics();
    await pushPrices();
  }, INTERVAL_MS);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
