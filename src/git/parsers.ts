import type { CommitSummary, LocalBranch, RefsSnapshot, RemoteBranch, StashEntry, Tag, Upstream } from './types';

const FIELD = '\0';
const RECORD = '\x1e';

export const REF_FORMAT = [
	'%(refname)',
	'%(objectname)',
	'%(*objectname)',
	'%(HEAD)',
	'%(upstream)',
	'%(upstream:remotename)',
	'%(upstream:remoteref)',
	'%(upstream:track,nobracket)',
].join('%00');

export const LOG_FORMAT = ['%m', '%H', '%h', '%an', '%ct', '%s'].join('%x00') + '%x1e';

export const STASH_FORMAT = ['%gd', '%ct', '%gs'].join('%x00');

const HEADS = 'refs/heads/';
const REMOTES = 'refs/remotes/';
const TAGS = 'refs/tags/';

export interface TrackInfo {
	readonly ahead: number;
	readonly behind: number;
	readonly gone: boolean;
}

/** Parses `%(upstream:track,nobracket)`: "ahead 1, behind 2", "behind 3", "gone" or "". */
export function parseTrack(track: string): TrackInfo {
	if (track === 'gone') {
		return { ahead: 0, behind: 0, gone: true };
	}
	const ahead = /ahead (\d+)/.exec(track);
	const behind = /behind (\d+)/.exec(track);
	return {
		ahead: ahead ? Number(ahead[1]) : 0,
		behind: behind ? Number(behind[1]) : 0,
		gone: false,
	};
}

export function shortRefName(fullName: string): string {
	for (const prefix of [HEADS, REMOTES, TAGS]) {
		if (fullName.startsWith(prefix)) {
			return fullName.slice(prefix.length);
		}
	}
	return fullName;
}

/** Splits `origin/feature/x` into remote and branch, preferring the longest known remote name. */
export function splitRemoteBranch(shortName: string, remoteNames: readonly string[]): { remote: string; branchName: string } {
	let remote = '';
	for (const candidate of remoteNames) {
		if (shortName.startsWith(`${candidate}/`) && candidate.length > remote.length) {
			remote = candidate;
		}
	}
	if (!remote) {
		const slash = shortName.indexOf('/');
		remote = slash > 0 ? shortName.slice(0, slash) : shortName;
	}
	return { remote, branchName: shortName.slice(remote.length + 1) };
}

/** Parses the output of `git for-each-ref --format=REF_FORMAT`. */
export function parseRefs(output: string, remoteNames: readonly string[]): RefsSnapshot {
	const local: LocalBranch[] = [];
	const remote: RemoteBranch[] = [];
	const tags: Tag[] = [];

	for (const line of output.split('\n')) {
		if (!line) {
			continue;
		}
		const [fullName, objectName, peeled, head, upstreamRef, upstreamRemote, upstreamRemoteRef, track] = line.split(FIELD);
		const commit = peeled || objectName;
		const name = shortRefName(fullName);

		if (fullName.startsWith(HEADS)) {
			const trackInfo = parseTrack(track ?? '');
			const upstream: Upstream | undefined = upstreamRef
				? { ref: upstreamRef, name: shortRefName(upstreamRef), remote: upstreamRemote || '.', remoteRef: upstreamRemoteRef || upstreamRef }
				: undefined;
			local.push({
				kind: 'local',
				fullName,
				name,
				commit,
				isCurrent: head === '*',
				upstream,
				ahead: trackInfo.ahead,
				behind: trackInfo.behind,
				upstreamGone: trackInfo.gone,
			});
		} else if (fullName.startsWith(REMOTES)) {
			// `origin/HEAD` is a symbolic pointer to the default branch, not a branch of its own.
			if (name.endsWith('/HEAD')) {
				continue;
			}
			const { remote: remoteName, branchName } = splitRemoteBranch(name, remoteNames);
			remote.push({ kind: 'remote', fullName, name, commit, remote: remoteName, branchName });
		} else if (fullName.startsWith(TAGS)) {
			tags.push({ kind: 'tag', fullName, name, commit });
		}
	}

	return { local, remote, tags };
}

/** Extracts recently checked-out branch names from `git reflog --format=%gs`, newest first. */
export function parseRecentCheckouts(output: string, isCandidate: (name: string) => boolean, limit: number): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const line of output.split('\n')) {
		const match = /^checkout: moving from (\S+) to (\S+)$/.exec(line);
		if (!match) {
			continue;
		}
		// Newest entry first: the branch moved to was checked out after the one moved from.
		for (const name of [match[2], match[1]]) {
			if (seen.has(name)) {
				continue;
			}
			seen.add(name);
			if (isCandidate(name)) {
				result.push(name);
				if (result.length >= limit) {
					return result;
				}
			}
		}
	}
	return result;
}

/** Parses `git log --format=LOG_FORMAT`; `%m` is `=` for commits marked by `--cherry-mark`. */
export function parseLog(output: string): CommitSummary[] {
	const commits: CommitSummary[] = [];
	for (const raw of output.split(RECORD)) {
		const record = raw.replace(/^\n/, '');
		if (!record) {
			continue;
		}
		const [mark, hash, shortHash, author, timestamp, subject] = record.split(FIELD);
		if (!hash) {
			continue;
		}
		commits.push({
			hash,
			shortHash,
			author,
			date: new Date(Number(timestamp) * 1000),
			subject: subject ?? '',
			equivalentExists: mark === '=',
		});
	}
	return commits;
}

/** Parses `git stash list --format=STASH_FORMAT`. */
export function parseStashes(output: string): StashEntry[] {
	const stashes: StashEntry[] = [];
	for (const line of output.split('\n')) {
		if (!line) {
			continue;
		}
		const [ref, timestamp, message] = line.split(FIELD);
		const index = /^stash@\{(\d+)\}$/.exec(ref);
		if (!index) {
			continue;
		}
		stashes.push({ index: Number(index[1]), ref, message: message ?? '', date: new Date(Number(timestamp) * 1000) });
	}
	return stashes;
}

/** Splits NUL-separated path output (`-z`). */
export function parseNulSeparated(output: string): string[] {
	return output.split('\0').filter(Boolean);
}
