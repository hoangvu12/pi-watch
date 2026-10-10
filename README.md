# pi-watch

Monitor extension for the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). It notifies the agent when something is done.

```
pi> run the tests, but don't block — tell me when they finish
    → WatchRun { command: "npm test" }
    …agent keeps working, no tokens spent on waiting…
[pi-watch] Background command finished (exit 0 after 2m 14s) [id w4f2a1b3]
    --- last output ---
    124 passed
```

The sensing is deterministic code: child-process events, pid polls, `fs.watch`. Nothing costs a model call until an event fires. Notifications ride the session's message queue as follow-up messages, so they never interrupt a running turn. This is the `run_in_background` plus completion-notify pattern, and the local event-source half of an always-on assistant. Pair it with [`@mjakl/pi-cron`](https://www.npmjs.com/package/@mjakl/pi-cron) for time-based triggers.

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
| `WatchRun` | a background command exits. The message includes exit code, duration, and the last output lines. |
| `WatchPid` | an external process (started outside Pi) exits. |
| `WatchFile` | a file or directory changes. Directories are watched recursively; writes are debounced. |
| `WatchList` | nothing; it lists watches and their status. |
| `WatchStop` | nothing; it stops a watch. Background commands are killed, process tree included. |

### WatchRun

```
WatchRun { command: "npm run build", timeout: 600, notifyOn: "failure", label: "build" }
```

- `timeout` kills the command after N seconds and reports a timeout.
- `notifyOn` selects which exits are worth a notification: `always` (default), `success` (only exit 0), or `failure` ("tell me if the build breaks").
- Output is captured in a 16 KiB ring buffer; the completion message carries its tail.
- Children are killed via `taskkill /T` on Windows and TERM then KILL elsewhere.

### WatchPid

```
WatchPid { pid: 41288, label: "model download" }
```

Use it when the user started something outside Pi and wants to know when it is done. Liveness is polled, by default every 500 ms.

### WatchFile

```
WatchFile { path: "./dist", once: true }
```

- Directories are watched recursively, and a burst of writes debounces into one notification (default 500 ms).
- `once: true` stops after the first change. Use it for "tell me when the report appears".
- Watching a file survives delete and recreate, because the parent directory is watched and events are filtered by basename.

## Semantics

Watches are session-scoped. Children are killed and watchers closed on shutdown, the same lifecycle as pi-subagent children. A notification needs a live session to land in.

Every notification is a queued follow-up user message with a `[pi-watch]` header, so the model can tell a monitor event apart from something the human typed.

Stopped runs never notify. The `WatchStop` tool result is the confirmation.

The budget is 20 concurrent watches.

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `PI_WATCH_DISABLE` | off | Kill switch: register nothing. |
| `PI_WATCH_MAX` | `20` | Max concurrent watches. |
| `PI_WATCH_OUTPUT_BYTES` | `16384` | Output ring buffer per command. |
| `PI_WATCH_PID_POLL_MS` | `500` | Pid liveness poll interval. |
| `PI_WATCH_DEBOUNCE_MS` | `500` | Default file-change debounce. |

## Composition

pi-cron handles time triggers and pi-watch handles events; together they are the local equivalent of an always-on assistant's trigger layer. pi-subagent handles the reaction: `WatchRun` a test suite with `notifyOn: "failure"`, and the fired prompt can delegate the fix.

## Development

```bash
npm install
npm test        # node --test (34 tests)
npm run check   # tsc --noEmit
npm pack --dry-run
```

## License

MIT
