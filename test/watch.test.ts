import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { WatchRegistry, type WatchEvent } from "../watch.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-watch-test-"));
}

/** Windows keeps a directory locked while a child's cwd points at it. */
async function rmDir(dir: string): Promise<void> {
	for (let attempt = 0; attempt < 10; attempt++) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return predicate();
}

function collect(registry: WatchRegistry): WatchEvent[] {
	const events: WatchEvent[] = [];
	registry.on("event", (event) => events.push(event));
	return events;
}

const NODE = process.execPath;

test("run watch notifies on exit with code and output tail", async () => {
	const registry = new WatchRegistry();
	const events = collect(registry);
	const entry = registry.startRun({
		command: `"${NODE}" -e "console.log('BUILD_MARKER_OK'); setTimeout(() => process.exit(0), 120)"`,
	});
	assert.equal(entry.status, "running");

	const fired = await waitFor(
		() => events.some((e) => e.entry.id === entry.id),
		10_000,
	);
	assert.ok(fired, "completion event delivered");
	const event = events.find((e) => e.entry.id === entry.id)!;
	assert.equal(event.entry.exitCode, 0);
	assert.match(event.message, /\[pi-watch\] Background command finished \(exit 0 after \d+s\)/);
	assert.match(event.message, /BUILD_MARKER_OK/);
	assert.equal(registry.get(entry.id)!.status, "done");
});

test("run watch reports non-zero exit codes", async () => {
	const registry = new WatchRegistry();
	const events = collect(registry);
	const entry = registry.startRun({
		command: `"${NODE}" -e "console.error('BOOM'); process.exit(3)"`,
	});
	await waitFor(() => events.some((e) => e.entry.id === entry.id), 10_000);
	const event = events.find((e) => e.entry.id === entry.id)!;
	assert.equal(event.entry.exitCode, 3);
	assert.match(event.message, /exit 3/);
	assert.match(event.message, /BOOM/);
});

test("notifyOn failure suppresses successful exits", async () => {
	const registry = new WatchRegistry();
	const events = collect(registry);
	const entry = registry.startRun({
		command: `"${NODE}" -e "process.exit(0)"`,
		notifyOn: "failure",
	});
	await waitFor(() => registry.get(entry.id)!.status === "done", 10_000);
	assert.equal(events.length, 0);
});

test("notifyOn success suppresses failed exits", async () => {
	const registry = new WatchRegistry();
	const events = collect(registry);
	const entry = registry.startRun({
		command: `"${NODE}" -e "process.exit(9)"`,
		notifyOn: "success",
	});
	await waitFor(() => registry.get(entry.id)!.status === "done", 10_000);
	assert.equal(events.length, 0);
});

test("run watch timeout kills the command and reports it", async () => {
	const registry = new WatchRegistry();
	const events = collect(registry);
	const entry = registry.startRun({
		command: `"${NODE}" -e "setTimeout(() => {}, 60000)"`,
		timeoutMs: 300,
	});
	const fired = await waitFor(
		() => events.some((e) => e.entry.id === entry.id),
		10_000,
	);
	assert.ok(fired, "timeout event delivered");
	const event = events.find((e) => e.entry.id === entry.id)!;
	assert.equal(event.entry.timedOut, true);
	assert.match(event.message, /timed out/);
	// The child actually dies.
	await waitFor(() => !isAlive(event.entry), 10_000);
});

function isAlive(entry: { pid?: number }): boolean {
	if (entry.pid === undefined) return false;
	try {
		process.kill(entry.pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("stop kills a running command without a completion event", async () => {
	const registry = new WatchRegistry();
	const events = collect(registry);
	const entry = registry.startRun({
		command: `"${NODE}" -e "setTimeout(() => {}, 60000)"`,
	});
	const pid = entry.pid!;
	assert.ok(isAlive({ pid }));
	registry.stop(entry.id);

	await waitFor(() => !isAlive({ pid }), 10_000);
	assert.equal(registry.get(entry.id)!.status, "done");
	assert.equal(registry.get(entry.id)!.stopped, true);
	// A late exit must not emit a completion event.
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(events.length, 0);
});

test("stop throws for unknown ids", () => {
	const registry = new WatchRegistry();
	assert.throws(() => registry.stop("nope"), /No watch with id 'nope'/);
});

test("capacity limit rejects new watches", () => {
	const registry = new WatchRegistry({ maxWatches: 1 });
	registry.startRun({ command: `"${NODE}" -e "setTimeout(() => {}, 60000)"` });
	assert.throws(
		() => registry.startRun({ command: `"${NODE}" -e "process.exit(0)"` }),
		/Too many active watches/,
	);
});

test("pid watch notifies when an external process exits", async () => {
	const registry = new WatchRegistry({ pidPollMs: 100 });
	const events = collect(registry);
	const child = spawn(NODE, ["-e", "setTimeout(() => {}, 250)"]);
	const pid = child.pid!;

	const entry = registry.startPid({ pid, label: "download" });
	const fired = await waitFor(
		() => events.some((e) => e.entry.id === entry.id),
		10_000,
	);
	assert.ok(fired, "pid exit event delivered");
	const event = events.find((e) => e.entry.id === entry.id)!;
	assert.match(event.message, new RegExp(`Watched process ${pid} exited \\(download\\)`));
});

test("pid watch rejects a dead pid", () => {
	const registry = new WatchRegistry();
	assert.throws(() => registry.startPid({ pid: -1 }), /not running/);
});

test("file watch notifies on change, debounced", async () => {
	const dir = tmpDir();
	const target = path.join(dir, "log.txt");
	fs.writeFileSync(target, "v0\n");
	const registry = new WatchRegistry({ debounceMs: 100 });
	const events = collect(registry);

	const entry = registry.startFile({ watchPath: target });
	// Burst of writes -> one debounced notification.
	fs.writeFileSync(target, "v1\n");
	fs.writeFileSync(target, "v2\n");
	fs.writeFileSync(target, "v3\n");
	const fired = await waitFor(
		() => events.some((e) => e.entry.id === entry.id),
		10_000,
	);
	assert.ok(fired, "file change event delivered");
	assert.equal(events.filter((e) => e.entry.id === entry.id).length, 1);
	assert.match(events.find((e) => e.entry.id === entry.id)!.message, /Watched path changed/);
	registry.stop(entry.id);
	await rmDir(dir);
});

test("file watch once stops after the first change", async () => {
	const dir = tmpDir();
	const target = path.join(dir, "out.bin");
	fs.writeFileSync(target, "a");
	const registry = new WatchRegistry({ debounceMs: 100 });
	const events = collect(registry);

	const entry = registry.startFile({ watchPath: target, once: true });
	fs.writeFileSync(target, "b");
	await waitFor(() => events.length > 0, 10_000);
	assert.equal(registry.get(entry.id)!.status, "done");

	await new Promise((resolve) => setTimeout(resolve, 300));
	fs.writeFileSync(target, "c");
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(events.length, 1);
	await rmDir(dir);
});

test("file watch ignores sibling files when watching a file", async () => {
	const dir = tmpDir();
	const target = path.join(dir, "watched.txt");
	const other = path.join(dir, "ignored.txt");
	fs.writeFileSync(target, "v0");
	fs.writeFileSync(other, "v0");
	const registry = new WatchRegistry({ debounceMs: 100 });
	const events = collect(registry);

	const entry = registry.startFile({ watchPath: target });
	fs.writeFileSync(other, "v1");
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.equal(events.length, 0);

	fs.writeFileSync(target, "v1");
	await waitFor(() => events.length > 0, 10_000);
	assert.equal(events.length, 1);
	registry.stop(entry.id);
	await rmDir(dir);
});

test("file watch on a directory reports recursive changes", async () => {
	const dir = tmpDir();
	const nested = path.join(dir, "sub");
	fs.mkdirSync(nested);
	const registry = new WatchRegistry({ debounceMs: 100 });
	const events = collect(registry);

	const entry = registry.startFile({ watchPath: dir });
	fs.writeFileSync(path.join(nested, "new-file.txt"), "hello");
	const fired = await waitFor(() => events.length > 0, 10_000);
	assert.ok(fired, "recursive change seen");
	assert.match(events[0]!.message, /Watched path changed/);
	registry.stop(entry.id);
	await rmDir(dir);
});

test("file watch rejects missing paths", () => {
	const registry = new WatchRegistry();
	assert.throws(
		() => registry.startFile({ watchPath: path.join(tmpDir(), "nope.txt") }),
		/Cannot watch/,
	);
});

test("list shows running and done watches", async () => {
	const registry = new WatchRegistry();
	const run = registry.startRun({ command: `"${NODE}" -e "process.exit(0)"` });
	const file = path.join(tmpDir(), "f.txt");
	fs.writeFileSync(file, "x");
	const watch = registry.startFile({ watchPath: file });
	await waitFor(() => registry.get(run.id)!.status === "done", 10_000);
	const list = registry.list();
	assert.equal(list.length, 2);
	assert.ok(list.some((e) => e.id === run.id && e.status === "done"));
	assert.ok(list.some((e) => e.id === watch.id && e.status === "running"));
	registry.stop(watch.id);
	fs.rmSync(file, { force: true });
});

test("stopAll stops everything without events", async () => {
	const registry = new WatchRegistry();
	const events = collect(registry);
	const run = registry.startRun({ command: `"${NODE}" -e "setTimeout(() => {}, 60000)"` });
	const dir = tmpDir();
	const target = path.join(dir, "t.txt");
	fs.writeFileSync(target, "x");
	const file = registry.startFile({ watchPath: target });

	const stopped = registry.stopAll();
	assert.equal(stopped.length, 2);
	assert.equal(registry.get(run.id)!.status, "done");
	assert.equal(registry.get(file.id)!.status, "done");
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(events.length, 0);
	await rmDir(dir);
});

test("tail exposes captured output for finished runs", async () => {
	const registry = new WatchRegistry();
	const entry = registry.startRun({
		command: `"${NODE}" -e "console.log('TAIL_MARKER')"`,
	});
	await waitFor(() => registry.get(entry.id)!.status === "done", 10_000);
	assert.match(registry.tail(entry.id), /TAIL_MARKER/);
});
