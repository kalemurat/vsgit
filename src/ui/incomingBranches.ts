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
 * Items for the "Update Branches" picker. The branches checked out in their repositories come first,
 * in one section labelled `repository: branch` like the status bar, and are preselected: they are
 * what the working trees are on. The other branches follow unselected, under a separator per
 * repository when `groupByRepository` is set; they are fast-forwarded without a checkout when picked.
 */
export function buildIncomingItems(
	entries: readonly IncomingBranch[],
	method: UpdateMethod,
	groupByRepository: boolean,
): { items: (IncomingBranchItem | Separator)[]; selected: IncomingBranchItem[] } {
	const toItem = (entry: IncomingBranch): IncomingBranchItem => {
		const { branch } = entry;
		const note = branch.isCurrent
			? branch.ahead > 0 ? `has local commits, updates with a ${method}` : undefined
			: branch.ahead > 0 ? 'has local commits, needs a checkout to update' : undefined;
		return {
			entry,
			label: branch.isCurrent && groupByRepository ? `${entry.repository.name}: ${branch.name}` : branch.name,
			iconPath: refIcon(branch, false),
			description: [refDescription(branch), note].filter(Boolean).join('  ·  '),
		};
	};

	const current = entries.filter(entry => entry.branch.isCurrent).map(toItem);
	const items: (IncomingBranchItem | Separator)[] = current.length > 0 ? [separator('Checked Out'), ...current] : [];
	let repository: GitRepository | undefined;
	let othersHeaded = false;
	for (const entry of entries.filter(candidate => !candidate.branch.isCurrent)) {
		if (groupByRepository && entry.repository !== repository) {
			repository = entry.repository;
			items.push(separator(repository.name));
		} else if (!groupByRepository && !othersHeaded && current.length > 0) {
			items.push(separator('Other Branches'));
		}
		othersHeaded = true;
		items.push(toItem(entry));
	}
	return { items, selected: current };
}
