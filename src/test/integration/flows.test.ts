import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { VsgitApi } from '../../extension';
import type { Flows } from '../../flows/context';
import type { GitRepository } from '../../git/gitRepository';
import type { RepositoryRegistry } from '../../git/repositoryRegistry';
import type { GitExtension } from '../../typings/git';
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

/**
 * End-to-end checks of the workflows behind the menu entries, run against real repositories.
 * Only flows that complete without a prompt are driven here; prompts are covered by the unit tests.
 */
suite('VSGit flows (end to end)', function () {
	this.timeout(60000);

	let flows: Flows;
	let registry: RepositoryRegistry;
	const fixtures: Fixture[] = [];

	suiteSetup(async () => {
		const api = await vscode.extensions.getExtension<VsgitApi>(EXTENSION_ID)!.activate();
		assert.ok(api.flows && api.registry);
		flows = api.flows;
		registry = api.registry;
	});

	suiteTeardown(() => fixtures.forEach(fixture => fixture.dispose()));

	async function open(): Promise<{ fixture: Fixture; repository: GitRepository }> {
		const fixture = createFixture();
		fixtures.push(fixture);
		const git = vscode.extensions.getExtension<GitExtension>('vscode.git')!.exports.getAPI(1);
		await git.openRepository(vscode.Uri.file(fixture.work));
		const repository = await waitFor(() => registry.all.find(candidate => candidate.root === fixture.work));
		await refreshed(repository, 'main');
		return { fixture, repository };
	}

	/** Lets the built-in Git extension pick up changes made behind its back, then waits for the expected HEAD. */
	async function refreshed(repository: GitRepository, branch: string, withUpstream = true): Promise<void> {
		await repository.api.status();
		await waitFor(() => {
			const head = repository.api.state.HEAD;
			return head?.name === branch && (!withUpstream || head.upstream) ? true : undefined;
		});
	}

	const rev = (fixture: Fixture, ref: string): string => fixture.git(fixture.work, 'rev-parse', ref);
	const current = (fixture: Fixture): string => fixture.git(fixture.work, 'branch', '--show-current');

	test('Update on a non-current branch fast-forwards it without checkout', async () => {
		const { fixture, repository } = await open();
		const feature = (await repository.getRefs()).local.find(branch => branch.name === 'feature')!;

		await flows.sync.updateBranch(repository, feature);

		assert.strictEqual(rev(fixture, 'feature'), rev(fixture, 'origin/feature'));
		assert.strictEqual(current(fixture), 'main');
	});

	test('Update Project with merge reconciles a diverged current branch', async () => {
		const { fixture, repository } = await open();
		fixture.commit(fixture.work, 'local.txt', 'local\n', 'Local commit');
		await refreshed(repository, 'main');

		assert.strictEqual(await flows.sync.updateCurrentBranch(repository, 'merge'), true);

		assert.strictEqual(fixture.git(fixture.work, 'rev-list', '--count', 'main..origin/main'), '0');
		assert.strictEqual(fixture.git(fixture.work, 'rev-list', '--parents', '-n', '1', 'main').split(' ').length, 3, 'a merge commit');
	});

	test('Update Project with rebase keeps history linear', async () => {
		const { fixture, repository } = await open();
		fixture.commit(fixture.work, 'local.txt', 'local\n', 'Local commit');
		await refreshed(repository, 'main');

		assert.strictEqual(await flows.sync.updateCurrentBranch(repository, 'rebase'), true);

		assert.strictEqual(rev(fixture, 'main~1'), rev(fixture, 'origin/main'));
		assert.strictEqual(fixture.git(fixture.work, 'log', '-1', '--format=%s', 'main'), 'Local commit');
	});

	test('Update Project with local uncommitted changes stashes and restores them', async () => {
		const { fixture, repository } = await open();
		fixture.commit(fixture.work, 'local.txt', 'local\n', 'Local commit');
		fs.writeFileSync(path.join(fixture.work, 'wip.txt'), 'work in progress\n');
		fixture.git(fixture.work, 'add', 'wip.txt');
		await refreshed(repository, 'main');

		assert.strictEqual(await flows.sync.updateCurrentBranch(repository, 'rebase'), true);

		assert.match(fixture.git(fixture.work, 'status', '--porcelain'), /wip\.txt/);
	});

	test('Checkout of a remote branch creates a tracking local branch', async () => {
		const { fixture, repository } = await open();
		fixture.git(fixture.work, 'branch', '-D', 'feature');
		const remote = (await repository.getRefs()).remote.find(branch => branch.name === 'origin/feature')!;

		assert.strictEqual(await flows.branches.checkout(repository, remote), true);

		assert.strictEqual(current(fixture), 'feature');
		assert.strictEqual(fixture.git(fixture.work, 'rev-parse', '--abbrev-ref', 'feature@{upstream}'), 'origin/feature');
	});

	test('Merge into current, then delete the merged branch', async () => {
		const { fixture, repository } = await open();
		fixture.git(fixture.work, 'checkout', '-q', '-b', 'topic');
		fixture.commit(fixture.work, 'topic.txt', 'topic\n', 'Topic work');
		fixture.git(fixture.work, 'checkout', '-q', 'main');
		await refreshed(repository, 'main');
		const topic = (await repository.getRefs()).local.find(branch => branch.name === 'topic')!;

		await flows.integration.mergeInto(repository, topic);
		assert.strictEqual(fixture.git(fixture.work, 'merge-base', '--is-ancestor', 'topic', 'main'), '');

		await flows.branches.delete(repository, topic);
		assert.strictEqual(fixture.git(fixture.work, 'branch', '--list', 'topic'), '');
	});

	test('Rebase current onto a branch, and Checkout and Rebase onto current', async () => {
		const { fixture, repository } = await open();
		fixture.git(fixture.work, 'checkout', '-q', '-b', 'topic', 'main');
		fixture.commit(fixture.work, 'topic.txt', 'topic\n', 'Topic work');
		await refreshed(repository, 'topic', false);
		const origin = (await repository.getRefs()).remote.find(branch => branch.name === 'origin/main')!;

		await flows.integration.rebaseCurrentOnto(repository, origin);
		assert.strictEqual(rev(fixture, 'topic~1'), rev(fixture, 'origin/main'));

		fixture.git(fixture.work, 'checkout', '-q', 'main');
		fixture.git(fixture.work, 'reset', '-q', '--hard', 'origin/main');
		fixture.commit(fixture.work, 'main.txt', 'main\n', 'Main work');
		await refreshed(repository, 'main');
		const feature = (await repository.getRefs()).local.find(branch => branch.name === 'feature')!;

		await flows.integration.checkoutAndRebase(repository, feature);
		assert.strictEqual(current(fixture), 'feature');
		assert.strictEqual(fixture.git(fixture.work, 'merge-base', '--is-ancestor', 'main', 'feature'), '');
	});

	test('Pull into current using rebase from a remote branch', async () => {
		const { fixture, repository } = await open();
		const remote = (await repository.getRefs()).remote.find(branch => branch.name === 'origin/feature')!;

		await flows.sync.pullInto(repository, remote, 'rebase');

		assert.strictEqual(fixture.git(fixture.work, 'merge-base', '--is-ancestor', 'origin/feature', 'main'), '');
		assert.strictEqual(current(fixture), 'main');
	});

	test('Compare data and cherry-pick into current', async () => {
		const { fixture, repository } = await open();
		const missing = await repository.getCommitsMissing('origin/feature', 'HEAD');
		assert.deepStrictEqual(missing.map(commit => commit.subject), ['Improve feature', 'Add feature']);

		await flows.integration.cherryPick(repository, [...missing].reverse().map(commit => commit.hash));

		assert.strictEqual((await repository.getCommitsMissing('origin/feature', 'HEAD')).every(commit => commit.equivalentExists), true);
		assert.strictEqual(fixture.git(fixture.work, 'log', '-1', '--format=%s'), 'Improve feature');
	});

	test('Compare file with a branch opens a diff against that branch', async () => {
		const { fixture, repository } = await open();
		const file = vscode.Uri.file(path.join(fixture.work, 'readme.txt'));
		const feature = (await repository.getRefs()).remote.find(branch => branch.name === 'origin/feature')!;
		assert.strictEqual(await repository.existsInRef('origin/feature', 'readme.txt'), true);
		assert.strictEqual(await repository.existsInRef('origin/feature', 'missing.txt'), false);

		assert.strictEqual(registry.forUri(file)?.root, fixture.work, 'file resolves to its repository');
		await flows.workspace.compareFileWithRef(file, feature);

		const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		const input = tab?.input;
		assert.ok(input instanceof vscode.TabInputTextDiff, `a diff editor is open (got ${tab?.label}: ${JSON.stringify(input)})`);
		assert.strictEqual(input.original.scheme, 'git');
		assert.strictEqual(input.modified.fsPath, file.fsPath);
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	test('Show Files Diff between two refs opens the changes editor', async () => {
		const { repository } = await open();
		await flows.integration.showFilesDiff(repository, 'main', 'origin/feature');
		assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab, 'an editor is open');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});
});
