import { createAutonomous } from './autonomous.js';
import { searchVideos, getVideoInfo } from './bili-api.js';
import { getConfig } from '../../src/config.js';
import { chatCompletion } from '../../src/llm.js';
import { resolveSchedule } from './schedule.js';

export function makePersonaBrowser({ config, fetcher, storage, log, warn, filter }) {
  let sender = null;
  let blockedUntil = 0;
  const settings = () => {
    const c = config();
    const number = (k, fallback, min, max) => Math.max(min, Math.min(max, Number.isFinite(Number(c[k])) ? Number(c[k]) : fallback));
    return { ...c,
      autonomousEnabled: c.autonomousEnabled === true,
      feedbackQQ: String(c.feedbackQQ || '').trim(),
      recommendCount: number('recommendCount', 3, 1, 3),
      candidateCount: number('candidateCount', 5, 1, 8),
      dailyRounds: number('dailyRounds', 3, 1, 12),
      checkIntervalMin: number('checkIntervalMin', 120, 30, 1440),
      riskCooldownMin: number('riskCooldownMin', 180, 30, 1440),
      ...resolveSchedule(c)
    };
  };
  const request = async (url, opts = {}) => {
    if (Date.now() < blockedUntil) throw new Error('412 风控冷却中');
    const s = settings();
    const h = new Headers(opts.headers || {});
    if (new URL(url).hostname === 'api.bilibili.com') {
      const cookie = [s.sessdata ? `SESSDATA=${s.sessdata}` : '', s.biliJct ? `bili_jct=${s.biliJct}` : '', h.get('cookie') || ''].filter(Boolean).join('; ');
      if (cookie) h.set('cookie', cookie);
    }
    const res = await fetcher(url, { ...opts, headers: h });
    if (res.status === 412 || res.status === 403) {
      blockedUntil = Date.now() + s.riskCooldownMin * 60000;
      throw new Error(`HTTP ${res.status} B站风控`);
    }
    return res;
  };
  async function subtitle(info, signal) {
    if (!info.cid || !(settings().sessdata || settings().hasBiliLogin)) return '';
    const url = `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(info.bvid)}&cid=${info.cid}`;
    const r = await request(url, { headers: { referer: 'https://www.bilibili.com/', 'user-agent': 'Mozilla/5.0' }, signal });
    if (!r.ok) return '';
    const j = await r.json();
    if ([-412,-352,-403].includes(j.code)) throw new Error('412 字幕接口风控');
    const tracks = j.data?.subtitle?.subtitles || [];
    const t = tracks.find(t => /zh|ai-zh/.test(t.lan)) || tracks[0];
    if (!t?.subtitle_url) return '';
    const u = new URL(t.subtitle_url.startsWith('//') ? `https:${t.subtitle_url}` : t.subtitle_url);
    if (u.protocol !== 'https:' || !/(^|\.)hdslb\.com$|(^|\.)bilibili\.com$/.test(u.hostname)) return '';
    const sr = await fetcher(u.href, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    if (!sr.ok) return '';
    const body = await sr.json();
    return (body.body || []).map(x => String(x.content || '')).join(' ').slice(0, 4500);
  }
  const engine = createAutonomous({
    now: Date.now, settings, storage, log, warn, ready: () => !!sender?.sendTextBatch,
    // Global character defines interests. Private-owner style does not change selection.
    persona: () => getConfig().persona || {},
    filter,
    llm: async (system, user, maxTokens, signal) => {
      const c = getConfig(), messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
      const r = await chatCompletion({ messages, maxTokens, signal, temperature: 0.8,
        skillContext: { api: c.api, model: c.api?.model, thinkingMode: 'off', chatKey: `private:${settings().feedbackQQ}`, biliAutonomous: true } });
      return r?.message?.content || '';
    },
    search: q => searchVideos(request, q, settings().candidateCount, { pages: 1 }),
    inspect: async (candidate, signal) => {
      // A blocked details API does not invalidate search metadata. Stop further requests
      // this round, label the evidence, and persist cooldown via the engine's result.
      if (Date.now() < blockedUntil) return { ...candidate, desc: String(candidate.desc || '').slice(0,1000), evidence: 'metadata', riskBlocked: true };
      try {
        const info = await getVideoInfo(request, candidate.bvid);
        const text = await subtitle(info, signal);
        return { bvid: info.bvid, title: info.title, author: info.author, desc: info.desc.slice(0,1000), subtitle: text, evidence: text ? 'subtitle' : 'metadata' };
      } catch(e) {
        if (/412|403|风控/.test(e.message)) {
          blockedUntil = Date.now() + settings().riskCooldownMin * 60000;
          return { bvid: candidate.bvid, title: candidate.title, author: candidate.author, desc: String(candidate.desc || '').slice(0,1000), evidence: 'metadata', riskBlocked: true };
        }
        if (signal.aborted) throw e;
        return { bvid: candidate.bvid, title: candidate.title, author: candidate.author, desc: String(candidate.desc || '').slice(0,1000), evidence: 'metadata' };
      }
    },
    send: async (qq, text, signal) => {
      if (signal.aborted) throw new Error('发送前已取消');
      if (!sender?.sendTextBatch) throw new Error('等待 QQ 发送队列就绪，本轮不自动重发');
      const r = await sender.sendTextBatch(`private:${qq}`, [text]);
      if (r?.deduped) throw new Error('发送队列判定重复');
    }
  });
  return { ...engine, capture: ctx => { if (ctx?.sender?.sendTextBatch) sender = ctx.sender; } };
}
