"""Server-side encrypted offline outbox, defaults, expiry and crash safety."""
import os
import sqlite3
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from backend import store
from backend.session_manager import SessionManager


class OutboxTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory()
        self.settings=patch.dict(os.environ, {
            "WTOX_DATA_DIR":self.directory.name,
            "WTOX_MASTER_KEY":"42"*32
        })
        self.settings.start()
        store.init()
        identity=SimpleNamespace(address="A"*76,secret_proof=b"x"*32,savedata=b"secret-tox-identity")
        self.uid=store.create_tox_identity(identity)
        self.peer="B"*64

    def tearDown(self):
        self.settings.stop()
        self.directory.cleanup()

    def enqueue(self, eid="c"*32, text="offline-plaintext-secret"):
        return store.enqueue_outbox(self.uid,self.peer,text,eid)

    def test_default_on_and_per_identity_disable(self):
        self.assertTrue(store.offline_queue_enabled(self.uid))
        store.set_offline_queue(self.uid,False)
        self.assertFalse(store.offline_queue_enabled(self.uid))
        store.set_offline_queue(self.uid,True)
        self.assertTrue(store.offline_queue_enabled(self.uid))

    def test_outbox_is_encrypted_idempotent_and_owned_by_account(self):
        record=self.enqueue()
        self.assertEqual(record["status"],"queued")
        self.assertEqual(self.enqueue(),record)
        with store.db() as c:
            raw=c.execute("SELECT data FROM outbox WHERE id=?",("c"*32,)).fetchone()[0]
        self.assertNotIn(b"offline-plaintext-secret",raw)
        self.assertEqual(store.outbox_queued(self.uid),
                         [("c"*32,self.peer,"offline-plaintext-secret")])
        other=SimpleNamespace(address="C"*76,secret_proof=b"y"*32,savedata=b"other")
        uid2=store.create_tox_identity(other)
        self.assertEqual(store.outbox_status(uid2),[])
        with self.assertRaises(ValueError):
            store.enqueue_outbox(uid2,self.peer,"test","c"*32)

    def test_online_friend_drain_marks_sent_and_clears_plaintext(self):
        self.enqueue()
        manager=SessionManager()
        session=SimpleNamespace(
            session_id="my-tox-session",
            friends=Mock(return_value=[{"public_key":self.peer,"status":2}]),
            send_message=Mock(return_value=123)
        )
        manager.get=lambda uid:session
        manager.dispatch_outbox(self.uid)
        session.send_message.assert_called_once_with(self.peer,"offline-plaintext-secret")
        row=store.outbox_status(self.uid)[0]
        self.assertEqual(row["status"],"sent")
        self.assertEqual(row["session_id"],"my-tox-session")
        self.assertEqual(row["message_id"],123)
        with store.db() as c:
            ciphertext=c.execute("SELECT data FROM outbox WHERE id=?",("c"*32,)).fetchone()[0]
        self.assertIsNone(ciphertext)

    def test_offline_friend_is_not_sent_to(self):
        self.enqueue()
        manager=SessionManager()
        session=SimpleNamespace(
            friends=Mock(return_value=[{"public_key":self.peer,"status":0}]),
            send_message=Mock(return_value=123)
        )
        manager.get=lambda uid:session
        manager.dispatch_outbox(self.uid)
        session.send_message.assert_not_called()
        self.assertEqual(store.outbox_status(self.uid)[0]["status"],"queued")

    def test_crash_during_send_becomes_uncertain_not_resent(self):
        self.enqueue()
        self.assertTrue(store.outbox_claim(self.uid,"c"*32))
        store.init()  # Simulated process restart and schema initialization.
        self.assertEqual(store.outbox_status(self.uid)[0]["status"],"uncertain")
        self.assertEqual(store.outbox_queued(self.uid),[])

    def test_older_than_seven_days_expires_instead_of_sending(self):
        self.enqueue()
        with store.db() as c:
            c.execute("UPDATE outbox SET created=? WHERE id=?",
                      (int(time.time())-8*86400,"c"*32))
        self.assertEqual(store.outbox_queued(self.uid),[])
        self.assertEqual(store.outbox_status(self.uid)[0]["status"],"expired")

    def test_limit_prevents_unbounded_vps_disk_use(self):
        with store.db() as c:
            for i in range(store.OUTBOX_LIMIT):
                c.execute(
                    "INSERT INTO outbox(id,account_id,peer,data,status,created,updated) "
                    "VALUES(?,?,?,?,?,?,?)",
                    (f"{i:032x}",self.uid,self.peer,store.encrypt(b"x"),
                     "queued",int(time.time()),int(time.time()))
                )
        with self.assertRaises(ValueError):
            self.enqueue("f"*32)


if __name__=="__main__":
    unittest.main()
