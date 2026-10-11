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
        return [{"public_key": PEER, "name": "Friend", "status": 1}]

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
            "WTOX_ACCESS_PASSWORD": "this-is-a-long-web-gate-passphrase",
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
        gate = self.client.post("/api/gate/login", json={
            "password": "this-is-a-long-web-gate-passphrase"
        })
        self.assertEqual(gate.status_code, 200, gate.text)
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
        self.assertEqual(len(self.client.get("/api/friends").json()["friends"]), 1)
        add = self.client.post("/api/friends", json={
            "address": "AA" * 38, "message": "Hello"
        })
        self.assertEqual(add.status_code, 200, add.text)
        accept = self.client.post("/api/friends/accept", json={"public_key": PEER})
        self.assertEqual(accept.status_code, 200, accept.text)
        msg = self.client.post("/api/messages", json={
            "public_key": PEER, "text": "Hello!"
        })
        self.assertEqual(msg.status_code, 200, msg.text)
        self.assertEqual(msg.json()["status"], "queued")
        self.assertEqual(msg.json()["public_key"], PEER)
        self.assertEqual(self.client.get("/api/outbox").json()["messages"][0]["status"],"queued")

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

    def test_gate_and_origins(self):
        resp = self.client.post("/api/messages", json={
            "public_key": PEER, "text": "hey"
        }, headers={"Origin": "https://not-our-site.example"})
        self.assertEqual(resp.status_code, 403, resp.text)
        self.client.cookies.delete("wtox_tox_session")
        self.assertEqual(self.client.get("/api/network").status_code, 401)
        self.client.cookies.delete("wtox_gate")
        self.assertEqual(self.client.get("/api/friends").status_code, 401)

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
