// tools/sealed-backup.js on a throwaway repo (never the real bank).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const B = require("../tools/sealed-backup.js");

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", env });
const PASS = "a long test phrase written on paper";

test("backup → verify → restore gives back every commit; wrong passphrase or tampering is refused", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agtbak-t-"));
  const repo = path.join(tmp, "bank");
  fs.mkdirSync(repo);
  git(["init", "-q"], repo);
  fs.writeFileSync(path.join(repo, "embedded.json"), JSON.stringify({ q: "secret question" }));
  git(["add", "-A"], repo); git(["commit", "-q", "-m", "1"], repo);
  fs.writeFileSync(path.join(repo, "more.json"), "{}");
  git(["add", "-A"], repo); git(["commit", "-q", "-m", "2"], repo);

  const out = path.join(tmp, "bank.agtbak");
  B.backup(repo, out, PASS);
  assert.ok(!fs.readFileSync(out).includes(Buffer.from("secret question")), "the file is ciphertext");
  assert.equal(B.verify(out, repo, PASS).ok, true);
  const back = path.join(tmp, "back");
  B.restore(out, back, PASS);
  assert.equal(fs.readFileSync(path.join(back, "embedded.json"), "utf8"), JSON.stringify({ q: "secret question" }));
  assert.equal(git(["log", "--format=%H"], back), git(["log", "--format=%H"], repo));

  assert.throws(() => B.verify(out, repo, PASS + "x"), /wrong passphrase/);
  const bad = Buffer.from(fs.readFileSync(out)); bad[bad.length - 5] ^= 1; fs.writeFileSync(out + ".bad", bad);
  assert.throws(() => B.restore(out + ".bad", path.join(tmp, "x"), PASS), /wrong passphrase or damaged/);

  fs.writeFileSync(path.join(repo, "uncommitted.json"), "{}");
  assert.throws(() => B.backup(repo, out, PASS), /uncommitted/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
