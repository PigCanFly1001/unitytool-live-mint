// store.js — 内存聚合 (浏览器侧, 无数据库)
//   scanner 每块喂 mint 事件, 这里聚合成: 每个合约的累计volume/minters/快照/最近活动。
//   localStorage 持久化最近状态, 刷新不丢。

const WINDOW_SEC = 6 * 3600;   // minters/volume统计窗口

export class MintStore {
  constructor() {
    this.projects = new Map();   // contract → project
    this.activity = [];          // 最近 mint 活动流 (右栏)
    this._load();
  }

  _now() { return Math.floor(Date.now() / 1000); }

  // 喂一块的 mint 结果 (empty=无 mint, failed=扫失败, skipped=跳过一段老块, blockTs=出块时间戳秒)
  ingest({ blockNumber, mints, empty, failed, skipped, blockTs, fromBlock, toBlock }) {
    const now = this._now();
    let bts = blockTs;
    if (!bts) {
      const prev = this.activity.find(a => a.ts);
      bts = prev ? prev.ts + 12 : now;
      if (bts > now) bts = now;
    }
    // 跳过的一段老块 (落后太多时) → 单独一条 skipped 标记
    if (skipped) {
      this.activity.unshift({ gap: true, skipped: true, fromBlock: fromBlock ?? blockNumber, toBlock: toBlock ?? blockNumber, ts: now });
      if (this.activity.length > 200) this.activity.length = 200;
      this._save();
      return;
    }
    // 无 mint / 扫失败的块: 记入活动流的 gap (连续同类块合并成一段)
    if (empty || failed || !mints || mints.size === 0) {
      const head = this.activity[0];
      if (head && head.gap && !head.skipped && !!head.failed === !!failed) { head.toBlock = blockNumber; head.ts = bts; }
      else this.activity.unshift({ gap: true, failed: !!failed, fromBlock: blockNumber, toBlock: blockNumber, ts: bts });
      if (this.activity.length > 200) this.activity.length = 200;
      this._save();
      return;
    }
    for (const [contract, e] of mints) {
      let p = this.projects.get(contract);
      if (!p) {
        p = { contract, name: null, symbol: null, meta: null, deploy: null, analysis: null,
              seadrop: null, isSeaDrop: null, priceWei: null, priceHistory: [], priceChanged: false,
              std: e.std || 721,   // 721 | 1155 (影响图片 uri(id) vs tokenURI(id))
              firstSeen: now, lastMint: now, totalMinted: 0, totalTxs: 0,
              minters: new Map(), mintCounts: new Map(), snapshots: [], recentTxs: [] };
        this.projects.set(contract, p);
      }
      if (e.std === 1155 && p.std !== 1155) p.std = 1155;   // 升级标记 (合约实际是 1155)
      // 防御: 存档水合后若某 Map 不是 Map (旧版/损坏), 就地修复, 保证 .set 可用
      if (!(p.minters instanceof Map)) p.minters = new Map();
      if (!(p.mintCounts instanceof Map)) p.mintCounts = new Map();
      if (!(p.txMintCount instanceof Map)) p.txMintCount = new Map();   // txHash → 该tx铸了几个
      if (!Array.isArray(p.recentTxs)) p.recentTxs = [];
      if (!Array.isArray(p.snapshots)) p.snapshots = [];
      if (e.txMap) for (const [h, c] of e.txMap) p.txMintCount.set(h, (p.txMintCount.get(h) || 0) + c);
      // 最新 mint 的 tokenId (详情页画廊, 留最近 12 个)
      if (!p.recentTokenIds) p.recentTokenIds = [];
      if (e.tokenIds?.length) { p.recentTokenIds.unshift(...[...e.tokenIds].reverse()); p.recentTokenIds = p.recentTokenIds.slice(0, 12); }
      const txCount = e.txs ? e.txs.size : e.count;
      p.lastMint = bts;
      p.totalMinted += e.count;
      p.totalTxs += txCount;
      for (const m of e.minters) p.minters.set(m, bts);
      // 每地址真实铸造数量 (holder 分布用): 用 scanner 的 mintedBy (该地址实际铸了几个)
      if (e.mintedBy) for (const [m, c] of e.mintedBy) p.mintCounts.set(m, (p.mintCounts.get(m) || 0) + c);
      else for (const m of e.minters) p.mintCounts.set(m, (p.mintCounts.get(m) || 0) + 1);
      // 存最近的 mint txHash (方式/成本分析用) — 去重, 只留最近 120 笔
      if (e.txs) for (const h of e.txs) if (!p.recentTxs.includes(h)) p.recentTxs.push(h);
      if (p.recentTxs.length > 120) p.recentTxs = p.recentTxs.slice(-120);
      // 快照带累计 tx (算窗口内 tx 增量用)
      p.snapshots.push({ ts: bts, total: p.totalMinted, txs: p.totalTxs });
      if (p.snapshots.length > 200) p.snapshots.shift();
      // 活动流: count=mint数量, txs=真实交易数, ts=链上出块时间
      this.activity.unshift({ contract, ts: bts, count: e.count, txs: txCount, uniq: e.minters.size, block: blockNumber });
    }
    // 修剪活动流: 去掉超 1 小时的陈旧块 (防秒数乱跳) + 数量上限
    const cut = now - 3600;
    this.activity = this.activity.filter(a => a.ts && a.ts >= cut);
    if (this.activity.length > 200) this.activity.length = 200;
    this._pruneMinters();
    this._save();
  }

  _pruneMinters() {
    const cut = this._now() - WINDOW_SEC;
    for (const p of this.projects.values()) {
      for (const [m, ts] of p.minters) if (ts < cut) p.minters.delete(m);
    }
  }

  setMeta(contract, meta) {
    const p = this.projects.get(contract);
    if (!p || !meta) return;
    // 合并: 新读到的值优先, 但绝不用 null 覆盖已知值 (RPC 抽风时 max/total 可能读空)
    const prev = p.meta || {};
    p.meta = {
      name: meta.name ?? prev.name ?? null,
      symbol: meta.symbol ?? prev.symbol ?? null,
      totalSupply: meta.totalSupply ?? prev.totalSupply ?? null,
      maxSupply: meta.maxSupply ?? prev.maxSupply ?? null,
      std: meta.std ?? prev.std,
    };
    p.name = p.meta.name || p.name; p.symbol = p.meta.symbol || p.symbol;
    this._save();
  }

  setDeploy(contract, deploy) {
    const p = this.projects.get(contract);
    if (p) { p.deploy = deploy; this._save(); }
  }

  // 标记 SeaDrop + 记录价格; 若价格变了 → 打改价标 + 存历史
  setSeaDrop(contract, sd) {
    const p = this.projects.get(contract);
    if (!p) return;
    p.seadrop = sd; p.isSeaDrop = !!sd;
    // 只有拿到确切价格才记价 (priceUnknown 时别记 0, 否则误判免费/改价)
    if (sd && sd.mintPriceWei != null && !sd.priceUnknown) this.setPrice(contract, sd.mintPriceWei.toString());
    this._save();
  }

  // 记录当前价 (wei 字符串); 与上×不同 → 改价标记 + 历史
  setPrice(contract, priceWei) {
    const p = this.projects.get(contract);
    if (!p || priceWei == null) return;
    const now = this._now();
    if (p.priceWei != null && p.priceWei !== priceWei) {
      p.priceChanged = true;
      p.priceHistory.push({ ts: now, from: p.priceWei, to: priceWei });
      if (p.priceHistory.length > 30) p.priceHistory.shift();
    }
    p.priceWei = priceWei;
    this._save();
  }

  // 铸速: 最早↔最新快照
  rate(p) {
    if (p.snapshots.length < 2) return null;
    const a = p.snapshots[0], b = p.snapshots[p.snapshots.length - 1];
    const dt = b.ts - a.ts, ds = b.total - a.total;
    if (dt <= 0 || ds <= 0) return null;
    return { perHour: ds / dt * 3600, perMin: ds / dt * 60 };
  }

  // 窗口内增量: field="total"(铸造) 或 "txs"(交易). snapshots 里 winSec 秒内的增量。
  windowDelta(p, winSec, field) {
    if (!winSec) return field === "txs" ? (p.totalTxs || 0) : p.totalMinted;
    const cut = this._now() - winSec;
    const inWin = p.snapshots.filter(s => s.ts >= cut);
    if (inWin.length < 1) return 0;
    const first = inWin[0], last = inWin[inWin.length - 1];
    const idx = p.snapshots.indexOf(first);
    const base = idx > 0 ? (p.snapshots[idx - 1][field] || 0) : Math.max(0, (first[field] || 0) - 1);
    return Math.max(0, (last[field] || 0) - base);
  }
  windowMinted(p, winSec) { return this.windowDelta(p, winSec, "total"); }
  windowTxs(p, winSec) { return this.windowDelta(p, winSec, "txs"); }
  // 窗口内独立地址数: p.minters 里 ts 在窗口内的
  windowMinters(p, winSec) {
    if (!winSec) return p.minters.size;
    const cut = this._now() - winSec;
    let n = 0; for (const ts of p.minters.values()) if (ts >= cut) n++;
    return n;
  }

  // 榜单: winSec=时间窗(0=All), sort=minters|minted|newest|progress|window
  ranking({ limit = 80, winSec = 0, sort = "minters" } = {}) {
    const now = this._now();
    let arr = [...this.projects.values()].map(p => {
      const max = p.meta?.maxSupply || 0;
      const total = p.meta?.totalSupply ?? p.totalMinted;
      const winMinted = this.windowMinted(p, winSec);
      return {
        contract: p.contract, name: p.name, symbol: p.symbol,
        totalMinted: p.totalMinted, winMinted,
        // 窗口模式用窗口内值; All 模式用累计值 (一致, 不错位)
        uniqueMinters: winSec ? this.windowMinters(p, winSec) : p.minters.size,
        totalTxs: winSec ? this.windowTxs(p, winSec) : (p.totalTxs || 0),
        totalSupply: total, maxSupply: max || null,
        pct: max > 0 ? Math.min(100, total / max * 100) : null,
        firstSeen: p.firstSeen, lastMint: p.lastMint, rate: this.rate(p),
        isSeaDrop: p.isSeaDrop, priceChanged: p.priceChanged, std: p.std || 721,
      };
    });
    // 时间窗过滤: 只保留窗口内有铸造活动的
    if (winSec) arr = arr.filter(x => (now - x.lastMint) <= winSec);
    const cmp = {
      minters:  (a, b) => b.uniqueMinters - a.uniqueMinters || b.winMinted - a.winMinted,
      minted:   (a, b) => (winSec ? b.winMinted - a.winMinted : b.totalMinted - a.totalMinted),
      mints:    (a, b) => b.totalMinted - a.totalMinted,
      txs:      (a, b) => (b.totalTxs || 0) - (a.totalTxs || 0),
      window:   (a, b) => b.winMinted - a.winMinted,
      newest:   (a, b) => b.lastMint - a.lastMint,
      progress: (a, b) => (b.pct ?? -1) - (a.pct ?? -1),
    }[sort] || ((a, b) => b.uniqueMinters - a.uniqueMinters);
    arr.sort(cmp);
    return arr.slice(0, limit);
  }

  // 右栏活动流 (最近 mint)
  recentActivity({ limit = 50 } = {}) {
    return this.activity.slice(0, limit).map(a => {
      const p = this.projects.get(a.contract);
      return { ...a, name: p?.name, symbol: p?.symbol,
               totalSupply: p?.meta?.totalSupply, maxSupply: p?.meta?.maxSupply };
    });
  }

  get(contract) { return this.projects.get(contract); }

  _save() {
    try {
      const now = this._now();
      const STALE = 12 * 3600;   // 超过 12h 无铸造的项目不存 (刷新后不占版面, 也防 localStorage 撑爆)
      // 只存"最近活跃"的项目, 按最近铸造排序, 最多 300 个 (防 quota 溢出)
      const active = [...this.projects.values()]
        .filter(p => (now - (p.lastMint || 0)) < STALE)
        .sort((a, b) => (b.lastMint || 0) - (a.lastMint || 0))
        .slice(0, 300);
      // activity (区块流) 不再持久化: 它是实时 feed, 存了刷新会把几十分钟前的老块混进来,
      //   造成时间线断裂/乱序。只持久化 projects (名字/图片/排行), 流每次会话从空开始。
      const dump = { savedAt: now,
        projects: active.map(p => ({
          ...p,
          // 所有 Map 都要转成数组才能 JSON 化 (否则序列化成 {}, load 回来不是 Map → .set 崩)
          minters: [...(p.minters?.entries?.() || [])].slice(-200),
          mintCounts: [...(p.mintCounts?.entries?.() || [])].slice(-200),
          txMintCount: [...(p.txMintCount?.entries?.() || [])].slice(-120),
          recentTxs: (p.recentTxs || []).slice(-60),        // 存少点, 够分析用
          snapshots: (p.snapshots || []).slice(-40),
          meta: p.meta,
        })) };
      try { localStorage.setItem("mr_store", JSON.stringify(dump)); }
      catch (e) {
        // quota 溢出 → 只存前 80 个再试一次 (保证能存下, 数据不至于 18h 不更新)
        dump.projects = dump.projects.slice(0, 80);
        try { localStorage.setItem("mr_store", JSON.stringify(dump)); } catch {}
      }
    } catch {}
  }

  _load() {
    try {
      const d = JSON.parse(localStorage.getItem("mr_store") || "null");
      if (!d) return;
      const now = this._now();
      const STALE = 12 * 3600;
      // 区块流不从 cache 恢复 — 始终空开始, 避免老块混入导致时间线断裂/乱序。
      this.activity = [];
      for (const p of d.projects || []) {
        // 跳过已陈旧的项目 (超 12h 无铸造) — 别让 18h 前的老数据占版面
        if ((now - (p.lastMint || 0)) >= STALE) continue;
        // 所有 Map 字段重新水合 (存的是数组); 缺失字段补默认, 防旧版本存档不兼容
        p.minters = new Map(Array.isArray(p.minters) ? p.minters : []);
        p.mintCounts = new Map(Array.isArray(p.mintCounts) ? p.mintCounts : []);
        p.txMintCount = new Map(Array.isArray(p.txMintCount) ? p.txMintCount : []);
        if (!Array.isArray(p.recentTxs)) p.recentTxs = [];
        if (!Array.isArray(p.recentTokenIds)) p.recentTokenIds = [];
        if (!Array.isArray(p.snapshots)) p.snapshots = [];
        if (!Array.isArray(p.priceHistory)) p.priceHistory = [];
        if (p.std !== 1155) p.std = p.std || 721;
        this.projects.set(p.contract, p);
      }
    } catch {
      // 存档损坏/不兼容 → 清掉重来, 别让整个应用卡死
      try { localStorage.removeItem("mr_store"); } catch {}
      this.projects.clear(); this.activity = [];
    }
  }

  clear() { this.projects.clear(); this.activity = []; localStorage.removeItem("mr_store"); }
}
