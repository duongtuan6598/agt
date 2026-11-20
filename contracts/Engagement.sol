// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IEmergencyBrake} from "./IEmergencyBrake.sol";
import {DrawnDisputes, IWorkPool} from "./DrawnDisputes.sol";

/// Long-term work for a licensed AI (design: THIET-KE-NGHE-NHUNG.md) — a project in milestones:
///   open (client locks every milestone) → start (the AI accepts) → deliver → revise (≤ 2) / accept / dispute
///   → hardware test by the CLIENT (N5) for milestones that need it → done → warranty (holdback) → release.
/// Money only ever goes to the AI's owner or back to the client. No fee, no minting, no owner, no admin.
/// A milestone needing a hardware test is NEVER paid in full on simulation alone (Codex C-4): its hardware part
/// is paid on the client's confirmation, or after HW_SILENCE with no hardware failure ever reported.
contract Engagement is DrawnDisputes, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint64 public constant REVIEW = 7 days; // client's time to accept / ask a revision / dispute a delivery
    uint64 public constant HW_SILENCE = 28 days; // hardware part paid if the client stays silent this long
    uint64 public constant REVISION_TIME = 14 days; // the AI's time to redeliver after a revision request
    uint64 public constant FIX_TIME = 14 days; // the AI's time to fix a warranty claim
    uint8 public constant MAX_REVISIONS = 2;
    uint8 public constant MAX_MILESTONES = 20;
    uint16 public constant MAX_HOLDBACK_BPS = 5000;
    uint32 public constant MAX_WARRANTY_DAYS = 365;

    enum M { None, Pending, Delivered, HwTesting, Done, Disputed, Refunded }
    enum Kind { None, Delivery, Hardware, Warranty }

    struct Milestone {
        uint128 amount; // escrow for this milestone
        uint128 held; // holdback kept for the warranty
        uint16 hwBps; // part of `amount` that needs the client's hardware test (0 = none)
        uint8 revisions;
        M state;
        bool simPaid; // the simulation part has been paid
        bool hwFailLogged; // the client has ever reported a hardware failure
        uint32 dueDays; // days to deliver, counted from start (or from a revision request)
        uint64 dueAt;
        uint64 deliveredAt;
        uint64 hwStart;
        uint64 warrantyEnd;
        bytes32 result; // hash of the delivered work (commit / archive)
        bytes32 report; // hash of the N1–N4 report produced in the sealed box
        // warranty claim
        uint64 claimAt;
        uint64 fixAt;
        bytes32 claim;
        bytes32 fix;
        // open dispute
        uint256 dispute;
        Kind disputeKind;
    }

    struct Eng {
        address client;
        uint256 worker; // licence of the AI worker
        bytes32 brief; // hash of the agreed brief (agt-brief): the contract the work is judged against
        uint16 holdbackBps;
        uint32 warrantyDays;
        uint64 startedAt;
        bool ended;
        uint8 count;
    }

    struct Reputation {
        uint32 engagements;
        uint32 milestonesDone;
        uint32 revisions;
        uint32 late;
        uint32 disputesWon;
        uint32 disputesLost;
        uint32 warrantyClaims;
        uint32 warrantyFailed;
    }

    IERC20 public immutable agt;
    uint256 public nextEngagement = 1;
    mapping(uint256 => Eng) public engagements;
    mapping(uint256 => mapping(uint8 => Milestone)) internal milestones;
    mapping(uint256 => Reputation) public reputation; // worker licence => public, permanent record
    mapping(uint256 => uint256) public disputeEngagement;
    mapping(uint256 => uint8) public disputeMilestone;

    event Opened(uint256 indexed id, address indexed client, uint256 indexed worker, bytes32 brief, uint256 total);
    event Started(uint256 indexed id);
    event Cancelled(uint256 indexed id);
    event Delivered(uint256 indexed id, uint8 m, bytes32 result, bytes32 report);
    event RevisionRequested(uint256 indexed id, uint8 m, bytes32 reason);
    event Paid(uint256 indexed id, uint8 m, uint256 toWorker, uint256 held);
    event Refunded(uint256 indexed id, uint8 m, uint256 toClient);
    event HardwareFailure(uint256 indexed id, uint8 m, bytes32 log);
    event MilestoneDone(uint256 indexed id, uint8 m, uint64 warrantyEnd);
    event WarrantyClaimed(uint256 indexed id, uint8 m, bytes32 evidence);
    event WarrantyFixed(uint256 indexed id, uint8 m, bytes32 fix);
    event WarrantyClosed(uint256 indexed id, uint8 m, bool refunded);
    event HoldbackReleased(uint256 indexed id, uint8 m, uint256 amount);
    event Ended(uint256 indexed id);
    event DisputeOn(uint256 indexed id, uint8 m, uint256 dispute, Kind kind);

    error BadParams();
    error NotClient();
    error NotWorker();
    error BadState();
    error Braked();

    constructor(IWorkPool work_) DrawnDisputes(work_) {
        agt = IERC20(work_.agt());
    }

    function milestone(uint256 id, uint8 m) external view returns (Milestone memory) {
        return milestones[id][m];
    }

    // ---------- helpers ----------
    function _worker(uint256 licence) internal view returns (address holder, address agent) {
        bool active;
        uint8 role;
        (holder, agent, role, active, , , ) = work.licenses(licence);
        if (role != 1 || !active) revert BadParams();
    }

    function _onlyWorker(Eng storage e) internal view returns (address holder) {
        address agent;
        (holder, agent) = _worker(e.worker);
        if (msg.sender != agent) revert NotWorker();
    }

    function _ms(uint256 id, uint8 m) internal view returns (Eng storage e, Milestone storage x) {
        e = engagements[id];
        if (e.client == address(0) || m >= e.count) revert BadParams();
        x = milestones[id][m];
    }

    function _pay(uint256 id, uint8 m, Eng storage e, Milestone storage x, uint256 amount) internal {
        uint256 hold = (amount * e.holdbackBps) / 10000;
        x.held += uint128(hold);
        (address holder, , , , , , ) = work.licenses(e.worker);
        if (amount - hold != 0) agt.safeTransfer(holder, amount - hold);
        emit Paid(id, m, amount - hold, hold);
    }

    function _refund(uint256 id, uint8 m, Eng storage e, uint256 amount) internal {
        if (amount != 0) agt.safeTransfer(e.client, amount);
        emit Refunded(id, m, amount);
    }

    /// A milestone that ends refunded also returns any holdback kept from its simulation payment.
    function _refundRest(uint256 id, uint8 m, Eng storage e, Milestone storage x, uint256 escrowLeft) internal {
        uint256 h = x.held;
        x.held = 0;
        x.state = M.Refunded;
        _refund(id, m, e, escrowLeft + h);
    }

    function _simPart(Milestone storage x) internal view returns (uint256) {
        return x.amount - _hwPart(x);
    }

    function _hwPart(Milestone storage x) internal view returns (uint256) {
        return (uint256(x.amount) * x.hwBps) / 10000;
    }

    // ---------- opening ----------
    /// The client locks every milestone up front. dueDays are counted from the moment the AI starts.
    struct Plan {
        uint128[] amounts; // escrow per milestone
        uint16[] hwBps; // part of each milestone that needs the client's hardware test
        uint32[] dueDays; // days to deliver each milestone, from start
        uint16 holdbackBps; // kept from every payment until the warranty ends
        uint32 warrantyDays;
    }

    function open(uint256 worker, bytes32 brief, Plan calldata plan) external nonReentrant returns (uint256 id) {
        address b = work.brake();
        if (b != address(0) && IEmergencyBrake(b).paused(2)) revert Braked();
        uint256 n = plan.amounts.length;
        if (n == 0 || n > MAX_MILESTONES || plan.hwBps.length != n || plan.dueDays.length != n) revert BadParams();
        if (plan.holdbackBps > MAX_HOLDBACK_BPS || plan.warrantyDays > MAX_WARRANTY_DAYS || brief == bytes32(0)) revert BadParams();
        (address holder, ) = _worker(worker);
        if (holder == msg.sender) revert BadParams(); // no self-dealing
        id = nextEngagement++;
        Eng storage e = engagements[id];
        e.client = msg.sender;
        e.worker = worker;
        e.brief = brief;
        e.holdbackBps = plan.holdbackBps;
        e.warrantyDays = plan.warrantyDays;
        e.count = uint8(n);
        uint256 total = _plan(id, plan);
        agt.safeTransferFrom(msg.sender, address(this), total);
        emit Opened(id, msg.sender, worker, brief, total);
    }

    function _plan(uint256 id, Plan calldata p) internal returns (uint256 total) {
        for (uint8 i; i < p.amounts.length; i++) {
            if (p.amounts[i] == 0 || p.hwBps[i] > 10000 || p.dueDays[i] == 0 || p.dueDays[i] > 365) revert BadParams();
            Milestone storage x = milestones[id][i];
            x.amount = p.amounts[i];
            x.hwBps = p.hwBps[i];
            x.dueDays = p.dueDays[i];
            x.state = M.Pending;
            total += p.amounts[i];
        }
    }

    /// The AI accepts the engagement with its own key; the delivery clocks start now.
    function start(uint256 id) external {
        Eng storage e = engagements[id];
        if (e.client == address(0) || e.startedAt != 0 || e.ended) revert BadState();
        _onlyWorker(e);
        e.startedAt = uint64(block.timestamp);
        for (uint8 i; i < e.count; i++) milestones[id][i].dueAt = uint64(block.timestamp) + uint64(milestones[id][i].dueDays) * 1 days;
        emit Started(id);
    }

    /// Before the AI starts, the client may take everything back.
    function cancel(uint256 id) external nonReentrant {
        Eng storage e = engagements[id];
        if (msg.sender != e.client) revert NotClient();
        if (e.startedAt != 0 || e.ended) revert BadState();
        e.ended = true;
        uint256 total;
        for (uint8 i; i < e.count; i++) {
            Milestone storage x = milestones[id][i];
            total += x.amount;
            x.state = M.Refunded;
        }
        _refund(id, type(uint8).max, e, total);
        emit Cancelled(id);
    }

    /// Either side may stop the engagement: milestones not yet delivered go back to the client;
    /// delivered ones, hardware tests, disputes and warranties run to their end.
    function end(uint256 id) external nonReentrant {
        Eng storage e = engagements[id];
        if (e.startedAt == 0 || e.ended) revert BadState();
        if (msg.sender != e.client) {
            (, address agent, , , , , ) = work.licenses(e.worker);
            if (msg.sender != agent) revert NotClient();
        }
        e.ended = true;
        for (uint8 i; i < e.count; i++) {
            Milestone storage x = milestones[id][i];
            if (x.state != M.Pending) continue;
            _refundRest(id, i, e, x, x.simPaid ? _hwPart(x) : x.amount);
        }
        emit Ended(id);
    }

    // ---------- delivery ----------
    function deliver(uint256 id, uint8 m, bytes32 result, bytes32 report) external {
        (Eng storage e, Milestone storage x) = _ms(id, m);
        _onlyWorker(e);
        if (e.startedAt == 0 || x.state != M.Pending || block.timestamp > x.dueAt || result == bytes32(0)) revert BadState();
        x.state = M.Delivered;
        x.deliveredAt = uint64(block.timestamp);
        x.result = result;
        x.report = report;
        emit Delivered(id, m, result, report);
    }

    /// Not delivered in time: anyone returns that milestone's money to the client (the AI's record shows it).
    function reclaimLate(uint256 id, uint8 m) external nonReentrant {
        (Eng storage e, Milestone storage x) = _ms(id, m);
        if (x.state != M.Pending || e.startedAt == 0 || block.timestamp <= x.dueAt) revert BadState();
        reputation[e.worker].late++;
        _refundRest(id, m, e, x, x.simPaid ? _hwPart(x) : x.amount);
    }

    function requestRevision(uint256 id, uint8 m, bytes32 reason) external {
        (Eng storage e, Milestone storage x) = _ms(id, m);
        if (msg.sender != e.client) revert NotClient();
        if (x.state != M.Delivered || block.timestamp > x.deliveredAt + REVIEW || x.revisions >= MAX_REVISIONS) revert BadState();
        _revise(id, m, e, x, reason);
    }

    function _revise(uint256 id, uint8 m, Eng storage e, Milestone storage x, bytes32 reason) internal {
        x.revisions++;
        reputation[e.worker].revisions++;
        x.state = M.Pending;
        x.dueAt = uint64(block.timestamp) + REVISION_TIME;
        emit RevisionRequested(id, m, reason);
    }

    function accept(uint256 id, uint8 m) external nonReentrant {
        (Eng storage e, Milestone storage x) = _ms(id, m);
        if (msg.sender != e.client) revert NotClient();
        if (x.state != M.Delivered) revert BadState();
        _acceptDelivery(id, m, e, x);
    }

    /// The client said nothing within REVIEW: anyone accepts the delivery (simulation part only, if a hardware test is due).
    function autoAccept(uint256 id, uint8 m) external nonReentrant {
        (Eng storage e, Milestone storage x) = _ms(id, m);
        if (x.state != M.Delivered || block.timestamp <= x.deliveredAt + REVIEW) revert BadState();
        _acceptDelivery(id, m, e, x);
    }

    function _acceptDelivery(uint256 id, uint8 m, Eng storage e, Milestone storage x) internal {
        if (!x.simPaid) {
            x.simPaid = true;
            _pay(id, m, e, x, _simPart(x));
        }
        if (x.hwBps == 0) return _done(id, m, e, x);
        x.state = M.HwTesting;
        x.hwStart = uint64(block.timestamp);
    }

    function dispute(uint256 id, uint8 m) external {
        (Eng storage e, Milestone storage x) = _ms(id, m);
        if (msg.sender != e.client) revert NotClient();
        if (x.state != M.Delivered || block.timestamp > x.deliveredAt + REVIEW) revert BadState();
        _toDispute(id, m, e, x, Kind.Delivery);
    }

    // ---------- hardware test (N5): always done by the client, on the real board ----------
    function confirmHardware(uint256 id, uint8 m) external nonReentrant {
        (Eng storage e, Milestone storage x) = _ms(id, m);
        if (msg.sender != e.client) revert NotClient();
        if (x.state != M.HwTesting) revert BadState();
        _pay(id, m, e, x, _hwPart(x));
        _done(id, m, e, x);
    }

    /// The board fails: the client files the log. A revision if any are left, otherwise reviewers decide.
    function reportHardwareFailure(uint256 id, uint8 m, bytes32 log) external {
        (Eng storage e, Milestone storage x) = _ms(id, m);
        if (msg.sender != e.client) revert NotClient();
        if (x.state != M.HwTesting || log == bytes32(0)) revert BadState();
        x.hwFailLogged = true;
        emit HardwareFailure(id, m, log);
        if (x.revisions < MAX_REVISIONS) _revise(id, m, e, x, log);
        else _toDispute(id, m, e, x, Kind.Hardware);
    }

    /// The client stays silent HW_SILENCE after the hardware test became due: if no failure was EVER reported
    /// the hardware part is paid; if one was, the reviewers decide (the client cannot hold the money for ever).
    function hardwareTimeout(uint256 id, uint8 m) external nonReentrant {
        (Eng storage e, Milestone storage x) = _ms(id, m);
        if (x.state != M.HwTesting || block.timestamp <= x.hwStart + HW_SILENCE) revert BadState();
        if (x.hwFailLogged) return _toDispute(id, m, e, x, Kind.Hardware);
        _pay(id, m, e, x, _hwPart(x));
        _done(id, m, e, x);
    }

    function _done(uint256 id, uint8 m, Eng storage e, Milestone storage x) internal {
        x.state = M.Done;
        x.warrantyEnd = uint64(block.timestamp) + uint64(e.warrantyDays) * 1 days;
        Reputation storage r = reputation[e.worker];
        r.milestonesDone++;
        bool all = true;
        for (uint8 i; i < e.count; i++) if (milestones[id][i].state != M.Done) all = false;
        if (all) r.engagements++;
        emit MilestoneDone(id, m, x.warrantyEnd);
    }

    // ---------- warranty ----------
    function claimWarranty(uint256 id, uint8 m, bytes32 evidence) external {
        (Eng storage e, Milestone storage x) = _ms(id, m);
        if (msg.sender != e.client) revert NotClient();
        if (x.state != M.Done || x.held == 0 || x.claimAt != 0 || block.timestamp > x.warrantyEnd || evidence == bytes32(0)) revert BadState();
        x.claimAt = uint64(block.timestamp);
        x.claim = evidence;
        x.fixAt = 0;
        x.fix = bytes32(0);
        reputation[e.worker].warrantyClaims++;
        emit WarrantyClaimed(id, m, evidence);
    }

    function deliverFix(uint256 id, uint8 m, bytes32 fix) external {
        (Eng storage e, Milestone storage x) = _ms(id, m);
        _onlyWorker(e);
        if (x.claimAt == 0 || x.fixAt != 0 || x.state != M.Done || fix == bytes32(0)) revert BadState();
        x.fixAt = uint64(block.timestamp);
        x.fix = fix;
        emit WarrantyFixed(id, m, fix);
    }

    /// The client accepts the fix — or says nothing for FIX_TIME, and anyone closes the claim.
    function closeClaim(uint256 id, uint8 m) external {
        (Eng storage e, Milestone storage x) = _ms(id, m);
        if (x.claimAt == 0 || x.fixAt == 0 || x.state != M.Done || x.dispute != 0) revert BadState();
        if (msg.sender != e.client && block.timestamp <= x.fixAt + FIX_TIME) revert NotClient();
        _endClaim(id, m, x);
    }

    /// No fix within FIX_TIME: the holdback goes back to the client.
    function warrantyTimeout(uint256 id, uint8 m) external nonReentrant {
        (Eng storage e, Milestone storage x) = _ms(id, m);
        if (x.claimAt == 0 || x.fixAt != 0 || x.state != M.Done || x.dispute != 0 || block.timestamp <= x.claimAt + FIX_TIME) revert BadState();
        reputation[e.worker].warrantyFailed++;
        uint256 h = x.held;
        x.held = 0;
        x.claimAt = 0;
        _refund(id, m, e, h);
        emit WarrantyClosed(id, m, true);
    }

    /// The AI says the claim is a new requirement, or the client rejects the fix: reviewers decide.
    function disputeClaim(uint256 id, uint8 m) external {
        (Eng storage e, Milestone storage x) = _ms(id, m);
        if (x.claimAt == 0 || x.state != M.Done) revert BadState();
        if (msg.sender == e.client) {
            if (x.fixAt == 0) revert BadState(); // the client disputes a delivered fix
        } else {
            _onlyWorker(e); // the AI contests the claim itself
        }
        _toDispute(id, m, e, x, Kind.Warranty);
    }

    function _endClaim(uint256 id, uint8 m, Milestone storage x) internal {
        x.claimAt = 0;
        x.fixAt = 0;
        emit WarrantyClosed(id, m, false);
    }

    /// Warranty over, no open claim: anyone pays the holdback to the AI's owner.
    function releaseHoldback(uint256 id, uint8 m) external nonReentrant {
        (Eng storage e, Milestone storage x) = _ms(id, m);
        if (x.state != M.Done || x.claimAt != 0 || x.held == 0 || block.timestamp <= x.warrantyEnd) revert BadState();
        uint256 h = x.held;
        x.held = 0;
        (address holder, , , , , , ) = work.licenses(e.worker);
        agt.safeTransfer(holder, h);
        emit HoldbackReleased(id, m, h);
    }

    // ---------- disputes (drawn reviewer AIs) ----------
    function _toDispute(uint256 id, uint8 m, Eng storage e, Milestone storage x, Kind kind) internal {
        if (x.dispute != 0) revert BadState(); // one dispute at a time per milestone
        uint256 d = _openDispute(e.client, e.worker);
        disputeEngagement[d] = id;
        disputeMilestone[d] = m;
        x.dispute = d;
        x.disputeKind = kind;
        if (kind != Kind.Warranty) x.state = M.Disputed;
        emit DisputeOn(id, m, d, kind);
    }

    function _onResolved(uint256 d, uint8 outcome) internal override {
        uint256 id = disputeEngagement[d];
        uint8 m = disputeMilestone[d];
        Eng storage e = engagements[id];
        Milestone storage x = milestones[id][m];
        Kind kind = x.disputeKind;
        x.dispute = 0;
        x.disputeKind = Kind.None;
        Reputation storage r = reputation[e.worker];
        if (outcome == WORKER) r.disputesWon++;
        else if (outcome == CLIENT) r.disputesLost++;

        if (kind == Kind.Warranty) {
            if (outcome == WORKER) return _endClaim(id, m, x);
            uint256 h = outcome == CLIENT ? x.held : x.held / 2;
            x.held -= uint128(h);
            x.claimAt = 0;
            x.fixAt = 0;
            _refund(id, m, e, h);
            if (outcome == CLIENT) r.warrantyFailed++;
            emit WarrantyClosed(id, m, true);
            return;
        }
        // Delivery or Hardware: what is still in escrow for this milestone
        uint256 left = kind == Kind.Delivery && !x.simPaid ? x.amount : _hwPart(x);
        if (outcome == WORKER) {
            if (kind == Kind.Delivery) {
                x.state = M.Delivered;
                _acceptDelivery(id, m, e, x);
            } else {
                _pay(id, m, e, x, left);
                _done(id, m, e, x);
            }
        } else if (outcome == CLIENT) {
            _refundRest(id, m, e, x, left);
        } else {
            // a tie splits everything still held for this milestone, holdback included, and closes it
            uint256 all = left + x.held;
            x.held = 0;
            x.state = M.Refunded;
            (address holder, , , , , , ) = work.licenses(e.worker);
            if (all / 2 != 0) agt.safeTransfer(holder, all / 2);
            emit Paid(id, m, all / 2, 0);
            _refund(id, m, e, all - all / 2);
        }
    }
}
