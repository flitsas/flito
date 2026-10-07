# Diseño slim — HU #13364 Cargar y eliminar documentos adicionales de una solicitud de SOAT

Épica #13201 · Feature #13361 · módulo FLITO **`flito-soat`** (`/api/flito/soat`), **no** el legacy `soat`.
Estado: **Propuesto** (diseño slim; ADR no aplica — ver al final).
Base: `docs/arquitectura/hu-13362-documentos-adicionales-soat.md` (HU #13362, en develop `d57d8428`). Este documento
solo describe el **delta**; todo lo que no se nombra aquí (motor a disco, clasificación D2, exclusión de listas/ZIP,
modelado en `flito_soportes`) sigue igual.

## Patrón reutilizado

| Pieza | De dónde sale (ya en develop) |
|---|---|
| Motor multer a disco + sha256 al vuelo + 413 del techo técnico | `apps/api/src/modules/flito-soat/flito-soat-documentos.upload.ts` (`motor`, `uploadAlta`, `limpiarTemporales`) |
| Clasificación por bytes / 15 MB / 20 / 250 MB / repetido | `flito-soat-documentos.service.ts` → `clasificarAdicionales` |
| Subida fuera de tx + compensación | `subirAdicionales` / `compensarAdicionales` (mismo archivo) |
| Inserción en `flito_soportes` | `insertarAdicionales(tx, subidos, { soatId }, autor)` |
| Frontera 404-no-403 | `buscarConAcceso(id, ctx)` (vía `listarDocumentosAdicionales`, mismo patrón) |
| Router, `exigirFuncion`, `contextoSoat` | `flito-soat-documentos.routes.ts` (GET de la #13362) |
| Bitácora | `detalleBitacoraAdicional` + `audit()` |
| Limitador | `soatClienteLimiter` en `apps/api/src/shared/middleware/rateLimiter.ts` (`userOrIpKey`, `frenoConRastro`, `makeStore`) |
| Siembra de función | `0222_flito_soportes_documentos_adicionales_soat.sql` (bloques 3-5) |

Sin dependencia nueva.

## Decisiones

### D1. Rutas y montaje

Ambas en **`flito-soat-documentos.routes.ts`** (ya montado en `app.ts` l. 269 antes de `flitoSoatRoutes`; **no** se toca `app.ts`).
Cadena, en este orden:

```
POST   /:id/documentos-adicionales
  authMiddleware (router.use) → exigirFuncion('soat.documentos_adicionales.cargar')   [AC3: 403 antes de leer bytes]
  → soatDocumentosAdicionalesLimiter                                                [AC10: 429 antes de leer bytes]
  → uploadAdicionales (multer, motor de disco)                                      [solo campo documentosAdicionales]
  → handler: uuid inválido → 404; ctx; cargarDocumentosAdicionales(id, ctx, …); finally limpiarTemporales
DELETE /:id/documentos-adicionales/:soporteId
  authMiddleware → exigirFuncion('soat.documentos_adicionales.eliminar')            [AC7: 403]
  → handler: ambos uuid (Zod) o 404; eliminarDocumentoAdicional(id, soporteId, ctx) → 204
```

- **Limitador antes de multer** y **función antes del limitador**: quien no tiene la función no gasta presupuesto; quien excede
  el límite no escribe nada a disco.
- El chequeo de acceso (`buscarConAcceso`) va **después** de multer, dentro del servicio. Hacerlo antes ahorraría escribir
  temporales de una petición que acabará en 404, pero responder sin consumir el cuerpo multipart produce `EPIPE/ECONNRESET`
  en clientes y en supertest (`attach`) → tests inestables. El coste lo acota el limitador y la función. Temporales: `finally`.
- **No** se inscriben en `shared/middleware/canal-cliente.ts`, igual que el GET de la #13362: el cliente no tiene
  las funciones y la guardia del canal ya le cierra la ruta.
- Sin chequeo de estado de la solicitud (AC1/AC5: cualquier estado, incluido pagado).

### D2. Multer: misma pieza, una fábrica

En `flito-soat-documentos.upload.ts`, extraer la construcción en `crearUpload(campos)` y exportar dos instancias:
`uploadAlta` (sin cambios de comportamiento: factura + adicionales) y **`uploadAdicionales`** (solo
`{ name: CAMPO_ADICIONALES, maxCount: 100 }`, `limits.files = 100`). El mismo `motor`, el mismo 413 de
`esExcesoDeArchivos` (`MENSAJE_DEMASIADOS_ARCHIVOS`). En `uploadAdicionales`, un archivo en cualquier otro campo
(`LIMIT_UNEXPECTED_FILE` con `field ≠ documentosAdicionales`) → **400** «Campo de archivo no permitido» (no 500).
Helper `archivosDeCarga(req) → { adicionales, etiquetas }` junto a `archivosDelAlta`.
Envío sin ningún archivo → **400** «Adjunta al menos un documento» (no se crea nada).

### D3. Cupos por envío y repetido contra lo guardado (AC2)

- **Por envío**, como dice el AC: 20 aceptados y 250 MB se cuentan sobre los archivos de *esta* petición, no sobre el
  acumulado de la solicitud. Riesgo declarado: no hay techo de acumulado por solicitud (N envíos × 250 MB). Lo acotan la
  función configurable y el limitador (D5). Si negocio quiere techo acumulado es un WI aparte (ver «Pendiente humano»).
- **Repetido**: `clasificarAdicionales` generaliza su tercer parámetro de `hashFactura: string | null` a
  `hashesPrevios: string | readonly string[] | null` (el alta sigue pasando el string; no se toca `flito-soat-cliente.routes.ts`).
  La carga le pasa los `hash` de `flito_soportes` con `soat_id = :id AND tipo = 'documento_adicional_soat' AND descartado = false`
  (consulta nueva `hashesAdicionalesGuardados(soatId)`; la cubre `idx_flito_soportes_soat_tipo`).
- **Factura de venta**: **se incluye** (decisión de David, 2026-10-07, igual que en el alta): la consulta de huellas previas
  usa `inArray(tipo, [DOCUMENTO_ADICIONAL_SOAT, FACTURA_VENTA])` (`hashesPreviosDeSolicitud`).
- Orden de reglas y textos: los de D2 de la #13362, sin cambios. `documento_repetido` cubre ambos casos (mismo envío y ya guardado).

### D4. Concurrencia — índice único parcial + `ON CONFLICT DO NOTHING`

Dos cargas simultáneas del mismo archivo pasan ambas el chequeo de D3. Se cierra en BD:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_soportes_adicional_soat_hash
  ON flito_soportes (soat_id, hash)
  WHERE tipo = 'documento_adicional_soat' AND descartado = false AND soat_id IS NOT NULL;
```

- No choca con el alta aparcada (`soat_id NULL` queda fuera del predicado) ni con `vincularAdicionalesAlSoat`
  (la solicitud nace en ese UPDATE: no puede tener adicionales previos, y el envío ya viene sin repetidos).
- Inserción de la carga: variante `insertarAdicionalesDeCarga(tx, subidos, soatId, autor)` con
  `.onConflictDoNothing({ target: [flitoSoportes.soatId, flitoSoportes.hash], where: <predicado del índice> })`
  (drizzle-orm 0.45: comprobar si la opción es `where` o `targetWhere`; debe coincidir con el predicado del índice o
  Postgres responde 42P10). Los que no vuelven en `returning` → `descartados` con `documento_repetido` **y** su objeto
  se borra de storage (`compensarAdicionales` de esos). No se aborta la transacción: los demás se guardan.
- Se descarta la alternativa «chequeo dentro de la tx»: sin `SERIALIZABLE` o lock de la fila de `flito_soat` no cierra la carrera.
- Antes de crear el índice, la migración **verifica** que no haya duplicados (la #13362 deduplica por envío, así que no
  debería haber; si los hubiera, `RAISE EXCEPTION` con el conteo en vez de un error críptico del índice).

### D5. Limitador

`soatDocumentosAdicionalesLimiter` en `shared/middleware/rateLimiter.ts`, calcado de `soatClienteLimiter`:
`windowMs: 15 min`, `max: 30`, `keyGenerator: userOrIpKey('soat-doc-adic:')` (usuario + IP, válido tras los dos proxies
con `trust proxy`), `handler: frenoConRastro('soat-doc-adic')`, `store: makeStore('rl:soat-doc-adic:')`,
`message: { error: 'Demasiadas cargas de documentos adicionales. Espera unos minutos e intenta de nuevo.' }`.
Solo en el POST (AC10 habla de la carga). Presupuesto **propio**, no compartido con el canal Cliente (otro público y otra ruta).

### D6. Orden del borrado (AC5/AC8) — BD primero, storage después

```
eliminarDocumentoAdicional(id, soporteId, ctx):
  1 buscarConAcceso(id, ctx) → null ⇒ 404                                         [AC4]
  2 db.delete(flitoSoportes).where(id = soporteId AND soat_id = soat.id
       AND tipo = 'documento_adicional_soat' AND descartado = false)
     .returning({ storageKey, etiqueta, nombreArchivo })  → 0 filas ⇒ 404       [AC8: factura u otra solicitud]
  3 (tras el DELETE, ya confirmado) borrarObjetoConReintento(storageKey)          [AC5: borrado físico]
  4 ruta: audit 'delete' → 204
```

Por qué este orden:
- **Storage primero** dejaría, si el DELETE falla, una fila visible apuntando a un objeto inexistente (enlace roto en la UI,
  AC5 incumplido de cara a la persona).
- **BD primero**: si storage falla, queda un objeto **inalcanzable** desde la app (sin fila no se lista, no se firma URL, no
  se descarga), clave opaca sin PII en el nombre. Es el mal menor y es recuperable.

Tratamiento del fallo de storage:
- `deleteEntityDocument` **traga** el error (`log.warn`) y no avisa a quien llama. Se añade en `apps/api/src/services/storage.ts`
  `removeEntityDocument(key)` que **lanza**, y `deleteEntityDocument` pasa a delegar en ella con su `catch` (comportamiento intacto
  para los demás usos).
- `borrarObjetoConReintento` (en el servicio de documentos): 3 intentos con espera corta (p. ej. 0 / 200 / 800 ms). `removeObject`
  de MinIO es idempotente sobre una clave ya inexistente. Si los 3 fallan: `logger.error({ evento: 'soat.adicional.objeto_huerfano',
  soporteId, storageKey }, …)` — la clave es opaca, sin nombre ni PII — y la respuesta **sigue siendo 204** (el documento ya
  no existe para el producto). La Bitácora lo deja dicho (`…, objeto pendiente de borrar`), para que la recuperación manual
  tenga rastro sin depender del log.
- No se crea tabla de pendientes ni cron (sería contrato nuevo y no lo pide el AC). Si negocio quiere garantía dura de borrado
  físico (Ley 1581, supresión), es un WI aparte — ver «Pendiente humano».

Notas:
- El borrado **no** va dentro de una `db.transaction` con storage: una tx abierta durante una llamada de red a MinIO retiene el lock sin ganar nada.
- Las filas de una solicitud por validar (`soat_id NULL`) no son alcanzables por esta ruta → 404. Correcto: la HU habla de la solicitud.
- AC6 (cualquiera con el permiso): el `where` **no** filtra por `subido_por_id`.

### D7. Bitácora (AC9)

`detalleBitacoraAdicional(g, accion: 'cargado' | 'eliminado' = 'cargado')`: mismo formato, el verbo cambia.
- Carga: `audit(req, { action: 'create', resource: 'flito_soat', resourceId: soatId, detail })` por cada guardado, tras el COMMIT.
- Borrado: `action: 'delete'`, mismo recurso. La fila no persiste `etiquetaDeNombre`: se reconstruye como
  `etiqueta === nombreArchivo.slice(0, 150)` → se usa el nombre truncado a 40; si no, la etiqueta. (Si la persona tecleó
  exactamente el nombre del archivo, el detalle sale truncado: inocuo.)
- Usuario y fecha/hora los pone `audit()`. Nunca contenido ni nombre completo.

## Contrato delta

**`POST /api/flito/soat/:id/documentos-adicionales`** — multipart: `documentosAdicionales` (1..100 archivos),
`etiquetasDocumentosAdicionales` (0..n textos, alineados por índice).
- **201** `ResultadoDocumentosAdicionales` (shared-types, la misma forma del alta): `{ aceptados[], descartados[] }`.
  Si todos se descartan → **201** con `aceptados: []` (el envío se procesó; los motivos van en `descartados`).
- 400 sin archivos / campo no permitido · 403 sin `soat.documentos_adicionales.cargar` · 404 sin acceso o `:id` no uuid ·
  413 >100 archivos (`MENSAJE_DEMASIADOS_ARCHIVOS`) · 429 limitador. En todos: nada en BD ni en storage.
- Error de subida o de la transacción → compensación de lo subido y error (500/503 como hoy); nada queda.

**`DELETE /api/flito/soat/:id/documentos-adicionales/:soporteId`**
- **204** sin cuerpo · 403 sin `soat.documentos_adicionales.eliminar` · 404 sin acceso / no es adicional / otra solicitud / uuid inválido.

**shared-types:** sin tipos nuevos (`ResultadoDocumentosAdicionales` ya existe). Regla 7: no se cambia ningún tipo → sin grep obligatorio.

## Migración

`apps/api/src/db/migrations/0223_flito_soportes_documentos_adicionales_carga_eliminar.sql`
(verificado: `git ls-tree origin/develop` tras `git fetch` el 2026-10-07 → última `0222_…`; volver a mirar antes del PR).
Sin BEGIN/COMMIT, idempotente, calcada de `0222`:
1. Guarda de duplicados: `DO $dup0223$` que cuenta `(soat_id, hash)` repetidos con el predicado del índice y `RAISE EXCEPTION` si > 0.
2. `CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_soportes_adicional_soat_hash …` (D4).
3. `INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) … ON CONFLICT (codigo) DO NOTHING` de:
   - `soat.documentos_adicionales.cargar` — «Cargar documentos adicionales en una solicitud de SOAT» / «Adjuntar documentos adicionales a una solicitud de SOAT existente, en cualquier estado.»
   - `soat.documentos_adicionales.eliminar` — «Eliminar documentos adicionales de una solicitud de SOAT» / «Borrar definitivamente un documento adicional de una solicitud de SOAT, en cualquier estado, aunque lo haya cargado otra persona.»
   Textos **byte a byte** iguales a `catalogo-operaciones.ts`.
4. `permisos_rol_funcion`: `('admin', …cargar)`, `('proveedor', …cargar)`, `('admin', …eliminar)`, `('proveedor', …eliminar)` `ON CONFLICT DO NOTHING`. **Sin** `cliente`.
5. `DO $resumen0223$`: `RAISE EXCEPTION` si no hay exactamente 2 funciones, si el reparto ≠ 4, si `cliente` tiene alguna, o si falta el índice; `RAISE NOTICE` del reparto.

`schema.ts`: declarar el índice único en el bloque de índices de `flitoSoportes`
(`uniqueIndex('uq_flito_soportes_adicional_soat_hash').on(t.soatId, t.hash).where(sql\`…\`)`), sin columnas nuevas.
Techo congelado de `schema.ts` en `eslint.config.mjs`: `npx eslint apps/api/src/db/schema.ts`; compactar en la misma área si sube, nunca subir el techo.
P6: aplicar **el archivo** dos veces contra la BD local (puerto 5434) y avisar.

## Archivos a crear/modificar

| Acción | Archivo | Qué |
|---|---|---|
| Modificar | `apps/api/src/modules/flito-soat/flito-soat-documentos.routes.ts` | POST y DELETE (D1); traducción de `DocumentoAdicionalError` como el GET; `audit` por guardado/eliminado; `finally limpiarTemporales` |
| Modificar | `apps/api/src/modules/flito-soat/flito-soat-documentos.upload.ts` | fábrica `crearUpload`, `uploadAdicionales`, 400 por campo ajeno, `archivosDeCarga` (D2). `uploadAlta` sin cambio de comportamiento |
| Modificar | `apps/api/src/modules/flito-soat/flito-soat-documentos.service.ts` | `clasificarAdicionales(…, hashesPrevios)` (D3), `hashesAdicionalesGuardados`, `insertarAdicionalesDeCarga` con `onConflictDoNothing` (D4), `cargarDocumentosAdicionales(id, ctx, archivos, etiquetas)` (acceso → clasificar → subir → tx → compensar), `eliminarDocumentoAdicional` + `borrarObjetoConReintento` (D6), `detalleBitacoraAdicional(g, accion)` (D7). Vigilar 800 líneas efectivas (hoy 277 brutas) |
| Modificar | `apps/api/src/services/storage.ts` | `removeEntityDocument(key)` que lanza; `deleteEntityDocument` delega con su `catch` |
| Modificar | `apps/api/src/shared/middleware/rateLimiter.ts` | `soatDocumentosAdicionalesLimiter` (D5) |
| Modificar | `apps/api/src/modules/permisos/catalogo-operaciones.ts` | dos `op(\`${SOAT_DOC} POST /:id/documentos-adicionales\`, 'soat.documentos_adicionales.cargar', …)` y `op(\`${SOAT_DOC} DELETE /:id/documentos-adicionales/:soporteId\`, 'soat.documentos_adicionales.eliminar', …)` — textos = migración |
| Modificar | `apps/api/src/modules/permisos/inventario.generado.ts` | dos entradas a mano junto a la l. 43: `{ modulo: "soat", fichero: "flito-soat/flito-soat-documentos.routes.ts", metodo: "POST", ruta: "/:id/documentos-adicionales", roles: ["admin","proveedor"], heredada: false }` y la del `DELETE …/:soporteId` |
| Modificar | `apps/api/src/db/schema.ts` | índice único parcial (sin columnas) |
| Crear | `apps/api/src/db/migrations/0223_flito_soportes_documentos_adicionales_carga_eliminar.sql` | ver «Migración» |
| Modificar | `apps/api/__tests__/services/permisos.reconduccion-cierre.test.ts` | **montajes 271 → 273** (`GUARDAS_MEDIDAS` y `montajes`; añadir «+ 2 por la HU #13364 (cargar y eliminar documentos adicionales)» al título). **Ficheros de rutas siguen en 32** (mismo `flito-soat-documentos.routes.ts`): no tocar ese aserto. Revisar si la lista blanca / conteo de `metodo === null` cambia (no debería: ambas rutas llevan `exigirFuncion`) |
| Modificar | `apps/api/__tests__/helpers/permisos-seed-sql.ts` | añadir `'0223_flito_soportes_documentos_adicionales_carga_eliminar.sql'` tras la `0222` (si no, las funciones nuevas no existen en la BD de los tests de permisos) |
| Revisar | `apps/api/__tests__/fixtures/permisos-rutas-reconducidas.ts` | si enumera rutas con su función (lo tocó la #13362), añadir las dos |
| Crear | `apps/api/__tests__/db/migracion-0223.test.ts` | calcado de `migracion-0222.test.ts`: funciones, reparto sin `cliente`, índice con su predicado; «la anterior es la 0222» (no «es la última») |
| Modificar | `apps/api/__tests__/services/flito-soat-documentos.service.test.ts` | AC2: repetido contra guardado (hash previo), cupos por envío aunque la solicitud ya tenga 20; carrera: `onConflictDoNothing` devuelve menos filas → `documento_repetido` + `deleteEntityDocument` del perdedor; D6: orden DELETE→storage (asertar que storage no se llama con 0 filas → 404 para la factura / otra solicitud), reintento y log de huérfano, `where` sin `subido_por_id` (AC6); D7 verbo «eliminado» |
| Modificar | `apps/api/__tests__/services/flito-soat-documentos.routes.test.ts` | POST 201 (AC1), 403 sin función sin tocar storage (AC3), 404 sin acceso (AC4), 413 >100, 429 del limitador sin escribir (AC10), 400 sin archivos; DELETE 204 (AC5), 403 (AC7), 404 factura/otra solicitud (AC8), `audit` con detail truncado (AC9) |

P1 = esos archivos de test, nada más. `security-agent` (multer + rutas nuevas + borrado de PII) y `db-review-agent` (índice único + migración) **aplican**, en paralelo.

## ADR: no aplica

Extiende rutas, tabla y motor existentes de la #13362; sin dependencia ni contrato transversal nuevo. La fábrica
`crearUpload` sigue siendo local al módulo.

## Notas operativas

**backend-agent**
- Imports con `.js`; Drizzle `and/eq/inArray`; nada de `drizzle-kit`.
- `onConflictDoNothing` con índice parcial: el `where` del conflicto debe repetir el predicado del índice; probarlo contra
  la BD local una vez (no solo con mock: el mock `chain` no verifica `ON CONFLICT`).
- Tests de orden: asertar el **orden de llamadas** (`delete` de BD antes de `removeObject`), no solo que ambas ocurran.
- `npx eslint` sobre cada archivo tocado (max-lines; `schema.ts` con techo).
- Mínimo P1 + `NODE_OPTIONS=--max-old-space-size=8192 npm run build:api`. shared-types no cambia.

**security-agent**: limitador antes de multer; función antes del limitador; temporales con `finally`; respuesta del POST sin
URL ni clave de storage; log del huérfano solo con la clave opaca.

**frontend-agent**: fuera de esta HU (botones de cargar/eliminar en el detalle van en la HU hermana). Contrato estable arriba.

## Decisiones humanas cerradas (David, 2026-10-07)

1. **Repetido contra la factura de venta en la carga posterior**: sí se incluye (D3).
2. **Techo acumulado por solicitud**: no; los topes son por envío, como dice el AC.
3. **Garantía dura del borrado físico** (cola/purga persistente de objetos huérfanos) y **retención de 30 días** de las
   incompletas descartadas: van en un Feature nuevo bajo la Épica #13201, fuera de esta HU.
