"""Translation gateway: origin/auth, bounds, no-open-proxy and parsing."""
import os
import unittest
from unittest.mock import patch, MagicMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import translate_api as tr
from backend.tox_api import require_user

APP=FastAPI()
APP.include_router(tr.router)
APP.dependency_overrides[require_user] = lambda:"f" * 32
CLIENT=TestClient(APP,raise_server_exceptions=False)


class TranslateTests(unittest.TestCase):
    def setUp(self):
        tr._THROTTLE.clear()

    def test_decode_google_response_and_detected_language(self):
        self.assertEqual(
            tr._google_segments([[["你","Hello"],["好","there"]],None,"en"]),
            ("你好","en"))
        with self.assertRaises(ValueError):
            tr._google_segments({})
        with self.assertRaises(ValueError):
            tr._google_segments([[[""]]])

    def test_request_requires_valid_inputs_and_explicit_origin(self):
        with patch.object(tr,"_fetch_google",return_value=("Bonjour","en")) as fetch:
            okay=CLIENT.post("/api/translate",
                json={"text":"Hello","target":"fr"},
                headers={"Origin":"http://testserver"})
            self.assertEqual(okay.status_code,200)
            self.assertEqual(okay.json(),{"translated":"Bonjour","source":"en","target":"fr"})
            self.assertEqual(okay.headers["cache-control"],"no-store")
            fetch.assert_called_once_with("Hello","fr")

            invalid=[
                {"text":"","target":"fr"},
                {"text":"x"*1001,"target":"fr"},
                {"text":"hello","target":"javascript:alert(1)"},
                {"text":"hello","target":"http://foo"},
                {"text":"   ","target":"en"}
            ]
            for body in invalid:
                with self.subTest(body=body):
                    self.assertEqual(CLIENT.post("/api/translate",json=body).status_code,422)
            denied=CLIENT.post("/api/translate",
                json={"text":"hello","target":"fr"},
                headers={"Origin":"https://attacker.example"})
            self.assertEqual(denied.status_code,403)
            self.assertEqual(fetch.call_count,1,"Invalid content never goes upstream")

    def test_upstream_failure_never_leaks_original_or_service_error(self):
        with patch.object(tr,"_fetch_google",side_effect=RuntimeError("SECRET CHAT TEXT")):
            response=CLIENT.post("/api/translate",
                json={"text":"SECRET CHAT TEXT","target":"ja"})
            self.assertEqual(response.status_code,502)
            self.assertNotIn("SECRET CHAT TEXT",response.text)

    def test_bounded_translation_requests(self):
        with patch.object(tr,"_fetch_google",return_value=("ok","en")):
            for _ in range(20):
                self.assertEqual(CLIENT.post("/api/translate",
                    json={"text":"hi","target":"en"}).status_code,200)
            self.assertEqual(CLIENT.post("/api/translate",
                json={"text":"hi","target":"en"}).status_code,429)

    def test_plaintext_sent_only_in_https_post_body(self):
        import urllib.parse
        payload = [[["bonjour", "hello"]], None, "en"]
        response = MagicMock()
        response.status = 200
        response.read.return_value = __import__("json").dumps(payload).encode()
        opener = MagicMock()
        opener.open.return_value.__enter__.return_value = response
        with patch.object(tr, "build_opener", return_value=opener):
            translated, language = tr._fetch_google("secret chat text", "fr")
        request = opener.open.call_args.args[0]
        self.assertEqual(request.get_method(), "POST")
        self.assertNotIn("secret chat text", request.full_url)
        self.assertNotIn("q=", request.full_url)
        self.assertEqual(urllib.parse.parse_qs(request.data.decode())["q"], ["secret chat text"])
        self.assertEqual(translated, "bonjour")
        self.assertEqual(language, "en")

    def test_only_https_operator_configured_upstream(self):
        with patch.dict(os.environ,{"WTOX_TRANSLATE_UPSTREAM":"https://translate.example.org"}):
            self.assertEqual(tr._trusted_endpoint(),
                "https://translate.example.org/translate_a/single")
        for bad in ["http://localhost:3000","file:///etc/passwd",
                    "https://user:password@google.com","https://google.com/path",
                    "https://google.com?q=bad"]:
            with self.subTest(upstream=bad):
                with patch.dict(os.environ,{"WTOX_TRANSLATE_UPSTREAM":bad}):
                    with self.assertRaises(RuntimeError):
                        tr._trusted_endpoint()


if __name__=="__main__":
    unittest.main()
