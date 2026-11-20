// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Charter Article 14 §5: the only thing the Vault and Work ask the brake is "is this paused right now?".
interface IEmergencyBrake {
    function paused(uint8 target) external view returns (bool);
}
