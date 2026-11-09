// B 站动态抓取（本插件自带一份，不跨目录 import —— 删掉插件不留残留）。
//
// 骨架（指纹 Cookie / WBI 签名 / 浏览器请求头）照抄自本项目里**已验证可用**的
// skills/bili-share/bili-api.js，那几条实测结论直接沿用：
//   · 搜索类接口无 Cookie 会 412 风控 → 先领 buvid3/buvid4（匿名接口，不用登录）
//   · 空间类接口必须带完整浏览器头（Origin / Sec-Fetch-*），只带 Cookie 会 -352
//   · WBI 签名算法：nav 取 wbi_img → 固定表重排成 32 位 mixin → md5(query + mixin)
//
// 动态接口 /x/polymer/web-dynamic/v1/feed/space 在本项目里是**新用法**（bili-share
// 只用过投稿/搜索接口），所以这里对它做了两条保险：
//   ① 先带 WBI 签名请求，失败再试不带签名的形态（两种都有公开实现在用）；
//   ② 返回值一律做防御式取字段（B 站动态的 JSON 结构嵌套很深，字段缺失很常见），
//      取不到就降级成"[动态]"，绝不抛异常给上层。
import { createHash } from 'node:crypto';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';
const API = 'https://api.bilibili.com';
const LIVE_API = 'https://api.live.bilibili.com';

// B 站接口对"短时间内的连续请求"很敏感（实测：空间类接口间隔 3 秒连打会被限流
// 十分钟以上）。这里给本插件自己的所有请求加一道最小间隔，宁可慢一点。
const MIN_API_GAP_MS = 1200;
let lastApiAt = 0;

async function throttle() {
  const wait = lastApiAt + MIN_API_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastApiAt = Date.now();
}

function apiHeaders(extra = {}) {
  return { 'User-Agent': UA, Referer: REFERER, ...extra };
}

/** 统一的 JSON 请求：网络错误、非 JSON、业务 code≠0 都归一成 {ok:false,...}。 */
async function getJson(url, { headers = {}, timeoutMs = 15000 } = {}) {
  await throttle();
  let res;
  try {
    res = await fetch(url, { headers: apiHeaders(headers), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { ok: false, error: `请求失败：${error?.message ?? error}` };
  }
  const text = await res.text();
  if (res.status !== 200) {
    return { ok: false, error: `HTTP ${res.status}`, status: res.status, raw: text.slice(0, 200) };
  }
  let body;
  try { body = JSON.parse(text); } catch { return { ok: false, error: '返回不是 JSON', raw: text.slice(0, 200) }; }
  if (body?.code !== 0) {
    return { ok: false, error: body?.message || `业务码 ${body?.code}`, code: body?.code };
  }
  return { ok: true, data: body?.data !== undefined ? body.data : body?.result };
}

// ── 指纹 Cookie（buvid3/buvid4）──────────────────────────────────────────

let fingerprint = { cookie: '', at: 0 };
const FP_TTL_MS = 30 * 60 * 1000;

/** 领 buvid3/buvid4 指纹。无需登录，纯匿名接口。失败返回空串（接口会退化成匿名请求）。 */
export async function ensureFingerprint({ timeoutMs = 10000, force = false } = {}) {
  if (!force && fingerprint.cookie && Date.now() - fingerprint.at < FP_TTL_MS) return fingerprint.cookie;
  const r = await getJson(`${API}/x/frontend/finger/spi`, { timeoutMs });
  if (!r.ok) return '';
  const b3 = String(r.data?.b_3 || '').trim();
  const b4 = String(r.data?.b_4 || '').trim();
  fingerprint = {
    cookie: [b3 && `buvid3=${b3}`, b4 && `buvid4=${b4}`].filter(Boolean).join('; '),
    at: Date.now()
  };
  return fingerprint.cookie;
}

// ── WBI 签名 ─────────────────────────────────────────────────────────────

const WBI_MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52
];

let wbiKeyCache = null;
let wbiKeyAt = 0;
const WBI_KEY_TTL_MS = 30 * 60 * 1000;

/** 取（并缓存）wbi mixin。key 会轮换，所以带 TTL。拿不到返回 null。 */
async function ensureWbiMixin({ timeoutMs = 10000, force = false } = {}) {
  if (!force && wbiKeyCache && Date.now() - wbiKeyAt < WBI_KEY_TTL_MS) return wbiKeyCache;
  // ⚠️ 这里不能用 getJson：nav 未登录时 code=-101，getJson 对 code≠0 一律判失败，
  //    会把 wbi_img 一起丢掉 —— 而 wbi_img 与登录态无关，永远都会返回。
  await throttle();
  let body;
  try {
    const res = await fetch(`${API}/x/web-interface/nav`, {
      headers: apiHeaders(),
      signal: AbortSignal.timeout(timeoutMs)
    });
    body = await res.json();
  } catch {
    return null;
  }
  const imgUrl = body?.data?.wbi_img?.img_url || '';
  const subUrl = body?.data?.wbi_img?.sub_url || '';
  const key = (u) => String(u).split('/').pop().split('.')[0];
  const raw = key(imgUrl) + key(subUrl);
  if (raw.length < 64) return null;
  wbiKeyCache = WBI_MIXIN_TABLE.map((i) => raw[i]).join('').slice(0, 32);
  wbiKeyAt = Date.now();
  return wbiKeyCache;
}

/** 给参数签名，返回可直接拼到 URL 后的 query 串；拿不到 key 返回 null。 */
export async function wbiSign(params, opts = {}) {
  const mixin = await ensureWbiMixin(opts);
  if (!mixin) return null;
  const withTs = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(withTs).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(withTs[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  const wRid = createHash('md5').update(query + mixin).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

// ── UP 主：名字 → uid ────────────────────────────────────────────────────

/**
 * 按名字搜索 UP 主，返回 { mid, uname, fans, videos }。
 * 用 search_type=bili_user，免签名（只需指纹 Cookie）。
 */
export async function searchUpUser(name, { timeoutMs = 15000, cookie: userCookie = '' } = {}) {
  const kw = String(name || '').trim();
  if (!kw) return { ok: false, error: 'UP 名字为空' };
  const url = `${API}/x/web-interface/search/type?search_type=bili_user&page=1&keyword=${encodeURIComponent(kw)}`;
  const own = normalizeUserCookie(userCookie);
  let fp = await ensureFingerprint({ timeoutMs });
  let r = await getJson(url, { headers: { Cookie: mergeCookie(own, fp) }, timeoutMs });
  // 412 = 风控：指纹过期或首次没有，重领一次再试
  if (!r.ok && (r.status === 412 || r.code === -412)) {
    fp = await ensureFingerprint({ timeoutMs, force: true });
    r = await getJson(url, { headers: { Cookie: mergeCookie(own, fp) }, timeoutMs });
  }
  if (!r.ok) return { ok: false, error: `搜 UP 失败：${r.error}` };
  const list = Array.isArray(r.data?.result) ? r.data.result : [];
  const users = list.map((u) => ({
    mid: Number(u.mid) || 0,
    uname: String(u.uname || '').replace(/<[^>]+>/g, '').trim(),
    fans: Number(u.fans) || 0,
    videos: Number(u.videos) || 0
  })).filter((u) => u.mid);
  if (!users.length) return { ok: false, error: `没找到叫「${kw}」的 UP 主（可以改用 uid 数字）` };
  return { ok: true, users, best: users[0] };
}

/**
 * 合并两份 Cookie（后者是匿名指纹）。
 * 用于"用户填了 B 站登录凭证"的场景：同名键以**用户给的**为准
 * （用户 Cookie 里通常已经带了 buvid3，不能和指纹的 buvid3 拼成两个）。
 */
function mergeCookie(userCookie, fingerprintCookie) {
  const seen = new Set();
  const out = [];
  for (const part of [userCookie, fingerprintCookie]) {
    for (const piece of String(part || '').split(';')) {
      const kv = piece.trim();
      if (!kv || !kv.includes('=')) continue;
      const k = kv.split('=')[0].trim().toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(kv);
    }
  }
  return out.join('; ');
}

/**
 * 把用户填的登录凭证整形成 Cookie 值。
 * 用户可能把 `SESSDATA=xxx` 或整串 `SESSDATA=xxx; bili_jct=yyy` 粘进来 —— 两种都吃；
 * 只有裸值（没有 = 号）时按 SESSDATA 处理。
 */
export function normalizeUserCookie(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s.includes('=') ? s : `SESSDATA=${s}`;
}

// ── 动态列表 ─────────────────────────────────────────────────────────────

const DYNAMIC_TYPE_LABEL = {
  DYNAMIC_TYPE_AV: '视频',
  DYNAMIC_TYPE_DRAW: '图文',
  DYNAMIC_TYPE_WORD: '文字动态',
  DYNAMIC_TYPE_FORWARD: '转发',
  DYNAMIC_TYPE_ARTICLE: '专栏',
  DYNAMIC_TYPE_MUSIC: '音频',
  DYNAMIC_TYPE_LIVE_RCMD: '直播',
  DYNAMIC_TYPE_OPUS: '图文'
};

/** 动态类型 → 人话标签。 */
export function dynamicTypeLabel(type) {
  return DYNAMIC_TYPE_LABEL[String(type || '')] || '动态';
}

/**
 * 清掉 B 站的**文字表情**标记。
 *
 * 实测：动态正文里常见 `[tv_点赞]` 这种网页播放器表情标记，发到 QQ 会原样显示成
 * 方括号文字，看着很脏。这里只清 `[tv_xxx]` 这个固定前缀（B 站表情的命名空间），
 * **不动**用户自己打的方括号 —— 群里常见的 `[图片]`、`[链接]` 等要保留。
 */
const BILI_FACE_RE = /\[tv_[A-Za-z0-9_\u4e00-\u9fa5]{1,20}\]/g;

function cleanBiliFaces(text) {
  return String(text ?? '').replace(BILI_FACE_RE, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/** 把一条原始动态压成扁平结构（到处都要做防御式取值，所以集中在这里）。 */
export function normDynamic(item) {
  const mods = item?.modules || {};
  const author = mods.module_author || {};
  const dyn = mods.module_dynamic || {};
  const major = dyn.major || {};
  const archive = major.archive || null;
  const article = major.article || null;
  const opus = major.opus || null;
  const draw = major.draw || null;
  const stat = mods.module_stat || {};

  const id = String(item?.id_str || item?.id || '');
  const pubTs = Number(author.pub_ts) || 0;
  // ⚠️ 实测坑：视频动态的 jump_url 是**协议相对**的 `//www.bilibili.com/video/BVxxx`，
  // 原样发到 QQ 里是个点不开的地址（没有协议头）。必须补成 https。
  let url = String(
    archive?.jump_url || article?.jump_url || opus?.jump_url
    || (id ? `https://t.bilibili.com/${id}` : '')
  );
  if (url.startsWith('//')) url = `https:${url}`;
  else if (url.startsWith('/')) url = `https://www.bilibili.com${url}`;
  return {
    id,
    type: String(item?.type || ''),
    label: dynamicTypeLabel(item?.type),
    author: String(author.name || '').trim(),
    authorMid: Number(author.mid) || 0,
    pubTs,
    title: cleanBiliFaces(archive?.title || article?.title || opus?.title || ''),
    // 正文：文字动态在 desc.text；专栏/图文在文章的 desc / opus.summary.text
    text: cleanBiliFaces(dyn.desc?.text || ''),
    summary: cleanBiliFaces(article?.desc || opus?.summary?.text || ''),
    url,
    stat: {
      like: Number(stat?.like?.count) || 0,
      comment: Number(stat?.comment?.count) || 0,
      forward: Number(stat?.forward?.count) || 0
    }
  };
}

/** 浏览器请求头：空间类接口少一个都可能 -352，所以整组给全。 */
function spaceHeaders(mid, cookie) {
  return {
    'User-Agent': UA,
    Referer: `https://space.bilibili.com/${mid}/dynamic`,
    Origin: 'https://space.bilibili.com',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    ...(cookie ? { Cookie: cookie } : {})
  };
}

// 动态接口的 features 参数：实测**必须带这一长串**，只给 itemOpusStyle 时接口
// 会 code=0 但 items 直接是空数组（不是错误，是"什么都没有"）。
const FEATURES = 'itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote';

/**
 * 空间类接口的"体面间隔"。
 *
 * 实测（2026-09-27 本机）：同一 IP 在十几秒内连打 5 次 /feed/space，
 * 前 1 次正常返回 12 条，后面几次全是 `code:0` + **空 items** ——
 * B 站限流在这里是**静默**的，不报错、不返回 4xx，最难排查。
 * 所以这里主动把空间接口之间的间隔拉开，并且把"空列表"当成需要下一轮再试的软失败。
 */
const SPACE_GAP_MS = 8000;
let lastSpaceAt = 0;

async function spaceGap() {
  const wait = lastSpaceAt + SPACE_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSpaceAt = Date.now();
}

/**
 * 拉某个 UP 的动态列表（第一页，最新在前）。
 *
 * @returns {{ok:true, items:Array, hasMore:boolean, offset:string}}
 *        | {{ok:false, error:string}}
 */
export async function fetchUserDynamics(mid, { limit = 20, timeoutMs = 15000, cookie: userCookie = '' } = {}) {
  const id = Number(mid);
  if (!id) return { ok: false, error: '缺少 UP 的 uid' };
  const base = { host_mid: id, offset: '', timezone_offset: -480, features: FEATURES };
  const errors = [];
  const own = normalizeUserCookie(userCookie);

  // 最多两次：第二次会**换一份全新指纹 + 重取 WBI key**。
  // 触发第二次的两种情形：① 风控类错误（-352/-412）；② 空列表（对官方号实测常见）。
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const fresh = attempt > 1;
    // eslint-disable-next-line no-await-in-loop
    const fp = await ensureFingerprint({ timeoutMs, force: fresh });
    const headers = spaceHeaders(id, mergeCookie(own, fp));

    // ⚠️ 签名的 key 取自 nav 接口，**偶发拿不到**（实测：同一个 UP，前一分钟成功、
    // 后一分钟 nav 返回的东西里没有 wbi_img）。这时不能退化成"不带签名的请求" ——
    // 实测不带签名必然 -352 风控，发了只是白白消耗配额。所以这里重取一次 key，
    // 再拿不到就记成可重试失败，交给下一轮。
    // eslint-disable-next-line no-await-in-loop
    let q = await wbiSign(base, { timeoutMs, force: fresh });
    if (!q) {
      // eslint-disable-next-line no-await-in-loop
      q = await wbiSign(base, { timeoutMs, force: true });
    }
    if (!q) {
      errors.push(`第${attempt}次：WBI 签名参数获取失败（nav 接口没给出 key）`);
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    await spaceGap();

    let res;
    try {
      // eslint-disable-next-line no-await-in-loop
      res = await fetch(`${API}/x/polymer/web-dynamic/v1/feed/space?${q}`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      errors.push(`第${attempt}次请求失败：${error?.message ?? error}`);
      continue;
    }
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      errors.push(`第${attempt}次返回了非 JSON（HTTP ${res.status}，多半被风控拦了）`);
      continue;
    }
    if (body?.code !== 0) {
      const msg = String(body?.message || `业务码 ${body?.code}`);
      errors.push(`第${attempt}次：${msg}`);
      if (/^-?(352|412)$/.test(String(body?.code)) && attempt === 1) {
        await new Promise((r) => setTimeout(r, 3000));   // 风控：重领指纹后立刻重试一次
        continue;
      }
      break;
    }
    const rawItems = Array.isArray(body?.data?.items) ? body.data.items : [];
    const items = rawItems.map(normDynamic).filter((x) => x.id).slice(0, Math.max(1, Number(limit) || 20));
    if (!items.length) {
      errors.push(`第${attempt}次：接口返回了空列表（B 站对同一 IP 的频繁请求会这样静默限流；也可能是该账号此刻没有可见动态）`);
      // 实测（2026-10-06 本机，官方号）：同一个 UP 的 5 次检查里会有几次返回空列表，
      // 换一份**全新指纹**再试一次能明显提高命中率。所以这里等 20 秒重试一次
      // （只重试一次：再多就变成"越限流越打"，反而更糟）。
      if (attempt === 1) {
        await new Promise((r) => setTimeout(r, 20000));
        continue;
      }
      break;
    }
    return {
      ok: true,
      items,
      hasMore: Boolean(body?.data?.has_more),
      offset: String(body?.data?.offset ?? ''),
      // 第几次才成功：调用方据此提示"这次是重试才拿到的"（排错时很有用）
      attempt
    };
  }
  return { ok: false, error: errors.join('；') || '动态接口没有返回可用数据' };
}

// ── 直播状态 ─────────────────────────────────────────────────────────────
//
// 为什么单独用直播间接口，而不是指望"动态流里的直播卡片"：
//   · 动态流里那张卡（DYNAMIC_TYPE_LIVE_RCMD）**经常不带动态 id**，而本插件的
//     去重/记账完全依赖 id —— 带 id 才记得住，记不住就会每轮重复推；
//   · 直播卡片只说明"动态流里出现了推荐位"，拿不到稳定的开播/下播状态。
// 直播间接口（api.live.bilibili.com，与动态接口不同服务器、独立限流）能一次问多个
// uid，字段是明确的 live_status：0=未开播 / 1=直播中 / 2=轮播。
//
// 实测（2026-10-06）：get_status_info_by_uids 返回
//   { "1265652806": { title, room_id, uid, online, live_status, uname, ... } }
export async function fetchLiveStatus(uids, { timeoutMs = 15000 } = {}) {
  const list = (Array.isArray(uids) ? uids : [uids]).map((u) => Number(u)).filter(Boolean);
  if (!list.length) return { ok: false, error: '缺少 uid' };
  const q = list.map((u) => `uids%5B%5D=${u}`).join('&');
  await throttle();
  let res;
  try {
    res = await fetch(`${LIVE_API}/room/v1/Room/get_status_info_by_uids?${q}`, {
      headers: { 'User-Agent': UA, Referer: 'https://live.bilibili.com/' },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    return { ok: false, error: `直播间接口请求失败：${error?.message ?? error}` };
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: `直播间接口返回了非 JSON（HTTP ${res.status}）` };
  }
  if (body?.code !== 0) {
    return { ok: false, error: `直播间接口：${String(body?.message || `业务码 ${body?.code}`)}` };
  }
  const data = (body?.data && typeof body.data === 'object') ? body.data : {};
  const byUid = {};
  for (const [k, v] of Object.entries(data)) {
    const status = Number(v?.live_status);
    byUid[String(k)] = {
      uid: Number(v?.uid) || Number(k) || 0,
      live: status === 1,          // 只有在播算"开播"，轮播(2)不算
      round: status === 2,
      status,
      roomId: Number(v?.room_id) || 0,
      title: cleanBiliFaces(v?.title || ''),
      name: String(v?.uname || '').trim()
    };
  }
  return { ok: true, byUid };
}

// ── 文案 ─────────────────────────────────────────────────────────────────

/**
 * 把一条动态拼成要发到群里的纯文本。
 *
 * 刻意**只发文字 + 链接**、不发图片：动态里的图都在 B 站 CDN 上，QQ 端抓取
 * 经常失败（要么被防盗链挡、要么图太大），而"推送失败/半成功"比少一张图更糟。
 * 链接交给 QQ 自己展开卡片即可。
 */
export function formatDynamicMessage({ name = '', item = {}, first = false } = {}) {
  const who = String(name || item.author || 'UP主').trim();
  const label = String(item.label || '动态');
  const head = label === '转发' ? '转发了动态' : `发布了新${label}`;
  const when = shortTime(item.pubTs);
  const lines = [`【B站动态】${who} ${head}${when ? `（${when}）` : ''}`];

  if (item.title) lines.push(`《${String(item.title).slice(0, 120)}》`);
  const body = String(item.text || item.summary || '').trim();
  if (body) lines.push(body.length > 120 ? `${body.slice(0, 120)}…` : body);
  if (item.url) lines.push(String(item.url));
  if (first) lines.push('（这是订阅时 TA 最新的一条，之后有新动态我会自动发出来）');
  return lines.join('\n');
}

/** 秒级时间戳 → "09-30 17:12"（发到群里用短格式，别喧宾夺主）。 */
export function shortTime(pubTs) {
  const t = Number(pubTs) || 0;
  if (!t) return '';
  const d = new Date(t * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 开播文案。 */
export function formatLiveOnMessage({ name = '', title = '', roomId = 0 } = {}) {
  const who = String(name || 'UP主').trim();
  const lines = [`【B站开播】${who} 正在直播`];
  if (title) lines.push(`《${String(title).slice(0, 120)}》`);
  if (roomId) lines.push(`https://live.bilibili.com/${roomId}`);
  return lines.join('\n');
}

/** 下播文案。 */
export function formatLiveOffMessage({ name = '' } = {}) {
  return `【B站下播】${String(name || 'UP主').trim()} 的直播结束了`;
}

/** 秒级时间戳 → "2026-09-27 14:03"（本地时区，群里看得懂）。 */
export function formatPubTime(pubTs) {
  const t = Number(pubTs) || 0;
  if (!t) return '';
  const d = new Date(t * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
