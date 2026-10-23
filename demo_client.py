"""Run after broker is listening. Exercises isolated context, DOM, click, image and network."""
import os
from pathlib import Path
import requests

BASE = os.getenv("BROKER_URL", "http://127.0.0.1:8765").rstrip("/")
ADMIN = {"Authorization": "Bearer " + os.environ["BROKER_TOKEN"]}


def check(res):
    res.raise_for_status()
    return res


def main():
    payload = check(requests.post(BASE + "/tasks", headers=ADMIN,
                                  json={"name": "demo"}, timeout=60)).json()
    task_id, token = payload["task_id"], payload["task_token"]
    headers = {"X-Task-Token": token}
    prefix = BASE + "/tasks/" + task_id
    try:
        check(requests.post(prefix + "/navigate", headers=headers,
                            json={"url": "https://example.org"}, timeout=65))
        snapshot = check(requests.get(prefix + "/snapshot", headers=headers, timeout=40)).json()
        print("TITLE:", snapshot["title"])
        image = check(requests.get(prefix + "/screenshot", headers=headers, timeout=65)).content
        Path("example.jpg").write_bytes(image)
        print("SCREENSHOT: example.jpg", len(image), "bytes")
        print("NETWORK:", check(requests.get(prefix + "/network", headers=headers,
                                             timeout=20)).json()["events"][:3])
    finally:
        check(requests.delete(prefix, headers=headers, timeout=30))


if __name__ == "__main__":
    main()
