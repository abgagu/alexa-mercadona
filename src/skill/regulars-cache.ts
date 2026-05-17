import type { MercadonaClient, MyRegularItem } from "../mercadona-client.js";

interface CacheEntry {
	fetchedAt: number;
	items: MyRegularItem[];
}

const TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

export async function getRegulars(client: MercadonaClient, cacheKey: string): Promise<MyRegularItem[]> {
	const now = Date.now();
	const entry = cache.get(cacheKey);
	if (entry && now - entry.fetchedAt < TTL_MS) {
		return entry.items;
	}
	const reg = await client.getMyRegulars();
	cache.set(cacheKey, { fetchedAt: now, items: reg.results });
	return reg.results;
}

export function invalidateRegulars(cacheKey: string): void {
	cache.delete(cacheKey);
}
