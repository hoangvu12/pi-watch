/**
 * The watch registry and the three monitor kinds.
 *
 * - run:  spawn a command in the background; notify when it exits, with the
 *   exit code and the tail of its output. The sensing is a child process
 *   event — zero tokens until something actually finishes.
 * - pid:  poll an external process for liveness; notify when it is gone.
 *   Covers "tell me when the thing I started outside Pi is done".
 * - file: watch a path (file or directory, recursive for directories) and
 *   notify on changes, debounced.
 *
 * All watches are session-scoped: children are killed and watchers closed on
 * session shutdown, the same lifecycle as pi-subagent's children. Completion
 * is delivered by the caller via the session message queue, so a fire never
 * interrupts a running turn.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { OutputRing } from "./output.ts";

export type WatchKind = "run" | "pid" | "file";
export type NotifyOn = "always" | "success" | "failure";
export type WatchStatus = "running" | "done";

export interface WatchEntry {
	id: string;
	kind: WatchKind;
	/** Human label the model or user chose, echoed in messages. */
	label?: string;
	startedAt: number;
	status: WatchStatus;
	/** run */
	command?: string;
	notifyOn?: NotifyOn;
	exitCode?: number | null;
	signal?: string | null;
	timedOut?: boolean;
	stopped?: boolean;
	/** pid */
	pid?: number;
	/** file */
	watchPath?: string;
	once?: boolean;
	/** Free-text last event, for listings. */
	lastEvent?: string;
}

export interface WatchEvent {
	entry: WatchEntry;
	message: string;
}

export function newWatchId(): string {
	return `w${randomBytes(4).toString("hex")}`;
}

export function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Kill a process tree — taskkill /T on Windows, TERM then KILL elsewhere. */
export function killTree(child: ChildProcess, graceMs = 3_000): void {
	const pid = child.pid;
	if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
			return;
		} catch {
			// Fall through to plain kill.
		}
	}
	try {
		child.kill("SIGTERM");
	} catch {
		// Already dead.
		return;
	}
	const killTimer = setTimeout(() => {
		try {
			child.kill("SIGKILL");
		} catch {
			// Already dead.
		}
	}, graceMs);
	killTimer.unref?.();
}

interface ActiveHandle {
	stop: () => void;
}

export interface RunWatchOptions {
	command: string;
	cwd?: string;
	timeoutMs?: number;
	notifyOn?: NotifyOn;
	label?: string;
	outputBytes?: number;
	/** Test seam: replaced clock. */
	now?: () => number;
}

export interface PidWatchOptions {
	pid: number;
	label?: string;
	pollMs?: number;
}

export interface FileWatchOptions {
	watchPath: string;
	once?: boolean;
	debounceMs?: number;
	label?: string;
}

export interface RegistryOptions {
	maxWatches?: number;
	outputBytes?: number;
	pidPollMs?: number;
	debounceMs?: number;
	now?: () => number;
}

/**
 * Owns all watches for one session. Emits "event" for every notification
 * that should be delivered to the session; the caller decides the rail.
 */
export class WatchRegistry extends EventEmitter {
	private readonly entries = new Map<string, WatchEntry>();
	private readonly handles = new Map<string, ActiveHandle>();
	private readonly maxWatches: number;
	private readonly outputBytes: number;
	private readonly pidPollMs: number;
	private readonly debounceMs: number;
	private readonly now: () => number;
	/** Output tails per run watch, keyed by id. */
	private readonly tails = new Map<string, OutputRing>();

	constructor(options: RegistryOptions = {}) {
		super();
		this.maxWatches = options.maxWatches ?? 20;
		this.outputBytes = options.outputBytes ?? 16 * 1024;
		this.pidPollMs = options.pidPollMs ?? 500;
		this.debounceMs = options.debounceMs ?? 500;
		this.now = options.now ?? Date.now;
	}

	get size(): number {
		return this.entries.size;
	}

	list(): WatchEntry[] {
		return [...this.entries.values()]
			.map((e) => ({ ...e }))
			.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
	}

	get(id: string): WatchEntry | undefined {
		const entry = this.entries.get(id);
		return entry ? { ...entry } : undefined;
	}

	/** Output tail for a run watch (empty string otherwise). */
	tail(id: string, maxLines = 20): string {
		return this.tails.get(id)?.tail(maxLines) ?? "";
	}

	private ensureCapacity(): void {
		const running = [...this.entries.values()].filter((e) => e.status === "running");
		if (running.length >= this.maxWatches) {
			throw new Error(
				`Too many active watches (max ${this.maxWatches}). Stop one first with WatchStop.`,
			);
		}
	}

	private emitEvent(entry: WatchEntry, message: string): void {
		this.emit("event", { entry: { ...entry }, message } satisfies WatchEvent);
	}

	private finalize(entry: WatchEntry, patch: Partial<WatchEntry>): void {
		Object.assign(entry, patch, { status: "done" });
		this.handles.delete(entry.id);
	}

	// -- run ---------------------------------------------------------------

	startRun(options: RunWatchOptions): WatchEntry {
		this.ensureCapacity();
		const entry: WatchEntry = {
			id: newWatchId(),
			kind: "run",
			label: options.label,
			startedAt: this.now(),
			status: "running",
			command: options.command,
			notifyOn: options.notifyOn ?? "always",
		};
		this.entries.set(entry.id, entry);

		const ring = new OutputRing(this.outputBytes);
		this.tails.set(entry.id, ring);

		let child: ChildProcess;
		try {
			child = spawn(options.command, {
				shell: true,
				cwd: options.cwd,
				windowsHide: true,
			});
		} catch (error) {
			this.finalize(entry, { exitCode: null, lastEvent: `spawn failed: ${String(error)}` });
			throw error instanceof Error ? error : new Error(String(error));
		}

		entry.pid = child.pid;
		child.stdout?.on("data", (chunk: Buffer) => ring.append(chunk));
		child.stderr?.on("data", (chunk: Buffer) => ring.append(chunk));

		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		if (options.timeoutMs && options.timeoutMs > 0) {
			timeoutTimer = setTimeout(() => {
				if (entry.status !== "running") return;
				entry.timedOut = true;
				killTree(child);
			}, options.timeoutMs);
			timeoutTimer.unref?.();
		}

		child.on("error", (error) => {
			if (entry.status !== "running") return;
			clearTimeout(timeoutTimer);
			const message = `[pi-watch] Background command failed to run: ${options.command} [id ${entry.id}] — ${error.message}`;
			this.finalize(entry, { exitCode: null, lastEvent: `error: ${error.message}` });
			this.emitEvent(entry, message);
		});

		child.on("exit", (code, signal) => {
			// stopped: the stop is the answer — never a completion event.
			if (entry.status !== "running" || entry.stopped) return;
			clearTimeout(timeoutTimer);
			const timedOut = entry.timedOut === true;
			const exitCode = code;
			const lastEvent = timedOut
				? `timed out after ${Math.round((this.now() - entry.startedAt) / 1000)}s`
				: `exit ${exitCode ?? "signal " + signal}`;
			this.finalize(entry, { exitCode, signal, lastEvent });

			const notifyOn = entry.notifyOn ?? "always";
			const succeeded = exitCode === 0;
			if (notifyOn === "success" && !succeeded) return;
			if (notifyOn === "failure" && succeeded) return;

			const durationMs = this.now() - entry.startedAt;
			const lines: string[] = [];
			lines.push(
				`[pi-watch] Background command ${timedOut ? "timed out" : "finished"} (${timedOut ? "stopped after " + Math.round(durationMs / 1000) + "s" : "exit " + (exitCode ?? `signal ${signal}`) + " after " + formatDuration(durationMs)})${entry.label ? ` (${entry.label})` : ""} [id ${entry.id}]`,
			);
			lines.push(`Command: ${options.command}`);
			const outputTail = ring.tail();
			if (outputTail) {
				lines.push("", "--- last output ---", outputTail);
			}
			this.emitEvent(entry, lines.join("\n"));
		});

		this.handles.set(entry.id, {
			stop: () => {
				clearTimeout(timeoutTimer);
				entry.stopped = true;
				killTree(child);
			},
		});
		return { ...entry };
	}

	// -- pid ---------------------------------------------------------------

	startPid(options: PidWatchOptions): WatchEntry {
		this.ensureCapacity();
		if (!isPidAlive(options.pid)) {
			throw new Error(`Process ${options.pid} is not running.`);
		}
		const entry: WatchEntry = {
			id: newWatchId(),
			kind: "pid",
			label: options.label,
			startedAt: this.now(),
			status: "running",
			pid: options.pid,
		};
		this.entries.set(entry.id, entry);

		const pollMs = options.pollMs ?? this.pidPollMs;
		const timer = setInterval(() => {
			if (entry.status !== "running") return;
			if (!isPidAlive(options.pid)) {
				clearInterval(timer);
				const durationMs = this.now() - entry.startedAt;
				this.finalize(entry, { lastEvent: "exited" });
				this.emitEvent(
					entry,
					`[pi-watch] Watched process ${options.pid} exited${entry.label ? ` (${entry.label})` : ""} after ${formatDuration(durationMs)} [id ${entry.id}]`,
				);
			}
		}, pollMs);
		timer.unref?.();

		this.handles.set(entry.id, { stop: () => clearInterval(timer) });
		return { ...entry };
	}

	// -- file --------------------------------------------------------------

	startFile(options: FileWatchOptions): WatchEntry {
		this.ensureCapacity();
		const resolved = path.resolve(options.watchPath);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(resolved);
		} catch (error) {
			throw new Error(
				`Cannot watch '${options.watchPath}': ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		const entry: WatchEntry = {
			id: newWatchId(),
			kind: "file",
			label: options.label,
			startedAt: this.now(),
			status: "running",
			watchPath: resolved,
			once: options.once ?? false,
		};
		this.entries.set(entry.id, entry);

		const isDir = stat.isDirectory();
		// Watching the parent directory (and filtering by basename) survives
		// delete/recreate cycles that a direct file watch misses.
		const watchDir = isDir ? resolved : path.dirname(resolved);
		const base = isDir ? undefined : path.basename(resolved);

		const debounceMs = options.debounceMs ?? this.debounceMs;
		let debounceTimer: ReturnType<typeof setTimeout> | undefined;
		let pendingEvents = new Set<string>();
		let stopped = false;

		let watcher: fs.FSWatcher;
		try {
			watcher = fs.watch(watchDir, { recursive: isDir }, (event, filename) => {
				if (stopped || entry.status !== "running") return;
				const changed = filename ? path.join(watchDir, filename.toString()) : watchDir;
				if (base !== undefined && path.basename(changed) !== base) return;
				pendingEvents.add(event);
				if (debounceTimer === undefined) {
					debounceTimer = setTimeout(() => {
						debounceTimer = undefined;
						const events = [...pendingEvents];
						pendingEvents = new Set();
						if (stopped || entry.status !== "running") return;
						entry.lastEvent = `changed (${events.join(", ")})`;
						const relative = displayPath(resolved);
						this.emitEvent(
							entry,
							`[pi-watch] Watched path changed (${events.join(", ")})${entry.label ? ` (${entry.label})` : ""}: ${relative} [id ${entry.id}]`,
						);
						if (entry.once) {
							this.stop(entry.id);
						}
					}, debounceMs);
					debounceTimer.unref?.();
				}
			});
		} catch (error) {
			this.finalize(entry, { lastEvent: `watch failed: ${String(error)}` });
			throw error instanceof Error ? error : new Error(String(error));
		}

		watcher.on("error", (error) => {
			if (entry.status !== "running") return;
			clearTimeout(debounceTimer);
			const relative = displayPath(resolved);
			this.finalize(entry, { lastEvent: `watch error: ${error.message}` });
			this.emitEvent(
				entry,
				`[pi-watch] Watch failed on ${relative} [id ${entry.id}] — ${error.message}`,
			);
		});

		this.handles.set(entry.id, {
			stop: () => {
				stopped = true;
				clearTimeout(debounceTimer);
				watcher.close();
			},
		});
		return { ...entry };
	}

	// -- control -----------------------------------------------------------

	/**
	 * Stop a watch. Run children are killed. Stopped runs never emit any
	 * event — the WatchStop tool result is the confirmation. Returns the
	 * final entry.
	 */
	stop(id: string): WatchEntry {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`No watch with id '${id}'.`);
		const handle = this.handles.get(id);
		handle?.stop();
		this.finalize(
			entry,
			entry.kind === "run"
				? { stopped: true, lastEvent: "stopped" }
				: { lastEvent: entry.lastEvent ?? "stopped" },
		);
		return { ...entry };
	}

	/** Stop everything (session shutdown). Children die with the session. */
	stopAll(): WatchEntry[] {
		const stopped: WatchEntry[] = [];
		for (const entry of [...this.entries.values()]) {
			if (entry.status !== "running") continue;
			try {
				stopped.push(this.stop(entry.id));
			} catch {
				// Best-effort.
			}
		}
		return stopped;
	}
}

export function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 60) return `${minutes}m ${rest}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

function displayPath(p: string): string {
	const cwd = process.cwd();
	const resolved = path.resolve(p);
	if (resolved === cwd) return ".";
	if (resolved.startsWith(`${cwd}${path.sep}`)) return `.${path.sep}${resolved.slice(cwd.length + 1)}`;
	return resolved;
}
