"""Small single-process multi-agent Firefox broker using W3C WebDriver BiDi.

Keep the HTTP server on loopback. Never reuse an interactive user's Firefox profile.
"""
from __future__ import annotations

import asyncio
import collections
import contextlib
from dataclasses import dataclass, field
import json
import os
import secrets
import threading
import time
from typing import Any, Literal
import uuid
from contextlib import asynccontextmanager

import psutil
import websocket
from fastapi import FastAPI, HTTPException, Header, Query, Response
from pydantic import BaseModel, Field
from selenium import webdriver
from selenium.webdriver.firefox.options import Options


class BiDiFailure(RuntimeError):
    pass


class BiDiSocket:
    """One websocket / one WebDriver session / multiplexed command IDs."""

    def __init__(self, url: str, event_callback):
        # geckodriver advertises a loopback WebSocket URL. Disable proxy env
        # interception; this socket must not be routed to an outbound proxy.
        self.ws = websocket.create_connection(url, timeout=30, enable_multithread=True, http_proxy_host=None)
        self.ws.settimeout(1)
        self.event_callback = event_callback
        self.send_lock = threading.Lock()
        self.pending_lock = threading.Lock()
        self.pending: dict[int, dict[str, Any]] = {}
        self.next_id = 0
        self.stopped = threading.Event()
        self.reader = threading.Thread(target=self._receive, daemon=True, name="bidi-events")
        self.reader.start()

    def _receive(self):
        while not self.stopped.is_set():
            try:
                raw = self.ws.recv()
                if not raw:
                    raise BiDiFailure("BiDi websocket disconnected")
                msg = json.loads(raw)
                if "id" in msg:
                    with self.pending_lock:
                        waiter = self.pending.get(msg["id"])
                    if waiter is not None:
                        waiter["response"] = msg
                        waiter["event"].set()
                elif msg.get("type") == "event":
                    with contextlib.suppress(Exception):
                        self.event_callback(msg)
            except websocket.WebSocketTimeoutException:
                continue
            except Exception:
                break
        self.stopped.set()
        with self.pending_lock:
            for waiter in self.pending.values():
                waiter["event"].set()

    def call(self, method: str, params: dict | None = None, timeout: float = 30) -> dict:
        if self.stopped.is_set():
            raise BiDiFailure("BiDi socket is disconnected")
        waiter = {"event": threading.Event(), "response": None}
        with self.pending_lock:
            self.next_id += 1
            ident = self.next_id
            self.pending[ident] = waiter
        try:
            with self.send_lock:
                self.ws.send(json.dumps({"id": ident, "method": method, "params": params or {}}))
            if not waiter["event"].wait(timeout):
                raise BiDiFailure(f"BiDi command timeout: {method}")
            response = waiter["response"]
            if response is None:
                raise BiDiFailure("BiDi connection closed")
            if response.get("type") == "error":
                raise BiDiFailure(f"{method}: {response.get('error')}: {response.get('message')}")
            return response.get("result", {})
        finally:
            with self.pending_lock:
                self.pending.pop(ident, None)

    def close(self):
        self.stopped.set()
        with contextlib.suppress(Exception):
            self.ws.close()
        self.reader.join(timeout=2)


@dataclass
class Task:
    id: str
    token: str
    name: str
    user_context: str
    context: str
    touched: float = field(default_factory=time.monotonic)
    events: collections.deque = field(default_factory=lambda: collections.deque(maxlen=300))
    network_enabled: bool = True
    collector: str | None = None


class BrowserBroker:
    NETWORK_EVENTS = ["network.beforeRequestSent", "network.responseCompleted", "network.fetchError"]

    def __init__(self):
        self.lock = threading.RLock()
        self.input_lock = threading.Lock()
        self.creation_lock = threading.Lock()
        self.tasks: dict[str, Task] = {}
        self.by_context: dict[str, str] = {}
        self.driver = None
        self.bidi = None
        self.max_tasks = int(os.getenv("BROKER_MAX_TASKS", "6"))
        self.max_events = int(os.getenv("BROKER_MAX_EVENTS", "300"))
        self.idle_ttl = int(os.getenv("BROKER_IDLE_TTL_SECONDS", "900"))
        if self.max_tasks < 1 or self.max_events < 1 or self.idle_ttl < 30:
            raise ValueError("Invalid broker capacity / TTL environment settings")

    def start(self):
        opts = Options()
        opts.enable_bidi = True
        if os.getenv("BROKER_HEADLESS", "0") == "1":
            opts.add_argument("-headless")
        binary = os.getenv("FIREFOX_BINARY")
        if binary:
            opts.binary_location = binary
        # Selenium Manager finds geckodriver automatically (may download it once).
        # Always use a fresh automation profile, not a personal browser profile.
        self.driver = webdriver.Firefox(options=opts)
        try:
            ws_url = self.driver.capabilities.get("webSocketUrl")
            if not ws_url:
                raise RuntimeError("Firefox/geckodriver did not expose webSocketUrl")
            self.bidi = BiDiSocket(ws_url, self._on_event)
            self.bidi.call("session.status")
        except Exception:
            self.stop()
            raise

    def stop(self):
        if self.bidi:
            self.bidi.close()
            self.bidi = None
        if self.driver:
            with contextlib.suppress(Exception):
                self.driver.quit()
            self.driver = None

    def _on_event(self, msg: dict):
        params = msg.get("params", {})
        context = params.get("context") or params.get("source", {}).get("context")
        if not context:
            return
        with self.lock:
            task_id = self.by_context.get(context)
            task = self.tasks.get(task_id) if task_id else None
            if not task:
                return
            req = params.get("request", {})
            resp = params.get("response", {})
            task.events.append({
                "event": msg["method"],
                "ts": time.time(),
                "url": req.get("url"),
                "method": req.get("method"),
                "request_id": req.get("request"),
                "status": resp.get("status"),
                "error": params.get("errorText"),
            })

    def create(self, name: str) -> Task:
        # Do not hold self.lock while waiting for BiDi replies: the reader
        # thread must remain able to route asynchronous network events.
        with self.creation_lock:
            with self.lock:
                if len(self.tasks) >= self.max_tasks:
                    raise HTTPException(429, "Maximum active tasks reached")
            uc = self.bidi.call("browser.createUserContext")["userContext"]
            try:
                ctx = self.bidi.call("browsingContext.create", {
                    "type": "tab", "userContext": uc, "background": True
                })["context"]
            except Exception:
                with contextlib.suppress(Exception):
                    self.bidi.call("browser.removeUserContext", {"userContext": uc})
                raise
            task = Task(id=str(uuid.uuid4()), token=secrets.token_urlsafe(32),
                        name=name[:80], user_context=uc, context=ctx,
                        events=collections.deque(maxlen=self.max_events))
            with self.lock:
                self.tasks[task.id] = task
                self.by_context[ctx] = task.id
            try:
                self.bidi.call("session.subscribe", {
                    "events": self.NETWORK_EVENTS, "contexts": [ctx]
                })
            except BiDiFailure:
                task.network_enabled = False
            return task

    def resolve(self, task_id: str, token: str | None) -> Task:
        with self.lock:
            t = self.tasks.get(task_id)
            if t is None or not token or not secrets.compare_digest(t.token, token):
                raise HTTPException(404, "Task not found or invalid task token")
            t.touched = time.monotonic()
            return t

    def delete(self, task_id: str):
        with self.lock:
            t = self.tasks.pop(task_id, None)
            if not t:
                return
            self.by_context.pop(t.context, None)
        # Do not hold the events lock while waiting for a BiDi response.
        if t.collector:
            with contextlib.suppress(BiDiFailure):
                self.bidi.call("network.removeDataCollector", {"collector": t.collector})
        self.bidi.call("browser.removeUserContext", {"userContext": t.user_context})

    def sweep(self):
        with self.lock:
            stale = [t.id for t in self.tasks.values()
                     if time.monotonic() - t.touched >= self.idle_ttl]
        for ident in stale:
            with contextlib.suppress(Exception):
                self.delete(ident)

    def execute(self, t: Task, expression: str):
        res = self.bidi.call("script.evaluate", {
            "expression": expression, "target": {"context": t.context},
            "awaitPromise": False, "resultOwnership": "none"
        })
        if res.get("type") != "success":
            raise BiDiFailure(f"Script exception: {res.get('exceptionDetails', {}).get('text')}")
        value = res.get("result", {})
        return value.get("value")

    def activate(self, t: Task):
        self.bidi.call("browsingContext.activate", {"context": t.context})

    def click(self, t: Task, selector: str):
        # Holding the lock across scroll+activate+coordinates+protocol click
        # prevents another agent from stealing the foreground midway.
        with self.input_lock:
            self.activate(t)
            expression = """(() => {
              const e = document.querySelector(%s);
              if (!e) return JSON.stringify({error: 'not_found'});
              e.scrollIntoView({block:'center',inline:'nearest'});
              const r=e.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) return JSON.stringify({error:'not_visible'});
              const x=Math.round(r.left+r.width/2), y=Math.round(r.top+r.height/2);
              const hit=document.elementFromPoint(x,y);
              if (!hit || (hit !== e && !e.contains(hit))) return JSON.stringify({error:'obscured'});
              return JSON.stringify({x,y});
            })()""" % json.dumps(selector)
            coords = json.loads(self.execute(t, expression))
            if "error" in coords:
                raise HTTPException(409, f"Element {coords['error']}")
            self.bidi.call("input.performActions", {"context": t.context, "actions": [{
                "type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"},
                "actions": [
                    {"type": "pointerMove", "x": coords["x"], "y": coords["y"], "origin": "viewport"},
                    {"type": "pointerDown", "button": 0},
                    {"type": "pointerUp", "button": 0}
                ]
            }]})
            self.bidi.call("input.releaseActions", {"context": t.context})
            return coords

    def type_text(self, t: Task, text: str):
        with self.input_lock:
            self.activate(t)
            # Key actions are trusted protocol input, not synthetic DOM events.
            # Complex IME composition may require an OS-level fallback.
            for offset in range(0, len(text), 32):
                actions = []
                for char in text[offset:offset+32]:
                    actions.extend([{"type": "keyDown", "value": char},
                                    {"type": "keyUp", "value": char}])
                self.bidi.call("input.performActions", {"context": t.context,
                    "actions": [{"type": "key", "id": "keyboard", "actions": actions}]})
            self.bidi.call("input.releaseActions", {"context": t.context})

    def scroll(self, t: Task, dx: int, dy: int):
        with self.input_lock:
            self.activate(t)
            self.bidi.call("input.performActions", {"context": t.context, "actions": [{
                "type": "wheel", "id": "wheel", "actions": [{
                    "type": "scroll", "x": 0, "y": 0,
                    "deltaX": dx, "deltaY": dy, "duration": 100
                }]
            }]})
            self.bidi.call("input.releaseActions", {"context": t.context})

    def enable_capture(self, t: Task, max_bytes: int):
        # Explicit opt-in: collecting bodies costs browser memory, so keep the
        # limit small; metadata-only capture remains the default.
        if t.collector:
            return t.collector
        result = self.bidi.call("network.addDataCollector", {
            "dataTypes": ["request", "response"],
            "maxEncodedDataSize": max_bytes,
            "contexts": [t.context]
        })
        t.collector = result["collector"]
        return t.collector

    def get_body(self, t: Task, request_id: str, kind: str):
        if not t.collector:
            raise HTTPException(409, "Enable body capture before generating the request")
        with self.lock:
            known = any(ev["request_id"] == request_id for ev in t.events)
        if not known:
            raise HTTPException(404, "Request not in task's retained network events")
        result = self.bidi.call("network.getData", {
            "request": request_id,
            "dataType": kind,
            "collector": t.collector,
            "disown": True
        }, timeout=12)
        return result.get("bytes", {})

    def memory(self):
        if not self.driver or not self.driver.service.process:
            return {}
        proc = psutil.Process(self.driver.service.process.pid)
        procs = [proc] + proc.children(recursive=True)
        rss = 0
        count = 0
        for p in procs:
            with contextlib.suppress(psutil.Error):
                rss += p.memory_info().rss
                count += 1
        return {"rss_mib": round(rss / 1024**2, 1), "process_count": count}


broker = BrowserBroker()


def admin_auth(authorization: str | None):
    expected = os.getenv("BROKER_TOKEN", "")
    if not expected or not authorization or not secrets.compare_digest(authorization, f"Bearer {expected}"):
        raise HTTPException(401, "Missing or invalid bearer token")


class CreateTask(BaseModel):
    name: str = Field(default="agent", max_length=80)


class Navigate(BaseModel):
    url: str = Field(min_length=1, max_length=8192, pattern=r"^https?://")


class Click(BaseModel):
    selector: str = Field(min_length=1, max_length=1000)


class TypeText(BaseModel):
    text: str = Field(max_length=10000)


class Capture(BaseModel):
    max_bytes: int = Field(default=65536, ge=1024, le=1048576)


class Scroll(BaseModel):
    dx: int = Field(default=0, ge=-2000, le=2000)
    dy: int = Field(default=500, ge=-2000, le=2000)


async def sweeper():
    while True:
        await asyncio.sleep(30)
        await asyncio.to_thread(broker.sweep)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if len(os.getenv("BROKER_TOKEN", "")) < 24:
        raise RuntimeError("Set BROKER_TOKEN to a random value of at least 24 characters")
    await asyncio.to_thread(broker.start)
    sweep_task = asyncio.create_task(sweeper())
    try:
        yield
    finally:
        sweep_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await sweep_task
        await asyncio.to_thread(broker.stop)


app = FastAPI(title="Firefox BiDi Agent Broker", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health(authorization: str | None = Header(default=None)):
    admin_auth(authorization)
    with broker.lock:
        return {"alive": bool(broker.bidi and not broker.bidi.stopped.is_set()),
                "active_tasks": len(broker.tasks), "max_tasks": broker.max_tasks,
                **broker.memory()}


@app.post("/tasks")
def create_task(body: CreateTask, authorization: str | None = Header(default=None)):
    admin_auth(authorization)
    t = broker.create(body.name)
    return {"task_id": t.id, "task_token": t.token,
            "network_enabled": t.network_enabled}


@app.delete("/tasks/{task_id}")
def delete_task(task_id: str, x_task_token: str | None = Header(default=None)):
    broker.resolve(task_id, x_task_token)
    broker.delete(task_id)
    return {"deleted": True}


@app.post("/tasks/{task_id}/navigate")
def navigate(task_id: str, body: Navigate, x_task_token: str | None = Header(default=None)):
    t = broker.resolve(task_id, x_task_token)
    result = broker.bidi.call("browsingContext.navigate", {
        "context": t.context, "url": body.url, "wait": "interactive"
    }, timeout=60)
    return {"url": result.get("url"), "navigation": result.get("navigation")}


@app.get("/tasks/{task_id}/snapshot")
def snapshot(task_id: str, max_chars: int = Query(12000, ge=500, le=40000),
             x_task_token: str | None = Header(default=None)):
    t = broker.resolve(task_id, x_task_token)
    expression = """(() => JSON.stringify({
        title:document.title, url:location.href,
        text:(document.body?.innerText || '').slice(0,%d),
        controls:Array.from(document.querySelectorAll('button,a,input,textarea,select,[role=button]'))
          .slice(0,150).map(e=>({tag:e.tagName.toLowerCase(),
           text:(e.innerText||e.getAttribute('aria-label')||e.getAttribute('placeholder')||'').slice(0,100),
           id:e.id||null, name:e.getAttribute('name'), type:e.getAttribute('type'),
           disabled:e.disabled||false}))
    }))()""" % max_chars
    value = broker.execute(t, expression)
    return json.loads(value)


@app.get("/tasks/{task_id}/screenshot")
def screenshot(task_id: str, quality: float = Query(0.7, ge=0.1, le=1.0),
               full_page: bool = False, x_task_token: str | None = Header(default=None)):
    import base64
    t = broker.resolve(task_id, x_task_token)
    res = broker.bidi.call("browsingContext.captureScreenshot", {
        "context": t.context, "origin": "document" if full_page else "viewport",
        "format": {"type": "image/jpeg", "quality": quality}
    }, timeout=60)
    return Response(base64.b64decode(res["data"]), media_type="image/jpeg",
                    headers={"Cache-Control": "no-store"})


@app.post("/tasks/{task_id}/click")
def click(task_id: str, body: Click, x_task_token: str | None = Header(default=None)):
    t = broker.resolve(task_id, x_task_token)
    return {"clicked": True, "position": broker.click(t, body.selector)}


@app.post("/tasks/{task_id}/type")
def type_text(task_id: str, body: TypeText, x_task_token: str | None = Header(default=None)):
    t = broker.resolve(task_id, x_task_token)
    broker.type_text(t, body.text)
    return {"typed": len(body.text)}


@app.post("/tasks/{task_id}/scroll")
def scroll(task_id: str, body: Scroll, x_task_token: str | None = Header(default=None)):
    t = broker.resolve(task_id, x_task_token)
    broker.scroll(t, body.dx, body.dy)
    return {"scrolled": True}


@app.get("/tasks/{task_id}/network")
def network(task_id: str, clear: bool = False, x_task_token: str | None = Header(default=None)):
    t = broker.resolve(task_id, x_task_token)
    with broker.lock:
        events = list(t.events)
        if clear:
            t.events.clear()
    return {"network_enabled": t.network_enabled, "events": events}


@app.post("/tasks/{task_id}/network/capture")
def capture(task_id: str, body: Capture, x_task_token: str | None = Header(default=None)):
    t = broker.resolve(task_id, x_task_token)
    try:
        broker.enable_capture(t, body.max_bytes)
    except BiDiFailure as exc:
        raise HTTPException(501, f"Body collection unavailable: {exc}") from exc
    return {"body_capture_enabled": True, "max_bytes": body.max_bytes}


@app.get("/tasks/{task_id}/network/body/{request_id}")
def get_body(task_id: str, request_id: str, kind: Literal["request", "response"] = "response",
             x_task_token: str | None = Header(default=None)):
    t = broker.resolve(task_id, x_task_token)
    try:
        return broker.get_body(t, request_id, kind)
    except BiDiFailure as exc:
        raise HTTPException(502, f"Body unavailable or timed out: {exc}") from exc
