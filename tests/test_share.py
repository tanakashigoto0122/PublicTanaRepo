import os
import tempfile
import unittest
import urllib.error
import urllib.request

from test_library import touch
from tripo_export import qr, viewer


class ShareTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        touch(self.root, "cat.glb", b"glb-bytes")
        touch(self.root, "secret.glb", b"other")

    def tearDown(self):
        viewer.stop_share()
        self._tmp.cleanup()

    def get(self, url):
        try:
            with urllib.request.urlopen(url) as res:
                return res.status, res.read()
        except urllib.error.HTTPError as err:
            with err:
                return err.code, b""

    def test_shares_only_the_one_model_under_a_random_path(self):
        res = viewer.start_share(self.root, "cat.glb", "<猫>", host="127.0.0.1")
        url = res["url"]
        self.assertRegex(url, r"^http://127\.0\.0\.1:\d+/[\w-]{16}/$")
        self.assertTrue(res["qr"].startswith("<svg"))
        status, page = self.get(url)
        self.assertEqual(status, 200)
        self.assertIn("&lt;猫&gt;", page.decode())
        self.assertIn('ar-modes="webxr scene-viewer quick-look"', page.decode())
        self.assertEqual(self.get(url + "model.glb"), (200, b"glb-bytes"))
        self.assertEqual(self.get(url + "model-viewer.min.js")[0], 200)
        base = url.rsplit("/", 2)[0]
        for path in ("/", "/secret.glb", "/cat.glb", "/wrong-token/model.glb", url[len(base):] + "secret.glb"):
            self.assertEqual(self.get(base + path)[0], 404, path)

    def test_stop_and_replace(self):
        first = viewer.start_share(self.root, "cat.glb", "a", host="127.0.0.1")["url"]
        second = viewer.start_share(self.root, "secret.glb", "b", host="127.0.0.1")["url"]
        self.assertEqual(self.get(second + "model.glb"), (200, b"other"))
        with self.assertRaises(OSError):
            urllib.request.urlopen(first + "model.glb", timeout=2)
        viewer.stop_share()
        with self.assertRaises(OSError):
            urllib.request.urlopen(second + "model.glb", timeout=2)

    def test_only_glb_can_be_shared(self):
        touch(self.root, "chair.fbx", b"fbx")
        with self.assertRaises(ValueError):
            viewer.start_share(self.root, "chair.fbx", "x", host="127.0.0.1")
        with self.assertRaises(ValueError):
            viewer.start_share(self.root, "../outside.glb", "x", host="127.0.0.1")


class QrTests(unittest.TestCase):
    def test_reed_solomon_matches_the_standard_example(self):
        # "HELLO WORLD" at 1-M, the worked example in most QR references.
        data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]
        self.assertEqual(qr.reed_solomon(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23])

    def test_format_bits_match_the_table(self):
        table = ["101010000010010", "101000100100101", "101111001111100", "101101101001011",
                 "100010111111001", "100000011001110", "100111110010111", "100101010100000"]
        self.assertEqual([format(qr.format_bits(m), "015b") for m in range(8)], table)

    def test_version_grows_with_the_text_and_has_finder_patterns(self):
        self.assertEqual(len(qr.encode("http://a/")), 21)
        grid = qr.encode("http://192.168.11.23:54321/Ab3dEfGh1jKlMn0p/")
        self.assertEqual(len(grid), 33)
        finder = [[True] * 7, [True] + [False] * 5 + [True]]
        self.assertEqual([row[:7] for row in grid[:2]], finder)
        self.assertEqual([row[-7:] for row in grid[:2]], finder)
        with self.assertRaises(ValueError):
            qr.encode("x" * 200)


if __name__ == "__main__":
    unittest.main()
