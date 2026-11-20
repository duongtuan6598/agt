// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockFeed {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;

    constructor(uint8 d, int256 a) {
        decimals = d;
        answer = a;
        updatedAt = block.timestamp;
    }

    function set(int256 a) external {
        answer = a;
        updatedAt = block.timestamp;
    }

    function setUpdatedAt(uint256 t) external {
        updatedAt = t;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

contract MockToken is ERC20 {
    uint8 private _d;

    constructor(string memory n, uint8 d) ERC20(n, n) {
        _d = d;
    }

    function decimals() public view override returns (uint8) {
        return _d;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

/// Pyth stand-in for tests: settable prices, records update calls.
contract MockPyth {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }
    mapping(bytes32 => Price) public prices;
    uint256 public updates;
    uint256 public feesReceived;

    function set(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime) external {
        prices[id] = Price(price, conf, expo, publishTime);
    }

    function getPriceUnsafe(bytes32 id) external view returns (Price memory) {
        return prices[id];
    }

    function updatePriceFeeds(bytes[] calldata) external payable {
        updates++;
        feesReceived += msg.value;
    }

    function getUpdateFee(bytes[] calldata data) external pure returns (uint256) {
        return data.length;
    }
}
