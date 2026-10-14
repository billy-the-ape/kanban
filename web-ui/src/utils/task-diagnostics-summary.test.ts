import { describe, expect, it } from "vitest";
import {
	formatDiagnosticsDuration,
	formatDiagnosticsTimestamp,
	getDiagnosticsSessionTiming,
} from "./task-diagnostics-summary";

describe("diagnostics session timing", () => {
	it("uses the latest output or hook, without extending stopped sessions to now", () => {
		expect(getDiagnosticsSessionTiming({ startedAt: 1000, lastOutputAt: 61_000, lastHookAt: 91_000 })).toEqual({
			lastActivityAt: 91_000,
			recordedSpanMs: 90_000,
		});
		expect(getDiagnosticsSessionTiming({ startedAt: 1000, lastOutputAt: 91_000, lastHookAt: 61_000 })).toEqual({
			lastActivityAt: 91_000,
			recordedSpanMs: 90_000,
		});
	});

	it("keeps missing data and reversed clocks unknown", () => {
		expect(getDiagnosticsSessionTiming(null)).toEqual({ lastActivityAt: null, recordedSpanMs: null });
		expect(getDiagnosticsSessionTiming({ startedAt: 1000, lastOutputAt: null, lastHookAt: null })).toEqual({
			lastActivityAt: null,
			recordedSpanMs: null,
		});
		expect(getDiagnosticsSessionTiming({ startedAt: 2000, lastOutputAt: 1000, lastHookAt: null })).toEqual({
			lastActivityAt: 1000,
			recordedSpanMs: null,
		});
	});

	it("ignores non-finite and out-of-range timestamps rather than displaying invalid dates", () => {
		expect(getDiagnosticsSessionTiming({ startedAt: 1000, lastOutputAt: Number.NaN, lastHookAt: 9e15 })).toEqual({
			lastActivityAt: null,
			recordedSpanMs: null,
		});
		expect(formatDiagnosticsTimestamp(null)).toBeNull();
		expect(formatDiagnosticsTimestamp(Number.POSITIVE_INFINITY)).toBeNull();
		expect(formatDiagnosticsTimestamp(9e15)).toBeNull();
		expect(formatDiagnosticsTimestamp(0)).not.toBeNull();
	});

	it("formats spans across minutes, hours and days and preserves a measured zero", () => {
		expect(formatDiagnosticsDuration(0)).toBe("0s");
		expect(formatDiagnosticsDuration(90_999)).toBe("1m 30s");
		expect(formatDiagnosticsDuration(3_661_000)).toBe("1h 1m 1s");
		expect(formatDiagnosticsDuration(90_061_000)).toBe("1d 1h 1m");
		for (const value of [null, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(formatDiagnosticsDuration(value)).toBeNull();
		}
	});
});
