import { cn } from "../ui/cn";

interface TaskPrTrackingCheckboxProps {
	label: string;
	hint: string | null;
	checked: boolean;
	disabled: boolean;
	acting: boolean;
	onChange: (next: boolean) => void;
	testId?: string;
}

export function TaskPrTrackingCheckbox({
	label,
	hint,
	checked,
	disabled,
	acting,
	onChange,
	testId,
}: TaskPrTrackingCheckboxProps): React.ReactElement {
	return (
		<label
			className={cn(
				"flex items-start gap-2 text-xs text-text-secondary",
				!disabled && "cursor-pointer hover:text-text-primary",
			)}
		>
			<input
				type="checkbox"
				checked={checked}
				disabled={disabled || acting}
				onChange={(event) => onChange(event.target.checked)}
				className="mt-0.5 h-3.5 w-3.5 accent-(--color-accent)"
				aria-label={label}
				data-state={checked ? "checked" : "unchecked"}
				{...(testId && { "data-testid": testId })}
			/>
			<span className="leading-tight">
				{label}
				{hint ? <span className="block text-text-tertiary">{hint}</span> : null}
			</span>
		</label>
	);
}
