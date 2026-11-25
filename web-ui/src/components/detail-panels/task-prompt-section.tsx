import * as Collapsible from "@radix-ui/react-collapsible";
import { Check, ChevronDown, Copy, PencilLine } from "lucide-react";
import { type ReactElement, useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";

/**
 * The task's own stored prompt, shown without an agent session.
 *
 * The prompt lives on the board card, not in the terminal or the Cline
 * transcript, so it stays readable and editable even when no agent ever ran for
 * the task — the exact state a failed launch leaves behind. It is deliberately
 * separate from the conversation views: this is what Kanban was asked to do,
 * which is not the same thing as the messages already sent to a running agent.
 */
export function TaskPromptSection({
	prompt,
	columnLabel,
	canEdit,
	onEdit,
	collapseByDefault = true,
}: {
	prompt: string;
	/** Where the card currently sits, so "stored prompt" is unambiguous. */
	columnLabel?: string | null;
	/** Only a task that never successfully launched may have its prompt rewritten. */
	canEdit?: boolean;
	onEdit?: () => void;
	collapseByDefault?: boolean;
}): ReactElement | null {
	const trimmed = prompt.trim();
	const [isOpen, setIsOpen] = useState(!collapseByDefault || trimmed.length <= 240);
	const [isCopied, setIsCopied] = useState(false);

	const handleCopy = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(trimmed);
			setIsCopied(true);
			window.setTimeout(() => setIsCopied(false), 1500);
		} catch {
			// A browser can refuse clipboard access (insecure context); the text is
			// still fully visible on screen, so nothing is lost.
		}
	}, [trimmed]);

	if (!trimmed) {
		return null;
	}

	return (
		// The strip is rendered next to panels that already bring their own tooltip
		// provider, and Radix `Tooltip` refuses to render without one, so the
		// section owns a provider instead of depending on which host mounts it.
		<TooltipProvider>
			<div className="shrink-0 border-b border-border bg-surface-1">
				<Collapsible.Root open={isOpen} onOpenChange={setIsOpen}>
					<div className="flex items-center gap-1 px-3 py-1.5">
						<Collapsible.Trigger asChild>
							<button
								type="button"
								aria-expanded={isOpen}
								className="inline-flex min-w-0 items-center gap-1 text-[11px] text-text-secondary hover:text-text-primary cursor-pointer bg-transparent border-none p-0"
							>
								<ChevronDown
									size={12}
									className={isOpen ? "rotate-0 transition-transform" : "-rotate-90 transition-transform"}
								/>
								<span className="truncate">
									Task prompt
									{columnLabel ? <span className="text-text-tertiary"> · {columnLabel}</span> : null}
								</span>
							</button>
						</Collapsible.Trigger>
						<div className="ml-auto flex items-center gap-1">
							<Tooltip content={isCopied ? "Copied" : "Copy the full prompt"}>
								<Button
									variant="ghost"
									size="sm"
									icon={isCopied ? <Check size={12} /> : <Copy size={12} />}
									onClick={() => void handleCopy()}
									aria-label="Copy task prompt"
								/>
							</Tooltip>
							{canEdit && onEdit ? (
								<Tooltip content="Edit prompt and launch settings">
									<Button
										variant="ghost"
										size="sm"
										icon={<PencilLine size={12} />}
										onClick={onEdit}
										aria-label="Edit task prompt and settings"
									/>
								</Tooltip>
							) : null}
						</div>
					</div>
					{isOpen ? (
						<Collapsible.Content>
							<p
								className="m-0 whitespace-pre-wrap break-words px-3 pb-2.5 pt-0 text-[12px] leading-relaxed text-text-primary max-h-64 overflow-y-auto"
								data-testid="task-prompt-text"
							>
								{prompt}
							</p>
						</Collapsible.Content>
					) : null}
				</Collapsible.Root>
			</div>
		</TooltipProvider>
	);
}
