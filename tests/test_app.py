import os
import tempfile
import time
import unittest
from types import SimpleNamespace

from test_exporter import FakeClient, make_task
from tripo_export import app


class AppClient(FakeClient):
    async def get_balance(self):
        return SimpleNamespace(balance=1000.0, frozen=0.0)

    async def close(self):
        self.closed = True


class MemorySettings(app.Settings):
    """Settings without the OS keychain."""

    def api_key(self):
        return self._session_key

    def set_api_key(self, key):
        self._session_key = key
        return True


def wait_for(api, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = api.get_job()
        if job and not job["running"]:
            return job
        time.sleep(0.01)
    raise AssertionError("job did not finish")


class AppApiTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.folder = os.path.join(self._tmp.name, "models")
        os.makedirs(self.folder)
        self.settings = MemorySettings(os.path.join(self._tmp.name, "config"))
        self.client = AppClient([make_task("a"), make_task("b")])
        self.server = SimpleNamespace(root=self.folder)
        self.api = app.AppApi(self.server, self.settings, client_factory=lambda key, china: self.client)

    def tearDown(self):
        self._tmp.cleanup()

    def test_jobs_need_an_api_key(self):
        self.assertIn("error", self.api.start_export({}))
        self.assertFalse(self.api.get_state()["has_key"])

    def test_rejects_malformed_key(self):
        self.assertIn("error", self.api.save_settings({"api_key": "sk-wrong"}))

    def test_settings_persist(self):
        state = self.api.save_settings({"api_key": "tsk_abc", "china": True})
        self.assertTrue(state["has_key"])
        self.assertTrue(state["china"])
        reloaded = app.Settings(os.path.dirname(self.settings.path))
        self.assertTrue(reloaded.values["china"])
        with open(self.settings.path, encoding="utf-8") as handle:
            self.assertNotIn("tsk_abc", handle.read())

    def test_export_job_reports_progress_and_result(self):
        self.api.save_settings({"api_key": "tsk_abc"})
        self.assertEqual(self.api.start_export({"format": "GLB"}), {"ok": True})
        job = wait_for(self.api)
        self.assertIsNone(job["error"])
        self.assertEqual((job["done"], job["total"]), (2, 2))
        self.assertIn("保存 2 件", job["result"])
        self.assertTrue(self.client.closed)
        self.assertEqual(len([f for f in os.listdir(self.folder) if f.endswith(".glb")]), 2)

    def test_generate_job(self):
        self.api.save_settings({"api_key": "tsk_abc"})
        self.assertIn("error", self.api.start_generate({"source": "text", "prompt": "  "}))
        self.assertIn("error", self.api.start_generate({"source": "image"}))
        res = self.api.start_generate({"source": "text", "prompt": "a cat", "model_version": "v3.0-20250812",
                                       "detailed": True})
        self.assertEqual(res, {"ok": True})
        job = wait_for(self.api)
        self.assertIsNone(job["error"])
        self.assertEqual(self.client.created[0:2], ("text", "a cat"))
        self.assertEqual(self.client.created[2]["texture_quality"], "detailed")
        self.assertEqual(self.settings.values["model_version"], "v3.0-20250812")

    def test_failed_job_reports_error(self):
        self.api.save_settings({"api_key": "tsk_abc"})

        async def broken(ids):
            raise RuntimeError("API down")

        self.client.list_tasks = broken
        self.api.start_export({})
        job = wait_for(self.api)
        self.assertEqual(job["error"], "API down")

    def test_empty_history_explains_studio_models(self):
        self.api.save_settings({"api_key": "tsk_abc"})
        self.client.usage = []
        self.api.start_export({})
        job = wait_for(self.api)
        self.assertEqual(job["result"], app.NO_HISTORY_TEXT)

    def test_invalid_key_error_is_explained(self):
        self.api.save_settings({"api_key": "tsk_abc"})

        async def rejected():
            raise RuntimeError("[2] Invalid API key Suggestion: Check if your credentials is valid")

        self.client.get_balance = rejected
        self.assertIn("API キーが正しくありません", self.api.get_balance()["error"])

    def test_balance(self):
        self.api.save_settings({"api_key": "tsk_abc"})
        self.assertEqual(self.api.get_balance(), {"balance": 1000.0, "frozen": 0.0})

    def test_set_folder_and_reveal_stays_inside(self):
        other = os.path.join(self._tmp.name, "other")
        self.api.set_folder(other)
        self.assertEqual(self.server.root, other)
        self.assertEqual(self.settings.values["folder"], other)
        revealed = []
        app._reveal, original = (lambda path, select=False: revealed.append(path)), app._reveal
        try:
            self.api.reveal("../models")
            self.assertEqual(revealed, [])
        finally:
            app._reveal = original


if __name__ == "__main__":
    unittest.main()
