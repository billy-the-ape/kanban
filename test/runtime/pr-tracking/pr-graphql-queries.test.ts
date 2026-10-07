import { validate } from "@octokit/graphql-schema";
import { describe, expect, it } from "vitest";

import { THREAD_COMMENTS_QUERY, THREADS_QUERY } from "../../../src/pr-tracking/github-gh-adapter";

/**
 * Every GraphQL document in the adapter module must validate against
 * GitHub's published schema (@octokit/graphql-schema). This catches
 * invalid fields (e.g. a field that does not exist on a type — GitHub
 * rejects the whole query with `errors` and no `data`, which the adapter
 * would surface only as an opaque `network` failure) entirely offline.
 */
describe("adapter GraphQL documents vs GitHub's published schema", () => {
	it("THREADS_QUERY validates", () => {
		expect(validate(THREADS_QUERY)).toEqual([]);
	});

	it("THREAD_COMMENTS_QUERY validates", () => {
		expect(validate(THREAD_COMMENTS_QUERY)).toEqual([]);
	});
});
