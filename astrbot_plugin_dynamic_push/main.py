"""
astrbot_plugin_dynamic_push - B 站动态推送

轮询指定 UP 的最新动态（文字/图文/视频/转发等），发现新动态即推送到指定会话。
使用 WBI 签名 + 登录态 cookies，兼容 B 站 IP 风控（失败自动跳过）。
首次运行仅记录基线（不推送历史动态）。
"""

import asyncio
import hashlib
import json
import logging
import re
import time
import urllib.parse
from datetime import datetime
from pathlib import Path
from typing import Optional

import aiohttp

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register
from astrbot.core.message.message_event_result import MessageChain
from astrbot.core.platform.message_session import MessageSession

PLUGIN_LOGGER = logging.getLogger("DynamicPushPlugin")

API_BASE = "https://api.bilibili.com"
DYNAMIC_FEED_URL = f"{API_BASE}/x/polymer/web-dynamic/v1/feed/space"
NAV_URL = f"{API_BASE}/x/web-interface/nav"

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.bilibili.com",
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://www.bilibili.com",
}

MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

DYNAMIC_TYPE_LABEL = {
    "DYNAMIC_TYPE_WORD": "文字动态",
    "DYNAMIC_TYPE_DRAW": "图文动态",
    "DYNAMIC_TYPE_AV": "视频动态",
    "DYNAMIC_TYPE_ARTICLE": "专栏动态",
    "DYNAMIC_TYPE_FORWARD": "转发动态",
    "DYNAMIC_TYPE_MUSIC": "音乐动态",
    "DYNAMIC_TYPE_LIVE_RCMD": "直播动态",
    "DYNAMIC_TYPE_PGC": "番剧动态",
    "DYNAMIC_TYPE_COMMON": "通用动态",
}

# 单条消息最大字符数，超过则自动分段发送（保证长动态完整送达，不再截断为“…”）
MAX_MSG_CHARS = 3500


def _derive_mixin_key(img_key: str, sub_key: str) -> str:
    orig = img_key + sub_key
    return "".join(orig[i] for i in MIXIN_KEY_ENC_TAB)[:32]


def _sign_params(params: dict, mixin_key: str) -> dict:
    signed = dict(params)
    signed["wts"] = int(time.time())
    query = urllib.parse.urlencode(dict(sorted(signed.items())))
    for ch in "!'()*":
        query = query.replace(urllib.parse.quote(ch), "")
    signed["w_rid"] = hashlib.md5((query + mixin_key).encode()).hexdigest()
    return signed


def _load_cookies(path: Path) -> dict:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, list):
        out = {}
        for item in raw:
            if isinstance(item, dict) and item.get("name"):
                out[item["name"]] = item.get("value", "")
        return out
    return {}


def _extract_reserve(dyn_mod: dict) -> Optional[dict]:
    """提取 ADDITIONAL_TYPE_RESERVE 预约卡（直播预约/视频预约）。"""
    additional = dyn_mod.get("additional") or {}
    if additional.get("type") != "ADDITIONAL_TYPE_RESERVE":
        return None
    reserve = additional.get("reserve") or {}
    button = reserve.get("button") or {}
    return {
        "title": (reserve.get("title") or "").strip(),
        "desc1": ((reserve.get("desc1") or {}).get("text") or "").strip(),
        "desc2": ((reserve.get("desc2") or {}).get("text") or "").strip(),
        "desc3": ((reserve.get("desc3") or {}).get("text") or "").strip(),
        "reserve_total": reserve.get("reserve_total") or 0,
        "stype": reserve.get("stype"),
        "button_type": button.get("type"),
        "rid": reserve.get("rid"),
        "jump_url": (reserve.get("jump_url") or "").strip(),
    }


def _extract_live_rcmd(major: dict) -> Optional[dict]:
    """提取 MAJOR_TYPE_LIVE_RCMD（开播/预约开播），content 为 JSON 字符串。"""
    live_rcmd = major.get("live_rcmd") or {}
    if not live_rcmd:
        return None
    content = live_rcmd.get("content") or {}
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except Exception:
            content = {}
    content = content or {}
    play = content.get("live_play_info") or {}
    plan = content.get("live_plan_info") or {}
    reserve_type = live_rcmd.get("reserve_type")
    live_status = play.get("live_status")
    return {
        "reserve_type": reserve_type,
        "live_status": live_status,
        "title": (play.get("title") or plan.get("title") or "").strip(),
        "room_id": play.get("room_id") or plan.get("room_id") or "",
        "start_ts": (
            play.get("live_start_time")
            or plan.get("start_time")
            or plan.get("reserve_start_time")
            or 0
        ),
        "area_name": (play.get("area_name") or plan.get("area_name") or "").strip(),
        "link": (play.get("link") or plan.get("link") or "").strip(),
        # 预约态：content 含 live_plan_info，或 reserve_type 非 0
        "is_planned": bool(plan) or (reserve_type not in (None, 0)),
    }


def _collect_image_urls(major: dict, limit: int = 6) -> list:
    """从 major 里提取图片 URL（opus/draw/archive 封面），http 统一转 https。"""
    urls = []
    opus = major.get("opus") or {}
    for pic in opus.get("pics") or []:
        u = (pic.get("url") or "").strip()
        if u:
            urls.append(u)
    draw = major.get("draw") or {}
    for item in draw.get("items") or []:
        u = (item.get("src") or "").strip()
        if u:
            urls.append(u)
    archive = major.get("archive") or {}
    if archive.get("cover"):
        urls.append(str(archive["cover"]).strip())
    norm = []
    for u in urls:
        if u.startswith("http://"):
            u = "https://" + u[len("http://"):]
        if u not in norm:
            norm.append(u)
    return norm[:limit]


def _extract_dynamic(item: dict) -> dict:
    """从动态条目中提取展示信息。"""
    mods = item.get("modules") or {}
    author = mods.get("module_author") or {}
    dyn_mod = mods.get("module_dynamic") or {}
    desc = dyn_mod.get("desc") or {}
    major = dyn_mod.get("major") or {}
    dtype = str(item.get("type", ""))
    label = DYNAMIC_TYPE_LABEL.get(dtype, "动态")

    text = (desc.get("text") or "").strip()
    image_count = 0
    emoji_codes = []

    if not text:
        if dtype == "DYNAMIC_TYPE_DRAW":
            opus = major.get("opus") or {}
            summary = ((opus.get("summary") or {}).get("text") or "").strip()
            opus_title = (opus.get("title") or "").strip()
            if summary or opus_title:
                image_count = len(opus.get("pics") or [])
                if summary and opus_title:
                    text = f"{opus_title}｜{summary}"
                elif summary:
                    text = summary
                else:
                    text = opus_title
            else:
                draw = major.get("draw") or {}
                items = draw.get("items") or []
                image_count = len(items)
                if items and (items[0].get("description") or "").strip():
                    text = items[0]["description"].strip()
                if not text:
                    text = f"（包含 {image_count} 张图片）" if image_count else "（图文动态）"
        elif dtype == "DYNAMIC_TYPE_ARTICLE":
            article = major.get("article") or {}
            text = (article.get("title") or "").strip() or "（专栏动态）"
        elif dtype == "DYNAMIC_TYPE_AV":
            av = major.get("archive") or {}
            text = (av.get("title") or "").strip() or "（视频动态）"
        elif dtype == "DYNAMIC_TYPE_FORWARD":
            orig = (desc.get("orig_desc") or {}).get("text") or ""
            text = f"转发：{(orig or '（转发动态）')[:80]}"

    image_urls = _collect_image_urls(major)
    # OPUS 富文本：表情节点收集为代码列表，正文去掉表情代码
    opus = major.get("opus") or {}
    nodes = ((opus.get("summary") or {}).get("rich_text_nodes")) or []
    if nodes:
        parts = []
        for n in nodes:
            if n.get("type") == "RICH_TEXT_NODE_TYPE_EMOJI":
                code = (n.get("text") or "").strip()
                if code:
                    emoji_codes.append(code)
            else:
                t = (n.get("text") or "")
                if t:
                    parts.append(t)
        cleaned = "".join(parts).strip()
        if cleaned:
            text = cleaned
    if dtype == "DYNAMIC_TYPE_FORWARD":
        # 转发动态：图片与内容取自原动态 orig
        orig_item = item.get("orig") or {}
        omods = orig_item.get("modules") or {}
        omd = omods.get("module_dynamic") or {}
        omajor = omd.get("major") or {}
        image_urls = _collect_image_urls(omajor) or image_urls
        oauthor = (omods.get("module_author") or {}).get("name") or ""
        otext = (omd.get("desc") or {}).get("text") or ""
        if not otext:
            opus = omajor.get("opus") or {}
            otext = ((opus.get("summary") or {}).get("text")) or (opus.get("title") or "")
        if oauthor:
            text = f"转发自 {oauthor}：{(otext or '（转发动态）')[:80]}"
        elif otext:
            text = f"转发：{otext[:80]}"

    return {
        "id": str(item.get("id_str") or item.get("id") or ""),
        "type": dtype,
        "label": label,
        "text": text,
        "image_count": image_count,
        "pub_ts": int(author.get("pub_ts") or 0),
        "author": author.get("name") or "",
        "pinned": bool(((mods.get("module_tag") or {}).get("text") or "").strip()),
        "live_reserve": _extract_reserve(dyn_mod),
        "live_rcmd": _extract_live_rcmd(major),
        "image_urls": image_urls,
        "emoji_codes": emoji_codes,
    }


@register(
    "astrbot_plugin_dynamic_push",
    "Codex",
    "B 站动态推送：监控指定 UP 的最新动态/直播预约并推送到指定会话",
    "1.2.0",
)
class DynamicPushPlugin(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.config = config
        self.check_interval = max(
            1, int(getattr(config, "check_interval_minutes", 3) or 3)
        )
        self.push_targets = self._parse_targets(
            getattr(
                config,
                "push_target",
                "default:FriendMessage:943867461,default:GroupMessage:1041495420",
            )
            or "default:FriendMessage:943867461,default:GroupMessage:1041495420"
        )
        self.cookie_path = Path(
            str(
                getattr(
                    config,
                    "bili_cookie_path",
                    "/AstrBot/data/plugin_data/astrbot_plugin_bilivideo/bili_cookies.json",
                )
                or "/AstrBot/data/plugin_data/astrbot_plugin_bilivideo/bili_cookies.json"
            )
        )
        # max_preview_chars <= 0 表示不限制长度（完整推送，超长自动分段）
        self.max_preview = int(getattr(config, "max_preview_chars", 0) or 0)
        self.uids = self._parse_uids(getattr(config, "uids", ""))
        self.state_dir = Path(
            "/AstrBot/data/plugin_data/astrbot_plugin_dynamic_push"
        )
        self.state_path = self.state_dir / "state.json"
        self.state = self._load_state()
        self._task: Optional[asyncio.Task] = None
        self._session: Optional[aiohttp.ClientSession] = None
        self._next_check_ts: float = 0
        logger.info(
            f"DynamicPushPlugin 初始化: uids={self.uids}, "
            f"interval={self.check_interval}min, targets={self.push_targets}"
        )

    # ---------- 配置/状态 ----------
    def _parse_uids(self, raw) -> dict:
        if isinstance(raw, str):
            parts = [
                p.strip() for p in raw.replace("，", ",").split(",") if p.strip()
            ]
        else:
            parts = [str(p).strip() for p in (raw or [])]
        uids: dict = {}
        for p in parts:
            if ":" in p:
                mid, name = p.split(":", 1)
            else:
                mid, name = p, p
            if mid.strip():
                uids[mid.strip()] = name.strip() or mid.strip()
        return uids

    def _parse_targets(self, raw) -> list:
        if isinstance(raw, str):
            parts = [
                p.strip() for p in raw.replace("，", ",").split(",") if p.strip()
            ]
        else:
            parts = [str(p).strip() for p in (raw or [])]
        if not parts:
            parts = ["default:FriendMessage:943867461"]
        return parts

    def _load_state(self) -> dict:
        try:
            return json.loads(self.state_path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def _save_state(self) -> None:
        try:
            self.state_dir.mkdir(parents=True, exist_ok=True)
            self.state_path.write_text(
                json.dumps(self.state, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except OSError as exc:
            PLUGIN_LOGGER.warning(f"保存状态失败: {exc}")

    # ---------- B 站 API ----------
    async def _get_mixin_key(self, session: aiohttp.ClientSession, cookies: dict) -> str:
        async with session.get(NAV_URL) as resp:
            nav = await resp.json(content_type=None)
        wbi = ((nav.get("data") or {}).get("wbi_img")) or {}
        img_url = wbi.get("img_url", "")
        sub_url = wbi.get("sub_url", "")
        if not img_url or not sub_url:
            raise RuntimeError(f"WBI nav 缺少密钥: {str(nav)[:200]}")
        img_key = img_url.rsplit("/", 1)[-1].split(".")[0]
        sub_key = sub_url.rsplit("/", 1)[-1].split(".")[0]
        return _derive_mixin_key(img_key, sub_key)

    async def _fetch_latest(
        self,
        session: aiohttp.ClientSession,
        mid: str,
        cookies: dict,
        mixin_key: str,
    ) -> list:
        params = {
            "host_mid": mid,
            "timezone_offset": -480,
            "features": (
                "itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote,"
                "decorationCard,forwardList,imageViewFlag,reply2folding,"
                "superVipGroup,preventComment,feedForwardContentStyle,ugcDelete"
            ),
        }
        signed = _sign_params(params, mixin_key)
        async with session.get(DYNAMIC_FEED_URL, params=signed) as resp:
            body = await resp.json(content_type=None)
        code = body.get("code")
        if code != 0:
            raise RuntimeError(
                f"动态接口 code={code} message={body.get('message')} "
                f"(可能触发风控，请降低频率或稍后再试)"
            )
        items = ((body.get("data") or {}).get("items")) or []
        return [_extract_dynamic(it) for it in items if it.get("id_str") or it.get("id")]

    # ---------- 推送 ----------
    def _format_push(self, name: str, dyn: dict) -> Optional[str]:
        reserve = dyn.get("live_reserve")
        rcmd = dyn.get("live_rcmd")

        # 纯视频动态交给 bilivideo 插件（带 AI 总结推送），此处跳过以避免重复推送
        if dyn.get("type") == "DYNAMIC_TYPE_AV":
            PLUGIN_LOGGER.info(
                f"{name} 视频动态由 bilivideo 负责，dynamic_push 跳过"
            )
            return None

        # 直播预约卡（button.type=2 为直播预约，1 为视频预约）
        if reserve and reserve.get("button_type") == 2:
            lines = [f"🔔 {name} 发布了直播预约", "━━━━━━━━━━━━"]
            if reserve.get("title"):
                lines.append(f"📌 {reserve['title']}")
            if reserve.get("desc1"):
                lines.append(f"🕐 {reserve['desc1']}")
            people = reserve.get("desc2") or (
                f"{reserve['reserve_total']} 人预约"
                if reserve.get("reserve_total")
                else ""
            )
            if people:
                lines.append(f"👥 {people}")
            if reserve.get("desc3"):
                lines.append(f"🎁 {reserve['desc3']}")
            jump = reserve.get("jump_url") or f"https://t.bilibili.com/{dyn['id']}"
            lines.append(f"🔗 {jump}")
            return "\n".join(lines)

        # 直播动态：已开播由 livemonitor 负责推送，避免重复；仅推预约待开播
        if rcmd:
            if rcmd.get("live_status") == 1:
                PLUGIN_LOGGER.info(
                    f"{name} 开播通知(LIVE_RCMD)由 livemonitor 负责，跳过"
                )
                return None
            if rcmd.get("is_planned"):
                lines = [f"🔔 {name} 预约的直播即将开始", "━━━━━━━━━━━━"]
                if rcmd.get("title"):
                    lines.append(f"📌 {rcmd['title']}")
                if rcmd.get("start_ts"):
                    try:
                        lines.append(
                            f"🕐 {datetime.fromtimestamp(int(rcmd['start_ts'])):%Y-%m-%d %H:%M}"
                        )
                    except Exception:
                        lines.append(f"🕐 {rcmd['start_ts']}")
                if rcmd.get("area_name"):
                    lines.append(f"🏷 {rcmd['area_name']}")
                link = rcmd.get("link") or (
                    f"https://live.bilibili.com/{rcmd['room_id']}"
                    if rcmd.get("room_id")
                    else ""
                )
                if link:
                    lines.append(f"🔗 {link}")
                return "\n".join(lines)
            return None

        # 常规动态（完整正文，不做截断；超长由发送层自动分段）
        label = dyn.get("label") or "动态"
        header = f"📢 {name} · 新{label}"
        body = (dyn.get("text") or "").strip() or "（无文字内容）"
        lines = [header, "━━━━━━━━━━━━", body]
        if dyn.get("image_count"):
            lines.append(f"🖼 共 {dyn['image_count']} 张图片")
        if dyn.get("pub_ts"):
            ts = datetime.fromtimestamp(dyn["pub_ts"])
            lines.append(f"🕐 {ts:%Y-%m-%d %H:%M}")
        lines.append(f"🔗 https://t.bilibili.com/{dyn['id']}")
        return "\n".join(lines)

    async def _send(self, text: str, image_urls: Optional[list] = None) -> bool:
        return await self._send_chain(text, image_urls)

    async def _send_chain(
        self,
        text: str,
        image_urls: Optional[list] = None,
        emoji_urls: Optional[list] = None,
    ) -> bool:
        """推送一条动态到全部目标，返回是否全部发送成功。

        只有全部目标都成功时返回 True；任一目标失败返回 False，
        由调用方决定是否推进状态，从而让失败的目标在下轮重试。
        """
        cap = self.max_preview if self.max_preview > 0 else MAX_MSG_CHARS
        # 长文本按上限分段，保证完整送达（不再截断为“…”）
        if len(text) <= cap:
            chunks = [text]
        else:
            chunks = [text[i : i + cap] for i in range(0, len(text), cap)]
        all_ok = True
        for target in self.push_targets:
            try:
                for idx, chunk in enumerate(chunks):
                    session = MessageSession.from_str(target)
                    chain = MessageChain().message(chunk)
                    # 图片只随首段发送，避免重复刷屏
                    if idx == 0:
                        for url in (image_urls or [])[:6]:
                            try:
                                chain.url_image(url)
                            except Exception:
                                pass
                        for url in (emoji_urls or [])[:9]:
                            try:
                                chain.url_image(url)
                            except Exception:
                                pass
                    await self.context.send_message(session, chain)
                PLUGIN_LOGGER.info(
                    f"已发送推送 -> {target}（共 {len(chunks)} 段）"
                )
            except Exception as exc:
                all_ok = False
                PLUGIN_LOGGER.warning(f"推送失败 -> {target}: {exc}")
        return all_ok

    async def _resolve_emotes(
        self,
        session: aiohttp.ClientSession,
        rpid: str,
        codes: list,
    ) -> dict:
        """通过 B 站 emote API 把表情代码解析为图片 URL。"""
        if not codes:
            return {}
        url = f"https://api.bilibili.com/x/emote/user/panel?business=reply&rpid={rpid}"
        try:
            async with session.get(url) as resp:
                body = await resp.json(content_type=None)
            if body.get("code") != 0:
                return {}
            mapping = {}
            for pkg in ((body.get("data") or {}).get("packages") or []):
                for emote in pkg.get("emote") or []:
                    t = (emote.get("text") or "").strip()
                    u = (emote.get("url") or "").strip()
                    if t and u:
                        mapping[t] = u
            return {c: mapping[c] for c in codes if c in mapping}
        except Exception as exc:
            PLUGIN_LOGGER.warning(f"解析表情失败: {exc}")
            return {}

    # ---------- 主循环 ----------
    async def _scan(self) -> None:
        if not self.uids:
            return
        if not self.cookie_path.exists():
            PLUGIN_LOGGER.warning(f"cookies 文件不存在: {self.cookie_path}")
            return
        cookies = _load_cookies(self.cookie_path)
        if not cookies:
            PLUGIN_LOGGER.warning("cookies 为空，跳过本轮")
            return
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                headers=DEFAULT_HEADERS,
                cookies=cookies,
                timeout=aiohttp.ClientTimeout(total=20),
            )
        session = self._session
        try:
            mixin_key = await self._get_mixin_key(session, cookies)
        except Exception as exc:
            PLUGIN_LOGGER.warning(f"获取 WBI 密钥失败: {exc}")
            return

        for mid, name in self.uids.items():
            try:
                items = await self._fetch_latest(session, mid, cookies, mixin_key)
                if not items:
                    continue
                # 置顶动态会一直排在首位，取第一个非置顶项作为“最新动态”
                latest = next((it for it in items if not it.get("pinned")), items[0])
                dyn_id = latest["id"]
                last = (self.state.get(mid) or {}).get("last_dyn")
                if not last:
                    self.state.setdefault(mid, {})["last_dyn"] = dyn_id
                    PLUGIN_LOGGER.info(
                        f"{name}({mid}) 首次基线记录 dyn={dyn_id}，不推送历史动态"
                    )
                    continue
                if dyn_id == last:
                    continue
                text = self._format_push(name, latest)
                sent = True
                if text:
                    emoji_map = await self._resolve_emotes(
                        session, dyn_id, latest.get("emoji_codes") or []
                    )
                    emoji_urls = [
                        emoji_map[c]
                        for c in (latest.get("emoji_codes") or [])
                        if c in emoji_map
                    ]
                    sent = await self._send_chain(
                        text, latest.get("image_urls"), emoji_urls
                    )
                if sent:
                    self.state.setdefault(mid, {})["last_dyn"] = dyn_id
                    PLUGIN_LOGGER.info(f"已推送 {name}({mid}) 新动态 {dyn_id}")
                else:
                    PLUGIN_LOGGER.warning(
                        f"{name}({mid}) 新动态 {dyn_id} 推送未全部成功，"
                        "保留状态，下轮自动重试"
                    )
            except Exception as exc:
                PLUGIN_LOGGER.warning(f"检查 {name}({mid}) 动态失败: {exc}")
            await asyncio.sleep(1)
        self._save_state()

    async def _run(self) -> None:
        # 启动后先做一轮基线/检查
        try:
            await self._scan()
        except Exception as exc:
            PLUGIN_LOGGER.warning(f"首轮扫描失败: {exc}")
        while True:
            self._next_check_ts = time.time() + self.check_interval * 60
            await asyncio.sleep(self.check_interval * 60)
            try:
                await self._scan()
            except Exception as exc:
                PLUGIN_LOGGER.warning(f"动态扫描失败: {exc}")

    async def initialize(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def terminate(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        if self._session and not self._session.closed:
            await self._session.close()

    # ---------- 订阅管理（交互式，比改配置更直观） ----------
    CONFIG_PATH = Path(
        "/AstrBot/data/config/astrbot_plugin_dynamic_push_config.json"
    )

    @staticmethod
    def _extract_mid(q: str) -> Optional[str]:
        q = (q or "").strip()
        if q.isdigit():
            return q
        m = re.search(r"(?:space\.)?bilibili\.com/(?:space/)?(\d+)", q)
        if m:
            return m.group(1)
        return None

    def _cmd_args(self, event) -> str:
        raw = getattr(event, "message_str", "") or ""
        raw = raw.lstrip("/")
        parts = raw.split(None, 1)
        return parts[1].strip() if len(parts) > 1 else ""

    async def _http_get_json(self, url: str, params: dict = None) -> dict:
        session = self._session
        if session is None or session.closed:
            session = aiohttp.ClientSession(
                headers=DEFAULT_HEADERS,
                timeout=aiohttp.ClientTimeout(total=20),
            )
            self._session = session
        cookies = {}
        if self.cookie_path.exists():
            try:
                cookies = _load_cookies(self.cookie_path)
            except Exception:
                cookies = {}
        async with session.get(url, params=params, cookies=cookies) as resp:
            return await resp.json(content_type=None)

    async def _fetch_name(self, mid: str) -> str:
        try:
            body = await self._http_get_json(
                f"{API_BASE}/x/space/acc/info", {"mid": mid}
            )
            if body.get("code") == 0:
                return (body.get("data") or {}).get("name") or f"UP_{mid}"
        except Exception as exc:
            PLUGIN_LOGGER.warning(f"获取昵称失败 {mid}: {exc}")
        return f"UP_{mid}"

    async def _search_mid(self, keyword: str) -> Optional[str]:
        try:
            body = await self._http_get_json(
                f"{API_BASE}/x/web-interface/search/all/v2",
                {"keyword": keyword},
            )
            for group in (body.get("data") or {}).get("result") or []:
                if group.get("result_type") == "user":
                    for item in group.get("data") or []:
                        mid = item.get("mid") or item.get("uid")
                        if mid:
                            return str(mid)
        except Exception as exc:
            PLUGIN_LOGGER.warning(f"昵称搜索失败: {exc}")
        return None

    def _persist_uids(self) -> bool:
        try:
            uids_str = ",".join(f"{m}:{n}" for m, n in self.uids.items())
            try:
                self.config["uids"] = uids_str
            except Exception:
                pass
            data = {}
            if self.CONFIG_PATH.exists():
                try:
                    data = json.loads(
                        self.CONFIG_PATH.read_text(encoding="utf-8")
                    )
                except Exception:
                    data = {}
            data["uids"] = uids_str
            self.CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
            self.CONFIG_PATH.write_text(
                json.dumps(data, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            return True
        except Exception as exc:
            PLUGIN_LOGGER.warning(f"持久化 uids 失败: {exc}")
            return False

    @filter.command("动态订阅", alias={"动态订阅列表", "我的动态订阅"})
    async def sub_list_command(self, event: AstrMessageEvent):
        if not self.uids:
            yield event.plain_result(
                "📋 当前没有订阅任何 UP 主\n"
                "添加：/动态订阅添加 <UID 或空间链接或昵称>"
            )
            return
        lines = ["📋 动态推送订阅列表：", "━━━━━━━━━━━━"]
        for i, (mid, name) in enumerate(self.uids.items(), 1):
            lines.append(f"{i}. {name} (UID:{mid})")
        lines.append(f"\n共 {len(self.uids)} 个")
        yield event.plain_result("\n".join(lines))

    @filter.command("动态订阅添加", alias={"添加动态订阅", "订阅动态"})
    async def sub_add_command(self, event: AstrMessageEvent):
        q = self._cmd_args(event)
        if not q:
            yield event.plain_result(
                "❌ 请提供 UP 主 UID、空间链接或昵称\n"
                "用法：/动态订阅添加 <UID 或 space.bilibili.com/123 或昵称>"
            )
            return
        mid = self._extract_mid(q)
        if not mid:
            yield event.plain_result(f"🔍 正在按昵称搜索：{q} ...")
            mid = await self._search_mid(q)
            if not mid:
                yield event.plain_result(
                    "❌ 无法识别，请直接提供 UID 或 space 链接"
                )
                return
        name = await self._fetch_name(mid)
        self.uids[mid] = name
        if self._persist_uids():
            yield event.plain_result(
                f"✅ 已添加订阅：{name} (UID:{mid})\n查看列表：/动态订阅"
            )
        else:
            yield event.plain_result(
                f"⚠️ 已加入运行内存，但配置文件写入失败，重启后可能丢失。UID:{mid}"
            )

    @filter.command("动态订阅移除", alias={"移除动态订阅", "取消动态订阅"})
    async def sub_remove_command(self, event: AstrMessageEvent):
        q = self._cmd_args(event)
        if not q:
            yield event.plain_result(
                "❌ 请提供要移除的 UID 或昵称\n"
                "用法：/动态订阅移除 <UID 或昵称>"
            )
            return
        mid = self._extract_mid(q)
        target_mid = None
        if mid and mid in self.uids:
            target_mid = mid
        else:
            for m, n in self.uids.items():
                if n == q or m == q:
                    target_mid = m
                    break
        if not target_mid:
            yield event.plain_result(f"⚠️ 未找到订阅：{q}")
            return
        name = self.uids.pop(target_mid)
        if self._persist_uids():
            yield event.plain_result(
                f"✅ 已移除订阅：{name} (UID:{target_mid})\n查看列表：/动态订阅"
            )
        else:
            yield event.plain_result(
                f"⚠️ 已从运行内存移除，但配置文件写入失败。UID:{target_mid}"
            )

    # ---------- 指令 ----------
    @filter.command("dynamic_push_status", alias={"动态状态", "动态推送状态"})
    async def status_command(self, event: AstrMessageEvent):
        lines = ["📡 动态推送状态"]
        if not self.uids:
            lines.append("⚠️ 未配置 uids")
        for mid, name in self.uids.items():
            last = (self.state.get(mid) or {}).get("last_dyn") or "未记录"
            lines.append(f"· {name} ({mid})：最新 dyn={last}")
        if self._next_check_ts:
            remain = max(0, int(self._next_check_ts - time.time()))
            lines.append(f"⏱ 下次检查：{remain} 秒后")
        lines.append(f"⏲ 间隔：{self.check_interval} 分钟")
        yield event.plain_result("\n".join(lines))
