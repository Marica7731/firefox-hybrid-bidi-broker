# AI agent deployment instructions — Firefox Hybrid BiDi Broker

Read README.md first. Deploy the **Node.js 22+** implementation in `src/`; do not deploy legacy Python files or install Selenium/geckodriver. Public and vendor-neutral: do not add private URLs, credentials, browser profiles, session exports, internal port maps or organization names to this repository.

## Objective

Bring up a generic local test environment containing at least two isolated Firefox instances. Use dedicated mode to test parallel trusted inputs, then a shared instance with two user contexts to test storage separation and local input serialization. Measure the results before replacing existing browser automation.

## Checklist

1. Confirm Node 22+, Firefox desktop, OS-approved localhost browser debugging and an interactive display. Obtain runtime from the official links in README.
2. Check out branch `firefox-bidi-agent-broker` of `https://github.com/Marica7731/mygit`.
3. Copy `config.example.json` to **untracked** `config.local.json`, edit separate WebSocket ports and pool capacities. Never edit sample values to match a private environment in public Git.
4. Generate a random `BROKER_ADMIN_TOKEN` (>=24 chars) locally and supply through process environment. Never commit/log this value.
5. Start Firefox processes with separate **disposable** profiles using `scripts/start-firefox.ps1` (Windows) or equivalent approved launch command. No attachment to personal default profiles.
6. Run `npm test` (unit/mock checks), `npm start` (broker), and `npm run smoke` (real browser smoke). A passing unit suite **does not** imply WebDriver BiDi has worked against the target browser.
7. Run `node scripts/benchmark.mjs 2 dedicated` then `node scripts/benchmark.mjs 4 shared` and `node scripts/benchmark.mjs 6 auto` if enough capacity exists. Compare P50/P95, working set/private memory, success rate, focus conflict and browser restart recovery.
8. Optional external integrations (such as credential sources, extra HTTP body logging, MCP frontends) MUST be implemented as private adapters or standalone modules with explicit authorization, size limits and redaction. Keep the public core generic.

## API expectations

- `GET /v1/browsers` and `POST /v1/tasks` accept **admin token** only.
- All `/v1/tasks/:id/...` methods accept **task token** only.
- Task creation accepts `{mode:"auto"|"shared"|"dedicated",leaseSeconds:300}` and returns `id`, `token`, `browserId` and context identifiers.
- Call `POST /v1/tasks/:id/renew` periodically for long-running tasks; delete on completion.
- To fill a test input: first click a CSS selector using trusted BiDi input, then call `/type` (not synthetic events).
- All events are task scoped and sanitized. No raw request/response bodies or HAR claim in v0.2.

## Non-negotiable acceptance

- Agent A and B in **different Firefox processes** can click simultaneously without broker-global input serialization.
- Agent A and B in **one Firefox** have different User Contexts and do not share stored test cookie values.
- Injecting one test cookie through `/cookies` only affects its designated User Context, never the default profile.
- Task tokens cannot be used across tasks; admin token cannot operate as a task token.
- Closing/expiring a task removes its User Context and releases capacity.
- A disconnected browser is marked unavailable, without blocking other nodes; recovery is attempted while idle.
- Benchmarks explicitly report any unsupported BiDi operations as failures, not guessed success.

## Troubleshooting

- `No browser capacity`: check `/v1/browsers`, choose a less restrictive mode or add an additional disposable Firefox instance.
- `Browser unavailable`: check that each Firefox was started with `--remote-debugging-port`, that ports are distinct, and that the port is reachable only through local loopback. If blocked by endpoint policy, seek approved configuration; do not bypass security controls.
- `session not created`: another automation client may own that Firefox's single WebDriver session. Use a separate instance, not session theft.
- `browsingContext` / input failures: update Firefox stable and verify on a simple local fixture first; never suppress errors to mark a test passed.
- Background tab and OS dialogs: per-instance lock only coordinates requests *through the broker*, not unrelated desktop applications.

Read [docs/MIGRATION.md](docs/MIGRATION.md) for integration architecture. Deploy incrementally, retaining the existing stable browser workflow as rollback until all tests pass.
