import * as vscode from 'vscode';
import type { Flows } from './flows/context';
import { Commands, type OperationRunner } from './flows/runner';
import { errorSummary } from './git/errors';
import type { GitRepository } from './git/gitRepository';
import type { RepositoryRegistry } from './git/repositoryRegistry';
import type { BranchesPopup } from './ui/branchesPopup';
import type { GitMenu } from './ui/gitMenu';

export const CommandIds = {
	showGitMenu: 'vsgit.showGitMenu',
	showBranches: 'vsgit.showBranches',
	updateProject: 'vsgit.updateProject',
	pull: 'vsgit.pull',
	fetch: 'vsgit.fetch',
	push: 'vsgit.push',
	merge: 'vsgit.merge',
	rebase: 'vsgit.rebase',
	newBranch: 'vsgit.newBranch',
	newTag: 'vsgit.newTag',
	resetHead: 'vsgit.resetHead',
	checkoutRevision: 'vsgit.checkoutRevision',
	stash: 'vsgit.stash',
	unstash: 'vsgit.unstash',
	manageRemotes: 'vsgit.manageRemotes',
	compareWithBranch: 'vsgit.compareWithBranch',
	showFileHistory: 'vsgit.showFileHistory',
	annotateFile: 'vsgit.annotateFile',
	resolveConflicts: Commands.resolveConflicts,
	abortOperation: Commands.abortOperation,
} as const;

interface CommandServices {
	readonly registry: RepositoryRegistry;
	readonly runner: OperationRunner;
	readonly flows: Flows;
	readonly branchesPopup: BranchesPopup;
	readonly gitMenu: GitMenu;
}

/**
 * Runs a built-in command that works on the active editor, first opening the file that a context
 * menu (explorer, editor tab) passed in.
 */
async function onFile(argument: unknown, command: string): Promise<void> {
	if (argument instanceof vscode.Uri && vscode.window.activeTextEditor?.document.uri.toString() !== argument.toString()) {
		await vscode.window.showTextDocument(argument);
	}
	await vscode.commands.executeCommand(command);
}

/** Registers every `vsgit.*` command declared in package.json. */
export function registerCommands(services: CommandServices): vscode.Disposable {
	const { registry, runner, flows, branchesPopup, gitMenu } = services;

	const register = (id: string, handler: (...args: unknown[]) => unknown): vscode.Disposable =>
		vscode.commands.registerCommand(id, async (...args: unknown[]) => {
			try {
				await handler(...args);
			} catch (error) {
				runner.error(errorSummary(error));
			}
		});

	/** Commands receive a SourceControl (from SCM menus), a Uri, or nothing (palette/status bar). */
	const withRepository = (id: string, handler: (repository: GitRepository) => unknown): vscode.Disposable =>
		register(id, (argument?: unknown) => {
			const repository = registry.resolve(argument);
			if (!repository) {
				runner.error('No Git repository is open');
				return;
			}
			return handler(repository);
		});

	const allRepositories = (id: string, handler: (repositories: readonly GitRepository[]) => unknown): vscode.Disposable =>
		register(id, () => registry.all.length > 0 ? handler(registry.all) : runner.error('No Git repository is open'));

	return vscode.Disposable.from(
		withRepository(CommandIds.showGitMenu, repository => gitMenu.show(repository)),
		withRepository(CommandIds.showBranches, repository => branchesPopup.show(repository)),
		allRepositories(CommandIds.updateProject, repositories => flows.sync.updateProject(repositories)),
		allRepositories(CommandIds.fetch, repositories => flows.sync.fetch(repositories)),
		withRepository(CommandIds.pull, repository => flows.sync.pull(repository)),
		withRepository(CommandIds.push, repository => flows.sync.push(repository)),
		withRepository(CommandIds.merge, repository => flows.integration.merge(repository)),
		withRepository(CommandIds.rebase, repository => flows.integration.rebase(repository)),
		withRepository(CommandIds.newBranch, repository => flows.branches.newBranch(repository)),
		withRepository(CommandIds.newTag, repository => flows.branches.newTag(repository)),
		withRepository(CommandIds.resetHead, repository => flows.integration.resetHead(repository)),
		withRepository(CommandIds.checkoutRevision, repository => flows.branches.checkoutRevision(repository)),
		withRepository(CommandIds.stash, repository => flows.workspace.stash(repository)),
		withRepository(CommandIds.unstash, repository => flows.workspace.unstash(repository)),
		withRepository(CommandIds.manageRemotes, repository => flows.workspace.manageRemotes(repository)),
		withRepository(CommandIds.resolveConflicts, repository => flows.integration.resolveConflicts(repository)),
		withRepository(CommandIds.abortOperation, repository => flows.integration.abort(repository)),
		register(CommandIds.compareWithBranch, (argument?: unknown) =>
			flows.workspace.compareFileWithRef(argument instanceof vscode.Uri ? argument : undefined)),
		register(CommandIds.showFileHistory, (argument?: unknown) => onFile(argument, 'timeline.focus')),
		register(CommandIds.annotateFile, (argument?: unknown) => onFile(argument, 'git.blame.toggleEditorDecoration')),
	);
}
