import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	// Only the extension under test and the built-in extensions (including vscode.git) are loaded.
	launchArgs: ['--disable-extensions'],
	mocha: {
		ui: 'tdd',
		timeout: 60000,
	},
});
