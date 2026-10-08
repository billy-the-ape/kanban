import { z } from "zod";
import { type ClineSdkAgentHooks, createClineSdkEditorExecutor } from "./sdk-runtime-boundary";

export const CLINE_EDITOR_MAX_CHARS = 32_000;
const SDK_EDITOR_MAX_CHARS = 6_000;
// The SDK's input contract, without its hard-coded payload rejection. The executor
// retains SDK create/replace/insert, path restrictions, unique matching, and diff behavior.
const editorInput = z.object({
	path: z.string().min(1),
	old_text: z.string().nullable().optional(),
	new_text: z.string(),
	insert_line: z.number().int().nullable().optional(),
});

export function createClineEditorLimitHooks(cwd: string): ClineSdkAgentHooks {
	const wrapped = new WeakSet<object>();
	let executor: ReturnType<typeof createClineSdkEditorExecutor> | undefined;
	return {
		beforeModel: ({ request }) => ({
			tools: request.tools.map((tool) => {
				if (tool.name !== "editor") return tool;
				// Update only descriptions: preserve SDK property types and validation.
				const inputSchema = JSON.parse(JSON.stringify(tool.inputSchema), (key, value) =>
					key === "description" && typeof value === "string"
						? value.replace(/\b6000\b/g, String(CLINE_EDITOR_MAX_CHARS))
						: value,
				);
				return { ...tool, inputSchema };
			}),
		}),
		beforeTool: ({ tool }) => {
			if (tool.name !== "editor" || wrapped.has(tool)) return undefined;
			wrapped.add(tool);
			const original = tool.execute.bind(tool);
			tool.execute = async (input, context) => {
				const parsed = editorInput.parse(input);
				const length = Math.max(parsed.new_text.length, parsed.old_text?.length ?? 0);
				if (length <= SDK_EDITOR_MAX_CHARS) return original(input, context);
				const query = `${parsed.insert_line == null ? "edit" : "insert"}:${parsed.path}`;
				if (length > CLINE_EDITOR_MAX_CHARS) {
					return {
						query,
						result: "",
						success: false,
						error: `Editor input too large: largest text field was ${length} characters; limit is ${CLINE_EDITOR_MAX_CHARS}. Split the edit into smaller calls.`,
					};
				}
				context.signal?.throwIfAborted();
				executor ??= createClineSdkEditorExecutor();
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					const result = await Promise.race([
						executor(parsed, cwd, context),
						new Promise<never>((_, reject) => {
							timer = setTimeout(() => reject(new Error("Editor operation timed out after 30000ms")), 30_000);
						}),
					]);
					return { query, result, success: true };
				} catch (error) {
					context.signal?.throwIfAborted();
					return {
						query,
						result: "",
						success: false,
						error: `Editor operation failed: ${error instanceof Error ? error.message : String(error)}`,
					};
				} finally {
					clearTimeout(timer);
				}
			};
			return undefined;
		},
	};
}
