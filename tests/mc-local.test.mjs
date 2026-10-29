// mc-local without network: argument handling, config, a full start/console/stop
// cycle against a fake Java, and a check that the real JVM accepts our flags.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = fileURLToPath(new URL("../mc-local.mjs", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "mclocal-"));

function run(args, opts = {}) {
  return new Promise((ok) => execFile(process.execPath, [CLI, ...args], { timeout: 30000, ...opts },
    (e, out, err) => ok({ code: e ? e.code : 0, out, err })));
}

function waitFor(getText, re, ms = 15000) {
  const deadline = Date.now() + ms;
  return new Promise((ok, fail) => {
    const poll = () => (re.test(getText()) ? ok() : Date.now() > deadline ? fail(new Error(`timed out waiting for ${re}\n${getText()}`)) : setTimeout(poll, 100));
    poll();
  });
}

/** A stand-in for `java`: records argv, prints Minecraft's ready line, echoes stdin, honours stop/SIGTERM. */
function fakeJava(dir) {
  const path = join(dir, "fake-java");
  writeFileSync(path, `#!${process.execPath}
require("fs").writeFileSync(${JSON.stringify(join(dir, "argv.json"))}, JSON.stringify(process.argv.slice(2)));
console.log("[Server] Done (0.1s)! For help, type \\"help\\"");
process.on("SIGTERM", () => { console.log("[Server] Saving worlds"); process.exit(143); });
require("readline").createInterface({ input: process.stdin }).on("line", (l) => {
  console.log("got: " + l);
  if (l === "stop") process.exit(0);
});
`);
  chmodSync(path, 0o755);
  return path;
}

test("help exits 0 and lists the commands", async () => {
  const r = await run(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /install <type> <ver>/);
});

test("unknown option is an error, not silently ignored", async () => {
  const r = await run(["start", "--rma", "2048"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /Unknown option '--rma'/);
});

test("init writes config, eula and server.properties with --port/--ram", async () => {
  const dir = join(tmp(), "srv");
  const r = await run(["init", dir, "--port", "25601", "--ram", "2048"]);
  assert.equal(r.code, 0, r.err);
  const cfg = JSON.parse(readFileSync(join(dir, "mc-local.json"), "utf-8"));
  assert.equal(cfg.port, 25601);
  assert.equal(cfg.ram_mb, 2048);
  assert.match(readFileSync(join(dir, "eula.txt"), "utf-8"), /eula=true/);
  assert.match(readFileSync(join(dir, "server.properties"), "utf-8"), /^server-port=25601$/m);
});

test("README form 'start --ram 2048' uses the current dir, not a dir named --ram", async () => {
  const dir = tmp();
  await run(["init"], { cwd: dir });
  const r = await run(["start", "--ram", "2048"], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.err, /No server\.jar found/);
  assert.equal(existsSync(join(dir, "--ram")), false);
  assert.equal(JSON.parse(readFileSync(join(dir, "mc-local.json"), "utf-8")).ram_mb, 2048);
});

test("invalid --ram and --port are rejected", async () => {
  const dir = tmp();
  for (const args of [["--ram", "lots"], ["--port", "70000"], ["--port", "0"]]) {
    const r = await run(["init", dir, ...args]);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.err, /must be a whole number/);
  }
});

test("install without a version prints usage (README form 'install paper 1.21.1')", async () => {
  const r = await run(["install", "paper"], { cwd: tmp() });
  assert.equal(r.code, 1);
  assert.match(r.err, /Usage: mc-local install/);
});

test("install rejects an unknown server type", async () => {
  const r = await run(["install", "bukkit", "1.21.1", "--print-url"], { cwd: tmp() });
  assert.equal(r.code, 1);
  assert.match(r.err, /Unknown type: bukkit/);
});

test("status with a stale pid file reports not running and cleans up", async () => {
  const dir = tmp();
  await run(["init", dir]);
  writeFileSync(join(dir, ".mc-local.pid"), "999999");
  const r = await run(["status", dir]);
  assert.match(r.out, /Running:\s+no/);
  assert.equal(existsSync(join(dir, ".mc-local.pid")), false);
});

test("start without Java installed explains the problem", async () => {
  const dir = tmp();
  await run(["init", dir]);
  writeFileSync(join(dir, "server.jar"), "x");
  const r = await run(["start", dir, "--java", join(dir, "no-such-java")]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Could not run Java/);
  assert.equal(existsSync(join(dir, ".mc-local.pid")), false);
});

test("start → console input → stop → restart cycle (fake java)", { skip: process.platform === "win32" && "fake java is a POSIX script" }, async () => {
  const dir = tmp();
  const java = fakeJava(dir);
  await run(["init", dir, "--ram", "768", "--java", java]);
  writeFileSync(join(dir, "server.jar"), "x");

  let out = "";
  const server = spawn(process.execPath, [CLI, "start", dir], { stdio: ["pipe", "pipe", "pipe"] });
  server.stdout.on("data", (d) => (out += d));
  server.stderr.on("data", (d) => (out += d));
  const exited = new Promise((ok) => server.on("exit", (code) => ok(code)));
  await waitFor(() => out, /Done \(/);

  const argv = JSON.parse(readFileSync(join(dir, "argv.json"), "utf-8"));
  assert.deepEqual(argv.slice(0, 2), ["-Xmx768M", "-Xms768M"]);
  assert.deepEqual(argv.slice(-3), ["-jar", "server.jar", "nogui"]);

  const status = await run(["status", dir]);
  assert.match(status.out, /Running:\s+yes/);
  assert.equal((await run(["start", dir])).out.includes("already running"), true);

  server.stdin.write("say hello\n"); // the start terminal is the console
  await waitFor(() => out, /got: say hello/);

  const stop = await run(["stop", dir]);
  assert.equal(stop.code, 0, stop.err);
  assert.match(stop.out, /Server stopped\./);
  assert.equal(await exited, 0, "start exits 0 after a normal stop");
  assert.equal(existsSync(join(dir, ".mc-local.pid")), false);

  // restart from a stopped state simply starts it again
  let out2 = "";
  const again = spawn(process.execPath, [CLI, "restart", dir], { stdio: ["pipe", "pipe", "pipe"] });
  again.stdout.on("data", (d) => (out2 += d));
  const againExited = new Promise((ok) => again.on("exit", ok)); // attach before it can exit
  await waitFor(() => out2, /Done \(/);
  assert.equal((await run(["stop", dir])).code, 0);
  assert.equal(await againExited, 0);
});

test("the JVM flags start uses are accepted by the installed Java", async (t) => {
  try { execFileSync("java", ["-version"], { stdio: "ignore" }); } catch { return t.skip("java not installed"); }
  const src = readFileSync(CLI, "utf-8");
  const flags = JSON.parse(src.match(/const JVM_FLAGS = (\[[^\]]*\]);/)[1]);
  assert.ok(flags.length > 0);
  execFileSync("java", ["-Xmx64M", "-Xms64M", ...flags, "-version"], { stdio: "pipe" }); // throws on an unknown flag
});

test("backup archives every world dimension", async () => {
  const dir = tmp();
  for (const w of ["world", "world_nether", "world_the_end"]) {
    mkdirSync(join(dir, w), { recursive: true });
    writeFileSync(join(dir, w, "level.dat"), "data");
  }
  const r = await run(["backup", dir]);
  assert.equal(r.code, 0, r.err);
  const archive = readdirSync(dir).find((f) => f.startsWith("backup-"));
  assert.ok(archive, "backup file created");
  const listing = archive.endsWith(".zip")
    ? execFileSync(process.platform === "win32" ? "tar" : "unzip", process.platform === "win32" ? ["-tf", archive] : ["-l", archive], { cwd: dir }).toString()
    : execFileSync("tar", ["-tzf", archive], { cwd: dir }).toString();
  for (const w of ["world", "world_nether", "world_the_end"]) assert.match(listing, new RegExp(`${w}/level\\.dat`));
});

test("backup without a world fails clearly", async () => {
  const r = await run(["backup", tmp()]);
  assert.equal(r.code, 1);
  assert.match(r.err, /No world\/ directory found/);
});
