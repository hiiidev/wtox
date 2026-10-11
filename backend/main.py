"""Website entrance gate and Tox-profile-only authentication."""
import asyncio
import time
from pathlib import Path
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from threading import Lock

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.base import BaseHTTPMiddleware

from . import access, store
from .profile_api import router as profile_router, COOKIE_NAME as TOX_SESSION_COOKIE
from .tox_api import router as tox_router
from .session_manager import manager

_ATTEMPTS = defaultdict(deque)
_ATTEMPT_LOCK = Lock()

def rate_check(key: str):
    now=time.monotonic()
    with _ATTEMPT_LOCK:
        q=_ATTEMPTS[key]
        while q and now-q[0]>900: q.popleft()
        if len(q)>=12: raise HTTPException(429,"尝试次数过多，请稍后重试")
        q.append(now)

@asynccontextmanager
async def lifespan(app: FastAPI):
    access.validate_settings()
    store.init()
    if store.needs_legacy_migration():
        from .tox_identity import ToxCore
        store.migrate_legacy_identities(ToxCore())
    manager.start(asyncio.get_running_loop())
    try:
        yield
    finally:
        await manager.shutdown()

app = FastAPI(title="wtox",docs_url=None,redoc_url=None,openapi_url=None,lifespan=lifespan)
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
# Docker copies compiled Vite files directly into /app/frontend.
# Developer/CI checkouts keep build output at frontend/dist.
if (FRONTEND_DIR / "dist" / "index.html").is_file():
    FRONTEND_DIR = FRONTEND_DIR / "dist"

class GateMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path=request.url.path
        if path in ("/health","/health/ui","/gate","/api/gate/login","/favicon.ico","/logo.svg") or path.startswith("/assets/"):
            return await call_next(request)
        if not access.gate_valid(request.cookies.get(access.COOKIE_NAME)):
            if path.startswith("/api/"):
                return JSONResponse({"detail":"需要输入网站访问密码"},status_code=401)
            return RedirectResponse("/gate",status_code=303)
        response=await call_next(request)
        response.headers["Cache-Control"]="no-store"
        return response

app.add_middleware(GateMiddleware)
app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIR / "assets"), check_dir=False), name="assets")

class PasswordRequest(BaseModel):
    password: str = Field(min_length=1,max_length=512)

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
    if not good or not scripts or not styles:
        return JSONResponse(
            {"ok":False,"detail":"React 静态资源不完整，请重新构建 Docker 镜像"},
            status_code=503)
    return {"ok":True,"js":len(scripts),"css":len(styles),"logo":True}

@app.get("/gate",response_class=HTMLResponse)
def gate_page():
    return """<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>wtox · 访问验证</title><style>body{background:#101827;color:#e6ebf5;font:16px system-ui;display:grid;place-items:center;min-height:100dvh;margin:0}
form{max-width:360px;width:86%;background:#1b2639;padding:2em;border-radius:16px}
input,button{box-sizing:border-box;width:100%;padding:12px;border-radius:8px;margin-top:12px;font-size:1em}
button{background:#467be8;color:white;border:0;cursor:pointer}</style>
<form id="gate"><h2>wtox</h2><p>请输入网站访问密码</p><input type="password" autocomplete="current-password" required id="password" placeholder="访问密码">
<button type="submit">进入</button><p id="error" role="alert"></p></form>
<script>document.querySelector('#gate').onsubmit=async e=>{
e.preventDefault();const r=await fetch('/api/gate/login',{method:'POST',headers:{'Content-Type':'application/json'},
body:JSON.stringify({password:document.querySelector('#password').value})});
if(r.ok)location.replace('/');else document.querySelector('#error').textContent='访问密码错误或尝试次数过多';
}</script></html>"""

@app.post("/api/gate/login")
def site_login(body: PasswordRequest, request: Request, response: Response):
    ip=request.client.host if request.client else "unknown"
    rate_check("gate:"+ip)
    if not access.access_password_ok(body.password):
        raise HTTPException(401,"访问密码错误")
    response.set_cookie(access.COOKIE_NAME,access.issue_gate_cookie(),
                        httponly=True,secure=access.secure_cookies(),
                        samesite="strict",max_age=access.SESSION_AGE,path="/")
    return {"ok":True}

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
