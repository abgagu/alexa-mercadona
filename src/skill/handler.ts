import {
	SkillBuilders,
	getRequestType,
	getIntentName,
	getSlotValue,
} from "ask-sdk-core";
import type { RequestHandler, ErrorHandler, HandlerInput } from "ask-sdk-core";
import type { Response } from "ask-sdk-model";

import { loadEnv } from "../env.js";
import {
	MercadonaClient,
	MercadonaAuthError,
	MercadonaApiError,
} from "../mercadona-client.js";
import { findBestMatches } from "../matcher.js";
import { getRegulars } from "./regulars-cache.js";
import { installFetchPolyfill } from "./fetch-polyfill.js";

installFetchPolyfill();

const MIN_ORDER_EUR = 60;

function parseEuros(s: string): number {
	const n = parseFloat(s);
	return Number.isFinite(n) ? n : 0;
}

function formatEuros(amount: number): string {
	const cents = Math.round(amount * 100);
	const e = Math.floor(cents / 100);
	const c = cents % 100;
	if (c === 0) return `${e} euros`;
	return `${e} euros y ${c} céntimos`;
}

function cartSuffix(prevTotal: number, newTotal: number): string {
	if (prevTotal < MIN_ORDER_EUR && newTotal >= MIN_ORDER_EUR) {
		return ` Total ${formatEuros(newTotal)}, importe mínimo superado.`;
	}
	if (prevTotal >= MIN_ORDER_EUR && newTotal < MIN_ORDER_EUR) {
		return ` Total ${formatEuros(newTotal)}, ya no llegas al mínimo.`;
	}
	return ` Total ${formatEuros(newTotal)}.`;
}

const SPANISH_NUMERALS: Record<string, number> = {
	un: 1, uno: 1, una: 1,
	dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
	once: 11, doce: 12,
};

/**
 * Si productName empieza por un numeral ("dos kéfir", "3 yogures", "una botella de leche"),
 * devuelve { quantity, rest } separando la cantidad del resto del nombre.
 * Si no, devuelve { quantity: null, rest: productName } — el llamante decidira el default
 * (normalmente recommended_quantity del habitual).
 */
function extractQuantity(productName: string): { quantity: number | null; rest: string } {
	const trimmed = productName.trim();
	const match = trimmed.match(/^(\S+)\s+(.+)$/);
	if (!match) return { quantity: null, rest: trimmed };
	const head = match[1]!.toLowerCase();
	const rest = match[2]!;

	const asInt = parseInt(head, 10);
	if (Number.isInteger(asInt) && asInt >= 1 && asInt <= 99 && /^\d+$/.test(head)) {
		return { quantity: asInt, rest };
	}
	const numeral = SPANISH_NUMERALS[head];
	if (numeral !== undefined) {
		return { quantity: numeral, rest };
	}
	return { quantity: null, rest: trimmed };
}

function defaultQty(recommended: number | undefined): number {
	if (!recommended || !Number.isFinite(recommended) || recommended < 1) return 1;
	return Math.floor(recommended);
}

const env = loadEnv();
const client = new MercadonaClient({ bearer: env.bearer, customerUuid: env.customerUuid });

async function sendProgressive(input: HandlerInput, text: string): Promise<void> {
	const ctx = input.requestEnvelope.context.System;
	const apiEndpoint = ctx.apiEndpoint;
	const apiAccessToken = ctx.apiAccessToken;
	const requestId = input.requestEnvelope.request.requestId;
	if (!apiEndpoint || !apiAccessToken || !requestId) return;
	try {
		await fetch(`${apiEndpoint}/v1/directives`, {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${apiAccessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				header: { requestId },
				directive: {
					type: "VoicePlayer.Speak",
					speech: text,
				},
			}),
		});
	} catch (e) {
		console.warn("Progressive response failed:", (e as Error).message);
	}
}

const LISTENING_EARCON = '<audio src="soundbank://soundlibrary/alarms/beeps_and_bloops/bell_03"/>';

function speak(input: HandlerInput, text: string, endSession = false): Response {
	if (endSession) {
		return input.responseBuilder.speak(text).withShouldEndSession(true).getResponse();
	}
	const attrs = input.attributesManager.getSessionAttributes();
	attrs.expectingFollowUp = true;
	input.attributesManager.setSessionAttributes(attrs);
	const fullText = `${text} ¿Hago algo más? ${LISTENING_EARCON}`;
	return input.responseBuilder
		.speak(fullText)
		.reprompt("¿Hago algo más?")
		.withShouldEndSession(false)
		.getResponse();
}

const LaunchRequestHandler: RequestHandler = {
	canHandle(input) {
		return getRequestType(input.requestEnvelope) === "LaunchRequest";
	},
	handle(input) {
		return input.responseBuilder
			.speak("Hola. Dime qué quieres añadir al carrito de Mercadona.")
			.reprompt("Por ejemplo, di: añade kéfir.")
			.withShouldEndSession(false)
			.getResponse();
	},
};

const AddToCartIntentHandler: RequestHandler = {
	canHandle(input) {
		return (
			getRequestType(input.requestEnvelope) === "IntentRequest" &&
			getIntentName(input.requestEnvelope) === "AddToCartIntent"
		);
	},
	async handle(input) {
		const raw = getSlotValue(input.requestEnvelope, "productName");

		if (!raw || raw.trim().length === 0) {
			return speak(input, "No he entendido qué producto quieres. Repítelo, por favor.", false);
		}

		const { quantity, rest } = extractQuantity(raw);

		await sendProgressive(input, `Un momento, busco ${rest}.`);

		const items = await getRegulars(client, env.customerUuid);
		const matches = findBestMatches(rest, items);

		if (matches.length === 0) {
			return speak(input, `No encuentro "${rest}" en tus habituales.`);
		}

		if (matches.length > 1) {
			const top = matches.slice(0, 5);
			const attrs = input.attributesManager.getSessionAttributes();
			attrs.pendingDisambiguation = {
				candidates: top.map((m) => ({
					id: m.item.product.id,
					name: m.item.product.display_name,
					recommendedQty: defaultQty(m.item.recommended_quantity),
				})),
				requestedQty: quantity,
			};
			delete attrs.pendingAdd;
			input.attributesManager.setSessionAttributes(attrs);
			const enumerated = top.map((m, i) => `${i + 1}, ${m.item.product.display_name}`).join(". ");
			return input.responseBuilder
				.speak(`He encontrado varias opciones. ${enumerated}. Di el número.`)
				.reprompt("Di el número de la opción que quieres, o cancela.")
				.withShouldEndSession(false)
				.getResponse();
		}

		const best = matches[0]!;
		const productId = best.item.product.id;
		const displayName = best.item.product.display_name;
		const effectiveQty = quantity ?? defaultQty(best.item.recommended_quantity);

		const cart = await client.getCart();
		const prevTotal = parseEuros(cart.summary.total);
		const existingLine = cart.lines.find((l) => l.product.id === productId);
		if (existingLine) {
			const attrs = input.attributesManager.getSessionAttributes();
			attrs.pendingAdd = {
				productId,
				displayName,
				existingQty: existingLine.quantity,
				requestedQty: effectiveQty,
				prevTotal,
			};
			input.attributesManager.setSessionAttributes(attrs);
			const unitExisting = existingLine.quantity === 1 ? "unidad" : "unidades";
			const proposedTotal = existingLine.quantity + effectiveQty;
			return input.responseBuilder
				.speak(`Ya tienes ${existingLine.quantity} ${unitExisting} de ${displayName} en el carrito. ¿Cuántas quieres en total? Si no me respondes te dejaré ${proposedTotal}.`)
				.reprompt(`Dime cuántas unidades de ${displayName} quieres en total.`)
				.withShouldEndSession(false)
				.getResponse();
		}

		const updated = await client.addToCart(productId, effectiveQty);
		const unit = effectiveQty === 1 ? "unidad" : "unidades";
		const suffix = cartSuffix(prevTotal, parseEuros(updated.summary.total));
		return speak(input, `Añadidas ${effectiveQty} ${unit} de ${displayName} al carrito.${suffix}`);
	},
};

const AddMoreIntentHandler: RequestHandler = {
	canHandle(input) {
		return (
			getRequestType(input.requestEnvelope) === "IntentRequest" &&
			getIntentName(input.requestEnvelope) === "AddMoreIntent"
		);
	},
	async handle(input) {
		const attrs = input.attributesManager.getSessionAttributes();
		if (!attrs.expectingFollowUp) {
			return speak(input, "Dime qué quieres añadir. Por ejemplo: añade kéfir.");
		}
		return AddToCartIntentHandler.handle(input);
	},
};

const SetQuantityIntentHandler: RequestHandler = {
	canHandle(input) {
		return (
			getRequestType(input.requestEnvelope) === "IntentRequest" &&
			getIntentName(input.requestEnvelope) === "SetQuantityIntent"
		);
	},
	async handle(input) {
		const attrs = input.attributesManager.getSessionAttributes();
		const pendingAdd = attrs.pendingAdd as
			| { productId: string; displayName: string; existingQty: number; requestedQty: number; prevTotal?: number }
			| undefined;
		const pendingDis = attrs.pendingDisambiguation as
			| { candidates: { id: string; name: string; recommendedQty: number }[]; requestedQty: number | null }
			| undefined;

		const raw = getSlotValue(input.requestEnvelope, "quantity");
		const n = raw ? parseInt(raw, 10) : NaN;
		if (!Number.isInteger(n) || n < 0 || n > 99) {
			return speak(input, "No he entendido el número. Repítelo, por favor.", false);
		}

		// Caso 1: hay desambiguación pendiente. El número es índice (1-based) en la lista.
		if (pendingDis) {
			if (n < 1 || n > pendingDis.candidates.length) {
				return speak(input, `Di un número entre 1 y ${pendingDis.candidates.length}.`, false);
			}
			const chosen = pendingDis.candidates[n - 1]!;
			delete attrs.pendingDisambiguation;
			input.attributesManager.setSessionAttributes(attrs);

			await sendProgressive(input, "Marchando.");

			// Reproducimos el flujo de añadir con la cantidad original o el recommended del elegido.
			const qty = pendingDis.requestedQty ?? defaultQty(chosen.recommendedQty);
			const cart = await client.getCart();
			const prevTotal = parseEuros(cart.summary.total);
			const existing = cart.lines.find((l) => l.product.id === chosen.id);
			if (existing) {
				const proposedTotal = existing.quantity + qty;
				attrs.pendingAdd = {
					productId: chosen.id,
					displayName: chosen.name,
					existingQty: existing.quantity,
					requestedQty: qty,
					prevTotal,
				};
				input.attributesManager.setSessionAttributes(attrs);
				const unitExisting = existing.quantity === 1 ? "unidad" : "unidades";
				return input.responseBuilder
					.speak(`Ya tienes ${existing.quantity} ${unitExisting} en el carrito. ¿Cuántas quieres en total? Si no me respondes te dejaré ${proposedTotal}.`)
					.reprompt("Dime cuántas unidades quieres en total.")
					.withShouldEndSession(false)
					.getResponse();
			}
			const updated = await client.addToCart(chosen.id, qty);
			const unit = qty === 1 ? "unidad" : "unidades";
			const suffix = cartSuffix(prevTotal, parseEuros(updated.summary.total));
			return speak(input, `Añadidas ${qty} ${unit}.${suffix}`);
		}

		// Caso 2: hay añadido pendiente con conflicto de cantidad.
		if (pendingAdd) {
			delete attrs.pendingAdd;
			input.attributesManager.setSessionAttributes(attrs);
			await sendProgressive(input, "Marchando.");
			const updated = await client.setCartLineQuantity(pendingAdd.productId, n);
			const suffix = cartSuffix(pendingAdd.prevTotal ?? 0, parseEuros(updated.summary.total));
			if (n === 0) {
				return speak(input, `Quitado del carrito.${suffix}`);
			}
			const unit = n === 1 ? "unidad" : "unidades";
			return speak(input, `Hecho. Queda en ${n} ${unit}.${suffix}`);
		}

		return speak(input, "No tengo nada pendiente que confirmar. ¿Qué quieres añadir?");
	},
};

const RemoveFromCartIntentHandler: RequestHandler = {
	canHandle(input) {
		return (
			getRequestType(input.requestEnvelope) === "IntentRequest" &&
			getIntentName(input.requestEnvelope) === "RemoveFromCartIntent"
		);
	},
	async handle(input) {
		const raw = getSlotValue(input.requestEnvelope, "productName");
		if (!raw || raw.trim().length === 0) {
			return speak(input, "No he entendido qué producto quieres quitar. Repítelo, por favor.", false);
		}

		await sendProgressive(input, `Un momento, busco ${raw} en el carrito.`);

		const cart = await client.getCart();
		if (cart.lines.length === 0) {
			return speak(input, "El carrito ya está vacío.");
		}

		const matches = findBestMatches(raw, cart.lines);
		if (matches.length === 0) {
			return speak(input, `No encuentro "${raw}" en el carrito.`);
		}
		if (matches.length > 1) {
			const names = matches.slice(0, 3).map((m) => m.item.product.display_name);
			const list = names.length === 1
				? names[0]
				: names.slice(0, -1).join(", ") + " o " + names[names.length - 1];
			return speak(
				input,
				`He encontrado varias coincidencias en el carrito: ${list}. Dime cuál con más detalle.`,
				false,
			);
		}

		const best = matches[0]!;
		const productId = best.item.product.id;
		const displayName = best.item.product.display_name;

		const prevTotal = parseEuros(cart.summary.total);
		const updated = await client.removeFromCart(productId);
		const suffix = cartSuffix(prevTotal, parseEuros(updated.summary.total));
		return speak(input, `Quitado ${displayName} del carrito.${suffix}`);
	},
};

const GetCartTotalIntentHandler: RequestHandler = {
	canHandle(input) {
		return (
			getRequestType(input.requestEnvelope) === "IntentRequest" &&
			getIntentName(input.requestEnvelope) === "GetCartTotalIntent"
		);
	},
	async handle(input) {
		const cart = await client.getCart();
		const total = parseEuros(cart.summary.total);
		if (total === 0) {
			return speak(input, "El carrito está vacío.");
		}
		if (total >= MIN_ORDER_EUR) {
			return speak(input, `Total ${formatEuros(total)}. Importe mínimo superado.`);
		}
		const missing = MIN_ORDER_EUR - total;
		return speak(input, `Total ${formatEuros(total)}. Te faltan ${formatEuros(missing)} para el importe mínimo.`);
	},
};

const GetMinimumOrderIntentHandler: RequestHandler = {
	canHandle(input) {
		return (
			getRequestType(input.requestEnvelope) === "IntentRequest" &&
			getIntentName(input.requestEnvelope) === "GetMinimumOrderIntent"
		);
	},
	handle(input) {
		return speak(input, `El importe mínimo del pedido en Mercadona es de ${MIN_ORDER_EUR} euros.`);
	},
};

const CheckoutIntentHandler: RequestHandler = {
	canHandle(input) {
		return (
			getRequestType(input.requestEnvelope) === "IntentRequest" &&
			getIntentName(input.requestEnvelope) === "CheckoutIntent"
		);
	},
	handle(input) {
		return speak(input, "Yo solo gestiono el carrito. Para finalizar la compra abre la app o la web de Mercadona y confirma el pedido desde allí.");
	},
};

const ClearCartIntentHandler: RequestHandler = {
	canHandle(input) {
		return (
			getRequestType(input.requestEnvelope) === "IntentRequest" &&
			getIntentName(input.requestEnvelope) === "ClearCartIntent"
		);
	},
	async handle(input) {
		const req = input.requestEnvelope.request as { intent?: { confirmationStatus?: string } };
		const status = req.intent?.confirmationStatus;

		if (status === "DENIED") {
			return speak(input, "Vale, dejo el carrito como está.");
		}
		if (status !== "CONFIRMED") {
			return input.responseBuilder.addDelegateDirective().getResponse();
		}

		await sendProgressive(input, "Un momento, vacío el carrito.");
		await client.clearCart();
		return speak(input, "Carrito vaciado.");
	},
};

const HelpIntentHandler: RequestHandler = {
	canHandle(input) {
		return (
			getRequestType(input.requestEnvelope) === "IntentRequest" &&
			getIntentName(input.requestEnvelope) === "AMAZON.HelpIntent"
		);
	},
	handle(input) {
		return input.responseBuilder
			.speak("Puedes decir: añade kéfir, o añade dos paquetes de yogur. Sólo busco entre tus habituales.")
			.reprompt("¿Qué quieres añadir?")
			.withShouldEndSession(false)
			.getResponse();
	},
};

const FallbackIntentHandler: RequestHandler = {
	canHandle(input) {
		return (
			getRequestType(input.requestEnvelope) === "IntentRequest" &&
			getIntentName(input.requestEnvelope) === "AMAZON.FallbackIntent"
		);
	},
	handle(input) {
		const attrs = input.attributesManager.getSessionAttributes();
		if (attrs.expectingFollowUp) {
			return speak(input, "No te he entendido. Si quieres añadir algo di: añade, y el nombre. Para quitar: quita, y el nombre.");
		}
		return speak(input, "No te he entendido. Por ejemplo, di: añade kéfir.");
	},
};

const CancelStopIntentHandler: RequestHandler = {
	canHandle(input) {
		const t = getRequestType(input.requestEnvelope);
		if (t !== "IntentRequest") return false;
		const n = getIntentName(input.requestEnvelope);
		return n === "AMAZON.CancelIntent" || n === "AMAZON.StopIntent";
	},
	handle(input) {
		const attrs = input.attributesManager.getSessionAttributes();
		delete attrs.pendingAdd;
		delete attrs.pendingDisambiguation;
		input.attributesManager.setSessionAttributes(attrs);
		return speak(input, "Adiós.", true);
	},
};

const SessionEndedRequestHandler: RequestHandler = {
	canHandle(input) {
		return getRequestType(input.requestEnvelope) === "SessionEndedRequest";
	},
	handle(input) {
		return input.responseBuilder.getResponse();
	},
};

const ErrorHandlerImpl: ErrorHandler = {
	canHandle() {
		return true;
	},
	handle(input, error) {
		const e = error as Error;
		console.error("Skill error:", e?.name, e?.message, e?.stack);
		if (error instanceof MercadonaAuthError) {
			return speak(input, "El token de Mercadona ha caducado. Renuévalo y prueba otra vez.");
		}
		if (error instanceof MercadonaApiError) {
			return speak(input, `Mercadona ha respondido con un error ${error.status}. Inténtalo en unos minutos.`);
		}
		return speak(input, "Ha habido un problema procesando la orden. Inténtalo otra vez.");
	},
};

export const handler = SkillBuilders.custom()
	.addRequestHandlers(
		LaunchRequestHandler,
		AddToCartIntentHandler,
		AddMoreIntentHandler,
		SetQuantityIntentHandler,
		RemoveFromCartIntentHandler,
		ClearCartIntentHandler,
		GetCartTotalIntentHandler,
		GetMinimumOrderIntentHandler,
		CheckoutIntentHandler,
		HelpIntentHandler,
		FallbackIntentHandler,
		CancelStopIntentHandler,
		SessionEndedRequestHandler,
	)
	.addErrorHandlers(ErrorHandlerImpl)
	.lambda();
