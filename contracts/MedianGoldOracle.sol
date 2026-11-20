// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPriceOracle} from "./IPriceOracle.sol";

interface IChainlinkFeed {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80);
}

interface IPyth {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }
    function getPriceUnsafe(bytes32 id) external view returns (Price memory);
    function updatePriceFeeds(bytes[] calldata updateData) external payable;
    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256);
}

/// Giá theo vàng từ NHIỀU nguồn độc lập (Hiến chương Điều 13, audit F-3): mỗi tài sản (và vàng) có danh sách
/// nguồn Chainlink/Pyth; lấy TRUNG VỊ các nguồn còn mới, cần ít nhất `minSources` nguồn, và các nguồn không được
/// lệch nhau quá `maxDeviationBps`. Thiếu nguồn hay lệch nhiều thì từ chối — Kho đóng còn hơn đúc sai.
/// Hội đồng (owner) chỉnh nguồn; freeze() khoá vĩnh viễn.
contract MedianGoldOracle is IPriceOracle, Ownable2Step {
    enum Kind { None, Chainlink, Pyth }

    struct Source {
        Kind kind;
        address at; // Chainlink feed, or the Pyth contract
        bytes32 id; // Pyth price id (unused for Chainlink)
        uint32 maxAge; // seconds
    }

    address public constant XAU = address(1);
    uint8 public minSources;
    uint16 public maxDeviationBps; // between the lowest and highest fresh source, relative to the median
    uint16 public maxConfBps; // Pyth confidence interval, relative to its price
    bool public frozen;
    mapping(address => Source[]) internal _sources;

    event SourcesSet(address indexed asset, uint256 count);
    event ParamsSet(uint8 minSources, uint16 maxDeviationBps, uint16 maxConfBps);
    event Frozen();

    error IsFrozen();
    error BadParams();
    error NotEnoughSources(address asset, uint256 fresh, uint8 needed);
    error SourcesDisagree(address asset, uint256 low, uint256 high);

    constructor(address owner_, uint8 minSources_, uint16 maxDeviationBps_, uint16 maxConfBps_) Ownable(owner_) {
        _setParams(minSources_, maxDeviationBps_, maxConfBps_);
    }

    function _setParams(uint8 m, uint16 d, uint16 c) internal {
        if (m < 2 || d == 0 || c == 0) revert BadParams(); // at least two independent sources, always
        minSources = m;
        maxDeviationBps = d;
        maxConfBps = c;
        emit ParamsSet(m, d, c);
    }

    function setParams(uint8 m, uint16 d, uint16 c) external onlyOwner {
        if (frozen) revert IsFrozen();
        _setParams(m, d, c);
    }

    /// asset: XAU = address(1), BNB = address(0), or a token.
    function setSources(address asset, Source[] calldata list) external onlyOwner {
        if (frozen) revert IsFrozen();
        delete _sources[asset];
        for (uint256 i; i < list.length; i++) {
            if (list[i].kind == Kind.None || list[i].at == address(0) || list[i].maxAge == 0) revert BadParams();
            _sources[asset].push(list[i]);
        }
        emit SourcesSet(asset, list.length);
    }

    function sources(address asset) external view returns (Source[] memory) {
        return _sources[asset];
    }

    function freeze() external onlyOwner {
        frozen = true;
        emit Frozen();
    }

    /// Anyone may push fresh Pyth prices (from Pyth's Hermes service) before depositing; they pay Pyth's fee.
    function updatePyth(address pyth, bytes[] calldata updateData) external payable {
        IPyth(pyth).updatePriceFeeds{value: msg.value}(updateData);
    }

    /// One source's price in USD with 18 decimals, or 0 if unusable (stale, non-positive, too uncertain, failing).
    function _read(Source memory s) internal view returns (uint256) {
        if (s.kind == Kind.Chainlink) {
            try IChainlinkFeed(s.at).latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
                if (answer <= 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > s.maxAge) return 0;
                uint8 dec = IChainlinkFeed(s.at).decimals();
                return dec <= 18 ? uint256(answer) * 10 ** (18 - dec) : uint256(answer) / 10 ** (dec - 18);
            } catch {
                return 0;
            }
        }
        try IPyth(s.at).getPriceUnsafe(s.id) returns (IPyth.Price memory p) {
            if (p.price <= 0 || p.publishTime > block.timestamp || block.timestamp - p.publishTime > s.maxAge) return 0;
            if (uint256(p.conf) * 10_000 > uint256(uint64(p.price)) * maxConfBps) return 0;
            int256 e = int256(p.expo) + 18;
            if (e < 0 || e > 36) return 0;
            return uint256(uint64(p.price)) * 10 ** uint256(e);
        } catch {
            return 0;
        }
    }

    /// Median USD price (18 decimals) of an asset over its fresh sources.
    function priceUSD(address asset) public view returns (uint256) {
        Source[] storage list = _sources[asset];
        uint256[] memory v = new uint256[](list.length);
        uint256 n;
        for (uint256 i; i < list.length; i++) {
            uint256 p = _read(list[i]);
            if (p > 0) v[n++] = p;
        }
        if (n < minSources) revert NotEnoughSources(asset, n, minSources);
        for (uint256 i = 1; i < n; i++) { // insertion sort (a handful of sources)
            uint256 x = v[i];
            uint256 j = i;
            while (j > 0 && v[j - 1] > x) { v[j] = v[j - 1]; j--; }
            v[j] = x;
        }
        uint256 median = n % 2 == 1 ? v[n / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
        if ((v[n - 1] - v[0]) * 10_000 > median * maxDeviationBps) revert SourcesDisagree(asset, v[0], v[n - 1]);
        return median;
    }

    function valueInAGT(address token, uint256 amount) external view returns (uint256) {
        uint256 p = priceUSD(token);
        uint256 x = priceUSD(XAU);
        uint8 td = token == address(0) ? 18 : IERC20Metadata(token).decimals();
        // amount (td decimals) × p / x → AGT with 18 decimals
        return (amount * p * (10 ** (18 - td))) / x;
    }
}
