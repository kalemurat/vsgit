import * as vscode from 'vscode';
import type { GitRepository } from '../git/gitRepository';
import type { RepositoryRegistry } from '../git/repositoryRegistry';
import type { CommitSummary } from '../git/types';
import { fromNow } from '../util/format';
import { openChanges } from './changes';

export interface CommitPickItem extends vscode.QuickPickItem {
	readonly commit: CommitSummary;
}

export const SHOW_CHANGES_BUTTON: vscode.QuickInputButton = {
	iconPath: new vscode.ThemeIcon('diff-multiple'),
	tooltip: 'Show Changes',
};

export function toCommitItem(commit: CommitSummary, equivalentNote?: string): CommitPickItem {
	return {
		commit,
		label: commit.subject || commit.shortHash,
		description: `${commit.shortHash} · ${commit.author} · ${fromNow(commit.date)}`,
		detail: commit.equivalentExists ? equivalentNote : undefined,
		iconPath: new vscode.ThemeIcon(commit.equivalentExists ? 'check' : 'git-commit'),
		buttons: [SHOW_CHANGES_BUTTON],
	};
}

/** Opens the changes of one commit against its first parent in the multi-file diff editor. */
export async function openCommitChanges(registry: RepositoryRegistry, repository: GitRepository, commit: CommitSummary): Promise<void> {
	const { parent, changes } = await repository.getCommitChanges(commit.hash);
	await openChanges(registry, `${commit.shortHash} — ${commit.subject}`, changes, parent, commit.hash);
}
