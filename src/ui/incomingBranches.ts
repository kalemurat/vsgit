import type * as vscode from 'vscode';
import type { GitRepository } from '../git/gitRepository';
import type { LocalBranch, UpdateMethod } from '../git/types';
import { separator, type Separator } from './quickInput';
import { refDescription, refIcon } from './refItems';

/** A local branch, in one of the open repositories, whose tracked branch has commits it lacks. */
export interface IncomingBranch {
	readonly repository: GitRepository;
	readonly branch: LocalBranch;
}

export interface IncomingBranchItem extends vscode.QuickPickItem {
	readonly entry: IncomingBranch;
}

/** True when the branch tracks an existing branch that has commits the local branch does not. */
export function hasIncomingCommits(branch: LocalBranch): boolean {
	return branch.upstream !== undefined && !branch.upstreamGone && branch.behind > 0;
}

/**
 * Items for the "Update Branches" picker, grouped under a separator per repository when
 * `groupByRepository` is set. Branches without local commits are preselected: the update is a plain
 * fast-forward for them. Branches with local commits are listed but left unselected, because the
 * current one would get a merge or rebase, and any other one cannot be updated without a checkout.
 */
export function buildIncomingItems(
	entries: readonly IncomingBranch[],
	method: UpdateMethod,
	groupByRepository: boolean,
): { items: (IncomingBranchItem | Separator)[]; selected: IncomingBranchItem[] } {
	const items: (IncomingBranchItem | Separator)[] = [];
	const selected: IncomingBranchItem[] = [];
	let repository: GitRepository | undefined;
	for (const entry of entries) {
		if (groupByRepository && entry.repository !== repository) {
			repository = entry.repository;
			items.push(separator(repository.name));
		}
		const { branch } = entry;
		const note = branch.isCurrent
			? `checked out, updates with ${method}`
			: branch.ahead > 0 ? 'has local commits, needs a checkout to update' : undefined;
		const item: IncomingBranchItem = {
			entry,
			label: branch.name,
			iconPath: refIcon(branch, false),
			description: [refDescription(branch), note].filter(Boolean).join('  ·  '),
		};
		items.push(item);
		if (branch.ahead === 0) {
			selected.push(item);
		}
	}
	return { items, selected };
}
