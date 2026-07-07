// worker.js — 常驻扫链 worker。复用前端的 scanner.js/erc721.js (纯 JS, Node 22 原生 fetch/ws)。
//   每块的 mints 写进 SQLite; 后台懒补元数据 (名字/图片/部署者)。24/7 运行。
import { createScanner } from "../src/scanner.js";
import { readNftMeta, fetchImage, fetchDeployViaEtherscan, fetchDeployInfo } from "../src/erc721.js";

export function startWorker(store, cfg) {
  const { rpcUrl, wsUrl, etherscanKey, log = console.log } = cfg;

  // 简易 RPC 函数 (直连, 带超时+一次重试)。后端量不大, 不需要前端那套 pool。
  const rpc = async (method, params = [], tries = 0) => {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(8000),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) {
      if (tries < 2) { await new Promise(r => setTimeout(r, 500)); return rpc(method, params, tries + 1); }
      throw e;
    }
  };

  // 元数据补全队列 (懒加载, 别和扫链抢): 每 2s 处理一个缺数据的合约。
  const metaQueue = [];
  const metaSeen = new Set();
  const queueMeta = (contract) => { if (!metaSeen.has(contract)) { metaSeen.add(contract); metaQueue.push(contract); } };

  const scanner = createScanner({
    wsUrl: wsUrl || null,
    rpcFn: rpc,
    onBlock: ({ blockNumber, mints, blockTs }) => {
      if (!mints || mints.size === 0) return;
      // 把 aggregateLogs 的结构转成 db.ingestBlock 需要的
      const rows = [];
      for (const [contract, e] of mints) {
        rows.push({
          contract, std: e.std || 721,
          count: e.count, txs: e.txs.size,
          minterCounts: [...e.mintedBy.entries()],   // [[addr, n], ...]
        });
        queueMeta(contract);
      }
      try { store.ingestBlock(blockNumber, blockTs, rows); }
      catch (err) { log("[db] ingest error:", err.message); }
    },
    onHead: ({ head }) => { lastHead = head; },
    onError: (msg) => log("[scan]", msg),
    onLog: (msg) => log("[scan]", msg),
  });

  let lastHead = 0;
  scanner.start();
  log(`[worker] scanning via ${wsUrl ? "wss " + wsUrl : "http " + rpcUrl}`);

  // 元数据补全循环
  const metaTimer = setInterval(async () => {
    const c = metaQueue.shift();
    if (!c) return;
    try {
      const p = store.project(c);
      if (p && p.name == null) {
        const m = await readNftMeta(rpc, c, p.std);
        if (m && (m.name != null || m.totalSupply != null)) store.setMeta(c, { ...m, std: p.std });
      }
      // 图片
      const p2 = store.project(c);
      if (p2 && !p2.image) {
        const img = await fetchImage(rpc, c, 1, p2.std).catch(() => null);
        if (img) store.setField(c, "image", img);
      }
      // 部署者 (etherscan 优先)
      if (p2 && !p2.dev) {
        let d = etherscanKey ? await fetchDeployViaEtherscan(rpc, c, etherscanKey).catch(() => null) : null;
        if (!d) d = await fetchDeployInfo(rpc, c).catch(() => null);
        if (d?.dev) {
          store.setField(c, "dev", d.dev);
          if (d.deployBlock) store.setField(c, "deploy_block", d.deployBlock);
          if (d.deployTs) store.setField(c, "deploy_ts", d.deployTs);
        }
      }
    } catch (e) { /* 失败下次再补 */ metaSeen.delete(c); }
  }, 2000);

  // 定期清理旧 activity
  const pruneTimer = setInterval(() => { try { store.prune(6); } catch {} }, 10 * 60 * 1000);

  return {
    stop() { scanner.stop(); clearInterval(metaTimer); clearInterval(pruneTimer); },
    status() { return { lastHead, metaQueue: metaQueue.length, ...store.stats() }; },
  };
}
