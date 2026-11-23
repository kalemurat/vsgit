import * as assert from 'assert';
import type { GitRef, LocalBranch } from '../../git/types';
import { sortRefs } from '../../ui/refItems';

function local(name: string, isCurrent = false): LocalBranch {
	return {
		kind: 'local', name, fullName: `refs/heads/${name}`, commit: 'abc', isCurrent,
		upstream: undefined, ahead: 0, behind: 0, upstreamGone: false,
	};
}

suite('refItems', () => {
	test('sortRefs puts the current branch first, then favorites, keeping git order otherwise', () => {
		const refs = [local('a'), local('b'), local('c', true), local('d'), local('e')];
		const favorites = new Set(['refs/heads/d', 'refs/heads/b']);
		const names = (sorted: GitRef[]): string[] => sorted.map(ref => ref.name);
		assert.deepStrictEqual(names(sortRefs(refs, ref => favorites.has(ref.fullName))), ['c', 'b', 'd', 'a', 'e']);
		// A current branch that is also a favorite still comes first.
		favorites.add('refs/heads/c');
		assert.deepStrictEqual(names(sortRefs(refs, ref => favorites.has(ref.fullName))), ['c', 'b', 'd', 'a', 'e']);
		assert.deepStrictEqual(names(sortRefs(refs, () => false)), ['c', 'a', 'b', 'd', 'e']);
	});
});
