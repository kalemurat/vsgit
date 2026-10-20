import * as vscode from 'vscode';
import type { RepositoryRegistry } from '../git/repositoryRegistry';
import type { Change, Status } from '../typings/git';

// Values of the `Status` const enum in git.d.ts (not inlinable by esbuild).
const INDEX_ADDED = 1 as Status;
const INDEX_DELETED = 2 as Status;
const DELETED = 6 as Status;
const UNTRACKED = 7 as Status;

type ChangeResource = [label: vscode.Uri, original: vscode.Uri | undefined, modified: vscode.Uri | undefined];

/**
 * Opens the multi-file changes editor (`vscode.changes`) for a set of changes between `leftRef`
 * and `rightRef`, where an undefined `rightRef` means the working tree.
 */
export async function openChanges(registry: RepositoryRegistry, title: string, changes: readonly Change[], leftRef: string, rightRef?: string): Promise<void> {
	const resources: ChangeResource[] = changes.map(change => {
		const added = change.status === INDEX_ADDED || change.status === UNTRACKED;
		const deleted = change.status === DELETED || change.status === INDEX_DELETED;
		const original = added ? undefined : registry.toGitUri(change.originalUri, leftRef);
		const modified = deleted ? undefined : rightRef ? registry.toGitUri(change.uri, rightRef) : change.uri;
		return [change.uri, original, modified];
	});
	await vscode.commands.executeCommand('vscode.changes', title, resources);
}
