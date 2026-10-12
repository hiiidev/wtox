"""Optional site password protects API and websocket, with persistent cookies."""
import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend import access
from backend.main import app, _SITE_LOGIN_ATTEMPTS


class AccessTest(unittest.TestCase):
    def setUp(self):
        _SITE_LOGIN_ATTEMPTS.clear()
        self.site_db_dir = tempfile.TemporaryDirectory()
        self.site_db_env = patch.dict(os.environ, {"WTOX_DATA_DIR": self.site_db_dir.name})
        self.site_db_env.start()

    def tearDown(self):
        self.site_db_env.stop()
        self.site_db_dir.cleanup()

    def test_cookie_security_keeps_https_by_default(self):
        with patch.dict(os.environ,{},clear=True):
            self.assertTrue(access.secure_cookies())
        with patch.dict(os.environ,{"WTOX_INSECURE_HTTP":"1"}):
            self.assertFalse(access.secure_cookies())

    def test_public_home_and_protected_private_api_when_gate_disabled(self):
        with patch.dict(os.environ,{"WTOX_ACCESS_PASSWORD":""}):
            client=TestClient(app)
            try:
                self.assertEqual(client.get("/").status_code,200)
                self.assertEqual(client.get("/api/me").status_code,401)
                self.assertEqual(client.get("/api/friends").status_code,401)
                self.assertEqual(client.post("/api/gate/login",
                    json={"password":"x"}).status_code,200)
                self.assertEqual(client.get("/api/gate/status").json(),
                    {"required":False,"authorized":True})
                self.assertEqual(client.get("/gate").status_code,404)
            finally:
                client.close()

    def test_minimum_length_is_checked_on_server_only(self):
        with patch.dict(os.environ,{"WTOX_ACCESS_PASSWORD":"12345"}):
            with self.assertRaisesRegex(ValueError,"at least 6"):
                access.site_password()
        with patch.dict(os.environ,{"WTOX_ACCESS_PASSWORD":"123456"}):
            self.assertEqual(access.site_password(),"123456")

    def test_long_term_cookie_signed_without_thirty_day_expiry(self):
        with patch.dict(os.environ,{
            "WTOX_ACCESS_PASSWORD":"correct secret",
            "WTOX_MASTER_KEY":"e3"*32
        }):
            token=access.issue_access_cookie(access.site_password())
            self.assertTrue(token.startswith("v3."))
            self.assertEqual(len(token.split(".")),3)
            self.assertTrue(access.gate_authorized(token))
            self.assertFalse(access.gate_authorized(token[:-1]+"x"))
            self.assertFalse(access.gate_authorized(None))
            self.assertGreaterEqual(access.REMEMBER_SECONDS,365*86400)
            renewed = access.renew_access_cookie(token)
            self.assertIsNotNone(renewed)
            self.assertTrue(access.gate_authorized(renewed))
            device = next(d for d in access.access_devices(renewed) if d["current"])
            access.revoke_device(device["id"])
            self.assertFalse(access.gate_authorized(renewed))
            with patch.dict(os.environ,{"WTOX_ACCESS_PASSWORD":"changed secret"}):
                self.assertFalse(access.gate_authorized(token))

    def test_entry_form_guards_every_private_api_and_remembers_device(self):
        env={"WTOX_ACCESS_PASSWORD":"good password 123",
             "WTOX_INSECURE_HTTP":"1","WTOX_MASTER_KEY":"c1"*32}
        with patch.dict(os.environ,env):
            client=TestClient(app,base_url="http://testserver")
            try:
                self.assertEqual(client.get("/").status_code,200)
                public=client.get("/api/gate/status")
                self.assertEqual(public.json(),{"required":True,"authorized":False})
                self.assertEqual(public.headers["cache-control"],"no-store")
                for url in ("/api/me","/api/friends","/api/network",
                            "/api/files","/api/legacy/export","/api/pending"):
                    with self.subTest(url=url):
                        r=client.get(url)
                        self.assertEqual(r.status_code,403)
                        self.assertTrue(r.json()["access_required"])
                self.assertEqual(client.post("/api/translate",
                    json={"text":"hi","target":"fr"}).status_code,403)
                with self.assertRaises(WebSocketDisconnect):
                    with client.websocket_connect("/ws",
                             headers={"origin":"http://testserver"}):
                        pass
                bad=client.post("/api/gate/login",json={"password":"incorrect"},
                    headers={"origin":"http://testserver"})
                self.assertEqual(bad.status_code,401)
                self.assertNotIn("good password",bad.text)
                cross=client.post("/api/gate/login",json={"password":"good password 123"},
                    headers={"origin":"http://other.example"})
                self.assertEqual(cross.status_code,403)
                okay=client.post("/api/gate/login",
                    json={"password":"good password 123"},
                    headers={"origin":"http://testserver"})
                self.assertEqual(okay.status_code,200)
                self.assertIn("httponly",okay.headers["set-cookie"].lower())
                self.assertIn("samesite=strict",okay.headers["set-cookie"].lower())
                first=client.cookies.get(access.COOKIE_NAME)
                self.assertTrue(access.gate_authorized(first))
                self.assertEqual(client.get("/api/me").status_code,401,
                    "Website password never substitutes for the Tox identity login")
                again=client.get("/api/gate/status")
                self.assertTrue(again.json()["authorized"])
                self.assertIn("max-age=",again.headers["set-cookie"].lower(),
                    "Each normal visit should transparently renew remembered access")
                self.assertNotEqual(first,client.cookies.get(access.COOKIE_NAME))
                fresh=client.cookies.get(access.COOKIE_NAME)
                devices=client.get("/api/gate/devices").json()["devices"]
                self.assertTrue(any(d["current"] for d in devices))
                current=next(d for d in devices if d["current"])
                self.assertEqual(client.post("/api/gate/devices/"+current["id"]+"/revoke",
                    json={"password":"invalid"}).status_code,403)
                removed=client.post("/api/gate/devices/"+current["id"]+"/revoke",
                    json={"password":"good password 123"})
                self.assertEqual(removed.status_code,200)
                self.assertTrue(removed.json()["current_revoked"])
                self.assertFalse(access.gate_authorized(fresh))
                self.assertEqual(client.get("/api/me").status_code,403)
                self.assertEqual(client.post("/api/gate/login",
                    json={"password":"good password 123"}).status_code,200)
                with patch.dict(os.environ,{"WTOX_ACCESS_PASSWORD":"changed password"}):
                    self.assertEqual(client.get("/api/me").status_code,403)
                    self.assertFalse(client.get("/api/gate/status").json()["authorized"])
            finally:
                client.close()

    def test_brute_force_password_attempts_are_limited(self):
        with patch.dict(os.environ,{
            "WTOX_ACCESS_PASSWORD":"very long password",
            "WTOX_INSECURE_HTTP":"1"
        }):
            client=TestClient(app)
            try:
                for _ in range(12):
                    self.assertEqual(client.post("/api/gate/login",
                        json={"password":"bad"}).status_code,401)
                self.assertEqual(client.post("/api/gate/login",
                    json={"password":"bad"}).status_code,429)
            finally:
                client.close()


if __name__=="__main__":
    unittest.main()
