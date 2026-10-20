import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Change, ForcePushMode, Repository } from '../typings/git';
import { SerialQueue } from '../util/async';
import type { GitCli } from './cli';
import { LOG_FORMAT, parseLog, parseNulSeparated, parseRecentCheckouts, parseRefs, parseStashes, REF_FORMAT, STASH_FORMAT } from './parsers';
import type { CommitSummary, Head, LocalBranch, MergeOption, OngoingOperation, RefsSnapshot, ResetMode, StashEntry } from './types';

// `ForcePushMode` is a const enum in an ambient declaration; esbuild cannot inline it, so the value is spelled out.
const FORCE_WITH_LEASE = 1 as ForcePushMode;

/** Empty tree object; the "parent" used to diff a root commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const STATE_FILES = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'FETCH_HEAD'] as const;
type StateFile = typeof STATE_FILES[number];

export interface RebaseRequest {
	/** Upstream ref (the branch picked in the dialog). */
	readonly upstream: string;
	/** `--onto <newBase>`: replay the commits after `upstream` onto `newBase`. */
	readonly newBase?: string;
	/** `--root --onto <upstream>`: replay every commit reachable from the branch. */
	readonly root?: boolean;
	/** Branch to check out before rebasing (`git rebase <upstream> <branch>`). */
	readonly branch?: string;
	readonly flags?: readonly string[];
}

export interface StashRequest {
	readonly message?: string;
	readonly includeUntracked?: boolean;
	readonly keepIndex?: boolean;
}

/**
 * One Git repository: the `vscode.git` API object plus the queries and verbs that the API does
 * not expose. Holds no repository data itself; every query reads fresh state from git.
 */
export class GitRepository {
	readonly root: string;
	readonly name: string;
	private readonly queue = new SerialQueue();
	private stateFiles: Promise<Record<StateFile, string>> | undefined;

	constructor(readonly api: Repository, private readonly cli: GitCli) {
		this.root = api.rootUri.fsPath;
		this.name = path.basename(this.root);
	}

	get rootUri(): vscode.Uri {
		return this.api.rootUri;
	}

	get head(): Head | undefined {
		const head = this.api.state.HEAD;
		if (head?.name) {
			return { kind: 'branch', name: head.name };
		}
		if (head?.commit) {
			return { kind: 'detached', commit: head.commit };
		}
		return undefined;
	}

	get currentBranchName(): string | undefined {
		const head = this.head;
		return head?.kind === 'branch' ? head.name : undefined;
	}

	get remoteNames(): string[] {
		return this.api.state.remotes.map(remote => remote.name);
	}

	/** Serialises mutating operations started from this extension. */
	exclusive<T>(task: () => Promise<T>): Promise<T> {
		return this.queue.run(task);
	}

	git(args: readonly string[], token?: vscode.CancellationToken): Promise<string> {
		return this.cli.exec(this.root, args, token);
	}

	// ---- Queries -------------------------------------------------------------------------------

	async getRefs(token?: vscode.CancellationToken): Promise<RefsSnapshot> {
		const output = await this.git(['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags'], token);
		return parseRefs(output, this.remoteNames);
	}

	async getRecentBranches(isCandidate: (name: string) => boolean, limit: number, token?: vscode.CancellationToken): Promise<string[]> {
		try {
			const output = await this.git(['reflog', 'show', '--format=%gs', '-n', '500', 'HEAD', '--'], token);
			return parseRecentCheckouts(output, isCandidate, limit);
		} catch {
			// A repository without commits has no HEAD reflog yet.
			return [];
		}
	}

	async getOngoingOperation(): Promise<OngoingOperation | undefined> {
		const files = await this.getStateFiles();
		const checks: [StateFile, OngoingOperation][] = [
			['rebase-merge', 'rebase'],
			['rebase-apply', 'rebase'],
			['MERGE_HEAD', 'merge'],
			['CHERRY_PICK_HEAD', 'cherry-pick'],
			['REVERT_HEAD', 'revert'],
		];
		const present = await Promise.all(checks.map(([file]) => exists(files[file])));
		const index = present.indexOf(true);
		return index >= 0 ? checks[index][1] : undefined;
	}

	async getLastFetchTime(): Promise<Date | undefined> {
		const files = await this.getStateFiles();
		try {
			return (await fs.stat(files.FETCH_HEAD)).mtime;
		} catch {
			return undefined;
		}
	}

	async getConflictedFiles(): Promise<vscode.Uri[]> {
		const output = await this.git(['diff', '--name-only', '--diff-filter=U', '-z']);
		return parseNulSeparated(output).map(file => vscode.Uri.joinPath(this.rootUri, file));
	}

	/** Commits reachable from `from` but not from `into`; patches already applied to `into` are flagged. */
	async getCommitsMissing(from: string, into: string, max = 1000): Promise<CommitSummary[]> {
		const output = await this.git(['log', '--cherry-mark', '--right-only', `--format=${LOG_FORMAT}`, '-n', String(max), `${into}...${from}`, '--']);
		return parseLog(output);
	}

	/** Commits on `ref` that are not on any branch of `remote` (what a first push would publish). */
	async getUnpublishedCommits(ref: string, remote: string, max = 1000): Promise<CommitSummary[]> {
		const output = await this.git(['log', `--format=${LOG_FORMAT}`, '-n', String(max), ref, '--not', `--remotes=${remote}`, '--']);
		return parseLog(output);
	}

	async countCommits(range: string): Promise<number> {
		const output = await this.git(['rev-list', '--count', range, '--']);
		return Number(output.trim()) || 0;
	}

	async getStashes(): Promise<StashEntry[]> {
		return parseStashes(await this.git(['stash', 'list', `--format=${STASH_FORMAT}`]));
	}

	/** Resolves a revision to a commit hash, or undefined when it does not name a commit. */
	async resolveCommit(revision: string): Promise<string | undefined> {
		try {
			return (await this.git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`])).trim() || undefined;
		} catch {
			return undefined;
		}
	}

	/** Whether `relativePath` (slash-separated, relative to the root) exists in `ref`. */
	async existsInRef(ref: string, relativePath: string): Promise<boolean> {
		try {
			await this.git(['cat-file', '-e', `${ref}:${relativePath}`]);
			return true;
		} catch {
			return false;
		}
	}

	async getCommitChanges(hash: string): Promise<{ parent: string; changes: Change[] }> {
		const parent = (await this.resolveCommit(`${hash}^`)) ?? EMPTY_TREE;
		return { parent, changes: await this.api.diffBetween(parent, hash) };
	}

	diffWithWorkingTree(ref: string): Promise<Change[]> {
		return this.api.diffWith(ref);
	}

	hasLocalChanges(): boolean {
		const { workingTreeChanges, indexChanges, untrackedChanges } = this.api.state;
		return workingTreeChanges.length + indexChanges.length + untrackedChanges.length > 0;
	}

	// ---- Local mutations -----------------------------------------------------------------------

	checkout(ref: string): Promise<void> {
		return this.api.checkout(ref);
	}

	createBranch(name: string, startPoint: string, checkout: boolean): Promise<void> {
		return this.api.createBranch(name, checkout, startPoint);
	}

	setUpstream(branch: string, upstream: string): Promise<void> {
		return this.api.setBranchUpstream(branch, upstream);
	}

	async renameBranch(oldName: string, newName: string): Promise<void> {
		await this.git(['branch', '--move', oldName, newName]);
	}

	async unsetUpstream(branch: string): Promise<void> {
		await this.git(['branch', '--unset-upstream', branch]);
	}

	/** `git checkout --force [-b <name>] <ref>`: discards local changes that would block the checkout. */
	async forceCheckout(ref: string, newBranch?: string): Promise<void> {
		await this.git(['checkout', '--force', ...(newBranch ? ['-b', newBranch] : []), ref]);
	}

	deleteBranch(name: string, force: boolean): Promise<void> {
		return this.api.deleteBranch(name, force);
	}

	async merge(ref: string, options: readonly MergeOption[] = [], message?: string): Promise<void> {
		const messageArgs = message ? ['-m', message] : [];
		await this.git(['merge', '--autostash', '--no-edit', ...options, ...messageArgs, ref]);
	}

	async rebase(request: RebaseRequest): Promise<void> {
		const args = ['rebase', '--autostash', ...(request.flags ?? [])];
		if (request.root) {
			args.push('--root', '--onto', request.upstream);
		} else if (request.newBase) {
			args.push('--onto', request.newBase, request.upstream);
		} else {
			args.push(request.upstream);
		}
		if (request.branch) {
			args.push(request.branch);
		}
		await this.git(args);
	}

	/** Applies the given commits in order; pass them oldest first. */
	async cherryPick(hashes: readonly string[]): Promise<void> {
		await this.git(['cherry-pick', ...hashes]);
	}

	async reset(ref: string, mode: ResetMode): Promise<void> {
		await this.git(['reset', `--${mode}`, ref]);
	}

	async abort(operation: OngoingOperation): Promise<void> {
		await this.git([operation, '--abort']);
	}

	async continue(operation: Exclude<OngoingOperation, 'merge'>): Promise<void> {
		await this.git([operation, '--continue']);
	}

	async skipRebaseCommit(): Promise<void> {
		await this.git(['rebase', '--skip']);
	}

	async commitMerge(): Promise<void> {
		await this.git(['commit', '--no-edit']);
	}

	async stash(request: StashRequest): Promise<void> {
		const args = ['stash', 'push'];
		if (request.includeUntracked) {
			args.push('--include-untracked');
		}
		if (request.keepIndex) {
			args.push('--keep-index');
		}
		if (request.message) {
			args.push('--message', request.message);
		}
		await this.git(args);
	}

	applyStash(index: number): Promise<void> {
		return this.api.applyStash(index);
	}

	popStash(index: number): Promise<void> {
		return this.api.popStash(index);
	}

	dropStash(index: number): Promise<void> {
		return this.api.dropStash(index);
	}

	async stashToBranch(branch: string, stashRef: string): Promise<void> {
		await this.git(['stash', 'branch', branch, stashRef]);
	}

	async clearStashes(): Promise<void> {
		await this.git(['stash', 'clear']);
	}

	tag(name: string, message: string, ref?: string): Promise<void> {
		return this.api.tag(name, message, ref);
	}

	deleteTag(name: string): Promise<void> {
		return this.api.deleteTag(name);
	}

	async restoreTag(name: string, commit: string): Promise<void> {
		await this.git(['tag', name, commit]);
	}

	addRemote(name: string, url: string): Promise<void> {
		return this.api.addRemote(name, url);
	}

	removeRemote(name: string): Promise<void> {
		return this.api.removeRemote(name);
	}

	renameRemote(name: string, newName: string): Promise<void> {
		return this.api.renameRemote(name, newName);
	}

	async setRemoteUrl(name: string, url: string): Promise<void> {
		await this.git(['remote', 'set-url', name, url]);
	}

	// ---- Network (through the API, so VS Code handles authentication) ---------------------------

	fetchAll(): Promise<void> {
		return this.api.fetch({ all: true });
	}

	fetch(remote: string, ref?: string): Promise<void> {
		return this.api.fetch({ remote, ref });
	}

	/**
	 * Fast-forwards a branch that is not checked out to its upstream with
	 * `git fetch <remote> <remoteRef>:<branch>`; git rejects the update unless it is a fast-forward.
	 */
	fastForward(branch: LocalBranch): Promise<void> {
		const upstream = branch.upstream;
		if (!upstream) {
			return Promise.reject(new Error(`Tracked branch is not configured for '${branch.name}'`));
		}
		return this.api.fetch({ remote: upstream.remote, ref: `${upstream.remoteRef}:${branch.fullName}` });
	}

	push(remote: string, branch: string, setUpstream: boolean, force: boolean): Promise<void> {
		return this.api.push(remote, branch, setUpstream, force ? FORCE_WITH_LEASE : undefined);
	}

	deleteRemoteBranch(remote: string, branchName: string): Promise<void> {
		return this.api.push(remote, `:refs/heads/${branchName}`);
	}

	pushTag(remote: string, tag: string): Promise<void> {
		return this.api.push(remote, `refs/tags/${tag}`);
	}

	private getStateFiles(): Promise<Record<StateFile, string>> {
		this.stateFiles ??= this.git(['rev-parse', ...STATE_FILES.flatMap(file => ['--git-path', file])]).then(
			output => {
				const lines = output.split('\n');
				const entries = STATE_FILES.map((file, index) => [file, path.resolve(this.root, lines[index] ?? '')]);
				return Object.fromEntries(entries) as Record<StateFile, string>;
			},
			error => {
				this.stateFiles = undefined;
				throw error;
			},
		);
		return this.stateFiles;
	}
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}
