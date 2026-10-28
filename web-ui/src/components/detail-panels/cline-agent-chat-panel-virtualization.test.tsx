import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClineAgentChatPanel, CHAT_VIRTUALIZATION_THRESHOLD } from "@/components/detail-panels/cline-agent-chat-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ClineChatMessage } from "@/hooks/use-cline-chat-session";

// JSDOM has no layout engine or ResizeObserver measurements. This shim models
// the window contract and tests that the actual chat panel supplies bounded
// rows, stable message IDs, and preserved expansion state across unmounts.
// Real virtualizer geometry requires a browser test.
vi.mock("react-virtuoso", async () => {
	const React = await import("react");
	type MockProps = {
		data: ClineChatMessage[];
		itemContent: (index: number, message: ClineChatMessage) => React.ReactNode;
		initialTopMostItemIndex: { index: number };
		atBottomStateChange?: (atBottom: boolean) => void;
		followOutput?: boolean;
	};
	type MockHandle = { scrollToIndex: (location: { index: number }) => void };
	return {
		Virtuoso: React.forwardRef<MockHandle, MockProps>(function MockVirtuoso(props, ref) {
			const { data, itemContent, atBottomStateChange } = props;
			const [start, setStart] = React.useState(() => Math.max(0, data.length - 6));
			React.useImperativeHandle(ref, () => ({
				scrollToIndex: ({ index }) => setStart(Math.max(0, Math.min(index, data.length - 6))),
			}), [data.length]);
			return (
				<div data-testid="virtual-chat-list" data-initial-index={props.initialTopMostItemIndex.index}>
					<button
					type="button"
					data-testid="show-oldest"
					onClick={() => { setStart(0); atBottomStateChange?.(false); }}
					>Oldest</button>
					<button
					type="button"
					data-testid="show-newest"
					onClick={() => { setStart(Math.max(0, data.length - 6)); atBottomStateChange?.(true); }}
					>Newest</button>
					{data.slice(start, start + 6).map((message, offset) => (
						<div key={message.id}>{itemContent(start + offset, message)}</div>
					))}
				</div>
			);
		}),
	};
});

function message(index: number): ClineChatMessage {
	return {
		id: `message-${index}`,
		role: "assistant",
		content: `Reply ${index}: \`code\` and **Markdown**\n\n\`\`\`ts\nconst value = ${index};\n\`\`\``,
		createdAt: index,
	};
}

describe("ClineAgentChatPanel long conversations", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
		}
	});

	async function render(panel: ReactElement): Promise<void> {
		await act(async () => {
			root.render(<TooltipProvider>{panel}</TooltipProvider>);
			await Promise.resolve();
		});
	}

	async function click(testId: string): Promise<void> {
		const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
		expect(button).toBeInstanceOf(HTMLButtonElement);
		await act(async () => { button?.click(); });
	}

	it("virtualizes a thousand mixed-size messages and starts at the latest message", async () => {
		const messages = Array.from({ length: 1000 }, (_, index) => message(index));
		const onLoadMessages = async () => messages;
		await render(<ClineAgentChatPanel taskId="task-large" summary={null} onLoadMessages={onLoadMessages} />);
		expect(CHAT_VIRTUALIZATION_THRESHOLD).toBeLessThan(messages.length);
		expect(container.querySelector('[data-testid="virtual-chat-list"]')?.getAttribute("data-initial-index")).toBe("999");
		expect(container.querySelectorAll('[data-testid="virtual-chat-message"]')).toHaveLength(6);
		expect(container.textContent).toContain("Reply 999:");
		expect(container.textContent).not.toContain("Reply 0:");
		await click("show-oldest");
		expect(container.textContent).toContain("Reply 0:");
		expect(container.querySelectorAll('[data-testid="virtual-chat-message"]')).toHaveLength(6);
	});

	it("keeps a tool's expansion state when its virtualized row unmounts and returns", async () => {
		const messages = Array.from({ length: 120 }, (_, index) => message(index));
		messages[0] = {
			id: "tool-0",
			role: "tool",
			createdAt: 0,
			content: 'Tool: editor\nInput:\n{"path":"src/app.ts"}\nOutput:\n{"success":true,"result":"Saved successfully"}',
		};
		const onLoadMessages = async () => messages;
		await render(<ClineAgentChatPanel taskId="task-tool" summary={null} onLoadMessages={onLoadMessages} />);
		await click("show-oldest");
		const toolToggle = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("editor"));
		expect(toolToggle).toBeDefined();
		await act(async () => { toolToggle?.click(); });
		expect(container.textContent).toContain("Saved successfully");
		await click("show-newest");
		expect(container.textContent).not.toContain("Saved successfully");
		await click("show-oldest");
		expect(container.textContent).toContain("Saved successfully");
	});
});
