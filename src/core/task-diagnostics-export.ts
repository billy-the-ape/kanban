// B-10.7: redacted task diagnostics export bundle.
//
// The bundle is meant to be shared when asking for help, so it keeps the
// operational facts (phases, stages, SHAs, branch names, statuses, counts)
// and drops free text that carries task content or model output: the task
// title and prompt, the session transcript, review handoff and finding text,
// hook activity text, and the local home directory in paths. `redactions`
// names every category that was present and removed.
import type { RuntimeTaskDiagnosticsResponse } from "./api-contract";

export const DIAGNOSTICS_REDACTED_TEXT = "[redacted]";

export interface TaskDiagnosticsExportInput {
	diagnostics: RuntimeTaskDiagnosticsResponse;
	/** Messages in the task's transcript (0 when none); the transcript itself is never exported. */
	transcriptMessageCount: number;
	/** Local home directory; occurrences in the bundle are rewritten to `~`. */
	homeDirectory: string | null;
	exportedAt: string;
}

export interface TaskDiagnosticsExportBundle {
	bundle: Record<string, unknown>;
	redactions: string[];
}

function redactTextList(values: string[]): { count: number } {
	return { count: values.length };
}

export function buildTaskDiagnosticsExportBundle(input: TaskDiagnosticsExportInput): TaskDiagnosticsExportBundle {
	const { diagnostics } = input;
	const redactions: string[] = [];

	const task = diagnostics.task ? { ...diagnostics.task, title: DIAGNOSTICS_REDACTED_TEXT } : null;
	if (diagnostics.task) {
		redactions.push("task_title");
	}

	let dispatchRecord = diagnostics.dispatchRecord;
	if (dispatchRecord?.prompt) {
		redactions.push("dispatch_prompt");
		dispatchRecord = { ...dispatchRecord, prompt: null };
	}

	if (input.transcriptMessageCount > 0) {
		redactions.push("session_transcript");
	}

	const { handoff, result } = diagnostics.review;
	if (handoff) {
		redactions.push("review_handoff_text");
	}
	if (result) {
		redactions.push("review_result_text");
	}
	const review = {
		...diagnostics.review,
		handoff: handoff
			? {
					...handoff,
					acceptanceCriteria: redactTextList(handoff.acceptanceCriteria),
					designDecisions: redactTextList(handoff.designDecisions),
					testsAttempted: redactTextList(handoff.testsAttempted),
					knownLimitations: redactTextList(handoff.knownLimitations),
					unresolvedQuestions: redactTextList(handoff.unresolvedQuestions),
				}
			: null,
		result: result
			? {
					...result,
					findings: result.findings.map((finding) => ({
						severity: finding.severity,
						file: finding.file,
						line: finding.line,
					})),
					fixesApplied: redactTextList(result.fixesApplied),
					requirementsCovered: redactTextList(result.requirementsCovered),
					unresolvedItems: redactTextList(result.unresolvedItems),
				}
			: null,
	};

	const summary = diagnostics.session.summary;
	if (summary?.latestHookActivity || summary?.warningMessage) {
		redactions.push("session_activity_text");
	}

	const bundle = {
		schemaVersion: 2,
		exportedAt: input.exportedAt,
		task,
		phase: diagnostics.phase,
		lastSuccessfulPhase: diagnostics.lastSuccessfulPhase,
		needsAttention: diagnostics.needsAttention,
		blockedReason: diagnostics.blockedReason,
		branch: diagnostics.branch,
		commit: diagnostics.commit,
		baseRef: diagnostics.baseRef,
		baseSha: diagnostics.baseSha,
		workspace: diagnostics.workspace,
		preservedWork: diagnostics.preservedWork,
		delivery: diagnostics.delivery,
		review,
		dispatchRecord,
		session: {
			summary: summary ? { ...summary, latestHookActivity: null, warningMessage: null } : null,
			active: diagnostics.session.active,
			transcriptRedacted: input.transcriptMessageCount > 0,
		},
		context: diagnostics.context,
		actions: diagnostics.actions,
	};

	// Rewrite the home directory in the serialized form (it appears inside
	// larger path strings), escaped the same way JSON escapes it.
	let serialized = JSON.stringify(bundle);
	const homeDirectory = input.homeDirectory;
	if (homeDirectory && homeDirectory !== "/") {
		const escapedHome = JSON.stringify(homeDirectory).slice(1, -1);
		if (serialized.includes(escapedHome)) {
			redactions.push("home_directory");
			serialized = serialized.split(escapedHome).join("~");
		}
	}
	return { redactions, bundle: JSON.parse(serialized) as Record<string, unknown> };
}
