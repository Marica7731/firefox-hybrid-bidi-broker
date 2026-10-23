"""Repeatable lightweight broker benchmark: time and cumulative browser process RSS."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import os
import statistics
import time
import requests

BASE = os.getenv("BROKER_URL", "http://127.0.0.1:8765").rstrip("/")
HEADERS = {"Authorization": "Bearer " + os.environ["BROKER_TOKEN"]}


def go(i, url):
    with requests.Session() as ses:
        create = ses.post(BASE + "/tasks", headers=HEADERS, json={"name": f"bench-{i}"}, timeout=60)
        create.raise_for_status()
        response = create.json()
        base = BASE + "/tasks/" + response["task_id"]
        h = {"X-Task-Token": response["task_token"]}
        t0 = time.perf_counter()
        try:
            for endpoint, payload in [("/navigate", {"url": url})]:
                r = ses.post(base + endpoint, headers=h, json=payload, timeout=65)
                r.raise_for_status()
            for endpoint in ["/snapshot", "/screenshot", "/network"]:
                r = ses.get(base + endpoint, headers=h, timeout=65)
                r.raise_for_status()
        finally:
            ses.delete(base, headers=h, timeout=30).raise_for_status()
        return time.perf_counter() - t0


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--agents", type=int, default=4)
    p.add_argument("--url", default="https://example.org")
    args = p.parse_args()
    assert 1 <= args.agents <= 32
    before = requests.get(BASE + "/health", headers=HEADERS, timeout=10).json()
    with ThreadPoolExecutor(max_workers=args.agents) as exe:
        vals = list(exe.map(lambda i: go(i, args.url), range(args.agents)))
    after = requests.get(BASE + "/health", headers=HEADERS, timeout=10).json()
    print({"agents": args.agents, "latencies_s": [round(v, 2) for v in vals],
           "mean_s": round(statistics.mean(vals), 2),
           "max_s": round(max(vals), 2),
           "start_rss_mib": before.get("rss_mib"),
           "end_rss_mib": after.get("rss_mib")})
    print("Note: process RSS is a snapshot, not peak memory. Compare runs on identical pages/hardware.")


if __name__ == "__main__":
    main()
