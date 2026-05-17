# Alexa-Mercadona

Skill de Alexa para añadir y quitar productos del carrito de Mercadona por voz.

> **Importante**: la skill SÓLO opera sobre los productos de tu lista **"Mis Habituales"** de Mercadona. No busca en el catálogo general. Esto es deliberado: limitar el universo de productos hace que el reconocimiento por voz funcione de forma fiable. Si dejásemos buscar en los ~30.000 productos del catálogo, cada frase produciría docenas de candidatos plausibles y el usuario tendría que desambiguar constantemente, hasta el punto de hacer la skill inutilizable. Si quieres que un producto sea pedible por voz, asegúrate primero de que aparece en "Mis Habituales" (Mercadona lo añade automáticamente cuando lo compras varias veces).
>
> **La skill NO finaliza la compra.** A propósito. Sólo gestiona el carrito (añadir, quitar, vaciar, ajustar cantidades). Cuando consideres que ya tienes todo, abres la app o la web de Mercadona y revisas + confirmas el pedido tú mismo. Esto evita que un malentendido de voz acabe en un pedido no deseado, y deja la decisión final (slot de entrega, dirección, método de pago) en la interfaz que está diseñada para ello. La skill pretende ser una alternativa a la "lista de la compra" de Alexa, no un sustituto del checkout.

Permite cosas como:

- *"Alexa, dile a mi mercadona que añada kéfir."*
- *"Alexa, pídele a mi mercadona que añada dos paquetes de yogur."*
- *"Alexa, dile a mi mercadona que quite los limones."*
- *"Alexa, dile a mi mercadona que vacíe el carrito."* (con confirmación)

---

## Avisos importantes

- **No es un producto oficial de Mercadona ni de Amazon.** Es ingeniería inversa de la API web de tienda.mercadona.es para uso personal. Mercadona puede cambiar la API en cualquier momento y romperla.
- **Mono-usuario por instalación.** Cada despliegue funciona con UN cliente de Mercadona, configurado con su JWT. No hay multi-cuenta.
- **El JWT da control total del carrito.** Trátalo como una contraseña. Está en `.gitignore` y en `secrets.json` (también gitignored). Nunca commitees ninguno de los dos.
- **El JWT caduca cada 42 días.** Hay un bookmarklet para renovarlo en 30 segundos (ver sección de refresco).
- **La skill no puede publicarse en el store de Amazon** sin permiso de Mercadona por uso de marca. Pensada para vivir en modo Development en tu cuenta personal de Alexa Developer.

---

## Cómo funciona

1. El usuario habla a Alexa. El interaction model captura la frase y la mapea a un intent (`AddToCartIntent`, `AddMoreIntent`, `RemoveFromCartIntent`, `ClearCartIntent`, `SetQuantityIntent`, `GetCartTotalIntent`, `GetMinimumOrderIntent`, `CheckoutIntent`, o `AMAZON.FallbackIntent`).
2. El handler de la skill (Lambda Node, alojado en Alexa-Hosted) recibe el intent.
3. Para tareas con I/O notable la skill emite una respuesta progresiva ("Un momento, busco X") vía Progressive Response API mientras corre la llamada a Mercadona — el usuario no percibe silencio.
4. Llama a la API de Mercadona con el JWT del usuario para leer "Mis Habituales" (cacheado en memoria 1 h por warm starts) y/o el carrito.
5. Un matcher con normalización, singularización heurística y un diccionario de sinónimos editable casa la frase del usuario con el producto más probable.
6. Si hay ambigüedad, la skill enumera las opciones y pide un número.
7. Si el producto ya está en el carrito, la skill pregunta cuántas unidades en total quieres.
8. Aplica la operación contra el carrito vía un PUT idempotente.
9. Tras cada acción la sesión queda abierta con "¿Hago algo más?" + earcon corto. Se puede encadenar con frases breves tipo "y kéfir", "también yogur" (intent `AddMoreIntent`). Si dices algo que la skill no entiende, `AMAZON.FallbackIntent` te recuerda la fórmula correcta.

---

## Requisitos previos

- **Cuenta personal de Mercadona** activa, con productos en "Mis Habituales" (la skill no busca fuera de ahí). Para sembrar los habituales: usa la web/app oficial unas semanas haciendo compras reales.
- **Cuenta de [Amazon Developer](https://developer.amazon.com/alexa/console/ask)** (gratis, requiere una cuenta Amazon).
- **Node.js 20+** local (para el build y, opcionalmente, el CLI de pruebas).
- **Chrome** o navegador equivalente para extraer el token con el bookmarklet.

---

## Setup paso a paso

### 1. Clonar y dependencias

```bash
git clone https://github.com/abgagu/alexa-mercadona.git
cd alexa-mercadona
npm install
```

### 2. Capturar el token de Mercadona

Tu JWT vive en el `localStorage` de tienda.mercadona.es. Hay dos formas de obtenerlo:

#### Opción A — Bookmarklet (recomendado, especialmente para futuros refrescos)

1. Crea un marcador nuevo en Chrome.
2. Nombre: `Mercadona token`.
3. URL: pega el contenido completo de [`tools/bookmarklet.txt`](tools/bookmarklet.txt). Empieza por `javascript:`.
4. Abre https://tienda.mercadona.es/ y asegúrate de estar logueado.
5. Pulsa el marcador. Te dirá *"secrets.json copiado al portapapeles"*.

#### Opción B — Manual

1. Abre https://tienda.mercadona.es/ logueado.
2. DevTools (F12) → Application → Local Storage → `https://tienda.mercadona.es`.
3. Busca la clave `MO-user`. Es un JSON con campos `token` y `uuid`.
4. Apunta ambos valores.

### 3. Crear `secrets.json` local

```bash
cp secrets.example.json secrets.json
# edita secrets.json con los valores obtenidos en el paso 2
```

El mismo `secrets.json` lo usa el CLI local y el build de la skill (se copia automáticamente al paquete que sube a Alexa-Hosted). Tanto el CLI como el handler en la nube lo leen.

Verifica:

```bash
npm run cli -- whoami            # debe imprimir tu nombre y cart_id
npm run cli -- list --filter X   # lista habituales filtrados
npm run cli -- cart              # estado del carrito
```

**El CLI modifica el carrito REAL.** Cualquier `add` que hagas en pruebas, revísalo y revierte si no lo querías.

### 4. Crear la skill en Alexa Developer Console

1. Entra a https://developer.amazon.com/alexa/console/ask y haz "Create Skill".
2. **Skill name**: cualquier nombre distinto del invocation name (por ejemplo `Mi Mercadona`).
3. **Primary locale**: `Spanish (ES)`. Si quieres soportar otro locale (es-MX, es-US, en-US...), tendrás que duplicar el modelo de interacción.
4. **Experience type**: `Other` → `Custom`.
5. **Model**: `Custom`.
6. **Hosting service**: `Alexa-hosted (Node.js)`. No requiere configurar nada en AWS por tu cuenta.
7. **Template**: `Start from Scratch`.
8. Tras crearla, espera 1–2 minutos a que aprovisione los recursos (verás un mensaje "skill is being provisioned").

### 5. Configurar el invocation name y el modelo

1. Pestaña **Build** → menú lateral **Invocations** → **Skill Invocation Name** → pon `mi mercadona` (o el invocation name que prefieras, mínimo 2 palabras).
2. Menú lateral → **JSON Editor**.
3. Borra todo el contenido y pega el contenido completo de [`alexa/interaction-model-es-ES.json`](alexa/interaction-model-es-ES.json) del repo. (Si cambiaste el invocation name, edita el campo `invocationName` antes de pegar.)
4. **Save Model**.
5. **Build Model**. Espera a que termine (1–3 min).

### 6. Construir el código

En tu máquina local:

```bash
npm run build:hosted
```

Esto produce la carpeta `lambda/` lista con:

```
lambda/
  index.js
  package.json
  env.js
  mercadona-client.js
  matcher.js
  synonyms.js
  secrets.json         <- generado a partir de tu secrets.json local
  skill/
    handler.js
    regulars-cache.js
    fetch-polyfill.js
```

### 7. Empaquetar e importar a Alexa-Hosted

Comprime la carpeta `lambda/` en un zip (debe quedar la carpeta `lambda/` en la raíz del zip, no su contenido suelto). Luego en la consola Alexa:

1. Pestaña **Code** → botón **Import Code** → selecciona el zip.
2. La importación NO borra los archivos del template Hello World que crea el wizard. Tras importar, en el árbol de archivos borra a mano `index.js` (el del template, en CommonJS), `local-debugger.js` y `util.js`. Si dejas el `index.js` viejo, la Lambda peta con `ReferenceError: require is not defined in ES module scope`.
3. **Deploy** (arriba a la derecha).

### 8. Primera prueba

Pestaña **Test**:

1. Cambia el selector de "Off" a "Development".
2. Escribe o di:
   ```
   abre mi mercadona
   ```
3. La skill debe responder algo como *"Hola. Dime qué quieres añadir al carrito de Mercadona."*
4. Prueba:
   ```
   añade kéfir
   ```
5. Debería responder *"Añadidas 1 unidad de Kéfir natural sabor suave al carrito."* (o similar, según tus habituales).

Si algo falla, mira el log: pestaña Code → botón **Logs** abajo → te lleva a CloudWatch.

---

## Patrones de invocación

Una vez la skill está habilitada en tu cuenta (en Development eso ya pasa), puedes hablarle así desde cualquier dispositivo Alexa o el simulador:

**Abrir sesión y dialogar**:
```
Alexa, abre mi mercadona
> añade kéfir
> quita los limones
> vacía el carrito
> sí               (confirma el vaciado)
> para             (cierra)
```

**Una sola frase, sin abrir sesión**:
```
Alexa, dile a mi mercadona que añada dos paquetes de yogur
Alexa, pídele a mi mercadona que quite el kéfir
Alexa, dile a mi mercadona que vacíe el carrito
```

Verbos válidos para añadir: `añade/añada`, `echa/eche`, `mete/meta`, `pon/ponga`, `apunta/apunte`, `quiero`, `necesito`. (Los subjuntivos son necesarios porque Alexa convierte el imperativo a subjuntivo en la plantilla `dile a X que ...`. Todas las formas tienen su variante de ustedeo simétrica.)

Verbos para quitar: `quita/quite`, `saca/saque`, `borra/borre`, `elimina/elimine`, `quítame/quíteme`, `sácame/sáqueme`.

Vaciar: `vacía/vacíe el carrito`, `limpia/limpie el carro`, `borra/borre todo el carrito`, `empieza/empiece de cero`.

**Encadenar acciones** (mientras la sesión sigue abierta tras una acción): formas cortas con `y`, `también`, `ahora`, `otro`, `además`, etc.

```
> añade plátanos
< Añadidas 1 unidad de Plátano de Canarias al carrito. Total 39 euros. ¿Hago algo más?
> y kéfir
< Añadidas 1 unidad de Kéfir Hacendado al carrito. Total 40 euros. ¿Hago algo más?
```

**Re-invocación accidental**: si crees que la skill ha cerrado y vuelves a usar la fórmula completa, también funciona — los samples cubren "dile a mi mercadona que añada {producto}" cuando la sesión sigue abierta.

**Cantidades**: el handler entiende numerales escritos en español (`un/uno/una`, `dos`...`doce`) o dígitos. *"Añade tres yogures"* → `quantity=3`.

**Cuando hay varias coincidencias**, la skill enumera por voz:
```
> Alexa, dile a mi mercadona que añada plátanos
< He encontrado varias opciones. 1, Banana. 2, Dúo frutas fresa y plátano congeladas. Di el número.
> uno
< Añadidas 1 unidad de Banana al carrito.
```

**Cuando el producto ya está en el carrito**:
```
> añade dos kéfir
< Ya tienes 3 unidades de Kéfir natural sabor suave en el carrito. ¿Cuántas quieres en total?
> cinco
< Hecho. Kéfir natural sabor suave queda en 5 unidades.
```

---

## Refrescar el JWT cada ~40 días

El token de Mercadona caduca a los 42 días. Cuando empiece a fallar (la skill dirá *"El token de Mercadona ha caducado"*), renuévalo:

1. Abre https://tienda.mercadona.es/ logueado.
2. Pulsa el bookmarklet "Mercadona token".
3. Abre la consola Alexa Developer → pestaña **Code** → archivo `lambda/secrets.json`.
4. Selecciona todo (Ctrl+A) y pega (Ctrl+V).
5. **Save** y **Deploy**.

Total: ~30 segundos.

(Si también usas el CLI local, recuerda actualizar tu `secrets.json` local con los mismos valores.)

---

## Añadir sinónimos

Cuando una palabra que dices no encuentra el producto que esperabas, edita [`src/synonyms.ts`](src/synonyms.ts) y añade una entrada:

```typescript
"palabra_que_dices": "palabra_que_aparece_en_display_name",
```

Después:

```bash
npm run build:hosted
# rezipea lambda/, Import Code, Deploy
```

**Regla importante**: la palabra de la izquierda no debe aparecer en ningún `display_name` de tus habituales. Si aparece, redirigirla rompería matches legítimos. La derecha sí puede repetirse y de hecho conviene que sea un token que ya aparezca.

El diccionario inicial está sembrado con casos comunes (papa→patata, yogur→bifidus, fresa→freson, plátano→banana, habichuelas→judia, frijol→alubia, cangrejo→surimi, cápsula→monodosis, etc.).

La singularización es automática (`plátanos` → prueba también `plátano`).

---

## CLI local (desarrollo y debugging)

```bash
npm run cli -- whoami                        # valida token
npm run cli -- list                          # todos los habituales
npm run cli -- list --filter kefir           # filtrados por substring
npm run cli -- list --limit 20
npm run cli -- cart                          # estado del carrito
npm run cli -- add "kefir"                   # busca y añade
npm run cli -- add "yogur natural" -q 2      # cantidad explícita
npm run cli -- add -p 21307                  # por id directo, sin búsqueda
npm run typecheck                            # validación de tipos TS
```

Útil para probar matcher + sinónimos sin redesplegar la skill. Recuerda revertir cambios al carrito si pruebas `add`.

---

## Estructura del proyecto

```
alexa-mercadona/
├── README.md                         <- estás aquí
├── CLAUDE.md                         <- contexto técnico denso (para IA o desarrolladores nuevos)
├── API-RESEARCH.md                   <- ingeniería inversa de la API de Mercadona
├── package.json
├── tsconfig.json
├── secrets.example.json              <- plantilla; el secrets.json real está gitignored
│
├── alexa/
│   └── interaction-model-es-ES.json  <- modelo de interacción para pegar en Alexa Console
│
├── tools/
│   ├── bookmarklet.txt               <- pegar como URL del marcador de Chrome
│   └── bookmarklet-readable.js       <- versión comentada del bookmarklet
│
├── scripts/
│   ├── build-alexa-hosted.mjs        <- npm run build:hosted, produce lambda/
│   └── package-lambda.mjs            <- (no usado actualmente; era para AWS Lambda propia)
│
└── src/
    ├── env.ts                        <- lee process.env y/o secrets.json
    ├── mercadona-client.ts           <- cliente HTTP tipado (get/put cart, add/remove/clear, setLineQuantity, myregulars)
    ├── matcher.ts                    <- normalización, singularización, expansión por sinónimos, scoring
    ├── synonyms.ts                   <- diccionario editable (con docs inline)
    ├── cli.ts                        <- CLI local para pruebas
    └── skill/
        ├── handler.ts                <- todos los handlers de la skill + state de sesión
        ├── regulars-cache.ts         <- cache módulo-global con TTL 1h
        └── fetch-polyfill.ts         <- polyfill fetch para Node 16
```

---

## Sobre el código y la API de Mercadona

Si quieres entender cómo funciona la API por dentro (auth, endpoints, gotchas observados, ejemplos de curl), lee [API-RESEARCH.md](API-RESEARCH.md). Es la documentación de la ingeniería inversa hecha durante el desarrollo.

---

## Licencia y responsabilidad

Código bajo licencia [MIT](LICENSE) (si añades LICENSE) o equivalente — úsalo libremente.

**El uso de la API de tienda.mercadona.es no está cubierto por ninguna licencia ni acuerdo formal con Mercadona.** Es scraping/reverse-engineering. Usa esto bajo tu propia responsabilidad, con tu propia cuenta, para uso personal. No abuses (un par de requests por compra es perfectamente razonable). Si Mercadona en algún momento publica una API oficial o pide explícitamente que se deje de usar la web API, este proyecto debería retirarse.

No me hago responsable de pedidos accidentales, cargos imprevistos, ni de que Mercadona cambie algo y rompa la skill.
