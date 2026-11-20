// The embedded trade's tools inside the sealed box (THIET-KE-NGHE-NHUNG.md §3, §9): the objective checks N1–N4.
//   N1 build      — the agreed build command, toolchain pinned by the image; the artifact's sha256
//   N2 unit tests — the agreed test command; the test files are PINNED by hash in the brief (the worker AI
//                   cannot weaken the client's tests to make them pass — Codex S-3)
//   N3 simulation — the firmware runs in QEMU (Cortex-M / RISC-V) with semihosting; the expected output and
//                   the scenario come from the brief, not from the repository
//   N4 budgets    — flash/RAM from EVERY allocated ELF section (fail closed — S-4), static analysis (cppcheck)
//                   with no new findings; a suppression list counts only if its hash is pinned in the brief (S-5)
//
// The client's code is UNTRUSTED. Everything that touches it — building, running, even PARSING its ELF (S-1) —
// runs as the unprivileged user `builder` with a clean environment (no keys, no tokens), resource limits
// (CPU time, memory, processes, file size) and a time limit that kills the whole process group (S-6).
// Repository tokens are used only by the box's own process to clone; they never enter the work directory.
// Known gap (README): no network namespace yet — `builder` can reach the network, but can read nothing secret.
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SANDBOX_USER = { uid: Number(process.env.AGT_BUILDER_UID || 1500), gid: Number(process.env.AGT_BUILDER_GID || 1500) };
const MAX_OUTPUT = 512 * 1024;
const LIMITS = ["--cpu=900", "--as=4294967296", "--nproc=512", "--fsize=1073741824", "--nofile=1024"];

/// Run one command as the sandbox user, in its own process group. Returns { code, out, timedOut }.
function run(cmd, args, { cwd, timeoutMs = 120000, input = null } = {}) {
  return new Promise((resolve) => {
    const root = process.getuid && process.getuid() === 0;
    const opts = {
      cwd,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: cwd || "/tmp", LANG: "C.UTF-8" }, // nothing inherited
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // its own process group: a timeout kills every descendant
    };
    if (root) Object.assign(opts, SANDBOX_USER);
    const hasPrlimit = fs.existsSync("/usr/bin/prlimit");
    const [c, a] = hasPrlimit ? ["/usr/bin/prlimit", [...LIMITS, "--", cmd, ...args]] : [cmd, args];
    let out = "";
    let timedOut = false;
    const p = spawn(c, a, opts);
    const add = (b) => { if (out.length < MAX_OUTPUT) out += b.toString(); };
    p.stdout.on("data", add);
    p.stderr.on("data", add);
    const killAll = () => { try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch {} } };
    const t = setTimeout(() => { timedOut = true; killAll(); }, timeoutMs);
    p.on("error", (e) => { clearTimeout(t); resolve({ code: -1, out: String(e.message), timedOut }); });
    p.on("close", (code) => { clearTimeout(t); killAll(); resolve({ code, out: out.slice(0, MAX_OUTPUT), timedOut }); });
    if (input) p.stdin.end(input);
    else p.stdin.end();
  });
}

const sh = (line, o) => run("/bin/sh", ["-c", line], o);
const sha256File = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

/// Check files against hashes pinned in the brief: { "tests/test_uart.c": "<sha256>", … }. Paths stay inside dir.
function checkPinned(dir, pinned = {}) {
  const bad = [];
  const root = fs.realpathSync(dir);
  for (const [rel, want] of Object.entries(pinned)) {
    const f = path.resolve(root, rel);
    let real = null;
    try { real = fs.realpathSync(f); } catch {}
    if (!real || !real.startsWith(root + path.sep) || !fs.statSync(real).isFile() || sha256File(real) !== want) bad.push(rel);
  }
  return bad;
}

/// N1: build. `artifact` is the ELF path relative to dir.
async function build({ dir, cmd, artifact, timeoutMs = 600000 }) {
  const r = await sh(cmd, { cwd: dir, timeoutMs });
  const elf = path.join(dir, artifact);
  const ok = r.code === 0 && !r.timedOut && fs.existsSync(elf) && fs.realpathSync(elf).startsWith(fs.realpathSync(dir));
  const warnings = (r.out.match(/warning:/g) || []).length;
  return { level: "N1", ok, warnings, sha256: ok ? sha256File(elf) : null, log: r.out.slice(-4000) };
}

/// N2: the agreed test command; the client's test files must be exactly the pinned ones.
async function unitTests({ dir, cmd, pinned = {}, timeoutMs = 600000 }) {
  const tampered = checkPinned(dir, pinned);
  if (tampered.length) return { level: "N2", ok: false, tampered, log: "pinned test files changed: " + tampered.join(", ") };
  const r = await sh(cmd, { cwd: dir, timeoutMs });
  return { level: "N2", ok: r.code === 0 && !r.timedOut, tampered, log: r.out.slice(-4000) };
}

const QEMU = {
  "cortex-m3": { bin: "qemu-system-arm", machine: "lm3s6965evb" },
  "cortex-m4": { bin: "qemu-system-arm", machine: "netduinoplus2" },
  "riscv32": { bin: "qemu-system-riscv32", machine: "virt", bios: "none" },
};

/// N3: run the firmware in QEMU; pass when every expected line from the BRIEF appears and it exits 0.
/// Semihosting runs as `builder` (the firmware's host file access is the sandbox's, inside its own work dir).
async function simulate({ elf, target = "cortex-m3", expect = [], serial = false, timeoutMs = 20000 }) {
  const q = QEMU[target];
  if (!q) throw new Error(`no simulator for ${target}`);
  // serial: the first UART goes to the captured output (driver checks); otherwise only semihosting output counts
  const args = ["-M", q.machine, "-nographic", "-semihosting-config", "enable=on,target=native", "-kernel", elf, "-monitor", "none", "-serial", serial ? "stdio" : "null", "-nic", "none"];
  if (q.bios) args.push("-bios", q.bios);
  const r = await run(q.bin, args, { cwd: path.dirname(elf), timeoutMs });
  const missing = expect.filter((e) => !r.out.includes(e));
  return { level: "N3", ok: r.code === 0 && !r.timedOut && missing.length === 0 && expect.length > 0, exitCode: r.code, timedOut: r.timedOut, missing, output: r.out.slice(-4000) };
}

/// N4a: flash and RAM from EVERY allocated section (readelf flags; fail closed on parse errors).
///   alloc + NOBITS (bss, stack, heap…)      → RAM only
///   alloc + PROGBITS + writable (data…)     → flash (initial values) and RAM
///   alloc + PROGBITS, not writable          → flash
async function size({ elf, flashLimit, ramLimit, tool = "arm-none-eabi-readelf" }) {
  const r = await run(tool, ["-S", "-W", path.basename(elf)], { cwd: path.dirname(elf), timeoutMs: 30000 });
  let flash = 0, ram = 0, sections = 0;
  for (const line of r.out.split("\n")) {
    const m = /^\s*\[\s*\d+\]\s+(\S+)\s+(\S+)\s+[0-9a-f]+\s+[0-9a-f]+\s+([0-9a-f]+)\s+[0-9a-f]+\s+([A-Za-z]*)\s/.exec(line);
    if (!m || !m[4].includes("A")) continue;
    const [, , type, sizeHex, flags] = m;
    const n = parseInt(sizeHex, 16);
    sections++;
    if (type === "NOBITS") ram += n;
    else if (flags.includes("W")) { flash += n; ram += n; }
    else flash += n;
  }
  const parsed = r.code === 0 && !r.timedOut && sections > 0;
  return { level: "N4", check: "size", ok: parsed && (!flashLimit || flash <= flashLimit) && (!ramLimit || ram <= ramLimit), flash, ram, flashLimit, ramLimit, sections };
}

/// N4b: static analysis. Only NEW findings fail (against a baseline of exact findings). The repository's
/// `.cppcheck-suppress` is honoured only if its sha256 is pinned in the brief (`suppressionsSha256`).
async function staticAnalysis({ dir, paths = ["."], baseline = [], suppressionsSha256 = null }) {
  const supFile = path.join(dir, ".cppcheck-suppress");
  const pinnedOk = suppressionsSha256 && fs.existsSync(supFile) && checkPinned(dir, { ".cppcheck-suppress": suppressionsSha256 }).length === 0;
  const sup = pinnedOk ? ["--suppressions-list=.cppcheck-suppress"] : [];
  const r = await run("cppcheck", ["--enable=warning,portability", "--inconclusive", "--error-exitcode=0", "--template={file}:{line}:{id}:{message}", "--quiet", ...sup, ...paths], { cwd: dir, timeoutMs: 300000 });
  const findings = r.out.split("\n").map((l) => l.trim()).filter((l) => /^[^:]+:\d+:\w+:/.test(l)).map((l) => {
    const [file, line, id, ...msg] = l.split(":");
    return { file, line: Number(line), id, message: msg.join(":").trim() };
  });
  const key = (f) => `${f.file}:${f.id}:${f.message}`;
  const base = new Set(baseline);
  const fresh = findings.filter((f) => !base.has(key(f)));
  const ran = r.code === 0 && !r.timedOut;
  return { level: "N4", check: "static", ok: ran && fresh.length === 0, ran, suppressionsUsed: !!pinnedOk, findings, newFindings: fresh, baseline: findings.map(key) };
}

/// The N1–N4 report for one delivery; its hash goes on chain with the delivery (Engagement.deliver report).
/// `memoryHead` anchors the engagement memory (its latest hash) so a later rollback of it is detected (S-7).
function report(parts, { memoryHead = null } = {}) {
  const body = { schema: "agt-n-report/v1", at: new Date().toISOString(), ok: parts.every((p) => p.ok), memoryHead, parts };
  const text = JSON.stringify(body);
  return { text, hash: "0x" + crypto.createHash("sha256").update(text).digest("hex"), ok: body.ok };
}

module.exports = { run, build, unitTests, simulate, size, staticAnalysis, report, checkPinned, QEMU };
