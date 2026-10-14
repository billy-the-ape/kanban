import type { RuntimeTaskSessionSummary } from "@/runtime/types";

export function getIsErrorCardStatus(summary: RuntimeTaskSessionSummary | undefined) {
	if (!summary) {
		return false;
	}
	return (
		summary.state === "failed" ||
		summary.latestHookActivity?.activityText?.trim().startsWith("Failed ") ||
		summary.latestHookActivity?.hookEventName?.trim().toLocaleLowerCase().includes("error")
	);
}

export function getIsPausedCardStatus(summary: RuntimeTaskSessionSummary | undefined) {
	if (!summary) {
		return false;
	}
	return summary.state === "idle" || summary.latestHookActivity?.hookEventName === "concurrency_waiting";
}

export function getQueuePosition(summary: RuntimeTaskSessionSummary | undefined) {
	return summary?.state === "running" && summary.latestHookActivity?.hookEventName === "concurrency_waiting"
		? summary.latestHookActivity.queuePosition
		: null;
}

export function getIsCardCreditLimitError(summary: RuntimeTaskSessionSummary | undefined): boolean {
	if (!summary) {
		return false;
	}
	if (summary.state !== "awaiting_review" && summary.state !== "failed" && summary.state !== "interrupted") {
		return false;
	}
	return summary.latestHookActivity?.notificationType === "credit_limit";
}
