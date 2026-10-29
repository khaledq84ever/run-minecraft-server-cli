// ch-cli against a local mock of the CraftHost API (no network, no account needed).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMock, SERVERS } from "./helpers/mock-crafthost.mjs";

const CLI = fileURLToPath(new URL("../ch-cli.mjs", import.meta.url));
let mock, home;

/** Runs ch-cli with an isolated HOME; resolves { code, out, err }. */
function run(...args) {
  const env = { ...process.env, CRAFTHOST_API: mock.url, HOME: home, USERPROFILE: home };
  return new Promise((ok) => execFile(process.execPath, [CLI, ...args], { env, timeout: 15000 },
    (e, out, err) => ok({ code: e ? e.code : 0, out, err })));
}
const loggedIn = () => writeFileSync(join(home, ".crafthost-cli.json"), JSON.stringify({ token: "tok123", email: "a@b.c" }));
const lastRequest = () => mock.requests[mock.requests.length - 1];

before(async () => { mock = await startMock(); });
after(() => mock.close());

test("login with good credentials saves the session token", async () => {
  home = mkdtempSync(join(tmpdir(), "chcli-"));
  const r = await run("login", "a@b.c", "secret");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Logged in as a@b\.c/);
  assert.equal(JSON.parse(readFileSync(join(home, ".crafthost-cli.json"), "utf-8")).token, "tok123");
});

test("login with a bad password fails with the API's message", async () => {
  home = mkdtempSync(join(tmpdir(), "chcli-"));
  const r = await run("login", "a@b.c", "wrong");
  assert.equal(r.code, 1);
  assert.match(r.err, /Invalid email or password/);
});

test("login without arguments prints usage instead of sending a request", async () => {
  home = mkdtempSync(join(tmpdir(), "chcli-"));
  const n = mock.requests.length;
  const r = await run("login");
  assert.equal(r.code, 1);
  assert.match(r.err, /Usage: ch-cli login/);
  assert.equal(mock.requests.length, n);
});

for (const args of [["list"], ["servers", "list"]]) {
  test(`'${args.join(" ")}' lists every server`, async () => {
    home = mkdtempSync(join(tmpdir(), "chcli-"));
    loggedIn();
    const r = await run(...args);
    assert.equal(r.code, 0, r.err);
    for (const s of SERVERS) assert.match(r.out, new RegExp(s.name));
    assert.match(r.out, /1111aaaa…/);
  });
}

test("commands without a session report 'Not logged in'", async () => {
  home = mkdtempSync(join(tmpdir(), "chcli-"));
  const r = await run("list");
  assert.equal(r.code, 1);
  assert.match(r.err, /Not logged in/);
});

for (const action of ["start", "stop", "restart"]) {
  test(`${action} accepts the 8-char id prefix that list prints`, async () => {
    home = mkdtempSync(join(tmpdir(), "chcli-"));
    loggedIn();
    const r = await run(action, "1111aaaa");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`${action} requested`));
    assert.deepEqual([lastRequest().method, lastRequest().path], ["POST", `/api/servers/${SERVERS[0].id}/${action}`]);
  });
}

test("an ambiguous id prefix is rejected, not guessed", async () => {
  home = mkdtempSync(join(tmpdir(), "chcli-"));
  loggedIn();
  const r = await run("start", "2222");
  assert.equal(r.code, 1);
  assert.match(r.err, /matches 2 servers/);
});

test("a missing id is rejected before any request", async () => {
  home = mkdtempSync(join(tmpdir(), "chcli-"));
  loggedIn();
  const r = await run("stop");
  assert.equal(r.code, 1);
  assert.match(r.err, /Missing server id/);
});

test("status shows the server's details", async () => {
  home = mkdtempSync(join(tmpdir(), "chcli-"));
  loggedIn();
  const r = await run("status", "2222bbbb");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Name:\s+creative/);
  assert.match(r.out, /Plan:\s+free \(1024MB\)/);
});

test("create sends name and options", async () => {
  home = mkdtempSync(join(tmpdir(), "chcli-"));
  loggedIn();
  const r = await run("create", "mybox", "--type", "fabric", "--version=1.21.1", "--region", "us");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Created server: mybox/);
  assert.deepEqual(lastRequest().body, { name: "mybox", type: "fabric", version: "1.21.1", plan: "free", region: "us" });
});

test("delete resolves the prefix and deletes the full id", async () => {
  home = mkdtempSync(join(tmpdir(), "chcli-"));
  loggedIn();
  const r = await run("delete", "2222cccc");
  assert.equal(r.code, 0, r.err);
  assert.equal(lastRequest().path, `/api/servers/${SERVERS[2].id}`);
});

test("logs streams log lines and stats over the WebSocket", async () => {
  home = mkdtempSync(join(tmpdir(), "chcli-"));
  loggedIn();
  const r = await run("logs", "1111aaaa");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\[Server\] Done \(3\.2s\)!/);
  assert.match(r.out, /\[stats\] 2 players · 20\.0 tps · 2GB RAM/);
  const ws = mock.requests.find((q) => q.method === "WS");
  assert.equal(ws.path, `/ws/servers/${SERVERS[0].id}/logs`);
  assert.equal(ws.token, "tok123");
});
