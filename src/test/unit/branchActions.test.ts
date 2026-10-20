import * as assert from 'assert';
import type { LocalBranch, RemoteBranch, Tag } from '../../git/types';
import { buildBranchActions, type BranchActionContext } from '../../ui/branchActions';

function local(name: string, overrides: Partial<LocalBranch> = {}): LocalBranch {
	return {
		kind: 'local', name, fullName: `refs/heads/${name}`, commit: 'abc', isCurrent: false,
		upstream: { ref: `refs/remotes/origin/${name}`, name: `origin/${name}`, remote: 'origin', remoteRef: `refs/heads/${name}` },
		ahead: 0, behind: 0, upstreamGone: false, ...overrides,
	};
}

const remote: RemoteBranch = { kind: 'remote', name: 'origin/feature', fullName: 'refs/remotes/origin/feature', commit: 'abc', remote: 'origin', branchName: 'feature' };
const tag: Tag = { kind: 'tag', name: 'v1', fullName: 'refs/tags/v1', commit: 'abc' };
const onDevelop: BranchActionContext = { currentBranch: 'develop', remoteNames: ['origin'] };

const labels = (actions: ReturnType<typeof buildBranchActions>): string[] => actions.map(action => action.label);

suite('branch actions (WebStorm Branches popup)', () => {
	test('non-current local branch', () => {
		assert.deepStrictEqual(labels(buildBranchActions(local('feature'), onDevelop)), [
			'Checkout',
			`New Branch from 'feature'…`,
			`Checkout and Rebase onto 'develop'`,
			`Compare with 'develop'`,
			'Show Diff with Working Tree',
			`Rebase 'develop' onto 'feature'`,
			`Merge 'feature' into 'develop'`,
			'Update',
			'Push…',
			'Rename…',
			'Delete',
		]);
	});

	test('a branch with incoming commits also offers Checkout and Update', () => {
		const actions = labels(buildBranchActions(local('feature', { behind: 3 }), onDevelop));
		assert.deepStrictEqual(actions.slice(0, 2), ['Checkout', 'Checkout and Update']);
	});

	test('current branch only offers what applies to it', () => {
		assert.deepStrictEqual(labels(buildBranchActions(local('develop', { isCurrent: true }), onDevelop)), [
			`New Branch from 'develop'…`,
			'Update',
			'Push…',
			'Rename…',
		]);
	});

	test('remote branch offers pull into current instead of update/push/rename', () => {
		assert.deepStrictEqual(labels(buildBranchActions(remote, onDevelop)), [
			'Checkout',
			`New Branch from 'origin/feature'…`,
			`Checkout and Rebase onto 'develop'`,
			`Compare with 'develop'`,
			'Show Diff with Working Tree',
			`Rebase 'develop' onto 'origin/feature'`,
			`Merge 'origin/feature' into 'develop'`,
			`Pull into 'develop' Using Rebase`,
			`Pull into 'develop' Using Merge`,
			'Delete',
		]);
	});

	test('tag actions', () => {
		assert.deepStrictEqual(labels(buildBranchActions(tag, onDevelop)), [
			'Checkout',
			'Show Diff with Working Tree',
			`Merge 'v1' into 'develop'`,
			'Push to origin',
			'Delete',
		]);
	});

	test('without an upstream there is no Update; without remotes no Push', () => {
		const noUpstream = labels(buildBranchActions(local('topic', { upstream: undefined }), onDevelop));
		assert.ok(!noUpstream.includes('Update'));
		assert.ok(noUpstream.includes('Push…'));
		const noRemotes = labels(buildBranchActions(local('topic', { upstream: undefined }), { currentBranch: 'develop', remoteNames: [] }));
		assert.ok(!noRemotes.includes('Push…'));
	});

	test('detached HEAD hides rebase actions', () => {
		const actions = labels(buildBranchActions(local('feature'), { currentBranch: undefined, remoteNames: ['origin'] }));
		assert.ok(!actions.some(label => label.startsWith('Rebase') || label.startsWith('Checkout and Rebase')));
		assert.ok(actions.includes(`Merge 'feature' into 'HEAD'`));
	});

	test('with a file open, refs offer comparing that file (not the current branch)', () => {
		const withFile: BranchActionContext = { ...onDevelop, activeFile: '/repo/src/app.ts' };
		const actions = buildBranchActions(local('feature'), withFile);
		const compareFile = actions.find(action => action.id === 'compareFileWith');
		assert.strictEqual(compareFile?.label, `Compare 'app.ts' with 'feature'`);
		assert.ok(labels(buildBranchActions(tag, withFile)).includes(`Compare 'app.ts' with 'v1'`));
		assert.ok(!buildBranchActions(local('develop', { isCurrent: true }), withFile).some(action => action.id === 'compareFileWith'));
	});

	test('actions are grouped in WebStorm order', () => {
		const groups = buildBranchActions(local('feature'), onDevelop).map(action => action.group);
		assert.deepStrictEqual(groups, [...groups].sort((a, b) => a - b));
	});
});
