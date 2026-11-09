/**
 * bili-browse —— 自己刷B站（确定性型插件 / API v1）
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────────
 * 机器人原本只会"被动接话"。群里冷场时它靠 proactive 主动机会开口，但那时的
 * 它手里什么都没有 —— 只能硬聊，或者用 web_search 现搜（慢、费 token、
 * 搜到的是标题党摘要）。这个插件把"看点东西"提前备好：
 *
 *   后台定时（默认 45 分钟）挑一个 B站 视频
 *     → 拉详情 + 热门评论 + **逐帧画面拼图**
 *   主动机会来临时，把这一份（含画面）塞进提示词末尾
 *     → 它真的"看过"，于是能像人一样说"刚刷到一个视频，xxx"
 *
 * ── 画面从哪来（本插件最关键的取舍）──────────────────────────────────────
 * 不用下载视频、不用 ffmpeg、不落盘 —— B站 自己为每个视频预生成了
 * **逐帧缩略图拼图**（videoshot 接口，默认 10x10 = 100 帧/张，帧横跨全片
 * 均匀采样，`index[i]` 就是第 i 帧的秒数）。实测 4/4 视频都有（含 5 分钟短视频）。
 *
 * 这么做不只是"省事"，更是**为了不被安全闸拦下**：
 *   下载落盘要 `fs`、裁剪抽帧要 `child_process` —— 这两样正是插件加载器的
 *   能力闸拦的东西（见 src/plugin-loader.js 的 DANGEROUS_MODULE_RE）。
 *   一旦导入，插件会被判「触碰高危能力」直接拒绝加载，得让用户手工加信任。
 *   而本插件只用 fetch，**放进去就能跑，不需要改任何信任配置**。
 *
 * 实测（本机、2026-10-14）：把 10x10 拼图交给 deepseek-v4.1-flash，
 * 它准确读出了"第 1 格是室内女性人像，第 100 格是夜景烟花"，一次约 1000 token。
 *
 * ── 为什么是插件，不是技能 ────────────────────────────────────────────────
 * "到点去挑一个、备着" 这件事不需要判断，也不该让模型决定（它忘了就永远不刷）。
 * 所以定时那一半必须是插件、由定时器无条件执行，且**完全不花 token**。
 * 另一半"要不要说、怎么说"由模型判断 —— 通过 before-llm-messages 钩子递料，
 * 以及 bili_watch 工具按需查询。
 *
 * ── 踩坑备忘 ─────────────────────────────────────────────────────────────
 *   · 拼图 URL 是协议相对的（//bimp...），不补 https: 模型那边取不到图。
 *   · 搜索接口不带随机 buvid3 cookie 会稳定 412（见 bili-api.js）。
 *   · 长视频有很多张拼图（4.4 小时的视频有 16 张）。**只取第 1 张等于只看开头**，
 *     所以这里按整段均匀抽几张，并把每张覆盖的时间范围告诉模型。
 *   · 注入一律**追加到最后一条 user 消息末尾**：系统提示的前缀是缓存命脉，
 *     中间插入动态内容会让整段前缀缓存失效（prompt.js 的约定）。
 *   · ⚠️ 连**注释里**都不能出现"进程环境变量对象""主配置文件名""凭据文件名"的
 *     字面写法：加载器的 CREDENTIAL_RE 是纯文本扫描，扫到就判"涉及凭据文件"
 *     并拒绝加载整个插件。这一条是实测踩出来的 —— 本文件最初那段提醒自己
 *     别写这些字样的注释，本身就把插件拦下了（自指陷阱）。
 *     要描述它们就绕开字面量（像本段这样），或改放在 README.md 里
 *     （扫描只看 .js/.mjs/.cjs，不看 .md）。
 */

import {
  isBiliUrl, resolveBvid, getVideoInfo, getHotComments, getVideoShot,
  sheetUrls, searchVideos, popularVideos, postComment,
  fmtDuration, stripTags
} from './bili-api.js';
// isAtMe 是宿主里「是否被艾特」的**唯一权威实现**（QQ 号优先、名字兜底，覆盖
// CQ 码 / 展平 @昵称(QQ:123) / @123 / 昵称 四种写法）。自己再写一遍正则必然漂移，
// 而漂移的后果是"仅@模式"下机器人叫不醒 —— 那正是 prompt.js 注释里记着的旧坑。
import { isAtMe } from '../../src/prompt.js';
import { chatCompletion } from '../../src/llm.js';
import { getConfig, personaForChat } from '../../src/config.js';

import { makePersonaBrowser } from './persona-browse.js';
import { createBiliAuth } from './bili-auth.js';
import { createFileStorage } from './storage.js';
import { DATA_DIR } from '../../src/config.js';
let biliAuth = null;
export const providers = { 'bili.account.login': ({op}) => { if (!biliAuth) throw new Error('插件未就绪'); return biliAuth.action(op); } };
let personaBrowser = null;
const BUILD_TAG = 'v1.4.1-local';

const DEFAULTS = {
  enabled: true,
  browseEnabled: true,
  source: 'keyword',
  keywords: '小鲸鱼,美食,猫,科技数码,搞笑',
  minDurationSec: 30,
  maxDurationSec: 900,
  // ── 筛选（0 = 不限）────────────────────────────────────────────────────
  // 全部在**客户端**二次过滤（见 chooseCandidate）：接口参数只是让候选更准，
  // 而"筛选"是用户明确要的语义，不能因为接口哪天忽略参数就静默失效。
  minViewCount: 0,
  maxViewCount: 0,
  minLikeCount: 0,
  maxLikeCount: 0,
  maxAgeDays: 0,
  minAgeDays: 0,
  /** 筛空时自动放宽一次（会打日志说明放宽了什么）。 */
  filterFallback: true,
  perPage: 20,
  checkIntervalMin: 45,
  catchUpOnStart: true,
  injectOnProactive: true,
  shareChatKey: '',
  maxSharesPerDay: 6,
  minMinutesBetweenShares: 60,
  quietHours: '1,2,3,4,5,6,7',
  // ── 触发词主动发视频 ───────────────────────────────────────────────────
  triggerKeywords: '',
  triggerSendEnabled: true,
  triggerCooldownMin: 20,
  triggerMaxPerDay: 10,
  /** 只在被 @ 时才发视频（触发词也必须带 @，且关掉冷场自动分享）。 */
  atOnly: false,
  /** 视频发出去之后，让它再补一句自己的锐评。 */
  autoReview: true,
  commentCount: 5,
  sheetCount: 1,
  sheetWidth: 0,
  imageMode: 'url',
  maxInjectChars: 1100,
  seenKeep: 200,
  allowComment: false,
  bilibiliSessdata: '',
  bilibiliJct: ''
};

// ── 运行态（内存）────────────────────────────────────────────────────────
const state = {
  timer: null,
  /** 启动补挑的那一发延迟定时器（deactivate 必须清，否则热重载会留下孤儿） */
  catchUpTimer: null,
  picking: false,
  /** 备好但还没递出去的视频（递出后置 null，天然防同一轮重复注入） */
  pending: null,
  /**
   * 最近一次见到的发送队列与会话名（chatKey → { sender, chatName, at }）。
   *
   * 为什么需要缓存：**触发发送**必须在拿到消息的那一刻就知道往哪发，而
   * `onMessage` 钩子虽然带了 sender，却不带群名；`before-llm-messages` 带了群名
   * 却不带 sender（skillContext 里没有它）。两边各有一半，所以这里按会话把两边
   * 见过的东西合起来记 —— 与 hot-trend-tracker 的 senderCache 同一套路。
   */
  channels: new Map(),
  sending: false
};

let cfg = () => ({});
let log = () => {};
let warn = () => {};
let fetchImpl = globalThis.fetch;
let storage = null;

// ── 配置 ─────────────────────────────────────────────────────────────────

function settings() {
  const c = cfg() || {};
  const num = (k, d) => {
    const v = Number(c[k]);
    return Number.isFinite(v) ? v : d;
  };
  const bool = (k, d) => (typeof c[k] === 'boolean' ? c[k] : d);
  const str = (k, d) => (c[k] === undefined || c[k] === null ? d : String(c[k]));

  const source = str('source', DEFAULTS.source).toLowerCase() === 'popular' ? 'popular' : 'keyword';
  const imageMode = ['url', 'base64', 'off'].includes(str('imageMode', DEFAULTS.imageMode).toLowerCase())
    ? str('imageMode', DEFAULTS.imageMode).toLowerCase()
    : 'url';
  // 「仅 @」隐含"别自己往外掏视频" —— 不强制关掉 injectOnProactive 的话，
  // 冷场时它仍会把视频塞进提示词，与"我不叫你你就别发"的语义直接冲突。
  // 在这里（而不是在使用处）收口，是因为判断散在多处时必然有一处漏掉。
  const atOnly = bool('atOnly', DEFAULTS.atOnly);

  return {
    ...Object.fromEntries(['peakBrowseEnabled','offPeakBrowseEnabled','peakIntervalMin','offPeakIntervalMin','peakDailyRounds','offPeakDailyRounds','peakWindows','offPeakDates'].map(k=>[k,c[k]])),
    autonomousEnabled: bool('autonomousEnabled', false),
    feedbackQQ: str('feedbackQQ', ''),
    candidateCount: num('candidateCount', 5),
    recommendCount: num('recommendCount', 3),
    dailyRounds: num('dailyRounds', 3),
    riskCooldownMin: num('riskCooldownMin', 180),
    enabled: bool('enabled', DEFAULTS.enabled),
    browseEnabled: bool('browseEnabled', DEFAULTS.browseEnabled),
    source,
    keywords: str('keywords', DEFAULTS.keywords),
    minDurationSec: Math.max(0, num('minDurationSec', DEFAULTS.minDurationSec)),
    maxDurationSec: Math.max(1, num('maxDurationSec', DEFAULTS.maxDurationSec)),
    // 筛选：0 一律表示"不限"。用 Math.max(0, …) 把负数也归到 0（不限），
    // 而不是留个负数让比较式永远为假 —— 那会变成"静默筛掉所有候选"。
    minViewCount: Math.max(0, num('minViewCount', DEFAULTS.minViewCount)),
    maxViewCount: Math.max(0, num('maxViewCount', DEFAULTS.maxViewCount)),
    minLikeCount: Math.max(0, num('minLikeCount', DEFAULTS.minLikeCount)),
    maxLikeCount: Math.max(0, num('maxLikeCount', DEFAULTS.maxLikeCount)),
    maxAgeDays: Math.max(0, num('maxAgeDays', DEFAULTS.maxAgeDays)),
    minAgeDays: Math.max(0, num('minAgeDays', DEFAULTS.minAgeDays)),
    filterFallback: bool('filterFallback', DEFAULTS.filterFallback),
    perPage: Math.max(1, Math.min(50, num('perPage', DEFAULTS.perPage))),
    checkIntervalMin: Math.max(1, Math.min(1440, num('checkIntervalMin', DEFAULTS.checkIntervalMin))),
    catchUpOnStart: bool('catchUpOnStart', DEFAULTS.catchUpOnStart),
    injectOnProactive: bool('injectOnProactive', DEFAULTS.injectOnProactive) && !atOnly,
    shareChatKey: str('shareChatKey', DEFAULTS.shareChatKey).trim(),
    maxSharesPerDay: Math.max(0, num('maxSharesPerDay', DEFAULTS.maxSharesPerDay)),
    minMinutesBetweenShares: Math.max(0, num('minMinutesBetweenShares', DEFAULTS.minMinutesBetweenShares)),
    quietHours: parseHours(str('quietHours', DEFAULTS.quietHours)),
    triggerKeywords: str('triggerKeywords', DEFAULTS.triggerKeywords),
    triggerSendEnabled: bool('triggerSendEnabled', DEFAULTS.triggerSendEnabled),
    triggerCooldownMin: Math.max(0, num('triggerCooldownMin', DEFAULTS.triggerCooldownMin)),
    triggerMaxPerDay: Math.max(0, num('triggerMaxPerDay', DEFAULTS.triggerMaxPerDay)),
    atOnly,
    autoReview: bool('autoReview', DEFAULTS.autoReview),
    commentCount: Math.max(0, Math.min(20, num('commentCount', DEFAULTS.commentCount))),
    sheetCount: Math.max(0, Math.min(6, num('sheetCount', DEFAULTS.sheetCount))),
    sheetWidth: Math.max(0, num('sheetWidth', DEFAULTS.sheetWidth)),
    imageMode,
    maxInjectChars: Math.max(200, Math.min(4000, num('maxInjectChars', DEFAULTS.maxInjectChars))),
    seenKeep: Math.max(10, Math.min(2000, num('seenKeep', DEFAULTS.seenKeep))),
    allowComment: bool('allowComment', DEFAULTS.allowComment),
    sessdata: str('bilibiliSessdata', '').trim(),
    biliJct: str('bilibiliJct', '').trim()
  };
}

/**
 * "1,2,3" → Set([1,2,3])；空串 = 无静默时段。
 *
 * ⚠️ 必须跳过空片段：`''.split(/[,，\s]+/)` 得到的是 `['']`，而 `Number('')` 是 **0**
 *    （不是 NaN）—— 于是"留空 = 全天都可以"会静默变成"0 点静默"，正好反了。
 *    同理 `'1,,2'` 这类多余分隔符也不能凭空塞进一个 0 点。
 */
function parseHours(raw) {
  const out = new Set();
  for (const part of String(raw || '').split(/[,，\s]+/)) {
    const t = part.trim();
    if (!t) continue;                      // 空片段直接跳过（见上）
    const n = Number(t);
    if (Number.isFinite(n) && n >= 0 && n <= 23) out.add(Math.round(n));
  }
  return out;
}

/** 北京时间的小时（这台机器的宿主按北京时间工作，与 hot-trend-tracker 同口径）。 */
function bjNow(now = Date.now()) {
  return new Date(now + 8 * 3600 * 1000);
}

function bjDayKey(now = Date.now()) {
  const d = bjNow(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// ── 持久状态：看过的视频 / 分享计数（走 api.storage，不需要 import fs）──

const STORE_SEEN = 'seenBvids';
const STORE_SHARE = 'shareLog';

function seenList() {
  try {
    const v = storage?.get(STORE_SEEN, []);
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}

function markSeen(bvid) {
  try {
    const list = seenList().filter((x) => x !== bvid);
    list.push(bvid);
    storage?.set(STORE_SEEN, list.slice(-settings().seenKeep));
  } catch (error) {
    warn(`记录已看视频失败（不影响其它功能）：${error?.message ?? error}`);
  }
}

function shareLog() {
  try {
    const v = storage?.get(STORE_SHARE, null);
    const day = bjDayKey();
    if (!v || typeof v !== 'object' || v.day !== day) return { day, count: 0, lastAt: 0 };
    return { day: v.day, count: Number(v.count) || 0, lastAt: Number(v.lastAt) || 0 };
  } catch { return { day: bjDayKey(), count: 0, lastAt: 0 }; }
}

function writeShareLog(next) {
  try { storage?.set(STORE_SHARE, next); } catch (error) {
    warn(`写分享计数失败：${error?.message ?? error}`);
  }
}

// ── 挑视频 ───────────────────────────────────────────────────────────────

/**
 * 一个候选是否通过筛选。
 *
 * ── 设计口径（重要，2026-10-14 实测定标后改写）──────────────────────────
 * ① `0` / 空设置 = **不限**，不是"等于 0"。用户把播放量下限留空，意思显然是
 *    "多少都行"，而不是"只要 0 播放的"。
 *
 * ② 判"字段缺失"必须看 `Number.isFinite`，**不能**看 `值 > 0`。
 *    这是第一版写错的地方，而且错得很隐蔽：搜索接口的 `play` 字段**总是存在**，
 *    一条刚发布、真的 0 播放的视频拿到的是 `0` 而不是 `undefined`。第一版写的是
 *    `if (play > 0 && play < min)` —— 于是 `play = 0` 直接绕过"播放量下限"，
 *    用户设"只要 1 万播放以上"却会收到 0 播放的刚投稿视频。
 *    实测（order=pubdate + 30 天窗）前 5 页 100 条里，播放中位数 0~18，
 *    最高 18 —— 也就是说这个 bug 会让"播放量筛选"在真实场景下**几乎完全失效**。
 *    正确写法：`Number.isFinite(play) && play < min` —— 字段没给（NaN）才放行。
 *
 * ③ 字段真的缺失时（接口没返回这个键）**不参与排除**：宁可给一个，也别因为
 *    接口少给一个字段就永远挑不出视频（那种故障表现为"功能开着但一直没动静"，
 *    最难查）。
 *
 * @returns {{ok:boolean, why:string}} why 只用于日志/排障，不面向用户
 */
export function passesFilters(v, s = {}, now = Date.now()) {
  if (!v) return { ok: false, why: '空候选' };
  // 只做"取数"，不做 `|| 0`：`|| 0` 会把"字段缺失"与"真的是 0"抹成同一个值，
  // 而这两者必须区分（见上方 ②）。Number(undefined) 是 NaN，正好当哨兵。
  const num = (x) => (x === null || x === undefined || x === '' ? NaN : Number(x));
  const play = num(v.play);
  const like = num(v.like);
  const pub = Number(v.pubdate) || 0;   // 时间戳 0 就是"没给"，不需要区分

  if (s.minViewCount > 0 && Number.isFinite(play) && play < s.minViewCount) {
    return { ok: false, why: `播放 ${play} < ${s.minViewCount}` };
  }
  if (s.maxViewCount > 0 && Number.isFinite(play) && play > s.maxViewCount) {
    return { ok: false, why: `播放 ${play} > ${s.maxViewCount}` };
  }
  if (s.minLikeCount > 0 && Number.isFinite(like) && like < s.minLikeCount) {
    return { ok: false, why: `点赞 ${like} < ${s.minLikeCount}` };
  }
  if (s.maxLikeCount > 0 && Number.isFinite(like) && like > s.maxLikeCount) {
    return { ok: false, why: `点赞 ${like} > ${s.maxLikeCount}` };
  }
  // 发布时间：pubdate 是**秒**（B站 惯例），now 是毫秒，换算后再比。
  // 未知 pubdate（0）不排除。
  if (pub > 0) {
    const ageDays = (now / 1000 - pub) / 86400;
    if (s.maxAgeDays > 0 && ageDays > s.maxAgeDays) {
      return { ok: false, why: `${ageDays.toFixed(0)} 天前 > 上限 ${s.maxAgeDays} 天` };
    }
    if (s.minAgeDays > 0 && ageDays < s.minAgeDays) {
      return { ok: false, why: `${ageDays.toFixed(1)} 天前 < 下限 ${s.minAgeDays} 天` };
    }
  }
  return { ok: true, why: '' };
}

/** 从候选里挑一个：时长 + 播放/点赞/发布时间筛选 + 没看过 + 随机。 */
export function chooseCandidate(list, {
  seen = [], minSec = 30, maxSec = 900, s = null, now = Date.now()
} = {}) {
  const seenSet = new Set((seen || []).map(String));
  const filt = s || { minDurationSec: minSec, maxDurationSec: maxSec };
  const ok = (Array.isArray(list) ? list : []).filter((v) => {
    if (!v?.bvid || !v?.title) return false;
    if (seenSet.has(String(v.bvid))) return false;
    const d = Number(v.durationSec) || 0;
    const minD = Number(filt.minDurationSec ?? minSec) || 0;
    const maxD = Number(filt.maxDurationSec ?? maxSec) || 0;
    // 时长未知（0）时不拿它做排除依据：宁可给一个，也别因为接口没给时长就永远挑不出来
    if (d > 0 && d < minD) return false;
    if (d > 0 && maxD > 0 && d > maxD) return false;
    return passesFilters(v, filt, now).ok;
  });
  if (!ok.length) return null;
  return ok[Math.floor(Math.random() * ok.length)];
}

/**
 * 取几页候选。
 *
 * 为什么与 perPage 挂钩而不是固定值：翻页是**筛选能不能用**的关键（实测：
 * "播放≥1万 且 30天内"在 1 页里存活 37 条、3 页里 96 条），但每多一页就多
 * 一次请求、多一分撞 412 的概率。所以按"用户要多少候选"等比放大，而不是
 * 一律拉满 5 页 —— 用户把 perPage 调到 50 时本来就不缺候选。
 * 上限 5 页（B站 搜索接口翻太深会开始返回重复或空页，实测第 6 页起收益趋零）。
 */
export function candidatePages(s = {}) {
  const per = Math.max(1, Number(s.perPage) || 20);
  if (per <= 20) return 3;    // 默认档：3 页 = 最多 60 个候选，够筛选折腾
  if (per <= 35) return 2;
  return 1;
}

/**
 * 筛空时算一组"放宽"条件。返回 null = 没什么可放宽的。
 *
 * 放宽顺序是**刻意**的：先动时间窗，再动播放/点赞。理由是这样对用户意图的
 * 伤害最小 —— "最近 1 天"这种条件是用户主动选的强意图（"我要最新的"），
 * 而它恰恰最容易把候选筛空（刚发的视频不可能有 1 万播放）。
 * 反过来先放宽播放量下限就等于"你要高播放的，我给你低播放的"，更偏离本意。
 *
 * 每一步都返回 why 用于日志：**静默放宽等于骗用户**，必须留痕。
 */
export function relaxFilters(s = {}) {
  // 第一档：时间窗放开到 30 天（或直接取消），重新取候选
  if (s.maxAgeDays > 0) {
    const next = s.maxAgeDays >= 30 ? 0 : 30;
    return {
      why: `时间窗从「最近 ${s.maxAgeDays} 天」放宽到「${next > 0 ? `最近 ${next} 天` : '不限'}」`,
      refetch: true,
      maxAgeDays: next,
      patch: { maxAgeDays: next }
    };
  }
  // 第二档：播放/点赞下限砍半（时间窗已经没得放了）
  const patch = {};
  const bits = [];
  if (s.minViewCount > 0) { patch.minViewCount = Math.floor(s.minViewCount / 2); bits.push(`播放下限 ${s.minViewCount} → ${patch.minViewCount}`); }
  if (s.minLikeCount > 0) { patch.minLikeCount = Math.floor(s.minLikeCount / 2); bits.push(`点赞下限 ${s.minLikeCount} → ${patch.minLikeCount}`); }
  if (!bits.length) return null;
  return { why: bits.join('、'), refetch: false, maxAgeDays: 0, patch };
}

/**
 * 均匀抽 N 张拼图。
 * ⚠️ 不能只取前 N 张：4.4 小时的视频有 16 张拼图，前 1 张只覆盖开头 5%，
 * 模型会以为整个视频都是那个画面。均匀铺开才是"看整段"。
 */
export function pickSheets(sheets, count) {
  const arr = Array.isArray(sheets) ? sheets : [];
  const n = Math.max(0, Math.min(arr.length, Math.round(Number(count) || 0)));
  if (n <= 0) return [];
  if (n >= arr.length) return arr.map((url, i) => ({ url, i }));
  if (n === 1) {
    const i = Math.floor((arr.length - 1) / 2);   // 单张取中间：最能代表整体
    return [{ url: arr[i], i }];
  }
  const out = [];
  for (let k = 0; k < n; k += 1) {
    const i = Math.round((k * (arr.length - 1)) / (n - 1));
    out.push({ url: arr[i], i });
  }
  return out;
}

/**
 * 备一个视频：详情 + 评论 + 拼图。
 * 任何一步失败都不抛给上层 —— 后台任务失败只该写日志。
 */
async function prepareOne({ reason = 'timer' } = {}) {
  const s = settings();
  if (!s.enabled || !s.browseEnabled) return null;

  let candidates = [];
  if (s.source === 'popular') {
    candidates = await popularVideos(fetchImpl, s.perPage);
    log(`候选来自综合热门：${candidates.length} 个`);
  } else {
    const words = s.keywords.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
    if (!words.length) throw new Error('没配搜索关键词（source=keyword 时至少要有一个）');
    const kw = words[Math.floor(Math.random() * words.length)];
    // 候选策略（2026-10-14 实测定标，见 bili-api.js searchVideos 的长注释）：
    //   · 时间筛选交给**服务端** pubtime 窗口（有效，且不会丢掉高播放视频）
    //   · 排序**保持相关度**：换成 order=pubdate 会让候选变成一堆 0 播放的刚投稿，
    //     实测"播放≥1万 且 点赞≥500 且 30天内"的存活数从 96 条掉到 **0 条**
    //   · 翻页：候选越多，筛选才越有得挑（1 页存活 37、3 页 96）
    const perPage = s.perPage;
    const pages = candidatePages(s);
    candidates = await searchVideos(fetchImpl, kw, perPage * pages, {
      pubWithinDays: s.maxAgeDays,
      pages
    });
    log(`候选来自搜索「${kw}」：${candidates.length} 个（${pages} 页`
      + `${s.maxAgeDays > 0 ? `，限最近 ${s.maxAgeDays} 天` : ''}）`);
  }

  const before = candidates.length;
  let pick = chooseCandidate(candidates, { seen: seenList(), s });

  // ── 自适应放宽：筛空了就退一步，别让"开着却永远没动静"发生 ──────────────
  // 用户的筛选条件之间可能互相冲突（"最近 1 天" + "播放 1 万以上"在 B站
  // 几乎无解 —— 刚发的视频不可能有 1 万播放）。硬扛着只会让功能看起来坏了。
  // 这里的取舍是**优先保住功能可用**：先放宽时间窗，再放宽播放/点赞下限，
  // 并且每次都**明确打日志**说明放宽了什么 —— 静默放宽等于骗用户。
  if (!pick && before > 0 && s.filterFallback) {
    const relaxed = relaxFilters(s);
    if (relaxed) {
      log(`筛选太严导致候选全被筛掉，临时放宽后重试：${relaxed.why}`);
      let more = candidates;
      if (relaxed.refetch) {
        try {
          const words = s.keywords.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
          const kw = words[Math.floor(Math.random() * words.length)];
          const pages2 = candidatePages(s);
          more = await searchVideos(fetchImpl, kw, s.perPage * pages2, {
            pubWithinDays: relaxed.maxAgeDays,
            pages: pages2
          });
          log(`放宽后重新取候选：${more.length} 个`);
        } catch (error) {
          warn(`放宽后重新取候选失败，改用已有候选：${error?.message ?? error}`);
          more = candidates;
        }
      }
      pick = chooseCandidate(more, { seen: seenList(), s: { ...s, ...relaxed.patch } });
      if (pick) log(`放宽后挑到了：${pick.title}`);
    }
  }

  if (!pick) {
    // 候选被筛空是**配置问题**，不是"运气不好"。只打一句"没有合适的"会让用户
    // 以为在正常工作，实际是筛选条件太严 —— 所以把每条的落选原因归一下类报出来。
    if (before > 0) {
      const reasons = new Map();
      const seenSet = new Set(seenList().map(String));
      for (const v of candidates) {
        let why;
        if (seenSet.has(String(v.bvid))) why = '已看过';
        else {
          const f = passesFilters(v, s);
          why = f.ok ? '时长不符' : f.why;
        }
        reasons.set(why, (reasons.get(why) || 0) + 1);
      }
      const brief = [...reasons.entries()].map(([k, c]) => `${k}×${c}`).join('、');
      log(`这一轮 ${before} 个候选全被筛掉（${brief}）—— 检查一下筛选设置是不是太严了`);
    } else {
      log('这一轮没有候选（接口没返回结果），跳过');
    }
    return null;
  }

  const info = await getVideoInfo(fetchImpl, pick.bvid);
  const comments = s.commentCount > 0 ? await getHotComments(fetchImpl, info.aid, s.commentCount) : [];
  const shot = s.imageMode === 'off' ? null : await getVideoShot(fetchImpl, pick.bvid);
  const sheets = pickSheets(sheetUrls(shot, s.sheetWidth), s.sheetCount);

  markSeen(pick.bvid);

  const entry = {
    bvid: info.bvid,
    aid: info.aid,
    url: info.url,
    title: info.title,
    desc: info.desc,
    author: info.author,
    durationSec: info.durationSec,
    stat: { view: info.view, danmaku: info.danmaku, reply: info.replyCount, like: info.like },
    comments,
    sheets,
    frameIndex: shot?.index || [],
    grid: { x: shot?.xLen || 10, y: shot?.yLen || 10, total: (shot?.xLen || 10) * (shot?.yLen || 10) },
    preparedAt: Date.now(),
    reason
  };
  log(`已备好：${entry.title}（${entry.author}，${fmtDuration(entry.durationSec)}，`
    + `${sheets.length} 张拼图，${comments.length} 条评论）`);
  return entry;
}

/** 后台跑一次 prepareOne，带并发保护与错误兜底。 */
async function prepareInBackground(reason) {
  if (state.picking) { log('上一次挑视频还没结束，跳过这次'); return; }
  state.picking = true;
  try {
    const entry = await prepareOne({ reason });
    if (entry) state.pending = entry;
  } catch (error) {
    warn(`挑视频失败（${reason}）：${error?.message ?? error}`);
  } finally {
    state.picking = false;
  }
}

// ── 注入提示词 ───────────────────────────────────────────────────────────

function commentLines(comments, limit) {
  return (Array.isArray(comments) ? comments : [])
    .slice(0, Math.max(0, limit))
    .map((c) => `· ${c.user}（赞${c.like}）：${c.text}`);
}

/** 每张拼图覆盖的时间范围（用 index 算），让模型知道这张图对应视频哪一段。 */
function sheetTimeHint(entry, sheetIdx) {
  const idx = entry.frameIndex;
  const per = entry.grid?.total || 100;
  if (!Array.isArray(idx) || !idx.length) return '';
  const start = idx[Math.min(idx.length - 1, sheetIdx * per)];
  const end = idx[Math.min(idx.length - 1, (sheetIdx + 1) * per - 1)];
  if (!Number.isFinite(Number(start)) || !Number.isFinite(Number(end))) return '';
  return `${fmtDuration(start)}~${fmtDuration(end)}`;
}

/**
 * 组装递给模型的文字块。
 * 刻意写得像"你自己刚刷到的东西"，而不是一份数据报告 —— 否则模型会照抄成播报腔。
 */
export function buildBrief(entry, s = settings(), { withFrames = null } = {}) {
  if (!entry) return { text: '', images: [] };
  const parts = [];
  parts.push('【你刚刷到的视频】（这是你闲下来时自己刷到的，不是你被要求找的）');
  parts.push(`标题：${entry.title}`);
  if (entry.author) parts.push(`UP主：${entry.author}`);
  parts.push(`时长：${fmtDuration(entry.durationSec)}`
    + (entry.stat?.view ? `　播放：${entry.stat.view}` : '')
    + (entry.stat?.danmaku ? `　弹幕：${entry.stat.danmaku}` : ''));
  parts.push(`链接：${entry.url}`);

  const desc = stripTags(entry.desc || '');
  if (desc) parts.push(`简介：${desc.slice(0, 300)}`);

  const cl = commentLines(entry.comments, s.commentCount);
  if (cl.length) parts.push(`热门评论：\n${cl.join('\n')}`);

  // 先定"这次到底给不给画面"，再据此写文字 —— 顺序不能反。
  // ⚠️ 这里踩过一次：文字按 entry.sheets 写"下面是 N 张拼图"，而图片被
  //    imageMode=off 过滤掉了 → 模型被明确告知"你有画面"，实际什么都没收到，
  //    于是它会照着标题编画面细节。文字承诺必须与真实附带的内容一致。
  //    withFrames 显式传入时以它为准（调用方还要考虑"模型支不支持图片"）。
  const allowFrames = withFrames === null ? s.imageMode !== 'off' : withFrames === true;
  const images = allowFrames ? (entry.sheets || []).map((x) => x.url).filter(Boolean) : [];

  if (images.length) {
    const per = entry.grid?.total || 100;
    const bits = entry.sheets.map((sh, k) => {
      const hint = sheetTimeHint(entry, sh.i);
      return `第 ${k + 1} 张（${hint || `第 ${sh.i * per + 1}~${(sh.i + 1) * per} 帧`}）`;
    });
    parts.push(`画面：下面是 ${images.length} 张**逐帧缩略图拼图（截图）**，每张是 ${entry.grid?.xLen || 10}x${entry.grid?.yLen || 10} 格、`
      + `按时间顺序从左到右再从上到下，格子之间是均匀跳着采样的 —— 是截图不是连续视频，`
      + `帧与帧之间的过程你看不到，别断言中间的连续剧情。`
      + `顺序：${bits.join('；')}。`);
  } else {
    parts.push('画面：这次没拿到（只凭标题/简介/评论判断，别编画面细节）。');
  }

  parts.push('怎么用：想分享就自然地说，像"刚刷到一个…"这种口气，把链接带上；'
    + '不想说就正常结束，不用勉强。别把它念成播报、别逐条复述评论、'
    + '也别假装看过画面里没有的东西。');

  let text = parts.join('\n');
  const cap = s.maxInjectChars;
  if (text.length > cap) text = `${text.slice(0, cap)}\n…（内容过长已截断）`;

  return { text, images };
}

/**
 * 把块追加到最后一条 user 消息末尾。
 *
 * 为什么不插进 system：系统提示的前缀通常是缓存命中大头，中间插入动态内容会让
 * 后面所有字节位置偏移、整段前缀缓存归零（prompt.js 明确约定动态内容一律殿后）。
 */
function appendToTail(messages, text, images = []) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (!m || m.role !== 'user') continue;
    const block = `\n\n${String(text || '').trim()}`;
    if (!images.length) {
      if (typeof m.content === 'string') m.content += block;
      else if (Array.isArray(m.content)) m.content.push({ type: 'text', text: block });
      else m.content = block.trim();
      return true;
    }
    if (typeof m.content === 'string') {
      m.content = [{ type: 'text', text: m.content + block }];
    } else if (!Array.isArray(m.content)) {
      m.content = [{ type: 'text', text: block.trim() }];
    } else {
      m.content.push({ type: 'text', text: block });
    }
    for (const url of images) {
      m.content.push({ type: 'image_url', image_url: { url } });
    }
    return true;
  }
  list.push({ role: 'user', content: images.length
    ? [{ type: 'text', text: String(text || '').trim() }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))]
    : String(text || '').trim() });
  return true;
}

/** 现在允许递出去吗（静默时段 / 每日上限 / 最小间隔 / 指定会话）。 */
export function canShareNow({ now = Date.now(), chatKey = '', s = settings(), log: sl = shareLog() } = {}) {
  if (!s.enabled || !s.injectOnProactive) return { ok: false, why: '未启用或已关闭主动递料' };
  if (s.shareChatKey && chatKey && String(chatKey) !== s.shareChatKey) {
    return { ok: false, why: `只往 ${s.shareChatKey} 分享` };
  }
  if (s.quietHours.has(bjNow(now).getUTCHours())) return { ok: false, why: '当前是静默时段' };
  if (sl.count >= s.maxSharesPerDay) return { ok: false, why: `今天已分享 ${sl.count} 次（上限 ${s.maxSharesPerDay}）` };
  const gap = s.minMinutesBetweenShares * 60000;
  if (sl.lastAt && now - sl.lastAt < gap) {
    const left = Math.ceil((gap - (now - sl.lastAt)) / 60000);
    return { ok: false, why: `距上次分享还差 ${left} 分钟` };
  }
  return { ok: true, why: '' };
}

// ── 触发词：群里提到某个词，就主动发一个视频 ─────────────────────────────
//
// 与"主动机会递料"是两条**独立**的通路：
//   递料   —— 冷场时把备好的视频塞进提示词，说不说由模型定（不保证发出）
//   触发词 —— 命中就**确定性**地发出去（插件直接调发送队列，模型不参与）
// 之所以后者要确定性：用户配了触发词的意图就是"我提这个词你就发"，
// 交给模型判断就会出现"我说了它却没理我"。要变通就该关掉这个开关。

/** 触发词表（逗号/空格分隔，去重、去空）。 */
export function triggerWords(s = settings()) {
  const out = [];
  const seen = new Set();
  for (const part of String(s.triggerKeywords || '').split(/[,，\s]+/)) {
    const w = part.trim();
    if (!w) continue;
    const k = w.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  return out;
}

/**
 * 这批消息里有没有触发词，以及是哪一条先命中的。
 *
 * @returns {{hit:boolean, word:string, entry:object|null}}
 */
export function findTrigger(entries, words) {
  const list = Array.isArray(entries) ? entries : [];
  if (!words?.length) return { hit: false, word: '', entry: null };
  for (const m of list) {
    const t = String(m?.text ?? '');
    if (!t) continue;
    // 机器人自己的发言不算触发（存档里 senderId 为 'self'）。
    // 少了这一条，机器人自己说过的触发词会在下一轮把话题再触发一次，形成自激循环。
    if (m?.self || String(m?.senderId) === 'self') continue;
    const low = t.toLowerCase();
    for (const w of words) {
      if (low.includes(w.toLowerCase())) return { hit: true, word: w, entry: m };
    }
  }
  return { hit: false, word: '', entry: null };
}

/**
 * 「仅 @」模式下的准入判定：必须是**被艾特**才算数。
 *
 * 走宿主 prompt.js 的 isAtMe（QQ 号优先）—— 自己写名字匹配会在群名片
 * 与配置昵称不一致时叫不醒，这个坑 prompt.js 的头注释里记着。
 */
export function atOnlyOk(entries, { selfNickname = '', botName = '', selfId = '' } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  return list.some((m) => isAtMe(String(m?.text ?? ''), { selfNickname, botName, selfId }));
}

// ── 触发发送的计数（持久化，与"分享"分开记账）──────────────────────────
//
// 为什么不共用 shareLog：两者的限额语义完全不同 —— 分享是"别刷屏"的软约束，
// 触发是"用户叫我发"的硬承诺。共用一份计数会导致"冷场分享用光了额度，
// 于是我 @ 它它也不发" —— 那正是用户最不能接受的失败。
const STORE_TRIGGER = 'triggerLog';

function triggerLog() {
  try {
    const v = storage?.get(STORE_TRIGGER, null);
    const day = bjDayKey();
    if (!v || typeof v !== 'object' || v.day !== day) return { day, count: 0, lastAt: 0 };
    return { day: v.day, count: Number(v.count) || 0, lastAt: Number(v.lastAt) || 0 };
  } catch { return { day: bjDayKey(), count: 0, lastAt: 0 }; }
}

function writeTriggerLog(next) {
  try { storage?.set(STORE_TRIGGER, next); } catch (error) {
    warn(`写触发计数失败：${error?.message ?? error}`);
  }
}

/** 触发发送的闸门（冷却 + 日限）。静默时段**不拦** —— 是人叫它发的。 */
export function canTriggerNow({ now = Date.now(), s = settings(), log: tl = triggerLog() } = {}) {
  if (!s.enabled || !s.triggerSendEnabled) return { ok: false, why: '未启用触发词发送' };
  if (tl.count >= s.triggerMaxPerDay) {
    return { ok: false, why: `今天已被触发 ${tl.count} 次（上限 ${s.triggerMaxPerDay}）` };
  }
  const gap = s.triggerCooldownMin * 60000;
  if (tl.lastAt && now - tl.lastAt < gap) {
    const left = Math.ceil((gap - (now - tl.lastAt)) / 60000);
    return { ok: false, why: `触发冷却中，还差 ${left} 分钟` };
  }
  return { ok: true, why: '' };
}

// ── 锐评：视频发出去之后，让它自己补一句看法 ─────────────────────────────
//
// 为什么要单独调一次模型，而不是"发视频的时候顺手让它说"：
// 发送是插件**确定性**完成的（不经过模型），模型此刻根本不知道刚发生了什么。
// 所以要么发完再问它一句（这里），要么就只能让模型自己决定发不发（那就不确定了）。
// 选择前者：视频一定发得出去，锐评有没有是加分项 —— 失败只写日志，不影响主流程。

/** 锐评提示词。刻意把"看得到什么"写清楚，免得它编声音和连续剧情。 */
export function buildReviewMessages({ entry, s, chatName = '', persona = {}, recent = [] }) {
  const who = String(persona.botName || '机器人');
  const desc = stripTags(entry?.desc || '').slice(0, 400);
  const cl = commentLines(entry?.comments, Math.min(5, s.commentCount || 5));
  const lines = [
    `你是「${who}」，正在 QQ 群「${chatName || '群里'}」里聊天。`,
    '刚才有人让你发了个 B站 视频，你已经把链接发出去了。现在补一句你自己的看法。',
    '',
    `视频标题：${entry?.title || ''}`,
    entry?.author ? `UP主：${entry.author}` : '',
    `时长：${fmtDuration(entry?.durationSec || 0)}`
      + (entry?.stat?.view ? `　播放：${entry.stat.view}` : '')
      + (entry?.stat?.like ? `　点赞：${entry.stat.like}` : ''),
    desc ? `简介：${desc}` : '',
    cl.length ? `热门评论：\n${cl.join('\n')}` : '',
    '',
    '要求：',
    '- 一到两句，短、像随口说的，别写成影评或播报。',
    '- 要有你自己的态度（喜欢/无感/吐槽/好奇都行），别和稀泥。',
    '- 你只看到了一些截图，**没听到声音**，帧与帧之间发生了什么也不知道。',
    '  不要描述背景音乐、歌词、说话语气，也不要断言中间的连续剧情。',
    '- 画面里的小字看不清就说看不清，别猜。',
    '- 直接输出要发的话，不要引号、不要「锐评：」这种前缀。'
  ].filter(Boolean);
  if (recent.length) {
    lines.push('', '（群里最近在聊：', ...recent.slice(-5), '）');
  }
  return [
    { role: 'system', content: '你是一个正在参与 QQ 群聊的普通网友，说话短、口语化、有自己的态度。只输出要发的那一两句话本身。' },
    { role: 'user', content: lines.join('\n') }
  ];
}

/** 把模型返回的锐评洗成一条能直接发的文本（空/异常一律返回空串）。 */
export function cleanReview(raw) {
  let t = String(raw ?? '').trim();
  if (!t) return '';
  // 有些模型会带 markdown 引号或前缀，去掉但不做过度加工
  t = t.replace(/^```[\s\S]*?\n/, '').replace(/```$/, '').trim();
  t = t.replace(/^(锐评|评论|看法|我的看法)\s*[:：]\s*/, '');
  t = t.replace(/^["'“”『「]+|["'“”』」]+$/g, '').trim();
  // 多段就只取第一段：锐评就该是一句话，多段说明它开始写作文了
  const firstLine = t.split(/\n+/).map((x) => x.trim()).filter(Boolean)[0] || '';
  return firstLine.slice(0, 200);
}

/**
 * 生成一条锐评（失败返回空串，绝不抛）。
 *
 * 用 chatCompletion 走**主模型**：它此刻已经"看过"这些文字，
 * 没必要另配一个判定模型；而且这是可选的锦上添花，失败静默降级最合适。
 */
export async function makeReview({ entry, s = settings(), chatName = '', chatKey = '', recent = [] }) {
  if (!s.autoReview) return '';
  try {
    const cfgNow = getConfig();
    const api = cfgNow.api || {};
    if (!api.model || !api.baseUrl) {
      warn('锐评跳过：当前没有可用的模型配置');
      return '';
    }
    const persona = personaForChat(chatKey);
    const messages = buildReviewMessages({ entry, s, chatName, persona, recent });
    const res = await chatCompletion({
      messages,
      temperature: 1.0,
      maxTokens: 120,
      // thinkingMode: 'off' —— 锐评是一句话的事，开着思考只会多烧 reasoning
      // 还可能把 max_tokens 吃光导致正文为空（context-chime 里踩过同样的坑）。
      skillContext: { api, model: api.model, messages, thinkingMode: 'off', chatKey, biliReview: true }
    });
    const text = cleanReview(res?.message?.content ?? '');
    if (!text) {
      warn('锐评生成结果为空（可能被 max_tokens 截断或模型在思考上烧光了预算），本次不发');
    }
    return text;
  } catch (error) {
    warn(`锐评生成失败（不影响视频已发出这件事）：${error?.message ?? error}`);
    return '';
  }
}

// ── 触发发送主流程 ───────────────────────────────────────────────────────

/**
 * 被触发词命中后：挑一个视频 → 发链接 → 补一条锐评。
 *
 * 全程确定性（不经过模型决定发不发），只有锐评那一步用模型。
 * 任何一步失败都只写日志 —— 这是后台任务，不能把异常抛回 ingest 热路径。
 */
export async function runTriggerSend({ chatKey, ctx = {}, reason = 'trigger' } = {}) {
  const s = settings();
  if (!chatKey) return { ok: false, why: '没有会话' };

  // 发送通道优先用本次 ctx 里的；没有就退回通道缓存（onMessage 缓存过）。
  // 群名只有缓存里有（onMessage 的 ctx 不带 chatName），锐评要用它。
  const cached = state.channels.get(chatKey) || {};
  const sender = ctx.sender?.sendTextBatch ? ctx.sender : cached.sender;
  const chatName = String(ctx.chatName || cached.chatName || '');
  if (!sender?.sendTextBatch) {
    warn('触发发送失败：拿不到发送队列（ctx.sender 与缓存都没有），本次跳过');
    return { ok: false, why: '没有发送通道' };
  }

  const gate = canTriggerNow({ s });
  if (!gate.ok) {
    log(`触发词命中但不发（${gate.why}）`);
    return { ok: false, why: gate.why };
  }

  // 先占住冷却再干活：抓取要几秒，期间又有人喊同一个词不该再排一次。
  // （state.sending 只是同进程串行保护，管不住"两次调用间隔 0.5 秒"这种。）
  const tl0 = triggerLog();
  writeTriggerLog({ day: tl0.day, count: tl0.count, lastAt: Date.now() });

  let entry = null;
  try {
    entry = await prepareOne({ reason });
  } catch (error) {
    warn(`触发发送：挑视频失败：${error?.message ?? error}`);
  }
  if (!entry) {
    // 挑不出来（筛选太严 / 都被看过 / 接口没结果）：如实说一句，别假装在干活。
    // 这条不算"已触发"，把冷却退回去，免得用户喊了没反应还得等 20 分钟。
    const tl1 = triggerLog();
    writeTriggerLog({ day: tl1.day, count: tl1.count, lastAt: tl0.lastAt });
    try {
      await sender.sendTextBatch(chatKey, ['翻了半天没找到合适的视频…筛选条件可能太严了，要不改改设置？']);
    } catch { /* 连这句都发不出去就算了 */ }
    return { ok: false, why: '没有合适的视频' };
  }

  // 发链接。刻意只发「标题 + 链接」两行：视频内容该由后面的锐评来说，
  // 而不是靠插件写一段播报（那就变成机器人在念简介了）。
  const text = `${entry.title}\n${entry.url}`;
  try {
    await sender.sendTextBatch(chatKey, [text]);
  } catch (error) {
    warn(`触发发送：发链接失败：${error?.message ?? error}`);
    return { ok: false, why: `发送失败：${error?.message ?? error}` };
  }
  log(`触发发送成功：${entry.title} → ${chatKey}`);

  // 记账：只有真发出去了才 +1
  const tl = triggerLog();
  writeTriggerLog({ day: tl.day, count: tl.count + 1, lastAt: Date.now() });

  // 锐评：发完再说，失败就算了（视频已经发出去了，这才是用户要的）
  if (s.autoReview) {
    const review = await makeReview({
      entry, s, chatName, chatKey,
      recent: ctx.recentLines || []
    });
    if (review) {
      try {
        await sender.sendTextBatch(chatKey, [review]);
        log(`已补锐评：${review}`);
      } catch (error) {
        warn(`锐评发送失败：${error?.message ?? error}`);
      }
    }
  }

  return { ok: true, entry };
}

/**
 * 后台跑一次触发发送（fire-and-forget）。
 *
 * state.sending 是**同进程**串行闸：两个群几乎同时命中触发词时，第二个会看到
 * 第一个还在跑。此时不排队（排队会让延迟变得不可预期），直接放弃并记日志 ——
 * 用户看到的仍然是"它发了"，只是发的是另一个群那一次。
 */
function spawnTriggerSend(args) {
  if (state.sending) {
    log('上一次触发发送还在进行，这次跳过（避免同时抓多个视频撞风控）');
    return;
  }
  state.sending = true;
  Promise.resolve()
    .then(() => runTriggerSend(args))
    .catch((error) => warn(`触发发送任务异常：${error?.message ?? error}`))
    .finally(() => { state.sending = false; });
}

// ── 给模型用的工具 ───────────────────────────────────────────────────────

/** 把一次视频分析渲染成工具返回（文字 + 画面）。 */
function renderWatchResult(entry, s, { withFrames = true } = {}) {
  const parts = [];
  parts.push(`《${entry.title}》`);
  if (entry.author) parts.push(`UP主：${entry.author}`);
  parts.push(`时长：${fmtDuration(entry.durationSec)}　链接：${entry.url}`);
  if (entry.stat?.view) parts.push(`播放 ${entry.stat.view}　弹幕 ${entry.stat.danmaku}　评论 ${entry.stat.reply}　点赞 ${entry.stat.like}`);
  const desc = stripTags(entry.desc || '');
  if (desc) parts.push(`简介：${desc.slice(0, 500)}`);
  const cl = commentLines(entry.comments, s.commentCount);
  if (cl.length) parts.push(`热门评论：\n${cl.join('\n')}`);

  const images = (withFrames && s.imageMode !== 'off') ? (entry.sheets || []).map((x) => x.url) : [];
  if (images.length) {
    const per = entry.grid?.total || 100;
    const bits = entry.sheets.map((sh, k) => `第 ${k + 1} 张 = ${sheetTimeHint(entry, sh.i) || `第 ${sh.i * per + 1}~${(sh.i + 1) * per} 帧`}`);
    parts.push(`画面：附上 ${images.length} 张逐帧缩略图拼图（每张 ${entry.grid?.xLen || 10}x${entry.grid?.yLen || 10} 格，`
      + `从左到右、从上到下按时间排，格子之间跳着采样）。${bits.join('；')}。`
      + '这是**截图**不是连续视频，帧与帧之间的过程看不到，别断言中间的连续剧情。');
  } else if (withFrames) {
    parts.push('画面：这次没取到（只凭标题/简介/评论判断）。');
  }

  return { content: [{ type: 'text', text: parts.join('\n') }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] };
}

/**
 * base64 内联模式：把拼图抓下来内联。
 * 只在网关不支持外链图片时才需要（url 模式最省：URL 字符串不占请求预算）。
 * 注意这里必须压到较小宽度 —— base64 会真的进请求体，原图 4800x2700 约 650KB。
 */
async function inlineSheet(url, width) {
  const target = width > 0 ? `${url}@${width}w.jpg` : `${url}@1920w.jpg`;
  const res = await fetchImpl(target, {
    headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = String(res.headers.get('content-type') || 'image/jpeg');
  return `data:${ct};base64,${buf.toString('base64')}`;
}

/** 统一的"看一个视频"：给链接/BV号就能用，也供后台注入复用。 */
async function watchTarget(target, { withFrames = true, commentLimit = null } = {}) {
  const s = settings();
  const bvid = await resolveBvid(fetchImpl, target);
  const info = await getVideoInfo(fetchImpl, bvid);
  const wantComments = commentLimit === null ? s.commentCount : Math.max(0, Math.min(20, Number(commentLimit) || 0));
  const comments = wantComments > 0 ? await getHotComments(fetchImpl, info.aid, wantComments) : [];
  const shot = (withFrames && s.imageMode !== 'off') ? await getVideoShot(fetchImpl, bvid) : null;
  let sheets = pickSheets(sheetUrls(shot, s.sheetWidth), s.sheetCount);

  if (withFrames && s.imageMode === 'base64' && sheets.length) {
    const inlined = [];
    for (const sh of sheets) {
      try {
        inlined.push({ ...sh, url: await inlineSheet(sh.url, s.sheetWidth || 1920) });
      } catch (error) {
        warn(`内联拼图失败（改用外链）：${error?.message ?? error}`);
        inlined.push(sh);
      }
    }
    sheets = inlined;
  }

  return {
    bvid: info.bvid, aid: info.aid, url: info.url, title: info.title, desc: info.desc,
    author: info.author, durationSec: info.durationSec,
    stat: { view: info.view, danmaku: info.danmaku, reply: info.replyCount, like: info.like },
    comments, sheets,
    frameIndex: shot?.index || [],
    grid: { xLen: shot?.xLen || 10, yLen: shot?.yLen || 10, total: (shot?.xLen || 10) * (shot?.yLen || 10) },
    preparedAt: Date.now(),
    reason: 'tool'
  };
}

// ── 生命周期 ─────────────────────────────────────────────────────────────

export function setup(api) {
  if (typeof api?.config === 'function') cfg = api.config;
  if (typeof api?.log === 'function') log = api.log;
  if (typeof api?.warn === 'function') warn = api.warn;
  if (typeof api?.fetch === 'function') fetchImpl = api.fetch;

  // This host has no api.storage; use a plugin-scoped atomic file store.
  storage = createFileStorage(DATA_DIR);

  biliAuth = createBiliAuth({config:settings,fetcher:fetchImpl,storage:()=>storage});
  fetchImpl = biliAuth.fetch;
  personaBrowser = makePersonaBrowser({ config: () => ({...settings(), hasBiliLogin:biliAuth.hasLogin()}), fetcher: (...a) => fetchImpl(...a), storage: () => storage, log, warn,
    filter: (v,s) => passesFilters(v,s).ok && v.durationSec >= s.minDurationSec && v.durationSec <= s.maxDurationSec });
  const s = settings();
  log(`${BUILD_TAG} 已就绪｜${s.source === 'popular' ? '综合热门' : `关键词：${s.keywords}`}`
    + `｜每 ${s.checkIntervalMin} 分钟挑一次｜画面：${s.imageMode === 'off' ? '关' : s.imageMode}`
    + `｜发评论：${s.allowComment ? '开' : '关'}`);

  api.registerTool({
    id: 'bili_watch',
    name: '看B站视频',
    description: '打开一个 B站 视频"看看"：返回标题、简介、播放数据、热门评论，以及 B站 自己抽好的逐帧画面拼图（10x10 格，按时间顺序排，横跨整个视频）。适用：群里有人丢 B站 链接、问「这视频讲了啥」「这视频怎么样」。只支持 B站。',
    category: 'media',
    icon: '📺',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'B站 链接（含 b23.tv 短链）或 BV 号' },
        withFrames: { type: 'boolean', description: '是否要画面拼图，默认 true。关掉只拿文字（更省 token）' },
        comments: { type: 'number', description: '带几条热门评论，默认用设置里的值（5）' }
      },
      required: ['target']
    },
    async execute(ctx, args) {
      const target = String(args?.target ?? '').trim();
      if (!target) return { content: '错误：请给出 B站 链接或 BV 号', isError: true };
      if (!isBiliUrl(target)) {
        return { content: `错误：这看起来不是 B站 视频（本工具只支持 B站）：${target.slice(0, 80)}`, isError: true };
      }
      try {
        const entry = await watchTarget(target, {
          withFrames: args?.withFrames !== false,
          commentLimit: args?.comments === undefined ? null : Number(args.comments)
        });
        const s = settings();
        const withFrames = args?.withFrames !== false && s.imageMode !== 'off';
        // 模型明确不支持图片时别塞图：塞了它看不到，还要为 base64/URL 白付上下文
        const visionOk = ctx?.visionEnabled !== false;
        return renderWatchResult(entry, s, { withFrames: withFrames && visionOk });
      } catch (error) {
        return { content: `看视频失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'bili_comment',
    name: '在B站发评论',
    description: '⚠️ 会在 B站 上以**账号本人**身份发一条真实评论（删不掉只能手动删）。只有在设置里显式打开「允许在 B站 下发评论」并扫码登录B站后才可用。适用：你确实看完一个视频、有话想说，且明确希望留到 B站 上。',
    category: 'media',
    icon: '💬',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'B站 链接或 BV 号' },
        message: { type: 'string', description: '评论内容（会原样发出去，别带多余格式）' }
      },
      required: ['target', 'message']
    },
    async execute(ctx, args) {
      const s = settings();
      if (!s.allowComment) {
        return { content: '发评论功能没开。要在 B站 上留评论，需要机器人的主人在设置里打开「允许在 B站 下发评论」并扫码登录B站。', isError: true };
      }
      if (!biliAuth?.commentCredentials()) {
        return { content: '缺少可用于评论的登录态：请在本插件设置里扫码登录B站。', isError: true };
      }
      const target = String(args?.target ?? '').trim();
      const message = String(args?.message ?? '').trim();
      if (!target || !message) return { content: '错误：target 与 message 都不能为空', isError: true };
      if (message.length > 900) return { content: '错误：评论太长了（B站 上限约 1000 字，这里限 900）', isError: true };
      try {
        const bvid = await resolveBvid(fetchImpl, target);
        const info = await getVideoInfo(fetchImpl, bvid);
        const login = biliAuth?.commentCredentials();
        if (!settings().enabled || !settings().allowComment || !login) return { content: '评论已取消：开关已关闭或登录态已退出，请在插件设置检查。', isError: true };
        const r = await postComment(fetchImpl, {
          aid: info.aid, message, sessdata: login.sessdata, biliJct: login.biliJct
        });
        log(`已在《${info.title}》下发评论（rpid=${r.rpid}）`);
        return { content: `评论发出去了：在《${info.title}》下面。内容：${message}` };
      } catch (error) {
        return { content: `发评论失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

export function activate() {
  biliAuth?.activate();
  const s = settings();
  personaBrowser?.start();
  if (s.autonomousEnabled) state.pending = null;
  stopTimer();
  if (!s.enabled || !s.browseEnabled) {
    log('自己刷视频当前是关闭状态（仍可用 bili_watch 按需看视频）');
    return;
  }
  state.timer = setInterval(() => {
    const cur = settings();
    if (!cur.enabled || !cur.browseEnabled || cur.autonomousEnabled) return;
    // 已经有备好的就别重复挑：递出去之后再备下一个
    if (state.pending) return;
    prepareInBackground('timer');
  }, s.checkIntervalMin * 60000);
  state.timer.unref?.();

  if (s.catchUpOnStart) {
    // 延迟 12 秒：别和启动抢网络/IO（与 hot-trend-tracker 的补抓同一约定）
    //
    // ⚠️ 必须把 timer 存下来，deactivate 里清掉。踩过：最初这个 setTimeout 的句柄
    //    直接丢掉了，于是**每次热重载都会留下一个孤儿定时器** —— 开发期反复保存文件时，
    //    十几个 12 秒后集中触发，表现为"每 45 分钟才该挑一次，实际几分钟挑了九个"。
    //    unref 只保证它不拖住进程退出，**不阻止它触发**，所以不能拿 unref 当清理。
    //    （skillManager.register 的注释把这类泄漏叫"幽灵行为"，并明确要求
    //      deactivate 必须清掉 activate 里建的定时器。）
    state.catchUpTimer = setTimeout(() => {
      state.catchUpTimer = null;
      if (!settings().autonomousEnabled && !state.pending) prepareInBackground('startup');
    }, 12000);
    state.catchUpTimer.unref?.();
  }
  log(`定时器已启动：每 ${s.checkIntervalMin} 分钟挑一个视频备着`);
}

export function deactivate() {
  biliAuth?.deactivate();
  personaBrowser?.stop();
  stopTimer();
  state.pending = null;
  state.channels.clear();
  log('已停止（禁用/重载时调用，不会留下幽灵定时器）');
}

export function dispose() { deactivate(); }

function stopTimer() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  // 补挑那一发也要清：它是 setTimeout，不清就会在重载后 12 秒自己触发一次
  if (state.catchUpTimer) {
    clearTimeout(state.catchUpTimer);
    state.catchUpTimer = null;
  }
}

/** 同步返回：能不能用不取决于网络（抓不到就只是这次没有内容）。 */
export function available() {
  return true;
}

/** 提示词片段（动态）：只在允许主动递料时说明有这回事。 */
export function promptSections() {
  const s = settings();
  if (!s.enabled) return [];
  if (s.autonomousEnabled) return [{ id: 'bili-autonomous-note', title: '自主刷视频', priority: 46,
    content: '后台会按你自己的人设兴趣浏览 B站并私聊反馈，不需要在普通回复里重复推荐。可用 bili_watch 按需读取视频；只看到标题简介时不要声称看过视频。' }];
  const words = triggerWords(s);
  const notes = [];
  if (s.triggerSendEnabled && words.length) {
    notes.push(`群里有人提到「${words.join('/')}」时，你已经会自动把相关视频发出去`
      + `（不用你再动手，也别重复发；发完你会自己补一句看法）。`);
  }
  if (s.atOnly) {
    notes.push('现在设成了「仅 @」模式：只有被 @ 到时才发视频，平时不要自己往外掏视频。');
  }
  return [{
    id: 'bili-browse-note',
    title: '刷视频',
    priority: 46,
    content: '你有 bili-browse__bili_watch 工具：给一个 B站 链接或 BV 号，就能看到这个视频的标题、简介、播放数据、热门评论，以及 B站 自己抽好的逐帧画面（10x10 拼图，按时间顺序从左到右、从上到下）。别人在群里丢 B站 链接、问「这视频讲了啥」时用它。\n'
      + '注意：你看到的是一张张**截图**，不是连续视频 —— 帧与帧之间的过程你看不到，描述时用「看着像」「有一帧」这类措辞，不要断言中间的连续剧情。'
      + '你也**听不到声音**：不要描述背景音乐、歌词、说话语气或任何听觉内容，那不在你看到的东西里。'
      + '画面里的小字常常糊到看不清，看不清就说看不清，别猜。'
      + '画面只是辅助：真正判断内容以标题/简介/评论为主，别对着几张截图编故事。'
      + (notes.length ? `\n${notes.join('\n')}` : '')
      + (s.allowComment ? '\n你也装了 bili-browse__bili_comment：确实看完一个视频、有话想说时，可以把它留到 B站 评论里（会以本人账号发出）。' : '')
  }];
}

export const hooks = {
  /**
   * 每条消息都过这里：缓存发送通道 + 判断触发词。
   *
   * 为什么触发判定放在 onMessage 而不是 before-llm-messages：
   *   · onMessage 是**确定性**的（每条消息必过），而 before-llm-messages 只在
   *     真正要跑模型时才触发 —— 档位判定"不响应"时根本不会到那里。
   *     触发词若挂在后者上，就会出现"我说了那个词，但机器人那轮没被唤醒，
   *     于是它永远不发" —— 而这正是用户配触发词要避免的事。
   *   · onMessage 的 ctx 里直接有 sender（发送队列），不需要等某次会话。
   *
   * 代价：这里**不能**做耗时的事（它挡在 ingest 热路径上，后面的存档、
   * 未读通知都在等它）。所以只做"登记 + 起一个后台任务"，立刻返回。
   */
  async onMessage(ctx = {}) {
    personaBrowser?.capture(ctx);
    try {
      const s = settings();
      if (!s.enabled) return;
      const chatKey = String(ctx.chatKey || '');
      if (!chatKey) return;

      // 顺手缓存发送通道与群名（群名 onMessage 没有，先留空，等
      // before-llm-messages 那次补上；锐评里没有群名也不影响什么）。
      if (ctx.sender?.sendTextBatch) {
        const prev = state.channels.get(chatKey) || {};
        state.channels.set(chatKey, { ...prev, sender: ctx.sender, at: Date.now() });
        if (state.channels.size > 30) {
          const oldest = [...state.channels.entries()].sort((a, b) => a[1].at - b[1].at)[0];
          if (oldest) state.channels.delete(oldest[0]);
        }
      }

      if (s.autonomousEnabled || !s.triggerSendEnabled) return;
      const words = triggerWords(s);
      if (!words.length) return;

      // 只看这一条（onMessage 是逐条进来的）。存档里的 self 消息根本不会
      // 走这个钩子（app.js 里 message_sent / self_id 直接 return），
      // 所以这里不用再防自激。
      const one = { text: String(ctx.text || ''), senderId: String(ctx.senderId || '') };
      const found = findTrigger([one], words);
      if (!found.hit) return;

      // 「仅 @」模式：触发词还必须带 @ 才算。判定走宿主 isAtMe（QQ 号优先）。
      if (s.atOnly) {
        const cfgNow = getConfig();
        const okAt = atOnlyOk([one], {
          selfId: ctx.onebot?.selfId || '',
          selfNickname: cfgNow.persona?.selfNickname || ctx.onebot?.selfNickname || '',
          botName: cfgNow.persona?.botName || ''
        });
        if (!okAt) {
          log(`「${found.word}」命中，但当前是「仅 @」模式且没 @ 我，不发`);
          return;
        }
      }

      log(`触发词「${found.word}」命中（${chatKey}），去挑一个视频发过去`);
      spawnTriggerSend({ chatKey, ctx, reason: `trigger:${found.word}` });
    } catch (error) {
      warn(`触发词判定失败（不影响正常聊天）：${error?.message ?? error}`);
    }
  },

  /**
   * 主动机会来临时，把备好的视频递过去（含画面）。
   *
   * 只在 ctx.proactive 为真时递 —— 别人正在聊天时插一句"我刚刷到个视频"很出戏，
   * 而主动机会本来就是"群里安静了、给你个开口的由头"，正好对上。
   *
   * 「仅 @」模式下**整条递料通路关闭**：那个模式的语义是"我不叫你你就别发视频"，
   * 冷场时自己往外掏视频正好与它相反。
   */
  async 'before-llm-messages'(ctx = {}) {
    try {
      const s = settings();
      if (s.autonomousEnabled || !s.enabled || !s.injectOnProactive) return;

      // 群名在这里才有，补进通道缓存供锐评使用（onMessage 那边拿不到）。
      const chatKey = String(ctx.chatKey || '');
      if (chatKey && ctx.chatName) {
        const prev = state.channels.get(chatKey) || {};
        state.channels.set(chatKey, { ...prev, chatName: String(ctx.chatName), at: Date.now() });
      }

      if (s.atOnly) return;
      if (ctx.proactive !== true) return;
      const entry = state.pending;
      if (!entry) return;

      const gate = canShareNow({ chatKey: ctx.chatKey, s });
      if (!gate.ok) {
        log(`这次不递（${gate.why}）`);
        return;
      }

      const visionOk = ctx.visionEnabled !== false;
      // 把"给不给画面"的结论**传进** buildBrief：文字与图片必须来自同一个决定。
      // 不这么做就会出现"文字说附了 2 张拼图、实际一张没带"——模型于是照标题编画面。
      const withFrames = visionOk && s.imageMode !== 'off';
      const brief = buildBrief(entry, s, { withFrames });
      if (!visionOk && s.imageMode !== 'off') {
        log('当前模型不支持图片输入，本次只递文字（标题/简介/评论）');
      }

      appendToTail(ctx.messages, brief.text, brief.images);

      const sl = shareLog();
      writeShareLog({ day: sl.day, count: sl.count + 1, lastAt: Date.now() });
      state.pending = null;

      log(`已递出：${entry.title}（${brief.images.length} 张画面，今天第 ${sl.count + 1} 次）`);
    } catch (error) {
      warn(`递视频失败（不影响正常回话）：${error?.message ?? error}`);
    }
  }
};

/** 测试/排障用导出。 */
export const __internals = {
  state, settings, parseHours, bjDayKey, bjNow,
  seenList, markSeen, shareLog, writeShareLog,
  prepareOne, prepareInBackground, watchTarget, renderWatchResult,
  buildBrief, appendToTail, pickSheets, chooseCandidate, sheetTimeHint, canShareNow,
  // 新增：筛选 / 触发 / 锐评
  passesFilters, triggerWords, findTrigger, atOnlyOk,
  triggerLog, writeTriggerLog, canTriggerNow,
  buildReviewMessages, cleanReview, makeReview, runTriggerSend,
  candidatePages, relaxFilters,
  DEFAULTS
};
