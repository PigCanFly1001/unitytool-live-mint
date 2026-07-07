# AGENTS.md — guide for AI agents & contributors

This file is the orientation an AI (or human) should read before editing UnityTool · Live Mint. It captures the architecture, the invariants that are easy to break, and the specific mistakes this codebase has already been burned by. Read it first; it will save you a debugging loop.

## What this is

A **pure-frontend, zero-backend, zero-dependency** realtime NFT mint tracker. It runs in the browser against an Ethereum RPC endpoint. There is no build step, no framework, no package.json for the app itself. Everything is vanilla ES modules loaded directly by `index.html`.

**Core principle: keep it 100% client-side.** No bundler, no npm dependency in the shipped app, no backend call except to the user's own RPC and (optionally) Etherscan/OpenSea with the user's own key. If a change would require a backend or a build step, it does not belong in this project — propose it as a separate opt-in, don't bake it in.

## File map

| File | Lines | Responsibility |
|---|---|---|
| `index.html` | ~80 | Static shell + three-column layout. Loads `src/app.js` as a module. |
| `src/app.js` | ~1570 | UI wiring, rendering, event handlers, detail panel, settings modal, i18n application. The orchestrator. |
| `src/scanner.js` | ~430 | `MintScanner` (HTTP poll), `WsScanner` (wss subscribe), `createScanner()` factory. Emits `onBlock`/`onHead`. |
| `src/rpcpool.js` | ~230 | `RpcPool`: node selection, failover, rate-limit backoff, priority lanes, archive routing. |
| `src/erc721.js` | ~920 | All chain reads via hand-rolled ABI: metadata, mint simulation, holders, deployer, socials. |
| `src/store.js` | ~275 | In-memory aggregation + `localStorage` persistence. Ranking logic. |
| `src/i18n.js` | ~460 | 15-language string table + `t(key, vars)`. |
| `serve.py` | ~16 | Dev-only no-cache static server (port 8090). Not part of the app. |

## Data flow

```
scanner (wss subscribe | http poll)
  → onBlock({ blockNumber, mints, empty, blockTs })
  → store.ingest(...)              // aggregate per contract
  → scheduleRender()               // repaint leaderboard + stream
```

`mints` is a `Map<contractAddress, {count, txs, minters:Set, ...}>` produced by `aggregateLogs()` in `scanner.js`.

## Invariants — break these and things go subtly wrong

1. **The live block stream is NOT persisted.** `store._save()` persists projects only; `store._load()` sets `this.activity = []`. Persisting the stream reintroduces old blocks on refresh → the timeline looks broken (jumps from `#N · 3s` to `#N-100 · 40m ago`). If you touch `store.js` persistence, keep the stream ephemeral.

2. **Never use wall-clock (`Date.now()`) for block-relative time directly.** The user's PC clock can be seconds off. Relative times go through `ago()` in `app.js`, which subtracts `chainSkew` (measured at head arrival = clock error + propagation delay). The block-age ticker counts from `lastHeadAt` (local receive time), not from the block timestamp. Both are clock-skew-proof; keep them that way.

3. **Scanning is latency-critical; background reads are not.** Scan calls go through `rpcHi = pool.call()` — direct, no queue. Background reads (names, images, holders, deployer) go through `rpcMid`/`rpc` = `pool.throttled(...)`. **Do not route scan through the throttle** (it doubles latency) and do not route heavy background reads through `rpcHi` (they starve the scan). This was a real regression.

4. **The throttle has per-lane caps.** `_midQ` (names/images/sim/price — user-facing) is drained first; `_loQ` (holders/deployer/socials — heavy) has an independent `_loCap` so it can't consume every slot and starve the panels the user is looking at. If you add a background read, pick the right lane.

5. **Archive calls must route to archive nodes.** Deployer/age lookups query historical state (`eth_getCode`/`eth_getTransactionCount` at old blocks). Free nodes like publicnode reject this with HTTP 403 "requires personal token". Use `rpcArchive = pool.throttled(..., {archive:true})`; the pool filters to `!_noArchive` nodes and flags rejecters (including a pre-seeded `KNOWN_NO_ARCHIVE` list). Never send an archive call through the plain lane.

6. **Failed background lookups must be retryable.** A lookup guarded by a `Set` (e.g. `deployQueued`) must `delete` from that set on failure, or the UI stays stuck on "looking up…" forever. Only keep it in the set on success.

7. **`t` is the i18n function — don't shadow it.** `const t = $("#deploy-time")` inside a function that also calls `t("some.key")` will call a DOM node as a function and crash. Name DOM refs `elT` etc.

8. **No inline `onerror="...quotes..."` with nested quotes.** Nested single quotes in an HTML attribute break the whole document and silently kill all script after it. Image/media fallbacks use `window.mrImgErr(this)` / `window.mrMediaErr(this)` global functions instead. Keep that pattern.

9. **Watch for TDZ.** `app.js` runs top-level code; a call that references a `const` defined later throws `Cannot access before initialization` and kills everything after it. `setupPending`-style init calls must come *after* their dependencies. (Pending was removed, but the lesson stands.)

## RPC pool mental model (`rpcpool.js`)

- `call(method, params, _tries, _deadline, opts)` — one request with failover. `opts.archive` restricts node choice. 3s per-request timeout, 6s total deadline (so one slow call can't hang the scan).
- `throttled(method, params, prio, opts)` — enqueue a background call. `prio`: `"mid"` (user-facing) or `"lo"` (heavy). Returns a promise.
- `_pick(archiveOnly)` — health-first, then priority, then round-robin within a tier. Skips cooling nodes and (for archive) `_noArchive` nodes.
- Errors: `rateErr` (429/throttle → cooldown+retry), `badNode` (bad data / HTTP error / archive reject → failover). Network/AbortError also failover.

## Scanner mental model (`scanner.js`)

- `createScanner({wsUrl, rpcFn, headFn, onBlock, onHead, onError, onLog})` returns `WsScanner` if `wsUrl` is set, else `MintScanner`.
- **WsScanner** is purely subscription-driven — it does NOT poll. On each `newHead` it debounces 150ms then flushes that block inclusive (`_flushUpTo`). If it can't subscribe (endpoint unsupported) it calls `onError("ws-no-data"/"ws-subscribe-failed")` and app falls back to HTTP.
- **MintScanner** polls ~1s, scans only the recent ~3 blocks (never chases history — the displayed lag is a cache artifact, not a scan gap), merges Transfer/1155 topics into one `eth_getLogs`.

## Adding a chain read

Put it in `erc721.js` as an `async function(rpc, ...)` where `rpc` is a call function (so it works with any lane). Encode calldata by hand (see existing selectors). Decode defensively — free nodes return garbage/HTML under load; assume any field can be missing. Route the call through the right lane in `app.js` (`rpcMid` for user-facing, `rpc` for background, `rpcArchive` for historical state).

## Testing

There is no test suite. Verify with `node --check src/<file>.js` for syntax, then load in a browser and watch the console. For chain-logic changes, a throwaway `.mjs` script hitting real nodes (with `ws`/`fetch`) is the fastest way to confirm behavior — delete it after; do not commit test scripts or a `node_modules` into the repo.

## Things that are NOT bugs

- Free `wss://` endpoints showing ~2–5s block delay — that's propagation + clock skew, not code.
- Metadata/image requests failing with CORS / `ERR_NAME_NOT_RESOLVED` / 404 — those are the *projects'* dead CDNs/IPFS, not our system. Expected and harmless.
- Sparse or empty mint activity — mints are genuinely intermittent on-chain.
- In-session block gaps with a "scanned N blocks" marker — legitimate skips when the tab was backgrounded or the scanner fell >30 blocks behind.
