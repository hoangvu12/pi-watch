/**
 * Pi Watch Extension
 *
 * Monitors that notify the agent when something is done:
 * - WatchRun — background command -> message on exit (exit code + output tail)
 * - WatchPid — external process -> message when it exits
 * - WatchFile — file/directory -> message on change (debounced)
 *
 * The sensing is deterministic code — child-process events, pid polls,
 * fs.watch — so it costs zero tokens until something actually happens.
 * Notifications ride the session's message queue as follow-up messages and
 * therefore never interrupt a running turn. Watches are session-scoped:
 * children are killed and watchers closed on shutdown.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	isDisabled,
	resolveDebounceMs,
	resolveMaxWatches,
	resolveOutputBytes,
	resolvePidPollMs,
} from "./config.ts";
import { registerWatchTools } from "./tools.ts";
import { WatchRegistry, type WatchEvent } from "./watch.ts";

export default function (pi: ExtensionAPI) {
	if (isDisabled()) return;

	const registry = new WatchRegistry({
		maxWatches: resolveMaxWatches(),
		outputBytes: resolveOutputBytes(),
		pidPollMs: resolvePidPollMs(),
		debounceMs: resolveDebounceMs(),
	});

	/** Deliver a watch notification as a queued follow-up user message. */
	const deliver = (message: string): void => {
		if (typeof pi.sendUserMessage !== "function") return;
		try {
			pi.sendUserMessage(message, { deliverAs: "followUp" });
		} catch (error) {
			console.warn(`[pi-watch] Could not deliver a watch notification: ${String(error)}`);
		}
	};

	registry.on("event", (event: WatchEvent) => {
		deliver(event.message);
	});

	registerWatchTools(pi, registry);

	// Fires for every teardown reason (quit, reload, new, resume, fork) and is
	// idempotent: stop every watch, kill background children.
	pi.on("session_shutdown", async () => {
		const stopped = registry.stopAll();
		if (stopped.length > 0) {
			console.warn(
				`[pi-watch] Stopped ${stopped.length} watch(es) on session shutdown.`,
			);
		}
	});
}
