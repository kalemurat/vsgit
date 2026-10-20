/**
 * Validates a branch or tag name against the rules of `git check-ref-format --branch`
 * (https://git-scm.com/docs/git-check-ref-format). Returns an error message, or undefined when valid.
 * Done in-process so input boxes can validate on every keystroke without spawning git.
 */
export function validateRefName(name: string): string | undefined {
	if (!name) {
		return 'Specify a name';
	}
	if (name === 'HEAD') {
		return 'HEAD is a reserved keyword';
	}
	if (name === '@') {
		return `'@' is not a valid name`;
	}
	if (name.startsWith('-')) {
		return 'The name cannot start with a dash';
	}
	if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) {
		return 'The name cannot contain spaces, control characters or any of ~ ^ : ? * [ \\';
	}
	if (name.includes('..')) {
		return `The name cannot contain '..'`;
	}
	if (name.includes('@{')) {
		return `The name cannot contain '@{'`;
	}
	if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) {
		return 'The name cannot start or end with a slash or contain consecutive slashes';
	}
	if (name.endsWith('.')) {
		return 'The name cannot end with a dot';
	}
	for (const component of name.split('/')) {
		if (component.startsWith('.')) {
			return 'No slash-separated component can start with a dot';
		}
		if (component.endsWith('.lock')) {
			return `No slash-separated component can end with '.lock'`;
		}
	}
	return undefined;
}
