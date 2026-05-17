# API tienda.mercadona.es — Investigación para skill de Alexa

Fecha de los hallazgos: 2026-05-15. Todas las llamadas se validaron en vivo contra `https://tienda.mercadona.es/` usando Playwright con la sesión real del usuario. El frontend en ese momento reportaba `x-version: v8918`.

Este documento es la base para construir una skill de Alexa que, ante una orden de voz, añada productos al carrito de Mercadona buscándolos primero en "Mis Habituales". No incluye implementación.

---

## 1. Resumen ejecutivo

- La API es REST/JSON sobre `https://tienda.mercadona.es/api/`. Los endpoints autenticados se autorizan **exclusivamente** con un **JWT** en cabecera `Authorization: Bearer ...`. **Las cookies no autentican** — quitarlas no rompe nada; incluir el header sin cookies funciona perfectamente.
- El JWT vive en `localStorage["MO-user"].token` y dura **42 días**. Hay un único token de tipo `"access"`; no hay endpoint de refresh — al expirar toca volver a hacer login.
- "Mis Habituales" se sirve completo en una sola llamada de ~160 KB con ~140 productos en esta cuenta. Latencia típica desde Madrid: **120–180 ms**. Aceptable para Alexa (timeout 8 s).
- Añadir un producto al carrito es un `PUT` **idempotente con el carrito completo** (no incremental). Body mínimo:
  ```json
  { "id":"<cart_id>", "version":<int>, "lines":[ {"quantity":N, "product_id":"<id>", "sources":["+MR"]}, ... ] }
  ```
  Solo necesita `Authorization` y `Content-Type: application/json`. **No** requiere `x-version`, `x-customer-device-id` ni `x-experiment-variants`.
- El endpoint de login `POST /api/auth/tokens/` sigue aceptando user + password planos en JSON. No hay captcha visible en una llamada simple, pero no se ha probado rate-limit ni bloqueo por intentos repetidos. **Para fase 1 no se usará**: el token se capturará a mano desde DevTools.
- Akamai (`bm_sz`, `_abck` cookies) y `incapsula`/similar no aparecen como bloqueantes para llamadas API directas con Bearer válido. Sí pueden aparecer en HTML scraping desde IPs sospechosas.

Conclusión: viable. Para una skill personal, capturar el token cada ~40 días y usar `Authorization: Bearer` directo es la opción más simple y robusta.

---

## 2. Autenticación

### 2.1. Mecanismo real

El frontend almacena el token en `localStorage["MO-user"]`, con esta forma (sanitizada):

```json
{
  "uuid": "<customer_uuid>",
  "token": "<JWT>",
  "userUuid": "<customer_uuid>"
}
```

El JWT es **HS512** y su payload incluye:

```json
{
  "token_type": "access",
  "iat": 1778838310,
  "exp": 1782467110,
  "jti": "<id_unico>",
  "user_id": "<user_id>",
  "created_at": "2026-05-15 09:45:10.578120+00:00",
  "customer_uuid": "<customer_uuid>"
}
```

`exp - iat = 3 628 800 s = 42 días`. Es la vida útil máxima observada.

Comprobado:
- `Authorization: Bearer <jwt>` sin cookies → 200.
- Sin `Authorization`, con cookies → 401 `not_authenticated`.
- `Authorization: Bearer <jwt-fabricado-mal-firmado>` → 401 `token_not_valid`.
- `POST /api/auth/refresh/` → 404 (no existe).
- `POST /api/auth/tokens/` con creds bogus → 400 `"No active account found with the given credentials"`. Sin captcha en una llamada aislada.

### 2.2. Cómo capturar el token a mano (fase 1)

Pasos para el usuario, ~30 segundos:

1. Abrir `https://tienda.mercadona.es/` en Chrome y comprobar arriba a la derecha que pone "Hola \<nombre\>".
2. F12 → pestaña **Application** → en el árbol izquierdo, **Local Storage** → `https://tienda.mercadona.es`.
3. Clic en la clave `MO-user`. En el panel derecho se ve un JSON con `uuid` y `token`.
4. Copiar el valor de `token` (el JWT entero) y el valor de `uuid` (el `customer_uuid`).
5. Guardarlos en un `.env` privado de la skill, con nombres p.ej.:
   ```
   MERCADONA_BEARER=eyJhbGciOiJIUzUxMiIs...
   MERCADONA_CUSTOMER_UUID=........-....-....-....-............
   ```
6. Apuntar la fecha — habrá que repetir el proceso en ~40 días.

Validación rápida del token desde terminal:
```bash
curl -s "https://tienda.mercadona.es/api/customers/$MERCADONA_CUSTOMER_UUID/" \
  -H "Authorization: Bearer $MERCADONA_BEARER"
```
Debe devolver 200 con `{id, uuid, email, name, last_name, current_postal_code, cart_id, ...}`.

### 2.3. Por qué no usamos login programático en fase 1

`POST /api/auth/tokens/` con `{username, password}` parece funcionar hoy, pero:
- Obliga a guardar la contraseña en el backend de la skill.
- No se ha probado el comportamiento ante varios intentos fallidos seguidos — podría disparar captcha o bloqueo de cuenta.
- Cualquier cambio futuro de Mercadona (añadir captcha, 2FA, mover a OAuth contra `fed.mercadona.com`) rompería la skill sin previo aviso.
- La vida del token (42 días) hace que la fricción del modo manual sea baja.

Si en el futuro se quiere automatizar, el primer experimento sería:
- Probar `POST /api/auth/tokens/` desde la IP de producción (Akamai puede tratar diferente IPs residenciales vs cloud).
- Comprobar si tras 5–10 intentos seguidos aparece captcha o bloqueo.

---

## 3. Endpoints relevantes para la skill

Para todos los endpoints autenticados:
```
Authorization: Bearer <JWT>
```
Las llamadas se hacen contra `https://tienda.mercadona.es/api/`. La UI suele añadir `?lang=es&wh=mad1` (warehouse del CP del cliente), pero son **opcionales** — los endpoints responden igual sin ellos.

`<customer_uuid>` es el valor de `MO-user.uuid` (también disponible en el claim `customer_uuid` del JWT).

### 3.1. `GET /api/customers/<customer_uuid>/` — sanity check del token

Útil para validar que el token está vivo y obtener `cart_id` y `current_postal_code` sin tocar el carrito.

Respuesta:
```json
{
  "id": <int>,
  "uuid": "<customer_uuid>",
  "email": "...",
  "name": "...",
  "last_name": "...",
  "current_postal_code": "28036",
  "cart_id": "<cart_id>",
  "has_requested_account_deletion": false,
  "has_active_billing": true
}
```

### 3.2. `GET /api/customers/<customer_uuid>/recommendations/myregulars/<tipo>/` — Mis Habituales

`<tipo>` puede ser `precision` o `recall`. **En esta cuenta los dos endpoints han devuelto exactamente la misma lista en el mismo orden** (sospechoso, posible degeneración de la API). Usar `precision` por defecto.

Respuesta:
```json
{
  "next_page": null,
  "results": [
    {
      "product": { "id":"21307", "display_name":"Bífidus natural probióticos Hacendado", "slug":"...", "thumbnail":"...", "categories":[{"id":11,"name":"Postres y yogures",...}], "price_instructions":{...}, "published":true, "limit":999, "badges":{...}, "unavailable_from":null, "unavailable_weekdays":[], "packaging":null },
      "source": "my_regulars",
      "source_code": "MR",
      "selling_method": 0,
      "recommended_quantity": 1
    },
    ...
  ]
}
```

Observaciones:
- Esta cuenta devolvió **140 productos** en una sola respuesta (~160 KB). No hay paginación real (`next_page: null`).
- Cada item trae el objeto `product` completo con todo lo necesario para emparejar (nombre, slug, categoría, formato/packaging, precio).
- `source_code: "MR"` es lo que luego va en el `sources` de la línea del carrito como `"+MR"`.
- Vida latencia: ~120–180 ms desde Madrid.

### 3.3. `GET /api/customers/<customer_uuid>/cart/` — leer carrito

Respuesta:
```json
{
  "id": "<cart_id>",
  "version": 27,
  "lines": [
    {
      "quantity": 1.0,
      "sources": ["+MR"],
      "version": 22,
      "product": { /* objeto producto completo */ }
    },
    ...
  ],
  "open_order_id": null,
  "summary": { "total": "39.02" },
  "products_count": 13
}
```

Notas:
- `version` (top-level): contador entero que el servidor incrementa con cada modificación.
- Cada `line.version`: contador propio de la línea (suele alinearse con la versión global del momento en que la línea se modificó por última vez).
- `sources` es un **log** de operaciones, no un origen único. Cada `"+MR"` representa un "+1 desde Mis Habituales" y un `"-MR"` un "-1". Para 1 unidad neta puedes pasar simplemente `["+MR"]`.
- `summary.total` viene como string con punto decimal.

### 3.4. `PUT /api/customers/<customer_uuid>/cart/` — añadir / actualizar carrito

**Es un PUT idempotente con el carrito completo.** No hay endpoint para añadir una sola línea de forma incremental.

Cabeceras mínimas verificadas:
```
Authorization: Bearer <JWT>
Content-Type: application/json
```
No se necesitan `x-version`, `x-customer-device-id`, `x-experiment-variants` ni los query params `?lang=es&wh=mad1`.

Body (capturado de una request real al hacer "+1 Bífidus" desde la UI):
```json
{
  "id": "<cart_id>",
  "version": 25,
  "lines": [
    { "quantity": 1, "product_id": "21307", "sources": ["+MR"] },
    { "quantity": 1, "version": 22, "product_id": "23561", "sources": ["+MR"] },
    { "quantity": 3, "version": 21, "product_id": "61089", "sources": ["+MR","+MR","+MR"] },
    { "quantity": 2, "version": 9,  "product_id": "3832",  "sources": ["+SA","+SA"] }
  ]
}
```

Observaciones del contrato:
- Las **líneas nuevas** se envían **sin** campo `version` (lo asigna el servidor).
- Las **líneas existentes** se envían con su `version` actual.
- El `version` top-level es la versión **actual antes del cambio**.
- `sources` para una línea recién creada desde Mis Habituales: `["+MR"]` repetido tantas veces como `quantity`. Para una línea ya existente con histórico, conviene **conservar** lo que venía y **añadir** `"+MR"` adicionales.

Respuesta:
- `200 OK` con el cuerpo del carrito completo en formato de lectura (igual que `GET /cart/`).
- `version` incrementado en 1.
- Cabecera `x-customer-pc: <CP>` y `x-customer-wh: <warehouse>` informativas.

Comportamientos verificados:
- Mandar `version: 1` (muy atrás) contra un carrito en `version: 27`: **200 OK**. El servidor no rechaza con conflicto, parece reconciliar. No hay control de concurrencia optimista visible. Para una skill personal no es problema; si en algún momento hubiese concurrencia con el móvil del usuario, podría haber sobreescrituras silenciosas.
- Quitar una línea → omitirla en `lines`. (Para quitar 1 unidad de una línea con quantity>1, hay que mandar la línea con `quantity` reducida y añadir un `"-MR"` al final del `sources`, manteniendo los previos.)
- Vaciar carrito → `lines: []`.

### 3.5. Otros endpoints autenticados vistos (no usados en fase 1)

- `GET /api/customers/<uuid>/orders/cart/drafts/` → 404 en esta cuenta (puede ser stub).
- `POST /api/auth/refresh/` → 404 (no existe; no hay refresh).

---

## 4. Endpoints públicos útiles a futuro (sin auth)

No necesarios para la skill v1, pero útiles cuando se amplíe más allá de "Mis Habituales":

- `GET /api/categories/`
- `GET /api/categories/<id>/`
- `GET /api/products/<id>/`
- `GET /api/products/<id>/similars/`, `/xselling/`
- `GET /api/home/`, `/api/home/new-arrivals/`, `/api/home/price-drops/`, `/api/home/sections/<uuid>/`
- `GET /api/postal-codes/actions/retrieve-pc/<cp>/`
- `PUT /api/postal-codes/actions/change-pc/`  (body `{"new_postal_code":"..."}`)

Atención a la **búsqueda de productos**: la UI usa un endpoint en `https://api.mercadona.es/` (servicio separado), no en `tienda.mercadona.es`. Investigar cuando toque la fase de "buscar fuera de Mis Habituales".

---

## 5. Estrategia recomendada de captura del token (fase 1)

Resumida. Detalle en §2.2.

| Aspecto | Decisión |
|---|---|
| Origen del token | `localStorage["MO-user"].token` capturado a mano desde DevTools |
| Persistencia en la skill | Variable de entorno o fichero secreto local del backend, p.ej. `.env` |
| Renovación | Manual cada ~40 días. Aviso por log/email cuando se reciba `401 token_not_valid`. |
| `customer_uuid` | Capturar a la vez (es estático para la cuenta, no caduca) |
| Fallback | Si la skill recibe 401, contestar al usuario "Necesito que renueves el token de Mercadona" y dejar un log claro |

---

## 6. Mapeo voz → producto habitual

Cómo plantear el matching cuando el usuario diga, por ejemplo, "Añade tres kéfir":

1. Cachear el JSON de `GET /myregulars/precision/` durante una ventana razonable (1 h es suficiente: la lista cambia poco y la respuesta es ~160 KB → demasiado para pedirla en cada invocación).
2. Sobre cada producto del cache, normalizar el campo `product.display_name` y opcionalmente el `slug`:
   - Pasar a minúsculas.
   - Quitar acentos (`NFD` + filtrar marcas combinantes).
   - Eliminar palabras-marca y descriptores comunes ("hacendado", "deliplus", "bosque verde", "ultracongelado", "natural", "pack", "paquete", "bote"…) — siempre y cuando el usuario no las haya dicho explícitamente.
3. Matching:
   - **Exacto normalizado** primero.
   - **Substring** del término del usuario en el `display_name` normalizado.
   - **Fuzzy** (Levenshtein o token-set ratio) como último recurso. Umbral conservador (≥ 80) para evitar añadir un producto erróneo.
4. Si hay 0 coincidencias → responder "No encuentro X en tus habituales" y, opcionalmente en fase 2, buscar en el catálogo general.
5. Si hay >1 coincidencia → responder "Tienes varios X: A, B, C. ¿Cuál quieres?". Cortar a las 3 mejores.
6. Cantidad: extraer slot de Alexa (`quantity`). Por defecto 1. Respetar `min_bunch_amount` e `increment_bunch_amount` del `price_instructions` cuando sean ≠ 1.

Listas de stop-words concretas y umbrales fuzzy se afinarán empíricamente con la lista real del usuario.

---

## 7. Gotchas y limitaciones conocidas

- **Vida del token: 42 días sin refresh.** El usuario tendrá que renovarlo a mano periódicamente. Mitigar con un aviso cuando falten N días o cuando llegue el primer 401.
- **No hay concurrencia optimista en el PUT del carrito.** Si el usuario usa simultáneamente el móvil de Mercadona y la skill de Alexa, una de las dos peticiones puede pisar a la otra sin error visible. Para uso personal habitual no es crítico.
- **`precision` y `recall` devolvieron lo mismo** en esta cuenta — no se garantiza que sea así para otras cuentas o para esta cuenta a largo plazo. Tratar `recall` como fallback informativo.
- **`sources` es un log, no un tag.** Si se quiere replicar fielmente la forma en que la UI registra interacciones, hay que ir acumulando "+MR"/"-MR" en orden. Para una skill personal basta con `"+MR"` por cada unidad nueva.
- **Akamai bot manager** (`_abck`, `bm_sz`) está presente en cookies. No bloquea llamadas API con Bearer válido desde un navegador real, pero podría comportarse distinto desde IPs de cloud (AWS, Azure) o desde IPs marcadas. Si el backend de la skill se aloja en cloud y empiezan a salir errores raros (403, body con HTML, retos JS), revisar primero esto.
- **Latencia desde Madrid: 90–180 ms.** Desde Lambda US-East-1 se añadirán ~150 ms por salto transatlántico, pero seguiremos muy por debajo del límite de 8 s de Alexa. Si el backend está en `eu-west-1` o `eu-west-3`, latencia comparable a la observada.
- **Tamaño del payload de Mis Habituales**: 160 KB. Cachearlo y no traerlo en cada invocación de Alexa.
- **`current_postal_code` está fijado en la cuenta**. Si el usuario tiene un CP sin servicio, los endpoints de carrito devolverán error o `wh` distinto. Para esta cuenta `wh=mad1`.
- **No se sabe el comportamiento ante productos sin stock.** Hay que probar empíricamente qué pasa al PUT con un `product_id` no disponible (probable que devuelva el cart con la línea marcada como `unavailable_from` y/o que la rechace).

---

## 8. Próximos pasos

Fuera del alcance de este documento, pero quedan apuntados:

1. Decidir el stack del backend de la skill (Node.js+Lambda, Python+Lambda, VPS propio).
2. Diseñar el interaction model: `invocationName`, intents (`AddToCartIntent` con slots `productName` y `quantity`, `EmptyCartIntent`, `ListCartIntent` opcional), prompts de desambiguación.
3. Implementar:
   - Cliente HTTP de Mercadona (4 funciones: `getCustomer`, `getMyRegulars`, `getCart`, `putCart`).
   - Cache en memoria del listado de Mis Habituales con TTL.
   - Matcher voz → producto (§6).
   - Handlers Alexa.
4. Probar end-to-end en local con `ask` CLI antes de desplegar.
5. Establecer un proceso de renovación del token (recordatorio en calendario / chequeo automático con aviso por email).
6. Plantear fase 2: búsqueda fuera de Mis Habituales contra `api.mercadona.es`, intents adicionales, e incluso login programático si se considera asumible el riesgo.

---

## Apéndice A — ejemplo end-to-end con curl

Suponiendo que `MERCADONA_BEARER` y `MERCADONA_CUSTOMER_UUID` están exportados:

```bash
# 1) Validar token y obtener cart_id
curl -s "https://tienda.mercadona.es/api/customers/$MERCADONA_CUSTOMER_UUID/" \
  -H "Authorization: Bearer $MERCADONA_BEARER" | jq '{name, cart_id, current_postal_code}'

# 2) Listar Mis Habituales (solo nombre + id)
curl -s "https://tienda.mercadona.es/api/customers/$MERCADONA_CUSTOMER_UUID/recommendations/myregulars/precision/" \
  -H "Authorization: Bearer $MERCADONA_BEARER" \
  | jq '.results[] | {id: .product.id, name: .product.display_name}' | head -40

# 3) Leer carrito
curl -s "https://tienda.mercadona.es/api/customers/$MERCADONA_CUSTOMER_UUID/cart/" \
  -H "Authorization: Bearer $MERCADONA_BEARER" \
  | jq '{id, version, products_count, total: .summary.total, lines: [.lines[] | {id: .product.id, name: .product.display_name, qty: .quantity}]}'

# 4) Añadir 1 unidad del producto 21307 (Bífidus) al carrito.
#    Hay que LEER el carrito antes, modificarlo y reenviarlo entero.
#    Ejemplo asumiendo un carrito con una sola línea previa (queso emmental 23561):
curl -s -X PUT "https://tienda.mercadona.es/api/customers/$MERCADONA_CUSTOMER_UUID/cart/" \
  -H "Authorization: Bearer $MERCADONA_BEARER" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "<cart_id>",
    "version": 25,
    "lines": [
      {"quantity": 1, "product_id": "21307", "sources": ["+MR"]},
      {"quantity": 1, "version": 22, "product_id": "23561", "sources": ["+MR"]}
    ]
  }' | jq '{version, products_count, total: .summary.total}'
```
