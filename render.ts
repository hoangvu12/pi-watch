/**
 * TUI rendering for the Watch tool calls and results.
 */

import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { WatchEntry } from "./watch.ts";

type Fg = Theme["fg"];

function truncate(text: string, maxLen: number): string {
	return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function oneLine(text: unknown): string {
	return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

export function renderWatchCall(
	kind: "run" | "pid" | "file" | "stop",
	args: Record<string, unknown>,
	theme: Theme,
): Text {
	const fg = theme.fg.bind(theme);
	switch (kind) {
		case "run": {
			const command = truncate(oneLine(args.command), 56);
			const notifyOn = args.notifyOn ? String(args.notifyOn) : "always";
			return new Text(
				fg("muted", "⏳ watch run ") +
					fg("accent", command) +
					fg("dim", ` · notify: ${notifyOn}`),
			);
		}
		case "pid":
			return new Text(fg("muted", "⏳ watch pid ") + fg("accent", String(args.pid ?? "...")));
		case "file": {
			const p = truncate(oneLine(args.path), 56);
			return new Text(
				fg("muted", "⏳ watch file ") +
					fg("accent", p) +
					(args.once === true ? fg("dim", " · once") : ""),
			);
		}
		default:
			return new Text(fg("muted", "⏳ stop watch ") + fg("accent", String(args.id ?? "...")));
	}
}

export function renderWatchResult(
	kind: "run" | "pid" | "file" | "list" | "stop",
	details: unknown,
	isError: boolean,
	theme: Theme,
): Text {
	const fg = theme.fg.bind(theme);
	if (isError) return new Text(fg("error", "✗ watch error"));

	const entry = details as WatchEntry | undefined;
	if (kind !== "list") {
		if (!entry) return new Text(fg("success", "✓ watch"));
		const summary =
			kind === "run"
				? `watching [${entry.id}]`
				: kind === "stop"
					? `stopped [${entry.id}]`
					: `watching [${entry.id}]`;
		return new Text(fg("success", "✓ ") + fg("accent", summary) + fg("dim", ` · ${entry.kind}`));
	}

	const d = details as { watches?: WatchEntry[] } | undefined;
	const count = d?.watches?.length ?? 0;
	if (count === 0) return new Text(fg("muted", "no watches"));
	const lines = d!.watches!.slice(0, 10).map((w) => {
		const status = w.status === "running" ? "running" : (w.lastEvent ?? "done");
		return (
			fg("accent", w.id) +
			fg("dim", ` ${w.kind}`) +
			fg("muted", ` · ${status}`)
		);
	});
	const more = count > 10 ? [fg("muted", `... ${count - 10} more`)] : [];
	return new Text(
		[fg("success", "⏳ ") + fg("muted", `${count} watch(es)`), ...lines, ...more].join("\n"),
	);
}
