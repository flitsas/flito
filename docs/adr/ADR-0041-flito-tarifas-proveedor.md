# ADR-0041 — FLITO: tarifas de proveedor (costo que cada proveedor le cobra a FLIT por servicio)

- **Estado:** Propuesto (pendiente de aprobación del Líder Técnico)
- **Fecha:** 2026-11-11
- **Enmienda 1 (2026-11-11, Propuesta):** §13 «Costo de proveedor en el trámite» reescribe **R8** — el costo pasa a leerse en el reporte de costos y a congelarse al sellar, sin sumar a nada de lo que se cobra (C1–C8). Donde este documento diga «R8: ningún proceso lee estos valores», manda §13.
- **Épica:** ADO #13763 «Tarifas: valores que cobra cada proveedor». **Sin Features ni HUs en ADO por instrucción explícita del humano**; el criterio de aceptación son las reglas R1–R9 acordadas con él (se citan como `R1`…`R9`).
- **Rama:** `FEATURE/13763-davidchica-tarifas-proveedores`
- **Módulos:** FLITO `flito-parametrizacion` (servicio y router nuevos), `db/schema/flito-proveedores.ts`, `packages/shared-types`, `apps/web` página `FlitoTarifas`. **No toca** los legacy `soat`, `tramites`, `liquidacion`, ni la tarifa al cliente (`flito_tarifas_vigencias`), ni ningún proceso (SOAT, liquidación, entregas) — R1, R8.
- **Relación con ADRs previos:**

| ADR | Relación |
|---|---|
| ADR-0039 (proveedores multiservicio) | **Se apoya, no se supersede.** La llave es la identidad única `flito_proveedores.id`; los servicios vigentes salen de `flito_proveedor_servicios_v`. Se respeta el orden de bloqueo padre → perfil de §4.3 y la frontera de §6/§7 (D4: el proveedor no ve precios). |
| ADR-0040 (rol proveedor con perfil de logística) | Sin cambio. Este ADR **no** siembra nada al rol `proveedor`. |
| ADR-0024 (frontera por enlace) | Sin cambio. El router nuevo se monta **sin** `conAlcance`: cerrado a todo enlace. |
| ADR-0035 (migraciones a mano) | Se cumple: SQL plano, idempotente, sin `drizzle-kit`. |

---

## 1. Contexto

Hoy FLITO registra **lo que cobra al cliente** (`flito_tarifas_vigencias`, `apps/api/src/db/schema/finanzas.ts:54-90`, servicio `flito-tarifas.service.ts`, RN-01..RN-07) y lee el valor del SOAT del comprobante (lo paga el cliente). No registra **lo que el proveedor le cobra a FLIT** por prestar el servicio. Se pide registrarlo, por proveedor y por concepto, con historial de vigencias, sin que ningún proceso lo lea todavía (R8), y sin que los usuarios de proveedor lo vean (R7).

Lo que ya existe y se reutiliza:

- **Patrón de vigencias** de la tarifa al cliente: abrir / cerrar-y-abrir / cerrar-sin-abrir en una transacción, mismo instante en las dos escrituras, `FOR UPDATE` sobre la abierta, índice único parcial de «una abierta por llave», `EXCLUDE` con `btree_gist` contra solapes, CHECK de rango y de cierre (`(vigente_hasta IS NULL) = (cerrado_en IS NULL)`), `PATCH /tarifas/:id` donde el id de la vigencia es la llave de conflicto (`TarifaConflictoError` → 409).
- **Identidad de proveedor** `flito_proveedores` (UUID único, `activo`, `deleted_at`), perfiles `flito_proveedores_soat` / `flito_proveedores_logistica` con el mismo UUID y `deleted_at` por servicio, vista `flito_proveedor_servicios_v (proveedor_id, servicio)`.
- **Permisos** `accion.tarifas.ver` («Ver las tarifas») → `parametrizacion.tarifas.listar | ver_por_cliente | historial`; `accion.tarifas.crear_modificar` («Crear y modificar tarifas») → `parametrizacion.tarifas.crear | editar` (`apps/api/src/modules/permisos/arbol/acciones-finanzas.ts:83-84`).
- **Frontera:** todo `/api/flito/parametrizacion/*` se monta sin `conAlcance` (`app.ts:271-274`), y `guardiaFrontera` responde 403 a cualquier enlace distinto de `ninguno` en un router sin módulo de frontera (`shared/middleware/frontera-enlace.ts:199-221`). `parametrizacion` no está en `MODULOS_FRONTERA`.

## 2. Alternativas

### Opción 1 — Tabla nueva `flito_tarifas_proveedor_vigencias` con el mismo patrón de vigencias (RECOMENDADA)

Tabla hermana de `flito_tarifas_vigencias`, con llave `(proveedor_id, concepto)` y la columna derivada `servicio`.

| | |
|---|---|
| **Pros** | Separación total cliente/proveedor (R1): ningún lector actual de tarifas (`tarifaDe`, reporte de costos, liquidación, precio de traslados) puede leer un costo por error, porque no ve la tabla. Reutiliza el patrón ya probado (RN-01, AC6 de #12373) sin tocarlo. FK `RESTRICT` limpia a `flito_proveedores` (UUID) en vez de a `clients` (integer). La migración es solo `CREATE`: sin `ALTER` sobre una tabla financiera en uso. Rollback = la imagen vieja ignora la tabla. |
| **Contras** | Duplica ~60 líneas de esqueleto (CHECK, índices, transición abrir/cerrar). Dos tablas de vigencias con forma parecida. |
| **Esfuerzo** | **M** |
| **Riesgos** | Bajos. Que alguien, más adelante, «unifique» las dos tablas sin ADR (se cierra con este documento). |

### Opción 2 — Generalizar `flito_tarifas_vigencias` (columna `proveedor_id` nullable + XOR con `compania_id`)

| | |
|---|---|
| **Pros** | Una sola tabla y un solo servicio de vigencias. |
| **Contras** | Contradice R1 en la práctica: **todos** los lectores actuales (`tarifaDe`, `vigenteEn`, `vistaPorCompania`, `historial`, reporte de costos, congelado de `tarifaVigenciaId` en traslados, HU #14106) deben añadir `compania_id IS NOT NULL` o mezclar valores; un olvido suma el costo del proveedor a lo que se le cobra al cliente. Hay que rehacer el índice único parcial, el `EXCLUDE` y los CHECK de concepto/tipo de una tabla que lee la liquidación, con `ALTER … DROP NOT NULL` sobre `compania_id` durante un rollout en que pods viejos siguen escribiendo. Mezcla FK integer (`clients`) y UUID (`flito_proveedores`). |
| **Esfuerzo** | **L** |
| **Riesgos** | **Altos**: regresión silenciosa en liquidación y reporte de costos; viola R8 en espíritu (un proceso «lee» la tabla aunque sea para excluir). |

### Opción 3 — Columnas de costo en los perfiles (`flito_proveedores_soat.costo_con_tramite`, …) + historial en `flito_proveedores_auditoria`

| | |
|---|---|
| **Pros** | Esfuerzo mínimo; el valor vive junto al servicio y desaparece de la vista solo con el perfil. |
| **Contras** | **Pisa** el valor (R4: «nunca se borra ni se pisa»); el historial queda como texto en la auditoría, no consultable por fecha para el proceso futuro que lo lea. Mezcla la concurrencia del costo con `flito_proveedores.version` (falsos 409 al editar datos del proveedor mientras otro fija un costo). La auditoría tiene CHECK de lista blanca de campos y enmascara PII: no es lugar para importes. |
| **Esfuerzo** | **S** |
| **Riesgos** | Incumple R4 y R6 tal como se acordaron. Descartada. |

### Comparación

| Criterio | Op. 1 | Op. 2 | Op. 3 |
|---|---|---|---|
| R1 (no mezcla) | Sí, por construcción | Solo por disciplina en cada lector | Sí |
| R4 (nunca se pisa, historial) | Sí | Sí | **No** |
| R6 (concurrencia por valor) | Sí (id de la vigencia) | Sí | Choca con `version` del proveedor |
| Riesgo sobre liquidación | Nulo | **Alto** | Nulo |
| Esfuerzo | M | L | S |

## 3. Decisión

**Opción 1.** Tabla nueva `flito_tarifas_proveedor_vigencias`, servicio y router nuevos en `flito-parametrizacion`, mismo patrón que `flito-tarifas.service.ts` (RN-01, RN-04) sin modificarlo.

**Qué cambiaría esta recomendación:** que el PO pida un único reporte «cobro vs costo» transaccional con la misma llave; aun así se resolvería con una vista de lectura, no fusionando tablas.

### 3.1 Decisiones puntuales

| # | Tema | Decisión | Motivo |
|---|---|---|---|
| D1 | Precisión | `numeric(14,2)`, máximo `TARIFA_VALOR_MAX` (999 999 999 999,99), ≤ 2 decimales | Misma columna que la tarifa al cliente: comparables cuando un proceso lea ambas. Sin IVA (R3): un solo importe, sin columnas de impuesto. |
| D2 | Concepto ↔ servicio | **En BD** con CHECK sobre el par `(servicio, concepto)`; **en el servicio** la vigencia del servicio para ese proveedor (perfil con `deleted_at IS NULL`) | El par es un invariante estático (no depende de datos): lo garantiza la BD. Que el proveedor *preste hoy* el servicio es dinámico (perfil) y no se puede expresar con una FK simple a dos tablas de perfil: lo comprueba el servicio con `FOR SHARE` sobre el perfil (§5). Se guarda `servicio` (columna derivada) para unir directo con `flito_proveedor_servicios_v` y filtrar por servicio sin `CASE`. |
| D3 | Llave de concurrencia (R6) | **El id de la vigencia abierta** viaja en la ruta de cambio/cierre (`PATCH /vigencias/:vigenciaId`). Si al tomar `FOR UPDATE` ya no está abierta → 409 `TARIFA_PROVEEDOR_CAMBIADA_POR_OTRO`. Para la primera fijación (no hay fila que bloquear) el índice único parcial de la abierta convierte la carrera en 23505 → el mismo 409 | Es el «equivalente» de `versionEsperada` (ADR-0039 §4.2): cada cambio crea un id nuevo que nunca se reutiliza, así que el id **es** una versión monótona por fila, sin columna `version` extra ni ABA. Es exactamente el contrato que ya usa `PATCH /tarifas/:id` en el vecino. No se usa `flito_proveedores.version`: cambiaría por ediciones del proveedor y daría falsos 409 (y viceversa). |
| D4 | Valor cero | `0` es válido y se guarda como vigencia abierta; «Sin configurar» = no hay abierta. **No** se exige `confirmarCero` | R4 lo declara válido y R3 no pide confirmación. La UI distingue los dos estados (ux-agent). Si el humano quiere confirmación como en la tarifa cliente (AC10 de #12373), es un flag opcional en el body sin cambio de modelo. |
| D5 | Inicio de la vigencia | `vigente_desde = now()` de la transacción; el body **no** acepta fechas | R4: «empieza al guardar, sin fechas futuras». Cerrar y abrir usan el mismo `now()` (rangos `[a, t)` y `[t, ∞)`). |
| D6 | Proveedor inactivo / eliminado / servicio quitado (R5) | Se conservan vigencias e historial. Lista: solo activos y vivos. Escritura: 404 si eliminado, 409 `PROVEEDOR_NO_ACTIVO` si inactivo, 422 `SERVICIO_NO_PRESTADO` si el perfil del servicio no está vivo. Lectura de vista e historial: permitida aunque esté inactivo o eliminado (auditoría) | R5. Ver pendiente humano P-1 y P-2 (§12). |
| D7 | Quitar un servicio | **No** cierra las vigencias abiertas de ese servicio ni toca `quitarServicio` (ADR-0039 §4.3) | Menor acoplamiento y R8 (nadie las lee). La vista solo muestra filas de servicios vigentes (R2), así que la abierta queda «latente». Ver P-1. |
| D8 | Permisos (R7) | **Reutilizar los códigos existentes** sin crear funciones nuevas: lectura → `parametrizacion.tarifas.listar` (lista y vista) y `parametrizacion.tarifas.historial`; fijar → `parametrizacion.tarifas.crear`; cambiar/cerrar → `parametrizacion.tarifas.editar` | R7 pide «los permisos actuales». Las dos acciones del árbol ya los conceden juntos: quien hoy tiene «Ver las tarifas» / «Crear y modificar tarifas» obtiene esto sin siembra ni migración de permisos. El catálogo admite varias rutas por código (como `parametrizacion.proveedores.editar`). Para la autogestión futura del proveedor (fuera de alcance) se crearía una función propia `parametrizacion.tarifas_proveedor.ver_propias` en otro ADR. |
| D9 | Frontera (R7) | Router montado en `app.ts` **sin** `conAlcance` → `guardiaFrontera` da 403 a cualquier enlace (`compania`, `proveedor`, `organismos_transito`) aunque su rol tenga la función. No se siembra nada al rol `proveedor`. Test explícito | D4 de ADR-0039 se mantiene: el proveedor no ve precios de ningún tipo. El panel de roles ya avisa (`funcionesAlcanzables`) que `parametrizacion.*` no es alcanzable para enlaces. |
| D10 | PII / `logPiiAccess` | **No aplica**: no hay datos del titular (conductor/propietario). Se proyecta: id y nombre del proveedor (empresa), importes, fechas y **nombre** del usuario interno que fijó/cerró. No se proyecta NIT, teléfono, correo, dirección ni contacto del proveedor. Sin filtros PII: no hay búsqueda por NIT/placa/nombre en query; el único filtro en query es `concepto` (catálogo cerrado) | AGENTS §16: «no se registran las rutas sin datos del titular». IDs opacos (UUID) en path están permitidos (§14). |
| D11 | Auditoría | `audit()` en las tres mutaciones (fijar, cambiar, cerrar), tras commit, como el vecino. `detail` con concepto, id y nombre del proveedor, valor anterior → nuevo, id de vigencia. **No** se escribe en `flito_proveedores_auditoria` (su CHECK de lista blanca es de datos del proveedor; el historial de importes vive en la propia tabla, con `fijado_por` / `cerrado_por`) | AGENTS backend; R4 (quién fijó, quién cerró). |
| D12 | Archivo de esquema | `apps/api/src/db/schema/flito-proveedores.ts` | El dominio es el proveedor; la FK Drizzle a `flitoProveedores` queda en el mismo archivo (sin import entre archivos de esquema). `finanzas.ts` es la facturación al cliente y lo tocan otros Features: no compartirlo evita serializar con ellos. Siguiendo la convención del archivo, las FK a `users` solo en SQL (no importa `schema.ts`, sin ciclo). |

## 4. Modelo de datos (Drizzle)

En `apps/api/src/db/schema/flito-proveedores.ts` (añadir `check`, `numeric`, `uniqueIndex` y `sql` a los imports). El barril `src/db/schema.ts` ya reexporta el archivo (`export * from './schema/flito-proveedores.js'` — comprobar; si reexporta por nombre, añadir el símbolo).

```ts
// Costo que cada proveedor le cobra a FLIT por concepto (ADR-0041, Épica #13763). NO es la tarifa al cliente
// (`flito_tarifas_vigencias`, finanzas.ts): no se mezclan ni se unen. Vigencias [vigente_desde, vigente_hasta):
// cambiar = cerrar la abierta y abrir otra en UNA transacción con el mismo now(); dejar de cobrar = cerrar sin
// abrir. Nunca se borra ni se pisa. Solo en SQL (0300): FK fijado_por_id/cerrado_por_id → users RESTRICT y la
// EXCLUDE sin solapes (btree_gist).
export const flitoTarifasProveedorVigencias = pgTable('flito_tarifas_proveedor_vigencias', {
  id: uuid('id').primaryKey().defaultRandom(),
  proveedorId: uuid('proveedor_id').notNull().references(() => flitoProveedores.id, { onDelete: 'restrict' }),
  servicio: varchar('servicio', { length: 20 }).notNull(),     // derivado del concepto; CHECK de par
  concepto: varchar('concepto', { length: 30 }).notNull(),
  valor: numeric('valor', { precision: 14, scale: 2 }).notNull(),
  vigenteDesde: timestamp('vigente_desde', { withTimezone: true }).notNull().defaultNow(),
  vigenteHasta: timestamp('vigente_hasta', { withTimezone: true }),
  fijadoPorId: integer('fijado_por_id'),
  fijadoEn: timestamp('fijado_en', { withTimezone: true }).notNull().defaultNow(),
  cerradoPorId: integer('cerrado_por_id'),
  cerradoEn: timestamp('cerrado_en', { withTimezone: true }),
}, (t) => ({
  proveedorConceptoIdx: index('idx_flito_tarifas_prov_proveedor_concepto').on(t.proveedorId, t.concepto, t.vigenteDesde),
  abiertaUq: uniqueIndex('uq_flito_tarifas_prov_abierta').on(t.proveedorId, t.concepto).where(sql`${t.vigenteHasta} IS NULL`),
  conceptoChk: check('flito_tarifas_prov_concepto_chk', sql`(${t.servicio} = 'logistica' AND ${t.concepto} = 'logistica') OR (${t.servicio} = 'soat' AND ${t.concepto} IN ('soat_con_tramite', 'soat_sin_tramite'))`),
  valorChk: check('flito_tarifas_prov_valor_chk', sql`${t.valor} >= 0`),
  rangoChk: check('flito_tarifas_prov_rango_chk', sql`${t.vigenteHasta} IS NULL OR ${t.vigenteHasta} >= ${t.vigenteDesde}`),
  cierreChk: check('flito_tarifas_prov_cierre_chk', sql`(${t.vigenteHasta} IS NULL) = (${t.cerradoEn} IS NULL)`),
}));
```

Sin `COALESCE` en el único parcial (no hay columna nullable en la llave, a diferencia de `tipo_tramite` del vecino). El índice `(proveedor_id, concepto, vigente_desde)` sirve al historial ordenado y a un futuro filtro por proveedor (R7, autogestión).

### 4.1 Migración `apps/api/src/db/migrations/0300_flito_tarifas_proveedor.sql` (esbozo)

Numeración: `0300` es el siguiente libre hoy; **se renumera al integrar** si otro Feature tomó el número. Idempotente; sin `BEGIN/COMMIT` (lo pone el runner); sin datos (R8: los proveedores nacen sin valor).

```sql
-- 0300_flito_tarifas_proveedor.sql — ADR-0041 (Épica #13763). Costo que el proveedor le cobra a FLIT.
-- Solo DDL nuevo; no toca flito_tarifas_vigencias ni ningún lector. Sin backfill (R8). Idempotente.

CREATE EXTENSION IF NOT EXISTS btree_gist;  -- ya creada por la 0182; no-op

CREATE TABLE IF NOT EXISTS flito_tarifas_proveedor_vigencias (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proveedor_id    uuid NOT NULL REFERENCES flito_proveedores(id) ON DELETE RESTRICT,
  servicio        varchar(20) NOT NULL,
  concepto        varchar(30) NOT NULL,
  valor           numeric(14,2) NOT NULL,
  vigente_desde   timestamptz NOT NULL DEFAULT now(),
  vigente_hasta   timestamptz,
  fijado_por_id   integer REFERENCES users(id) ON DELETE RESTRICT,
  fijado_en       timestamptz NOT NULL DEFAULT now(),
  cerrado_por_id  integer REFERENCES users(id) ON DELETE RESTRICT,
  cerrado_en      timestamptz,
  CONSTRAINT flito_tarifas_prov_concepto_chk CHECK (
    (servicio = 'logistica' AND concepto = 'logistica')
    OR (servicio = 'soat' AND concepto IN ('soat_con_tramite', 'soat_sin_tramite'))),
  CONSTRAINT flito_tarifas_prov_valor_chk  CHECK (valor >= 0),
  CONSTRAINT flito_tarifas_prov_rango_chk  CHECK (vigente_hasta IS NULL OR vigente_hasta >= vigente_desde),
  CONSTRAINT flito_tarifas_prov_cierre_chk CHECK ((vigente_hasta IS NULL) = (cerrado_en IS NULL)),
  -- Cerrar exige quién: una cerrada sin actor no tiene «quién cerró» en el historial (R4).
  CONSTRAINT flito_tarifas_prov_cerrado_por_chk CHECK (cerrado_en IS NULL OR cerrado_por_id IS NOT NULL),
  CONSTRAINT flito_tarifas_prov_sin_solape EXCLUDE USING gist (
    proveedor_id WITH =, concepto WITH =, tstzrange(vigente_desde, vigente_hasta, '[)') WITH &&)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_tarifas_prov_abierta
  ON flito_tarifas_proveedor_vigencias (proveedor_id, concepto) WHERE vigente_hasta IS NULL;
CREATE INDEX IF NOT EXISTS idx_flito_tarifas_prov_proveedor_concepto
  ON flito_tarifas_proveedor_vigencias (proveedor_id, concepto, vigente_desde);

COMMENT ON TABLE flito_tarifas_proveedor_vigencias IS
  'Costo que el proveedor cobra a FLIT por concepto (ADR-0041). No es la tarifa al cliente. Nunca se borra.';
```

Notas para `db-review-agent`: `btree_gist` sobre `uuid` está soportado en PostgreSQL 16 (imagen `postgres:16-alpine`); confirmar en la BD local aplicando el archivo dos veces (P6). El CHECK `cerrado_por_chk` es más estricto que el vecino (que admite `cerrado_por_id` nulo); se mantiene porque aquí no hay filas migradas sin actor. `fijado_por_id` queda nullable por si un proceso de sistema fija valores en el futuro; la API siempre lo llena.

## 5. Diagrama de secuencia (cambio concurrente, R6)

```mermaid
sequenceDiagram
  autonumber
  participant A as Usuaria A (web)
  participant B as Usuario B (web)
  participant R as Router tarifas-proveedores
  participant S as flito-tarifas-proveedor.service
  participant DB as PostgreSQL

  A->>R: PATCH /vigencias/V1 {valor: 120000}
  B->>R: PATCH /vigencias/V1 {valor: 125000}
  R->>R: authMiddleware + guardiaFrontera (enlace=ninguno) + exigirFuncion(tarifas.editar) + Zod
  R->>S: cambiar(V1, 120000, actorA)
  S->>DB: BEGIN; SELECT proveedor FOR SHARE; SELECT perfil(servicio) FOR SHARE
  S->>DB: SELECT V1 FOR UPDATE (abierta)
  R->>S: cambiar(V1, 125000, actorB)
  S->>DB: BEGIN; ... SELECT V1 FOR UPDATE (espera el lock de A)
  S->>DB: UPDATE V1 SET vigente_hasta=now(), cerrado_*; INSERT V2 (vigente_desde=now()); COMMIT
  S-->>R: {accion: cambiada, anterior, nueva: V2}
  R->>R: audit(update, flito_tarifa_proveedor_vigencia)
  R-->>A: 200 {vigencia V2, valorAnterior}
  DB-->>S: (B) relee V1 tras el lock: vigente_hasta NOT NULL
  S-->>R: TarifaProveedorCambiadaError
  R-->>B: 409 {code: TARIFA_PROVEEDOR_CAMBIADA_POR_OTRO, error: "Otro usuario cambió este valor. Recarga para ver el vigente"}
```

Orden de bloqueo **padre → perfil → vigencia**, el mismo que `quitarServicio` / `cambiarEstadoProveedor` (ADR-0039 §4.3): sin interbloqueo. Primera fijación (`POST`): igual hasta el perfil; luego `SELECT abierta (proveedor, concepto) FOR UPDATE`; si existe → 409; si no, `INSERT`; un 23505 sobre `uq_flito_tarifas_prov_abierta` o un 23P01 sobre `sin_solape` (dos primeras fijaciones simultáneas) → mismo 409.

## 6. Contrato de endpoints

Router nuevo `apps/api/src/modules/flito-parametrizacion/flito-tarifas-proveedor.routes.ts`, montado en `app.ts` como `app.use('/api/flito/parametrizacion/tarifas-proveedores', flitoTarifasProveedorRoutes)` **antes** de `app.use('/api/flito/parametrizacion', …)` y **sin** `conAlcance`. Todas con `authMiddleware` + `exigirFuncion`. `Cache-Control: no-store` en las lecturas (importes comerciales).

| Método y ruta | Función (existente) | Request | Response |
|---|---|---|---|
| `GET /` | `parametrizacion.tarifas.listar` | — | `ResumenProveedorCostos[]`: `{ id, nombre, servicios: ServicioProveedor[], conceptos: number, faltan: number }` de proveedores **activos y vivos** (R5), orden por nombre. Sin NIT ni datos de contacto |
| `GET /:proveedorId` | `parametrizacion.tarifas.listar` | `proveedorId` uuid (Zod) | `VistaCostosProveedor`: `{ proveedor: { id, nombre, activo, eliminado }, filas: FilaCostoProveedor[], capacidades: { editar, verHistorial } }`. `filas` = conceptos de los servicios vigentes (R2), cada una `{ servicio, concepto, vigencia: VigenciaCostoProveedor \| null }` (`null` = «Sin configurar»). `capacidades` con `funcionesConcedidas` como el vecino: `editar = crear && editar`, `verHistorial = historial` |
| `GET /:proveedorId/historial?concepto=` | `parametrizacion.tarifas.historial` | `concepto` opcional ∈ `CONCEPTOS_COSTO_PROVEEDOR` (catálogo cerrado, no PII) | `VigenciaCostoProveedor[]` de **todos** los conceptos, incluidos servicios ya retirados (R5), orden `concepto, vigente_desde DESC` |
| `POST /:proveedorId/vigencias` | `parametrizacion.tarifas.crear` | `{ concepto, valor }` | 201 `VigenciaCostoProveedor` (primera fijación o volver a cobrar tras cerrar) |
| `PATCH /vigencias/:vigenciaId` | `parametrizacion.tarifas.editar` | `{ valor }` **o** `{ cerrar: true }` (exactamente uno, `.strict()`) | 200 `{ vigencia: VigenciaCostoProveedor, accion: 'cambiada' \| 'cerrada' \| 'sin_cambio', valorAnterior, valorNuevo \| null }`. En `cerrada`, `vigencia` es la cerrada y la fila vuelve a «Sin configurar» |

`VigenciaCostoProveedor = { id, proveedorId, servicio, concepto, valor: number, vigenteDesde, vigenteHasta: string | null, fijadoPor: { id, nombre } | null, fijadoEn, cerradoPor: { id, nombre } | null, cerradoEn: string | null }` («Vigente» = `vigenteHasta === null`).

**Zod (en la ruta):**

```ts
const valorCostoSchema = z.number({ error: MENSAJE_VALOR_COSTO_INVALIDO })
  .finite(MENSAJE_VALOR_COSTO_INVALIDO).nonnegative(MENSAJE_VALOR_COSTO_INVALIDO)
  .max(TARIFA_VALOR_MAX, 'Supera el máximo admitido (12 enteros y 2 decimales)')
  .refine((n) => Math.round(n * 100) / 100 === n, 'Admite a lo sumo dos decimales');
const fijarSchema   = z.object({ concepto: z.enum(CONCEPTOS_COSTO_PROVEEDOR), valor: valorCostoSchema }).strict();
const cambiarSchema = z.union([z.object({ valor: valorCostoSchema }).strict(), z.object({ cerrar: z.literal(true) }).strict()]);
// MENSAJE_VALOR_COSTO_INVALIDO = 'El valor debe ser mayor o igual a cero' (R3): vacío, null, texto o negativo.
```

El 400 del valor responde **el mensaje literal** de R3 (`{ error, campo: 'valor' }`), no el «Datos inválidos: …» genérico del vecino. La web también valida antes de enviar (vacío/negativo) con el mismo texto de shared-types.

**Códigos de error** (clases `*Error` exportadas por el servicio; traducción en la ruta):

| HTTP | `code` | Mensaje | Cuándo |
|---|---|---|---|
| 400 | `VALOR_INVALIDO` | «El valor debe ser mayor o igual a cero» | Valor vacío, no numérico o negativo (R3) |
| 400 | `DATOS_INVALIDOS` | campo: regla | uuid mal formado, concepto fuera de catálogo, body con campos de más |
| 404 | `PROVEEDOR_NO_ENCONTRADO` / `VIGENCIA_NO_ENCONTRADA` | — | Proveedor inexistente o eliminado (en escritura); vigencia inexistente |
| 409 | `TARIFA_PROVEEDOR_CAMBIADA_POR_OTRO` | «Otro usuario cambió este valor. Recarga para ver el vigente» | R6: la vigencia del path ya no está abierta, o ya hay abierta al fijar, o 23505/23P01 |
| 409 | `PROVEEDOR_NO_ACTIVO` | «El proveedor está inactivo» | Escritura sobre proveedor inactivo (D6, P-2) |
| 422 | `SERVICIO_NO_PRESTADO` | «El proveedor no presta ese servicio» | Concepto de un servicio sin perfil vivo (R2) |
| 403 | — | «Sin permisos» | Sin la función, o cualquier enlace ≠ `ninguno` (R7, frontera) |

**OpenAPI:** las cinco rutas se agregan al contrato con `npm run contrato:generar` (genera `contracts/openapi/flito-api.v1.yaml`; no se edita a mano). El CI falla si falta.

## 7. Impacto en `shared-types`

Archivo nuevo `packages/shared-types/src/flito-tarifas-proveedor.ts`, exportado desde `src/index.ts`. Tipos **distintos** de `ConceptoTarifa` (el `'logistica'` del cliente y el del proveedor no son intercambiables en el sistema de tipos):

- `CONCEPTOS_COSTO_PROVEEDOR = ['logistica', 'soat_con_tramite', 'soat_sin_tramite'] as const`, `type ConceptoCostoProveedor`.
- `SERVICIO_DE_CONCEPTO_COSTO: Readonly<Record<ConceptoCostoProveedor, ServicioProveedor>>` y `CONCEPTOS_DE_SERVICIO: Readonly<Record<ServicioProveedor, readonly ConceptoCostoProveedor[]>>` (fuente única de R2; el test de esquema comprueba que coincide con el CHECK).
- `ETIQUETA_CONCEPTO_COSTO` (`Logística`, `SOAT con trámite`, `SOAT sin trámite`).
- `MENSAJE_VALOR_COSTO_INVALIDO`, `MENSAJE_TARIFA_PROVEEDOR_CAMBIADA_POR_OTRO`, `CODIGO_TARIFA_PROVEEDOR_CAMBIADA = 'TARIFA_PROVEEDOR_CAMBIADA_POR_OTRO'`.
- Interfaces `VigenciaCostoProveedor`, `FilaCostoProveedor`, `VistaCostosProveedor`, `ResumenProveedorCostos`, `ResultadoCambioCostoProveedor`.
- Reutiliza `ServicioProveedor` / `SERVICIOS_PROVEEDOR` y `TARIFA_VALOR_MAX` existentes. **No** modifica `CONCEPTOS_TARIFA` ni `flito-tarifas.ts` → no hay usos que cambien en `apps/web` (regla 7: el grep confirma cero usos de símbolos modificados).

## 8. Permisos y frontera (R7)

- Sin funciones nuevas, sin migración de permisos, sin cambio en `acciones-finanzas.ts`: las rutas nuevas se declaran en `catalogo-operaciones.ts` con los **mismos códigos, etiquetas y descripciones** que las de `/tarifas` (una entrada `op()` por ruta, patrón de `parametrizacion.proveedores.editar` con dos rutas). Así el centinela «ruta ⇔ función» pasa y el reparto actual (admin + Finanzas) aplica tal cual.
- La pantalla usa la misma página `flito_tarifas` (`ProtectedRoute page="flito_tarifas"`); no se crea `PageSlug`.
- Rol `operaciones`: no existe; no aparece en ninguna guarda.
- **Usuario de proveedor:** el router está fuera de `MODULOS_FRONTERA` → `guardiaFrontera` 403 aunque un administrador le hubiera concedido `accion.tarifas.*` (ADR-0015 permite concederlo con aviso). Ninguna ruta abierta al proveedor (`/api/flito/logistica`, `/api/flito/soat`) lee la tabla nueva (R8), así que D4 de ADR-0039 se mantiene sin cambios. Test obligatorio: usuario con enlace `proveedor` **y** las cinco funciones concedidas → 403 en las cinco rutas, cuerpo sin importes.
- Autogestión futura: el modelo ya filtra por `proveedor_id` (índice) y el enlace `proveedor` ya trae `proveedorId` en `req.frontera`; bastará una función nueva y una ruta en un módulo abierto al proveedor. Fuera de alcance.

## 9. Archivos por bloque

Regla: ningún archivo en dos bloques **paralelos**. CONTRATO es serial y va primero; BACKEND y FRONTEND corren en paralelo después, cada uno en su worktree. El único archivo que pasa de CONTRATO a BACKEND (el router con stubs) no se toca en FRONTEND.

### Bloque CONTRATO (serial, un agente: `backend-agent`)

| Archivo | Acción |
|---|---|
| `apps/api/src/db/migrations/0300_flito_tarifas_proveedor.sql` | Crear (§4.1). Renumerar al integrar si hace falta |
| `apps/api/src/db/schema/flito-proveedores.ts` | Modificar: tabla `flitoTarifasProveedorVigencias` (§4) |
| `apps/api/src/db/schema.ts` | Solo si reexporta por nombre (verificar; si es `export *`, no se toca). Techo congelado: sin líneas nuevas netas |
| `packages/shared-types/src/flito-tarifas-proveedor.ts` | Crear (§7) |
| `packages/shared-types/src/index.ts` | Modificar: `export * from './flito-tarifas-proveedor.js'` |
| `apps/api/src/modules/flito-parametrizacion/flito-tarifas-proveedor.routes.ts` | Crear con las 5 rutas, Zod, `exigirFuncion` y handlers que llaman al servicio (stubs `throw new Error('no implementado')` en el servicio) |
| `apps/api/src/modules/flito-parametrizacion/flito-tarifas-proveedor.service.ts` | Crear con firmas y clases `*Error` (cuerpos stub) |
| `apps/api/src/app.ts` | Modificar: import + `app.use('/api/flito/parametrizacion/tarifas-proveedores', …)` antes del router general |
| `apps/api/src/modules/permisos/catalogo-operaciones.ts` | Modificar: 5 `op()` con códigos existentes |
| `contracts/openapi/flito-api.v1.yaml` | Regenerar con `npm run contrato:generar` (no a mano) |

Verificación del bloque: `npm run build -w packages/shared-types`, `NODE_OPTIONS=--max-old-space-size=8192 npm run build:api`, aplicar la 0300 dos veces en la BD local (P6), `npm run lint`.

### Bloque BACKEND (paralelo, `backend-agent`)

| Archivo | Acción |
|---|---|
| `apps/api/src/modules/flito-parametrizacion/flito-tarifas-proveedor.service.ts` | Implementar: `listarProveedoresConCostos`, `vistaCostosProveedor`, `historialCostosProveedor`, `fijarCosto`, `cambiarOCerrarCosto`; cabecera con `RN-TP-01..RN-TP-06` (vigencias, par concepto↔servicio, $0, concurrencia, R5, frontera) |
| `apps/api/src/modules/flito-parametrizacion/flito-tarifas-proveedor.routes.ts` | Completar traducción de errores, `audit()`, `capacidades`, `no-store` |
| `apps/api/__tests__/db/flito-tarifas-proveedor-esquema.test.ts` | Crear: CHECK de par (R2), `valor >= 0` (R3), única abierta, EXCLUDE, cierre/rango, FK RESTRICT a proveedor y users (R5), coincidencia `CONCEPTOS_DE_SERVICIO` ↔ CHECK |
| `apps/api/__tests__/services/flito-tarifas-proveedor.test.ts` | Crear: filas por servicios vigentes (1 / 2 / 3, servicio agregado → «Sin configurar», perfil eliminado → fuera) (R2); fijar, cambiar, cerrar, $0 ≠ sin configurar, mismo instante cierre/apertura, nunca se borra, historial con fijó/cerró (R4); inactivo/eliminado/servicio quitado conserva historial y no lista (R5); dos PATCH simultáneos → uno 200 y otro `TarifaProveedorCambiadaError`, dos POST simultáneos → uno 201 y otro 409, PATCH con vigencia ya cerrada → 409 (R6); escritura en servicio no prestado → 422 (R2); `flito_tarifas_vigencias` intacta tras operar (R1) |
| `apps/api/__tests__/services/flito-tarifas-proveedor.routes.test.ts` | Crear (supertest): 400 con mensaje literal de R3 (vacío, null, `-1`, texto); 409 con `code` y mensaje literal de R6; 404; 403 sin función; sin `crear` → POST 403 y `capacidades.editar=false`; **enlace `proveedor` (y `compania`) con las funciones concedidas → 403 en las 5 rutas** (R7); `audit()` llamado en las 3 mutaciones; respuesta sin NIT ni contacto |

Comando P1: `npm test -w apps/api -- __tests__/db/flito-tarifas-proveedor-esquema.test.ts __tests__/services/flito-tarifas-proveedor.test.ts __tests__/services/flito-tarifas-proveedor.routes.test.ts`.

### Bloque FRONTEND (paralelo, `frontend-agent`, tras el «ok» humano al mockup de `ux-agent`)

| Archivo | Acción |
|---|---|
| `apps/web/src/pages/FlitoTarifas.tsx` (410) | Modificar: selector «Clientes · Proveedores» (`FlitPillGroup`) que navega entre `/flito/tarifas` y `/flito/tarifas/proveedores`; delega la pestaña en `TarifasProveedores`. Presupuesto **≤ +30 líneas** (techo 800 holgado) |
| `apps/web/src/pages/tarifas/TarifasProveedores.tsx` | Crear: lista de proveedores activos con «Faltan n» + panel del elegido (sin preselección, como el vecino); 4 estados |
| `apps/web/src/pages/tarifas/CostosProveedor.tsx` | Crear: filas por concepto (Sin configurar / valor / $0), fijar, cambiar, dejar de cobrar; aviso de página en 409 con recarga; validación R3 con el mensaje de shared-types |
| `apps/web/src/pages/tarifas/HistorialCostosProveedor.tsx` | Crear: tabla valor · desde · hasta («Vigente») · fijó · cerró, filtro por concepto; 4 estados |
| `apps/web/src/lib/tarifas-proveedor.ts` | Crear: `RUTA_TARIFAS_PROVEEDORES`, normalizadores y `faltantes` — llamadas por el `api` genérico de `src/lib/api.ts` (no se modifica `api.ts`, 670 líneas) |
| `apps/web/src/App.tsx` | Modificar: 2 `<Route>` `/flito/tarifas/proveedores` y `/flito/tarifas/proveedores/:proveedorId` con `ProtectedRoute page="flito_tarifas"` + el `lazy` existente (rutas estáticas ganan a `/:companiaId` en RR6). UUID de empresa en la URL: permitido (§14, no es persona) |
| `apps/web/src/content/ayuda/flito_tarifas.md` | Modificar (skill `flit-ayuda-flito`): delta de la pestaña Proveedores |
| `apps/web/e2e/tests/flito-tarifas-proveedores.spec.ts` | Crear: fijar / cambiar / $0 / dejar de cobrar / historial / mensaje R3 |

Ningún archivo de FRONTEND aparece en BACKEND ni viceversa; `shared-types` solo se escribe en CONTRATO.

### Paralelismo con otros Features

Este Feature toca `db/schema/flito-proveedores.ts`, `app.ts`, `catalogo-operaciones.ts`, `App.tsx`, `shared-types/index.ts` y la numeración de migraciones: **no** se paraleliza con otro Feature que toque cualquiera de ellos (en particular, cualquier trabajo pendiente de ADR-0039 F5 sobre proveedores).

## 10. Estimación de tamaño

| Bloque | Líneas de producto (aprox.) |
|---|---|
| CONTRATO (migración ~45, esquema ~25, shared-types ~70, stubs de router/servicio ~60, app.ts +2, catálogo +5) | ~210 |
| BACKEND (servicio ~300, router ~150 netas sobre el stub) | ~420 |
| FRONTEND (TarifasProveedores ~250, CostosProveedor ~260, HistorialCostosProveedor ~150, lib ~80, FlitoTarifas +30, App +2, ayuda ~30) | ~800 |
| **Total** | **~1 430** (tests aparte, ~700) |

Por debajo de ~1 500 y sin backend de riesgo (sin PII, sin auth nueva, sin multer): **un solo PR** del Feature. Si al integrar supera 1 500 líneas de producto, partir en **PR 1 = CONTRATO + BACKEND** y **PR 2 = FRONTEND**, declarado en el cuerpo.

## 11. Notas operativas por agente

- **backend-agent:** copiar la transición abrir/cerrar de `flito-tarifas.service.ts` (`cambiarOCerrar`, `fijarTarifa`) — mismo `now()` en las dos escrituras, valor anterior leído en la transacción con `FOR UPDATE`, nunca del body. Bloquear padre y perfil con `FOR SHARE` antes de la vigencia (orden de ADR-0039 §4.3). Mapear 23505 y 23P01 de esta tabla al 409 de R6. `valor` sale de `numeric` como string: convertir a `number` en un solo punto. `audit()` tras el commit, `detail` sin datos de contacto. No exportar nada que lea esta tabla hacia otros módulos (R8). Sin `logPiiAccess` (D10): comentarlo en la cabecera del router.
- **frontend-agent:** pestaña dentro de la página existente; no crear `PageSlug`. El 409 va en **aviso de página** con botón «Recargar» (estado persistente), no solo toast. `$0` se muestra como «$ 0» y «Sin configurar» como estado distinto. Utilidades del kit `components/flit/`, sin HEX (R9). No preseleccionar proveedor.
- **db-review-agent:** revisar §4.1 (EXCLUDE con `uuid`, CHECK de par, RESTRICT) y la idempotencia.
- **security-agent:** dispara por rutas nuevas. Foco: frontera (enlace `proveedor`/`compania` → 403), que ninguna respuesta abierta al proveedor incluya costos, y que no se proyecte NIT/contacto.
- **ux-agent:** slim (extensión de pantalla) — pestaña Proveedores, estados «Sin configurar» vs «$0», aviso de 409.

## 12. Riesgos abiertos y qué falta decidir (pendiente humano)

- **P-1 — Quitar un servicio con costo vigente.** Propuesta D7: la vigencia abierta queda latente (no se cierra) y, si el servicio se vuelve a agregar, la fila reaparece **con su último valor**, no en «Sin configurar». Alternativa: cerrarla en la misma transacción de `quitarServicio` (toca `flito-proveedores-servicios.service.ts` de ADR-0039) para que el historial muestre «hasta» = fecha del retiro y al reagregar aparezca «Sin configurar». R2 dice «al agregarle un servicio aparecen sus filas en Sin configurar»: confirmar si eso incluye **re**-agregar.
- **P-2 — Proveedor inactivo.** Propuesta D6: no se lista y se rechaza la escritura (409); su vista e historial siguen consultables. Confirmar que no se quiere poder ajustar costos de un proveedor inactivo.
- **P-3 — Confirmación de $0.** Propuesta D4: sin confirmación. Confirmar o pedir el mismo `confirmarCero` de la tarifa al cliente.
- **R-1:** las descripciones de `parametrizacion.tarifas.listar` («lo que se le cobra a cada compañía») no mencionan proveedores. Cambiarlas exigiría tocar la siembra de `permisos_funciones`; se deja como deuda visible (Nota), no en este Feature.
- **R-2:** un administrador puede conceder `accion.tarifas.*` a un rol con enlace `proveedor` (el panel solo avisa). La frontera lo anula por HTTP; si se quiere bloqueo duro en el panel, es otro cambio sobre permisos, fuera del alcance.

---

## 13. Enmienda 1 — Costo de proveedor en el trámite (Propuesta)

- **Estado:** Propuesto (pendiente de aprobación del Líder Técnico). No supersede ADRs aceptados; reescribe la R8 de este mismo ADR, que sigue Propuesto.
- **Origen:** decisión del humano en sesión (C1–C8). Sin Azure DevOps por instrucción explícita.
- **Módulos que habla:** FLITO `finanzas` (reporte de costos: `/api/finanzas/reporte-costos*`, montado **sin** `conAlcance`), `flito-liquidacion` (sellado), `flito-parametrizacion` (solo lectura de `flito_tarifas_proveedor_vigencias` vía `vigenteEn`). Lee, sin modificar, `flito_soat`, `flito_logistica_*`. **No toca** legacy `liquidacion`, `soat`, `tramites`, ni Siigo/facturación, ni `flito_tarifas_vigencias`.

### 13.1 R8 reescrita

> **R8 (nueva).** El costo de proveedor es un valor **informativo** del trámite: se muestra en el reporte de costos (tabla de detalle, columnas configurables y Excel) y se congela en el `detalle` de la liquidación al sellar. **Nunca** entra en `EXPR_TOTAL`, `EXPR_BASE_GMF`, subtotales RN-02 (reintegro/servicio), `TotalesReporte`, consolidado de cobro, `faltantes`, `EXPR_BLOQUEADA`, `noConfigurados`, salidas de bolsa ni Siigo. Ninguna ruta abierta a un enlace (`proveedor`, `compania`, `organismos_transito`) lo proyecta.

Consecuencias en el resto del ADR: la nota de §11 «no exportar nada que lea esta tabla» queda sustituida por §13.4 (un único lector: `finanzas.costos-proveedor.ts`). D7 (vigencia latente al quitar un servicio) sigue igual: la vigencia la elige la **fecha del evento**, no el servicio vigente hoy; un acta de un proveedor al que luego se le quitó el servicio sigue costando lo que estaba vigente ese día.

### 13.2 Reglas (C1–C8, del humano) y su lectura técnica

| # | Regla | Cómo se implementa |
|---|---|---|
| C1 | Columnas nuevas, no suman | Campos nuevos en `FilaReporte`; ninguna `EXPR_*` existente los referencia. Test de no-regresión: mismo universo con y sin vigencias de proveedor ⇒ `total`, `gmf`, `totalReintegro`, `totalServicio`, `TotalesReporte` y consolidado **idénticos** |
| C2 | SOAT con trámite | `flito_tramites.soat_id → flito_soat.proveedor_soat_id`; vigencia `soat_con_tramite` en `COALESCE(flito_soat.enviado_en, now())` (misma forma que RN-07 con `fecha_aprobacion`; ver duda H-1). `gestion_operaciones = true` ⇒ `gestionado_operaciones`; sin proveedor, sin SOAT o FLITO no gestiona el SOAT (`GESTIONA_SOAT` falso) ⇒ `sin_proveedor` |
| C3 | SOAT compartido | «Primero» = el trámite con menor `(created_at, id)` entre los que tienen ese `soat_id` (todos, sin filtrar por el reporte). Los demás ⇒ `ya_contado` con `contadoEnTramiteId` / `contadoEnIdFlit`. Determinista y estable: `created_at` no cambia en el resync |
| C4 | Logística, valor fijo por trámite | Primera entrega (`ORDER BY a.entregado_en, a.id`) de una línea `flito_logistica_traslado_lts.estado='entregado'` de un documento `tipo='licencia_transito'` del trámite (cualquier destino, `flit` o `cliente`, igual que `cobra()` de `trasladosDe`). Proveedor = `flito_logistica_actas.proveedor_logistica_id` del acta del traslado (una por traslado: `actaDeTraslado`). Vigencia `logistica` en `a.entregado_en`. **Exclusión del proveedor por defecto falso** (ADR-0039 §1.1): el **mismo** criterio que `actasDelProveedor` (`flito-logistica.alcance.ts:46-51`) — traslado `legado` o acta con `created_at` anterior a `flito_logistica_corte_proveedor.corte_en` ⇒ esa entrega no tiene proveedor válido. Si la **primera** entrega está excluida o tiene proveedor NULL ⇒ `sin_proveedor` (ver duda H-3). `GESTIONA_LOGISTICA` falso (autogestionada sin excepción) ⇒ `sin_proveedor`. Viajes adicionales y entregas posteriores no cambian el valor |
| C5 | SOAT sin trámite | Fuera. El concepto `soat_sin_tramite` no se lee |
| C6 | Congelar al sellar | `liquidar()` escribe `detalle.costosProveedor` (§13.6). Sellados anteriores sin la clave ⇒ cálculo en vivo con `estado='estimado'` cuando el vivo da valor (§13.5) |
| C7 | «Sin configurar» avisa | Estado propio `sin_configurar` (proveedor resuelto, sin vigencia en la fecha del evento). No entra en `EXPR_BLOQUEADA`, `EXPR_INCOMPLETA`, `filasIncompletas`, `noConfigurados` ni `faltantes`. Filtro nuevo `costoProveedorSinConfigurar` |
| C8 | El proveedor no lo ve | `/api/finanzas/*` y `/api/flito/liquidacion/*` se montan **sin** `conAlcance` (`app.ts:293,320`) ⇒ `guardiaFrontera` (`frontera-enlace.ts:199-221`) da 403 a todo enlace ≠ `ninguno`, aunque su rol tenga `finanzas.reporte_costos.ver`. Verificado en código; se fija con test (§13.9). Ninguna ruta con `conAlcance` lee `costosProveedor` ni la tabla de vigencias. `LiquidacionDto` **no** expone la clave (§13.6) |

### 13.3 Alternativas para el cálculo

#### Opción A — Expresiones SQL correlacionadas, compuestas en `SELECT_FILA` desde un archivo propio (RECOMENDADA)

Un `jsonb_build_object` por concepto (una subconsulta escalar correlacionada para SOAT y otra para logística), con `CASE` sellado/vivo, exportado como `SELECT_COSTOS_PROVEEDOR` y `EXPR_*` desde `finanzas.costos-proveedor.ts`. Es exactamente el patrón de `SELECT_CONCILIACION_SOAT` y `SELECT_VALORES_DOCUMENTALES` (subconsultas correlacionadas, no joins, para no multiplicar filas).

| | |
|---|---|
| **Pros** | Una sola definición para página, exportación (20 000 filas), filtro `sin_configurar` y conteo: el filtro pagina bien porque está en el `WHERE`. Las subconsultas escalares en el `SELECT` solo se evalúan para las filas proyectadas (50 por página): el conteo y los totales no las pagan salvo con el filtro activo. Sin cambios en `conJoins` (no altera el plan de conteo/totales/consolidado). El sellado reutiliza la misma expresión vía una consulta mínima (`flito_tramites ⟕ flito_soat` por id), sin duplicar la regla en TS |
| **Contras** | SQL largo; el `jsonb` se parsea en `aFila`. Las expresiones necesitan `GESTIONA_SOAT`/`GESTIONA_LOGISTICA`, que viven en `finanzas.service.ts` → se pasan como parámetro (función fábrica) para no crear el ciclo de imports `flito-liquidacion → costos-proveedor → finanzas.service → flito-liquidacion` |
| **Esfuerzo** | **M** |
| **Riesgos** | Rendimiento con el filtro activo sobre el universo entero (N × 2 subconsultas indexadas). Mitigado con el índice de §13.8 y medido con `EXPLAIN ANALYZE` en la BD local (nota a backend) |

#### Opción B — Vista `flito_costos_proveedor_tramite_v` (una fila por trámite) unida en `conJoins`

| | |
|---|---|
| **Pros** | SQL legible y reutilizable por cualquier lector; consultable a mano |
| **Contras** | La regla queda en una migración: cada ajuste (H-1..H-4) es `CREATE OR REPLACE VIEW` nueva y deriva entre el SQL en disco y el TS. No puede usar `vigenteEn` ni `GESTIONA_*` (que son TS): se duplican en SQL y divergen. Unirla en `conJoins` la mete también en el conteo, los totales y el consolidado (LEFT JOIN de vista no se elimina si tiene agregados/`DISTINCT ON`) |
| **Esfuerzo** | **M** |
| **Riesgos** | Medios: dos definiciones de «gestiona» (lo que AGENTS y la cabecera de `finanzas.service.ts` piden evitar). Drift de vista en un rollout con pods viejos |

#### Opción C — Función TS por lote (`costosProveedorDe(tramiteIds[])`) tras paginar

| | |
|---|---|
| **Pros** | Lógica en TS, fácil de testear unitariamente; consultas simples |
| **Contras** | El filtro `sin_configurar` (C7) no se puede aplicar en el `WHERE`: o rompe la paginación (filtrar después de paginar) o obliga a calcular todo el universo en memoria. La exportación (20 000 filas) necesita lotes. El sellado y el reporte podrían divergir si el lote y la consulta de `liquidar()` no comparten el SQL |
| **Esfuerzo** | **S–M** |
| **Riesgos** | Altos para C7: filtro que miente sobre el total |

**Decisión recomendada: Opción A.** Qué la cambiaría: que el humano pidiera **sumar** costos de proveedor en `TotalesReporte` o en el consolidado sobre el universo entero (hoy C1 lo excluye); entonces se mediría y, si no cabe, se pasaría a una columna materializada en una migración aparte.

### 13.4 Expresiones (para `backend-agent`; esbozo, no código final)

Archivo nuevo `apps/api/src/modules/finanzas/finanzas.costos-proveedor.ts`. Imports: esquema, `vigenteEn` (de `flito-tarifas.service.ts`, que no importa finanzas: sin ciclo). **No** importa `finanzas.service.ts`.

```ts
export function exprCostosProveedor(g: { gestionaSoat: SQL; gestionaLogistica: SQL }): { soatVivo: SQL; logisticaVivo: SQL };
export function exprCostosProveedorReporte(g): { soat: SQL; logistica: SQL };   // CASE sellado / vivo + 'estimado'
export const SELECT_COSTOS_PROVEEDOR /* fábrica: { costoProveedorSoat, costoProveedorLogistica } jsonb */;
export const EXPR_COSTO_PROVEEDOR_SIN_CONFIGURAR /* fábrica */;
export function costosProveedorDeFila(r): Pick<FilaReporte, 'costoProveedorSoat' | 'costoProveedorLogistica' | 'costoProveedorTotal'>;
export async function costosProveedorParaSellar(ej: Ejecutor, tramiteId: string, g: { gestionaSoat: boolean; gestionaLogistica: boolean }): Promise<CostosProveedorSellados>;
```

SOAT vivo (orden de los `WHEN` = prioridad de estados):

```sql
CASE
  WHEN t.soat_id IS NULL OR NOT <GESTIONA_SOAT>                  THEN {estado:'sin_proveedor'}
  WHEN s.gestion_operaciones                                     THEN {estado:'gestionado_operaciones'}
  WHEN s.proveedor_soat_id IS NULL                               THEN {estado:'sin_proveedor'}
  WHEN p1.id <> t.id  -- p1 = (SELECT id, id_flit FROM flito_tramites WHERE soat_id = t.soat_id ORDER BY created_at, id LIMIT 1)
                                                                 THEN {estado:'ya_contado', contadoEnTramiteId, contadoEnIdFlit}
  ELSE (SELECT jsonb_build_object('estado', CASE WHEN v.id IS NULL THEN 'sin_configurar' ELSE 'costo' END,
          'proveedorId', p.id, 'proveedor', p.nombre, 'vigenciaId', v.id, 'valor', v.valor,
          'fechaReferencia', COALESCE(s.enviado_en, now()))
        FROM flito_proveedores p
        LEFT JOIN flito_tarifas_proveedor_vigencias v ON v.proveedor_id = p.id AND v.concepto = 'soat_con_tramite'
             AND <vigenteEn(v, s.enviado_en)>
        WHERE p.id = s.proveedor_soat_id)
END
```

Logística vivo:

```sql
CASE WHEN NOT <GESTIONA_LOGISTICA> THEN {estado:'sin_proveedor'}
ELSE COALESCE((
  SELECT CASE
      WHEN tr.legado OR a.created_at < (SELECT corte_en FROM flito_logistica_corte_proveedor)
           OR a.proveedor_logistica_id IS NULL                     THEN {estado:'sin_proveedor'}
      ELSE jsonb_build_object('estado', CASE WHEN v.id IS NULL THEN 'sin_configurar' ELSE 'costo' END,
             'proveedorId', p.id, 'proveedor', p.nombre, 'vigenciaId', v.id, 'valor', v.valor,
             'fechaReferencia', a.entregado_en) END
  FROM flito_logistica_documentos d
  JOIN flito_logistica_traslado_lts l ON l.documento_id = d.id AND l.estado = 'entregado'
  JOIN flito_logistica_traslados tr   ON tr.id = l.traslado_id
  JOIN flito_logistica_actas a        ON a.traslado_id = tr.id AND a.entregado_en IS NOT NULL
  LEFT JOIN flito_proveedores p       ON p.id = a.proveedor_logistica_id
  LEFT JOIN flito_tarifas_proveedor_vigencias v ON v.proveedor_id = p.id AND v.concepto = 'logistica'
       AND tstzrange(v.vigente_desde, v.vigente_hasta, '[)') @> a.entregado_en
  WHERE d.tramite_id = t.id AND d.tipo = 'licencia_transito'
  ORDER BY a.entregado_en, a.id
  LIMIT 1), {estado:'sin_proveedor'})
END
```

`{estado:'x'}` = `jsonb_build_object('estado','x', …resto en null)`: el objeto tiene **siempre** las mismas claves (contrato estable). Si el corte aún no existe en el ambiente (tabla vacía), la subconsulta da NULL y la comparación no excluye — mismo comportamiento que `desdeElCorte`; la 0298 lo siembra en todos los ambientes.

Reporte (sellado manda, como `EXPR_*`; sin `COALESCE(sellado, vivo)` ciego):

```sql
CASE
  WHEN liq.id IS NOT NULL AND jsonb_typeof(liq.detalle->'costosProveedor'->'soat') = 'object'
    THEN liq.detalle->'costosProveedor'->'soat'
  WHEN liq.id IS NOT NULL   -- sellado sin la clave, o concepto no congelado (null, §13.6)
    THEN CASE WHEN <vivo>->>'estado' = 'costo' THEN <vivo> || '{"estado":"estimado"}' ELSE <vivo> END
  ELSE <vivo>
END
```

`EXPR_COSTO_PROVEEDOR_SIN_CONFIGURAR` = `(soat->>'estado' = 'sin_configurar' OR logistica->>'estado' = 'sin_configurar')`. Para no evaluar dos veces el `jsonb` en `WHERE` y `SELECT`, aceptable (solo con el filtro activo); si el `EXPLAIN` lo pide, envolver la consulta paginada en un CTE.

### 13.5 Contrato (shared-types + `FilaReporte`)

En `packages/shared-types/src/flito-tarifas-proveedor.ts` (ya existe en la rama `-api`; se amplía, no se crea otro archivo):

```ts
export const ESTADOS_COSTO_PROVEEDOR = ['costo', 'sin_configurar', 'sin_proveedor', 'gestionado_operaciones', 'ya_contado', 'estimado'] as const;
export type EstadoCostoProveedor = (typeof ESTADOS_COSTO_PROVEEDOR)[number];
/** Estados que se congelan al sellar (`estimado` solo existe al leer un sello sin la clave). */
export type EstadoCostoProveedorSellado = Exclude<EstadoCostoProveedor, 'estimado'>;
export const ETIQUETA_ESTADO_COSTO_PROVEEDOR: Readonly<Record<EstadoCostoProveedor, string>>;
// 'Sin configurar' · 'Sin proveedor' · 'Gestionado por Operaciones' · 'Ya contado en el trámite {idFlit}' (la UI interpola) · 'Estimado'
export interface CostoProveedorConcepto {
  estado: EstadoCostoProveedor;
  proveedorId: string | null;  proveedor: string | null;   // nombre de la empresa; sin NIT/contacto (D10)
  vigenciaId: string | null;   valor: number | null;       // valor != null ⇔ estado ∈ {costo, estimado}
  fechaReferencia: string | null;                          // ISO: enviado_en (SOAT) o entregado_en (logística) usada
  contadoEnTramiteId: string | null; contadoEnIdFlit: string | null;  // solo ya_contado
}
export interface CostosProveedorSellados {                  // detalle.costosProveedor
  version: 1;
  soat: (CostoProveedorConcepto & { estado: EstadoCostoProveedorSellado }) | null;
  logistica: (CostoProveedorConcepto & { estado: EstadoCostoProveedorSellado }) | null;
}
```

`FilaReporte` (API, `finanzas.service.ts`) hereda una interfaz nueva `CostosProveedorDeFila` (patrón de `ConciliacionSoatDeFila`, para que el compilador exija rellenarla en `aFila`):

```ts
costoProveedorSoat: CostoProveedorConcepto;
costoProveedorLogistica: CostoProveedorConcepto;
/** Σ de los `valor` no nulos; null si ninguno tiene valor. Informativo: no entra en `total` (C1). */
costoProveedorTotal: number | null;
```

`FiltrosReporte += costoProveedorSinConfigurar?: boolean` — query `costoProveedorSinConfigurar=true` en `GET /reporte-costos`, `/consolidado`, `/facturacion-electronica` (los comparte `filtrosDe`) y el mismo campo en el body de `POST /reporte-costos/export`. Booleano, sin PII. El consolidado lo acepta como filtro del universo pero **no** suma costos (C1). OpenAPI: `npm run contrato:generar`.

Excel (`COLUMNAS_EXPORT_DETALLE`): siete columnas **al final** (Financiero pega el libro sobre el suyo; insertar en medio desplaza sus fórmulas): `Proveedor SOAT`, `Costo proveedor SOAT`, `Estado costo SOAT`, `Proveedor logística`, `Costo proveedor logística`, `Estado costo logística`, `Total costo proveedor`. Celda de valor vacía (no 0) cuando no hay valor, como el resto del libro. La hoja `Consolidado` no cambia.

### 13.6 `detalle` de la liquidación

`liquidar()` (dentro de la transacción, con `tx`) llama a `costosProveedorParaSellar(tx, tramiteId, { gestionaSoat, gestionaLogistica })` — los dos booleanos salen del mismo `calcular()` previo (la regla «gestiona» que ya decide si SOAT/logística bloquean), y la consulta usa las **mismas** expresiones vivas de §13.4. Se añade al objeto `detalle`:

```ts
detalle.costosProveedor = { version: 1, soat, logistica }   // CostosProveedorSellados
```

- Un concepto se congela con su estado **solo si es definitivo**: `costo`, `sin_configurar`, `gestionado_operaciones`, `ya_contado`, y `sin_proveedor` cuando no depende de un evento futuro (FLITO no gestiona / sin SOAT / entrega excluida). Si a la hora de sellar el evento aún no ocurrió (logística sin ninguna entrega; SOAT sin `enviado_en` si H-1 se resuelve así), el concepto se guarda `null` = «no congelado» y el reporte lo calcula en vivo marcado `estimado` cuando dé valor. **Duda H-2.**
- No cambia `total`, `baseGmf`, `valorGmf`, columnas `valor_*`, `faltantes`, salidas de bolsa ni consumo de tránsito. `flito_liquidacion_eventos.snapshot` lo hereda (`{...detalle}`): interno, aceptable.
- `aDto` / `LiquidacionDto` **no** cambian: nadie pidió verlo en la pantalla de liquidación y así ninguna ruta de liquidación lo proyecta (C8). Siigo lee claves concretas (`serviciosAdicionales->items`): la clave nueva no le afecta.
- Lectura de sellados viejos (sin `costosProveedor`): §13.4, `estimado`. Mismo espíritu que `viajes`/`traslados` en `aDto:807-823` (la ausencia de clave no se lee como «cero»), con la diferencia pedida por C6: aquí se calcula en vivo en lugar de `null`.
- Reversar la liquidación borra el sello ⇒ vuelve a vivo, sin cambio de código.

### 13.7 Diagrama del cálculo

```mermaid
sequenceDiagram
  autonumber
  participant W as Web (Reporte de costos)
  participant R as finanzas.routes
  participant F as finanzas.service (SELECT_FILA)
  participant C as finanzas.costos-proveedor
  participant DB as PostgreSQL
  participant L as flito-liquidacion.liquidar

  W->>R: GET /api/finanzas/reporte-costos?costoProveedorSinConfigurar=true
  R->>R: authMiddleware + guardiaFrontera (enlace=ninguno, si no 403) + exigirFuncion(reporte_costos.ver)
  R->>F: reporteCostos(filtros)
  F->>C: exprCostosProveedorReporte({GESTIONA_SOAT, GESTIONA_LOGISTICA})
  F->>DB: SELECT … , costoProveedorSoat(jsonb), costoProveedorLogistica(jsonb) WHERE … AND sin_configurar LIMIT 50
  DB->>DB: por fila: ¿sellado con clave? → detalle.costosProveedor
  DB->>DB: si no: SOAT = soat_id→proveedor_soat_id→¿primero (created_at,id)?→vigencia en enviado_en
  DB->>DB: logística = 1.ª entrega LT→acta (no legado, ≥ corte)→vigencia en entregado_en
  DB-->>F: filas
  F->>C: costosProveedorDeFila(r) (parse jsonb, total informativo)
  F-->>W: FilaReporte (total/GMF/RN-02 sin cambios)

  L->>DB: BEGIN; bloquear trámite; calcular (sin cambios)
  L->>C: costosProveedorParaSellar(tx, tramiteId, gestiona)
  C->>DB: SELECT expresiones vivas FROM flito_tramites ⟕ flito_soat WHERE id = $1
  L->>DB: INSERT flito_liquidaciones (detalle.costosProveedor = {version:1, soat, logistica}); COMMIT
```

### 13.8 Índices — migración `0301`

`flito_tramites.soat_id` **no tiene índice** (verificado: ni en el esquema ni en migraciones). La subconsulta de C3 corre por fila y, con el filtro `sin_configurar`, por todo el universo: sin índice es un seq scan de `flito_tramites` por fila.

```sql
-- 0301_flito_tramites_soat_orden.sql — ADR-0041 §13 (Épica #13763). C3: primer trámite por SOAT compartido.
CREATE INDEX IF NOT EXISTS idx_flito_tramites_soat_orden
  ON flito_tramites (soat_id, created_at, id) WHERE soat_id IS NOT NULL;
```

Sin `CONCURRENTLY` (el runner envuelve en transacción); el tamaño de `flito_tramites` lo hace un bloqueo breve en el rollout — `db-review-agent` lo confirma. Espejo Drizzle en `db/schema/tramites.ts` (`soatOrdenIdx`, `.where(sql\`… IS NOT NULL\`)`). Renumerar al integrar si `0301` está tomada.

Índices que **ya existen** y bastan: `uq_flito_log_doc_tramite_tipo (tramite_id, tipo)`, `idx_flito_log_traslado_lts_documento`, `idx_flito_log_actas_traslado`, PK de traslados y proveedores, `idx_flito_tarifas_prov_proveedor_concepto (proveedor_id, concepto, vigente_desde)` (la `EXCLUDE` gist también sirve al `@>`).

### 13.9 Archivos por bloque

Contrato y backend van **en serie** en un solo bloque (el contrato es pequeño y vive en la rama `-api`). FRONTEND después, en `-ui`. Ningún archivo en los dos bloques.

#### Bloque BACKEND — rama `FEATURE/13763-davidchica-tarifas-proveedores-api` (PR #772), `backend-agent`

| Archivo | Acción | Líneas prod. |
|---|---|---|
| `apps/api/src/db/migrations/0301_flito_tramites_soat_orden.sql` | Crear (§13.8) | ~8 |
| `apps/api/src/db/schema/tramites.ts` | Modificar: índice espejo | +2 |
| `packages/shared-types/src/flito-tarifas-proveedor.ts` | Modificar: tipos de §13.5 | +40 |
| `apps/api/src/modules/finanzas/finanzas.costos-proveedor.ts` | **Crear**: expresiones, parseo, `costosProveedorParaSellar`; cabecera con `RN-CP-01..08` = C1–C8 | ~220 |
| `apps/api/src/modules/finanzas/finanzas.service.ts` | Modificar: `FilaReporte extends CostosProveedorDeFila`, spread en `SELECT_FILA`, `aFila`, `FiltrosReporte` + condición. Hoy **448** líneas efectivas (no está en `FROZEN_CEILINGS`): queda ~475 | +25 |
| `apps/api/src/modules/finanzas/finanzas.routes.ts` | Modificar: `filtrosDe` y Zod del body de export con `costoProveedorSinConfigurar` | +4 |
| `apps/api/src/modules/finanzas/finanzas.export-excel.ts` | Modificar: 7 columnas al final + `filasExcelDetalle` | +20 |
| `apps/api/src/modules/flito-liquidacion/flito-liquidacion.service.ts` | Modificar: `detalle.costosProveedor` en `liquidar()`. Hoy **647** efectivas: queda ~660 | +12 |
| `contracts/openapi/flito-api.v1.yaml` | Regenerar (`npm run contrato:generar`) | gen. |

**No se tocan:** `finanzas.consolidado.ts`, `finanzas.gastos-diarios.ts`, `finanzas.reporte-columnas.ts` (no define columnas por defecto ni grupos: solo proyecciones de titular/organismo y `subtotalesDe`; los grupos y las columnas por defecto viven en la web, `TablaReporteCostos.tsx` `COLUMNAS`/`Grupo` + `localStorage`; y el Excel tiene un orden fijo pactado con Financiero, sin grupos), Siigo, `flito-tarifas.service.ts`, `app.ts`.

Tests P1 por regla:

| Regla | Test (crear o ampliar) |
|---|---|
| C2, C3, C4, C7 (SQL contra BD) | `apps/api/__tests__/services/finanzas-costos-proveedor.test.ts` (**crear**): SOAT con proveedor y vigencia en `enviado_en` (y otra vigencia posterior que no debe usarse); `gestion_operaciones`; sin proveedor; compañía autogestiona SOAT; SOAT compartido por 3 trámites ⇒ uno `costo`, dos `ya_contado` con el `idFlit` del primero, empate de `created_at` resuelto por `id`; logística: primera entrega con proveedor y vigencia en `entregado_en`, segunda entrega de otro proveedor ignorada, viaje adicional no cambia valor, traslado `legado` ⇒ `sin_proveedor`, acta anterior al corte ⇒ `sin_proveedor`, sin entregas ⇒ `sin_proveedor`, autogestionada ⇒ `sin_proveedor`; proveedor sin vigencia ⇒ `sin_configurar`; filtro `costoProveedorSinConfigurar` pagina y cuenta bien |
| C1 | mismo archivo: universo con y sin vigencias de proveedor ⇒ `total`, `gmf`, `totalReintegro`, `totalServicio`, `totales` y `consolidadoReporte` idénticos; `filasIncompletas`/etapa `listo` iguales con un `sin_configurar` |
| C6 | `apps/api/__tests__/services/flito-liquidacion-costos-proveedor.test.ts` (**crear**): `liquidar()` congela `costosProveedor` (version, proveedor, vigenciaId, valor, estado); cambiar la vigencia después no cambia lo sellado; sello sin la clave ⇒ reporte en vivo con `estimado`; concepto `null` (sin entrega al sellar) ⇒ vivo tras la entrega; `total`/`faltantes`/salidas iguales con y sin costos; `LiquidacionDto` sin la clave |
| C7 (sellado) | mismo archivo: `sin_configurar` no bloquea `liquidar()` |
| C8 | `apps/api/__tests__/services/finanzas-reporte-costos-proveedor.routes.test.ts` (**crear**, supertest): enlace `proveedor` y `compania` con `finanzas.reporte_costos.ver` concedida ⇒ 403 en `GET /reporte-costos`, `/consolidado`, `POST /reporte-costos/export` y `GET /api/flito/liquidacion/:id`, sin importes en el cuerpo; `ninguno` ⇒ 200 con los campos; query `costoProveedorSinConfigurar` mal formada ⇒ 400 |
| Excel | `apps/api/__tests__/services/finanzas.export-excel.test.ts` (**ampliar**): 7 columnas al final, celdas vacías sin valor, orden anterior intacto |

Comando P1: `npm test -w apps/api -- __tests__/services/finanzas-costos-proveedor.test.ts __tests__/services/flito-liquidacion-costos-proveedor.test.ts __tests__/services/finanzas-reporte-costos-proveedor.routes.test.ts __tests__/services/finanzas.export-excel.test.ts` + `build:api` (con heap) + `build -w packages/shared-types` + 0301 dos veces (P6).

Gates que dispara: `db-review-agent` (0301, `schema/tramites.ts`), `security-agent` (C8, filtros nuevos en rutas existentes), `qa-agent` B, `flit-code-review`.

#### Bloque FRONTEND — rama `FEATURE/13763-davidchica-tarifas-proveedores-ui` (PR #773), `frontend-agent`

Archivos que toca **solo por el costo de proveedor**, y cuáles toca también el rediseño de `docs/ux/flito-reporte-costos-rediseno.md` (spec de `ux-agent` en curso):

| Archivo (efectivas hoy) | Cambio por costo de proveedor | Lo toca el rediseño | Líneas costo |
|---|---|---|---|
| `apps/web/src/components/finanzas/tiposReporteCostos.ts` (112) | Campos de `FilaReporte` (tipos de shared-types) y filtro | **Sí** (filtros/periodo) | +15 |
| `apps/web/src/components/finanzas/TablaReporteCostos.tsx` (409) | `Grupo` nuevo `costo_proveedor` (encabezado «Costo de proveedor»), columnas: Proveedor SOAT · Costo SOAT · Proveedor logística · Costo logística · Total; celda con valor o etiqueta de estado (`ETIQUETA_ESTADO_COSTO_PROVEEDOR`, `ya_contado` con el `idFlit`, `estimado` con la marca de estimado ya usada); columnas configurables | **Sí** (grupos «Cobro al cliente»/«Costo de proveedor», columnas por defecto, «Columnas») | +60 |
| `apps/web/src/components/finanzas/FiltrosReporteCostos.tsx` (94) | Casilla «Costo de proveedor sin configurar» | **Sí** (una barra, un periodo, «Más filtros»: la casilla cae dentro) | +12 |
| `apps/web/src/pages/FinanzasReporteCostos.tsx` (461) | Estado del filtro → query del `api` y body de export | **Sí** (estado de filtros) | +8 |
| `apps/web/src/content/ayuda/finanzas_reporte_costos.md` | Delta (skill `flit-ayuda-flito`): qué es el costo, que no suma, estados | **Sí** | +20 |
| `apps/web/e2e/tests/finanzas-reporte-costos.spec.ts` | Columnas, estados, filtro | **Sí** | tests |

Sin cambio por costo: `TotalesReporteCostos.tsx` y `ConsolidadoReporteCostos.tsx` (C1: no suman), `ExportarReporteCostos.tsx` (si toma el objeto de filtros entero; si arma el body campo a campo, +1 línea — verificar), `App.tsx`, `src/lib/api.ts`.

**Los seis archivos coinciden con el rediseño**: costo y rediseño van en **un solo bloque FRONTEND y un solo `frontend-agent`**, implementando el costo sobre la estructura del rediseño (grupos y columnas por defecto de la spec). Hacer primero el costo con el `Grupo` actual y luego rehacer la tabla con el rediseño duplicaría el trabajo en `TablaReporteCostos.tsx`.

### 13.10 Estimación

| Bloque | Líneas de producto |
|---|---|
| BACKEND costo de proveedor (§13.9) | **~330** (tests aparte, ~700) |
| FRONTEND solo costo de proveedor | **~115** |
| FRONTEND rediseño (estimación sin la spec: tabla con grupos y por defecto ~150, barra única + «Más filtros» ~180, página ~80, ayuda ~30) | **~450–550**, a confirmar con la spec |

PR #772 (`-api`) pasa de ~630 a ~960 líneas de producto: un solo PR, pero ahora **mezcla backend de riesgo** (sellado de liquidación + migración) con lo ya revisado; se declara en el cuerpo. PR #773 (`-ui`) ya lleva ~800: costo + rediseño (~600) lo llevarían a ~1 400, rozando el umbral y mezclando dos pantallas. **Recomendación:** tercer PR `FEATURE/13763-davidchica-reporte-costos-ui` apilado sobre `-ui`, con el costo **y** el rediseño juntos (mismos seis archivos); #773 queda solo con Tarifas › Proveedores.

### 13.11 Notas operativas

- **backend-agent:** copiar la forma de `SELECT_CONCILIACION_SOAT` (spread en `SELECT_FILA`, interfaz heredada por `FilaReporte`). Fábricas con `GESTIONA_*` por parámetro para evitar el ciclo de imports. `vigenteEn` necesita `ColumnasVigencia`: comprobar que el alias de `flitoTarifasProveedorVigencias` cumple el tipo; si no, una línea `tstzrange … @> …::timestamptz` local con el mismo comentario de Bug #12682. `valor` del `jsonb` llega como número o texto: normalizar en `costosProveedorDeFila`. `EXPLAIN ANALYZE` en local de la página y de la exportación con el filtro activo; pegar los tiempos en el HANDOFF. No sumar nada a `TotalesReporte`.
- **frontend-agent:** sin `fetch` suelto; estados con texto, no solo color; `estimado` con la misma marca que las filas estimadas; 4 estados ya existentes de la página.
- **db-review-agent:** 0301 (índice parcial, bloqueo en rollout) y que no hay drift con `schema/tramites.ts`.
- **security-agent:** C8 (frontera de `/api/finanzas` y `/api/flito/liquidacion`), que el nombre del proveedor es de empresa (no PII), y que `costosProveedor` no aparece en rutas con `conAlcance`.

### 13.12 Dudas que cambian comportamiento (pendiente humano)

- **H-1 — SOAT con proveedor y aún no enviado** (`enviado_en` NULL). Propuesta: vigencia en `now()` (como RN-07 con la aprobación) y, al sellar, no congelar (`null`, vivo). Alternativa: `sin_proveedor` hasta que se envíe.
- **H-2 — Sellar antes del evento.** Un trámite puede liquidarse antes de su primera entrega (la logística solo exige la tarifa al cliente). Propuesta: el concepto se guarda `null` y se sigue calculando en vivo (`estimado`). Alternativa literal de C6: congelar `sin_proveedor` para siempre.
- **H-3 — Primera entrega excluida, entrega posterior válida.** Si la 1.ª entrega es `legado`/anterior al corte y hay otra posterior con proveedor real: propuesta `sin_proveedor` (C4 literal: el proveedor es el de la primera entrega). Alternativa: tomar la primera entrega **válida**.
- **H-4 — SOAT de un trámite que FLITO no gestiona** (compañía autogestiona sin excepción): propuesta `sin_proveedor`. Confirmar que no se quiere un estado «Autogestionado».
- **H-5 — SOAT compartido entre trámites de compañías distintas**: «primero» se mide entre todos los trámites del `soat_id`, sin importar compañía. Confirmar.
