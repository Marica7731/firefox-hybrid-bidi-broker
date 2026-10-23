# Integration & migration (vendor neutral)

## Recommended strategy

**Do not replace a working parallel browser setup wholesale.** Integrate the Node module behind an existing local HTTP gateway or run it on a separate loopback port. Use the gateway to authorize agents and forward broker routes, retaining the per-task token boundary.

1. First use only `dedicated` browser nodes: one Firefox process per input-heavy long task. The broker consolidates protocol management and credentials but **does not serialize across processes**.
2. Add one `shared` node for lightweight short-lived jobs that mainly read DOM, capture screenshots and inspect response metadata.
3. Profile concurrent memory usage with 2, 4 and 6 tasks using identical pages and workloads. Escalate focus-heavy tasks to dedicated nodes; do not auto-switch a task's browser mid-run.
4. Add a private authentication adapter if required. It should supply **explicit test cookies** to the documented `/cookies` endpoint; the public broker must not acquire or extract browser credentials.
5. Implement optional MCP tools as a thin client over HTTP; never allow each agent to call `session.new` on its own. The broker owns the Firefox session.
6. Keep the older automation workflow as a fallback until input fidelity, network coverage and failure handling are accepted.

## Session ownership / crash behavior

The broker is the sole WebDriver BiDi session owner per Firefox. `BidiClient` connects directly to `ws://127.0.0.1:PORT/session`, sends `session.new`, and subscribes once. Firefox typically allows one active automation session. Do not multiplex new sessions across agents. For a disconnected node, old task contexts cannot be guaranteed to survive; its tasks are reclaimed, and the broker attempts reconnection only after allocations reach zero.

## Task selection

- `dedicated`: requests one of the configured dedicated Firefox instances; reject when none is free. Input across different instances is independent.
- `shared`: requests a slot in a Firefox instance configured with capacity greater than one; creates its own User Context and tab. Its instance-wide focus-dependent commands queue.
- `auto`: favors shared capacity for low process overhead. Applications requiring deterministic parallel clicks **must request dedicated**.

## Benchmark methodology

Run the exact same fixture and action sequence across modes. Record latency distribution, task throughput, correctness and resource usage. On Windows sample the Firefox process tree's `WorkingSet64` and `PrivateMemorySize64` via PowerShell; on Linux use process RSS/PSS where available. Re-run 5+ times with cold/warm states separated. Any focused-click violation or credential leakage is a hard failure, regardless of memory reduction.

## Known gaps / deliberately deferred

- No full HAR, request/response body capture, proxy interception, tracing to disk, accessibility-tree snapshots, OS file chooser automation, browser preference management, dynamic process spawn/kill or production-grade distributed broker.
- Browser-level events are routed by top-level context only; some subframe/worker network events are absent. Add proper context ancestry tracking and feature tests before relying on completeness.
- Browser reload/restart loses in-memory task tokens and contexts. Current recovery is best-effort after failure; create a new disposable profile as needed.
- JSON snapshot includes page text and basic controls; complex rich-app accessibility may need a separate read-only DOM adapter.

## Why direct WebSocket instead of Selenium

[Mozilla documented direct BiDi startup](https://developer.mozilla.org/en-US/docs/Web/WebDriver/How_to/Create_BiDi_connection) eliminates Selenium/geckodriver and its extra local service from this **reference** implementation. This is a reduction in the dependency graph, **not** a way to evade endpoint policy. Approval and testing on the target OS remain mandatory.
