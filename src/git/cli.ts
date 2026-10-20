import { execFile } from 'node:child_process';
import type * as vscode from 'vscode';

const MAX_BUFFER = 64 * 1024 * 1024;

export class GitCommandError extends Error {
	constructor(
		readonly args: readonly string[],
		readonly exitCode: number | undefined,
		readonly stdout: string,
		readonly stderr: string,
	) {
		super(stderr.trim() || stdout.trim() || `git ${args[0]} failed with exit code ${exitCode}`);
		this.name = 'GitCommandError';
	}
}

/**
 * Runs the git executable that the built-in Git extension resolved. Used for operations the
 * `vscode.git` API does not expose; network operations go through the API instead so that
 * VS Code's credential (askpass) handling applies.
 */
export class GitCli {
	private readonly env: NodeJS.ProcessEnv;

	constructor(readonly gitPath: string) {
		this.env = {
			...process.env,
			// Never block on a terminal prompt; there is no terminal to answer it.
			GIT_TERMINAL_PROMPT: '0',
			// Continue/commit steps reuse the prepared message instead of opening an editor.
			GIT_EDITOR: 'true',
			// Read-only commands must not take optional locks that would race the built-in Git extension.
			GIT_OPTIONAL_LOCKS: '0',
			// Stable English output, which error handling matches against.
			LC_ALL: 'C',
		};
	}

	exec(cwd: string, args: readonly string[], token?: vscode.CancellationToken): Promise<string> {
		if (token?.isCancellationRequested) {
			return Promise.reject(new GitCommandError(args, undefined, '', 'Cancelled'));
		}
		return new Promise((resolve, reject) => {
			const controller = new AbortController();
			const cancellation = token?.onCancellationRequested(() => controller.abort());
			execFile(
				this.gitPath,
				['-c', 'core.quotepath=false', ...args],
				{ cwd, env: this.env, maxBuffer: MAX_BUFFER, signal: controller.signal, windowsHide: true, encoding: 'utf8' },
				(error, stdout, stderr) => {
					cancellation?.dispose();
					if (error) {
						const exitCode = typeof error.code === 'number' ? error.code : undefined;
						reject(new GitCommandError(args, exitCode, stdout, stderr || error.message));
					} else {
						resolve(stdout);
					}
				},
			);
		});
	}
}
