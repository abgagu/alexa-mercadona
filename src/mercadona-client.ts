const BASE_URL = "https://tienda.mercadona.es/api";

export interface Customer {
	id: number;
	uuid: string;
	email: string;
	name: string;
	last_name: string;
	current_postal_code: string;
	cart_id: string;
	has_requested_account_deletion: boolean;
	has_active_billing: boolean;
}

export interface PriceInstructions {
	iva: number | null;
	is_new: boolean;
	is_pack: boolean;
	pack_size: number | null;
	unit_name: string | null;
	unit_size: number;
	bulk_price: string;
	unit_price: string;
	approx_size: boolean;
	size_format: string;
	total_units: number | null;
	unit_selector: boolean;
	bunch_selector: boolean;
	drained_weight: number | null;
	selling_method: number;
	tax_percentage: string;
	price_decreased: boolean;
	reference_price: string;
	min_bunch_amount: number;
	reference_format: string;
	previous_unit_price: string | null;
	increment_bunch_amount: number;
}

export interface ProductCategory {
	id: number;
	name: string;
	level: number;
	order: number;
}

export interface Product {
	id: string;
	slug: string;
	limit: number;
	badges: Record<string, boolean>;
	status: string | null;
	packaging: string | null;
	published: boolean;
	share_url: string;
	thumbnail: string;
	categories: ProductCategory[];
	display_name: string;
	unavailable_from: string | null;
	unavailable_weekdays: string[];
	price_instructions: PriceInstructions;
}

export interface CartLineRead {
	quantity: number;
	sources: string[];
	version: number;
	product: Product;
}

export interface CartRead {
	id: string;
	version: number;
	lines: CartLineRead[];
	open_order_id: string | null;
	summary: { total: string };
	products_count: number;
}

export interface MyRegularItem {
	product: Product;
	source: string;
	source_code: string;
	selling_method: number;
	recommended_quantity: number;
}

export interface MyRegularsResponse {
	next_page: string | null;
	results: MyRegularItem[];
}

export interface CartLineWrite {
	quantity: number;
	product_id: string;
	sources: string[];
	version?: number;
}

export interface CartWriteBody {
	id: string;
	version: number;
	lines: CartLineWrite[];
}

export interface ClientOptions {
	bearer: string;
	customerUuid: string;
	fetchImpl?: typeof fetch;
}

export class MercadonaAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MercadonaAuthError";
	}
}

export class MercadonaApiError extends Error {
	status: number;
	body: string;
	constructor(message: string, status: number, body: string) {
		super(message);
		this.name = "MercadonaApiError";
		this.status = status;
		this.body = body;
	}
}

export class MercadonaClient {
	private bearer: string;
	private customerUuid: string;
	private fetchImpl: typeof fetch;

	constructor(opts: ClientOptions) {
		this.bearer = opts.bearer;
		this.customerUuid = opts.customerUuid;
		this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const url = `${BASE_URL}${path}`;
		const init: RequestInit = {
			method,
			headers: {
				Authorization: `Bearer ${this.bearer}`,
				...(body !== undefined ? { "Content-Type": "application/json" } : {}),
			},
		};
		if (body !== undefined) init.body = JSON.stringify(body);

		const resp = await this.fetchImpl(url, init);
		const text = await resp.text();

		if (resp.status === 401) {
			throw new MercadonaAuthError(`Token inválido o caducado (HTTP 401). Renueva MERCADONA_BEARER. Body: ${text.slice(0, 200)}`);
		}
		if (!resp.ok) {
			throw new MercadonaApiError(`Error ${resp.status} en ${method} ${path}`, resp.status, text);
		}
		if (text.length === 0) return undefined as T;
		try {
			return JSON.parse(text) as T;
		} catch {
			throw new MercadonaApiError(`Respuesta no JSON en ${method} ${path}`, resp.status, text);
		}
	}

	getCustomer(): Promise<Customer> {
		return this.request<Customer>("GET", `/customers/${this.customerUuid}/`);
	}

	getMyRegulars(type: "precision" | "recall" = "precision"): Promise<MyRegularsResponse> {
		return this.request<MyRegularsResponse>("GET", `/customers/${this.customerUuid}/recommendations/myregulars/${type}/`);
	}

	getCart(): Promise<CartRead> {
		return this.request<CartRead>("GET", `/customers/${this.customerUuid}/cart/`);
	}

	putCart(body: CartWriteBody): Promise<CartRead> {
		return this.request<CartRead>("PUT", `/customers/${this.customerUuid}/cart/`, body);
	}

	/**
	 * Añade `quantity` unidades del producto al carrito.
	 * Si la línea ya existe, suma a la cantidad actual y conserva el histórico de `sources`.
	 * Si no existe, la crea con `sources = ["+MR"] * quantity`.
	 */
	async addToCart(productId: string, quantity: number): Promise<CartRead> {
		if (!Number.isInteger(quantity) || quantity < 1) {
			throw new Error(`quantity debe ser un entero >= 1, recibido: ${quantity}`);
		}
		const cart = await this.getCart();

		const lines: CartLineWrite[] = [];
		let merged = false;
		for (const line of cart.lines) {
			if (line.product.id === productId) {
				merged = true;
				lines.push({
					quantity: line.quantity + quantity,
					product_id: productId,
					sources: [...line.sources, ...Array(quantity).fill("+MR")],
					version: line.version,
				});
			} else {
				lines.push({
					quantity: line.quantity,
					product_id: line.product.id,
					sources: line.sources,
					version: line.version,
				});
			}
		}
		if (!merged) {
			lines.push({
				quantity,
				product_id: productId,
				sources: Array(quantity).fill("+MR"),
			});
		}

		return this.putCart({ id: cart.id, version: cart.version, lines });
	}

	/**
	 * Elimina la línea completa de `productId` del carrito. Si no está, no hace nada
	 * y devuelve el carrito sin cambios.
	 */
	async removeFromCart(productId: string): Promise<CartRead> {
		const cart = await this.getCart();
		const filtered = cart.lines.filter((l) => l.product.id !== productId);
		if (filtered.length === cart.lines.length) return cart;
		const lines: CartLineWrite[] = filtered.map((line) => ({
			quantity: line.quantity,
			product_id: line.product.id,
			sources: line.sources,
			version: line.version,
		}));
		return this.putCart({ id: cart.id, version: cart.version, lines });
	}

	/**
	 * Vacía el carrito por completo.
	 */
	async clearCart(): Promise<CartRead> {
		const cart = await this.getCart();
		return this.putCart({ id: cart.id, version: cart.version, lines: [] });
	}

	/**
	 * Fija la cantidad EXACTA de `productId` en el carrito.
	 * - Si `quantity` <= 0 → quita la línea.
	 * - Si la línea no existía y `quantity` > 0 → la crea con `sources = ["+MR"] * quantity`.
	 * - Si existía → ajusta `quantity` y, si subió, añade "+MR" por cada unidad extra; si bajó, recorta `sources`.
	 */
	async setCartLineQuantity(productId: string, quantity: number): Promise<CartRead> {
		if (!Number.isInteger(quantity) || quantity < 0) {
			throw new Error(`quantity debe ser un entero >= 0, recibido: ${quantity}`);
		}
		const cart = await this.getCart();
		const lines: CartLineWrite[] = [];
		let found = false;
		for (const line of cart.lines) {
			if (line.product.id !== productId) {
				lines.push({
					quantity: line.quantity,
					product_id: line.product.id,
					sources: line.sources,
					version: line.version,
				});
				continue;
			}
			found = true;
			if (quantity === 0) continue;
			let sources = line.sources;
			if (quantity > line.quantity) {
				sources = [...sources, ...Array(quantity - line.quantity).fill("+MR")];
			} else if (quantity < line.quantity) {
				sources = sources.slice(0, quantity);
			}
			lines.push({
				quantity,
				product_id: productId,
				sources,
				version: line.version,
			});
		}
		if (!found && quantity > 0) {
			lines.push({
				quantity,
				product_id: productId,
				sources: Array(quantity).fill("+MR"),
			});
		}
		return this.putCart({ id: cart.id, version: cart.version, lines });
	}
}
