export interface Upstream {
	/** Full ref, e.g. `refs/remotes/origin/main` (or `refs/heads/main` when tracking a local branch). */
	readonly ref: string;
	/** Short display name, e.g. `origin/main`. */
	readonly name: string;
	/** Remote name; `.` when the upstream is a local branch. */
	readonly remote: string;
	/** Ref on the remote side, e.g. `refs/heads/main`. */
	readonly remoteRef: string;
}

interface RefBase {
	readonly fullName: string;
	/** Short name as shown to the user (`main`, `origin/main`, `v1.0`). */
	readonly name: string;
	readonly commit: string;
}

export interface LocalBranch extends RefBase {
	readonly kind: 'local';
	readonly isCurrent: boolean;
	readonly upstream: Upstream | undefined;
	/** Commits on the branch that are not on its upstream (outgoing). */
	readonly ahead: number;
	/** Commits on the upstream that are not on the branch (incoming). */
	readonly behind: number;
	readonly upstreamGone: boolean;
}

export interface RemoteBranch extends RefBase {
	readonly kind: 'remote';
	readonly remote: string;
	/** Branch name on the remote, e.g. `feature/x` for `origin/feature/x`. */
	readonly branchName: string;
}

export interface Tag extends RefBase {
	readonly kind: 'tag';
}

export type GitRef = LocalBranch | RemoteBranch | Tag;

export interface RefsSnapshot {
	readonly local: readonly LocalBranch[];
	readonly remote: readonly RemoteBranch[];
	readonly tags: readonly Tag[];
}

export type Head =
	| { readonly kind: 'branch'; readonly name: string }
	| { readonly kind: 'detached'; readonly commit: string };

export type OngoingOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

export interface CommitSummary {
	readonly hash: string;
	readonly shortHash: string;
	readonly author: string;
	readonly date: Date;
	readonly subject: string;
	/** True when an equivalent patch already exists on the other side (`git log --cherry-mark`). */
	readonly equivalentExists: boolean;
}

export interface StashEntry {
	readonly index: number;
	readonly ref: string;
	readonly message: string;
	readonly date: Date;
}

export type MergeOption = '--no-ff' | '--ff-only' | '--squash' | '--no-commit' | '--no-verify' | '--allow-unrelated-histories';

export type ResetMode = 'soft' | 'mixed' | 'hard' | 'keep';

export type UpdateMethod = 'merge' | 'rebase';
