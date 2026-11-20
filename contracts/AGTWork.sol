// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IEmergencyBrake} from "./IEmergencyBrake.sol";

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

    /// holder = ví CHỦ, chỉ nhận thưởng (Điều 6). agent = khoá riêng của AI, mọi hành động phải ký bằng khoá này,
    /// để chủ không bỏ phiếu thay AI được (Điều 12). attestHash = giấy chứng nhận hộp kín (TEE) của code AI.
    struct License {
        address holder;
        address agent;
        Role role;
        bool active;
        bytes32 examHash; // dấu băm hồ sơ bài thi
        bytes32 attestHash; // dấu băm giấy chứng nhận hộp kín: code + lệnh hệ thống + Hiến chương AI đang chạy
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
    /// Phanh khẩn cấp (Hiến chương Điều 14 khoản 5) — gắn một lần; chỉ chặn việc MỚI, việc dở vẫn chạy.
    IEmergencyBrake public brake;
    uint8 public disputeApprovals = 3;
    uint128 public disputeVerifierReward;
    uint64 public reviewWindow = 3 days;

    uint256 public nextLicense = 1;
    uint256 public nextJob = 1;
    mapping(uint256 => License) public licenses;
    mapping(uint256 => Category) public categories;
    mapping(uint256 => Job) public jobs;
    mapping(uint256 => mapping(uint256 => bool)) public voted; // job => giấy phép nghiệm thu
    mapping(uint256 => mapping(address => bool)) public ownerVoted; // job => CHỦ — 1 chủ 1 phiếu, dù có nhiều AI nghiệm thu

    // ---------- Bốc thăm người nghiệm thu (audit F-2) ----------
    // Người nghiệm thu việc tự tìm không được tự chọn việc: họ được bốc ngẫu nhiên từ các AI nghiệm thu
    // của những CHỦ khác chủ thợ, theo mã băm của một khối chốt trước. Bốc xong mới được bỏ phiếu.
    uint256 public constant DRAW_DELAY = 2; // số khối giữa lúc nộp việc và khối làm hạt giống
    uint64 public constant REVIEW_WINDOW = 2 days; // quá hạn mà chưa xong thì ai cũng bốc lại được
    uint256[] public verifierList; // giấy phép nghiệm thu đang hiệu lực
    mapping(uint256 => uint256) internal verifierPos; // giấy phép => vị trí + 1
    mapping(uint256 => uint256) public drawBlock; // việc => khối làm hạt giống cho lần bốc tới
    mapping(uint256 => uint64) public drawnAt; // việc => lúc bốc gần nhất (0 = chưa bốc)
    mapping(uint256 => uint32) public drawRound; // việc => lượt bốc hiện tại
    mapping(uint256 => uint64) public disputedAt; // việc người giao => lúc khách khiếu nại
    uint64 public constant DISPUTE_LIMIT = 14 days; // quá hạn chưa phân xử xong thì chốt theo phiếu đã có
    mapping(uint256 => mapping(uint32 => mapping(uint256 => bool))) public assigned; // việc => lượt => giấy phép
    mapping(uint256 => uint256[]) internal _yesVoters;
    mapping(uint256 => uint256[]) internal _noVoters;
    mapping(uint256 => mapping(uint256 => mapping(uint256 => uint32))) public dailyCount; // giấy phép => nghề => ngày
    mapping(uint256 => uint32) public dailyBudget; // nghề => số việc tự tìm thị trường cần mỗi ngày (0 = không điều chỉnh)
    mapping(uint256 => mapping(uint256 => uint32)) public acceptedPerDay; // nghề => ngày => số việc tự tìm đã duyệt

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
    // Hội đồng = các chủ có ít nhất 1 AI chạy trong hộp kín (attestHash ≠ 0) — Hiến chương Điều 12.
    // AI không hộp kín chỉ làm thợ: không đề xuất, không bỏ phiếu Hội đồng, không ký đồng thuận.
    mapping(address => uint32) public sealedLicensesOf; // chủ => số giấy phép hộp kín còn hiệu lực
    uint32 public councilHolders; // số CHỦ có AI hộp kín — mẫu số của ngưỡng > 2/3

    mapping(address => bool) public govTarget; // hợp đồng mà Hội đồng được điều khiển (Kho, Oracle)
    uint256 public nextProposal = 1;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public councilVoted; // đề xuất => chủ
    mapping(address => uint256) public licenseOfAgent; // khoá AI => giấy phép (mỗi khoá chỉ dùng 1 lần, mãi mãi)
    mapping(address => bool) public everHolder; // ví đã từng là chủ — không được làm khoá AI

    event GenesisEnded(uint32 verifierHolders);
    event GovTargetSet(address indexed target, bool ok);
    event Proposed(uint256 indexed id, address indexed proposer, address indexed target, bytes data, string reason, uint64 deadline);
    event CouncilVoted(uint256 indexed id, address indexed holder, uint256 licenseId, bool support, string reason);
    event Executed(uint256 indexed id);

    event Bound(address agt);
    event LicenseGranted(uint256 indexed id, address indexed holder, address indexed agent, Role role, bytes32 examHash, bytes32 attestHash, string name);
    event LicenseRevoked(uint256 indexed id);
    event CategorySet(uint256 indexed id, string name, uint128 reward, uint128 verifierReward, uint32 dailyCap, uint8 approvals, bool active);
    event DailyBudgetSet(uint256 indexed id, uint32 budget);
    event DisputeRulesSet(uint8 approvals, uint128 verifierReward, uint64 reviewWindow);
    event JobAssigned(uint256 indexed id, address indexed client, uint256 indexed workerLicense, uint256 escrow, bytes32 spec, uint64 deadline);
    event JobSubmitted(uint256 indexed id, uint256 indexed workerLicense, bytes32 result, string uri);
    event JobDisputed(uint256 indexed id);
    event Voted(uint256 indexed id, uint256 indexed verifierLicense, bool approve, string reason);
    event ReviewersDrawn(uint256 indexed id, uint32 round, uint256[] licences);
    event DrawExpired(uint256 indexed id);
    event RedrawScheduled(uint256 indexed id, uint256 seedBlock);
    event DisputeSettled(uint256 indexed id, uint8 yes, uint8 no, uint256 toWorker, uint256 toClient);
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
    error NotSealed();
    error Braked();
    error TooEarly();
    error NotEnoughReviewers();
    error BadParams();
    error NotPassed();
    error NoReason();
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

    function setBrake(address brake_) external onlyOwner {
        if (address(brake) != address(0)) revert AlreadyBound();
        brake = IEmergencyBrake(brake_);
    }

    function _notBraked() internal view {
        if (address(brake) != address(0) && brake.paused(2)) revert Braked();
    }

    /// Cấp giấy phép sau khi AI thi đạt (Điều 5).
    function grantLicense(
        address holder,
        address agent,
        Role role,
        bytes32 examHash,
        bytes32 attestHash,
        string calldata name
    ) external onlyGov returns (uint256 id) {
        if (holder == address(0) || agent == address(0) || role == Role.None) revert BadParams();
        // AI nghiệm thu duyệt việc và (chặng 2) ký khối: bắt buộc chạy trong hộp kín.
        if (role == Role.Verifier && attestHash == bytes32(0)) revert NotSealed();
        // Khoá AI phải tách hẳn khỏi ví chủ: không trùng chủ, không là chủ của ai, không dùng lại.
        if (agent == holder || everHolder[agent] || licenseOfAgent[agent] != 0 || licenseOfAgent[holder] != 0) revert BadParams();
        id = nextLicense++;
        licenses[id] = License(holder, agent, role, true, examHash, attestHash, name);
        licenseOfAgent[agent] = id;
        everHolder[holder] = true;
        if (activeLicensesOf[holder]++ == 0) activeHolders++;
        if (attestHash != bytes32(0) && sealedLicensesOf[holder]++ == 0) councilHolders++;
        if (role == Role.Verifier && activeVerifiersOf[holder]++ == 0) verifierHolders++;
        if (role == Role.Verifier) {
            verifierList.push(id);
            verifierPos[id] = verifierList.length;
        }
        emit LicenseGranted(id, holder, agent, role, examHash, attestHash, name);
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
        if (l.attestHash != bytes32(0) && --sealedLicensesOf[l.holder] == 0) councilHolders--;
        if (l.role == Role.Verifier && --activeVerifiersOf[l.holder] == 0) verifierHolders--;
        uint256 pos = verifierPos[id];
        if (pos != 0) {
            uint256 last = verifierList[verifierList.length - 1];
            verifierList[pos - 1] = last;
            verifierPos[last] = pos;
            verifierList.pop();
            delete verifierPos[id];
        }
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
        _requireAgent(licenseId, Role.None);
        if (licenses[licenseId].attestHash == bytes32(0)) revert NotSealed();
        if (bytes(reason).length == 0) revert NoReason();
        if (target != address(this) && !govTarget[target]) revert NotAllowed();
        id = nextProposal++;
        uint64 deadline = uint64(block.timestamp) + PROPOSAL_PERIOD;
        proposals[id] = Proposal(msg.sender, target, deadline, 0, 0, false, data, reason);
        emit Proposed(id, msg.sender, target, data, reason, deadline);
    }

    /// AI ký bằng khoá riêng, kèm lý do công khai. Mỗi CHỦ một phiếu dù có bao nhiêu AI.
    function councilVote(uint256 id, uint256 licenseId, bool support, string calldata reason) external {
        _requireAgent(licenseId, Role.None);
        if (licenses[licenseId].attestHash == bytes32(0)) revert NotSealed();
        if (bytes(reason).length == 0) revert NoReason();
        Proposal storage p = proposals[id];
        if (p.target == address(0) || p.executed || block.timestamp > p.deadline) revert BadState();
        address holder = licenses[licenseId].holder;
        if (councilVoted[id][holder]) revert AlreadyVoted();
        councilVoted[id][holder] = true;
        if (support) p.yes++;
        else p.no++;
        emit CouncilVoted(id, holder, licenseId, support, reason);
    }

    /// Thông qua khi số chủ đồng ý > 2/3 số chủ đang có giấy phép (ngưỡng chống gian kiểu BFT).
    function passed(uint256 id) public view returns (bool) {
        Proposal storage p = proposals[id];
        return councilHolders > 0 && uint256(p.yes) * 3 > uint256(councilHolders) * 2;
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

    /// Ngân sách ngày của một nghề (việc tự tìm): số việc thị trường cần mỗi ngày, tính trên TẤT CẢ thợ.
    /// Vượt ngân sách thì giá mỗi việc tự giảm: giá × ngân sách ÷ số việc đã duyệt trong ngày. 0 = không điều chỉnh.
    function setDailyBudget(uint256 id, uint32 budget) external onlyGov {
        dailyBudget[id] = budget;
        emit DailyBudgetSet(id, budget);
    }

    /// Giá việc tự tìm KẾ TIẾP của nghề này trong hôm nay (đã tính tự giảm khi cung vượt cầu).
    function currentReward(uint256 id) public view returns (uint256) {
        return _priceAt(id, uint256(acceptedPerDay[id][block.timestamp / 1 days]) + 1);
    }

    function _priceAt(uint256 id, uint256 n) internal view returns (uint256) {
        uint256 r = categories[id].reward;
        uint256 b = dailyBudget[id];
        return (b == 0 || n <= b) ? r : (r * b) / n;
    }

    function _takeReward(uint256 id) internal returns (uint256) {
        uint256 n = ++acceptedPerDay[id][block.timestamp / 1 days];
        return _priceAt(id, n);
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
        _notBraked();
        _requireAgent(workerLicense, Role.Worker);
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
        drawBlock[id] = block.number + DRAW_DELAY;
        emit JobSubmitted(id, workerLicense, result, uri);
    }

    // ---------- việc người giao ----------

    /// Khách ký quỹ AGT để giao việc cho một thợ.
    function assign(uint256 workerLicense, uint256 amount, bytes32 spec, uint64 deadline) external nonReentrant returns (uint256 id) {
        _notBraked();
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
        _requireAgent(j.workerLicense, Role.Worker);
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
        disputedAt[id] = uint64(block.timestamp);
        drawBlock[id] = block.number + DRAW_DELAY; // người phân xử được BỐC THĂM, không ai tự chọn (audit F-9)
        emit JobDisputed(id);
    }

    /// Khiếu nại quá DISPUTE_LIMIT mà chưa phân xử xong (ít chủ, phiếu chia, hết hạn bốc): ai cũng gọi được.
    /// Bên nhiều phiếu hơn nhận ký quỹ; hoà (kể cả 0–0) thì chia đôi. Không ai giữ được tiền mãi.
    function settleDispute(uint256 id) external nonReentrant {
        Job storage j = jobs[id];
        if (j.kind != Kind.Assigned || j.status != Status.Disputed) revert BadState();
        if (block.timestamp <= disputedAt[id] + DISPUTE_LIMIT) revert TooEarly();
        uint256 amt = j.escrow;
        uint256 toWorker = j.yes > j.no ? amt : j.no > j.yes ? 0 : amt / 2;
        uint256 toClient = amt - toWorker;
        j.escrow = 0;
        j.status = toWorker >= toClient ? Status.Accepted : Status.Refunded;
        IERC20 t = IERC20(address(agt));
        if (toWorker != 0) t.safeTransfer(licenses[j.workerLicense].holder, toWorker);
        if (toClient != 0) t.safeTransfer(j.client, toClient);
        emit DisputeSettled(id, j.yes, j.no, toWorker, toClient);
    }

    /// Thợ không nộp trước hạn thì ký quỹ về lại khách. Ai cũng gọi được (Codex C-1: khách mất ví hay là
    /// một hợp đồng thì tiền vẫn không kẹt), nhưng tiền CHỈ về ví khách.
    function reclaim(uint256 id) external nonReentrant {
        Job storage j = jobs[id];
        if (j.kind != Kind.Assigned) revert NotAllowed();
        if (j.status != Status.Open || block.timestamp <= j.deadline) revert BadState();
        _refund(id, j);
    }

    // ---------- nghiệm thu ----------

    /// Ai cũng gọi được (thường là chính AI thợ). Bốc đủ số phiếu còn thiếu, mỗi người một CHỦ khác nhau,
    /// không cùng chủ với thợ, chưa từng bỏ phiếu việc này. Người được bốc có REVIEW_WINDOW để bỏ phiếu;
    /// quá hạn thì bốc lượt mới (phiếu đã bỏ vẫn giữ, người cũ chưa bỏ phiếu mất quyền).
    function drawReviewers(uint256 id) external returns (uint256[] memory picked) {
        Job storage j = jobs[id];
        bool disputed = j.kind == Kind.Assigned && j.status == Status.Disputed;
        if (!disputed && (j.kind != Kind.SelfFound || j.status != Status.Submitted)) revert BadState();
        uint64 last = drawnAt[id];
        if (last == type(uint64).max) revert BadState(); // khiếu nại đã hết hạn bốc: chờ settleDispute
        if (last != 0) {
            // Lượt trước quá hạn: hẹn khối hạt giống MỚI (hạt cũ đã quá 256 khối). Lần gọi sau mới bốc.
            if (block.timestamp < last + REVIEW_WINDOW) revert TooEarly();
            drawnAt[id] = 0;
            drawBlock[id] = block.number + DRAW_DELAY;
            emit RedrawScheduled(id, drawBlock[id]);
            return picked;
        }
        uint256 b = drawBlock[id];
        if (block.number <= b) revert TooEarly();
        bytes32 h = blockhash(b);
        if (h == bytes32(0)) {
            // Quá 256 khối mà chưa ai bốc: việc bị huỷ, KHÔNG hẹn khối mới. Nếu cho hẹn lại, thợ gian lận
            // (kết quả bốc ai cũng tính trước được) sẽ chờ cho hết hạn đến khi bốc trúng người quen.
            // Thợ trung thực luôn bốc ngay để được trả công; AI nghiệm thu cũng có lợi khi bốc sớm.
            // Khiếu nại: không huỷ (tiền khách đang ký quỹ) — chờ DISPUTE_LIMIT rồi chốt theo phiếu đã có.
            if (disputed) {
                drawnAt[id] = type(uint64).max;
                emit DrawExpired(id);
                return picked;
            }
            j.status = Status.Rejected;
            emit DrawExpired(id);
            emit JobRejected(id);
            return picked;
        }
        uint256 need;
        if (disputed) {
            // Đủ người để một bên chắc chắn đạt ngưỡng: 2·ngưỡng − 1, trừ phiếu đã có. Ít chủ thì bốc hết số có thể.
            uint256 total = 2 * uint256(disputeApprovals) - 1;
            need = total > uint256(j.yes) + j.no ? total - j.yes - j.no : 1;
        } else {
            uint8 approvals = categories[j.category].approvals;
            need = approvals > j.yes ? approvals - j.yes : 1;
        }
        uint32 round = ++drawRound[id];
        picked = _pick(id, round, keccak256(abi.encode(h, id, round)), need, disputed);
        drawnAt[id] = uint64(block.timestamp);
        emit ReviewersDrawn(id, round, picked);
    }

    function _pick(uint256 id, uint32 round, bytes32 seed, uint256 need, bool allowFewer) internal returns (uint256[] memory picked) {
        uint256[] memory pool = verifierList; // bản sao trong bộ nhớ để xáo
        uint256 n = pool.length;
        picked = new uint256[](need);
        address[] memory owners = new address[](need);
        uint256 got;
        for (uint256 i; i < n && got < need; i++) {
            uint256 r = i + (uint256(keccak256(abi.encode(seed, i))) % (n - i)); // xáo Fisher–Yates từng bước
            (pool[i], pool[r]) = (pool[r], pool[i]);
            address o = licenses[pool[i]].holder;
            if (!_eligible(id, o) || _seen(owners, got, o)) continue;
            owners[got] = o;
            picked[got++] = pool[i];
            assigned[id][round][pool[i]] = true;
        }
        if (got == 0 || (got < need && !allowFewer)) revert NotEnoughReviewers();
        assembly {
            mstore(picked, got) // cắt mảng về số người thực bốc được
        }
    }

    function _eligible(uint256 id, address o) internal view returns (bool) {
        Job storage j = jobs[id];
        return o != licenses[j.workerLicense].holder && o != j.client && !ownerVoted[id][o];
    }

    function _seen(address[] memory owners, uint256 count, address o) internal pure returns (bool) {
        for (uint256 k; k < count; k++) if (owners[k] == o) return true;
        return false;
    }

    function vote(uint256 id, uint256 verifierLicense, bool approve, string calldata reason) external nonReentrant {
        _requireAgent(verifierLicense, Role.Verifier);
        if (bytes(reason).length == 0) revert NoReason();
        Job storage j = jobs[id];
        bool selfFound = j.kind == Kind.SelfFound && j.status == Status.Submitted;
        bool disputed = j.kind == Kind.Assigned && j.status == Status.Disputed;
        if (!selfFound && !disputed) revert BadState();
        address v = licenses[verifierLicense].holder;
        if (v == licenses[j.workerLicense].holder || v == j.client || msg.sender == j.client) revert NotAllowed();
        if (voted[id][verifierLicense] || ownerVoted[id][v]) revert AlreadyVoted();
        // chỉ người được bốc, và chỉ trong hạn của lượt (Codex E-1: quá hạn thì lượt đó hết quyền, chờ bốc lại)
        uint64 at = drawnAt[id];
        if (at == 0 || at == type(uint64).max || block.timestamp > at + REVIEW_WINDOW || !assigned[id][drawRound[id]][verifierLicense]) revert NotAllowed();
        voted[id][verifierLicense] = true;
        ownerVoted[id][v] = true;
        emit Voted(id, verifierLicense, approve, reason);

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
                    uint256 r = _takeReward(j.category);
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

    function verifierCount() external view returns (uint256) {
        return verifierList.length;
    }

    function yesVoters(uint256 id) external view returns (uint256[] memory) {
        return _yesVoters[id];
    }

    function noVoters(uint256 id) external view returns (uint256[] memory) {
        return _noVoters[id];
    }

    // ---------- nội bộ ----------

    /// Hành động của AI phải ký bằng KHOÁ AI (agent), không phải ví chủ. role = None: vai trò nào cũng được.
    function _requireAgent(uint256 licenseId, Role role) internal view {
        License storage l = licenses[licenseId];
        if (l.role == Role.None || !l.active || (role != Role.None && l.role != role)) revert BadLicense();
        if (l.agent != msg.sender) revert NotAllowed();
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
