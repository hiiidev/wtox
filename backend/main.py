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

@asynccontextmanager
async def lifespan(app: FastAPI):
    store.init()
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

@app.get("/health")
def health():
    return {"ok":True}

@app.get("/health/ui")
def frontend_health():
    """Detect incomplete React builds and missing static files before users see a white page."""
    assets=FRONTEND_DIR/"assets"
    good=(FRONTEND_DIR/"index.html").is_file() and (FRONTEND_DIR/"logo.svg").is_file()
    scripts=list(assets.glob("*.js")) if assets.is_dir() else []
    styles=list(assets.glob("*.css")) if assets.is_dir() else []
    # Checking disk files alone previously returned 200 even though the
    # /assets mount pointed one directory too high and served only 404s.
    asset_route=next((route for route in app.routes
                      if getattr(route,"path",None)=="/assets"),None)
    mounted=Path(asset_route.app.directory).resolve() if asset_route else None
    route_ok=mounted==assets.resolve()
    if not good or not scripts or not styles or not route_ok:
        return JSONResponse(
            {"ok":False,"detail":"React 静态资源不完整，请重新构建 Docker 镜像"},
            status_code=503)
    return {"ok":True,"js":len(scripts),"css":len(styles),"logo":True,"asset_route":"/assets"}

@app.post("/api/logout")
def logout(request: Request, response: Response):
    store.revoke_tox_session(request.cookies.get(TOX_SESSION_COOKIE))
    response.delete_cookie(TOX_SESSION_COOKIE, path="/")
    response.delete_cookie("wtox_session", path="/")
    return {"ok": True}

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
    return FileResponse(str(FRONTEND_DIR / "logo.svg"), media_type="image/svg+xml")

@app.get("/logo.svg")
def logo():
    return FileResponse(str(FRONTEND_DIR / "logo.svg"), media_type="image/svg+xml")

@app.get("/")
def index():
    return FileResponse(str(FRONTEND_DIR / "index.html"),headers={"Cache-Control":"no-store"})

app.include_router(profile_router)
app.include_router(tox_router)
