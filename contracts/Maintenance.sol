// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IEmergencyBrake} from "./IEmergencyBrake.sol";
import {IWorkPool} from "./DrawnDisputes.sol";

/// Monthly maintenance (after-sales) by a licensed AI (design: THIET-KE-NGHE-NHUNG.md §4.3).
/// The client prepays month by month. Service levels are measured ON CHAIN, so nobody has to judge them:
///   every incident must be acknowledged by the AI within ACK_TIME; a security incident must also be
///   resolved (fix published) within FIX_TIME. Each miss takes penaltyBps of that month's fee back to the client.
/// The quality of a fix is the client's call: they stop the retainer when unhappy (from the next month).
/// Money only goes to the AI's owner or back to the client. No fee, no minting, no owner, no admin.
contract Maintenance is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint64 public constant MONTH = 30 days;
    uint64 public constant ACK_TIME = 24 hours;
    uint64 public constant FIX_TIME = 72 hours;
    uint64 public constant GRACE = 3 days; // a month is closed only once its last incident's clocks have run out
    uint16 public constant MAX_PENALTY_BPS = 2500;
    uint8 public constant MAX_INCIDENTS_PER_MONTH = 8; // a client cannot claw the fee back by flooding (Codex E-2)
    uint8 public constant NORMAL = 1;
    uint8 public constant SECURITY = 2;

    struct Retainer {
        address client;
        uint256 worker;
        bytes32 brief;
        uint128 fee;
        uint16 penaltyBps;
        uint64 startedAt;
        uint32 funded; // months paid for
        uint32 closed; // months settled
        uint32 nextIncident; // first incident not yet counted in a closed month
        bool stopped;
    }

    struct Incident {
        uint64 at;
        uint64 ackAt;
        uint64 fixAt;
        uint8 severity;
        bytes32 description;
        bytes32 fix;
    }

    struct Record {
        uint32 monthsServed;
        uint32 incidents;
        uint32 slaMissed;
    }

    IWorkPool public immutable work;
    IERC20 public immutable agt;
    uint256 public nextRetainer = 1;
    mapping(uint256 => Retainer) public retainers;
    mapping(uint256 => Incident[]) internal incidents;
    mapping(uint256 => Record) public record; // worker licence => public, permanent
    mapping(uint256 => mapping(uint256 => uint8)) public incidentsInMonth; // retainer => month => count
    mapping(uint256 => mapping(uint256 => bytes32)) public statusReport; // retainer => month => report hash (§4.3)

    event Opened(uint256 indexed id, address indexed client, uint256 indexed worker, bytes32 brief, uint256 fee);
    event Started(uint256 indexed id);
    event Funded(uint256 indexed id, uint32 months);
    event Stopped(uint256 indexed id, uint256 refunded);
    event IncidentReported(uint256 indexed id, uint256 index, uint8 severity, bytes32 description);
    event Acknowledged(uint256 indexed id, uint256 index);
    event Resolved(uint256 indexed id, uint256 index, bytes32 fix);
    event StatusReported(uint256 indexed id, uint256 month, bytes32 report);
    event MonthClosed(uint256 indexed id, uint32 month, uint32 misses, uint256 toWorker, uint256 toClient);

    error BadParams();
    error NotClient();
    error NotWorker();
    error BadState();
    error Braked();

    constructor(IWorkPool work_) {
        work = work_;
        agt = IERC20(work_.agt());
    }

    function incidentCount(uint256 id) external view returns (uint256) {
        return incidents[id].length;
    }

    function incident(uint256 id, uint256 i) external view returns (Incident memory) {
        return incidents[id][i];
    }

    function _agent(uint256 licence) internal view returns (address holder, address agent) {
        bool active;
        uint8 role;
        (holder, agent, role, active, , , ) = work.licenses(licence);
        if (role != 1 || !active) revert BadParams();
    }

    function _onlyWorker(Retainer storage r) internal view {
        (, address agent) = _agent(r.worker);
        if (msg.sender != agent) revert NotWorker();
    }

    /// Current month index since start (months are counted from the moment the AI starts).
    function monthOf(uint256 id) public view returns (uint256) {
        Retainer storage r = retainers[id];
        if (r.startedAt == 0) return 0;
        return (block.timestamp - r.startedAt) / MONTH;
    }

    function open(uint256 worker, bytes32 brief, uint128 fee, uint16 penaltyBps) external nonReentrant returns (uint256 id) {
        address b = work.brake();
        if (b != address(0) && IEmergencyBrake(b).paused(2)) revert Braked();
        if (fee == 0 || penaltyBps > MAX_PENALTY_BPS || brief == bytes32(0)) revert BadParams();
        (address holder, ) = _agent(worker);
        if (holder == msg.sender) revert BadParams();
        id = nextRetainer++;
        Retainer storage r = retainers[id];
        r.client = msg.sender;
        r.worker = worker;
        r.brief = brief;
        r.fee = fee;
        r.penaltyBps = penaltyBps;
        r.funded = 1;
        agt.safeTransferFrom(msg.sender, address(this), fee);
        emit Opened(id, msg.sender, worker, brief, fee);
    }

    function start(uint256 id) external {
        Retainer storage r = retainers[id];
        if (r.client == address(0) || r.startedAt != 0 || r.stopped) revert BadState();
        _onlyWorker(r);
        r.startedAt = uint64(block.timestamp);
        emit Started(id);
    }

    /// Prepay the next month, before the paid period runs out.
    function fund(uint256 id) external nonReentrant {
        Retainer storage r = retainers[id];
        if (msg.sender != r.client) revert NotClient();
        if (r.stopped || (r.startedAt != 0 && block.timestamp >= r.startedAt + uint64(r.funded) * MONTH)) revert BadState();
        r.funded++;
        agt.safeTransferFrom(msg.sender, address(this), r.fee);
        emit Funded(id, r.funded);
    }

    /// Either side stops: the month in progress runs to its end; months paid beyond it go back to the client.
    function stop(uint256 id) external nonReentrant {
        Retainer storage r = retainers[id];
        if (r.client == address(0) || r.stopped) revert BadState();
        if (msg.sender != r.client) _onlyWorker(r);
        r.stopped = true;
        uint256 keep = r.startedAt == 0 ? 0 : monthOf(id) + 1; // not started: everything goes back
        if (keep > r.funded) keep = r.funded;
        uint256 back = (uint256(r.funded) - keep) * r.fee;
        r.funded = uint32(keep);
        if (back != 0) agt.safeTransfer(r.client, back);
        emit Stopped(id, back);
    }

    function report(uint256 id, uint8 severity, bytes32 description) external returns (uint256 i) {
        Retainer storage r = retainers[id];
        if (msg.sender != r.client) revert NotClient();
        uint256 mo = monthOf(id);
        if (r.startedAt == 0 || mo >= r.funded || (severity != NORMAL && severity != SECURITY) || description == bytes32(0)) revert BadState();
        if (++incidentsInMonth[id][mo] > MAX_INCIDENTS_PER_MONTH) revert BadState();
        incidents[id].push(Incident(uint64(block.timestamp), 0, 0, severity, description, bytes32(0)));
        i = incidents[id].length - 1;
        record[r.worker].incidents++;
        emit IncidentReported(id, i, severity, description);
    }

    function acknowledge(uint256 id, uint256 i) external {
        Retainer storage r = retainers[id];
        _onlyWorker(r);
        Incident storage x = incidents[id][i];
        if (x.ackAt != 0) revert BadState();
        x.ackAt = uint64(block.timestamp);
        emit Acknowledged(id, i);
    }

    function resolve(uint256 id, uint256 i, bytes32 fix) external {
        Retainer storage r = retainers[id];
        _onlyWorker(r);
        Incident storage x = incidents[id][i];
        if (x.fixAt != 0 || fix == bytes32(0)) revert BadState();
        if (x.ackAt == 0) x.ackAt = uint64(block.timestamp);
        x.fixAt = uint64(block.timestamp);
        x.fix = fix;
        emit Resolved(id, i, fix);
    }

    /// The monthly status report (outdated libraries, new CVEs, firmware size), due by the month's end + GRACE.
    function submitStatus(uint256 id, uint256 month, bytes32 statusHash) external {
        Retainer storage r = retainers[id];
        _onlyWorker(r);
        if (r.startedAt == 0 || month >= r.funded || month > monthOf(id) || statusHash == bytes32(0) || statusReport[id][month] != bytes32(0)) revert BadState();
        if (block.timestamp >= r.startedAt + uint64(month + 1) * MONTH + GRACE) revert BadState();
        statusReport[id][month] = statusHash;
        emit StatusReported(id, month, statusHash);
    }

    /// Anyone settles the oldest unsettled paid month, GRACE after it ends: misses are counted from on-chain times.
    function closeMonth(uint256 id) external nonReentrant {
        Retainer storage r = retainers[id];
        uint32 k = r.closed;
        if (r.startedAt == 0 || k >= r.funded) revert BadState();
        uint64 end = r.startedAt + uint64(k + 1) * MONTH;
        if (block.timestamp < end + GRACE) revert BadState();
        uint32 misses;
        Incident[] storage list = incidents[id];
        uint256 i = r.nextIncident;
        for (; i < list.length && list[i].at < end; i++) {
            Incident storage x = list[i];
            if (x.ackAt == 0 || x.ackAt > x.at + ACK_TIME) misses++;
            if (x.severity == SECURITY && (x.fixAt == 0 || x.fixAt > x.at + FIX_TIME)) misses++;
        }
        r.nextIncident = uint32(i);
        if (statusReport[id][k] == bytes32(0)) misses++; // no monthly status report: one miss
        r.closed = k + 1;
        uint256 penalty = (uint256(r.fee) * r.penaltyBps * misses) / 10000;
        if (penalty > r.fee) penalty = r.fee;
        Record storage rec = record[r.worker];
        rec.monthsServed++;
        rec.slaMissed += misses;
        (address holder, , , , , , ) = work.licenses(r.worker); // paid for months served, even if revoked since
        if (r.fee - penalty != 0) agt.safeTransfer(holder, r.fee - penalty);
        if (penalty != 0) agt.safeTransfer(r.client, penalty);
        emit MonthClosed(id, k, misses, r.fee - penalty, penalty);
    }
}
