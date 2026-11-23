import * as vscode from 'vscode';
import type { API, Repository } from '../typings/git';
import { DisposableStore } from '../util/disposable';
import { GitCli } from './cli';
import { GitRepository } from './gitRepository';

/**
 * Mirrors the repositories the built-in Git extension has open and tracks which one is "active"
 * (the repository of the active editor, else the one selected in the Source Control view).
 *
 * The Git API hands out a new `Repository` wrapper on every access (`repositories`,
 * `getRepository`, open/close events), so repositories are keyed by their root URI, never by object.
 */
export class RepositoryRegistry implements vscode.Disposable {
	private readonly cli: GitCli;
	private readonly repositories = new Map<string, GitRepository>();
	private readonly perRepository = new Map<string, vscode.Disposable>();
	private readonly disposables = new DisposableStore();
	private readonly onDidChangeActiveEmitter = this.disposables.add(new vscode.EventEmitter<GitRepository | undefined>());
	private readonly onDidChangeRepositoriesEmitter = this.disposables.add(new vscode.EventEmitter<void>());
	private activeRepository: GitRepository | undefined;

	/** Fires when the active repository changes (not when its contents change). */
	readonly onDidChangeActive = this.onDidChangeActiveEmitter.event;
	readonly onDidChangeRepositories = this.onDidChangeRepositoriesEmitter.event;

	constructor(private readonly api: API) {
		this.cli = new GitCli(api.git.path);
		this.disposables.add(api.onDidOpenRepository(repository => this.add(repository)));
		this.disposables.add(api.onDidCloseRepository(repository => this.remove(repository)));
		this.disposables.add(vscode.window.onDidChangeActiveTextEditor(() => this.updateActive()));
		for (const repository of api.repositories) {
			this.add(repository);
		}
	}

	get all(): readonly GitRepository[] {
		return [...this.repositories.values()];
	}

	get active(): GitRepository | undefined {
		return this.activeRepository;
	}

	/** Resolves a command argument (a SourceControl, a Uri, or nothing) to a repository. */
	resolve(argument?: unknown): GitRepository | undefined {
		const uri = argument instanceof vscode.Uri
			? argument
			: (argument as { rootUri?: unknown } | undefined)?.rootUri;
		if (uri instanceof vscode.Uri) {
			const repository = this.forUri(uri);
			if (repository) {
				return repository;
			}
		}
		return this.activeRepository;
	}

	forUri(uri: vscode.Uri): GitRepository | undefined {
		const repository = this.api.getRepository(uri);
		return repository ? this.repositories.get(keyOf(repository)) : undefined;
	}

	toGitUri(uri: vscode.Uri, ref: string): vscode.Uri {
		return this.api.toGitUri(uri, ref);
	}

	dispose(): void {
		for (const subscription of this.perRepository.values()) {
			subscription.dispose();
		}
		this.perRepository.clear();
		this.repositories.clear();
		this.disposables.dispose();
	}

	private add(repository: Repository): void {
		const key = keyOf(repository);
		if (this.repositories.has(key)) {
			return;
		}
		this.repositories.set(key, new GitRepository(repository, this.cli));
		this.perRepository.set(key, repository.ui.onDidChange(() => this.updateActive()));
		this.onDidChangeRepositoriesEmitter.fire();
		this.updateActive();
	}

	private remove(repository: Repository): void {
		const key = keyOf(repository);
		if (!this.repositories.has(key)) {
			return;
		}
		this.perRepository.get(key)?.dispose();
		this.perRepository.delete(key);
		this.repositories.delete(key);
		this.onDidChangeRepositoriesEmitter.fire();
		this.updateActive();
	}

	private updateActive(): void {
		const next = this.computeActive();
		if (next !== this.activeRepository) {
			this.activeRepository = next;
			this.onDidChangeActiveEmitter.fire(next);
		}
	}

	private computeActive(): GitRepository | undefined {
		const editorUri = vscode.window.activeTextEditor?.document.uri;
		if (editorUri?.scheme === 'file') {
			const fromEditor = this.forUri(editorUri);
			if (fromEditor) {
				return fromEditor;
			}
		}
		const all = this.all;
		// Keep the current choice while it is still open, e.g. when focus moves to a non-file editor.
		if (this.activeRepository && all.includes(this.activeRepository)) {
			const selected = all.filter(repository => repository.api.ui.selected);
			if (selected.length === 0 || selected.includes(this.activeRepository)) {
				return this.activeRepository;
			}
		}
		return all.find(repository => repository.api.ui.selected) ?? all[0];
	}
}

function keyOf(repository: Repository): string {
	return repository.rootUri.toString();
}
