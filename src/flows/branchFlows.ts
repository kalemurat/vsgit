import * as vscode from 'vscode';
import { isLocalChangesError, isNotFullyMergedError } from '../git/errors';
import type { GitRepository } from '../git/gitRepository';
import { validateRefName } from '../git/refName';
import type { GitRef, LocalBranch, RefsSnapshot, RemoteBranch, Tag } from '../git/types';
import { Settings } from '../settings';
import { confirm, showInput } from '../ui/quickInput';
import { quote } from '../util/format';
import type { FlowContext, Flows } from './context';

type CheckoutTarget =
	| { readonly kind: 'existing'; readonly ref: string; readonly label: string }
	| { readonly kind: 'create'; readonly name: string; readonly startPoint: string; readonly upstream?: string };

function targetLabel(target: CheckoutTarget): string {
	return target.kind === 'existing' ? target.label : target.name;
}

/** Checkout, New Branch, Rename, Delete, New Tag and Checkout Tag or Revision. */
export class BranchFlows {
	constructor(private readonly ctx: FlowContext, private readonly flows: Flows) {}

	/** Checks out a branch or tag; a remote branch gets a local tracking branch, as in WebStorm. */
	async checkout(repository: GitRepository, ref: GitRef): Promise<boolean> {
		switch (ref.kind) {
			case 'local':
				return this.checkoutTarget(repository, { kind: 'existing', ref: ref.name, label: ref.name });
			case 'tag':
				return this.checkoutTarget(repository, { kind: 'existing', ref: ref.fullName, label: ref.name });
			case 'remote':
				return this.checkoutRemote(repository, ref);
		}
	}

	async checkoutAndUpdate(repository: GitRepository, branch: LocalBranch): Promise<void> {
		if (await this.checkout(repository, branch)) {
			await this.flows.sync.updateCurrentBranch(repository, Settings.updateMethod);
		}
	}

	/** New Branch… (from HEAD) or New Branch from 'ref'…. */
	async newBranch(repository: GitRepository, from?: GitRef): Promise<void> {
		const refs = await repository.getRefs();
		const input = await showInput({
			title: from ? `Create New Branch from ${quote(from.name)}` : 'Create New Branch',
			prompt: 'New branch name',
			value: from?.kind === 'remote' ? from.branchName : undefined,
			validate: value => validateNewBranchName(value, refs),
			toggles: [{ id: 'checkout', label: 'Checkout branch', icon: 'check', checked: true }],
		});
		if (!input) {
			return;
		}
		// `<ref>^0` starts from the commit without inheriting the start point's tracking configuration.
		const startPoint = from ? `${from.fullName}^0` : 'HEAD';
		if (input.toggles.checkout) {
			await this.checkoutTarget(repository, { kind: 'create', name: input.value, startPoint });
		} else {
			await this.ctx.runner.run(repository, `Creating ${input.value}`, () => repository.createBranch(input.value, startPoint, false));
		}
	}

	async rename(repository: GitRepository, branch: LocalBranch): Promise<void> {
		const refs = await repository.getRefs();
		const input = await showInput({
			title: `Rename Branch ${branch.name}`,
			prompt: 'New branch name',
			value: branch.name,
			validate: value => value === branch.name ? undefined : validateNewBranchName(value, refs),
			toggles: branch.upstream ? [{ id: 'unsetUpstream', label: 'Unset upstream branch', icon: 'debug-disconnect', checked: false }] : [],
		});
		if (!input || (input.value === branch.name && !input.toggles.unsetUpstream)) {
			return;
		}
		await this.ctx.runner.run(repository, `Renaming ${branch.name}`, async () => {
			if (input.value !== branch.name) {
				await repository.renameBranch(branch.name, input.value);
			}
			if (input.toggles.unsetUpstream) {
				await repository.unsetUpstream(input.value);
			}
		});
	}

	async delete(repository: GitRepository, ref: GitRef): Promise<void> {
		switch (ref.kind) {
			case 'local':
				return this.deleteLocal(repository, ref);
			case 'remote':
				return this.deleteRemote(repository, ref);
			case 'tag':
				return this.deleteTag(repository, ref);
		}
	}

	/** Checkout Tag or Revision…: any revision git understands; non-branch revisions end in detached HEAD. */
	async checkoutRevision(repository: GitRepository): Promise<void> {
		const input = await showInput({
			title: 'Checkout Tag or Revision',
			prompt: 'Enter reference (branch, tag) name or commit hash',
		});
		if (!input) {
			return;
		}
		if (!(await repository.resolveCommit(input.value))) {
			this.ctx.runner.error(`Revision ${quote(input.value)} was not found in ${quote(repository.name)}`);
			return;
		}
		await this.checkoutTarget(repository, { kind: 'existing', ref: input.value, label: input.value });
	}

	/** Git | New Tag… (and New Tag on a commit when `ref` is given). */
	async newTag(repository: GitRepository, ref?: string): Promise<void> {
		const refs = await repository.getRefs();
		const tags = new Set(refs.tags.map(tag => tag.name));
		const name = await showInput({
			title: ref ? `Create New Tag on ${ref}` : 'Create New Tag',
			prompt: 'Tag name',
			validate: value => validateRefName(value) ?? (tags.has(value) ? `Tag ${quote(value)} already exists` : undefined),
		});
		if (!name) {
			return;
		}
		const message = await showInput({
			title: `Create New Tag ${name.value}`,
			prompt: 'Message (optional; a message creates an annotated tag)',
			allowEmpty: true,
		});
		if (!message) {
			return;
		}
		const outcome = await this.ctx.runner.run(repository, `Tagging ${name.value}`, () => repository.tag(name.value, message.value, ref));
		if (outcome.ok) {
			vscode.window.setStatusBarMessage(`$(tag) Created tag ${quote(name.value)}`, 5000);
		}
	}

	private async checkoutRemote(repository: GitRepository, remote: RemoteBranch): Promise<boolean> {
		const refs = await repository.getRefs();
		const existing = refs.local.find(branch => branch.name === remote.branchName);
		if (existing?.isCurrent) {
			this.ctx.runner.info(`Already on ${quote(existing.name)}`);
			return true;
		}
		if (existing) {
			return this.checkoutTarget(repository, { kind: 'existing', ref: existing.name, label: existing.name });
		}
		return this.checkoutTarget(repository, { kind: 'create', name: remote.branchName, startPoint: remote.name, upstream: remote.name });
	}

	/**
	 * Checks out, and when local changes block it offers WebStorm's choices: Smart Checkout
	 * (stash, checkout, unstash) or Force Checkout (discard the changes).
	 */
	private async checkoutTarget(repository: GitRepository, target: CheckoutTarget): Promise<boolean> {
		const label = targetLabel(target);
		const outcome = await this.ctx.runner.run(repository, `Checking out ${label}`,
			() => performCheckout(repository, target, false), { handled: isLocalChangesError });
		if (outcome.ok || !isLocalChangesError(outcome.error)) {
			return outcome.ok;
		}

		const smart = 'Smart Checkout';
		const force = 'Force Checkout';
		const choice = await vscode.window.showWarningMessage(
			`Your local changes would be overwritten by checkout of ${quote(label)}.`,
			{ modal: true, detail: 'Smart Checkout stashes the local changes, checks out, and restores them. Force Checkout discards them.' },
			smart, force);
		if (choice === smart) {
			return (await this.ctx.runner.run(repository, `Smart checkout of ${label}`, async () => {
				await repository.stash({ message: `Uncommitted changes before checkout of ${label}`, includeUntracked: true });
				try {
					await performCheckout(repository, target, false);
				} finally {
					await repository.popStash(0);
				}
			})).ok;
		}
		if (choice === force && await confirm(`Discard local changes and check out ${quote(label)}?`, force, 'Local changes that conflict with the checkout are lost.')) {
			return (await this.ctx.runner.run(repository, `Force checkout of ${label}`, () => performCheckout(repository, target, true))).ok;
		}
		return false;
	}

	private async deleteLocal(repository: GitRepository, branch: LocalBranch): Promise<void> {
		let outcome = await this.ctx.runner.run(repository, `Deleting ${branch.name}`,
			() => repository.deleteBranch(branch.name, false), { handled: isNotFullyMergedError });
		if (!outcome.ok && isNotFullyMergedError(outcome.error)) {
			if (!(await confirm(`Branch ${quote(branch.name)} is not fully merged`, 'Delete',
				`It has commits that are not merged into the current branch or its upstream. Delete ${quote(branch.name)} anyway?`))) {
				return;
			}
			outcome = await this.ctx.runner.run(repository, `Deleting ${branch.name}`, () => repository.deleteBranch(branch.name, true));
		}
		if (outcome.ok) {
			void this.offerRestore(repository, branch);
		}
	}

	/** WebStorm's post-delete notification: restore the branch, or delete the branch it tracked as well. */
	private async offerRestore(repository: GitRepository, branch: LocalBranch): Promise<void> {
		const restore = 'Restore';
		const deleteTracked = 'Delete Tracked Branch';
		const upstream = branch.upstream;
		const actions = upstream && upstream.remote !== '.' && !branch.upstreamGone ? [restore, deleteTracked] : [restore];
		const choice = await vscode.window.showInformationMessage(`Deleted branch ${quote(branch.name)}`, ...actions);
		if (choice === restore) {
			await this.ctx.runner.run(repository, `Restoring ${branch.name}`, async () => {
				await repository.createBranch(branch.name, branch.commit, false);
				if (upstream && !branch.upstreamGone) {
					await repository.setUpstream(branch.name, upstream.name);
				}
			});
		} else if (choice === deleteTracked && upstream) {
			const refs = await repository.getRefs();
			const remote = refs.remote.find(candidate => candidate.fullName === upstream.ref);
			if (remote) {
				await this.deleteRemote(repository, remote);
			}
		}
	}

	private async deleteRemote(repository: GitRepository, branch: RemoteBranch): Promise<void> {
		if (!(await confirm(`Delete remote branch ${quote(branch.name)}?`, 'Delete', `The branch ${quote(branch.branchName)} is removed from ${quote(branch.remote)}.`))) {
			return;
		}
		const outcome = await this.ctx.runner.run(repository, `Deleting ${branch.name}`, () => repository.deleteRemoteBranch(branch.remote, branch.branchName));
		if (outcome.ok) {
			vscode.window.setStatusBarMessage(`$(trash) Deleted remote branch ${quote(branch.name)}`, 5000);
		}
	}

	private async deleteTag(repository: GitRepository, tag: Tag): Promise<void> {
		const outcome = await this.ctx.runner.run(repository, `Deleting tag ${tag.name}`, () => repository.deleteTag(tag.name));
		if (outcome.ok) {
			void this.offerTagRestore(repository, tag);
		}
	}

	private async offerTagRestore(repository: GitRepository, tag: Tag): Promise<void> {
		const restore = 'Restore';
		const choice = await vscode.window.showInformationMessage(`Deleted tag ${quote(tag.name)}`, restore);
		if (choice === restore) {
			await this.ctx.runner.run(repository, `Restoring tag ${tag.name}`, () => repository.restoreTag(tag.name, tag.commit));
		}
	}
}

async function performCheckout(repository: GitRepository, target: CheckoutTarget, force: boolean): Promise<void> {
	if (target.kind === 'existing') {
		await (force ? repository.forceCheckout(target.ref) : repository.checkout(target.ref));
		return;
	}
	await (force ? repository.forceCheckout(target.startPoint, target.name) : repository.createBranch(target.name, target.startPoint, true));
	if (target.upstream) {
		await repository.setUpstream(target.name, target.upstream);
	}
}

/** Mirrors the checks of WebStorm's New Branch dialog. */
export function validateNewBranchName(name: string, refs: RefsSnapshot): string | undefined {
	const formatError = validateRefName(name);
	if (formatError) {
		return formatError;
	}
	if (refs.local.some(branch => branch.name === name)) {
		return `Branch name ${name} already exists`;
	}
	if (refs.remote.some(branch => branch.name === name)) {
		return `Branch name ${name} conflicts with remote branch with the same name`;
	}
	if (refs.local.some(branch => branch.name.startsWith(`${name}/`) || name.startsWith(`${branch.name}/`))) {
		return `Branch name ${name} conflicts with local branch directory with the same name`;
	}
	return undefined;
}
