/**
 * Integration test: drives the real extension factory with a fake
 * ExtensionAPI and verifies end-to-end delivery — a background command
 * finishes and its notification arrives as a queued follow-up user message.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

interface RegisteredTool {
	name: string;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: undefined,
		onUpdate: undefined,
		ctx: { cwd: string; mode: string },
	) => Promise<{ content: { type: string; text: string }[]; details: unknown }>;
}

function createFakePi(): {
	pi: object;
	tools: RegisteredTool[];
	sent: { content: string; options?: { deliverAs?: string } }[];
	shutdownSession: () => Promise<void>;
} {
	const handlers = new Map<string, Array<(event: unknown, ctx: object) => Promise<void> | void>>();
	const tools: RegisteredTool[] = [];
	const sent: { content: string; options?: { deliverAs?: string } }[] = [];
	return {
		pi: {
			registerTool: (tool: RegisteredTool) => tools.push(tool),
			on: (event: string, handler: (event: unknown, ctx: object) => Promise<void> | void) => {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			sendUserMessage: (content: string, options?: { deliverAs?: string }) =>
				sent.push({ content, options }),
		},
		tools,
		sent,
		shutdownSession: async () => {
			for (const handler of handlers.get("session_shutdown") ?? []) {
				await handler({}, {});
			}
		},
	};
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return predicate();
}

const NODE = process.execPath;

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

test("background command completion is delivered as a follow-up message", async () => {
	const harness = createFakePi();
	extension(harness.pi as unknown as ExtensionAPI);

	assert.deepEqual(
		harness.tools.map((t) => t.name).sort(),
		["WatchFile", "WatchList", "WatchPid", "WatchRun", "WatchStop"],
	);

	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-watch-int-"));
	const runTool = harness.tools.find((t) => t.name === "WatchRun")!;
	const result = await runTool.execute(
		"call-1",
		{
			command: `"${NODE}" -e "console.log('INTEGRATION_MARKER'); setTimeout(() => process.exit(0), 150)"`,
			label: "smoke build",
		},
		undefined,
		undefined,
		{ cwd, mode: "tui" },
	);
	assert.match(result.content[0]!.text, /Watching background command \[id w[0-9a-f]+\]/);
	const id = (result.details as { id: string }).id;

	const delivered = await waitFor(
		() => harness.sent.some((m) => m.content.includes(`[id ${id}]`)),
		10_000,
	);
	assert.ok(delivered, "completion message delivered");
	const message = harness.sent.find((m) => m.content.includes(`[id ${id}]`))!;
	assert.match(message.content, /\[pi-watch\] Background command finished \(exit 0 after \d+s\) \(smoke build\)/);
	assert.match(message.content, /INTEGRATION_MARKER/);
	assert.equal(message.options?.deliverAs, "followUp");

	// WatchList reflects the finished run.
	const listTool = harness.tools.find((t) => t.name === "WatchList")!;
	const listResult = await listTool.execute("call-2", {}, undefined, undefined, { cwd, mode: "tui" });
	assert.match(listResult.content[0]!.text, /1 watch/);
	assert.match(listResult.content[0]!.text, new RegExp(`${id}  run  exit 0`));

	await rmDir(cwd);
});

test("WatchStop kills the child and suppresses the completion message", async () => {
	const harness = createFakePi();
	extension(harness.pi as unknown as ExtensionAPI);
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-watch-int-"));

	const runTool = harness.tools.find((t) => t.name === "WatchRun")!;
	const result = await runTool.execute(
		"call-1",
		{ command: `"${NODE}" -e "setTimeout(() => {}, 60000)"` },
		undefined,
		undefined,
		{ cwd, mode: "tui" },
	);
	const id = (result.details as { id: number; pid?: number }).id;
	const pid = (result.details as { pid?: number }).pid;
	assert.ok(pid, "child pid recorded");

	const stopTool = harness.tools.find((t) => t.name === "WatchStop")!;
	const stopResult = await stopTool.execute("call-2", { id }, undefined, undefined, { cwd, mode: "tui" });
	assert.match(stopResult.content[0]!.text, /The command was killed/);

	const gone = await waitFor(
		() => {
			try {
				process.kill(pid!, 0);
				return false;
			} catch {
				return true;
			}
		},
		10_000,
	);
	assert.ok(gone, "child process killed");
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(harness.sent.length, 0);
	await rmDir(cwd);
});

test("WatchPid notifies when an external process exits", async () => {
	const harness = createFakePi();
	extension(harness.pi as unknown as ExtensionAPI);
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-watch-int-"));

	const child = spawn(NODE, ["-e", "setTimeout(() => {}, 400)"]);
	const pidTool = harness.tools.find((t) => t.name === "WatchPid")!;
	const result = await pidTool.execute(
		"call-1",
		{ pid: child.pid, label: "external download" },
		undefined,
		undefined,
		{ cwd, mode: "tui" },
	);
	const id = (result.details as { id: string }).id;

	const delivered = await waitFor(
		() => harness.sent.some((m) => m.content.includes(`[id ${id}]`)),
		10_000,
	);
	assert.ok(delivered, "pid exit message delivered");
	assert.match(
		harness.sent.find((m) => m.content.includes(`[id ${id}]`))!.content,
		new RegExp(`Watched process ${child.pid} exited \\(external download\\)`),
	);
	await rmDir(cwd);
});

test("session shutdown stops all watches and kills children", async () => {
	const harness = createFakePi();
	extension(harness.pi as unknown as ExtensionAPI);
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-watch-int-"));

	const runTool = harness.tools.find((t) => t.name === "WatchRun")!;
	const result = await runTool.execute(
		"call-1",
		{ command: `"${NODE}" -e "setTimeout(() => {}, 60000)"` },
		undefined,
		undefined,
		{ cwd, mode: "tui" },
	);
	const pid = (result.details as { pid?: number }).pid;
	assert.ok(pid);

	await harness.shutdownSession();
	const gone = await waitFor(
		() => {
			try {
				process.kill(pid!, 0);
				return false;
			} catch {
				return true;
			}
		},
		10_000,
	);
	assert.ok(gone, "child killed on shutdown");
	assert.equal(harness.sent.length, 0);
	await rmDir(cwd);
});

test("print mode warns that watches cannot outlive the session", async () => {
	const harness = createFakePi();
	extension(harness.pi as unknown as ExtensionAPI);
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-watch-int-"));

	const runTool = harness.tools.find((t) => t.name === "WatchRun")!;
	const result = await runTool.execute(
		"call-1",
		{ command: `"${NODE}" -e "process.exit(0)"` },
		undefined,
		undefined,
		{ cwd, mode: "print" },
	);
	assert.match(result.content[0]!.text, /headless/);
	await harness.shutdownSession();
	await rmDir(cwd);
});

test("kill switch disables registration entirely", () => {
	process.env["PI_WATCH_DISABLE"] = "1";
	try {
		const harness = createFakePi();
		extension(harness.pi as unknown as ExtensionAPI);
		assert.equal(harness.tools.length, 0);
	} finally {
		delete process.env["PI_WATCH_DISABLE"];
	}
});
