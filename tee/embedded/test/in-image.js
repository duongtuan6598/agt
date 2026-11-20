// Run INSIDE the embedded image (as root, like the box): checks the toolchain, the simulator, the analysis
// and the sandbox. `docker run --rm --entrypoint node <image> /agt/tee/embedded/test/in-image.js`
const fs = require("fs");
const { execSync } = require("child_process");
const T = require("../tools.js");

(async () => {
  const fail = [];
  const check = (name, ok, extra = "") => { console.log(`${ok ? "✔" : "✘"} ${name}${extra ? " — " + extra : ""}`); if (!ok) fail.push(name); };
  const work = "/work/job";
  execSync(`rm -rf ${work} && mkdir -p ${work} && cp -r /agt/tee/embedded/fixtures/* ${work}/ && chown -R builder:builder /work`);

  const b = await T.build({ dir: `${work}/hello-cm3`, cmd: "make", artifact: "firmware.elf" });
  check("N1 build (arm-none-eabi-gcc, as builder)", b.ok && b.warnings === 0, `sha256 ${b.sha256}`);
  const s = await T.size({ elf: `${work}/hello-cm3/firmware.elf`, flashLimit: 4096, ramLimit: 1024 });
  check("N4 size within budget (every allocated section, parsed as builder)", s.ok, `flash ${s.flash} B, RAM ${s.ram} B, ${s.sections} sections`);
  const tight = await T.size({ elf: `${work}/hello-cm3/firmware.elf`, flashLimit: 100 });
  check("N4 size over budget fails", !tight.ok);
  fs.writeFileSync(`${work}/hello-cm3/test_crc.c`, "/* client's test */\n");
  const pin = { "test_crc.c": require("crypto").createHash("sha256").update(fs.readFileSync(`${work}/hello-cm3/test_crc.c`)).digest("hex") };
  check("N2 pinned client tests unchanged → runs", (await T.unitTests({ dir: `${work}/hello-cm3`, cmd: "true", pinned: pin })).ok);
  fs.writeFileSync(`${work}/hello-cm3/test_crc.c`, "/* weakened by the worker */\n");
  check("N2 a changed pinned test fails (S-3)", !(await T.unitTests({ dir: `${work}/hello-cm3`, cmd: "true", pinned: pin })).ok);
  const q = await T.simulate({ elf: `${work}/hello-cm3/firmware.elf`, target: "cortex-m3", expect: ["AGT firmware OK crc="] });
  check("N3 simulation in QEMU (lm3s6965, semihosting)", q.ok, q.output.trim());
  const supHash = require("crypto").createHash("sha256").update(fs.readFileSync("/agt/tee/embedded/fixtures/hello-cm3/.cppcheck-suppress")).digest("hex");
  const unpinned = await T.staticAnalysis({ dir: `${work}/hello-cm3` });
  check("N4 a suppression list NOT pinned in the brief is ignored (S-5)", !unpinned.ok && !unpinned.suppressionsUsed);
  const clean = await T.staticAnalysis({ dir: `${work}/hello-cm3`, suppressionsSha256: supHash });
  check("N4 static analysis: clean firmware has no findings", clean.ok && clean.findings.length === 0);
  const bug = await T.staticAnalysis({ dir: `${work}/bug`, baseline: clean.baseline });
  check("N4 static analysis catches the seeded overflow", !bug.ok && bug.newFindings.some((f) => /arrayIndexOutOfBounds|bufferAccessOutOfBounds/.test(f.id)), bug.newFindings.map((f) => f.id).join(","));

  // Sandbox: the client's code cannot read the box's secrets.
  fs.writeFileSync("/run/agt-secret", "master-secret", { mode: 0o600 });
  const peek = await T.run("/bin/sh", ["-c", "cat /run/agt-secret; head -c 300 /proc/1/environ; echo; id -u"], { cwd: work });
  check("sandbox: runs as uid 1500", /\b1500\b/.test(peek.out));
  check("sandbox: cannot read a root-only secret file", !peek.out.includes("master-secret"));
  check("sandbox: cannot read the box process environment", !/AGENT_KEY|PATH=/.test(peek.out.split("\n").slice(1).join("\n")) || /Permission denied/.test(peek.out));
  const env = await T.run("/bin/sh", ["-c", "env"], { cwd: work });
  check("sandbox: clean environment (nothing inherited)", !/AGT_|MODEL|KEY/.test(env.out), env.out.split("\n").filter(Boolean).join(" "));
  const loop = await T.run("/bin/sh", ["-c", "(sleep 30; touch /work/job/escaped) & while :; do :; done"], { cwd: work, timeoutMs: 1500 });
  await new Promise((r) => setTimeout(r, 300));
  const ps = execSync("ps -o user,args | grep -c '[s]leep 30' || true").toString().trim();
  check("sandbox: a timeout kills the whole process group, background children too (S-6)", loop.timedOut && ps === "0", `left running: ${ps}`);
  const lim = await T.run("/bin/sh", ["-c", "ulimit -u; ulimit -t"], { cwd: work });
  check("sandbox: resource limits applied (processes, CPU time)", /512/.test(lim.out) && /900/.test(lim.out), lim.out.replace(/\n/g, " "));

  const r = T.report([b, s, q, clean]);
  check("N1–N4 report", r.ok, r.hash);
  process.exit(fail.length ? 1 : 0);
})();
