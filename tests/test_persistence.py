import os
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch

from backend import store
from backend.tox_runtime import hex_bytes


class PersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.settings = patch.dict(os.environ, {
            "WTOX_DATA_DIR": self.temp.name,
            "WTOX_MASTER_KEY": "11" * 32,
        })
        self.settings.start()
        store.init()

    def tearDown(self):
        self.settings.stop()
        self.temp.cleanup()

    def test_encrypted_profiles_and_duplicate_prevention(self):
        alice = store.add_account("alice1", "a-very-long-password")
        bob = store.add_account("bob___", "another-long-password")
        toxid = "A1" * 38
        payload = b"raw-secret-key-material-marker"
        store.claim_profile(alice, payload, toxid)
        self.assertEqual(store.read_profile(alice), payload)
        self.assertIsNone(store.read_profile(bob))
        with store.db() as db:
            raw = db.execute("SELECT profile FROM accounts WHERE id=?", (alice,)).fetchone()[0]
        self.assertNotIn(payload, raw)
        with self.assertRaises(ValueError):
            store.claim_profile(bob, payload, toxid)
        with self.assertRaises(ValueError):
            store.claim_profile(alice, b"other", "B2" * 38)

    def test_pending_queue_is_encrypted_and_acknowledged(self):
        alice = store.add_account("alice1", "a-very-long-password")
        secret_text = "highly-confidential-message"
        event_id = store.append_pending(alice, {"type":"message","text":secret_text})
        with store.db() as db:
            raw = db.execute("SELECT data FROM pending WHERE id=?", (event_id,)).fetchone()[0]
        self.assertNotIn(secret_text.encode(), raw)
        result = store.get_pending(alice)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["event"]["text"], secret_text)
        store.ack_pending(alice, [event_id])
        self.assertEqual(store.get_pending(alice), [])

    def test_expired_queue_items_are_removed(self):
        alice = store.add_account("alice1", "a-very-long-password")
        eid = store.append_pending(alice, {"type":"message","text":"expired"})
        with store.db() as db:
            db.execute("UPDATE pending SET created=? WHERE id=?",(int(time.time())-8*86400,eid))
        self.assertEqual(store.get_pending(alice), [])

    def test_tox_key_hex_validation(self):
        data = "F0" * 32
        self.assertEqual(hex_bytes(data, 32, "key"), bytes.fromhex(data))
        with self.assertRaises(ValueError): hex_bytes("xyz", 32, "key")
        with self.assertRaises(ValueError): hex_bytes("0" * 10, 32, "key")


if __name__ == "__main__":
    unittest.main()
