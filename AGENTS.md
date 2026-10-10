# AGENTS.md

Simple guidance for coding agents working in this repository.

## Repository setup

- Requirements: Node.js + npm
- Install dependencies:

```bash
npm install
```

- Check what would be published:

```bash
npm pack --dry-run
npm publish --dry-run --access public
```

## Local validation

- This package is a Pi extension (entry point: `index.ts`).
- Quick manual check with local package:

```bash
pi -e .
```

- Test suite and typecheck:

```bash
npm test
npm run check
```

## Code map

- `index.ts` — extension entry point: tool registration, event delivery, shutdown lifecycle
- `watch.ts` — watch registry and the three monitor kinds (run/pid/file), kill-tree handling
- `output.ts` — fixed-size output ring buffer and tail formatting
- `tools.ts` — WatchRun/WatchPid/WatchFile/WatchList/WatchStop tool definitions
- `render.ts` — TUI rendering for tool calls/results
- `config.ts` — environment-driven configuration
- `README.md` — user-facing docs

## Design invariants

- The sensing is deterministic code (child events, pid polls, fs.watch) — zero model calls until an event fires.
- Notifications are delivered via `pi.sendUserMessage(..., { deliverAs: "followUp" })` and never interrupt a running turn.
- Watches are session-scoped: children killed (tree, taskkill /T on Windows) and watchers closed on `session_shutdown`, which fires for every teardown reason and is idempotent.
- Stopped runs never emit a completion event — the `WatchStop` result is the confirmation. The `entry.stopped` guard must be checked in the exit handler *before* status is finalized (kills resolve asynchronously).
- Timers and watchers are unref'd where possible so nothing keeps the process alive.
- `watch.ts`/`output.ts` import Node built-ins only — no runtime dependencies on Pi packages. Only `tools.ts`/`render.ts`/`index.ts` touch Pi APIs.
- Internal imports use explicit `.ts` extensions (type-checked with `allowImportingTsExtensions`, stripped by Node and resolved by Pi's loader).
- Tests that spawn children with a temp cwd must clean up with retries — Windows keeps a directory locked while a child's cwd points at it.

## Commit format (important)

Use the repository's existing style:

- Imperative mood
- Sentence case
- No prefix like `feat:` / `fix:` / `chore:`

Examples:

- `Add pi-watch extension for completion monitors`
- `Suppress completion events for stopped runs`

Keep commits focused (one logical change per commit).

## Release notes

- Package name: `@mjakl/pi-watch`
- For doc/code changes on npm, publish a new version (`npm version patch|minor|major`), then publish.
