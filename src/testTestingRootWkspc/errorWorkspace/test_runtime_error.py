import unittest


class TestRuntimeError(unittest.TestCase):
    def test_exception(self):
        raise RuntimeError("This is a test exception")
