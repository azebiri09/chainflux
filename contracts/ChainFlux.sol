// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable@5.0.2/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable@5.0.2/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable@5.0.2/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable@5.0.2/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable@5.0.2/token/ERC20/ERC20Upgradeable.sol";

/// @title ChainFlux V2 — Trade the heartbeat of blockchain
/// @notice Perpetual trading on live Ethereum blockchain activity, settled on Arbitrum
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
    uint256 public constant PRICE_STALENESS = 60;        // seconds
    uint256 public constant LIQ_THRESHOLD_BPS = 8_000;  // 80% of margin lost
    uint256 public constant LIQ_BONUS_BPS = 500;        // 5% bonus to liquidator
    uint8   public constant LEVERAGE_LOW = 2;
    uint8   public constant LEVERAGE_HIGH = 5;

    // ─────────────────────────────────────────────
    // Enums — slot order MUST match original (0,1,2)
    // ─────────────────────────────────────────────

    enum Market    { GAS, LIQUIDATIONS, STABLECOIN_NETFLOWS }
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

    /// @dev New fields (leverage, liquidationPrice) appended at end — safe for upgrade
    struct Position {
        address trader;
        Market market;
        Direction direction;
        uint256 collateral;
        uint256 size;           // collateral * leverage
        uint256 entryPrice;
        uint256 openedAt;
        uint256 cftMinted;
        bool open;
        uint8 leverage;
        uint256 liquidationPrice;
    }

    // ─────────────────────────────────────────────
    // Storage — original slots preserved in order
    // ─────────────────────────────────────────────

    address public feeRecipient;
    mapping(Market => MarketState) public markets;
    mapping(uint256 => Position) public positions;
    mapping(address => uint256[]) public userPositions;
    mapping(address => bool) public isKeeper;
    uint256 public positionCount;
    uint256 public totalFeesCollected;

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
    event PositionClosed(uint256 indexed id, address indexed trader, int256 pnl, uint256 payout);
    event PositionLiquidated(uint256 indexed id, address indexed trader, address indexed liquidator, uint256 bonus);
    event KeeperUpdated(address indexed keeper, bool status);
    event FeeRecipientUpdated(address indexed newRecipient);

    // ─────────────────────────────────────────────
    // Modifiers
    // ─────────────────────────────────────────────

    modifier onlyKeeper() {
        require(isKeeper[msg.sender], "ChainFlux: not keeper");
        _;
    }

    modifier validLeverage(uint8 leverage) {
        require(leverage == LEVERAGE_LOW || leverage == LEVERAGE_HIGH, "ChainFlux: leverage must be 2 or 5");
        _;
    }

    modifier freshPrice(Market market) {
        require(
            block.timestamp - markets[market].updatedAt <= PRICE_STALENESS,
            "ChainFlux: price stale"
        );
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
    // Initializer (proxy only — never called again)
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
    // Keeper — price feed
    // ─────────────────────────────────────────────

    /// @notice Push smoothed prices for all 3 markets
    /// @param prices [GAS, LIQUIDATIONS, STABLECOIN_NETFLOWS] — all scaled to 1e18
    function pushPrices(uint256[3] calldata prices) external onlyKeeper {
        _setPrice(Market.GAS,                   prices[0]);
        _setPrice(Market.LIQUIDATIONS,           prices[1]);
        _setPrice(Market.STABLECOIN_NETFLOWS,    prices[2]);
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

    /// @notice Open a leveraged position
    /// @param marketId  0=GAS, 1=LIQUIDATIONS, 2=STABLECOIN_NETFLOWS
    /// @param dirId     0=LONG, 1=SHORT
    /// @param leverage  2 or 5
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

        Market    market    = Market(marketId);
        Direction direction = Direction(dirId);

        require(markets[market].price > 0, "ChainFlux: no price feed");
        require(
            block.timestamp - markets[market].updatedAt <= PRICE_STALENESS,
            "ChainFlux: price stale"
        );

        uint256 fee        = (msg.value * FEE_BPS) / BPS_DENOM;
        uint256 collateral = msg.value - fee;
        uint256 size       = collateral * leverage;

        totalFeesCollected += fee;
        (bool feeOk,) = feeRecipient.call{value: fee}("");
        require(feeOk, "ChainFlux: fee transfer failed");

        uint256 entryPrice      = markets[market].price;
        uint256 liquidationPrice = _computeLiqPrice(entryPrice, leverage, direction);

        uint256 cftAmount = (collateral * PRICE_PRECISION) / entryPrice;
        _mint(msg.sender, cftAmount);

        if (direction == Direction.LONG) {
            markets[market].longOI  += collateral;
        } else {
            markets[market].shortOI += collateral;
        }

        uint256 id = positionCount++;
        positions[id] = Position({
            trader:           msg.sender,
            market:           market,
            direction:        direction,
            collateral:       collateral,
            size:             size,
            entryPrice:       entryPrice,
            openedAt:         block.timestamp,
            cftMinted:        cftAmount,
            open:             true,
            leverage:         leverage,
            liquidationPrice: liquidationPrice
        });

        userPositions[msg.sender].push(id);

        emit PositionOpened(id, msg.sender, market, direction, collateral, leverage, liquidationPrice, cftAmount);
    }

    /// @notice Close your own position
    function closePosition(uint256 id) external nonReentrant {
        Position storage pos = positions[id];
        require(pos.open,               "ChainFlux: position not open");
        require(pos.trader == msg.sender, "ChainFlux: not your position");

        uint256 currentPrice = markets[pos.market].price;
        require(currentPrice > 0, "ChainFlux: no price feed");

        int256  pnl    = _calculatePnL(pos, currentPrice);
        uint256 payout = _resolvePayout(pos.collateral, pnl);

        _closePosition(id, pos, payout, pnl);
    }

    /// @notice Liquidate an underwater position — anyone can call, earns 5% bonus
    function liquidate(address trader, uint8 marketId) external nonReentrant {
        // Find the trader's open position for this market
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

        uint256 bonus = (pos.collateral * LIQ_BONUS_BPS) / BPS_DENOM;
        uint256 remaining = pos.collateral > bonus ? pos.collateral - bonus : 0;

        // Burn CFT, update OI
        _burn(pos.trader, pos.cftMinted);
        if (pos.direction == Direction.LONG) {
            markets[pos.market].longOI  -= pos.collateral;
        } else {
            markets[pos.market].shortOI -= pos.collateral;
        }

        pos.open = false;

        // Pay liquidator bonus
        if (bonus > 0 && address(this).balance >= bonus) {
            (bool ok,) = msg.sender.call{value: bonus}("");
            require(ok, "ChainFlux: bonus transfer failed");
        }

        // Remaining goes to fee recipient (protocol)
        if (remaining > 0 && address(this).balance >= remaining) {
            (bool ok2,) = feeRecipient.call{value: remaining}("");
            require(ok2, "ChainFlux: remaining transfer failed");
        }

        emit PositionLiquidated(posId, trader, msg.sender, bonus);
    }

    // ─────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────

    function _computeLiqPrice(
        uint256 entryPrice,
        uint8   leverage,
        Direction direction
    ) internal pure returns (uint256) {
        // 80% of margin lost = liquidation
        // For LONG:  liqPrice = entryPrice * (1 - 0.8/leverage)
        // For SHORT: liqPrice = entryPrice * (1 + 0.8/leverage)
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
        // Liquidate when loss >= 80% of collateral
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
        int256 pnl
    ) internal {
        _burn(pos.trader, pos.cftMinted);

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

        emit PositionClosed(id, msg.sender, pnl, payout);
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
        MarketState memory stablecoinNetflows
    ) {
        return (
            markets[Market.GAS],
            markets[Market.LIQUIDATIONS],
            markets[Market.STABLECOIN_NETFLOWS]
        );
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
