# UnityTool · Live Mint

**Realtime on-chain NFT mint tracker that runs entirely in your browser.**

UnityTool · Live Mint watches Ethereum block-by-block for NFT mints — ERC-721 `Transfer` from the zero address and ERC-1155 mint events — aggregates them live, and shows you what's being minted *right now*, ranked by unique minters, recent mints, and mint progress.

In its default (pure-frontend) mode there is no server, no database, and no API key from us — just a static site of HTML, CSS, and vanilla JavaScript with zero build step and zero dependencies, running between your browser and an Ethereum RPC endpoint. An **optional** self-hosted backend (see [`server/`](./server)) can run the scanner 24/7 and serve shared history to all visitors — use it only if you want that.

---

## Why

Most mint trackers are backends that index the chain and sell you the view. UnityTool inverts that: **the scanner is the client**. You point it at any EVM RPC and it does the indexing live, in your tab. Nothing is proxied, nothing is logged, and you can read every line of what it does.

That makes it fast to fork, trivial to self-host, and impossible to rug — the worst case is you swap the RPC URL.

---

## Quick start

Open `index.html`. That's it.

```bash
# any static file server works — pick one
python -m http.server 8080
npx serve .
```

Then visit the page. A public WebSocket endpoint is preconfigured, so it starts scanning the moment it loads — no setup, no buttons to click. Watch the leaderboard and live stream fill in.

For lower latency or higher rate limits, open **Settings** (gear icon) and paste your own endpoint:

- `wss://…` — real-time push (sub-second on a paid node like Alchemy). Recommended.
- `https://…` — HTTP polling (~1s cadence). Fine for casual use.

---

## What you get

| | |
|---|---|
| **Live leaderboard** | Projects ranked by unique minters, recent mints, or on-chain progress. Filter by SeaDrop / regular, price-changed, mintable. |
| **Block stream** | Every block's mints as they land, with gap markers for empty blocks so you can see the feed is alive. |
| **Detail panel** | Supply & progress, mint rate, live mint **simulation** (`eth_call` replay of a real mint), holder distribution, deployer address + deployer wallet age, and socials. |
| **15 languages** | Full UI i18n with automatic fallback to English. |

---

## Optional API keys

Both are free, optional, and live only in your browser's `localStorage`. They are sent **only** to their own provider, never to us (there is no us).

- **Etherscan key** — precise deployer lookup, including factory / CREATE2 deployments. Without it, the deployer is found via an archive-node binary search, which is slower and needs an archive-capable RPC. → [etherscan.io/apis](https://etherscan.io/apis)
- **OpenSea key** — twitter / website / discord detection for projects. → [docs.opensea.io](https://docs.opensea.io/reference/api-overview)

---

## How it works

```
 RPC endpoint
     │
     ├── wss://  →  WsScanner   (subscribe newHeads + mint logs, flush per block)
     └── https:// →  MintScanner (poll blockNumber + merged getLogs)
                        │
                        ▼
                    store.js      (per-contract aggregate: minters, counts, snapshots)
                        │
                        ▼
                     app.js       (three-column UI: leaderboard · detail · live stream)
```

- **`src/scanner.js`** — two interchangeable scanners.
  - `WsScanner` subscribes to `newHeads` and mint `logs` over `wss://`; when a block's head arrives it flushes that block's mints within ~150 ms (real-time).
  - `MintScanner` polls `eth_blockNumber` and pulls one merged `eth_getLogs` per block (OR-matching `Transfer`, `TransferSingle`, `TransferBatch` with `from = 0x0`).
- **`src/rpcpool.js`** — the multi-node RPC pool: health-aware node selection, per-request timeouts, rate-limit backoff, priority lanes (scan vs. background reads), and archive-only routing for historical-state calls.
- **`src/erc721.js`** — all the chain reads: `name / symbol / totalSupply / maxSupply`, mint simulation, holder sampling, deployer lookup. Hand-rolled ABI encoding/decoding — no ethers, no web3, no dependencies.
- **`src/store.js`** — in-memory aggregation with a rolling time window; projects persist to `localStorage`, the live block stream does not (it always starts fresh so stale blocks never bleed into the feed).
- **`src/app.js`** — UI wiring and rendering. **`src/i18n.js`** — the 15-language string table.

Data is **session-local**: it reflects what your RPC sees from the moment scanning starts. The longer it runs, the more complete the picture.

---

## RPC notes

- Any **logs-capable** endpoint works — every major provider supports single-block `eth_getLogs` on the free tier.
- Free public nodes are fine but may rate-limit, and most are **not archive nodes** — deployer / deployer-age lookups need archive access (or an Etherscan key, which sidesteps it entirely).
- Free `wss://` endpoints carry a few seconds of block-propagation delay; a paid endpoint pushes new heads in under a second.
- The filters target Ethereum mainnet, but the logic is chain-agnostic — point the RPC at any EVM chain.

---

## Deploy

It's a static folder. Drop it anywhere:

- **Vercel** — `vercel deploy` (`vercel.json` included, no config needed)
- **GitHub Pages** — push and enable Pages on the repo root
- **Netlify** — drag-and-drop the folder
- **Anything** — it's just files; any static host or `file://` works

---

## Roadmap

- [ ] Wallet connect (EIP-1193)
- [ ] One-click mint (detect mint function, simulate, estimate gas, send)
- [ ] Multi-chain presets (Base, Zora, …)
- [ ] Shareable snapshots

---

## Contributing

The codebase is deliberately small and dependency-free. If you're an AI agent or a human working on it, read **[AGENTS.md](./AGENTS.md)** first — it explains the architecture, invariants, and the mistakes that are easy to make here.

## Links & support

- **X / Twitter** — [@pigcanfly1001](https://x.com/pigcanfly1001)
- **Donate (ETH)** — `0x3400f5df694a3088b173b80ca5ba8467f2621de7`

It's free and open source — no tracking, bring your own RPC. If it caught you a good mint, a tip keeps it alive.

## Built with

Designed and built with [Claude Code](https://claude.com/claude-code) — Anthropic's agentic coding tool.

## License

MIT — see [LICENSE](./LICENSE).

## Disclaimer

A read-only observability tool. Nothing here is financial advice. Verify contracts yourself before interacting. Mint at your own risk.
