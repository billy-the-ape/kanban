// PRTRACK-0: canonical PR identity for the tracking foundation.
//
// The canonical PR key is the PR-linking identity key
// (`provider|host|repository|number`, host/repository lowercase) reused from
// `src/core/pull-request-links.ts`. The pure parsing/validation helpers live
// in `./pr-key-parsing` (browser-safe, no `node:` imports) and are re-exported
// here for compatibility. This module adds only the SHA-256 storage digest,
// which requires `node:crypto` and therefore must not be imported from the
// web-ui browser bundle (e.g. via `src/core/task-board-mutations.ts`, aliased
// as `@runtime-task-state`).
import { createHash } from "node:crypto";

export {
	isTrackingSupportedPr,
	type ParsedCanonicalPrKey,
	parseCanonicalPrKey,
	recordIdentityMatchesKey,
	toCanonicalPrKey,
} from "./pr-key-parsing";

/** SHA-256 hex digest used as the on-disk record file name. */
export function prKeyDigest(canonicalPrKey: string): string {
	return createHash("sha256").update(canonicalPrKey, "utf8").digest("hex");
}
