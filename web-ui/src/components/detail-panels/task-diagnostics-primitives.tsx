// DIAG-PANEL: shared layout primitives for the diagnostics detail panel
// (section shell + label/value row), used by the phase/session/git sections
// and the recorded quality summary section.
import { cn } from "@/components/ui/cn";

export function DiagnosticsValue({
	label,
	value,
}: {
	label: string;
	value: string | null | undefined;
}): React.ReactElement {
	const text = value?.trim();
	return (
		<div className="flex items-baseline gap-2">
			<span className="w-28 shrink-0 text-text-secondary">{label}</span>
			<span
				className={cn("min-w-0 flex-1 truncate font-mono", text ? "text-text-primary" : "text-text-tertiary")}
				title={text ?? undefined}
			>
				{text ?? "—"}
			</span>
		</div>
	);
}

export function DiagnosticsSection({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<div className="border-b border-divider px-3 py-2 last:border-b-0">
			<h4 className="mb-1.5 text-[11px] font-semibold tracking-wider text-text-secondary uppercase m-0">{title}</h4>
			<div className="space-y-1">{children}</div>
		</div>
	);
}
