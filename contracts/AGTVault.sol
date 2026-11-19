// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPriceOracle} from "./IPriceOracle.sol";

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

    mapping(address => bool) public accepted; // address(0) = BNB
    mapping(address => uint256) public reserve; // tổng lượng đã vào kho theo từng tài sản
    address[] public assets;

    event Bound(address agt);
    event OracleSet(address oracle);
    event AssetSet(address indexed token, bool accepted);
    event Frozen();
    event Deposited(address indexed from, address indexed beneficiary, address indexed token, uint256 amount, uint256 agtMinted);

    error AlreadyBound();
    error WrongAgt();
    error IsFrozen();
    error NotAccepted(address token);
    error ZeroValue();
    error DirectBnb();

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
        minted = oracle.valueInAGT(token, amount);
        if (minted == 0) revert ZeroValue();
        reserve[token] += amount;
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
