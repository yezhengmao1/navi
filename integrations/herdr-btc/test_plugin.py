import json
from pathlib import Path
import tempfile
import time
import tomllib
import unittest
from unittest.mock import patch

from btc_status import candles, quote, render, sentiment, sparkline, status
from configure import configure_text


class PluginTests(unittest.TestCase):
    def test_price_change_and_invalid_data(self):
        self.assertAlmostEqual(quote({"last": "110", "open": "100"})["change"], 10)
        for value in ("0", "NaN", "Infinity", "-1"):
            with self.assertRaises(ValueError):
                quote({"last": value, "open": "100"})

    def test_cache_and_network_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            data = {"price": 100, "change": -2, "updated": time.time(), "attempted": time.time(),
                    "chart": {"attempted": time.time()}, "sentiment": {"attempted": time.time()}}
            (directory / "price.json").write_text(json.dumps(data))
            with patch("btc_status.urlopen", side_effect=OSError("offline")) as fetch:
                self.assertEqual(status(directory), "₿ $100 unavailable 😐 -- ▼2.0%")
                fetch.assert_not_called()
                self.assertIn("stale", status(directory, force=True))
                self.assertIn("stale", status(directory))
                self.assertEqual(fetch.call_count, 3)

    def test_first_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch("btc_status.urlopen", side_effect=OSError("offline")):
                self.assertTrue(status(Path(folder)).startswith("₿ unavailable unavailable"))

    def test_candles_sort_filter_and_gaps(self):
        now = 3600
        rows = [[t, 0, 0, 0, i + 100] for i, t in enumerate(range(1800, 3600, 60))]
        parsed = candles(list(reversed(rows)) + [[3600, 0, 0, 0, 999]], now)
        graph = sparkline(parsed["points"], now)
        self.assertEqual(len(graph), 6)
        self.assertEqual(graph, "▁▂▄▅▇█")
        self.assertEqual(sparkline([[2040, 100], [3540, 100]], now), "▄····▄")
        self.assertEqual(sparkline([[2040, 100], [3540, 90]], now), "█····▁")
        self.assertEqual(sparkline(parsed["points"], now + 1800), "unavailable")
        with self.assertRaises(ValueError):
            candles([[3540, 0, 0, 0, "NaN"]], now)

    def test_sentiment(self):
        payload = {"data": [{"value": "5", "value_classification": "Extreme Fear", "timestamp": "3600"}]}
        self.assertEqual(sentiment(payload)["label"], "极度恐慌")
        payload["data"][0]["value"] = "101"
        with self.assertRaises(ValueError):
            sentiment(payload)

    def test_independent_fetch_cache_and_recovery(self):
        now = time.time()
        end = int(now // 60) * 60
        def response(url, parser):
            if "/stats" in url:
                return parser({"last": "110", "open": "100"})
            if "/candles?" in url:
                return parser([[t, 0, 0, 0, 100 + i] for i, t in enumerate(range(end - 1800, end, 60))])
            return parser({"data": [{"value": "5", "value_classification": "Extreme Fear", "timestamp": str(now)}]})
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            with patch("btc_status.fetch", side_effect=response) as fetch:
                output = status(directory)
                self.assertIn("▁▂▄▅▇█", output)
                self.assertIn("😱 5", output)
                self.assertEqual(fetch.call_count, 3)
                self.assertEqual(status(directory), output)
                self.assertEqual(fetch.call_count, 3)
            def partial(url, parser):
                if "/fng/" in url:
                    raise OSError("offline")
                return response(url, parser)
            with patch("btc_status.fetch", side_effect=partial):
                output = status(directory, force=True)
                self.assertIn("😱 5 [stale", output)
                self.assertNotIn("stale", output.split("😱")[0])
            with patch("btc_status.fetch", side_effect=response):
                self.assertNotIn("stale", status(directory, force=True))

    def test_config_preserves_settings_and_is_idempotent(self):
        original = '[theme]\nname = "catppuccin"\n[ui]\nmouse = true\n'
        result = configure_text(original, "python3 /tmp/btc.py")
        self.assertEqual(tomllib.loads(result)["theme"], {"name": "catppuccin"})
        self.assertTrue(tomllib.loads(result)["ui"]["mouse"])
        self.assertEqual(configure_text(result, "python3 /tmp/btc.py"), result)
        self.assertEqual(len(tomllib.loads(configure_text("", "btc"))["ui"]["tab_bar_right"]), 2)

    def test_existing_status_is_preserved(self):
        with self.assertRaises(ValueError):
            configure_text('[ui]\ntab_bar_right = [{type="hostname"}]\n', "btc")


if __name__ == "__main__":
    unittest.main()
