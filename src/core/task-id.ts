const TASK_ID_LENGTH = 5;

export function createShortTaskId(randomUuid: () => string): string {
	return randomUuid().replaceAll("-", "").slice(0, TASK_ID_LENGTH);
}

export function createUniqueTaskId(existingIds: Set<string>, randomUuid: () => string): string {
	for (let attempt = 0; attempt < 16; attempt += 1) {
		const candidate = createShortTaskId(randomUuid);
		if (!existingIds.has(candidate)) {
			return candidate;
		}
	}
	return Math.random()
		.toString(36)
		.slice(2, 2 + TASK_ID_LENGTH);
}

// crypto.randomUUID only exists in secure contexts (HTTPS or localhost), so shared code that also runs
// in the browser must not depend on it. crypto.getRandomValues is available in every context.
export function createRandomHexId(length: number): string {
	const bytes = new Uint8Array(Math.ceil(length / 2));
	if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
		crypto.getRandomValues(bytes);
	} else {
		for (let index = 0; index < bytes.length; index += 1) {
			bytes[index] = Math.floor(Math.random() * 256);
		}
	}
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, length);
}
