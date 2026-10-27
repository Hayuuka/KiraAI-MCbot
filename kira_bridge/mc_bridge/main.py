"""mc_bridge —— 把本机 mineflayer 身体接入 KiraAI。

本机 bot 在家用 NAT 后面，云端无法反向连入，所以由 bot 主动连出。
KiraAI 当前的 WebSocket 插件路由不可用（所有 WS 升级请求都被拒），因此
这里只用 HTTP 轮询，不依赖任何 KiraAI 侧改动：

  bot --GET  /api/plugin/mc_bridge/poll   -> 取走待执行的动作（长轮询）
  bot --POST /api/plugin/mc_bridge/result -> 回报动作结果 + 推送游戏事件

两端都用 token 校验（query/header 均可）。

事件通过 ctx.publish_notice() 注入指定会话，从而复用同一份人格
（memory/core.txt）与同一份会话记忆（chat_memory.json）——不需要复制任何东西。
"""

from __future__ import annotations

import asyncio
import collections
import hmac
import json
import time

from core.plugin import BasePlugin, logger, register
from core.chat import MessageChain
from core.chat.message_elements import Text
from core.chat.message_utils import KiraMessageBatchEvent

PROTOCOL_VERSION = "0.2.0"
DEFAULT_RPC_TIMEOUT = 12.0

# 每小时唤醒上限的滑动窗口
WAKE_WINDOW_SECONDS = 3600

# bot 没来取任务时，一次 poll 最多挂多久（长轮询），减少空转
POLL_HOLD_SECONDS = 20.0


class McBridgePlugin(BasePlugin):
    def __init__(self, ctx, cfg: dict):
        super().__init__(ctx, cfg)
        self.cfg = dict(cfg or {})

        self.bot_name = ""
        self.last_seen = 0.0
        self.next_id = 1

        # 待下发的动作队列（bot 来 poll 时取走）
        self.outbox: collections.deque[dict] = collections.deque()
        # 等待结果的 future：id -> Future
        self.pending: dict[int, asyncio.Future] = {}
        # 新任务/新结果到达时唤醒挂起的 poll
        self._job_wakeup = asyncio.Event()

        # 事件节流状态
        self.wake_times: collections.deque[float] = collections.deque()
        self.recent_text: dict[str, float] = {}
        self.join_leave_last: dict[str, float] = {}
        self.low_health_last = 0.0


    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    async def initialize(self):
        if not self.token():
            logger.warning("[mc_bridge] token 未配置，将拒绝所有身体连接")
        logger.info(
            f"[mc_bridge] 已加载 v{PROTOCOL_VERSION}（HTTP 轮询），"
            f"目标会话 {self.session()}，每小时唤醒上限 {self.max_wakes()}"
        )

    async def terminate(self):
        self._fail_pending("plugin unloading")
        self.outbox.clear()
        logger.info("[mc_bridge] 已卸载")

    # ------------------------------------------------------------------
    # 配置读取
    # ------------------------------------------------------------------

    def _cfg(self, key, default=None):
        value = self.cfg.get(key, default)
        return default if value is None else value

    def token(self) -> str:
        return str(self._cfg("token", "") or "").strip()

    def session(self) -> str:
        return str(self._cfg("session", "") or "").strip()

    def enabled(self) -> bool:
        return bool(self._cfg("enabled", True))

    def max_wakes(self) -> int:
        try:
            return max(1, int(self._cfg("max_wakes_per_hour", 30)))
        except (TypeError, ValueError):
            return 30

    # ------------------------------------------------------------------
    # HTTP 端点
    # ------------------------------------------------------------------

    def _check_token(self, token: str) -> bool:
        expected = self.token()
        if not expected:
            return False
        return hmac.compare_digest(str(token or ""), expected)

    @register.api(method="GET", path="/poll", auth=False)
    async def api_poll(self, token: str = "", wait: float = 0.0):
        """bot 来取待执行的动作。没有任务时最多挂 wait 秒（长轮询）。

        返回 {"ok": true, "online": bool, "job": {...}|null}
        """
        if not self.enabled():
            return {"ok": False, "error": "plugin disabled"}
        if not self._check_token(token):
            return {"ok": False, "error": "invalid token"}

        self.last_seen = time.time()

        hold = max(0.0, min(POLL_HOLD_SECONDS, float(wait or 0.0)))
        deadline = time.time() + hold
        while not self.outbox and time.time() < deadline:
            self._job_wakeup.clear()
            try:
                await asyncio.wait_for(self._job_wakeup.wait(), timeout=max(0.05, deadline - time.time()))
            except asyncio.TimeoutError:
                break

        if not self.outbox:
            return {"ok": True, "online": True, "job": None}

        job = self.outbox.popleft()
        return {"ok": True, "online": True, "job": job}

    @register.api(method="POST", path="/result", auth=False)
    async def api_result(self, payload: dict = None):
        """bot 回报动作结果，或推送游戏事件。

        {"token": "...", "type": "result", "id": N, "ok": true, "data": {...}}
        {"token": "...", "type": "event", "kind": "chat", "data": {...}}
        """
        body = payload or {}
        if not self.enabled():
            return {"ok": False, "error": "plugin disabled"}
        if not self._check_token(body.get("token")):
            return {"ok": False, "error": "invalid token"}

        self.last_seen = time.time()
        kind = str(body.get("type") or "")

        if kind == "result":
            call_id = body.get("id")
            future = self.pending.pop(call_id, None)
            if future is not None and not future.done():
                if body.get("ok"):
                    future.set_result(body.get("data") if body.get("data") is not None else {})
                else:
                    error_payload = {
                        key: value for key, value in body.items()
                        if key not in ("token", "type", "id", "ok", "error")
                    }
                    future.set_result({
                        "__remote_error__": str(body.get("error") or "remote error"),
                        **error_payload,
                    })
            return {"ok": True}

        if kind == "event":
            await self._on_event({"kind": body.get("kind"), "data": body.get("data") or {}})
            return {"ok": True}

        if kind == "hello":
            self.bot_name = str(body.get("name") or "")
            logger.info(f"[mc_bridge] 身体上线：{self.bot_name}")
            return {"ok": True, "protocol": PROTOCOL_VERSION}

        return {"ok": False, "error": f"unknown type: {kind}"}

    @register.api(method="GET", path="/status", auth=False)
    async def api_status(self, token: str = ""):
        if not self._check_token(token):
            return {"ok": False, "error": "invalid token"}
        return {
            "ok": True,
            "protocol": PROTOCOL_VERSION,
            "bot": self.bot_name,
            "connected": self.is_connected(),
            "queue": len(self.outbox),
            "pending": len(self.pending),
            "last_seen": self.last_seen,
        }

    # ------------------------------------------------------------------
    # RPC
    # ------------------------------------------------------------------

    def is_connected(self) -> bool:
        """近 30 秒内 bot 有过来往，视为在线。"""
        return self.last_seen > 0 and (time.time() - self.last_seen) < 30

    def _fail_pending(self, reason: str):
        for call_id, future in list(self.pending.items()):
            self.pending.pop(call_id, None)
            if not future.done():
                future.set_exception(RuntimeError(reason))

    async def rpc(self, tool: str, args: dict | None = None, timeout: float = DEFAULT_RPC_TIMEOUT) -> dict:
        """把动作放进队列，等 bot 轮询取走并回来交结果。"""
        if not self.is_connected():
            return {"ok": False, "error": "MC 身体未连接（本机 bot 没开或已掉线）"}

        call_id = self.next_id
        self.next_id += 1
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self.pending[call_id] = future
        self.outbox.append({"id": call_id, "tool": tool, "args": args or {}})
        self._job_wakeup.set()

        try:
            data = await asyncio.wait_for(future, timeout=max(1.0, min(30.0, float(timeout))))
        except asyncio.TimeoutError:
            return {"ok": False, "error": f"{tool} 超时（{timeout:.0f}s）"}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
        finally:
            self.pending.pop(call_id, None)

        if not isinstance(data, dict):
            return {"ok": True, "data": data}
        if "__remote_error__" in data:
            error = str(data.get("__remote_error__") or "remote error")
            details = {key: value for key, value in data.items() if key != "__remote_error__"}
            return {"ok": False, "error": error, **details}
        return {"ok": True, **data}

    # ------------------------------------------------------------------
    # 工具（与本地 mc_bot 的动作一一对应）
    # ------------------------------------------------------------------

    @register.tool(
        "mc_status",
        "查看 MC 身体当前状态：是否在线、坐标、维度、血量、饥饿、主手物品、附近玩家、行为模式。",
        {"type": "object", "properties": {}, "required": []},
    )
    async def mc_status(self, event: KiraMessageBatchEvent = None):
        return await self.rpc("mc_status", {}, timeout=6)

    @register.tool(
        "mc_body",
        "查看我现在的完整状态：正在做什么、最近结果、还能做什么、为什么没做事。",
        {"type": "object", "properties": {}, "required": []},
    )
    async def mc_body(self, event: KiraMessageBatchEvent = None):
        return await self.rpc("mc_body", {}, timeout=6)

    @register.tool(
        "mc_do",
        "让我做一件具体的事。只能做 mc_body 返回的 can 列表里列出的事；不要自己编任务名。",
        {
            "type": "object",
            "properties": {
                "do": {"type": "string", "description": "mc_body.can[].do，例如 collectBlock、goto、sleep"},
                "args": {"type": "object", "description": "对应 can[].args，可原样传入"},
                "say": {"type": "string", "description": "可选：开始执行时在游戏里说一句话"},
            },
            "required": ["do"],
        },
    )
    async def mc_do(self, event: KiraMessageBatchEvent = None, do: str = "", args: dict | None = None,
                    say: str = ""):
        task_name = str(do or "").strip()
        if not task_name:
            return {"ok": False, "error": "do 不能为空"}
        payload = {"do": task_name, "args": args if isinstance(args, dict) else {}}
        if say:
            payload["say"] = str(say)[:200]
        return await self.rpc("mc_do", payload, timeout=8)

    @register.tool(
        "mc_say",
        "让 MC 身体在游戏内聊天里说一句话。",
        {
            "type": "object",
            "properties": {"text": {"type": "string", "description": "要说的话，最长 200 字符"}},
            "required": ["text"],
        },
    )
    async def mc_say(self, event: KiraMessageBatchEvent = None, text: str = ""):
        text = " ".join(str(text or "").replace("\r", " ").replace("\n", " ").split())
        if not text:
            return {"ok": False, "error": "内容为空"}
        if len(text) > 200:
            text = text[:200]
        return await self.rpc("mc_say", {"text": text}, timeout=6)

    @register.tool(
        "mc_move",
        "已弃用，请优先用 mc_body + mc_do。让 MC 身体移动到某个目标：跟随玩家、前往指定方块、或走到坐标。只等最多 12 秒，"
        "没到会返回 moving=true，可以再调一次或用 mc_status 查看进度。",
        {
            "type": "object",
            "properties": {
                "target": {
                    "type": "string",
                    "description": "player:玩家名 / block:方块id / xyz:x,y,z"
                }
            },
            "required": ["target"],
        },
    )
    async def mc_move(self, event: KiraMessageBatchEvent = None, target: str = ""):
        target = str(target or "").strip()
        if not target:
            return {"ok": False, "error": "target 不能为空"}
        return await self.rpc("mc_move", {"target": target}, timeout=14)

    @register.tool(
        "mc_follow",
        "已弃用，请优先用 mc_body + mc_do。让 MC 身体持续跟随某个玩家。停止用 mc_stop。",
        {
            "type": "object",
            "properties": {"player": {"type": "string", "description": "玩家名"}},
            "required": ["player"],
        },
    )
    async def mc_follow(self, event: KiraMessageBatchEvent = None, player: str = ""):
        player = str(player or "").strip()
        if not player:
            return {"ok": False, "error": "player 不能为空"}
        return await self.rpc("mc_follow", {"player": player}, timeout=6)

    @register.tool(
        "mc_stop",
        "让 MC 身体停止当前所有动作，回到原地待命。",
        {"type": "object", "properties": {}, "required": []},
    )
    async def mc_stop(self, event: KiraMessageBatchEvent = None):
        return await self.rpc("mc_stop", {}, timeout=6)

    @register.tool(
        "mc_plan",
        "已弃用，请优先用 mc_body + mc_do。一次给出 2-5 步的连续计划，身体会按顺序自己执行，每步做完自动接下一步。"
        "比连续调用 mc_mode 更好：中间不用再问你，行动更连贯。",
        {
            "type": "object",
            "properties": {
                "steps": {
                    "type": "array",
                    "description": "按顺序执行的步骤列表",
                    "items": {
                        "type": "object",
                        "properties": {
                            "mode": {"type": "string", "enum": ["mine", "wander", "guard", "follow", "idle", "sleep"]},
                            "label": {"type": "string", "description": "这一步在做什么，用于日志"},
                            "block": {"type": "string", "description": "mine 模式的方块，如 #minecraft:logs"},
                            "count": {"type": "integer", "description": "mine 模式挖多少个"},
                            "maxMinutes": {"type": "number", "description": "这一步最多几分钟"},
                            "radius": {"type": "integer", "description": "搜索半径"},
                            "player": {"type": "string", "description": "follow 模式的目标玩家"},
                        },
                        "required": ["mode"],
                    },
                }
            },
            "required": ["steps"],
        },
    )
    async def mc_plan(self, event: KiraMessageBatchEvent = None, steps: list = None):
        if not isinstance(steps, list) or not steps:
            return {"ok": False, "error": "steps 不能为空"}
        return await self.rpc("mc_plan", {"steps": steps}, timeout=8)

    @register.tool(
        "mc_mode",
        "已弃用，请优先用 mc_body + mc_do。设置 MC 身体的持续行为模式。模式在本地循环执行，不需要反复调用。",
        {
            "type": "object",
            "properties": {
                "mode": {
                    "type": "string",
                    "enum": ["idle", "follow", "guard", "mine", "wander", "sleep"],
                    "description": "idle 待命 / follow 跟随 / guard 打怪守家 / mine 挖指定方块 / wander 附近闲逛 / sleep 找床睡觉（天亮自动醒，没床则会待命）"
                },
                "player": {"type": "string", "description": "follow 模式必填"},
                "block": {"type": "string", "description": "mine 模式必填，方块 id 或 #minecraft:logs 这类标签"},
                "radius": {"type": "integer", "description": "搜索半径。mine 默认 32，wander 默认 6"},
                "count": {"type": "integer", "description": "mine 模式挖够多少个就停（不填则用时长和背包空间兜底）"},
                "maxMinutes": {"type": "number", "description": "mine 模式最多挖几分钟"}
            },
            "required": ["mode"],
        },
    )
    async def mc_mode(self, event: KiraMessageBatchEvent = None, mode: str = "", player: str = "",
                      block: str = "", radius: int = 0, count: int = 0, maxMinutes: float = 0):
        requested = str(mode or "idle")
        # 挖矿要有足够大的搜索范围，否则"附近 6 格找不到树"这种误判会频繁发生
        default_radius = 32 if requested == "mine" else 6
        radius = max(1, min(64, int(radius or default_radius)))
        args = {"mode": requested, "radius": radius}
        if count:
            args["count"] = max(1, int(count))
        if maxMinutes:
            args["maxMinutes"] = max(0.5, float(maxMinutes))
        if player:
            args["player"] = str(player)
        if block:
            args["block"] = str(block)
        if requested in ("idle", "guard", "sleep"):
            return await self.rpc("mc_do", {"do": requested, "args": {}}, timeout=8)
        if requested == "mine":
            task_args = {
                "selector": str(block or "#minecraft:logs"),
                "radius": radius,
            }
            if count:
                task_args["count"] = max(1, int(count))
            if maxMinutes:
                task_args["maxMinutes"] = max(0.5, float(maxMinutes))
            return await self.rpc("mc_do", {"do": "collectBlock", "args": task_args}, timeout=8)
        return await self.rpc("mc_mode", args, timeout=8)

    @register.tool(
        "mc_scan",
        "扫描 MC 身体附近的方块与实体。返回附近方块种类前 10、实体列表、矿物坐标前 10。",
        {
            "type": "object",
            "properties": {"radius": {"type": "integer", "description": "半径 1-16，默认 12"}},
            "required": [],
        },
    )
    async def mc_scan(self, event: KiraMessageBatchEvent = None, radius: int = 12):
        radius = max(1, min(16, int(radius or 12)))
        return await self.rpc("mc_scan", {"radius": radius}, timeout=10)

    @register.tool(
        "mc_inventory",
        "查看 MC 身体的背包内容。",
        {"type": "object", "properties": {}, "required": []},
    )
    async def mc_inventory(self, event: KiraMessageBatchEvent = None):
        return await self.rpc("mc_inventory", {}, timeout=6)

    @register.tool(
        "mc_drop",
        "丢掉背包里的物品。支持指定数量或 all；丢完会回读背包确认真的少了。",
        {
            "type": "object",
            "properties": {
                "item": {"type": "string", "description": "物品 id 或常见中文名，如 dirt、iron_sword、泥土"},
                "count": {
                    "oneOf": [
                        {"type": "integer", "minimum": 1},
                        {"type": "string", "enum": ["all"]},
                    ],
                    "description": "数量，默认 1；all 表示全部丢掉",
                },
            },
            "required": ["item"],
        },
    )
    async def mc_drop(self, event: KiraMessageBatchEvent = None, item: str = "", count=1):
        item = str(item or "").strip()
        if not item:
            return {"ok": False, "error": "item 不能为空"}
        if isinstance(count, str) and count.strip().lower() == "all":
            normalized_count = "all"
        else:
            try:
                normalized_count = max(1, int(count or 1))
            except (TypeError, ValueError):
                return {"ok": False, "error": "count 必须是正整数或 all"}
        return await self.rpc("mc_drop", {"item": item, "count": normalized_count}, timeout=10)

    @register.tool(
        "mc_equip",
        "把背包里的物品穿到对应槽位：护甲自动判断头盔/胸甲/护腿/靴子，其他物品放主手。穿完会回读槽位确认。",
        {
            "type": "object",
            "properties": {
                "item": {"type": "string", "description": "物品 id 或常见中文名，如 iron_chestplate、铁胸甲"}
            },
            "required": ["item"],
        },
    )
    async def mc_equip(self, event: KiraMessageBatchEvent = None, item: str = ""):
        item = str(item or "").strip()
        if not item:
            return {"ok": False, "error": "item 不能为空"}
        return await self.rpc("mc_equip", {"item": item}, timeout=8)

    @register.tool(
        "mc_unequip",
        "脱下指定槽位的装备或手持物。槽位：head/torso/legs/feet/hand/off-hand。",
        {
            "type": "object",
            "properties": {
                "slot": {
                    "type": "string",
                    "enum": ["head", "torso", "legs", "feet", "hand", "off-hand"],
                    "description": "要清空的槽位",
                }
            },
            "required": ["slot"],
        },
    )
    async def mc_unequip(self, event: KiraMessageBatchEvent = None, slot: str = ""):
        slot = str(slot or "").strip().lower()
        if not slot:
            return {"ok": False, "error": "slot 不能为空"}
        return await self.rpc("mc_unequip", {"slot": slot}, timeout=8)

    @register.tool(
        "mc_attack",
        "已弃用，请优先用 mc_body + mc_do。让 MC 身体攻击附近的目标。PVP 默认关闭，只能打敌对生物。",
        {
            "type": "object",
            "properties": {"target": {"type": "string", "description": "目标实体名或玩家名"}},
            "required": ["target"],
        },
    )
    async def mc_attack(self, event: KiraMessageBatchEvent = None, target: str = ""):
        target = str(target or "").strip()
        if not target:
            return {"ok": False, "error": "target 不能为空"}
        return await self.rpc("mc_attack", {"target": target}, timeout=6)

    @register.tool(
        "mc_recent_chat",
        "读取游戏内最近的聊天记录。",
        {
            "type": "object",
            "properties": {"limit": {"type": "integer", "description": "条数，1-30，默认 20"}},
            "required": [],
        },
    )
    async def mc_recent_chat(self, event: KiraMessageBatchEvent = None, limit: int = 20):
        limit = max(1, min(30, int(limit or 20)))
        return await self.rpc("mc_recentChat", {"limit": limit}, timeout=6)

    # ------------------------------------------------------------------
    # 事件分级
    # ------------------------------------------------------------------

    async def _on_event(self, frame: dict):
        kind = str(frame.get("kind") or "")
        data = frame.get("data") or {}
        if not isinstance(data, dict):
            return

        session = self.session()
        if not session:
            return

        if kind == "chat":
            await self._on_chat(data, session)
            return

        if kind in ("join", "leave"):
            await self._on_join_leave(kind, data, session)
            return

        if kind == "death":
            await self._wake(session, "[MC游戏内] 我死了。", key="death")
            return

        if kind == "intent":
            await self._on_intent(data, session)
            return

        if kind == "health":
            await self._on_low_health(data, session)
            return

        if kind == "task_failed":
            task_kind = str(data.get("kind") or "任务").strip()
            reason = str(data.get("reason") or "unknown").strip()
            await self._wake(
                session,
                f"[MC游戏内] 连续两次做 {task_kind} 都失败了（{reason}）。先看 mc_body 的 can 列表，换一个现在真做得到的事。",
                key="task_failed",
            )
            return

        if kind == "system":
            text = str(data.get("text") or "").strip()
            if text and ("Grim" in text or "反作弊" in text):
                logger.info(f"[mc_bridge] 检测到反作弊告警：{text[:120]}")

    async def _on_intent(self, data: dict, session: str):
        """身体空闲了，问一句接下来做什么。

        这不是"事件通知"，而是一次真实的决策请求：模型收到处境后会自己挑一个
        mc_mode 调用，身体那边就会开始执行。所以用 is_mentioned=True 唤醒。
        """
        if not self.is_connected():
            return
        if not bool(self._cfg("auto_play", True)):
            return
        if self._wake_budget_exhausted():
            return

        # 新行为层：处境里已经带了真实可执行能力 can[]，不再由云端手写模式清单。
        if isinstance(data.get("can"), list):
            situation = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
            text = (
                f"[MC游戏内] 身体现在空闲了，处境如下：\n{situation}\n"
                "只从 can 列表里选一项，然后调用 mc_do（do 用 can[].do，args 可原样传）。"
                "不要编造 can 里没有的能力；如果确实没合适的事，就选 idle。"
            )
            self.wake_times.append(time.time())
            await self.ctx.publish_notice(session, MessageChain([Text(text)]), is_mentioned=True)
            return

        hp = data.get("hp")
        food = data.get("food")
        pos = data.get("pos")
        tod = data.get("timeOfDay")
        day = data.get("dayProgress") or {}
        underground = data.get("underground")
        last = str(data.get("lastResult") or "").strip()

        bits = []
        if hp is not None:
            bits.append(f"血量{hp}")
        if food is not None:
            bits.append(f"饥饿{food}")
        if isinstance(pos, list) and len(pos) == 3:
            bits.append(f"位置{pos[0]},{pos[1]},{pos[2]}")
        if underground is True:
            bits.append("在地下")
        elif underground is False:
            bits.append("在地表")
        if isinstance(tod, (int, float)):
            if isinstance(day, dict) and day.get("phase"):
                remain = day.get("remainingSec")
                remain_txt = f"，还有约{max(1, remain // 60)}分钟天亮" if day["phase"] == "night" and remain else ""
                if day["phase"] == "night":
                    bits.append(f"夜晚{remain_txt}")
                else:
                    bits.append("白天")
            else:
                bits.append("白天" if 0 <= tod < 13000 else "夜晚")

        state = "，".join(bits) if bits else "状态未知"
        reason = f"上一件事结束了（{last}）。" if last else "现在闲下来了。"

        is_night = isinstance(tod, (int, float)) and not (0 <= tod < 13000)
        if is_night:
            if underground is True:
                options = (
                    "你在地下，昼夜不影响这里。继续 mine 挖矿最有效率，"
                    "想收工就用 sleep（会回到地表找床）。"
                )
            else:
                options = (
                    "天黑了，地表会刷怪。**优先选 sleep 找床睡过去**（天黑就该睡，天亮自动醒）；"
                    "如果附近确实没床，sleep 会失败并告诉你，那时再考虑 mine 挖进地下或 guard 守家。"
                    "别选 idle 干等，那一整晚就白过了。"
                )
        else:
            options = (
                "可以 mine 砍木头或挖矿、wander 四处探索、guard 守家。"
                "想连着做几件事就用 mc_plan 一次给出多步计划，比一步步问更连贯。"
            )

        text = (
            f"[MC游戏内] {reason}目前{state}。\n"
            f"没人给你下命令，你自己决定接下来做什么，然后开始行动。{options}选一个，别只说话不行动。"
        )
        self.wake_times.append(time.time())
        await self.ctx.publish_notice(session, MessageChain([Text(text)]), is_mentioned=True)

    async def _on_chat(self, data: dict, session: str):
        player = str(data.get("player") or "").strip()
        text = str(data.get("text") or "").strip()
        if not player or not text:
            return

        # 回声过滤：自己说的话不回流
        if self.bot_name and player.lower() == self.bot_name.lower():
            return

        if self._duplicate(text):
            return

        # 只有被点名才交给 LLM。没点名的一律丢弃，连缓冲都不进——
        # 缓冲区的内容会在下一次唤醒时一并送进上下文，等于替闲聊付 token。
        mentioned = self._mentions_bot(text)
        if not mentioned:
            return
        if not bool(self._cfg("wake_on_chat_mention", True)):
            return

        line = f"[MC游戏内] {player}: {text}"
        await self._wake(session, line + "（在游戏里叫你）", key=f"chat:{player}")

    def _mentions_bot(self, text: str) -> bool:
        """游戏名 + 配置里的中文别名，任一命中即视为在叫她。"""
        if not text:
            return False
        lowered = text.lower()
        names = []
        if self.bot_name:
            names.append(self.bot_name)
        raw = str(self._cfg("bot_aliases", "") or "")
        names.extend(part.strip() for part in raw.replace("，", ",").split(",") if part.strip())
        for name in names:
            if name and name.lower() in lowered:
                return True
        return False

    async def _on_join_leave(self, kind: str, data: dict, session: str):
        player = str(data.get("player") or "").strip()
        if not player:
            return
        # 自己的上下线不必播报
        if self.bot_name and player.lower() == self.bot_name.lower():
            return
        now = time.time()
        if now - self.join_leave_last.get(player, 0.0) < 300:
            return
        self.join_leave_last[player] = now
        verb = "加入了游戏" if kind == "join" else "离开了游戏"
        await self._wake(session, f"[MC游戏内] {player} {verb}。", key=f"{kind}:{player}")

    async def _on_low_health(self, data: dict, session: str):
        now = time.time()
        if now - self.low_health_last < 60:
            return
        self.low_health_last = now
        hp = data.get("hp")
        await self._wake(session, f"[MC游戏内] 我血量很低（{hp}）。", key="low_health")

    # ------------------------------------------------------------------
    # 注入与节流
    # ------------------------------------------------------------------

    async def _wake(self, session: str, text: str, key: str = ""):
        """叫醒模型：is_mentioned=True。受每小时上限约束。"""
        # 身体没上线时，游戏事件没有意义，直接丢弃，不占上下文
        if not self.is_connected():
            return
        if not bool(self._cfg("wake_on_self_event", True)) and key in ("death", "low_health"):
            return
        if self._wake_budget_exhausted():
            logger.info("[mc_bridge] 已达每小时唤醒上限，事件丢弃")
            return
        self.wake_times.append(time.time())
        await self.ctx.publish_notice(session, MessageChain([Text(text)]), is_mentioned=True)

    def _wake_budget_exhausted(self) -> bool:
        now = time.time()
        while self.wake_times and now - self.wake_times[0] > WAKE_WINDOW_SECONDS:
            self.wake_times.popleft()
        return len(self.wake_times) >= self.max_wakes()

    def _duplicate(self, text: str) -> bool:
        now = time.time()
        if len(self.recent_text) > 512:
            self.recent_text = {k: v for k, v in self.recent_text.items() if now - v < 30}
        last = self.recent_text.get(text)
        self.recent_text[text] = now
        return last is not None and now - last < 30



