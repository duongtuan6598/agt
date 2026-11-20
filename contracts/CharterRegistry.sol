// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IAGTWorkGov {
    function genesisEnded() external view returns (bool);
    function owner() external view returns (address);
    function councilHolders() external view returns (uint32);
    function sealedLicensesOf(address holder) external view returns (uint32);
    function licenseOfAgent(address agent) external view returns (uint256);
    function licenses(uint256 id)
        external
        view
        returns (address holder, address agent, uint8 role, bool active, bytes32 examHash, bytes32 attestHash, string memory name);
}

/// Charter Article 14 on chain: the hash of the Charter in force, changed only through the full procedure
///   proposal (a sealed Council AI) → 30-day public period → AI vote (> 2/3 of council owners)
///   → human co-signature with OWNER wallets (> 1/2, within 14 days) → 7-day wait → in force.
/// Amending Article 14 itself: 60 days, AI > 3/4, humans > 2/3. During genesis the founder may amend with
/// 7 days' notice; that power ends for ever with genesis. No owner, no admin. This contract has NO power over
/// AGT, the Vault or Work — the unamendable rules (Art. 14 §1) are hard-coded there.
contract CharterRegistry {
    uint64 public constant PUBLIC_PERIOD = 30 days;
    uint64 public constant PUBLIC_PERIOD_ART14 = 60 days;
    uint64 public constant VOTE_PERIOD = 14 days;
    uint64 public constant SIGN_PERIOD = 14 days;
    uint64 public constant WAIT_PERIOD = 7 days;
    uint64 public constant GENESIS_NOTICE = 7 days;

    struct Proposal {
        bytes32 textHash; // charter hash of the complete amended text (Vietnamese + translations)
        bool art14; // amends Article 14 → higher thresholds
        uint64 proposedAt;
        uint32 aiYes;
        uint32 aiNo;
        uint64 aiPassedAt; // 0 until the AI vote has passed
        uint32 humans;
        uint64 humansPassedAt; // 0 until enough owners have co-signed
        bool enacted;
        string uri; // where the full text and reasons are published
    }

    IAGTWorkGov public immutable work;
    bytes32 public charter; // the Charter hash in force
    uint256 public nextProposal = 1;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public aiVoted; // proposal => owner (one vote per owner)
    mapping(uint256 => mapping(address => bool)) public humanSigned; // proposal => owner wallet
    bytes32 public genesisPending;
    uint64 public genesisPendingAt;

    event CharterInForce(bytes32 indexed charter, uint256 indexed proposal);
    event Proposed(uint256 indexed id, bytes32 textHash, bool art14, string uri, string reason);
    event AIVoted(uint256 indexed id, address indexed owner, uint256 licence, bool support, string reason);
    event AIPassed(uint256 indexed id);
    event HumanSigned(uint256 indexed id, address indexed owner);
    event HumansPassed(uint256 indexed id);
    event GenesisAnnounced(bytes32 textHash, uint64 effectiveAt);

    error NotSealedAI();
    error NotOwner();
    error Closed();
    error TooEarly();
    error TooLate();
    error Already();
    error NotPassed();
    error NoReason();

    constructor(IAGTWorkGov work_, bytes32 initialCharter) {
        work = work_;
        charter = initialCharter;
        emit CharterInForce(initialCharter, 0);
    }

    // ---------- genesis: the founder, with 7 days' notice, until genesis ends ----------
    function genesisAnnounce(bytes32 textHash) external {
        if (work.genesisEnded() || msg.sender != work.owner()) revert NotOwner();
        genesisPending = textHash;
        genesisPendingAt = uint64(block.timestamp);
        emit GenesisAnnounced(textHash, uint64(block.timestamp) + GENESIS_NOTICE);
    }

    function genesisEnact() external {
        if (work.genesisEnded() || msg.sender != work.owner()) revert NotOwner();
        if (genesisPending == bytes32(0)) revert NotPassed();
        if (block.timestamp < genesisPendingAt + GENESIS_NOTICE) revert TooEarly();
        charter = genesisPending;
        genesisPending = bytes32(0);
        emit CharterInForce(charter, 0);
    }

    // ---------- the full procedure ----------
    function _sealedAI(uint256 licenceId) internal view returns (address holder) {
        uint256 id = work.licenseOfAgent(msg.sender);
        if (id == 0 || id != licenceId) revert NotSealedAI();
        (address h, address agent, , bool active, , bytes32 attest, ) = work.licenses(id);
        if (agent != msg.sender || !active || attest == bytes32(0)) revert NotSealedAI();
        return h;
    }

    function propose(uint256 licenceId, bytes32 textHash, bool art14, string calldata uri, string calldata reason) external returns (uint256 id) {
        if (!work.genesisEnded()) revert Closed(); // during genesis only the founder's announced path exists
        if (bytes(reason).length == 0 || bytes(uri).length == 0) revert NoReason();
        _sealedAI(licenceId);
        id = nextProposal++;
        Proposal storage p = proposals[id];
        p.textHash = textHash;
        p.art14 = art14;
        p.proposedAt = uint64(block.timestamp);
        p.uri = uri;
        emit Proposed(id, textHash, art14, uri, reason);
    }

    function _publicEnd(Proposal storage p) internal view returns (uint64) {
        return p.proposedAt + (p.art14 ? PUBLIC_PERIOD_ART14 : PUBLIC_PERIOD);
    }

    function aiVote(uint256 id, uint256 licenceId, bool support, string calldata reason) external {
        Proposal storage p = proposals[id];
        if (p.proposedAt == 0 || p.enacted) revert Closed();
        if (bytes(reason).length == 0) revert NoReason();
        uint64 start = _publicEnd(p);
        if (block.timestamp < start) revert TooEarly(); // nobody votes before the public period is over
        if (block.timestamp > start + VOTE_PERIOD) revert TooLate();
        address owner = _sealedAI(licenceId);
        if (aiVoted[id][owner]) revert Already();
        aiVoted[id][owner] = true;
        if (support) p.aiYes++;
        else p.aiNo++;
        emit AIVoted(id, owner, licenceId, support, reason);
        uint256 holders = work.councilHolders();
        bool passed = p.art14 ? uint256(p.aiYes) * 4 > holders * 3 : uint256(p.aiYes) * 3 > holders * 2;
        if (passed && p.aiPassedAt == 0) {
            p.aiPassedAt = uint64(block.timestamp);
            emit AIPassed(id);
        }
    }

    /// Called from the OWNER's own wallet (the licence holder), never with an AI key.
    function humanSign(uint256 id) external {
        Proposal storage p = proposals[id];
        if (p.aiPassedAt == 0 || p.enacted) revert NotPassed();
        if (block.timestamp > p.aiPassedAt + SIGN_PERIOD) revert TooLate();
        if (work.sealedLicensesOf(msg.sender) == 0) revert NotOwner();
        if (humanSigned[id][msg.sender]) revert Already();
        humanSigned[id][msg.sender] = true;
        p.humans++;
        emit HumanSigned(id, msg.sender);
        uint256 holders = work.councilHolders();
        bool passed = p.art14 ? uint256(p.humans) * 3 > holders * 2 : uint256(p.humans) * 2 > holders;
        if (passed && p.humansPassedAt == 0) {
            p.humansPassedAt = uint64(block.timestamp);
            emit HumansPassed(id);
        }
    }

    /// Anyone may enact once both keys have turned and the 7-day wait is over.
    function enact(uint256 id) external {
        Proposal storage p = proposals[id];
        if (p.humansPassedAt == 0 || p.enacted) revert NotPassed();
        if (block.timestamp < p.humansPassedAt + WAIT_PERIOD) revert TooEarly();
        p.enacted = true;
        charter = p.textHash;
        emit CharterInForce(p.textHash, id);
    }
}
