import * as vscode from 'vscode';
import { DisposableStore } from '../util/disposable';

export type Separator = vscode.QuickPickItem & { readonly kind: vscode.QuickPickItemKind.Separator };

export function separator(label = ''): Separator {
	return { label, kind: vscode.QuickPickItemKind.Separator };
}

export type PickResult<T> =
	| { readonly kind: 'accept'; readonly item: T }
	| { readonly kind: 'button'; readonly id: string }
	| { readonly kind: 'itemButton'; readonly button: vscode.QuickInputButton; readonly item: T }
	| { readonly kind: 'back' }
	| { readonly kind: 'cancel' };

export interface PickerController<T extends vscode.QuickPickItem> {
	setItems(items: readonly (T | Separator)[]): void;
	setTitle(title: string): void;
	setPlaceholder(placeholder: string): void;
	setBusy(busy: boolean): void;
}

export interface PickerButton<T extends vscode.QuickPickItem> extends vscode.QuickInputButton {
	readonly id: string;
	/** Handles the click while keeping the picker open; without it the picker resolves with `{ kind: 'button' }`. */
	readonly keepOpen?: (controller: PickerController<T>) => void | Promise<void>;
}

export interface PickerOptions<T extends vscode.QuickPickItem> {
	readonly title: string;
	readonly placeholder?: string;
	/** Items, or a loader; the picker opens immediately and shows progress while loading. */
	readonly items: readonly (T | Separator)[] | (() => Promise<readonly (T | Separator)[]>);
	readonly isActive?: (item: T) => boolean;
	readonly canGoBack?: boolean;
	readonly buttons?: readonly PickerButton<T>[];
	readonly onDidTriggerItemButton?: (event: vscode.QuickPickItemButtonEvent<T>, controller: PickerController<T>) => void | Promise<void>;
	/** Item buttons that close the picker and resolve with `{ kind: 'itemButton' }` instead of calling the handler. */
	readonly closingItemButtons?: readonly vscode.QuickInputButton[];
	readonly matchOnDescription?: boolean;
	readonly matchOnDetail?: boolean;
	/** Keeps the picker open when focus moves to an editor (e.g. after opening a diff from an item button). */
	readonly ignoreFocusOut?: boolean;
}

function isSeparator(item: vscode.QuickPickItem): item is Separator {
	return item.kind === vscode.QuickPickItemKind.Separator;
}

/** Shows a single-selection quick pick. The underlying widget and its listeners are disposed when it closes. */
export function showPicker<T extends vscode.QuickPickItem>(options: PickerOptions<T>): Promise<PickResult<T>> {
	return new Promise<PickResult<T>>((resolve, reject) => {
		const disposables = new DisposableStore();
		const quickPick = disposables.add(vscode.window.createQuickPick<T | Separator>());
		let settled = false;

		const settle = (result: PickResult<T>): void => {
			if (!settled) {
				settled = true;
				resolve(result);
				quickPick.hide();
			}
		};

		const setItems = (items: readonly (T | Separator)[]): void => {
			quickPick.items = items;
			const active = options.isActive
				? items.find((item): item is T => !isSeparator(item) && options.isActive!(item))
				: undefined;
			if (active) {
				quickPick.activeItems = [active];
			}
		};

		const controller: PickerController<T> = {
			setItems,
			setTitle: title => { quickPick.title = title; },
			setPlaceholder: placeholder => { quickPick.placeholder = placeholder; },
			setBusy: busy => { quickPick.busy = busy; },
		};

		quickPick.title = options.title;
		quickPick.placeholder = options.placeholder;
		quickPick.matchOnDescription = options.matchOnDescription ?? false;
		quickPick.matchOnDetail = options.matchOnDetail ?? false;
		quickPick.ignoreFocusOut = options.ignoreFocusOut ?? false;
		quickPick.buttons = [
			...(options.canGoBack ? [vscode.QuickInputButtons.Back] : []),
			...(options.buttons ?? []),
		];

		disposables.add(quickPick.onDidAccept(() => {
			const [item] = quickPick.selectedItems;
			if (item && !isSeparator(item)) {
				settle({ kind: 'accept', item });
			}
		}));
		disposables.add(quickPick.onDidTriggerButton(button => {
			if (button === vscode.QuickInputButtons.Back) {
				settle({ kind: 'back' });
				return;
			}
			const pickerButton = button as PickerButton<T>;
			if (pickerButton.keepOpen) {
				void Promise.resolve(pickerButton.keepOpen(controller)).catch(reject);
			} else {
				settle({ kind: 'button', id: pickerButton.id });
			}
		}));
		disposables.add(quickPick.onDidTriggerItemButton(event => {
			if (isSeparator(event.item)) {
				return;
			}
			if (options.closingItemButtons?.includes(event.button)) {
				settle({ kind: 'itemButton', button: event.button, item: event.item });
			} else if (options.onDidTriggerItemButton) {
				void Promise.resolve(options.onDidTriggerItemButton(event as vscode.QuickPickItemButtonEvent<T>, controller)).catch(reject);
			}
		}));
		disposables.add(quickPick.onDidHide(() => {
			settle({ kind: 'cancel' });
			disposables.dispose();
		}));

		if (typeof options.items === 'function') {
			quickPick.busy = true;
			options.items().then(
				items => {
					if (!settled) {
						quickPick.busy = false;
						setItems(items);
					}
				},
				error => {
					settle({ kind: 'cancel' });
					reject(error);
				},
			);
		} else {
			setItems(options.items);
		}
		quickPick.show();
	});
}

/** Shows a multi-selection quick pick. Resolves with the selection, or undefined when dismissed. */
export function showMultiPicker<T extends vscode.QuickPickItem>(options: {
	readonly title: string;
	readonly placeholder?: string;
	readonly items: readonly T[];
	readonly selected?: readonly T[];
}): Promise<T[] | undefined> {
	return new Promise(resolve => {
		const disposables = new DisposableStore();
		const quickPick = disposables.add(vscode.window.createQuickPick<T>());
		let result: T[] | undefined;
		quickPick.title = options.title;
		quickPick.placeholder = options.placeholder;
		quickPick.canSelectMany = true;
		quickPick.items = options.items;
		quickPick.selectedItems = options.selected ?? [];
		disposables.add(quickPick.onDidAccept(() => {
			result = [...quickPick.selectedItems];
			quickPick.hide();
		}));
		disposables.add(quickPick.onDidHide(() => {
			resolve(result);
			disposables.dispose();
		}));
		quickPick.show();
	});
}

export interface InputToggle {
	readonly id: string;
	readonly label: string;
	readonly icon: string;
	readonly checked: boolean;
}

export interface InputOptions {
	readonly title: string;
	readonly prompt?: string;
	readonly placeholder?: string;
	readonly value?: string;
	readonly validate?: (value: string) => string | undefined;
	/** Boolean options rendered as native toggle buttons in the title bar (the counterpart of dialog checkboxes). */
	readonly toggles?: readonly InputToggle[];
	readonly allowEmpty?: boolean;
}

export interface InputResult {
	readonly value: string;
	readonly toggles: Readonly<Record<string, boolean>>;
}

type ToggleButton = vscode.QuickInputButton & { readonly toggle: { checked: boolean } };

/** Shows an input box. Resolves with the value and toggle states, or undefined when dismissed. */
export function showInput(options: InputOptions): Promise<InputResult | undefined> {
	return new Promise(resolve => {
		const disposables = new DisposableStore();
		const input = disposables.add(vscode.window.createInputBox());
		const toggles = options.toggles ?? [];
		// VS Code flips `toggle.checked` itself when a toggle button is pressed.
		const buttons: ToggleButton[] = toggles.map(toggle => ({
			iconPath: new vscode.ThemeIcon(toggle.icon),
			tooltip: toggle.label,
			toggle: { checked: toggle.checked },
		}));
		let result: InputResult | undefined;

		const states = (): Record<string, boolean> =>
			Object.fromEntries(toggles.map((toggle, index) => [toggle.id, buttons[index].toggle.checked]));
		const renderPrompt = (): void => {
			const current = states();
			const summary = toggles.map(toggle => `${toggle.label}: ${current[toggle.id] ? 'on' : 'off'}`).join(' · ');
			input.prompt = [options.prompt, summary].filter(Boolean).join('  —  ');
		};
		const validate = (value: string): string | undefined => {
			if (!value.trim() && !options.allowEmpty) {
				return undefined;
			}
			return options.validate?.(value.trim());
		};

		input.title = options.title;
		input.placeholder = options.placeholder;
		input.value = options.value ?? '';
		input.valueSelection = options.value ? [0, options.value.length] : undefined;
		input.buttons = buttons;
		renderPrompt();

		disposables.add(input.onDidChangeValue(value => { input.validationMessage = validate(value); }));
		disposables.add(input.onDidTriggerButton(() => renderPrompt()));
		disposables.add(input.onDidAccept(() => {
			const value = input.value.trim();
			if ((!value && !options.allowEmpty) || validate(value)) {
				input.validationMessage = validate(value) ?? 'A value is required';
				return;
			}
			result = { value, toggles: states() };
			input.hide();
		}));
		disposables.add(input.onDidHide(() => {
			resolve(result);
			disposables.dispose();
		}));
		input.show();
	});
}

/** Modal confirmation; resolves true only when the confirming button is chosen. */
export async function confirm(message: string, confirmLabel: string, detail?: string): Promise<boolean> {
	const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, confirmLabel);
	return choice === confirmLabel;
}
