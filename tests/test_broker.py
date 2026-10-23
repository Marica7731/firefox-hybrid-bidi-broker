"""Logic tests that do not require Firefox; live smoke test is demo_client.py."""
import os
import unittest
from unittest.mock import patch

# import fastapi and selenium dependencies after pip install -r requirements.txt
from broker import BrowserBroker, BiDiFailure


class FakeBiDi:
    def __init__(self):
        self.calls = []
        self.next = 0

    def call(self, method, params=None, timeout=30):
        self.calls.append((method, params or {}))
        if method == "browser.createUserContext":
            self.next += 1
            return {"userContext": f"uc-{self.next}"}
        if method == "browsingContext.create":
            return {"context": f"ctx-{self.next}"}
        if method == "session.subscribe":
            return {"subscription": "sub"}
        if method == "script.evaluate":
            return {"type": "success", "result": {"type": "string", "value": '{"x":20,"y":40}'}}
        return {}


class TestBroker(unittest.TestCase):
    def setUp(self):
        self.broker = BrowserBroker()
        self.broker.bidi = FakeBiDi()

    def test_contexts_isolated(self):
        a, b = self.broker.create("a"), self.broker.create("b")
        self.assertNotEqual(a.user_context, b.user_context)
        self.assertNotEqual(a.context, b.context)
        self.broker._on_event({"type": "event", "method": "network.responseCompleted",
                               "params": {"context": b.context, "request": {"url": "https://example.org"},
                                          "response": {"status": 200}}})
        self.assertEqual(len(a.events), 0)
        self.assertEqual(len(b.events), 1)
        self.broker.delete(a.id)
        self.assertNotIn(a.id, self.broker.tasks)
        self.assertIn(b.id, self.broker.tasks)

    def test_capacity(self):
        self.broker.max_tasks = 1
        self.broker.create("a")
        from fastapi import HTTPException
        with self.assertRaises(HTTPException):
            self.broker.create("b")

    def test_real_pointer_path(self):
        task = self.broker.create("click")
        self.broker.click(task, "button")
        methods = [method for method, _ in self.broker.bidi.calls]
        self.assertIn("browsingContext.activate", methods)
        self.assertIn("input.performActions", methods)
        self.assertIn("input.releaseActions", methods)
        self.assertNotIn("WebDriver:ExecuteScript", methods)

    def test_expiry(self):
        task = self.broker.create("old")
        task.touched -= self.broker.idle_ttl + 1
        self.broker.sweep()
        self.assertNotIn(task.id, self.broker.tasks)


if __name__ == "__main__":
    unittest.main()
