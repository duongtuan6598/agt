// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// Những gì cầu nối đọc từ Hội đồng AI (AGTWork) — không đọc gì khác, không có chủ.
interface IAGTWorkView {
    function genesisEnded() external view returns (bool);
    function activeHolders() external view returns (uint32);
    function licenseOfAgent(address agent) external view returns (uint256);
    function licenses(uint256 id)
        external
        view
        returns (address holder, address agent, uint8 role, bool active, bytes32 examHash, bytes32 attestHash, string memory name);
}

/// Cầu nối chặng 2 (Hiến chương Điều 11): AGT khoá ở đây trên BSC thì xuất hiện trên chuỗi AGT;
/// AGT đốt trên chuỗi AGT thì được mở khoá ở đây — CHỈ KHI có chữ ký của các AI có giấy phép
/// thuộc hơn 2/3 số chủ (1 chủ = 1 phiếu, giống Hội đồng).
/// Không có chủ, không có hàm quản trị, không đúc AGT: cầu chỉ giữ và trả lại đúng AGT đã khoá.
/// Chỉ mở khi giai đoạn khởi tạo đã kết thúc — để người sáng lập không bao giờ nắm được cầu.
contract AGTBridge is ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant RELEASE_TAG = keccak256("AGT-CHAIN-RELEASE-v1");

    IERC20 public immutable agt;
    IAGTWorkView public immutable work;

    uint256 public nextLock = 1;
    uint256 public totalLocked;
    mapping(uint256 => bool) public released; // số thứ tự rút trên chuỗi AGT => đã trả

    event Locked(uint256 indexed nonce, address indexed from, address indexed to, uint256 amount);
    event Released(uint256 indexed nonce, address indexed to, uint256 amount, uint256 signers);

    error NotReady();
    error BadAmount();
    error AlreadyReleased();
    error BadSigner(uint256 index);
    error NotEnoughSigners(uint256 signers, uint32 holders);

    constructor(IERC20 agt_, IAGTWorkView work_) {
        agt = agt_;
        work = work_;
    }

    /// Khoá AGT trên BSC; `to` là địa chỉ nhận trên chuỗi AGT (cùng dạng khoá secp256k1).
    function lock(address to, uint256 amount) external nonReentrant returns (uint256 nonce) {
        if (!work.genesisEnded()) revert NotReady();
        if (amount == 0 || to == address(0)) revert BadAmount();
        agt.safeTransferFrom(msg.sender, address(this), amount);
        nonce = nextLock++;
        totalLocked += amount;
        emit Locked(nonce, msg.sender, to, amount);
    }

    /// Thông điệp mà mỗi AI ký khi chứng nhận một lần rút trên chuỗi AGT.
    function releaseDigest(uint256 nonce, address to, uint256 amount) public view returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(RELEASE_TAG, block.chainid, address(this), nonce, to, amount))
        );
    }

    /// Ai cũng nộp được (thường là người rút); tiền luôn về đúng `to` đã được ký.
    /// Chữ ký phải xếp theo địa chỉ CHỦ tăng dần — mỗi chủ chỉ tính 1 lần.
    function release(uint256 nonce, address to, uint256 amount, bytes[] calldata sigs) external nonReentrant {
        if (!work.genesisEnded()) revert NotReady();
        if (released[nonce]) revert AlreadyReleased();
        if (amount == 0 || to == address(0)) revert BadAmount();
        bytes32 digest = releaseDigest(nonce, to, amount);
        address last;
        for (uint256 i; i < sigs.length; i++) {
            address signer = ECDSA.recover(digest, sigs[i]);
            uint256 id = work.licenseOfAgent(signer);
            if (id == 0) revert BadSigner(i);
            (address holder, address agent, , bool active, , bytes32 attestHash, ) = work.licenses(id);
            // Chỉ AI chạy trong hộp kín (có giấy chứng nhận) mới được ký đồng thuận — Điều 12.
            if (agent != signer || !active || attestHash == bytes32(0) || holder <= last) revert BadSigner(i);
            last = holder;
        }
        uint32 holders = work.activeHolders();
        if (sigs.length * 3 <= uint256(holders) * 2) revert NotEnoughSigners(sigs.length, holders);
        released[nonce] = true;
        totalLocked -= amount;
        agt.safeTransfer(to, amount);
        emit Released(nonce, to, amount, sigs.length);
    }
}
