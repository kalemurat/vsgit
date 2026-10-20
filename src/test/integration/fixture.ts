import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface Fixture {
	readonly root: string;
	/** Clone under test; `main` is checked out. */
	readonly work: string;
	/** Second clone used to push commits "from someone else". */
	readonly other: string;
	git(cwd: string, ...args: string[]): string;
	commit(cwd: string, file: string, content: string, message: string): string;
	dispose(): void;
}

/**
 * Builds `origin` (bare) with `main` and `feature`, a clone `work` tracking both, and pushes one
 * more commit to each branch from `other`, so after a fetch both branches in `work` are behind by 1.
 */
export function createFixture(): Fixture {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vsgit-test-')));
	const origin = path.join(root, 'origin.git');
	const work = path.join(root, 'work');
	const other = path.join(root, 'other');

	const git = (cwd: string, ...args: string[]): string =>
		execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
	const configure = (cwd: string): void => {
		git(cwd, 'config', 'user.name', 'VSGit Test');
		git(cwd, 'config', 'user.email', 'vsgit@example.com');
		git(cwd, 'config', 'commit.gpgsign', 'false');
	};
	const commit = (cwd: string, file: string, content: string, message: string): string => {
		fs.writeFileSync(path.join(cwd, file), content);
		git(cwd, 'add', file);
		git(cwd, 'commit', '-q', '-m', message);
		return git(cwd, 'rev-parse', 'HEAD');
	};

	git(root, 'init', '-q', '--bare', '-b', 'main', origin);
	git(root, 'clone', '-q', origin, other);
	configure(other);
	commit(other, 'readme.txt', 'one\n', 'Initial commit');
	git(other, 'push', '-q', 'origin', 'main');
	git(other, 'checkout', '-q', '-b', 'feature');
	commit(other, 'feature.txt', 'feature\n', 'Add feature');
	git(other, 'push', '-q', '-u', 'origin', 'feature');

	git(root, 'clone', '-q', origin, work);
	configure(work);
	git(work, 'branch', '-q', '--track', 'feature', 'origin/feature');

	commit(other, 'feature.txt', 'feature v2\n', 'Improve feature');
	git(other, 'push', '-q', 'origin', 'feature');
	git(other, 'checkout', '-q', 'main');
	commit(other, 'readme.txt', 'two\n', 'Update readme');
	git(other, 'push', '-q', 'origin', 'main');
	git(work, 'fetch', '-q', 'origin');

	return {
		root,
		work,
		other,
		git,
		commit,
		dispose: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}
