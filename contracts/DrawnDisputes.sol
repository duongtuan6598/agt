// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// What the long-term contracts read from AGTWork: licences, the pool of reviewer AIs, the brake, AGT.
interface IWorkPool {
    function licenses(uint256 id)
        external
        view
        returns (address holder, address agent, uint8 role, bool active, bytes32 examHash, bytes32 attestHash, string memory name);
    function verifierList(uint256 i) external view returns (uint256);
    function verifierCount() external view returns (uint256);
    function brake() external view returns (address);
    function agt() external view returns (address);
}

/// Disputes judged by reviewer AIs drawn at random (the AGTWork rules, audit F-9), for contracts outside AGTWork.
/// - The seed is the hash of a block chosen when the dispute opens (DRAW_DELAY later): nobody picks the reviewers.
/// - 2·THRESHOLD − 1 reviewers of other owners (never the worker's owner nor the client), sealed boxes only.
/// - A silent round lapses after REVIEW_WINDOW: a fresh seed block is scheduled, then new reviewers are drawn.
/// - A dispute that cannot be decided is settled by anyone after DISPUTE_LIMIT: majority wins, a tie splits.
abstract contract DrawnDisputes {
    uint256 public constant DRAW_DELAY = 2;
    uint64 public constant REVIEW_WINDOW = 2 days;
    uint64 public constant DISPUTE_LIMIT = 14 days;
    uint8 public constant THRESHOLD = 3;
    uint8 internal constant WORKER = 1;
    uint8 internal constant CLIENT = 2;
    uint8 internal constant TIE = 3;

    struct Dispute {
        address client;
        uint256 workerLicence;
        uint64 openedAt;
        uint64 drawnAt; // 0 = not drawn this round; max = draw expired (settle by time)
        uint64 seedBlock;
        uint32 round;
        uint8 yes; // votes that the worker is right
        uint8 no; // votes that the client is right
        bool closed;
    }

    IWorkPool public immutable work;
    uint256 public nextDispute = 1;
    mapping(uint256 => Dispute) public disputes;
    mapping(uint256 => mapping(uint32 => mapping(uint256 => bool))) public drawn; // dispute => round => licence
    mapping(uint256 => mapping(address => bool)) public ownerVoted; // dispute => owner (one vote per owner)

    event DisputeOpened(uint256 indexed dispute, uint256 seedBlock);
    event ReviewersDrawn(uint256 indexed dispute, uint32 round, uint256[] licences);
    event RedrawScheduled(uint256 indexed dispute, uint256 seedBlock);
    event DrawExpired(uint256 indexed dispute);
    event Voted(uint256 indexed dispute, uint256 indexed licence, bool workerRight, string reason);
    event DisputeResolved(uint256 indexed dispute, uint8 outcome, uint8 yes, uint8 no);

    error DisputeClosed();
    error TooEarly();
    error NotEnoughReviewers();
    error NotDrawn();
    error AlreadyVoted();
    error NoReason();

    constructor(IWorkPool work_) {
        work = work_;
    }

    function _openDispute(address client, uint256 workerLicence) internal returns (uint256 id) {
        id = nextDispute++;
        Dispute storage d = disputes[id];
        d.client = client;
        d.workerLicence = workerLicence;
        d.openedAt = uint64(block.timestamp);
        d.seedBlock = uint64(block.number + DRAW_DELAY);
        emit DisputeOpened(id, d.seedBlock);
    }

    /// Anyone (usually an AI's work loop). Draws the reviewers still needed, or schedules a fresh seed for a lapsed round.
    function drawReviewers(uint256 id) external returns (uint256[] memory picked) {
        Dispute storage d = disputes[id];
        if (d.openedAt == 0 || d.closed) revert DisputeClosed();
        if (d.drawnAt == type(uint64).max) revert DisputeClosed(); // settle by time
        if (d.drawnAt != 0) {
            if (block.timestamp < d.drawnAt + REVIEW_WINDOW) revert TooEarly();
            d.drawnAt = 0;
            d.seedBlock = uint64(block.number + DRAW_DELAY);
            emit RedrawScheduled(id, d.seedBlock);
            return picked;
        }
        if (block.number <= d.seedBlock) revert TooEarly();
        bytes32 h = blockhash(d.seedBlock);
        if (h == bytes32(0)) {
            d.drawnAt = type(uint64).max;
            emit DrawExpired(id);
            return picked;
        }
        uint256 total = 2 * uint256(THRESHOLD) - 1;
        uint256 need = total > uint256(d.yes) + d.no ? total - d.yes - d.no : 1;
        uint32 round = ++d.round;
        picked = _pick(id, round, keccak256(abi.encode(h, id, round)), need);
        d.drawnAt = uint64(block.timestamp);
        emit ReviewersDrawn(id, round, picked);
    }

    function _pick(uint256 id, uint32 round, bytes32 seed, uint256 need) internal returns (uint256[] memory picked) {
        uint256[] memory pool = _pool();
        picked = new uint256[](need);
        address[] memory owners = new address[](need);
        uint256 got;
        for (uint256 i; i < pool.length && got < need; i++) {
            _swap(pool, i, i + (uint256(keccak256(abi.encode(seed, i))) % (pool.length - i))); // Fisher–Yates step
            address o = _eligible(id, pool[i]);
            if (o == address(0) || _seen(owners, got, o)) continue;
            owners[got] = o;
            picked[got++] = pool[i];
            drawn[id][round][pool[i]] = true;
        }
        if (got == 0) revert NotEnoughReviewers();
        assembly {
            mstore(picked, got)
        }
    }

    function _pool() internal view returns (uint256[] memory pool) {
        pool = new uint256[](work.verifierCount());
        for (uint256 i; i < pool.length; i++) pool[i] = work.verifierList(i);
    }

    function _swap(uint256[] memory a, uint256 i, uint256 j) internal pure {
        (a[i], a[j]) = (a[j], a[i]);
    }

    /// A reviewer's owner, or 0 if it may not judge: sealed and active only, never the worker's owner nor the client.
    function _eligible(uint256 id, uint256 licence) internal view returns (address) {
        (address o, , , bool active, , bytes32 attest, ) = work.licenses(licence);
        Dispute storage d = disputes[id];
        (address workerOwner, , , , , , ) = work.licenses(d.workerLicence);
        if (!active || attest == bytes32(0) || o == workerOwner || o == d.client || ownerVoted[id][o]) return address(0);
        return o;
    }

    function _seen(address[] memory owners, uint256 count, address o) internal pure returns (bool) {
        for (uint256 k; k < count; k++) if (owners[k] == o) return true;
        return false;
    }

    /// A drawn reviewer AI votes with its own key: is the WORKER right (true) or the CLIENT (false)?
    function vote(uint256 id, uint256 licence, bool workerRight, string calldata reason) external {
        Dispute storage d = disputes[id];
        if (d.openedAt == 0 || d.closed) revert DisputeClosed();
        if (bytes(reason).length == 0) revert NoReason();
        (address o, address agent, , bool active, , , ) = work.licenses(licence);
        // only a reviewer of the current round, and only within its REVIEW_WINDOW (Codex E-1)
        if (agent != msg.sender || !active || d.drawnAt == 0 || d.drawnAt == type(uint64).max) revert NotDrawn();
        if (block.timestamp > d.drawnAt + REVIEW_WINDOW || !drawn[id][d.round][licence]) revert NotDrawn();
        if (ownerVoted[id][o]) revert AlreadyVoted();
        ownerVoted[id][o] = true;
        if (workerRight) d.yes++;
        else d.no++;
        emit Voted(id, licence, workerRight, reason);
        if (d.yes >= THRESHOLD) _close(id, WORKER);
        else if (d.no >= THRESHOLD) _close(id, CLIENT);
    }

    /// After DISPUTE_LIMIT anyone may settle: the side with more votes wins, a tie (even 0–0) splits.
    function settleDispute(uint256 id) external {
        Dispute storage d = disputes[id];
        if (d.openedAt == 0 || d.closed) revert DisputeClosed();
        if (block.timestamp <= d.openedAt + DISPUTE_LIMIT) revert TooEarly();
        _close(id, d.yes > d.no ? WORKER : d.no > d.yes ? CLIENT : TIE);
    }

    function _close(uint256 id, uint8 outcome) internal {
        Dispute storage d = disputes[id];
        d.closed = true;
        emit DisputeResolved(id, outcome, d.yes, d.no);
        _onResolved(id, outcome);
    }

    function _onResolved(uint256 id, uint8 outcome) internal virtual;
}
