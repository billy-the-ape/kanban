import type { MouseEvent } from "react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { cn } from "@/components/ui/cn";
import { clampTextWithInlineSuffix, type InlineSuffixClampResult } from "@/utils/task-prompt";
import { measureTextWidth } from "@/utils/text-measure";

const SEGMENT_COLLAPSE_LINES = 3;
const SEGMENT_EXPANDED_MAX_LINES = 10;
const SEGMENT_EXPAND_LABEL = "See more";
const SEGMENT_COLLAPSE_LABEL = "Less";
const SEGMENT_COLLAPSE_SUFFIX = `… ${SEGMENT_EXPAND_LABEL}`;
const SEGMENT_EXPANDED_SUFFIX = `… ${SEGMENT_COLLAPSE_LABEL}`;

/**
 * Card description preview showing the first task message followed by the
 * latest user-authored chat message. Each message is clamped independently
 * with its own inline "See more" / "Less" control, separated by "…".
 */
export interface BoardCardDescriptionProps {
	/** Non-empty normalized message texts to display, oldest first. */
	segments: readonly string[];
	/** Measured container width in pixels (0 while the measure observer is pending). */
	width: number;
	/** Font shorthand used for text measurement. */
	font: string;
	/** Muted styling used for trash cards. */
	isMuted?: boolean;
	/** Value that resets every expanded segment when it changes. */
	resetKey: string;
	/** Stops card-level click/drag handling for interactive controls. */
	stopEvent: (event: MouseEvent<HTMLElement>) => void;
	/** Ref attached to the first rendered paragraph (used for font sampling). */
	firstParagraphRef?: (element: HTMLParagraphElement | null) => void;
}

interface SegmentClamp {
	collapsed: InlineSuffixClampResult;
	expanded: InlineSuffixClampResult;
}

function clampSegment(text: string, width: number, font: string): SegmentClamp {
	if (width <= 0) {
		return {
			collapsed: { text, isTruncated: false },
			expanded: { text, isTruncated: false },
		};
	}
	const measure = (value: string) => measureTextWidth(value, font);
	return {
		collapsed: clampTextWithInlineSuffix(text, {
			maxWidthPx: width,
			maxLines: SEGMENT_COLLAPSE_LINES,
			suffix: SEGMENT_COLLAPSE_SUFFIX,
			measureText: measure,
		}),
		expanded: clampTextWithInlineSuffix(text, {
			maxWidthPx: width,
			maxLines: SEGMENT_EXPANDED_MAX_LINES,
			suffix: SEGMENT_EXPANDED_SUFFIX,
			measureText: measure,
		}),
	};
}

interface DescriptionSegmentProps {
	text: string;
	clamp: SegmentClamp;
	isExpanded: boolean;
	isMeasured: boolean;
	isMuted: boolean;
	stopEvent: (event: MouseEvent<HTMLButtonElement>) => void;
	onToggle: () => void;
	refCallback?: (element: HTMLParagraphElement | null) => void;
}

function DescriptionSegment({
	text,
	clamp,
	isExpanded,
	isMeasured,
	isMuted,
	stopEvent,
	onToggle,
	refCallback,
}: DescriptionSegmentProps): React.ReactElement {
	const active = isExpanded ? clamp.expanded : clamp.collapsed;
	return (
		<p
			ref={refCallback}
			className={cn(
				"text-sm leading-[1.4] max-w-full overflow-hidden",
				isMuted ? "text-text-tertiary" : "text-text-secondary",
				!isMeasured && !isExpanded && "line-clamp-3",
			)}
			style={{ margin: 0 }}
		>
			{active.isTruncated ? active.text : text}
			{active.isTruncated ? (
				<>
					{"… "}
					<button
						type="button"
						className="inline cursor-pointer rounded-sm text-text-tertiary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [font:inherit]"
						aria-expanded={isExpanded}
						aria-label={isExpanded ? "Collapse task description" : "Expand task description"}
						onMouseDown={stopEvent}
						onClick={(event) => {
							stopEvent(event);
							onToggle();
						}}
					>
						{isExpanded ? SEGMENT_COLLAPSE_LABEL : SEGMENT_EXPAND_LABEL}
					</button>
				</>
			) : isExpanded && clamp.collapsed.isTruncated ? (
				<>
					{" "}
					<button
						type="button"
						className="inline cursor-pointer rounded-sm text-text-tertiary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [font:inherit]"
						aria-expanded
						aria-label="Collapse task description"
						onMouseDown={stopEvent}
						onClick={(event) => {
							stopEvent(event);
							onToggle();
						}}
					>
						{SEGMENT_COLLAPSE_LABEL}
					</button>
				</>
			) : null}
		</p>
	);
}

export function BoardCardDescription({
	segments,
	width,
	font,
	isMuted = false,
	resetKey,
	stopEvent,
	firstParagraphRef,
}: BoardCardDescriptionProps): React.ReactElement | null {
	const [expandedSegments, setExpandedSegments] = useState<ReadonlySet<number>>(new Set());

	useEffect(() => {
		setExpandedSegments(new Set());
	}, [resetKey]);

	const clamps = useMemo(() => segments.map((text) => clampSegment(text, width, font)), [font, segments, width]);
	const isMeasured = width > 0;

	if (segments.length === 0) {
		return null;
	}

	const toggleSegment = (index: number) => {
		setExpandedSegments((current) => {
			const next = new Set(current);
			if (next.has(index)) {
				next.delete(index);
			} else {
				next.add(index);
			}
			return next;
		});
	};

	return (
		<div className="mt-0.5">
			{segments.map((text, index) => {
				const clamp = clamps[index] ?? {
					collapsed: { text, isTruncated: false },
					expanded: { text, isTruncated: false },
				};
				return (
					<Fragment key={index}>
						{index > 0 ? (
							<div
								aria-hidden
								className={cn("text-sm leading-[1.4]", isMuted ? "text-text-tertiary" : "text-text-secondary")}
								style={{ margin: 0 }}
							>
								…
							</div>
						) : null}
						<DescriptionSegment
							text={text}
							clamp={clamp}
							isExpanded={expandedSegments.has(index)}
							isMeasured={isMeasured}
							isMuted={isMuted}
							stopEvent={stopEvent}
							onToggle={() => toggleSegment(index)}
							refCallback={index === 0 ? firstParagraphRef : undefined}
						/>
					</Fragment>
				);
			})}
		</div>
	);
}
