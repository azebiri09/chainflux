import { ethers } from "ethers";
import fetch from "node-fetch";
import http from "http";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const KEEPER_PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY;

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
  WHALE_TRANSFERS: 1,
  ETH_LARGE_TRANSFERS: 2,
  LIQUIDATION_VOLUME: 3,
  STABLES_MINTED_BURNED: 4,
  NEW_WALLET_CREATION: 5,
  BRIDGE_INFLOWS_OUTFLOWS: 6,
  DEX_VOLUME: 7
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

// ─── MINIMUM THRESHOLDS ───────────────────────────────────────────────────────

const METRIC_THRESHOLDS = {
  [Metric.ACTIVE_ADDRESSES]:      10,
  [Metric.WHALE_TRANSFERS]:        2,
  [Metric.ETH_LARGE_TRANSFERS]:    2,
  [Metric.LIQUIDATION_VOLUME]:     1,
  [Metric.STABLES_MINTED_BURNED]: 100,
  [Metric.NEW_WALLET_CREATION]:    2,
  [Metric.BRIDGE_INFLOWS_OUTFLOWS]: 0.05,
  [Metric.DEX_VOLUME]:             2
};

function metricIsReady(metricId) {
  const value = getRawMetricValue(metricId);
  const threshold = METRIC_THRESHOLDS[metricId];
  return value > threshold;
}

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

// ─── CACHES ───────────────────────────────────────────────────────────────────

let latestPrices = {
  GAS: 0,
  TXS_PER_BLOCK: 0,
  updatedAt: 0
};

let networkFeed = {
  ACTIVE_ADDRESSES: 0,
  WHALE_TRANSFERS: 0,
  ETH_LARGE_TRANSFERS: 0,
  LIQUIDATION_VOLUME: 0,
  STABLES_MINTED_BURNED: 0,
  NEW_WALLET_CREATION: 0,
  BRIDGE_INFLOWS_OUTFLOWS: 0,
  DEX_VOLUME: 0,
  updatedAt: 0
};

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

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toScaled(value) {
  return BigInt(Math.round(value)) * PRICE_PRECISION;
}

function toHex(num) {
  return "0x" + num.toString(16);
}

async function getBlockRange(numBlocks) {
  const latest = await provider.getBlockNumber();
  const from = Math.max(0, latest - numBlocks);
  return { fromBlock: from, toBlock: latest, latestBlock: latest };
}

function getRawMetricValue(metric) {
  switch (metric) {
    case Metric.ACTIVE_ADDRESSES:        return networkFeed.ACTIVE_ADDRESSES || 0;
    case Metric.WHALE_TRANSFERS:         return networkFeed.WHALE_TRANSFERS || 0;
    case Metric.ETH_LARGE_TRANSFERS:     return networkFeed.ETH_LARGE_TRANSFERS || 0;
    case Metric.LIQUIDATION_VOLUME:      return networkFeed.LIQUIDATION_VOLUME || 0;
    case Metric.STABLES_MINTED_BURNED:   return networkFeed.STABLES_MINTED_BURNED || 0;
    case Metric.NEW_WALLET_CREATION:     return networkFeed.NEW_WALLET_CREATION || 0;
    case Metric.BRIDGE_INFLOWS_OUTFLOWS: return networkFeed.BRIDGE_INFLOWS_OUTFLOWS || 0;
    case Metric.DEX_VOLUME:              return networkFeed.DEX_VOLUME || 0;
    default: return 0;
  }
}

function getCurrentMetricValue(metric) {
  const raw = getRawMetricValue(metric);
  return toScaled(raw) || 0n;
}

// ─── SLOT 0 — GAS ─────────────────────────────────────────────────────────────

async function fetchGas() {
  try {
    const url = `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_gasPrice&apikey=${ETHERSCAN_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    if (!data.result || typeof data.result !== "string" || !data.result.startsWith("0x")) {
      throw new Error("bad gas response");
    }

    const rawGwei = Number(BigInt(data.result)) / 1e9;
    const scaled = BigInt(Math.round(rawGwei * 1e18));

    pushToWindow(gasHistory, scaled, GAS_WINDOW);
    const smoothed = rollingAverage(gasHistory);

    console.log(`  GAS: ${rawGwei.toFixed(4)} gwei | smoothed: ${Number(smoothed) / 1e18}`);
    return smoothed;
  } catch (err) {
    console.error(`  GAS error: ${err.message}`);
    return gasHistory.length > 0 ? rollingAverage(gasHistory) : BigInt("220000000000000000");
  }
}

// ─── SLOT 2 — TXS PER BLOCK ───────────────────────────────────────────────────

async function fetchTxsPerBlock() {
  try {
    const url = `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_getBlockByNumber&tag=latest&boolean=false&apikey=${ETHERSCAN_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    const txs = data?.result?.transactions ?? [];
    const count = txs.length;

    if (count === 0) throw new Error("empty block");

    const scaled = BigInt(count) * PRICE_PRECISION;
    pushToWindow(txsHistory, scaled, TXS_WINDOW);
    const smoothed = rollingAverage(txsHistory);

    console.log(`  TXS PER BLOCK: ${count} | smoothed: ${Number(smoothed) / 1e18}`);
    return smoothed;
  } catch (err) {
    console.error(`  TXS error: ${err.message}`);
    return txsHistory.length > 0 ? rollingAverage(txsHistory) : BigInt("200000000000000000000");
  }
}

// ─── FEED: ACTIVE ADDRESSES ───────────────────────────────────────────────────

async function fetchActiveAddresses() {
  try {
    const { fromBlock, toBlock, latestBlock } = await getBlockRange(500);
    const addressSet = new Set();
    for (let i = 0; i < 5; i++) {
      const tag = toHex(latestBlock - i);
      const url = `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_getBlockByNumber&tag=${tag}&boolean=true&apikey=${ETHERSCAN_API_KEY}`;
      const res = await fetch(url);
      const data = await res.json();
      const txs = data?.result?.transactions ?? [];
      for (const tx of txs) {
        if (tx.from) addressSet.add(tx.from.toLowerCase());
        if (tx.to) addressSet.add(tx.to.toLowerCase());
      }
      await sleep(600);
    }
    const count = addressSet.size;
    console.log(`  ACTIVE_ADDRESSES: ${count}`);
    return count || networkFeed.ACTIVE_ADDRESSES || 0;
  } catch (err) {
    console.error(`  ACTIVE_ADDRESSES error: ${err.message}`);
    return networkFeed.ACTIVE_ADDRESSES || 0;
  }
}

// ─── FEED: WHALE TRANSFERS ────────────────────────────────────────────────────

async function fetchWhaleTransfers() {
  try {
    const { fromBlock, toBlock } = await getBlockRange(50);
    const WHALE_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
    const url = `https://api.etherscan.io/v2/api?chainid=1&module=logs&action=getLogs&address=${WETH}&topic0=${WHALE_TOPIC}&fromBlock=${fromBlock}&toBlock=${toBlock}&apikey=${ETHERSCAN_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!Array.isArray(data?.result)) throw new Error("bad whale response");
    const WHALE_THRESHOLD = BigInt("100000000000000000000"); // 100 ETH
    let whaleCount = 0;
    for (const log of data.result) {
      try {
        if (BigInt(log.data) >= WHALE_THRESHOLD) whaleCount++;
      } catch {}
    }
    console.log(`  WHALE_TRANSFERS: ${whaleCount} over last 50 blocks`);
    return whaleCount || networkFeed.WHALE_TRANSFERS || 0;
  } catch (err) {
    console.error(`  WHALE_TRANSFERS error: ${err.message}`);
    return networkFeed.WHALE_TRANSFERS || 0;
  }
}

// ─── FEED: ETH LARGE TRANSFERS ────────────────────────────────────────────────

async function fetchEthLargeTransfers() {
  try {
    const { fromBlock, toBlock } = await getBlockRange(200);
    const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
    const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const url = `https://api.etherscan.io/v2/api?chainid=1&module=logs&action=getLogs&address=${WETH}&topic0=${TRANSFER_TOPIC}&fromBlock=${fromBlock}&toBlock=${toBlock}&apikey=${ETHERSCAN_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!Array.isArray(data?.result)) throw new Error("bad eth large response");
    const LARGE_THRESHOLD = BigInt("10000000000000000000"); // 10 ETH
    let largeCount = 0;
    for (const log of data.result) {
      try {
        if (BigInt(log.data) >= LARGE_THRESHOLD) largeCount++;
      } catch {}
    }
    console.log(`  ETH_LARGE_TRANSFERS: ${largeCount} transfers >= 10 ETH over last 200 blocks`);
    return largeCount || networkFeed.ETH_LARGE_TRANSFERS || 0;
  } catch (err) {
    console.error(`  ETH_LARGE_TRANSFERS error: ${err.message}`);
    return networkFeed.ETH_LARGE_TRANSFERS || 0;
  }
}

// ─── FEED: LIQUIDATION VOLUME ─────────────────────────────────────────────────

async function fetchLiquidationVolume() {
  try {
    const { fromBlock, toBlock } = await getBlockRange(500);
    const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
    const LIQUIDATION_TOPIC = "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286";
    const url = `https://api.etherscan.io/v2/api?chainid=1&module=logs&action=getLogs&address=${AAVE_POOL}&topic0=${LIQUIDATION_TOPIC}&fromBlock=${fromBlock}&toBlock=${toBlock}&apikey=${ETHERSCAN_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!Array.isArray(data?.result)) throw new Error("bad liquidation response");
    const count = data.result.length;
    console.log(`  LIQUIDATION_VOLUME: ${count} events over last 500 blocks`);
    return count || networkFeed.LIQUIDATION_VOLUME || 0;
  } catch (err) {
    console.error(`  LIQUIDATION_VOLUME error: ${err.message}`);
    return networkFeed.LIQUIDATION_VOLUME || 0;
  }
}

// ─── FEED: STABLES MINTED/BURNED ─────────────────────────────────────────────

async function fetchStablesMintedBurned() {
  try {
    const { fromBlock, toBlock } = await getBlockRange(200);
    const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";
    const urlMint = `https://api.etherscan.io/v2/api?chainid=1&module=logs&action=getLogs&address=${USDC}&topic0=${TRANSFER_TOPIC}&topic1=${ZERO}&fromBlock=${fromBlock}&toBlock=${toBlock}&apikey=${ETHERSCAN_API_KEY}`;
    const urlBurn = `https://api.etherscan.io/v2/api?chainid=1&module=logs&action=getLogs&address=${USDC}&topic0=${TRANSFER_TOPIC}&topic2=${ZERO}&fromBlock=${fromBlock}&toBlock=${toBlock}&apikey=${ETHERSCAN_API_KEY}`;
    await sleep(600);
    const [resMint, resBurn] = await Promise.all([fetch(urlMint), fetch(urlBurn)]);
    const [dataMint, dataBurn] = await Promise.all([resMint.json(), resBurn.json()]);
    if (!Array.isArray(dataMint?.result) && !Array.isArray(dataBurn?.result)) throw new Error("bad stables response");
    let totalUsdc = 0;
    for (const log of [...(Array.isArray(dataMint?.result) ? dataMint.result : []), ...(Array.isArray(dataBurn?.result) ? dataBurn.result : [])]) {
      try {
        totalUsdc += parseInt(log.data, 16) / 1e6;
      } catch {}
    }
    const rounded = Math.round(totalUsdc);
    console.log(`  STABLES_MINTED_BURNED: ${rounded} USDC over last 200 blocks`);
    return rounded || networkFeed.STABLES_MINTED_BURNED || 0;
  } catch (err) {
    console.error(`  STABLES_MINTED_BURNED error: ${err.message}`);
    return networkFeed.STABLES_MINTED_BURNED || 0;
  }
}

// ─── FEED: NEW WALLET CREATION ────────────────────────────────────────────────

async function fetchNewWalletCreation() {
  try {
    const { latestBlock } = await getBlockRange(20);
    let newContracts = 0;
    for (let i = 0; i < 20; i++) {
      const tag = toHex(latestBlock - i);
      const url = `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_getBlockByNumber&tag=${tag}&boolean=true&apikey=${ETHERSCAN_API_KEY}`;
      const res = await fetch(url);
      const data = await res.json();
      const txs = data?.result?.transactions ?? [];
      for (const tx of txs) {
        if (!tx.to || tx.to === "" || tx.to === null) newContracts++;
      }
      await sleep(600);
    }
    console.log(`  NEW_WALLET_CREATION: ${newContracts} deployments in last 20 blocks`);
    return newContracts || networkFeed.NEW_WALLET_CREATION || 0;
  } catch (err) {
    console.error(`  NEW_WALLET_CREATION error: ${err.message}`);
    return networkFeed.NEW_WALLET_CREATION || 0;
  }
}

// ─── FEED: BRIDGE INFLOWS ─────────────────────────────────────────────────────

async function fetchBridgeInflows() {
  try {
    const { fromBlock, toBlock } = await getBlockRange(500);
    const ARBITRUM_BRIDGE = "0x8315177aB297bA92A06054cE80a67Ed4DBd7ed3a";
    const url = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=txlist&address=${ARBITRUM_BRIDGE}&startblock=${fromBlock}&endblock=${toBlock}&sort=desc&apikey=${ETHERSCAN_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!Array.isArray(data?.result)) throw new Error("bad bridge response");
    let totalEth = 0;
    for (const tx of data.result) {
      try {
        totalEth += Number(BigInt(tx.value || "0")) / 1e18;
      } catch {}
    }
    const rounded = Math.round(totalEth * 100) / 100;
    console.log(`  BRIDGE_INFLOWS_OUTFLOWS: ${rounded} ETH over last 500 blocks`);
    return rounded || networkFeed.BRIDGE_INFLOWS_OUTFLOWS || 0;
  } catch (err) {
    console.error(`  BRIDGE_INFLOWS_OUTFLOWS error: ${err.message}`);
    return networkFeed.BRIDGE_INFLOWS_OUTFLOWS || 0;
  }
}

// ─── FEED: DEX VOLUME ─────────────────────────────────────────────────────────

async function fetchDexVolume() {
  try {
    const { fromBlock, toBlock } = await getBlockRange(100);
    const USDC_ETH_POOL = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640";
    const SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
    const url = `https://api.etherscan.io/v2/api?chainid=1&module=logs&action=getLogs&address=${USDC_ETH_POOL}&topic0=${SWAP_TOPIC}&fromBlock=${fromBlock}&toBlock=${toBlock}&apikey=${ETHERSCAN_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!Array.isArray(data?.result)) throw new Error("bad dex response");
    const count = data.result.length;
    console.log(`  DEX_VOLUME: ${count} swaps over last 100 blocks`);
    return count || networkFeed.DEX_VOLUME || 0;
  } catch (err) {
    console.error(`  DEX_VOLUME error: ${err.message}`);
    return networkFeed.DEX_VOLUME || 0;
  }
}

// ─── NETWORK FEED LOOP ────────────────────────────────────────────────────────

let feedTick = 0;

async function updateNetworkFeed() {
  try {
    feedTick++;
    console.log(`[${new Date().toISOString()}] Network Feed tick ${feedTick}`);

    networkFeed.ACTIVE_ADDRESSES = await fetchActiveAddresses();
    await sleep(600);

    networkFeed.WHALE_TRANSFERS = await fetchWhaleTransfers();
    await sleep(600);

    networkFeed.ETH_LARGE_TRANSFERS = await fetchEthLargeTransfers();
    await sleep(600);

    networkFeed.LIQUIDATION_VOLUME = await fetchLiquidationVolume();
    await sleep(600);

    networkFeed.STABLES_MINTED_BURNED = await fetchStablesMintedBurned();
    await sleep(600);

    networkFeed.NEW_WALLET_CREATION = await fetchNewWalletCreation();
    await sleep(600);

    if (feedTick % 4 === 0) {
      networkFeed.BRIDGE_INFLOWS_OUTFLOWS = await fetchBridgeInflows();
      await sleep(600);
      networkFeed.DEX_VOLUME = await fetchDexVolume();
      await sleep(600);
    }

    networkFeed.updatedAt = Date.now();

  } catch (err) {
    console.error(`  Network Feed error: ${err.message}`);
  }
}

// ─── PERPS PRICE PUSH ─────────────────────────────────────────────────────────

async function pushPrices() {
  try {
    console.log(`[${new Date().toISOString()}] Fetching perps prices...`);

    const gas = await fetchGas();
    await sleep(600);
    const txs = await fetchTxsPerBlock();

    await enqueue(async () => {
      console.log(`  Pushing to chain...`);
      const tx = await perpsContract.pushPrices([gas, 1n, txs]);
      console.log(`  TX sent: ${tx.hash}`);
      await tx.wait();
      console.log("  Perps confirmed.");

      latestPrices = {
        GAS: Number(gas) / 1e18,
        TXS_PER_BLOCK: Number(txs) / 1e18,
        updatedAt: Date.now()
      };

      console.log(`  GAS=${latestPrices.GAS} | TXS=${latestPrices.TXS_PER_BLOCK}`);
    });

  } catch (err) {
    console.error(`  Perps push error: ${err.message}`);
  }
}

// ─── PREDICTION ROUND MANAGER ─────────────────────────────────────────────────

const roundTracker = {};

function getRoundKey(metric, timeframe) {
  return `${metric}_${timeframe}`;
}

async function managePredictionRounds() {
  try {
    console.log(`[${new Date().toISOString()}] Managing prediction rounds...`);

    for (const [metricName, metricId] of Object.entries(Metric)) {
      for (const [timeframeName, timeframeId] of Object.entries(Timeframe)) {
        const key = getRoundKey(metricId, timeframeId);
        const tracked = roundTracker[key];
        const now = Math.floor(Date.now() / 1000);

        try {
          if (!tracked) {
            let latestId;
            try {
              latestId = await predictContract.getLatestRound(metricId, timeframeId);
            } catch (e) {
              console.error(`  getLatestRound failed ${metricName} ${timeframeName}: ${e.message}`);
              await sleep(200);
              continue;
            }
            await sleep(200);

            let shouldOpen = false;

            if (latestId === 0n) {
              shouldOpen = true;
            } else {
              try {
                const round = await predictContract.rounds(latestId);
                await sleep(200);
                if (Number(round.status) === RoundStatus.OPEN) {
                  roundTracker[key] = { roundId: latestId, closeTime: Number(round.closeTime) };
                  console.log(`  Loaded existing round: ${metricName} ${timeframeName} ID=${latestId}`);
                } else {
                  shouldOpen = true;
                }
              } catch (e) {
                console.error(`  rounds() failed ${metricName} ${timeframeName}: ${e.message}`);
                await sleep(200);
                continue;
              }
            }

            if (shouldOpen) {
              if (!metricIsReady(metricId)) {
                console.log(`  Feed not ready for ${metricName} — skipping round open`);
                continue;
              }
              const startValue = getCurrentMetricValue(metricId);
              console.log(`  Opening round: ${metricName} ${timeframeName} startValue=${startValue}`);
              await enqueue(async () => {
                try {
                  const tx = await predictContract.openRound(metricId, timeframeId, startValue);
                  console.log(`  TX sent openRound ${metricName} ${timeframeName}: ${tx.hash}`);
                  await tx.wait();
                  const newId = await predictContract.getLatestRound(metricId, timeframeId);
                  const newRound = await predictContract.rounds(newId);
                  roundTracker[key] = { roundId: newId, closeTime: Number(newRound.closeTime) };
                  console.log(`  Opened round: ${metricName} ${timeframeName} ID=${newId} closes=${newRound.closeTime}`);
                } catch (e) {
                  console.error(`  openRound FAILED ${metricName} ${timeframeName}: ${e.message}`);
                }
              });
            }

          } else {
            if (now >= tracked.closeTime) {
              if (!metricIsReady(metricId)) {
                console.log(`  Feed not ready for ${metricName} — skipping resolve/reopen`);
                continue;
              }
              const endValue = getCurrentMetricValue(metricId);
              const startValue = getCurrentMetricValue(metricId);
              await enqueue(async () => {
                try {
                  const tx = await predictContract.resolveRound(tracked.roundId, endValue);
                  console.log(`  TX sent resolveRound ${metricName} ${timeframeName}: ${tx.hash}`);
                  await tx.wait();
                  console.log(`  Resolved: ${metricName} ${timeframeName} ID=${tracked.roundId}`);
                  const tx2 = await predictContract.openRound(metricId, timeframeId, startValue);
                  console.log(`  TX sent openRound next ${metricName} ${timeframeName}: ${tx2.hash}`);
                  await tx2.wait();
                  const newId = await predictContract.getLatestRound(metricId, timeframeId);
                  const newRound = await predictContract.rounds(newId);
                  roundTracker[key] = { roundId: newId, closeTime: Number(newRound.closeTime) };
                  console.log(`  Opened next: ${metricName} ${timeframeName} ID=${newId}`);
                } catch (e) {
                  console.error(`  resolve/open FAILED ${metricName} ${timeframeName}: ${e.message}`);
                }
              });
            }
          }

        } catch (e) {
          console.error(`  Loop error ${metricName} ${timeframeName}: ${e.message}`);
        }

        await sleep(200);
      }
    }
  } catch (err) {
    console.error(`  Prediction round error: ${err.message}`);
  }
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────

http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  const url = req.url?.split("?")[0];

  if (url === "/feed") {
    res.end(JSON.stringify(networkFeed));
  } else if (url === "/rounds") {
    res.end(JSON.stringify(roundTracker));
  } else {
    res.end(JSON.stringify(latestPrices));
  }

}).listen(process.env.PORT || 3000, () => {
  console.log(`ChainFlux Keeper running on port ${process.env.PORT || 3000}`);
});

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("ChainFlux Keeper starting...");

  await updateNetworkFeed();

  setTimeout(async () => {
    await managePredictionRounds();
    setInterval(managePredictionRounds, 60000);
  }, 120000);

  await pushPrices();
  setInterval(pushPrices, INTERVAL_MS);
  setInterval(updateNetworkFeed, INTERVAL_MS);
}

main().catch(console.error);
