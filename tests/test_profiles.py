"""Tox-only authentication: no username/password login, preserve legacy identities."""
import os
import tempfile
import hashlib
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend import store, profile_api
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
        # API unit tests must NEVER enter the application lifespan: doing so
        # starts the real 24/7 Tox native sessions and the infinite outbox task
        # against synthetic .tox fixtures. Test the lifecycle separately.
        store.init()
        # Each test has its own isolated identity DB; isolate the IP rate window too.
        with profile_api._LOCK:
            profile_api._ATTEMPTS.clear()
        self.client = TestClient(app)
        response = self.client.post("/api/gate/login", json={"password":"123456"})
        self.assertEqual(response.status_code, 200, response.text)
        self.backup_mock = patch("backend.profile_api.encrypt_savedata",
                                 side_effect=lambda data,password: b"toxEsave-mock-encrypted")
        self.backup_mock.start()
        self.alice = fixture_identity("A", b"1"*32, b"native-alice-tox-save")
        self.bob = fixture_identity("B", b"2"*32, b"native-bob-tox-save")

    def tearDown(self):
        self.client.close()
        self.backup_mock.stop()
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
            created=self.client.post("/api/tox/create",json={"password":"中文🔐"})
            self.assertEqual(created.status_code,200,created.text)
            self.assertEqual(created.content,b"toxEsave-mock-encrypted")
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
            self.client.post("/api/tox/create",json={"password":"中文🔐"})
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
            self.client.post("/api/tox/create",json={"password":"中文🔐"})
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
        uid="legacy-user-id"
        old_cookie="existing-legacy-session-token"
        with store.db() as c:
            c.execute(
                "INSERT INTO accounts(id,username,password_hash,profile,tox_address,tox_pubkey) "
                "VALUES(?,?,?,?,?,?)",
                (uid, "olduser", "legacy-argon2-hash", store.encrypt(self.alice.savedata),
                 self.alice.address, self.alice.address[:64])
            )
            c.execute("INSERT INTO sessions(token_hash,account_id,expires) VALUES(?,?,?)",
                      (hashlib.sha256(old_cookie.encode()).hexdigest(), uid, int(time.time())+86400))
        pending_id=store.append_pending(uid,{"type":"message","text":"stored-before-upgrade"})
        self.client.cookies.set("wtox_session",old_cookie)
        self.assertEqual(self.client.get("/api/legacy/export").content,self.alice.savedata)
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


    def test_create_requires_nonempty_password(self):
        self.assertEqual(self.client.post("/api/tox/create",json={}).status_code,422)
        self.assertEqual(self.client.post("/api/tox/create",json={"password":""}).status_code,422)
        self.assertEqual(self.client.get("/api/me").status_code,401)

    def test_password_prefixed_encrypted_import(self):
        def decrypt(data,password):
            self.assertEqual(data,b"toxEsave"+b"x"*80)
            if password != "中文🔐":
                raise ToxIdentityError("解密失败：密码不正确")
            return self.alice.savedata
        with patch("backend.profile_api.core",return_value=self.native()), \
             patch("backend.profile_api.activate",return_value=True), \
             patch("backend.profile_api.decrypt_savedata",side_effect=decrypt):
            pw="中文🔐".encode("utf-8")
            encrypted=b"toxEsave"+b"x"*80
            response=self.client.post("/api/tox/login",
                content=pw+encrypted,headers={"X-Tox-Password-Bytes":str(len(pw))})
            self.assertEqual(response.status_code,200,response.text)
            self.client.post("/api/logout")
            failed=self.client.post("/api/tox/login",
                content=b"wrong"+encrypted,headers={"X-Tox-Password-Bytes":"5"})
            self.assertEqual(failed.status_code,400)
            self.assertEqual(self.client.get("/api/me").status_code,401)

    def test_encrypted_profile_export(self):
        with patch("backend.profile_api.core",return_value=self.native()), \
             patch("backend.profile_api.activate",return_value=True):
            self.client.post("/api/tox/create",json={"password":"original"})
            response=self.client.post("/api/profile/export/encrypted",json={"password":"new🔒"})
            self.assertEqual(response.status_code,200,response.text)
            self.assertEqual(response.content,b"toxEsave-mock-encrypted")
            self.assertEqual(self.client.post("/api/profile/export/encrypted",json={"password":""}).status_code,400)


if __name__ == "__main__":
    unittest.main()
