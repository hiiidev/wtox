import os
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from backend import store
from backend.tox_runtime import hex_bytes


def identity(prefix, proof, data):
    return SimpleNamespace(address=prefix * 76, secret_proof=proof, savedata=data)


class PersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.settings = patch.dict(os.environ, {
            "WTOX_DATA_DIR": self.temp.name,
            "WTOX_MASTER_KEY": "11" * 32,
        })
        self.settings.start()
        store.init()
        self.alice = identity("A", b"A"*32, b"raw-secret-key-material-marker")
        self.bob = identity("B", b"B"*32, b"another-private-identity")

    def tearDown(self):
        self.settings.stop()
        self.temp.cleanup()

    def test_encrypted_profiles_and_private_key_verification(self):
        alice_uid = store.create_tox_identity(self.alice)
        self.assertEqual(store.read_profile(alice_uid), self.alice.savedata)
        with store.db() as db:
            raw = db.execute("SELECT profile FROM accounts WHERE id=?", (alice_uid,)).fetchone()[0]
        self.assertNotIn(self.alice.savedata, raw)
        with self.assertRaises(ValueError):
            store.create_tox_identity(self.alice)

        different_savedata_same_key = identity("A", b"A"*32, b"old-backup")
        uid, imported = store.login_or_import_tox(different_savedata_same_key, None)
        self.assertEqual(uid, alice_uid)
        self.assertFalse(imported)
        self.assertEqual(store.read_profile(alice_uid), self.alice.savedata,
                         "Login must not overwrite more recent server-side Tox savedata")

        forged = identity("A", b"X"*32, b"forged-id")
        with self.assertRaises(ValueError):
            store.login_or_import_tox(forged, None)

        bob_uid, imported = store.login_or_import_tox(self.bob, None)
        self.assertTrue(imported)
        self.assertNotEqual(bob_uid, alice_uid)
        self.assertEqual(store.read_profile(bob_uid), self.bob.savedata)

    def test_pending_queue_is_encrypted_and_acknowledged(self):
        alice = store.create_tox_identity(self.alice)
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
        alice = store.create_tox_identity(self.alice)
        eid = store.append_pending(alice, {"type":"message","text":"expired"})
        with store.db() as db:
            db.execute("UPDATE pending SET created=? WHERE id=?",
                       (int(time.time())-8*86400,eid))
        self.assertEqual(store.get_pending(alice), [])

    def test_tox_key_hex_validation(self):
        data = "F0" * 32
        self.assertEqual(hex_bytes(data, 32, "key"), bytes.fromhex(data))
        with self.assertRaises(ValueError):
            hex_bytes("xyz", 32, "key")
        with self.assertRaises(ValueError):
            hex_bytes("0" * 10, 32, "key")


if __name__ == "__main__":
    unittest.main()
