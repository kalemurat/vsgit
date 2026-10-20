import * as path from 'node:path';
import type { GitRef, LocalBranch, RemoteBranch, Tag } from '../git/types';
import { quote } from '../util/format';

type Branch = LocalBranch | RemoteBranch;

/** One entry of the per-branch submenu; each variant carries the ref type its handler needs. */
export type BranchAction = { readonly label: string; readonly group: number } & (
	| { readonly id: 'checkout'; readonly ref: GitRef }
	| { readonly id: 'checkoutAndUpdate'; readonly ref: LocalBranch }
	| { readonly id: 'newBranchFrom'; readonly ref: Branch }
	| { readonly id: 'checkoutAndRebase'; readonly ref: Branch }
	| { readonly id: 'compareWithCurrent'; readonly ref: Branch }
	| { readonly id: 'showDiffWithWorkingTree'; readonly ref: GitRef }
	| { readonly id: 'compareFileWith'; readonly ref: GitRef; readonly file: string }
	| { readonly id: 'rebaseCurrentOnto'; readonly ref: Branch }
	| { readonly id: 'mergeIntoCurrent'; readonly ref: GitRef }
	| { readonly id: 'update'; readonly ref: LocalBranch }
	| { readonly id: 'push'; readonly ref: LocalBranch }
	| { readonly id: 'pullUsingRebase'; readonly ref: RemoteBranch }
	| { readonly id: 'pullUsingMerge'; readonly ref: RemoteBranch }
	| { readonly id: 'pushTag'; readonly ref: Tag; readonly remote: string }
	| { readonly id: 'rename'; readonly ref: LocalBranch }
	| { readonly id: 'delete'; readonly ref: GitRef }
);

export interface BranchActionContext {
	/** Name of the checked-out branch; undefined when HEAD is detached. */
	readonly currentBranch: string | undefined;
	readonly remoteNames: readonly string[];
	/** Path of the file in the active editor when it belongs to the repository. */
	readonly activeFile?: string;
}

/**
 * Builds the submenu WebStorm shows for a branch or tag in its Branches popup. Order, labels and
 * visibility follow IntelliJ's `Git.Branch` action group (checkout · compare · integrate · sync · edit).
 * One addition beyond WebStorm's popup: comparing the active file with the ref (WebStorm offers that
 * as Git | Current File | Compare with Branch).
 */
export function buildBranchActions(ref: GitRef, context: BranchActionContext): BranchAction[] {
	const current = quote(context.currentBranch ?? 'HEAD');
	const onBranch = context.currentBranch !== undefined;
	const hasRemotes = context.remoteNames.length > 0;
	const isCurrent = ref.kind === 'local' && ref.isCurrent;
	const actions: BranchAction[] = [];

	if (!isCurrent) {
		actions.push({ id: 'checkout', label: 'Checkout', group: 0, ref });
	}
	if (ref.kind === 'local' && !isCurrent && ref.upstream && ref.behind > 0) {
		actions.push({ id: 'checkoutAndUpdate', label: 'Checkout and Update', group: 0, ref });
	}
	if (ref.kind !== 'tag') {
		actions.push({ id: 'newBranchFrom', label: `New Branch from ${quote(ref.name)}…`, group: 0, ref });
		if (!isCurrent && onBranch) {
			actions.push({ id: 'checkoutAndRebase', label: `Checkout and Rebase onto ${current}`, group: 0, ref });
		}
	}

	if (!isCurrent) {
		if (ref.kind !== 'tag') {
			actions.push({ id: 'compareWithCurrent', label: `Compare with ${current}`, group: 1, ref });
		}
		actions.push({ id: 'showDiffWithWorkingTree', label: 'Show Diff with Working Tree', group: 1, ref });
		if (context.activeFile) {
			const file = context.activeFile;
			actions.push({ id: 'compareFileWith', label: `Compare ${quote(path.basename(file))} with ${quote(ref.name)}`, group: 1, ref, file });
		}

		if (ref.kind !== 'tag' && onBranch) {
			actions.push({ id: 'rebaseCurrentOnto', label: `Rebase ${current} onto ${quote(ref.name)}`, group: 2, ref });
		}
		actions.push({ id: 'mergeIntoCurrent', label: `Merge ${quote(ref.name)} into ${current}`, group: 2, ref });
	}

	if (ref.kind === 'local' && hasRemotes) {
		if (ref.upstream) {
			actions.push({ id: 'update', label: 'Update', group: 3, ref });
		}
		actions.push({ id: 'push', label: 'Push…', group: 3, ref });
	}
	if (ref.kind === 'remote' && onBranch) {
		actions.push({ id: 'pullUsingRebase', label: `Pull into ${current} Using Rebase`, group: 3, ref });
		actions.push({ id: 'pullUsingMerge', label: `Pull into ${current} Using Merge`, group: 3, ref });
	}
	if (ref.kind === 'tag') {
		for (const remote of context.remoteNames) {
			actions.push({ id: 'pushTag', label: `Push to ${remote}`, group: 3, ref, remote });
		}
	}

	if (ref.kind === 'local') {
		actions.push({ id: 'rename', label: 'Rename…', group: 4, ref });
	}
	if (!isCurrent) {
		actions.push({ id: 'delete', label: 'Delete', group: 4, ref });
	}
	return actions;
}
