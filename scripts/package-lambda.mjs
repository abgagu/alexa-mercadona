// Empaqueta la skill para AWS Lambda.
// Pasos: tsc -> copia dist + node_modules de producción a build/lambda -> zip a dist/skill.zip
import { execSync } from "node:child_process";
import { rmSync, mkdirSync, cpSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createWriteStream } from "node:fs";

const root = resolve(process.cwd());
const buildDir = join(root, "build", "lambda");
const distDir = join(root, "dist");
const zipOut = join(root, "dist", "skill.zip");

function run(cmd) {
	console.log(`> ${cmd}`);
	execSync(cmd, { stdio: "inherit", cwd: root });
}

console.log("== Limpieza ==");
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

console.log("== tsc build ==");
run("npx tsc -p .");

console.log("== Copiando dist a build/lambda ==");
cpSync(distDir, buildDir, { recursive: true, filter: (src) => !src.endsWith(".zip") });

console.log("== package.json mínimo para producción ==");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const prodPkg = {
	name: pkg.name,
	version: pkg.version,
	private: true,
	type: pkg.type,
	main: "skill/handler.js",
	dependencies: pkg.dependencies,
};
writeFileSync(join(buildDir, "package.json"), JSON.stringify(prodPkg, null, 2));

console.log("== npm install --omit=dev en build/lambda ==");
run(`npm install --omit=dev --prefix "${buildDir}"`);

console.log("== Creando zip ==");
rmSync(zipOut, { force: true });
// PowerShell Compress-Archive en Windows (más simple que arrastrar dependencia adicional).
const psCmd = `Compress-Archive -Path "${buildDir}\\*" -DestinationPath "${zipOut}" -Force`;
run(`powershell -NoProfile -Command "${psCmd}"`);

console.log(`\nListo: ${zipOut}`);
console.log("Handler de Lambda: skill/handler.handler");
console.log("Runtime: nodejs20.x");
console.log("Env vars necesarias: MERCADONA_BEARER, MERCADONA_CUSTOMER_UUID");
