import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalStorageKey } from "@/storage/local-storage-store";
import { useSidebarTasksFilter } from "./use-sidebar-tasks-filter";

const hookResultRef: { current: ReturnType<typeof useSidebarTasksFilter> | null } = { current: null };

function HookHarness(): null {
	hookResultRef.current = useSidebarTasksFilter();
	return null;
}

describe("useSidebarTasksFilter", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		window.localStorage.clear();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		hookResultRef.current = null;
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		window.localStorage.clear();
	});

	it("defaults to the In progress state when nothing is stored", async () => {
		await act(async () => {
			root.render(<HookHarness />);
		});
		expect([...(hookResultRef.current?.selectedStates ?? [])]).toEqual(["in_progress"]);
	});

	it("toggles states and persists the selection", async () => {
		await act(async () => {
			root.render(<HookHarness />);
		});
		await act(async () => {
			hookResultRef.current?.toggleState("done");
		});
		expect(hookResultRef.current?.selectedStates.has("in_progress")).toBe(true);
		expect(hookResultRef.current?.selectedStates.has("done")).toBe(true);
		expect(JSON.parse(window.localStorage.getItem(LocalStorageKey.SidebarTasksFilter) ?? "null")).toEqual([
			"in_progress",
			"done",
		]);
		await act(async () => {
			hookResultRef.current?.toggleState("in_progress");
		});
		expect(hookResultRef.current?.selectedStates.has("in_progress")).toBe(false);
	});

	it("reads the persisted selection into a new instance", async () => {
		window.localStorage.setItem(LocalStorageKey.SidebarTasksFilter, JSON.stringify(["backlog", "trash"]));
		await act(async () => {
			root.render(<HookHarness />);
		});
		expect([...(hookResultRef.current?.selectedStates ?? [])].sort()).toEqual(["backlog", "trash"]);
	});

	it("supports an empty stored selection (all states off)", async () => {
		window.localStorage.setItem(LocalStorageKey.SidebarTasksFilter, "[]");
		await act(async () => {
			root.render(<HookHarness />);
		});
		expect(hookResultRef.current?.selectedStates.size).toBe(0);
	});

	it("ignores unknown states", async () => {
		window.localStorage.setItem(LocalStorageKey.SidebarTasksFilter, JSON.stringify(["review", "bogus"]));
		await act(async () => {
			root.render(<HookHarness />);
		});
		expect([...(hookResultRef.current?.selectedStates ?? [])]).toEqual(["review"]);
	});

	it("falls back for invalid storage", async () => {
		window.localStorage.setItem(LocalStorageKey.SidebarTasksFilter, "{not json");
		await act(async () => {
			root.render(<HookHarness />);
		});
		expect([...(hookResultRef.current?.selectedStates ?? [])]).toEqual(["in_progress"]);
	});
});
