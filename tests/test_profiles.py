"""Account isolation and profile lifecycle tests (no native library required)."""
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
from backend import store
from backend.main import app


class IdentityApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {
            "WTOX_DATA_DIR": self.tmp.name,
            "WTOX_MASTER_KEY": "ab" * 32,
            "WTOX_ACCESS_PASSWORD": "very-long-and-random-gate-secret",
            "WTOX_INSECURE_HTTP": "1",
        })
        self.env.start()
        self.client_ctx = TestClient(app)
        self.client = self.client_ctx.__enter__()
        self.client.post("/api/gate/login", json={"password":"very-long-and-random-gate-secret"})

    def tearDown(self):
        self.client_ctx.__exit__(None, None, None)
        self.env.stop()
        self.tmp.cleanup()

    def test_identity_lifecycle_and_account_isolation(self):
        identity = SimpleNamespace(address="AB" * 38, savedata=b"mock savedata for lifecycle test")
        self.assertEqual(self.client.post("/api/register", json={"username":"alice","password":"a-long-passphrase"}).status_code, 200)
        with patch("backend.profile_api.core") as get_core:
            get_core.return_value.identity.return_value = identity
            created = self.client.post("/api/profile/create")
            self.assertEqual(created.status_code, 200, created.text)
            self.assertEqual(created.json()["tox_id"], identity.address)
        self.assertEqual(self.client.get("/api/profile/export").content, identity.savedata)
        self.assertEqual(self.client.post("/api/profile/create").status_code, 409)
        self.client.post("/api/logout")
        self.assertEqual(self.client.post("/api/register",json={"username":"bob","password":"another-long-passphrase"}).status_code, 200)
        self.assertEqual(self.client.get("/api/profile/export").status_code,404)
        with patch("backend.profile_api.core") as get_core:
            get_core.return_value.identity.return_value = identity
            self.assertEqual(self.client.post("/api/profile/import", content=b"any", headers={"content-type":"application/octet-stream"}).status_code,409)
        self.assertFalse(store.has_profile(store.session_user(self.client.cookies.get("wtox_session"))))

    def test_profile_upload_validation(self):
        self.client.post("/api/register", json={"username":"carol","password":"another-long-passphrase"})
        with patch("backend.profile_api.core") as get_core:
            get_core.return_value.identity.side_effect = __import__("backend.tox_identity",fromlist=["ToxIdentityError"]).ToxIdentityError("invalid file")
            r=self.client.post("/api/profile/import", content=b"not a savedata file",headers={"content-type":"application/octet-stream"})
            self.assertEqual(r.status_code,400)
        r=self.client.post("/api/profile/import", content=b"x" * (8*1024*1024+1),headers={"content-type":"application/octet-stream"})
        self.assertEqual(r.status_code,413)


if __name__ == "__main__":
    unittest.main()
