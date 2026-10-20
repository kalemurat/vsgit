import * as vscode from 'vscode';
import { isFastForwardRejected, isPushRejected } from '../git/errors';
import type { GitRepository } from '../git/gitRepository';
import type { CommitSummary, LocalBranch, MergeOption, RemoteBranch, UpdateMethod } from '../git/types';
import { Settings } from '../settings';
import { openCommitChanges, toCommitItem, type CommitPickItem } from '../ui/commits';
import { confirm, separator, showMultiPicker, showPicker, type Separator } from '../ui/quickInput';
import { plural, quote } from '../util/format';
import type { FlowContext, Flows } from './context';

type UpdateChoice = UpdateMethod | 'reset';

interface UpdateMethodItem extends vscode.QuickPickItem {
	readonly method: UpdateChoice;
}

type PullOption = MergeOption | '--rebase';

interface PullOptionItem extends vscode.QuickPickItem {
	readonly option: PullOption;
}

interface RemoteBranchItem extends vscode.QuickPickItem {
	readonly branch: RemoteBranch;
}

interface PushTarget {
	readonly remote: string;
	readonly branch: string;
	readonly setUpstream: boolean;
}

interface PushActionItem extends vscode.QuickPickItem {
	readonly force: boolean;
}

/** Fetch, Pull, Push, Update Project and per-branch Update. */
export class SyncFlows {
	constructor(private readonly ctx: FlowContext, private readonly flows: Flows) {}

	/** Git | Fetch: fetches all remotes of every given repository. */
	async fetch(repositories: readonly GitRepository[]): Promise<void> {
		const withRemotes = repositories.filter(repository => repository.remoteNames.length > 0);
		if (withRemotes.length === 0) {
			this.ctx.runner.error('No remotes are configured. Use Manage Remotes… to add one.');
			return;
		}
		const outcomes = await Promise.all(withRemotes.map(repository =>
			this.ctx.runner.run(repository, `Fetching ${repository.name}`, () => repository.fetchAll())));
		if (outcomes.every(outcome => outcome.ok)) {
			vscode.window.setStatusBarMessage('$(check) Fetch finished', 4000);
		}
	}

	/** Git | Update Project…: fetches and integrates the tracked branch in every repository. */
	async updateProject(repositories: readonly GitRepository[]): Promise<void> {
		const method = await this.pickUpdateMethod();
		if (!method) {
			return;
		}
		for (const repository of repositories) {
			await this.updateCurrentBranch(repository, method);
		}
	}

	/** Branch popup → Update: the current branch is updated in place, other branches are fast-forwarded. */
	async updateBranch(repository: GitRepository, branch: LocalBranch): Promise<void> {
		if (branch.isCurrent) {
			await this.updateCurrentBranch(repository, Settings.updateMethod);
			return;
		}
		if (!branch.upstream) {
			this.ctx.runner.error(`Tracked branch is not configured for ${quote(branch.name)}`);
			return;
		}
		const outcome = await this.ctx.runner.run(repository, `Updating ${branch.name}`, () => repository.fastForward(branch),
			{ handled: isFastForwardRejected });
		if (outcome.ok) {
			vscode.window.setStatusBarMessage(`$(check) ${quote(branch.name)} is up to date with ${branch.upstream.name}`, 5000);
			return;
		}
		if (isFastForwardRejected(outcome.error)) {
			const checkoutAndUpdate = 'Checkout and Update';
			const choice = await vscode.window.showWarningMessage(
				`${quote(branch.name)} has commits that are not in ${branch.upstream.name}, so it cannot be fast-forwarded without a checkout.`,
				checkoutAndUpdate);
			if (choice === checkoutAndUpdate) {
				await this.flows.branches.checkoutAndUpdate(repository, branch);
			}
		}
	}

	/**
	 * Fetches all remotes, then merges, rebases or resets the current branch onto its upstream.
	 * Returns false when the branch could not be updated.
	 */
	async updateCurrentBranch(repository: GitRepository, method: UpdateChoice): Promise<boolean> {
		const branch = repository.currentBranchName;
		const upstream = repository.api.state.HEAD?.upstream;
		if (!branch) {
			this.ctx.runner.error(`Cannot update ${quote(repository.name)}: HEAD is detached`);
			return false;
		}
		if (!upstream) {
			this.ctx.runner.error(`Tracked branch is not configured for ${quote(branch)} in ${quote(repository.name)}`);
			return false;
		}
		const upstreamName = upstream.remote === '.' ? upstream.name : `${upstream.remote}/${upstream.name}`;
		if (method === 'reset' && !(await confirm(
			`Do you want to reset local branch ${quote(branch)} to ${quote(upstreamName)}?`, 'Reset', 'Local commits will be dropped.'))) {
			return false;
		}

		const outcome = await this.ctx.runner.run(repository, `Updating ${repository.name}`, async () => {
			if (upstream.remote !== '.') {
				await repository.fetchAll();
			}
			const incoming = await repository.countCommits('HEAD..@{upstream}');
			if (incoming > 0 || method === 'reset') {
				if (method === 'merge') {
					await repository.merge('@{upstream}');
				} else if (method === 'rebase') {
					await repository.rebase({ upstream: '@{upstream}' });
				} else {
					await repository.reset('@{upstream}', 'keep');
				}
			}
			return incoming;
		});
		if (outcome.ok) {
			const message = outcome.value === 0
				? `All files are up-to-date in ${quote(repository.name)}`
				: `${quote(branch)} updated with ${plural(outcome.value, 'commit')} from ${upstreamName}`;
			vscode.window.setStatusBarMessage(`$(check) ${message}`, 5000);
		}
		return outcome.ok;
	}

	/** Git | Pull…: choose a remote branch and options, then fetch it and merge or rebase. */
	async pull(repository: GitRepository): Promise<void> {
		const current = repository.currentBranchName;
		if (!current) {
			this.ctx.runner.error('Pull is not possible in the detached HEAD state');
			return;
		}
		const refs = await repository.getRefs();
		const tracked = refs.local.find(branch => branch.isCurrent)?.upstream?.ref;
		if (refs.remote.length === 0) {
			this.ctx.runner.error('There are no remote branches. Add a remote or fetch first.');
			return;
		}
		const items: (RemoteBranchItem | Separator)[] = [];
		for (const remote of new Set(refs.remote.map(branch => branch.remote))) {
			items.push(separator(remote));
			for (const branch of refs.remote.filter(candidate => candidate.remote === remote)) {
				items.push({ branch, label: branch.name, iconPath: new vscode.ThemeIcon('cloud'), description: branch.fullName === tracked ? 'tracked' : undefined });
			}
		}
		const picked = await showPicker<RemoteBranchItem>({
			title: `Pull to ${current}`,
			placeholder: 'Select the remote branch to pull',
			items,
			isActive: item => item.branch.fullName === tracked,
		});
		if (picked.kind !== 'accept') {
			return;
		}
		const source = picked.item.branch;
		const options = await this.pickPullOptions(current, source);
		if (!options) {
			return;
		}
		await this.runPull(repository, source, options.includes('--rebase') ? 'rebase' : 'merge', options.filter((option): option is MergeOption => option !== '--rebase'));
	}

	/** Remote branch → Pull into 'current' Using Rebase/Merge. */
	pullInto(repository: GitRepository, source: RemoteBranch, method: UpdateMethod): Promise<void> {
		return this.runPull(repository, source, method, []);
	}

	/** Git | Push… or branch → Push…: shows the outgoing commits and pushes them (optionally force-with-lease). */
	async push(repository: GitRepository, branch?: LocalBranch): Promise<void> {
		const local = branch ?? (await repository.getRefs()).local.find(candidate => candidate.isCurrent);
		if (!local) {
			this.ctx.runner.error(repository.head?.kind === 'detached'
				? 'Push is not possible in the detached HEAD state'
				: 'There is nothing to push yet');
			return;
		}
		const target = await this.resolvePushTarget(repository, local);
		if (!target) {
			return;
		}
		const upstreamRef = target.setUpstream ? undefined : local.upstream?.ref;
		const commits = upstreamRef
			? await repository.getCommitsMissing(local.fullName, upstreamRef)
			: await repository.getUnpublishedCommits(local.fullName, target.remote);
		if (commits.length === 0 && !target.setUpstream) {
			this.ctx.runner.info(`Everything is up-to-date: ${quote(local.name)} has no commits to push to ${target.remote}/${target.branch}`);
			return;
		}

		const choice = await this.pickPushAction(repository, local, target, commits);
		if (choice === undefined) {
			return;
		}
		if (choice.force && !(await confirm(
			`Force push ${quote(local.name)} to ${quote(`${target.remote}/${target.branch}`)}?`, 'Force Push',
			'The remote branch is overwritten with your local history (with lease: refused if someone else pushed in the meantime).'))) {
			return;
		}
		await this.runPush(repository, local, target, choice.force, commits.length);
	}

	private async runPush(repository: GitRepository, local: LocalBranch, target: PushTarget, force: boolean, count: number): Promise<void> {
		const refspec = local.name === target.branch ? local.name : `${local.name}:${target.branch}`;
		const outcome = await this.ctx.runner.run(repository, `Pushing ${local.name}`,
			() => repository.push(target.remote, refspec, target.setUpstream, force), { handled: isPushRejected });
		if (outcome.ok) {
			const what = count > 0 ? plural(count, 'commit') : 'branch';
			vscode.window.setStatusBarMessage(`$(check) Pushed ${what} to ${target.remote}/${target.branch}`, 5000);
			return;
		}
		if (!isPushRejected(outcome.error)) {
			return;
		}
		// WebStorm offers to update (merge or rebase) and push again when the remote has new commits.
		const merge = 'Merge';
		const rebase = 'Rebase';
		const actions = local.isCurrent ? [merge, rebase] : [];
		const choice = await vscode.window.showWarningMessage(
			`Push of ${quote(local.name)} was rejected: ${target.remote}/${target.branch} has commits you do not have locally.`,
			{ modal: local.isCurrent, detail: local.isCurrent ? 'Update the branch and push again?' : `Check out ${quote(local.name)} and update it first.` },
			...actions);
		if (choice === merge || choice === rebase) {
			if (await this.updateCurrentBranch(repository, choice === merge ? 'merge' : 'rebase')) {
				await this.runPush(repository, local, target, false, count);
			}
		}
	}

	private async resolvePushTarget(repository: GitRepository, local: LocalBranch): Promise<PushTarget | undefined> {
		const upstream = local.upstream;
		if (upstream && upstream.remote !== '.' && !local.upstreamGone) {
			return { remote: upstream.remote, branch: upstream.remoteRef.replace(/^refs\/heads\//, ''), setUpstream: false };
		}
		const remotes = repository.remoteNames;
		if (remotes.length === 0) {
			const manage = 'Manage Remotes…';
			const choice = await vscode.window.showErrorMessage(`${quote(repository.name)} has no remotes to push to.`, manage);
			if (choice === manage) {
				await this.flows.workspace.manageRemotes(repository);
			}
			return undefined;
		}
		let remote = remotes[0];
		if (remotes.length > 1) {
			const picked = await showPicker({
				title: `Push ${local.name}`,
				placeholder: 'Select the remote to push to',
				items: remotes.map(name => ({ label: name, iconPath: new vscode.ThemeIcon('cloud') })),
				isActive: item => item.label === 'origin',
			});
			if (picked.kind !== 'accept') {
				return undefined;
			}
			remote = picked.item.label;
		}
		return { remote, branch: local.name, setUpstream: true };
	}

	private async pickPushAction(repository: GitRepository, local: LocalBranch, target: PushTarget, commits: readonly CommitSummary[]): Promise<PushActionItem | undefined> {
		const destination = `${target.remote}/${target.branch}`;
		const summary = `${plural(commits.length, 'commit')} → ${destination}${target.setUpstream ? ' (new branch)' : ''}`;
		const items: (PushActionItem | CommitPickItem | Separator)[] = [
			{ label: 'Push', iconPath: new vscode.ThemeIcon('repo-push'), description: summary, force: false },
			{ label: 'Force Push', iconPath: new vscode.ThemeIcon('repo-force-push'), description: 'with lease', force: true },
		];
		if (commits.length > 0) {
			items.push(separator('Commits'), ...commits.map(commit => toCommitItem(commit)));
		}
		// Accepting a commit opens its changes and returns to the dialog.
		for (;;) {
			const result = await showPicker<PushActionItem | CommitPickItem>({
				title: `Push Commits to ${destination}`,
				placeholder: `Push ${quote(local.name)}`,
				items,
				ignoreFocusOut: true,
				onDidTriggerItemButton: event => {
					if ('commit' in event.item) {
						return openCommitChanges(this.ctx.registry, repository, event.item.commit);
					}
				},
			});
			if (result.kind !== 'accept') {
				return undefined;
			}
			if ('force' in result.item) {
				return result.item;
			}
			await openCommitChanges(this.ctx.registry, repository, result.item.commit);
		}
	}

	private async runPull(repository: GitRepository, source: RemoteBranch, method: UpdateMethod, mergeOptions: readonly MergeOption[]): Promise<void> {
		const current = repository.currentBranchName ?? 'HEAD';
		const outcome = await this.ctx.runner.run(repository, `Pulling ${source.name}`, async () => {
			await repository.fetch(source.remote, source.branchName);
			if (method === 'rebase') {
				await repository.rebase({ upstream: source.fullName, flags: mergeOptions.filter(option => option === '--no-verify') });
			} else {
				await repository.merge(source.fullName, mergeOptions);
			}
		});
		if (outcome.ok) {
			vscode.window.setStatusBarMessage(`$(check) Pulled ${source.name} into ${current}`, 5000);
		}
	}

	private async pickUpdateMethod(): Promise<UpdateChoice | undefined> {
		const preferred = Settings.updateMethod;
		const items: UpdateMethodItem[] = [
			{ method: 'merge', label: 'Merge the incoming changes into the current branch', description: 'git pull --no-rebase' },
			{ method: 'rebase', label: 'Rebase the current branch on top of the incoming changes', description: 'git pull --rebase' },
			{ method: 'reset', label: 'Reset to the Remote Branch', description: 'drops local commits' },
		];
		const result = await showPicker({ title: 'Update Project', placeholder: 'Update type', items, isActive: item => item.method === preferred });
		if (result.kind !== 'accept') {
			return undefined;
		}
		const method = result.item.method;
		if (method !== 'reset' && method !== preferred) {
			await Settings.setUpdateMethod(method);
		}
		return method;
	}

	private async pickPullOptions(current: string, source: RemoteBranch): Promise<PullOption[] | undefined> {
		const items: PullOptionItem[] = [
			{ option: '--rebase', label: '--rebase', description: 'Rebase local unpushed commits onto the fetched changes' },
			{ option: '--ff-only', label: '--ff-only', description: 'Merge only if a fast-forward is possible' },
			{ option: '--no-ff', label: '--no-ff', description: 'Always create a merge commit' },
			{ option: '--squash', label: '--squash', description: 'Create a single commit with all pulled changes' },
			{ option: '--no-commit', label: '--no-commit', description: 'Merge without committing, to inspect the result' },
			{ option: '--no-verify', label: '--no-verify', description: 'Skip the pre-merge and commit-msg hooks' },
		];
		for (;;) {
			const selected = await showMultiPicker({
				title: `Pull ${source.name} into ${current}`,
				placeholder: 'Modify options (press Enter for a plain merge)',
				items,
			});
			if (!selected) {
				return undefined;
			}
			const options = selected.map(item => item.option);
			const conflict = findOptionConflict(options);
			if (!conflict) {
				return options;
			}
			await vscode.window.showWarningMessage(conflict, { modal: true });
		}
	}
}

const INCOMPATIBLE_OPTIONS: readonly [string, string][] = [
	['--ff-only', '--no-ff'],
	['--ff-only', '--squash'],
	['--squash', '--no-ff'],
	['--rebase', '--ff-only'],
	['--rebase', '--no-ff'],
	['--rebase', '--squash'],
	['--rebase', '--no-commit'],
];

/** Returns a message when two selected options cannot be combined. */
export function findOptionConflict(options: readonly string[]): string | undefined {
	const pair = INCOMPATIBLE_OPTIONS.find(([a, b]) => options.includes(a) && options.includes(b));
	return pair ? `${pair[0]} cannot be combined with ${pair[1]}` : undefined;
}
