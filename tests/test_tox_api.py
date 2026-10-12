"""Current Tox-savedata login contract for friend, messaging and websocket APIs.

These tests deliberately use a fake native session and DO NOT enter FastAPI's
production lifespan or connect to the real Tox network.
"""
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend import store
from backend.main import app


PEER = "CC" * 32


class FakeSession:
    last_connection = 1
    session_id = "fake-toxcore-instance"
    profile = {"name":"wTox Tester","status_message":"Available","user_status":0}

    def self_profile(self):
        return dict(self.profile)

    def update_self_profile(self,name,status_message,user_status):
        self.profile = {"name":name,"status_message":status_message,
                        "user_status":user_status}
        return dict(self.profile)

    def friends(self):
        return [{"public_key": PEER, "name": "Friend", "status": 1,
                 "status_message": "Testing with aTox", "user_status": 1}]

    def add_friend(self, address, text):
        assert len(address) == 76 and text
        return PEER

    def accept_friend(self, key):
        return key.upper()

    def send_message(self, key, text):
        assert key == PEER and text
        return 42


class ChatApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {
            "WTOX_DATA_DIR": self.temp.name,
            "WTOX_MASTER_KEY": "ab" * 32,
            "WTOX_INSECURE_HTTP": "1",
        })
        self.env.start()
        store.init()
        identity = SimpleNamespace(
            address="A" * 76, secret_proof=b"a" * 32,
            savedata=b"synthetic-tox-savedata-for-api-test",
        )
        self.uid = store.create_tox_identity(identity)
        self.client = TestClient(app)
        self.client.cookies.set("wtox_tox_session", store.create_tox_session(self.uid))
        self.core_mock = patch("backend.tox_api.manager.get", return_value=FakeSession())
        self.core_mock.start()

    def tearDown(self):
        self.core_mock.stop()
        self.client.close()
        self.env.stop()
        self.temp.cleanup()

    def test_friend_and_text_api(self):
        network = self.client.get("/api/network")
        self.assertEqual(network.status_code, 200, network.text)
        self.assertEqual(network.json()["status"], 1)
        self.assertEqual(network.json()["online_friends"],1)
        self.assertEqual(network.json()["total_friends"],1)
        self.assertEqual(network.json()["queued"],0)
        self.assertIn("tox_running",network.json())
        original=self.client.get("/api/friends").json()["friends"]
        self.assertEqual(len(original),1)
        self.assertIsNone(original[0]["tox_id"])
        self.assertEqual(original[0]["status_message"],"Testing with aTox")
        self.assertEqual(original[0]["user_status"],1)
        full_tox_id=PEER+"000000000000"
        add = self.client.post("/api/friends", json={
            "address": full_tox_id, "message": "Hello"
        })
        self.assertEqual(add.status_code, 200, add.text)
        updated=self.client.get("/api/friends").json()["friends"][0]
        self.assertEqual(updated["tox_id"],full_tox_id)
        self.assertEqual(updated["public_key"],PEER)
        accept = self.client.post("/api/friends/accept", json={"public_key": PEER})
        self.assertEqual(accept.status_code, 200, accept.text)
        msg = self.client.post("/api/messages", json={
            "public_key": PEER, "text": "Hello!"
        })
        self.assertEqual(msg.status_code, 200, msg.text)
        self.assertEqual(msg.json()["status"], "queued")
        self.assertEqual(msg.json()["public_key"], PEER)
        self.assertEqual(self.client.get("/api/outbox").json()["messages"][0]["status"],"queued")

    def test_complete_friend_address_is_private_to_owner(self):
        tox_id=PEER+"000000000000"
        self.assertEqual(self.client.post("/api/friends",json={
            "address":tox_id,"message":"test"}).status_code,200)
        self.assertEqual(store.friend_tox_ids(self.uid)[PEER],tox_id)
        with store.db() as con:
            encrypted=con.execute(
                "SELECT tox_address FROM friend_addresses WHERE account_id=?",
                (self.uid,)).fetchone()[0]
        self.assertNotIn(tox_id.encode(),encrypted)
        with self.assertRaises(ValueError):
            store.remember_friend_tox_id(self.uid,PEER,"DD"*38)

    def test_edit_native_profile_and_validate_origin(self):
        current=self.client.get("/api/profile/self")
        self.assertEqual(current.status_code,200,current.text)
        self.assertEqual(current.json()["name"],"wTox Tester")
        update=self.client.put("/api/profile/self", json={
            "name":"Alice","status_message":"Away for lunch","user_status":1
        })
        self.assertEqual(update.status_code,200,update.text)
        self.assertEqual(update.json()["user_status"],1)
        self.assertEqual(self.client.get("/api/profile/self").json()["name"],"Alice")
        bad=self.client.put("/api/profile/self",json={
            "name":"bad","status_message":"","user_status":9
        })
        self.assertEqual(bad.status_code,422)
        cross=self.client.put("/api/profile/self",json={
            "name":"bad","status_message":"","user_status":2
        },headers={"Origin":"https://evil.invalid"})
        self.assertEqual(cross.status_code,403)

    def test_tox_authentication_and_origins(self):
        resp = self.client.post("/api/messages", json={
            "public_key": PEER, "text": "hey"
        }, headers={"Origin": "https://not-our-site.example"})
        self.assertEqual(resp.status_code, 403, resp.text)
        self.client.cookies.delete("wtox_tox_session")
        self.assertEqual(self.client.get("/api/network").status_code, 401)
        self.assertEqual(self.client.get("/api/friends").status_code, 401)
        # The optional entrance endpoint is present and is a no-op when
        # WTOX_ACCESS_PASSWORD is not configured; personal Tox APIs remain private.
        self.assertEqual(self.client.post("/api/gate/login",
            json={"password":"x"}).status_code,200)

    def test_pending_ack_and_websocket_origin(self):
        eid = store.append_pending(self.uid, {
            "type": "message", "public_key": PEER, "text": "Hi"
        })
        with self.client.websocket_connect(
            "/ws", headers={"origin": "http://testserver"}
        ) as ws:
            event = ws.receive_json()
            self.assertEqual(event["id"], eid)
            ws.send_json({"type": "ack", "ids": [eid]})
            ws.send_json({"type": "ping"})
            self.assertEqual(ws.receive_json()["type"], "pong")
        self.assertEqual(store.get_pending(self.uid), [])

    def test_websocket_logs_safe_handshake_markers(self):
        # A public proxy may block before reaching ASGI; this marker
        # distinguishes "never reached the app" from backend rejection.
        with self.assertLogs("uvicorn.error", level="INFO") as output:
            with self.client.websocket_connect(
                "/ws", headers={"origin":"http://testserver"}
            ) as ws:
                ws.send_json({"type":"ping"})
                self.assertEqual(ws.receive_json()["type"],"pong")
        logs=" ".join(output.output)
        self.assertIn("wTox /ws upgrade reached application",logs)
        self.assertIn("wTox /ws upgrade accepted",logs)
        self.assertNotIn(self.session_token,logs)

    def test_websocket_denials_log_safe_reasons(self):
        # Browsers only report a generic websocket error when HTTP upgrade
        # authentication fails. Production logs must identify the condition
        # without exposing any cookie, token, origin or private key value.
        for headers, reason in [
            ({"origin": "https://other.example"}, "origin_host_mismatch"),
            ({}, "origin_host_mismatch"),
        ]:
            with self.subTest(reason=reason, headers=headers):
                with self.assertLogs("uvicorn.error", level="WARNING") as output:
                    with self.assertRaises(WebSocketDisconnect):
                        with self.client.websocket_connect("/ws", headers=headers):
                            pass
                self.assertIn(reason, " ".join(output.output))
                self.assertNotIn("https://other.example", " ".join(output.output))
        self.client.cookies.delete("wtox_tox_session")
        with self.assertLogs("uvicorn.error", level="WARNING") as output:
            with self.assertRaises(WebSocketDisconnect):
                with self.client.websocket_connect(
                    "/ws", headers={"origin":"http://testserver"}
                ):
                    pass
        self.assertIn("tox_session_missing_or_expired", " ".join(output.output))

    def test_all_messages_use_encrypted_vps_queue(self):
        self.assertTrue(self.client.get("/api/settings").json()["offline_queue"])
        # Former per-account switch no longer exists.
        self.assertEqual(self.client.put("/api/settings",
                         json={"offline_queue":False}).status_code,405)
        client_id = "e" * 32
        response = self.client.post("/api/messages", json={
            "public_key": PEER, "text": "queue-secret-text", "client_id": client_id
        })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "queued")
        self.assertEqual(response.json()["id"], client_id)
        self.assertEqual(self.client.get("/api/outbox").json()["messages"][0]["status"], "queued")
        with store.db() as connection:
            encrypted = connection.execute(
                "SELECT data FROM outbox WHERE id=?", (client_id,)
            ).fetchone()[0]
        self.assertNotIn(b"queue-secret-text", encrypted)


if __name__ == "__main__":
    unittest.main()
