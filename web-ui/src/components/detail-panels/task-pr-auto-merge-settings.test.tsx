import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutoMergePolicy, RuntimeTaskTrackingStateResponse } from "@/runtime/types";
import { TaskPrAutoMergeSettings } from "./task-pr-auto-merge-settings";

const mocks = vi.hoisted(() => ({ save: vi.fn(), policy: null as AutoMergePolicy | null }));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({ workspace: { prTracking: { setTaskPrSettings: { mutate: mocks.save } } } }),
}));
vi.mock("@/runtime/use-trpc-query", () => ({ useTrpcQuery: () => ({ data: mocks.policy, isLoading: false }) }));
vi.mock("./task-pr-auto-merge-policy", () => ({ TaskPrAutoMergePolicyPanel: () => <div>CI policy setup</div> }));

let root: Root;
let container: HTMLDivElement;
afterEach(async () => {
	if (root) await act(async () => root.unmount());
	container?.remove();
	vi.clearAllMocks();
	mocks.policy = null;
});
async function render(overrides: Partial<RuntimeTaskTrackingStateResponse> = {}) {
	const tracking: RuntimeTaskTrackingStateResponse = {
		ok: true,
		taskId: "t1",
		settingsRevision: 0,
		staleRevision: false,
		autoAddressComments: true,
		autoFinishOnMerge: true,
		autoMergeWhenApproved: true,
		armedAutoMergePolicyRevision: null,
		selectedAutomationPrKey: "github|github.com|owner/repo|1",
		explicitAutomationPrKey: null,
		eligible: true,
		legacyCompletionGated: true,
		mergeFinishesInReview: true,
		blockers: [],
		commentsSupportedForTask: true,
		owner: null,
		ownerLabel: null,
		ownerCandidates: [],
		reservation: { state: "none", reservedBy: null, reservedOperation: null, fencingGeneration: 0 },
		snapshot: null,
		terminalStop: null,
		error: null,
		...overrides,
	};
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const refetch = vi.fn(async () => tracking);
	mocks.save.mockResolvedValue({ ok: true });
	await act(async () =>
		root.render(<TaskPrAutoMergeSettings workspaceId="w1" taskId="t1" tracking={tracking} refetch={refetch} />),
	);
	return container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
}

describe("auto-merge preference", () => {
	it("shows on while waiting for policy setup and allows turning it off", async () => {
		const checkbox = await render();
		expect(checkbox.checked).toBe(true);
		expect(checkbox.disabled).toBe(false);
		expect(container.textContent).toContain("Waiting: configure the required CI checks below");
		await act(async () => checkbox.click());
		expect(mocks.save).toHaveBeenCalledWith({ taskId: "t1", autoMergeWhenApproved: false });
	});
	it("allows enabling without a PR or policy and saves directly", async () => {
		const checkbox = await render({ autoMergeWhenApproved: false, selectedAutomationPrKey: null });
		expect(checkbox.disabled).toBe(false);
		await act(async () => checkbox.click());
		expect(mocks.save).toHaveBeenCalledWith({ taskId: "t1", autoMergeWhenApproved: true });
	});
	it("accepts a sole linked PR without explicit selection", async () => {
		mocks.policy = {
			repository: "owner/repo",
			requiredChecks: ["ci"],
			revision: 1,
			mergeMethod: "merge",
			updatedAt: 1,
		};
		const checkbox = await render({ armedAutoMergePolicyRevision: 1 });
		expect(checkbox.disabled).toBe(false);
		expect(container.textContent).not.toContain("Record and select");
		expect(container.textContent).toContain("Waiting for the first verification");
	});
	it("shows an actionable policy drift message without locking the checkbox", async () => {
		mocks.policy = {
			repository: "owner/repo",
			requiredChecks: ["ci"],
			revision: 2,
			mergeMethod: "merge",
			updatedAt: 1,
		};
		const checkbox = await render({ armedAutoMergePolicyRevision: 1 });
		expect(checkbox.disabled).toBe(false);
		expect(container.textContent).toContain("Turn auto-merge off and on");
	});
});
