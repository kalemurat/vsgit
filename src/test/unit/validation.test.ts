import * as assert from 'assert';
import { validateNewBranchName } from '../../flows/branchFlows';
import { findOptionConflict } from '../../flows/syncFlows';
import { parseRefs } from '../../git/parsers';
import { validateRefName } from '../../git/refName';

suite('ref name validation', () => {
	test('accepts valid names', () => {
		for (const name of ['main', 'feature/login', 'fix-123', 'release/1.2.3', 'a.b', 'user@host']) {
			assert.strictEqual(validateRefName(name), undefined, name);
		}
	});

	test('rejects names git check-ref-format rejects', () => {
		for (const name of ['', 'HEAD', '@', '-x', 'a b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a..b', 'a@{b',
			'/a', 'a/', 'a//b', 'a.', '.a', 'a/.b', 'a.lock', 'a/b.lock', 'tab\there']) {
			assert.notStrictEqual(validateRefName(name), undefined, JSON.stringify(name));
		}
	});

	test('new branch names must not clash with existing refs', () => {
		const line = (ref: string): string => [ref, 'a', '', ' ', '', '', '', ''].join('\0');
		const refs = parseRefs([line('refs/heads/main'), line('refs/heads/feature/a'), line('refs/remotes/origin/dev')].join('\n'), ['origin']);
		assert.match(validateNewBranchName('main', refs) ?? '', /already exists/);
		assert.match(validateNewBranchName('origin/dev', refs) ?? '', /remote branch/);
		assert.match(validateNewBranchName('feature', refs) ?? '', /directory/);
		assert.match(validateNewBranchName('main/x', refs) ?? '', /directory/);
		assert.strictEqual(validateNewBranchName('feature/b', refs), undefined);
	});

	test('incompatible merge/pull options are reported', () => {
		assert.strictEqual(findOptionConflict(['--no-ff', '--no-verify']), undefined);
		assert.match(findOptionConflict(['--ff-only', '--no-ff']) ?? '', /cannot be combined/);
		assert.match(findOptionConflict(['--rebase', '--squash']) ?? '', /cannot be combined/);
	});
});
