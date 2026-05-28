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

// ─── SLOT 1 — FETCH AAVE V3 TOTAL BORROWS ────────────────────────────────────
// Dynamic resolution: fetch variableDebt token addresses live from Aave Pool
// then call totalSupply() on each — never breaks if Aave upgrades

// Aave V3 Pool on Ethereum mainnet
const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";

// Aave V3 Pool Data Provider on Ethereum mainnet
const AAVE_DATA_PROVIDER = "0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3";

// getReserveTokensAddresses(address asset) selector
const GET_RESERVE_TOKENS_SIG = "0xd2493b6c";

// totalSupply() selector
const TOTAL_SUPPLY_SIG = "0x18160ddd";

const ASSETS = [
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
  "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", // WBTC
];

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

  if (!json.result || json.result === "0x" || json.result.length < 10) {
    throw new Error(`empty response from ${to}`);
  }

  return json.result;
}

async function fetchBorrows() {
  try {
    let totalBorrows = 0n;
    let successCount = 0;

    for (const asset of ASSETS) {
      try {
        // Step 1 — dynamically resolve variableDebt token address
        const paddedAsset = asset.slice(2).toLowerCase().padStart(64, "0");
        const reserveCallData = GET_RESERVE_TOKENS_SIG + paddedAsset;

        const reserveResult = await ethCall(AAVE_DATA_PROVIDER, reserveCallData);

        // getReserveTokensAddresses returns 3 values:
        // [0] aTokenAddress
        // [1] stableDebtTokenAddress
        // [2] variableDebtTokenAddress  <── we want this
        const hex = reserveResult.slice(2);
        const variableDebtAddress =
          "0x" + hex.slice(2 * 64, 3 * 64).slice(24); // last 20 bytes of slot 2

        if (
          !variableDebtAddress ||
          variableDebtAddress === "0x0000000000000000000000000000000000000000"
        ) {
          console.warn(`  BORROWS: could not resolve variableDebt for ${asset}`);
          continue;
        }

        // Step 2 — call totalSupply() on the live variableDebt token
        const totalSupplyResult = await ethCall(variableDebtAddress, TOTAL_SUPPLY_SIG);

        const supply = BigInt(totalSupplyResult);

        if (supply === 0n) {
          console.warn(`  BORROWS: zero totalSupply for ${asset}, skipping`);
          continue;
        }

        console.log(`  BORROWS: asset ${asset} → variableDebt ${variableDebtAddress} → supply ${supply}`);

        totalBorrows += supply;
        successCount++;

      } catch (innerErr) {
        console.warn(`  BORROWS: asset ${asset} error — ${innerErr.message}`);
      }
    }

    if (successCount === 0 || totalBorrows === 0n) {
      throw new Error("all asset calls failed or returned zero");
    }

    // Scale to ~1e18 tradable range
    const scaled  = totalBorrows / BigInt("100000000000000000000");
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

    const [gas, borrows, txsPerBlock] = await Promise.all([
      fetchGas(),
      fetchBorrows(),
      fetchTxsPerBlock()
    ]);

    console.log("  Pushing to chain...");

    const tx = await contract.pushPrices([
      gas,
      borrows,
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
