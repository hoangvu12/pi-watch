/**
 * WatchRun / WatchPid / WatchFile / WatchList / WatchStop tool definitions.
 *
 * Thin layer over WatchRegistry: schemas, descriptions, and result text.
 * The registry is the testable core; the tools know about Pi.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type WatchEntry, type WatchRegistry, formatDuration } from "./watch.ts";
import { oneLinePreview } from "./output.ts";
import { renderWatchCall, renderWatchResult } from "./render.ts";

export const WATCH_RUN_TOOL_NAME = "WatchRun";
export const WATCH_PID_TOOL_NAME = "WatchPid";
export const WATCH_FILE_TOOL_NAME = "WatchFile";
export const WATCH_LIST_TOOL_NAME = "WatchList";
export const WATCH_STOP_TOOL_NAME = "WatchStop";

const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;

const RUN_PARAMS = Type.Object({
	command: Type.String({
		description:
			'Shell command to run in the background, e.g. "npm test" or "npm run build". Completes without holding this turn open.',
		minLength: 1,
	}),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the command (default: session cwd).", minLength: 1 }),
	),
	timeout: Type.Optional(
		Type.Integer({
			description: "Kill the command after this many seconds and report a timeout. Omit for no timeout.",
			minimum: 1,
			maximum: MAX_TIMEOUT_SECONDS,
		}),
	),
	notifyOn: Type.Optional(
		Type.Union(
			[Type.Literal("always"), Type.Literal("success"), Type.Literal("failure")],
			{
				description:
					'always (default) = notify on exit regardless of code. success = only when exit code 0. failure = only when it fails or times out. "failure" suits "tell me if the build breaks".',
			},
		),
	),
	label: Type.Optional(
		Type.String({ description: "Short human label echoed in the notification, e.g. \"unit tests\".", maxLength: 60 }),
	),
});

const PID_PARAMS = Type.Object({
	pid: Type.Integer({ description: "Process id to wait on. Notifies when it exits.", minimum: 1 }),
	label: Type.Optional(Type.String({ description: "Short label echoed in the notification.", maxLength: 60 })),
});

const FILE_PARAMS = Type.Object({
	path: Type.String({ description: "File or directory to watch. Directories are watched recursively.", minLength: 1 }),
	once: Type.Optional(
		Type.Boolean({ description: "true = notify on the first change, then stop watching. false (default) keeps watching." }),
	),
	label: Type.Optional(Type.String({ description: "Short label echoed in the notification.", maxLength: 60 })),
});

const LIST_PARAMS = Type.Object({});

const STOP_PARAMS = Type.Object({
	id: Type.String({ description: "Watch id returned by WatchRun/WatchPid/WatchFile.", minLength: 1 }),
});

export const HEADLESS_NOTE =
	"This run is headless and exits after the current prompt, so watches started here are stopped before they can notify. Run watches from an interactive session.";

function kindLine(entry: WatchEntry, tail?: string): string {
	const age = formatDuration(Date.now() - entry.startedAt);
	switch (entry.kind) {
		case "run":
			return `${entry.id}  run  ${entry.status === "running" ? `running ${age}` : entry.lastEvent ?? "done"}  "${oneLinePreview(entry.command ?? "")}"`;
		case "pid":
			return `${entry.id}  pid  ${entry.status === "running" ? `pid ${entry.pid} alive ${age}` : `exited after ${age}`}  ${entry.label ?? ""}`.trimEnd();
		case "file":
			return `${entry.id}  file  ${entry.status === "running" ? `watching ${age}` : entry.lastEvent ?? "done"}  ${entry.watchPath ?? ""}${tail ? `  "${oneLinePreview(tail, 40)}"` : ""}`.trimEnd();
	}
}

export function registerWatchTools(pi: ExtensionAPI, registry: WatchRegistry): void {
	const runTool: ToolDefinition<typeof RUN_PARAMS> = {
		name: WATCH_RUN_TOOL_NAME,
		label: "Watch run",
		description: `Run a command in the background and get notified when it finishes. The tool returns immediately with a watch id; when the command exits, a message with the exit code and the last output lines is delivered to this session (queued, so it never interrupts a running turn). Use for long builds, test suites, installs — anything you would otherwise block a turn waiting on. timeout kills the command and reports a timeout; notifyOn filters which exits are worth a notification. Watches are session-scoped: children are stopped when this Pi session ends.`,
		promptSnippet: "Run a command in the background and notify the session when it finishes.",
		parameters: RUN_PARAMS,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const entry = registry.startRun({
				command: params.command,
				cwd: params.cwd ?? ctx.cwd,
				timeoutMs: params.timeout ? params.timeout * 1000 : undefined,
				notifyOn: params.notifyOn ?? "always",
				label: params.label,
			});
			const lines = [
				`Watching background command [id ${entry.id}]${entry.label ? ` (${entry.label})` : ""}.`,
				"You will get a message here when it exits — keep working, or tell the user it is running.",
			];
			if (ctx.mode === "print") lines.push(HEADLESS_NOTE);
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: entry,
			};
		},
		renderCall: (args, theme) => renderWatchCall("run", args, theme),
		renderResult: (result, _options, theme, context) =>
			renderWatchResult("run", result.details, context.isError, theme),
	};

	const pidTool: ToolDefinition<typeof PID_PARAMS> = {
		name: WATCH_PID_TOOL_NAME,
		label: "Watch pid",
		description:
			"Notify this session when an external process exits. Use when the user started something outside Pi (a download, another terminal's build) and wants to know when it is done. Liveness is polled; the notification arrives as a queued message.",
		promptSnippet: "Notify the session when an external process (pid) exits.",
		parameters: PID_PARAMS,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const entry = registry.startPid({ pid: params.pid, label: params.label });
			const lines = [
				`Watching process ${entry.pid} [id ${entry.id}]${entry.label ? ` (${entry.label})` : ""}.`,
				"A message will arrive here when it exits.",
			];
			if (ctx.mode === "print") lines.push(HEADLESS_NOTE);
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: entry };
		},
		renderCall: (args, theme) => renderWatchCall("pid", args, theme),
		renderResult: (result, _options, theme, context) =>
			renderWatchResult("pid", result.details, context.isError, theme),
	};

	const fileTool: ToolDefinition<typeof FILE_PARAMS> = {
		name: WATCH_FILE_TOOL_NAME,
		label: "Watch file",
		description:
			"Notify this session when a file or directory changes. Directories are watched recursively; file events are debounced (default 500 ms) so a burst of writes becomes one notification. once: true stops after the first change — use it for 'tell me when this file appears/changes'. Watching a file survives delete/recreate. Watches are session-scoped.",
		promptSnippet: "Notify the session when a file or directory changes.",
		parameters: FILE_PARAMS,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const entry = registry.startFile({
				watchPath: params.path,
				once: params.once ?? false,
				label: params.label,
			});
			const lines = [
				`Watching ${entry.watchPath} [id ${entry.id}]${entry.once ? " (once)" : ""}.`,
				"A message will arrive here when it changes.",
			];
			if (ctx.mode === "print") lines.push(HEADLESS_NOTE);
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: entry };
		},
		renderCall: (args, theme) => renderWatchCall("file", args, theme),
		renderResult: (result, _options, theme, context) =>
			renderWatchResult("file", result.details, context.isError, theme),
	};

	const listTool: ToolDefinition<typeof LIST_PARAMS> = {
		name: WATCH_LIST_TOOL_NAME,
		label: "Watch list",
		description: "List watches: id, kind, status, and what is being watched.",
		promptSnippet: "List active and recently finished watches.",
		parameters: LIST_PARAMS,
		executionMode: "sequential",
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const entries = registry.list();
			const text =
				entries.length === 0
					? "No watches."
					: `${entries.length} watch(es):\n${entries
							.map((entry) => kindLine(entry, entry.kind === "run" && entry.status === "done" ? registry.tail(entry.id) : undefined))
							.join("\n")}`;
			return { content: [{ type: "text" as const, text }], details: { watches: entries } };
		},
		renderResult: (result, _options, theme, context) =>
			renderWatchResult("list", result.details, context.isError, theme),
	};

	const stopTool: ToolDefinition<typeof STOP_PARAMS> = {
		name: WATCH_STOP_TOOL_NAME,
		label: "Watch stop",
		description:
			"Stop a watch by id. Background commands are killed (their process tree, on Windows via taskkill). Stopped commands do not send a completion notification.",
		promptSnippet: "Stop a watch by id.",
		parameters: STOP_PARAMS,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const entry = registry.stop(params.id);
			return {
				content: [
					{
						type: "text" as const,
						text: `Stopped ${entry.kind} watch [id ${entry.id}]${entry.label ? ` (${entry.label})` : ""}.${entry.kind === "run" ? " The command was killed." : ""}`,
					},
				],
				details: entry,
			};
		},
		renderCall: (args, theme) => renderWatchCall("stop", args, theme),
		renderResult: (result, _options, theme, context) =>
			renderWatchResult("stop", result.details, context.isError, theme),
	};

	pi.registerTool(runTool);
	pi.registerTool(pidTool);
	pi.registerTool(fileTool);
	pi.registerTool(listTool);
	pi.registerTool(stopTool);
}
