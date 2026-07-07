// app.js — 主控制器: RPC 池 → 扫链 → 聚合 → 三栏 UI + 连钱包
import { MintScanner, WsScanner, createScanner } from "./scanner.js";
import { readNftMeta, fetchImage, fetchDeployInfo, fetchDeployViaEtherscan, fetchAddrAge, analyzeMints, simulateMint, readSeaDrop, fetchLatestMints, decodeCalldata, detectSeaDropByTx, fetchSeaDropSchedule, fetchHolderStats, fetchSocials } from "./erc721.js";
import { MintStore } from "./store.js";
import { RpcPool } from "./rpcpool.js";
import { t, setLang, getLang, LANGS, onLangChange } from "./i18n.js";

const $ = s => document.querySelector(s);
const store = new MintStore();
const pool = new RpcPool();
// 节流分流: rpcHi = 扫链 (高优先, 不被后台饿死); rpc = 后台读取 (低优先, 池忙时排队)
// 扫链 = 直接 call (无队列, 最快, 延迟敏感); 后台任务才走节流队列 (省 RPC)。
//   设计取舍: 块扫描走 wss (延迟敏感), 但 metadata/图片/eth_call 这些"读"始终走 http 池 —
//   http 池经实测稳定, 且有轮换/限流保护; wss 那条连接只用于订阅推送, 不拿它发 eth_call
//   (免得单个方法不返回时卡满 8s 超时, 拖死模拟/进度面板)。所以设置里下面的 http 节点是必须的。
const rpcHi = (method, params) => pool.call(method, params);               // 扫链: 直连不排队
const rpcMid = (method, params) => pool.throttled(method, params, "mid");  // 名字/图片
const rpc = (method, params) => pool.throttled(method, params, "lo");      // holder/schedule/social/后台
// archive 版: 部署信息/地址年龄要二分查历史块 state → 只发给支持 archive 的节点
//   (免得抽中 publicnode 这种非 archive 节点白失败, 导致"开发者/年龄有时抓不到")。
const rpcArchive = (method, params) => pool.throttled(method, params, "lo", { archive: true });
let scanner = null, current = null;
const metaQueued = new Set();
const imgQueued = new Set();
// 图片 URL 缓存 — 持久化到 localStorage, 刷新后不重抓 (只存成功抓到的)
const imgCache = new Map(JSON.parse(localStorage.getItem("mr_imgcache") || "[]"));
let _imgSaveT = null;
function saveImgCache() {
  clearTimeout(_imgSaveT);
  _imgSaveT = setTimeout(() => {
    try {
      // 只存有 url 的 (成功), 最多 500 个 (防撑爆)
      const ok = [...imgCache.entries()].filter(([, v]) => v).slice(-500);
      localStorage.setItem("mr_imgcache", JSON.stringify(ok));
    } catch {}
  }, 1500);
}
const deployQueued = new Set();
let walletAddr = null;
const TEST_ADDR = "0x0000000000000000000000000000000000000001";   // 无钱包时的模拟地址
const simCache = new Map();   // contract → sim 结果 (可 mint 判断)

// filter/sort 状态 (localStorage 记忆)
const DEFAULT_WINS = [0, 60, 300, 900, 3600, 7200];   // All/1/5/15分/1/2时
const filter = Object.assign(
  // show* 默认全开 = 全部显示; 用户关掉某类就隐藏那类 (排除式, 不是叠加过滤)
  { winSec: 0, sort: "minters", wins: DEFAULT_WINS.slice(),
    showSeaDrop: true, showRegular: true, showPriceChanged: true, showNoChange: true, showMintable: true, showUnverified: true },
  JSON.parse(localStorage.getItem("mr_filter") || "null") || {}
);
// 迁移旧的 *Only 字段 (若存在) → 忽略, 用新默认
["seadropOnly", "priceChangedOnly", "mintableOnly"].forEach(k => delete filter[k]);
// Preferences (hover 暂停等)
const prefs = Object.assign({ hoverPause: true, preload: true }, JSON.parse(localStorage.getItem("mr_prefs") || "null") || {});
function savePrefs() { localStorage.setItem("mr_prefs", JSON.stringify(prefs)); }
let hoverPaused = false;
let pendingRender = false;   // 悬停暂停期间有新块 → 离开后补渲染
// 迁移: 去掉已删除的 3分/10分 预设 (旧版本存过)
filter.wins = filter.wins.filter(w => w !== 180 && w !== 600);
if (filter.winSec === 180 || filter.winSec === 600) filter.winSec = 0;
function saveFilter() { localStorage.setItem("mr_filter", JSON.stringify(filter)); }
const winLabel = s => s === 0 ? "All" : s < 3600 ? (s / 60) + "m" : (s / 3600) + "h";
// 排序项 (标签 tk = i18n key, 渲染时 t(tk))
const SORTS = [
  { v: "minters", tk: "sort.minters" },
  { v: "minted", tk: "sort.volume" },
  { v: "txs", tk: "sort.txCount" },
  { v: "mints", tk: "sort.mintCount" },
  { v: "newest", tk: "sort.latest" },
  { v: "progress", tk: "sort.progress" },
];

// 价格显示: 用定点小数 (不用科学计数法, e-5 看起来像"1.5个E"很误导)。
//   很小的值保留足够有效位; gwei 级用 gwei 单位更直观。
const eth = v => {
  if (v == null) return "—";
  if (v === 0) return "Free";
  if (v < 0.000001) {                       // < 1000 gwei → 用 gwei 显示更清楚
    const gwei = v * 1e9;
    return (gwei < 1 ? gwei.toFixed(3) : gwei < 100 ? gwei.toFixed(2) : Math.round(gwei)) + " gwei";
  }
  // 0.000001 ~ 1 之间: 保留到能看清有效数字 (最多 8 位小数, 去尾零)
  let s = v < 0.01 ? v.toFixed(8) : v.toFixed(4);
  s = s.replace(/\.?0+$/, "");
  return s + " Ξ";
};
// ETH/USD 现价 (链上 Chainlink 预言机, 无需外部 API). 每 5 分钟刷一次。
let ethUsd = null;
async function refreshEthUsd() {
  try {
    // Chainlink ETH/USD Feed: latestAnswer() = 0x50d25bcd, 8 decimals
    const r = await rpc("eth_call", [{ to: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", data: "0x50d25bcd" }, "latest"]);
    if (r && r !== "0x") { const p = Number(BigInt(r)) / 1e8; if (p > 0 && p < 100000) ethUsd = p; }
  } catch {}
}
// ETH 值 → USD 等值文字 (小括号). 太小则显示更多精度。
const usd = v => {
  if (ethUsd == null || v == null || v === 0) return "";
  const d = v * ethUsd;
  if (d < 0.01) return `~$${d.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  if (d < 1) return `~$${d.toFixed(3)}`;
  if (d < 1000) return `~$${d.toFixed(2)}`;
  return `~$${Math.round(d).toLocaleString()}`;
};
const fmtNum = n => n == null ? "—" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : n;
const short = a => a ? a.slice(0, 6) + "…" + a.slice(-4) : "";
// 时钟偏差校正: chainSkew = (本机秒) - (最新块链上时间戳)。它包含"电脑时钟误差 + 区块传播延迟"。
//   所有相对时间减掉它 → 等价于"距该块到达本机过了多久", 和顶部 block-age 同基准, 且不受
//   电脑时钟快慢影响。head 到达时更新 (见 onHead)。
let chainSkew = 0;
const ago = ts => { if (!ts) return "—"; let s = Math.floor(Date.now() / 1000) - ts - chainSkew; if (s < 0) s = 0; if (s < 60) return s + "s"; if (s < 3600) return Math.floor(s / 60) + "m"; if (s < 86400) return Math.floor(s / 3600) + "h"; return Math.floor(s / 86400) + "d"; };
// 绝对时间 (deployed用): 显示 相对 + 日期
const agoFull = ts => { if (!ts) return "—"; const d = new Date(ts * 1000); const rel = ago(ts); return `${rel} ago · ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`; };
function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 2600); }
// 三点波浪 loading (顺滑, 非生硬切换). label 可选。
const loading = (label = "") => `<div class="dload"><span class="dots"><i></i><i></i><i></i></span>${label ? `<span>${label}</span>` : ""}</div>`;
// OpenSea 官方船型 icon (只有船, 无圆盘背景 — Catchmint 同款做法). fill 继承 currentColor。
const OS_ICON = `<svg class="os-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="m2.952 11.223.056-.088 3.376-5.281a.115.115 0 0 1 .203.014c.564 1.264 1.05 2.836.822 3.815-.097.402-.364.948-.664 1.452a2.658 2.658 0 0 1-.126.215.115.115 0 0 1-.096.05H3.05a.115.115 0 0 1-.099-.177Z"/><path d="M18 12.204v.836a.12.12 0 0 1-.072.11c-.261.111-1.156.522-1.528 1.04-.95 1.32-1.675 3.21-3.296 3.21H6.34A4.347 4.347 0 0 1 2 13.045v-.077c0-.064.052-.116.116-.116h3.77c.075 0 .13.07.123.143-.026.245.019.496.135.724.224.454.688.738 1.19.738H9.2V13H7.355a.119.119 0 0 1-.096-.187l.066-.098c.175-.248.424-.634.672-1.072.17-.296.334-.612.466-.93.026-.057.048-.116.069-.173.036-.101.073-.196.1-.29.027-.08.048-.165.07-.243.062-.27.089-.555.089-.851 0-.116-.006-.237-.016-.353a4.579 4.579 0 0 0-.038-.38 3.938 3.938 0 0 0-.052-.339 5.71 5.71 0 0 0-.106-.507l-.015-.064c-.032-.116-.059-.226-.096-.342a12.929 12.929 0 0 0-.355-1.051c-.046-.132-.1-.259-.153-.385-.079-.191-.159-.364-.232-.528a7.367 7.367 0 0 1-.101-.212 7.444 7.444 0 0 0-.111-.232c-.027-.058-.057-.111-.079-.164l-.228-.422a.074.074 0 0 1 .084-.108l1.427.387h.004l.005.001.188.052.207.059.076.021v-.848c0-.409.328-.741.733-.741.203 0 .387.083.519.217a.745.745 0 0 1 .215.524V5l.152.043a.12.12 0 0 1 .034.017c.038.028.091.07.159.12.053.043.11.095.18.148a10.83 10.83 0 0 1 .619.544c.232.216.492.47.74.75.069.078.137.158.206.242.07.085.143.17.207.253.084.112.175.228.253.35.038.057.08.116.116.173.102.153.191.312.276.47.036.074.074.154.106.233.094.212.17.428.217.644a.807.807 0 0 1 .03.142v.011c.017.064.022.132.027.201a2.155 2.155 0 0 1-.116.944c-.032.091-.064.186-.105.275-.08.185-.175.37-.287.544a3.063 3.063 0 0 1-.121.196c-.047.068-.095.132-.137.195-.059.08-.122.164-.186.238a8.531 8.531 0 0 1-.444.528c-.053.063-.11.127-.169.184a6.926 6.926 0 0 1-.396.39l-.147.136a.12.12 0 0 1-.078.029h-1.136v1.457h1.429c.32 0 .624-.113.87-.321.083-.073.45-.39.883-.87a.112.112 0 0 1 .055-.033l3.948-1.141a.116.116 0 0 1 .148.112Z"/></svg>`;

// 用户填的 wss:// 端点 (实时订阅模式); 空 = 用 http 轮询池. localStorage 记忆。
// 默认预设公开 wss (publicnode, 免 key 实时订阅) → 开箱即用实时推送, 不用用户自己配。
//   用户可在设置里换成自己的 Alchemy (更快); "切回 HTTP" 会存 mr_wsurl="" 明确关闭。
const DEFAULT_WSS = "wss://ethereum-rpc.publicnode.com";
const _savedWs = localStorage.getItem("mr_wsurl");
let wsUrl = _savedWs != null ? _savedWs : DEFAULT_WSS;   // 没存过 → 用默认; 存过(含空串)→ 尊重用户选择

// 顶栏"当前数据源模式"常驻提示. state: "http" | "ws-idle" | "ws-live" | "ws-reconnect"
function setMode(state) {
  const chip = $("#mode-chip"); if (!chip) return;
  const host = u => { try { return new URL(u).host; } catch { return u; } };
  const map = {
    "http":        { cls: "mode-http",  icon: "fa-tower-broadcast", txt: `HTTP poll · ${pool.list().length} RPC` },
    "ws-idle":     { cls: "mode-ws",    icon: "fa-bolt",            txt: `WS · ${host(wsUrl)}` },
    "ws-live":     { cls: "mode-ws-on", icon: "fa-bolt",            txt: `WS live · ${host(wsUrl)}` },
    "ws-reconnect":{ cls: "mode-ws-re", icon: "fa-rotate",          txt: `WS reconnecting…` },
    "backend":     { cls: "mode-ws-on", icon: "fa-server",          txt: `shared history` },
  };
  const m = map[state] || map.http;
  chip.className = "mode-chip " + m.cls;
  chip.innerHTML = `<i class="fa-solid ${m.icon}"></i> ${m.txt}`;
  chip.title = wsUrl ? `WebSocket realtime · ${wsUrl}` : "HTTP polling via RPC pool";
}
// 初始反映 (刷新后 localStorage 里若已有 wss, 显示 WS)
setMode(wsUrl ? "ws-idle" : "http");

// 应用一个用户输入的 RPC (在设置弹窗里调用)。
//   填 wss:// → 走 WebSocket 实时订阅 (更实时省配额); 填 http(s):// → 加进轮询池。
async function applyRpcInput(url) {
  url = (url || "").trim();
  if (url) {
    if (/^wss?:\/\//i.test(url)) {
      wsUrl = url; localStorage.setItem("mr_wsurl", wsUrl);
      setMode("ws-idle");
      toast("using WebSocket RPC (realtime subscribe)");
    } else if (/^https?:\/\//i.test(url)) {
      if (pool.add(url, { priority: 1 })) toast("added to RPC pool (top priority)");
      if (!wsUrl) setMode("http");
    } else { toast("enter a valid http(s):// or wss:// RPC URL"); return; }
  }
  await connectAndScan();
}
// 切回 http 轮询模式 (清掉 wss)
function clearWs() {
  wsUrl = ""; localStorage.removeItem("mr_wsurl");
  setMode("http");
  toast("switched to HTTP polling");
  connectAndScan();
}

// 预检 + Start scan. wss 模式用 WsScanner 预检 (走订阅); 否则用 http 池预检。
async function connectAndScan() {
  $("#rpc-status").textContent = "";
  try {
    let info;
    if (wsUrl) {
      const probe = new WsScanner({ wsUrl });
      info = await probe.preflight();
    } else {
      const [chainHex, blockHex] = await Promise.all([rpc("eth_chainId"), rpc("eth_blockNumber")]);
      info = { chainId: parseInt(chainHex, 16), block: parseInt(blockHex, 16) };
    }
    // 状态信息已在顶栏 mode-chip 显示, 这里不再重复
    $("#rpc-status").textContent = "";
    setMode(wsUrl ? "ws-idle" : "http");
    setupScanner();
    $("#scan-toggle").disabled = false;
    scanner.start();
    setScanning(true);
  } catch (e) {
    $("#rpc-status").innerHTML = `<span class="bad">${e.message}</span>`;
    setScanning(false);
  }
}

// ── 后端模式 ── 从后端 API 拉共享历史, 喂进同一套 store/渲染 (不自己扫链)。
//   通过 store.ingest 复用聚合逻辑: 把 API 的活动流转成合成 mint 事件按块灌入。
let _beSeen = new Set();   // 已灌入的 activity id (block:contract), 防重复
async function startBackendMode(base) {
  const api = base.replace(/\/$/, "");
  setMode("backend");
  $("#scan-toggle") && ($("#scan-toggle").style.display = "none");   // 后端模式无本地扫描按钮
  const poll = async () => {
    try {
      // 活动流 → 合成 mint 事件灌 store (只灌没见过的块)
      const act = await fetch(`${api}/api/activity?limit=150`).then(r => r.json()).catch(() => null);
      if (act?.items) {
        // API 是新→旧; ingest 要按旧→新, 反转
        for (const a of [...act.items].reverse()) {
          const id = `${a.block}:${a.contract}`;
          if (_beSeen.has(id)) continue;
          _beSeen.add(id);
          // 合成一个该合约该块的 mint 事件 (minters 用占位地址, 只为驱动聚合/流显示)
          const mints = new Map([[a.contract, {
            count: a.count, std: a.std || 721,
            minters: new Set(Array.from({ length: a.minters }, (_, i) => `0x${id.slice(2)}${i}`.padEnd(42, "0").slice(0, 42))),
            mintedBy: new Map(), txs: new Set(Array.from({ length: a.txs }, (_, i) => `${a.block}-${a.contract}-${i}`)),
            txMap: new Map(), tokenIds: [],
          }]]);
          store.ingest({ blockNumber: a.block, mints, blockTs: a.ts });
          // 元数据直接写 (后端已补好)
          const p = store.get(a.contract);
          if (p && a.name) p.name = a.name;
          if (p && a.image && !imgCache.get(a.contract)) { imgCache.set(a.contract, a.image); }
        }
      }
      if (_beSeen.size > 4000) _beSeen = new Set([..._beSeen].slice(-2000));
      // 排行的元数据 (名字/图片/供应) 批量补
      const rank = await fetch(`${api}/api/ranking?limit=120`).then(r => r.json()).catch(() => null);
      if (rank?.items) for (const r of rank.items) {
        const p = store.get(r.contract);
        if (!p) continue;
        if (r.name) { p.name = r.name; p.symbol = r.symbol; }
        if (!p.meta) p.meta = {};
        if (r.total_supply != null) p.meta.totalSupply = r.total_supply;
        if (r.max_supply != null) p.meta.maxSupply = r.max_supply;
        if (r.is_seadrop) p.isSeaDrop = true;
        if (r.image && !imgCache.get(r.contract)) imgCache.set(r.contract, r.image);
      }
      scheduleRender();
    } catch (e) { console.warn("[backend]", e.message); }
  };
  await poll();
  setInterval(poll, 5000);   // 每 5s 拉新
}

// 统一反映"扫描中"状态: 按钮显示"下一步动作" (扫描中→Pause, 停止→Resume)
function setScanning(on) {
  const btn = $("#scan-toggle");
  btn.innerHTML = on
    ? `<i class="fa-solid fa-circle live-dot"></i> ${t("scan.live")}`
    : `<i class="fa-solid fa-play"></i> ${t("scan.resume")}`;
  btn.classList.toggle("scanning", on);
  document.body.classList.toggle("is-scanning", on);
  // 两栏标题的 live 指示灯: 暂停时熄灭 (dim), 避免"暂停了还显示 live"的误导
  document.querySelectorAll(".col-head .live").forEach(el => el.classList.toggle("paused", !on));
}

let lastHeadAt = 0, lastHead = 0, lastHeadTs = 0;   // headTs = 该块链上出块时间戳
function setupScanner() {
  if (scanner) scanner.stop();
  // wss:// → WsScanner (实时订阅); 否则 MintScanner (http 轮询池)
  //   注意: 即便走 wss 扫链, metadata/图片/模拟等"读"仍走 http 池 (rpc), 因为 wss 端点
  //   不一定支持所有 eth_call, 且池有轮换/限流保护。
  scanner = createScanner({
    wsUrl: wsUrl || null,
    rpcFn: rpcHi,   // 扫链直连
    headFn: () => pool.fastestHead(),   // 多节点竞速取最新 head → 降低传播延迟
    onBlock: ev => { store.ingest(ev); queueMeta(ev.mints); scheduleRender(); },
    onHead: ({ head, at, headTs }) => {
      const isNew = head !== lastHead;
      lastHead = head; lastHeadAt = at;
      // 新块: 立刻重置计时基准 (headTs 没来就用墙钟估), 真 headTs 到了再校准 → 秒数立即刷新不停滞
      if (headTs) lastHeadTs = headTs;
      else if (isNew) lastHeadTs = Math.floor(at / 1000);
      // 更新时钟偏差 = 本机秒 - 该块链上时间戳 (含电脑时钟误差 + 传播延迟)。
      //   用 floor (和 block-age ticker / ago() 一致) → 顶部秒数与区块行秒数完全对齐, 不差 1。
      if (headTs) chainSkew = Math.max(0, Math.floor(at / 1000) - headTs);
      if (wsUrl) setMode("ws-live");
    },
    onError: msg => {
      console.warn("[scan]", msg);
      // wss 端点不支持订阅 / 没数据 → 自动降级到 http 轮询
      if (wsUrl && /ws-no-data|ws-subscribe-failed/.test(msg)) {
        toast("wss endpoint unusable — falling back to HTTP polling");
        clearWs();
      }
    },
    onLog: msg => {
      console.log("[scan]", msg);
      if (!wsUrl) return;
      if (/reconnect/i.test(msg)) setMode("ws-reconnect");
      else if (/connected/i.test(msg)) setMode("ws-live");
    },
  });
}

// 补 NFT 元数据 (name/symbol/supply) + SeaDrop 探测。
//   关键: 失败 (RPC 限流/超时) 不能永久标记为"已试", 否则名字永远补不回来 →
//   只有"成功拿到" 或 "确认不是 NFT" 才不再重试; 失败则下次该合约再出现时重试。
const metaFails = new Map();   // contract → 失败次数 (指数退避, 上限后放弃)
function queueMeta(mints) {
  for (const [contract] of mints) {
    const p = store.get(contract);
    if (p && !p.meta && !metaQueued.has(contract) && (metaFails.get(contract) || 0) < 6) {
      metaQueued.add(contract);
      readNftMeta(rpcMid, contract, p.std)
        .then(m => {
          if (m && (m.name != null || m.totalSupply != null)) {
            store.setMeta(contract, m); metaFails.delete(contract); scheduleRender();
          } else {
            // 明确不是 NFT (无 name 无 supply) → 记一次, 但允许几次重试防误判
            metaQueued.delete(contract); metaFails.set(contract, (metaFails.get(contract) || 0) + 1);
          }
        })
        .catch(() => {   // RPC 失败 → 解锁重试 (下个块该合约再出现时会再试)
          metaQueued.delete(contract); metaFails.set(contract, (metaFails.get(contract) || 0) + 1);
        });
    }
    // SeaDrop 探测: ① 靠一笔 mint tx 看 to= SeaDrop 合约 (最可靠) ② getPublicDrop 补价格
    if (p && p.isSeaDrop == null && !seadropQueued.has(contract)) {
      seadropQueued.add(contract);
      detectSeaDropTx(contract, p)
        .then(() => { scheduleRender(); if (current === contract) selectProject(contract); })
        .catch(() => { seadropQueued.delete(contract); });   // 失败解锁, 下次重试
    }
  }
}
const seadropQueued = new Set();

// SeaDrop 检测: 用多笔 mint tx 判 (tx.to = SeaDrop 合约 → 铁证), 再 getPublicDrop 补价格。
async function detectSeaDropTx(contract, p) {
  let isSD = false, checked = 0;
  // 试最近 5 笔样本 (新的优先), 有一笔命中就确认
  const candidates = (p?.recentTxs || []).slice(-5).reverse();
  for (const h of candidates) {
    let hit = null;
    try { hit = await detectSeaDropByTx(rpc, h); checked++; } catch {}
    if (hit) { isSD = true; break; }
  }
  // 拿价格 (getPublicDrop; 新版会 revert 但不影响已确认的 isSeaDrop)
  let sd = null;
  try { sd = await readSeaDrop(rpc, contract); } catch {}
  if (sd) { store.setSeaDrop(contract, sd); }                      // 有价 → 完整标记
  else if (isSD) { store.setSeaDrop(contract, { isSeaDrop: true, mintPriceWei: 0n, mintPriceEth: 0, priceUnknown: true }); }  // tx 确认是 SeaDrop
  else if (checked > 0) { store.setSeaDrop(contract, null); }      // 确实检查过且都不是 → 标非 SeaDrop
  else { seadropQueued.delete(contract); throw new Error("no sample checked");  }  // 一笔都没查成 (RPC失败) → 不下结论, 解锁重试
}

// ── 扫描开关 ──
$("#scan-toggle").onclick = () => {
  if (!scanner) return;
  if (scanner.running) { scanner.stop(); setScanning(false); }
  else { scanner.start(); setScanning(true); }
};

// ── 时间窗 chips + 排序下拉 (同一控制条) ──
function renderControls() {
  const bar = $("#sort-tabs");
  bar.innerHTML = filter.wins.map(w => `<button class="tab ${filter.winSec === w ? "on" : ""}" data-win="${w}">${winLabel(w)}</button>`).join("");
  bar.querySelectorAll("[data-win]").forEach(b => b.onclick = () => { filter.winSec = +b.dataset.win; saveFilter(); renderControls(); renderRank(); });
  const sel = $("#sort-select");
  if (sel) sel.innerHTML = SORTS.map(s => `<option value="${s.v}" ${filter.sort === s.v ? "selected" : ""}>${t(s.tk)}</option>`).join("");
}
$("#sort-select").onchange = e => { filter.sort = e.target.value; saveFilter(); renderRank(); };
$("#open-settings").onclick = openSettings;

// ── 图片懒加载 ──
//   · 优先用"刚 mint 的真实 tokenId" (合约 #1 常不存在/未 reveal), 拿不到才退 1
//   · 抓到才写缓存; 没抓到 (null) 不永久缓存 → 允许下次 (换 tokenId/RPC 恢复) 重试
const imgFails = new Map();   // contract → 失败次数 (退避, 上限后放弃)
function queueImage(contract, tokenIdHint) {
  if (imgCache.get(contract) || imgQueued.has(contract) || !scanner) return;   // 只在"已抓到"时跳过
  if ((imgFails.get(contract) || 0) >= 5) return;   // 试够 5 次仍无 → 放弃 (省 RPC)
  imgQueued.add(contract);
  const p = store.get(contract);
  // tokenId 优先级: 显式提示 > 最近 mint 的真实 tokenId > 1
  const tid = tokenIdHint || p?.recentTokenIds?.[0] || 1;
  fetchImage(rpcMid, contract, tid, p?.std || 721)
    .then(url => {
      imgQueued.delete(contract);
      if (url) { imgCache.set(contract, url); saveImgCache(); scheduleRender(); }
      else imgFails.set(contract, (imgFails.get(contract) || 0) + 1);   // 没抓到 → 记次数, 可重试
    })
    .catch(() => { imgQueued.delete(contract); imgFails.set(contract, (imgFails.get(contract) || 0) + 1); });
}
// 图片加载失败 → 换 IPFS 网关重试 (cf-ipfs → ipfs.io), 都失败才隐藏。
//   用全局函数 (挂 window), 避免在 HTML onerror 内联脚本里嵌套引号导致 HTML 破损。
window.mrImgErr = (el) => {
  if (el.dataset.fb === "1") { el.style.display = "none"; return; }
  el.dataset.fb = "1";
  el.src = el.src.replace("cf-ipfs.com", "ipfs.io");
};
// 画廊媒体 (video/img) 失败: 有兜底图就换成图, 否则显示占位图标
window.mrMediaErr = (el) => {
  const fb = el.dataset.fb;
  if (fb && el.tagName === "VIDEO") { el.outerHTML = `<img loading="lazy" src="${fb}" onerror="mrImgErr(this)">`; return; }
  if (fb && el.src !== fb) { el.dataset.fb = ""; el.src = fb; return; }
  const parent = el.parentElement; if (parent) parent.innerHTML = '<i class="fa-solid fa-image"></i>';
};
const imgTag = (contract, cls) => {
  const url = imgCache.get(contract);
  return url
    ? `<img class="${cls}" loading="lazy" src="${url}" onerror="mrImgErr(this)">`
    : `<i class="fa-solid fa-cube"></i>`;
};

// ── 渲染 ──
function renderAll() { renderRank(); renderStream(); if (typeof tickTimestamps === "function") tickTimestamps(); }
// 统一渲染入口: 悬停暂停时不刷, 只记 pending; 解冻后补刷。所有异步回调都走这里。
function scheduleRender() {
  if (hoverPaused) { pendingRender = true; return; }
  renderAll();
}

function renderRank() {
  let items = store.ranking({ limit: 120, winSec: filter.winSec, sort: filter.sort });
  // show* 全开=全显示; 关掉某类 = 隐藏那类 (排除式)
  if (!filter.showSeaDrop) items = items.filter(r => !r.isSeaDrop);
  if (!filter.showRegular) items = items.filter(r => r.isSeaDrop);
  if (!filter.showPriceChanged) items = items.filter(r => !r.priceChanged);
  if (!filter.showNoChange) items = items.filter(r => r.priceChanged);
  // mintable: 只对"已模拟过"的项目应用 (未模拟的当 unverified)
  if (!filter.showMintable || !filter.showUnverified) items = items.filter(r => {
    const sim = simCache.get(r.contract);
    const verified = sim != null;
    if (!verified) return filter.showUnverified;              // 没验证过
    return sim.mintable ? filter.showMintable : filter.showUnverified;
  });
  items = items.slice(0, 80);
  $("#rank-count").textContent = items.length;
  const el = $("#rank-list");
  if (!items.length) {
    el.dataset.reconciled = "";   // 重置, 下次从空开始
    el.innerHTML = scanner?.running
      ? `<div class="empty sm scanning-note"><span class="scan-dots"><b></b><b></b><b></b></span><div class="s">${filter.winSec ? t("empty.noWindow") : t("empty.scanning")}</div></div>`
      : `<div class="empty sm catwait">
           <pre class="cat">   ╱|、
  (˚ˎ 。7
   |、˜〵
   じしˍ,)ノ</pre>
           <div class="s"><span class="cat-sub">${t("empty.catSub")}</span></div>
         </div>`;
    return;
  }
  const nowS = Math.floor(Date.now() / 1000);
  items.forEach(r => queueImage(r.contract));
  // 每行内部 HTML (不含外层 .row, 便于只在变化时更新)
  const inner = r => {
    const hot = (nowS - r.lastMint) < 60 && r.uniqueMinters >= 2;
    // 窗口模式和 All 模式的 tx/地址 现在都按对应范围算 (store 里已分开), 不再错位
    const segs = filter.winSec
      ? [`${fmtNum(r.winMinted)} ${t("unit.mints")}`, `${fmtNum(r.totalTxs)} ${t("unit.tx")}`, `${fmtNum(r.uniqueMinters)} ${t("unit.minters")}`]
      : [`${fmtNum(r.uniqueMinters)} ${t("unit.minters")}`, `${fmtNum(r.totalMinted)} ${t("unit.mints")}`, `${fmtNum(r.totalTxs)} ${t("unit.tx")}`];
    const sub = segs.map(s => `<span class="ss-seg">${s}</span>`).join("");
    const prog = r.pct != null
      ? `<div class="prog"><div class="prog-fill ${hot ? "hot" : ""}" style="width:${r.pct.toFixed(1)}%"></div></div><span class="prog-pct">${r.pct.toFixed(0)}%</span>`
      : `<span class="prog-none">—</span>`;
    const badges = `${r.isSeaDrop ? `<span class="badge-sd" title="OpenSea SeaDrop">${OS_ICON}</span>` : ""}${r.std === 1155 ? '<span class="badge-std" title="ERC-1155">1155</span>' : ""}${r.priceChanged ? '<span class="badge-pc" title="mint price changed on-chain"><i class="fa-solid fa-triangle-exclamation"></i> PRICE</span>' : ""}`;
    return `<div class="ravatar">${imgTag(r.contract, "ravatar-img")}</div>
      <div class="rmain"><div class="rname">${badges}<span class="rname-txt">${r.name || short(r.contract)}</span></div><div class="rsub">${sub}</div></div>
      <div class="rprog">${prog}</div>`;
  };
  reconcileList(el, items, r => r.contract, inner, (node, r) => {
    node.className = "row" + (current === r.contract ? " on" : "");
    node.onclick = () => selectProject(r.contract);
  });
}

// ── 键控列表协调器 (顺滑更新, 无跳动) ──
//   · 复用已有 DOM 节点 (按 key), 只在内容变化时更新 innerHTML → 不闪烁
//   · 用 FLIP 动画平滑处理重新排序 → 位置变化滑动而非瞬跳
//   · 新节点淡入, 移除节点淡出
function reconcileList(container, items, keyOf, innerOf, applyAttrs) {
  const prev = new Map();
  for (const n of [...container.children]) if (n.dataset.key) prev.set(n.dataset.key, n);
  // FLIP: 记录旧位置
  const firstRects = new Map();
  prev.forEach((n, k) => firstRects.set(k, n.getBoundingClientRect().top));

  const seen = new Set();
  let prevNode = null;
  for (const it of items) {
    const key = keyOf(it);
    seen.add(key);
    let node = prev.get(key);
    const html = innerOf(it);
    if (!node) {
      // 新行 → 建 + 淡入
      node = document.createElement("div");
      node.dataset.key = key;
      node.innerHTML = html; node.dataset.html = html;
      applyAttrs(node, it);
      node.classList.add("row-enter");
      requestAnimationFrame(() => node.classList.remove("row-enter"));
    } else {
      // 复用: 仅内容变了才改 (避免图片/文本无谓重绘)
      if (node.dataset.html !== html) { node.innerHTML = html; node.dataset.html = html; }
      applyAttrs(node, it);
    }
    // 按目标顺序插入 (在 prevNode 之后)
    const anchor = prevNode ? prevNode.nextSibling : container.firstChild;
    if (node !== anchor) container.insertBefore(node, anchor);
    prevNode = node;
  }
  // 删除已不在列表里的
  prev.forEach((n, k) => { if (!seen.has(k)) n.remove(); });
  // FLIP: 计算位移, 反向平移后放行 → 顺滑滑动到新位置
  if (!prefersReducedMotion()) {
    for (const n of container.children) {
      const k = n.dataset.key; if (!firstRects.has(k)) continue;
      const dy = firstRects.get(k) - n.getBoundingClientRect().top;
      if (Math.abs(dy) > 1) {
        n.style.transform = `translateY(${dy}px)`;
        n.style.transition = "none";
        requestAnimationFrame(() => { n.style.transition = "transform .32s cubic-bezier(.22,1,.36,1)"; n.style.transform = ""; });
      }
    }
  }
}
const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ── 设定弹窗: 排序 + 自定义时间窗 ──
function openSettings() {
  let modal = $("#settings-modal");
  if (!modal) { modal = document.createElement("div"); modal.id = "settings-modal"; modal.className = "modal"; document.body.appendChild(modal); }
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-head"><h3>${t("modal.filtersSort")}</h3><button class="modal-x" id="modal-close"><i class="fa-solid fa-xmark"></i></button></div>
      <div class="modal-sec">
        <div class="modal-label">${t("modal.sortBy")}</div>
        <div class="modal-opts">${SORTS.map(s => `<button class="opt ${filter.sort === s.v ? "on" : ""}" data-sort="${s.v}">${t(s.tk)}</button>`).join("")}</div>
      </div>
      <div class="modal-sec">
        <div class="modal-label">${t("modal.timeWindows")}</div>
        <div class="modal-opts">${filter.wins.map(w => `<button class="opt win-opt ${filter.winSec === w ? "on" : ""}" data-win="${w}">${winLabel(w)}${w !== 0 ? ` <i class="fa-solid fa-xmark rm" data-rm="${w}"></i>` : ""}</button>`).join("")}</div>
      </div>
      <div class="modal-sec">
        <div class="modal-label">${t("modal.addWindow")}</div>
        <div class="modal-add">
          <input id="custom-win" type="number" min="1" placeholder="${t("modal.value")}">
          <select id="custom-unit"><option value="60">${t("modal.min")}</option><option value="3600">${t("modal.hour")}</option></select>
          <button class="btn sm" id="add-win">${t("set.add")}</button>
        </div>
      </div>
      <div class="modal-sec">
        <div class="modal-label">${t("modal.show")} <span class="modal-sublbl">${t("modal.showHint")}</span></div>
        <div class="modal-opts">
          <button class="opt ${filter.showSeaDrop ? "on" : ""}" data-flt="showSeaDrop">${t("flt.seadrop")}</button>
          <button class="opt ${filter.showRegular ? "on" : ""}" data-flt="showRegular">${t("flt.regular")}</button>
          <button class="opt ${filter.showPriceChanged ? "on" : ""}" data-flt="showPriceChanged">${t("flt.priceChanged")}</button>
          <button class="opt ${filter.showNoChange ? "on" : ""}" data-flt="showNoChange">${t("flt.stablePrice")}</button>
          <button class="opt ${filter.showMintable ? "on" : ""}" data-flt="showMintable">${t("flt.mintable")}</button>
          <button class="opt ${filter.showUnverified ? "on" : ""}" data-flt="showUnverified">${t("flt.unverified")}</button>
        </div>
        <div class="modal-hint">${t("modal.filtHint")}</div>
      </div>
      <div class="modal-foot"><button class="btn" id="modal-apply">${t("set.done")}</button></div>
    </div>`;
  modal.classList.add("show");
  const close = () => modal.classList.remove("show");
  $("#modal-close").onclick = close; $("#modal-apply").onclick = close;
  modal.onclick = e => { if (e.target === modal) close(); };
  modal.querySelectorAll("[data-sort]").forEach(b => b.onclick = () => { filter.sort = b.dataset.sort; saveFilter(); openSettings(); renderRank(); });
  modal.querySelectorAll(".win-opt").forEach(b => b.onclick = e => {
    if (e.target.classList.contains("rm")) { const w = +e.target.dataset.rm; filter.wins = filter.wins.filter(x => x !== w); if (filter.winSec === w) filter.winSec = 0; saveFilter(); openSettings(); renderControls(); renderRank(); return; }
    filter.winSec = +b.dataset.win; saveFilter(); openSettings(); renderControls(); renderRank();
  });
  modal.querySelectorAll("[data-flt]").forEach(b => b.onclick = () => {
    const k = b.dataset.flt; filter[k] = !filter[k]; saveFilter(); b.classList.toggle("on", filter[k]); renderRank();
  });
  $("#add-win").onclick = () => {
    const n = parseInt($("#custom-win").value), unit = +$("#custom-unit").value;
    if (!n || n < 1) return;
    const sec = n * unit;
    if (!filter.wins.includes(sec)) { filter.wins.push(sec); filter.wins.sort((a, b) => a - b); saveFilter(); openSettings(); renderControls(); }
  };
}

function renderStream() {
  const items = store.recentActivity({ limit: 60 });
  const el = $("#stream");
  if (!items.length) { el.dataset.reconciled = ""; el.innerHTML = `<div class="empty sm"><div class="s">${t("empty.stream")}</div></div>`; return; }
  // 先把活动流摊平成 [{kind, key, ...}] — 分隔条 / gap / mint 各一个键控节点
  const rows = [];
  let lastBlock = null;
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (a.gap) {
      const lo = Math.min(a.fromBlock, a.toBlock), hi = Math.max(a.fromBlock, a.toBlock);
      const span = lo === hi ? `${t("stream.block")} ${lo}` : `${t("stream.block")} ${lo}–${hi}`;
      const n = Math.abs(a.fromBlock - a.toBlock) + 1;
      const nStr = `${n} ${t("stream.blocks")}`;
      const txt = a.skipped ? `${span} · ${t("stream.skipped", { n: nStr })}`
        : a.failed ? `${span} · ${t("stream.scanFailed", { n: nStr })}`
        : `${span} · ${t("stream.noMints", { n: nStr })}`;
      rows.push({ kind: "gap", key: `gap-${a.toBlock}-${a.fromBlock}-${a.skipped ? "s" : a.failed ? "f" : "e"}`, failed: a.failed, html:
        `<span class="gap-line"></span><span class="gap-txt">${txt}</span><span class="gap-line"></span>` });
      lastBlock = null;
      continue;
    }
    if (a.block !== lastBlock) {
      const blockRows = items.filter(x => !x.gap && x.block === a.block);
      const blockTxs = blockRows.reduce((s, x) => s + (x.txs ?? x.count), 0);
      // block header 右侧: 区块时间距今 (bd-age 内容留空, 由 1秒 ticker 填 → html 稳定不闪)
      rows.push({ kind: "div", key: `div-${a.block}`, html:
        `<a class="bd-num" href="https://etherscan.io/block/${a.block}" target="_blank" rel="noopener" title="${t("stream.viewBlock")}">${t("stream.block")} ${a.block} <i class="fa-solid fa-arrow-up-right-from-square bd-ext"></i></a>
         <span class="bd-right"><span class="bd-txs">${blockTxs} ${t("unit.tx")}</span><span class="bd-age" data-ts="${a.ts}" data-suffix=" ${t("ago.suffix")}"></span></span>` });
      lastBlock = a.block;
    }
    const txs = a.txs ?? a.count;
    queueImage(a.contract);
    // key 用稳定身份 (block+contract), 不用循环下标 i — 否则新 mint 插入时全部 key 位移→全量重建→闪烁
    // sub-line: 铸造 · 笔 · 地址 (tx 数并入这行, 右边不再单独放)
    rows.push({ kind: "mint", key: `m-${a.block}-${a.contract}`, contract: a.contract, html:
      `<div class="savatar">${imgTag(a.contract, "savatar-img")}</div>
       <div class="sbody"><div class="sname">${a.name || short(a.contract)}${a.count > 1 ? ` <span class="qty">x${a.count}</span>` : ""}</div>
       <div class="ssub"><span class="ss-seg">${a.count} ${t("unit.mints")}</span><span class="ss-seg">${txs} ${t("unit.tx")}</span><span class="ss-seg">${a.uniq} ${t("unit.minters")}</span></div></div>` });
  }
  reconcileList(el, rows, r => r.key, r => r.html, (node, r) => {
    node.className = r.kind === "div" ? "blockdiv" : r.kind === "gap" ? ("gapdiv" + (r.failed ? " gap-failed" : "")) : "sitem";
    if (r.kind === "mint") node.onclick = () => selectProject(r.contract);
  });
}

async function selectProject(contract) {
  current = contract;
  queueImage(contract);   // 选中必抓图
  renderRank();
  const p = store.get(contract);
  const mid = $("#detail");
  const m = p?.meta || {};
  const dispName = m.name || p?.name || short(contract);   // meta 没名字时回退到 p.name (榜单用的那个)
  const dispSym = m.symbol || p?.symbol || "";
  const total = m.totalSupply ?? p?.totalMinted ?? 0;
  const max = m.maxSupply || 0;
  const pct = max > 0 ? Math.min(100, total / max * 100) : null;
  const rate = p ? store.rate(p) : null;
  const minters = p?.minters.size || 0;
  // 观测铸造人数是 session 局部样本, 除以总供应量(max)毫无意义(会算出 0.5% 这种噪音)。
  //   改显示"平均每人铸造几个" = 观测总铸造数 / 观测独立地址数, 反映是否被巨鲸/机器人集中扫。
  const obsMints = p?.totalMinted || 0;
  const avgPerMinter = minters > 0 ? obsMints / minters : null;
  mid.innerHTML = `
    <div class="dhead">
      <div class="davatar">${imgTag(contract, "davatar-img")}</div>
      <div class="dinfo">
        <div class="dname">${dispName} ${dispSym ? `<span class="dtag">${dispSym}</span>` : ""}<span class="dtag sd" id="sd-detail-tag" style="${p?.isSeaDrop ? "" : "display:none"}">${OS_ICON} SeaDrop</span></div>
        <div class="dcontract"><span class="copyable" data-copy="${contract}">${contract}</span></div>
        <div class="dlinks">
          <a class="btn sm" href="https://opensea.io/assets/ethereum/${contract}" target="_blank">${OS_ICON} OpenSea</a>
          <a class="btn sm" href="https://etherscan.io/address/${contract}" target="_blank"><i class="fa-solid fa-magnifying-glass"></i> Etherscan</a>
          <button class="btn sm" id="detail-refresh" title="${t("meta.refresh")}"><i class="fa-solid fa-rotate"></i> ${t("meta.refresh")}</button>
          <span id="social-links" class="social-links"></span>
        </div>
      </div>
    </div>
    ${p?.priceChanged && p.priceHistory?.length ? (() => {
      const last = p.priceHistory[p.priceHistory.length - 1];
      const from = Number(BigInt(last.from)) / 1e18, to = Number(BigInt(last.to)) / 1e18, up = to > from;
      return `<div class="pc-alert">
        <div class="pc-alert-ic"><i class="fa-solid fa-triangle-exclamation"></i></div>
        <div class="pc-alert-body">
          <div class="pc-alert-title">${t("pc.alert")} <span class="pc-alert-n">${t("pc.times", { n: p.priceHistory.length })}</span></div>
          <div class="pc-alert-change">
            <span class="pc-from">${from === 0 ? t("stat.free") : eth(from)}</span>
            <i class="fa-solid fa-arrow-right"></i>
            <span class="pc-to ${up ? "up" : "down"}">${to === 0 ? t("stat.free") : eth(to)}</span>
            <span class="pc-dir ${up ? "up" : "down"}"><i class="fa-solid fa-arrow-${up ? "up" : "down"}"></i> ${up ? t("pc.up") : t("pc.down")}</span>
          </div>
        </div>
      </div>`;
    })() : ""}
    <!-- 大数字统计块 -->
    <div class="bignum">
      <div class="bn bn-wide"><div class="bn-l">${t("stat.progress")} <span class="bn-tag" id="tm-tag">${m.totalSupply != null ? t("tag.onchain") : t("tag.session")}</span></div><div class="bn-v" id="bn-progress">${fmtNum(total)}${max ? " / " + fmtNum(max) : ` <span class="bn-loading" id="max-loading">/ <i class="fa-solid fa-circle-notch fa-spin"></i></span>`} ${pct != null ? `<span class="bn-pct">(${pct.toFixed(1)}%)</span>` : ""}</div></div>
      <div class="bn"><div class="bn-l">${t("stat.unitPrice")}</div><div class="bn-v" id="bn-price">…</div></div>
      <div class="bn"><div class="bn-l">${t("stat.maxTx")}</div><div class="bn-v" id="bn-maxtx">…</div></div>
      <div class="bn"><div class="bn-l">${t("stat.mintersObserved")} <span class="bn-tag" id="holders-tag">${t("tag.session")}</span></div><div class="bn-v" id="bn-holders">${fmtNum(minters)} ${avgPerMinter != null && avgPerMinter >= 1.05 ? `<span class="bn-pct" title="avg mints per minter">(×${avgPerMinter.toFixed(1)})</span>` : ""}</div></div>
    </div>
    ${pct != null ? `<div class="dprog"><div class="track"><div class="fill" style="width:${pct.toFixed(1)}%"></div></div></div>` : ""}
    <!-- SeaDrop mint schedule -->
    <div class="dsection" id="sched-section" style="${p?.isSeaDrop ? "" : "display:none"}">
      <div class="dsec-title">${OS_ICON} ${t("sec.schedule")} <span class="dsec-sub" id="sched-sub"></span></div>
      <div id="sched-box">${loading()}</div>
    </div>
    <!-- mint sim -->
    <div class="dsection">
      <div class="dsec-title">${t("sec.mintSim")} <span class="dsec-sub">${walletAddr ? t("sim.yourWallet") : t("sim.testAddr")} · eth_call</span></div>
      <div id="sim-box" class="sim-box">${loading(t("sim.simulating"))}</div>
    </div>
    <!-- 最新 mint 画廊 -->
    <div class="dsection" id="art-section" style="${p?.recentTokenIds?.length ? "" : "display:none"}">
      <div class="dsec-title">${t("sec.latestMints")} <span class="dsec-sub" id="art-sub"></span></div>
      <div id="art-gallery" class="art-gallery">${loading(t("art.fetching"))}</div>
    </div>
    <!-- mint 方式 -->
    <div class="dsection">
      <div class="dsec-title">${t("sec.mintMethods")} <span class="dsec-sub" id="method-sub">${t("method.analyzing")}</span></div>
      <div id="method-table" class="method-table">${loading(t("method.reading"))}</div>
    </div>
    <!-- ETH 消耗统计 -->
    <div class="dsection">
      <div class="dsec-title">${t("sec.ethSpent")} <span class="dsec-sub">${t("sec.ethSpentSub")}</span></div>
      <div class="ethspend" id="ethspend">${loading()}</div>
    </div>
    ${p?.priceHistory?.length ? `<!-- price changes -->
    <div class="dsection">
      <div class="dsec-title"><i class="fa-solid fa-arrow-right-arrow-left" style="color:var(--signal)"></i> ${t("sec.priceChanges")} <span class="dsec-sub">${p.priceHistory.length} ×</span></div>
      <div class="pc-list">${p.priceHistory.slice().reverse().map(h => {
        const from = Number(BigInt(h.from)) / 1e18, to = Number(BigInt(h.to)) / 1e18, up = to > from;
        return `<div class="pc-row"><span class="pc-time" data-ts="${h.ts}" data-suffix=" ${t("ago.suffix")}">${ago(h.ts)} ${t("ago.suffix")}</span><span class="pc-change ${up ? "up" : "down"}">${from === 0 ? t("stat.free") : from + " Ξ"} <i class="fa-solid fa-arrow-right"></i> ${to === 0 ? t("stat.free") : to + " Ξ"}</span></div>`;
      }).join("")}</div>
    </div>` : ""}
    <!-- hold 分布 -->
    <div class="dsection">
      <div class="dsec-title">${t("sec.holderDist")} <span class="dsec-sub" id="holderdist-sub">${t("sec.holderDistSub")}</span></div>
      <div id="holder-dist" class="holder-dist"></div>
    </div>
    <!-- dev + meta -->
    <div class="dmeta">
      <div><span class="ml">${t("meta.dev")}</span> <span id="dev-addr">${p?.deploy?.dev ? `<a class="copyable" href="https://etherscan.io/address/${p.deploy.dev}" target="_blank">${short(p.deploy.dev)}</a>` : (p?.deploy ? "—" : t("meta.lookingUp"))}</span></div>
      <div><span class="ml">${t("meta.devAge")}</span> <span id="dev-age">—</span></div>
      <div><span class="ml">${t("meta.deployed")}</span> <span id="deploy-time">${deployText(p?.deploy)}</span></div>
      <div><span class="ml">${t("meta.deployBlock")}</span> <span id="deploy-block">${p?.deploy?.deployBlock ? "#" + p.deploy.deployBlock : "—"}</span></div>
      <div><span class="ml">${t("meta.rate")}</span> ${rate ? (rate.perMin >= 1 ? rate.perMin.toFixed(0) + "/min" : rate.perHour.toFixed(0) + "/hr") : "—"}</div>
      <div><span class="ml">${t("meta.lastMint")}</span> <span data-ts="${p?.lastMint || 0}" data-suffix=" ${t("ago.suffix")}">${p ? ago(p.lastMint) + " " + t("ago.suffix") : "—"}</span></div>
    </div>`;
  mid.querySelectorAll(".copyable").forEach(c => c.onclick = e => { if (c.dataset.copy) { e.preventDefault(); navigator.clipboard?.writeText(c.dataset.copy); toast("copied"); } });
  // Refresh 按钮: 允许重抓 (清"已试/失败"锁), 但保留已有数据 → 刷新时旧数据不消失, 新数据到了再替换
  const rb = $("#detail-refresh");
  if (rb) rb.onclick = async () => {
    const btn = rb.querySelector("i"); if (btn?.classList.contains("fa-spin")) return;
    btn?.classList.add("fa-spin");
    // 只解锁重试标记, 不清 p.analysis/p.meta (旧数据继续显示)
    imgFails.delete(contract); metaFails.delete(contract);
    metaQueued.delete(contract); seadropQueued.delete(contract); deployQueued.delete(contract);
    simCache.delete(contract); artCache.delete(contract);   // 模拟/画廊可重算
    toast("refreshing…");
    // 原地重抓, 不重建整个详情页 (避免闪烁)
    try {
      await Promise.allSettled([
        refreshSupply(contract, p, 0),
        runAnalysis(contract, p, true),
        runArtGallery(contract, p),
        (async () => { if (p) { p.isSeaDrop = null; } await detectSeaDropTx(contract, p).catch(() => {}); if (current === contract) { renderRank(); const sdTag = $("#sd-detail-tag"); if (sdTag) sdTag.style.display = store.get(contract)?.isSeaDrop ? "" : "none"; } })(),
      ]);
      // 分析出新价后重模拟
      if (current === contract) runSim(contract, p);
    } finally { btn?.classList.remove("fa-spin"); }
  };
  renderHolderChart(p);   // 先用 session 数据占位
  refreshSupply(contract, p);
  runSim(contract, p);
  runAnalysis(contract, p);
  runDeployLookup(contract, p);
  runArtGallery(contract, p);
  runSchedule(contract, p);
  runHolders(contract, p);   // 抓链上真实 holder 分布, 替换占位
  runSocials(contract);      // 尽力抓推特/官网 (从 contractURI)
  // SeaDrop 探测 (若未探测过) — 完成后只更新徽标, 不重进 selectProject (防循环)
  if (p && p.isSeaDrop == null && !seadropQueued.has(contract)) {
    seadropQueued.add(contract);
    detectSeaDropTx(contract, p).then(() => { if (current === contract) renderRank(); }).catch(() => {});
  }
}

// 详情页打开时读链上真实 totalSupply/maxSupply (session 计数不准)。失败/读空则重试几次。
async function refreshSupply(contract, p, attempt = 0) {
  if (!p) return;
  const MAX_TRIES = 3;
  try {
    const m = await readNftMeta(rpc, contract, p.std);
    if (m) store.setMeta(contract, m);   // 合并更新 (不覆盖已知值)
    if (current !== contract) return;
    // 用合并后的 meta (这次读空但之前有值时仍显示旧值)
    const merged = store.get(contract)?.meta || m || {};
    const total = merged.totalSupply ?? p.totalMinted ?? 0;
    const max = merged.maxSupply || 0;
    const pct = max > 0 ? Math.min(100, total / max * 100) : null;
    const bp = $("#bn-progress"), tag = $("#tm-tag");
    if (bp) {
      // max 还没读到 + 还能重试 → 显示转圈; 试满仍无 → 显示"max unknown"而非直接消失
      const maxPart = max ? " / " + fmtNum(max)
        : (attempt < MAX_TRIES - 1 ? ` <span class="bn-loading">/ <i class="fa-solid fa-circle-notch fa-spin"></i></span>` : ` <span class="bn-loading" title="contract has no readable max supply">/ ?</span>`);
      bp.innerHTML = `${fmtNum(total)}${maxPart} ${pct != null ? `<span class="bn-pct">(${pct.toFixed(1)}%)</span>` : ""}`;
    }
    if (tag) tag.textContent = merged.totalSupply != null ? "on-chain" : "session";
    const fill = $(".dprog .fill"); if (fill && pct != null) fill.style.width = pct.toFixed(1) + "%";
    // max 还没读到 → 再试 (换节点); 很多合约 max 读一次会抽风
    if (max === 0 && attempt < MAX_TRIES - 1 && current === contract) {
      setTimeout(() => refreshSupply(contract, p, attempt + 1), 1400);
    }
  } catch {
    if (attempt < MAX_TRIES - 1 && current === contract) setTimeout(() => refreshSupply(contract, p, attempt + 1), 1400);
  }
}

// 最新 mint 的 NFT 画廊
const artCache = new Map();   // contract → [{tokenId,image,name}]
async function runArtGallery(contract, p) {
  const sec = $("#art-section"), gal = $("#art-gallery"); if (!sec || !gal) return;
  const ids = p?.recentTokenIds || [];
  if (!ids.length) { sec.style.display = "none"; return; }
  sec.style.display = "";
  const paint = (arr) => {
    if (!arr.length) { gal.innerHTML = `<div class="dnone">no art resolved (may be pre-reveal or off-chain)</div>`; return; }
    $("#art-sub") && ($("#art-sub").textContent = `${arr.length} latest`);
    gal.innerHTML = arr.map(t => {
      // 动图/视频: mp4/webm → video (自动播放静音循环); gif/webp/静态 → img
      //   失败回退用全局函数 (data 属性传兜底图), 避免内联脚本嵌套引号破坏 HTML。
      let media;
      const fbImg = t.image || "";
      if (t.anim && t.animType === "video") {
        media = `<video src="${t.anim}" autoplay loop muted playsinline poster="${fbImg}" data-fb="${fbImg}" onerror="mrMediaErr(this)"></video>`;
      } else if (t.anim && t.animType === "img") {
        media = `<img loading="lazy" src="${t.anim}" data-fb="${fbImg}" onerror="mrMediaErr(this)">`;
      } else if (t.image) {
        media = `<img loading="lazy" src="${t.image}" onerror="mrMediaErr(this)">`;
      } else {
        media = '<i class="fa-solid fa-image"></i>';
      }
      const anim = t.anim && t.animType === "video" ? ' <i class="fa-solid fa-circle-play art-anim" title="animated"></i>' : "";
      return `
      <a class="art-card" href="https://opensea.io/assets/ethereum/${contract}/${t.tokenId}" target="_blank" rel="noopener" title="View on OpenSea">
        <div class="art-img">${media}</div>
        <div class="art-name">${t.name || (p?.name || "") + " #" + t.tokenId}${anim}</div>
        <div class="art-id">#${t.tokenId} <i class="fa-solid fa-arrow-up-right-from-square art-ext"></i></div>
      </a>`;
    }).join("");
  };
  if (artCache.has(contract)) { paint(artCache.get(contract)); return; }
  try {
    const arr = await fetchLatestMints(rpc, contract, ids, 8, p?.std || 721);
    artCache.set(contract, arr);
    if (current === contract) paint(arr);
  } catch { gal.innerHTML = `<div class="dnone">couldn't load art — try Refresh</div>`; }
}

// SeaDrop mint schedule (阶段表) — 从链上事件 + IPFS 读完整公售阶段
const schedCache = new Map();   // contract → schedule 结果
async function runSchedule(contract, p) {
  const sec = $("#sched-section"), box = $("#sched-box"); if (!sec || !box) return;
  if (!p?.isSeaDrop) { sec.style.display = "none"; return; }
  sec.style.display = "";
  const paint = (sch) => {
    if (current !== contract) return;
    const sub = $("#sched-sub");
    if (sch?.error === "archive") {
      box.innerHTML = `<div class="dnone">${t("sched.needArchive")}</div>`;
      return;
    }
    if (!sch?.stages?.length) { box.innerHTML = `<div class="dnone">${t("sched.none")}</div>`; return; }
    if (sub) sub.textContent = `${sch.stages.length} ${t("sched.stages")}`;
    const now = Math.floor(Date.now() / 1000);
    box.innerHTML = `<div class="sched">${sch.stages.map(s => {
      const started = s.startTime && now >= s.startTime;
      const ended = s.endTime && now > s.endTime;
      const live = started && !ended;
      const state = live ? "live" : ended ? "done" : "upcoming";
      const dot = live ? '<span class="sc-dot live"></span>' : ended ? '<i class="fa-solid fa-circle-check sc-done"></i>' : '<span class="sc-dot"></span>';
      const when = live ? `${t("sched.mintingNow")}${s.endTime ? ` · ${t("sched.ends")} ${fmtDate(s.endTime)}` : ""}`
        : ended ? `${t("sched.ended")} ${fmtDate(s.endTime)}`
        : s.startTime ? `${t("sched.starts")} ${fmtDate(s.startTime)}` : "—";
      const price = s.mintPriceEth === 0 ? t("stat.free") : eth(s.mintPriceEth);
      const limit = s.maxPerWallet ? `${s.maxPerWallet} ${t("sched.perWallet")}` : "";
      return `
        <div class="sc-row ${state}">
          <div class="sc-mark">${dot}</div>
          <div class="sc-body">
            <div class="sc-name">${s.name}${s.isPublic ? '' : ` <span class="sc-tag">${t("sched.allowlist")}</span>`}</div>
            <div class="sc-when">${when}</div>
            <div class="sc-meta">${price}${limit ? ` <span class="sc-sep">·</span> ${limit}` : ""}</div>
          </div>
        </div>`;
    }).join("")}</div>`;
  };
  if (schedCache.has(contract)) { paint(schedCache.get(contract)); return; }
  try {
    const sch = await fetchSeaDropSchedule(rpc, contract);
    if (sch && !sch.error) schedCache.set(contract, sch);   // 只缓存成功
    paint(sch);
  } catch { if (current === contract) box.innerHTML = `<div class="dnone">${t("sched.loadFail")}</div>`; }
}
// 日期格式化 (schedule 用): "Jul 6, 5:15 PM"
function fmtDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ", " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// mint sim (eth_call) — 用真实侦测的价格, 不猜
async function runSim(contract, p) {
  if (!scanner) return;
  const box = $("#sim-box"); if (!box) return;
  const cached = simCache.get(contract);
  if (cached) { paintSim(cached); return; }
  const user = walletAddr || TEST_ADDR;
  // 真实价格侦测: ① SeaDrop 合约读 getPublicDrop  ② 普通合约用观测到的众数单价
  let pw = 0n, src = null, isSD = !!p?.isSeaDrop;
  try {
    const sd = p?.seadrop || await readSeaDrop(rpcMid, contract);
    if (sd) { p.seadrop = sd; isSD = true; if (sd.mintPriceWei > 0n) { pw = sd.mintPriceWei; src = "seadrop"; } }
  } catch {}
  // getPublicDrop 读不到价 (SeaDrop 版本差异会 revert) → 退回观测到的真实成交价
  if (pw === 0n) {
    try { if (p?.analysis?.unitPriceWei != null && BigInt(p.analysis.unitPriceWei) > 0n) { pw = BigInt(p.analysis.unitPriceWei); src = "observed"; } } catch {}
  }
  // 取真实成功 mint tx 做"重放模拟"(把 minter 换成用户地址) — 最稳。
  //   最新 3 笔样本并行拉取 tx (原来串行 5 笔太慢), 再按新→旧顺序试重放。
  const candidates = (p?.recentTxs || []).slice(-3).reverse();   // 最新 3 笔, 新的优先
  let sim = null;
  try {
    // 并行拉 tx 详情 (走 mid 快道), 大幅缩短"逐笔 await"的串行等待
    const samples = (await Promise.all(candidates.map(async h => {
      try { const tx = await rpcMid("eth_getTransactionByHash", [h]); if (tx && tx.input && tx.input !== "0x") return { to: tx.to, input: tx.input, from: tx.from, value: tx.value }; } catch {}
      return null;
    }))).filter(Boolean);
    for (const sample of samples) {
      sim = await simulateMint(rpcMid, contract, user, pw, 1, isSD, sample);
      if (sim?.mintable) break;   // 成功即止; 失败继续试下一笔样本
    }
    // 一个样本都没拿到 → 走无样本路径 (候选函数/SeaDrop 手工构造)
    if (!sim) sim = await simulateMint(rpcMid, contract, user, pw, 1, isSD, null);
    sim.priceSrc = sim.priceReplay ? "observed (replay)" : src;
    // 只缓存"成功"结果; 失败不缓存 → 下次 (拿到更好样本/公售开始) 可重试
    if (sim.mintable) simCache.set(contract, sim);
    if (current === contract) paintSim(sim);
  } catch { box.innerHTML = `<div class="dnone">simulation failed — try Refresh</div>`; }
}
function paintSim(sim) {
  const box = $("#sim-box"); if (!box) return;
  const cls = sim.mintable ? "sim-ok" : "sim-no";
  const icon = sim.mintable ? "fa-circle-check" : "fa-circle-xmark";
  const srcTxt = sim.priceSrc === "seadrop" ? "on-chain (SeaDrop)" : sim.priceSrc === "observed" ? "observed" : "unknown";
  const priceLine = sim.mintable && sim.unitPriceEth != null
    ? `<span class="ml">price</span> ${eth(sim.unitPriceEth)} <span class="src-tag">${srcTxt}</span>` : "";
  box.innerHTML = `
    <div class="sim-verdict ${cls}"><i class="fa-solid ${icon}"></i> ${sim.mintable ? "directly mintable" : "not directly mintable"}</div>
    <div class="sim-note">${sim.note}</div>
    ${sim.method ? `<div class="sim-meta"><span class="ml">fn</span> <code>${sim.method}</code>${priceLine ? " · " + priceLine : ""}</div>` : ""}
    <div class="sim-hint">eth_call static sim — passing doesn't guarantee a real mint. Verify signature / timing / gas yourself.</div>`;
}

// mint 分布 — 横条 + 直接显示数字 (铸1个/2-3/4-10/10+ 各多少地址)
// 渲染分布横条 (通用). data = [{key,n}]
function paintDist(box, data) {
  const total = data.reduce((s, b) => s + b.n, 0) || 1;
  const max = Math.max(1, ...data.map(b => b.n));
  box.innerHTML = data.map((b, i) => {
    const pct = (b.n / total * 100);
    const w = (b.n / max * 100);
    return `<div class="dist-row"><div class="dist-label">${b.key}</div><div class="dist-val">${b.n} <span class="dist-pct">${pct.toFixed(0)}%</span></div><div class="dist-track"><div class="dist-fill t${i}" style="width:${w.toFixed(1)}%"></div></div></div>`;
  }).join("");
}
// 先用 session 数据即时显示 (占位)
function renderHolderChart(p) {
  const box = $("#holder-dist"); if (!box || !p?.mintCounts) return;
  const buckets = [{ key: t("holder.hold1"), n: 0 }, { key: "2–3", n: 0 }, { key: "4–10", n: 0 }, { key: "10+", n: 0 }];
  for (const c of p.mintCounts.values()) { if (c === 1) buckets[0].n++; else if (c <= 3) buckets[1].n++; else if (c <= 10) buckets[2].n++; else buckets[3].n++; }
  paintDist(box, buckets);
}

// 抓链上真实 holder: 更新 holder 统计 + 分布图 (用真实 balanceOf, 准确)
// OpenSea API key (可选, 用户在设置里填). 填了就用 OpenSea 抓社交 (含新项目)。
let openseaKey = localStorage.getItem("mr_oskey") || "";
let etherscanKey = localStorage.getItem("mr_eskey") || "";   // 免费 etherscan key → 精确查部署者
// 抓项目社交/官网. OpenSea API (有 key) 优先, 否则链上 contractURI 兜底。
const socialCache = new Map();
async function runSocials(contract) {
  const box = $("#social-links"); if (!box) return;
  const render = (s) => {
    if (current !== contract || !box) return;
    if (!s || s.error) { box.innerHTML = ""; if (s?.error === "bad-key") toast("OpenSea API key invalid"); return; }
    const links = [];
    if (s.verified) links.push(`<span class="social-verified" title="Verified on OpenSea"><i class="fa-solid fa-circle-check"></i></span>`);
    if (s.site) links.push(`<a class="btn sm social" href="${s.site}" target="_blank" rel="noopener" title="Website"><i class="fa-solid fa-globe"></i></a>`);
    if (s.twitter) links.push(`<a class="btn sm social" href="${s.twitter}" target="_blank" rel="noopener" title="X / Twitter"><i class="fa-brands fa-x-twitter"></i></a>`);
    if (s.discord) links.push(`<a class="btn sm social" href="${s.discord}" target="_blank" rel="noopener" title="Discord"><i class="fa-brands fa-discord"></i></a>`);
    box.innerHTML = links.join("");
  };
  if (socialCache.has(contract)) { render(socialCache.get(contract)); return; }
  try { const s = await fetchSocials(rpc, contract, openseaKey); if (s && !s.error) socialCache.set(contract, s); render(s); } catch {}
}
const holderCache = new Map();   // contract → holder stats
async function runHolders(contract, p, attempt = 0) {
  const box = $("#holder-dist"); if (!box) return;
  if (p?.std === 1155) return;   // 1155 无 ownerOf, 跳过
  const total = store.get(contract)?.meta?.totalSupply ?? p?.meta?.totalSupply;
  // totalSupply 还没读到 (refreshSupply 异步) → 稍后重试
  if (!total) { if (attempt < 3 && current === contract) setTimeout(() => runHolders(contract, p, attempt + 1), 1600); return; }
  const paint = (h) => {
    if (current !== contract || !h) return;
    // 顶部 holders 统计 (链上估算)。
    //   百分比 = 持有人 ÷ 已铸造数 = 分散度 (每个已铸造 NFT 平均落在多少独立地址手里)。
    //   100% = 完全分散 (每 NFT 一个独立地址); 越低 = 越集中 (少数地址囤多个)。
    //   不用 maxSupply 当分母 (那是进度, 属于"铸造进度"栏, 不是持有人栏)。
    const bh = $("#bn-holders"), tag = $("#holders-tag");
    const minted = store.get(contract)?.meta?.totalSupply || 0;
    const pct = minted > 0 ? Math.min(100, h.estHolders / minted * 100) : null;
    if (bh) bh.innerHTML = `${fmtNum(h.estHolders)} ${pct != null ? `<span class="bn-pct" title="holders ÷ minted = spread">(${pct.toFixed(1)}%)</span>` : ""}`;
    if (tag) tag.textContent = t("tag.onchainEst");
    // 分布图 (真实 balanceOf)
    const data = [{ key: t("holder.hold1"), n: h.buckets["1"] }, { key: "2–3", n: h.buckets["2-3"] }, { key: "4–10", n: h.buckets["4-10"] }, { key: "10+", n: h.buckets["10+"] }];
    paintDist(box, data);
    const sub = $("#holderdist-sub"); if (sub) sub.textContent = t("holder.sampledN", { n: h.sampled, h: fmtNum(h.estHolders) });
  };
  if (holderCache.has(contract)) { paint(holderCache.get(contract)); return; }
  try {
    const h = await fetchHolderStats(rpc, contract, total, 50);
    if (h) holderCache.set(contract, h);
    paint(h);
  } catch {}
}

// mint 方式 + 成本分析 (采样最近 tx)
async function runAnalysis(contract, p, force = false) {
  if (!p || !scanner) return;
  // 只复用"完整且有方法"的缓存; force (Refresh) 或不完整 (RPC 抽风) 则重跑
  if (!force && p.analysis && p.analysis.complete && p.analysis.methods?.length) { paintAnalysis(p.analysis); return; }
  if (!p.recentTxs?.length) { $("#method-sub") && ($("#method-sub").textContent = "no tx sample"); return; }
  $("#method-sub") && ($("#method-sub").textContent = "analyzing…");
  try {
    const a = await analyzeMints(rpcMid, p.recentTxs, p.txMintCount || null, 30);
    if (a) {
      // 有解析出方法才缓存; 全失败 (methods 空) 不缓存 → 下次重试
      if (a.methods?.length) p.analysis = a;
      // 观测到的链上真实成交价 (众数) → 喂改价侦测 (对所有项目有效, 不依赖 getPublicDrop)
      if (a.unitPriceWei != null) store.setPrice(contract, a.unitPriceWei.toString());
      if (current === contract) { paintAnalysis(a); runSim(contract, p); }
    }
  } catch {}
}
function paintAnalysis(a) {
  const sub = $("#method-sub");
  if (sub) sub.textContent = a.failed ? `sampled ${a.sampled}/${a.attempted} txs (${a.failed} RPC-failed, retrying next open)` : `sampled ${a.sampled} txs`;
  const mt = $("#method-table");
  if (mt) {
    mt.innerHTML = a.methods.length ? a.methods.map((mm, i) => {
      const label = mm.name ? mm.name : mm.sel;
      const sub = mm.sig && mm.name ? `<span class="msig">${mm.sig}</span>` : `<span class="msig unk">${mm.sel} · unknown selector</span>`;
      return `
      <div class="mrow-wrap">
        <div class="mrow" data-mi="${i}">
          <span class="mname"><i class="fa-solid fa-chevron-right mchev"></i> ${label}</span>
          <span class="mstat">${mm.tx} tx · ${mm.addrs} addrs</span>
        </div>
        <div class="mrow-detail" id="mdet-${i}" hidden>${sub}<div class="mdecode" id="mdec-${i}"></div></div>
      </div>`;
    }).join("") : `<div class="dnone">no mint method resolved (RPC busy — try Refresh)</div>`;
    // 点击展开 → 解析该方法一笔样本 tx 的 input data
    mt.querySelectorAll(".mrow").forEach(row => row.onclick = () => {
      const i = +row.dataset.mi, det = $(`#mdet-${i}`), mm = a.methods[i];
      if (!det) return;
      const open = det.hasAttribute("hidden");
      det.toggleAttribute("hidden", !open);
      row.querySelector(".mchev")?.classList.toggle("open", open);
      if (open && !det.dataset.done) { det.dataset.done = "1"; renderDecode(i, mm); }
    });
  }
  // 顶部大数字块: unit price (+ USD 等值) + max/tx
  const bp = $("#bn-price");
  if (bp) {
    if (a.unitPriceEth == null) bp.innerHTML = "—";
    else { const u = usd(a.unitPriceEth); bp.innerHTML = `${eth(a.unitPriceEth)}${u ? ` <span class="bn-usd">${u}</span>` : ""}`; }
  }
  const bmt = $("#bn-maxtx"); if (bmt) bmt.textContent = a.maxPerTx != null ? "x" + a.maxPerTx : "—";

  // ── ETH 消耗统计 ──
  //   session 内该项目所有 mint 的总消耗估算 = 众数单价 × session 观测总铸造数 (真实成交价 × 数量)。
  const p = current ? store.get(current) : null;
  const totalMinted = p?.totalMinted || 0;
  const es = $("#ethspend");
  if (es) {
    const unit = a.unitPriceEth;                              // 每个的真实价 (众数)
    const mintSpend = unit != null ? unit * totalMinted : null;   // 总 mint 花费 (session)
    const avgGasFee = a.avgGasFeeEth;                         // 平均每 tx gas 上限
    const totalTxs = p?.totalTxs || 0;
    const gasSpend = avgGasFee != null ? avgGasFee * totalTxs : null;   // 总 gas 花费估算
    const grand = (mintSpend || 0) + (gasSpend || 0);
    const usdOf = v => { const u = usd(v); return u ? ` <span class="es-usd">${u}</span>` : ""; };
    // 单个 NFT 平均成本 = 单价 + 每 NFT 分摊的 gas (最重要, 放最前)
    const gasPerNft = (avgGasFee != null && a.maxPerTx) ? avgGasFee / Math.max(1, a.maxPerTx) : avgGasFee;
    const costPerNft = unit != null ? unit + (gasPerNft || 0) : null;
    es.innerHTML = `
      <div class="es-grand">
        <div class="es-g-l">${t("cost.perNft")} <span class="es-tag">${t("es.est")}</span></div>
        <div class="es-g-v">${costPerNft != null ? (costPerNft === 0 ? t("es.freeMint") : eth(costPerNft)) : "—"}${costPerNft ? usdOf(costPerNft) : ""}</div>
      </div>
      <div class="es-split">
        <div class="es-item"><div class="es-l"><i class="fa-solid fa-coins"></i> ${t("es.mintValue")}</div><div class="es-v">${unit != null ? (unit === 0 ? t("stat.free") : eth(unit)) : "—"}${unit ? usdOf(unit) : ""}</div><div class="es-sub">${t("es.total")}: ${mintSpend != null ? eth(mintSpend) : "—"}</div></div>
        <div class="es-item"><div class="es-l"><i class="fa-solid fa-gas-pump"></i> ${t("es.gas")}</div><div class="es-v">${gasPerNft != null ? "~" + eth(gasPerNft) : "—"}</div><div class="es-sub">${t("es.total")}: ${gasSpend != null ? eth(gasSpend) : "—"}</div></div>
      </div>`;
  }

}

// 展开 mint 方法 → 解析样本 tx 的 calldata (Etherscan 风格: # / Name / Type / Data)
function renderDecode(i, mm) {
  const box = $(`#mdec-${i}`); if (!box || !mm) return;
  if (!mm.sampleInput) { box.innerHTML = `<div class="md-empty">no calldata (may be a plain transfer)</div>`; return; }
  const dec = decodeCalldata(mm.sampleInput, mm.sig);
  const txLink = mm.sampleTx ? `<a class="md-txlink" href="https://etherscan.io/tx/${mm.sampleTx}" target="_blank" rel="noopener">sample tx <i class="fa-solid fa-arrow-up-right-from-square"></i></a>` : "";
  if (!dec) { box.innerHTML = `<div class="md-empty">could not decode</div>${txLink}`; return; }
  const isAddr = v => /^0x[0-9a-f]{40}$/i.test(v);
  // 会被替换成"你的地址"来模拟的参数 (minter/recipient 类)
  const isMinterParam = nm => /^(minter|minterIfNotPayer|to|recipient|receiver|account)$/i.test(nm || "");
  const rows = dec.params.length ? dec.params.map((pm, k) => {
    const swap = isMinterParam(pm.name) && isAddr(pm.value);
    const val = isAddr(pm.value)
      ? `<a class="md-addr" href="https://etherscan.io/address/${pm.value}" target="_blank" rel="noopener">${pm.value}</a>`
      : pm.value;
    return `<div class="md-prow">
      <span class="md-pi">${k}</span>
      <span class="md-pname">${pm.name}${swap ? ' <i class="fa-solid fa-user-pen md-swap" title="replaced with your address on simulate"></i>' : ""}</span>
      <span class="md-ptype">${pm.type}</span>
      <span class="md-pval">${val}</span>
    </div>`;
  }).join("") : `<div class="md-empty">no parameters</div>`;
  const note = dec.name == null ? `<div class="md-note">unknown selector — showing raw 32-byte words</div>` : "";
  box.innerHTML = `
    <div class="md-head"><span class="md-sel">${dec.selector}</span>${txLink}</div>
    ${note}
    <div class="md-ptable">
      <div class="md-prow md-phead"><span class="md-pi">#</span><span class="md-pname">${t("cd.name")}</span><span class="md-ptype">${t("cd.type")}</span><span class="md-pval">${t("cd.data")}</span></div>
      ${rows}
    </div>`;
}

// 部署信息 + dev 年龄
async function runDeployLookup(contract, p) {
  if (!p || !scanner) return;
  if (!p.deploy && !deployQueued.has(contract)) {
    deployQueued.add(contract);
    // 首选 etherscan (一次请求, 对工厂/CREATE2 也准); 没 key 或失败 → 回退 archive 二分。
    let info = etherscanKey ? await fetchDeployViaEtherscan(rpcArchive, contract, etherscanKey).catch(() => null) : null;
    if (!info) info = await fetchDeployInfo(rpcArchive, contract).catch(() => null);
    // 拿到有效结果 (含 archive 降级标记) 才认;否则从队列移除 → 下次打开/预载会重试, 不永久卡"looking up…"。
    if (info) { store.setDeploy(contract, info); p.deploy = info; }
    else deployQueued.delete(contract);
    if (current === contract) {
      const elT = $("#deploy-time"), elB = $("#deploy-block"), elD = $("#dev-addr");
      if (p.deploy) {
        if (elT) elT.textContent = deployText(p.deploy);
        if (elB) elB.textContent = p.deploy.deployBlock ? "#" + p.deploy.deployBlock : "—";
        if (elD) elD.innerHTML = p.deploy.dev ? `<a class="copyable" href="https://etherscan.io/address/${p.deploy.dev}" target="_blank">${short(p.deploy.dev)}</a>` : "—";
      } else {
        // 这轮没查到 (节点忙/限流) → 显示可重试提示, 不停在"looking up…"
        if (elT) elT.textContent = t("deploy.retry");
        if (elD) elD.textContent = "—";
      }
    }
  }
  // dev 年龄 (需 dev 地址 + archive)
  if (p.deploy?.dev && !p._devAge) {
    p._devAge = "loading";
    const age = await fetchAddrAge(rpcArchive, p.deploy.dev).catch(() => null);
    p._devAge = age;
    if (current === contract) {
      const el = $("#dev-age");
      if (el) el.textContent = !age ? "—" : age.archive === false ? "needs archive RPC" : age.firstTs ? agoFull(age.firstTs) : "no tx history";
    }
  }
}
// deployed文案 (含 archive 降级)
function deployText(d) {
  if (!d) return "looking up…";
  if (d.archive === false) return "needs archive RPC";
  return agoFull(d.deployTs);
}

// ── 钱包连接 ──
//   纯只读: 连接只用于把你的地址代入 mint 模拟 (eth_call), 让"能否 mint / 花费"更准。
//   本工具不会从你钱包发起任何交易 (一键 mint 在路线图上, 目前只读)。
function setWalletBtn() {
  const wb = $("#wallet-btn"); if (!wb) return;
  wb.innerHTML = walletAddr
    ? `<i class="fa-solid fa-wallet"></i> ${short(walletAddr)}`
    : `<i class="fa-solid fa-wallet"></i> ${t("tb.wallet")}`;
  wb.title = walletAddr ? t("wallet.connectedTip", { addr: walletAddr }) : t("wallet.tip");
}
async function connectWallet() {
  if (!window.ethereum) { toast(t("wallet.none")); return; }
  if (walletAddr) {   // 已连 → 再点=断开 (只是前端忘记地址, 不影响钱包本身)
    walletAddr = null; setWalletBtn(); toast(t("wallet.disconnected"));
    if (current) selectProject(current);
    return;
  }
  try {
    const accts = await window.ethereum.request({ method: "eth_requestAccounts" });
    walletAddr = accts[0];
    setWalletBtn();
    toast(t("wallet.connected"));
    if (current) selectProject(current);   // 用真实地址重模拟
  } catch { toast(t("wallet.cancelled")); }
}
$("#wallet-btn").onclick = connectWallet;
$("#wallet-btn").title = t("wallet.tip");
// 钱包切换账号 / 断开 → 同步 (MetaMask 等会 emit)
if (window.ethereum?.on) {
  window.ethereum.on("accountsChanged", (accts) => {
    walletAddr = accts && accts[0] ? accts[0] : null;
    setWalletBtn();
    if (current) selectProject(current);
  });
}

// ── theme (dark / light) ──
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  const icon = $("#theme-toggle").querySelector("i");
  // 显示"当前模式"图标: dark→月亮, light→灯泡 (灯泡更不像齿轮)
  icon.className = t === "light" ? "fa-solid fa-lightbulb" : "fa-solid fa-moon";
  localStorage.setItem("mr_theme", t);
}
$("#theme-toggle").onclick = () => {
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  applyTheme(cur === "dark" ? "light" : "dark");
};
const savedTheme = localStorage.getItem("mr_theme")
  || (window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark");
applyTheme(savedTheme);

// ── 启动 ──
// 迁移: 旧版单 RPC (mr_rpc) → 加入池, 优先度最高
const legacyRpc = localStorage.getItem("mr_rpc");
if (legacyRpc && /^https?:\/\//.test(legacyRpc)) { pool.add(legacyRpc, { priority: 1 }); localStorage.removeItem("mr_rpc"); }
renderControls();
renderAll();
applyStaticI18n();   // 应用当前语言到静态 DOM
// 后端模式: 由后端注入 window.MR_BACKEND (API 基址) → 不自己扫链, 改从后端拉共享历史。
//   纯前端模式 (静态托管, 无此变量) → 照旧自己扫链。两种模式共用同一套渲染。
if (window.MR_BACKEND) {
  startBackendMode(window.MR_BACKEND);
} else {
  // 默认就有公共 RPC 池 + 默认 wss → 开箱即自动Connect并开扫 (用户无需先输入)
  connectAndScan();
}
refreshEthUsd();                          // ETH/USD 现价 (Chainlink 预言机)
setInterval(refreshEthUsd, 300000);      // 每 5 分钟刷

// 改价侦测 (每 40s, 轻量) — tx 的 value 不会变, 所以只查"没查过的新 tx", 缓存单价。
//   拿最近未查过的 mint tx 单价 vs 记录价, 变了打改价标。不重复拉同一笔 tx, 不打爆 RPC。
const txUnitCache = new Map();   // txHash → 单价字符串 (查过就不再查)
setInterval(async () => {
  if (!scanner?.running) return;
  const top = store.ranking({ limit: 20 }).slice(0, 6);   // 只查前 6, 省 RPC 给扫链/侦测
  for (const r of top) {
    const p = store.get(r.contract); if (!p) continue;
    // 找该项目最近一笔"还没查过单价"的 tx
    const fresh = (p.recentTxs || []).slice(-3).filter(h => !txUnitCache.has(h));
    let newUnit = null;
    for (const h of fresh) {
      try {
        const tx = await rpc("eth_getTransactionByHash", [h]);
        if (!tx) continue;
        const minted = p.txMintCount?.get(h) || 1;
        let v = 0n; try { v = BigInt(tx.value || "0x0"); } catch {}
        const u = (v / BigInt(minted)).toString();
        txUnitCache.set(h, u); newUnit = u;
      } catch { break; }   // RPC 忙 → 下轮再说, 不硬刷
    }
    if (newUnit == null) continue;
    const before = p.priceChanged;
    store.setPrice(r.contract, newUnit);
    if (store.get(r.contract)?.priceChanged && !before) {
      toast(`price change detected: ${r.name || short(r.contract)}`);
      renderAll();
    }
  }
  if (txUnitCache.size > 500) txUnitCache.clear();   // 防无限增长
}, 40000);

// 名字补漏 sweep: 每 8s 给榜单里"可见但还没名字"的项目重试 readNftMeta。
//   覆盖"只 mint 过一次、之后不再出现、当时又恰好 RPC 失败"的项目 — 否则它们永远是地址。
setInterval(async () => {
  if (!scanner?.running) return;
  const nameless = store.ranking({ limit: 60 })
    .map(r => store.get(r.contract))
    .filter(p => p && !p.meta && (metaFails.get(p.contract) || 0) < 6)
    .slice(0, 8);   // 每轮最多 8 个, 别打爆 RPC
  for (const p of nameless) {
    metaQueued.add(p.contract);
    try {
      const m = await readNftMeta(rpc, p.contract, p.std);
      if (m && (m.name != null || m.totalSupply != null)) { store.setMeta(p.contract, m); metaFails.delete(p.contract); }
      else { metaQueued.delete(p.contract); metaFails.set(p.contract, (metaFails.get(p.contract) || 0) + 1); }
    } catch { metaQueued.delete(p.contract); metaFails.set(p.contract, (metaFails.get(p.contract) || 0) + 1); }
  }
  scheduleRender();
}, 8000);

// 后台预载 sweep: 负载低时提前把榜单前列项目的所有 detail 数据抓好, 点开秒显示。
//   每 5s 处理一个"缺某项数据"的项目 (轮转), 一次只补一项, 避免和扫链抢 RPC。
const preloadDone = new Set();   // contract → 已完整预载
setInterval(async () => {
  if (!scanner?.running || hoverPaused) return;   // 悬停时也别抢 RPC
  if (prefs.preload === false) return;            // 用户在设置里关了预载
  const top = store.ranking({ limit: 20 }).map(r => store.get(r.contract)).filter(Boolean);
  if (!top.length) return;
  // 找第一个还缺数据的项目, 补它缺的那一项 (每轮一项, 温和)
  for (const p of top) {
    const c = p.contract;
    // ① 名字/供应量
    if (!p.meta && (metaFails.get(c) || 0) < 6) {
      metaQueued.add(c);
      try { const m = await readNftMeta(rpcMid, c, p.std); if (m && (m.name != null || m.totalSupply != null)) { store.setMeta(c, m); scheduleRender(); } else metaFails.set(c, (metaFails.get(c) || 0) + 1); } catch { metaFails.set(c, (metaFails.get(c) || 0) + 1); }
      return;
    }
    // ② SeaDrop 探测
    if (p.isSeaDrop == null && p.recentTxs?.length && !seadropQueued.has(c)) {
      seadropQueued.add(c);
      await detectSeaDropTx(c, p).catch(() => {}); scheduleRender();
      return;
    }
    // ③ 方法/价格分析
    if (!p.analysis?.methods?.length && p.recentTxs?.length) {
      try { const a = await analyzeMints(rpc, p.recentTxs, p.txMintCount || null, 30); if (a?.methods?.length) { p.analysis = a; if (a.unitPriceWei != null) store.setPrice(c, a.unitPriceWei.toString()); } } catch {}
      return;
    }
    // ④ 图片 (榜单已抓封面, 这里确保有)
    if (!imgCache.get(c) && (imgFails.get(c) || 0) < 5) { queueImage(c); return; }
    // ⑤ 部署信息 (dev / 部署时间) — etherscan 优先, 回退二分; 没查到就出队, 下轮可重试
    if (!p.deploy && !deployQueued.has(c)) {
      deployQueued.add(c);
      try {
        let d = etherscanKey ? await fetchDeployViaEtherscan(rpcArchive, c, etherscanKey) : null;
        if (!d) d = await fetchDeployInfo(rpcArchive, c);
        if (d) store.setDeploy(c, d); else deployQueued.delete(c);
      } catch { deployQueued.delete(c); }
      return;
    }
    // ⑥ SeaDrop schedule (仅 SeaDrop 项目)
    if (p.isSeaDrop && !schedCache.has(c)) {
      try { const s = await fetchSeaDropSchedule(rpc, c); if (s && !s.error) schedCache.set(c, s); } catch {}
      return;
    }
    // 这个项目全齐了 → 换下一个
  }
}, 5000);

// hover 暂停刷新: 鼠标在列表上"活动"时冻结自动更新, 离开/静止后立即补刷。
//   用 mousemove + 自愈超时 (1.2s 无移动就解冻), 避免 mouseleave 漏触发导致永久卡住。
let hoverTimer = null;
function showPauseBadge(on) {
  let b = $("#pause-badge");
  if (!b) { b = document.createElement("div"); b.id = "pause-badge"; b.className = "pause-badge";
    b.innerHTML = `<i class="fa-solid fa-pause"></i> ${t("pause.badge")}`; document.body.appendChild(b); }
  b.classList.toggle("show", on);
}
function unpause() {
  clearTimeout(hoverTimer);
  showPauseBadge(false);
  if (!hoverPaused) return;
  hoverPaused = false;
  if (pendingRender) { pendingRender = false; renderAll(); }
}
function pauseFromHover() {
  if (!prefs.hoverPause) return;
  hoverPaused = true;
  showPauseBadge(true);
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(unpause, 1200);   // 静止 1.2s 自动解冻 → 永不卡死
}
["#rank-list", "#stream"].forEach(sel => {
  const el = $(sel);
  el.addEventListener("mousemove", pauseFromHover);
  el.addEventListener("mouseleave", () => { clearTimeout(hoverTimer); unpause(); });
});

// ── 列宽拖拽调整 (记忆到 localStorage) ──
(function setupResizers() {
  const layout = $(".layout"); if (!layout) return;
  const saved = JSON.parse(localStorage.getItem("mr_cols") || "null");
  if (saved) { if (saved.left) layout.style.setProperty("--col-left", saved.left + "px"); if (saved.right) layout.style.setProperty("--col-right", saved.right + "px"); }
  const MIN = 180, MAX = 640;
  const clamp = v => Math.max(MIN, Math.min(MAX, v));
  const save = () => {
    const cs = getComputedStyle(layout);
    localStorage.setItem("mr_cols", JSON.stringify({
      left: parseInt(cs.getPropertyValue("--col-left")), right: parseInt(cs.getPropertyValue("--col-right")),
    }));
  };
  const drag = (handle, varName, fromRight) => {
    if (!handle) return;
    handle.addEventListener("mousedown", e => {
      e.preventDefault();
      handle.classList.add("dragging");
      document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
      const rect = layout.getBoundingClientRect();
      const move = ev => {
        const w = fromRight ? (rect.right - ev.clientX) : (ev.clientX - rect.left);
        layout.style.setProperty(varName, clamp(w) + "px");
      };
      const up = () => {
        handle.classList.remove("dragging");
        document.body.style.cursor = ""; document.body.style.userSelect = "";
        window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
        save();
      };
      window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    });
    // 双击复位
    handle.addEventListener("dblclick", () => { layout.style.removeProperty(varName); save(); });
  };
  drag($("#resize-left"), "--col-left", false);
  drag($("#resize-right"), "--col-right", true);
})();

// ── Preferences + RPC 管理面板 (Theme 旁齿轮按钮) ──
$("#prefs-btn").onclick = openPrefs;
$("#mode-chip").onclick = openPrefs;   // 点模式 chip 直接开 RPC 设置

// ── 语言切换 ──
$("#lang-btn").onclick = () => {
  let m = $("#lang-modal");
  if (!m) { m = document.createElement("div"); m.id = "lang-modal"; m.className = "modal"; document.body.appendChild(m); }
  const cur = getLang();
  m.innerHTML = `
    <div class="modal-card lang-card">
      <div class="modal-head"><h3><i class="fa-solid fa-language"></i> ${t("tb.lang")}</h3><button class="modal-x" id="lang-close"><i class="fa-solid fa-xmark"></i></button></div>
      <div class="lang-grid">${LANGS.map((l, i) => `
        <button class="lang-opt ${l.code === cur ? "on" : ""}" data-lang="${l.code}" style="--d:${i * 22}ms">
          <span class="lang-flag">${l.flag}</span>
          <span class="lang-name">${l.name}</span>
          <span class="lang-code">${l.code.toUpperCase()}</span>
          ${l.code === cur ? '<i class="fa-solid fa-check lang-check"></i>' : ""}
        </button>`).join("")}</div>
    </div>`;
  m.classList.add("show");
  const close = () => m.classList.remove("show");
  $("#lang-close").onclick = close;
  m.onclick = e => { if (e.target === m) close(); };
  m.querySelectorAll("[data-lang]").forEach(b => b.onclick = () => { setLang(b.dataset.lang); close(); });
};

// 应用 i18n 到静态 DOM (标题/按钮/占位), 语言切换时调用
function applyStaticI18n() {
  const set = (sel, txt) => { const e = $(sel); if (e) { const icon = e.querySelector("i"); e.textContent = ""; if (icon) e.appendChild(icon); e.append(" " + txt); } };
  // topbar 按钮 title
  const setTitle = (sel, key) => { const e = $(sel); if (e) e.title = t(key); };
  setTitle("#prefs-btn", "tb.settings"); setTitle("#theme-toggle", "tb.theme");
  setTitle("#lang-btn", "tb.lang"); setTitle("#link-x", "tb.follow"); setTitle("#link-gh", "tb.github"); setTitle("#donate-btn", "tb.donate");
  // 列标题
  const sig = document.querySelector(".col.left h3"); if (sig) sig.childNodes[0].textContent = t("col.signal") + " ";
  const liv = document.querySelector(".col.right h3"); if (liv) liv.childNodes[0].textContent = t("col.live") + " ";
  // 钱包按钮 (未连接时)
  if (typeof setWalletBtn === "function") setWalletBtn();   // 钱包按钮文案+tooltip (随语言更新)
  // detail 空状态
  const dt = document.querySelector("#detail .empty .t"); if (dt) dt.textContent = t("detail.pickTitle");
  const ds = document.querySelector("#detail .empty .s"); if (ds) ds.innerHTML = t("detail.pickSub");
}

// 语言变了 → 重译静态 DOM + 重渲染动态列表 + 重开详情
onLangChange(() => {
  applyStaticI18n();
  renderControls();
  renderAll();
  if (current) selectProject(current);
});


// 首次访问引导弹窗 (介绍 wss / OpenSea key 能解锁什么). "不再提示"记 localStorage。
function showIntro() {
  if (localStorage.getItem("mr_introSeen") === "1") return;
  let m = $("#intro-modal");
  if (!m) { m = document.createElement("div"); m.id = "intro-modal"; m.className = "modal"; document.body.appendChild(m); }
  const li = (k) => `<li><i class="fa-solid fa-check"></i> ${t(k)}</li>`;
  m.innerHTML = `
    <div class="modal-card intro-card">
      <div class="intro-head">
        <div class="intro-logo"><i class="fa-solid fa-satellite-dish"></i></div>
        <h3>${t("intro.title")}</h3>
        <p class="intro-sub">${t("intro.sub")}</p>
      </div>
      <div class="intro-body">
        <div class="intro-feat">
          <div class="intro-feat-h"><i class="fa-solid fa-bolt"></i> ${t("intro.wssTitle")}</div>
          <div class="intro-feat-d">${t("intro.wssDesc")}</div>
          <ul class="intro-list">${li("intro.wss1")}${li("intro.wss2")}${li("intro.wss3")}${li("intro.wss4")}</ul>
        </div>
        <div class="intro-feat">
          <div class="intro-feat-h">${OS_ICON} ${t("intro.osTitle")}</div>
          <div class="intro-feat-d">${t("intro.osDesc")} <a href="https://docs.opensea.io/reference/api-overview" target="_blank" rel="noopener" class="intro-link">${t("intro.getKey")} <i class="fa-solid fa-arrow-up-right-from-square"></i></a></div>
          <ul class="intro-list">${li("intro.os1")}${li("intro.os2")}${li("intro.os3")}</ul>
        </div>
      </div>
      <div class="intro-foot">
        <button class="intro-cta" id="intro-open"><i class="fa-solid fa-gear"></i> ${t("intro.cta")}</button>
        <button class="intro-later" id="intro-skip">${t("intro.skip")}</button>
        <label class="intro-check"><input type="checkbox" id="intro-dontshow"> <span>${t("intro.dontShow")}</span></label>
      </div>
    </div>`;
  m.classList.add("show");
  const close = () => { if ($("#intro-dontshow")?.checked) localStorage.setItem("mr_introSeen", "1"); m.classList.remove("show"); };
  $("#intro-skip").onclick = close;
  $("#intro-open").onclick = () => { close(); openPrefs(); };
  m.onclick = e => { if (e.target === m) close(); };
}

// Donate 弹窗 (ETH 地址, 点击复制). 地址在这里配置。
const DONATE_ADDR = "0x3400f5df694a3088b173b80ca5ba8467f2621de7";   // ETH 收款地址
$("#donate-btn").onclick = () => {
  let m = $("#donate-modal");
  if (!m) { m = document.createElement("div"); m.id = "donate-modal"; m.className = "modal"; document.body.appendChild(m); }
  m.innerHTML = `
    <div class="modal-card donate-card">
      <button class="modal-x donate-x" id="donate-close"><i class="fa-solid fa-xmark"></i></button>
      <div class="donate-hero">
        <div class="donate-orbit"><i class="fa-solid fa-heart"></i></div>
        <div class="donate-title">${t("donate.title")}</div>
        <p class="donate-txt">${t("donate.text")}</p>
      </div>
      <div class="donate-addr" id="donate-copy" title="${t("donate.copy")}">
        <span class="da-net"><i class="fa-brands fa-ethereum"></i> ETH · any EVM chain</span>
        <span class="da-val">${DONATE_ADDR}</span>
        <span class="da-copy"><i class="fa-solid fa-copy"></i> copy</span>
      </div>
    </div>`;
  m.classList.add("show");
  const close = () => m.classList.remove("show");
  $("#donate-close").onclick = close;
  m.onclick = e => { if (e.target === m) close(); };
  $("#donate-copy").onclick = () => {
    navigator.clipboard?.writeText(DONATE_ADDR);
    const el = $("#donate-copy"); el.classList.add("copied");
    setTimeout(() => el.classList.remove("copied"), 1400);
    toast(t("donate.copied"));
  };
};
function openPrefs() {
  let modal = $("#prefs-modal");
  if (!modal) { modal = document.createElement("div"); modal.id = "prefs-modal"; modal.className = "modal"; document.body.appendChild(modal); }
  const nodes = pool.health();
  modal.innerHTML = `
    <div class="modal-card wide">
      <div class="modal-head"><h3>${t("set.title")}</h3><button class="modal-x" id="prefs-close"><i class="fa-solid fa-xmark"></i></button></div>
      <div class="modal-sec">
        <div class="modal-label">${t("set.dataSource")}
          <span class="modal-sublbl">${wsUrl ? t("set.wsSub") : t("set.httpSub")}</span></div>
        <div class="mode-line ${wsUrl ? "is-ws" : "is-http"}">
          <i class="fa-solid ${wsUrl ? "fa-bolt" : "fa-tower-broadcast"}"></i>
          <span class="mode-line-txt">${wsUrl ? "WS · " + wsUrl : t("set.httpPoll") + " · " + pool.list().length + " " + t("set.rpcNodesN")}</span>
          ${wsUrl ? `<button class="btn sm ghost" id="ws-clear">${t("set.switchHttp")}</button>` : ""}
        </div>
        <div class="modal-add">
          <input id="rpc-main-url" placeholder="http(s):// · wss://">
          <button class="btn sm" id="rpc-main-btn">${t("set.connect")}</button>
        </div>
        <div class="modal-hint">${t("set.rpcHint")}</div>
      </div>
      <div class="modal-sec">
        <div class="modal-label">${t("set.prefs")}</div>
        <div class="modal-opts">
          <button class="opt ${prefs.hoverPause ? "on" : ""}" id="hover-toggle">${t("set.hoverPause")}</button>
          <button class="opt ${pool.saveTokens ? "on" : ""}" id="savetokens-toggle">${t("set.saveTokens")}</button>
          <button class="opt ${prefs.preload !== false ? "on" : ""}" id="preload-toggle">${t("set.preload")}</button>
        </div>
      </div>
      <div class="modal-sec">
        <div class="modal-label">${t("set.osKey")} <span class="modal-sublbl">${t("set.osKeySub")}</span></div>
        <div class="modal-add">
          <input id="oskey-input" type="password" placeholder="sk_..." value="${openseaKey ? "••••••••••••" : ""}">
          <button class="btn sm" id="oskey-save">${t("set.save")}</button>
          ${openseaKey ? `<button class="btn sm ghost" id="oskey-clear">${t("set.clear")}</button>` : ""}
        </div>
      </div>
      <div class="modal-sec">
        <div class="modal-label">${t("set.esKey")} <span class="modal-sublbl">${t("set.esKeySub")}</span></div>
        <div class="modal-add">
          <input id="eskey-input" type="password" placeholder="etherscan API key" value="${etherscanKey ? "••••••••••••" : ""}">
          <button class="btn sm" id="eskey-save">${t("set.save")}</button>
          ${etherscanKey ? `<button class="btn sm ghost" id="eskey-clear">${t("set.clear")}</button>` : ""}
        </div>
      </div>
      <div class="modal-sec">
        <div class="modal-label">${t("set.rpcNodes")} <span class="modal-sublbl">${wsUrl ? t("set.rpcNodesWsSub") : t("set.rpcNodesSub")}</span></div>
        <div class="rpc-table">${nodes.map(n => `
          <div class="rpc-node ${n.cooling ? "cooling" : ""}" data-url="${n.url}">
            <div class="rn-main">
              <div class="rn-label">${n.label}</div>
              <div class="rn-url">${n.url}</div>
            </div>
            <div class="rn-ctrl">
              <label>${t("set.priority")}<input class="rn-num" type="number" min="1" value="${n.priority}" data-k="priority"></label>
              <label>req/s<input class="rn-num" type="number" min="1" value="${n.rps}" data-k="rps"></label>
              <span class="rn-stat ${n.cooling ? "bad" : "ok"}">${n.cooling ? t("set.cooldown") + " " + Math.ceil(n.cooldownMs / 1000) + "s" : "ok " + n.ok}</span>
              <button class="rn-del" title="${t("set.remove")}"><i class="fa-solid fa-xmark"></i></button>
            </div>
          </div>`).join("")}</div>
        <div class="modal-add">
          <input id="rpc-add-url" placeholder="https://…  ${t("set.addRpc")}">
          <button class="btn sm" id="rpc-add-btn">${t("set.add")}</button>
        </div>
      </div>
      <div class="modal-foot"><button class="btn" id="prefs-apply">${t("set.done")}</button></div>
    </div>`;
  modal.classList.add("show");
  const close = () => modal.classList.remove("show");
  $("#prefs-close").onclick = close; $("#prefs-apply").onclick = close;
  modal.onclick = e => { if (e.target === modal) close(); };
  // 主 RPC 输入 (wss/http) + 切回 http
  const mainConnect = async () => { const u = $("#rpc-main-url").value.trim(); $("#rpc-main-url").value = ""; await applyRpcInput(u); openPrefs(); };
  $("#rpc-main-btn").onclick = mainConnect;
  $("#rpc-main-url").onkeydown = e => { if (e.key === "Enter") mainConnect(); };
  if ($("#ws-clear")) $("#ws-clear").onclick = () => { clearWs(); openPrefs(); };
  // 原地切换 (只改 .on class, 不重渲染整个弹窗 → 无抖动)
  $("#hover-toggle").onclick = e => { prefs.hoverPause = !prefs.hoverPause; savePrefs(); if (!prefs.hoverPause) unpause(); e.currentTarget.classList.toggle("on", prefs.hoverPause); };
  $("#savetokens-toggle").onclick = e => { pool.setSaveTokens(!pool.saveTokens); e.currentTarget.classList.toggle("on", pool.saveTokens); };
  $("#preload-toggle").onclick = e => { prefs.preload = prefs.preload === false ? true : false; savePrefs(); e.currentTarget.classList.toggle("on", prefs.preload !== false); };
  $("#oskey-save").onclick = () => {
    const v = $("#oskey-input").value.trim();
    if (v && v !== "••••••••••••") { openseaKey = v; localStorage.setItem("mr_oskey", v); socialCache.clear(); toast(t("set.osKeySaved")); openPrefs(); if (current) runSocials(current); }
  };
  if ($("#oskey-clear")) $("#oskey-clear").onclick = () => { openseaKey = ""; localStorage.removeItem("mr_oskey"); socialCache.clear(); toast(t("set.osKeyCleared")); openPrefs(); };
  $("#eskey-save").onclick = () => {
    const v = $("#eskey-input").value.trim();
    if (v && v !== "••••••••••••") { etherscanKey = v; localStorage.setItem("mr_eskey", v); deployQueued.clear(); toast(t("set.esKeySaved")); openPrefs(); if (current) { const p = store.get(current); if (p) { p.deploy = null; runDeployLookup(current, p); } } }
  };
  if ($("#eskey-clear")) $("#eskey-clear").onclick = () => { etherscanKey = ""; localStorage.removeItem("mr_eskey"); toast(t("set.esKeyCleared")); openPrefs(); };
  modal.querySelectorAll(".rpc-node").forEach(node => {
    const url = node.dataset.url;
    node.querySelector(".rn-del").onclick = () => { pool.remove(url); openPrefs(); };
    node.querySelectorAll(".rn-num").forEach(inp => inp.onchange = () => {
      const v = parseInt(inp.value) || 1; pool.update(url, { [inp.dataset.k]: v });
    });
  });
  $("#rpc-add-btn").onclick = () => {
    const u = $("#rpc-add-url").value.trim();
    if (pool.add(u, { priority: 5 })) { openPrefs(); connectAndScan(); } else toast("invalid or duplicate RPC");
  };
  // cooldown 状态每秒刷新 (仅当面板开着)
  if (modal._t) clearInterval(modal._t);
  modal._t = setInterval(() => { if (!modal.classList.contains("show")) { clearInterval(modal._t); return; }
    pool.health().forEach(n => { const el = modal.querySelector(`.rpc-node[data-url="${CSS.escape(n.url)}"] .rn-stat`); if (el) { el.className = "rn-stat " + (n.cooling ? "bad" : "ok"); el.textContent = n.cooling ? "cooldown  " + Math.ceil(n.cooldownMs / 1000) + "s" : "ok " + n.ok; } });
  }, 1000);
}

// 相对时间实时更新 (每秒, 不重渲染, 只改 [data-ts] 文本 + 距上块时间)
function tickTimestamps() {
  document.querySelectorAll("[data-ts]").forEach(el => {
    const ts = +el.dataset.ts;
    if (!ts) return;
    const suffix = el.dataset.suffix || "";
    el.textContent = ago(ts) + suffix;
  });
  const ba = $("#block-age");
  if (ba) {
    // 距"收到这个块"过了多久。和 ago() 用完全一样的算法 (floor(now秒) - floor(收到秒)) →
    //   顶部 block-age 和下面区块行的秒数永远逐字相同, 不会一个 5s 一个 4s。不受电脑时钟影响。
    if (lastHeadAt) { const s = Math.max(0, Math.floor(Date.now() / 1000) - Math.floor(lastHeadAt / 1000)); ba.textContent = `#${lastHead} · ${s}s`; }
    else ba.textContent = scanner?.running ? "…" : "—";
  }
}
setInterval(tickTimestamps, 1000);
