"""Tox-profile-only authentication and the public web application."""
import asyncio
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from . import access, store
from .profile_api import router as profile_router, COOKIE_NAME as TOX_SESSION_COOKIE
from .tox_api import router as tox_router
from .session_manager import manager
from . import web_push
from .push_api import router as push_router
from .translate_api import router as translate_router

@asynccontextmanager
async def lifespan(app: FastAPI):
    store.init()
    web_push.init()
    if store.needs_legacy_migration():
        from .tox_identity import ToxCore
        store.migrate_legacy_identities(ToxCore())
    manager.start(asyncio.get_running_loop())
    try:
        yield
    finally:
        await manager.shutdown()

app = FastAPI(title="wTox",docs_url=None,redoc_url=None,openapi_url=None,lifespan=lifespan)
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
# Docker copies compiled Vite files directly into /app/frontend.
# Developer/CI checkouts keep build output at frontend/dist.
if (FRONTEND_DIR / "dist" / "index.html").is_file():
    FRONTEND_DIR = FRONTEND_DIR / "dist"

class NoStoreMiddleware(BaseHTTPMiddleware):
    """Keep identity pages and sensitive APIs out of shared HTTP caches."""
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if request.url.path == "/" or request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response


app.add_middleware(NoStoreMiddleware)
app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIR / "assets"), check_dir=False), name="assets")
app.mount("/icons", StaticFiles(directory=str(FRONTEND_DIR / "icons"), check_dir=False), name="icons")

@app.get("/health")
def health():
    return {"ok":True}

@app.get("/health/ui")
def frontend_health():
    """Detect incomplete React builds and missing static files before users see a white page."""
    assets=FRONTEND_DIR/"assets"
    icons=FRONTEND_DIR/"icons"
    required_icons=("icon-180.png", "icon-192.png", "icon-512.png")
    icons_ok=all((icons/name).is_file() for name in required_icons)
    good=(FRONTEND_DIR/"index.html").is_file() and (FRONTEND_DIR/"logo.svg").is_file() and icons_ok
    scripts=list(assets.glob("*.js")) if assets.is_dir() else []
    styles=list(assets.glob("*.css")) if assets.is_dir() else []
    # Checking disk files alone previously returned 200 even though the
    # /assets mount pointed one directory too high and served only 404s.
    asset_route=next((route for route in app.routes
                      if getattr(route,"path",None)=="/assets"),None)
    mounted=Path(asset_route.app.directory).resolve() if asset_route else None
    route_ok=mounted==assets.resolve()
    icons_route=next((route for route in app.routes
                      if getattr(route,"path",None)=="/icons"),None)
    icons_mounted=Path(icons_route.app.directory).resolve() if icons_route else None
    route_ok=route_ok and icons_mounted==icons.resolve()
    if not good or not scripts or not styles or not route_ok:
        return JSONResponse(
            {"ok":False,"detail":"React 静态资源不完整，请重新构建 Docker 镜像"},
            status_code=503)
    return {"ok":True,"js":len(scripts),"css":len(styles),"logo":True,
            "icons":list(required_icons),"asset_route":"/assets","icons_route":"/icons"}

@app.post("/api/logout")
def logout(request: Request, response: Response):
    # Legacy session-only logout, kept for older clients.
    store.revoke_tox_session(request.cookies.get(TOX_SESSION_COOKIE))
    response.delete_cookie(TOX_SESSION_COOKIE, path="/")
    response.delete_cookie("wtox_session", path="/")
    return {"ok": True}

@app.delete("/api/profile")
async def delete_current_profile(request: Request, response: Response):
    """Irreversibly remove the authenticated Tox identity from this VPS."""
    from .profile_api import require_same_origin
    require_same_origin(request)
    if request.headers.get("x-wtox-delete") != "delete-current-identity":
        raise HTTPException(400, "请明确确认删除当前 Tox 身份")
    token=request.cookies.get(TOX_SESSION_COOKIE)
    uid=store.tox_session_user(token)
    if not uid:
        raise HTTPException(401, "登录会话已失效")
    try:
        await manager.remove_account(uid)
    except (OSError,ValueError,RuntimeError) as exc:
        raise HTTPException(503, "服务器身份删除失败，请重试："+str(exc)) from exc
    response.delete_cookie(TOX_SESSION_COOKIE,path="/")
    response.delete_cookie("wtox_session",path="/")
    return {"ok":True,"deleted":True}

@app.get("/api/me")
def me(request: Request):
    uid = store.tox_session_user(request.cookies.get(TOX_SESSION_COOKIE))
    if not uid:
        raise HTTPException(401, "请先使用 .tox 配置登录")
    return store.tox_identity_info(uid)

@app.get("/api/legacy/export")
def export_legacy_profile(request: Request):
    """One-way recovery for an already valid OLD login cookie.

    Cannot sign in to the new site with a username/password; this endpoint
    only downloads an existing profile before the legacy cookie expires.
    """
    legacy_uid = store.legacy_session_user(request.cookies.get("wtox_session"))
    if not legacy_uid:
        raise HTTPException(401, "旧会话已过期，请使用之前备份的 .tox 文件")
    saved = store.read_profile(legacy_uid)
    if saved is None:
        raise HTTPException(404, "旧账号未创建 Tox 身份")
    return Response(
        saved, media_type="application/octet-stream",
        headers={"Content-Disposition":'attachment; filename="wtox-legacy-backup.tox"',
                 "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff"}
    )

@app.get("/favicon.ico")
def favicon():
    return FileResponse(str(FRONTEND_DIR / "logo.svg"), media_type="image/svg+xml",
                        headers={"Cache-Control": "no-cache, max-age=0, must-revalidate"})

@app.get("/logo.svg")
def logo():
    return FileResponse(str(FRONTEND_DIR / "logo.svg"), media_type="image/svg+xml")

@app.get("/")
def index():
    return FileResponse(str(FRONTEND_DIR / "index.html"),headers={"Cache-Control":"no-store"})

@app.get("/manifest.webmanifest")
def pwa_manifest():
    return FileResponse(str(FRONTEND_DIR / "manifest.webmanifest"), media_type="application/manifest+json")

@app.get("/sw.js")
def service_worker():
    return FileResponse(str(FRONTEND_DIR / "sw.js"), media_type="application/javascript",
                        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})

app.include_router(push_router)
app.include_router(profile_router)
app.include_router(tox_router)
app.include_router(translate_router)
