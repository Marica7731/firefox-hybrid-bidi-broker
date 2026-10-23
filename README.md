# Firefox BiDi Multi-Agent Browser Broker (public reference implementation)

One regular Firefox automation instance, **multiple isolated WebDriver BiDi User Contexts**, and a single authenticated localhost HTTP broker for AI agents. Avoid launching one full browser/profile per task. Designed for **low-memory, reproducible web UI testing**: navigation, DOM snapshots, protocol-trusted clicks / keys / scrolls, JPEG screenshots, and lightweight network metadata, with **optional bounded HTTP body collection**.

> **Status: reference implementation / field-validation required.** Unit tests do not replace browser compatibility testing. This is *not* a turnkey enterprise proxy, network MITM, shared-login manager, or multi-machine service. Nothing in this repo contains application-specific authentication or proprietary information.

## Architecture

```text
Agents (any LLM; text or multimodal)
    | REST (master token only for create/health; per-task token for actions)
    v
Firefox broker (single uvicorn worker)
    | one WebDriver Classic session creates BiDi websocket
    |-- Agent A -> User Context A -> tab A -> cookies/storage A
    |-- Agent B -> User Context B -> tab B -> cookies/storage B
    |-- Agent C -> User Context C -> tab C -> cookies/storage C
    |-- Agent D -> User Context D -> tab D -> cookies/storage D
    +-- global focus/input mutex for trusted actions
```

**Isolation:** Each task receives an independent browser User Context, not merely a separate tab. Network/DOM/screenshot commands address a specific tab; input is conservatively serialized after `browsingContext.activate`. This prevents simultaneous trusted input operations from fighting for foreground focus, but **agents are not all clicking simultaneously**. Browser processes and extensions remain shared and a browser crash affects all tasks. Use a second broker process on another localhost port if long-running foreground tasks require separate focus domains. Measure memory before increasing processes.

## Install (Windows native / Linux desktop / macOS)

Requirements: **Python 3.11+**, a current desktop **Firefox**, and network access on initial setup for `pip` and potentially Selenium Manager's `geckodriver` download. The broker must run on the same OS that owns Firefox's desktop session; on Windows, run the broker with Windows Python. Headed mode is the default; headless is optional but can differ on web apps.

```bash
# Clone this branch (do not clone the repository's other branches):
git clone --depth 1 --single-branch --branch firefox-bidi-agent-broker https://github.com/Marica7731/mygit.git firefox-bidi-agent-broker
cd firefox-bidi-agent-broker
python -m venv .venv
# macOS/Linux: source .venv/bin/activate
# Windows PowerShell: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
# Generate and copy a random token locally; never commit it:
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Set a 24+ character random token in the same terminal:

```bash
# macOS/Linux:
export BROKER_TOKEN='<paste-random-token>'
python -m uvicorn broker:app --host 127.0.0.1 --port 8765 --workers 1
```

```powershell
# Windows PowerShell:
$env:BROKER_TOKEN = '<paste-random-token>'
python -m uvicorn broker:app --host 127.0.0.1 --port 8765 --workers 1
```

Use only **one worker** and disable auto-reload; each worker would start another Firefox. Firefox uses a fresh automation profile and **does not attach to or read existing personal browser sessions**. The API binds to loopback; do not expose it to the public internet or untrusted machines.

Run from a second terminal (set the same `BROKER_TOKEN` there):

```bash
python demo_client.py
python benchmark.py --agents 2
python benchmark.py --agents 4
python -m unittest discover -s tests -v
```

Expected outputs: page title, `example.jpg` screenshot, network events if supported. The benchmark reports per-agent end-to-end times and an RSS snapshot **not peak memory**. For meaningful comparisons, also sample process RSS during concurrent activity and record wall-time, failed actions, p50/p95 and focus conflicts. Repeat at 2 / 4 / 6 agents. Do not claim a memory reduction without those measurements.

## Agent HTTP API

- `POST /tasks` admin bearer token → `{task_id, task_token, network_enabled}`
- `GET /health` admin bearer token → browser status and child-process RSS
- `POST /tasks/{id}/navigate` task token → `{url: "https://example.org"}`
- `GET /tasks/{id}/snapshot` task token → bounded visible text & element metadata
- `GET /tasks/{id}/screenshot?quality=0.7&full_page=false` task token → raw JPEG bytes
- `POST /tasks/{id}/click` task token → `{selector: "button[type=submit]"}`
- `POST /tasks/{id}/type` task token → `{text: "hello"}` (current focused element)
- `POST /tasks/{id}/scroll` task token → `{dx: 0, dy: 500}`
- `GET /tasks/{id}/network?clear=true` task token → bounded request/response metadata
- `POST /tasks/{id}/network/capture` task token → `{max_bytes: 65536}` enable per-task HTTP body collector before navigation
- `GET /tasks/{id}/network/body/{request_id}?kind=response` task token → collected request/response bytes (string or base64), freed after read
- `DELETE /tasks/{id}` task token → destroy User Context and its browser storage

Authorization: Admin calls use `Authorization: Bearer <BROKER_TOKEN>`; task calls use `X-Task-Token: <task_token>`. Tokens should stay local and out of logs and prompts unless the receiving agent is trusted. Task IDs are opaque UUIDs; never pass one agent's token to another. Tasks are cleaned up after `BROKER_IDLE_TTL_SECONDS` of no HTTP access (default: 900 seconds). Set `BROKER_MAX_TASKS` to a safe capacity (default: 6).

### Minimal curl flow

```bash
curl -fsS -H "Authorization: Bearer $BROKER_TOKEN" http://127.0.0.1:8765/health
curl -fsS -X POST -H "Authorization: Bearer $BROKER_TOKEN" -H 'Content-Type: application/json' -d '{"name":"agent-A"}' http://127.0.0.1:8765/tasks
# Use task_id and task_token from the JSON reply on all task calls.
```

## Recommended AI workflow

1. Create a task, store its task token in the local harness (not in a public chat transcript).
2. Navigate, then inspect `/snapshot`; prefer DOM-based selectors instead of screenshot coordinates.
3. If a control is ambiguous or canvas-only, obtain JPEG `/screenshot` and let a vision model interpret it.
4. Run trusted `/click`, `/type`, `/scroll`; inspect resulting DOM or relevant network event before taking another action. Always identify the clicked element by a stable CSS selector.
5. On error, collect screenshot + snapshot + `/network`, then stop or retry deliberately (do not create unbounded loops).
6. `DELETE` the task. Never keep hundreds of background tabs alive.

**Security and scope:** The broker has the ability to navigate arbitrary HTTP(S) sites on the machine. A bearer token is necessary but does not make it safe for public exposure; use loopback plus OS firewall and optionally a local process boundary. `/network` records URL metadata and may contain secrets in URL query strings. Screenshots and snapshots may contain private page content. Treat all outputs as sensitive and avoid forwarding them to untrusted services. No cookie extraction, credential replication, JS eval public endpoint, or arbitrary command execution is exposed. For comprehensive HAR recording, request/response editing, or TLS MITM, use a separately reviewed tool (e.g. mitmproxy) only where authorized.

**Caveats:** UI events in background contexts are not universally safe; this broker activates the task tab before input and serializes operations globally. Complex IME text, drag-and-drop, native file pickers and OS dialogs are intentionally **not** implemented as reliable generic primitives. DOM snapshots exclude cross-origin frames and closed shadow roots. Network events report metadata by default. The optional per-task body collector is bounded to 1 MiB per item, consumes extra memory, and depends on Firefox/geckodriver support (Firefox 143+ for body collection); unsupported cases return an error. For larger dumps or full HAR, use a dedicated recorder. Browser and driver crashes require broker restart. The demo is a smoke test, not compatibility proof for a specific site.

## Official downloads and reference documentation

- Firefox: https://www.mozilla.org/firefox/new/
- Selenium and Selenium Manager (driver download): https://www.selenium.dev/documentation/selenium_manager/
- Python 3 downloads: https://www.python.org/downloads/
- geckodriver releases (for offline/manual install): https://github.com/mozilla/geckodriver/releases
- Firefox WebDriver BiDi project: https://firefox-source-docs.mozilla.org/remote/
- WebDriver BiDi standard: https://www.w3.org/TR/webdriver-bidi/
- WebDriver BiDi `browser.createUserContext`: https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules/browser/createUserContext
- WebDriver BiDi `browsingContext.create`: https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules/browsingContext/create
- WebDriver BiDi `input.performActions`: https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules/input/performActions
- WebDriver BiDi `captureScreenshot`: https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules/browsingContext/captureScreenshot
- WebDriver BiDi `script.evaluate`: https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules/script/evaluate
- WebDriver BiDi `network` module: https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules/network
- WebDriver BiDi network body collection specification: https://www.w3.org/TR/webdriver-bidi/#command-network-addDataCollector
- mitmproxy (optional advanced capture): https://mitmproxy.org/
- Firefox DevTools MCP (alternative high-level tools): https://github.com/mozilla/firefox-devtools-mcp

## License

MIT. For testing web applications that you own or are authorized to automate.
