import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GitRepository, RebaseRequest } from '../git/gitRepository';
import type { GitRef, LocalBranch, MergeOption, OngoingOperation, RemoteBranch, ResetMode } from '../git/types';
import type { Branch, RefType } from '../typings/git';
import { openChanges } from '../ui/changes';
import { openCommitChanges, SHOW_CHANGES_BUTTON, toCommitItem, type CommitPickItem } from '../ui/commits';
import { confirm, showInput, showMultiPicker, showPicker } from '../ui/quickInput';
import { pickRef } from '../ui/refItems';
import { DisposableStore } from '../util/disposable';
import { plural, quote } from '../util/format';
import type { FlowContext, Flows } from './context';
import { findOptionConflict } from './syncFlows';

const REF_TYPE_HEAD = 0 as RefType;

type MergeChoice = MergeOption | '-m';

interface OptionItem<T> extends vscode.QuickPickItem {
	readonly option: T;
}

type RebaseChoice = '--onto' | '--root' | '--rebase-merges' | '--keep-empty' | '--update-refs' | '--autosquash' | 'branch';

const OPERATION_NAMES: Record<OngoingOperation, string> = {
	'merge': 'Merge',
	'rebase': 'Rebase',
	'cherry-pick': 'Cherry-Pick',
	'revert': 'Revert',
};

/** Merge, Rebase, Cherry-Pick, Compare, Reset and the abort/continue actions of interrupted operations. */
export class IntegrationFlows {
	constructor(private readonly ctx: FlowContext, private readonly flows: Flows) {}

	/** Branch → Merge 'ref' into 'current'. Merging a local branch proposes deleting it afterwards. */
	async mergeInto(repository: GitRepository, ref: GitRef, options: readonly MergeOption[] = [], message?: string): Promise<void> {
		const current = repository.currentBranchName ?? 'HEAD';
		const outcome = await this.ctx.runner.run(repository, `Merging ${ref.name} into ${current}`,
			() => repository.merge(ref.name, options, message));
		if (!outcome.ok) {
			return;
		}
		if (options.includes('--squash') || options.includes('--no-commit')) {
			this.ctx.runner.info(`Merged ${quote(ref.name)} into ${quote(current)}; the result is staged and not committed yet`);
			return;
		}
		if (ref.kind === 'local' && !this.isProtected(repository, ref)) {
			void this.offerDeleteMerged(repository, ref, current);
		} else {
			vscode.window.setStatusBarMessage(`$(check) Merged ${quote(ref.name)} into ${quote(current)}`, 5000);
		}
	}

	/** WebStorm proposes deleting a merged local branch; the notification does not hold up the merge flow. */
	private async offerDeleteMerged(repository: GitRepository, branch: LocalBranch, current: string): Promise<void> {
		const deleteBranch = 'Delete Branch';
		const choice = await vscode.window.showInformationMessage(`Merged ${quote(branch.name)} into ${quote(current)}`, deleteBranch);
		if (choice === deleteBranch) {
			await this.flows.branches.delete(repository, branch);
		}
	}

	/** Git | Merge…: choose a branch, then optional flags (WebStorm's "Modify options"). */
	async merge(repository: GitRepository): Promise<void> {
		const current = repository.currentBranchName ?? 'HEAD';
		const ref = await pickRef(repository, { title: `Merge into ${current}`, placeholder: 'Select the branch to merge', excludeCurrent: true });
		if (!ref) {
			return;
		}
		const items: OptionItem<MergeChoice>[] = [
			{ option: '--no-ff', label: '--no-ff', description: 'Create a merge commit even if a fast-forward is possible' },
			{ option: '--ff-only', label: '--ff-only', description: 'Merge only if a fast-forward is possible' },
			{ option: '--squash', label: '--squash', description: 'Add all changes as one commit on the current branch' },
			{ option: '-m', label: '-m', description: 'Edit the merge commit message' },
			{ option: '--no-commit', label: '--no-commit', description: 'Merge without committing, to inspect the result' },
			{ option: '--no-verify', label: '--no-verify', description: 'Skip the pre-merge and commit-msg hooks' },
			{ option: '--allow-unrelated-histories', label: '--allow-unrelated-histories', description: 'Merge branches without a common ancestor' },
		];
		let choices: MergeChoice[];
		for (;;) {
			const selected = await showMultiPicker({ title: `Merge ${ref.name} into ${current}`, placeholder: 'Modify options (press Enter to merge)', items });
			if (!selected) {
				return;
			}
			choices = selected.map(item => item.option);
			const conflict = findOptionConflict(choices);
			if (!conflict) {
				break;
			}
			await vscode.window.showWarningMessage(conflict, { modal: true });
		}
		let message: string | undefined;
		if (choices.includes('-m')) {
			const input = await showInput({ title: `Merge ${ref.name} into ${current}`, prompt: 'Commit message', value: `Merge branch '${ref.name}' into ${current}` });
			if (!input) {
				return;
			}
			message = input.value;
		}
		await this.mergeInto(repository, ref, choices.filter((choice): choice is MergeOption => choice !== '-m'), message);
	}

	/** Branch → Rebase 'current' onto 'ref'. */
	async rebaseCurrentOnto(repository: GitRepository, ref: GitRef): Promise<void> {
		const current = repository.currentBranchName;
		if (!current) {
			this.ctx.runner.error('Rebase is not possible in the detached HEAD state');
			return;
		}
		await this.runRebase(repository, { upstream: ref.name }, `Rebasing ${current} onto ${ref.name}`);
	}

	/** Branch → Checkout and Rebase onto 'current' (like `git rebase <current> <branch>`). */
	async checkoutAndRebase(repository: GitRepository, branch: LocalBranch | RemoteBranch): Promise<void> {
		const current = repository.currentBranchName;
		if (!current) {
			this.ctx.runner.error('Rebase is not possible in the detached HEAD state');
			return;
		}
		let localName = branch.name;
		if (branch.kind === 'remote') {
			localName = branch.branchName;
			const existing = (await repository.getRefs()).local.find(candidate => candidate.name === localName);
			if (existing && existing.upstream?.ref !== branch.fullName) {
				this.ctx.runner.error(`Local branch ${quote(localName)} already exists and does not track ${quote(branch.name)}`);
				return;
			}
			if (!existing) {
				const created = await this.ctx.runner.run(repository, `Creating ${localName}`, async () => {
					await repository.createBranch(localName, branch.name, false);
					await repository.setUpstream(localName, branch.name);
				});
				if (!created.ok) {
					return;
				}
			}
		}
		await this.runRebase(repository, { upstream: current, branch: localName }, `Rebasing ${localName} onto ${current}`);
	}

	/** Git | Rebase…: choose the target, then optional flags. */
	async rebase(repository: GitRepository): Promise<void> {
		const current = repository.currentBranchName;
		if (!current) {
			this.ctx.runner.error('Rebase is not possible in the detached HEAD state');
			return;
		}
		const target = await pickRef(repository, { title: `Rebase ${current}`, placeholder: 'Select the branch to rebase onto', excludeCurrent: true });
		if (!target) {
			return;
		}
		const items: OptionItem<RebaseChoice>[] = [
			{ option: '--onto', label: '--onto', description: `Select a new base; ${quote(target.name)} becomes the old base (cutoff)` },
			{ option: 'branch', label: 'Select another branch to rebase', description: `Instead of ${quote(current)}` },
			{ option: '--rebase-merges', label: '--rebase-merges', description: 'Keep the branch structure of the rebased commits' },
			{ option: '--keep-empty', label: '--keep-empty', description: 'Keep commits that do not change anything' },
			{ option: '--root', label: '--root', description: 'Rebase all commits reachable from the branch' },
			{ option: '--update-refs', label: '--update-refs', description: 'Update branches that point to rebased commits' },
			{ option: '--autosquash', label: '--autosquash', description: 'Squash commits marked as fixup! or squash!' },
		];
		const selected = await showMultiPicker({ title: `Rebase ${current} onto ${target.name}`, placeholder: 'Modify options (press Enter to rebase)', items });
		if (!selected) {
			return;
		}
		const choices = new Set(selected.map(item => item.option));
		let newBase: string | undefined;
		if (choices.has('--onto') && !choices.has('--root')) {
			newBase = (await pickRef(repository, { title: `Rebase ${current} --onto`, placeholder: 'Select the new base' }))?.name;
			if (!newBase) {
				return;
			}
		}
		let branch: string | undefined;
		if (choices.has('branch')) {
			branch = (await pickRef(repository, { title: 'Select another branch to rebase', kinds: ['local'], excludeCurrent: true }))?.name;
			if (!branch) {
				return;
			}
		}
		const flags = (['--rebase-merges', '--keep-empty', '--update-refs', '--autosquash'] as const).filter(flag => choices.has(flag));
		const request: RebaseRequest = { upstream: target.name, newBase, root: choices.has('--root'), branch, flags };
		await this.runRebase(repository, request, `Rebasing ${branch ?? current} onto ${newBase ?? target.name}`);
	}

	/**
	 * Branch → Compare with 'current': commits in `ref` missing from HEAD, with WebStorm's
	 * "already cherry-picked" marking. Selected commits can be cherry-picked; Swap shows the reverse.
	 */
	async compareWithCurrent(repository: GitRepository, ref: GitRef): Promise<void> {
		const current = repository.currentBranchName ?? 'HEAD';
		const selection = await this.showComparison(repository, ref.name, current);
		if (!selection || selection.length === 0) {
			return;
		}
		const oldestFirst = [...selection].reverse();
		await this.cherryPick(repository, oldestFirst.map(item => item.commit.hash), current);
	}

	async cherryPick(repository: GitRepository, hashes: readonly string[], current = repository.currentBranchName ?? 'HEAD'): Promise<void> {
		const outcome = await this.ctx.runner.run(repository, `Cherry-picking ${plural(hashes.length, 'commit')}`, () => repository.cherryPick(hashes));
		if (outcome.ok) {
			vscode.window.setStatusBarMessage(`$(check) Cherry-picked ${plural(hashes.length, 'commit')} into ${current}`, 5000);
		}
	}

	/** Branch → Show Diff with Working Tree. */
	async showDiffWithWorkingTree(repository: GitRepository, ref: GitRef): Promise<void> {
		const changes = await repository.diffWithWorkingTree(ref.name);
		if (changes.length === 0) {
			this.ctx.runner.info(`There are no differences between ${quote(ref.name)} and the working tree`);
			return;
		}
		await openChanges(this.ctx.registry, `${ref.name} ↔ Working Tree`, changes, ref.name);
	}

	/** Git | Reset HEAD…: target revision plus WebStorm's Soft / Mixed / Hard / Keep modes. */
	async resetHead(repository: GitRepository): Promise<void> {
		const input = await showInput({ title: 'Reset HEAD', prompt: 'To commit (revision, branch or tag)', value: 'HEAD' });
		if (!input) {
			return;
		}
		if (!(await repository.resolveCommit(input.value))) {
			this.ctx.runner.error(`Revision ${quote(input.value)} was not found`);
			return;
		}
		const modes: OptionItem<ResetMode>[] = [
			{ option: 'soft', label: 'Soft', detail: 'Files won\'t change, differences will be staged for commit.' },
			{ option: 'mixed', label: 'Mixed', detail: 'Files won\'t change, differences won\'t be staged.' },
			{ option: 'hard', label: 'Hard', detail: 'Files will be reverted to the state of the selected commit. Warning: any local changes will be lost.' },
			{ option: 'keep', label: 'Keep', detail: 'Files will be reverted to the state of the selected commit, but local changes will be kept intact.' },
		];
		const picked = await showPicker({ title: `Reset ${repository.currentBranchName ?? 'HEAD'} to ${input.value}`, placeholder: 'Reset mode', items: modes, isActive: item => item.option === 'mixed' });
		if (picked.kind !== 'accept') {
			return;
		}
		const mode = picked.item.option;
		if (mode === 'hard' && !(await confirm(`Hard reset to ${quote(input.value)}?`, 'Reset', 'Any local changes will be lost.'))) {
			return;
		}
		await this.ctx.runner.run(repository, `Resetting to ${input.value}`, () => repository.reset(input.value, mode));
	}

	async abort(repository: GitRepository, expected?: OngoingOperation): Promise<void> {
		const operation = expected ?? await repository.getOngoingOperation();
		if (!operation) {
			this.ctx.runner.info(`There is no merge, rebase, cherry-pick or revert in progress in ${quote(repository.name)}`);
			return;
		}
		const name = OPERATION_NAMES[operation];
		if (!(await confirm(`Abort ${name}?`, `Abort ${name}`, 'Changes made while resolving conflicts are lost.'))) {
			return;
		}
		await this.ctx.runner.run(repository, `Aborting ${name.toLowerCase()}`, () => repository.abort(operation));
	}

	async continue(repository: GitRepository, operation: Exclude<OngoingOperation, 'merge'>): Promise<void> {
		if (!(await this.ensureNoConflicts(repository))) {
			return;
		}
		await this.ctx.runner.run(repository, `Continuing ${OPERATION_NAMES[operation].toLowerCase()}`, () => repository.continue(operation));
	}

	async commitMerge(repository: GitRepository): Promise<void> {
		if (await this.ensureNoConflicts(repository)) {
			await this.ctx.runner.run(repository, 'Committing merge', () => repository.commitMerge());
		}
	}

	async skipRebaseCommit(repository: GitRepository): Promise<void> {
		await this.ctx.runner.run(repository, 'Skipping commit', () => repository.skipRebaseCommit());
	}

	/** Git | Resolve Conflicts…: opens a conflicted file in VS Code's merge editor. */
	async resolveConflicts(repository: GitRepository): Promise<void> {
		const files = await repository.getConflictedFiles();
		if (files.length === 0) {
			this.ctx.runner.info(`There are no conflicts in ${quote(repository.name)}`);
			return;
		}
		let file = files[0];
		if (files.length > 1) {
			const picked = await showPicker({
				title: `Conflicts (${files.length})`,
				placeholder: 'Select a file to resolve in the merge editor',
				items: files.map(uri => ({
					uri,
					label: path.basename(uri.fsPath),
					description: path.dirname(path.relative(repository.root, uri.fsPath)).replace(/^\.$/, ''),
					iconPath: vscode.ThemeIcon.File,
				})),
			});
			if (picked.kind !== 'accept') {
				return;
			}
			file = picked.item.uri;
		}
		await vscode.commands.executeCommand('git.openMergeEditor', file);
	}

	/** IntelliJ's "Show Files Diff": every file that differs between the heads of two refs. */
	async showFilesDiff(repository: GitRepository, left: string, right: string): Promise<void> {
		const changes = await repository.api.diffBetween(left, right);
		if (changes.length === 0) {
			this.ctx.runner.info(`There are no differences between ${quote(left)} and ${quote(right)}`);
			return;
		}
		await openChanges(this.ctx.registry, `${left} ↔ ${right}`, changes, left, right);
	}

	private async runRebase(repository: GitRepository, request: RebaseRequest, title: string): Promise<void> {
		const outcome = await this.ctx.runner.run(repository, title, () => repository.rebase(request));
		if (outcome.ok) {
			vscode.window.setStatusBarMessage(`$(check) ${title.replace(/^Rebasing/, 'Rebased')}`, 5000);
		}
	}

	private async ensureNoConflicts(repository: GitRepository): Promise<boolean> {
		const conflicts = await repository.getConflictedFiles();
		if (conflicts.length === 0) {
			return true;
		}
		const resolve = 'Resolve Conflicts…';
		const choice = await vscode.window.showWarningMessage(`Resolve ${plural(conflicts.length, 'conflicted file')} first.`, resolve);
		if (choice === resolve) {
			await this.resolveConflicts(repository);
		}
		return false;
	}

	private isProtected(repository: GitRepository, branch: LocalBranch): boolean {
		const asApiBranch: Branch = { type: REF_TYPE_HEAD, name: branch.name, commit: branch.commit };
		return repository.api.isBranchProtected(asApiBranch);
	}

	/**
	 * Lists commits of `ref` missing from `current` (multi-select; accepting cherry-picks them).
	 * The Swap button flips the direction; swapped commits can only be inspected.
	 */
	private showComparison(repository: GitRepository, ref: string, current: string): Promise<readonly CommitPickItem[] | undefined> {
		return new Promise((resolve, reject) => {
			const disposables = new DisposableStore();
			const quickPick = disposables.add(vscode.window.createQuickPick<CommitPickItem>());
			const swapButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('arrow-swap'), tooltip: 'Swap Branches' };
			const filesDiffButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('diff-multiple'), tooltip: 'Show Files Diff' };
			let swapped = false;
			let result: readonly CommitPickItem[] | undefined;
			let generation = 0;

			const load = async (): Promise<void> => {
				const request = ++generation;
				const [from, into] = swapped ? [current, ref] : [ref, current];
				quickPick.busy = true;
				quickPick.title = `Commits in ${quote(from)} missing in ${quote(into)}`;
				quickPick.canSelectMany = !swapped;
				quickPick.items = [];
				const commits = await repository.getCommitsMissing(from, into);
				if (request !== generation) {
					return;
				}
				quickPick.items = commits.map(commit => toCommitItem(commit, `An equivalent change is already in ${quote(into)}`));
				quickPick.placeholder = commits.length === 0
					? `${quote(from)} has no commits missing in ${quote(into)}`
					: swapped ? 'Select a commit to show its changes' : `Select commits to cherry-pick into ${quote(current)}`;
				quickPick.busy = false;
			};

			quickPick.buttons = [filesDiffButton, swapButton];
			quickPick.ignoreFocusOut = true;
			quickPick.matchOnDescription = true;
			disposables.add(quickPick.onDidTriggerButton(button => {
				if (button === filesDiffButton) {
					const [from, into] = swapped ? [current, ref] : [ref, current];
					this.showFilesDiff(repository, into, from).catch(reject);
					return;
				}
				swapped = !swapped;
				load().catch(reject);
			}));
			disposables.add(quickPick.onDidTriggerItemButton(event => {
				if (event.button === SHOW_CHANGES_BUTTON) {
					openCommitChanges(this.ctx.registry, repository, event.item.commit).catch(reject);
				}
			}));
			disposables.add(quickPick.onDidAccept(() => {
				if (swapped) {
					const [item] = quickPick.activeItems;
					if (item) {
						openCommitChanges(this.ctx.registry, repository, item.commit).catch(reject);
					}
					return;
				}
				result = quickPick.selectedItems.length > 0 ? [...quickPick.selectedItems] : [...quickPick.activeItems];
				quickPick.hide();
			}));
			disposables.add(quickPick.onDidHide(() => {
				generation++;
				resolve(result);
				disposables.dispose();
			}));
			quickPick.show();
			load().catch(error => {
				quickPick.hide();
				reject(error);
			});
		});
	}
}
