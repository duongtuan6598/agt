// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Quy đổi tài sản ra AGT (18 số lẻ), 1 AGT = 1 ounce vàng. token = address(0) nghĩa là BNB.
interface IPriceOracle {
    function valueInAGT(address token, uint256 amount) external view returns (uint256);
}
