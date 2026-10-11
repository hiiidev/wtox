import os
import unittest
from unittest.mock import patch

from backend import access

class AccessTest(unittest.TestCase):
    def test_roundtrip_and_invalidation(self):
        with patch.dict(os.environ,{"WTOX_MASTER_KEY":"ab"*32,
                                     "WTOX_ACCESS_PASSWORD":"a sufficiently long secret"},clear=False):
            access.validate_settings()
            self.assertTrue(access.access_password_ok("a sufficiently long secret"))
            self.assertFalse(access.access_password_ok("wrong"))
            tok=access.issue_gate_cookie()
            self.assertTrue(access.gate_valid(tok))
            self.assertFalse(access.gate_valid(tok[:-2]+"!!"))
            with patch.dict(os.environ,{"WTOX_ACCESS_PASSWORD":"a different strong secret"},clear=False):
                self.assertFalse(access.gate_valid(tok))

if __name__=="__main__": unittest.main()
