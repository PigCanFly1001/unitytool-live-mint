// erc721.js — 浏览器侧读 ERC721 合约元数据 (name/symbol/totalSupply/maxSupply)
//   纯 eth_call + 手写 ABI 编码/解码, 不依赖库。

// 函数选择器 (keccak256 前4字节)
const SEL = {
  name:        "0x06fdde03",
  symbol:      "0x95d89b41",
  totalSupply: "0x18160ddd",
  maxSupply:   "0xd5abeb01",   // 常见但非标准, 很多合约有
  tokenURI:    "0xc87b56dd",   // ERC721 tokenURI(uint256)
  uri1155:     "0x0e89341c",   // ERC1155 uri(uint256)
};

// ERC1155 元数据 URI 里的 {id} 要替换成 64位0填充的 16进制 tokenId (小写, 无0x)
function subId(uri, tokenId) {
  if (!uri || !uri.includes("{id}")) return uri;
  const hex = BigInt(tokenId).toString(16).padStart(64, "0");
  return uri.replace(/\{id\}/g, hex);
}
// 依 std 选 metadata URI 选择器
const uriSel = std => (std === 1155 ? SEL.uri1155 : SEL.tokenURI);

// SeaDrop (OpenSea OpenDrop) V1 合约 + getPublicDrop(address)
const SEADROP_V1 = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const SEL_GET_PUBLIC_DROP = "0xa9759c94";   // getPublicDrop(address)

// 已知 SeaDrop / OpenSea drop 合约地址 (mint tx 的 to = 这些 = 100% 是 SeaDrop)
const SEADROP_CONTRACTS = new Set([
  "0x00005ea00ac477b1030ce78506496e8c2de24bf5",   // SeaDrop v1
  "0x00005ea00ac477b1030ce78506496e8c2de24bf6",   // SeaDrop 变体
]);
const SEADROP_V1_LC = "0x00005ea00ac477b1030ce78506496e8c2de24bf5";
// DropURIUpdated(address indexed nftContract, string newDropURI) 事件 topic0 (链上实测)
const TOPIC_DROP_URI = "0xa0295608d25b3033c2e2c41cbac8746c2d08767bcfde6d47fae1ed7ba1d32150";

// 解 ABI string (event data 里的动态 string)
function decodeEventString(hex) {
  try {
    const h = hex.replace(/^0x/, "");
    const off = parseInt(h.slice(0, 64), 16) * 2;
    const len = parseInt(h.slice(off, off + 64), 16);
    const b = h.slice(off + 64, off + 64 + len * 2);
    let s = ""; for (let i = 0; i < b.length; i += 2) s += String.fromCharCode(parseInt(b.substr(i, 2), 16));
    return s;
  } catch { return null; }
}

// 二分找合约部署块。eth_getCode 历史块 — 免费节点里 drpc 等支持, 池会 failover 过去。
//   每次查带重试, 单次瞬时失败不当"查不了历史"(否则误报 archive)。
async function findDeployBlock(rpc, contract, head) {
  const hasCode = async b => {
    for (let i = 0; i < 3; i++) {   // 重试 3 次 (给池 failover 到 drpc 的机会)
      try { const c = await rpcCall(rpc, "eth_getCode", [contract, "0x" + b.toString(16)]); return c && c !== "0x"; }
      catch { await new Promise(r => setTimeout(r, 300)); }
    }
    return null;   // 3 次都失败才算查不了
  };
  let lo = Math.max(0, head - 2500000), hi = head;
  const loHas = await hasCode(lo);
  if (loHas === null) return null;
  if (loHas) lo = 0;
  if (!(await hasCode(hi))) return null;
  while (lo < hi) { const mid = (lo + hi) >> 1; const h = await hasCode(mid); if (h === null) return null; if (h) hi = mid; else lo = mid + 1; }
  return lo;
}

/**
 * 读 SeaDrop 完整 mint schedule (阶段表)。纯前端 + 免费 RPC (drpc 支持历史 logs)。
 *   ① 二分找部署块 ② 从部署块扫 DropURIUpdated 事件 ③ 取最新 IPFS URI ④ 解析 stages。
 *   返回 { stages:[{name,isPublic,mintPriceEth,startTime,endTime,maxPerWallet,feeBps}], source }
 *   或 null (拿不到 → UI 降级到基础信息)。
 */
export async function fetchSeaDropSchedule(rpc, contract) {
  try {
    const head = parseInt(await rpcCall(rpc, "eth_blockNumber", []), 16);
    const deploy = await findDeployBlock(rpc, contract, head);
    if (deploy == null) return { error: "archive" };   // 免费节点查不了历史
    const nft32 = contract.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    // 从部署块起扫 DropURIUpdated (分段, 每段 9k 块, 最多扫 40k)
    const uris = [];
    for (let f = deploy; f < deploy + 40000 && f <= head; f += 9000) {
      const to = Math.min(f + 8999, head);
      let logs;
      try {
        logs = await rpcCall(rpc, "eth_getLogs", [{
          fromBlock: "0x" + f.toString(16), toBlock: "0x" + to.toString(16),
          address: SEADROP_V1_LC, topics: [TOPIC_DROP_URI, "0x" + nft32],
        }]);
      } catch (e) {
        // 只有明确的 archive/授权错才降级; range/limit 是范围问题(缩小范围重试), 别误判 archive
        if (/archive|personal token|state.*unavailable/i.test(e.message || "")) return { error: "archive" };
        continue;   // 其他错 (range/瞬时) → 跳过这段继续
      }
      for (const l of logs || []) { const u = decodeEventString(l.data); if (u && /^(ipfs|https?|ar):/.test(u)) uris.push(u); }
    }
    if (!uris.length) return null;   // 无阶段事件 (可能只用 getPublicDrop 配置)
    const latest = uris[uris.length - 1];   // 最新配置
    const meta = await fetchJson(ipfs(latest));
    if (!meta?.stages?.length) return null;
    const stages = meta.stages.map(s => ({
      name: s.name || (s.isPublic ? "Public" : "Allowlist"),
      isPublic: !!s.isPublic,
      mintPriceEth: (Number(s.mintPrice) || 0) / 1e18,
      startTime: s.startTime || null,
      endTime: s.endTime || null,
      maxPerWallet: s.maxTotalMintableByWallet || null,
      maxForStage: s.maxTokenSupplyForStage || null,
      feeBps: s.feeBps ?? null,
    })).sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
    return { stages, source: latest };
  } catch { return null; }
}
// SeaDrop mint 的 selector (发往 SeaDrop 合约的)
const SEADROP_SELECTORS = new Set([
  "0x161ac21f",   // mintPublic(address,address,address,uint256)
  "0x84bb1e42",   // mintPublic 变体
  "0x4b61cd6f",   // mintAllowList
  "0xcd6e13f7",   // mintSigned
  "0x9b4f3af5",   // mintAllowedTokenHolder
]);

/**
 * 靠一笔真实 mint tx 判定 SeaDrop (最可靠): tx.to 命中已知 SeaDrop 合约。
 *   getPublicDrop 新版会 revert, supportsInterface 会误报, 但 tx.to 是铁证。
 *   返回 { isSeaDrop:true, nftContract } 或 null。
 */
export async function detectSeaDropByTx(rpc, txHash) {
  try {
    const tx = await rpcCall(rpc, "eth_getTransactionByHash", [txHash]);
    if (!tx) return null;
    const to = (tx.to || "").toLowerCase();
    const sel = (tx.input || "0x").slice(0, 10);
    if (SEADROP_CONTRACTS.has(to) || SEADROP_SELECTORS.has(sel)) {
      // mintPublic 首参 = nftContract (确认它 mint 的是哪个合约)
      let nftContract = null;
      if (tx.input && tx.input.length >= 74) nftContract = "0x" + tx.input.slice(34, 74);
      return { isSeaDrop: true, nftContract, seadropContract: to, selector: sel };
    }
    return null;
  } catch { return null; }
}

/**
 * 检测 SeaDrop + 读公售配置。
 *   SeaDrop v1 getPublicDrop(nft) 返回非全零 → 确认是 SeaDrop 且拿到真实价格/时间/每钱包上限。
 *   (supportsInterface 不可靠 — 实测普通 721 也会对多个 iface 返回 true, 故只信 getPublicDrop。)
 */
export async function readSeaDrop(rpc, nftContract) {
  const nft32 = nftContract.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  try {
    const hex = await ethCall(rpc, SEADROP_V1, SEL_GET_PUBLIC_DROP + nft32);
    if (!hex || hex === "0x" || hex.length < 2 + 64 * 5) return null;
    const w = i => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
    const u = i => BigInt("0x" + w(i));
    const mintPriceWei = u(0), startTime = Number(u(1)), endTime = Number(u(2)), maxPerWallet = Number(u(3)), feeBps = Number(u(4));
    // 全 0 = 没在 v1 SeaDrop 配公售 (可能是新版 SeaDrop 或非 SeaDrop) → 不误标
    if (mintPriceWei === 0n && startTime === 0 && endTime === 0 && maxPerWallet === 0) return null;
    return { isSeaDrop: true, mintPriceWei, mintPriceEth: Number(mintPriceWei) / 1e18,
      startTime: startTime || null, endTime: endTime || null, maxPerWallet: maxPerWallet || null, feeBps };
  } catch { return null; }
}

// rpc 参数可以是 URL 字符串, 也可以是 RPC 池的 call 函数 (method,params)=>Promise
async function rpcCall(rpc, method, params) {
  if (typeof rpc === "function") return rpc(method, params);
  const res = await fetch(rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function ethCall(rpc, to, data, extra) {
  if (typeof rpc === "function") {
    try { return await rpc("eth_call", [{ to, data, ...(extra || {}) }, "latest"]); }
    catch { return null; }
  }
  const res = await fetch(rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data, ...(extra || {}) }, "latest"] }),
  });
  const j = await res.json();
  if (j.error) return null;
  return j.result;
}

// 解码 ABI string (动态): [offset][len][data...]
function decodeString(hex) {
  if (!hex || hex === "0x" || hex.length < 130) return null;
  try {
    const len = parseInt(hex.slice(66, 130), 16);
    if (!len || len > 1000) return null;
    const bytes = hex.slice(130, 130 + len * 2);
    let s = "";
    for (let i = 0; i < bytes.length; i += 2) {
      const c = parseInt(bytes.substr(i, 2), 16);
      if (c) s += String.fromCharCode(c);
    }
    return decodeURIComponent(escape(s)); // 兼容 UTF-8
  } catch { return null; }
}

function decodeUint(hex) {
  if (!hex || hex === "0x") return null;
  try { return Number(BigInt(hex)); } catch { return null; }
}

// IPFS 网关 — ipfs.io 图片加载慢/常失败, 改用更快更稳的网关。
//   metadata JSON 用 fetch (下面 fetchJson), 图片 URL 给 <img> 用 (要选加载快的)。
const IPFS_GW = "https://ipfs.io/ipfs/";           // JSON 抓取用 (Node fetch 兼容好)
const IPFS_IMG_GW = "https://cf-ipfs.com/ipfs/";   // 图片显示用 (Cloudflare CDN, 快)
function ipfs(u, forImage = false) {
  if (!u) return u;
  u = u.trim();
  if (u.startsWith("ipfs://")) return (forImage ? IPFS_IMG_GW : IPFS_GW) + u.slice(7).replace(/^ipfs\//, "");
  if (u.startsWith("ar://")) return "https://arweave.net/" + u.slice(5);
  return u;
}
// 从一个 URI (tokenURI / contractURI) 解出图片
async function imageFromUri(uri) {
  if (!uri) return null;
  uri = ipfs(uri.trim());
  // 直接就是图片
  if (/^data:image\//.test(uri)) return uri;
  if (/\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(uri)) return uri;
  let meta = null;
  try {
    if (uri.startsWith("data:application/json") || uri.startsWith("data:text/plain")) {
      const b64 = uri.split(",")[1] || "";
      meta = JSON.parse(uri.includes("base64") ? atob(b64) : decodeURIComponent(b64));
    } else if (/^https?:/.test(uri)) {
      const signal = AbortSignal.timeout ? AbortSignal.timeout(7000) : undefined;
      const res = await fetch(uri, { signal });
      if (!res.ok) return null;
      meta = await res.json();
    } else return null;
  } catch { return null; }
  // 优先 image, 其次 image_url, 其次内联 SVG (image_data). 图片 URL 用快网关。
  const img = meta?.image || meta?.image_url;
  if (img) return ipfs(img, true);
  if (meta?.image_data) {
    const svg = meta.image_data.trim();
    return svg.startsWith("<svg") ? "data:image/svg+xml;utf8," + encodeURIComponent(svg) : ipfs(svg, true);
  }
  return null;
}
export async function fetchImage(rpc, contract, tokenId = 1, std = 721) {
  try {
    const sel = uriSel(std);
    // ① uri(tokenId)/tokenURI(tokenId) → 图 (1155 需替换 {id})
    const idHex = BigInt(tokenId).toString(16).padStart(64, "0");
    const uri1 = subId(decodeString(await ethCall(rpc, contract, sel + idHex).catch(() => null)), tokenId);
    let img = await imageFromUri(uri1);
    if (img) return img;
    // ② uri(0)/tokenURI(0) 兜底 (有些集合从 0 起)
    if (tokenId === 1) {
      const uri0 = subId(decodeString(await ethCall(rpc, contract, sel + "".padStart(64, "0")).catch(() => null)), 0);
      img = await imageFromUri(uri0);
      if (img) return img;
    }
    // ③ 若 std 不确定, 反向再试另一种选择器
    const altSel = std === 1155 ? SEL.tokenURI : SEL.uri1155;
    const uriAlt = subId(decodeString(await ethCall(rpc, contract, altSel + idHex).catch(() => null)), tokenId);
    img = await imageFromUri(uriAlt);
    if (img) return img;
    // ④ contractURI → 集合封面图 (作为项目缩略图)
    const cUri = decodeString(await ethCall(rpc, contract, "0xe8a3d485").catch(() => null)); // contractURI()
    img = await imageFromUri(cUri);
    if (img) return img;
    return null;
  } catch { return null; }
}

// 取单个 tokenId 的 metadata (image + name) — 详情页"最新 mint"画廊用
export async function fetchTokenMeta(rpc, contract, tokenId, std = 721) {
  try {
    const idHex = BigInt(tokenId).toString(16).padStart(64, "0");
    const raw = decodeString(await ethCall(rpc, contract, uriSel(std) + idHex).catch(() => null));
    const uri = subId(raw, tokenId);
    if (!uri) return { tokenId, image: null, name: null };
    let u = ipfs(uri.trim()), meta = null;
    try {
      if (u.startsWith("data:application/json") || u.startsWith("data:text/plain")) {
        const b64 = u.split(",")[1] || "";
        meta = JSON.parse(u.includes("base64") ? atob(b64) : decodeURIComponent(b64));
      } else if (/^https?:/.test(u)) {
        const signal = AbortSignal.timeout ? AbortSignal.timeout(7000) : undefined;
        const res = await fetch(u, { signal }); if (res.ok) meta = await res.json();
      }
    } catch {}
    const image = await imageFromUri(uri);
    // 动图/视频: 优先 animation_url, 否则看 image 本身是不是 gif/webp/mp4
    let anim = null, animType = null;
    const rawAnim = meta?.animation_url || meta?.animationUrl;
    if (rawAnim) { anim = ipfs(rawAnim.trim()); animType = mediaType(anim); }
    else if (image && /\.(gif|webp|mp4|webm)(\?|$)/i.test(image)) { anim = image; animType = mediaType(image); }
    return { tokenId, image, name: meta?.name || null, anim, animType };
  } catch { return { tokenId, image: null, name: null }; }
}

// 依 URL 后缀判媒体类型 (决定用 img 还是 video)
function mediaType(url) {
  if (!url) return null;
  if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) return "video";
  if (/\.(gif|webp|apng)(\?|$)/i.test(url)) return "img";     // 动图, img 能直接放
  if (/\.(png|jpe?g|svg|avif)(\?|$)/i.test(url)) return "img"; // 静态图
  if (/\.(html?|glb|gltf)(\?|$)/i.test(url)) return "iframe";  // HTML/3D — 用 iframe (谨慎)
  return "img";   // 未知后缀 (IPFS 无扩展名) → 当图片试
}

// 批量取最新 N 个 mint 的 NFT (并发限量)
export async function fetchLatestMints(rpc, contract, tokenIds, cap = 8, std = 721) {
  const ids = tokenIds.slice(0, cap);
  const out = [];
  for (let i = 0; i < ids.length; i += 4) {
    const slice = ids.slice(i, i + 4);
    const r = await Promise.all(slice.map(id => fetchTokenMeta(rpc, contract, id, std)));
    out.push(...r);
  }
  return out.filter(x => x.image || x.anim);   // 留有图或有动画的
}

// max supply 的常见选择器 (不同合约命名不同)
const MAX_SUPPLY_SELS = [
  "0xd5abeb01",   // maxSupply()
  "0x32cb6b0c",   // MAX_SUPPLY()
  "0x70a08231",   // (占位, 会被过滤) — 实际下面几个
  "0x362a95df",   // maxTotalSupply()
  "0xa2309ff8",   // totalMinted() — 有些当上限, 谨慎
  "0x9a4af1c6",   // collectionSize()
];
// 只用明确的上限选择器 (排除易混淆的)
const MAX_SELS = ["0xd5abeb01", "0x32cb6b0c", "0x362a95df", "0x9a4af1c6", "0x24a7c4fc"];
async function readMaxSupply(rpc, contract) {
  for (const sel of MAX_SELS) {
    // 每个选择器试 2 次 (RPC 抽风时重试) — max supply 重要, 值得多问一次
    for (let i = 0; i < 2; i++) {
      try {
        const v = decodeUint(await ethCall(rpc, contract, sel));
        if (v != null && v > 0 && v < 1e12) return v;   // 合理上限值 → 命中即返回
        break;   // 读到但不是有效值 (0/超大) → 换下个选择器, 不重试这个
      } catch {}   // 抛错 (RPC失败) → 重试同选择器
    }
  }
  return null;
}

// 带重试的 eth_call (RPC 抽风时单字段独立重试, 减少"读一半失败")
async function callRetry(rpc, contract, sel, decode, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try { const v = decode(await ethCall(rpc, contract, sel)); if (v != null) return v; }
    catch {}
  }
  return null;
}
// OpenSea API: 合约 → collection slug → 社交/官网/图/描述。需用户提供免费 key。
//   端点: /api/v2/chain/ethereum/contract/{addr} → collection; /api/v2/collections/{slug}
export async function fetchOpenSea(contract, apiKey) {
  if (!apiKey) return null;
  const H = { accept: "application/json", "x-api-key": apiKey };
  const to = () => (AbortSignal.timeout ? AbortSignal.timeout(9000) : undefined);
  try {
    // ① 合约 → collection slug
    const r1 = await fetch(`https://api.opensea.io/api/v2/chain/ethereum/contract/${contract.toLowerCase()}`, { headers: H, signal: to() });
    if (!r1.ok) return { error: r1.status === 401 ? "bad-key" : "http-" + r1.status };
    const c = await r1.json();
    const slug = c.collection;
    if (!slug) return null;
    // ② collection 详情 (社交)
    const r2 = await fetch(`https://api.opensea.io/api/v2/collections/${slug}`, { headers: H, signal: to() });
    if (!r2.ok) return null;
    const col = await r2.json();
    const tw = col.twitter_username ? "https://x.com/" + col.twitter_username : null;
    const dc = col.discord_url || null;
    const site = col.project_url || null;
    if (!tw && !dc && !site) return { source: "opensea", name: col.name, slug };
    return {
      source: "opensea", name: col.name || null, slug,
      twitter: tw, site, discord: dc,
      image: col.image_url || null,
      description: (col.description || "").slice(0, 300) || null,
      verified: col.safelist_status === "verified" || col.safelist_status === "approved",
    };
  } catch { return null; }
}

// 抓项目社交/官网。① OpenSea API (若用户填了 key, 命中率高含新项目) ② 链上 contractURI 兜底。
export async function fetchSocials(rpc, contract, openseaKey) {
  // ① OpenSea (需 key)
  if (openseaKey) {
    const os = await fetchOpenSea(contract, openseaKey);
    if (os && !os.error && (os.twitter || os.site || os.discord)) return os;
    if (os?.error === "bad-key") return { error: "bad-key" };
  }
  // ② 链上 contractURI 兜底
  try {
    const cUri = decodeString(await ethCall(rpc, contract, "0xe8a3d485").catch(() => null));
    if (!cUri) return null;
    const meta = await fetchJson(ipfs(cUri));
    if (!meta) return null;
    let twitter = (meta.twitter || meta.twitter_username || meta.x || "").trim();
    if (twitter && !/^https?:/.test(twitter)) twitter = "https://x.com/" + twitter.replace(/^@/, "");
    const site = (meta.external_link || meta.external_url || meta.website || "").trim();
    let discord = (meta.discord || meta.discord_url || "").trim();
    if (discord && !/^https?:/.test(discord)) discord = "https://discord.gg/" + discord.replace(/^.*discord\.gg\//, "");
    if (!twitter && !site && !discord) return null;
    return { source: "onchain", twitter: twitter || null, site: site || null, discord: discord || null, name: meta.name || null };
  } catch { return null; }
}

export async function readNftMeta(rpc, contract, std = 721) {
  const [name, symbol, total, max] = await Promise.all([
    callRetry(rpc, contract, SEL.name, decodeString),
    callRetry(rpc, contract, SEL.symbol, decodeString),
    callRetry(rpc, contract, SEL.totalSupply, decodeUint),
    readMaxSupply(rpc, contract),
  ]);
  // ERC1155 常无 name/symbol/totalSupply — 从 collection metadata (contractURI) 兜底取名字
  if (std === 1155) {
    let n = name;
    if (n == null) {
      try {
        const cUri = decodeString(await ethCall(rpc, contract, "0xe8a3d485").catch(() => null));
        if (cUri) { const m = await fetchJson(ipfs(cUri)); n = m?.name || null; }
      } catch {}
    }
    return { name: n, symbol, totalSupply: total, maxSupply: max, std: 1155 };
  }
  // ERC721: 至少要有 name 或 totalSupply 才算是真 NFT (排除随机合约)
  if (name == null && total == null) return null;
  return { name, symbol, totalSupply: total, maxSupply: max, std: 721 };
}

// 小工具: 拉一个 json uri (data:/http/ipfs)
async function fetchJson(uri) {
  if (!uri) return null;
  uri = ipfs(uri.trim());
  try {
    if (uri.startsWith("data:")) {
      const b64 = uri.split(",")[1] || "";
      return JSON.parse(uri.includes("base64") ? atob(b64) : decodeURIComponent(b64));
    }
    if (/^https?:/.test(uri)) {
      const signal = AbortSignal.timeout ? AbortSignal.timeout(7000) : undefined;
      const res = await fetch(uri, { signal });
      if (res.ok) return await res.json();
    }
  } catch {}
  return null;
}

// ── mint sim (eth_call) ──
//   试一批常见公开 mint 函数, 把接收/mint 地址替换成用户地址, 看哪个不 revert。
//   返回 { mintable, method, needsValue, guess, tried, note }
const addr32 = a => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const uint32 = n => BigInt(n).toString(16).padStart(64, "0");

// 候选公开 mint 函数 (selector + 参数构造器(user,qty) + 说明)
const MINT_CANDIDATES = [
  { sel: "0x1249c58b", name: "mint()", data: () => "0x1249c58b", qty: false },
  { sel: "0xa0712d68", name: "mint(uint256)", data: (u, q) => "0xa0712d68" + uint32(q), qty: true },
  { sel: "0x40c10f19", name: "mint(address,uint256)", data: (u, q) => "0x40c10f19" + addr32(u) + uint32(q), qty: true },
  { sel: "0x6a627842", name: "mint(address)", data: (u) => "0x6a627842" + addr32(u), qty: false },
  { sel: "0xefef39a1", name: "purchase(uint256)", data: (u, q) => "0xefef39a1" + uint32(q), qty: true },
  { sel: "0xa723533e", name: "mintPublic(uint256)", data: (u, q) => "0xa723533e" + uint32(q), qty: true },
  { sel: "0xd85d3d27", name: "mintNFT(uint256)", data: (u, q) => "0xd85d3d27" + uint32(q), qty: true },
];

// 单× eth_call sim; 返回 {ok, revert}
async function simCall(rpc, from, to, data, valueWei) {
  try {
    await rpcCall(rpc, "eth_call", [{ from, to, data, value: valueWei ? "0x" + valueWei.toString(16) : "0x0" }, "latest"]);
    return { ok: true };
  } catch (e) {
    return { ok: false, revert: (e.message || "").slice(0, 120) };
  }
}

// 重放一笔真实成功的 mint tx: 把 calldata 里"原始 minter 地址"换成用户地址, 再 eth_call。
//   最稳 — 不用猜函数, 直接复用真实项目方的 mint 调用格式。sample={to, input, from}。
async function replayMint(rpc, user, sample) {
  if (!sample?.input || sample.input.length < 10) return null;
  const from = (sample.from || "").toLowerCase().replace(/^0x/, "");
  const u = user.toLowerCase().replace(/^0x/, "");
  let data = sample.input;
  // 把 calldata 里出现的原发送者地址 (右对齐 32 字节) 全换成用户地址
  if (from && from.length === 40) {
    const fromWord = from.padStart(64, "0");
    const userWord = u.padStart(64, "0");
    data = data.split(fromWord).join(userWord);
  }
  // 原 tx 付的 value (拿真实价格)
  let val = 0n; try { val = BigInt(sample.value || "0x0"); } catch {}
  const r = await simCall(rpc, user, sample.to, data, val);
  if (r.ok) {
    const priceEth = Number(val) / 1e18;
    return { mintable: true, method: "replay (observed mint tx)", needsValue: val > 0n, unitPriceEth: priceEth, tried: [],
      note: val > 0n ? `replaying real mint tx works (~ ${priceEth} Ξ)` : "replaying real mint tx works (free)" };
  }
  return { mintable: false, revert: r.revert };
}

/**
 * 模拟能否 mint。user=接收/发起地址, priceWei=每个价格, isSeaDrop=是否走 SeaDrop 合约。
 *   优先"重放真实 mint tx (换成用户地址)"; 失败再退候选函数/SeaDrop 路径。
 *   sample = { to, input, from, value } 来自一笔观测到的成功 mint tx。
 */
export async function simulateMint(rpc, contract, user, priceWei = 0n, qty = 1, isSeaDrop = false, sample = null) {
  const tried = [];
  const q = BigInt(qty);

  // ── ① 重放真实 mint tx (换成用户地址) — 最稳, 适配任意合约 ──
  if (sample) {
    const rp = await replayMint(rpc, user, sample);
    if (rp?.mintable) return { ...rp, priceReplay: true };
    if (rp?.revert) tried.push({ m: "replay", r: rp.revert });
  }
  // 价格优先级: ① 真实侦测价(SeaDrop/观测众数) ② 免费 ③ 少量常见价兜底(仅当没侦测到价时)
  const detected = priceWei > 0n ? [priceWei] : [];
  const fallback = priceWei > 0n ? [] :   // 侦测到价就不猜; 没侦测到才试少量常见价
    ["1000000000000000", "5000000000000000", "690000000000000"].map(BigInt);
  const prices = [...detected, 0n, ...fallback];
  const uniqPrices = [...new Set(prices.map(p => p.toString()))].map(BigInt);

  // ── SeaDrop 路径: 调 SeaDrop 合约的 mintPublic(nft, feeRecipient, minter, qty) ──
  //   feeRecipient 用零地址 (creatorPayoutAddress 会自动路由), minterIfNotPayer=user。
  if (isSeaDrop) {
    const ZERO = "0".repeat(64);
    // mintPublic(address,address,address,uint256) = 0x161ac21f
    const dataSD = "0x161ac21f" + addr32(contract) + ZERO + addr32(user) + uint32(qty);
    for (const unit of uniqPrices) {
      const val = unit * q;
      const r = await simCall(rpc, user, SEADROP_V1, dataSD, val);
      if (r.ok) {
        const priceEth = Number(unit) / 1e18;
        return { mintable: true, method: "SeaDrop.mintPublic", needsValue: unit > 0n, unitPriceEth: priceEth, tried,
          note: unit > 0n ? `SeaDrop public mint works (~ ${priceEth} Ξ each)` : "SeaDrop free public mint works" };
      }
      if (unit === (uniqPrices[0])) tried.push({ m: "SeaDrop.mintPublic", r: r.revert || "revert" });
    }
    // SeaDrop 失败 → 给出针对性诊断, 不再去试普通合约候选 (那些对 SeaDrop 无意义)
    const revsSD = tried.map(t => (t.r || "").toLowerCase()).join(" ");
    let noteSD = "SeaDrop mint reverted";
    if (/not.*active|inactive|before.*start|after.*end|NotActive/i.test(revsSD)) noteSD = "SeaDrop sale not live (timing)";
    else if (/allow|MintQuantityExceeds|exceed|max/i.test(revsSD)) noteSD = "over per-wallet / supply limit";
    else if (/payment|IncorrectPayment|value/i.test(revsSD)) noteSD = "payment mismatch — price may have changed";
    return { mintable: false, method: null, needsValue: null, tried, note: noteSD };
  }

  for (const c of MINT_CANDIDATES) {
    const data = c.data(user, qty);
    let hit = null;
    for (const unit of uniqPrices) {
      const val = unit * q;
      const r = await simCall(rpc, user, contract, data, val);
      if (r.ok) { hit = { unit, val }; break; }
      // 记第一个 revert 原因即可 (免费那×)
      if (unit === 0n) tried.push({ m: c.name, r: r.revert || "revert" });
    }
    if (hit) {
      const priceEth = Number(hit.unit) / 1e18;
      return {
        mintable: true, method: c.name, needsValue: hit.unit > 0n,
        unitPriceEth: priceEth, tried,
        note: hit.unit > 0n ? `paid mint works (~ ${priceEth} Ξ)` : "free public mint works",
      };
    }
  }
  const revs = tried.map(t => (t.r || "").toLowerCase()).join(" ");
  let note = "no directly-callable public mint fn";
  if (/allow|whitelist|merkle|proof|signature|signer|not.*eligible/.test(revs)) note = "may need allowlist / signature";
  else if (/not.*active|not.*started|closed|paused|sale.*not/.test(revs)) note = "public sale not live / paused";
  else if (/max|exceed|limit|sold.?out/.test(revs)) note = "over limit (sold out or per-wallet cap)";
  else if (/insufficient|value|price|payment/.test(revs)) note = "price mismatch (tried common prices)";
  return { mintable: false, method: null, needsValue: null, tried, note };
}

// 已知 mint 函数选择器 → 完整签名 (含参数类型, 供解码 input)。
const MINT_FN = {
  "0xa0712d68": "mint(uint256)",
  "0x1249c58b": "mint()",
  "0x40c10f19": "mint(address,uint256)",
  "0x6a627842": "mint(address)",
  "0xefef39a1": "purchase(uint256)",
  "0xa723533e": "mintPublic(uint256)",
  "0xd85d3d27": "mintNFT(uint256)",
  "0x2db11544": "mint(uint256)",
  "0xf14fcbc8": "commit(bytes32)",
  "0x00000000": "0-eth transfer",
  // ── OpenSea SeaDrop (调 SeaDrop 合约, 首参恒为 nftContract) ──
  "0x161ac21f": "mintPublic(address,address,address,uint256)",
  "0x84bb1e42": "mintPublic(address,address,uint256,uint256)",
  "0x4b61cd6f": "mintAllowList(address,address,address,uint256,tuple,bytes)",
  "0xcd6e13f7": "mintSigned(address,address,address,uint256,tuple,uint256,bytes)",
  "0x9b4f3af5": "mintAllowedTokenHolder(address,address,address,tuple)",
  // ── 常见 launchpad ──
  "0x94bf804d": "mint(uint256,address)",
  "0xfa54cf1b": "mintTo(address,uint256)",
  "0xf2c298be": "register(string)",
};
// 参数名 (像 Etherscan 一样显示 nftContract/quantity 等, 而非只有类型)
const MINT_PARAM_NAMES = {
  "0xa0712d68": ["quantity"],
  "0x40c10f19": ["to", "amount"],
  "0x6a627842": ["to"],
  "0xefef39a1": ["quantity"],
  "0xa723533e": ["quantity"],
  "0xd85d3d27": ["quantity"],
  "0x2db11544": ["quantity"],
  "0x161ac21f": ["nftContract", "feeRecipient", "minterIfNotPayer", "quantity"],
  "0x84bb1e42": ["nftContract", "feeRecipient", "quantity", "dropStageIndex"],
  "0x4b61cd6f": ["nftContract", "feeRecipient", "minterIfNotPayer", "quantity", "mintParams", "proof"],
  "0xcd6e13f7": ["nftContract", "feeRecipient", "minterIfNotPayer", "quantity", "mintParams", "salt", "signature"],
  "0x9b4f3af5": ["nftContract", "feeRecipient", "minterIfNotPayer", "tokenGatedMintParams"],
  "0x94bf804d": ["quantity", "to"],
  "0xfa54cf1b": ["to", "quantity"],
};
// 拆签名成 { name, types[] }
function parseSig(sig) {
  const m = /^([a-zA-Z0-9_]+)\((.*)\)$/.exec(sig);
  if (!m) return { name: sig, types: [] };
  const inner = m[2].trim();
  const types = inner ? splitTopLevel(inner) : [];
  return { name: m[1], types };
}
// 按顶层逗号拆 (忽略 tuple 括号内)
function splitTopLevel(s) {
  const out = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++; if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const fnName = sel => { const s = MINT_FN[sel]; return s ? parseSig(s).name : sel; };

// 解码 calldata (静态头部字, 不深入 tuple/动态). 返回 [{type, value}]。
export function decodeCalldata(input, sig) {
  if (!input || input.length < 10) return null;
  const sel = input.slice(0, 10);
  const known = sig || MINT_FN[sel];
  const body = input.slice(10);
  const wordAt = i => body.slice(i * 64, (i + 1) * 64);
  const nWords = Math.floor(body.length / 64);
  const fmt = (type, w) => {
    if (!w) return "—";
    if (type === "address") return "0x" + w.slice(24);
    if (/^uint|^int/.test(type)) { try { return BigInt("0x" + w).toString(); } catch { return "0x" + w; } }
    if (type === "bool") return BigInt("0x" + w) ? "true" : "false";
    if (type === "bytes32") return "0x" + w;
    return "0x" + w;   // tuple/bytes/dynamic → 原始字 (offset)
  };
  if (known) {
    const { name, types } = parseSig(known);
    const pnames = MINT_PARAM_NAMES[sel] || [];
    const params = types.map((t, i) => ({ name: pnames[i] || `arg${i}`, type: t, value: fmt(t, wordAt(i)) }));
    return { selector: sel, name, params, rawWords: nWords };
  }
  // 未知签名: 只给原始字 (让用户自己看)
  const params = [];
  for (let i = 0; i < Math.min(nWords, 8); i++) params.push({ name: `word${i}`, type: "bytes32", value: "0x" + wordAt(i) });
  return { selector: sel, name: null, params, rawWords: nWords };
}

// 各 mint 函数里 quantity 参数的位置 (第几个 32字节字, 从0起)
const QTY_ARG_INDEX = {
  "0xa0712d68": 0,   // mint(uint256 qty)
  "0xefef39a1": 0,   // purchase(uint256)
  "0xa723533e": 0,   // mintPublic(uint256)
  "0xd85d3d27": 0,   // mintNFT(uint256)
  "0x2db11544": 0,
  "0x40c10f19": 1,   // mint(address,uint256)
  "0x161ac21f": 3,   // SeaDrop mintPublic(nft,fee,minter,qty)
  "0x84bb1e42": 2,   // mintPublic 变体(nft,fee,qty,idx)
  "0x4b61cd6f": 3,   // mintAllowList(...,qty,...)
  "0xcd6e13f7": 3,   // mintSigned(...,qty,...)
  "0x94bf804d": 0,   // mint(uint256,address)
  "0xfa54cf1b": 1,   // mintTo(address,uint256)
};
// 从 mint tx 的 calldata 解出 quantity (数量) — 用于精确算单价
function mintQtyFromCalldata(input, sel) {
  const idx = QTY_ARG_INDEX[sel];
  if (idx == null || !input || input.length < 10 + 64 * (idx + 1)) return null;
  try {
    const word = input.slice(10 + idx * 64, 10 + (idx + 1) * 64);
    const q = Number(BigInt("0x" + word));
    return q > 0 && q < 100000 ? q : null;   // 合理数量
  } catch { return null; }
}

// 批量分析: 查 recentTxs 的 (input选择器 / value / gas), 聚合 mint 方式 + 真实单价 + 成本。
//   txMintCount: Map<txHash, 该tx铸了几个token> (来自 scanner), 用来算真实单价 = value/铸数。
export async function analyzeMints(rpc, txHashes, txMintCount = null, cap = 60) {
  const hashes = txHashes.slice(-cap);
  if (!hashes.length) return null;
  const methods = new Map();
  let costSum = 0n, costN = 0, gasSum = 0n, gasN = 0, gasFeeSum = 0n, gasFeeN = 0;
  let resolved = 0, failed = 0;   // 实际拿到 tx 数 / 拉取失败数
  const unitPrices = [];   // 每笔的真实单价 (wei) = value / 该tx铸数
  const batch = 6;
  for (let i = 0; i < hashes.length; i += batch) {
    const slice = hashes.slice(i, i + batch);
    // 每笔失败重试 1 次 (换节点), 减少"全靠一次 RPC 抽风就空表"
    const results = await Promise.all(slice.map(async h => {
      for (let a = 0; a < 2; a++) {
        try { const tx = await rpcCall(rpc, "eth_getTransactionByHash", [h]); if (tx) return { h, tx }; }
        catch {}
      }
      return { h, tx: null };
    }));
    for (const { h, tx } of results) {
      if (!tx) { failed++; continue; }
      resolved++;
      const sel = (tx.input || "0x").slice(0, 10);
      let m = methods.get(sel);
      if (!m) { m = { sel, name: fnName(sel), sig: MINT_FN[sel] || null, tx: 0, addrs: new Set(), sampleInput: tx.input || null, sampleTx: h }; methods.set(sel, m); }
      m.tx++; m.addrs.add((tx.from || "").toLowerCase());
      try {
        const v = BigInt(tx.value || "0x0");
        costSum += v; costN++;
        // 真实单价 = value ÷ 数量。数量优先从 calldata 的 quantity 参数解 (最准),
        //   解不出再退回 scanner 数的 Transfer 数 (txMintCount)。
        const qty = mintQtyFromCalldata(tx.input, sel) || txMintCount?.get(h) || 1;
        if (v > 0n && qty > 0) unitPrices.push(v / BigInt(qty));
        else unitPrices.push(0n);
      } catch {}
      try {
        const gasLimit = BigInt(tx.gas || "0x0");
        gasSum += gasLimit; gasN++;
        // gas 花费上限估算: gasLimit × (effective gas price)。EIP-1559 用 maxFeePerGas, 否则 gasPrice。
        const gp = BigInt(tx.gasPrice || tx.maxFeePerGas || "0x0");
        if (gp > 0n) { gasFeeSum += gasLimit * gp; gasFeeN++; }
      } catch {}
    }
  }
  const toEth = w => Number(w) / 1e18;
  // 众数单价 (最常见的那个真实单价 = 公售价)
  let modalUnit = null;
  if (unitPrices.length) {
    const cnt = new Map();
    for (const u of unitPrices) { const k = u.toString(); cnt.set(k, (cnt.get(k) || 0) + 1); }
    const top = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0];
    modalUnit = BigInt(top[0]);
  }
  const methodArr = [...methods.values()].map(m => ({ name: m.name, sel: m.sel, sig: m.sig, tx: m.tx, addrs: m.addrs.size, sampleInput: m.sampleInput, sampleTx: m.sampleTx }))
    .sort((a, b) => b.tx - a.tx);
  // 单笔 tx 最大 mint 数 (观测到的上限, 反映每 tx 铸造限制)
  let maxPerTx = null;
  if (txMintCount && txMintCount.size) { let mx = 0; for (const c of txMintCount.values()) if (c > mx) mx = c; maxPerTx = mx || null; }
  return {
    sampled: resolved,          // 实际成功拉到的 tx 数 (不是尝试数)
    attempted: hashes.length,
    failed,                     // 拉取失败数 (RPC 抽风)
    complete: failed === 0 && resolved > 0,   // 是否完整 (供 caller 决定要不要重试)
    methods: methodArr,
    maxPerTx,
    avgCostEth: costN ? toEth(costSum / BigInt(costN)) : null,   // 平均每笔 tx 付的 ETH (mint 价, 不含 gas)
    totalCostEth: toEth(costSum),                                // 采样 tx 的 mint 花费总和
    avgGas: gasN ? Number(gasSum / BigInt(gasN)) : null,         // 平均 gas limit
    avgGasFeeEth: gasFeeN ? toEth(gasFeeSum / BigInt(gasFeeN)) : null,   // 平均每 tx gas 花费上限
    sampledGasFeeEth: toEth(gasFeeSum),                          // 采样 tx 的 gas 花费总和 (上限估算)
    unitPriceWei: modalUnit,                                     // 真实公售单价 (众数)
    unitPriceEth: modalUnit != null ? toEth(modalUnit) : null,
  };
}

// ── 首选: etherscan getcontractcreation (一次请求给 creator + 部署 tx, 对工厂/CREATE2 也准) ──
//   需用户免费 etherscan API key。CORS=* → 浏览器直调, 零后端。拿到后再用部署 tx 查块时间戳。
//   返回 { archive:true, deployBlock, deployTs, dev } 与二分版同结构; 失败返回 null → 上层回退二分。
export async function fetchDeployViaEtherscan(rpc, contract, apiKey) {
  if (!apiKey) return null;
  try {
    const url = `https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getcontractcreation&contractaddresses=${contract}&apikey=${apiKey}`;
    const res = await fetch(url);
    const j = await res.json();
    if (j.status !== "1" || !Array.isArray(j.result) || !j.result[0]) return null;
    const row = j.result[0];
    const dev = (row.contractCreator || "").toLowerCase() || null;
    // 部署块: etherscan 有时直接给 blockNumber; 没有就用 txHash 查 receipt 拿块号
    let deployBlock = row.blockNumber ? parseInt(row.blockNumber, 10) : null;
    let deployTs = null;
    try {
      if (!deployBlock && row.txHash) {
        const rc = await rpcCall(rpc, "eth_getTransactionReceipt", [row.txHash]);
        if (rc?.blockNumber) deployBlock = parseInt(rc.blockNumber, 16);
      }
      if (deployBlock != null) {
        const blk = await rpcCall(rpc, "eth_getBlockByNumber", ["0x" + deployBlock.toString(16), false]);
        if (blk?.timestamp) deployTs = parseInt(blk.timestamp, 16);
      }
    } catch {}
    if (!dev && deployBlock == null) return null;
    return { archive: true, deployBlock, deployTs, dev, src: "etherscan" };
  } catch { return null; }
}

// 合约deployed: 二分找 code 从空→非空的块, 取该块时间戳。
//   ~log2(块高)≈25 ×请求, 所以只对选中项调 (懒加载)。
//   ⚠ 需要 archive 节点 (能查历史块 code); 免费公共节点常返回 archive 错误 → 返回 {archive:false}。
export async function fetchDeployInfo(rpc, contract) {
  try {
    const head = parseInt(await rpcCall(rpc, "eth_blockNumber", []), 16);
    const has = async (blk) => {
      const code = await rpcCall(rpc, "eth_getCode", [contract, "0x" + blk.toString(16)]);
      return code && code !== "0x";
    };
    // 先探一个历史块 (head 的一半), 若报 archive 错 → 直接降级
    try { await has(Math.floor(head / 2)); }
    catch (e) {
      if (/archive|personal token|not available|state.*unavailable/i.test(e.message)) return { archive: false };
      throw e;
    }
    if (!(await has(head))) return null;   // 当前无 code = 非合约
    let lo = 0, hi = head;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (await has(mid)) hi = mid; else lo = mid + 1;
    }
    const block = await rpcCall(rpc, "eth_getBlockByNumber", ["0x" + lo.toString(16), true]);
    if (!block) return null;
    const c = contract.toLowerCase();
    // 找创建该合约的 tx → dev 地址。
    //   ① 直接创建 (tx.to==null 且 creates=合约): from = dev
    //   ② 工厂创建 (tx.to=工厂): 查该块每笔 tx 的 receipt.contractAddress 匹配我们的合约
    let dev = null, createTxTo = null;
    try {
      for (const tx of block.transactions || []) {
        if ((tx.to == null || tx.to === "0x") && (tx.creates || "").toLowerCase() === c) { dev = tx.from?.toLowerCase() || null; break; }
      }
      // 直接创建没找到 → 逐笔查 receipt (工厂部署). 限量避免太慢。
      if (!dev) {
        const cand = (block.transactions || []).slice(0, 40);
        for (const tx of cand) {
          try {
            const rc = await rpcCall(rpc, "eth_getTransactionReceipt", [tx.hash]);
            if (rc && (rc.contractAddress || "").toLowerCase() === c) { dev = tx.from?.toLowerCase() || null; createTxTo = tx.to?.toLowerCase() || null; break; }
          } catch {}
        }
      }
      // 仍没有 → 退回该块第一个 to==null 的 tx.from (近似)
      if (!dev) { const t0 = (block.transactions || []).find(x => x.to == null); if (t0) dev = t0.from?.toLowerCase() || null; }
    } catch {}
    return { archive: true, deployBlock: lo, deployTs: parseInt(block.timestamp, 16), dev, factory: createTxTo };
  } catch { return null; }
}

// ── 链上真实 holder 采样 ──
//   ERC721 没有 "holder 数" 的直接方法, 但可采样 ownerOf(tokenId) 统计当前持有分布。
//   对最新 + 均匀采样的 tokenId 查 ownerOf, 得到"每地址持有数"分布 + 去重 holder 数。
const SEL_OWNER_OF = "0x6352211e";   // ownerOf(uint256)
const SEL_BALANCE_OF = "0x70a08231";  // balanceOf(address)
const uint32e = n => BigInt(n).toString(16).padStart(64, "0");

export async function fetchHolderStats(rpc, contract, totalSupply, sampleSize = 60) {
  try {
    const total = Number(totalSupply) || 0;
    if (total <= 0) return null;
    // 采样 tokenId: 均匀分布 + 最新一批
    const n = Math.min(sampleSize, total);
    const ids = new Set();
    const step = Math.max(1, Math.floor(total / n));
    for (let i = 1; i <= total && ids.size < n; i += step) ids.add(i);
    for (let i = total; i > total - 8 && i >= 1 && ids.size < n + 8; i--) ids.add(i);
    const idArr = [...ids];
    // ① 采样 ownerOf → 去重出现过的地址
    const seenOwners = new Set();
    let ok = 0;
    const batch = 8;
    for (let i = 0; i < idArr.length; i += batch) {
      const slice = idArr.slice(i, i + batch);
      const res = await Promise.all(slice.map(async id => {
        try { const r = await ethCall(rpc, contract, SEL_OWNER_OF + uint32e(id)); if (r && r.length >= 66) return "0x" + r.slice(-40); } catch {}
        return null;
      }));
      for (const o of res) { if (o && /^0x[0-9a-f]{40}$/i.test(o) && !/^0x0+$/i.test(o)) { seenOwners.add(o.toLowerCase()); ok++; } }
    }
    if (ok === 0 || seenOwners.size === 0) return null;
    // ② 对每个去重地址查真实 balanceOf → 每 holder 真实持有数 (准确, 不靠采样计数)
    const owners = [...seenOwners];
    const balances = new Map();
    for (let i = 0; i < owners.length; i += batch) {
      const slice = owners.slice(i, i + batch);
      const res = await Promise.all(slice.map(async addr => {
        try { const r = await ethCall(rpc, contract, SEL_BALANCE_OF + addr.replace(/^0x/, "").padStart(64, "0")); if (r) return Number(BigInt(r)); } catch {}
        return null;
      }));
      slice.forEach((addr, k) => { if (res[k] != null && res[k] > 0) balances.set(addr, res[k]); });
    }
    if (!balances.size) return null;
    const counts = [...balances.values()];   // 每 holder 的真实持有数 (链上准确)
    const uniqueSampled = balances.size;
    const dedupRatio = uniqueSampled / ok;
    const estHolders = Math.round(dedupRatio * total);
    // 分布桶 (真实 balanceOf)
    const buckets = { "1": 0, "2-3": 0, "4-10": 0, "10+": 0 };
    for (const c of counts) { if (c === 1) buckets["1"]++; else if (c <= 3) buckets["2-3"]++; else if (c <= 10) buckets["4-10"]++; else buckets["10+"]++; }
    return { sampled: ok, uniqueSampled, estHolders, buckets, total, accurate: true };
  } catch { return null; }
}

// dev 地址年龄: 该地址第一笔交易时间 (nonce 二分 — 需 archive)。降级返回 {archive:false}
export async function fetchAddrAge(rpc, addr) {
  try {
    const head = parseInt(await rpcCall(rpc, "eth_blockNumber", []), 16);
    const nonceAt = async (blk) => parseInt(await rpcCall(rpc, "eth_getTransactionCount", [addr, "0x" + blk.toString(16)]), 16);
    try { await nonceAt(Math.floor(head / 2)); }
    catch (e) { if (/archive|personal token|state/i.test(e.message)) return { archive: false }; throw e; }
    const nowNonce = await nonceAt(head);
    if (nowNonce === 0) return { archive: true, firstTs: null };   // 从没发过 tx (纯接收地址)
    // 二分找 nonce 从 0→1 的块 = 首×发 tx 的块
    let lo = 0, hi = head;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (await nonceAt(mid) >= 1) hi = mid; else lo = mid + 1; }
    const block = await rpcCall(rpc, "eth_getBlockByNumber", ["0x" + lo.toString(16), false]);
    return { archive: true, firstTs: block ? parseInt(block.timestamp, 16) : null };
  } catch { return null; }
}

// ── 下一块 gas 费预测 (仿 Blocknative) ──
//   一次 eth_feeHistory 全拿到:
//   · baseFeePerGas 数组最后一个 = 下一块 base fee (EIP-1559 协议公式算的精确值, 不是猜)
//   · reward 百分位 = 最近块里实际成交的 priority fee 分布 → "付得比 p% 的人多 ≈ p% 概率上链"
//   · gasUsedRatio = 网络拥堵度
export async function fetchGasIntel(rpc) {
  try {
    const f = await rpcCall(rpc, "eth_feeHistory", ["0x5", "latest", [10, 30, 50, 75, 95]]);
    if (!f?.baseFeePerGas?.length) return null;
    const g = x => Number(BigInt(x || "0x0")) / 1e9;   // wei hex → gwei
    const nextBase = g(f.baseFeePerGas.at(-1));
    const congestion = f.gasUsedRatio?.length
      ? f.gasUsedRatio.reduce((a, b) => a + b, 0) / f.gasUsedRatio.length : null;
    // 各百分位在 5 块内取平均 → 平滑掉单块抖动; 百分位→概率的映射与 Blocknative 一致取整
    const PROBS = [70, 80, 90, 95, 99];
    const nTiers = f.reward?.[0]?.length || 0;
    const tiers = [];
    for (let i = 0; i < nTiers; i++) {
      const vals = f.reward.map(r => g(r[i]));
      const priority = vals.reduce((a, b) => a + b, 0) / vals.length;
      // max fee 推荐 = 下块 base × 1.5 + priority (base fee 每块最多 +12.5%, ×1.5 抗 ~3 块连涨)
      tiers.push({ prob: PROBS[i], priority, max: nextBase * 1.5 + priority });
    }
    return { nextBase, congestion, tiers, at: Date.now() };
  } catch { return null; }
}
