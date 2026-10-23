# Instructions for AI deployment agents

This repository is an open, generic browser-testing reference, with no environment-specific credentials or URLs. Read `README.md` first. Never access another person's browser profile or copy browser session data.

## Goal

Deploy one localhost Firefox BiDi broker that can allocate isolated tab/storage contexts to several AI agents. Maintain one broker process with one Selenium/WebDriver session and one BiDi WebSocket. Confirm correctness before optimizing memory.

## Deployment checklist

1. Check that Python >=3.11, desktop Firefox, `git`, `pip` are available. On Windows with a Windows GUI Firefox, use **Windows Python**, not a headless Linux instance. Do not attach to already-running personal Firefox.
2. Clone **only** this branch:
   `git clone --depth 1 --single-branch --branch firefox-bidi-agent-broker https://github.com/Marica7731/mygit.git firefox-bidi-agent-broker`
3. Create virtualenv and install `requirements.txt`.
4. Generate a **new local** `BROKER_TOKEN` with `python -c "import secrets; print(secrets.token_urlsafe(32))"`. Keep it out of Git and shared prompts.
5. Launch `python -m uvicorn broker:app --host 127.0.0.1 --port 8765 --workers 1`. **Do not** set `--reload` or use multiple workers.
6. In another terminal with the same token set, run `python -m unittest discover -s tests -v`, `python demo_client.py`, and then `python benchmark.py --agents 2` and `--agents 4`.
7. Verify the screenshot, page title and whether `network_enabled` is true; check that creating two tasks gives different browser contexts, and destroying one does not close the other.
8. Compare measured wall-time, process RSS, action errors, and screenshots across equivalent runs. If true foreground concurrency is required, deploy a second broker on a different port, each with its own Firefox process.

## Agent operation contract

- Admin: `Authorization: Bearer <BROKER_TOKEN>` only for `/tasks` create and `/health`.
- Individual task: `X-Task-Token: <task_token>` for all `tasks/{id}` endpoints.
- Keep each task token exclusive to its agent. Persist the task ID/token locally only for the task lifetime.
- Typical sequence: create -> navigate -> snapshot -> (screenshot if needed) -> click/type/scroll -> network -> delete.
- Selectors should target stable identifiers. `click` requires CSS selector and uses trusted BiDi pointer events; it activates the tab and holds a process-wide input mutex.
- `type` writes into the *currently focused* element. First `click` the intended input. For nontrivial IME input, implement and validate an OS-specific helper rather than assuming BiDi key events are equivalent to composition.
- Snapshot / capture may expose private content. Do not upload or log it without permission.
- For network payloads: call `POST /tasks/{id}/network/capture` **before** the request, then retrieve `request_id` from `/network`, then `GET /tasks/{id}/network/body/{request_id}`. Per-item cap default 64 KiB, max 1 MiB. Enable only when necessary. Failure to support collectors is not a fatal failure of general browsing.
- Never fall back from an error into global raw script execution, OS shell execution, browsing-profile copying, changing system firewall settings, or sending collected credentials elsewhere.

## Success criteria

- The localhost broker starts and `/health` returns `alive: true`.
- At least 2 isolated task contexts are allocated, with distinct task tokens.
- Both can navigate and take screenshots without sharing cookies/local storage.
- A real click, key typing, scroll and event capture pass on a test page.
- `DELETE` removes the context without affecting another task.
- Memory measurements report RSS and process count; quantify any claimed improvement relative to a baseline. Do **not** invent MB/percent speedups.

## References

- Firefox: https://www.mozilla.org/firefox/new/
- Python: https://www.python.org/downloads/
- Selenium Manager: https://www.selenium.dev/documentation/selenium_manager/
- geckodriver: https://github.com/mozilla/geckodriver/releases
- WebDriver BiDi: https://www.w3.org/TR/webdriver-bidi/
