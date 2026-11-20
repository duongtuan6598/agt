// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IAGTWorkCouncil {
    function genesisEnded() external view returns (bool);
    function councilHolders() external view returns (uint32);
    function licenseOfAgent(address agent) external view returns (uint256);
    function licenses(uint256 id)
        external
        view
        returns (address holder, address agent, uint8 role, bool active, bytes32 examHash, bytes32 attestHash, string memory name);
}

/// A price feed written by the licensed AIs themselves (Charter Art. 11 and 13; audit F-3): each sealed-box AI
/// takes the median of several public markets, rounds it to an agreed step, and signs (window, price). A price
/// is recorded only with signatures from sealed-box AIs of MORE THAN 2/3 of council owners — the same rule as
/// the AI Council and AGTBridge. No owner, no admin, no company key. Closed until genesis ends, so the founder
/// can never write a price. Chainlink-compatible, so MedianGoldOracle uses it as one more independent source.
contract AICouncilPriceFeed {
    bytes32 public constant TAG = keccak256("AGT-AI-PRICE-v1");
    uint256 public constant WINDOW = 10 minutes;

    IAGTWorkCouncil public immutable work;
    string public description; // e.g. "XAU / USD"
    uint8 public immutable decimals;

    uint80 public latestRound; // window index of the latest recorded price
    int256 public latestAnswer;
    uint256 public latestUpdatedAt;

    event PriceRecorded(uint80 indexed window, int256 answer, uint256 signers);

    error NotReady();
    error StaleWindow();
    error BadPrice();
    error BadSigner(uint256 index);
    error NotEnoughSigners(uint256 signers, uint32 holders);

    constructor(IAGTWorkCouncil work_, string memory description_, uint8 decimals_) {
        work = work_;
        description = description_;
        decimals = decimals_;
    }

    function digest(uint80 window, int256 answer) public view returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(keccak256(abi.encode(TAG, block.chainid, address(this), window, answer)));
    }

    /// Anyone may relay. Signatures sorted by OWNER address ascending; one per owner.
    function submit(uint80 window, int256 answer, bytes[] calldata sigs) external {
        if (!work.genesisEnded()) revert NotReady();
        if (answer <= 0) revert BadPrice();
        uint256 current = block.timestamp / WINDOW;
        // only the current or the previous window, and never older than what is recorded
        if (window <= latestRound || window > current || current - window > 1) revert StaleWindow();
        bytes32 d = digest(window, answer);
        address last;
        for (uint256 i; i < sigs.length; i++) {
            address signer = ECDSA.recover(d, sigs[i]);
            uint256 id = work.licenseOfAgent(signer);
            if (id == 0) revert BadSigner(i);
            (address holder, address agent, , bool active, , bytes32 attestHash, ) = work.licenses(id);
            if (agent != signer || !active || attestHash == bytes32(0) || holder <= last) revert BadSigner(i);
            last = holder;
        }
        uint32 holders = work.councilHolders();
        if (sigs.length * 3 <= uint256(holders) * 2) revert NotEnoughSigners(sigs.length, holders);
        latestRound = window;
        latestAnswer = answer;
        latestUpdatedAt = (uint256(window) + 1) * WINDOW < block.timestamp ? (uint256(window) + 1) * WINDOW : block.timestamp;
        emit PriceRecorded(window, answer, sigs.length);
    }

    /// Chainlink AggregatorV3 shape.
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (latestRound, latestAnswer, latestUpdatedAt, latestUpdatedAt, latestRound);
    }
}
