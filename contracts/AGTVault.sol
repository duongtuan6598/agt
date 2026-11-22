// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPriceOracle} from "./IPriceOracle.sol";
import {IEmergencyBrake} from "./IEmergencyBrake.sol";

interface IAGTMint {
    function vault() external view returns (address);
    function mintFromVault(address to, uint256 amount) external;
}

/// @title Kho AGT — Hiến chương Điều 3.
/// @notice Coin vào Kho là ở lại vĩnh viễn: hợp đồng này KHÔNG có hàm rút, không có cách nào
///         chuyển tài sản ra, kể cả người vận hành. Người vận hành chỉ được chọn tài sản nhận
///         và nguồn giá; freeze() khoá luôn hai việc đó.
contract AGTVault is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IAGTMint public agt;
    IPriceOracle public oracle;
    bool public frozen;
    /// Phanh khẩn cấp (Hiến chương Điều 14 khoản 5) — gắn đúng một lần, không ai gỡ hay đổi được.
    IEmergencyBrake public brake;

    mapping(address => bool) public accepted; // address(0) = BNB
    mapping(address => uint256) public reserve; // tổng lượng đã vào kho theo từng tài sản
    address[] public assets;

    /// Custodial assets (Claude + Codex, 22/11/2026; docs/decisions/2026-11-22-custodial-assets.md): a token that is a
    /// claim on something held off-chain by someone (tokenized gold held by a custodian or a nation, a fiat
    /// stablecoin). AGT must not depend on any one of them, so after every deposit:
    /// - one custodial token <= 5% of all AGT the Vault minted, and
    /// - one custodian group (all tokens controlled by the same party) <= 10%.
    /// Measured in AGT minted at deposit time (no price oracle needed to enforce it). Constants: nobody raises them.
    /// With a small Vault little custodial value fits; the room grows with the Vault (no waiting, no exception).
    /// Marking an asset custodial only ever makes the rules stricter, so it is one-way and allowed even when frozen.
    /// The Vault is one-way: AGT never promises redemption in gold, and depositors get no rights or votes.
    uint256 public constant TOKEN_BPS = 500;
    uint256 public constant GROUP_BPS = 1000;
    uint256 public mintedTotal;
    mapping(address => uint256) public mintedFor;
    mapping(address => uint256) public custodianOf; // 0 = not custodial
    mapping(uint256 => uint256) public mintedForGroup;

    event Bound(address agt);
    event OracleSet(address oracle);
    event AssetSet(address indexed token, bool accepted);
    event Frozen();
    event CustodialSet(address indexed token, uint256 indexed group);
    /// Emitted when an asset is marked custodial after deposits that already exceed a limit (Codex V-1): those
    /// deposits stay (the Vault is one-way), and every further deposit of that token or group is refused.
    event OverLimitWhenMarked(address indexed token, uint256 indexed group);
    event BrakeSet(address brake);
    event Deposited(address indexed from, address indexed beneficiary, address indexed token, uint256 amount, uint256 agtMinted);

    error AlreadyBound();
    error WrongAgt();
    error IsFrozen();
    error NotAccepted(address token);
    error ZeroValue();
    error DirectBnb();
    error Braked();
    error AlreadyCustodial();
    error BadGroup();
    error Concentrated(address token);

    constructor(address owner_, address oracle_) Ownable(owner_) {
        oracle = IPriceOracle(oracle_);
    }

    /// Gắn AGT đúng một lần; AGT phải trỏ ngược về kho này.
    function bind(address agt_) external onlyOwner {
        if (address(agt) != address(0)) revert AlreadyBound();
        if (IAGTMint(agt_).vault() != address(this)) revert WrongAgt();
        agt = IAGTMint(agt_);
        emit Bound(agt_);
    }

    function setOracle(address oracle_) external onlyOwner {
        if (frozen) revert IsFrozen();
        oracle = IPriceOracle(oracle_);
        emit OracleSet(oracle_);
    }

    function setAsset(address token, bool ok) external onlyOwner {
        if (frozen) revert IsFrozen();
        if (ok && !_known(token)) assets.push(token);
        accepted[token] = ok;
        emit AssetSet(token, ok);
    }

    /// Gắn phanh khẩn cấp đúng một lần. Phanh chỉ chặn tiền MỚI vào Kho, tối đa 14 ngày, tự mở.
    /// Marks `token` custodial, in custodian group `group` (> 0). One-way; past deposits count toward the group.
    function setCustodial(address token, uint256 group) external onlyOwner {
        if (custodianOf[token] != 0) revert AlreadyCustodial();
        if (group == 0) revert BadGroup();
        custodianOf[token] = group;
        mintedForGroup[group] += mintedFor[token];
        emit CustodialSet(token, group);
        if (mintedFor[token] * 10000 > mintedTotal * TOKEN_BPS || mintedForGroup[group] * 10000 > mintedTotal * GROUP_BPS)
            emit OverLimitWhenMarked(token, group);
    }

    function setBrake(address brake_) external onlyOwner {
        if (address(brake) != address(0)) revert AlreadyBound();
        brake = IEmergencyBrake(brake_);
        emit BrakeSet(brake_);
    }

    function freeze() external onlyOwner {
        frozen = true;
        emit Frozen();
    }

    /// Đổi token ERC20 vào kho, AGT phát cho beneficiary.
    function deposit(address token, uint256 amount, address beneficiary) external nonReentrant returns (uint256 minted) {
        if (token == address(0) || !accepted[token]) revert NotAccepted(token);
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        minted = _mint(token, received, beneficiary);
    }

    /// Đổi BNB vào kho.
    function depositBNB(address beneficiary) external payable nonReentrant returns (uint256 minted) {
        if (!accepted[address(0)]) revert NotAccepted(address(0));
        minted = _mint(address(0), msg.value, beneficiary);
    }

    function _mint(address token, uint256 amount, address beneficiary) internal returns (uint256 minted) {
        if (address(brake) != address(0) && brake.paused(1)) revert Braked();
        minted = oracle.valueInAGT(token, amount);
        if (minted == 0) revert ZeroValue();
        reserve[token] += amount;
        mintedTotal += minted;
        mintedFor[token] += minted;
        uint256 g = custodianOf[token];
        if (g != 0) {
            mintedForGroup[g] += minted;
            if (mintedFor[token] * 10000 > mintedTotal * TOKEN_BPS || mintedForGroup[g] * 10000 > mintedTotal * GROUP_BPS)
                revert Concentrated(token);
        }
        agt.mintFromVault(beneficiary, minted);
        emit Deposited(msg.sender, beneficiary, token, amount, minted);
    }

    function assetCount() external view returns (uint256) {
        return assets.length;
    }

    function _known(address token) internal view returns (bool) {
        for (uint256 i; i < assets.length; i++) if (assets[i] == token) return true;
        return false;
    }

    receive() external payable {
        revert DirectBnb();
    }
}
