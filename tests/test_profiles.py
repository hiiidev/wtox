"""Tox-only authentication: no username/password login, preserve legacy identities."""
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend import store
from backend.main import app
from backend.tox_identity import ToxIdentityError


def fixture_identity(char: str, secret: bytes, savedata: bytes):
    return SimpleNamespace(address=char * 76, secret_proof=secret, savedata=savedata)


class ToxLoginTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {
            "WTOX_DATA_DIR": self.tmp.name,
            "WTOX_MASTER_KEY": "ab" * 32,
            "WTOX_ACCESS_PASSWORD": "123456",
            "WTOX_INSECURE_HTTP": "1",
        })
        self.env.start()
        self.context = TestClient(app)
        self.client = self.context.__enter__()
        assert self.client.post("/api/gate/login", json={"password":"123456"}).status_code == 200
        self.alice = fixture_identity("A", b"1"*32, b"native-alice-tox-save")
        self.bob = fixture_identity("B", b"2"*32, b"native-bob-tox-save")

    def tearDown(self):
        self.context.__exit__(None, None, None)
        self.env.stop()
        self.tmp.cleanup()

    def native(self, identity=None, login_error=None):
        fake = SimpleNamespace()
        def identity_fn(savedata=None, nickname=None):
            if login_error:
                raise login_error
            if savedata is None:
                return identity or self.alice
            if savedata == self.alice.savedata:
                return self.alice
            if savedata == self.bob.savedata:
                return self.bob
            if savedata == b"fake-public-key-only":
                return fixture_identity("A", b"x"*32, b"fake-public-key-only")
            raise ToxIdentityError("无效 Tox 配置")
        fake.identity = identity_fn
        return fake

    def test_create_export_logout_and_tox_login(self):
        with patch("backend.profile_api.core", return_value=self.native()), patch("backend.profile_api.activate",return_value=True):
            created=self.client.post("/api/tox/create")
            self.assertEqual(created.status_code,200,created.text)
            self.assertEqual(created.content,self.alice.savedata)
            self.assertEqual(created.headers["x-tox-id"],self.alice.address)
            self.assertTrue(self.client.cookies.get("wtox_tox_session"))
            self.assertEqual(self.client.get("/api/me").json()["public_key"],"A"*64)
            self.assertEqual(self.client.get("/api/profile/export").content,self.alice.savedata)
            self.client.post("/api/logout")
            self.assertEqual(self.client.get("/api/me").status_code,401)
            logged=self.client.post("/api/tox/login",content=self.alice.savedata,
                                    headers={"content-type":"application/octet-stream"})
            self.assertEqual(logged.status_code,200,logged.text)
            self.assertFalse(logged.json()["imported"])
            self.assertEqual(self.client.get("/api/profile/export").content,self.alice.savedata)

    def test_import_other_key_never_exposes_first_profile(self):
        with patch("backend.profile_api.core",return_value=self.native()), patch("backend.profile_api.activate",return_value=True):
            self.client.post("/api/tox/create")
            self.client.post("/api/logout")
            imported=self.client.post("/api/tox/login",content=self.bob.savedata)
            self.assertEqual(imported.status_code,200)
            self.assertTrue(imported.json()["imported"])
            self.assertEqual(self.client.get("/api/profile/export").content,self.bob.savedata)
            self.client.post("/api/logout")
            self.client.post("/api/tox/login",content=self.alice.savedata)
            self.assertEqual(self.client.get("/api/profile/export").content,self.alice.savedata)

    def test_public_tox_id_without_private_key_cannot_login(self):
        with patch("backend.profile_api.core",return_value=self.native()), patch("backend.profile_api.activate",return_value=True):
            self.client.post("/api/tox/create")
            self.client.post("/api/logout")
            result=self.client.post("/api/tox/login", content=b"fake-public-key-only")
            self.assertEqual(result.status_code,403)
            self.assertEqual(self.client.get("/api/me").status_code,401)

    def test_invalid_savedata_and_upload_size(self):
        with patch("backend.profile_api.core",return_value=self.native()):
            bad=self.client.post("/api/tox/login", content=b"garbage")
            self.assertEqual(bad.status_code,400)
            oversized=self.client.post("/api/tox/login", content=b"x"*(8*1024*1024+1))
            self.assertEqual(oversized.status_code,413)

    def test_old_password_endpoints_are_absent(self):
        self.assertEqual(self.client.post("/api/register",json={"username":"alice","password":"anything"}).status_code,404)
        self.assertEqual(self.client.post("/api/login",json={"username":"alice","password":"anything"}).status_code,404)
        self.assertEqual(self.client.post("/api/profile/create").status_code,404)
        self.assertEqual(self.client.post("/api/profile/import",content=b"data").status_code,404)

    def test_legacy_savedata_and_pending_survive_migration(self):
        # A formerly password-based account with an existing native Tox profile.
        uid=store.add_account("olduser","a-long-legacy-password")
        store.claim_profile(uid,self.alice.savedata,self.alice.address)
        pending_id=store.append_pending(uid,{"type":"message","text":"stored-before-upgrade"})
        with store.db() as c:
            c.execute("UPDATE accounts SET tox_secret_hash=NULL WHERE id=?",(uid,))
        self.assertTrue(store.needs_legacy_migration())
        native=self.native()
        store.migrate_legacy_identities(native)
        self.assertFalse(store.needs_legacy_migration())
        with patch("backend.profile_api.core",return_value=native), patch("backend.profile_api.activate",return_value=True):
            response=self.client.post("/api/tox/login",content=self.alice.savedata)
            self.assertEqual(response.status_code,200)
            self.assertFalse(response.json()["imported"])
        self.assertEqual(store.get_pending(uid)[0]["id"], pending_id)
        self.assertEqual(self.client.get("/api/profile/export").content,self.alice.savedata)


if __name__ == "__main__":
    unittest.main()
