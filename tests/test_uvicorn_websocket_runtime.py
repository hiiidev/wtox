"""Integration regression: Uvicorn must actually accept WebSocket upgrades.

A Starlette/FastAPI TestClient can pass without an installed WebSocket server
protocol; this subprocess exercise catches that exact Docker deployment bug.
"""
import base64
import hashlib
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
import unittest


class UvicornWebSocketRuntimeTests(unittest.TestCase):
    def test_real_101_upgrade_via_wsproto(self):
        import wsproto  # noqa: F401 -- missing dependency must fail the test

        directory = Path(__file__).resolve().parent
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]

        proc = subprocess.Popen([
            sys.executable, "-m", "uvicorn", "ws_runtime_probe:app",
            "--app-dir", str(directory), "--ws", "wsproto",
            "--host", "127.0.0.1", "--port", str(port),
            "--log-level", "warning",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            response = b""
            deadline = time.monotonic() + 12
            key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
            request = (
                f"GET /ws HTTP/1.1\r\n"
                f"Host: 127.0.0.1:{port}\r\n"
                "Connection: Upgrade\r\n"
                "Upgrade: websocket\r\n"
                f"Sec-WebSocket-Key: {key}\r\n"
                "Sec-WebSocket-Version: 13\r\n"
                f"Origin: http://127.0.0.1:{port}\r\n"
                "\r\n"
            ).encode("ascii")
            last_error = None
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    self.fail(f"Uvicorn exited before accepting WebSocket: {proc.returncode}")
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=1) as conn:
                        conn.settimeout(2)
                        conn.sendall(request)
                        while b"\r\n\r\n" not in response and len(response) < 8192:
                            data = conn.recv(4096)
                            if not data:
                                break
                            response += data
                    break
                except (ConnectionError, TimeoutError, OSError) as exc:
                    last_error = exc
                    time.sleep(.1)
            else:
                self.fail(f"Uvicorn never started WebSocket listener: {last_error}")

            headers = response.split(b"\r\n\r\n", 1)[0].decode("ascii", "replace")
            self.assertRegex(headers.splitlines()[0], r"^HTTP/1\.1 101 ")
            expected = base64.b64encode(hashlib.sha1(
                (key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")
            ).digest()).decode("ascii")
            self.assertIn(f"sec-websocket-accept: {expected}".lower(), headers.lower())
            self.assertIn("upgrade: websocket", headers.lower())
        finally:
            proc.terminate()
            try:
                proc.communicate(timeout=4)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate(timeout=4)


if __name__ == "__main__":
    unittest.main()
