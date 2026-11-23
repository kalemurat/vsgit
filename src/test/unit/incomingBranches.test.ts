import * as assert from 'assert';
import * as vscode from 'vscode';
import type { GitRepository } from '../../git/gitRepository';
import type { LocalBranch } from '../../git/types';
import { buildIncomingItems, hasIncomingCommits, type IncomingBranch } from '../../ui/incomingBranches';

function branch(name: string, options: Partial<LocalBranch> = {}): LocalBranch {
	return {
		kind: 'local', name, fullName: `refs/heads/${name}`, commit: 'abc', isCurrent: false,
		upstream: { ref: `refs/remotes/origin/${name}`, name: `origin/${name}`, remote: 'origin', remoteRef: `refs/heads/${name}` },
		ahead: 0, behind: 0, upstreamGone: false,
		...options,
	};
}

const repository = (name: string): GitRepository => ({ name }) as GitRepository;

suite('incoming branches', () => {
	test('hasIncomingCommits needs an existing upstream with commits the branch lacks', () => {
		assert.strictEqual(hasIncomingCommits(branch('a', { behind: 2 })), true);
		assert.strictEqual(hasIncomingCommits(branch('b', { behind: 1, ahead: 3 })), true);
		assert.strictEqual(hasIncomingCommits(branch('c')), false);
		assert.strictEqual(hasIncomingCommits(branch('d', { ahead: 1 })), false);
		assert.strictEqual(hasIncomingCommits(branch('e', { behind: 1, upstream: undefined })), false);
		assert.strictEqual(hasIncomingCommits(branch('f', { behind: 1, upstreamGone: true })), false);
	});

	test('checked-out branches come first and preselected, the others follow per repository unselected', () => {
		const first = repository('first');
		const second = repository('second');
		const third = repository('third');
		const entries: IncomingBranch[] = [
			{ repository: first, branch: branch('develop', { isCurrent: true, behind: 2 }) },
			{ repository: first, branch: branch('diverged', { behind: 1, ahead: 1 }) },
			{ repository: first, branch: branch('main', { behind: 1 }) },
			{ repository: second, branch: branch('main', { isCurrent: true, behind: 4, ahead: 1 }) },
			{ repository: third, branch: branch('release', { behind: 3 }) },
		];
		const { items, selected } = buildIncomingItems(entries, 'rebase', true);

		const shape = items.map(item => item.kind === vscode.QuickPickItemKind.Separator ? `--${item.label}` : item.label);
		assert.deepStrictEqual(shape, ['--Checked Out', 'first: develop', 'second: main', '--first', 'diverged', 'main', '--third', 'release']);
		assert.deepStrictEqual(selected.map(item => item.label), ['first: develop', 'second: main']);

		const description = (label: string): string => items.find(item => item.label === label)?.description ?? '';
		assert.doesNotMatch(description('first: develop'), /local commits/);
		assert.match(description('second: main'), /has local commits, updates with a rebase/);
		assert.match(description('diverged'), /needs a checkout/);
	});

	test('a single repository shows its checked-out branch, then the other branches', () => {
		const only = repository('only');
		const { items, selected } = buildIncomingItems([
			{ repository: only, branch: branch('main', { isCurrent: true, behind: 1 }) },
			{ repository: only, branch: branch('feature', { behind: 1 }) },
		], 'merge', false);
		assert.deepStrictEqual(items.map(item => item.label), ['Checked Out', 'main', 'Other Branches', 'feature']);
		assert.deepStrictEqual(selected.map(item => item.label), ['main']);
	});

	test('without a checked-out branch to update, nothing is preselected and no section is added', () => {
		const only = repository('only');
		const { items, selected } = buildIncomingItems([{ repository: only, branch: branch('feature', { behind: 1 }) }], 'merge', false);
		assert.deepStrictEqual(items.map(item => item.label), ['feature']);
		assert.deepStrictEqual(selected, []);
	});
});
