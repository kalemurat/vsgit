import * as vscode from 'vscode';
import type { UpdateMethod } from './git/types';

const SECTION = 'vsgit';

/** Typed access to the `vsgit.*` settings declared in package.json. Values are read on demand. */
export const Settings = {
	get updateMethod(): UpdateMethod {
		return vscode.workspace.getConfiguration(SECTION).get<UpdateMethod>('updateMethod', 'merge');
	},

	setUpdateMethod(method: UpdateMethod): Thenable<void> {
		return vscode.workspace.getConfiguration(SECTION).update('updateMethod', method, vscode.ConfigurationTarget.Global);
	},

	get showRecentBranches(): boolean {
		return vscode.workspace.getConfiguration(SECTION).get<boolean>('branches.showRecent', true);
	},

	get showTags(): boolean {
		return vscode.workspace.getConfiguration(SECTION).get<boolean>('branches.showTags', true);
	},

	get statusBarEnabled(): boolean {
		return vscode.workspace.getConfiguration(SECTION).get<boolean>('statusBar.enabled', true);
	},

	affectsStatusBar(event: vscode.ConfigurationChangeEvent): boolean {
		return event.affectsConfiguration(`${SECTION}.statusBar`);
	},
};
