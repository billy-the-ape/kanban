// PCR: the shared `{{token}}` interpolation used by every generated
// git-action prompt (client-side commit/PR templates and the server-rendered
// conflict-repair template). Extracted from
// `web-ui/src/git-actions/build-task-git-action-prompt.ts` so both render
// paths share one rule set:
//
// - Only exact `{{key}}` occurrences for KNOWN keys are replaced; unknown
//   `{{tokens}}` stay untouched so an operator-edited template never loses
//   text it does not (yet) know about.
// - The renderer never invents values: a token the caller does not supply is
//   left as-is (or removed line-wise by the conflict renderer when the token
//   is documented as optional).

/**
 * Replaces every `{{key}}` occurrence for each entry in `variables` with the
 * entry's value. Keys containing regex-special characters are matched
 * literally. Unknown template tokens are preserved verbatim.
 */
export function interpolateTemplate(template: string, variables: Record<string, string>): string {
	let result = template;
	for (const [key, value] of Object.entries(variables)) {
		result = result.replaceAll(`{{${key}}}`, value);
	}
	return result;
}

/**
 * Neutralizes an untrusted value (branch names, provider-owned repository
 * strings) before it is interpolated into a turn that has push rights:
 * control characters and line breaks are collapsed to single spaces (a
 * newline could escape the template's label line), the value is length-capped
 * so an absurd provider string cannot bloat the prompt, and quote characters
 * are kept as printable text only.
 */
export function sanitizeTemplateValue(value: string, maxLength = 300): string {
	const collapsed = Array.from(value)
		.map((character) => {
			const code = character.charCodeAt(0);
			if (code === 9 || code === 10 || code === 13) {
				return " ";
			}
			// Drop other C0/C1 control characters and DEL entirely.
			return code < 32 || code === 127 || (code >= 128 && code <= 159) ? "" : character;
		})
		.join("")
		.replace(/\s+/g, " ")
		.trim();
	return collapsed.length > maxLength ? collapsed.slice(0, maxLength) : collapsed;
}
