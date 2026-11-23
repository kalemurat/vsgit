/** Error codes the built-in Git extension attaches as `gitErrorCode` (see `GitErrorCodes` in git.d.ts). */
export const GitErrorCode = {
	BranchNotFullyMerged: 'BranchNotFullyMerged',
	BranchFastForwardRejected: 'BranchFastForwardRejected',
	DirtyWorkTree: 'DirtyWorkTree',
	LocalChangesOverwritten: 'LocalChangesOverwritten',
	PushRejected: 'PushRejected',
	ForcePushWithLeaseRejected: 'ForcePushWithLeaseRejected',
} as const;

export function gitErrorCode(error: unknown): string | undefined {
	const code = (error as { gitErrorCode?: unknown } | undefined)?.gitErrorCode;
	return typeof code === 'string' ? code : undefined;
}

function rawErrorText(error: unknown): string {
	if (error && typeof error === 'object') {
		const { stderr, message } = error as { stderr?: unknown; message?: unknown };
		if (typeof stderr === 'string' && stderr.trim()) {
			return stderr;
		}
		if (typeof message === 'string') {
			return message;
		}
	}
	return String(error);
}

/** Full error text for the log. */
export function errorDetails(error: unknown): string {
	return rawErrorText(error).trim();
}

/** A short, user-facing summary: git's hint lines are dropped and the text is capped. */
export function errorSummary(error: unknown, maxLines = 3): string {
	const lines = rawErrorText(error)
		.split('\n')
		.map(line => line.trim())
		.filter(line => line && !line.startsWith('hint:'))
		.map(line => line.replace(/^(error|fatal):\s*/, ''));
	return lines.slice(0, maxLines).join(' ') || 'Unknown error';
}

/** Matches git's refusal to change files that have local modifications (checkout/merge/cherry-pick). */
export function isLocalChangesError(error: unknown): boolean {
	const code = gitErrorCode(error);
	if (code === GitErrorCode.LocalChangesOverwritten || code === GitErrorCode.DirtyWorkTree) {
		return true;
	}
	return /local changes to the following files would be overwritten|untracked working tree files would be overwritten/.test(rawErrorText(error));
}

export function isNotFullyMergedError(error: unknown): boolean {
	return gitErrorCode(error) === GitErrorCode.BranchNotFullyMerged || /is not fully merged/.test(rawErrorText(error));
}

export function isFastForwardRejected(error: unknown): boolean {
	return gitErrorCode(error) === GitErrorCode.BranchFastForwardRejected || /\(non-fast-forward\)/.test(rawErrorText(error));
}

export function isPushRejected(error: unknown): boolean {
	return gitErrorCode(error) === GitErrorCode.PushRejected;
}
