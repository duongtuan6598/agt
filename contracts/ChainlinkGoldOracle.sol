// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPriceOracle} from "./IPriceOracle.sol";

interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// Giá tài sản theo vàng: (token/USD) ÷ (XAU/USD), lấy từ Chainlink.
/// Người vận hành gắn nguồn giá cho từng tài sản; freeze() khoá vĩnh viễn, không sửa được nữa.
contract ChainlinkGoldOracle is IPriceOracle, Ownable2Step {
    struct Feed {
        AggregatorV3Interface feed;
        uint32 maxAge; // giây; giá cũ hơn thì từ chối
    }

    Feed public xau;
    mapping(address => Feed) public feeds;
    bool public frozen;

    event FeedSet(address indexed token, address feed, uint32 maxAge);
    event Frozen();

    error IsFrozen();
    error NoFeed(address token);
    error BadPrice(address feed);
    error StalePrice(address feed);

    constructor(address owner_, address xauFeed, uint32 xauMaxAge) Ownable(owner_) {
        xau = Feed(AggregatorV3Interface(xauFeed), xauMaxAge);
    }

    function setFeed(address token, address feed, uint32 maxAge) external onlyOwner {
        if (frozen) revert IsFrozen();
        feeds[token] = Feed(AggregatorV3Interface(feed), maxAge);
        emit FeedSet(token, feed, maxAge);
    }

    function setXauFeed(address feed, uint32 maxAge) external onlyOwner {
        if (frozen) revert IsFrozen();
        xau = Feed(AggregatorV3Interface(feed), maxAge);
        emit FeedSet(address(1), feed, maxAge);
    }

    function freeze() external onlyOwner {
        frozen = true;
        emit Frozen();
    }

    function _read(Feed memory f) internal view returns (uint256 price, uint8 dec) {
        (, int256 answer,, uint256 updatedAt,) = f.feed.latestRoundData();
        if (answer <= 0) revert BadPrice(address(f.feed));
        if (block.timestamp - updatedAt > f.maxAge) revert StalePrice(address(f.feed));
        return (uint256(answer), f.feed.decimals());
    }

    function valueInAGT(address token, uint256 amount) external view returns (uint256) {
        Feed memory f = feeds[token];
        if (address(f.feed) == address(0)) revert NoFeed(token);
        (uint256 p, uint8 pd) = _read(f);
        (uint256 x, uint8 xd) = _read(xau);
        uint8 td = token == address(0) ? 18 : IERC20Metadata(token).decimals();
        // amount/10^td * p/10^pd / (x/10^xd) * 1e18
        uint256 usdValue18 = Math.mulDiv(amount, p * 1e18, 10 ** (uint256(td) + pd));
        return Math.mulDiv(usdValue18, 10 ** xd, x);
    }
}
