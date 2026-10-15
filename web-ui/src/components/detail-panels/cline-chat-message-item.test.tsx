import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClineChatMessageItem } from "@/components/detail-panels/cline-chat-message-item";
import type { ClineChatMessage } from "@/hooks/use-cline-chat-session";

function toolMessage(id: string, content: string): ClineChatMessage {
	return {
		id,
		role: "tool",
		content,
		createdAt: 1,
	};
}

function findToolToggle(container: HTMLElement, text: string): HTMLButtonElement {
	const toggle = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes(text));
	expect(toggle).toBeInstanceOf(HTMLButtonElement);
	if (!(toggle instanceof HTMLButtonElement)) {
		throw new Error(`Expected tool toggle button containing ${text}`);
	}
	return toggle;
}

describe("ClineChatMessageItem tool messages", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function renderMessage(message: ClineChatMessage): Promise<void> {
		return act(async () => {
			root.render(<ClineChatMessageItem message={message} />);
			await Promise.resolve();
		});
	}

	async function expandTool(containerElement: HTMLElement, toggleText: string): Promise<void> {
		await act(async () => {
			findToolToggle(containerElement, toggleText).click();
			await Promise.resolve();
		});
	}

	it("keeps the collapsed summary unchanged and hides the recorded input", async () => {
		const editorInput = JSON.stringify({ path: "/tmp/app.ts", old_text: "foo", new_text: "bar" }, null, 2);
		const message = toolMessage("tool-1", `Tool: editor\nInput:\n${editorInput}\nDuration: 12ms`);

		await renderMessage(message);

		expect(container.textContent).toContain("/tmp/app.ts");
		expect(container.textContent).not.toContain("old_text");
		expect(container.textContent).not.toContain("Input");
		expect(container.querySelector("pre")).toBeNull();
	});

	it("shows the exact recorded editor input with old_text when expanded", async () => {
		const editorInput = JSON.stringify({ path: "/tmp/app.ts", old_text: "foo", new_text: "bar" }, null, 2);
		const output = JSON.stringify({
			query: "replace in /tmp/app.ts",
			result: "Edit applied.",
			success: true,
		});
		const message = toolMessage("tool-1", `Tool: editor\nInput:\n${editorInput}\nOutput:\n${output}\nDuration: 12ms`);

		await renderMessage(message);
		await expandTool(container, "editor");

		expect(container.textContent).toContain("Input");
		expect(container.textContent).toContain('"old_text": "foo"');
		expect(container.textContent).toContain('"new_text": "bar"');
		expect(container.textContent).toContain('"path": "/tmp/app.ts"');
		expect(container.textContent).toContain("Edit applied.");
		const inputPre = Array.from(container.querySelectorAll("pre")).find((pre) =>
			pre.textContent?.includes('"old_text"'),
		);
		expect(inputPre).toBeInstanceOf(HTMLPreElement);
	});

	it("shows the recorded editor input without old_text when the argument is absent", async () => {
		const editorInput = JSON.stringify({ path: "/tmp/new.ts", new_text: "hello" }, null, 2);
		const message = toolMessage("tool-1", `Tool: editor\nInput:\n${editorInput}\nDuration: 12ms`);

		await renderMessage(message);
		await expandTool(container, "editor");

		expect(container.textContent).toContain('"new_text": "hello"');
		expect(container.textContent).toContain('"path": "/tmp/new.ts"');
		expect(container.textContent).not.toContain("old_text");
	});

	it("keeps the readable run_commands rendering with the Command label", async () => {
		const input = JSON.stringify({ commands: ["git status", "npm test"] }, null, 2);
		const message = toolMessage("tool-1", `Tool: run_commands\nInput:\n${input}\nDuration: 5ms`);

		await renderMessage(message);
		await expandTool(container, "run_commands");

		expect(container.textContent).toContain("Command");
		expect(container.textContent).toContain("git status");
		expect(container.textContent).toContain("npm test");
		expect(container.textContent).not.toContain('"commands"');
		expect(container.textContent).not.toContain("Input");
	});

	it("shows the output and distinguishes structured per-operation errors from SDK-level errors", async () => {
		const editorInput = JSON.stringify({ path: "/tmp/app.ts", old_text: "foo", new_text: "bar" }, null, 2);

		const failedOperation = toolMessage(
			"tool-failed",
			[
				"Tool: editor",
				"Input:",
				editorInput,
				"Output:",
				JSON.stringify({
					query: "replace in /tmp/app.ts",
					result: "",
					success: false,
					error: "String not found in file: foo",
				}),
			].join("\n"),
		);
		const sdkError = toolMessage(
			"tool-sdk-error",
			`Tool: editor\nInput:\n${editorInput}\nError:\nSDK tool call timed out after 30000ms`,
		);

		await renderMessage(failedOperation);
		await expandTool(container, "editor");

		expect(container.textContent).toContain("Error");
		expect(container.textContent).toContain("String not found in file: foo");
		expect(container.textContent).not.toContain("SDK tool call");

		await act(async () => {
			root.unmount();
			root = createRoot(container);
			root.render(<ClineChatMessageItem message={sdkError} />);
			await Promise.resolve();
		});
		await expandTool(container, "editor");

		expect(container.textContent).toContain("Error");
		expect(container.textContent).toContain("SDK tool call timed out after 30000ms");
	});

	it("displays hostile markup in tool input and output as text, never as HTML", async () => {
		const hostileInput = JSON.stringify({ path: "/tmp/<img src=x onerror=alert(1)>.ts" }, null, 2);
		const hostileTool = toolMessage(
			"tool-hostile",
			`Tool: skills\nInput:\n${hostileInput}\nOutput:\n<script>document.cookie</script>`,
		);

		await renderMessage(hostileTool);
		await expandTool(container, "skills");

		expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
		expect(container.textContent).toContain("<script>document.cookie</script>");
		expect(container.querySelector("img")).toBeNull();
		expect(container.querySelector("script")).toBeNull();
	});

	it("labels persisted excerpted output as an excerpt", async () => {
		const output = [
			"head of the command output",
			"... [truncated 1200 lines; full output: /tmp/context-artifacts/abc123.txt]",
			"tail of the command output",
		].join("\n");
		const message = toolMessage(
			"tool-1",
			`Tool: run_commands\nInput:\n{"commands":["make build"]}\nOutput:\n${output}`,
		);

		await renderMessage(message);
		await expandTool(container, "run_commands");

		expect(container.textContent).toContain("Output (excerpt)");
		expect(container.textContent).toContain("full output: /tmp/context-artifacts/abc123.txt");
	});

	it("labels excerpted structured tool results as excerpts", async () => {
		const output = JSON.stringify({
			query: "npm test",
			result: [
				"test output head",
				"... [truncated 400 lines; full output: /tmp/context-artifacts/abc123.txt]",
				"test output tail",
			].join("\n"),
			success: true,
			error: "error head [truncated 20 lines; full output: /tmp/context-artifacts/err123.txt]",
		});
		const message = toolMessage(
			"tool-1",
			`Tool: run_commands\nInput:\n${JSON.stringify({ commands: ["npm test"] })}\nOutput:\n${output}`,
		);

		await renderMessage(message);
		await expandTool(container, "run_commands");

		expect(container.textContent).toContain("Output (excerpt)");
		expect(container.textContent).toContain("Error (excerpt)");
		expect(container.textContent).toContain("full output: /tmp/context-artifacts/err123.txt");
	});
});
