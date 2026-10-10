/**
 * Environment-driven configuration.
 *
 *   PI_WATCH_DISABLE      Kill switch: register nothing at all.
 *   PI_WATCH_MAX          Max concurrent watches (default 20).
 *   PI_WATCH_OUTPUT_BYTES Ring buffer size per command (default 16384).
 *   PI_WATCH_PID_POLL_MS  Liveness poll interval for pid watches (default 500).
 *   PI_WATCH_DEBOUNCE_MS  Default file-change debounce (default 500).
 */

export const DEFAULT_MAX_WATCHES = 20;
export const DEFAULT_OUTPUT_BYTES = 16 * 1024;
export const DEFAULT_PID_POLL_MS = 500;
export const DEFAULT_DEBOUNCE_MS = 500;
const MIN_PID_POLL_MS = 100;
const MIN_DEBOUNCE_MS = 50;

export function isEnvTruthy(value: string | undefined): boolean {
	if (typeof value !== "string") return false;
	const normalized = value.trim().toLowerCase();
	return (
		normalized !== "" &&
		normalized !== "0" &&
		normalized !== "false" &&
		normalized !== "no" &&
		normalized !== "off"
	);
}

export function isDisabled(): boolean {
	return isEnvTruthy(process.env["PI_WATCH_DISABLE"]);
}

function resolveInt(env: string, fallback: number, min: number): number {
	const raw = Number(process.env[env]);
	return Number.isFinite(raw) && raw >= min ? Math.floor(raw) : fallback;
}

export function resolveMaxWatches(): number {
	return resolveInt("PI_WATCH_MAX", DEFAULT_MAX_WATCHES, 1);
}

export function resolveOutputBytes(): number {
	return resolveInt("PI_WATCH_OUTPUT_BYTES", DEFAULT_OUTPUT_BYTES, 1024);
}

export function resolvePidPollMs(): number {
	return resolveInt("PI_WATCH_PID_POLL_MS", DEFAULT_PID_POLL_MS, MIN_PID_POLL_MS);
}

export function resolveDebounceMs(): number {
	return resolveInt("PI_WATCH_DEBOUNCE_MS", DEFAULT_DEBOUNCE_MS, MIN_DEBOUNCE_MS);
}
