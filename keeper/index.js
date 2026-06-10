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
const MARKET_INTERVAL_MS = 60000;

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
  ACTIVE_ADDRESSES: { high: 0, low: Infinity },
  DEX_VOLUME: { high: 0, low: Infinity },
  STABLECOIN_FLOWS: { high: 0, low: Infinity },
  LIQUIDATIONS: { high: 0, low: Infinity },
};
let lastDayReset = new Date().toISOString().slice(0, 10);

function checkDayReset() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastDayReset) {
    dailyStats = {
      GAS: { high: 0, low: Infinity },
      TXS_PER_BLOCK: { high: 0, low: Infinity },
      ACTIVE_ADDRESSES: { high: 0, low: Infinity },
      DEX_VOLUME: { high: 0, low: Infinity },
      STABLECOIN_FLOWS: { high: 0, low: Infinity },
      LIQUIDATIONS: { high: 0, low: Infinity },
    };
    lastDayReset = today;
    console.log("Daily high/low reset.");
  }
}

function updateDailyStats(key, value) {
  if (value <= 0) return;
  if (!dailyStats[key]) return;
  if (value > dailyStats[key].high) dailyStats[key].high = value;
  if (value < dailyStats[key].low) dailyStats[key].low = value;
}

function getDailyHigh(key) { return dailyStats[key]?.high ?? 0; }
function getDailyLow(key) { return dailyStats[key]?.low === Infinity ? 0 : (dailyStats[key]?.low ?? 0); }

let latestPrices = { GAS: 0, TXS_PER_BLOCK: 0, updatedAt: 0 };
let networkFeed = {
  GAS: 0, GAS_DAILY_HIGH: 0, GAS_DAILY_LOW: 0,
  TXS_PER_BLOCK: 0, TXS_DAILY_HIGH: 0, TXS_DAILY_LOW: 0,
  ACTIVE_ADDRESSES: 0, ACTIVE_DAILY_HIGH: 0, ACTIVE_DAILY_LOW: 0,
  TVL_CHANGE: 0,
  NET_UTILIZATION: 50,
  DEX_VOLUME: 0, DEX_VOLUME_HIGH: 1, DEX_VOLUME_LOW: 0,
  STABLECOIN_FLOWS: 0, STABLECOIN_HIGH: 1, STABLECOIN_LOW: 0,
  LIQUIDATIONS: 0, LIQUIDATIONS_HIGH: 1, LIQUIDATIONS_LOW: 0,
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

    let utilization = networkFeed.NET_UTILIZATION;
    if (block.gasUsed && block.gasLimit) {
      const used = parseInt(block.gasUsed, 16);
      const limit = parseInt(block.gasLimit, 16);
      if (limit > 0) utilization = (used / limit) * 100;
    }

    console.log(`[${new Date().toISOString()}] Block OK | GAS: ${gasGwei.toFixed(4)} | TXS: ${txCount} | ADDR: ${activeCount} | UTIL: ${utilization.toFixed(1)}%`);
    return { gasGwei, txCount, activeCount, utilization };
  } catch (err) {
    console.error(`Block fetch error: ${err.message}`);
    return {
      gasGwei: latestPrices.GAS > 0 ? latestPrices.GAS : 0.3,
      txCount: latestPrices.TXS_PER_BLOCK > 0 ? latestPrices.TXS_PER_BLOCK : 200,
      activeCount: networkFeed.ACTIVE_ADDRESSES > 0 ? networkFeed.ACTIVE_ADDRESSES : 400,
      utilization: networkFeed.NET_UTILIZATION,
    };
  }
}

async function fetchMarketData() {
  const results = await Promise.allSettled([
    fetch("https://api.coingecko.com/api/v3/global").then(r => r.json()),
    fetch("https://api.llama.fi/overview/dexs/ethereum?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyVolume").then(r => r.json()),
    fetch("https://api.llama.fi/overview/options/ethereum?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyNotionalVolume").then(r => r.json()),
  ]);

  // CoinGecko global data — used for both TVL change and stablecoin flows
  let tvlChange = networkFeed.TVL_CHANGE;
  let stablecoinFlows = networkFeed.STABLECOIN_FLOWS;
  if (results[0].status === "fulfilled") {
    try {
      const global = results[0].value?.data;
      if (global) {
        // DeFi TVL change: total_value_locked_in_defi in USD, use 24h market cap change % as proxy delta
        const defiMarketCap = global.total_value_locked?.usd ?? 0;
        const marketCapChange24h = global.market_cap_change_percentage_24h_usd ?? 0;
        if (defiMarketCap > 0) {
          tvlChange = Math.abs(defiMarketCap * (marketCapChange24h / 100));
        }

        // Stablecoin flows: stablecoins 24h volume change in USD
        const stablecoinMarketCap = global.total_market_cap_usd
          ? (global.market_cap_percentage?.usdt ?? 0) / 100 * global.total_market_cap_usd
          : 0;
        const stablecoinChange = global.market_cap_change_percentage_24h_usd ?? 0;
        if (stablecoinMarketCap > 0) {
          stablecoinFlows = Math.abs(stablecoinMarketCap * (stablecoinChange / 100));
        }
      }
    } catch { }
  }

  let dexVolume = networkFeed.DEX_VOLUME;
  if (results[1].status === "fulfilled") {
    try {
      dexVolume = results[1].value?.total24h ?? networkFeed.DEX_VOLUME;
    } catch { }
  }

  let liquidations = networkFeed.LIQUIDATIONS;
  if (results[2].status === "fulfilled") {
    try {
      const data = results[2].value;
      liquidations = data?.total24h ?? data?.totalNotionalVolume24h ?? networkFeed.LIQUIDATIONS;
    } catch { }
  }

  updateDailyStats("DEX_VOLUME", dexVolume);
  updateDailyStats("STABLECOIN_FLOWS", stablecoinFlows);
  updateDailyStats("LIQUIDATIONS", liquidations);

  console.log(`[${new Date().toISOString()}] Market data OK | TVL: ${tvlChange.toFixed(0)} | DEX: ${dexVolume.toFixed(0)} | STABLE: ${stablecoinFlows.toFixed(0)} | LIQ: ${liquidations.toFixed(0)}`);

  return { tvlChange, dexVolume, stablecoinFlows, liquidations };
}

async function updateAllMetrics() {
  checkDayReset();
  const { gasGwei, txCount, activeCount, utilization } = await fetchBlockData();

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
    ...networkFeed,
    GAS: gasGwei,
    GAS_DAILY_HIGH: getDailyHigh("GAS"),
    GAS_DAILY_LOW: getDailyLow("GAS"),
    TXS_PER_BLOCK: txCount,
    TXS_DAILY_HIGH: getDailyHigh("TXS_PER_BLOCK"),
    TXS_DAILY_LOW: getDailyLow("TXS_PER_BLOCK"),
    ACTIVE_ADDRESSES: activeCount,
    ACTIVE_DAILY_HIGH: getDailyHigh("ACTIVE_ADDRESSES"),
    ACTIVE_DAILY_LOW: getDailyLow("ACTIVE_ADDRESSES"),
    NET_UTILIZATION: utilization,
    updatedAt: Date.now()
  };
}

async function updateMarketMetrics() {
  const { tvlChange, dexVolume, stablecoinFlows, liquidations } = await fetchMarketData();
  networkFeed = {
    ...networkFeed,
    TVL_CHANGE: tvlChange,
    DEX_VOLUME: dexVolume,
    DEX_VOLUME_HIGH: getDailyHigh("DEX_VOLUME"),
    DEX_VOLUME_LOW: getDailyLow("DEX_VOLUME"),
    STABLECOIN_FLOWS: stablecoinFlows,
    STABLECOIN_HIGH: getDailyHigh("STABLECOIN_FLOWS"),
    STABLECOIN_LOW: getDailyLow("STABLECOIN_FLOWS"),
    LIQUIDATIONS: liquidations,
    LIQUIDATIONS_HIGH: getDailyHigh("LIQUIDATIONS"),
    LIQUIDATIONS_LOW: getDailyLow("LIQUIDATIONS"),
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
  await updateMarketMetrics();
  console.log("Warmup complete.");

  let tick = 0;
  setInterval(async () => {
    tick++;
    console.log(`\n── Tick ${tick} ──`);
    await updateAllMetrics();
    await pushPrices();
  }, INTERVAL_MS);

  setInterval(async () => {
    console.log(`\n── Market Data Refresh ──`);
    await updateMarketMetrics();
  }, MARKET_INTERVAL_MS);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
