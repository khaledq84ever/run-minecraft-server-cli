// In-memory stand-in for the CraftHost API used by ch-cli and the .bat launcher.
// Records every request so tests can assert what the clients sent.
import { createServer } from "node:http";
import { createHash } from "node:crypto";

export const TOKEN = "a".repeat(48);
export const SERVERS = [
  { id: "1111aaaa-0000-4000-8000-000000000001", name: "survival", type: "paper", version: "1.21.1", status: "online",
    plan_name: "free", ram_mb: 2048, port: 25565, max_players: 20, motd: "hi", is_public: true },
  { id: "2222bbbb-0000-4000-8000-000000000002", name: "creative", type: "fabric", version: "1.21.1", status: "offline",
    plan_name: "free", ram_mb: 1024, port: 25566, max_players: 10, motd: "", is_public: false },
  { id: "2222cccc-0000-4000-8000-000000000003", name: "test", type: "vanilla", version: "1.20.4", status: "offline",
    plan_name: "free", ram_mb: 1024, port: 25567, max_players: 5, motd: "", is_public: false },
];

/** Encodes one unmasked server→client WebSocket text frame. */
function wsFrame(text) {
  const payload = Buffer.from(text);
  const len = payload.length;
  const header = len < 126 ? Buffer.from([0x81, len])
    : Buffer.from([0x81, 126, len >> 8, len & 0xff]);
  return Buffer.concat([header, payload]);
}

export async function startMock() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      requests.push({ method: req.method, path: url.pathname, body: body ? JSON.parse(body) : null, cookie: req.headers.cookie });
      const json = (code, obj, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };
      const text = (code, t) => { res.writeHead(code, { "content-type": "text/plain" }); res.end(t); };

      // --- .bat launcher endpoints (plain text) ---
      const launcher = url.pathname.match(/^\/api\/launcher\/([^/]+)\/(start|stop|restart|status)$/);
      if (launcher) {
        if (launcher[1] !== TOKEN) return text(404, "ERROR unknown token");
        if (launcher[2] === "status") return text(200, "online\r\namber-creeper.joinmc.link\r\npaper 1.21.1\r\n2/20\r\n");
        return text(200, { start: "OK starting", stop: "OK stopping", restart: "OK restarting" }[launcher[2]]);
      }

      // --- ch-cli JSON API ---
      if (url.pathname === "/api/auth/login") {
        if (body && JSON.parse(body).password === "secret") return json(200, { ok: true }, { "set-cookie": "token=tok123; HttpOnly; Path=/" });
        return json(401, { error: "Invalid email or password" });
      }
      if (req.headers.cookie !== "token=tok123") return json(401, { error: "Not logged in" });
      if (req.method === "GET" && url.pathname === "/api/servers") return json(200, { servers: SERVERS });
      const action = url.pathname.match(/^\/api\/servers\/([^/]+)\/(start|stop|restart)$/);
      if (action && req.method === "POST") {
        if (!SERVERS.some((s) => s.id === action[1])) return json(404, { error: "No such server" });
        return json(200, { ok: true, status: `${action[2]} requested` });
      }
      if (req.method === "POST" && url.pathname === "/api/servers") {
        const b = JSON.parse(body);
        return json(200, { ok: true, server: { id: "3333dddd-new", name: b.name, status: "creating", port: 25570 } });
      }
      const del = url.pathname.match(/^\/api\/servers\/([^/]+)$/);
      if (del && req.method === "DELETE") return json(200, { ok: true, message: "deleted " + del[1] });
      json(404, { error: "Not found" });
    });
  });

  // Minimal WebSocket endpoint: sends a log line and a stats message, then closes.
  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url, "http://x");
    requests.push({ method: "WS", path: url.pathname, token: url.searchParams.get("token") });
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(wsFrame(JSON.stringify({ type: "log", line: "[Server] Done (3.2s)!" })));
    socket.write(wsFrame(JSON.stringify({ type: "stats", stats: { players: 2, tps: 19.96, ram_used: 2048 } })));
    socket.end(Buffer.from([0x88, 0x00])); // close frame
  });

  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}
