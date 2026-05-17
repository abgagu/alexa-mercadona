import { loadEnv } from "./env.js";
import { MercadonaClient, MercadonaApiError, MercadonaAuthError } from "./mercadona-client.js";
import type { MyRegularItem } from "./mercadona-client.js";
import { findBestMatches, normalize } from "./matcher.js";

class CliError extends Error {
	code: number;
	constructor(message: string, code = 1) {
		super(message);
		this.name = "CliError";
		this.code = code;
	}
}

interface ParsedArgs {
	command: string | null;
	positional: string[];
	options: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
	const args = argv.slice(2);
	const positional: string[] = [];
	const options: Record<string, string | boolean> = {};
	let command: string | null = null;

	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("-")) {
				options[key] = next;
				i++;
			} else {
				options[key] = true;
			}
		} else if (a.startsWith("-") && a.length > 1) {
			const key = a.slice(1);
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("-")) {
				options[key] = next;
				i++;
			} else {
				options[key] = true;
			}
		} else if (command === null) {
			command = a;
		} else {
			positional.push(a);
		}
	}

	return { command, positional, options };
}

function formatPrice(p: string): string {
	return `${p} €`;
}

function describeItem(item: MyRegularItem): string {
	const p = item.product;
	const pack = p.packaging ? `${p.packaging}` : "";
	const size = p.price_instructions.unit_size && p.price_instructions.size_format
		? `${p.price_instructions.unit_size}${p.price_instructions.size_format}`
		: "";
	const meta = [pack, size].filter(Boolean).join(", ");
	const metaStr = meta ? ` (${meta})` : "";
	return `${p.id.padEnd(8)} ${formatPrice(p.price_instructions.unit_price).padEnd(10)} ${p.display_name}${metaStr}`;
}

async function cmdWhoami(client: MercadonaClient): Promise<void> {
	const c = await client.getCustomer();
	console.log(`Nombre:       ${c.name} ${c.last_name}`);
	console.log(`Email:        ${c.email}`);
	console.log(`CP actual:    ${c.current_postal_code}`);
	console.log(`Customer UUID:${c.uuid}`);
	console.log(`Cart ID:      ${c.cart_id}`);
}

async function cmdList(client: MercadonaClient, args: ParsedArgs): Promise<void> {
	const reg = await client.getMyRegulars();
	const filter = typeof args.options.filter === "string" ? args.options.filter : null;
	const limit = typeof args.options.limit === "string" ? parseInt(args.options.limit, 10) : null;

	let items = reg.results;
	if (filter) {
		const f = normalize(filter);
		items = items.filter((it) => normalize(it.product.display_name).includes(f));
	}
	if (limit && Number.isFinite(limit)) items = items.slice(0, limit);

	console.log(`Mis Habituales: ${items.length}${filter ? ` (filtro: "${filter}")` : ""}`);
	console.log("");
	console.log(`ID       Precio     Producto`);
	console.log(`-------- ---------- ------------------------------------------`);
	for (const it of items) console.log(describeItem(it));
}

async function cmdCart(client: MercadonaClient): Promise<void> {
	const cart = await client.getCart();
	console.log(`Carrito ${cart.id} (version ${cart.version})`);
	console.log(`Productos: ${cart.products_count} | Total: ${formatPrice(cart.summary.total)}`);
	console.log("");
	console.log(`ID       Cant.  Subtotal   Producto`);
	console.log(`-------- ------ ---------- ----------------------------------------`);
	for (const line of cart.lines) {
		const p = line.product;
		const subtotal = (Number(p.price_instructions.unit_price) * line.quantity).toFixed(2);
		console.log(`${p.id.padEnd(8)} ${String(line.quantity).padEnd(6)} ${formatPrice(subtotal).padEnd(10)} ${p.display_name}`);
	}
}

async function cmdAdd(client: MercadonaClient, args: ParsedArgs): Promise<void> {
	const explicitId = typeof args.options.p === "string" ? args.options.p : null;
	const quantity = typeof args.options.q === "string" ? parseInt(args.options.q, 10) : 1;
	if (!Number.isInteger(quantity) || quantity < 1) {
		throw new Error(`Cantidad inválida: ${args.options.q}`);
	}

	let productId: string;
	let productName: string;

	if (explicitId) {
		productId = explicitId;
		const reg = await client.getMyRegulars();
		const found = reg.results.find((it) => it.product.id === productId);
		productName = found ? found.product.display_name : `(id ${productId})`;
	} else {
		const query = args.positional.join(" ").trim();
		if (!query) throw new Error("Indica un producto a buscar (ej: `add kefir`) o usa `-p <id>`.");

		const reg = await client.getMyRegulars();
		const matches = findBestMatches(query, reg.results);

		if (matches.length === 0) {
			throw new CliError(`No encuentro "${query}" en tus habituales.`);
		}
		if (matches.length > 1) {
			console.log(`Hay ${matches.length} coincidencias para "${query}". Repite con -p <id>:`);
			console.log("");
			for (const m of matches) console.log(describeItem(m.item));
			throw new CliError("", 1);
		}
		productId = matches[0]!.item.product.id;
		productName = matches[0]!.item.product.display_name;
	}

	const updated = await client.addToCart(productId, quantity);
	const line = updated.lines.find((l) => l.product.id === productId);
	console.log(`OK. Añadidas ${quantity} ud. de "${productName}" (id ${productId}).`);
	console.log(`Línea ahora con cantidad ${line?.quantity ?? "?"}. Carrito en version ${updated.version}, total ${formatPrice(updated.summary.total)}.`);
}

function printHelp(): void {
	console.log(`Uso: npm run cli -- <comando> [opciones]

Comandos:
  whoami                        Valida token y muestra datos del cliente
  list [--filter X] [--limit N] Lista Mis Habituales (id, precio, nombre)
  cart                          Muestra el carrito actual
  add <texto> [-q N]            Busca un producto en Mis Habituales y añade N unidades (default 1)
  add -p <product_id> [-q N]    Añade directamente por id

Ejemplos:
  npm run cli -- whoami
  npm run cli -- list --filter kefir
  npm run cli -- add kefir
  npm run cli -- add "yogur natural" -q 2
  npm run cli -- add -p 21307 -q 1`);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv);

	if (!args.command || args.command === "help" || args.options.help) {
		printHelp();
		return;
	}

	const env = loadEnv();
	const client = new MercadonaClient({ bearer: env.bearer, customerUuid: env.customerUuid });

	switch (args.command) {
		case "whoami":
			await cmdWhoami(client);
			break;
		case "list":
			await cmdList(client, args);
			break;
		case "cart":
			await cmdCart(client);
			break;
		case "add":
			await cmdAdd(client, args);
			break;
		default:
			console.error(`Comando desconocido: ${args.command}`);
			printHelp();
			process.exit(2);
	}
}

main().catch((err: unknown) => {
	if (err instanceof CliError) {
		if (err.message) console.error(err.message);
		process.exitCode = err.code;
		return;
	}
	if (err instanceof MercadonaAuthError) {
		console.error(err.message);
		process.exitCode = 3;
		return;
	}
	if (err instanceof MercadonaApiError) {
		console.error(`API error ${err.status}: ${err.message}`);
		console.error(err.body.slice(0, 500));
		process.exitCode = 4;
		return;
	}
	if (err instanceof Error) console.error(err.message);
	else console.error(err);
	process.exitCode = 1;
});
