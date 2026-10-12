"""Authenticated, narrowly scoped Google Translate backend gateway.

This is NOT a general-purpose reverse proxy. Chat text is submitted only after
the user explicitly taps Translate. No messages or Google responses are logged
or persisted by the gateway. Google's public web translate endpoint is not a
supported commercial SLA and may block/rate-limit traffic.
"""
from __future__ import annotations

import asyncio
from collections import defaultdict, deque
import json
import os
import re
import time
from threading import Lock
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request as UrlRequest, build_opener, HTTPRedirectHandler

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from .tox_api import require_user, check_origin

router = APIRouter()
_LANG = re.compile(r"^[a-z]{2,3}(?:-[A-Za-z]{2,5})?$")
_LIMIT = 1000
_MAX_BODY = 64 * 1024
_THROTTLE_LOCK = Lock()
_THROTTLE = defaultdict(deque)


class TranslateRequest(BaseModel):
    text: str = Field(min_length=1, max_length=_LIMIT)
    target: str = Field(min_length=2, max_length=12)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def _trusted_endpoint() -> str:
    # Operator-only configuration. Never accept a URL/host supplied by a
    # browser request. Can point to an operator-controlled HTTPS Google proxy.
    base = os.environ.get("WTOX_TRANSLATE_UPSTREAM", "https://translate.googleapis.com").rstrip("/")
    u = urlsplit(base)
    if (u.scheme != "https" or not u.hostname or u.username or u.password
            or u.query or u.fragment or u.path not in ("", "/")):
        raise RuntimeError("WTOX_TRANSLATE_UPSTREAM 必须是可信的 HTTPS 站点根地址")
    return base + "/translate_a/single"


def _google_segments(payload):
    """Extract text and source language from Google's nested JSON format."""
    if not isinstance(payload, list) or not payload or not isinstance(payload[0], list):
        raise ValueError("Google 翻译返回的数据格式不正确")
    parts = [
        fragment[0] for fragment in payload[0]
        if isinstance(fragment, list) and fragment and isinstance(fragment[0], str)
    ]
    translated = "".join(parts).strip()
    if not translated:
        raise ValueError("Google 翻译未返回译文")
    detected = payload[2] if len(payload) > 2 and isinstance(payload[2], str) else "auto"
    return translated, detected


def _fetch_google(text: str, target: str):
    # Never place plaintext messages in URL query parameters or proxy logs.
    query = urlencode({"client": "gtx", "sl": "auto", "tl": target, "dt": "t"})
    req = UrlRequest(_trusted_endpoint() + "?" + query,
        data=urlencode({"q": text}).encode("utf-8"), headers={
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        "User-Agent": "wTox-Translate/1.0",
    }, method="POST")
    try:
        with build_opener(_NoRedirect).open(req, timeout=8) as upstream:
            if upstream.status != 200:
                raise RuntimeError("翻译服务暂时不可用")
            raw = upstream.read(_MAX_BODY + 1)
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        # Do NOT echo upstream error bodies: they can contain submitted text.
        raise RuntimeError("翻译服务连接失败，请稍后重试") from exc
    if len(raw) > _MAX_BODY:
        raise ValueError("翻译响应超过大小限制")
    return _google_segments(json.loads(raw))


def _throttle(uid: str):
    now = time.monotonic()
    with _THROTTLE_LOCK:
        entries = _THROTTLE[uid]
        while entries and now - entries[0] >= 60:
            entries.popleft()
        if len(entries) >= 20:
            raise HTTPException(429, "翻译请求过于频繁，请稍后重试")
        entries.append(now)


@router.post("/api/translate")
async def translate(body: TranslateRequest, request: Request, uid: str = Depends(require_user)):
    check_origin(request)
    target = body.target.strip()
    if not _LANG.fullmatch(target) or len(target) > 12:
        raise HTTPException(422, "目标语言格式无效")
    if not body.text.strip():
        raise HTTPException(422, "没有可翻译的消息")
    _throttle(uid)
    try:
        translated, detected = await asyncio.wait_for(
            asyncio.to_thread(_fetch_google, body.text, target), timeout=10)
    except (TimeoutError, RuntimeError, ValueError, json.JSONDecodeError):
        raise HTTPException(502, "翻译失败，请检查服务器是否可以访问 Google 翻译")
    return Response(
        content=json.dumps({"translated": translated, "source": detected,
                            "target": target}, ensure_ascii=False),
        media_type="application/json",
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )
