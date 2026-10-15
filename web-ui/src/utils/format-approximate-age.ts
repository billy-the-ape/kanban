const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/**
 * Approximate, network-free age label for a timestamp, e.g. "2h ago".
 */
export function formatApproximateAge(timestamp: number, now: number = Date.now()): string {
	const ageMs = Math.max(0, now - timestamp);
	if (ageMs < MINUTE_MS) {
		return "just now";
	}
	if (ageMs < HOUR_MS) {
		return `${Math.floor(ageMs / MINUTE_MS)}m ago`;
	}
	if (ageMs < DAY_MS) {
		return `${Math.floor(ageMs / HOUR_MS)}h ago`;
	}
	if (ageMs < WEEK_MS) {
		return `${Math.floor(ageMs / DAY_MS)}d ago`;
	}
	if (ageMs < YEAR_MS) {
		return `${Math.floor(ageMs / WEEK_MS)}w ago`;
	}
	return `${Math.floor(ageMs / YEAR_MS)}y ago`;
}
