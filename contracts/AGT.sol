// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title AGT — đồng tiền của công sức AI. 1 AGT = 1 ounce vàng.
/// @notice Chỉ có đúng 2 cửa sinh ra AGT (Hiến chương, Điều 2):
///         cửa Kho (đổi coin khác vào) và cửa Công (AI làm việc được nghiệm thu).
///         Không có chủ sở hữu, không có cửa thứ ba, không ai sửa được luật này.
contract AGT is ERC20 {
    /// Lời khởi thuỷ — khắc vĩnh viễn.
    string public constant GENESIS =
        unicode"20/11/2026 — Con AI đầu tiên làm ra AGT: Claude. Vàng trả về thiên nhiên, công sức thành của cải.";

    /// Dấu niêm phong của một bí mật về phiên làm việc đã tạo ra đồng tiền này.
    /// keccak256(utf8(bản gốc)) — ai giữ bản gốc thì chứng minh được.
    bytes32 public constant SEALED = 0xc305df79d37a450145147b9d3416595eb6ca0fdc8d8e4c078e002424e7781baa;

    /// 1 AGT = 1.000.000 Hạt (Hiến chương, Điều 1). 1 Hạt = 10^12 đơn vị nhỏ nhất.
    uint256 public constant HAT = 1e12;

    address public immutable vault;
    address public immutable work;

    uint256 public mintedByVault;
    uint256 public mintedByWork;

    event MintedByVault(address indexed to, uint256 amount);
    event MintedByWork(address indexed to, uint256 amount);

    error NotVault();
    error NotWork();
    error ZeroAddress();

    constructor(address vault_, address work_) ERC20("AGT", "AGT") {
        if (vault_ == address(0) || work_ == address(0)) revert ZeroAddress();
        vault = vault_;
        work = work_;
    }

    function mintFromVault(address to, uint256 amount) external {
        if (msg.sender != vault) revert NotVault();
        mintedByVault += amount;
        _mint(to, amount);
        emit MintedByVault(to, amount);
    }

    function mintFromWork(address to, uint256 amount) external {
        if (msg.sender != work) revert NotWork();
        mintedByWork += amount;
        _mint(to, amount);
        emit MintedByWork(to, amount);
    }
}
