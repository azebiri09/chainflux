import { ethers } from "ethers";
import fetch from "node-fetch";
import http from "http";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const KEEPER_PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY;
const PORT = process.env.PORT || 3000;

const PROXY_ADDRESS = "0x615d3801019D33609Eed27EB39D40AB49fa44fAF";
const PREDICT_PROXY_ADDRESS = "0x7708a4C85F526E23090d3B27201487E91AF58694";
const RPC_URL = "https://sepolia-rollup.arbitrum.io/rpc";

const PRICE_PRECISION = BigInt("1000000000000000000");
const INTERVAL_MS = 15000;

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const PERPS_ABI = [
  "function pushPrices(uint256[3] calldata prices) external"
];

const PREDICT_ABI = [
  "function openRound(uint8 metric, uint8 timeframe, uint256 startValue) external returns (uint256)",
  "function resolveRound(uint256 roundId, uint256 endValue) external",
  "function getLatestRound(uint8 metric, uint8 timeframe) external view returns (uint256)",
  "function rounds(uint256 roundId) external view returns (uint256 id, uint8 metric, uint8 timeframe, uint256 startValue, uint256 endValue, uint256 openTime, uint256 closeTime, uint256 higherPool, uint256 lowerPool, uint8 status, uint8 result)"
];

// ─── PROVIDER + CONTRACTS ─────────────────────────────────────────────────────

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(KEEPER_PRIVATE_KEY, provider);
const perpsContract = new ethers.Contract(PROXY_ADDRESS, PERPS_ABI, wallet);
const predictContract = new ethers.Contract(PREDICT_PROXY_ADDRESS, PREDICT_ABI, wallet);

// ─── ENUMS ────────────────────────────────────────────────────────────────────

const Metric = {
  ACTIVE_ADDRESSES: 0,
  ETH_LARGE_TRANSFERS: 2,
  LIQUIDATION_VOLUME: 3
};

const Timeframe = {
  ONE_HOUR: 0,
  TWENTY_FOUR_HOUR: 1
};

const RoundStatus = {
  OPEN: 0,
  RESOLVED: 1,
  REFUNDED: 2
};

// ─── THRESHOLDS ───────────────────────────────────────────────────────────────

const METRIC_THRESHOLDS = {
  [Metric.ACTIVE_ADDRESSES]: 10,
  [Metric.ETH_LARGE_TRANSFERS]: 0.1,
  [Metric.LIQUIDATION_VOLUME]: 50
};

// ─── TRANSACTION QUEUE ────────────────────────────────────────────────────────

const txQueue = [];
let txBusy = false;

async function enqueue(fn) {
  return new Promise((resolve, reject) => {
    txQueue.push({ fn, resolve, reject });
    if (!txBusy) processQueue();
  });
}

async function processQueue() {
  if (txQueue.length === 0) {
    txBusy = false;
    return;
  }
  txBusy = true;
  const { fn, resolve, reject } = txQueue.shift();
  try {
    const result = await fn();
    resolve(result);
  } catch (err) {
    reject(err);
  }
  processQueue();
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toScaled(value) {
  return BigInt(Math.round(value * 1e4)) * (PRICE_PRECISION / BigInt(1e4));
}

// ─── ROLLING AVERAGES ─────────────────────────────────────────────────────────

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

// ─── DAILY HIGH / LOW ─────────────────────────────────────────────────────────

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
    console.log("Daily high/low reset for new UTC day.");
  }
}

function updateDailyStats(key, value) {
  if (value <= 0) return;
  if (value > dailyStats[key].high) dailyStats[key].high = value;
  if (value < dailyStats[key].low) dailyStats[key].low = value;
}

// ─── CACHES ───────────────────────────────────────────────────────────────────

let latestPrices = {
  GAS: 0,
  TXS_PER_BLOCK: 0,
  updatedAt: 0
};

let networkFeed = {
  GAS: 0,
  GAS_DAILY_HIGH: 0,
  GAS_DAILY_LOW: 0,
  TXS_PER_BLOCK: 0,
  TXS_DAILY_HIGH: 0,
  TXS_DAILY_LOW: 0,
  ACTIVE_ADDRESSES: 0,
  ACTIVE_DAILY_HIGH: 0,
  ACTIVE_DAILY_LOW: 0,
  updatedAt: 0
};

// ─── SINGLE BLOCK FETCH ───────────────────────────────────────────────────────

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

    console.log(`[${new Date().toISOString()}] Block fetch OK`);
    console.log(`  GAS: ${gasGwei.toFixed(4)} gwei`);
    console.log(`  TXS PER BLOCK: ${txCount}`);
    console.log(`  ACTIVE ADDRESSES: ${activeCount}`);

    return { gasGwei, txCount, activeCount };

  } catch (err) {
    console.error(`  Block fetch error: ${err.message}`);
    return {
      gasGwei: latestPrices.GAS > 0 ? latestPrices.GAS : 0.3,
      txCount: latestPrices.TXS_PER_BLOCK > 0 ? latestPrices.TXS_PER_BLOCK : 200,
      activeCount: networkFeed.ACTIVE_ADDRESSES > 0 ? networkFeed.ACTIVE_ADDRESSES : 400
    };
  }
}

// ─── UPDATE ALL METRICS ───────────────────────────────────────────────────────

async function updateAllMetrics() {
  checkDayReset();

  const { gasGwei, txCount, activeCount } = await fetchBlockData();

  const gasScaled = BigInt(Math.round(gasGwei * 1e18));
  const txsScaled = BigInt(txCount) * PRICE_PRECISION;
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
    updatedAt: Date.now()
  };

  console.log(`  Smoothed GAS: ${latestPrices.GAS.toFixed(4)} | Smoothed TXS: ${latestPrices.TXS_PER_BLOCK.toFixed(1)}`);
  console.log(`  GAS daily H/L: ${networkFeed.GAS_DAILY_HIGH} / ${networkFeed.GAS_DAILY_LOW}`);
  console.log(`  TXS daily H/L: ${networkFeed.TXS_DAILY_HIGH} / ${networkFeed.TXS_DAILY_LOW}`);
  console.log(`  ACTIVE daily H/L: ${networkFeed.ACTIVE_DAILY_HIGH} / ${networkFeed.ACTIVE_DAILY_LOW}`);
}

// ─── PERPS PRICE PUSH ─────────────────────────────────────────────────────────

async function pushPrices() {
  try {
    const gas = rollingAverage(gasHistory);
    const txs = rollingAverage(txsHistory);

    if (gas === 0n || txs === 0n) {
      console.log("  Skipping perps push — rolling averages not ready yet.");
      return;
    }

    console.log("  Pushing perps to chain...");
    const tx = await perpsContract.pushPrices([gas, 1n, txs]);
    console.log(`  TX sent: ${tx.hash}`);
    await tx.wait();
    console.log("  Perps confirmed.");

  } catch (err) {
    console.error(`  Perps push error (non-fatal): ${err.message?.slice(0, 120)}`);
  }
}

// ─── PREDICTION ROUND MANAGER ─────────────────────────────────────────────────

const roundTracker = {};

function getRoundKey(metric, timeframe) {
  return `${metric}_${timeframe}`;
}

function getMetricCurrentValue(metricId) {
  switch (metricId) {
    case Metric.ACTIVE_ADDRESSES:    return networkFeed.ACTIVE_ADDRESSES || 0;
    case Metric.ETH_LARGE_TRANSFERS: return networkFeed.GAS || 0;
    case Metric.LIQUIDATION_VOLUME:  return networkFeed.TXS_PER_BLOCK || 0;
    default: return 0;
  }
}

function metricIsReady(metricId) {
  const value = getMetricCurrentValue(metricId);
  const threshold = METRIC_THRESHOLDS[metricId] || 0;
  return value > threshold;
}

function getTimeframeDuration(timeframeId) {
  switch (timeframeId) {
    case Timeframe.ONE_HOUR:         return 3600;
    case Timeframe.TWENTY_FOUR_HOUR: return 86400;
    default: return 3600;
  }
}

async function managePredictionRounds() {
  try {
    console.log(`[${new Date().toISOString()}] Managing prediction rounds...`);

    const activeMetrics = [
      Metric.ACTIVE_ADDRESSES,
      Metric.ETH_LARGE_TRANSFERS,
      Metric.LIQUIDATION_VOLUME
    ];

    for (const metricId of activeMetrics) {
      for (const timeframeId of [Timeframe.ONE_HOUR, Timeframe.TWENTY_FOUR_HOUR]) {
        const key = getRoundKey(metricId, timeframeId);
        const tracked = roundTracker[key];
        const now = Math.floor(Date.now() / 1000);

        try {
          if (!tracked) {
            let latestId;
            try {
              latestId = await predictContract.getLatestRound(metricId, timeframeId);
            } catch (e) {
              console.error(`  getLatestRound failed metric ${metricId} tf ${timeframeId}: ${e.message?.slice(0, 80)}`);
              await sleep(300);
              continue;
            }
            await sleep(300);

            let shouldOpen = false;

            if (latestId === 0n) {
              shouldOpen = true;
            } else {
              let round;
              try {
                round = await predictContract.rounds(latestId);
              } catch (e) {
                console.error(`  rounds() failed id ${latestId}: ${e.message?.slice(0, 80)}`);
                await sleep(300);
                continue;
              }
              await sleep(300);

              const status = Number(round.status);
              const closeTime = Number(round.closeTime);

              if (status === RoundStatus.OPEN && now >= closeTime) {
                if (!metricIsReady(metricId)) {
                  console.log(`  Metric ${metricId} not ready — skipping resolve`);
                  continue;
                }
                const endValue = toScaled(getMetricCurrentValue(metricId));
                try {
                  await enqueue(async () => {
                    console.log(`  Resolving round ${latestId} metric ${metricId} tf ${timeframeId}`);
                    const tx = await predictContract.resolveRound(latestId, endValue);
                    console.log(`  Resolve TX: ${tx.hash}`);
                    await tx.wait();
                    console.log(`  Resolved.`);
                  });
                } catch (e) {
                  console.error(`  Resolve failed (non-fatal): ${e.message?.slice(0, 80)}`);
                }
                shouldOpen = true;
              } else if (status === RoundStatus.OPEN && now < closeTime) {
                roundTracker[key] = { roundId: latestId, closeTime };
                console.log(`  Round ${latestId} still open — closes in ${closeTime - now}s`);
                continue;
              } else {
                shouldOpen = true;
              }
            }

            if (shouldOpen) {
              if (!metricIsReady(metricId)) {
                console.log(`  Metric ${metricId} not ready — skipping open`);
                continue;
              }
              const startValue = toScaled(getMetricCurrentValue(metricId));
              const duration = getTimeframeDuration(timeframeId);
              try {
                await enqueue(async () => {
                  console.log(`  Opening round metric ${metricId} tf ${timeframeId} startValue ${startValue}`);
                  const tx = await predictContract.openRound(metricId, timeframeId, startValue);
                  console.log(`  Open TX: ${tx.hash}`);
                  await tx.wait();
                  const newId = await predictContract.getLatestRound(metricId, timeframeId);
                  roundTracker[key] = { roundId: newId, closeTime: now + duration };
                  console.log(`  Round opened. ID: ${newId}`);
                });
              } catch (e) {
                console.error(`  Open round failed (non-fatal): ${e.message?.slice(0, 80)}`);
              }
            }

          } else {
            if (now >= tracked.closeTime) {
              console.log(`  Round ${tracked.roundId} metric ${metricId} tf ${timeframeId} — time to resolve`);
              if (!metricIsReady(metricId)) {
                console.log(`  Metric ${metricId} not ready — skipping resolve`);
                continue;
              }
              const endValue = toScaled(getMetricCurrentValue(metricId));
              const duration = getTimeframeDuration(timeframeId);
              try {
                await enqueue(async () => {
                  console.log(`  Resolving round ${tracked.roundId}`);
                  const tx = await predictContract.resolveRound(tracked.roundId, endValue);
                  console.log(`  Resolve TX: ${tx.hash}`);
                  await tx.wait();
                  console.log(`  Resolved.`);
                });
              } catch (e) {
                console.error(`  Resolve failed (non-fatal): ${e.message?.slice(0, 80)}`);
              }
              delete roundTracker[key];

              if (metricIsReady(metricId)) {
                const startValue = toScaled(getMetricCurrentValue(metricId));
                const nowAfter = Math.floor(Date.now() / 1000);
                await sleep(4000);
                try {
                  await enqueue(async () => {
                    console.log(`  Opening next round metric ${metricId} tf ${timeframeId}`);
                    const tx = await predictContract.openRound(metricId, timeframeId, startValue);
                    console.log(`  Open TX: ${tx.hash}`);
                    await tx.wait();
                    const newId = await predictContract.getLatestRound(metricId, timeframeId);
                    roundTracker[key] = { roundId: newId, closeTime: nowAfter + duration };
                    console.log(`  Round opened. ID: ${newId}`);
                  });
                } catch (e) {
                  console.error(`  Open next round failed (non-fatal): ${e.message?.slice(0, 80)}`);
                }
              }
            } else {
              console.log(`  Round ${tracked.roundId} metric ${metricId} tf ${timeframeId} — closes in ${tracked.closeTime - now}s`);
            }
          }

        } catch (err) {
          console.error(`  Round manager error metric ${metricId} tf ${timeframeId}: ${err.message?.slice(0, 80)}`);
          await sleep(300);
        }
      }
    }
  } catch (err) {
    console.error(`  managePredictionRounds error: ${err.message}`);
  }
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  if (req.url === "/") {
    res.end(JSON.stringify({
      GAS: latestPrices.GAS,
      TXS_PER_BLOCK: latestPrices.TXS_PER_BLOCK,
      updatedAt: latestPrices.updatedAt
    }));
  } else if (req.url === "/feed") {
    res.end(JSON.stringify(networkFeed));
  } else if (req.url === "/rounds") {
    const out = {};
    for (const [key, val] of Object.entries(roundTracker)) {
      out[key] = {
        roundId: val.roundId?.toString(),
        closeTime: val.closeTime
      };
    }
    res.end(JSON.stringify(out));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  }
});

server.listen(PORT, () => {
  console.log(`Keeper server running on port ${PORT}`);
});

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────

async function main() {
  console.log("ChainFlux Keeper starting...");

  console.log("Warming up rolling averages (5 blocks)...");
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
    await managePredictionRounds();
  }, INTERVAL_MS);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
