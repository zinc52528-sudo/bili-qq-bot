/**
 * bili-browse / bili-api.js —— B站公开接口层（只依赖 fetch）
 *
 * 为什么单独一层：解析逻辑（BV号 / b23 短链 / 时长格式 / 评论结构 / 接触印相表）
 * 是纯逻辑，不碰定时器也不碰提示词，单独放这里便于离线断言与复用。
 *
 * ⚠️ 本文件**不得**引入 fs / child_process / net 等 Node 内置模块：
 *    第三方模块目录会被加载器的能力闸逐文件扫描，一旦出现这些导入，
 *    整个插件会被判为「触碰高危能力」而拒绝加载。只用 fetch 就能满足全部需求。
 *
 * ── 接口可用性（2026-10-14 本机逐个实测，全部匿名可用、无需登录）──
 *   search/type   搜索视频     code=0，20 条结果
 *   view          视频详情     code=0，含 aid / cid / duration / desc / stat
 *   reply         热门评论     code=0，**读评论不需要登录**
 *   videoshot     逐帧缩略图   code=0，返回 index(每帧秒数) + image(拼图 URL)
 *   popular       综合热门     code=0
 *
 * ── videoshot 是「看画面」的关键（本次最大发现）──────────────────────────
 *   B站为每个视频预生成了**逐帧缩略图拼图**（默认 10x10 = 100 帧/张）。
 *   实测一个 4.4 小时视频有 1523 帧、切成 16 张 4800x2700 的图；5 分钟的短视频
 *   有 59 帧、1 张图。`index[i]` 就是第 i 帧在视频里的**秒数**，且帧是横跨
 *   整个视频均匀采样的（首帧 0 秒、末帧接近总时长）。
 *
 *   于是「让模型看到画面」可以做到极便宜：
 *     拉一次 videoshot（几百字节 JSON）→ 把拼图 URL 作为图片交给模型
 *   —— 不需要下载视频、不需要 ffmpeg、不需要落盘、不需要任何子进程。
 *   实测 4/4 视频（含短视频）都有拼图，且模型能正确读出第 1 格与第 100 格的内容。
 *
 * ── 为什么不是"下载视频再抽帧" ──────────────────────────────────────────
 *   那条路要 fs + child_process（下载落盘、调 ffmpeg 裁剪），
 *   而这两样正是能力闸拦的东西 —— 插件会被拒绝加载，得让用户手工加信任。
 *   既然 B站自己已经把帧准备好了，就没必要为了同样的画面去付那个代价。
 *   （需要更高清单帧精度时再考虑，见 README 的「可选升级」。）
 */

export const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const BILI_REFERER = 'https://www.bilibili.com/';

const API = 'https://api.bilibili.com';
const DEFAULT_TIMEOUT = 15000;

/**
 * B站风控用的 buvid3。
 * 2026-10-04 实测（同一台机、同一秒对比）：裸请求搜索接口稳定 412，
 * 带一个随机 buvid3 cookie 后 200 / code=0。所以每次请求都塞一个新的，别去掉。
 */
export function buvid3() {
  const h = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, () => Math.floor(Math.random() * 16).toString(16));
  return `${h}infoc`;
}

export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** 搜索结果标题里带 <em class="keyword"> 高亮标签，必须剥掉。 */
export function stripTags(s) {
  return decodeEntities(String(s ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * 时长归一成秒。
 * 三个接口给的格式不一样，必须统一：
 *   · 搜索接口 → "12:34" / "1:02:03" 字符串
 *   · 详情/热门 → 秒数
 * 踩坑：只按一种格式解析，另一种会静默变成 0（时长过滤就永远失效）。
 */
export function parseDuration(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.round(v));
  const s = String(v ?? '').trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(':').map((x) => Number(x) || 0);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

/** 粗判「这是不是一个 B站视频引用」。真正的解析交给 resolveBvid。 */
export function isBiliUrl(s) {
  const t = String(s ?? '').trim();
  if (!t) return false;
  return /bilibili\.com|b23\.tv/i.test(t) || /^BV[0-9A-Za-z]{10}$/.test(t) || /^av\d+$/i.test(t);
}

/** 统一的 JSON 请求。非 200 或非 JSON 都抛错，让调用方决定降级方式。 */
async function getJson(fetchImpl, url, {
  referer = BILI_REFERER, timeoutMs = DEFAULT_TIMEOUT, cookie = '',
  method = 'GET', body = null, headers = {}
} = {}) {
  const res = await fetchImpl(url, {
    method,
    headers: {
      'user-agent': BILI_UA,
      referer,
      accept: 'application/json, text/plain, */*',
      ...(cookie ? { cookie } : {}),
      ...headers
    },
    body,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) {
    const hint = (res.status === 412 || res.status === 403) ? '（B站风控，稍后重试）' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`返回的不是 JSON（前 120 字：${text.slice(0, 120)}）`);
  }
}

/**
 * 把用户给的东西解析成 BV 号：支持 BV号、av号、完整链接、b23.tv 短链。
 * @returns {Promise<string>} bvid
 */
export async function resolveBvid(fetchImpl, input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('没有给出视频地址或 BV 号');

  const direct = /(BV[0-9A-Za-z]{10})/.exec(raw);
  if (direct) return direct[1];

  const av = /(?:^|[^\w])av(\d+)/i.exec(raw);
  if (av) {
    const j = await getJson(fetchImpl, `${API}/x/web-interface/view?aid=${av[1]}`);
    if (j?.code === 0 && j.data?.bvid) return j.data.bvid;
    throw new Error(`av${av[1]} 解析失败：code=${j?.code} ${j?.message || ''}`);
  }

  if (/b23\.tv|bilibili\.com/i.test(raw)) {
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    // 短链要跟跳转：最终 URL 里才有 BV 号
    const res = await fetchImpl(url, {
      redirect: 'follow',
      headers: { 'user-agent': BILI_UA, referer: BILI_REFERER },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT)
    });
    const m = /(BV[0-9A-Za-z]{10})/.exec(String(res?.url || ''));
    if (m) return m[1];
    // 少数短链跳转后 BV 号只出现在 HTML 里
    const text = await res.text().catch(() => '');
    const m2 = /(BV[0-9A-Za-z]{10})/.exec(text);
    if (m2) return m2[1];
    throw new Error('这个链接里没解析出 BV 号（可能不是视频页，或链接已失效）');
  }

  throw new Error(`认不出这是不是 B站视频：${raw.slice(0, 60)}`);
}

/** 视频详情。 */
export async function getVideoInfo(fetchImpl, bvid) {
  const j = await getJson(fetchImpl, `${API}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
  if (j?.code !== 0) throw new Error(`视频详情失败：code=${j?.code} ${j?.message || ''}`);
  const d = j.data || {};
  return {
    bvid: d.bvid || bvid,
    aid: d.aid,
    cid: d.cid,
    cid: d.cid,
    title: stripTags(d.title),
    desc: String(d.desc || '').trim(),
    durationSec: Number(d.duration) || 0,
    author: d.owner?.name || '',
    view: Number(d.stat?.view) || 0,
    danmaku: Number(d.stat?.danmaku) || 0,
    replyCount: Number(d.stat?.reply) || 0,
    like: Number(d.stat?.like) || 0,
    pubdate: Number(d.pubdate) || 0,
    url: `https://www.bilibili.com/video/${d.bvid || bvid}`
  };
}

/**
 * 热门评论（按热度 sort=2）。**读评论不需要登录**，失败就返回空数组 ——
 * 评论只是锦上添花，拿不到不该拖垮整次"刷视频"。
 */
export async function getHotComments(fetchImpl, aid, limit = 5) {
  if (!aid) return [];
  try {
    const ps = Math.max(1, Math.min(20, Math.round(Number(limit) || 5)));
    const j = await getJson(fetchImpl, `${API}/x/v2/reply?type=1&oid=${aid}&sort=2&ps=${ps}&pn=1`);
    if (j?.code !== 0) return [];
    const list = j?.data?.replies;
    if (!Array.isArray(list)) return [];
    return list.slice(0, ps).map((r) => ({
      user: r?.member?.uname || '匿名',
      text: stripTags(r?.content?.message || ''),
      like: Number(r?.like) || 0
    })).filter((c) => c.text);
  } catch {
    return [];
  }
}

/** CDN 返回的是协议相对地址（//bimp...），补上 https: 才能直接用。 */
function normalizeSheetUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (s.startsWith('//')) return `https:${s}`;
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

/**
 * 逐帧缩略图（接触印相表）。
 * @returns {Promise<null | {sheets:string[], index:number[], xLen:number, yLen:number}>}
 */
export async function getVideoShot(fetchImpl, bvid) {
  try {
    const j = await getJson(fetchImpl, `${API}/x/player/videoshot?bvid=${encodeURIComponent(bvid)}&index=1`);
    if (j?.code !== 0) return null;
    const d = j.data || {};
    const images = Array.isArray(d.image) ? d.image : [];
    if (!images.length) return null;
    return {
      sheets: images.map(normalizeSheetUrl).filter(Boolean),
      index: Array.isArray(d.index) ? d.index.map(Number) : [],
      xLen: Number(d.img_x_len) || 10,
      yLen: Number(d.img_y_len) || 10
    };
  } catch {
    return null;
  }
}

/**
 * 取拼图地址，可选让 CDN 先缩放。
 *
 * width = 0 用原图（默认 4800x2700，每格 480x270，最清楚）。
 * 之所以默认用原图：以 **URL 形式**交给模型时，进请求体预算的只是这个 URL 字符串
 * 的长度（约 90 字符），图片本身多大都不占预算 —— 那就没必要牺牲清晰度。
 * 只有切换成 base64 内联模式时才需要压（见 index.js 的 sheetWidthFor）。
 */
export function sheetUrls(shot, width = 0) {
  if (!shot?.sheets?.length) return [];
  const w = Math.round(Number(width) || 0);
  // 这里再归一一次（而不是只信 getVideoShot 的产物）：本函数也被离线断言和
  // 别处直接调用，传进来的是原始 //host/... 时不补协议会让模型取不到图。
  // 幂等，所以重复归一没有代价。
  return shot.sheets
    .map(normalizeSheetUrl)
    .filter(Boolean)
    .map((u) => (w > 0 ? `${u}@${w}w.jpg` : u));
}

/** 第 i 帧在视频里的秒数（拿不到就返回 null）。 */
export function frameSeconds(shot, i) {
  const arr = shot?.index;
  if (!Array.isArray(arr) || !arr.length) return null;
  const idx = Math.max(0, Math.min(arr.length - 1, Math.round(Number(i) || 0)));
  const v = Number(arr[idx]);
  return Number.isFinite(v) ? v : null;
}

/**
 * 搜索视频。
 *
 * ── 筛选参数（2026-10-14 加，本机实测定标）────────────────────────────
 * `pubWithinDays`：转成 `pubtime_begin_s` / `pubtime_end_s` 两个秒级时间戳，
 *   由**服务端**先筛一遍。实测有效，且**不会**因此丢掉高播放视频。
 *   客户端那份过滤仍然保留（见 index.js 的 passesFilters）—— 服务端参数
 *   是优化，不是保证：接口随时可能忽略它们，而"筛选"是用户明确要的语义。
 * `pages`：翻几页候选。**这一条是筛选能不能用的关键**，见下方实测。
 *
 * ── ⚠️ 不要用 order=pubdate（2026-10-14 实测推翻的直觉）────────────────
 * 加时间筛选时的第一反应是"顺带把排序换成按发布时间倒序"，因为默认相关度
 * 排序里确实混着几年前的老视频（实测见过 1857 天前的）。但实测定标证明
 * **换排序是错的，而且错得很彻底**：
 *
 *   B站的 order=pubdate 返回的是"刚刚发布"的那一批，它们播放量几乎全是 0
 *   （实测前 5 页 100 条，播放中位数 0~18，最高 18）。于是"发布时间 + 播放量"
 *   一起用时，候选会被筛得一个不剩：
 *
 *     条件：播放≥1万 且 点赞≥500 且 30 天内，3 个关键词各跑一遍
 *       默认相关度 + 30天窗 + 3页   → 存活 96 条   ← 最优
 *       默认相关度 + 30天窗 + 1页   → 存活 37 条
 *       默认相关度（无时间窗）+ 1页  → 存活 28 条
 *       order=pubdate + 30天窗 + 3页 → 存活  0 条   ← 全军覆没
 *
 *   原因：相关度排序本身就把"高播放"排在前面，而时间窗由服务端独立生效 ——
 *   两者叠加既保住了质量又限住了时间。换成 pubdate 则等于把质量排序扔掉。
 *
 *   所以这里**刻意不提供 order 参数**：留着它迟早有人（包括未来的我）
 *   觉得"时间筛选就该按时间排"而重新踩进去。要恢复相关度以外的排序，
 *   请先重跑 .workbuddy 之外的 probe-ordering-sweep.mjs 那份定标。
 *
 * 返回值里带上了 `like` 与 `pubdate`（秒）：它们是点赞数筛选与发布时间筛选的
 * 唯一依据。早先这两个字段没被映射出来，于是"按点赞筛"根本无从谈起。
 */
export async function searchVideos(fetchImpl, keyword, limit = 12, {
  pubWithinDays = 0, now = Date.now(), pages = 1
} = {}) {
  const kw = String(keyword ?? '').trim();
  if (!kw) return [];
  const n = Math.max(1, Math.min(50, Math.round(Number(limit) || 12)));
  const nPages = Math.max(1, Math.min(5, Math.round(Number(pages) || 1)));
  const days = Math.max(0, Number(pubWithinDays) || 0);

  const base = new URLSearchParams();
  base.set('search_type', 'video');
  base.set('keyword', kw);
  if (days > 0) {
    const end = Math.floor(Number(now) / 1000);
    const begin = end - Math.round(days * 86400);
    base.set('pubtime_begin_s', String(begin));
    base.set('pubtime_end_s', String(end));
  }

  const out = [];
  const seenBvid = new Set();
  // 逐页取，取够 n 条就停。某页失败**不**影响已拿到的部分 ——
  // 翻页只是"多要一点候选"，不该因为第 3 页 412 就整个挑不出视频。
  for (let p = 1; p <= nPages && out.length < n; p += 1) {
    const params = new URLSearchParams(base);
    params.set('page', String(p));
    let arr = [];
    try {
      const j = await getJson(fetchImpl, `${API}/x/web-interface/search/type?${params.toString()}`,
        { cookie: `buvid3=${buvid3()}` });
      if (j?.code !== 0) {
        if (p === 1) throw new Error(`搜索失败：code=${j?.code} ${j?.message || ''}`);
        break;   // 第 1 页就失败才是真失败；后续页失败就当没有了
      }
      arr = Array.isArray(j?.data?.result) ? j.data.result : [];
    } catch (error) {
      if (p === 1) throw error;
      break;
    }
    if (!arr.length) break;   // 没有下一页了
    for (const v of arr) {
      const bvid = String(v?.bvid || '');
      if (!bvid || seenBvid.has(bvid)) continue;   // 翻页会重复：同一视频可能出现在多页
      seenBvid.add(bvid);
      out.push(v);
    }
  }

  return out.slice(0, n).map((v) => ({
    bvid: v.bvid,
    title: stripTags(v.title),
    author: v.author || '',
    play: Number(v.play),
    like: Number(v.like),
    pubdate: Number(v.pubdate) || 0,
    durationSec: parseDuration(v.duration),
    desc: stripTags(v.description || ''),
    url: v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : String(v.arcurl || '')
  })).filter((v) => v.bvid && v.title);
}

/**
 * 综合热门（网梗与流行内容的主要来源）。
 *
 * 这里同样补齐了 `like` 与 `pubdate`：热门接口的点赞数在 `stat.like` 里
 * （顶层没有），发布时间在顶层 `pubdate`。少了这两个字段，热门源就没法参与
 * 点赞/时间筛选 —— 表现是"从热门挑的时候筛选静默失效"。
 *
 * 注意 `Number(v.play)` **不带 `|| 0`**：见 passesFilters 的注释 ——
 * 必须能区分"接口没给"（NaN）和"真的是 0 播放"（0），否则播放量下限
 * 会被 0 播放的新视频静默绕过。
 */
export async function popularVideos(fetchImpl, limit = 20) {
  const n = Math.max(1, Math.min(50, Math.round(Number(limit) || 20)));
  const j = await getJson(fetchImpl, `${API}/x/web-interface/popular?ps=${n}&pn=1`);
  if (j?.code !== 0) throw new Error(`热门失败：code=${j?.code} ${j?.message || ''}`);
  const arr = Array.isArray(j?.data?.list) ? j.data.list : [];
  return arr.slice(0, n).map((v) => ({
    bvid: v.bvid,
    title: stripTags(v.title),
    author: v?.owner?.name || '',
    play: Number(v?.stat?.view),
    like: Number(v?.stat?.like),
    pubdate: Number(v.pubdate) || 0,
    durationSec: Number(v.duration) || 0,
    desc: stripTags(v.desc || ''),
    url: v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : ''
  })).filter((v) => v.bvid && v.title);
}

/**
 * 发评论（**需要登录态**：SESSDATA + bili_jct）。
 *
 * ⚠️ 这是本项目里唯一一个「对外写入」的调用：它会在 B站上以**你的账号**留下
 * 一条真实评论，删不掉只能手动删。所以调用方必须显式开启，且默认关闭。
 *
 * csrf 参数就是 cookie 里的 bili_jct —— B站用双重提交校验，两个都得给。
 */
export async function postComment(fetchImpl, { aid, message, sessdata, biliJct, timeoutMs = 20000 } = {}) {
  const oid = String(aid ?? '').trim();
  const msg = String(message ?? '').trim();
  const sess = String(sessdata ?? '').trim();
  const jct = String(biliJct ?? '').trim();
  if (!oid) throw new Error('缺少 aid（视频的 oid）');
  if (!msg) throw new Error('评论内容为空');
  if (!sess) throw new Error('没配 SESSDATA —— 发评论必须登录态');
  if (!jct) throw new Error('没配 bili_jct —— B站的 csrf 校验需要它');

  const form = new URLSearchParams();
  form.set('oid', oid);
  form.set('type', '1');          // 1 = 视频
  form.set('message', msg);
  form.set('plat', '1');
  form.set('csrf', jct);

  const j = await getJson(fetchImpl, `${API}/x/v2/reply/add`, {
    method: 'POST',
    cookie: `SESSDATA=${sess}; bili_jct=${jct}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    timeoutMs
  });

  if (j?.code === 0) {
    return { ok: true, rpid: j?.data?.rpid ?? null };
  }
  throw new Error(commentErrorText(j?.code, j?.message));
}

/** 评论接口的错误码翻译成人话（这些码实测常见，照着提示改就行）。 */
export function commentErrorText(code, message = '') {
  const c = Number(code);
  const table = {
    '-101': '账号未登录（SESSDATA 失效或填错）',
    '-111': 'csrf 校验失败（bili_jct 与 SESSDATA 不配套，或已过期）',
    '-400': '请求被拒（参数不对）',
    '-403': '权限不足（可能被风控或该视频不允许评论）',
    12015: '需要验证码（触发了风控，换个时间或先手动登录一次）',
    12035: '评论太频繁（被限流，歇一会儿）',
    12051: '评论内容被判定为违规',
    12061: '评论内容不可用（可能含敏感词或被折叠）'
  };
  const hint = table[String(c)];
  return `发评论失败：code=${code} ${message}${hint ? ` —— ${hint}` : ''}`;
}
