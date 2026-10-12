"""Ensure JSON request body caps protect against oversized/chunked uploads."""
import os
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
from backend.main import app
from backend.body_limit import MAX_JSON_BODY, MAX_LOGIN_BODY, MAX_FILE_BODY


class RequestBodyLimitTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"WTOX_ACCESS_PASSWORD": ""})
        self.env.start()
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.env.stop()

    def test_large_json_body_with_content_length(self):
        response = self.client.post("/api/gate/login",
            content=b"x" * (MAX_JSON_BODY + 1),
            headers={"Content-Type": "application/json"})
        self.assertEqual(response.status_code, 413)

    def test_chunked_json_body_without_content_length(self):
        def chunks():
            yield b"x" * (MAX_JSON_BODY // 2)
            yield b"x" * (MAX_JSON_BODY // 2 + 2)
        response = self.client.post("/api/gate/login", content=chunks(),
                                    headers={"Content-Type": "application/json"})
        self.assertEqual(response.status_code, 413)

    def test_binary_login_has_separate_limit(self):
        response = self.client.post("/api/tox/login", content=b"x" * (MAX_LOGIN_BODY + 1))
        self.assertEqual(response.status_code, 413)

    def test_binary_attachment_has_15mb_edge_limit(self):
        self.assertEqual(MAX_FILE_BODY, 15_000_000)
        response = self.client.post("/api/files/send", content=b"x" * (MAX_FILE_BODY + 1))
        self.assertEqual(response.status_code, 413)

    def test_normal_json_request_is_unchanged(self):
        self.assertEqual(self.client.post("/api/gate/login",
            json={"password": "test"}).status_code, 200)


if __name__ == "__main__":
    unittest.main()
