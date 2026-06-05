// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable@5.0.2/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable@5.0.2/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable@5.0.2/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable@5.0.2/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable@5.0.2/token/ERC20/ERC20Upgradeable.sol";

/// @title ChainFlux V3 — Trade the heartbeat of blockchain
contract ChainFlux is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    ERC20Upgradeable
{
    // ─────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────

    uint256 public constant FEE_BPS = 30;
    uint256 public constant BPS_DENOM = 10_000;
    uint256 public constant MIN_POSITION = 0.001 ether;
    uint256 public constant PRICE_PRECISION = 1e18;
    uint256 public constant PRICE_STALENESS = 300;
    uint256 public constant LIQ_THRESHOLD_BPS = 8_000;
    uint256 public constant LIQ_BONUS_BPS = 500;

    uint256 public constant CFT_MULTIPLIER = 10_000;
    uint256 public constant WIN_BONUS_MULTIPLIER = 2;
    uint256 public constant CFT_TOTAL_SUPPLY = 1_000_000_000 * 1e18;

    uint256 public constant TIER_BRONZE  =   5_000 * 1e18;
    uint256 public constant TIER_SILVER  =  50_000 * 1e18;
    uint256 public constant TIER_GOLD    = 200_000 * 1e18;
    uint256 public constant TIER_DIAMOND = 500_000 * 1e18;

    uint8 public constant LEV_UNRANKED = 5;
    uint8 public constant LEV_BRONZE   = 10;
    uint8 public constant LEV_SILVER   = 20;
    uint8 public constant LEV_GOLD     = 25;
    uint8 public constant LEV_DIAMOND  = 30;

    // ─────────────────────────────────────────────
    // Enums
    // ─────────────────────────────────────────────

    enum Market    { GAS, LIQUIDATIONS, TXS_PER_BLOCK }
    enum Direction { LONG, SHORT }

    // ─────────────────────────────────────────────
    // Structs
    // ─────────────────────────────────────────────

    struct MarketState {
        uint256 price;
        uint256 updatedAt;
        uint256 longOI;
        uint256 shortOI;
    }

    struct Position {
        address trader;
        Market market;
        Direction direction;
        uint256 collateral;
        uint256 size;
        uint256 entryPrice;
        uint256 openedAt;
        uint256 cftMinted;
        bool open;
        uint8 leverage;
        uint256 liquidationPrice;
    }

    // ─────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────

    address public feeRecipient;
    mapping(Market => MarketState) public markets;
    mapping(uint256 => Position) public positions;
    mapping(address => uint256[]) public userPositions;
    mapping(address => bool) public isKeeper;
    uint256 public positionCount;
    uint256 public totalFeesCollected;
    uint256 public cftRewardsPool;
    bool public v3Initialized;

    // ─────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────

    event PriceUpdated(Market indexed market, uint256 price, uint256 timestamp);
    event PositionOpened(
        uint256 indexed id,
        address indexed trader,
        Market market,
        Direction direction,
        uint256 collateral,
        uint8 leverage,
        uint256 liquidationPrice,
        uint256 cftMinted
    );
    event PositionClosed(uint256 indexed id, address indexed trader, int256 pnl, uint256 payout, uint256 cftRewarded);
    event PositionLiquidated(uint256 indexed id, address indexed trader, address indexed liquidator, uint256 bonus);
    event KeeperUpdated(address indexed keeper, bool status);
    event FeeRecipientUpdated(address indexed newRecipient);
    event CFTRewarded(address indexed trader, uint256 amount, bool won);

    // ─────────────────────────────────────────────
    // Modifiers
    // ─────────────────────────────────────────────

    modifier onlyKeeper() {
        require(isKeeper[msg.sender], "ChainFlux: not keeper");
        _;
    }

    modifier validLeverage(uint8 leverage) {
        require(leverage >= 2 && leverage <= 30, "ChainFlux: invalid leverage");
        require(leverage <= getMaxLeverage(msg.sender), "ChainFlux: leverage exceeds tier");
        _;
    }

    // ─────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ─────────────────────────────────────────────
    // Initializer
    // ─────────────────────────────────────────────

    function initialize(
        address _feeRecipient,
        address _keeper
    ) external initializer {
        __Ownable_init(msg.sender);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __ERC20_init("ChainFlux Token", "CFT");
        feeRecipient = _feeRecipient;
        isKeeper[_keeper] = true;
    }

    // ─────────────────────────────────────────────
    // V3 Initializer
    // ─────────────────────────────────────────────

    function initializeV3(address founderWallet) external onlyOwner {
        require(!v3Initialized, "ChainFlux: V3 already initialized");
        require(founderWallet != address(0), "ChainFlux: zero address");
        v3Initialized = true;
        uint256 rewardsAmount = 700_000_000 * 1e18;
        _mint(address(this), rewardsAmount);
        cftRewardsPool = rewardsAmount;
        _mint(founderWallet, 300_000_000 * 1e18);
    }

    // ─────────────────────────────────────────────
    // Tier System
    // ─────────────────────────────────────────────

    function getTier(address user) public view returns (uint8) {
        uint256 bal = balanceOf(user);
        if (bal >= TIER_DIAMOND) return 4;
        if (bal >= TIER_GOLD)    return 3;
        if (bal >= TIER_SILVER)  return 2;
        if (bal >= TIER_BRONZE)  return 1;
        return 0;
    }

    function getMaxLeverage(address user) public view returns (uint8) {
        uint8 tier = getTier(user);
        if (tier == 4) return LEV_DIAMOND;
        if (tier == 3) return LEV_GOLD;
        if (tier == 2) return LEV_SILVER;
        if (tier == 1) return LEV_BRONZE;
        return LEV_UNRANKED;
    }

    // ─────────────────────────────────────────────
    // Keeper
    // ─────────────────────────────────────────────

    function pushPrices(uint256[3] calldata prices) external onlyKeeper {
        _setPrice(Market.GAS,           prices[0]);
        _setPrice(Market.LIQUIDATIONS,  prices[1]);
        _setPrice(Market.TXS_PER_BLOCK, prices[2]);
    }

    function _setPrice(Market m, uint256 price) internal {
        require(price > 0, "ChainFlux: invalid price");
        markets[m].price     = price;
        markets[m].updatedAt = block.timestamp;
        emit PriceUpdated(m, price, block.timestamp);
    }

    // ─────────────────────────────────────────────
    // Trading
    // ─────────────────────────────────────────────

    function openPosition(
        uint8 marketId,
        uint8 dirId,
        uint8 leverage
    )
        external
        payable
        nonReentrant
        validLeverage(leverage)
    {
        require(msg.value >= MIN_POSITION, "ChainFlux: below minimum");
        Market market = Market(marketId);
        Direction direction = Direction(dirId);
        require(markets[market].price > 0, "ChainFlux: no price feed");
        require(
            block.timestamp - markets[market].updatedAt <= PRICE_STALENESS,
            "ChainFlux: price stale"
        );
        _processOpen(market, direction, leverage);
    }

    function _processOpen(
        Market market,
        Direction direction,
        uint8 leverage
    ) internal {
        uint256 fee        = (msg.value * FEE_BPS) / BPS_DENOM;
        uint256 collateral = msg.value - fee;

        totalFeesCollected += fee;
        (bool feeOk,) = feeRecipient.call{value: fee}("");
        require(feeOk, "ChainFlux: fee transfer failed");

        uint256 entryPrice       = markets[market].price;
        uint256 liquidationPrice = _computeLiqPrice(entryPrice, leverage, direction);

        if (direction == Direction.LONG) {
            markets[market].longOI += collateral;
        } else {
            markets[market].shortOI += collateral;
        }

        uint256 id = positionCount++;
        positions[id] = Position({
            trader:           msg.sender,
            market:           market,
            direction:        direction,
            collateral:       collateral,
            size:             collateral * leverage,
            entryPrice:       entryPrice,
            openedAt:         block.timestamp,
            cftMinted:        0,
            open:             true,
            leverage:         leverage,
            liquidationPrice: liquidationPrice
        });

        userPositions[msg.sender].push(id);
        emit PositionOpened(id, msg.sender, market, direction, collateral, leverage, liquidationPrice, 0);
    }

    function closePosition(uint256 id) external nonReentrant {
        Position storage pos = positions[id];
        require(pos.open,                 "ChainFlux: position not open");
        require(pos.trader == msg.sender, "ChainFlux: not your position");
        uint256 currentPrice = markets[pos.market].price;
        require(currentPrice > 0, "ChainFlux: no price feed");
        int256  pnl    = _calculatePnL(pos, currentPrice);
        uint256 payout = _resolvePayout(pos.collateral, pnl);
        uint256 cftReward = _computeCFTReward(pos.collateral, pos.leverage, pnl >= 0);
        _distributeCFT(msg.sender, cftReward, pnl >= 0);
        _closePosition(id, pos, payout, pnl, cftReward);
    }

    function liquidate(address trader, uint8 marketId) external nonReentrant {
        uint256[] storage ids = userPositions[trader];
        uint256 posId = type(uint256).max;
        for (uint256 i = 0; i < ids.length; i++) {
            Position storage p = positions[ids[i]];
            if (p.open && uint8(p.market) == marketId) {
                posId = ids[i];
                break;
            }
        }
        require(posId != type(uint256).max, "ChainFlux: no open position");
        Position storage pos = positions[posId];
        uint256 currentPrice = markets[pos.market].price;
        require(currentPrice > 0, "ChainFlux: no price feed");
        require(_isLiquidatable(pos, currentPrice), "ChainFlux: not liquidatable");
        uint256 bonus     = (pos.collateral * LIQ_BONUS_BPS) / BPS_DENOM;
        uint256 remaining = pos.collateral > bonus ? pos.collateral - bonus : 0;
        if (pos.direction == Direction.LONG) {
            markets[pos.market].longOI  -= pos.collateral;
        } else {
            markets[pos.market].shortOI -= pos.collateral;
        }
        pos.open = false;
        if (bonus > 0 && address(this).balance >= bonus) {
            (bool ok,) = msg.sender.call{value: bonus}("");
            require(ok, "ChainFlux: bonus transfer failed");
        }
        if (remaining > 0 && address(this).balance >= remaining) {
            (bool ok2,) = feeRecipient.call{value: remaining}("");
            require(ok2, "ChainFlux: remaining transfer failed");
        }
        emit PositionLiquidated(posId, trader, msg.sender, bonus);
    }

    // ─────────────────────────────────────────────
    // CFT Rewards
    // ─────────────────────────────────────────────

    function _computeCFTReward(
        uint256 collateral,
        uint8 leverage,
        bool won
    ) internal pure returns (uint256) {
        uint256 cft = collateral * leverage * CFT_MULTIPLIER;
        if (won) cft = cft * WIN_BONUS_MULTIPLIER;
        return cft;
    }

    function _distributeCFT(address trader, uint256 amount, bool won) internal {
        if (amount == 0 || cftRewardsPool == 0) return;
        uint256 toSend = amount > cftRewardsPool ? cftRewardsPool : amount;
        cftRewardsPool -= toSend;
        _transfer(address(this), trader, toSend);
        emit CFTRewarded(trader, toSend, won);
    }

    // ─────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────

    function _computeLiqPrice(
        uint256 entryPrice,
        uint8 leverage,
        Direction direction
    ) internal pure returns (uint256) {
        uint256 movePercent = (LIQ_THRESHOLD_BPS * PRICE_PRECISION) / (BPS_DENOM * leverage);
        if (direction == Direction.LONG) {
            return entryPrice - (entryPrice * movePercent / PRICE_PRECISION);
        } else {
            return entryPrice + (entryPrice * movePercent / PRICE_PRECISION);
        }
    }

    function _isLiquidatable(
        Position storage pos,
        uint256 currentPrice
    ) internal view returns (bool) {
        int256 pnl = _calculatePnL(pos, currentPrice);
        if (pnl >= 0) return false;
        uint256 loss = uint256(-pnl);
        return loss >= (pos.collateral * LIQ_THRESHOLD_BPS) / BPS_DENOM;
    }

    function _calculatePnL(
        Position storage pos,
        uint256 currentPrice
    ) internal view returns (int256) {
        int256 entry   = int256(pos.entryPrice);
        int256 current = int256(currentPrice);
        int256 size    = int256(pos.size);
        if (pos.direction == Direction.LONG) {
            return (size * (current - entry)) / entry;
        } else {
            return (size * (entry - current)) / entry;
        }
    }

    function _resolvePayout(
        uint256 collateral,
        int256 pnl
    ) internal pure returns (uint256) {
        if (pnl >= 0) {
            return collateral + uint256(pnl);
        } else {
            uint256 loss = uint256(-pnl);
            return loss >= collateral ? 0 : collateral - loss;
        }
    }

    function _closePosition(
        uint256 id,
        Position storage pos,
        uint256 payout,
        int256 pnl,
        uint256 cftRewarded
    ) internal {
        if (pos.direction == Direction.LONG) {
            markets[pos.market].longOI  -= pos.collateral;
        } else {
            markets[pos.market].shortOI -= pos.collateral;
        }
        pos.open = false;
        if (payout > 0) {
            require(address(this).balance >= payout, "ChainFlux: insufficient balance");
            (bool ok,) = msg.sender.call{value: payout}("");
            require(ok, "ChainFlux: payout failed");
        }
        emit PositionClosed(id, msg.sender, pnl, payout, cftRewarded);
    }

    // ─────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────

    function getMarket(uint8 marketId) external view returns (uint256 price, uint256 timestamp) {
        MarketState storage m = markets[Market(marketId)];
        return (m.price, m.updatedAt);
    }

    function getMarketFull(uint8 marketId) external view returns (MarketState memory) {
        return markets[Market(marketId)];
    }

    function getPosition(uint256 id) external view returns (Position memory) {
        return positions[id];
    }

    function getPositionPnL(uint256 id) external view returns (int256) {
        Position storage pos = positions[id];
        require(pos.open, "ChainFlux: position not open");
        return _calculatePnL(pos, markets[pos.market].price);
    }

    function getUserPositions(address user) external view returns (uint256[] memory) {
        return userPositions[user];
    }

    function getSentiment(uint8 marketId) external view returns (uint256 longPct, uint256 shortPct) {
        MarketState storage m = markets[Market(marketId)];
        uint256 total = m.longOI + m.shortOI;
        if (total == 0) return (50, 50);
        longPct  = (m.longOI * 100) / total;
        shortPct = 100 - longPct;
    }

    function getAllMarkets() external view returns (
        MarketState memory gas,
        MarketState memory liquidations,
        MarketState memory txsPerBlock
    ) {
        return (
            markets[Market.GAS],
            markets[Market.LIQUIDATIONS],
            markets[Market.TXS_PER_BLOCK]
        );
    }

    function getTierInfo(address user) external view returns (
        uint8 tier,
        uint256 cftBalance,
        uint8 maxLeverage,
        uint256 nextTierThreshold
    ) {
        tier        = getTier(user);
        cftBalance  = balanceOf(user);
        maxLeverage = getMaxLeverage(user);
        if (tier == 0) nextTierThreshold = TIER_BRONZE;
        else if (tier == 1) nextTierThreshold = TIER_SILVER;
        else if (tier == 2) nextTierThreshold = TIER_GOLD;
        else if (tier == 3) nextTierThreshold = TIER_DIAMOND;
        else nextTierThreshold = 0;
    }

    // ─────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────

    function setKeeper(address _keeper, bool status) external onlyOwner {
        isKeeper[_keeper] = status;
        emit KeeperUpdated(_keeper, status);
    }

    function setFeeRecipient(address _newRecipient) external onlyOwner {
        require(_newRecipient != address(0), "ChainFlux: zero address");
        feeRecipient = _newRecipient;
        emit FeeRecipientUpdated(_newRecipient);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    receive() external payable {}
}
