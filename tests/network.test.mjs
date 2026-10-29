// Live checks against the real download services and a real server boot.
// Off by default; CI turns them on (push, PR and nightly) so upstream API
// changes — like Paper shutting down its v2 API — are caught within a day.
//   RUN_NETWORK_TESTS=1 node --test tests/network.test.mjs
//   RUN_BOOT_TEST=1 MC_BOOT_VERSION=1.21.1 node --test tests/network.test.mjs   (needs Java 21)
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = fileURLToPath(new URL("../mc-local.mjs", import.meta.url));
const NET = process.env.RUN_NETWORK_TESTS === "1";
const BOOT = process.env.RUN_BOOT_TEST === "1";
const VERSION = process.env.MC_TEST_VERSION || "1.21.1";

const run = (args, opts = {}) => new Promise((ok) => execFile(process.execPath, [CLI, ...args], { timeout: 600000, ...opts },
  (e, out, err) => ok({ code: e ? e.code : 0, out, err })));

for (const type of ["paper", "vanilla", "fabric", "purpur"]) {
  test(`${type} ${VERSION}: download URL resolves and is reachable`, { skip: !NET && "set RUN_NETWORK_TESTS=1" }, async () => {
    const r = await run(["install", type, VERSION, "--print-url"]);
    assert.equal(r.code, 0, r.err);
    const url = r.out.trim();
    assert.match(url, /^https:\/\//);
    const res = await fetch(url, { headers: { "User-Agent": "run-minecraft-server-cli-ci" } });
    assert.equal(res.status, 200, `${url} → ${res.status}`);
    await res.body.cancel();
  });
}

test("unknown paper version fails with an HTTP error, not a crash", { skip: !NET && "set RUN_NETWORK_TESTS=1" }, async () => {
  const r = await run(["install", "paper", "0.0.1", "--print-url"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /HTTP 404/);
});

test("real server: install paper, boot, console command, stop, backup", { skip: !BOOT && "set RUN_BOOT_TEST=1", timeout: 900000 }, async () => {
  const version = process.env.MC_BOOT_VERSION || VERSION;
  const dir = join(mkdtempSync(join(tmpdir(), "mcboot-")), "srv");
  assert.equal((await run(["init", dir, "--port", "25611", "--ram", "1024"])).code, 0);
  const inst = await run(["install", "paper", version, "--dir", dir]);
  assert.equal(inst.code, 0, inst.err);
  assert.ok(existsSync(join(dir, "server.jar")));

  let out = "";
  const server = spawn(process.execPath, [CLI, "start", dir], { stdio: ["pipe", "pipe", "pipe"] });
  server.stdout.on("data", (d) => (out += d));
  server.stderr.on("data", (d) => (out += d));
  const exited = new Promise((ok) => server.on("exit", ok));
  const deadline = Date.now() + 600000;
  while (!/Done \(/.test(out)) {
    if (Date.now() > deadline || server.exitCode !== null) assert.fail("server did not finish booting:\n" + out.slice(-3000));
    await new Promise((r) => setTimeout(r, 1000));
  }

  server.stdin.write("say ci-console-check\n");
  const sayDeadline = Date.now() + 30000;
  while (!/ci-console-check/.test(out) && Date.now() < sayDeadline) await new Promise((r) => setTimeout(r, 500));
  assert.match(out, /ci-console-check/, "console input reached the server");

  const stop = await run(["stop", dir]);
  assert.equal(stop.code, 0, stop.err);
  assert.equal(await exited, 0, "start exits 0 after stop:\n" + out.slice(-2000));

  const backup = await run(["backup", dir]);
  assert.equal(backup.code, 0, backup.err);
  assert.ok(readdirSync(dir).some((f) => f.startsWith("backup-")));
});
