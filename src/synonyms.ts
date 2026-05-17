// Diccionario de sinónimos para el matcher.
// Clave: forma normalizada (sin acentos, minúsculas) que diría el usuario.
// Valor: forma normalizada que aparece en el display_name del producto en habituales.
//
// Reglas:
//  - Ambas en singular (la singularización automática se aplica antes).
//  - Sin acentos (matcher.ts ya quita diacríticos).
//  - Tokens individuales, no frases.
//  - Solo añadir si la palabra de la izquierda NO aparece ya en ningún display_name
//    de habituales (si aparece, redirigirla rompería matches legítimos).
//
// Cuando una nueva frase del usuario falle, mira los logs, identifica el token
// problemático y añade la entrada aquí. Después `npm run build:hosted` y deploy.
export const SYNONYMS: Record<string, string> = {
	// --- Variantes regionales / dialectales ---
	"papa": "patata",          // → "Patatas (Malla, 3kg)", "Patatas guarnición"
	"papas": "patata",
	"habichuela": "judia",     // → "Judías verdes planas Hacendado"
	"habichuelas": "judia",
	"frijol": "alubia",        // → "Alubia granja Hacendado"
	"frijoles": "alubia",
	"poroto": "alubia",
	"porotos": "alubia",

	// --- Cambios de denominación / coloquial ---
	"platano": "banana",       // → "Banana (Pieza)". En España "plátano" suele ser la banana.
	"platanos": "banana",
	"fresa": "freson",         // → "Fresón (Bandeja)". Lo que vendes son fresones, pero el usuario dice fresa.
	"fresas": "freson",
	"yogur": "bifidus",        // → "Bífidus natural probióticos". En este surtido no hay yogur "clásico".
	"yogures": "bifidus",
	"yoghurt": "bifidus",
	"cangrejo": "surimi",      // → "Palitos de surimi Hacendado". "Palitos de cangrejo" es el nombre coloquial.
	"cangrejos": "surimi",
	"sardina": "sardinilla",   // → "Sardinillas en aceite". El usuario pide "sardinas" pero el producto es "sardinillas".
	"sardinas": "sardinilla",
	"liquida": "liquido",      // → "Edulcorante líquido sacarina Hacendado". Concordancia femenina con el producto pedido ("sacarina líquida").
	"liquidas": "liquido",
	"campero": "campera",      // → "Huevos de gallinas camperas". El adjetivo concuerda con "gallinas" en el producto, pero el usuario dice "huevos camperos".
	"camperos": "campera",
	"nueces": "nuez",          // → "Nuez troceada pelada Hacendado". La singularizacion heuristica de "nueces" da "nuec" (no "nuez"), asi que necesitamos redirigir explicitamente.
	// Pares de concordancia de genero. Una sola direccion basta (tokenForms se aplica a ambos lados,
	// asi que la expansion fem->masc tambien hace que el lado masc del producto cace consultas en fem y viceversa).
	"concentrada": "concentrado",     // → "Tomate doble concentrado Hacendado extra"
	"concentradas": "concentrado",
	"semidesnatada": "semidesnatado", // → "Leche semidesnatada" / "Queso ... semidesnatado"
	"semidesnatadas": "semidesnatado",
	"desnatada": "desnatado",         // sin producto actual con esta raiz, future-proof
	"desnatadas": "desnatado",
	"desgrasado": "desnatado",        // "desgrasado" / "desnatado" son denominaciones equivalentes; canonizamos a "desnatado".
	"desgrasada": "desnatado",
	"desgrasados": "desnatado",
	"desgrasadas": "desnatado",
	// Sinonimos de denominacion
	"colutorio": "enjuague",          // → "Enjuague bucal Blanqueador Bicarbonato Deliplus zero alcohol"
	"colutorios": "enjuague",
	"capsula": "monodosis",    // → "Café monodosis ..."
	"capsulas": "monodosis",
	"capsulita": "monodosis",
	"refrescos": "refresco",   // singularización defensiva (la regla cubre 'es' final si len > 3, "refrescos" cae bien)

	// --- Variantes ortográficas comunes que el ASR de Alexa puede entregar ---
	"emental": "emmental",
	"emmenthal": "emmental",
	"ementhal": "emmental",
	"brocoli": "brocoli",      // ya sin acento por normalize(); placeholder por si el ASR mete variantes
	"coliflores": "coliflor",
	"calabacin": "calabacin",
	"calabacines": "calabacin",
	"esparrago": "esparragos",
	"sandia": "sandia",
	"sandias": "sandia",
	"limon": "limones",        // habituales tiene "Limones" (plural), forzamos esa forma
	"granadas": "granada",
	"paraguayo": "paraguayos",
	"manzana": "manzanas",     // habituales tiene "Manzanas rojas acidulces"
};
