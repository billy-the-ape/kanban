import type { RuntimeTaskSessionSummary } from "@/runtime/types";

/** Invalid/missing timestamps stay unknown, including dates outside JS's range. */
export function formatDiagnosticsTimestamp(timestamp: number | null | undefined): string | null {
	if (timestamp == null || !Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) {
		return null;
	}
	return new Date(timestamp).toLocaleString(undefined, { timeZoneName: "short" });
}

export function formatDiagnosticsDuration(durationMs: number | null): string | null {
	if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) {
		return null;
	}
	const seconds = Math.floor(durationMs / 1000);
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (days > 0) return `${days}d ${hours}h ${minutes}m`;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds % 60}s`;
	if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
	return `${seconds}s`;
}

/**
 * A summary is only the latest session. Output/hook timestamps may include
 * hydration or lifecycle events; neither updatedAt nor wall-clock age measures
 * executing-agent time. Keep this span frozen at the last recorded activity.
 */
export function getDiagnosticsSessionTiming(
	summary: Pick<RuntimeTaskSessionSummary, "startedAt" | "lastOutputAt" | "lastHookAt"> | null,
): { lastActivityAt: number | null; recordedSpanMs: number | null } {
	const timestamps = [summary?.lastOutputAt, summary?.lastHookAt].filter(
		(value): value is number => value != null && Number.isFinite(value) && Math.abs(value) <= 8.64e15,
	);
	const lastActivityAt = timestamps.length > 0 ? Math.max(...timestamps) : null;
	const start = summary?.startedAt;
	return {
		lastActivityAt,
		recordedSpanMs:
			start != null &&
			Number.isFinite(start) &&
			Math.abs(start) <= 8.64e15 &&
			lastActivityAt !== null &&
			lastActivityAt >= start
				? lastActivityAt - start
				: null,
	};
}
