import * as vscode from 'vscode';
import type { FlowContext, Flows } from '../flows/context';
import type { GitRepository } from '../git/gitRepository';
import type { BranchesPopup } from './branchesPopup';
import { commandItem, ongoingOperationItems, type CommandItem } from './menuItems';
import { separator, showPicker, type Separator } from './quickInput';

type MenuEntry = CommandItem | Separator;

interface Submenu {
	readonly title: string;
	readonly icon: string;
	readonly items: readonly MenuEntry[];
}

/**
 * The counterpart of WebStorm's main Git menu (IntelliJ `Git.MainMenu`), opened from the icon in
 * the Source Control title bar. Entries for interrupted operations appear only while one is running.
 */
export class GitMenu {
	constructor(private readonly ctx: FlowContext, private readonly flows: Flows, private readonly branchesPopup: BranchesPopup) {}

	async show(repository: GitRepository): Promise<void> {
		const [ongoing, conflicts] = await Promise.all([
			repository.getOngoingOperation(),
			repository.getConflictedFiles(),
		]);
		const { sync, branches, integration, workspace } = this.flows;
		const all = this.ctx.registry.all;
		const ongoingItems = ongoingOperationItems(ongoing, repository, this.flows);
		// Merge/rebase entries sit under their main action; cherry-pick/revert ones close the menu, as in WebStorm.
		const otherOngoing = ongoing === 'cherry-pick' || ongoing === 'revert' ? ongoingItems : [];

		const uncommitted: Submenu = {
			title: 'Uncommitted Changes',
			icon: 'files',
			items: [
				commandItem('Stash Changes…', () => workspace.stash(repository), 'archive'),
				commandItem('Unstash Changes…', () => workspace.unstash(repository), 'git-stash-pop'),
				commandItem('Rollback…', () => vscode.commands.executeCommand('git.cleanAll'), 'discard'),
			],
		};
		const editorUri = vscode.window.activeTextEditor?.document.uri;
		const fileInRepository = editorUri?.scheme === 'file' && this.ctx.registry.forUri(editorUri) !== undefined;
		const currentFile: Submenu = {
			title: 'Current File',
			icon: 'file',
			items: [
				commandItem('Annotate with Git Blame', () => vscode.commands.executeCommand('git.blame.toggleEditorDecoration'), 'person'),
				commandItem('Show History', () => vscode.commands.executeCommand('timeline.focus'), 'history'),
				commandItem('Compare with Branch or Tag…', () => workspace.compareFileWithRef(editorUri), 'git-compare'),
			],
		};

		const items: MenuEntry[] = [
			commandItem('Commit…', () => vscode.commands.executeCommand('workbench.view.scm'), 'check'),
			commandItem('Push…', () => sync.push(repository), 'repo-push'),
			commandItem('Update Project…', () => sync.updateProject(all), 'repo-pull'),
			commandItem('Pull…', () => sync.pull(repository), 'arrow-down'),
			commandItem('Fetch', () => sync.fetch(all), 'cloud-download'),
			separator(),
			commandItem('Merge…', () => integration.merge(repository), 'git-merge'),
			...(ongoing === 'merge' ? ongoingItems : []),
			commandItem('Rebase…', () => integration.rebase(repository), 'git-pull-request'),
			...(ongoing === 'rebase' ? ongoingItems : []),
			...(conflicts.length > 0 ? [commandItem('Resolve Conflicts…', () => integration.resolveConflicts(repository), 'warning', `${conflicts.length}`)] : []),
			separator(),
			commandItem('Branches…', () => this.branchesPopup.show(repository), 'git-branch'),
			commandItem('New Branch…', () => branches.newBranch(repository), 'add'),
			commandItem('New Tag…', () => branches.newTag(repository), 'tag'),
			commandItem('Reset HEAD…', () => integration.resetHead(repository), 'discard'),
			separator(),
			commandItem('Show Git Log', () => vscode.commands.executeCommand('workbench.scm.history.focus'), 'git-commit'),
			this.submenuItem(uncommitted, repository),
			...(fileInRepository ? [this.submenuItem(currentFile, repository)] : []),
			separator(),
			commandItem('Manage Remotes…', () => workspace.manageRemotes(repository), 'cloud'),
			commandItem('Clone…', () => vscode.commands.executeCommand('git.clone'), 'repo-clone'),
			...(otherOngoing.length > 0 ? [separator(), ...otherOngoing] : []),
		];

		const result = await showPicker<CommandItem>({
			title: all.length > 1 ? `Git — ${repository.name}` : 'Git',
			placeholder: 'Search Git actions',
			items,
		});
		if (result.kind === 'accept') {
			await result.item.run();
		}
	}

	private submenuItem(submenu: Submenu, repository: GitRepository): CommandItem {
		return commandItem(submenu.title, async () => {
			const result = await showPicker<CommandItem>({ title: submenu.title, items: submenu.items, canGoBack: true });
			if (result.kind === 'back') {
				await this.show(repository);
			} else if (result.kind === 'accept') {
				await result.item.run();
			}
		}, submenu.icon, '$(chevron-right)');
	}
}
