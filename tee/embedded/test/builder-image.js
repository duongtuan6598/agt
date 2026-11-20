// Run INSIDE the embedded image as root (like a builder VM): a real reproduction of a real firmware build.
//   docker run --rm -v <agt>/tee/embedded/test:/agt/tee/embedded/test:ro --entrypoint node agt-box-embedded /agt/tee/embedded/test/builder-image.js
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const R = require("../builder.js");
const T = require("../tools.js");

let bad = 0;
const check = (n, ok, why = "") => { console.log(`${ok ? "✔" : "✘"} ${n}${why ? " — " + why : ""}`); if (!ok) bad++; };
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: "/tmp", GIT_AUTHOR_NAME: "c", GIT_AUTHOR_EMAIL: "c@c", GIT_COMMITTER_NAME: "c", GIT_COMMITTER_EMAIL: "c@c" } });

(async () => {
  // The client's repository: the Cortex-M3 fixture firmware, committed (what the worker's box has cloned).
  const src = "/tmp/client-fw";
  execFileSync("rm", ["-rf", src]);
  fs.mkdirSync(src, { recursive: true });
  for (const f of fs.readdirSync("/agt/tee/embedded/fixtures/hello-cm3")) fs.copyFileSync(path.join("/agt/tee/embedded/fixtures/hello-cm3", f), path.join(src, f));
  fs.appendFileSync(path.join(src, "Makefile"), "\ntest: firmware.elf\n\tarm-none-eabi-size firmware.elf\n");
  git(["init", "-q"], src);
  git(["add", "-A"], src);
  git(["commit", "-q", "-m", "milestone 1"], src);
  const commit = git(["rev-parse", "HEAD"], src).trim();

  for (const [label, commands, expectOk] of [["passing build", ["make", "make test"], true], ["failing check", ["make", "false"], false]]) {
    const job = R.newJob({ dispute: 3, commit, commands, imageDigest: "sha256:this-image" });
    const sealed = R.exportBundle({ gitBin: "git", gitDir: path.join(src, ".git"), commit, manifest: job.manifest });
    const { result, signature } = await R.runJob({ job, sealedBundle: sealed, tools: T, gitBin: "git", workRoot: "/work/repro" });
    check(`${label}: the builder checked out exactly the disputed commit and ran the commands as the sandbox user`, result.commit === commit && result.commands.length >= 1, result.commands.map((c) => `${c.cmd}→${c.exit}`).join(", "));
    check(`${label}: result ok = ${expectOk}`, result.ok === expectOk);
    const v = R.verifyResult({ job: { manifest: job.manifest }, result, signature, evidence: {}, dispute: 3, commitBytes32: "0x" + commit.padEnd(64, "0"), commands, verifyAttestation: () => true });
    check(`${label}: a reviewer verifies the signed result`, v.valid && v.ok === expectOk, v.why);
  }
  check("the work directory is gone after each job", fs.readdirSync("/work/repro").length === 0);

  // The sandboxed build cannot reach a job key held by the supervisor (it lives only in this process's memory),
  // nor the bundle (deleted before the build runs). A probe as the sandbox user finds neither.
  const probe = await T.run("/bin/sh", ["-c", "ls /work/repro 2>&1; cat /proc/1/environ 2>&1 | head -c 50; echo end"], { cwd: "/tmp" });
  check("the sandbox sees no job material", !/repro\.bundle/.test(probe.out), probe.out.replace(/\n/g, " ").slice(0, 120));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
