import { builtinEnvironments, type Environment } from "vitest/runtime";

import { isolateTestEnvironment } from "./utilities/test-environment";

export default {
	name: "kanban-node",
	viteEnvironment: "ssr",
	async setup(global, options) {
		const isolated = isolateTestEnvironment();
		try {
			const node = await builtinEnvironments.node.setup(global, options);
			return {
				async teardown() {
					try {
						await node.teardown(global);
					} finally {
						isolated.cleanup();
					}
				},
			};
		} catch (error) {
			isolated.cleanup();
			throw error;
		}
	},
} satisfies Environment;
