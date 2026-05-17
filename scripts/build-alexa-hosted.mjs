// Genera la carpeta lambda/ lista para copiar al repo git de Alexa-Hosted.
// Estructura final:
//   lambda/
//     index.mjs            (re-export del handler)
//     package.json         (deps mínimas: ask-sdk-core, ask-sdk-model)
//     env.js
//     mercadona-client.js
//     matcher.js
//     skill/handler.js
//     skill/regulars-cache.js
//
// Uso: npm run build:hosted
// Despues: copiar el contenido de lambda/ al repo que da Alexa-Hosted y git push allí.
import { execSync } from "node:child_process";
import { rmSync, mkdirSync, cpSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(process.cwd());
const distDir = join(root, "dist");
const outDir = join(root, "lambda");

function run(cmd) {
	console.log(`> ${cmd}`);
	execSync(cmd, { stdio: "inherit", cwd: root });
}

console.log("== Limpieza ==");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
mkdirSync(join(outDir, "skill"), { recursive: true });

console.log("== tsc build ==");
run("npx tsc -p .");

console.log("== Copiando módulos a lambda/ ==");
const files = [
	["env.js", "env.js"],
	["mercadona-client.js", "mercadona-client.js"],
	["matcher.js", "matcher.js"],
	["synonyms.js", "synonyms.js"],
	["skill/handler.js", "skill/handler.js"],
	["skill/regulars-cache.js", "skill/regulars-cache.js"],
	["skill/fetch-polyfill.js", "skill/fetch-polyfill.js"],
];
for (const [src, dest] of files) {
	cpSync(join(distDir, src), join(outDir, dest));
}

console.log("== Copiando secrets.json (si existe) ==");
const secretsCandidates = [join(root, "secrets.json"), join(root, "src", "secrets.json")];
const secretsFound = secretsCandidates.find((p) => existsSync(p));
if (secretsFound) {
	cpSync(secretsFound, join(outDir, "secrets.json"));
	console.log("  copiado desde " + secretsFound);
} else {
	console.warn("  AVISO: no encontrado ningún secrets.json. La skill arrancará pero fallará al primer request.");
	console.warn("  Crea ./secrets.json con: { \"bearer\": \"...\", \"customerUuid\": \"...\" }");
}

console.log("== Generando lambda/index.js ==");
// .js (no .mjs) para sobrescribir el index.js del template Hello World que deja
// el wizard de Alexa-Hosted. Con "type": "module" en package.json, .js es ESM.
writeFileSync(
	join(outDir, "index.js"),
	'export { handler } from "./skill/handler.js";\n',
);

console.log("== Generando lambda/package.json ==");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const hostedPkg = {
	name: "alexa-mercadona-hosted",
	version: pkg.version,
	private: true,
	type: "module",
	main: "index.js",
	dependencies: {
		"ask-sdk-core": pkg.dependencies["ask-sdk-core"],
		"ask-sdk-model": pkg.dependencies["ask-sdk-model"],
	},
};
writeFileSync(join(outDir, "package.json"), JSON.stringify(hostedPkg, null, 2) + "\n");

console.log("\nListo. Carpeta lista en: " + outDir);
console.log("\nSubir a Alexa-Hosted:");
console.log("  1. Comprime la carpeta lambda/ en un zip (con la carpeta en la raíz).");
console.log("  2. Pestaña Code -> botón \"Import Code\" -> selecciona el zip.");
console.log("  3. Deploy.");
