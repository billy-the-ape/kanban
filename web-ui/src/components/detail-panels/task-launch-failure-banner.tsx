import { AlertCircle, Play, TriangleAlert } from "lucide-react";
import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { RuntimeTaskLaunchRecoveryResponse } from "@/runtime/types";

/**
 * The "nothing is running and nothing ever started" banner.
 *
 * A card with a prepared worktree and no agent session used to be
 * indistinguishable from an ordinary paused task: an idle state, an empty
 * terminal, no error. Whatever broke (an unsupported setting, an adapter that
 * refused the request, a spawn the OS rejected) was reported once in a toast and
 * then nowhere at all.
 *
 * The banner is driven by the server's assessment (`neverLaunched`) rather than
 * by the absence of a pid: an interrupted session that can be restored, or a
 * finished one waiting for review, must not be told it never started.
 */
export function TaskLaunchFailureBanner({
	recovery,
	launchFailure,
	isRecovering = false,
	onRecover,
	onEditSettings,
}: {
	/** The server's read of "did this task ever launch, and can it be relaunched". */
	recovery: RuntimeTaskLaunchRecoveryResponse | null;
	/** Durable failure text from the session record, when the launch left one. */
	launchFailure?: string | null;
	isRecovering?: boolean;
	onRecover?: () => void;
	onEditSettings?: () => void;
}): ReactElement | null {
	const neverLaunched = recovery?.neverLaunched === true;
	const failure = launchFailure ?? null;
	if (!neverLaunched && !failure) {
		return null;
	}
	const recoverable = recovery?.recoverable === true;
	const explanation = failure ?? recovery?.reason ?? null;

	return (
		<div className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-status-red/10 px-3 py-2">
			<div className="flex items-start gap-2">
				{failure ? (
					<AlertCircle size={14} className="mt-0.5 shrink-0 text-status-red" />
				) : (
					<TriangleAlert size={14} className="mt-0.5 shrink-0 text-status-orange" />
				)}
				<div className="min-w-0 flex-1">
					<p className="m-0 text-[12px] font-medium text-text-primary">
						{neverLaunched ? "This task never started an agent" : "The agent session failed"}
					</p>
					{explanation ? (
						<p className="mt-0.5 mb-0 text-[11px] leading-relaxed text-text-secondary break-words">
							{explanation}
						</p>
					) : null}
					{recovery?.settingsError ? (
						<p className="mt-1 mb-0 text-[11px] leading-relaxed text-status-orange break-words">
							{recovery.settingsError}
						</p>
					) : null}
				</div>
			</div>
			{recoverable && onRecover ? (
				<div className="ml-6 flex items-center gap-2">
					<Button size="sm" variant="primary" disabled={isRecovering} onClick={onRecover}>
						<span className="inline-flex items-center gap-1.5">
							{isRecovering ? <Spinner size={12} /> : <Play size={12} />}
							Start with saved prompt
						</span>
					</Button>
					<span className="text-[11px] text-text-tertiary">
						Reuses this worktree at its saved baseline — nothing is recreated.
					</span>
				</div>
			) : null}
			{!recoverable && onEditSettings ? (
				<div className="ml-6">
					<Button size="sm" onClick={onEditSettings}>
						Edit launch settings
					</Button>
				</div>
			) : null}
		</div>
	);
}
