// Runs the real launcher-template.bat in cmd.exe against the mock CraftHost API,
// feeding menu choices on stdin. Windows only (CI runs it on windows-latest).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMock, TOKEN } from "./helpers/mock-crafthost.mjs";

const WIN = process.platform === "win32";
const TEMPLATE = fileURLToPath(new URL("../launcher-template.bat", import.meta.url));
let mock;

before(async () => { if (WIN) mock = await startMock(); });
after(() => mock?.close());

/** Copies the template with BASE/TOKEN pointed at the mock, runs it with `input` on stdin. */
function runBat(input, token = TOKEN) {
  const dir = mkdtempSync(join(tmpdir(), "bat-"));
  const bat = join(dir, "start-test.bat");
  const src = readFileSync(TEMPLATE, "utf-8")
    .replace(/set "BASE=[^"]*"/, `set "BASE=${mock.url}"`)
    .replace(/set "TOKEN=[^"]*"/, `set "TOKEN=${token}"`);
  writeFileSync(bat, src);
  const inputFile = join(dir, "input.txt");
  writeFileSync(inputFile, input.join("\r\n") + "\r\n");
  return new Promise((ok) => execFile("cmd.exe", ["/d", "/c", `"${bat}" < "${inputFile}"`],
    { timeout: 120000, windowsVerbatimArguments: true }, (e, out, err) => ok({ code: e ? e.code : 0, out, err })));
}

test("menu shows all four status lines from the API", { skip: !WIN && "Windows only" }, async () => {
  const r = await runBat(["0"]);
  assert.match(r.out, /Status : online/);
  assert.match(r.out, /Address: amber-creeper\.joinmc\.link/);
  assert.match(r.out, /Type\s+: paper 1\.21\.1/);
  assert.match(r.out, /Players: 2\/20/);
});

test("refresh then exit consumes exactly two menu inputs", { skip: !WIN && "Windows only" }, async () => {
  const r = await runBat(["4", "0"]);
  assert.equal((r.out.match(/Select an option/g) || []).length, 2, r.out);
});

test("stop sends POST /stop and shows the reply", { skip: !WIN && "Windows only" }, async () => {
  const r = await runBat(["2", "", "0"]);
  assert.match(r.out, /OK stopping/);
  assert.ok(mock.requests.some((q) => q.method === "POST" && q.path === `/api/launcher/${TOKEN}/stop`));
});

test("start on an online server says it's already online", { skip: !WIN && "Windows only" }, async () => {
  const r = await runBat(["1", "0"]);
  assert.match(r.out, /already online/);
});
