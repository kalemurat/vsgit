import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { VsgitApi } from '../../extension';
import { isFastForwardRejected } from '../../git/errors';
import type { GitRepository } from '../../git/gitRepository';
import type { RepositoryRegistry } from '../../git/repositoryRegistry';
import type { GitExtension } from '../../typings/git';
import { buildBranchActions } from '../../ui/branchActions';
import { createFixture, type Fixture } from './fixture';

const EXTENSION_ID = 'undefined_publisher.vsgit';

async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 20000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined) {
			return value;
		}
		if (Date.now() > deadline) {
			throw new Error('Timed out waiting for condition');
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
}

suite('VSGit integration', function () {
	this.timeout(60000);

	let fixture: Fixture;
	let registry: RepositoryRegistry;
	let repository: GitRepository;

	suiteSetup(async () => {
		fixture = createFixture();
		const extension = vscode.extensions.getExtension<VsgitApi>(EXTENSION_ID);
		assert.ok(extension, 'extension is installed');
		const api = await extension.activate();
		assert.ok(api.registry, 'services are running');
		registry = api.registry;

		const git = vscode.extensions.getExtension<GitExtension>('vscode.git')!.exports.getAPI(1);
		await git.openRepository(vscode.Uri.file(fixture.work));
		repository = await waitFor(() => registry.all.find(candidate => candidate.root === fixture.work));
		await waitFor(() => repository.api.state.HEAD?.name === 'main' ? true : undefined);
	});

	suiteTeardown(() => fixture?.dispose());

	test('every command in package.json is registered', async () => {
		const manifest = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON as { contributes: { commands: { command: string }[] } };
		const registered = new Set(await vscode.commands.getCommands(true));
		for (const { command } of manifest.contributes.commands) {
			assert.ok(registered.has(command), `${command} is registered`);
		}
	});

	test('registry keys repositories by root (the Git API returns a new wrapper per call)', () => {
		const file = vscode.Uri.file(path.join(fixture.work, 'readme.txt'));
		assert.strictEqual(registry.forUri(file), repository);
		assert.strictEqual(registry.resolve({ rootUri: vscode.Uri.file(fixture.work) }), repository);
		const roots = registry.all.map(candidate => candidate.root);
		assert.strictEqual(new Set(roots).size, roots.length, 'no duplicates');
	});

	test('refs report incoming commits for current and non-current branches', async () => {
		const refs = await repository.getRefs();
		const main = refs.local.find(branch => branch.name === 'main');
		const feature = refs.local.find(branch => branch.name === 'feature');
		assert.strictEqual(main?.isCurrent, true);
		assert.strictEqual(main?.behind, 1);
		assert.strictEqual(feature?.isCurrent, false);
		assert.strictEqual(feature?.behind, 1);
		assert.strictEqual(feature?.upstream?.name, 'origin/feature');
		assert.deepStrictEqual(refs.remote.map(branch => branch.name).sort(), ['origin/feature', 'origin/main']);
	});

	test('Update fast-forwards a branch that is not checked out', async () => {
		const feature = (await repository.getRefs()).local.find(branch => branch.name === 'feature')!;
		await repository.fastForward(feature);

		assert.strictEqual(fixture.git(fixture.work, 'rev-parse', 'feature'), fixture.git(fixture.work, 'rev-parse', 'origin/feature'));
		assert.strictEqual(fixture.git(fixture.work, 'branch', '--show-current'), 'main', 'HEAD did not move');
		const updated = (await repository.getRefs()).local.find(branch => branch.name === 'feature')!;
		assert.strictEqual(updated.behind, 0);
	});

	test('Update refuses to fast-forward a branch with local commits', async () => {
		fixture.git(fixture.work, 'branch', '-q', '--track', 'diverged', 'origin/feature');
		fixture.git(fixture.work, 'checkout', '-q', 'diverged');
		fixture.commit(fixture.work, 'local.txt', 'local\n', 'Local work');
		fixture.git(fixture.work, 'checkout', '-q', 'main');
		fixture.git(fixture.other, 'checkout', '-q', 'feature');
		fixture.git(fixture.other, 'pull', '-q', '--ff-only');
		fixture.commit(fixture.other, 'feature.txt', 'feature v3\n', 'More feature');
		fixture.git(fixture.other, 'push', '-q', 'origin', 'feature');
		fixture.git(fixture.work, 'fetch', '-q', 'origin');

		const diverged = (await repository.getRefs()).local.find(branch => branch.name === 'diverged')!;
		assert.strictEqual(diverged.ahead, 1);
		assert.strictEqual(diverged.behind, 1);
		await assert.rejects(repository.fastForward(diverged), error => isFastForwardRejected(error));
	});

	test('merge conflicts are detected and can be aborted', async () => {
		fixture.git(fixture.work, 'checkout', '-q', '-b', 'conflict-a', 'main');
		fixture.commit(fixture.work, 'readme.txt', 'from a\n', 'Change in a');
		fixture.git(fixture.work, 'checkout', '-q', '-b', 'conflict-b', 'main');
		fixture.commit(fixture.work, 'readme.txt', 'from b\n', 'Change in b');

		await assert.rejects(repository.merge('conflict-a'));
		assert.strictEqual(await repository.getOngoingOperation(), 'merge');
		assert.strictEqual((await repository.getConflictedFiles()).length, 1);

		await repository.abort('merge');
		assert.strictEqual(await repository.getOngoingOperation(), undefined);
		assert.strictEqual((await repository.getConflictedFiles()).length, 0);
		fixture.git(fixture.work, 'checkout', '-q', 'main');
	});

	test('compare marks commits whose patch is already cherry-picked', async () => {
		fixture.git(fixture.work, 'checkout', '-q', '-b', 'source', 'main');
		const picked = fixture.commit(fixture.work, 'picked.txt', 'picked\n', 'Picked change');
		fixture.commit(fixture.work, 'other.txt', 'other\n', 'Unpicked change');
		fixture.git(fixture.work, 'checkout', '-q', '-b', 'target', 'main');
		// Diverge first; otherwise a same-second cherry-pick onto the same parent recreates the identical commit.
		fixture.commit(fixture.work, 'target.txt', 'target\n', 'Target-only change');
		fixture.git(fixture.work, 'cherry-pick', picked);

		const commits = await repository.getCommitsMissing('source', 'target');
		assert.deepStrictEqual(commits.map(commit => [commit.subject, commit.equivalentExists]), [
			['Unpicked change', false],
			['Picked change', true],
		]);

		const unpicked = commits.find(commit => !commit.equivalentExists)!;
		await repository.cherryPick([unpicked.hash]);
		assert.strictEqual((await repository.getCommitsMissing('source', 'target')).every(commit => commit.equivalentExists), true);
		fixture.git(fixture.work, 'checkout', '-q', 'main');
	});

	test('branch actions for real refs follow the current branch', async () => {
		await waitFor(() => repository.api.state.HEAD?.name === 'main' ? true : undefined);
		const refs = await repository.getRefs();
		const feature = refs.local.find(branch => branch.name === 'feature')!;
		const labels = buildBranchActions(feature, { currentBranch: repository.currentBranchName, remoteNames: repository.remoteNames }).map(action => action.label);
		assert.ok(labels.includes(`Merge 'feature' into 'main'`));
		assert.ok(labels.includes('Update'));
	});

	test('stash list round-trips through stash push', async () => {
		fixture.commit(fixture.work, 'stash.txt', 'base\n', 'Add stash file');
		fs.writeFileSync(path.join(fixture.work, 'stash.txt'), 'changed\n');
		await repository.stash({ message: 'vsgit test stash' });
		const stashes = await repository.getStashes();
		assert.strictEqual(stashes.length, 1);
		assert.match(stashes[0].message, /vsgit test stash/);
		await repository.clearStashes();
		assert.strictEqual((await repository.getStashes()).length, 0);
	});
});
