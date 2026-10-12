"""Tiny ASGI app used to verify a *real* HTTP -> WebSocket upgrade.

The full wTox app requires encrypted Tox identity state. This test endpoint
deliberately uses no identity or secrets; it is NOT copied to production.
"""
from fastapi import FastAPI, WebSocket

app = FastAPI()

@app.websocket("/ws")
async def websocket_probe(ws: WebSocket):
    await ws.accept()
    await ws.send_text("ready")
    await ws.close(code=1000)
