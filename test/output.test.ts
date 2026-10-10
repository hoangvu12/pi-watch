import test from "node:test";
import assert from "node:assert/strict";
import { OutputRing, oneLinePreview } from "../output.ts";
import { formatDuration, isPidAlive, killTree, newWatchId } from "../watch.ts";

test("OutputRing keeps the tail of short writes", () => {
	const ring = new OutputRing(1024);
	ring.append("line 1\n");
	ring.append("line 2\n");
	ring.append("line 3\n");
	assert.equal(ring.text(), "line 1\nline 2\nline 3\n");
	assert.equal(ring.tail(), "line 1\nline 2\nline 3");
	assert.equal(ring.truncated, false);
});

test("OutputRing wraps and marks truncation", () => {
	const ring = new OutputRing(1024);
	const chunk = `${"x".repeat(64)}\n`;
	for (let i = 0; i < 100; i++) {
		ring.append(`batch ${i} ${chunk}`);
	}
	assert.equal(ring.truncated, true);
	// The earliest batches are gone; the latest survive intact.
	const text = ring.text();
	assert.ok(!text.includes("batch 0 "));
	assert.ok(text.includes("batch 99 "));
	// The wrapped leading line is partial and dropped by tail().
	assert.ok(ring.tail().startsWith("batch "));
});

test("OutputRing handles a single chunk larger than the buffer", () => {
	const ring = new OutputRing(1024);
	ring.append(`${"a".repeat(2000)}END`);
	assert.equal(ring.truncated, true);
	assert.ok(ring.text().endsWith("END"));
	assert.equal(ring.text().length, 1024);
});

test("OutputRing tail caps lines and characters", () => {
	const ring = new OutputRing(8192);
	ring.append(Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"));
	assert.equal(ring.tail(5).split("\n").length, 5);
	assert.match(ring.tail(5, 20), /^…/);
});

test("OutputRing ignores empty appends and decodes utf-8", () => {
	const ring = new OutputRing(1024);
	ring.append("");
	ring.append(Buffer.from("héllo wörld", "utf-8"));
	assert.equal(ring.text(), "héllo wörld");
});

test("oneLinePreview collapses and truncates", () => {
	assert.equal(oneLinePreview("a\n  b\t\tc"), "a b c");
	assert.equal(oneLinePreview("x".repeat(100), 10), `${"x".repeat(10)}...`);
});

test("newWatchId is prefixed and unique", () => {
	const a = newWatchId();
	const b = newWatchId();
	assert.match(a, /^w[0-9a-f]{8}$/);
	assert.notEqual(a, b);
});

test("formatDuration phrasing", () => {
	assert.equal(formatDuration(4_000), "4s");
	assert.equal(formatDuration(59_400), "59s");
	assert.equal(formatDuration(60_000), "1m 0s");
	assert.equal(formatDuration(125_000), "2m 5s");
	assert.equal(formatDuration(3_725_000), "1h 2m");
});

test("isPidAlive recognizes this process and dead pids", () => {
	assert.equal(isPidAlive(process.pid), true);
	assert.equal(isPidAlive(-1), false);
	assert.equal(isPidAlive(0), false);
	assert.equal(isPidAlive(1.5), false);
	// 0x7fffffff is beyond any realistic pid table on Windows.
	assert.equal(isPidAlive(0x7fffffff), false);
});

test("killTree tolerates an already-exited child", async () => {
	const { spawn } = await import("node:child_process");
	const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
	await new Promise((resolve) => child.on("exit", resolve));
	assert.doesNotThrow(() => killTree(child));
});
