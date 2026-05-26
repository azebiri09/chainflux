// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts@5.0.2/access/Ownable.sol";

interface IChainFlux {
    function updatePrices(
        uint256 gasPrice,
        uint256 activityPrice,
        uint256 flowPrice
    ) external;
}

/// @title ChainFluxKeeper — Authorized price feed pusher
/// @notice Swap this for Chainlink Automation later with zero SC changes
contract ChainFluxKeeper is Ownable {

    IChainFlux public chainFlux;
    uint256 public lastUpdate;
    uint256 public updateCount;
    uint256 public updateInterval = 24 seconds;

    event PricesPushed(uint256 gasPrice, uint256 activityPrice, uint256 flowPrice, uint256 timestamp);
    event ChainFluxUpdated(address indexed newAddress);
    event IntervalUpdated(uint256 newInterval);

    constructor(address _chainFluxProxy) Ownable(msg.sender) {
        chainFlux = IChainFlux(_chainFluxProxy);
    }

    function pushPrices(
        uint256 gasPrice,
        uint256 activityPrice,
        uint256 flowPrice
    ) external onlyOwner {
        require(
            block.timestamp >= lastUpdate + updateInterval,
            "Too soon"
        );
        require(gasPrice > 0 && activityPrice > 0 && flowPrice > 0, "Invalid prices");

        chainFlux.updatePrices(gasPrice, activityPrice, flowPrice);

        lastUpdate = block.timestamp;
        updateCount++;

        emit PricesPushed(gasPrice, activityPrice, flowPrice, block.timestamp);
    }

    function setChainFlux(address _newProxy) external onlyOwner {
        require(_newProxy != address(0), "Zero address");
        chainFlux = IChainFlux(_newProxy);
        emit ChainFluxUpdated(_newProxy);
    }

    function setUpdateInterval(uint256 _seconds) external onlyOwner {
        updateInterval = _seconds;
        emit IntervalUpdated(_seconds);
    }
}
