"""HomePanel Studio server.

One process, one port. It does four jobs:
  1. Tablets: say hello, wait for approval, fetch their design, hear about changes (/api/...).
  2. Home Assistant relay: tablets talk to HA through here, so they hold a tablet key, never an HA token.
  3. Studio: the page in the HA sidebar, plus its admin API (/admin/...), reachable only through HA.
  4. mDNS: advertises _homepanel._tcp so tablets find the server by themselves.

Runs as an HA add-on (Supervisor gives the HA connection) or standalone for development:
    HA_URL=http://ha:8123 HA_TOKEN=... python -m server
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
from pathlib import Path

from aiohttp import ClientSession, WSMsgType, web

from .store import Store

log = logging.getLogger("homepanel")
ROOT = Path(__file__).resolve().parents[1]
PORT = int(os.environ.get("HOMEPANEL_PORT", "8722"))
DATA = Path(os.environ.get("HOMEPANEL_DATA", "/data" if Path("/data").is_dir() else ROOT / "data"))
# Renderer files: shipped inside the add-on image, or the repo's web/ folder in development.
RENDERER = next(p for p in (ROOT / "renderer", ROOT.parent / "web") if p.is_dir())

SUPERVISOR_TOKEN = os.environ.get("SUPERVISOR_TOKEN")
if SUPERVISOR_TOKEN:
    HA_HTTP, HA_WS, HA_TOKEN = "http://supervisor/core/api", "ws://supervisor/core/websocket", SUPERVISOR_TOKEN
else:
    _u = os.environ.get("HA_URL", "http://homeassistant.local:8123").rstrip("/")
    HA_HTTP, HA_WS, HA_TOKEN = _u + "/api", _u.replace("http", "ws", 1) + "/api/websocket", os.environ.get("HA_TOKEN", "")

# The Studio and its admin API are for the HA sidebar only. Requests through HA ingress arrive from the
# Supervisor's address; in development they arrive from this machine. Tablets on the LAN get 403.
ADMIN_PEERS = {"172.30.32.2", "127.0.0.1", "::1"}
PREVIEW_KEY = "studio-preview"  # the Studio's own preview pane; honoured only from an admin peer


def is_admin(request: web.Request) -> bool:
    return request.remote in ADMIN_PEERS


def tablet_for(request: web.Request, key: str | None = None) -> dict | None:
    store: Store = request.app["store"]
    if key is None:
        auth = request.headers.get("Authorization", "")
        key = auth[7:] if auth.startswith("Bearer ") else request.query.get("key")
    if key == PREVIEW_KEY and is_admin(request):
        return {"id": "preview", "name": "Preview", "design": request.query.get("design"), "start_page": None}
    return store.tablet_by_key(key)


@web.middleware
async def guard(request: web.Request, handler):
    if request.path.startswith("/admin") and not is_admin(request):
        raise web.HTTPForbidden(text="Studio is only reachable through Home Assistant")
    if request.method == "OPTIONS":  # the tablet app is a bundled page, so every call is cross-origin
        resp = web.Response()
    else:
        try:
            resp = await handler(request)
        except web.HTTPException as e:
            resp = e
    if not isinstance(resp, web.WebSocketResponse):
        if request.path.startswith(("/admin/studio", "/renderer")):
            # Always revalidate, so an updated add-on is never shown with a stale script from the browser cache.
            resp.headers["Cache-Control"] = "no-cache"
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    return resp


# ---------------------------------------------------------------- tablets
async def hello(request: web.Request):
    try:
        t = request.app["store"].hello(await request.json())
    except (ValueError, json.JSONDecodeError) as e:
        raise web.HTTPBadRequest(text=str(e))
    await notify_admins(request.app)
    # shortcut: the tablet id doubles as its claim to the key (ids are random per device and LAN-only);
    # move to a pairing code shown on the tablet if panels are ever exposed beyond the home network.
    return web.json_response({"status": t["status"], "name": t["name"], "key": t["key"] if t["status"] == "approved" else None})


async def tablet_design(request: web.Request):
    t = tablet_for(request)
    if not t:
        raise web.HTTPUnauthorized()
    rec = request.app["store"].get_design(t.get("design"))
    if not rec:
        return web.json_response({"design": None, "tablet": {"name": t["name"]}})
    return web.json_response({"design": rec["design"], "version": rec["version"], "id": rec["id"],
                              "tablet": {"name": t["name"], "start_page": t.get("start_page")}})


async def tablet_events(request: web.Request):
    """Tablets hold this socket open; the server says when their design changed."""
    t = tablet_for(request)
    if not t:
        raise web.HTTPUnauthorized()
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    request.app["tablet_sockets"].setdefault(t["id"], set()).add(ws)
    try:
        async for _ in ws:
            pass
    finally:
        request.app["tablet_sockets"][t["id"]].discard(ws)
    return ws


async def push_design(app: web.Application, design_id: str | None = None, tablet_id: str | None = None):
    for t in app["store"].tablets.values():
        if (tablet_id and t["id"] == tablet_id) or (design_id and t.get("design") == design_id):
            for ws in list(app["tablet_sockets"].get(t["id"], ())):
                await ws.send_json({"type": "design"})


# ---------------------------------------------------------------- Home Assistant relay
async def ha_socket(request: web.Request):
    """Speaks HA's websocket protocol to the tablet. The tablet authenticates with its tablet key;
    the relay authenticates upstream with the real HA token and then passes frames both ways."""
    ws = web.WebSocketResponse(max_msg_size=0, heartbeat=30)
    await ws.prepare(request)
    await ws.send_json({"type": "auth_required", "ha_version": "relay"})
    try:
        first = await ws.receive_json(timeout=15)
    except (asyncio.TimeoutError, TypeError, ValueError):
        await ws.close()
        return ws
    if not tablet_for(request, first.get("access_token") or ""):
        await ws.send_json({"type": "auth_invalid", "message": "Tablet not approved in HomePanel Studio"})
        await ws.close()
        return ws
    try:
        async with request.app["http"].ws_connect(HA_WS, max_msg_size=0, heartbeat=30) as up:
            await up.receive_json()
            await up.send_json({"type": "auth", "access_token": HA_TOKEN})
            verdict = await up.receive_json()
            await ws.send_json(verdict)
            if verdict.get("type") != "auth_ok":
                log.error("Home Assistant refused the relay's own token: %s", verdict)
                return ws

            async def pump(src, dst):
                async for m in src:
                    if m.type == WSMsgType.TEXT:
                        await dst.send_str(m.data)
                    elif m.type == WSMsgType.BINARY:
                        await dst.send_bytes(m.data)
                    else:
                        break

            done, pending = await asyncio.wait([asyncio.create_task(pump(ws, up)), asyncio.create_task(pump(up, ws))],
                                               return_when=asyncio.FIRST_COMPLETED)
            for p in pending:
                p.cancel()
    except Exception as e:  # HA restarting, network blip: the tablet reconnects by itself
        log.warning("relay closed: %s", e)
    await ws.close()
    return ws


async def ha_media(request: web.Request):
    """Camera stills and HLS video. These HA paths carry their own short-lived tokens in the URL,
    so no tablet key is asked for; the relay only adds the HA token HA wants for the API route."""
    url = HA_HTTP + request.path[len("/api"):]
    async with request.app["http"].get(url, params=request.query, headers={"Authorization": f"Bearer {HA_TOKEN}"}) as up:
        resp = web.StreamResponse(status=up.status)
        for h in ("Content-Type", "Cache-Control"):
            if h in up.headers:
                resp.headers[h] = up.headers[h]
        resp.headers["Access-Control-Allow-Origin"] = "*"
        await resp.prepare(request)
        async for chunk in up.content.iter_chunked(64 * 1024):
            await resp.write(chunk)
        return resp


async def ha_call(app: web.Application, msgs: list[dict]) -> list:
    """One-shot websocket commands to HA, for the Studio's pickers."""
    async with app["http"].ws_connect(HA_WS, max_msg_size=0) as up:
        await up.receive_json()
        await up.send_json({"type": "auth", "access_token": HA_TOKEN})
        if (await up.receive_json()).get("type") != "auth_ok":
            raise web.HTTPBadGateway(text="Home Assistant refused the connection")
        out = []
        for i, m in enumerate(msgs, 1):
            await up.send_json({"id": i, **m})
            while True:
                r = await up.receive_json()
                if r.get("id") == i and r.get("type") == "result":
                    out.append(r.get("result"))
                    break
        return out


# ---------------------------------------------------------------- Studio admin API
def state(app: web.Application) -> dict:
    s: Store = app["store"]
    online = {tid for tid, socks in app["tablet_sockets"].items() if socks}
    return {"tablets": [dict(t, key=None, online=t["id"] in online) for t in s.tablets.values()],
            "designs": s.list_designs(), "assets": s.list_assets()}


async def notify_admins(app: web.Application):
    for ws in list(app["admin_sockets"]):
        await ws.send_json({"type": "state", "state": state(app)})


async def admin_state(request):
    return web.json_response(state(request.app))


async def admin_live(request: web.Request):
    """The Studio page listens here so a tablet that just said hello shows up without a refresh."""
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    request.app["admin_sockets"].add(ws)
    try:
        async for _ in ws:
            pass
    finally:
        request.app["admin_sockets"].discard(ws)
    return ws


async def admin_tablet(request: web.Request):
    s: Store = request.app["store"]
    tid = request.match_info["id"]
    if tid not in s.tablets:
        raise web.HTTPNotFound()
    if request.method == "DELETE":
        s.remove_tablet(tid)
    elif request.path.endswith("/approve"):
        s.approve(tid)
    else:
        s.update_tablet(tid, await request.json())
        await push_design(request.app, tablet_id=tid)
    await notify_admins(request.app)
    return web.json_response(state(request.app))


async def admin_design(request: web.Request):
    s: Store = request.app["store"]
    did = request.match_info.get("id")
    try:
        if request.method == "GET":
            rec = s.get_design(did)
            if not rec:
                raise web.HTTPNotFound()
            return web.json_response(rec)
        if request.method == "DELETE":
            s.delete_design(did)
        elif request.path.endswith("/duplicate"):
            s.duplicate_design(did)
        else:  # POST creates, PUT replaces
            body = await request.json()
            rec = s.save_design(did, body.get("name", ""), body.get("design"))
            await push_design(request.app, design_id=rec["id"])
            await notify_admins(request.app)
            return web.json_response(rec)
    except (ValueError, KeyError, json.JSONDecodeError) as e:
        raise web.HTTPBadRequest(text=str(e))
    await notify_admins(request.app)
    return web.json_response(state(request.app))


async def admin_asset(request: web.Request):
    s: Store = request.app["store"]
    if request.method == "DELETE":
        s.delete_asset(request.match_info["name"])
    else:
        part = await (await request.multipart()).next()
        if part is None or not part.filename:
            raise web.HTTPBadRequest(text="no file")
        data = await part.read(decode=False)
        if len(data) > 12 * 1024 * 1024:
            raise web.HTTPRequestEntityTooLarge(max_size=12 * 1024 * 1024, actual_size=len(data))
        s.save_asset(part.filename, bytes(data))
    await notify_admins(request.app)
    return web.json_response(state(request.app))


async def admin_entities(request: web.Request):
    """What the Studio's pickers offer: every entity with its name and room, plus the rooms."""
    areas, devices, ents, states = await ha_call(request.app, [
        {"type": "config/area_registry/list"}, {"type": "config/device_registry/list"},
        {"type": "config/entity_registry/list"}, {"type": "get_states"}])
    dev_area = {d["id"]: d.get("area_id") for d in devices}
    reg = {e["entity_id"]: e for e in ents}
    out = []
    for st in states:
        e = reg.get(st["entity_id"], {})
        if e.get("hidden_by") or e.get("disabled_by"):
            continue
        out.append({"id": st["entity_id"], "name": st["attributes"].get("friendly_name") or st["entity_id"],
                    "area": e.get("area_id") or dev_area.get(e.get("device_id")), "state": st["state"]})
    return web.json_response({"entities": out, "areas": [{"id": a["area_id"], "name": a["name"]} for a in areas]})


# ---------------------------------------------------------------- static files
async def studio_index(request):
    if not is_admin(request):
        raise web.HTTPForbidden(text="Studio is only reachable through Home Assistant")
    return web.FileResponse(ROOT / "studio" / "index.html", headers={"Cache-Control": "no-store"})


async def asset(request: web.Request):
    """Uploaded images first, then the pictures that ship with the renderer."""
    name = Path(request.match_info["name"]).name
    for base in (request.app["store"].assets_dir, RENDERER / "assets"):
        if (base / name).is_file():
            return web.FileResponse(base / name)
    raise web.HTTPNotFound()


# ---------------------------------------------------------------- mDNS
def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packet is sent; this only asks the OS which interface it would use
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


async def start_mdns(app: web.Application):
    try:
        from zeroconf import ServiceInfo
        from zeroconf.asyncio import AsyncZeroconf
        ip = lan_ip()
        info = ServiceInfo("_homepanel._tcp.local.", "HomePanel Studio._homepanel._tcp.local.", addresses=[socket.inet_aton(ip)],
                           port=PORT, properties={"v": "1"}, server=f"homepanel-{ip.replace('.', '-')}.local.")
        app["zc"] = AsyncZeroconf()
        await app["zc"].async_register_service(info)
        app["zc_info"] = info
        log.info("advertising _homepanel._tcp at %s:%s", ip, PORT)
    except Exception as e:  # discovery is a convenience; the server works without it
        log.warning("mDNS advertising off: %s", e)


async def stop_mdns(app: web.Application):
    if app.get("zc"):
        await app["zc"].async_unregister_service(app["zc_info"])
        await app["zc"].async_close()


async def seed(app: web.Application):
    """First start: give the Studio one design to look at."""
    s: Store = app["store"]
    sample = ROOT / "server" / "seed.json"
    if not s.list_designs() and sample.is_file():
        s.save_design(None, "Sample", json.loads(sample.read_text(encoding="utf-8")))


def build_app() -> web.Application:
    app = web.Application(middlewares=[guard], client_max_size=16 * 1024 * 1024)
    app["store"] = Store(DATA)
    app["tablet_sockets"] = {}
    app["admin_sockets"] = set()

    async def http_ctx(app):
        app["http"] = ClientSession()
        yield
        await app["http"].close()

    app.cleanup_ctx.append(http_ctx)
    app.on_startup.extend([seed, start_mdns])
    app.on_cleanup.append(stop_mdns)

    r = app.router
    r.add_post("/api/hello", hello)
    r.add_get("/api/design", tablet_design)
    r.add_get("/api/events", tablet_events)
    r.add_get("/api/websocket", ha_socket)
    for p in ("/api/camera_proxy/{t:.*}", "/api/camera_proxy_stream/{t:.*}", "/api/hls/{t:.*}"):
        r.add_get(p, ha_media)
    r.add_route("OPTIONS", "/api/{t:.*}", lambda request: web.Response())

    r.add_get("/admin/api/state", admin_state)
    r.add_get("/admin/api/live", admin_live)
    r.add_get("/admin/api/entities", admin_entities)
    r.add_post("/admin/api/tablets/{id}/approve", admin_tablet)
    r.add_route("PATCH", "/admin/api/tablets/{id}", admin_tablet)
    r.add_delete("/admin/api/tablets/{id}", admin_tablet)
    r.add_post("/admin/api/designs", admin_design)
    r.add_get("/admin/api/designs/{id}", admin_design)
    r.add_put("/admin/api/designs/{id}", admin_design)
    r.add_delete("/admin/api/designs/{id}", admin_design)
    r.add_post("/admin/api/designs/{id}/duplicate", admin_design)
    r.add_post("/admin/api/assets", admin_asset)
    r.add_delete("/admin/api/assets/{name}", admin_asset)

    r.add_get("/assets/{name}", asset)
    r.add_get("/", studio_index)
    r.add_get("/admin", studio_index)
    r.add_static("/admin/studio", ROOT / "studio")
    r.add_static("/renderer", RENDERER)
    return app


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    log.info("HomePanel Studio on port %s, data in %s, Home Assistant at %s", PORT, DATA, HA_HTTP)
    web.run_app(build_app(), port=PORT, access_log=None)


if __name__ == "__main__":
    main()
