import * as vscode from 'vscode';

/**
 * Owns a set of disposables and releases them together. Items added after
 * disposal are disposed immediately, so late async registrations cannot leak.
 */
export class DisposableStore implements vscode.Disposable {
	private readonly items = new Set<vscode.Disposable>();
	private disposed = false;

	add<T extends vscode.Disposable>(item: T): T {
		if (this.disposed) {
			item.dispose();
		} else {
			this.items.add(item);
		}
		return item;
	}

	clear(): void {
		const items = [...this.items];
		this.items.clear();
		for (const item of items) {
			item.dispose();
		}
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.clear();
	}
}
