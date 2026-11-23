export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
	['year', 365 * 24 * 3600],
	['month', 30 * 24 * 3600],
	['week', 7 * 24 * 3600],
	['day', 24 * 3600],
	['hour', 3600],
	['minute', 60],
];

const relativeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** Formats a past instant relative to `now`, e.g. "5 minutes ago". */
export function fromNow(date: Date, now: Date = new Date()): string {
	const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
	for (const [unit, unitSeconds] of RELATIVE_UNITS) {
		if (Math.abs(seconds) >= unitSeconds) {
			return relativeFormat.format(-Math.floor(seconds / unitSeconds), unit);
		}
	}
	return 'just now';
}

/** Wraps a ref name in quotes the way WebStorm labels its branch actions. */
export function quote(name: string): string {
	return `'${name}'`;
}
