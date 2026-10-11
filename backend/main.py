"""Application entry point: access gate and independent accounts.

Tox native bridge will be integrated behind this API in the next milestone.
Do not treat this service as a functioning Tox chat client yet.
"""
import html
import os
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from threading import Lock

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.base import BaseHTTPMiddleware

from . import access, store

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
    yield

app = FastAPI(title="wtox",docs_url=None,redoc_url=None,openapi_url=None,lifespan=lifespan)

class GateMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path=request.url.path
        if path in ("/health","/gate","/api/gate/login"):
            return await call_next(request)
        if not access.gate_valid(request.cookies.get(access.COOKIE_NAME)):
            if path.startswith("/api/"):
                return JSONResponse({"detail":"需要输入网站访问密码"},status_code=401)
            return RedirectResponse("/gate",status_code=303)
        response=await call_next(request)
        response.headers["Cache-Control"]="no-store"
        return response

app.add_middleware(GateMiddleware)

class PasswordRequest(BaseModel):
    password: str = Field(min_length=1,max_length=512)

class AccountRequest(BaseModel):
    username: str = Field(min_length=3,max_length=40)
    password: str = Field(min_length=12,max_length=256)

def require_user(request:Request):
    uid=store.session_user(request.cookies.get("wtox_session"))
    if not uid: raise HTTPException(401,"请先登录个人账号")
    return uid

@app.get("/health")
def health():
    return {"ok":True}

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

@app.post("/api/register")
def register(body: AccountRequest, response: Response,request:Request):
    ip=request.client.host if request.client else "unknown"
    rate_check("register:"+ip)
    try: uid=store.add_account(body.username,body.password)
    except ValueError as exc: raise HTTPException(400,str(exc)) from exc
    response.set_cookie("wtox_session",store.create_session(uid),
                        httponly=True,secure=access.secure_cookies(),samesite="strict",
                        max_age=7*86400,path="/")
    return {"ok":True,"username":body.username}

@app.post("/api/login")
def login(body: AccountRequest, response: Response,request:Request):
    ip=request.client.host if request.client else "unknown"
    rate_check("account-login:"+ip)
    uid=store.verify_account(body.username,body.password)
    if not uid: raise HTTPException(401,"账号名或密码错误")
    response.set_cookie("wtox_session",store.create_session(uid),
                        httponly=True,secure=access.secure_cookies(),samesite="strict",
                        max_age=7*86400,path="/")
    return {"ok":True,"username":body.username}

@app.post("/api/logout")
def logout(request: Request,response:Response):
    store.revoke_session(request.cookies.get("wtox_session"))
    response.delete_cookie("wtox_session",path="/")
    return {"ok":True}

@app.get("/api/me")
def me(uid=Depends(require_user)):
    return store.user_info(uid)

@app.get("/api/profile/status")
def profile_status(uid=Depends(require_user)):
    return {"has_profile":store.has_profile(uid),"native_tox_available":False}

@app.get("/")
def index():
    return FileResponse("/app/frontend/index.html",headers={"Cache-Control":"no-store"})
