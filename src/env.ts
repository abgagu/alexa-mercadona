import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

export interface Env {
	bearer: string;
	customerUuid: string;
}

interface SecretsFile {
	bearer?: string;
	customerUuid?: string;
}

function loadSecretsFile(): SecretsFile | null {
	const here = dirname(fileURLToPath(import.meta.url));
	// 1) Junto al módulo (caso Alexa-Hosted: lambda/secrets.json junto a env.js).
	// 2) En el directorio padre (caso CLI local: secrets.json en la raíz del repo,
	//    con env.ts en src/).
	// 3) En cwd (caso CLI corrido desde otra raíz arbitraria).
	const candidates = [
		join(here, "secrets.json"),
		resolve(here, "..", "secrets.json"),
		resolve(process.cwd(), "secrets.json"),
	];
	for (const path of candidates) {
		if (existsSync(path)) {
			try {
				return JSON.parse(readFileSync(path, "utf8")) as SecretsFile;
			} catch {
				continue;
			}
		}
	}
	return null;
}

export function loadEnv(): Env {
	const envBearer = process.env.MERCADONA_BEARER?.trim();
	const envUuid = process.env.MERCADONA_CUSTOMER_UUID?.trim();

	let bearer = envBearer;
	let customerUuid = envUuid;

	if (!bearer || !customerUuid) {
		const secrets = loadSecretsFile();
		if (secrets) {
			if (!bearer && secrets.bearer) bearer = secrets.bearer.trim();
			if (!customerUuid && secrets.customerUuid) customerUuid = secrets.customerUuid.trim();
		}
	}

	if (!bearer) throw new Error("MERCADONA_BEARER no está definido (ni en env ni en secrets.json)");
	if (!customerUuid) throw new Error("MERCADONA_CUSTOMER_UUID no está definido (ni en env ni en secrets.json)");
	return { bearer, customerUuid };
}
