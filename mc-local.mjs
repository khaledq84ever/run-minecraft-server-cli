#!/usr/bin/env node
import { spawn, execFileSync } from "child_process";
import { createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, unlinkSync, renameSync } from "fs";
import { join, resolve } from "path";
import { parseArgs } from "util";

const HELP = `
Usage: mc-local <command> [args] [options]

Commands:
  init [dir]              Create server directory with default files
  start [dir]             Start the server; this terminal becomes its console
  stop [dir]              Stop the running server (graceful, waits for exit)
  restart [dir]           Stop, wait for exit, start again
  status [dir]            Show server status & stats
  console [dir]           Same as start (the console is the start terminal)
  command <cmd>           How to send one command to a running server
  backup [dir]            Zip world/, world_nether/, world_the_end/
  install <type> <ver>    Download server JAR (paper, vanilla, fabric, purpur)

Options:
  --dir   <path>          Server directory (default: $MC_LOCAL_DIR or current dir)
  --java  <path>          Java executable (default: java)
  --ram   <MB>            Max heap MB (default: 1024)
  --port  <port>          Server port (default: 25565)
  --print-url             install: print the resolved download URL, don't download

  --java/--ram/--port are saved to mc-local.json and used from then on.

Files:
  mc-local.json           Server config (auto-created on init)
  server.jar              Server JAR
  world/                  World data directory
`;

const USER_AGENT = "run-minecraft-server-cli/1.1.0 (+https://github.com/khaledq84ever/run-minecraft-server-cli)";

/** JVM options passed before -jar; every one must be accepted by Java 17+. */
const JVM_FLAGS = ["-XX:+UseG1GC", "-XX:+ParallelRefProcEnabled", "-XX:MaxGCPauseMillis=200"];

const DEFAULT_CONFIG = { java: "java", ram_mb: 1024, port: 25565, type: "paper", version: "1.21.1" };

function loadConfig(dir) {
  const p = join(dir, "mc-local.json");
  if (!existsSync(p)) return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(p, "utf-8")) };
}

function saveConfig(dir, cfg) {
  writeFileSync(join(dir, "mc-local.json"), JSON.stringify(cfg, null, 2));
}

function positiveInt(name, value, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > max) throw new Error(`--${name} must be a whole number between 1 and ${max}`);
  return n;
}

/** Applies --java/--ram/--port to the saved config (and server.properties for the port). */
function applyFlags(dir, cfg, flags) {
  let changed = false;
  if (flags.java !== undefined) { cfg.java = flags.java; changed = true; }
  if (flags.ram !== undefined) { cfg.ram_mb = positiveInt("ram", flags.ram, 1_048_576); changed = true; }
  if (flags.port !== undefined) {
    cfg.port = positiveInt("port", flags.port, 65535);
    changed = true;
    const props = join(dir, "server.properties");
    if (existsSync(props)) {
      const text = readFileSync(props, "utf-8");
      const next = /^server-port=.*$/m.test(text)
        ? text.replace(/^server-port=.*$/m, `server-port=${cfg.port}`)
        : text + `server-port=${cfg.port}\n`;
      writeFileSync(props, next);
    }
  }
  if (changed && existsSync(dir)) saveConfig(dir, cfg);
  return cfg;
}

function serverPidFile(dir) {
  return join(dir, ".mc-local.pid");
}

function readPid(dir) {
  const pidFile = serverPidFile(dir);
  if (!existsSync(pidFile)) return null;
  const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isRunning(dir) {
  const pid = readPid(dir);
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    try { unlinkSync(serverPidFile(dir)); } catch {} // stale pid file
    return false;
  }
}

async function waitUntilStopped(dir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isRunning(dir)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
  return true;
}

function readEula(dir) {
  const p = join(dir, "eula.txt");
  if (!existsSync(p)) return false;
  return readFileSync(p, "utf-8").includes("eula=true");
}

async function init(dir, flags) {
  mkdirSync(dir, { recursive: true });
  const cfg = loadConfig(dir);
  saveConfig(dir, cfg);
  const eulaPath = join(dir, "eula.txt");
  if (!existsSync(eulaPath)) {
    writeFileSync(eulaPath, "eula=true\n");
    console.log("Created eula.txt (accepted)");
  }
  if (!existsSync(join(dir, "server.properties"))) {
    const props = [
      `server-port=${cfg.port}`,
      "online-mode=true",
      "motd=A CraftHost local server",
      "max-players=20",
      "difficulty=normal",
      "gamemode=survival",
      "spawn-protection=0",
      "enable-query=false",
      "enable-rcon=false",
      "broadcast-console-to-ops=true",
    ].join("\n");
    writeFileSync(join(dir, "server.properties"), props + "\n");
    console.log("Created server.properties");
  }
  applyFlags(dir, cfg, flags);
  if (!existsSync(join(dir, "server.jar"))) {
    console.log("No server.jar found. Run: mc-local install " + cfg.type + " " + cfg.version);
  }
  console.log("Initialized server at", dir);
}

async function startServer(dir, flags) {
  if (isRunning(dir)) {
    console.log("Server is already running (pid " + readPid(dir) + ").");
    return;
  }
  const cfg = applyFlags(dir, loadConfig(dir), flags);
  if (!existsSync(join(dir, "server.jar"))) {
    throw new Error("No server.jar found. Run: mc-local install <type> <version>");
  }
  if (!readEula(dir)) {
    writeFileSync(join(dir, "eula.txt"), "eula=true\n");
  }
  const javaArgs = [`-Xmx${cfg.ram_mb}M`, `-Xms${cfg.ram_mb}M`, ...JVM_FLAGS, "-jar", "server.jar", "nogui"];
  console.log(`Starting Minecraft server (${cfg.type} ${cfg.version}, ${cfg.ram_mb} MB, port ${cfg.port})…`);
  console.log("Type server commands here (e.g. 'op <name>', 'stop').");
  const proc = spawn(cfg.java, javaArgs, { cwd: dir, stdio: ["pipe", "inherit", "inherit"] });
  proc.stdin.on("error", () => {}); // server may exit before a pending write
  proc.on("error", (err) => {
    console.error(`Could not run Java ('${cfg.java}'): ${err.message}. Install Java or pass --java <path>.`);
    try { unlinkSync(serverPidFile(dir)); } catch {}
    process.exit(1);
  });
  writeFileSync(serverPidFile(dir), String(proc.pid));

  // This terminal is the server console.
  process.stdin.on("data", (chunk) => { if (proc.exitCode === null) proc.stdin.write(chunk); });
  process.stdin.on("end", () => {}); // keep running when stdin closes (e.g. started from a script)

  const saveTimer = setInterval(() => {
    if (proc.exitCode === null) proc.stdin.write("save-all\n");
  }, 300_000);
  const gracefulStop = () => {
    if (proc.exitCode === null) proc.stdin.write("stop\n");
  };
  process.on("SIGINT", gracefulStop);
  process.on("SIGTERM", gracefulStop);
  proc.on("exit", (code, signal) => {
    clearInterval(saveTimer);
    try { unlinkSync(serverPidFile(dir)); } catch {}
    // 143 = 128 + SIGTERM: the normal result of `mc-local stop`, not a failure.
    const clean = code === 0 || code === 143 || signal === "SIGTERM";
    console.log(clean ? "Server stopped." : `Server exited unexpectedly (${signal || "exit code " + code}).`);
    process.exit(clean ? 0 : code || 1);
  });
}

async function stopServer(dir) {
  const pid = readPid(dir);
  if (pid === null || !isRunning(dir)) {
    console.log("Server not running.");
    return;
  }
  // SIGTERM runs Minecraft's shutdown hook: it saves the world and exits cleanly.
  process.kill(pid, "SIGTERM");
  console.log("Stopping server (pid " + pid + ")…");
  if (await waitUntilStopped(dir, 120_000)) console.log("Server stopped.");
  else throw new Error("Server did not stop within 120 s (pid " + pid + ").");
}

function serverStatus(dir) {
  const running = isRunning(dir);
  const cfg = loadConfig(dir);
  const jarSize = existsSync(join(dir, "server.jar"))
    ? (statSync(join(dir, "server.jar")).size / 1024 / 1024).toFixed(1) + " MB"
    : "N/A";
  console.log(`Directory: ${dir}`);
  console.log(`Running:   ${running ? "yes" : "no"}`);
  console.log(`Type:      ${cfg.type} ${cfg.version}`);
  console.log(`RAM:       ${cfg.ram_mb}MB`);
  console.log(`Port:      ${cfg.port}`);
  console.log(`Java:      ${cfg.java}`);
  console.log(`JAR:       ${jarSize}`);
  console.log(`PID:       ${running ? readPid(dir) : "N/A"}`);
}

function sendCommand(dir, cmd) {
  if (!isRunning(dir)) throw new Error("Server not running.");
  // mc-local cannot inject into a JVM it does not own the stdin of; point at the options.
  console.log("Type commands in the terminal where you ran 'mc-local start'.");
  console.log("Or enable rcon in server.properties and use:");
  console.log("  mcrcon -p <password> " + JSON.stringify(cmd || "<command>"));
}

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/** Returns { url, sha256?, sha1? } for the requested server type and version. */
async function resolveDownload(type, version) {
  switch (type) {
    case "paper": {
      // Paper's v2 API was shut down on 2026-07-01; v3 ("Fill") lists builds newest first.
      const builds = await getJson(`https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds`);
      const build = builds.find((b) => b.channel === "STABLE") || builds[0];
      const dl = build?.downloads?.["server:default"];
      if (!dl) throw new Error(`No Paper build found for ${version}`);
      return { url: dl.url, sha256: dl.checksums?.sha256 };
    }
    case "vanilla": {
      const manifest = await getJson("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
      const id = version === "latest" ? manifest.latest.release : version;
      const ver = manifest.versions.find((v) => v.id === id);
      if (!ver) throw new Error(`Unknown vanilla version: ${version}`);
      const pkg = await getJson(ver.url);
      if (!pkg.downloads?.server) throw new Error(`Vanilla ${id} has no server jar`);
      return { url: pkg.downloads.server.url, sha1: pkg.downloads.server.sha1 };
    }
    case "fabric": {
      const [loaders, installers] = await Promise.all([
        getJson("https://meta.fabricmc.net/v2/versions/loader"),
        getJson("https://meta.fabricmc.net/v2/versions/installer"),
      ]);
      const loader = loaders.find((l) => l.stable) || loaders[0];
      const installer = installers.find((i) => i.stable) || installers[0];
      return { url: `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}/${loader.version}/${installer.version}/server/jar` };
    }
    case "purpur":
      return { url: `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}/latest/download` };
    default:
      throw new Error(`Unknown type: ${type} (use paper, vanilla, fabric or purpur)`);
  }
}

async function install(dir, type, version, flags) {
  if (!type || !version) throw new Error("Usage: mc-local install <paper|vanilla|fabric|purpur> <version>");
  const target = await resolveDownload(type, version);
  if (flags["print-url"]) {
    console.log(target.url);
    return;
  }
  mkdirSync(dir, { recursive: true });
  const cfg = loadConfig(dir);
  console.log(`Downloading ${type} ${version} server JAR…`);
  console.log("From:", target.url);
  const res = await fetch(target.url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} (is ${version} a valid ${type} version?)`);
  const buf = Buffer.from(await res.arrayBuffer());
  for (const algo of ["sha256", "sha1"]) {
    if (target[algo] && createHash(algo).update(buf).digest("hex") !== target[algo]) {
      throw new Error(`Downloaded jar failed its ${algo} check; nothing was written. Try again.`);
    }
  }
  const jarPath = join(dir, "server.jar");
  writeFileSync(jarPath + ".part", buf);
  renameSync(jarPath + ".part", jarPath); // never leave a half-written server.jar
  cfg.type = type;
  cfg.version = version;
  saveConfig(dir, cfg);
  console.log(`Downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB to ${jarPath}`);
}

async function backup(dir) {
  const worlds = ["world", "world_nether", "world_the_end"].filter((w) => existsSync(join(dir, w)));
  if (!worlds.length) throw new Error("No world/ directory found.");
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  let backupPath = join(dir, `backup-${ts}.zip`);
  try {
    if (process.platform === "win32") {
      execFileSync("tar", ["-a", "-c", "-f", backupPath, ...worlds], { cwd: dir, stdio: "inherit" });
    } else {
      execFileSync("zip", ["-q", "-r", backupPath, ...worlds], { cwd: dir, stdio: "inherit" });
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw new Error("Backup failed: " + err.message);
    backupPath = backupPath.replace(/\.zip$/, ".tar.gz"); // no zip tool installed
    execFileSync("tar", ["-czf", backupPath, ...worlds], { cwd: dir, stdio: "inherit" });
  }
  const size = statSync(backupPath).size;
  console.log(`Backup saved: ${backupPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

// --- main ---
let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      dir: { type: "string" }, java: { type: "string" }, ram: { type: "string" }, port: { type: "string" },
      "print-url": { type: "boolean" }, help: { type: "boolean", short: "h" },
    },
  });
} catch (err) {
  console.error("Error:", err.message);
  console.log(HELP);
  process.exit(2);
}
const { values: flags, positionals } = parsed;
const cmd = flags.help ? "help" : positionals[0] || "help";
const DIR_COMMANDS = ["init", "start", "stop", "restart", "status", "console", "backup"];
const dir = resolve(flags.dir || (DIR_COMMANDS.includes(cmd) && positionals[1]) || process.env.MC_LOCAL_DIR || process.cwd());

try {
  switch (cmd) {
    case "init":
      await init(dir, flags);
      break;
    case "start":
    case "console":
      await startServer(dir, flags);
      break;
    case "stop":
      await stopServer(dir);
      break;
    case "restart":
      await stopServer(dir);
      await startServer(dir, flags);
      break;
    case "status":
      serverStatus(dir);
      break;
    case "command":
      sendCommand(dir, positionals.slice(1).join(" "));
      break;
    case "install":
      await install(dir, positionals[1], positionals[2], flags);
      break;
    case "backup":
      await backup(dir);
      break;
    case "help":
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      console.log(HELP);
      process.exit(2);
  }
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
}
