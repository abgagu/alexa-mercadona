import { request as httpsRequest } from "node:https";

/**
 * Polyfill mínimo de fetch para Node < 18 (Alexa-Hosted está en Node 16).
 * Solo implementa lo que usa MercadonaClient: status, ok, text().
 */
interface MinimalResponse {
	status: number;
	ok: boolean;
	text(): Promise<string>;
}

function nodeFetch(input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<MinimalResponse> {
	return new Promise((resolve, reject) => {
		const url = new URL(input);
		const req = httpsRequest(
			{
				hostname: url.hostname,
				port: url.port || 443,
				path: url.pathname + url.search,
				method: init?.method ?? "GET",
				headers: init?.headers ?? {},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () => {
					const status = res.statusCode ?? 0;
					const body = Buffer.concat(chunks).toString("utf8");
					resolve({
						status,
						ok: status >= 200 && status < 300,
						text: () => Promise.resolve(body),
					});
				});
			},
		);
		req.on("error", reject);
		if (init?.body) req.write(init.body);
		req.end();
	});
}

/**
 * Si globalThis.fetch no existe (Node < 18), instala el polyfill.
 */
export function installFetchPolyfill(): void {
	if (typeof (globalThis as { fetch?: unknown }).fetch !== "function") {
		(globalThis as { fetch: typeof nodeFetch }).fetch = nodeFetch;
	}
}
