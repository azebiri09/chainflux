// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable@5.0.2/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable@5.0.2/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable@5.0.2/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable@5.0.2/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable@5.0.2/token/ERC20/ERC20Upgradeable.sol";

/// @title ChainFlux — Trade the heartbeat of blockchain
/// @notice Perpetual trading on live Arbitrum blockchain activity
contract ChainFlux is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    ERC20Upgradeable
{
    uint256 public constant FEE_BPS = 30;
    uint256 public constant BPS_DENOM = 10_000;
    uint256 public constant MIN_POSITION = 0.001 ether;
    uint256 public constant PRICE_PRECISION = 1e18;

    enum Market { GAS, ACTIVITY, FLOW }
    enum Direction { LONG, SHORT }

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
    }

    address public feeRecipient;
    mapping(Market => MarketState) public markets;
    mapping(uint256 => Position) public positions;
    mapping(address => uint256[]) public userPositions;
    mapping(address => bool) public isKeeper;
    uint256 public positionCount;
    uint256 public totalFeesCollected;

    event PriceUpdated(Market indexed market, uint256 price, uint256 timestamp);
    event PositionOpened(uint256 indexed id, address indexed trader, Market market, Direction direction, uint256 collateral, uint256 cftMinted);
    event PositionClosed(uint256 indexed id, address indexed trader, int256 pnl, uint256 payout);
    event KeeperUpdated(address indexed keeper, bool status);
    event FeeRecipientUpdated(address indexed newRecipient);

    modifier onlyKeeper() {
        require(isKeeper[msg.sender], "ChainFlux: not keeper");
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

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

    function updatePrices(
        uint256 gasPrice,
        uint256 activityPrice,
        uint256 flowPrice
    ) external onlyKeeper {
        _setPrice(Market.GAS, gasPrice);
        _setPrice(Market.ACTIVITY, activityPrice);
        _setPrice(Market.FLOW, flowPrice);
    }

    function _setPrice(Market m, uint256 price) internal {
        require(price > 0, "Invalid price");
        markets[m].price = price;
        markets[m].updatedAt = block.timestamp;
        emit PriceUpdated(m, price, block.timestamp);
    }

    function openPosition(
        Market market,
        Direction direction
    ) external payable nonReentrant {
        require(msg.value >= MIN_POSITION, "Below minimum");
        require(markets[market].price > 0, "No price feed yet");

        uint256 fee = (msg.value * FEE_BPS) / BPS_DENOM;
        uint256 collateral = msg.value - fee;
        totalFeesCollected += fee;

        (bool feeOk,) = feeRecipient.call{value: fee}("");
        require(feeOk, "Fee transfer failed");

        uint256 cftAmount = (collateral * PRICE_PRECISION) / markets[market].price;
        _mint(msg.sender, cftAmount);

        if (direction == Direction.LONG) {
            markets[market].longOI += collateral;
        } else {
            markets[market].shortOI += collateral;
        }

        uint256 id = positionCount++;
        positions[id] = Position({
            trader: msg.sender,
            market: market,
            direction: direction,
            collateral: collateral,
            size: collateral,
            entryPrice: markets[market].price,
            openedAt: block.timestamp,
            cftMinted: cftAmount,
            open: true
        });

        userPositions[msg.sender].push(id);
        emit PositionOpened(id, msg.sender, market, direction, collateral, cftAmount);
    }

    function closePosition(uint256 id) external nonReentrant {
        Position storage pos = positions[id];
        require(pos.open, "Position not open");
        require(pos.trader == msg.sender, "Not your position");

        uint256 currentPrice = markets[pos.market].price;
        require(currentPrice > 0, "No price feed");

        int256 pnl = _calculatePnL(pos, currentPrice);

        uint256 payout;
        if (pnl >= 0) {
            payout = pos.collateral + uint256(pnl);
        } else {
            uint256 loss = uint256(-pnl);
            payout = loss >= pos.collateral ? 0 : pos.collateral - loss;
        }

        _burn(msg.sender, pos.cftMinted);

        if (pos.direction == Direction.LONG) {
            markets[pos.market].longOI -= pos.collateral;
        } else {
            markets[pos.market].shortOI -= pos.collateral;
        }

        pos.open = false;

        if (payout > 0) {
            require(address(this).balance >= payout, "Insufficient contract balance");
            (bool ok,) = msg.sender.call{value: payout}("");
            require(ok, "Payout failed");
        }

        emit PositionClosed(id, msg.sender, pnl, payout);
    }

    function _calculatePnL(
        Position storage pos,
        uint256 currentPrice
    ) internal view returns (int256) {
        int256 entryPrice = int256(pos.entryPrice);
        int256 current = int256(currentPrice);
        int256 size = int256(pos.size);

        if (pos.direction == Direction.LONG) {
            return (size * (current - entryPrice)) / entryPrice;
        } else {
            return (size * (entryPrice - current)) / entryPrice;
        }
    }

    function getPositionPnL(uint256 id) external view returns (int256) {
        Position storage pos = positions[id];
        require(pos.open, "Position not open");
        return _calculatePnL(pos, markets[pos.market].price);
    }

    function getMarket(Market m) external view returns (MarketState memory) {
        return markets[m];
    }

    function getPosition(uint256 id) external view returns (Position memory) {
        return positions[id];
    }

    function getUserPositions(address user) external view returns (uint256[] memory) {
        return userPositions[user];
    }

    function getSentiment(Market m) external view returns (uint256 longPct, uint256 shortPct) {
        uint256 total = markets[m].longOI + markets[m].shortOI;
        if (total == 0) return (50, 50);
        longPct = (markets[m].longOI * 100) / total;
        shortPct = 100 - longPct;
    }

    function getAllMarkets() external view returns (
        MarketState memory gas,
        MarketState memory activity,
        MarketState memory flow
    ) {
        return (markets[Market.GAS], markets[Market.ACTIVITY], markets[Market.FLOW]);
    }

    function setKeeper(address _keeper, bool status) external onlyOwner {
        isKeeper[_keeper] = status;
        emit KeeperUpdated(_keeper, status);
    }

    function setFeeRecipient(address _newRecipient) external onlyOwner {
        require(_newRecipient != address(0), "Zero address");
        feeRecipient = _newRecipient;
        emit FeeRecipientUpdated(_newRecipient);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    receive() external payable {}
}
