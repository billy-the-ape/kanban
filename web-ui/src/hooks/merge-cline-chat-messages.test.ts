import { describe, expect, it } from "vitest";

import { mergeClineChatMessages, type ClineChatMessage } from "@/hooks/use-cline-chat-session";

function message(id: string, content = id): ClineChatMessage {
	return { id, role: "assistant", content, createdAt: 1 };
}

describe("mergeClineChatMessages", () => {
	it("keeps the original array and message identities for identical snapshots", () => {
		const first = message("a");
		const last = message("b");
		const base = [first, last];
		const incoming = [message("a"), message("b")];
		const merged = mergeClineChatMessages(base, incoming);
		expect(merged).toBe(base);
		expect(merged[0]).toBe(first);
		expect(merged[1]).toBe(last);
	});

	it("preserves ordering and handles duplicate incoming IDs", () => {
		const first = message("first");
		const base = [first, message("second")];
		const result = mergeClineChatMessages(base, [
			message("third", "initial"),
			message("second", "updated"),
			message("third", "latest"),
		]);
		expect(result.map((entry) => entry.id)).toEqual(["first", "second", "third"]);
		expect(result.map((entry) => entry.content)).toEqual(["first", "updated", "latest"]);
		expect(result[0]).toBe(first);
		expect(base[1]?.content).toBe("second");
	});

	it("updates image-only and metadata-only changes", () => {
		const before = message("a");
		const changedMeta = { ...before, meta: { hookEventName: "assistant_delta" as const } };
		expect(mergeClineChatMessages([before], [changedMeta])[0]).toBe(changedMeta);
		const images = [{ id: "img", data: "abc", mimeType: "image/png", name: "x.png" }];
		const changedImages = { ...before, images };
		expect(mergeClineChatMessages([before], [changedImages])[0]).toBe(changedImages);
	});

	it("merges a thousand messages without mutating existing history", () => {
		const history = Array.from({ length: 1000 }, (_, index) => message(`msg-${index}`));
		const current = [message("msg-999", "streamed update"), message("newest")];
		const merged = mergeClineChatMessages(history, current);
		expect(merged).toHaveLength(1001);
		expect(merged[999]?.content).toBe("streamed update");
		expect(merged.at(-1)?.id).toBe("newest");
		expect(history[999]?.content).toBe("msg-999");
		expect(merged[500]).toBe(history[500]);
	});
});
