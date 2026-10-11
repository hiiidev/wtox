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

    def test_all_tox_accounts_have_permanent_vps_queue(self):
        self.assertTrue(store.offline_queue_enabled(self.uid))
        # Existing profiles that had the obsolete browser-only setting migrate
        # automatically when the app initializes its SQLite schema.
        with store.db() as connection:
            connection.execute("UPDATE accounts SET offline_queue=0 WHERE id=?",
                               (self.uid,))
        store.init()
        self.assertTrue(store.offline_queue_enabled(self.uid))
        with store.db() as connection:
            flag=connection.execute("SELECT offline_queue FROM accounts WHERE id=?",
                                    (self.uid,)).fetchone()[0]
        self.assertEqual(flag,1)

    def test_status_summary_is_private_and_distinguishes_queued_from_sent(self):
        self.assertEqual(store.outbox_counts(self.uid),
                         {"queued":0,"dispatching":0,"uncertain":0})
        self.enqueue()
        self.assertEqual(store.outbox_counts(self.uid)["queued"],1)
        identity=SimpleNamespace(address="C"*76,secret_proof=b"y"*32,savedata=b"other")
        another=store.create_tox_identity(identity)
        self.assertEqual(store.outbox_counts(another)["queued"],0)
        self.assertTrue(store.outbox_claim(self.uid,"c"*32))
        self.assertEqual(store.outbox_counts(self.uid)["dispatching"],1)
        store.outbox_finish(self.uid,"c"*32,"sent",session_id="tox",message_id=5)
        self.assertEqual(store.outbox_counts(self.uid)["queued"],0)
        self.assertEqual(store.outbox_counts(self.uid)["dispatching"],0)

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

    def test_dead_tox_session_recovers_for_offline_outbox(self):
        from unittest.mock import Mock
        manager=SessionManager()
        sessions=[]
        def mock_native(savedata,on_event,on_save):
            native=SimpleNamespace(
                files=SimpleNamespace(),
                thread=SimpleNamespace(is_alive=lambda:True),
                start=Mock(),
                friends=Mock(return_value=[{"public_key":self.peer,"status":2}]),
                send_message=Mock(return_value=567),
                session_id="native-restarted",
            )
            sessions.append(native)
            return native
        with patch("backend.session_manager.ToxSession",side_effect=mock_native):
            first=manager.get(self.uid)
            self.assertIs(manager.get(self.uid),first)
            first.thread=SimpleNamespace(is_alive=lambda:False)
            self.enqueue()
            manager.dispatch_outbox(self.uid)
        self.assertEqual(len(sessions),2)
        sessions[1].start.assert_called_once()
        sessions[1].send_message.assert_called_once_with(self.peer,"offline-plaintext-secret")
        self.assertEqual(store.outbox_status(self.uid)[0]["status"],"sent")
        self.assertEqual(manager.sockets,{})

    def test_failure_start_does_not_cache_broken_identity(self):
        manager=SessionManager()
        with patch("backend.session_manager.ToxSession") as native:
            native.return_value.files=SimpleNamespace()
            native.return_value.start.side_effect=RuntimeError("start failed")
            with self.assertRaisesRegex(RuntimeError,"start failed"):
                manager.get(self.uid)
        self.assertNotIn(self.uid,manager.sessions)


if __name__=="__main__":
    unittest.main()
