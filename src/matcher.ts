import { SYNONYMS } from "./synonyms.js";

const STOP_WORDS = new Set([
	"hacendado", "deliplus", "bosque", "verde", "compy", "milbona",
	"ud", "uds", "unidad", "unidades", "pack", "paquete", "bote", "botella",
	"bandeja", "tarrina", "tarro", "caja", "frasco", "spray", "pieza", "granel",
	"gr", "g", "gramos", "kg", "kilo", "kilos", "ml", "mililitros", "l", "litro", "litros",
	"de", "del", "la", "el", "los", "las", "y", "con", "sin", "para", "al", "a",
]);

// Pesos por posicion (en la lista de tokens significativos del producto).
const POSITION_WEIGHTS: readonly number[] = [1.0, 0.7, 0.5, 0.3, 0.2];
const SUBSTRING_WEIGHT = 0.2;

// Tolerancia para comparar coverage/posQuality. Solo cubre ruido de IEEE-754
// (p.ej. 0.7+0.2 = 0.8999...). Los tiers semanticos reales estan separados
// por >= 0.033, asi que un epsilon de 1e-9 los distingue sin riesgo.
const TIER_EPSILON = 1e-9;

function stripDiacritics(s: string): string {
	return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function normalize(text: string): string {
	return stripDiacritics(text.toLowerCase())
		.replace(/[^a-z0-9\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function tokenize(text: string): string[] {
	return normalize(text)
		.split(" ")
		.filter((t) => t.length > 0);
}

export function meaningfulTokens(text: string): string[] {
	return tokenize(text).filter((t) => !STOP_WORDS.has(t) && t.length >= 2);
}

function singularize(t: string): string | null {
	if (t.endsWith("es") && t.length > 3) return t.slice(0, -2);
	if (t.endsWith("s") && t.length > 2) return t.slice(0, -1);
	return null;
}

/**
 * Devuelve todas las formas alternativas de un token:
 *  - el token original
 *  - su singularización heurística
 *  - su sinónimo (si existe)
 *  - la singularización del sinónimo
 */
export function tokenForms(t: string): string[] {
	const out = new Set<string>([t]);
	const sing = singularize(t);
	if (sing) out.add(sing);
	const syn = SYNONYMS[t] ?? (sing ? SYNONYMS[sing] : undefined);
	if (syn) {
		out.add(syn);
		const synSing = singularize(syn);
		if (synSing) out.add(synSing);
	}
	return Array.from(out);
}

function positionWeight(pos: number): number {
	if (pos < 0) return 0;
	if (pos >= POSITION_WEIGHTS.length) return POSITION_WEIGHTS[POSITION_WEIGHTS.length - 1]!;
	return POSITION_WEIGHTS[pos]!;
}

function setsIntersect(a: Set<string>, b: Set<string>): boolean {
	for (const x of a) if (b.has(x)) return true;
	return false;
}

/**
 * Mejor peso obtenido al buscar el token de la consulta en el producto.
 * Match si alguna forma del query coincide con alguna forma de un token del producto.
 * Posicion = primera coincidencia. Si no, fallback a substring.
 */
function bestTokenWeight(
	queryForms: Set<string>,
	productTokensForms: Set<string>[],
	productRaw: string,
): number {
	for (let i = 0; i < productTokensForms.length; i++) {
		if (setsIntersect(queryForms, productTokensForms[i]!)) {
			return positionWeight(i);
		}
	}
	for (const f of queryForms) {
		if (productRaw.includes(f)) return SUBSTRING_WEIGHT;
	}
	return 0;
}

/**
 * Cualquier estructura con product.display_name (Mis Habituales o líneas del carrito).
 */
export interface MatchableItem {
	product: { id: string; display_name: string };
}

export interface MatchResult<T extends MatchableItem> {
	item: T;
	coverage: number;
	posQuality: number;
}

/**
 * Devuelve items ordenados por (coverage desc, posQuality desc, len asc).
 *
 *  - coverage    = fraccion de tokens de la consulta que matchean (0..1).
 *  - posQuality  = media de pesos posicionales de los matches (0..1).
 *
 * Empata por numero de tokens significativos del producto (premia nombres concisos).
 */
export function findMatches<T extends MatchableItem>(query: string, items: T[]): MatchResult<T>[] {
	const queryTokens = meaningfulTokens(query);
	if (queryTokens.length === 0) return [];
	const queryFormsList: Set<string>[] = queryTokens.map((t) => new Set(tokenForms(t)));

	const scored: MatchResult<T>[] = [];
	for (const item of items) {
		const displayName = item.product.display_name;
		const productRaw = normalize(displayName);
		const productTokens = meaningfulTokens(displayName);
		const productTokensForms: Set<string>[] = productTokens.map((t) => new Set(tokenForms(t)));

		const weights: number[] = [];
		for (const forms of queryFormsList) {
			const w = bestTokenWeight(forms, productTokensForms, productRaw);
			if (w > 0) weights.push(w);
		}
		if (weights.length === 0) continue;

		const coverage = weights.length / queryFormsList.length;
		const posQuality = weights.reduce((a, b) => a + b, 0) / weights.length;
		scored.push({ item, coverage, posQuality });
	}

	scored.sort((a, b) => {
		if (b.coverage !== a.coverage) return b.coverage - a.coverage;
		if (b.posQuality !== a.posQuality) return b.posQuality - a.posQuality;
		const lenA = meaningfulTokens(a.item.product.display_name).length;
		const lenB = meaningfulTokens(b.item.product.display_name).length;
		return lenA - lenB;
	});

	return scored;
}

/**
 * Filtra `findMatches` para devolver solo los empatados en la mejor tupla (coverage, posQuality).
 */
export function findBestMatches<T extends MatchableItem>(query: string, items: T[]): MatchResult<T>[] {
	const all = findMatches(query, items);
	if (all.length === 0) return [];
	const best = all[0]!;
	return all.filter(
		(m) =>
			Math.abs(m.coverage - best.coverage) < TIER_EPSILON &&
			Math.abs(m.posQuality - best.posQuality) < TIER_EPSILON,
	);
}
