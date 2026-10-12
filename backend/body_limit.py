"""Bound API request bodies before Pydantic parses untrusted JSON.

Binary identity/attachment uploads already have streaming caps in their
handlers. Content-Length is rejected early for all routes.
"""
from starlette.responses import JSONResponse

MAX_JSON_BODY = 64 * 1024
MAX_LOGIN_BODY = 8 * 1024 * 1024 + 80 + 1024
MAX_FILE_BODY = 5 * 1024 * 1024


class RequestBodyLimitMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") not in ("POST", "PUT", "PATCH", "DELETE"):
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        if not path.startswith("/api/"):
            return await self.app(scope, receive, send)
        limit = (MAX_LOGIN_BODY if path == "/api/tox/login" else
                 MAX_FILE_BODY if path == "/api/files/send" else MAX_JSON_BODY)
        headers = dict(scope.get("headers", []))
        length = headers.get(b"content-length")
        if length is not None:
            if not length.isascii() or not length.isdigit():
                return await JSONResponse({"detail": "Content-Length 无效"}, status_code=400)(scope, receive, send)
            if int(length) > limit:
                return await JSONResponse({"detail": "请求体超过大小限制"}, status_code=413)(scope, receive, send)

        # Large binary streams must never be assembled here.
        if path in ("/api/tox/login", "/api/files/send"):
            return await self.app(scope, receive, send)

        chunks = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            if message["type"] != "http.request":
                continue
            part = message.get("body", b"")
            if len(chunks) + len(part) > limit:
                return await JSONResponse({"detail": "请求体超过大小限制"}, status_code=413)(scope, receive, send)
            chunks.extend(part)
            if not message.get("more_body", False):
                break

        first = True
        async def replay():
            nonlocal first
            if first:
                first = False
                return {"type": "http.request", "body": bytes(chunks), "more_body": False}
            return await receive()
        return await self.app(scope, replay, send)
