import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GitRepository } from '../git/gitRepository';
import { validateRefName } from '../git/refName';
import type { GitRef, StashEntry } from '../git/types';
import type { Remote } from '../typings/git';
import { confirm, showInput, showPicker } from '../ui/quickInput';
import { pickRef } from '../ui/refItems';
import { fromNow, quote } from '../util/format';
import type { FlowContext } from './context';

interface StashItem extends vscode.QuickPickItem {
	readonly stash: StashEntry;
}

type StashAction = 'pop' | 'apply' | 'branch' | 'drop';

interface ActionItem<T> extends vscode.QuickPickItem {
	readonly action: T;
}

interface RemoteItem extends vscode.QuickPickItem {
	readonly remote: Remote;
}

type RemoteAction = 'url' | 'rename' | 'remove';

const CLEAR_BUTTON = { id: 'clear', iconPath: new vscode.ThemeIcon('clear-all'), tooltip: 'Clear All Stashes' };
const ADD_REMOTE_BUTTON = { id: 'add', iconPath: new vscode.ThemeIcon('add'), tooltip: 'Add Remote' };

/** Uncommitted Changes (stash/unstash), Manage Remotes and Current File actions. */
export class WorkspaceFlows {
	constructor(private readonly ctx: FlowContext) {}

	/** Uncommitted Changes → Stash Changes…. */
	async stash(repository: GitRepository): Promise<void> {
		if (!repository.hasLocalChanges()) {
			this.ctx.runner.info(`There are no local changes to stash in ${quote(repository.name)}`);
			return;
		}
		const input = await showInput({
			title: `Stash Changes in ${repository.name}`,
			prompt: 'Message (optional)',
			allowEmpty: true,
			toggles: [
				{ id: 'keepIndex', label: 'Keep index', icon: 'pass', checked: false },
				{ id: 'includeUntracked', label: 'Include untracked files', icon: 'new-file', checked: false },
			],
		});
		if (!input) {
			return;
		}
		const outcome = await this.ctx.runner.run(repository, 'Stashing changes', () => repository.stash({
			message: input.value || undefined,
			keepIndex: input.toggles.keepIndex,
			includeUntracked: input.toggles.includeUntracked,
		}));
		if (outcome.ok) {
			vscode.window.setStatusBarMessage('$(check) Local changes stashed', 5000);
		}
	}

	/** Uncommitted Changes → Unstash Changes…: Pop, Apply, Unstash as branch, Drop, or Clear. */
	async unstash(repository: GitRepository): Promise<void> {
		for (;;) {
			const stashes = await repository.getStashes();
			if (stashes.length === 0) {
				this.ctx.runner.info(`There are no stashes in ${quote(repository.name)}`);
				return;
			}
			const picked = await showPicker<StashItem>({
				title: `Unstash Changes in ${repository.name}`,
				placeholder: 'Select a stash',
				items: stashes.map(stash => ({ stash, label: stash.message, description: `${stash.ref} · ${fromNow(stash.date)}`, iconPath: new vscode.ThemeIcon('archive') })),
				buttons: [CLEAR_BUTTON],
				matchOnDescription: true,
			});
			if (picked.kind === 'button') {
				if (await confirm('Clear all stashes?', 'Clear', 'Stashed changes cannot be restored.')) {
					await this.ctx.runner.run(repository, 'Clearing stashes', () => repository.clearStashes());
				}
				return;
			}
			if (picked.kind !== 'accept') {
				return;
			}
			const done = await this.runStashAction(repository, picked.item.stash);
			if (done) {
				return;
			}
		}
	}

	/** Git | Manage Remotes…. */
	async manageRemotes(repository: GitRepository): Promise<void> {
		for (;;) {
			const remotes = repository.api.state.remotes;
			const picked = await showPicker<RemoteItem>({
				title: `Git Remotes — ${repository.name}`,
				placeholder: remotes.length > 0 ? 'Select a remote to edit, or add one with +' : 'No remotes yet — add one with +',
				items: remotes.map(remote => ({ remote, label: remote.name, description: remote.fetchUrl ?? remote.pushUrl, iconPath: new vscode.ThemeIcon('cloud') })),
				buttons: [ADD_REMOTE_BUTTON],
			});
			if (picked.kind === 'button') {
				await this.addRemote(repository);
				continue;
			}
			if (picked.kind !== 'accept') {
				return;
			}
			const remote = picked.item.remote;
			const action = await showPicker<ActionItem<RemoteAction>>({
				title: `Remote ${remote.name}`,
				canGoBack: true,
				items: [
					{ action: 'url', label: 'Edit URL…', iconPath: new vscode.ThemeIcon('edit') },
					{ action: 'rename', label: 'Rename…', iconPath: new vscode.ThemeIcon('symbol-text') },
					{ action: 'remove', label: 'Remove', iconPath: new vscode.ThemeIcon('trash') },
				],
			});
			if (action.kind === 'back') {
				continue;
			}
			if (action.kind !== 'accept') {
				return;
			}
			await this.runRemoteAction(repository, remote, action.item.action);
		}
	}

	/**
	 * Current File → Compare with Branch or Tag…: diffs the file as it is in `ref` against the local
	 * file. Without `ref` the user picks one.
	 */
	async compareFileWithRef(uri: vscode.Uri | undefined, ref?: GitRef): Promise<void> {
		const file = uri ?? vscode.window.activeTextEditor?.document.uri;
		const repository = file?.scheme === 'file' ? this.ctx.registry.forUri(file) : undefined;
		if (!file || !repository) {
			this.ctx.runner.error('Open a file that belongs to a Git repository first');
			return;
		}
		const name = path.basename(file.fsPath);
		const target = ref ?? await pickRef(repository, { title: `Compare ${name} with Branch or Tag` });
		if (!target) {
			return;
		}
		const relativePath = path.relative(repository.root, file.fsPath).split(path.sep).join('/');
		if (!(await repository.existsInRef(target.name, relativePath))) {
			const compare = 'Compare Anyway';
			const choice = await vscode.window.showWarningMessage(`${quote(relativePath)} does not exist in ${quote(target.name)}.`, compare);
			if (choice !== compare) {
				return;
			}
		}
		await vscode.commands.executeCommand('vscode.diff', this.ctx.registry.toGitUri(file, target.name), file, `${name} (${target.name}) ↔ ${name}`);
	}

	private async runStashAction(repository: GitRepository, stash: StashEntry): Promise<boolean> {
		const action = await showPicker<ActionItem<StashAction>>({
			title: `${stash.ref}: ${stash.message}`,
			canGoBack: true,
			items: [
				{ action: 'pop', label: 'Pop', description: 'Apply and remove the stash', iconPath: new vscode.ThemeIcon('git-stash-pop') },
				{ action: 'apply', label: 'Apply', description: 'Apply and keep the stash', iconPath: new vscode.ThemeIcon('git-stash-apply') },
				{ action: 'branch', label: 'Unstash as Branch…', description: 'Create a branch from the stash base and apply it there', iconPath: new vscode.ThemeIcon('git-branch') },
				{ action: 'drop', label: 'Drop', description: 'Delete the stash', iconPath: new vscode.ThemeIcon('trash') },
			],
		});
		if (action.kind === 'back') {
			return false;
		}
		if (action.kind !== 'accept') {
			return true;
		}
		switch (action.item.action) {
			case 'pop':
				await this.ctx.runner.run(repository, `Popping ${stash.ref}`, () => repository.popStash(stash.index));
				break;
			case 'apply':
				await this.ctx.runner.run(repository, `Applying ${stash.ref}`, () => repository.applyStash(stash.index));
				break;
			case 'branch': {
				const refs = await repository.getRefs();
				const input = await showInput({
					title: `Unstash ${stash.ref} as Branch`,
					prompt: 'New branch name',
					validate: value => validateRefName(value) ?? (refs.local.some(branch => branch.name === value) ? `Branch name ${value} already exists` : undefined),
				});
				if (input) {
					await this.ctx.runner.run(repository, `Unstashing to ${input.value}`, () => repository.stashToBranch(input.value, stash.ref));
				}
				break;
			}
			case 'drop':
				if (await confirm(`Drop ${stash.ref}?`, 'Drop', stash.message)) {
					await this.ctx.runner.run(repository, `Dropping ${stash.ref}`, () => repository.dropStash(stash.index));
				}
				break;
		}
		return true;
	}

	private async addRemote(repository: GitRepository): Promise<void> {
		const existing = new Set(repository.remoteNames);
		const name = await showInput({
			title: 'Add Remote',
			prompt: 'Name',
			value: existing.has('origin') ? undefined : 'origin',
			validate: value => validateRefName(value) ?? (existing.has(value) ? `Remote ${quote(value)} already exists` : undefined),
		});
		if (!name) {
			return;
		}
		const url = await showInput({ title: `Add Remote ${name.value}`, prompt: 'URL' });
		if (url) {
			await this.ctx.runner.run(repository, `Adding remote ${name.value}`, () => repository.addRemote(name.value, url.value));
		}
	}

	private async runRemoteAction(repository: GitRepository, remote: Remote, action: RemoteAction): Promise<void> {
		switch (action) {
			case 'url': {
				const url = await showInput({ title: `Edit Remote ${remote.name}`, prompt: 'URL', value: remote.fetchUrl ?? remote.pushUrl });
				if (url) {
					await this.ctx.runner.run(repository, `Updating remote ${remote.name}`, () => repository.setRemoteUrl(remote.name, url.value));
				}
				break;
			}
			case 'rename': {
				const existing = new Set(repository.remoteNames);
				const name = await showInput({
					title: `Rename Remote ${remote.name}`,
					prompt: 'New name',
					value: remote.name,
					validate: value => value === remote.name ? undefined : validateRefName(value) ?? (existing.has(value) ? `Remote ${quote(value)} already exists` : undefined),
				});
				if (name && name.value !== remote.name) {
					await this.ctx.runner.run(repository, `Renaming remote ${remote.name}`, () => repository.renameRemote(remote.name, name.value));
				}
				break;
			}
			case 'remove':
				if (await confirm(`Remove remote ${quote(remote.name)}?`, 'Remove', 'Its remote-tracking branches are removed too.')) {
					await this.ctx.runner.run(repository, `Removing remote ${remote.name}`, () => repository.removeRemote(remote.name));
				}
				break;
		}
	}
}
