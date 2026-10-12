"""Authenticated Web Push subscription and test endpoints."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from .profile_api import owner, require_same_origin
from . import web_push

router = APIRouter()


class Unsubscribe(BaseModel):
    endpoint: str = Field(min_length=20, max_length=4096)


@router.get("/api/push/public-key")
def public_key(uid: str = Depends(owner)):
    return {"public_key": web_push.public_key()}


@router.post("/api/push/subscription")
async def subscribe(request: Request, uid: str = Depends(owner)):
    require_same_origin(request)
    try:
        content = await request.json()
        subscription = web_push.validate_subscription(content)
        web_push.save_subscription(uid, subscription)
    except (TypeError, ValueError, KeyError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True}


@router.delete("/api/push/subscription")
def unsubscribe(body: Unsubscribe, request: Request, uid: str = Depends(owner)):
    require_same_origin(request)
    web_push.remove_subscription(uid, body.endpoint)
    return {"ok": True}


@router.post("/api/push/test")
async def test_push(request: Request, uid: str = Depends(owner)):
    require_same_origin(request)
    return await asyncio.to_thread(web_push.send_to_user, uid, "test")
