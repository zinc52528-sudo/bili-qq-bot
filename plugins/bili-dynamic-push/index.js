// B 站动态推送（确定性型 · plugins/bili-dynamic-push/）
//
// ── 为什么做成插件，而不是技能（按文档 §0 的三问）─────────────────────────
//   第一问「触发时机能用 if 描述吗」：能 —— "每隔 N 分钟看看有没有新动态"。
//   第二问「漏触发一次的代价」：漏了就少推一条，属于"必须按点发生"的事。
//   第三问「参数从哪来」：uid / 目标群 / 间隔都来自设置或订阅记录，不从人话里抠。
//   三问指向一致 → 确定性型（plugins/），到点就跑，不靠模型自觉、不花 token。
//   （附带注册了两个给模型用的工具，是为了让你能在群里直接用嘴订阅 —— 见文件末尾。）
//
// ── 为什么它自己发消息（重要，别当成绕过规范）───────────────────────────
//   核心传给插件的上下文（skillContext）里**没有** sender / onebot，确定性插件
//   又没有"请求-响应"式的执行上下文，所以"定时主动推送"在核心侧没有现成通道。
//   这里的做法是**复用核心自己的发送管道**，而不是自己拼 HTTP：
//     import('../../src/sender.js') 的 SendQueue
//     import('../../src/onebot.js') 的 OneBotClient
//   好处是排队（同会话串行）/ 限频 / 去重 / Markdown 转纯文本 / QQ 长度切分 /
//   CQ 转义，与机器人自己发言完全同一套代码。
//
//   ⚠️ 只借 OneBotClient 的 HTTP 通道，**绝不调用它的 connect()**：
//      再开一条 WebSocket 会让群消息事件收到两份（本项目 2026-09-19 的复盘里
//      明确写过"两个 WS 同时连着 → 所有事件收到两份"）。
//   ⚠️ 发送不写进聊天的 self 留档（传的是一次性空 store）：目的是避免和核心的
//      ChatStore 双写同一个文件。代价：机器人下一轮不知道"这条是我自己发的"。
//      这是本次开法的已知取舍，不影响推送本身。
//
//   ⚠️ 路径依赖：这属于"借用核心内部模块"，走的是相对路径。
//      如果哪天 QQ Agent 升级把 src/sender.js / src/onebot.js 挪了位置，
//      本插件会在「插件」页显示"加载失败"，把那条错误发给我就能修。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// ⚠️ 辅助模块必须**带时间戳动态 import**，不能写成静态 import。
//
// 实测踩到的坑（2026-10-06）：加载器热重载时只给**入口文件**拼了 `?t=<时间戳>`
// 来绕过 Node 的 ESM 缓存（见 src/plugin-loader.js），而入口里 `./bili-dynamic.js`
// 这种相对导入解析出来的 URL **不带查询串** —— 于是 Node 一直复用进程里最早那次
// 加载的旧模块实例。表现是：文件明明改了、热重载日志也显示"✅ 加载成功"，但跑的还是
// 老代码；加了新导出时更直接：`does not provide an export named ...` 加载失败。
// 这里自己加时间戳，保证每次热重载都用磁盘上的最新代码。
const bili = await import(`./bili-dynamic.js?t=${Date.now()}`);
const {
  searchUpUser, fetchUserDynamics, formatDynamicMessage, formatPubTime,
  fetchLiveStatus, formatLiveOnMessage, formatLiveOffMessage
} = bili;

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const NAME_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // 名字 → uid 的缓存有效期
const TICK_MS = 60 * 1000;                     // 内部心跳：每分钟看一眼"该不该检查了"
const STARTUP_DELAY_MS = 20 * 1000;            // 启动后先等 20 秒（让核心连上 OneBot）
const CONFIG_CHANGE_DELAY_MS = 3 * 1000;       // 设置刚被改过 → 3 秒后就检查一次（看得见效果）
const CONFIG_CHANGE_GUARD_MS = 30 * 1000;      // 设置改动触发的检查，距上次检查至少隔 30 秒
const SEEN_CAP = 100;                          // 每个 UP 记住多少条已推过的动态
const MAX_SUBS = 50;                           // 订阅条数上限

// ── 模块级状态 ────────────────────────────────────────────────────────────
let cfg = () => ({});
let apiRef = null;
let coreLogger = null;

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * 日志出口。
 *
 * ⚠️ 实测坑（2026-10-06 本机）：Skill API 给的 `api.log` 就是 `console.log`，
 *    而**打包版 Electron 里 console 没人接** —— app.js 把 logger 的 mirrorConsole
 *    关掉了，日志文件只收 `logger.*`。于是插件用 api.log 打的东西在
 *    data/logs/ 与控制台「日志」页里**全都看不到**，出问题时毫无线索。
 *    所以这里直接写核心的 logger（落盘 + 进「日志」页），拿不到才退回 console。
 */
function pipeLog(level, args) {
  let text = '';
  try { text = args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' '); } catch { text = '(无法序列化的日志内容)'; }
  if (coreLogger) {
    try { coreLogger[level]('bili-dynamic-push', text); return; } catch { /* 退回 console */ }
  }
  try { console.log('[bili-dynamic-push]', text); } catch { /* ignore */ }
}

const log = (...args) => pipeLog('info', args);
const warn = (...args) => pipeLog('warn', args);

let timer = null;
let stopped = true;
let checking = false;
let firstTick = true;
let lastConfigSig = '';
let nextCheckAt = 0;
let hintLogged = false;

const status = {
  lastCheckAt: 0,
  lastPushAt: 0,
  lastOk: null,
  lastError: '',
  pushedTotal: 0,
  lastSummary: ''
};

// ── 数据目录 / 状态文件 ───────────────────────────────────────────────────
// 数据一律落在 QQ Agent 自己的 data 目录下（与 core 的 config.json 同处），
// 不往插件目录里写：插件目录将来升级会被覆盖，状态不能跟着走。
let coreDataDir = '';

function dataDir() {
  return coreDataDir || process.env.QQ_AGENT_DATA_DIR || path.resolve(APP_ROOT, 'data');
}

function stateFile() {
  return path.join(dataDir(), 'bili-dynamic-push-state.json');
}

let state = null;

function loadState() {
  if (state) return state;
  state = { seen: {}, subs: [], nameCache: {}, live: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (parsed && typeof parsed === 'object') {
      if (parsed.seen && typeof parsed.seen === 'object') state.seen = parsed.seen;
      if (Array.isArray(parsed.subs)) state.subs = parsed.subs.filter((s) => s && s.uid && s.chatKey);
      if (parsed.nameCache && typeof parsed.nameCache === 'object') state.nameCache = parsed.nameCache;
      if (parsed.live && typeof parsed.live === 'object') state.live = parsed.live;
    }
  } catch { /* 首次运行 / 文件坏了：从空开始，不能因此让插件失效 */ }
  return state;
}

function saveState() {
  const s = loadState();
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    const tmp = `${stateFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1), 'utf8');
    fs.renameSync(tmp, stateFile());     // 先写临时文件再改名：避免写一半被读到半个 JSON
    return true;
  } catch (error) {
    warn(`状态写盘失败（本次推送照常，只是重启后可能重复推一条）：${error?.message ?? error}`);
    return false;
  }
}

/**
 * 把"本次检查的结论"一起落盘。
 *
 * 为什么需要：插件运行状态原本只在内存里 —— 一旦重启（或热重载）就全没了，
 * 剩下的线索只有一句"什么都没发生"。落盘后：
 *   · 群友问「动态推送什么状态」时，即使刚重启过也能看到上次检查的结果与错误原文；
 *   · 排错时可以直接看 data/bili-dynamic-push-state.json。
 */
function noteCheck() {
  const st = loadState();
  st.lastCheck = {
    at: status.lastCheckAt || Date.now(),
    ok: status.lastOk,
    summary: String(status.lastSummary || '').slice(0, 200),
    error: String(status.lastError || '').slice(0, 500),
    pushedTotal: Number(st.pushedTotal) || 0
  };
  saveState();
}

// ── 借用核心模块（config / onebot / sender / logger）──────────────────────
let coreModules = null;
let coreModulesLoading = null;

async function loadCoreModules() {
  if (coreModules) return coreModules;
  if (!coreModulesLoading) {
    coreModulesLoading = (async () => {
      const out = { getConfig: null, DATA_DIR: '', OneBotClient: null, SendQueue: null, error: '' };
      try {
        const m = await import('../../src/config.js');
        out.getConfig = m.getConfig || null;
        out.DATA_DIR = m.DATA_DIR || '';
        if (out.DATA_DIR) coreDataDir = out.DATA_DIR;
      } catch (error) {
        out.error += `config.js：${error?.message ?? error}；`;
      }
      try {
        const m = await import('../../src/onebot.js');
        out.OneBotClient = m.OneBotClient || null;
      } catch (error) {
        out.error += `onebot.js：${error?.message ?? error}；`;
      }
      try {
        const m = await import('../../src/sender.js');
        out.SendQueue = m.SendQueue || null;
      } catch (error) {
        out.error += `sender.js：${error?.message ?? error}；`;
      }
      try {
        const m = await import('../../src/logger.js');
        if (m.logger) coreLogger = m.logger;
      } catch { /* 没有 logger 就退回 console，不影响功能 */ }
      return out;
    })();
  }
  coreModules = await coreModulesLoading;
  if (coreModules.error) warn(`借用核心模块失败：${coreModules.error}`);
  return coreModules;
}

let senderCache = null;

/** 懒建一个发送器：只借核心的发送管道（HTTP 通道），不建 WS 连接。 */
async function getSender() {
  if (senderCache) return senderCache;
  const mods = await loadCoreModules();
  if (!mods.OneBotClient || !mods.SendQueue || !mods.getConfig) {
    throw new Error(`拿不到核心发送管道（${mods.error || '未知原因'}）`);
  }
  const all = mods.getConfig() || {};
  const sl = all.snowluma || {};
  const onebot = new mods.OneBotClient({
    wsUrl: sl.wsUrl,
    httpUrl: sl.httpUrl,
    accessToken: sl.accessToken,
    httpToken: sl.httpAccessToken || sl.accessToken
  });
  // ⚠️ 不调用 onebot.connect()：只作为 HTTP 客户端用。
  const sender = new mods.SendQueue({
    onebot,
    store: { appendSelf() {} },      // 不做留档，理由见文件头注释
    log: (...args) => log(...args)
  });
  senderCache = sender;
  return sender;
}

/** 走发送管道发一批文本。返回 {ok, sent?, error?}，绝不抛。 */
async function sendTo(chatKey, texts) {
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? '')).filter(Boolean);
  if (!list.length) return { ok: false, error: '没有要发送的内容' };
  if (!/^(group|private):\d+$/.test(String(chatKey))) return { ok: false, error: `会话标识不对：${chatKey}` };
  try {
    const sender = await getSender();
    const r = await sender.sendTextBatch(String(chatKey), list);
    const sentCount = (r?.sent || []).filter((x) => !x.deduped).length;
    status.pushedTotal += sentCount;
    if (sentCount) status.lastPushAt = Date.now();
    return { ok: true, sent: sentCount, failed: r?.failed || [] };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

// ── 配置解析 ──────────────────────────────────────────────────────────────

function clamp(n, lo, hi) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

function intervalMs() {
  return clamp(Number(cfg()?.intervalMin) || 10, 5, 1440) * 60000;
}

/**
 * 取用户填的 B 站登录凭证（可能为空）。
 * ⚠️ 每次调用都现读配置（用户改完不用重启），并且**永远不要打进日志**。
 */
function biliCookie() {
  try { return String(cfg()?.biliCookie || '').trim(); } catch { return ''; }
}

/**
 * 解析「推送到」设置：
 *   123456            → group:123456（最常见，直接填群号）
 *   group:123456      → 群
 *   private:123456 / p:123456 → 私聊
 * 多个用逗号、空格或换行分隔。
 */
export function parseTargets(raw) {
  const out = [];
  for (const piece of String(raw ?? '').split(/[\s,，;；]+/)) {
    const t = piece.trim();
    if (!t) continue;
    const lower = t.toLowerCase();
    let key = '';
    if (lower.startsWith('group:')) key = `group:${t.slice(6).replace(/\D/g, '')}`;
    else if (lower.startsWith('private:')) key = `private:${t.slice(8).replace(/\D/g, '')}`;
    else if (lower.startsWith('p:')) key = `private:${t.slice(2).replace(/\D/g, '')}`;
    else if (/^\d+$/.test(t)) key = `group:${t}`;
    if (/^(group|private):\d+$/.test(key) && !out.includes(key)) out.push(key);
  }
  return out;
}

function configSig(c) {
  // ⚠️ 这里必须覆盖**所有会影响行为的设置**：指纹一变就立刻检查一次（见 heartbeat），
  //    否则用户改完设置要等满一个检查周期才看到效果（实测踩过：改直播开关没反应）。
  //    Cookie 只取"填没填"，不把凭证内容放进这个字符串。
  return JSON.stringify([
    c.up || '', c.targets || '', c.intervalMin, c.maxPerCheck, c.firstRunPush,
    c.pushLive !== false, c.pushLiveOn !== false, c.pushLiveOff !== false,
    Boolean(biliCookie())
  ]);
}

// ── UP 主解析（名字 → uid，带 7 天缓存）───────────────────────────────────

async function resolveUp(input, { timeoutMs = 15000 } = {}) {
  const s = String(input ?? '').trim();
  if (!s) return { ok: false, error: '没有指定 UP 主（填名字或 uid）' };
  const st = loadState();
  if (/^\d{3,}$/.test(s)) {
    const cached = st.nameCache[`uid:${s}`];
    return { ok: true, uid: Number(s), name: cached?.name || '' };
  }
  const cached = st.nameCache[s];
  if (cached && cached.uid && Date.now() - (cached.at || 0) < NAME_TTL_MS) {
    return { ok: true, uid: cached.uid, name: cached.name || '', cached: true };
  }
  const r = await searchUpUser(s, { timeoutMs, cookie: biliCookie() });
  if (!r.ok) return { ok: false, error: r.error };
  const best = r.best;
  const at = Date.now();
  st.nameCache[s] = { uid: best.mid, name: best.uname, at };
  st.nameCache[`uid:${best.mid}`] = { uid: best.mid, name: best.uname, at };
  saveState();
  return {
    ok: true,
    uid: best.mid,
    name: best.uname,
    others: r.users.slice(1, 4).map((u) => `${u.uname}(${u.mid})`)
  };
}

// ── 检查 + 推送 ───────────────────────────────────────────────────────────

/** 把"配置里的 UP 主"和"群内订阅"合并成 [{upInput, targets[]}]。 */
function collectJobs(c) {
  const jobs = [];
  const configTargets = parseTargets(c.targets);
  const configUp = String(c.up || '').trim();
  if (configUp && configTargets.length) jobs.push({ upInput: configUp, targets: configTargets, from: 'config' });
  if (configUp && !configTargets.length && !hintLogged) {
    hintLogged = true;
    log('设置了 UP 主但「推送到」是空的 —— 请填群号，或在群里对机器人说「订阅XXX的动态」');
  }
  for (const sub of loadState().subs) {
    jobs.push({ upInput: String(sub.uid), targets: [String(sub.chatKey)], from: 'sub' });
  }
  return jobs;
}

/**
 * 跑一次检查。任何异常都在内部兜住 —— 定时器里抛错会变成 unhandledRejection。
 * @returns {Promise<{ok:boolean, skipped?:string, error?:string, pushed?:number}>}
 */
export async function runCheck(reason = 'timer') {
  if (checking) return { ok: false, error: '上一次检查还没跑完，跳过这一次' };
  checking = true;
  status.lastCheckAt = Date.now();
  status.lastError = '';
  let pushed = 0;
  try {
    await loadCoreModules();
    const c = cfg() || {};
    const jobs = collectJobs(c);
    if (!jobs.length) {
      status.lastOk = true;
      status.lastSummary = '没有配置任何 UP 主/推送目标，什么也没做';
      noteCheck();
      return { ok: true, skipped: status.lastSummary };
    }

    // ① 按 uid 归并：同一个 UP 推给多个会话时只抓一次接口
    const byUid = new Map();
    for (const job of jobs) {
      const r = await resolveUp(job.upInput);
      if (!r.ok) {
        status.lastError = r.error;
        warn(`解析 UP「${job.upInput}」失败：${r.error}`);
        continue;
      }
      const key = String(r.uid);
      if (!byUid.has(key)) byUid.set(key, { uid: r.uid, name: r.name || '', targets: new Set() });
      const rec = byUid.get(key);
      if (r.name) rec.name = r.name;
      for (const t of job.targets) rec.targets.add(t);
    }
    if (!byUid.size) {
      status.lastOk = false;
      status.lastSummary = `没有可用的 UP 主：${status.lastError}`;
      noteCheck();
      return { ok: false, error: status.lastSummary };
    }

    const maxPer = clamp(Number(c.maxPerCheck) || 3, 1, 10);
    const firstRunPush = c.firstRunPush !== false;
    const notes = [];

    // ② 逐个 UP 抓动态 → 挑新的 → 推
    for (const rec of byUid.values()) {
      const fetched = await fetchUserDynamics(rec.uid, { limit: 20, cookie: biliCookie() });
      if (!fetched.ok) {
        status.lastError = `抓「${rec.name || rec.uid}」动态失败：${fetched.error}`;
        warn(status.lastError);
        continue;
      }
      if (!rec.name) rec.name = fetched.items[0]?.author || '';
      if (fetched.attempt > 1) log(`「${rec.name || rec.uid}」第 1 次被静默限流，换指纹重试后拿到 ${fetched.items.length} 条`);
      const ids = fetched.items.map((x) => x.id).filter(Boolean);
      const key = String(rec.uid);
      const known = Array.isArray(loadState().seen[key]);
      const seenSet = new Set(known ? loadState().seen[key] : []);

      // 首次见到这个 UP：把当前动态全部记为已见（否则一启用就把历史全推出去）；
      // 想验证链路是否通，就把「首次启用先推一条最新动态」留着（默认开）。
      const todo = known
        ? fetched.items.filter((x) => x.id && !seenSet.has(x.id)).slice(0, maxPer)
        : (firstRunPush ? fetched.items.slice(0, 1) : []);

      for (const item of todo) {
        const text = formatDynamicMessage({ name: rec.name, item, first: !known });
        for (const chatKey of rec.targets) {
          // eslint-disable-next-line no-await-in-loop
          const r = await sendTo(chatKey, [text]);
          if (r.ok && r.sent > 0) {
            pushed += r.sent;
            // 累计数记在**落盘状态**里：内存计数每次热重载都会清零，用户看到的
            // "累计已推送"就永远是 0（实测踩过）。
            const st0 = loadState();
            st0.pushedTotal = (Number(st0.pushedTotal) || 0) + r.sent;
            notes.push(`${rec.name || rec.uid} → ${chatKey}`);
            log(`已推送 ${rec.name || rec.uid} 的动态 ${item.id} 到 ${chatKey}`);
          } else {
            status.lastError = `推送到 ${chatKey} 失败：${r.error || '被发送去重跳过'}`;
            warn(status.lastError);
          }
        }
      }

      // ③ 记账：本次抓到的全部 id 都算"已见"（含推送失败的）。
      //    取舍说明：B 站动态不是关键数据，宁可偶发漏一条，也不要因为某次发送失败
      //    而在下一轮把同一条重推一遍（那才是真正让人烦的体验）。
      loadState().seen[key] = [...new Set([...ids, ...seenSet])].slice(0, SEEN_CAP);
    }

    // ③ 直播（开播 / 下播）—— 走直播间接口，一次问完所有 UP
    //
    // ⚠️ 开播与下播是**两个独立开关**（c.pushLiveOn / c.pushLiveOff）：
    //    下播提醒对多数人是噪音（直播动不动就结束），能单独关掉。
    //    但**状态记录不跟着开关走** —— 关掉下播时仍然记录 live=false，
    //    否则"关掉下播 → 再开播"会被当成"从来没播过"，开播提醒就发不出来了。
    //    （c.pushLive 是上一版的总开关，保留兼容：明确关掉它仍然是全部关闭。）
    const liveMaster = c.pushLive !== false;
    const wantLiveOn = liveMaster && c.pushLiveOn !== false;
    const wantLiveOff = liveMaster && c.pushLiveOff !== false;
    if (wantLiveOn || wantLiveOff) {
      const uids = [...byUid.values()].map((r) => r.uid);
      const live = await fetchLiveStatus(uids);
      if (!live.ok) {
        warn(`查直播状态失败：${live.error}`);
        if (!status.lastError) status.lastError = `查直播状态失败：${live.error}`;
      } else {
        const st = loadState();
        st.live = (st.live && typeof st.live === 'object') ? st.live : {};
        for (const rec of byUid.values()) {
          const info = live.byUid[String(rec.uid)];
          if (!info) continue;         // 这个账号没有直播间信息：不动它，也不误报下播
          const prev = st.live[String(rec.uid)] || null;
          const name = rec.name || info.name || String(rec.uid);

          // 开播：从未在播 → 在播。首次看到就是"在播"时也提醒一次（现在就在播，值得知道）。
          if (info.live && !(prev && prev.live)) {
            if (!wantLiveOn) {
              log(`（开播提醒已关闭，跳过）${name} 开播了`);
            } else {
              const text = formatLiveOnMessage({ name, title: info.title, roomId: info.roomId });
              for (const chatKey of rec.targets) {
                // eslint-disable-next-line no-await-in-loop
                const r = await sendTo(chatKey, [text]);
                if (r.ok && r.sent > 0) {
                  pushed += r.sent;
                  st.pushedTotal = (Number(st.pushedTotal) || 0) + r.sent;
                  notes.push(`开播 → ${chatKey}`);
                  log(`已推送开播提醒（${name}${info.title ? `：${info.title}` : ''}）到 ${chatKey}`);
                } else {
                  status.lastError = `开播提醒推送到 ${chatKey} 失败：${r.error || '被发送去重跳过'}`;
                  warn(status.lastError);
                }
              }
            }
          } else if (!info.live && prev && prev.live) {
            // 下播：在播 → 不在播
            if (!wantLiveOff) {
              log(`（下播提醒已关闭，跳过）${name} 下播了`);
            } else {
              const text = formatLiveOffMessage({ name });
              for (const chatKey of rec.targets) {
                // eslint-disable-next-line no-await-in-loop
                const r = await sendTo(chatKey, [text]);
                if (r.ok && r.sent > 0) {
                  pushed += r.sent;
                  st.pushedTotal = (Number(st.pushedTotal) || 0) + r.sent;
                  notes.push(`下播 → ${chatKey}`);
                  log(`已推送下播提醒（${name}）到 ${chatKey}`);
                } else {
                  status.lastError = `下播提醒推送到 ${chatKey} 失败：${r.error || '被发送去重跳过'}`;
                  warn(status.lastError);
                }
              }
            }
          }
          st.live[String(rec.uid)] = {
            live: info.live,
            round: info.round,
            title: info.title,
            roomId: info.roomId,
            name,
            at: Date.now()
          };
        }
      }
    }

    status.lastOk = !status.lastError;
    status.lastSummary = pushed ? `本次推送 ${pushed} 条（${notes.join('、')}）` : '检查完成，没有新动态';
    noteCheck();
    return { ok: true, pushed, summary: status.lastSummary, error: status.lastError || '' };
  } catch (error) {
    status.lastOk = false;
    status.lastError = String(error?.stack ?? error?.message ?? error);
    status.lastSummary = '检查过程中抛错了';
    warn(`检查出错：${status.lastError}`);
    noteCheck();
    return { ok: false, error: status.lastError };
  } finally {
    checking = false;
    // 加一点随机抖动（±45 秒）：每次都在同一秒打 B 站接口容易被风控盯上，
    // 也让多个 UP 主的请求时刻错开。
    const jitter = Math.floor(Math.random() * 90000) - 45000;
    nextCheckAt = Date.now() + Math.max(60000, intervalMs() + jitter);
  }
}

// ── 定时器 ────────────────────────────────────────────────────────────────
//
// 用"每分钟心跳 + 到点才真检查"而不是 setInterval(intervalMin)：
//   ① 用户刚改完设置能很快看到效果（配置变了 3 秒后就检查一次）；
//   ② 检查没跑完也不会叠第二次（心跳里 checking 有互斥）；
//   ③ intervalMin 改了不需要重启定时器。

function schedule(delayMs) {
  if (stopped) return;
  if (timer) { clearTimeout(timer); timer = null; }
  const t = setTimeout(heartbeat, Math.max(1000, delayMs));
  t.unref?.();     // 别让定时器拖着进程不退出
  timer = t;
}

function heartbeat() {
  timer = null;
  if (stopped) return;
  let c = {};
  try { c = cfg() || {}; } catch { c = {}; }
  const sig = configSig(c);
  const now = Date.now();

  if (firstTick) {
    firstTick = false;
    lastConfigSig = sig;
    nextCheckAt = now + STARTUP_DELAY_MS;
  } else if (sig !== lastConfigSig) {
    lastConfigSig = sig;
    // 设置刚被改过：很快检查一次，让你填完就能看到推送。
    // ⚠️ 这里刻意不用 intervalMin 做下限：定时心跳即使"没配置"也会记 lastCheckAt，
    //    拿它做满一个周期的下限会让"刚填完设置"白等十分钟。改用 30 秒的短保护，
    //    既能立刻看到效果，也不会因为连续点保存把 B 站打爆。
    nextCheckAt = Math.min(nextCheckAt || Infinity, Math.max(now + CONFIG_CHANGE_DELAY_MS, status.lastCheckAt + CONFIG_CHANGE_GUARD_MS));
    log('设置已改变，稍后自动检查一次');
  }

  if (now >= nextCheckAt) {
    runCheck('timer')
      .catch((error) => warn(`检查出错：${error?.message ?? error}`))
      .finally(() => { if (!stopped) schedule(TICK_MS); });
    return;
  }
  schedule(Math.min(TICK_MS, Math.max(1000, nextCheckAt - now)));
}

function startLoop(reason = 'activate') {
  stopped = false;
  firstTick = true;
  nextCheckAt = 0;
  lastConfigSig = '';
  hintLogged = false;
  if (timer) { clearTimeout(timer); timer = null; }
  log(`已启动（${reason}）：每 ${Math.round(intervalMs() / 60000)} 分钟检查一次 B 站动态`
    + `，首次检查在约 ${Math.round(STARTUP_DELAY_MS / 1000)} 秒后`);
  schedule(1000);
}

function stopLoop() {
  stopped = true;
  if (timer) { clearTimeout(timer); timer = null; }
}

// ── 能力（providers）──────────────────────────────────────────────────────
//
// 两个自建能力名：核心不认识它们，但**别的扩展和本插件的工具**用它取用实现，
// 这样"抓动态"和"订阅管理"的逻辑只有一份（文档 §5/§8 的软依赖写法）。

async function capabilityLatest({ up = '', uid = 0, limit = 5 } = {}) {
  try {
    let mid = Number(uid) || 0;
    let name = '';
    if (!mid) {
      const r = await resolveUp(up);
      if (!r.ok) return { ok: false, error: r.error };
      mid = r.uid;
      name = r.name || '';
    }
    const f = await fetchUserDynamics(mid, { limit: clamp(limit, 1, 20), cookie: biliCookie() });
    if (!f.ok) return { ok: false, error: f.error };
    if (!name) name = f.items[0]?.author || '';
    return { ok: true, uid: mid, name, items: f.items, hasMore: f.hasMore };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

async function capabilitySubscribe({ action = 'list', chatKey = '', up = '', uid = 0, name = '' } = {}) {
  try {
    const st = loadState();
    const act = String(action || 'list');

    if (act === 'subscribe' || act === 'add') {
      if (!chatKey) return { ok: false, error: '缺少会话标识（订阅必须知道推到哪个群）' };
      let mid = Number(uid) || 0;
      let uname = String(name || '');
      if (!mid) {
        const r = await resolveUp(up);
        if (!r.ok) return { ok: false, error: r.error };
        mid = r.uid;
        uname = r.name || uname;
      }
      if (!uname) uname = loadState().nameCache[`uid:${mid}`]?.name || '';
      const exists = st.subs.find((s) => String(s.uid) === String(mid) && String(s.chatKey) === String(chatKey));
      if (!exists) {
        st.subs.push({ uid: mid, name: uname, chatKey: String(chatKey), at: Date.now() });
        if (st.subs.length > MAX_SUBS) st.subs = st.subs.slice(-MAX_SUBS);
        saveState();
      }
      return { ok: true, added: !exists, uid: mid, name: uname, chatKey: String(chatKey) };
    }

    if (act === 'unsubscribe' || act === 'remove') {
      const before = st.subs.length;
      const target = String(up || uid || '').trim();
      if (!target || target.toLowerCase() === 'all') {
        st.subs = st.subs.filter((s) => String(s.chatKey) !== String(chatKey));
      } else {
        let mid = Number(uid) || 0;
        if (!mid && /^\d{3,}$/.test(target)) mid = Number(target);
        let uname = '';
        if (!mid) {
          const r = await resolveUp(target);
          if (!r.ok) return { ok: false, error: r.error };
          mid = r.uid;
          uname = r.name || '';
        }
        st.subs = st.subs.filter((s) => !(String(s.chatKey) === String(chatKey) && String(s.uid) === String(mid)));
        if (uname) loadState().nameCache[`uid:${mid}`] = { uid: mid, name: uname, at: Date.now() };
      }
      const removed = before - st.subs.length;
      saveState();
      return { ok: true, removed };
    }

    if (act === 'list') {
      const mine = st.subs.filter((s) => String(s.chatKey) === String(chatKey));
      return { ok: true, subs: mine, all: st.subs.length };
    }

    if (act === 'status') {
      const c = cfg() || {};
      return {
        ok: true,
        active: !stopped,
        intervalMin: clamp(Number(c.intervalMin) || 10, 5, 1440),
        configUp: String(c.up || ''),
        configTargets: parseTargets(c.targets),
        // 只说"填没填"，绝不回显内容
        hasBiliCookie: Boolean(biliCookie()),
        pushLiveOn: c.pushLive !== false && c.pushLiveOn !== false,
        pushLiveOff: c.pushLive !== false && c.pushLiveOff !== false,
        // 当前记录到的直播状态（哪个 UP 在播）
        live: st.live || {},
        subs: st.subs.map((s) => ({ uid: s.uid, name: s.name, chatKey: s.chatKey })),
        lastCheckAt: status.lastCheckAt,
        lastPushAt: status.lastPushAt,
        lastOk: status.lastOk,
        lastError: status.lastError,
        lastSummary: status.lastSummary,
        pushedTotal: Number(st.pushedTotal) || 0,
        // 落盘的上次检查结论：重启/热重载后内存状态清零，靠它兜底
        lastCheckOnDisk: st.lastCheck || null,
        coreError: coreModules?.error || ''
      };
    }

    return { ok: false, error: `不认识的 action：${act}` };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

export const providers = {
  'bili.dynamic-latest': (args = {}) => capabilityLatest(args),
  'bili.dynamic-subscribe': (args = {}) => capabilitySubscribe(args)
};

/** 优先走能力名取用（能被别的扩展复用），拿不到再退回本地实现。 */
async function callCapability(name, args) {
  try {
    if (apiRef && typeof apiRef.capability === 'function') {
      const r = await apiRef.capability(name, args);
      if (r !== undefined && r !== null) return r;
    }
  } catch (error) {
    warn(`能力 ${name} 取用失败，改用本地实现：${error?.message ?? error}`);
  }
  const fn = providers[name];
  return fn ? await fn(args) : undefined;
}

// ── 文案小工具 ────────────────────────────────────────────────────────────

function ok(payload) { return { content: JSON.stringify(payload, null, 1) }; }
function err(message) { return { content: String(message), isError: true }; }

function substatusText(s) {
  if (!s) return '（暂时读不到运行状态）';
  const lines = [];
  lines.push(`状态：${s.active ? '已启动' : '未启动（插件可能被关闭了）'}`);
  lines.push(`检查间隔：${s.intervalMin} 分钟`);
  if (s.configUp) lines.push(`设置里的 UP 主：${s.configUp}；推送目标：${s.configTargets.length ? s.configTargets.join('、') : '（没填）'}`);
  lines.push(`B 站登录信息：${s.hasBiliCookie ? '已填（官方号动态需要它）' : '未填（匿名访问）'}`);
  lines.push(`开播提醒：${s.pushLiveOn ? '开' : '关'}；下播提醒：${s.pushLiveOff ? '开' : '关'}`);
  {
    const liveUids = Object.values(s.live || {});
    if (liveUids.length) {
      lines.push(`直播状态：${liveUids.map((x) => `${x.name || ''}${x.live ? '正在直播' : (x.round ? '轮播中' : '未开播')}`).join('、')}`);
    }
  }
  lines.push(`已订阅：${s.subs.length ? s.subs.map((x) => `${x.name || x.uid}→${x.chatKey}`).join('、') : '（本机还没有任何订阅）'}`);
  lines.push(`上次检查：${s.lastCheckAt ? new Date(s.lastCheckAt).toLocaleString('zh-CN', { hour12: false }) : '还没跑过'}`);
  lines.push(`上次结果：${s.lastSummary || (s.lastOk === null ? '未知' : (s.lastOk ? '正常' : '出错'))}`);
  if (s.lastError) lines.push(`最后的错误：${String(s.lastError).slice(0, 300)}`);
  lines.push(`累计已推送：${s.pushedTotal} 条`);
  // 内存状态是空的（刚重启/刚热重载）时，把落盘的上次结论补上，别让用户以为"从没跑过"
  if (!s.lastCheckAt && s.lastCheckOnDisk) {
    const d = s.lastCheckOnDisk;
    const at = d.at ? new Date(d.at).toLocaleString('zh-CN', { hour12: false }) : '';
    lines.push(`上次检查记录（重启前，${at}）：${d.summary || (d.ok ? '正常' : '出错')}`
      + (d.error ? ` / 错误：${String(d.error).slice(0, 200)}` : ''));
  }
  if (s.coreError) lines.push(`⚠️ 发送通道有问题：${String(s.coreError).slice(0, 200)}`);
  return lines.join('\n');
}

// ── 给模型用的工具 ────────────────────────────────────────────────────────
//
// 注册工具是为了"用嘴订阅"：群友说一句「订阅某某的动态」，模型调这个工具，
// 订阅的会话就是当前会话（ctx.chatKey）—— 你不用自己去查群号。
// 确认信息由工具直接发出去（和 bili-share 的做法一致），避免模型再复述一遍。

function registerTools(api) {
  api.registerTool({
    id: 'bili_dynamic_sub',
    name: 'B站动态订阅',
    description: '订阅 / 取消订阅 / 查看「某个 B 站 UP 主的动态自动推送」。'
      + '订阅后机器人会每隔一段时间自动把 TA 的新动态发到**当前会话**，不经过模型、不花 token。'
      + '当群友说「订阅XX的动态」「帮我盯着XX」「关注一下XX的更新」时用 action=add（up 填名字或 uid）；'
      + '说「取消订阅XX」「别推XX了」「取关」时用 action=remove（up 填名字或 uid，填 all 或省略表示清空本会话全部订阅）；'
      + '问「订阅了哪些 / 都关注了谁」时用 action=list；'
      + '问「动态推送怎么没生效 / 什么状态」时用 action=status。'
      + '不要自己记订阅名单，一切以这个工具的返回为准。',
    category: 'query',
    icon: '🔔',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'remove', 'list', 'status'],
          description: '要做什么：add=订阅、remove=取消订阅、list=查看本会话订阅、status=查看运行状态'
        },
        up: {
          type: 'string',
          description: 'UP 主的名字或 uid（数字）。add/remove 时填；remove 填 all 表示清空本会话全部订阅'
        }
      },
      required: ['action']
    },
    async execute(ctx, args) {
      try {
        const action = String(args?.action || '').trim().toLowerCase();
        const chatKey = String(ctx?.chatKey || '');
        const up = String(args?.up || '').trim();
        if (!chatKey) return err('拿不到当前会话，无法操作订阅');
        if (!['add', 'remove', 'list', 'status'].includes(action)) {
          return err('action 只能是 add / remove / list / status');
        }

        // ── 订阅 ──
        if (action === 'add') {
          if (!up) return err('要订阅谁？请把 UP 主的名字或 uid 放进 up 参数');
          const r = await callCapability('bili.dynamic-subscribe', { action: 'add', chatKey, up });
          if (!r?.ok) return err(`订阅失败：${r?.error || '未知错误'}`);
          const lines = [`🔔 已订阅 ${r.name || r.uid}（uid ${r.uid}）的 B 站动态`];
          if (r.added === false) lines.push('（本来就在订阅里，没有重复添加）');

          // 立刻抓一条最新的发出来：一是验证链路通不通，二是让你马上看到效果
          const latest = await callCapability('bili.dynamic-latest', { uid: r.uid, limit: 5 });
          if (latest?.ok && latest.items?.length) {
            const ids = latest.items.map((x) => x.id).filter(Boolean);
            const st = loadState();
            const seenSet = new Set(Array.isArray(st.seen[String(r.uid)]) ? st.seen[String(r.uid)] : []);
            st.seen[String(r.uid)] = [...new Set([...ids, ...seenSet])].slice(0, SEEN_CAP);
            saveState();
            const text = formatDynamicMessage({ name: r.name || latest.name, item: latest.items[0], first: true });
            const sent = await sendTo(chatKey, [text]);
            if (!sent.ok) lines.push(`（最新那条没发出去：${sent.error}）`);
          } else {
            lines.push(`（暂时抓不到 TA 的动态：${latest?.error || '未知原因'}）`);
          }
          lines.push(`之后每 ${clamp(Number(cfg()?.intervalMin) || 10, 5, 1440)} 分钟检查一次，有新动态会自动发到这里。`);
          {
            const c0 = cfg() || {};
            const master = c0.pushLive !== false;
            const on = master && c0.pushLiveOn !== false;
            const off = master && c0.pushLiveOff !== false;
            if (on && off) lines.push('TA 开播 / 下播时也会在这里提醒（可在插件设置里分别关掉）。');
            else if (on) lines.push('TA 开播时会在这里提醒（下播提醒已关闭）。');
            else if (off) lines.push('TA 下播时会在这里提醒（开播提醒已关闭）。');
          }
          const text = lines.join('\n');
          const sent = await sendTo(chatKey, [text]);
          return ok({
            subscribed: true,
            uid: r.uid,
            name: r.name,
            alreadyThere: r.added === false,
            confirmationSent: sent.ok,
            note: sent.ok
              ? '已经把确认信息（和 TA 最新一条动态）直接发到会话里了，不要再复述一遍，也不要再补发链接。'
              : `确认信息没发出去（${sent.error}），你可以把上面的结果转述给群友。`
          });
        }

        // ── 取消订阅 ──
        if (action === 'remove') {
          const r = await callCapability('bili.dynamic-subscribe', { action: 'remove', chatKey, up });
          if (!r?.ok) return err(`取消失败：${r?.error || '未知错误'}`);
          const text = r.removed
            ? `🔕 已取消 ${r.removed} 个 B 站动态订阅`
            : '🔕 这个会话本来就没有订阅，无需取消';
          const sent = await sendTo(chatKey, [text]);
          return ok({
            removed: r.removed,
            confirmationSent: sent.ok,
            note: sent.ok ? '已直接发出，不要复述。' : `没发出去（${sent.error}），请把结果转述给群友。`
          });
        }

        // ── 查看 / 状态 ──
        if (action === 'list') {
          const r = await callCapability('bili.dynamic-subscribe', { action: 'list', chatKey });
          if (!r?.ok) return err(`读取订阅失败：${r?.error || '未知错误'}`);
          const text = r.subs.length
            ? `🔔 本会话订阅的 B 站 UP 主：\n${r.subs.map((s) => `· ${s.name || s.uid}（uid ${s.uid}）`).join('\n')}`
            : '🔔 本会话还没有订阅任何 B 站 UP 主的动态。可以说「订阅XX的动态」。';
          const sent = await sendTo(chatKey, [text]);
          return ok({
            subs: r.subs,
            confirmationSent: sent.ok,
            note: sent.ok ? '已直接发出，不要复述。' : `没发出去（${sent.error}）。`
          });
        }

        const r = await callCapability('bili.dynamic-subscribe', { action: 'status' });
        if (!r?.ok) return err(`读取状态失败：${r?.error || '未知错误'}`);
        const text = substatusText(r);
        const sent = await sendTo(chatKey, [text]);
        return ok({
          status: r,
          confirmationSent: sent.ok,
          note: sent.ok ? '已直接发出，不要复述。' : `没发出去（${sent.error}）。`
        });
      } catch (error) {
        warn(`bili_dynamic_sub 执行异常：${error?.stack ?? error}`);
        return err(`订阅操作出错：${error?.message ?? error}`);
      }
    }
  });

  api.registerTool({
    id: 'bili_dynamic_now',
    name: '看B站最新动态',
    description: '立刻查某个 B 站 UP 主最新的一条（或几条）动态并发到当前会话 —— 用来验证订阅是否正常，'
      + '或满足「看看XX最近发了什么」这类临时请求。'
      + '注意：这只是"现在查一次"，不会创建订阅；要长期自动推送请用 bili_dynamic_sub。',
    category: 'query',
    icon: '📰',
    parameters: {
      type: 'object',
      properties: {
        up: { type: 'string', description: 'UP 主的名字或 uid（数字）' },
        count: { type: 'number', description: '发几条，1~3，默认 1' }
      },
      required: ['up']
    },
    async execute(ctx, args) {
      try {
        const up = String(args?.up || '').trim();
        if (!up) return err('要看谁的动态？请把 UP 主的名字或 uid 放进 up 参数');
        const count = clamp(Number(args?.count) || 1, 1, 3);
        const r = await callCapability('bili.dynamic-latest', { up, limit: count });
        if (!r?.ok) return err(`查动态失败：${r?.error || '未知错误'}`);
        const chatKey = String(ctx?.chatKey || '');
        const texts = r.items.slice(0, count).map((item) => formatDynamicMessage({ name: r.name, item }));
        const sent = chatKey ? await sendTo(chatKey, texts) : { ok: false, error: '拿不到当前会话' };
        return ok({
          uid: r.uid,
          name: r.name,
          count: r.items.length,
          items: r.items.slice(0, count).map((x) => ({
            id: x.id, type: x.label, title: x.title,
            time: formatPubTime(x.pubTs), url: x.url
          })),
          sent: sent.ok,
          note: sent.ok
            ? '内容已经直接发到会话里了，不要再复述一遍。'
            : `发送失败（${sent.error}），你可以用上面的 items 转述给群友。`
        });
      } catch (error) {
        warn(`bili_dynamic_now 执行异常：${error?.stack ?? error}`);
        return err(`查动态出错：${error?.message ?? error}`);
      }
    }
  });
}

// ── 生命周期（加载器约定：setup 注册、activate 起、deactivate 清）─────────

/** 加载时一次：接管配置、注册工具。 */
export function setup(api) {
  apiRef = api;
  cfg = api.config;
  registerTools(api);
  loadState();
  log('B 站动态推送已加载（可在「插件」页设置 UP 主与推送目标，或直接在群里说「订阅XX的动态」）');
}

/** 被启用时：起定时器。 */
export async function activate(ctx = {}) {
  try {
    startLoop(String(ctx?.reason || 'activate'));
  } catch (error) {
    warn(`启动定时器失败：${error?.message ?? error}`);
  }
}

/**
 * 被关闭 / 热重载前：**必须**清干净，否则会出现
 * "插件明明关了，群里还在推消息"（旧的定时器还在跑）。
 */
export function deactivate() {
  stopLoop();
  log('已停止定时检查');
}

/** 卸载时：最后清一次。 */
export function dispose() {
  stopLoop();
}

/** 依赖自检：**必须同步返回**（返回 Promise 会被当成"可用"）。 */
export function available() {
  return true;
}

// 供测试/排障用（加载器不消费）
export const internals = {
  runCheck, resolveUp, parseTargets, loadState, saveState, status, providers
};
