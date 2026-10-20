import type { FavoritesStore } from '../favorites';
import type { RepositoryRegistry } from '../git/repositoryRegistry';
import type { BranchFlows } from './branchFlows';
import type { IntegrationFlows } from './integrationFlows';
import type { OperationRunner } from './runner';
import type { SyncFlows } from './syncFlows';
import type { WorkspaceFlows } from './workspaceFlows';

export interface FlowContext {
	readonly registry: RepositoryRegistry;
	readonly runner: OperationRunner;
	readonly favorites: FavoritesStore;
}

/** All user-facing Git workflows. Flows reach each other through this object (e.g. push → update on rejection). */
export interface Flows {
	readonly sync: SyncFlows;
	readonly branches: BranchFlows;
	readonly integration: IntegrationFlows;
	readonly workspace: WorkspaceFlows;
}
