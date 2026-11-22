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

    /// Limits on the work door, which mints AGT with no asset behind it (Claude + Codex, 22/11/2026;
    /// docs/decisions/2026-11-22-work-mint-cap.md). Constants: nobody, founder included, can raise them.
    /// - Lifetime: mintedByWork <= min(WORK_MAX, WORK_BOOT + mintedByVault / 19). This is an issuance limit by
    ///   counters, not proof of assets: beyond the bootstrap, work mints at most 1/19 of what the Vault minted, so
    ///   >= 95% of supply came through the Vault (the Vault's own rules decide what backs that).
    /// - Per UTC day, all trades together: <= min(DAY_MAX, DAY_BASE + mintedByVault / 3650).
    /// WORK_BOOT and DAY_BASE let AIs be paid from day one, before the Vault holds anything (the founder's
    /// "restaurant that just opened" rule); the shares tied to the Vault take over as real deposits come in.
    uint256 public constant WORK_BOOT = 100e18;
    uint256 public constant WORK_MAX = 1_000_000e18;
    uint256 public constant DAY_BASE = 1e18;
    uint256 public constant DAY_MAX = 100e18;

    /// Work minted per UTC day, and pay that is owed because a limit was reached. Owed pay is never lost: anyone may
    /// call claimWork(to) once there is room again; it always pays `to`'s own debt to `to`. While anything is owed, new
    /// work pay joins the queue too, so new work never gets in ahead of older debts; among owed holders, whoever is
    /// claimed first is paid first (Codex W-3: accepted, nobody's pay is lost). Pay beyond the lifetime limit is NOT
    /// owed (Codex W-2): the lifetime limit only grows, so every recorded debt can always be paid in the end.
    mapping(uint256 => uint256) public workMintedOnDay;
    mapping(address => uint256) public workOwed;
    uint256 public totalWorkOwed;

    event MintedByVault(address indexed to, uint256 amount);
    event MintedByWork(address indexed to, uint256 amount);
    event WorkPayOwed(address indexed to, uint256 amount);
    event WorkPayBeyondLimit(address indexed to, uint256 amount);

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

    /// Never reverts on a limit, so the work contract's settlement is never blocked: what does not fit is owed.
    function mintFromWork(address to, uint256 amount) external {
        if (msg.sender != work) revert NotWork();
        uint256 paid = totalWorkOwed > 0 ? 0 : _workMint(to, amount);
        uint256 rest = amount - paid;
        if (rest == 0) return;
        uint256 life = _lifeLimit();
        uint256 used = mintedByWork + totalWorkOwed;
        uint256 owe = _min(rest, life > used ? life - used : 0);
        if (owe > 0) {
            workOwed[to] += owe;
            totalWorkOwed += owe;
            emit WorkPayOwed(to, owe);
        }
        if (rest > owe) emit WorkPayBeyondLimit(to, rest - owe);
    }

    /// Pays owed work pay to `to`, as far as the limits allow today. Anyone may call it.
    function claimWork(address to) external returns (uint256 paid) {
        paid = _workMint(to, workOwed[to]);
        workOwed[to] -= paid;
        totalWorkOwed -= paid;
    }

    /// How much work pay can be minted right now under both limits.
    function workRoom() public view returns (uint256) {
        uint256 life = _lifeLimit();
        uint256 day = _min(DAY_MAX, DAY_BASE + mintedByVault / 3650);
        uint256 today = workMintedOnDay[block.timestamp / 1 days];
        return _min(life > mintedByWork ? life - mintedByWork : 0, day > today ? day - today : 0);
    }

    function _workMint(address to, uint256 amount) internal returns (uint256 paid) {
        paid = _min(amount, workRoom());
        if (paid == 0) return 0;
        mintedByWork += paid;
        workMintedOnDay[block.timestamp / 1 days] += paid;
        _mint(to, paid);
        emit MintedByWork(to, paid);
    }

    function _lifeLimit() private view returns (uint256) {
        return _min(WORK_MAX, WORK_BOOT + mintedByVault / 19);
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
