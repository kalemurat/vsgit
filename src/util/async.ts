/** Runs tasks one after another; a failing task does not block the ones queued after it. */
export class SerialQueue {
	private tail: Promise<unknown> = Promise.resolve();

	run<T>(task: () => Promise<T>): Promise<T> {
		const result = this.tail.then(task);
		this.tail = result.catch(() => undefined);
		return result;
	}
}

/** Coalesces bursts of calls into a single trailing invocation. */
export class Debouncer {
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly delayMs: number, private readonly callback: () => void) {}

	trigger(): void {
		this.cancel();
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.callback();
		}, this.delayMs);
	}

	cancel(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	dispose(): void {
		this.cancel();
	}
}
