#!/usr/bin/env python3
"""A bounded HTTP fetch with a shared, locked 60-second cache; stdlib only."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import fcntl
import json
import math
import os
from pathlib import Path
import sys
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

URL = "https://api.exchange.coinbase.com/products/BTC-USD/stats"


def quote(data):
    price, opening = float(data["last"]), float(data["open"])
    if not all(math.isfinite(v) and v > 0 for v in (price, opening)):
        raise ValueError("Invalid BTC price")
    change = (price / opening - 1) * 100
    if not math.isfinite(change):
        raise ValueError("Invalid change")
    return {"price": price, "change": change}



def candles(data, now):
    end = int(now // 60) * 60
    points = {}
    for row in data:
        stamp, price = float(row[0]), float(row[4])
        if not math.isfinite(stamp) or not math.isfinite(price) or price <= 0:
            raise ValueError("Invalid candle")
        if end - 1800 <= stamp < end and stamp % 60 == 0:
            points[int(stamp)] = price
    if len(points) < 2:
        raise ValueError("Insufficient recent candles")
    return {"points": [[stamp, points[stamp]] for stamp in sorted(points)]}


def sparkline(points, now):
    end = int(now // 60) * 60
    prices = {int(stamp): price for stamp, price in points if end - 1800 <= stamp < end}
    samples = [prices.get(start + 240) for start in range(end - 1800, end, 300)]
    available = [price for price in samples if price is not None]
    if len(available) < 2:
        return "unavailable"
    low, high = min(available), max(available)
    bars = "▁▂▃▄▅▆▇█"
    return "".join("·" if price is None else
                   bars[3 if high == low else round((price - low) / (high - low) * 7)]
                   for price in samples)


def sentiment(data):
    item = data["data"][0]
    value = int(item["value"])
    stamp = float(item["timestamp"])
    if not 0 <= value <= 100 or not math.isfinite(stamp) or stamp <= 0:
        raise ValueError("Invalid fear/greed index")
    labels = {"Extreme Fear": "极度恐慌", "Fear": "恐慌", "Neutral": "中性",
              "Greed": "贪婪", "Extreme Greed": "极度贪婪"}
    return {"value": value, "label": labels[item["value_classification"]], "timestamp": stamp}


def fetch(url, parser):
    request = Request(url, headers={"User-Agent": "herdr-btc-status/0.2"})
    with urlopen(request, timeout=5) as response:
        return parser(json.load(response))


def stale(data, now, ttl=120):
    age = max(0, now - data["updated"])
    return f" [stale {int(age // 60)}m]" if data.get("error") or age >= ttl else ""


def render(data, now):
    change_text = ""
    if data.get("price"):
        change = data["change"]
        arrow = "▲" if change >= 0 else "▼"
        price = f"₿ ${data['price']:,.0f}{stale(data, now)}"
        change_text = f" {arrow}{abs(change):.1f}%"
    else:
        price = "₿ unavailable"
    chart = data.get("chart", {})
    graph = sparkline(chart.get("points", []), now)
    chart_text = graph
    if graph != "unavailable":
        chart_text += stale(chart, now)
    fear = data.get("sentiment", {})
    fear_text = "😐 --"
    if "value" in fear:
        old = dict(fear)
        if now - fear["timestamp"] >= 172800:
            old["error"] = True
        emoji = {"极度恐慌": "😱", "恐慌": "😨", "中性": "😐", "贪婪": "🤑", "极度贪婪": "🤯"}.get(fear.get("label"), "😐")
        fear_text = f"{emoji} {fear['value']}{stale(old, now, 1800)}"
    return f"{price} {chart_text} {fear_text}{change_text}"


def status(directory, force=False):
    directory.mkdir(parents=True, exist_ok=True)
    cache = directory / "price.json"
    with (directory / "price.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            data = json.loads(cache.read_text())
            if not isinstance(data, dict):
                data = {}
            if data.get("price"):
                for key in ("price", "change", "updated", "attempted"):
                    if not math.isfinite(float(data[key])):
                        raise ValueError("Invalid cache")
                    data[key] = float(data[key])
            for key in ("chart", "sentiment"):
                section = data.get(key)
                if section is not None:
                    if not isinstance(section, dict):
                        raise ValueError("Invalid cache section")
                    for field in ("attempted", "updated"):
                        if field in section and not math.isfinite(float(section[field])):
                            raise ValueError("Invalid cache timestamp")
                    if key == "chart" and "points" in section:
                        candles([[t, 0, 0, 0, p] for t, p in section["points"]], section["updated"])
                    if key == "sentiment" and "value" in section:
                        if not 0 <= section["value"] <= 100 or not math.isfinite(section["timestamp"]):
                            raise ValueError("Invalid cached sentiment")
        except (OSError, ValueError, KeyError, TypeError, IndexError):
            data = {}
        now = time.time()
        end = int(now // 60) * 60
        params = urlencode({"granularity": 60,
                            "start": datetime.fromtimestamp(end - 1800, timezone.utc).isoformat(),
                            "end": datetime.fromtimestamp(end, timezone.utc).isoformat()})
        sources = [
            (None, URL, quote, 60),
            ("chart", "https://api.exchange.coinbase.com/products/BTC-USD/candles?" + params,
             lambda payload: candles(payload, now), 60),
            ("sentiment", "https://api.alternative.me/fng/?limit=1", sentiment, 900),
        ]
        pending = []
        with ThreadPoolExecutor(max_workers=3) as pool:
            for key, url, parser, ttl in sources:
                section = data if key is None else data.get(key, {})
                retry = 60 if section.get("error") else ttl
                if force or not 0 <= now - section.get("attempted", 0) < retry:
                    pending.append((key, pool.submit(fetch, url, parser)))
            for key, future in pending:
                section = data if key is None else data.setdefault(key, {})
                try:
                    section.update(future.result())
                    section["updated"] = time.time()
                    section.pop("error", None)
                except Exception as exc:
                    section["error"] = True
                    print(f"BTC {key or 'price'} fetch failed: {exc}", file=sys.stderr)
                section["attempted"] = time.time()
        if pending:
            temporary = cache.with_suffix(".tmp")
            temporary.write_text(json.dumps(data))
            temporary.replace(cache)
        return render(data, time.time())


if __name__ == "__main__":
    # Same path for plugin actions and status commands, which lack plugin env vars.
    directory = Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache"))) / "herdr-btc-status"
    try:
        print(status(directory, "--refresh" in sys.argv))
    except Exception as exc:
        print(f"BTC status failed: {exc}", file=sys.stderr)
        print("₿ unavailable")
