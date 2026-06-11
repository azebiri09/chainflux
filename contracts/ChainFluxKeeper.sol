// SPDX-License-Identifier: MIT
// ChainFluxKeeper V5 - Arbitrum Sepolia
// Address: 0xCB2E158022A7d741c01e73D56FAe5FB2e2cB38Ba
// Proxy: 0x615d3801019D33609Eed27EB39D40AB49fa44fAF

pragma solidity ^0.8.20;

interface IChainFlux {
    function pushPrices(uint256[3] calldata prices) external;
}

/// @title ChainFluxKeeper - Authorized price feed pusher for ChainFlux
/// @notice Pushes GAS, LIQUIDATIONS, and TXS_PER_BLOCK prices to the ChainFlux proxy every 15 seconds
/// @dev Keeper wallet 0xbfcB136f6e15511312557c613792839A666e0843 is authorized via isKeeper on the proxy
contract ChainFluxKeeper {

    address public immutable proxy;
    address public immutable keeper;

    event PricesPushed(uint256 gas, uint256 liquidations, uint256 txsPerBlock, uint256 timestamp);

    constructor(address _proxy, address _keeper) {
        proxy = _proxy;
        keeper = _keeper;
    }

    modifier onlyKeeper() {
        require(msg.sender == keeper, "not keeper");
        _;
    }

    /// @notice Push prices for GAS (slot 0), LIQUIDATIONS (slot 1), TXS_PER_BLOCK (slot 2)
    /// @dev Values scaled by 1e18. GAS in gwei * 1e18. TXS as count * 1e18.
    function pushPrices(uint256[3] calldata prices) external onlyKeeper {
        require(prices[0] > 0 && prices[1] > 0 && prices[2] > 0, "invalid prices");
        IChainFlux(proxy).pushPrices(prices);
        emit PricesPushed(prices[0], prices[1], prices[2], block.timestamp);
    }
}
