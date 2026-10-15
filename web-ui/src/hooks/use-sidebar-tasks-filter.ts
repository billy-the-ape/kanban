import type { RuntimeTaskDisplayState } from "@runtime-task-display-state";
import { useCallback, useState } from "react";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";

const KNOWN_TASK_DISPLAY_STATES = new Set<RuntimeTaskDisplayState>([
	"backlog",
	"in_progress",
	"paused",
	"review",
	"done",
	"trash",
]);

const DEFAULT_SELECTED_STATES: readonly RuntimeTaskDisplayState[] = ["in_progress"];

function createDefaultSelection(): ReadonlySet<RuntimeTaskDisplayState> {
	return new Set<RuntimeTaskDisplayState>(DEFAULT_SELECTED_STATES);
}

function readStoredSelection(): ReadonlySet<RuntimeTaskDisplayState> {
	const raw = readLocalStorageItem(LocalStorageKey.SidebarTasksFilter);
	if (raw === null) {
		return createDefaultSelection();
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			return createDefaultSelection();
		}
		// An empty array is a valid stored value (the user switched every state
		// off); unknown/foreign entries are ignored.
		const valid = parsed.filter(
			(value): value is RuntimeTaskDisplayState =>
				typeof value === "string" && KNOWN_TASK_DISPLAY_STATES.has(value as RuntimeTaskDisplayState),
		);
		return new Set<RuntimeTaskDisplayState>(valid);
	} catch {
		return createDefaultSelection();
	}
}

/**
 * Sidebar task state filter: which of the six display states are shown. The
 * selection persists per browser; invalid/legacy values fall back to the
 * "In progress" default.
 */
export function useSidebarTasksFilter(): {
	selectedStates: ReadonlySet<RuntimeTaskDisplayState>;
	toggleState: (state: RuntimeTaskDisplayState) => void;
} {
	const [selectedStates, setSelectedStates] = useState<ReadonlySet<RuntimeTaskDisplayState>>(readStoredSelection);

	const toggleState = useCallback((state: RuntimeTaskDisplayState) => {
		setSelectedStates((current) => {
			const next = new Set<RuntimeTaskDisplayState>(current);
			if (next.has(state)) {
				next.delete(state);
			} else {
				next.add(state);
			}
			writeLocalStorageItem(LocalStorageKey.SidebarTasksFilter, JSON.stringify([...next]));
			return next;
		});
	}, []);

	return { selectedStates, toggleState };
}
