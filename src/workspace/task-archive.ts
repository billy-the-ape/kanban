import { spawn } from "node:child_process";

const DIAGNOSTIC_BYTES = 8192;

/** Drain tar's output without allowing diagnostics to terminate a large archive operation. */
export async function runTaskArchive(args: string[]): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"] });
		let first = Buffer.alloc(0);
		let last = Buffer.alloc(0);
		let total = 0;
		child.stderr.on("data", (chunk: Buffer) => {
			total += chunk.length;
			if (first.length < DIAGNOSTIC_BYTES) {
				first = Buffer.concat([first, chunk.subarray(0, DIAGNOSTIC_BYTES - first.length)]);
			}
			last = Buffer.concat([last, chunk]).subarray(-DIAGNOSTIC_BYTES);
		});
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			const details =
				total <= DIAGNOSTIC_BYTES
					? first.toString("utf8")
					: total <= DIAGNOSTIC_BYTES * 2
						? first.toString("utf8") + last.subarray(DIAGNOSTIC_BYTES * 2 - total).toString("utf8")
						: `${first.toString("utf8")}\n[tar diagnostics truncated]\n${last.toString("utf8")}`;
			reject(
				new Error(
					`Task archive command failed (${signal ? `signal ${signal}` : `exit ${code}`}). ${details.trim()}`,
				),
			);
		});
	});
}
