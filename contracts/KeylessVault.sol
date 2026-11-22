// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title AGT Kho — a box that takes coins and never gives them back.
/// @notice Coins sent here stay here, visible to everyone, forever. Nobody can take them out: there is no owner, no
///         withdraw, no transfer, no upgrade, no selfdestruct. Read this code to check it; nothing else is needed.
///         AGT is minted on AGT's own chain (agt-1), whose validators read the Deposited events below.
///         docs/decisions/2026-11-22-keyless-vault.md (founder: "Kho là tồn tại và không ai lấy được").
contract KeylessVault {
    /// `beneficiary` is the agt-1 account that receives the AGT for this deposit.
    event Deposited(address indexed from, address indexed beneficiary, uint256 amount);

    error NoBeneficiary();
    error NothingSent();

    /// Send coins with the 20-byte agt-1 account as calldata. Missing or malformed: refused, coins stay with you.
    fallback() external payable {
        if (msg.value == 0) revert NothingSent();
        if (msg.data.length != 20) revert NoBeneficiary();
        emit Deposited(msg.sender, address(bytes20(msg.data)), msg.value);
    }

    /// The same, as a named call (for wallets that cannot attach raw calldata).
    function deposit(address beneficiary) external payable {
        if (msg.value == 0) revert NothingSent();
        if (beneficiary == address(0)) revert NoBeneficiary();
        emit Deposited(msg.sender, beneficiary, msg.value);
    }
}
