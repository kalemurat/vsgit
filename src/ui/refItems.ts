import * as vscode from 'vscode';
import type { GitRepository } from '../git/gitRepository';
import type { GitRef, LocalBranch, RefsSnapshot } from '../git/types';
import { plural } from '../util/format';
import { separator, showPicker, type Separator } from './quickInput';

export interface RefPickItem extends vscode.QuickPickItem {
	readonly ref: GitRef;
}

const INCOMING_COLOR = new vscode.ThemeColor('charts.blue');
const OUTGOING_COLOR = new vscode.ThemeColor('charts.green');

/**
 * Incoming/outgoing markers in the spirit of WebStorm's blue (incoming) and green (outgoing) arrows.
 * Counts compare the branch with its remote-tracking ref, so they are as fresh as the last fetch.
 */
export function syncIndicator(branch: LocalBranch): string {
	if (branch.upstreamGone) {
		return '$(warning) upstream gone';
	}
	const parts: string[] = [];
	if (branch.behind > 0) {
		parts.push(`$(arrow-down)${branch.behind}`);
	}
	if (branch.ahead > 0) {
		parts.push(`$(arrow-up)${branch.ahead}`);
	}
	return parts.join(' ');
}

export function syncTooltip(branch: LocalBranch): string | undefined {
	if (branch.upstreamGone) {
		return `The tracked branch ${branch.upstream?.name ?? ''} no longer exists on the remote`;
	}
	if (branch.behind > 0 && branch.ahead > 0) {
		return `${branch.behind} incoming and ${branch.ahead} outgoing commits`;
	}
	if (branch.behind > 0) {
		return `${plural(branch.behind, 'incoming commit')} — update to get them`;
	}
	if (branch.ahead > 0) {
		return `${plural(branch.ahead, 'outgoing commit')}`;
	}
	return undefined;
}

export function refIcon(ref: GitRef, favorite: boolean): vscode.ThemeIcon {
	if (ref.kind === 'tag') {
		return new vscode.ThemeIcon('tag');
	}
	if (ref.kind === 'local' && ref.isCurrent) {
		return new vscode.ThemeIcon('check');
	}
	if (favorite) {
		return new vscode.ThemeIcon('star-full');
	}
	if (ref.kind === 'local' && ref.behind > 0) {
		return new vscode.ThemeIcon('arrow-down', INCOMING_COLOR);
	}
	if (ref.kind === 'local' && ref.ahead > 0) {
		return new vscode.ThemeIcon('arrow-up', OUTGOING_COLOR);
	}
	return new vscode.ThemeIcon(ref.kind === 'remote' ? 'cloud' : 'git-branch');
}

export function refDescription(ref: GitRef): string | undefined {
	if (ref.kind !== 'local') {
		return undefined;
	}
	const parts = [syncIndicator(ref), ref.upstream?.name].filter(Boolean);
	return parts.length > 0 ? parts.join('  ') : undefined;
}

/**
 * WebStorm's order within a Branches popup section: the current branch, then favorites, then the rest
 * in git's (alphabetical) order.
 */
export function sortRefs<T extends GitRef>(refs: readonly T[], isFavorite: (ref: T) => boolean): T[] {
	const rank = (ref: T): number => (ref.kind === 'local' && ref.isCurrent ? 0 : isFavorite(ref) ? 1 : 2);
	return [...refs].sort((a, b) => rank(a) - rank(b));
}

export function toRefItem(ref: GitRef, favorite = false): RefPickItem {
	return {
		ref,
		label: ref.name,
		iconPath: refIcon(ref, favorite),
		description: refDescription(ref),
	};
}

export type RefKind = GitRef['kind'];

export interface PickRefOptions {
	readonly title: string;
	readonly placeholder?: string;
	readonly kinds?: readonly RefKind[];
	readonly excludeCurrent?: boolean;
	/** Full ref name to highlight initially. */
	readonly preferred?: string;
}

export function refItemsBySection(refs: RefsSnapshot, options: Pick<PickRefOptions, 'kinds' | 'excludeCurrent'>): (RefPickItem | Separator)[] {
	const kinds = options.kinds ?? ['local', 'remote', 'tag'];
	const sections: [RefKind, string, readonly GitRef[]][] = [
		['local', 'Local', refs.local.filter(branch => !(options.excludeCurrent && branch.isCurrent))],
		['remote', 'Remote', refs.remote],
		['tag', 'Tags', refs.tags],
	];
	const items: (RefPickItem | Separator)[] = [];
	for (const [kind, label, list] of sections) {
		if (kinds.includes(kind) && list.length > 0) {
			items.push(separator(label), ...list.map(ref => toRefItem(ref)));
		}
	}
	return items;
}

/** Lets the user choose a branch or tag; resolves undefined when dismissed. */
export async function pickRef(repository: GitRepository, options: PickRefOptions): Promise<GitRef | undefined> {
	const result = await showPicker<RefPickItem>({
		title: options.title,
		placeholder: options.placeholder ?? 'Select a branch or tag',
		items: async () => refItemsBySection(await repository.getRefs(), options),
		isActive: item => item.ref.fullName === options.preferred,
	});
	return result.kind === 'accept' ? result.item.ref : undefined;
}
