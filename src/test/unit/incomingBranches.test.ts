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

	test('items are grouped per repository and only branches without local commits are preselected', () => {
		const first = repository('first');
		const second = repository('second');
		const entries: IncomingBranch[] = [
			{ repository: first, branch: branch('develop', { isCurrent: true, behind: 2 }) },
			{ repository: first, branch: branch('main', { behind: 1 }) },
			{ repository: first, branch: branch('diverged', { behind: 1, ahead: 1 }) },
			{ repository: second, branch: branch('main', { isCurrent: true, behind: 4, ahead: 1 }) },
		];
		const { items, selected } = buildIncomingItems(entries, 'rebase', true);

		const shape = items.map(item => item.kind === vscode.QuickPickItemKind.Separator ? `--${item.label}` : item.label);
		assert.deepStrictEqual(shape, ['--first', 'develop', 'main', 'diverged', '--second', 'main']);
		assert.deepStrictEqual(selected.map(item => `${item.entry.repository.name}/${item.label}`), ['first/develop', 'first/main']);

		const descriptions = items.filter(item => 'entry' in item).map(item => item.description);
		assert.match(descriptions[0] ?? '', /checked out, updates with rebase/);
		assert.match(descriptions[2] ?? '', /needs a checkout/);
	});

	test('a single repository gets no separator', () => {
		const only = repository('only');
		const { items } = buildIncomingItems([{ repository: only, branch: branch('main', { behind: 1 }) }], 'merge', false);
		assert.deepStrictEqual(items.map(item => item.label), ['main']);
	});
});
