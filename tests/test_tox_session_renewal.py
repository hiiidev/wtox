"""Tox identity browser sessions renew with activity, without a lifetime cap."""
import hashlib
import os
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import Response
from fastapi.testclient import TestClient

from backend import profile_api, store
from backend.main import app


class SlidingToxSessionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {
            "WTOX_DATA_DIR": self.tmp.name,
            "WTOX_MASTER_KEY": "ab" * 32,
            "WTOX_INSECURE_HTTP": "1",
            "WTOX_ACCESS_PASSWORD": "",
        })
        self.env.start()
        store.init()
        self.uid = store.create_tox_identity(SimpleNamespace(
            address="E" * 76, secret_proof=b"e" * 32,
            savedata=b"synthetic-tox-savedata-for-renewal-tests",
        ))
        self.token = store.create_tox_session(self.uid)
        self.client = TestClient(app)
        self.client.cookies.set(profile_api.COOKIE_NAME, self.token)

    def tearDown(self):
        self.client.close()
        self.env.stop()
        self.tmp.cleanup()

    def _expires(self):
        with store.db() as conn:
            return conn.execute(
                "SELECT expires FROM tox_sessions WHERE token_hash=?",
                (hashlib.sha256(self.token.encode()).hexdigest(),),
            ).fetchone()[0]

    def _force_expiry(self, when):
        with store.db() as conn:
            conn.execute("UPDATE tox_sessions SET expires=? WHERE token_hash=?",
                         (when, hashlib.sha256(self.token.encode()).hexdigest()))

    def test_new_cookie_and_database_expire_after_idle_window(self):
        response = Response()
        profile_api.issue_session(response, self.uid)
        self.assertIn("Max-Age=2592000", response.headers["set-cookie"])
        self.assertIn("httponly", response.headers["set-cookie"].lower())
        self.assertIn("samesite=strict", response.headers["set-cookie"].lower())
        self.assertGreaterEqual(self._expires(), int(time.time()) + 29 * 86400)

    def test_active_get_renews_both_expiry_and_browser_cookie(self):
        self.assertEqual(self.client.get("/api/me").status_code, 200)
        # Fresh sessions should not write to SQLite or refresh cookies on every poll.
        self.assertNotIn("set-cookie", self.client.get("/api/me").headers)
        self._force_expiry(int(time.time()) + 2 * 86400)
        response = self.client.get("/api/me")
        self.assertEqual(response.status_code, 200)
        self.assertIn("Max-Age=2592000", response.headers["set-cookie"])
        self.assertIn("httponly", response.headers["set-cookie"].lower())
        self.assertEqual(self.client.cookies.get(profile_api.COOKIE_NAME), self.token)
        self.assertGreaterEqual(self._expires(), int(time.time()) + 29 * 86400)
        self.assertNotIn("set-cookie", self.client.get("/api/me").headers)

    def test_many_renewals_have_no_absolute_lifetime_limit(self):
        start = int(time.time())
        for period in range(1, 30):
            # Every 20 days the session is used; even after ~580 days it is valid.
            now = start + period * 20 * 86400
            with patch("backend.store.time.time", return_value=now):
                response = self.client.get("/api/me")
                self.assertEqual(response.status_code, 200, period)
                self.assertIn("Max-Age=2592000", response.headers["set-cookie"])
                self.assertEqual(self._expires(), now + store.TOX_SESSION_IDLE_SECONDS)

    def test_expired_session_is_not_resurrected(self):
        self._force_expiry(int(time.time()) - 1)
        denied = self.client.get("/api/me")
        self.assertEqual(denied.status_code, 401)
        self.assertNotIn("set-cookie", denied.headers)
        self.assertFalse(store.renew_tox_session_if_needed(self.token))
        self.assertLess(self._expires(), int(time.time()))

    def test_logout_revokes_even_nearly_expired_session(self):
        self._force_expiry(int(time.time()) + 60)
        gone = self.client.post("/api/logout")
        self.assertEqual(gone.status_code, 200)
        self.assertIsNone(store.tox_session_user(self.token))
        self.assertFalse(store.renew_tox_session_if_needed(self.token))
        self.assertEqual(self.client.get("/api/me").status_code, 401)

    def test_gate_status_does_not_extend_tox_session(self):
        self._force_expiry(int(time.time()) + 60)
        before = self._expires()
        response = self.client.get("/api/gate/status")
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("set-cookie", response.headers)
        self.assertEqual(self._expires(), before)

    def test_expired_rows_are_pruned_on_new_login(self):
        self._force_expiry(int(time.time()) - 1)
        store.create_tox_session(self.uid)
        with store.db() as conn:
            row = conn.execute(
                "SELECT 1 FROM tox_sessions WHERE token_hash=?",
                (hashlib.sha256(self.token.encode()).hexdigest(),),
            ).fetchone()
        self.assertIsNone(row)


if __name__ == "__main__":
    unittest.main()
