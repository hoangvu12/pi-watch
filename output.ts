/**
 * Output capture for background commands.
 *
 * A fixed-size ring buffer keeps the tail of combined stdout/stderr so the
 * completion message can include what the command actually printed without
 * holding unbounded output in memory.
 */

export const DEFAULT_OUTPUT_LIMIT_BYTES = 16 * 1024;

export class OutputRing {
	private readonly buffer: Buffer;
	private length = 0;
	private wrapped = false;

	constructor(limitBytes: number = DEFAULT_OUTPUT_LIMIT_BYTES) {
		this.buffer = Buffer.alloc(Math.max(1024, limitBytes));
	}

	append(chunk: Buffer | string): void {
		const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		if (data.length === 0) return;
		if (data.length >= this.buffer.length) {
			// Chunk alone exceeds the buffer: keep only the last window.
			data.copy(this.buffer, 0, data.length - this.buffer.length);
			this.length = this.buffer.length;
			this.wrapped = true;
			return;
		}
		const room = this.buffer.length - this.length;
		if (data.length > room) {
			// Shift out the oldest bytes to make room.
			const drop = data.length - room;
			this.buffer.copy(this.buffer, 0, drop, this.length);
			this.length -= drop;
			this.wrapped = true;
		}
		data.copy(this.buffer, this.length);
		this.length += data.length;
	}

	text(): string {
		return this.buffer.subarray(0, this.length).toString("utf-8");
	}

	/** The tail as lines, capped, ready for a completion message. */
	tail(maxLines = 20, maxChars = 2_000): string {
		const text = this.text();
		const lines = text.replace(/\r\n/g, "\n").split("\n");
		// Drop a leading partial line when the buffer wrapped.
		const usable = this.wrapped && lines.length > 1 ? lines.slice(1) : lines;
		while (usable.length > 0 && usable[usable.length - 1] === "") usable.pop();
		const sliced = usable.slice(-maxLines);
		let out = sliced.join("\n");
		if (out.length > maxChars) out = `…${out.slice(-maxChars)}`;
		return out;
	}

	get byteLength(): number {
		return this.length;
	}

	get truncated(): boolean {
		return this.wrapped;
	}
}

/** Collapse whitespace for one-line previews in listings. */
export function oneLinePreview(text: string, maxLen = 80): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > maxLen ? `${collapsed.slice(0, maxLen)}...` : collapsed;
}
