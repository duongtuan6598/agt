// Run INSIDE the builder image as root (Codex L-2): the build can reach the job bucket (here a local directory it
// can write, like the bucket through the metadata token). A detached process left by the build tries to overwrite
// result.json after the build — the supervisor kills every sandbox process before writing the signed result.
//   docker run --rm -v <agt>/tee/embedded/test:/agt/tee/embedded/test:ro --entrypoint node agt-builder /agt/tee/embedded/test/builder-order.js
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { runBuilder } = require("../../builder/main.js");
const R = require("../builder.js");
const T = require("../tools.js");
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: "/tmp", GIT_AUTHOR_NAME: "c", GIT_AUTHOR_EMAIL: "c@c", GIT_COMMITTER_NAME: "c", GIT_COMMITTER_EMAIL: "c@c" } });
(async () => {
  const src = "/tmp/fw";
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "main.c"), "int main(void){return 0;}\n");
  git(["init", "-q"], src); git(["add", "-A"], src); git(["commit", "-q", "-m", "m"], src);
  const commit = git(["rev-parse", "HEAD"], src).trim();
  const bucket = "/tmp/bucket";
  fs.mkdirSync(bucket, { recursive: true });
  execFileSync("chown", ["1500:1500", bucket]); // the build can write here, as through the bucket-only token
  const attack = `(sleep 3; echo FORGED > ${bucket}/result.json) >/dev/null 2>&1 & echo started`;
  fs.writeFileSync(path.join(bucket, "spec.json"), JSON.stringify({ dispute: 9, commit, commands: [attack], imageDigest: "sha256:x" }));
  const io = { get: async (k) => (fs.existsSync(path.join(bucket, k)) ? fs.readFileSync(path.join(bucket, k), "utf8") : null), put: async (k, v) => fs.writeFileSync(path.join(bucket, k), v) };
  const sleep = async () => {
    const j = JSON.parse(await io.get("job.json"));
    await io.put("source.sealed", JSON.stringify(R.exportBundle({ gitBin: "git", gitDir: path.join(src, ".git"), commit, manifest: j.manifest })));
  };
  await runBuilder({ io, attest: async () => ({ token: "test" }), tools: T, sleep, pollSec: 0 });
  await new Promise((r) => setTimeout(r, 5000)); // longer than the attacker's delay
  const res = fs.readFileSync(path.join(bucket, "result.json"), "utf8");
  let parsed = null; try { parsed = JSON.parse(res); } catch {}
  const ok = res.trim() !== "FORGED" && !!parsed && parsed.result && parsed.result.schema === "agt-repro/v1";
  if (!ok) console.log("result.json was:", res.slice(0, 300));
  console.log(`${ok ? "✔" : "✘"} a process left behind by the build cannot overwrite the signed result (killed before the result is written)`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
