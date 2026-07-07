// index.js — UnityTool · Live Mint 后端入口。零 npm 依赖 (Node 22 内置 http/sqlite/fetch/ws)。
//   职责: ① 常驻扫链 worker 写库  ② REST API 供前端读共享历史  ③ 静态托管前端。
//   启动: node --experimental-sqlite index.js   (见 package.json scripts)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { startWorker } from "./worker.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");           // 仓库根 (前端静态文件在这)

// ── 配置 (环境变量) ──
const cfg = {
  port: parseInt(process.env.PORT || "8090", 10),
  rpcUrl: process.env.RPC_URL || "https://ethereum-rpc.publicnode.com",
  wsUrl: process.env.WS_URL || "",            // 有 wss 就实时; 否则 http 轮询
  etherscanKey: process.env.ETHERSCAN_KEY || "",
  dbPath: process.env.DB_PATH || "./data/mintradar.db",
};

const store = openDb(cfg.dbPath);
const worker = startWorker(store, cfg);

// ── HTTP ──
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".woff2": "font/woff2" };

const json = (res, code, data) => {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(data));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;

  // ── API ──
  if (path.startsWith("/api/")) {
    try {
      if (path === "/api/ranking") {
        const limit = Math.min(300, parseInt(url.searchParams.get("limit") || "120", 10));
        const winSec = parseInt(url.searchParams.get("win") || "0", 10);
        const sort = url.searchParams.get("sort") || "minters";
        return json(res, 200, { items: store.ranking({ limit, winSec, sort }) });
      }
      if (path === "/api/activity") {
        const limit = Math.min(200, parseInt(url.searchParams.get("limit") || "100", 10));
        return json(res, 200, { items: store.activity({ limit }) });
      }
      if (path.startsWith("/api/project/")) {
        const c = decodeURIComponent(path.slice("/api/project/".length));
        const p = store.project(c);
        return p ? json(res, 200, p) : json(res, 404, { error: "not found" });
      }
      if (path === "/api/status") {
        return json(res, 200, { ok: true, mode: cfg.wsUrl ? "ws" : "http", ...worker.status() });
      }
      return json(res, 404, { error: "unknown endpoint" });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── 静态文件 (前端) ──
  let rel = path === "/" ? "/index.html" : path;
  const filePath = normalize(join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end("forbidden"); }  // 防目录穿越
  try {
    // index.html 注入 window.MR_BACKEND → 前端进入"后端模式"(从 API 读, 不自己扫链)
    if (filePath === join(ROOT, "index.html")) {
      let html = await readFile(filePath, "utf8");
      html = html.replace("</head>", `<script>window.MR_BACKEND="";</script></head>`);  // 同源, 空基址=当前站
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-cache" });
      return res.end(html);
    }
    const buf = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-cache" });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});

server.listen(cfg.port, () => {
  console.log(`\n  UnityTool · Live Mint server`);
  console.log(`  ─────────────────`);
  console.log(`  http://localhost:${cfg.port}   (frontend + API)`);
  console.log(`  scanning: ${cfg.wsUrl ? "wss " + cfg.wsUrl : "http " + cfg.rpcUrl}`);
  console.log(`  db: ${cfg.dbPath}\n`);
});

// 优雅退出
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => {
  console.log("\nshutting down…");
  worker.stop(); server.close(); process.exit(0);
});
