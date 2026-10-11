"""Contract tests for authenticated chat endpoints, without live Tox network."""
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from backend.main import app


class FakeSession:
    last_connection = 1
    def friends(self):
        return [{"public_key":"CC"*32,"name":"Friend","status":1}]
    def add_friend(self,address,text):
        assert len(address)==76 and text
        return "CC"*32
    def accept_friend(self,key):
        return key.upper()
    def send_message(self,key,text):
        assert len(key)==64 and text
        return 42


class ChatApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {
            "WTOX_DATA_DIR": self.temp.name,
            "WTOX_MASTER_KEY": "ab"*32,
            "WTOX_ACCESS_PASSWORD": "this-is-a-long-web-gate-passphrase",
            "WTOX_INSECURE_HTTP": "1",
        })
        self.env.start()
        self.client_ctx=TestClient(app)
        self.client=self.client_ctx.__enter__()
        self.client.post("/api/gate/login",json={"password":"this-is-a-long-web-gate-passphrase"})
        self.client.post("/api/register",json={"username":"alice","password":"long-account-password"})
        self.core_mock=patch("backend.tox_api.manager.get", return_value=FakeSession())
        self.core_mock.start()

    def tearDown(self):
        self.core_mock.stop()
        self.client_ctx.__exit__(None,None,None)
        self.env.stop()
        self.temp.cleanup()

    def test_friend_and_text_api(self):
        self.assertEqual(self.client.get("/api/network").json()["status"],1)
        self.assertEqual(len(self.client.get("/api/friends").json()["friends"]),1)
        add=self.client.post("/api/friends",json={"address":"AA"*38,"message":"Hello"})
        self.assertEqual(add.status_code,200,add.text)
        accept=self.client.post("/api/friends/accept",json={"public_key":"CC"*32})
        self.assertEqual(accept.status_code,200,accept.text)
        msg=self.client.post("/api/messages",json={"public_key":"CC"*32,"text":"Hello!"})
        self.assertEqual(msg.status_code,200,msg.text)
        self.assertEqual(msg.json()["message_id"],42)

    def test_gate_and_origins(self):
        resp=self.client.post("/api/messages",json={"public_key":"CC"*32,"text":"hey"},
                              headers={"Origin":"https://not-our-site.example"})
        self.assertEqual(resp.status_code,403)
        self.client.cookies.delete("wtox_gate")
        self.assertEqual(self.client.get("/api/friends").status_code,401)

    def test_pending_ack_and_websocket_origin(self):
        from backend import store
        uid=store.session_user(self.client.cookies.get("wtox_session"))
        eid=store.append_pending(uid,{"type":"message","public_key":"CC"*32,"text":"Hi"})
        with self.client.websocket_connect("/ws",headers={"origin":"http://testserver"}) as ws:
            event=ws.receive_json()
            self.assertEqual(event["id"],eid)
            ws.send_json({"type":"ack","ids":[eid]})
            ws.send_json({"type":"ping"})
            self.assertEqual(ws.receive_json()["type"],"pong")
        self.assertEqual(store.get_pending(uid),[])


if __name__=="__main__":
    unittest.main()
