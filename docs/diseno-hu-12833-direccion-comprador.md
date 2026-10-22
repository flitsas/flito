# Diseño slim — HU #12833 · Impuestos: dirección de la factura, corrección con permiso y marca en el Excel

Épica #12809 · Feature #12824 · Módulo **FLITO** `flito-impuestos` (`/api/flito/impuestos`), no el legacy `liquidacion`.
Estado: **Aprobado** (decisiones de David, 2026-09-24). Rama `HU/12833-davidchica-direccion-comprador-factura`, desde develop `7aa864fc` (ya incluye la 12828).
**Fuera de esta HU:** la UI (aviso del conteo, formulario de corrección y comparativa en pantalla) es de la 12834.

## Patrón reutilizado

| Pieza | Vecino |
|---|---|
| Paso de la cola, con `UPDATE … WHERE analisis_estado='en_curso'` y log sin PII | `pasoExtraccion`, `flito-impuestos.extraccion.ts`. Orden de los pasos en `flito-impuestos.analisis.pasos.ts` |
| Acceso a PII del sistema, sin usuario | `registrarAccesoSistema`, `flito-impuestos.extraccion.ts` |
| Sub-router montado tras `authMiddleware` y con el contexto por parámetro | `flito-impuestos.analisis.routes.ts` (`analisisRouter(contextoImpuesto)`) |
| Frontera 404 en lugar de 403 | `buscarConAcceso` (`flito-impuestos.service.ts`) |
| Función nueva: siembra a `admin`, `op()` en el catálogo y textos idénticos a los de la migración | **Bug #12642**: `impuestos.excel.exportar_pago`, migración `0203`, `catalogo-operaciones.ts:92` |
| Columna extra del Excel ampliado | `COLUMNAS_PAGO_IMPUESTOS` / `celdasPagoImpuestos` (`flito-impuestos.export-pago.ts`) y `COLUMNAS_PAGO_IMPUESTOS_EXPORT` (`shared/export/cola-flito-excel.ts:272`) |
| Leer cabeceras en el front | `api.getConCabeceras` / `alLeerCabeceras` (`apps/web/src/lib/api.ts:377`; se usa con `X-Total-Count` en `UsersGestion.tsx:126`) |
| Migración idempotente | `0207_flito_impuestos_semaforo.sql` |

No hace falta ninguna dependencia nueva.

## Decisiones

### D1. Esquema: la dirección vive en `flito_impuestos`, nunca en `flito_compradores`

El sync borra `flito_compradores` y la vuelve a insertar (`flito-sync.service.ts` ~l.347), así que ahí no puede vivir la dirección de la factura. Migración nueva **`0208_flito_impuestos_direccion_factura.sql`**. El número se confirma justo antes de crear el archivo:
`git fetch origin develop && git ls-tree --name-only origin/develop apps/api/src/db/migrations/ | grep -E '/0[0-9]{3}_' | tail -1`.
Hoy la última es la 0207. Si otra sesión subió la 0208, se toma la siguiente. Antes de escribir, `grep -n "direccion_factura\|direccionFactura" apps/api/src/db/schema.ts` debe salir vacío.

```sql
ALTER TABLE flito_impuestos
  ADD COLUMN IF NOT EXISTS direccion_factura             text,
  ADD COLUMN IF NOT EXISTS municipio_factura             text,
  ADD COLUMN IF NOT EXISTS departamento_factura          text,
  -- NULL = sin dirección confirmada → se lee la de FLIT. 'factura' = confirmada por el job. 'manual' = corregida.
  ADD COLUMN IF NOT EXISTS direccion_fuente              text CHECK (direccion_fuente IN ('factura','manual')),
  ADD COLUMN IF NOT EXISTS direccion_pendiente_revision  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS direccion_confirmada_por_id   integer REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS direccion_confirmada_por_nombre text,
  ADD COLUMN IF NOT EXISTS direccion_confirmada_en       timestamptz;
```

- **`direccion_fuente` es el discriminante**, y no `confirmada_por_id IS NULL`. Con `ON DELETE SET NULL`, borrar al usuario haría que una corrección manual pareciera del sistema, y el reanálisis la pisaría. Si `ADD COLUMN IF NOT EXISTS` con un `CHECK` inline no es idempotente en PG, se separa en `ADD CONSTRAINT` dentro de un `DO $$ … duplicate_object`.
- **La propuesta sin confirmar (AC3) no se duplica:** ya está en `extraccion_factura_venta` (`direccion`/`municipio`/`departamento`, cada uno `{valor, confianza, confiable}`). Por eso `direccion_factura` solo contiene valores **confirmados**.
- **Siembra del permiso** en la misma migración (D5).
- **Backfill (recomendado):** los impuestos que analizó la 12826, ya en develop, quedarían sin dirección de la factura y sin marca. La migración aplica la misma regla del paso sobre el jsonb, solo en filas con análisis terminado:
  `UPDATE … SET direccion_factura = trim(e->'direccion'->>'valor'), municipio_factura = CASE WHEN (e->'municipio'->>'confiable')::boolean THEN … END, …, direccion_fuente='factura', direccion_confirmada_en=now() WHERE analisis_estado IN ('completado','error_analisis') AND direccion_fuente IS NULL AND NOT direccion_pendiente_revision AND (e->'direccion'->>'confiable')::boolean AND nullif(trim(e->'direccion'->>'valor'),'') IS NOT NULL`
  y después `UPDATE … SET direccion_pendiente_revision = true WHERE analisis_estado IN ('completado','error_analisis') AND direccion_fuente IS NULL`.
  Al volver a correr la migración no cambia nada: las filas confirmadas y las pendientes quedan fuera del `WHERE`.
- Espejo en `schema.ts`, junto a `semaforo`/`comparacionFacturaRunt`.
- P6: este archivo se aplica **dos veces** sobre la BD local ya migrada.

### D2. Paso nuevo `direccion`, después de `extraccion` y antes de `comparacion`

Orden: `extraccion → direccion → comparacion → autocertificacion`. Se prefiere un **paso separado** a meter la lógica dentro de `pasoExtraccion` por tres razones:
1. `flito-impuestos.extraccion.ts` y sus tests quedan intactos. La regla de la dirección tiene sus propios AC (1, 3 y 8) y se prueba sola.
2. El paso va **antes** de `comparacion`: si el RUNT se cae y el análisis acaba en `error_analisis`, la dirección confiable ya quedó confirmada.
3. El orden explícito de `analisis.pasos.ts` es justamente el punto de extensión que dejó la 12825.

`pasoDireccion({ impuestoId })` en `flito-impuestos.direccion.ts`:
- Lee `extraccion_factura_venta` de la fila, en 1 query y sin tocar la firma `ContextoAnalisis`.
- Si `direccion.confiable` es verdadero y el valor recortado no está vacío, escribe `direccion_factura = valor`. `municipio_factura` y `departamento_factura` se escriben **solo si su campo es confiable**; si no, van a `NULL` y el lector cae a FLIT campo a campo (D3). Además pone `direccion_fuente='factura'`, `pendiente=false`, `confirmada_por_id/nombre = NULL` y `confirmada_en = now()`.
- Si no es confiable o no hay dirección, escribe `pendiente = true` y deja `direccion_fuente` tal cual (AC3).
- **Guarda del `UPDATE`:** `id = $1 AND analisis_estado = 'en_curso' AND direccion_fuente IS DISTINCT FROM 'manual'`. Una corrección manual, aunque llegue mientras el job corre, siempre gana.
- **No toca `flito_compradores`** (AC1). Llama una vez a `registrarAccesoSistema(impuestoId, ['direccion','municipio','departamento'], 'dirección de la factura')`. El log solo lleva `{ impuestoId, resultado: 'confirmada'|'pendiente' }` y nunca el valor.

**Fallo técnico, AC3 con `error_analisis`:** si la extracción lanza (factura no disponible), el paso `direccion` no llega a correr. Por eso los **dos** `UPDATE` que ponen `ERROR` en `flito-impuestos.analisis.service.ts` suman el fragmento exportado `PENDIENTE_SI_SIN_DIRECCION = sql\`${flitoImpuestos.direccionFuente} IS NULL\`` como valor de `direccionPendienteRevision`. Son el `catch` de `ejecutarAnalisis` (l.149) y el barrido de huérfanos (l.197). Así, una dirección ya confirmada no se marca, y un análisis caído sin dirección sí.

### D3. Precedencia de lectura (AC2): un solo helper puro

La dirección de FLIT no sale de una sola tabla. `direccion` viene del comprador principal (`propietariosDe`, en la aplicación), `municipio` de `flito_tramites.ciudad` y `departamento` de `flit_raw`. Por eso la regla **no** se puede escribir como una expresión SQL: va en una función pura en `flito-impuestos.direccion.ts`:

```ts
export function direccionEfectiva(
  f: { fuente: 'factura'|'manual'|null; direccion: string|null; municipio: string|null; departamento: string|null },
  flit: { direccion: string|null; municipio: string|null; departamento: string|null },
): { direccion: string|null; municipio: string|null; departamento: string|null; origen: 'factura'|'manual'|'flit' }
// fuente != null → direccion = f.direccion; municipio = f.municipio ?? flit.municipio; departamento = f.departamento ?? flit.departamento
// fuente == null → FLIT tal cual, origen 'flit'
```

Estos son sus tres lectores:
- **Export de la cola y export ampliado:** `ensamblarFilas` (`flito-impuestos.export.service.ts`) es **un solo** punto para los dos Excel. `COLUMNAS_CONSULTA` suma 4 columnas de lectura (`direccionFuente`, `direccionFactura`, `municipioFactura`, `departamentoFactura`), sin ninguna celda nueva en el archivo del gestor. Las celdas `direccion`, `municipio` y `departamento` (l.274-276) pasan por `direccionEfectiva`.
- **Detalle/comparativa:** `detalleImpuesto` suma **una línea**: `direccionComprador: bloqueDireccionDetalle(imp, item)`. `imp` es la fila completa que ya devuelve `buscarConAcceso`. El bloque incluye `propuesta` (lo leído de `extraccion_factura_venta` cuando `pendienteRevision` es verdadero), `confirmadaPor` y `confirmadaEn`. `compradores[]` sigue siendo el dato crudo de FLIT. El dato efectivo, y lo que pinta la 12834, es `direccionComprador`.
- **Sync:** no cambia nada. `flito-sync` no proyecta estas columnas de `flito_impuestos`. Un test lo fija (lista de P1).

### D4. Marca y conteo en el Excel ampliado (AC4/AC8)

- **Columna nueva, solo en el ampliado,** al final de `COLUMNAS_PAGO_IMPUESTOS_EXPORT`: `{ header: 'Dirección sin confirmar', key: 'direccionSinConfirmar', width: 22 }`. El archivo del gestor (27 columnas) no cambia.
- **Valor:** `'Sí'` si `analisisEstado ∈ {completado, error_analisis}` **y** `direccionPendienteRevision`. En cualquier otro caso `null`, que deja la celda vacía y evita un «No» que parezca afirmar algo. Mismo criterio de texto que `marcadoPorDiferencia`. Nunca analizado (`analisis_estado IS NULL`) o `en_curso` deja la celda vacía (AC8). Para eso `COLUMNAS_PAGO_IMPUESTOS` suma `analisisEstado` y `direccionPendienteRevision`, y `CeldasPagoImpuestos` suma `direccionSinConfirmar: string | null`. Ninguna fila se filtra.
- **Conteo:** cabecera **`X-Direcciones-Sin-Confirmar: <n>`**, que se envía solo con `incluirPago`. Se calcula en la ruta con `contarDireccionesSinConfirmar(filas)` (export-pago.ts) **antes** de `sendExcel`. El front la puede leer: `request()` acepta un callback `alLeerCabeceras`, pero hoy solo lo exponen `getConCabeceras` y `downloadWithName`. Para el POST de la descarga, la **12834** añade una variante `downloadPost` con ese callback, sin cambiar las demás. El origen es el mismo (`BASE='/api'`) y `X-Total-Count` ya funciona así, de modo que no hace falta `Access-Control-Expose-Headers`.
- `routes.ts` va en 804 líneas físicas: el cambio ahí es de **2 líneas** (import y `res.set`). El `backend-agent` corre `npx eslint apps/api/src/modules/flito-impuestos/flito-impuestos.routes.ts` y comprueba el número de max-lines.

### D5. Endpoint de corrección y permiso nuevo (AC5/AC6/AC7)

**Ruta:** `PATCH /api/flito/impuestos/:id/direccion`, en un sub-router **nuevo**, `flito-impuestos.direccion.routes.ts` (`direccionRouter(contextoImpuesto)`), que se monta como el de análisis con `router.use(direccionRouter(contextoImpuesto))`, tras `authMiddleware`.
¿Por qué no en `analisis.routes.ts`? El catálogo es «una función por ruta, código único». Si se mete `analisis.routes.ts` en `FICHEROS_EN_ALCANCE`, el inventario también ve `POST /:id/reanalizar`, cuya función (`impuestos.tramite.certificar`) ya es de `POST /:id/certificar`. Eso rompe la unicidad y convierte esta HU en la deuda de la 12825. Con un archivo propio, solo entra la ruta nueva, que tiene un código único.

```
PATCH /:id/direccion   exigirFuncion('impuestos.tramite.corregir_direccion')
body (zod .strict()): { direccion: string trim 1..200, municipio: string trim 1..100, departamento: string trim 1..100 }
200 → DireccionCompradorImpuesto (bloque de D3, origen 'manual')
400 id/body inválido · 403 sin función (AC6: no toca la fila) · 404 fuera de frontera (buscarConAcceso)
```

- Servicio `corregirDireccionImpuesto(id, datos, actor)` en `flito-impuestos.direccion.ts` con un solo `UPDATE`: los tres valores, `direccion_fuente='manual'`, `pendiente=false`, `confirmada_por_id/nombre` del `req.user` y `confirmada_en=now()`. No restringe por estado, así que también se permite con el análisis en curso: la guarda de D2 impide que el job lo pise.
- **Auditoría sin PII (AC5):** `audit(req, { action:'update', resource:'flito_impuesto', resourceId:id, detail:'Dirección del comprador corregida' })`, **sin** valores, y `registrarAccesoImpuesto(req, { accion:'update', campos:['direccion','municipio','departamento'], … })` (helper de `flito-impuestos.pii.ts`, que ya envuelve `logPiiAccess`). Ningún `log.*` lleva el body.
- **Inventario:** `inventario-guardas.ts` → `FICHEROS_EN_ALCANCE` suma `{ modulo: 'impuestos', fichero: 'flito-impuestos/flito-impuestos.direccion.routes.ts' }`, igual que el SOAT, que ya tiene dos ficheros. Antes, el `backend-agent` lee `leerMontajes` una vez para confirmar que parsea `router.patch(` dentro de una función exportada por defecto, que es la forma de `analisisRouter`. Si exige `authMiddleware` en el propio fichero, se declara `router.use(authMiddleware)` en el sub-router: autenticar dos veces es inocuo.
- **Catálogo:** `catalogo-operaciones.ts` añade una constante `IMP_DIR = 'flito-impuestos/flito-impuestos.direccion.routes.ts'` y
  `op(\`${IMP_DIR} PATCH /:id/direccion\`, 'impuestos.tramite.corregir_direccion', 'Corregir dirección del comprador', 'Guardar la dirección, municipio y departamento correctos del comprador de un trámite de impuestos.')`, con los textos **idénticos, byte a byte**, a los de la migración.
- **Siembra (misma 0208):** misma forma que la 0203. `INSERT` de la función (`'impuestos'`, `'operacion'`) y `INSERT` `('admin','impuestos.tramite.corregir_direccion')`, los dos con `ON CONFLICT DO NOTHING`. Ningún otro rol: el resto se concede desde el panel.
- **Espejos:** `grep -rn "exportar_pago" packages/shared-types/src apps/api/__tests__ apps/api/src/modules/permisos apps/web/e2e/helpers`. **Cada** aparición de ese precedente se replica con el código nuevo. Incluye el catálogo de shared-types si lo hay, y los tests de paridad, conteo e idempotencia de la 0179/0203/0205. Después, `npm run build -w packages/shared-types`, porque un `dist` viejo tumba la paridad. `FUNCIONES_POR_ROL` (E2E) **se deja para la 12834**, que es la que usa `hasFuncion` en la UI; esta HU no toca `apps/web`.

### D6. Reintento (`reanalizarImpuesto`)

Al mismo `UPDATE` condicional que limpia el semáforo se le suma una limpieza **condicionada**:
`direccion_factura/municipio/departamento/confirmada_* = CASE WHEN direccion_fuente = 'manual' THEN <actual> ELSE NULL END`, `direccion_fuente = NULLIF(direccion_fuente,'factura')` y `direccion_pendiente_revision = false`.
Una corrección **manual** no se toca nunca: ni el reintento ni el paso posterior la pisan (guarda de D2). Una confirmación **automática** se descarta y el análisis nuevo la vuelve a decidir, igual que el semáforo. Mientras está `en_curso` se ve la de FLIT, sin marca (AC8). Si ese análisis acaba en fallo técnico, queda `pendiente` (D2).
Para no repetir el `CASE` en SQL, `flito-impuestos.direccion.ts` exporta el objeto `LIMPIEZA_DIRECCION_REANALISIS` (claves → `sql`) y `reanalizarImpuesto` lo expande con `...`.

## Contrato delta

- `PATCH /api/flito/impuestos/:id/direccion`: nuevo (D5).
- `GET /api/flito/impuestos/:id`: `+ direccionComprador: DireccionCompradorImpuesto`.
- `POST /api/flito/impuestos/export` con `incluirPago: true`: `+` columna `Dirección sin confirmar` y `+` cabecera `X-Direcciones-Sin-Confirmar`. Sin `incluirPago` no cambia ninguna columna, aunque `Dirección`/`Municipio`/`Departamento` ahora dan prioridad a la factura.
- shared-types: `DireccionCompradorImpuesto { direccion; municipio; departamento: string|null; origen: 'factura'|'manual'|'flit'; pendienteRevision: boolean; propuesta: {direccion; municipio; departamento: string|null} | null; confirmadaPor: string|null; confirmadaEn: string|null }`, `CorregirDireccionImpuestoBody` y `CABECERA_DIRECCIONES_SIN_CONFIRMAR = 'X-Direcciones-Sin-Confirmar'`. Se añaden solo campos (aditivo), así que el `grep` de usos en `apps/web` es solo de `ImpuestoDetalle`.

## Archivos a crear/modificar

**Crear**
- `apps/api/src/db/migrations/0208_flito_impuestos_direccion_factura.sql` (número por confirmar, D1)
- `apps/api/src/modules/flito-impuestos/flito-impuestos.direccion.ts`: `pasoDireccion`, `direccionEfectiva`, `bloqueDireccionDetalle`, `corregirDireccionImpuesto`, `PENDIENTE_SI_SIN_DIRECCION`, `LIMPIEZA_DIRECCION_REANALISIS`
- `apps/api/src/modules/flito-impuestos/flito-impuestos.direccion.routes.ts`
- Tests (junto a los de la 12825-12828, en el mismo directorio de `apps/api/__tests__/`):
  - `flito-impuestos.direccion.test.ts`: paso (AC1/AC3), precedencia (AC2), guarda manual y reintento (D6)
  - `flito-impuestos.direccion.routes.test.ts`: AC5, AC6 (403 sin cambio en la fila), 404 de frontera, 400 del zod, audit sin valores
  - test de la migración 0208: siembra a `admin`, sin duplicar al re-aplicar (AC7), backfill

**Modificar**
- `apps/api/src/db/schema.ts`: 8 columnas
- `apps/api/src/modules/flito-impuestos/flito-impuestos.analisis.pasos.ts`: registrar `direccion` en segundo lugar
- `apps/api/src/modules/flito-impuestos/flito-impuestos.analisis.service.ts`: los 2 `UPDATE` de `ERROR` más `reanalizarImpuesto`
- `apps/api/src/modules/flito-impuestos/flito-impuestos.export.service.ts`: proyección y `direccionEfectiva` en `ensamblarFilas`
- `apps/api/src/modules/flito-impuestos/flito-impuestos.export-pago.ts`: proyección, celda y `contarDireccionesSinConfirmar`
- `apps/api/src/shared/export/cola-flito-excel.ts`: columna y `CeldasPagoImpuestos`
- `apps/api/src/modules/flito-impuestos/flito-impuestos.routes.ts`: montar `direccionRouter` y `res.set` de la cabecera (≈+3 líneas; eslint)
- `apps/api/src/modules/flito-impuestos/flito-impuestos.service.ts`: +1 línea en `detalleImpuesto` (va en 786 líneas físicas)
- `apps/api/src/modules/permisos/catalogo-operaciones.ts` y `apps/api/src/modules/permisos/inventario-guardas.ts`
- `packages/shared-types/src/`: los tipos del detalle de impuestos, más `permissions.ts` si el grep de D5 lo muestra

**Tests P1 (modificar los existentes que cubren el prod tocado; el `backend-agent` los localiza con `grep -rl` del nombre del prod en `apps/api/__tests__`):**
- tests de `flito-impuestos.analisis.service`: `ERROR` marca `pendiente` solo sin fuente; el reintento conserva la corrección manual
- tests de `flito-impuestos.analisis.pasos`, si fijan el orden o el número de pasos
- tests del export de impuestos (base y ampliado): celda efectiva, marca `Sí`/vacía según AC4/AC8, cabecera con el conteo, 27 columnas sin cambio
- test de `flito-sync` que asierta el `set` de `flito_impuestos` (AC2: el sync no pisa la dirección)
- **Centinelas de permisos:** catálogo ↔ inventario (cobertura y unicidad de códigos), paridad y conteo de funciones de la 0179/0203/0205, e idempotencia de la migración de siembra. Se encuentran con el grep `exportar_pago` de D5.
- **Centinelas de migraciones:** cualquier test que fije «la última migración es NNNN» (`grep -rn "sqls.length - 1\|0207" apps/api/__tests__`). Se ajusta a «la anterior es NNNN-1», nunca a «es la última».

## ADR: no aplica

Es una extensión de patrón: paso de cola, sub-router, función sembrada y columna del ampliado, todos con un vecino. No cambia ningún contrato público ni una frontera PII: las direcciones se escriben en el body, y el id opaco va en el path.

## Notas operativas

**backend-agent**
1. Con la migración: número desde `origin/develop` justo antes (D1). P6: el archivo nuevo, dos veces. Se avisa al usuario de que se tocó su BD.
2. Hace falta una sonda de mutación por guarda. Candidatos para QA (P2, ≤3):
   - quitar `IS DISTINCT FROM 'manual'` del paso: debe caer el test «el reanálisis no pisa la manual»;
   - quitar la condición `analisisEstado` de la celda: debe caer el test de AC8;
   - quitar `PENDIENTE_SI_SIN_DIRECCION` del `catch`: debe caer el test de AC3 con `error_analisis`.
3. El mock `chain` devuelve la fila entera aunque el `select` pida menos. El aserto de AC1 («no escribe en `flito_compradores`») se hace sobre el **espía de `update`/`insert` por tabla**, no sobre el resultado.
4. `routes.ts` y `service.ts` rozan max-lines: `npx eslint` sobre los dos y leer el número.

**frontend-agent (12834, fuera de esta HU)**
- Leer `X-Direcciones-Sin-Confirmar` con una variante de `downloadPost` que acepte `alLeerCabeceras`. Leer `direccionComprador` del detalle. Añadir `impuestos.tramite.corregir_direccion` a `FUNCIONES_POR_ROL` del helper E2E.

## Decisiones humanas (David, 2026-09-24)

1. **Backfill: sí.** La 0208 completa los impuestos ya analizados con la misma regla del paso (D1).
2. **Municipio o departamento no confiables con dirección confiable:** se confirma la dirección y el campo dudoso cae a FLIT (D2/D3).
3. **Corrección manual en cualquier estado**, también certificado o pagado, sin `409` (D5).
