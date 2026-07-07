// rpcpool.js — 多 RPC 池管理 (原创)
//   · 按优先度选节点, 轮换分摊请求
//   · 每个 RPC 可设 rate limit (req/s); 超限则退避
//   · 命中 429/限流 → 自动降权cooldown , 切下一个 (智能侦测限流)
//   · All localStorage 持久化

// 默认公共节点 (无需 key, 免费). 用户可在设置弹窗改/加自己的。
// 默认节点 — 实测稳定的排前面 (publicnode/mevblocker/1rpc); drpc 用于历史/归档 (会限流放后);
//   llamarpc/merkle 常返回 HTML 错误页, 只做最后兜底 (健康优先算法会自动少用它们)。
// 只保留实测稳定可用的节点 (getLogs/blockNumber 都通过)。坏节点 (llamarpc/merkle/1rpc/ankr…)
//   全删掉 — 它们返回 HTML/块0/限流, 留着只会疯狂失败重试, 拖慢一切。用户想加自己的可在设置里加。
const DEFAULT_POOL = [
  { url: "https://ethereum-rpc.publicnode.com",   label: "publicnode", priority: 1, rps: 8 },
  { url: "https://eth.drpc.org",                  label: "drpc",       priority: 1, rps: 5 },
  { url: "https://eth-mainnet.public.blastapi.io", label: "blastapi",  priority: 1, rps: 5 },
];

// 已知不支持 archive (历史 state) 的节点 → archive 请求 (部署信息/地址年龄) 直接跳过, 不浪费一次失败。
//   publicnode 免费档: eth_getCode/eth_getTransactionCount 查历史块返回 403 "requires personal token"。
const KNOWN_NO_ARCHIVE = /publicnode\.com/i;

const POOL_VER = "4";   // v4: 只留 3 个实测稳定节点 (publicnode/drpc/blastapi), 删所有坏节点
function loadPool() {
  try {
    // 只有用户自己加过节点才保留存档; 否则用最新默认池 (修复旧存档里的坏节点顺序)
    if (localStorage.getItem("mr_poolver") === POOL_VER) {
      const saved = JSON.parse(localStorage.getItem("mr_rpcpool") || "null");
      if (saved && Array.isArray(saved) && saved.length) return saved;
    } else {
      localStorage.setItem("mr_poolver", POOL_VER);
      localStorage.removeItem("mr_rpcpool");   // 清旧默认池
    }
  } catch {}
  return DEFAULT_POOL.slice();
}

export class RpcPool {
  constructor() {
    this.nodes = loadPool().map(n => ({
      url: n.url, label: n.label || hostOf(n.url),
      priority: n.priority ?? 5, rps: n.rps ?? 5,
      _sent: [],          // 最近请求时间戳 (滑动窗口限流)
      _cooldownUntil: 0,  // 限流cooldown 到期时间
      _fails: 0, _ok: 0,  // 健康统计
      // 该节点拒绝历史 state 查询 (archive 请求跳过它)。已知非 archive 节点 (publicnode 返回
      //   403 "requires personal token") 直接预标记, 免得首个 archive 请求还去撞它一次。
      _noArchive: KNOWN_NO_ARCHIVE.test(n.url),
    }));
    this._rr = 0;         // round-robin 指针
    // ── 轻量后台节流 (只管后台任务, 扫链直连不走这里) ──
    //   扫链走 pool.call() 直连, 零队列延迟。后台 (名字/图片/holder) 走 throttled 队列限并发省 RPC。
    //   设计原则: 简单、防死锁 (每个 job 有超时兜底, _inflight 永不卡住)。
    this.saveTokens = (localStorage.getItem("mr_saveTokens") ?? "1") === "1";
    this._inflight = 0;
    this._loInflight = 0; // lo lane 独立在途计数 (防止重 lo 任务占满全部槽饿死 mid)
    this._midQ = [];     // 名字/图片/模拟/价格 (用户盯着看)
    this._loQ = [];      // holder/schedule/social (可慢)
  }

  // 后台并发上限 (节点实测很快, 放宽以免详情面板一堆读排队饿死)
  _maxConc() { return this.saveTokens ? 8 : 12; }
  // lo lane (holder/deploy/social — 重且慢) 的独立上限: 不能占满所有槽, 否则 mid(名字/图片/
  //   模拟/价格) 会被饿死 → 面板一直转圈。给 lo 留一半, 另一半永远留给 mid。
  _loCap() { return Math.max(2, Math.floor(this._maxConc() / 2)); }
  setSaveTokens(on) { this.saveTokens = !!on; localStorage.setItem("mr_saveTokens", on ? "1" : "0"); this._drain(); }

  // 后台节流入口: prio="mid"(名字/图片/模拟/价格 — 用户盯着看) | "lo"(holder/deploy/social — 可慢)。
  //   opts.archive=true: 该请求要查历史 state (部署信息/地址年龄) → 只发给支持 archive 的节点。
  throttled(method, params = [], prio = "lo", opts = {}) {
    return new Promise((resolve, reject) => {
      (prio === "mid" ? this._midQ : this._loQ).push({ method, params, resolve, reject, opts });
      this._drain();
    });
  }
  _drain() {
    const cap = this._maxConc(), loCap = this._loCap();
    // 先尽量发 mid (用户可见的面板优先); 再在 lo 独立配额内发 lo → lo 再多也不会堵死 mid。
    while (this._inflight < cap && (this._midQ.length || (this._loQ.length && this._loInflight < loCap))) {
      let job, isLo = false;
      if (this._midQ.length) job = this._midQ.shift();
      else if (this._loQ.length && this._loInflight < loCap) { job = this._loQ.shift(); isLo = true; }
      if (!job) break;
      this._inflight++;
      if (isLo) this._loInflight++;
      this.call(job.method, job.params, 0, 0, job.opts || {})
        .then(job.resolve, job.reject)
        .finally(() => { this._inflight--; if (isLo) this._loInflight--; this._drain(); });
    }
  }

  // 多节点竞速取最新 head: 免费节点各自有几秒传播延迟, 哪个先同步到新块就用哪个 → 降低发现延迟。
  //   直接 fetch 各健康节点的 eth_blockNumber, 取最大 (最新) 的。快, 且绕过队列。
  async fastestHead() {
    const now = Date.now();
    const nodes = this.nodes.filter(n => now >= n._cooldownUntil).slice(0, 4);   // 最多问 4 个
    if (!nodes.length) return null;
    const results = await Promise.all(nodes.map(async n => {
      try {
        const sig = (typeof AbortSignal !== "undefined" && AbortSignal.timeout) ? AbortSignal.timeout(2500) : undefined;
        const res = await fetch(n.url, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber" }), signal: sig });
        const j = await res.json();
        const h = parseInt(j.result, 16);
        if (h > 0) { n._ok++; return h; }
      } catch {}
      return 0;
    }));
    const max = Math.max(0, ...results);
    return max || null;
  }

  list() { return this.nodes; }
  save() {
    localStorage.setItem("mr_rpcpool", JSON.stringify(
      this.nodes.map(n => ({ url: n.url, label: n.label, priority: n.priority, rps: n.rps }))));
  }
  add(url, opts = {}) {
    if (!/^https?:\/\//.test(url)) return false;
    if (this.nodes.some(n => n.url === url)) return false;
    this.nodes.push({ url, label: opts.label || hostOf(url), priority: opts.priority ?? 5, rps: opts.rps ?? 5, _sent: [], _cooldownUntil: 0, _fails: 0, _ok: 0, _noArchive: KNOWN_NO_ARCHIVE.test(url) });
    this.save(); return true;
  }
  remove(url) { this.nodes = this.nodes.filter(n => n.url !== url); this.save(); }
  update(url, patch) { const n = this.nodes.find(x => x.url === url); if (n) { Object.assign(n, patch); this.save(); } }

  // 选一个当前可用节点: 未cooldown + 未超 rps; 健康(连续失败少)优先, 再按 priority, 同级轮换。
  //   健康优先能自动避开经常返回 HTML/限流的坏节点 (llamarpc/merkle 等), 大幅降低延迟和失败。
  //   archiveOnly=true: 只选支持历史 state 查询的节点 (部署信息/地址年龄要二分查老块) —
  //   跳过明确拒过 archive 的节点 (如 publicnode "requires personal token"), 否则每次抽中它就白失败。
  _pick(archiveOnly = false) {
    const now = Date.now();
    let avail = this.nodes
      .filter(n => now >= n._cooldownUntil)
      .filter(n => {
        n._sent = n._sent.filter(t => now - t < 1000);
        return n._sent.length < n.rps;
      });
    if (archiveOnly) {
      const arch = avail.filter(n => !n._noArchive);
      if (arch.length) avail = arch;   // 有 archive 节点就只用它们; 全没有就退回不筛 (总比不查强)
    }
    if (!avail.length) return null;
    // 排序: ① 健康档 (连续失败 <2 优先) ② priority ③ 累计成功多的优先
    const healthTier = n => (n._fails >= 2 ? 1 : 0);   // 近期失败多的降到后面
    avail.sort((a, b) => healthTier(a) - healthTier(b) || a.priority - b.priority || (b._ok || 0) - (a._ok || 0));
    // 同(健康档+priority)里轮换, 分摊负载
    const t0 = healthTier(avail[0]), p0 = avail[0].priority;
    const same = avail.filter(n => healthTier(n) === t0 && n.priority === p0);
    const node = same[this._rr++ % same.length];
    node._sent.push(now);
    return node;
  }

  // 发一个 JSON-RPC 请求, 自动选节点 + 限流退避 + 命中限流切换重试。
  //   _deadline: 整个 call (含所有重试) 的截止时间, 防止一个请求卡几十秒 (拖慢扫链)。
  async call(method, params = [], _tries = 0, _deadline = 0, opts = {}) {
    if (!_deadline) _deadline = Date.now() + 6000;   // 整个 call 最多 6 秒 (含重试)
    if (Date.now() > _deadline) throw new Error("rpc call timed out (all nodes slow)");
    const node = this._pick(opts.archive);
    if (!node) {
      if (_tries > 6 || Date.now() > _deadline) throw new Error("all RPCs busy");
      await sleep(200);
      return this.call(method, params, _tries + 1, _deadline, opts);
    }
    try {
      // 单次请求硬超时 3s → 慢节点快速放弃换下一个 (扫链要快)
      const signal = (typeof AbortSignal !== "undefined" && AbortSignal.timeout) ? AbortSignal.timeout(3000) : undefined;
      const res = await fetch(node.url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal,
      });
      if (res.status === 429 || res.status === 503) throw rateErr(res.status);
      // 非 2xx (Cloudflare 403/5xx/网关错误) → 换节点重试。但 403 常是"archive 需要 token"
      //   (publicnode 就这样), body 里带 archive 关键词 → 永久标记该节点无 archive, 以后 archive 请求跳过它。
      if (!res.ok) {
        if (res.status === 403) {
          let body = ""; try { body = await res.text(); } catch {}
          if (/archive|personal token|allnodes/i.test(body)) node._noArchive = true;
        }
        throw badNode(`HTTP ${res.status}`);
      }
      // 有些免费节点在限流/维护时返回 HTML 错误页, res.json() 会抛 SyntaxError → 当作节点故障切换
      const text = await res.text();
      let j;
      try { j = JSON.parse(text); }
      catch { throw badNode(text.slice(0, 40).replace(/\s+/g, " ")); }
      if (j.error) {
        const msg = j.error.message || "";
        // RPC 层限流关键词 → 当限流处理
        if (/rate.?limit|too many|429|capacity|throttl/i.test(msg)) throw rateErr("rpc");
        // 明确的 archive 拒绝 → 永久标记该节点无 archive, 以后 archive 请求跳过它 (不再白抽中失败)
        if (/archive|personal token|missing trie|state.*(unavailable|not available)|no historical/i.test(msg)) { node._noArchive = true; throw badNode(msg.slice(0, 60)); }
        // 其他容量/鉴权类错误 → 换个节点可能能查 (不是致命)
        if (/not available|429|unauthori[sz]|authenticate|api.?key|forbidden|access denied/i.test(msg)) throw badNode(msg.slice(0, 60));
        throw new Error(msg);
      }
      // 侦测坏数据: eth_blockNumber 返回 0x0/空 = 节点没同步/返回垃圾 → 当故障切换
      if (method === "eth_blockNumber" && (!j.result || j.result === "0x0" || j.result === "0x")) throw badNode("stale/zero block number");
      node._ok++; node._fails = 0;
      return j.result;
    } catch (e) {
      // 限流 / 节点故障 / 网络超时(AbortError)/连接失败 都触发切换重试
      const isNet = e.name === "AbortError" || e.name === "TimeoutError" || /fetch failed|network|timeout|ECONN|ETIMEDOUT/i.test(e.message || "");
      if (e._rate || e._badNode || isNet) {
        node._fails++;
        const base = e._rate ? 1500 : 800;
        node._cooldownUntil = Date.now() + Math.min(30000, base * Math.pow(2, Math.min(node._fails, 5)));
        if (_tries > this.nodes.length + 4 || Date.now() > _deadline) throw new Error(e._rate ? "all RPCs rate-limited" : "all RPCs failing");
        return this.call(method, params, _tries + 1, _deadline, opts);
      }
      node._fails++;
      throw e;
    }
  }

  // 健康快照 (弹窗显示用)
  health() {
    const now = Date.now();
    return this.nodes.map(n => ({
      url: n.url, label: n.label, priority: n.priority, rps: n.rps,
      cooling: now < n._cooldownUntil, cooldownMs: Math.max(0, n._cooldownUntil - now),
      ok: n._ok, fails: n._fails,
    }));
  }
}

function hostOf(u) { try { return new URL(u).host; } catch { return u.slice(0, 24); } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rateErr(code) { const e = new Error("rate limit (" + code + ")"); e._rate = true; return e; }
// 节点返回坏数据 (HTML/非JSON/HTTP错/归档限制) — 触发换节点重试, 非致命
function badNode(detail) { const e = new Error("bad RPC response: " + detail); e._badNode = true; return e; }
