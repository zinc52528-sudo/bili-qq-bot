import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import sqlite3
import time
from datetime import datetime
from typing import Optional
from urllib import parse
from zoneinfo import ZoneInfo

import aiohttp
from cryptography.hazmat.primitives import serialization

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register
from astrbot.core.message.message_event_result import MessageChain
from astrbot.core.platform.message_session import MessageSession
from astrbot.core.platform.message_type import MessageType

PLUGIN_LOGGER = logging.getLogger("DailyReportPlugin")
WEEKDAYS = "一二三四五六日"
MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52,
]


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


@register(
    "astrbot_plugin_daily_report",
    "Codex",
    "每日 08:00 自动推送日报（天气/今日安排/赛事/新视频/直播预约/新动态），确定性链路",
    "1.1.0",
)
class DailyReportPlugin(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.target_session_str = str(
            getattr(config, "target_session", "default:FriendMessage:943867461")
            or "default:FriendMessage:943867461"
        )
        self._dt_target_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "dingtalk_target.json"
        )
        self.dingtalk_target = self._load_dingtalk_target()
        self.cron_expression = str(
            getattr(config, "cron_expression", "0 8 * * *") or "0 8 * * *"
        )
        self.default_city = str(getattr(config, "default_city", "上海") or "上海")
        raw_interests = str(getattr(config, "interests", "英雄联盟,LPL") or "")
        self.interests = [x.strip() for x in raw_interests.split(",") if x.strip()] or ["英雄联盟"]

        self.api_host = str(getattr(config, "api_host", "mb33jrhhn3.re.qweatherapi.com") or "").strip().rstrip("/")
        self.auth_mode = str(getattr(config, "auth_mode", "jwt") or "jwt").strip().lower()
        self.api_key = str(getattr(config, "api_key", "") or "")
        self.credential_id = str(getattr(config, "credential_id", "") or "")
        self.project_id = str(getattr(config, "project_id", "") or "")
        self.private_key_path = str(
            getattr(config, "private_key_path", "/AstrBot/data/qweather_private.pem")
            or "/AstrBot/data/qweather_private.pem"
        )
        self.exa_key = str(getattr(config, "exa_key", "") or "")
        self.bili_cookie_path = str(
            getattr(
                config,
                "bili_cookie_path",
                "/AstrBot/data/plugin_data/astrbot_plugin_bilivideo/bili_cookies.json",
            )
            or "/AstrBot/data/plugin_data/astrbot_plugin_bilivideo/bili_cookies.json"
        )
        raw_esports = str(getattr(config, "bili_esports_uids", "50329118") or "50329118")
        self.bili_esports_uids = [x.strip() for x in raw_esports.split(",") if x.strip()]
        raw_extra = str(getattr(config, "bili_extra_uids", "") or "")
        self.bili_extra_uids = [x.strip() for x in raw_extra.split(",") if x.strip()]
        self._jwt_cache = {"token": None, "exp": 0}
        self._wbi_cache = {"mixin_key": None, "ts": 0}
        self._llm_cfg = self._load_llm_config()

        asyncio.get_event_loop().create_task(self._register_cron())
        logger.info(
            f"DailyReportPlugin 初始化: target={self.target_session_str}, "
            f"cron={self.cron_expression}, city={self.default_city}, interests={self.interests}"
        )

    # ===================== cron 注册 =====================
    async def _register_cron(self):
        await asyncio.sleep(2)
        try:
            mgr = self.context.cron_manager
            try:
                existing = await mgr.list_jobs()
                for job in existing:
                    if job.name == "每日日报" and job.job_type == "basic":
                        await mgr.delete_job(job.job_id)
            except Exception as exc:
                PLUGIN_LOGGER.warning(f"清理旧日报任务失败: {exc}")
            job = await mgr.add_basic_job(
                name="每日日报",
                cron_expression=self.cron_expression,
                handler=self._send_daily_report,
                description="每日 08:00 自动推送日报（天气/今日安排/赛事/游戏动态）",
                timezone="Asia/Shanghai",
                persistent=True,
            )
            PLUGIN_LOGGER.info(f"每日日报 cron 已注册: {job.job_id} {self.cron_expression}")
        except Exception as exc:
            PLUGIN_LOGGER.error(f"注册每日日报 cron 失败: {exc}", exc_info=True)

    # ===================== 命令 =====================
    @filter.command("daily_report", alias={"日报", "日报测试"})
    async def daily_report_command(self, event: AstrMessageEvent):
        yield event.plain_result("正在生成日报，请稍候…")
        try:
            text = await self._compose_report()
            # 回复到触发会话（钉钉/QQ 均可）；若是钉钉则记住该会话，供 08:00 cron 使用
            sid = event.get_session_id()
            if str(sid).startswith("dingtalk"):
                self._remember_dingtalk_target(sid)
            await self._send(text, sid)
        except Exception as exc:
            PLUGIN_LOGGER.error(f"日报生成失败: {exc}", exc_info=True)
            try:
                await self._send(f"❌ 日报生成失败：{exc}", event.get_session_id())
            except Exception:
                pass

    # ===================== 发送 =====================
    def _get_cron_target(self) -> str:
        """cron 目标：优先用记住的钉钉会话，否则用配置 target_session。"""
        if self.dingtalk_target:
            return self.dingtalk_target
        return self.target_session_str

    def _load_dingtalk_target(self) -> str:
        try:
            if os.path.exists(self._dt_target_path):
                with open(self._dt_target_path, "r", encoding="utf-8") as f:
                    val = (json.load(f) or {}).get("session_id")
                if val and str(val).startswith("dingtalk"):
                    return str(val)
        except Exception as exc:
            PLUGIN_LOGGER.warning(f"读取钉钉推送目标失败: {exc}")
        return ""

    def _remember_dingtalk_target(self, sid: str) -> None:
        try:
            with open(self._dt_target_path, "w", encoding="utf-8") as f:
                json.dump({"session_id": str(sid)}, f, ensure_ascii=False)
            self.dingtalk_target = str(sid)
            PLUGIN_LOGGER.info(f"已记住钉钉推送目标会话: {sid}")
        except Exception as exc:
            PLUGIN_LOGGER.warning(f"保存钉钉推送目标失败: {exc}")

    async def _send(self, text: str, target: str = None):
        if not target:
            target = self._get_cron_target()
        session = MessageSession.from_str(str(target))
        await self.context.send_message(session, MessageChain().message(text))

    async def _send_daily_report(self):
        target = self._get_cron_target()
        text = await self._compose_report()
        await self._send(text, target)
        return f"日报已发送（{len(text)} 字）→ {target}"

    # ===================== 日报拼装 =====================
    async def _compose_report(self) -> str:
        tz = ZoneInfo("Asia/Shanghai")
        now = datetime.now(tz)
        date_str = now.strftime("%Y-%m-%d")
        weekday = WEEKDAYS[now.weekday()]
        lines = [f"📅 {date_str}（周{weekday}）· 每日早报", ""]

        lines.append("🌤 今日天气")
        try:
            weather = await self._weather_now(self.default_city)
            if weather:
                lines.append(weather)
            forecast = await self._weather_forecast(self.default_city, 3)
            if forecast:
                lines.append(forecast)
        except Exception as exc:
            lines.append(f"（天气获取失败：{exc}）")
        lines.append("")

        lines.append("🗓 今日安排")
        schedule = self._today_schedule(now)
        lines.extend(schedule if schedule else ["暂无安排"])
        lines.append("")

        lines.append("⚔️ 今日赛事")
        try:
            matches = await self._bili_summary(
                "英雄联盟赛事账号最新动态",
                self.bili_esports_uids,
                limit_per_uid=6,
            )
            if not matches:
                matches = await self._exa_search(f"{now.month}月{now.day}日 英雄联盟 LPL 赛程")
            lines.extend(matches[:5] if isinstance(matches, list) else [matches])
        except Exception as exc:
            lines.append(f"（赛事获取失败：{exc}）")
        lines.append("")

        all_uids = self._load_all_uids()

        lines.append("📢 新视频（关注的 UP）")
        try:
            lines.extend(await self._new_videos_section(all_uids))
        except Exception as exc:
            lines.append(f"（新视频获取失败：{exc}）")
        lines.append("")

        lines.append("🔔 直播预约（今天/明天）")
        try:
            lines.extend(await self._reservations_section(all_uids))
        except Exception as exc:
            lines.append(f"（直播预约获取失败：{exc}）")
        lines.append("")

        lines.append("📰 新动态（近 48 小时）")
        try:
            lines.extend(await self._new_dynamics_section(all_uids))
        except Exception as exc:
            lines.append(f"（新动态获取失败：{exc}）")

        return "\n".join(lines)

    # ===================== B 站动态（最新投稿 + LLM 总结） =====================
    def _load_subscription_uids(self) -> list:
        try:
            path = "/AstrBot/data/plugin_data/astrbot_plugin_bilivideo/subscriptions.json"
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            uids = []
            for group in (data.get("subscriptions") or {}).values():
                for up in group.get("up_list") or []:
                    mid = str(up.get("mid") or "").strip()
                    if mid and mid not in uids:
                        uids.append(mid)
            return uids
        except Exception:
            return []

    def _load_subscription_pairs(self) -> list:
        """读取 bilivideo 订阅的 (mid, name) 对。"""
        try:
            path = "/AstrBot/data/plugin_data/astrbot_plugin_bilivideo/subscriptions.json"
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            pairs = []
            for group in (data.get("subscriptions") or {}).values():
                for up in group.get("up_list") or []:
                    mid = str(up.get("mid") or "").strip()
                    if mid:
                        pairs.append((mid, str(up.get("name") or mid)))
            return pairs
        except Exception:
            return []

    def _load_all_uids(self) -> dict:
        """合并所有关注的 UID -> 名称（dynamic_push uids + bilivideo 订阅 + 额外配置）。"""
        uids: dict = {}
        try:
            with open(
                "/AstrBot/data/config/astrbot_plugin_dynamic_push_config.json",
                "r",
                encoding="utf-8",
            ) as f:
                cfg = json.load(f)
            for part in str(cfg.get("uids", "")).replace("，", ",").split(","):
                part = part.strip()
                if not part:
                    continue
                if ":" in part:
                    mid, name = part.split(":", 1)
                else:
                    mid, name = part, part
                if mid.strip():
                    uids[mid.strip()] = name.strip() or mid.strip()
        except Exception:
            pass
        for mid, name in self._load_subscription_pairs():
            uids.setdefault(mid, name)
        for mid in self.bili_extra_uids:
            uids.setdefault(mid, mid)
        for mid in self.bili_esports_uids:
            uids.setdefault(mid, mid)
        return uids

    async def _bili_summary(
        self, title: str, uids: list, limit_per_uid: int = 3, max_total: int = 8
    ) -> list:
        """拉取 UP 最新投稿，交给 LLM 总结。"""
        items = []
        for uid in uids[:5]:
            videos = await self._bili_latest_videos(uid, limit_per_uid)
            for v in videos:
                items.append(f"[{v['name']}] {v['title']}（{v['date']}）")
            if len(items) >= max_total:
                break
        if not items:
            return []
        summary = await self._llm_summarize(title, items)
        if not summary:
            return ["· " + item for item in items[:5]]
        return [summary]

    async def _bili_latest_videos(self, mid: str, limit: int = 3) -> list:
        """WBI 签名调用空间投稿接口。"""
        query = await self._wbi_query({"mid": mid, "ps": str(limit), "pn": "1", "order": "pubdate"})
        url = "https://api.bilibili.com/x/space/wbi/arc/search?" + query
        headers = await self._bili_headers(mid)
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers, timeout=15) as resp:
                data = await resp.json()
        if data.get("code") != 0:
            return []
        vlist = (((data.get("data") or {}).get("list") or {}).get("vlist")) or []
        out = []
        now = time.time()
        for v in vlist[:limit]:
            ts = int(v.get("created") or v.get("pubdate") or 0)
            date_str = ""
            if ts:
                date_str = datetime.fromtimestamp(ts, ZoneInfo("Asia/Shanghai")).strftime("%m-%d")
            title = v.get("title") or ""
            out.append(
                {
                    "title": title,
                    "date": date_str,
                    "name": v.get("author") or str(mid),
                    "ts": ts,
                }
            )
        return out

    async def _bili_dynamic_feed(self, mid: str, limit: int = 10) -> list:
        """WBI 签名拉取 UP 动态流（feed/space）。"""
        params = {
            "host_mid": mid,
            "timezone_offset": -480,
            "features": (
                "itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote,"
                "decorationCard,forwardList,imageViewFlag,reply2folding,"
                "superVipGroup,preventComment,feedForwardContentStyle,ugcDelete"
            ),
        }
        query = await self._wbi_query(params)
        url = "https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?" + query
        headers = await self._bili_headers(mid)
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers, timeout=20) as resp:
                data = await resp.json()
        if data.get("code") != 0:
            return []
        return (((data.get("data") or {}).get("items")) or [])[:limit]

    @staticmethod
    def _extract_reserve(item: dict) -> Optional[dict]:
        """提取直播预约卡（ADDITIONAL_TYPE_RESERVE, button.type=2）。"""
        mods = item.get("modules") or {}
        dyn = mods.get("module_dynamic") or {}
        additional = dyn.get("additional") or {}
        if additional.get("type") != "ADDITIONAL_TYPE_RESERVE":
            return None
        reserve = additional.get("reserve") or {}
        button = reserve.get("button") or {}
        if button.get("type") != 2:
            return None
        return {
            "title": (reserve.get("title") or "").strip(),
            "desc1": ((reserve.get("desc1") or {}).get("text") or "").strip(),
            "desc2": ((reserve.get("desc2") or {}).get("text") or "").strip(),
            "rid": reserve.get("rid"),
        }

    @staticmethod
    def _extract_dynamic_text(item: dict) -> str:
        mods = item.get("modules") or {}
        dyn = mods.get("module_dynamic") or {}
        desc = dyn.get("desc") or {}
        major = dyn.get("major") or {}
        text = (desc.get("text") or "").strip()
        if not text:
            opus = major.get("opus") or {}
            text = ((opus.get("summary") or {}).get("text") or "").strip()
        if not text:
            archive = major.get("archive") or {}
            text = (archive.get("title") or "").strip()
        return text[:60]

    @staticmethod
    def _is_pinned(item: dict) -> bool:
        mods = item.get("modules") or {}
        return bool(((mods.get("module_tag") or {}).get("text") or "").strip())

    @staticmethod
    def _reserve_is_current(desc1: str) -> bool:
        """预约时间是否在今天/明天/未来（按 desc1 里的日期判断）。"""
        if "今天" in desc1 or "明天" in desc1:
            return True
        m = re.search(r"(\d{1,2})[-/月](\d{1,2})", desc1)
        if m:
            mon, day = int(m.group(1)), int(m.group(2))
            now = datetime.now(ZoneInfo("Asia/Shanghai"))
            return (mon, day) >= (now.month, now.day)
        return False

    async def _new_videos_section(self, uids: dict) -> list:
        """近 48 小时有新视频的 UP。"""
        out = []
        now = time.time()
        for mid, name in list(uids.items())[:12]:
            try:
                videos = await self._bili_latest_videos(mid, 5)
            except Exception as exc:
                PLUGIN_LOGGER.warning(f"新视频拉取失败 {mid}: {exc}")
                continue
            fresh = [v for v in videos if v.get("ts") and now - v["ts"] <= 48 * 3600]
            for v in fresh[:2]:
                out.append(f"· {name}：{v['title']}（{v['date']}）")
            await asyncio.sleep(0.3)
        return out or ["（近两天暂无新视频）"]

    async def _reservations_section(self, uids: dict) -> list:
        """直播预约卡（今天/明天优先标记）。"""
        out = []
        for mid, name in list(uids.items())[:12]:
            try:
                items = await self._bili_dynamic_feed(mid, 15)
            except Exception as exc:
                PLUGIN_LOGGER.warning(f"直播预约拉取失败 {mid}: {exc}")
                continue
            seen = set()
            for it in items:
                reserve = self._extract_reserve(it)
                if not reserve:
                    continue
                if reserve["rid"] in seen:
                    continue
                seen.add(reserve["rid"])
                desc1 = reserve["desc1"] or "待定"
                if not self._reserve_is_current(desc1):
                    continue
                desc2 = reserve["desc2"] or ""
                flag = " ⏰" if ("今天" in desc1 or "明天" in desc1) else ""
                suffix = f"｜{desc2}" if desc2 else ""
                out.append(f"· {name}：{reserve['title'] or '直播预约'}（{desc1}{suffix}）{flag}")
                if len(out) >= 8:
                    return out
            await asyncio.sleep(0.3)
        return out or ["（暂未发现直播预约）"]

    async def _new_dynamics_section(self, uids: dict) -> list:
        """各 UP 近 48 小时最新动态。"""
        out = []
        now = time.time()
        for mid, name in list(uids.items())[:12]:
            try:
                items = await self._bili_dynamic_feed(mid, 8)
            except Exception as exc:
                PLUGIN_LOGGER.warning(f"新动态拉取失败 {mid}: {exc}")
                continue
            latest = next((it for it in items if not self._is_pinned(it)), None)
            if not latest:
                continue
            author = ((latest.get("modules") or {}).get("module_author")) or {}
            pub_ts = int(author.get("pub_ts") or 0)
            if not pub_ts or now - pub_ts > 48 * 3600:
                continue
            text = self._extract_dynamic_text(latest)
            dstr = datetime.fromtimestamp(
                pub_ts, ZoneInfo("Asia/Shanghai")
            ).strftime("%m-%d %H:%M")
            out.append(f"· {name}：{text or '（动态）'}（{dstr}）")
            await asyncio.sleep(0.3)
        return out or ["（近两天暂无新动态）"]

    async def _bili_headers(self, mid: str) -> dict:
        try:
            with open(self.bili_cookie_path, "r", encoding="utf-8") as f:
                cookies = json.load(f)
            cookie_str = "; ".join(f"{k}={v}" for k, v in cookies.items() if v)
        except Exception:
            cookie_str = ""
        return {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
            "Referer": f"https://space.bilibili.com/{mid}/video",
            "Cookie": cookie_str,
        }

    async def _wbi_query(self, params: dict) -> str:
        mixin_key = self._wbi_cache.get("mixin_key")
        if not mixin_key or time.time() - self._wbi_cache.get("ts", 0) > 3600:
            headers = await self._bili_headers("0")
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    "https://api.bilibili.com/x/web-interface/nav", headers=headers, timeout=15
                ) as resp:
                    nav = await resp.json()
            wbi = (nav.get("data") or {}).get("wbi_img") or {}
            img_key = wbi.get("img_url", "").rsplit("/", 1)[-1].split(".")[0]
            sub_key = wbi.get("sub_url", "").rsplit("/", 1)[-1].split(".")[0]
            mixin_key = "".join((img_key + sub_key)[i] for i in MIXIN_KEY_ENC_TAB)[:32]
            self._wbi_cache["mixin_key"] = mixin_key
            self._wbi_cache["ts"] = time.time()
        signed = {**params, "wts": int(time.time())}
        query = parse.urlencode(sorted(signed.items()))
        w_rid = hashlib.md5((query + mixin_key).encode()).hexdigest()
        return query + "&w_rid=" + w_rid

    def _load_llm_config(self) -> dict:
        try:
            with open("/AstrBot/data/cmd_config.json", "r", encoding="utf-8") as f:
                cfg = json.load(f)
            sources = cfg.get("provider_sources") or []
            providers = cfg.get("provider") or []
            key = ""
            if sources:
                keys = sources[0].get("key") or []
                key = keys[0] if keys else ""
            api_base = (sources[0].get("api_base") if sources else "") or "https://api.deepseek.com/v1"
            model = (providers[0].get("model") if providers else "") or "deepseek-v4-flash"
            return {"api_base": api_base, "key": key, "model": model}
        except Exception:
            return {"api_base": "https://api.deepseek.com/v1", "key": "", "model": "deepseek-v4-flash"}

    async def _llm_summarize(self, title: str, items: list) -> str:
        if not self._llm_cfg.get("key"):
            return ""
        content = "\n".join(f"- {item}" for item in items)
        payload = {
            "model": self._llm_cfg["model"],
            "messages": [
                {
                    "role": "system",
                    "content": "你是信息摘要助手。用户会给你一批 B 站账号的最新动态（标题+发布日期），"
                    "请用中文做 60~120 字的简洁总结，突出重要信息（比赛结果、更新、活动、直播等），"
                    "不要列清单，直接输出总结内容，不要寒暄。",
                },
                {"role": "user", "content": f"板块：{title}\n{content}"},
            ],
            "temperature": 0.3,
            "max_tokens": 300,
            "stream": False,
        }
        url = self._llm_cfg["api_base"].rstrip("/") + "/chat/completions"
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    url,
                    json=payload,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": "Bearer " + self._llm_cfg["key"],
                    },
                    timeout=60,
                ) as resp:
                    data = await resp.json()
            if resp.status != 200:
                return ""
            return (data.get("choices") or [{}])[0].get("message", {}).get("content", "").strip()
        except Exception as exc:
            PLUGIN_LOGGER.warning(f"LLM 总结失败: {exc}")
            return ""

    # ===================== 今日安排（来自定时任务表） =====================
    def _today_schedule(self, now: datetime) -> list:
        try:
            con = sqlite3.connect("/AstrBot/data/data_v4.db")
            cur = con.cursor()
            cur.execute(
                "SELECT name, description, run_once, cron_expression, payload "
                "FROM cron_jobs WHERE enabled=1"
            )
            rows = cur.fetchall()
            con.close()
        except Exception:
            return []

        today = now.strftime("%Y-%m-%d")
        out = []
        for name, desc, run_once, cron_expr, payload in rows:
            if name == "每日日报":
                continue
            try:
                payload = json.loads(payload) if isinstance(payload, str) else (payload or {})
            except Exception:
                payload = {}
            note = (payload.get("note") or desc or name or "")[:60]
            if run_once:
                run_at = payload.get("run_at") or ""
                if run_at[:10] == today:
                    hm = run_at[11:16] if len(run_at) >= 16 else "全天"
                    out.append(f"· {hm} {note}")
            else:
                parts = (cron_expr or "").split()
                if len(parts) == 5 and parts[0].isdigit() and parts[1].isdigit():
                    hm = f"{int(parts[1]):02d}:{int(parts[0]):02d}"
                    out.append(f"· 每天 {hm} {note}")
        return out

    # ===================== 和风天气 =====================
    def _make_jwt(self) -> str:
        now = int(time.time())
        cached = self._jwt_cache
        if cached["token"] and cached["exp"] > now + 60:
            return cached["token"]
        with open(self.private_key_path, "rb") as f:
            raw = f.read()
        private_key = serialization.load_pem_private_key(raw, password=None)
        header = _b64url(
            json.dumps({"alg": "EdDSA", "kid": self.credential_id}, separators=(",", ":")).encode()
        )
        sub = self.project_id or self.credential_id
        payload = _b64url(
            json.dumps(
                {"sub": sub, "iat": now - 30, "exp": now + 900},
                separators=(",", ":"),
            ).encode()
        )
        signing = f"{header}.{payload}".encode()
        signature = _b64url(private_key.sign(signing))
        token = f"{header}.{payload}.{signature}"
        cached["token"] = token
        cached["exp"] = now + 900
        return token

    async def _qweather_get(self, path: str, params: dict) -> dict:
        host = self.api_host
        if not host.startswith(("http://", "https://")):
            host = "https://" + host
        headers = (
            {"Authorization": "Bearer " + self._make_jwt()}
            if self.auth_mode == "jwt"
            else {"X-QW-Api-Key": self.api_key}
        )
        async with aiohttp.ClientSession() as session:
            async with session.get(host + path, params=params, headers=headers, timeout=15) as resp:
                data = await resp.json()
                if resp.status != 200 or str(data.get("code", "200")) != "200":
                    raise RuntimeError(
                        f"HTTP {resp.status} code={data.get('code')} "
                        f"{json.dumps(data, ensure_ascii=False)[:150]}"
                    )
                return data

    async def _resolve_location(self, city: str) -> Optional[dict]:
        data = await self._qweather_get(
            "/geo/v2/city/lookup", {"location": city, "lang": "zh", "number": 5}
        )
        locs = data.get("location") or []
        if not locs:
            return None
        return sorted(locs, key=lambda x: int(x.get("rank") or 999))[0]

    async def _weather_now(self, city: str) -> Optional[str]:
        loc = await self._resolve_location(city)
        if not loc:
            return None
        data = await self._qweather_get(
            "/v7/weather/now", {"location": loc["id"], "lang": "zh", "unit": "m"}
        )
        now = data.get("now") or {}
        return (
            f"📍 {loc.get('name') or city}：{now.get('text', '未知')} "
            f"{now.get('temp', '?')}℃（体感 {now.get('feelsLike', '?')}℃）｜"
            f"湿度 {now.get('humidity', '?')}% "
            f"{now.get('windDir', '')}{now.get('windScale', '?')}级"
        )

    async def _weather_forecast(self, city: str, days: int = 3) -> Optional[str]:
        loc = await self._resolve_location(city)
        if not loc:
            return None
        data = await self._qweather_get(
            f"/v7/weather/{days}d", {"location": loc["id"], "lang": "zh", "unit": "m"}
        )
        daily = data.get("daily") or []
        if not daily:
            return None
        parts = []
        for day in daily:
            fx = day.get("fxDate", "")
            md = fx[5:].replace("-", "/") if len(fx) >= 10 else fx
            parts.append(
                f"{md} {day.get('textDay', '?')}/{day.get('textNight', '?')} "
                f"{day.get('tempMin', '?')}~{day.get('tempMax', '?')}℃"
            )
        return "未来{}天：{}".format(len(parts), " | ".join(parts))

    # ===================== Exa 搜索 =====================
    async def _exa_search(self, query: str, num: int = 4) -> list:
        if not self.exa_key:
            return []
        async with aiohttp.ClientSession() as session:
            async with session.post(
                "https://api.exa.ai/search",
                json={"query": query, "numResults": num, "contents": {"highlights": True}},
                headers={"x-api-key": self.exa_key, "Content-Type": "application/json"},
                timeout=20,
            ) as resp:
                data = await resp.json()
        if resp.status != 200:
            return []
        out = []
        for res in (data.get("results") or [])[:num]:
            title = res.get("title") or "无标题"
            url = res.get("url") or ""
            highlights = res.get("highlights") or []
            snippet = highlights[0][:70] if highlights else ""
            out.append(f"· {title}" + (f"：{snippet}" if snippet else "") + f"（{url}）")
        return out
