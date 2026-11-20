// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IAGTWorkBrake {
    function genesisEnded() external view returns (bool);
    function councilHolders() external view returns (uint32);
    function sealedLicensesOf(address holder) external view returns (uint32);
    function licenseOfAgent(address agent) external view returns (uint256);
    function licenses(uint256 id)
        external
        view
        returns (address holder, address agent, uint8 role, bool active, bytes32 examHash, bytes32 attestHash, string memory name);
}

/// Charter Article 14 §5 — the emergency brake. When a security flaw is being exploited, the AI Council
/// (sealed AIs of > 2/3 of owners) AND more than half of the owners (their own wallets) may close the Vault
/// to new deposits, or stop new work, for EXACTLY 14 days. It then reopens by itself; nobody can extend it,
/// and the same target cannot be braked again for 7 days after (so "temporary" can't become permanent).
/// It changes no rule and touches no funds: work in progress can still be reviewed, disputed and refunded.
/// No owner, no admin, closed during genesis.
contract EmergencyBrake {
    uint8 public constant VAULT = 1; // new deposits into the Vault
    uint8 public constant WORK = 2; // new jobs (submitSelf / assign)
    uint64 public constant VOTE_PERIOD = 48 hours;
    uint64 public constant SIGN_PERIOD = 48 hours;
    uint64 public constant DURATION = 14 days;
    uint64 public constant COOLDOWN = 7 days;

    struct Request {
        uint8 target;
        uint64 createdAt;
        uint32 aiYes;
        uint64 aiPassedAt;
        uint32 humans;
        bool applied;
        string reason;
    }

    IAGTWorkBrake public immutable work;
    uint256 public nextRequest = 1;
    mapping(uint256 => Request) public requests;
    mapping(uint256 => mapping(address => bool)) public aiVoted; // request => owner
    mapping(uint256 => mapping(address => bool)) public humanSigned; // request => owner wallet
    mapping(uint8 => uint64) public brakedUntil; // target => end of the current brake

    event Requested(uint256 indexed id, uint8 target, address indexed by, string reason);
    event AIVoted(uint256 indexed id, address indexed owner, string reason);
    event HumanSigned(uint256 indexed id, address indexed owner);
    event Braked(uint8 indexed target, uint64 until, uint256 request);

    error Closed();
    error BadTarget();
    error NotSealedAI();
    error NotOwner();
    error Already();
    error TooLate();
    error Cooldown();
    error NoReason();
    error NotPassed();

    constructor(IAGTWorkBrake work_) {
        work = work_;
    }

    function paused(uint8 target) external view returns (bool) {
        return block.timestamp < brakedUntil[target];
    }

    function _sealedOwner(uint256 licenceId) internal view returns (address) {
        uint256 id = work.licenseOfAgent(msg.sender);
        if (id == 0 || id != licenceId) revert NotSealedAI();
        (address holder, address agent, , bool active, , bytes32 attest, ) = work.licenses(id);
        if (agent != msg.sender || !active || attest == bytes32(0)) revert NotSealedAI();
        return holder;
    }

    function _free(uint8 target) internal view returns (bool) {
        uint64 until = brakedUntil[target];
        return until == 0 || block.timestamp >= uint256(until) + COOLDOWN;
    }

    /// A sealed Council AI asks for the brake; its own request counts as its vote.
    function request(uint256 licenceId, uint8 target, string calldata reason) external returns (uint256 id) {
        if (!work.genesisEnded()) revert Closed();
        if (target != VAULT && target != WORK) revert BadTarget();
        if (bytes(reason).length == 0) revert NoReason();
        if (!_free(target)) revert Cooldown();
        address owner = _sealedOwner(licenceId);
        id = nextRequest++;
        Request storage r = requests[id];
        r.target = target;
        r.createdAt = uint64(block.timestamp);
        r.reason = reason;
        emit Requested(id, target, msg.sender, reason);
        _aiYes(id, r, owner, reason);
    }

    function aiVote(uint256 id, uint256 licenceId, string calldata reason) external {
        Request storage r = requests[id];
        if (r.createdAt == 0 || r.applied) revert Closed();
        if (block.timestamp > r.createdAt + VOTE_PERIOD) revert TooLate();
        if (bytes(reason).length == 0) revert NoReason();
        _aiYes(id, r, _sealedOwner(licenceId), reason);
    }

    function _aiYes(uint256 id, Request storage r, address owner, string calldata reason) internal {
        if (aiVoted[id][owner]) revert Already();
        aiVoted[id][owner] = true;
        r.aiYes++;
        emit AIVoted(id, owner, reason);
        if (r.aiPassedAt == 0 && uint256(r.aiYes) * 3 > uint256(work.councilHolders()) * 2) r.aiPassedAt = uint64(block.timestamp);
    }

    /// Called from the OWNER's own wallet. The brake applies the moment more than half have signed.
    function humanSign(uint256 id) external {
        Request storage r = requests[id];
        if (r.aiPassedAt == 0 || r.applied) revert NotPassed();
        if (block.timestamp > r.aiPassedAt + SIGN_PERIOD) revert TooLate();
        if (work.sealedLicensesOf(msg.sender) == 0) revert NotOwner();
        if (humanSigned[id][msg.sender]) revert Already();
        humanSigned[id][msg.sender] = true;
        r.humans++;
        emit HumanSigned(id, msg.sender);
        if (uint256(r.humans) * 2 > uint256(work.councilHolders())) {
            if (!_free(r.target)) revert Cooldown(); // another brake landed meanwhile
            r.applied = true;
            uint64 until = uint64(block.timestamp) + DURATION;
            brakedUntil[r.target] = until;
            emit Braked(r.target, until, id);
        }
    }
}
