// Run INSIDE the embedded image as root (like the box): a hostile client repository and hostile build code try to
// make the box's root process leak or overwrite its secrets, or run their code as root.
//   docker run --rm -v <agt>/tee/embedded/test:/agt/tee/embedded/test:ro --entrypoint node agt-box-embedded /agt/tee/embedded/test/workspace-attack.js
const fs = require("fs");
const path = require("path");
const { execFileSync, execSync } = require("child_process");
const { Workspace } = require("../workspace.js");
const T = require("../tools.js");

let bad = 0;
const check = (name, ok, why = "") => { console.log(`${ok ? "✔" : "✘"} ${name}${why ? " — " + why : ""}`); if (!ok) bad++; };
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: "/tmp", GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } });

(async () => {
  // The box's secret (root only).
  fs.mkdirSync("/run/agt", { recursive: true, mode: 0o700 });
  fs.writeFileSync("/run/agt/master", "BOX-MASTER-SECRET", { mode: 0o600 });

  // A hostile repository: a committed symlink pointing at the box's secret.
  const src = "/tmp/hostile-src", bare = "/tmp/hostile.git";
  execSync(`rm -rf ${src} ${bare}`);
  git(["init", "-q", "--bare", bare]);
  git(["init", "-q", src]);
  fs.writeFileSync(path.join(src, "main.c"), "int main(void){return 0;}\n");
  fs.symlinkSync("/run/agt/master", path.join(src, "leak.c"));
  git(["add", "-A"], src);
  git(["commit", "-q", "-m", "init"], src);
  git(["push", "-q", bare, "HEAD:refs/heads/main"], src);
  git(["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);

  const ws = new Workspace({ root: "/var/agt/ws", id: "attack", allowFileUrls: true, git: "/usr/bin/git" });
  ws.clone("file://" + bare, "SECRET-REPO-TOKEN", "agt/attack");
  check("clone works; the tree belongs to the sandbox user", fs.statSync(path.join(ws.tree, "main.c")).uid === 1500);

  // 1. The model is shown repository files: a symlink to the secret must never be read by root.
  const { files } = ws.read();
  check("root never reads through a committed symlink", !files.some((f) => f.content.includes("BOX-MASTER-SECRET")) && !files.some((f) => f.path === "leak.c"));

  // 2. Root must not write through a symlink the client planted (committed, or created during the build).
  let refused = false;
  try { ws.write([{ path: "leak.c", content: "overwritten" }]); } catch { refused = true; }
  check("root refuses to write through a committed symlink", refused && fs.readFileSync("/run/agt/master", "utf8") === "BOX-MASTER-SECRET");
  await T.run("/bin/sh", ["-c", "mkdir -p src && ln -sf /run/agt/master src/uart.c && ln -sfn /run/agt subdir"], { cwd: ws.tree });
  refused = false;
  try { ws.write([{ path: "src/uart.c", content: "overwritten" }]); } catch { refused = true; }
  check("root refuses to write through a symlink made during the build", refused && fs.readFileSync("/run/agt/master", "utf8") === "BOX-MASTER-SECRET");
  refused = false;
  try { ws.write([{ path: "subdir/master", content: "overwritten" }]); } catch { refused = true; }
  check("root refuses to write through a symlinked directory", refused && fs.readFileSync("/run/agt/master", "utf8") === "BOX-MASTER-SECRET");

  // 3. The client's code plants a git dir with a hook and hostile config in the tree; root then commits.
  await T.run("/bin/sh", ["-c", "rm -f src/uart.c subdir; mkdir -p .git/hooks && printf '#!/bin/sh\\ntouch /tmp/PWNED\\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit && printf '[core]\\n\\tfsmonitor = touch /tmp/PWNED2\\n' > .git/config"], { cwd: ws.tree });
  ws.write([{ path: "src/uart.c", content: "void uart_init(void) {}\n" }]);
  const sha = ws.commit("deliver");
  check("commit works (40-hex sha)", /^[0-9a-f]{40}$/.test(sha));
  check("no hook or config planted in the tree ran as root", !fs.existsSync("/tmp/PWNED") && !fs.existsSync("/tmp/PWNED2"));

  // 4. The sandbox cannot read the git dir (where root keeps the repository's state).
  const peek = await T.run("/bin/sh", ["-c", `cat ${ws.gitDir}/config 2>&1; ls ${ws.gitDir} 2>&1`], { cwd: ws.tree });
  check("the sandbox cannot read root's git dir", /Permission denied/.test(peek.out) && !/\[core\]/.test(peek.out));

  // 5. The token never appears where the sandbox can look (argv of any process, files in the tree).
  // The search string is assembled at run time, so this probe's own command line does not contain the token.
  const b64 = Buffer.from("x-access-token:SECRET-REPO-TOKEN").toString("base64");
  const probe = `A=SECRET-REPO; B=TOKEN; C=${b64.slice(0, 10)}; D=${b64.slice(10)}; ` +
    `echo P $(cat /proc/*/cmdline /proc/*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c -e "$A-$B" -e "$C$D"); ` +
    `echo F $(grep -rl -e "$A-$B" -e "$C$D" . 2>/dev/null | wc -l)`;
  const scan = await T.run("/bin/sh", ["-c", probe], { cwd: ws.tree });
  const inProc = Number((/P (\d+)/.exec(scan.out) || [])[1]);
  const inFiles = Number((/F (\d+)/.exec(scan.out) || [])[1]);
  check("the repository token is not visible to the sandbox (process args, environments, files)", inProc === 0 && inFiles === 0, scan.out.trim().replace(/\n/g, " "));

  // 6. Pinned client tests cannot be changed by the model.
  refused = false;
  try { ws.write([{ path: "main.c", content: "x" }], { "main.c": "ab" }); } catch { refused = true; }
  check("a file pinned by the client cannot be changed", refused);

  console.log(bad ? `${bad} check(s) failed` : "all workspace attack checks passed");
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
