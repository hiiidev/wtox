"""Guard against the Vite /assets 404 regression on the actual FastAPI app."""
import re
import unittest
from pathlib import Path

from fastapi.testclient import TestClient
from backend.main import app, FRONTEND_DIR


class ReactStaticAssetsTests(unittest.TestCase):
    def setUp(self):
        if not (FRONTEND_DIR / "index.html").is_file() or not (FRONTEND_DIR / "assets").is_dir():
            self.skipTest("Vite dist not built; CI builds React before Python tests")
        self.client = TestClient(app)  # No lifespan/background Tox threads.

    def tearDown(self):
        if hasattr(self, "client"):
            self.client.close()

    def test_every_hashed_vite_asset_resolves_via_real_fastapi_mount(self):
        html = (FRONTEND_DIR / "index.html").read_text(encoding="utf-8")
        urls = re.findall(r'(?:src|href)="(/assets/[^"]+)"', html)
        self.assertTrue(any(url.endswith(".js") for url in urls), html)
        self.assertTrue(any(url.endswith(".css") for url in urls), html)
        for url in urls:
            with self.subTest(asset=url):
                # Hashed assets are public and bypass the shared-password gate.
                response = self.client.get(url, follow_redirects=False)
                self.assertEqual(response.status_code, 200, f"{url}: {response.text[:140]}")
                self.assertNotEqual(response.headers.get("content-type"), "application/json")
                self.assertGreater(len(response.content), 100)

    def test_asset_health_endpoint_checks_same_build_directory(self):
        result = self.client.get("/health/ui")
        self.assertEqual(result.status_code, 200, result.text)
        body = result.json()
        self.assertTrue(body["ok"])
        self.assertGreaterEqual(body["js"], 1)
        self.assertGreaterEqual(body["css"], 1)

    def test_missing_asset_is_a_404_not_a_site_gate_redirect(self):
        response = self.client.get("/assets/__wtox_missing__.css", follow_redirects=False)
        self.assertEqual(response.status_code, 404)
        self.assertNotIn(response.status_code, (302, 303, 307))


if __name__ == "__main__":
    unittest.main()
