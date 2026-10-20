import * as assert from 'assert';
import { parseLog, parseRecentCheckouts, parseRefs, parseStashes, parseTrack, splitRemoteBranch } from '../../git/parsers';

const F = '\0';

suite('parsers', () => {
	test('parseTrack reads ahead/behind/gone', () => {
		assert.deepStrictEqual(parseTrack(''), { ahead: 0, behind: 0, gone: false });
		assert.deepStrictEqual(parseTrack('ahead 2'), { ahead: 2, behind: 0, gone: false });
		assert.deepStrictEqual(parseTrack('behind 7'), { ahead: 0, behind: 7, gone: false });
		assert.deepStrictEqual(parseTrack('ahead 1, behind 3'), { ahead: 1, behind: 3, gone: false });
		assert.deepStrictEqual(parseTrack('gone'), { ahead: 0, behind: 0, gone: true });
	});

	test('splitRemoteBranch prefers the longest known remote', () => {
		assert.deepStrictEqual(splitRemoteBranch('origin/feature/x', ['origin']), { remote: 'origin', branchName: 'feature/x' });
		assert.deepStrictEqual(splitRemoteBranch('team/a/main', ['team', 'team/a']), { remote: 'team/a', branchName: 'main' });
		assert.deepStrictEqual(splitRemoteBranch('upstream/dev', []), { remote: 'upstream', branchName: 'dev' });
	});

	test('parseRefs classifies refs and reads tracking info', () => {
		const output = [
			['refs/heads/main', 'aaa', '', '*', 'refs/remotes/origin/main', 'origin', 'refs/heads/main', 'behind 2'],
			['refs/heads/feature/x', 'bbb', '', ' ', 'refs/remotes/origin/feature/x', 'origin', 'refs/heads/feature/x', 'ahead 1, behind 4'],
			['refs/heads/old', 'ccc', '', ' ', 'refs/remotes/origin/old', 'origin', 'refs/heads/old', 'gone'],
			['refs/heads/local-only', 'ddd', '', ' ', '', '', '', ''],
			['refs/remotes/origin/HEAD', 'aaa', '', ' ', '', '', '', ''],
			['refs/remotes/origin/main', 'eee', '', ' ', '', '', '', ''],
			['refs/tags/v1', 'tagobj', 'fff', ' ', '', '', '', ''],
		].map(fields => fields.join(F)).join('\n') + '\n';

		const refs = parseRefs(output, ['origin']);

		assert.deepStrictEqual(refs.local.map(branch => branch.name), ['main', 'feature/x', 'old', 'local-only']);
		const [main, feature, old, localOnly] = refs.local;
		assert.strictEqual(main.isCurrent, true);
		assert.strictEqual(main.behind, 2);
		assert.deepStrictEqual(main.upstream, { ref: 'refs/remotes/origin/main', name: 'origin/main', remote: 'origin', remoteRef: 'refs/heads/main' });
		assert.strictEqual(feature.isCurrent, false);
		assert.strictEqual(feature.ahead, 1);
		assert.strictEqual(feature.behind, 4);
		assert.strictEqual(old.upstreamGone, true);
		assert.strictEqual(localOnly.upstream, undefined);

		assert.deepStrictEqual(refs.remote.map(branch => [branch.name, branch.remote, branch.branchName]), [['origin/main', 'origin', 'main']]);
		assert.deepStrictEqual(refs.tags.map(tag => [tag.name, tag.commit]), [['v1', 'fff']]);
	});

	test('parseRefs handles a local upstream (remote ".")', () => {
		const output = ['refs/heads/topic', 'aaa', '', ' ', 'refs/heads/main', '.', 'refs/heads/main', 'ahead 1'].join(F);
		const [topic] = parseRefs(output, []).local;
		assert.deepStrictEqual(topic.upstream, { ref: 'refs/heads/main', name: 'main', remote: '.', remoteRef: 'refs/heads/main' });
	});

	test('parseRecentCheckouts returns distinct candidates, newest first', () => {
		const reflog = [
			'checkout: moving from feature to main',
			'commit: change',
			'checkout: moving from main to feature',
			'checkout: moving from main to 1a2b3c4',
			'checkout: moving from dev to main',
			'checkout: moving from main to dev',
		].join('\n');
		const candidates = new Set(['feature', 'dev', 'old']);
		assert.deepStrictEqual(parseRecentCheckouts(reflog, name => candidates.has(name), 5), ['feature', 'dev']);
		assert.deepStrictEqual(parseRecentCheckouts(reflog, name => candidates.has(name), 1), ['feature']);
		// The branch moved away from counts as recently used too.
		assert.deepStrictEqual(parseRecentCheckouts('checkout: moving from old to main', name => candidates.has(name), 5), ['old']);
	});

	test('parseLog reads records and the cherry mark', () => {
		const record = (mark: string, hash: string, subject: string): string => [mark, hash, hash.slice(0, 3), 'Ann', '1700000000', subject].join(F) + '\x1e';
		const output = `${record('>', 'abcdef', 'Add feature')}\n${record('=', '123456', 'Fix: a, b')}\n`;
		const commits = parseLog(output);
		assert.strictEqual(commits.length, 2);
		assert.strictEqual(commits[0].subject, 'Add feature');
		assert.strictEqual(commits[0].equivalentExists, false);
		assert.strictEqual(commits[1].shortHash, '123');
		assert.strictEqual(commits[1].equivalentExists, true);
		assert.strictEqual(commits[1].date.getTime(), 1700000000 * 1000);
	});

	test('parseStashes reads index and message', () => {
		const output = ['stash@{0}', '1700000000', 'On main: wip'].join(F) + '\n' + ['stash@{1}', '1690000000', 'WIP on dev: abc msg'].join(F) + '\n';
		const stashes = parseStashes(output);
		assert.deepStrictEqual(stashes.map(stash => [stash.index, stash.ref, stash.message]), [[0, 'stash@{0}', 'On main: wip'], [1, 'stash@{1}', 'WIP on dev: abc msg']]);
	});
});
