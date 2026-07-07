# UnityTool · Live Mint — Backend (always-on, shared history)

An optional 24/7 backend for UnityTool · Live Mint. It scans the chain continuously, stores everything in SQLite, and serves the same frontend backed by **shared history** — every visitor sees the full picture immediately instead of starting from an empty session.

**The pure-frontend version still works standalone and is unchanged.** This is an additive, opt-in deployment. The backend reuses the frontend's own `scanner.js` / `erc721.js` — no logic is duplicated.

## Zero dependencies

Runs on Node 22 built-ins only: `node:http`, `node:sqlite`, native `fetch`, native `WebSocket`. There is nothing to `npm install`.

Requires **Node ≥ 22.5** (for `node:sqlite`).

## Run it

```bash
cd server
node --experimental-sqlite index.js
# or: npm start
```

Open `http://localhost:8090` — same UI, now reading shared history from the backend (the mode chip shows **shared history** instead of WS/HTTP).

### Configuration (environment variables)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8090` | HTTP port (serves frontend + API). |
| `WS_URL` | — | `wss://` endpoint for real-time scanning. **Set this for best results** (e.g. your Alchemy wss). |
| `RPC_URL` | `https://ethereum-rpc.publicnode.com` | HTTP RPC — used for metadata/deployer reads, and for scanning if `WS_URL` is unset. |
| `ETHERSCAN_KEY` | — | Free Etherscan key → precise deployer lookup. |
| `DB_PATH` | `./data/mintradar.db` | SQLite file location. |

Example:

```bash
WS_URL="wss://eth-mainnet.g.alchemy.com/v2/YOUR_KEY" \
ETHERSCAN_KEY="YOUR_ETHERSCAN_KEY" \
PORT=8090 \
node --experimental-sqlite index.js
```

## API

All JSON, `access-control-allow-origin: *` (so a separately-hosted frontend can consume it).

| Endpoint | Returns |
|---|---|
| `GET /api/ranking?limit=120&win=0&sort=minters` | Leaderboard. `win` = window seconds (0 = all-time). `sort` = `minters` \| `mints` \| `progress`. |
| `GET /api/activity?limit=100` | Recent block-level mint activity (newest first). |
| `GET /api/project/:contract` | Full project record + unique minter count. |
| `GET /api/status` | Scanner health: last head, queue depth, row counts. |

## Keep it running

### pm2

```bash
npm i -g pm2
pm2 start "node --experimental-sqlite index.js" --name mint-radar --cwd ./server
pm2 save && pm2 startup     # restart on reboot
pm2 logs mint-radar
```

### systemd

`/etc/systemd/system/mint-radar.service`:

```ini
[Unit]
Description=UnityTool Live Mint backend
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/mint-radar/server
Environment=WS_URL=wss://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
Environment=ETHERSCAN_KEY=YOUR_ETHERSCAN_KEY
ExecStart=/usr/bin/node --experimental-sqlite index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now mint-radar
sudo journalctl -u mint-radar -f
```

### Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY . .
EXPOSE 8090
CMD ["node", "--experimental-sqlite", "server/index.js"]
```

```bash
docker build -t mint-radar .
docker run -d -p 8090:8090 \
  -e WS_URL="wss://…" -e ETHERSCAN_KEY="…" \
  -v mintradar-data:/app/server/data \
  --restart unless-stopped mint-radar
```

> Mount a volume at `server/data` so the SQLite database survives container restarts.

## How it fits together

```
worker.js  ── createScanner() from ../src/scanner.js ──►  onBlock
     │                                                        │
     └──────────────────► db.js (SQLite) ◄───────────────────┘
                              ▲
                              │  read
                         index.js ── REST API ──► frontend (backend mode)
                              └──── static files ─┘
```

- `worker.js` runs the same `WsScanner`/`MintScanner` the frontend uses, writing each block's mints to SQLite and lazily backfilling metadata/deployer.
- `db.js` is the SQLite layer (schema, prepared statements, ranking queries, pruning).
- `index.js` serves the REST API and the static frontend, injecting `window.MR_BACKEND` so the page enters backend mode.

## Notes

- `activity` rows are pruned to the last 6 hours; `projects` persist indefinitely.
- The frontend served here reads from the API and does **not** scan from the visitor's browser — so visitors need no RPC of their own.
- To host the frontend separately (CDN) and point it at this backend, set `window.MR_BACKEND = "https://your-backend"` in that page's HTML and enable CORS (already `*`).
