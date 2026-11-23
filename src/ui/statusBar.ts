import * as vscode from 'vscode';
import type { GitRepository } from '../git/gitRepository';
import type { RepositoryRegistry } from '../git/repositoryRegistry';
import type { OngoingOperation } from '../git/types';
import { Settings } from '../settings';
import { Debouncer } from '../util/async';
import { DisposableStore } from '../util/disposable';
import { fromNow, plural } from '../util/format';

/** Just left of the built-in Source Control items (priority 10000), i.e. where the branch is shown. */
const PRIORITY = 10001;

const ONGOING_LABELS: Record<OngoingOperation, string> = {
	'merge': 'Merging',
	'rebase': 'Rebasing',
	'cherry-pick': 'Cherry-picking',
	'revert': 'Reverting',
};

/**
 * WebStorm's VCS widget: current branch with incoming (↓) / outgoing (↑) commit counts; a click
 * opens the Branches popup. It follows the active repository and re-renders only when that
 * repository's state changes, reading counts from the Git API instead of spawning git.
 */
export class BranchStatusBar implements vscode.Disposable {
	private readonly disposables = new DisposableStore();
	private readonly repositorySubscription = this.disposables.add(new DisposableStore());
	private readonly item: vscode.StatusBarItem;
	private readonly renderSoon = this.disposables.add(new Debouncer(150, () => void this.render()));
	private renderGeneration = 0;

	constructor(private readonly registry: RepositoryRegistry, command: string) {
		this.item = this.disposables.add(vscode.window.createStatusBarItem('vsgit.branch', vscode.StatusBarAlignment.Left, PRIORITY));
		this.item.name = 'Git Branch (VSGit)';
		this.item.command = command;
		this.disposables.add(registry.onDidChangeActive(() => this.bind()));
		this.disposables.add(registry.onDidChangeRepositories(() => this.renderSoon.trigger()));
		this.disposables.add(vscode.workspace.onDidChangeConfiguration(event => {
			if (Settings.affectsStatusBar(event)) {
				this.bind();
			}
		}));
		this.bind();
	}

	dispose(): void {
		this.renderGeneration++;
		this.disposables.dispose();
	}

	private bind(): void {
		this.repositorySubscription.clear();
		const repository = this.registry.active;
		if (!repository || !Settings.statusBarEnabled) {
			this.renderGeneration++;
			this.item.hide();
			return;
		}
		this.repositorySubscription.add(repository.api.state.onDidChange(() => this.renderSoon.trigger()));
		void this.render();
	}

	private async render(): Promise<void> {
		const generation = ++this.renderGeneration;
		const repository = this.registry.active;
		if (!repository || !Settings.statusBarEnabled) {
			this.item.hide();
			return;
		}
		const [ongoing, lastFetch] = await Promise.all([
			repository.getOngoingOperation().catch(() => undefined),
			repository.getLastFetchTime().catch(() => undefined),
		]);
		// A newer render (or disposal) superseded this one while it was waiting.
		if (generation !== this.renderGeneration) {
			return;
		}
		this.update(repository, ongoing, lastFetch);
	}

	private update(repository: GitRepository, ongoing: OngoingOperation | undefined, lastFetch: Date | undefined): void {
		const head = repository.api.state.HEAD;
		const name = head?.name ?? head?.commit?.slice(0, 8) ?? 'No branch';
		const behind = head?.behind ?? 0;
		const ahead = head?.ahead ?? 0;
		const prefix = this.registry.all.length > 1 ? `${repository.name}: ` : '';

		const parts = [`$(git-branch) ${prefix}${name}`];
		if (behind > 0) {
			parts.push(`$(arrow-down)${behind}`);
		}
		if (ahead > 0) {
			parts.push(`$(arrow-up)${ahead}`);
		}
		if (ongoing) {
			parts.push(`(${ONGOING_LABELS[ongoing]})`);
		}
		this.item.text = parts.join(' ');
		this.item.backgroundColor = ongoing ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

		const tooltip = new vscode.MarkdownString('', true);
		const upstream = head?.upstream ? `${head.upstream.remote}/${head.upstream.name}` : undefined;
		tooltip.appendMarkdown(`**${escape(repository.name)}** — ${code(name)}`);
		tooltip.appendMarkdown(upstream ? ` → ${code(upstream)}\n\n` : '\n\n');
		if (!head?.name) {
			tooltip.appendMarkdown('HEAD is detached\n\n');
		} else if (!upstream) {
			tooltip.appendMarkdown('No tracked branch\n\n');
		} else if (behind === 0 && ahead === 0) {
			tooltip.appendMarkdown(`Up to date with ${code(upstream)}\n\n`);
		} else {
			const counts = [
				behind > 0 ? `$(arrow-down) ${plural(behind, 'incoming commit')}` : '',
				ahead > 0 ? `$(arrow-up) ${plural(ahead, 'outgoing commit')}` : '',
			].filter(Boolean);
			tooltip.appendMarkdown(`${counts.join(' · ')}\n\n`);
		}
		if (ongoing) {
			tooltip.appendMarkdown(`$(warning) ${ONGOING_LABELS[ongoing]} — finish or abort it from the Git menu\n\n`);
		}
		tooltip.appendMarkdown(lastFetch ? `Last fetch: ${fromNow(lastFetch)}\n\n` : 'Never fetched\n\n');
		tooltip.appendMarkdown('_Click to show branches_');
		this.item.tooltip = tooltip;
		this.item.show();
	}
}

/** Backslash escapes are literal inside code spans, so only backticks need replacing there. */
function code(text: string): string {
	return `\`${text.replace(/`/g, "'")}\``;
}

function escape(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
