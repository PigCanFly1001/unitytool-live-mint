// db.js — SQLite 持久层 (Node 内置 node:sqlite, 零依赖)。
//   存: projects (每合约聚合) + activity (区块流) + minters (去重铸造者)。
//   访客打开前端 → 从这里读共享历史, 不再 session-local。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDb(path = "./data/mintradar.db") {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS projects (
      contract     TEXT PRIMARY KEY,
      std          INTEGER DEFAULT 721,
      name         TEXT,
      symbol       TEXT,
      total_supply INTEGER,
      max_supply   INTEGER,
      total_minted INTEGER DEFAULT 0,   -- 累计观测铸造数
      total_txs    INTEGER DEFAULT 0,
      is_seadrop   INTEGER,
      unit_price   TEXT,                -- wei, 字符串存 (bigint)
      dev          TEXT,
      deploy_block INTEGER,
      deploy_ts    INTEGER,
      image        TEXT,
      first_seen   INTEGER,             -- 首次观测 (unix s)
      last_mint    INTEGER,             -- 最近铸造 (unix s)
      meta_json    TEXT                 -- 其余元数据 (socials 等) JSON
    );
    CREATE INDEX IF NOT EXISTS idx_projects_lastmint ON projects(last_mint DESC);

    -- 去重铸造者 (每合约每地址一行, 存该地址在此合约铸造数)
    CREATE TABLE IF NOT EXISTS minters (
      contract TEXT,
      addr     TEXT,
      count    INTEGER DEFAULT 0,
      PRIMARY KEY (contract, addr)
    );

    -- 区块活动流 (每个有铸造的合约每块一行)
    CREATE TABLE IF NOT EXISTS activity (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      contract  TEXT,
      block     INTEGER,
      ts        INTEGER,               -- 块时间戳 (unix s)
      count     INTEGER,               -- 该块该合约铸造数
      txs       INTEGER,
      minters   INTEGER,               -- 该块该合约独立铸造者
      created   INTEGER                -- 入库时刻 (unix s), 用于清理
    );
    CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(ts DESC);
  `);
  return new Store(db);
}

class Store {
  constructor(db) {
    this.db = db;
    // 预编译语句 (热路径)
    this._upsertProject = db.prepare(`
      INSERT INTO projects (contract, std, total_minted, total_txs, first_seen, last_mint)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(contract) DO UPDATE SET
        total_minted = total_minted + excluded.total_minted,
        total_txs    = total_txs + excluded.total_txs,
        last_mint    = excluded.last_mint,
        std          = COALESCE(projects.std, excluded.std)
    `);
    this._bumpMinter = db.prepare(`
      INSERT INTO minters (contract, addr, count) VALUES (?, ?, ?)
      ON CONFLICT(contract, addr) DO UPDATE SET count = count + excluded.count
    `);
    this._insActivity = db.prepare(`
      INSERT INTO activity (contract, block, ts, count, txs, minters, created)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this._setMeta = db.prepare(`
      UPDATE projects SET name=?, symbol=?, total_supply=?, max_supply=?, std=?, meta_json=? WHERE contract=?
    `);
    this._setField = {};
    for (const f of ["is_seadrop", "unit_price", "dev", "deploy_block", "deploy_ts", "image"]) {
      this._setField[f] = db.prepare(`UPDATE projects SET ${f}=? WHERE contract=?`);
    }
  }

  // 每块聚合入库 (worker 调用)。mints: [{contract, std, count, txs, minters:[addr...]}]
  ingestBlock(blockNumber, blockTs, mints) {
    const now = Math.floor(Date.now() / 1000);
    const tx = this.db.exec.bind(this.db);
    this.db.exec("BEGIN");
    try {
      for (const m of mints) {
        const c = m.contract.toLowerCase();
        this._upsertProject.run(c, m.std || 721, m.count, m.txs, blockTs || now, blockTs || now);
        for (const [addr, cnt] of m.minterCounts) this._bumpMinter.run(c, addr.toLowerCase(), cnt);
        this._insActivity.run(c, blockNumber, blockTs || now, m.count, m.txs, m.minterCounts.length, now);
      }
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  setMeta(contract, meta) {
    this._setMeta.run(meta.name ?? null, meta.symbol ?? null, meta.totalSupply ?? null,
      meta.maxSupply ?? null, meta.std ?? 721, meta.extra ? JSON.stringify(meta.extra) : null, contract.toLowerCase());
  }
  setField(contract, field, value) { this._setField[field]?.run(value, contract.toLowerCase()); }

  // ── 读接口 (API 用) ──
  ranking({ limit = 120, winSec = 0, sort = "minters" } = {}) {
    const now = Math.floor(Date.now() / 1000);
    // 窗口统计: 从 activity 里按窗口聚合; winSec=0 用 projects 累计值
    if (winSec > 0) {
      const cut = now - winSec;
      const rows = this.db.prepare(`
        SELECT a.contract,
               SUM(a.count) AS minted,
               SUM(a.txs)   AS txs,
               MAX(a.ts)    AS last_mint,
               p.name, p.symbol, p.std, p.total_supply, p.max_supply,
               p.is_seadrop, p.unit_price, p.image, p.dev
        FROM activity a JOIN projects p ON p.contract = a.contract
        WHERE a.ts >= ?
        GROUP BY a.contract
      `).all(cut);
      // 独立铸造者数 (窗口内) 另查
      const mcount = this.db.prepare(`SELECT COUNT(DISTINCT addr) n FROM minters WHERE contract=?`);
      for (const r of rows) r.minters = mcount.get(r.contract)?.n || 0;
      return this._sortRank(rows, sort).slice(0, limit);
    }
    const rows = this.db.prepare(`
      SELECT p.contract, p.total_minted AS minted, p.total_txs AS txs, p.last_mint,
             p.name, p.symbol, p.std, p.total_supply, p.max_supply,
             p.is_seadrop, p.unit_price, p.image, p.dev,
             (SELECT COUNT(*) FROM minters m WHERE m.contract = p.contract) AS minters
      FROM projects p
      ORDER BY p.last_mint DESC LIMIT ?
    `).all(Math.max(limit, 400));
    return this._sortRank(rows, sort).slice(0, limit);
  }
  _sortRank(rows, sort) {
    const key = sort === "mints" || sort === "minted" ? "minted" : sort === "progress" ? "_prog" : "minters";
    if (key === "_prog") for (const r of rows) r._prog = r.max_supply ? (r.total_supply || 0) / r.max_supply : 0;
    return rows.sort((a, b) => (b[key] || 0) - (a[key] || 0));
  }

  project(contract) {
    const c = contract.toLowerCase();
    const p = this.db.prepare(`SELECT * FROM projects WHERE contract=?`).get(c);
    if (!p) return null;
    p.uniqueMinters = this.db.prepare(`SELECT COUNT(*) n FROM minters WHERE contract=?`).get(c)?.n || 0;
    if (p.meta_json) { try { p.meta = JSON.parse(p.meta_json); } catch {} }
    delete p.meta_json;
    return p;
  }

  activity({ limit = 100 } = {}) {
    return this.db.prepare(`
      SELECT a.contract, a.block, a.ts, a.count, a.txs, a.minters, p.name, p.symbol, p.image, p.std
      FROM activity a LEFT JOIN projects p ON p.contract = a.contract
      ORDER BY a.id DESC LIMIT ?
    `).all(limit);
  }

  // 定期清理: activity 只留最近 N 小时, 防无限增长
  prune(activityHours = 6) {
    const cut = Math.floor(Date.now() / 1000) - activityHours * 3600;
    this.db.prepare(`DELETE FROM activity WHERE ts < ?`).run(cut);
  }

  stats() {
    const p = this.db.prepare(`SELECT COUNT(*) n FROM projects`).get()?.n || 0;
    const a = this.db.prepare(`SELECT COUNT(*) n FROM activity`).get()?.n || 0;
    return { projects: p, activity: a };
  }
}
