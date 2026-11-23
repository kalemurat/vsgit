import * as vscode from 'vscode';
import { CommandIds, registerCommands } from './commands';
import { FavoritesStore } from './favorites';
import { BranchFlows } from './flows/branchFlows';
import type { FlowContext, Flows } from './flows/context';
import { IntegrationFlows } from './flows/integrationFlows';
import { OperationRunner } from './flows/runner';
import { SyncFlows } from './flows/syncFlows';
import { WorkspaceFlows } from './flows/workspaceFlows';
import { RepositoryRegistry } from './git/repositoryRegistry';
import type { API, GitExtension } from './typings/git';
import { BranchesPopup } from './ui/branchesPopup';
import { GitMenu } from './ui/gitMenu';
import { BranchStatusBar } from './ui/statusBar';
import { DisposableStore } from './util/disposable';

/** Exposed to the integration tests. */
export interface VsgitApi {
	readonly registry: RepositoryRegistry | undefined;
	readonly flows: Flows | undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<VsgitApi> {
	const log = vscode.window.createOutputChannel('VSGit', { log: true });
	context.subscriptions.push(log);

	const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
	if (!gitExtension) {
		log.error('The built-in Git extension (vscode.git) is not available');
		return { registry: undefined, flows: undefined };
	}
	const git = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();

	// Services exist only while the built-in Git extension is enabled (`git.enabled`).
	let services: Services | undefined;
	const setUp = async (enabled: boolean): Promise<void> => {
		services?.dispose();
		services = undefined;
		if (enabled) {
			const api = git.getAPI(1);
			await whenInitialized(api, context);
			services = new Services(api, context, log);
		}
	};
	context.subscriptions.push(
		git.onDidChangeEnablement(enabled => void setUp(enabled)),
		{ dispose: () => services?.dispose() },
	);
	await setUp(git.enabled);

	return {
		get registry() {
			return services?.registry;
		},
		get flows() {
			return services?.flows;
		},
	};
}

export function deactivate(): void {
	// Everything is released through context.subscriptions.
}

class Services implements vscode.Disposable {
	private readonly disposables = new DisposableStore();
	readonly registry: RepositoryRegistry;
	readonly flows: Flows;

	constructor(api: API, context: vscode.ExtensionContext, log: vscode.LogOutputChannel) {
		this.registry = this.disposables.add(new RepositoryRegistry(api));
		const runner = new OperationRunner(log);
		const ctx: FlowContext = { registry: this.registry, runner, favorites: new FavoritesStore(context.workspaceState) };

		const flows = {} as { -readonly [K in keyof Flows]: Flows[K] };
		flows.sync = new SyncFlows(ctx, flows);
		flows.branches = new BranchFlows(ctx, flows);
		flows.integration = new IntegrationFlows(ctx, flows);
		flows.workspace = new WorkspaceFlows(ctx);
		this.flows = flows;

		const branchesPopup = new BranchesPopup(ctx, flows);
		const gitMenu = new GitMenu(ctx, flows, branchesPopup);
		this.disposables.add(registerCommands({ registry: this.registry, runner, flows, branchesPopup, gitMenu }));
		this.disposables.add(new BranchStatusBar(this.registry, CommandIds.showBranches));
	}

	dispose(): void {
		this.disposables.dispose();
	}
}

function whenInitialized(api: API, context: vscode.ExtensionContext): Promise<void> {
	if (api.state === 'initialized') {
		return Promise.resolve();
	}
	return new Promise(resolve => {
		const subscription = api.onDidChangeState(state => {
			if (state === 'initialized') {
				subscription.dispose();
				resolve();
			}
		});
		context.subscriptions.push(subscription);
	});
}
