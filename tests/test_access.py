"""Site entrance is public; private data requires a Tox identity session."""
import os
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
from backend import access
from backend.main import app


class AccessTest(unittest.TestCase):
    def test_cookie_security_keeps_https_by_default(self):
        with patch.dict(os.environ,{},clear=True):
            self.assertTrue(access.secure_cookies())
        with patch.dict(os.environ,{"WTOX_INSECURE_HTTP":"1"}):
            self.assertFalse(access.secure_cookies())

    def test_public_home_and_protected_private_api(self):
        client=TestClient(app)
        try:
            self.assertEqual(client.get("/").status_code,200)
            self.assertEqual(client.get("/api/me").status_code,401)
            self.assertEqual(client.get("/api/friends").status_code,401)
            self.assertEqual(client.post("/api/gate/login",json={"password":"x"}).status_code,404)
            self.assertEqual(client.get("/gate").status_code,404)
        finally:
            client.close()


if __name__=="__main__":
    unittest.main()
