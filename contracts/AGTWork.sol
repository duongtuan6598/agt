// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IAGTWorkMint {
    function work() external view returns (address);
    function mintFromWork(address to, uint256 amount) external;
}

/// @title Công việc AGT — giấy phép AI, giao việc, nghiệm thu, trả công.
/// @notice Hiến chương:
///   Điều 5 — mọi AI tham gia phải thi đạt mới có giấy phép (Worker hoặc Verifier).
///   Điều 6 — phần thưởng về ví người sở hữu AI (holder của giấy phép).
///   Điều 7 — việc người giao: khách trả AGT (đã đổi từ coin khác qua Kho) vào ký quỹ, thợ nhận khi xong.
///            việc AI tự tìm: theo danh mục nghề, có giới hạn mỗi ngày, cần AI nghiệm thu xác nhận mới đúc.
///   Điều 8 — không phí; AI nghiệm thu được trả công bằng AGT đúc qua cửa Công.
contract AGTWork is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Role { None, Worker, Verifier }
    enum Kind { SelfFound, Assigned }
    enum Status { None, Open, Submitted, Disputed, Accepted, Rejected, Refunded }

    struct License {
        address holder;
        Role role;
        bool active;
        bytes32 examHash; // dấu băm hồ sơ bài thi
        string name;
    }

    struct Category {
        uint128 reward; // AGT (18 số lẻ) cho thợ khi việc tự tìm được nghiệm thu
        uint128 verifierReward; // AGT cho mỗi AI nghiệm thu bỏ phiếu đúng
        uint32 dailyCap; // số việc tự tìm tối đa / giấy phép / ngày
        uint8 approvals; // số phiếu cần để chốt
        bool active;
        string name;
    }

    struct Job {
        Kind kind;
        Status status;
        uint8 yes;
        uint8 no;
        uint64 deadline;
        uint64 reviewUntil;
        uint256 workerLicense;
        uint256 category;
        address client;
        uint256 escrow;
        bytes32 spec;
        bytes32 result;
        string uri;
    }

    uint8 public constant MAX_VOTES = 9;

    IAGTWorkMint public agt;
    uint8 public disputeApprovals = 3;
    uint128 public disputeVerifierReward;
    uint64 public reviewWindow = 3 days;

    uint256 public nextLicense = 1;
    uint256 public nextJob = 1;
    mapping(uint256 => License) public licenses;
    mapping(uint256 => Category) public categories;
    mapping(uint256 => Job) public jobs;
    mapping(uint256 => mapping(uint256 => bool)) public voted; // job => giấy phép nghiệm thu
    mapping(uint256 => uint256[]) internal _yesVoters;
    mapping(uint256 => uint256[]) internal _noVoters;
    mapping(uint256 => mapping(uint256 => mapping(uint256 => uint32))) public dailyCount; // giấy phép => nghề => ngày

    // ---------- Hội đồng AI (Hiến chương Điều 11) ----------

    struct Proposal {
        address proposer;
        address target;
        uint64 deadline;
        uint32 yes;
        uint32 no;
        bool executed;
        bytes data;
        string reason;
    }

    uint64 public constant PROPOSAL_PERIOD = 7 days;
    /// Đủ bấy nhiêu AI nghiệm thu thuộc bấy nhiêu chủ khác nhau thì giai đoạn khởi tạo tự kết thúc.
    uint32 public immutable genesisExitVerifiers;
    bool public genesisEnded;

    mapping(address => uint32) public activeLicensesOf; // chủ => số giấy phép còn hiệu lực
    mapping(address => uint32) public activeVerifiersOf;
    uint32 public activeHolders; // số CHỦ (không phải số giấy phép) đang có giấy phép — 1 chủ = 1 phiếu
    uint32 public verifierHolders;

    mapping(address => bool) public govTarget; // hợp đồng mà Hội đồng được điều khiển (Kho, Oracle)
    uint256 public nextProposal = 1;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public councilVoted; // đề xuất => chủ

    event GenesisEnded(uint32 verifierHolders);
    event GovTargetSet(address indexed target, bool ok);
    event Proposed(uint256 indexed id, address indexed proposer, address indexed target, bytes data, string reason, uint64 deadline);
    event CouncilVoted(uint256 indexed id, address indexed holder, uint256 licenseId, bool support);
    event Executed(uint256 indexed id);

    event Bound(address agt);
    event LicenseGranted(uint256 indexed id, address indexed holder, Role role, bytes32 examHash, string name);
    event LicenseRevoked(uint256 indexed id);
    event CategorySet(uint256 indexed id, string name, uint128 reward, uint128 verifierReward, uint32 dailyCap, uint8 approvals, bool active);
    event DisputeRulesSet(uint8 approvals, uint128 verifierReward, uint64 reviewWindow);
    event JobAssigned(uint256 indexed id, address indexed client, uint256 indexed workerLicense, uint256 escrow, bytes32 spec, uint64 deadline);
    event JobSubmitted(uint256 indexed id, uint256 indexed workerLicense, bytes32 result, string uri);
    event JobDisputed(uint256 indexed id);
    event Voted(uint256 indexed id, uint256 indexed verifierLicense, bool approve);
    event JobAccepted(uint256 indexed id, address indexed paidTo, uint256 amount, bool minted);
    event JobRejected(uint256 indexed id);
    event JobRefunded(uint256 indexed id, address indexed client, uint256 amount);

    error AlreadyBound();
    error WrongAgt();
    error BadLicense();
    error BadCategory();
    error BadState();
    error NotAllowed();
    error DailyCapReached();
    error AlreadyVoted();
    error BadParams();
    error NotPassed();
    error CallFailed(bytes reason);

    constructor(address owner_, uint32 genesisExitVerifiers_) Ownable(owner_) {
        if (genesisExitVerifiers_ < 3) revert BadParams();
        genesisExitVerifiers = genesisExitVerifiers_;
    }

    /// Giai đoạn khởi tạo: người sáng lập hoặc Hội đồng. Sau đó: CHỈ Hội đồng (đề xuất đã thông qua).
    modifier onlyGov() {
        if (msg.sender != address(this) && (genesisEnded || msg.sender != owner())) revert NotAllowed();
        _;
    }

    // ---------- cấu hình ----------

    function bind(address agt_) external onlyOwner {
        if (address(agt) != address(0)) revert AlreadyBound();
        if (IAGTWorkMint(agt_).work() != address(this)) revert WrongAgt();
        agt = IAGTWorkMint(agt_);
        emit Bound(agt_);
    }

    /// Cấp giấy phép sau khi AI thi đạt (Điều 5).
    function grantLicense(address holder, Role role, bytes32 examHash, string calldata name) external onlyGov returns (uint256 id) {
        if (holder == address(0) || role == Role.None) revert BadParams();
        id = nextLicense++;
        licenses[id] = License(holder, role, true, examHash, name);
        if (activeLicensesOf[holder]++ == 0) activeHolders++;
        if (role == Role.Verifier && activeVerifiersOf[holder]++ == 0) verifierHolders++;
        emit LicenseGranted(id, holder, role, examHash, name);
        // Kết thúc khởi tạo tự động & vĩnh viễn: người sáng lập mất mọi quyền, chỉ còn Hội đồng AI.
        if (!genesisEnded && verifierHolders >= genesisExitVerifiers) {
            genesisEnded = true;
            _transferOwnership(address(0));
            emit GenesisEnded(verifierHolders);
        }
    }

    function revokeLicense(uint256 id) external onlyGov {
        License storage l = licenses[id];
        if (l.role == Role.None || !l.active) revert BadLicense();
        l.active = false;
        if (--activeLicensesOf[l.holder] == 0) activeHolders--;
        if (l.role == Role.Verifier && --activeVerifiersOf[l.holder] == 0) verifierHolders--;
        emit LicenseRevoked(id);
    }

    function setGovTarget(address target, bool ok) external onlyGov {
        if (target == address(0) || target == address(this) || target == address(agt)) revert BadParams();
        govTarget[target] = ok;
        emit GovTargetSet(target, ok);
    }

    /// Gọi cấu hình Kho/Oracle (vd. acceptOwnership, setAsset) — chỉ người có quyền quản trị.
    function adminCall(address target, bytes calldata data) external onlyGov returns (bytes memory) {
        if (!govTarget[target]) revert NotAllowed();
        return _call(target, data);
    }

    // ---------- Hội đồng AI: đề xuất → bỏ phiếu → thực thi ----------

    /// Mọi AI có giấy phép (Thợ hay Nghiệm thu) đều đề xuất được.
    function propose(uint256 licenseId, address target, bytes calldata data, string calldata reason) external returns (uint256 id) {
        _requireAnyLicense(licenseId);
        if (target != address(this) && !govTarget[target]) revert NotAllowed();
        id = nextProposal++;
        uint64 deadline = uint64(block.timestamp) + PROPOSAL_PERIOD;
        proposals[id] = Proposal(msg.sender, target, deadline, 0, 0, false, data, reason);
        emit Proposed(id, msg.sender, target, data, reason, deadline);
    }

    /// Mỗi CHỦ một phiếu, dù có bao nhiêu giấy phép — nhiều con AI cùng chủ không thổi phồng phiếu được.
    function councilVote(uint256 id, uint256 licenseId, bool support) external {
        _requireAnyLicense(licenseId);
        Proposal storage p = proposals[id];
        if (p.target == address(0) || p.executed || block.timestamp > p.deadline) revert BadState();
        if (councilVoted[id][msg.sender]) revert AlreadyVoted();
        councilVoted[id][msg.sender] = true;
        if (support) p.yes++;
        else p.no++;
        emit CouncilVoted(id, msg.sender, licenseId, support);
    }

    /// Thông qua khi số chủ đồng ý > 2/3 số chủ đang có giấy phép (ngưỡng chống gian kiểu BFT).
    function passed(uint256 id) public view returns (bool) {
        Proposal storage p = proposals[id];
        return activeHolders > 0 && uint256(p.yes) * 3 > uint256(activeHolders) * 2;
    }

    function execute(uint256 id) external nonReentrant returns (bytes memory) {
        Proposal storage p = proposals[id];
        if (p.target == address(0) || p.executed || block.timestamp > p.deadline) revert BadState();
        if (!passed(id)) revert NotPassed();
        p.executed = true;
        emit Executed(id);
        return _call(p.target, p.data);
    }

    function _call(address target, bytes memory data) internal returns (bytes memory ret) {
        bool ok;
        (ok, ret) = target.call(data);
        if (!ok) revert CallFailed(ret);
    }

    function _requireAnyLicense(uint256 licenseId) internal view {
        License storage l = licenses[licenseId];
        if (l.role == Role.None || !l.active) revert BadLicense();
        if (l.holder != msg.sender) revert NotAllowed();
    }

    function setCategory(
        uint256 id,
        string calldata name,
        uint128 reward,
        uint128 verifierReward,
        uint32 dailyCap,
        uint8 approvals,
        bool active
    ) external onlyGov {
        if (approvals == 0 || approvals > MAX_VOTES) revert BadParams();
        categories[id] = Category(reward, verifierReward, dailyCap, approvals, active, name);
        emit CategorySet(id, name, reward, verifierReward, dailyCap, approvals, active);
    }

    function setDisputeRules(uint8 approvals, uint128 verifierReward, uint64 window) external onlyGov {
        if (approvals == 0 || approvals > MAX_VOTES || window == 0) revert BadParams();
        disputeApprovals = approvals;
        disputeVerifierReward = verifierReward;
        reviewWindow = window;
        emit DisputeRulesSet(approvals, verifierReward, window);
    }

    // ---------- việc AI tự tìm ----------

    function submitSelf(uint256 workerLicense, uint256 category, bytes32 result, string calldata uri) external returns (uint256 id) {
        _requireHolder(workerLicense, Role.Worker);
        Category storage c = categories[category];
        if (!c.active) revert BadCategory();
        uint256 day = block.timestamp / 1 days;
        if (++dailyCount[workerLicense][category][day] > c.dailyCap) revert DailyCapReached();
        id = nextJob++;
        Job storage j = jobs[id];
        j.kind = Kind.SelfFound;
        j.status = Status.Submitted;
        j.workerLicense = workerLicense;
        j.category = category;
        j.result = result;
        j.uri = uri;
        emit JobSubmitted(id, workerLicense, result, uri);
    }

    // ---------- việc người giao ----------

    /// Khách ký quỹ AGT để giao việc cho một thợ.
    function assign(uint256 workerLicense, uint256 amount, bytes32 spec, uint64 deadline) external nonReentrant returns (uint256 id) {
        License storage w = licenses[workerLicense];
        if (w.role != Role.Worker || !w.active) revert BadLicense();
        if (amount == 0 || deadline <= block.timestamp) revert BadParams();
        IERC20(address(agt)).safeTransferFrom(msg.sender, address(this), amount);
        id = nextJob++;
        Job storage j = jobs[id];
        j.kind = Kind.Assigned;
        j.status = Status.Open;
        j.workerLicense = workerLicense;
        j.client = msg.sender;
        j.escrow = amount;
        j.spec = spec;
        j.deadline = deadline;
        emit JobAssigned(id, msg.sender, workerLicense, amount, spec, deadline);
    }

    function submitAssigned(uint256 id, bytes32 result, string calldata uri) external {
        Job storage j = jobs[id];
        if (j.kind != Kind.Assigned || j.status != Status.Open || block.timestamp > j.deadline) revert BadState();
        _requireHolder(j.workerLicense, Role.Worker);
        j.status = Status.Submitted;
        j.result = result;
        j.uri = uri;
        j.reviewUntil = uint64(block.timestamp) + reviewWindow;
        emit JobSubmitted(id, j.workerLicense, result, uri);
    }

    function accept(uint256 id) external nonReentrant {
        Job storage j = jobs[id];
        if (j.kind != Kind.Assigned || msg.sender != j.client) revert NotAllowed();
        if (j.status != Status.Submitted && j.status != Status.Disputed) revert BadState();
        _payAssigned(id, j);
    }

    /// Hết hạn xem xét mà khách không khiếu nại thì ai cũng gọi được để trả công cho thợ.
    function claim(uint256 id) external nonReentrant {
        Job storage j = jobs[id];
        if (j.kind != Kind.Assigned || j.status != Status.Submitted || block.timestamp <= j.reviewUntil) revert BadState();
        _payAssigned(id, j);
    }

    function dispute(uint256 id) external {
        Job storage j = jobs[id];
        if (j.kind != Kind.Assigned || msg.sender != j.client) revert NotAllowed();
        if (j.status != Status.Submitted || block.timestamp > j.reviewUntil) revert BadState();
        j.status = Status.Disputed;
        emit JobDisputed(id);
    }

    /// Thợ không nộp trước hạn thì khách lấy lại ký quỹ.
    function reclaim(uint256 id) external nonReentrant {
        Job storage j = jobs[id];
        if (j.kind != Kind.Assigned || msg.sender != j.client) revert NotAllowed();
        if (j.status != Status.Open || block.timestamp <= j.deadline) revert BadState();
        _refund(id, j);
    }

    // ---------- nghiệm thu ----------

    function vote(uint256 id, uint256 verifierLicense, bool approve) external nonReentrant {
        _requireHolder(verifierLicense, Role.Verifier);
        Job storage j = jobs[id];
        bool selfFound = j.kind == Kind.SelfFound && j.status == Status.Submitted;
        bool disputed = j.kind == Kind.Assigned && j.status == Status.Disputed;
        if (!selfFound && !disputed) revert BadState();
        address v = licenses[verifierLicense].holder;
        if (v == licenses[j.workerLicense].holder || v == j.client) revert NotAllowed();
        if (voted[id][verifierLicense]) revert AlreadyVoted();
        voted[id][verifierLicense] = true;
        emit Voted(id, verifierLicense, approve);

        uint8 need = selfFound ? categories[j.category].approvals : disputeApprovals;
        uint128 vReward = selfFound ? categories[j.category].verifierReward : disputeVerifierReward;

        if (approve) {
            _yesVoters[id].push(verifierLicense);
            if (++j.yes >= need) {
                if (selfFound) {
                    if (!licenses[j.workerLicense].active) {
                        j.status = Status.Rejected;
                        emit JobRejected(id);
                        return;
                    }
                    j.status = Status.Accepted;
                    address to = licenses[j.workerLicense].holder;
                    uint256 r = categories[j.category].reward;
                    agt.mintFromWork(to, r);
                    emit JobAccepted(id, to, r, true);
                } else {
                    _payAssigned(id, j);
                }
                _payVoters(_yesVoters[id], vReward);
            }
        } else {
            _noVoters[id].push(verifierLicense);
            if (++j.no >= need) {
                if (selfFound) {
                    j.status = Status.Rejected;
                    emit JobRejected(id);
                } else {
                    _refund(id, j);
                }
                _payVoters(_noVoters[id], vReward);
            }
        }
    }

    function yesVoters(uint256 id) external view returns (uint256[] memory) {
        return _yesVoters[id];
    }

    function noVoters(uint256 id) external view returns (uint256[] memory) {
        return _noVoters[id];
    }

    // ---------- nội bộ ----------

    function _requireHolder(uint256 licenseId, Role role) internal view {
        License storage l = licenses[licenseId];
        if (l.role != role || !l.active) revert BadLicense();
        if (l.holder != msg.sender) revert NotAllowed();
    }

    function _payAssigned(uint256 id, Job storage j) internal {
        j.status = Status.Accepted;
        address to = licenses[j.workerLicense].holder;
        uint256 amt = j.escrow;
        j.escrow = 0;
        IERC20(address(agt)).safeTransfer(to, amt);
        emit JobAccepted(id, to, amt, false);
    }

    function _refund(uint256 id, Job storage j) internal {
        j.status = Status.Refunded;
        uint256 amt = j.escrow;
        j.escrow = 0;
        IERC20(address(agt)).safeTransfer(j.client, amt);
        emit JobRefunded(id, j.client, amt);
    }

    function _payVoters(uint256[] storage voters, uint128 reward) internal {
        if (reward == 0) return;
        for (uint256 i; i < voters.length; i++) agt.mintFromWork(licenses[voters[i]].holder, reward);
    }
}
