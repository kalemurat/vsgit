import * as vscode from 'vscode';
import type { Flows } from '../flows/context';
import type { GitRepository } from '../git/gitRepository';
import type { OngoingOperation } from '../git/types';

/** A menu entry that runs an action when accepted. */
export interface CommandItem extends vscode.QuickPickItem {
	readonly type: 'command';
	readonly run: () => Promise<unknown> | unknown;
}

export function commandItem(label: string, run: CommandItem['run'], icon?: string, description?: string): CommandItem {
	return { type: 'command', label, run, description, iconPath: icon ? new vscode.ThemeIcon(icon) : undefined };
}

/**
 * Abort/Continue entries for an interrupted operation (IntelliJ's `Git.Ongoing.Rebase.Actions`
 * group, plus Commit Merge in the main menu's merge group).
 */
export function ongoingOperationItems(operation: OngoingOperation | undefined, repository: GitRepository, flows: Flows, includeCommitMerge: boolean): CommandItem[] {
	const integration = flows.integration;
	switch (operation) {
		case 'rebase':
			return [
				commandItem('Abort Rebase', () => integration.abort(repository, 'rebase'), 'stop-circle'),
				commandItem('Continue Rebase', () => integration.continue(repository, 'rebase'), 'debug-continue'),
				commandItem('Skip Commit', () => integration.skipRebaseCommit(repository), 'debug-step-over'),
			];
		case 'merge':
			return [
				...(includeCommitMerge ? [commandItem('Commit Merge', () => integration.commitMerge(repository), 'check')] : []),
				commandItem('Abort Merge', () => integration.abort(repository, 'merge'), 'stop-circle'),
			];
		case 'cherry-pick':
			return [
				commandItem('Abort Cherry-Pick', () => integration.abort(repository, 'cherry-pick'), 'stop-circle'),
				commandItem('Continue Cherry-Pick', () => integration.continue(repository, 'cherry-pick'), 'debug-continue'),
			];
		case 'revert':
			return [commandItem('Abort Revert', () => integration.abort(repository, 'revert'), 'stop-circle')];
		default:
			return [];
	}
}
