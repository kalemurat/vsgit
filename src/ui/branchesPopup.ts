import * as vscode from 'vscode';
import type { FlowContext, Flows } from '../flows/context';
import type { GitRepository } from '../git/gitRepository';
import type { GitRef, OngoingOperation, RefsSnapshot } from '../git/types';
import { Settings } from '../settings';
import { fromNow, quote } from '../util/format';
import { buildBranchActions, type BranchAction } from './branchActions';
import { commandItem, ongoingOperationItems, type CommandItem } from './menuItems';
import { separator, showPicker, type PickerButton, type PickerController, type Separator } from './quickInput';
import { refDescription, refIcon } from './refItems';

interface RefItem extends vscode.QuickPickItem {
	readonly type: 'ref';
	readonly ref: GitRef;
}

type PopupItem = RefItem | CommandItem;

interface ActionItem extends vscode.QuickPickItem {
	readonly action: BranchAction;
}

interface PopupData {
	readonly refs: RefsSnapshot;
	readonly recent: readonly string[];
	readonly ongoing: OngoingOperation | undefined;
	readonly lastFetch: Date | undefined;
}

const RECENT_LIMIT = 5;
const FAVORITE_ON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('star-full'), tooltip: 'Unmark as Favorite' };
const FAVORITE_OFF: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('star-empty'), tooltip: 'Mark as Favorite' };

// Shortcuts shown when hovering a ref; each runs the same action as the matching submenu entry.
const UPDATE_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('repo-pull'), tooltip: 'Update (without checkout)' };
const COMPARE_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('git-compare'), tooltip: 'Compare with Current' };
const COMPARE_FILE_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('diff-single'), tooltip: 'Compare Current File with This Ref' };
const MORE_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('ellipsis'), tooltip: 'More Actions…' };
const SHORTCUT_BUTTONS = [UPDATE_BUTTON, COMPARE_BUTTON, COMPARE_FILE_BUTTON, MORE_BUTTON];

const KIND_LABELS: Record<GitRef['kind'], string> = { local: 'Branch', remote: 'Remote Branch', tag: 'Tag' };

/**
 * The counterpart of WebStorm's Branches popup: top-level actions, then Recent / Local / Remote /
 * Tags with incoming/outgoing markers and favorites; choosing a ref opens its action submenu.
 */
export class BranchesPopup {
	constructor(private readonly ctx: FlowContext, private readonly flows: Flows) {}

	async show(initial: GitRepository): Promise<void> {
		let repository = initial;
		for (;;) {
			let data: PopupData | undefined;
			const load = async (): Promise<readonly (PopupItem | Separator)[]> => {
				data = await this.load(repository);
				return this.buildItems(repository, data);
			};
			const result = await showPicker<PopupItem>({
				title: this.title(repository),
				placeholder: 'Search for branches and actions',
				items: load,
				buttons: this.buttons(repository, load),
				closingItemButtons: SHORTCUT_BUTTONS,
				onDidTriggerItemButton: async (event, controller) => {
					if (event.item.type === 'ref' && data) {
						await this.ctx.favorites.toggle(repository.root, event.item.ref.fullName);
						controller.setItems(this.buildItems(repository, data));
					}
				},
			});

			if (result.kind === 'button' && result.id === 'repository') {
				const picked = await this.pickRepository(repository);
				if (picked) {
					repository = picked;
					continue;
				}
				return;
			}
			if (result.kind === 'button' && result.id === 'settings') {
				await vscode.commands.executeCommand('workbench.action.openSettings', 'vsgit.branches');
				return;
			}
			if (result.kind === 'itemButton' && result.item.type === 'ref' && result.button !== MORE_BUTTON) {
				await this.runShortcut(repository, result.item.ref, result.button);
				return;
			}
			if (result.kind !== 'accept' && result.kind !== 'itemButton') {
				return;
			}
			if (result.item.type === 'command') {
				await result.item.run();
				return;
			}
			const action = await this.pickAction(repository, result.item.ref);
			if (action === 'back') {
				continue;
			}
			if (action) {
				await this.runAction(repository, action);
			}
			return;
		}
	}

	private title(repository: GitRepository): string {
		return this.ctx.registry.all.length > 1 ? `Branches — ${repository.name}` : 'Branches';
	}

	private buttons(repository: GitRepository, load: () => Promise<readonly (PopupItem | Separator)[]>): PickerButton<PopupItem>[] {
		const buttons: PickerButton<PopupItem>[] = [{
			id: 'fetch',
			iconPath: new vscode.ThemeIcon('cloud-download'),
			tooltip: 'Fetch All Remotes',
			keepOpen: async (controller: PickerController<PopupItem>) => {
				controller.setBusy(true);
				try {
					await this.flows.sync.fetch([repository]);
					controller.setItems(await load());
				} finally {
					controller.setBusy(false);
				}
			},
		}];
		if (this.ctx.registry.all.length > 1) {
			buttons.push({ id: 'repository', iconPath: new vscode.ThemeIcon('repo'), tooltip: 'Select Repository' });
		}
		buttons.push({ id: 'settings', iconPath: new vscode.ThemeIcon('settings-gear'), tooltip: 'Branches Popup Settings' });
		return buttons;
	}

	private async load(repository: GitRepository): Promise<PopupData> {
		const [refs, ongoing, lastFetch] = await Promise.all([
			repository.getRefs(),
			repository.getOngoingOperation(),
			repository.getLastFetchTime(),
		]);
		let recent: string[] = [];
		if (Settings.showRecentBranches) {
			const candidates = new Set(refs.local.filter(branch => !branch.isCurrent).map(branch => branch.name));
			recent = await repository.getRecentBranches(name => candidates.has(name), RECENT_LIMIT);
		}
		return { refs, recent, ongoing, lastFetch };
	}

	private buildItems(repository: GitRepository, data: PopupData): (PopupItem | Separator)[] {
		const favorites = this.ctx.favorites.get(repository.root);
		const all = this.ctx.registry.all;
		const items: (PopupItem | Separator)[] = [];

		const ongoing = ongoingOperationItems(data.ongoing, repository, this.flows);
		if (ongoing.length > 0) {
			items.push(...ongoing, separator());
		}
		items.push(
			commandItem('Update Project…', () => this.flows.sync.updateProject(all), 'repo-pull'),
			commandItem('Commit…', () => vscode.commands.executeCommand('workbench.view.scm'), 'check'),
			commandItem('Push…', () => this.flows.sync.push(repository), 'repo-push'),
			separator(),
			commandItem('New Branch…', () => this.flows.branches.newBranch(repository), 'add'),
			commandItem('Checkout Tag or Revision…', () => this.flows.branches.checkoutRevision(repository), 'tag'),
		);

		const activeFile = this.activeFile(repository);
		const toItem = (ref: GitRef): RefItem => {
			const favorite = favorites.has(ref.fullName);
			return {
				type: 'ref',
				ref,
				label: ref.name,
				iconPath: refIcon(ref, favorite),
				description: refDescription(ref),
				buttons: [...shortcutButtons(ref, activeFile !== undefined), favorite ? FAVORITE_ON : FAVORITE_OFF],
			};
		};
		// Favorites first, then the rest in git's (alphabetical) order.
		const section = (label: string, refs: readonly GitRef[]): void => {
			if (refs.length === 0) {
				return;
			}
			const sorted = [...refs.filter(ref => favorites.has(ref.fullName)), ...refs.filter(ref => !favorites.has(ref.fullName))];
			items.push(separator(label), ...sorted.map(toItem));
		};

		const byName = new Map(data.refs.local.map(branch => [branch.name, branch]));
		const recent = data.recent.flatMap(name => byName.get(name) ?? []);
		if (recent.length > 0) {
			items.push(separator('Recent'), ...recent.map(toItem));
		}
		const lastFetch = data.lastFetch ? ` · last fetch ${fromNow(data.lastFetch)}` : '';
		section('Local', data.refs.local);
		section(`Remote${lastFetch}`, data.refs.remote);
		if (Settings.showTags) {
			section('Tags', data.refs.tags);
		}
		return items;
	}

	private async pickAction(repository: GitRepository, ref: GitRef): Promise<BranchAction | 'back' | undefined> {
		const actions = buildBranchActions(ref, {
			currentBranch: repository.currentBranchName,
			remoteNames: repository.remoteNames,
			activeFile: this.activeFile(repository)?.fsPath,
		});
		const items: (ActionItem | Separator)[] = [];
		let group = actions[0]?.group;
		for (const action of actions) {
			if (action.group !== group) {
				items.push(separator());
				group = action.group;
			}
			items.push({ action, label: action.label });
		}
		const description = ref.kind === 'local' ? refDescription(ref) : undefined;
		const result = await showPicker<ActionItem>({
			title: `${KIND_LABELS[ref.kind]} ${quote(ref.name)}${description ? `  ${description}` : ''}`,
			placeholder: `Actions for ${quote(ref.name)}`,
			items,
			canGoBack: true,
		});
		if (result.kind === 'back') {
			return 'back';
		}
		return result.kind === 'accept' ? result.item.action : undefined;
	}

	private async runAction(repository: GitRepository, action: BranchAction): Promise<void> {
		const { branches, integration, sync } = this.flows;
		switch (action.id) {
			case 'checkout':
				await branches.checkout(repository, action.ref);
				break;
			case 'checkoutAndUpdate':
				await branches.checkoutAndUpdate(repository, action.ref);
				break;
			case 'newBranchFrom':
				await branches.newBranch(repository, action.ref);
				break;
			case 'checkoutAndRebase':
				await integration.checkoutAndRebase(repository, action.ref);
				break;
			case 'compareWithCurrent':
				await integration.compareWithCurrent(repository, action.ref);
				break;
			case 'showDiffWithWorkingTree':
				await integration.showDiffWithWorkingTree(repository, action.ref);
				break;
			case 'compareFileWith':
				await this.flows.workspace.compareFileWithRef(vscode.Uri.file(action.file), action.ref);
				break;
			case 'rebaseCurrentOnto':
				await integration.rebaseCurrentOnto(repository, action.ref);
				break;
			case 'mergeIntoCurrent':
				await integration.mergeInto(repository, action.ref);
				break;
			case 'update':
				await sync.updateBranch(repository, action.ref);
				break;
			case 'push':
				await sync.push(repository, action.ref);
				break;
			case 'pullUsingRebase':
				await sync.pullInto(repository, action.ref, 'rebase');
				break;
			case 'pullUsingMerge':
				await sync.pullInto(repository, action.ref, 'merge');
				break;
			case 'pushTag': {
				const { ref, remote } = action;
				await this.ctx.runner.run(repository, `Pushing tag ${ref.name} to ${remote}`, () => repository.pushTag(remote, ref.name));
				break;
			}
			case 'rename':
				await branches.rename(repository, action.ref);
				break;
			case 'delete':
				await branches.delete(repository, action.ref);
				break;
		}
	}

	private async runShortcut(repository: GitRepository, ref: GitRef, button: vscode.QuickInputButton): Promise<void> {
		if (button === UPDATE_BUTTON && ref.kind === 'local') {
			await this.flows.sync.updateBranch(repository, ref);
		} else if (button === COMPARE_BUTTON) {
			await this.flows.integration.compareWithCurrent(repository, ref);
		} else if (button === COMPARE_FILE_BUTTON) {
			await this.flows.workspace.compareFileWithRef(this.activeFile(repository), ref);
		}
	}

	/** The file in the active editor, when it belongs to `repository`. */
	private activeFile(repository: GitRepository): vscode.Uri | undefined {
		const uri = vscode.window.activeTextEditor?.document.uri;
		return uri?.scheme === 'file' && this.ctx.registry.forUri(uri) === repository ? uri : undefined;
	}

	private async pickRepository(current: GitRepository): Promise<GitRepository | undefined> {
		const result = await showPicker({
			title: 'Select Repository',
			items: this.ctx.registry.all.map(repository => ({
				repository,
				label: repository.name,
				description: repository.currentBranchName ?? 'detached',
				detail: repository.root,
				iconPath: new vscode.ThemeIcon('repo'),
			})),
			isActive: item => item.repository === current,
		});
		return result.kind === 'accept' ? result.item.repository : undefined;
	}
}

/** Hover shortcuts for a ref, in the order of its submenu; the current branch only gets "More". */
function shortcutButtons(ref: GitRef, hasActiveFile: boolean): vscode.QuickInputButton[] {
	if (ref.kind === 'local' && ref.isCurrent) {
		return [MORE_BUTTON];
	}
	const buttons: vscode.QuickInputButton[] = [];
	if (ref.kind === 'local' && ref.upstream && ref.behind > 0) {
		buttons.push(UPDATE_BUTTON);
	}
	if (ref.kind !== 'tag') {
		buttons.push(COMPARE_BUTTON);
	}
	if (hasActiveFile) {
		buttons.push(COMPARE_FILE_BUTTON);
	}
	buttons.push(MORE_BUTTON);
	return buttons;
}
