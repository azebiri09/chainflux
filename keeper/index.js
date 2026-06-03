import { ethers } from "ethers";
import fetch from "node-fetch";
import http from "http";

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const KEEPER_PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY;
const PORT = process.env.PORT || 3000;

const PROXY_ADDRESS = "0x615d3801019D33609Eed27EB39D40AB49fa44fAF";
const PREDICT_PROXY_ADDRESS = "0x7708a4C85F526E23090d3B27201487E91AF58694";
const RPC_URL = "https://sepolia-rollup.arbitrum.io/rpc";

const PRICE_PRECISION = BigInt("1000000000000000000");
const INTERVAL_MS = 15000;

const PERPS_ABI = [
  "function pushPrices(uint256[3] calldata prices) external"
];

const PREDICT_ABI = [
  "function openRound(uint8 metric, uint8 timeframe, uint256 startValue) external returns (uint256)",
  "function resolveRound(uint256 roundId, uint256 endValue) external",
  "function getLatestRound(uint8 metric, uint8 timeframe) external view returns (uint256)",
  "function rounds(uint256 roundId) external view returns (uint256 id, uint8 metric, uint8 timeframe, uint256 startValue, uint256 endValue, uint256 openTime, uint256 closeTime, uint256 higherPool, uint256 lowerPool, uint8 status, uint8 result)"
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(KEEPER_PRIVATE_KEY, provider);
const perpsContract = new ethers.Contract(PROXY_ADDRESS, PERPS_ABI, wallet);
const predictContract = new ethers.Contract(PREDICT_PROXY_ADDRESS, PREDICT_ABI, wallet);

const Metric = {
  ACTIVE_ADDRESSES: 0,
  GAS_PRICE: 2,
  TXS_PER_BLOCK: 3
};

const Timeframe = {
  ONE_HOUR: 0,
  TWENTY_FOUR_HOUR: 1
};

const RoundStatus = {
  OPEN: 0,
  RESOLVED: 1,
  CANCELLED: 2
};

const METRIC_THRESHOLDS = {
  [Metric.ACTIVE_ADDRESSES]: 10,
  [Metric.GAS_PRICE]: 0.01,
  [Metric.TXS_PER_BLOCK]: 1
};

// ─── TX QUEUE ─────────────────────────────────────────────────────────────────

const txQueue = [];
let txBusy = false;

async function enqueue(fn) {
  return new Promise((resolve, reject) => {
    txQueue.push({ fn, resolve, reject });
    if (!txBusy) processQueue();
  });
}

async function processQueue() {
  if (txQueue.length === 0) { txBusy = false; return; }
  txBusy = true;
  const { fn, resolve, reject } = txQueue.shift();
  try { resolve(await fn()); } catch (err) { reject(err); }
  processQueue();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── SCALING ──────────────────────────────────────────────────────────────────
// Store all values scaled by 1e18 for consistency.
// Gas: gwei value * 1e18  (frontend divides by 1e9 to get gwei — so we store gwei*1e9 as wei then *1e9 again... 
// Actually: frontend does Number(raw)/1e9 for gas. So we need raw = gwei * 1e9.
// For TXS: frontend does Number(raw)/100. So raw = txCount * 100.
// For Active Addresses: frontend checks raw > 1e12 then divides by 1e18, else uses raw directly.
// So Active Addresses: store as plain integer (no scaling needed if count < 1e12).

function toScaledGas(gwei) {
  // frontend: Number(raw) / 1e9 = gwei  →  raw = gwei * 1e9
  return BigInt(Math.round(gwei * 1e9));
}

function toScaledTxs(count) {
  // frontend: Number(raw) / 100 = count  →  raw = count * 100
  return BigInt(Math.round(count * 100));
}

function toScaledAddresses(count) {
  // frontend: if raw > 1e12 divide by 1e18, else use raw directly
  // count is always < 1e12 so store as plain integer
  return BigInt(Math.round(count));
}

function toScaled(metricId, value) {
  switch (metricId) {
    case Metric.GAS_PRICE:       return toScaledGas(value);
    case Metric.TXS_PER_BLOCK:   return toScaledTxs(value);
    case Metric.ACTIVE_ADDRESSES: return toScaledAddresses(value);
    default: return BigInt(Math.round(value));
  }
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

// ─── DAILY STATS ──────────────────────────────────────────────────────────────

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

// ─── CACHES ───────────────────────────────────────────────────────────────────

let latestPrices = { GAS: 0, TXS_PER_BLOCK: 0, updatedAt: 0 };
let networkFeed = {
  GAS: 0, GAS_DAILY_HIGH: 0, GAS_DAILY_LOW: 0,
  TXS_PER_BLOCK: 0, TXS_DAILY_HIGH: 0, TXS_DAILY_LOW: 0,
  ACTIVE_ADDRESSES: 0, ACTIVE_DAILY_HIGH: 0, ACTIVE_DAILY_LOW: 0,
  updatedAt: 0
};

// ─── BLOCK FETCH ──────────────────────────────────────────────────────────────

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

// ─── ROUND TRACKER — rebuilt from chain on startup ────────────────────────────

const roundTracker = {};

function getRoundKey(metric, timeframe) { return `${metric}_${timeframe}`; }

function getMetricCurrentValue(metricId) {
  switch (metricId) {
    case Metric.ACTIVE_ADDRESSES: return networkFeed.ACTIVE_ADDRESSES || 0;
    case Metric.GAS_PRICE:        return networkFeed.GAS || 0;
    case Metric.TXS_PER_BLOCK:    return networkFeed.TXS_PER_BLOCK || 0;
    default: return 0;
  }
}

function metricIsReady(metricId) {
  return getMetricCurrentValue(metricId) > (METRIC_THRESHOLDS[metricId] || 0);
}

function getTimeframeDuration(timeframeId) {
  return timeframeId === Timeframe.ONE_HOUR ? 3600 : 86400;
}

// Rebuild roundTracker from chain so restarts don't lose open rounds
async function rebuildRoundTracker() {
  console.log("Rebuilding round tracker from chain...");
  const activeMetrics = [Metric.ACTIVE_ADDRESSES, Metric.GAS_PRICE, Metric.TXS_PER_BLOCK];
  for (const metricId of activeMetrics) {
    for (const timeframeId of [Timeframe.ONE_HOUR, Timeframe.TWENTY_FOUR_HOUR]) {
      try {
        const latestId = await predictContract.getLatestRound(metricId, timeframeId);
        if (latestId === 0n) continue;
        const round = await predictContract.rounds(latestId);
        const status = Number(round.status);
        const closeTime = Number(round.closeTime);
        if (status === RoundStatus.OPEN) {
          const key = getRoundKey(metricId, timeframeId);
          roundTracker[key] = { roundId: latestId, closeTime };
          console.log(`  Recovered round ${latestId} metric ${metricId} tf ${timeframeId} closes in ${closeTime - Math.floor(Date.now()/1000)}s`);
        }
        await sleep(200);
      } catch (e) {
        console.error(`  Rebuild error metric ${metricId} tf ${timeframeId}: ${e.message?.slice(0, 80)}`);
      }
    }
  }
  console.log("Round tracker rebuilt.");
}

async function managePredictionRounds() {
  try {
    const activeMetrics = [Metric.ACTIVE_ADDRESSES, Metric.GAS_PRICE, Metric.TXS_PER_BLOCK];
    const now = Math.floor(Date.now() / 1000);

    for (const metricId of activeMetrics) {
      for (const timeframeId of [Timeframe.ONE_HOUR, Timeframe.TWENTY_FOUR_HOUR]) {
        const key = getRoundKey(metricId, timeframeId);
        const tracked = roundTracker[key];

        try {
          if (!tracked) {
            // No tracked round — check chain
            let latestId;
            try {
              latestId = await predictContract.getLatestRound(metricId, timeframeId);
            } catch (e) {
              console.error(`  getLatestRound failed m${metricId} tf${timeframeId}: ${e.message?.slice(0, 80)}`);
              continue;
            }
            await sleep(200);

            let shouldOpen = false;

            if (latestId === 0n) {
              shouldOpen = true;
            } else {
              let round;
              try {
                round = await predictContract.rounds(latestId);
              } catch (e) {
                console.error(`  rounds() failed id ${latestId}: ${e.message?.slice(0, 80)}`);
                continue;
              }
              await sleep(200);

              const status = Number(round.status);
              const closeTime = Number(round.closeTime);

              if (status === RoundStatus.OPEN && now >= closeTime) {
                // Overdue open round — resolve it now
                if (metricIsReady(metricId)) {
                  const endValue = toScaled(metricId, getMetricCurrentValue(metricId));
                  try {
                    await enqueue(async () => {
                      console.log(`  Resolving overdue round ${latestId} m${metricId} tf${timeframeId}`);
                      const tx = await predictContract.resolveRound(latestId, endValue);
                      await tx.wait();
                      console.log(`  Resolved.`);
                    });
                  } catch (e) {
                    console.error(`  Resolve failed: ${e.message?.slice(0, 80)}`);
                  }
                }
                shouldOpen = true;
              } else if (status === RoundStatus.OPEN && now < closeTime) {
                roundTracker[key] = { roundId: latestId, closeTime };
                console.log(`  Recovered round ${latestId} m${metricId} tf${timeframeId} closes in ${closeTime - now}s`);
                continue;
              } else {
                // Resolved or cancelled — open new
                shouldOpen = true;
              }
            }

            if (shouldOpen && metricIsReady(metricId)) {
              const startValue = toScaled(metricId, getMetricCurrentValue(metricId));
              const duration = getTimeframeDuration(timeframeId);
              try {
                await enqueue(async () => {
                  console.log(`  Opening round m${metricId} tf${timeframeId} startValue ${startValue}`);
                  const tx = await predictContract.openRound(metricId, timeframeId, startValue);
                  await tx.wait();
                  const newId = await predictContract.getLatestRound(metricId, timeframeId);
                  roundTracker[key] = { roundId: newId, closeTime: Math.floor(Date.now()/1000) + duration };
                  console.log(`  Opened round ID: ${newId}`);
                });
              } catch (e) {
                console.error(`  Open round failed: ${e.message?.slice(0, 80)}`);
              }
            }

          } else {
            // Have tracked round
            if (now >= tracked.closeTime) {
              console.log(`  Resolving round ${tracked.roundId} m${metricId} tf${timeframeId}`);
              const duration = getTimeframeDuration(timeframeId);

              if (metricIsReady(metricId)) {
                const endValue = toScaled(metricId, getMetricCurrentValue(metricId));
                try {
                  await enqueue(async () => {
                    const tx = await predictContract.resolveRound(tracked.roundId, endValue);
                    await tx.wait();
                    console.log(`  Resolved round ${tracked.roundId}.`);
                  });
                } catch (e) {
                  console.error(`  Resolve failed: ${e.message?.slice(0, 80)}`);
                }
              }

              delete roundTracker[key];
              await sleep(3000);

              if (metricIsReady(metricId)) {
                const startValue = toScaled(metricId, getMetricCurrentValue(metricId));
                const nowAfter = Math.floor(Date.now() / 1000);
                try {
                  await enqueue(async () => {
                    console.log(`  Opening next round m${metricId} tf${timeframeId}`);
                    const tx = await predictContract.openRound(metricId, timeframeId, startValue);
                    await tx.wait();
                    const newId = await predictContract.getLatestRound(metricId, timeframeId);
                    roundTracker[key] = { roundId: newId, closeTime: nowAfter + duration };
                    console.log(`  Opened round ID: ${newId}`);
                  });
                } catch (e) {
                  console.error(`  Open next round failed: ${e.message?.slice(0, 80)}`);
                }
              }
            } else {
              console.log(`  Round ${tracked.roundId} m${metricId} tf${timeframeId} closes in ${tracked.closeTime - now}s`);
            }
          }
        } catch (err) {
          console.error(`  Round manager error m${metricId} tf${timeframeId}: ${err.message?.slice(0, 80)}`);
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
    res.end(JSON.stringify({ GAS: latestPrices.GAS, TXS_PER_BLOCK: latestPrices.TXS_PER_BLOCK, updatedAt: latestPrices.updatedAt }));
  } else if (req.url === "/feed") {
    res.end(JSON.stringify(networkFeed));
  } else if (req.url === "/rounds") {
    const out = {};
    for (const [key, val] of Object.entries(roundTracker)) {
      out[key] = { roundId: val.roundId?.toString(), closeTime: val.closeTime };
    }
    res.end(JSON.stringify(out));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  }
});

server.listen(PORT, () => console.log(`Keeper running on port ${PORT}`));

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("ChainFlux Keeper starting...");

  // Warmup rolling averages
  console.log("Warming up (5 blocks)...");
  for (let i = 0; i < 5; i++) {
    await updateAllMetrics();
    await sleep(3000);
  }
  console.log("Warmup complete.");

  // Rebuild round tracker from chain — survives restarts
  await rebuildRoundTracker();

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
