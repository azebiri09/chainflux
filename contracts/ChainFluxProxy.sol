// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts@5.0.2/proxy/ERC1967/ERC1967Proxy.sol";

/// @title ChainFluxProxy — Permanent address for CHAINFLUX
/// @notice All users, frontend, and keeper interact with this address forever
contract ChainFluxProxy is ERC1967Proxy {
    constructor(
        address logic,
        bytes memory data
    ) ERC1967Proxy(logic, data) {}
}
