import type * as vscode from 'vscode';

const STORAGE_KEY = 'vsgit.favoriteRefs';

/** Like WebStorm, the main branch is a favorite until the user unmarks it. */
const DEFAULT_FAVORITES = ['refs/heads/main', 'refs/heads/master'];

/** Favorite refs per repository, persisted in workspace state and keyed by repository root. */
export class FavoritesStore {
	constructor(private readonly memento: vscode.Memento) {}

	get(root: string): ReadonlySet<string> {
		return new Set(this.read()[root] ?? DEFAULT_FAVORITES);
	}

	async toggle(root: string, fullRefName: string): Promise<boolean> {
		const all = this.read();
		const favorites = new Set(all[root] ?? DEFAULT_FAVORITES);
		const nowFavorite = !favorites.delete(fullRefName);
		if (nowFavorite) {
			favorites.add(fullRefName);
		}
		await this.memento.update(STORAGE_KEY, { ...all, [root]: [...favorites] });
		return nowFavorite;
	}

	private read(): Readonly<Record<string, readonly string[]>> {
		return this.memento.get<Record<string, string[]>>(STORAGE_KEY, {});
	}
}
