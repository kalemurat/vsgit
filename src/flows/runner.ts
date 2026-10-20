import * as vscode from 'vscode';
import { errorDetails, errorSummary } from '../git/errors';
import type { GitRepository } from '../git/gitRepository';
import { plural } from '../util/format';

export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

export interface RunOptions {
	/** Return true when the caller handles the error itself, which suppresses the default notification. */
	readonly handled?: (error: unknown) => boolean;
}

export const Commands = {
	resolveConflicts: 'vsgit.resolveConflicts',
	abortOperation: 'vsgit.abortOperation',
} as const;

/**
 * Executes repository operations one at a time per repository, shows progress in the status bar,
 * logs failures, and turns conflicts into an actionable notification.
 */
export class OperationRunner {
	constructor(private readonly log: vscode.LogOutputChannel) {}

	async run<T>(repository: GitRepository, title: string, task: () => Promise<T>, options: RunOptions = {}): Promise<Outcome<T>> {
		try {
			const value = await repository.exclusive(async () =>
				await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, task));
			return { ok: true, value };
		} catch (error) {
			this.log.error(`${title} failed in ${repository.root}\n${errorDetails(error)}`);
			if (!options.handled?.(error)) {
				void this.reportFailure(repository, title, error);
			}
			return { ok: false, error };
		}
	}

	info(message: string): void {
		this.log.info(message);
		void vscode.window.showInformationMessage(message);
	}

	error(message: string): void {
		this.log.error(message);
		void vscode.window.showErrorMessage(message);
	}

	private async reportFailure(repository: GitRepository, title: string, error: unknown): Promise<void> {
		const conflicts = await repository.getConflictedFiles().catch(() => []);
		if (conflicts.length > 0) {
			const resolve = 'Resolve Conflicts…';
			const abort = 'Abort';
			const choice = await vscode.window.showWarningMessage(
				`${title}: ${plural(conflicts.length, 'file')} with conflicts in '${repository.name}'.`, resolve, abort);
			if (choice === resolve) {
				await vscode.commands.executeCommand(Commands.resolveConflicts, repository.rootUri);
			} else if (choice === abort) {
				await vscode.commands.executeCommand(Commands.abortOperation, repository.rootUri);
			}
			return;
		}
		const showLog = 'Show Log';
		const choice = await vscode.window.showErrorMessage(`${title} failed: ${errorSummary(error)}`, showLog);
		if (choice === showLog) {
			this.log.show();
		}
	}
}
