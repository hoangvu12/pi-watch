# pi-watch

Monitor extension for the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent): **notifies the agent when something is done.**

```
pi> run the tests, but don't block — tell me when they finish
    → WatchRun { command: "npm test" }
    …agent keeps working, zero tokens spent on waiting…
[pi-watch] Background command finished (exit 0 after 2m 14s) [id w4f2a1b3]
    --- last output ---
    124 passed
```

The sensing is deterministic code — child-process events, pid polls, `fs.watch` — so it costs **zero tokens until something actually happens**. Notifications ride the session's message queue as follow-up messages, so they never interrupt a running turn. This is the `run_in_background` + completion-notify pattern, and the local event-source half of an always-on assistant (pair it with [`@mjakl/pi-cron`](https://www.npmjs.com/package/@mjakl/pi-cron) for time-based triggers).

## Install

```bash
pi install @mjakl/pi-watch
```

Or load locally while developing:

```bash
pi -e .
```

## Tools

| Tool | Fires when |
|---|---|
| `WatchRun` | a background **command exits** — message includes exit code, duration, and the last output lines |
| `WatchPid` | an **external process** (started outside Pi) exits |
| `WatchFile` | a **file or directory changes** (directories recursively, debounced) |
| `WatchList` | — (list watches and their status) |
| `WatchStop` | — (stop a watch; background commands are killed, process tree included) |

### WatchRun

```
WatchRun { command: "npm run build", timeout: 600, notifyOn: "failure", label: "build" }
```

- `timeout` — kill after N seconds and report a timeout
- `notifyOn` — `always` (default) / `success` (only exit 0) / `failure` (only failures — "tell me if the build breaks")
- output is captured in a 16 KiB ring buffer; the completion message carries its tail
- children are killed via `taskkill /T` on Windows, TERM→KILL elsewhere

### WatchPid

```
WatchPid { pid: 41288, label: "model download" }
```

Use when the user started something outside Pi and wants to know when it's done. Liveness is polled (default 500 ms).

### WatchFile

```
WatchFile { path: "./dist", once: true }
```

- directories are watched recursively; a burst of writes debounces into one notification (default 500 ms)
- `once: true` stops after the first change — "tell me when the report appears"
- watching a file survives delete/recreate (parent directory + basename filter)

## Semantics

- **Session-scoped:** watches die with the session — children killed, watchers closed on shutdown (same lifecycle as pi-subagent children). A notification needs a live session to land in.
- **Delivery:** every notification is a queued follow-up user message attributed with a `[pi-watch]` header — the model can tell a monitor event apart from something the human typed.
- **Stopped runs never notify** — the `WatchStop` tool result is the confirmation.
- **Budget:** at most 20 concurrent watches.

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `PI_WATCH_DISABLE` | off | Kill switch: register nothing. |
| `PI_WATCH_MAX` | `20` | Max concurrent watches. |
| `PI_WATCH_OUTPUT_BYTES` | `16384` | Output ring buffer per command. |
| `PI_WATCH_PID_POLL_MS` | `500` | Pid liveness poll interval. |
| `PI_WATCH_DEBOUNCE_MS` | `500` | Default file-change debounce. |

## Composition

- **pi-cron** handles *when* (time triggers); **pi-watch** handles *what happened* (events). Together they are the local equivalent of an always-on assistant's trigger layer.
- **pi-subagent** handles the reaction: `WatchRun` a test suite with `notifyOn: "failure"`, and the fired prompt can delegate the fix.

## Development

```bash
npm install
npm test        # node --test (34 tests)
npm run check   # tsc --noEmit
npm pack --dry-run
```

## License

MIT
