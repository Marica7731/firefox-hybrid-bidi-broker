# Firefox Hybrid BiDi Broker (Node.js)

[中文部署摘要](#中文部署摘要) · [AI deployment instructions](AGENTS.md) · [Migration guide](docs/MIGRATION.md)

**A public, standalone reference implementation** for many AI agents sharing browser automation resources. This revision implements a **hybrid pool**: independent Firefox processes for truly concurrent trusted input, plus multiple WebDriver BiDi user contexts in a compact Firefox process for short, lower-overhead tasks.

**Status:** Node logic has automated tests; **Firefox end-to-end performance, site compatibility, network capture completeness and focus behavior are not verified in this environment**. Test against a disposable browser profile first. Do not assume a reduction in RAM until you measure it.

## Architecture

```text
LLM agents (text / multimodal; model-agnostic)
           |
     HTTP JSON + bearer tokens (127.0.0.1 only)
           |
   Node.js 22+ BrowserBroker (no npm dependencies)
    |          |                   |
 dedicated  dedicated          shared
 Firefox A  Firefox B          Firefox C
 1 task      1 task           2-16 user contexts
    |          |                   |
 BiDi WS    BiDi WS          BiDi WS
 instance   instance         instance
 mutex      mutex            mutex
```

- **Independent processes:** clicks/typing can execute concurrently across A and B, with independent crash domains.
- **Shared process:** tabs have distinct `browser.createUserContext` storage partitions; trusted input and navigation/activation are serialized **only within that Firefox process**.
- **Task leases:** task-scoped random token; expiration/renewal; cleanup removes the task-owned user context (including its storage).
- **Network:** bounded **metadata-only** `network.*` events, scoped to task top-level context. No request/response body collection, full HAR export, proxy interception or credential logging in v0.2.
- **Authentication adapter:** authorized clients can call `POST /v1/tasks/{id}/cookies` using WebDriver BiDi `storage.setCookie` and explicit `userContext` partition. No credential harvesting or login workflow is shipped.
- **Firefox connection:** Node built-in WebSocket connects **directly** to Firefox; no Python, Selenium, geckodriver, Playwright, browser extension, or npm dependencies.

## Links / requirements

- [Node.js 22+ downloads](https://nodejs.org/en/download) (Node 22+ required for global `WebSocket`)
- [Firefox stable downloads](https://www.mozilla.org/firefox/new/)
- [MDN: direct Firefox BiDi connection](https://developer.mozilla.org/en-US/docs/Web/WebDriver/How_to/Create_BiDi_connection)
- [MDN: user context isolation](https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules/browser/createUserContext)
- [MDN: trusted input actions](https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules/input/performActions)
- [Mozilla: per-context `storage.setCookie`](https://fxdx.dev/firefox-webdriver-newsletter-125/)
- [W3C: BiDi protocol](https://www.w3.org/TR/webdriver-bidi/)

## Install & start (Windows PowerShell)

```powershell
git clone --depth 1 --single-branch --branch firefox-bidi-agent-broker https://github.com/Marica7731/mygit.git hybrid-bidi-broker
cd hybrid-bidi-broker
node --version
Copy-Item config.example.json config.local.json
$env:BROKER_ADMIN_TOKEN = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

`node` should print **v22 or newer**. Edit `config.local.json` to list your actual test Firefox processes and their debugging ports (the example has three processes). Each Firefox must be started with a **different disposable profile** and a unique `--remote-debugging-port`.

```powershell
.\scripts\start-firefox.ps1 -Port 9222 -ProfileDir .\.data\firefox-a
.\scripts\start-firefox.ps1 -Port 9223 -ProfileDir .\.data\firefox-b
.\scripts\start-firefox.ps1 -Port 9224 -ProfileDir .\.data\firefox-c
npm test
npm start
```

The broker listens **only** on `http://127.0.0.1:8765` by default. Node must run on the OS that can reach these Firefox BiDi localhost WebSockets. Do not bind to an external interface or forward debug ports. Do not connect to an interactive user's profile. A previously running Firefox instance without the debugging flag cannot be retrofitted; start a disposable instance.

If a Windows endpoint policy blocks a localhost process connection, **do not attempt to bypass it**; verify the approved deployment configuration with your administrator. Node does not guarantee endpoint-agent compatibility.

Linux: start isolated Firefox processes with distinct `-profile` directories and `--remote-debugging-port`, then run the same `npm test` / `npm start` commands. A graphical desktop session is required for reliable focus-dependent operations.

## API

All routes use JSON, require `Authorization: Bearer ...`, and reply with `Cache-Control: no-store`. Only two routes accept the **administrator** bearer token; every task route requires **that task's** returned random bearer token.

| Method / route | Authorization | Description |
| --- | --- | --- |
| `GET /v1/browsers` | admin | pool status / allocations |
| `POST /v1/tasks` | admin | create task: `{ "mode":"auto|shared|dedicated", "leaseSeconds":300 }` |
| `GET /v1/tasks/{id}` | task | task status |
| `DELETE /v1/tasks/{id}` | task | cleanup and release |
| `POST /v1/tasks/{id}/renew` | task | extend task lease |
| `POST /v1/tasks/{id}/navigate` | task | `{ "url":"https://example.com" }` |
| `GET /v1/tasks/{id}/snapshot` | task | bounded DOM/text snapshot |
| `GET /v1/tasks/{id}/screenshot?format=jpeg&quality=0.7` | task | base64 screenshot |
| `POST /v1/tasks/{id}/click` | task | trusted mouse click via CSS selector |
| `POST /v1/tasks/{id}/type` | task | text typing in focused control |
| `POST /v1/tasks/{id}/scroll` | task | `{ "deltaY":400, "deltaX":0 }` |
| `POST /v1/tasks/{id}/cookies` | task | cookie injection into this task's User Context |
| `GET /v1/tasks/{id}/events?clear=1` | task | bounded sanitized network/log events |

Task creation response includes `id`, `token`, `browserId`, `userContext`, `context`, `expiresAt`. **Never log a task token or Cookie value.**

### Example (PowerShell)

```powershell
$headers=@{Authorization="Bearer $env:BROKER_ADMIN_TOKEN"}
Invoke-RestMethod -Uri 'http://127.0.0.1:8765/v1/browsers' -Headers $headers
$task=Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8765/v1/tasks' -Headers $headers -ContentType 'application/json' -Body '{"mode":"shared","leaseSeconds":300}'
$tHeader=@{Authorization="Bearer $($task.token)"}
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8765/v1/tasks/$($task.id)/navigate" -Headers $tHeader -ContentType 'application/json' -Body '{"url":"https://example.com"}'
Invoke-RestMethod -Uri "http://127.0.0.1:8765/v1/tasks/$($task.id)/snapshot" -Headers $tHeader
Invoke-RestMethod -Method Delete -Uri "http://127.0.0.1:8765/v1/tasks/$($task.id)" -Headers $tHeader
```

### Example: inject **test** cookie

```json
{"cookies":[{"name":"example_test","value":"development_only","domain":"example.com","path":"/","secure":true}]}
```

Send that object via authenticated `POST /v1/tasks/{id}/cookies` **before navigating**. Cookies are set with WebDriver BiDi's **singular** `storage.setCookie`, once for each entry, partitioned by task `userContext`. The broker does not support copying browser storage or fetching cookies from another user profile.

### Run the smoke and benchmark scripts

```powershell
npm run smoke
node scripts/benchmark.mjs 2 dedicated
node scripts/benchmark.mjs 4 shared
node scripts/benchmark.mjs 6 auto
```

Benchmark fixture is served from a disposable `127.0.0.1` HTTP server; it performs real navigation, trusted click, DOM snapshot, screenshot. The output includes success/failure, wall time and per-operation timings. **It does not measure Firefox RAM**: use OS process/private-memory counters with the same sites, window sizes, loads and repetition counts. Example on Windows:

```powershell
Get-Process firefox -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum
```

Use P50/P95 latency, aggregate private memory/working set, click accuracy, focus conflicts, crashes and recovery time. Shared mode is best treated as an optimization hypothesis, not a guaranteed replacement for fully parallel input.

## Limitations and safety

1. This is a **single-host** reference broker. It does not include TLS, remote authentication or multiple Node workers. Keep all listening endpoints and Firefox debug sockets on loopback. A bearer token is not a defense against a compromised local OS account.
2. Shared-context cookie/storage isolation does **not** isolate CPU, process crashes, display focus, cache perfectly, downloads or all browser preferences. Do not put mutually untrusted agents in the same process.
3. `browsingContext.activate` intentionally focuses a tab. The per-instance mutex protects click/type/scroll/navigate within the same browser. Other browser windows can interact independently; OS-level dialogs and third-party focus changes need separate coordination.
4. Network collection is **metadata-only** and records the origin (not paths/queries/headers/bodies); cross-origin iframe and worker requests without a mapped top-level context may be omitted. HAR/response body features require a separate opt-in collector implementation and browser-compatibility testing.
5. No persistence of active tasks across broker restart. Tasks created in the previous process cannot be reclaimed by a new process; when starting a replacement broker, restart the disposable Firefox profiles too.
6. Localhost pages must be trusted during testing. Screenshots/snapshots may include sensitive information and should not be sent to untrusted models or placed in public logs.
7. Browser/Node version and platform support differ. Test in a disposable instance before using production-like sessions. `session.new` is not supported concurrently by the same Firefox; **exactly one connection owner per Firefox**.

## 中文部署摘要

本项目是通用、公开的 **Node.js 混合浏览器池**，不包含任何专有系统、凭证或业务登录逻辑。多个 Firefox 进程可真正并行点击；同一 Firefox 内的多个独立 User Context 共享进程内存，但输入操作按实例排队。部署请先阅读 [AGENTS.md](AGENTS.md)，执行 `npm test`，再按 README 启动独立 Firefox 测试实例并运行真实浏览器基准测试。正式替换前必须在目标环境验收；旧 Python 脚本不再是推荐入口。

## License

MIT, see [LICENSE](LICENSE).
