// PCR: the shared {{token}} interpolator must substitute values VERBATIM.
// A string replacement in `String.replaceAll` interprets `$&`, `$'`, `` $` ``
// and `$$` in the inserted value — and branch names may legally contain `$`,
// so without the replacer form a branch like `feat/a$$b` would be silently
// rewritten in a prompt that has push rights.
import { describe, expect, it } from "vitest";
import { interpolateTemplate, sanitizeTemplateValue } from "../../../src/core/prompt-template-interpolation";

describe("interpolateTemplate", () => {
	it("substitutes known tokens and leaves unknown tokens untouched", () => {
		expect(interpolateTemplate("Head {{head_branch}} keeps {{future}}", { head_branch: "main" })).toBe(
			"Head main keeps {{future}}",
		);
	});

	it("inserts dollar patterns in values verbatim", () => {
		expect(interpolateTemplate("Branch: {{head_branch}}", { head_branch: "feat/a$$b" })).toBe("Branch: feat/a$$b");
		expect(interpolateTemplate("Branch: {{head_branch}}", { head_branch: "a$&b" })).toBe("Branch: a$&b");
		expect(interpolateTemplate("Branch: {{head_branch}} $tail", { head_branch: "a$'b" })).toBe("Branch: a$'b $tail");
		// A `$` at the end of one value must survive untouched next to the next
		// substitution (both values are inserted verbatim: x$ + y).
		expect(interpolateTemplate("{{a}}${{b}}", { a: "x$", b: "y" })).toBe("x$$y");
	});

	it("replaces every occurrence, including overlapping-looking keys", () => {
		expect(interpolateTemplate("{{a}} {{a}}", { a: "1" })).toBe("1 1");
	});
});

describe("sanitizeTemplateValue", () => {
	it("collapses line breaks and control characters into single spaces", () => {
		expect(sanitizeTemplateValue("evil\r\n\tvalue\u0001")).toBe("evil value");
	});

	it("length-caps absurd provider strings", () => {
		expect(sanitizeTemplateValue("a".repeat(500)).length).toBe(300);
	});
});
