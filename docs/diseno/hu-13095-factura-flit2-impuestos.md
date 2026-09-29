# Diseño slim — HU #13095 [BACKEND] Factura de FLIT 2 para impuestos

Épica 12736 · Feature 13059 · Base: `develop` 5c0833f5 · Contrato: `docs/integraciones/flit2-api.md` §3
(`GET /api/v1/external/tramites/{id}/adjuntos/{adjuntoId}/url`). El endpoint de FLIT (#13077) **aún no
existe**: se construye contra el puerto y se prueba con el fake y con `fetch` simulado.

Habla con: módulos FLITO `flito-sync` (FLIT 2) y `flito-impuestos`. No toca legacy.

## Patrón reutilizado

| Pieza | Vecino que se copia |
|---|---|
| Descarga con tope y desenlaces | `apps/api/src/modules/flito-impuestos/flito-impuestos.extraccion.ts` → `descargarFacturaDeImpuesto` (FLIT 1: `TOPE_FACTURA_BYTES` 15 MB, `TIMEOUT_DESCARGA_MS` 30 s, `FacturaNoDisponibleError` + `noDisponible`) |
| Llamada autenticada a FLIT 2 | `apps/api/src/modules/flito-sync/flit2-sync-http.adapter.ts` → `leerPagina` (`conPase`, `redirect: 'error'`, `codigoDeProblema`, `segundosRetryAfter`, `Flit2RespuestaError` / `Flit2NoRespondeError`) |
| Puerto + fake | `flit2-sync.port.ts` / `flit2-sync-fake.adapter.ts` / selector `flit2-sync.adapter.ts` (`getFlit2SyncAdapter`) |
| Guardar el campo | `flit2-lectura.service.ts` (`aplicarItem`, objeto `valores`, línea ~299) → `escribirTramite` de FLIT 1 (registra el cambio en el historial con `registrarDiferencias`) |

Ya hecho por la #13091 (no se toca): `aItemFlit2` ya parsea `factura.adjuntoId` a `ItemFlit2.facturaAdjuntoId`.

## Decisiones

### D1 — Dónde se guarda `adjuntoId` (AC1)

En `flit2-lectura.service.ts`, `valores.facturaVentaFlitId` (hoy `porId?.facturaVentaFlitId ?? null`, con el
comentario «#13095 la factura… se conservan») pasa a:

```
facturaVentaFlitId: acotado(it.facturaAdjuntoId, 120)   // mismo helper que ya usa para ciudad/NIT
```

No va en `flit2-mapeo.ts`: allí solo hay mapeos puros de estado/familia/compradores; el `adjuntoId` ya viene
normalizado (`s()`) del adaptador. Más largo que 120 (la columna) → null + `log.warn({ idFlit2, campo:
'facturaAdjuntoId', longitud })`, como los demás `acotado`. Sin migración.

### D2 — `factura: null` en una actualización: se **refleja** (se borra la referencia), no se conserva

**Confirmado por FLIT el 2026-09-29:** `factura: null` siempre significa que en ese momento no hay factura
confirmada (el feed solo lee transacciones cerradas y un reemplazo es atómico). El `adjuntoId` cambia en
cada reemplazo: no es identidad estable; se guarda el que llegue y la descarga usa el guardado al pedirla.

Justificación:
1. El ítem del feed es el **estado completo** del trámite (contrato §3: upsert por `id`, descarte por
   `syncVersion`), no un delta: `factura: null` significa «hoy no tiene factura».
2. **Paridad con FLIT 1**: `flit-http.adapter.ts:91` escribe `s(it.factura)` en cada sync, también null.
3. Conservar una referencia que FLIT 2 ya no publica haría que impuestos muestre `tieneFacturaVenta = true`
   (`flito-impuestos.service.ts:524`, `flito-tramites.service.ts:427`) para algo que en la descarga daría 404.
4. La pérdida no es silenciosa: `escribirTramite` registra `factura_venta_flit_id` viejo → null en el
   historial (`registrarDiferencias`, origen `api`).

Los tombstones no llegan aquí (RN-05 de la lectura: se ignoran), así que un `eliminado: true` con
`factura: null` no borra nada. El modo enmascarado (#13094) no afecta: la factura no es PII.

### D3 — AC4 (asignado sin factura → impuesto «sin factura») no requiere código nuevo

`arrancarSoatEImpuesto` recibe `TramiteArranque = Pick<TramiteFlit, 'vin' | 'idFlit' | 'valorImpuestoLiquidado'>`:
el arranque **no depende** de la factura en ninguna de las dos fuentes, y la condición «sin factura» del
impuesto se deriva de `flito_tramites.factura_venta_flit_id IS NULL` al leer (`flito-impuestos.service.ts`
~524/~610/~654). Al guardar el campo con D1/D2, FLIT 2 hereda el comportamiento de FLIT 1. Se cubre con test
(ver P1). **backend-agent:** confirmar en ≤1 lectura esas tres líneas; si aparece un estado `sin_factura`
asignado por fuente, parar y reportar (no inventar).

> Nota: el comentario de `resolverImpuesto` (`flito-sync.service.ts` ~460) dice «sin factura, en
> 'sin_factura'», pero el insert usa `EstadoImpuesto.PENDIENTE` siempre. Deuda de comentario preexistente
> (P4 Nota), fuera de esta HU.

### D4 — Método nuevo del puerto

`flit2-sync.port.ts`:

```ts
/** HU #13095. Respuesta de `GET …/tramites/{id}/adjuntos/{adjuntoId}/url`. `url` NUNCA va a un log. */
export interface UrlAdjuntoFlit2 {
  url: string;               // firmada, 10 min, un solo uso inmediato
  contentType: string | null; // informativo: el tipo real se saca de los bytes (tipoPorBytes), como FLIT 1
  nombreArchivo: string | null;
  expiraEn: string | null;    // informativo (contrato): no se usa para decidir
}
// en Flit2SyncPort:
/** null = 404 (trámite o adjunto inexistente, o no es de ese trámite). CUALQUIER 404, sin mirar `code`. */
obtenerUrlAdjunto(idFlit2: string, adjuntoId: string): Promise<UrlAdjuntoFlit2 | null>;
```

**Adaptador HTTP** (`flit2-sync-http.adapter.ts`), mismo esqueleto que `leerPagina`:
- Ruta `RUTA_ADJUNTO = (id, adj) => /api/v1/external/tramites/${encodeURIComponent(id)}/adjuntos/${encodeURIComponent(adj)}/url`
  sobre `base()` (sin `FLIT2_BASE_URL` → `Flit2NoConfiguradoError`).
- `adjuntoId` vacío, `.` o `..` → `return null` **sin** llamar (`encodeURIComponent` no escapa el punto y
  `new URL` normalizaría `..`: evita recorrer rutas del host de FLIT 2).
- `conPase(pase => fetch(url, { headers: { Authorization: pase.authorization.unwrap(), Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) }))`.
- Excepción que no es `Flit2Error` → log solo `e.name` → `Flit2NoRespondeError`. `Flit2Error` del pase se propaga.
- `404` → `log.warn({ idFlit2, status: 404, codigo })` y `return null`. **No** se ramifica por `code`.
- Otro ≠ 200 → `codigoDeProblema`; si 429, `segundosRetryAfter(retry-after)`; `throw new Flit2RespuestaError(status, codigo, reintentarEnS)`.
- 200 → Zod `{ url: z.string().url().max(4096), expiraEn: texto, nombreArchivo: texto, contentType: texto }.passthrough()`;
  cuerpo no JSON o fuera de contrato → `Flit2RespuestaError(200, null)`.
- **Nunca** loguear la URL pedida (lleva ids), el cuerpo ni `url`.

**Fake** (`flit2-sync-fake.adapter.ts`): `Flit2SyncFake` gana
`adjuntos: Map<string, UrlAdjuntoFlit2>` (clave `${idFlit2}/${adjuntoId}`) y `llamadasAdjunto: { idFlit2, adjuntoId }[]`.
Clave ausente → `null` (404). Default: mapa **vacío** → en demo toda factura FLIT 2 queda «no disponible»
sin salir a la red. No cambiar `paginasPorDefecto()` (evita churn en tests existentes).

### D5 — Rama por fuente en la extracción (AC2, AC3, AC5)

`descargarFacturaDeImpuesto`: el `select` añade `fuente: flitoTramites.fuente, idFlit2: flitoTramites.idFlit2`.
Tras el `sin_factura` existente:

```
if (fila.fuente === 'flit2') return descargarFacturaFlit2(impuestoId, fila.idFlit2!, fila.facturaId);
// … líneas de FLIT 1 SIN TOCAR (AC5)
```

`descargarFacturaFlit2` (mismo archivo; +~70 líneas, queda lejos de 800):

```
for intento in 1..2:
  adj = await getFlit2SyncAdapter().obtenerUrlAdjunto(idFlit2, adjuntoId)   // errores → ver D6
  if (!adj) noDisponible('url_nula')                     // 404 = mismo motivo/desenlace que FLIT 1 (AC3)
  if (!urlFirmadaPermitida(adj.url, env.FLIT2_ADJUNTOS_HOSTS)) noDisponible('host')   // sin reintento
  resp = await fetch(adj.url, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_DESCARGA_MS) }).catch(() => null)
  // SIN cabecera Authorization: el almacenamiento es otro host; el pase de FLIT 2 no sale de su API
  if (!resp || !resp.ok) { if (intento === 1) continue; noDisponible(resp ? `http_${resp.status}` : 'descarga') }
  if (content-length > TOPE_FACTURA_BYTES) noDisponible('tope')                      // sin reintento
  bytes = leer resp.body por stream acumulando; si supera TOPE → reader.cancel() + noDisponible('tope')
  return { bytes, contentType: tipoPorBytes(bytes).contentType }
```

- **Tope**: el mismo `TOPE_FACTURA_BYTES` (15 MB). FLIT 2 admite hasta 20 MB (o más): llega como `tope`,
  igual que FLIT 1 ante exceso, y el lector por stream corta al pasar el tope, sin cargar 20 MB+ en memoria
  cuando no viene `content-length`. FLIT 1 no se toca (sigue con `arrayBuffer`).
- **«Antes de que expire»**: la URL se usa en el acto, nunca se guarda ni se cachea; entre pedirla y
  descargarla no hay espera. Si la descarga falla (red, timeout, 403 de URL vencida, 5xx), se pide **otra**
  URL **una** vez (2 peticiones máx. al endpoint por paso, frente a 120/min). `tope` y `host` no reintentan.
- `MotivoFacturaNoDisponible` gana `'host'` y `'flit2_acceso'`. Todos los desenlaces siguen siendo el de
  FLIT 1: el paso **lanza** → la cola deja `error_analisis`, sin escribir nada.

### D6 — Errores del endpoint de la URL (401, 429, 5xx)

| Situación | Lo hace | Motivo en la extracción | Reintento en el paso |
|---|---|---|---|
| 401 | `conPase` invalida y renueva el pase **una** vez (RN-04); si repite 401 → `Flit2RespuestaError(401)` | `http_401` | no |
| Pase inutilizable (sin acceso, rechazado, 403 cambio de clave, 423/429 del token, no configurado) | lo lanza el pase (`Flit2Error`) | `flit2_acceso` | no |
| 429 del endpoint | `Flit2RespuestaError(429, codigo, reintentarEnS)` | `http_429` (se loguea `reintentarEnS`) | **no**: nada de `sleep` dentro del job; lo reprograma la cola. No se registra pausa global del feed |
| 5xx / cuerpo fuera de contrato | `Flit2RespuestaError(status)` | `http_${status}` | no |
| Timeout / red | `Flit2NoRespondeError` | `descarga` | no |
| 404 (cualquier `code`, o sin cuerpo) | `null` | `url_nula` | no |

Traducción en `descargarFacturaFlit2`: `catch (e) { if (e instanceof Flit2RespuestaError) noDisponible(`http_${e.status}`); if (e instanceof Flit2NoRespondeError) noDisponible('descarga'); if (e instanceof Flit2Error) noDisponible('flit2_acceso'); throw e; }`
(el nombre exacto del campo de estado de `Flit2RespuestaError` lo confirma backend-agent en `flit2.errors.ts:136`).

### D7 — Validación del host de la URL firmada (SSRF)

Variable nueva **`FLIT2_ADJUNTOS_HOSTS`**: lista separada por comas de hosts exactos del almacenamiento de
FLIT 2 (endpoint S3 del bucket de file-manager), por ambiente.
- `config/env.ts`: `z.preprocess(vacioComoAusente, z.string().optional())` → `transform` a `string[]` en
  minúscula, sin vacíos. **Nunca** un host en el repo (es público).
- `apps/api/.env.example`: `FLIT2_ADJUNTOS_HOSTS=` **sin valor**, con comentario: «hosts (sin esquema) del
  almacenamiento de adjuntos de FLIT 2, separados por coma; vacío = ninguna factura de FLIT 2 se descarga».
- **Vacía o ausente → fail-closed**: toda URL se rechaza (`host`). No bloquea el arranque de la API (con el
  fake no hace falta); no hay default permisivo.

`export function urlFirmadaPermitida(url: string, hosts: readonly string[]): boolean` (pura, en extraccion):
`new URL(url)` sin lanzar; `protocol === 'https:'`; `username`/`password` vacíos; `url.host.toLowerCase()`
(hostname + puerto si no es 443) **igual** a una entrada. Sin comodines ni sufijos, sin resolver DNS.
`redirect: 'error'` en el `fetch` impide que el host permitido redirija a otro.

Rechazo → `noDisponible('host')`: el warn existente (`{ impuestoId, motivo: 'host' }`) es el aviso; **sin**
URL, sin hostname, sin reintento.

### D8 — Nada de la URL a los logs

- `url` firmada, `expiraEn`, `nombreArchivo`, la ruta pedida al API de FLIT 2 y cualquier `e.message` de
  `fetch` (puede arrastrar la URL): **nunca** a `log.*`, a `FacturaNoDisponibleError.message` ni a
  `pii_access_log`. Solo `impuestoId`, `idFlit2`, `status`, `codigo`, `motivo`, `reintentarEnS`, `e.name`.
- El nombre de archivo al OCR sigue siendo el genérico `'factura-venta'` (ya lo hace `extraerDeFactura`).

## Contrato delta

```
flito_tramites.factura_venta_flit_id (varchar 120, existente): FLIT 2 guarda factura.adjuntoId; null lo refleja
Flit2SyncPort.obtenerUrlAdjunto(idFlit2, adjuntoId) → UrlAdjuntoFlit2 | null(404)       [nuevo]
  → FLIT 2: GET /api/v1/external/tramites/{id}/adjuntos/{adjuntoId}/url (conPase)
MotivoFacturaNoDisponible += 'host' | 'flit2_acceso'
env FLIT2_ADJUNTOS_HOSTS (lista, vacía = fail-closed)                                  [nuevo]
Sin endpoints FLITO nuevos, sin shared-types, sin migración.
```

## Archivos a crear/modificar

| Archivo | Cambio |
|---|---|
| `apps/api/src/modules/flito-sync/flit2-sync.port.ts` | `UrlAdjuntoFlit2` + `obtenerUrlAdjunto` |
| `apps/api/src/modules/flito-sync/flit2-sync-http.adapter.ts` | implementación (D4) |
| `apps/api/src/modules/flito-sync/flit2-sync-fake.adapter.ts` | `adjuntos` + `llamadasAdjunto` (D4) |
| `apps/api/src/modules/flito-sync/flit2-lectura.service.ts` | `valores.facturaVentaFlitId = acotado(it.facturaAdjuntoId, 120)` + comentario (D1/D2); RN nueva en cabecera |
| `apps/api/src/modules/flito-impuestos/flito-impuestos.extraccion.ts` | select + rama `flit2`, `descargarFacturaFlit2`, `urlFirmadaPermitida`, motivos (D5-D8); cabecera: línea HU #13095 |
| `apps/api/src/config/env.ts` | `FLIT2_ADJUNTOS_HOSTS` (D7) |
| `apps/api/.env.example` | `FLIT2_ADJUNTOS_HOSTS=` vacío + comentario |

Sin cambios: `flit2-mapeo.ts`, `schema.ts`, migraciones, `packages/shared-types`, `apps/web`, FLIT 1 (`flit-http.adapter.ts`, `flito-sync.service.ts`).

## Tests (P1 — solo estos archivos)

```
npm test -w apps/api -- __tests__/services/flito-sync.flit2-sync-http.test.ts \
  __tests__/services/flito-sync.flit2-lectura.test.ts __tests__/services/flito-impuestos.extraccion.test.ts
```

- **flit2-sync-http** (mod): 200 → `UrlAdjuntoFlit2`; 404 con `attachment_not_found`, con otro `code` y sin
  cuerpo → `null`; 401 → renueva el pase una vez; 429 con `Retry-After` → `Flit2RespuestaError(429, …, s)`;
  500 → `Flit2RespuestaError(500)`; timeout → `Flit2NoRespondeError`; ids escapados en la ruta; `adjuntoId`
  `..` → `null` sin `fetch`; 200 con `url` no-URL → `Flit2RespuestaError(200)`; el logger espía no contiene la `url` firmada.
- **flit2-lectura** (mod): AC1 alta con `factura.adjuntoId` → columna guardada; D2 actualización con
  `factura: null` → columna null y diferencia registrada; `adjuntoId` de 121 → null; AC4 asignado sin
  factura → arranca el impuesto y queda sin factura (mismo resultado que FLIT 1).
- **flito-impuestos.extraccion** (mod): fuente `flit2` feliz (bytes + `tipoPorBytes`); 404 → `url_nula`
  (AC3); host fuera de lista / `http:` / lista vacía / con credenciales → `host` **sin** `fetch` al
  almacenamiento y **sin** segunda URL; `content-length` > tope → `tope`; sin `content-length` y cuerpo > tope
  → `tope` (stream cortado); 1.ª descarga falla y la 2.ª URL funciona → OK con 2 llamadas a
  `obtenerUrlAdjunto`; dos fallos → `http_xxx`/`descarga`; 429 → `http_429` con 1 sola llamada; `fetch` al
  almacenamiento con `redirect: 'error'` y sin `Authorization`; **AC5**: fuente `flit` sigue llamando a
  `getFlitAdapter().obtenerUrlFactura` y nunca a `obtenerUrlAdjunto`; ningún log/mensaje de error contiene la URL.
  Tests puros de `urlFirmadaPermitida`.
  Ojo (memoria del repo): el mock `chain` devuelve la fila entera aunque el `select` pida menos — dar
  `fuente`/`idFlit2` explícitos en la fila del mock y no fiarse de que el `select` los pidió.

## ADR: no aplica

Extiende el patrón del adaptador FLIT 2 y la descarga de FLIT 1. La allowlist por env no sienta un
precedente de arquitectura (es una mitigación local del SSRF, D7).

## Notas operativas

- **backend-agent**: presupuesto P8 (8). Leer solo los archivos de la tabla y `flit2.errors.ts`. No refactorizar
  FLIT 1. Declarar `security-agent`: **aplica** (salida a un host externo tomado de una respuesta, SSRF,
  env nuevo). `db-review-agent`: no aplica (sin esquema).
- **devops / deploy**: poner `FLIT2_ADJUNTOS_HOSTS` en DEV/QA/PDN con el host que dé la sesión de FLIT;
  sin él, las facturas de FLIT 2 caen en `error_analisis` (motivo `host`) — fail-closed buscado, no un fallo.
- **frontend-agent**: nada.
