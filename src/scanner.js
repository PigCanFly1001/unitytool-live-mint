// scanner.js — 浏览器侧链上 mint 扫描器 (零后端, 用户自带 RPC)
//   逐块拉 Transfer(from=0x0) = mint, 聚合成 "谁在被 mint / volume / minters"。
//   纯 JSON-RPC (fetch), 不依赖任何库, 兼容任意 EVM RPC。

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC = "0x0000000000000000000000000000000000000000000000000000000000000000";
// ERC1155: TransferSingle(operator,from,to,id,value) / TransferBatch(operator,from,to,ids[],values[])
const TS_SINGLE = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
const TS_BATCH  = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";
// pending mint 识别: 已知 SeaDrop 合约 + 常见 mint 函数 selector
const SEADROP_ADDRS = new Set(["0x00005ea00ac477b1030ce78506496e8c2de24bf5", "0x00005ea00ac477b1030ce78506496e8c2de24bf6"]);
const MINT_SELECTORS = new Set(["0x1249c58b", "0xa0712d68", "0x40c10f19", "0x161ac21f", "0x84bb1e42", "0xa723533e", "0xefef39a1", "0x6a627842", "0xd85d3d27", "0x4b61cd6f", "0xcd6e13f7", "0x2db11544", "0x94bf804d", "0xfa54cf1b"]);

// 从 32字节字 slice 读第 i 个字 (hex, 无 0x)
const word = (hex, i) => hex.slice(i * 64, (i + 1) * 64);
const addrFromTopic = t => "0x" + t.slice(26).toLowerCase();

// 解 TransferSingle data = [id][value]; 返回 [{tokenId, amount}]
function decodeSingle(dataHex) {
  const h = (dataHex || "0x").replace(/^0x/, "");
  if (h.length < 128) return [];
  try { return [{ tokenId: BigInt("0x" + word(h, 0)).toString(), amount: Number(BigInt("0x" + word(h, 1))) }]; }
  catch { return []; }
}
// 解 TransferBatch data = [off_ids][off_vals][ids.len][ids...][vals.len][vals...]
function decodeBatch(dataHex) {
  const h = (dataHex || "0x").replace(/^0x/, "");
  try {
    const idsOff = Number(BigInt("0x" + word(h, 0))) / 32;
    const valsOff = Number(BigInt("0x" + word(h, 1))) / 32;
    const nIds = Number(BigInt("0x" + word(h, idsOff)));
    const nVals = Number(BigInt("0x" + word(h, valsOff)));
    const out = [];
    for (let k = 0; k < nIds; k++) {
      const id = BigInt("0x" + word(h, idsOff + 1 + k)).toString();
      const amt = k < nVals ? Number(BigInt("0x" + word(h, valsOff + 1 + k))) : 1;
      out.push({ tokenId: id, amount: amt });
    }
    return out;
  } catch { return []; }
}

// 把一批原始日志 (混合 721/1155) 聚合成 Map<contract, {count, minters, ...}>
//   http 轮询 (3 次 getLogs) 和 wss 订阅 (一路 logs 流) 共用这个解码逻辑。
function aggregateLogs(logs) {
  const mints = new Map();
  const ent = (contract, std) => {
    let e = mints.get(contract);
    if (!e) { e = { count: 0, minters: new Set(), mintedBy: new Map(), txs: new Set(), txMap: new Map(), tokenIds: [], std }; mints.set(contract, e); }
    if (std === 1155) e.std = 1155;
    return e;
  };
  const addTx = (e, l, minted) => {
    if (l.transactionHash) { e.txs.add(l.transactionHash); e.txMap.set(l.transactionHash, (e.txMap.get(l.transactionHash) || 0) + minted); }
  };
  for (const l of logs || []) {
    if (!l.topics || !l.topics.length) continue;
    const t0 = l.topics[0];
    const contract = l.address.toLowerCase();
    if (t0 === TRANSFER_TOPIC) {
      // ERC721 mint: 4 topics + from=0x0
      if (l.topics.length < 4 || l.topics[1] !== ZERO_TOPIC) continue;
      const e = ent(contract, 721);
      e.count++;
      if (l.topics[3]) { try { e.tokenIds.push(BigInt(l.topics[3]).toString()); } catch {} }
      const to = addrFromTopic(l.topics[2]);
      e.minters.add(to); e.mintedBy.set(to, (e.mintedBy.get(to) || 0) + 1);
      addTx(e, l, 1);
    } else if (t0 === TS_SINGLE || t0 === TS_BATCH) {
      // ERC1155 mint: from(=topics[2]) = 0x0
      if (l.topics.length < 4 || l.topics[2] !== ZERO_TOPIC) continue;
      const e = ent(contract, 1155);
      const to = addrFromTopic(l.topics[3]);
      const items = t0 === TS_SINGLE ? decodeSingle(l.data) : decodeBatch(l.data);
      let n = 0;
      for (const it of items) { n += it.amount; e.tokenIds.push(it.tokenId); }
      if (!n) n = 1;
      e.count += n;
      e.minters.add(to); e.mintedBy.set(to, (e.mintedBy.get(to) || 0) + n);
      addTx(e, l, n);
    }
  }
  for (const e of mints.values()) if (e.tokenIds.length) e.tokenIds = [...new Set(e.tokenIds)].slice(-24);
  return mints;
}

export class MintScanner {
  /**
   * @param {object} opts
   * @param {string} opts.rpcUrl        用户输入的 RPC (http/https)
   * @param {(ev:object)=>void} opts.onBlock   每块扫完回调 {blockNumber, mints:Map}
   * @param {(msg:string)=>void} [opts.onLog]
   * @param {(err:string)=>void} [opts.onError]
   * @param {number} [opts.pollMs]      轮询间隔 (默认 4000, 适配免费 RPC)
   */
  constructor(opts) {
    // rpcFn: 注入的 (method, params)=>Promise (来自 RPC 池, 自带轮换/限流退避)
    //   兼容旧用法: 若只给 rpcUrl 则内部包一个单节点 rpcFn。
    this.rpcFn = opts.rpcFn || null;
    this.headFn = opts.headFn || null;   // 可选: 多节点竞速取最新 head (降低传播延迟)
    this.rpcUrl = opts.rpcUrl || null;
    this.onBlock = opts.onBlock || (() => {});
    this.onHead = opts.onHead || (() => {});
    this._headSeen = null; this._headAt = 0;
    this.onLog = opts.onLog || (() => {});
    this.onError = opts.onError || (() => {});
    this.pollMs = opts.pollMs || 1000;   // 固定 1s 轮询 → 出块 1 秒内发现, 近 0 延迟
    this.running = false;
    this.lastBlock = null;
    this._id = 1;
    this._timer = null;
  }

  async rpc(method, params = []) {
    if (this.rpcFn) return this.rpcFn(method, params);
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this._id++, method, params }),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || "RPC error");
    return j.result;
  }

  // 预检 RPC: 返回链 id + 最新块, 失败抛错 (供 UI 提示用户 RPC 无效)
  async preflight() {
    const [chainId, block] = await Promise.all([
      this.rpc("eth_chainId"),
      this.rpc("eth_blockNumber"),
    ]);
    return { chainId: parseInt(chainId, 16), block: parseInt(block, 16) };
  }

  // 扫单块的 mint (ERC721 Transfer from=0x0 + ERC1155 TransferSingle/Batch from=0x0)
  //   返回 { mints:Map, blockTs:number|null }  (blockTs = 链上出块时间戳, 秒)
  async scanBlock(blockNum) {
    const hex = "0x" + blockNum.toString(16);
    // 单次 getLogs 拉全部 3 类 mint 事件 (topic0 用数组 = OR 匹配), 请求量降到 1/3。
    //   from=0x0 的过滤在 JS 侧做 (721 看 topic[1], 1155 看 topic[2]), 因为两者位置不同不能靠 RPC 一次过滤。
    let all;
    try {
      all = await this.rpc("eth_getLogs", [{ fromBlock: hex, toBlock: hex, topics: [[TRANSFER_TOPIC, TS_SINGLE, TS_BATCH]] }]);
    } catch (e) {
      // 有些老节点不支持 topic0 数组 → 退回分 3 次 (仍带重试语义由池处理)
      const [a, b, c] = await Promise.all([
        this.rpc("eth_getLogs", [{ fromBlock: hex, toBlock: hex, topics: [TRANSFER_TOPIC, ZERO_TOPIC] }]).catch(() => null),
        this.rpc("eth_getLogs", [{ fromBlock: hex, toBlock: hex, topics: [TS_SINGLE, null, ZERO_TOPIC] }]).catch(() => []),
        this.rpc("eth_getLogs", [{ fromBlock: hex, toBlock: hex, topics: [TS_BATCH, null, ZERO_TOPIC] }]).catch(() => []),
      ]);
      if (a === null && !(b?.length) && !(c?.length)) throw new Error("all getLogs failed for block");
      all = [...(a || []), ...(b || []), ...(c || [])];
    }
    const mints = aggregateLogs(all || []);
    // 出块时间: 优先用日志里带的 blockTimestamp (新版 RPC 有), 否则拉块头 (仅有 mint 时才拉, 省请求)
    let blockTs = null;
    const rawTs = all.find(l => l.blockTimestamp)?.blockTimestamp;
    if (rawTs != null) { try { blockTs = parseInt(rawTs, 16); } catch {} }
    else if (mints.size > 0) {
      try { const blk = await this.rpc("eth_getBlockByNumber", [hex, false]); if (blk?.timestamp) blockTs = parseInt(blk.timestamp, 16); } catch {}
    }
    return { mints, blockTs };
  }

  // 扫 mempool pending 块, 找正在排队 (还没上链) 的 mint tx。
  //   返回 Map<nftContract, {count, tx:Set, from:Set}> — 比已上链的信号榜更超前。
  async scanPending() {
    let blk;
    try { blk = await this.rpc("eth_getBlockByNumber", ["pending", true]); }
    catch { return null; }
    if (!blk?.transactions) return null;
    const pend = new Map();
    for (const tx of blk.transactions) {
      const sel = (tx.input || "0x").slice(0, 10);
      const to = (tx.to || "").toLowerCase();
      const isSD = SEADROP_ADDRS.has(to);
      if (!isSD && !MINT_SELECTORS.has(sel)) continue;
      // SeaDrop mint 目标 = calldata 首参 (nftContract); 否则 = to
      let target = to;
      if (isSD && tx.input && tx.input.length >= 74) target = "0x" + tx.input.slice(34, 74);
      if (!/^0x[0-9a-f]{40}$/i.test(target)) continue;
      let e = pend.get(target);
      if (!e) { e = { count: 0, txs: new Set(), from: new Set() }; pend.set(target, e); }
      e.count++;
      if (tx.hash) e.txs.add(tx.hash);
      if (tx.from) e.from.add(tx.from.toLowerCase());
    }
    return pend;
  }

  async _tick() {
    if (!this.running) return;
    // 防卡: 记录本次 tick 开始, 若某个 await 挂太久, 下面的兜底会强制重排
    this._tickAt = Date.now();
    try {
      // 多节点竞速取最新 head (哪个节点先同步到新块就用哪个 → 降低传播延迟); 无 headFn 则单节点。
      const head = this.headFn ? await this.headFn() : parseInt(await this.rpc("eth_blockNumber"), 16);
      // 侦测坏数据: head 为 0/NaN, 或比已知块倒退太多 (>5) = 节点返回垃圾/落后 → 忽略这次
      if (!head || isNaN(head) || (this._headSeen && head < this._headSeen - 5)) {
        this.onError("bad head from node: " + head);
        if (this.running) this._timer = setTimeout(() => this._tick(), 500);
        return;
      }
      // 新块出现 → 即时通知; 出块时间戳后台补 (不 await, 不拖慢扫链)。
      if (head > this._headSeen || this._headSeen == null) {
        this._headSeen = head; this._headAt = Date.now();
        this.onHead?.({ head, at: this._headAt, headTs: null });
        this.rpc("eth_getBlockByNumber", ["0x" + head.toString(16), false])
          .then(blk => { if (blk?.timestamp) { this._headTs = parseInt(blk.timestamp, 16); this.onHead?.({ head, at: this._headAt, headTs: this._headTs }); } })
          .catch(() => {});
      }
      // 只扫最新块, 不追历史。落后的旧块 mint 已过时 (狙击也来不及), 直接跳到 head 附近。
      //   窗口: 最多回扫 3 块 (兜住网络抖动漏的相邻块), 更早的不管 → 永远贴着 head, 不会卡/落后。
      if (this.lastBlock == null) this.lastBlock = head - 1;
      const from = Math.max(this.lastBlock + 1, head - 3);   // 只扫最近 ~3 块
      for (let b = from; b <= head; b++) {
        let res = null;
        for (let attempt = 0; attempt < 2 && res == null; attempt++) {
          try { res = await this.scanBlock(b); }
          catch (e) { if (attempt === 1) this.onError(`block ${b}: ${e.message}`); }
        }
        if (res) this.onBlock({ blockNumber: b, mints: res.mints, blockTs: res.blockTs, empty: res.mints.size === 0 });
        else this.onBlock({ blockNumber: b, mints: new Map(), empty: true, failed: true });
      }
      this.lastBlock = head;
      this._behind = 0;   // 永远贴着 head, 不追赶
    } catch (e) {
      this.onError(e.message);
    }
    // ── 调度: 固定快轮询 (1s), 出块后最多 1 秒发现 = 近 0 延迟。
    //   省 RPC 靠"每块只 1 次 getLogs + 只扫最新块", 不靠睡长觉 (睡久了会错过新块、有延迟)。
    if (this.running) this._timer = setTimeout(() => this._tick(), this.pollMs);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.onLog("scan started");
    this._tick();
    // 看门狗: 若某次 tick 卡住 (某 await 挂死) 超 10s, 强制重启一轮 → 永不停摆
    this._watchdog = setInterval(() => {
      if (!this.running) return;
      if (this._tickAt && Date.now() - this._tickAt > 10000) {
        this.onLog("scan watchdog: tick stalled, restarting");
        this._tickAt = Date.now();
        this._tick();
      }
    }, 5000);
  }

  stop() {
    this.running = false;
    if (this._timer) clearTimeout(this._timer);
    if (this._watchdog) clearInterval(this._watchdog);
    this.onLog("scan stopped");
  }
}

// ───────────────────────────────────────────────────────────
// WsScanner — WebSocket 订阅版 (更实时, 省配额). 用户 RPC 是 wss:// 时用它。
//   订阅 logs (全链 Transfer/1155 mint 事件) + newHeads (出块时间), 按块缓冲后 flush。
//   自动重连 (断线指数退避). 接口与 MintScanner 一致 (onBlock/onHead/onError/onLog)。
// ───────────────────────────────────────────────────────────
export class WsScanner {
  constructor(opts) {
    this.wsUrl = opts.wsUrl;
    this.onBlock = opts.onBlock || (() => {});
    this.onHead = opts.onHead || (() => {});
    this.onError = opts.onError || (() => {});
    this.onLog = opts.onLog || (() => {});
    this.running = false;
    this.ws = null;
    this._id = 1;
    this._pending = new Map();    // reqId → resolve (rpc 调用)
    this._subs = {};              // subId → "logs" | "heads"
    this._buf = new Map();        // blockNumber(int) → [logs]  (按块缓冲, 出新块时 flush 前一块)
    this._maxBlock = 0;
    this._retry = 0;
    this._reconnectT = null;
  }

  _send(method, params = []) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error("ws not open"));
      const id = this._id++;
      this._pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      setTimeout(() => { if (this._pending.has(id)) { this._pending.delete(id); reject(new Error("ws timeout")); } }, 8000);
    });
  }
  // 公开: 通过 wss 发普通 RPC 请求 (名字/图片/eth_call 等都能走 wss, 不用另开 http 池)。
  //   ws 没连上时抛错, 上层可回退 http。返回 result (和 pool.call 一致)。
  request(method, params = []) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error("ws not open"));
    return this._send(method, params).then(r => {
      if (r && r.error) throw new Error(r.error.message || "rpc error");
      return r;
    });
  }

  _connect() {
    if (!this.running) return;
    let ws;
    try { ws = new WebSocket(this.wsUrl); }
    catch (e) { this.onError("ws open failed: " + e.message); return this._scheduleReconnect(); }
    this.ws = ws;
    ws.onopen = async () => {
      this._retry = 0;
      this.onLog("ws connected");
      try {
        // 订阅所有 mint 相关日志: Transfer(from=0) + 1155 Single/Batch(from=0)
        const [sHeads, sT, sS, sB] = await Promise.all([
          this._send("eth_subscribe", ["newHeads"]),
          this._send("eth_subscribe", ["logs", { topics: [TRANSFER_TOPIC, ZERO_TOPIC] }]),
          this._send("eth_subscribe", ["logs", { topics: [TS_SINGLE, null, ZERO_TOPIC] }]),
          this._send("eth_subscribe", ["logs", { topics: [TS_BATCH, null, ZERO_TOPIC] }]),
        ]);
        this._subs = { [sHeads]: "heads", [sT]: "logs", [sS]: "logs", [sB]: "logs" };
        this.onLog("ws subscribed — waiting for blocks");
        // 看门狗: 若 40s 内没收到任何 newHead, 判定该 wss 端点不支持订阅 → 通知上层
        clearTimeout(this._watchdog);
        this._gotHead = false;
        this._watchdog = setTimeout(() => {
          if (!this._gotHead && this.running) this.onError("ws-no-data: no blocks in 40s — this wss endpoint may not support eth_subscribe. Try HTTP mode.");
        }, 40000);
      } catch (e) {
        // 订阅被拒 (端点不支持 eth_subscribe) → 明确告知上层可切 http
        this.onError("ws-subscribe-failed: " + e.message + " — this endpoint may not support subscriptions. Try HTTP mode.");
        this._reconnect();
      }
    };
    ws.onmessage = (ev) => this._onMessage(ev.data);
    ws.onerror = () => this.onError("ws error");
    ws.onclose = () => { if (this.running) this._scheduleReconnect(); };
  }

  _onMessage(raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    // rpc 响应 (订阅确认等)
    if (msg.id != null && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id); this._pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || "rpc error")); else p.resolve(msg.result);
      return;
    }
    // 订阅推送
    if (msg.method === "eth_subscription" && msg.params) {
      const kind = this._subs[msg.params.subscription];
      const data = msg.params.result;
      if (kind === "heads") this._onHead(data);
      else if (kind === "logs") this._onLogPush(data);
    }
  }

  _onHead(head) {
    const bn = parseInt(head.number, 16);
    this._gotHead = true; clearTimeout(this._watchdog);
    let headTs = null; try { if (head.timestamp) headTs = parseInt(head.timestamp, 16); } catch {}
    this.onHead?.({ head: bn, at: Date.now(), headTs });
    // head N 到达 = 块 N 已确认, 它的 logs 也都推完了 → 立即 flush 到 N (含 N), 不等下一块。
    //   稍等 150ms 让同块剩余 log 推完 (它们和 head 几乎同时到), 再 flush → mint 秒出, 不延迟一个周期。
    clearTimeout(this._flushT);
    this._flushT = setTimeout(() => this._flushUpTo(bn, headTs), 150);
    this._maxBlock = Math.max(this._maxBlock, bn);
  }

  _onLogPush(log) {
    if (log.removed) return;   // 链重组撤销的日志, 忽略
    const bn = parseInt(log.blockNumber, 16);
    if (!this._buf.has(bn)) this._buf.set(bn, []);
    this._buf.get(bn).push(log);
  }

  // flush 所有块号 <= upTo 的缓冲 (含 upTo 本身 → mint 秒出, 不等下一块)。含空块上报保持 gap 显示。
  _flushUpTo(upTo, headTs) {
    // 首次 flush: 只报最新块, 别把历史几百块全报出来 (刚连上时)
    let from = this._lastFlushed != null ? this._lastFlushed + 1 : upTo;
    if (upTo - from > 30) from = upTo;   // 落后太多 → 只报最新, 不补历史
    for (let b = from; b <= upTo; b++) {
      const logs = this._buf.get(b) || [];
      const mints = aggregateLogs(logs);
      // 只有 upTo (最新块) 带 headTs; 中间补的块没时间戳
      this.onBlock({ blockNumber: b, mints, empty: mints.size === 0, blockTs: b === upTo ? headTs : null });
      this._buf.delete(b);
      this._lastFlushed = b;
    }
    for (const b of this._buf.keys()) if (b < upTo - 20) this._buf.delete(b);
  }

  _scheduleReconnect() {
    if (this._reconnectT || !this.running) return;
    const delay = Math.min(15000, 1000 * Math.pow(2, Math.min(this._retry++, 4)));
    this.onLog(`ws reconnecting in ${delay}ms`);
    this._reconnectT = setTimeout(() => { this._reconnectT = null; this._connect(); }, delay);
  }
  _reconnect() { try { this.ws?.close(); } catch {} }

  // 预检: 连一下拿 chainId + blockNumber (和 MintScanner.preflight 同签名)
  async preflight() {
    // 临时连一条短命 ws 做预检
    return new Promise((resolve, reject) => {
      let ws; try { ws = new WebSocket(this.wsUrl); } catch (e) { return reject(e); }
      const to = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("ws preflight timeout")); }, 10000);
      let got = {};
      ws.onopen = () => { ws.send(JSON.stringify({ jsonrpc:"2.0", id:1, method:"eth_chainId" })); ws.send(JSON.stringify({ jsonrpc:"2.0", id:2, method:"eth_blockNumber" })); };
      ws.onerror = () => { clearTimeout(to); reject(new Error("ws connect failed")); };
      ws.onmessage = (ev) => {
        try { const m = JSON.parse(ev.data);
          if (m.id === 1) got.chainId = parseInt(m.result, 16);
          if (m.id === 2) got.block = parseInt(m.result, 16);
          if (got.chainId != null && got.block != null) { clearTimeout(to); try { ws.close(); } catch {} resolve(got); }
        } catch {}
      };
    });
  }

  start() { if (this.running) return; this.running = true; this.onLog("ws scan started"); this._connect(); }
  stop() {
    this.running = false;
    if (this._reconnectT) { clearTimeout(this._reconnectT); this._reconnectT = null; }
    clearTimeout(this._watchdog); clearTimeout(this._flushT);
    try { this.ws?.close(); } catch {}
    this.onLog("ws scan stopped");
  }
}

// 依 RPC URL 选扫描器: wss:// → WsScanner (实时订阅); http:// → MintScanner (轮询池)
export function createScanner(opts) {
  const url = opts.wsUrl || opts.rpcUrl || "";
  if (/^wss?:\/\//i.test(url) && typeof WebSocket !== "undefined") {
    return new WsScanner({ ...opts, wsUrl: url });
  }
  return new MintScanner(opts);
}
