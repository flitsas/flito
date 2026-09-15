# Diseño — Servicios adicionales por trámite: asignación, liquidación, reporte y factura (Feature #12544)

Modo **full**. Cubre las cuatro HUs a la vez (#12545 asignación · #12546 liquidación + reporte ·
#12547 Siigo · #12548 panel web) para que cada agente codee sin volver a explorar. Verificado sobre
el worktree `/home/david/flit/flito-serv-adic` (rama `HU/12545-…`, develop `e61b6dfe`, 2026-09-14).

Decisiones de producto que este diseño NO discute (David Chica, 2026-09-14): los servicios se
cobran como un concepto más de la liquidación (base del 4×1000 y total; congelado al sellar,
liberado al reversar); financieramente son **servicio** (cuentan en `totalServicio`); se asignan
desde el Reporte de costos; Excel: columna «Servicios adicionales» junto a «Modelo»; Siigo: concepto
`servicio_adicional`, semilla sin producto, **una línea por servicio** con `description` = nombre
sellado.

ADR asociado: [`docs/adr/ADR-0017-servicios-adicionales-snapshot-y-guarda-transaccional.md`](adr/ADR-0017-servicios-adicionales-snapshot-y-guarda-transaccional.md) (**Propuesto**).

---

## Contexto (lo que hay, medido)

| Pieza | Dónde | Lo que condiciona el diseño |
|---|---|---|
| Catálogo de tipos | `apps/api/src/db/schema.ts:3545` `flitoServiciosAdicionalesTipos`; `apps/api/src/modules/flito-parametrizacion/flito-servicios-adicionales.service.ts` | Baja lógica (`activo=false`), FKs a users `RESTRICT`, `valor numeric(14,2) CHECK >= 0`; los 3 tipos sembrados valen **0** (un servicio de valor 0 es legítimo). |
| Liquidación | `apps/api/src/modules/flito-liquidacion/flito-liquidacion.service.ts` (662 líneas) | `calcularDeFila()` arma 5 `ConceptoLiquidado` y `baseGmf = sumar(...)`; `liquidar()` calcula **fuera** de la transacción y sella dentro (`insert` + evento + bolsa del cliente + bolsa de tránsito); `reversar()` guarda `{...detalle, total}` como snapshot y borra la fila; `aDto()` lee `detalle[k] ?? { valor: columna, origen: 'Sellado' }`. |
| `flito_liquidaciones` | `schema.ts:3556` | Columnas `valor_*` nullable (`NULL` = no aplica), `detalle jsonb`, `tramite_id UNIQUE`. |
| Reporte de costos | `apps/api/src/modules/finanzas/finanzas.service.ts` (**760 líneas**, `max-lines` 800) | `seLiquido` es `const` privada; `EXPR_*` exportadas; `EXPR_BASE_GMF`/`EXPR_TOTAL` (l.207-216); `SELECT_FILA` compone `...SELECT_CONCILIACION_SOAT` y `...SELECT_COLUMNAS_REPORTE` desde archivos hermanos; **las columnas 1:n van por subconsulta correlacionada, nunca por join** (cabeceras de `finanzas.reporte-columnas.ts` y `finanzas.conciliacion-soat.ts`); `SELECT_TOTALES` agrega con `SUM(EXPR)`; `subtotalesDe()` (reporte-columnas) calcula `totalServicio = tramiteDigital ?? 0` en JS. |
| Consolidado | `finanzas.consolidado.ts` | `selectConsolidado = {claves, COUNT(DISTINCT), ...SELECT_TOTALES}` con `GROUP BY` de 3 claves; las sumas van dentro de `SUM()` → no entran al `GROUP BY`. `gruposHuerfanos()` vigila el 42803. |
| Excel | `finanzas.export-excel.ts` | `COLUMNAS_EXPORT_DETALLE` = 31 cabeceras literales; `'Modelo'` en índice 9. `filasExcelDetalle` mapea `servicio: f.totalServicio`. |
| Rutas finanzas | `finanzas.routes.ts`, montado en `/api/finanzas` (`app.ts:271`) | `LECTURA = requireRole('financiera','admin','auditor')` (única guarda: la valla legacy cuenta `finanzas: 1`). Vecino: `GET /tramites/:id/soportes` (404 `{ error: 'El trámite no existe' }`, `Cache-Control: no-store`). |
| Permisos | `permisos/inventario-guardas.ts` (`FICHEROS_EN_ALCANCE`, 23 ficheros), `catalogo.ts:104` (`catalogoDeOperaciones` lanza si hay operación huérfana), `permisos.service.ts:75` (`verificarCatalogoAlArrancar` **impide arrancar** si la base declara una función que el código no monta), `__tests__/services/permisos.reconduccion-cierre.test.ts` (20 `DIRECTORIOS_RECONDUCIDOS`, cero `requireRole(` en ellos, 244 montajes), `permisos.valla-legacy.test.ts:36` (`finanzas: 1`, y ningún fichero de `finanzas/` puede importar `exigir-funcion.js`). **No existe «fichero mixto»**. |
| Siigo | `packages/shared-types/src/siigo-facturacion.ts` (`CONCEPTOS_FACTURABLES` × `Record<ConceptoFacturable,…>` ×2), `siigo/siigo.compuerta.service.ts:64` (`conceptosAplicables` = columnas no nulas), `siigo/facturacion.armado.ts` (`lineasDe` 1 línea/concepto, `description: m.nombreProducto ?? label`), `siigo/facturacion.emision.service.ts:265` (`cargarTramites` arma `ValoresLiquidacion`), `siigo/facturacion.elegibilidad.service.ts:168` (idem), migración `0128` (semilla `CROSS JOIN (VALUES ('pruebas'),('produccion'))`, `ON CONFLICT DO NOTHING` contra `idx_siigo_mapeo_unico_activo`; **sin CHECK sobre `concepto`**). Web: `DialogoEnvioFacturacion.tsx` itera `CONCEPTOS_FACTURABLES`; `MapeoConceptos.tsx` lista lo que devuelve la API. |
| Bolsa del cliente | `flito-bolsas/flito-bolsas.service.ts:556` `SalidaConcepto.concepto: ConceptoBolsa`; `shared-types/flito-bolsas.ts:49` | `flito_bolsa_movimientos.concepto` es `varchar(30)` **sin CHECK**. La liquidación asienta una salida por concepto cobrable + GMF. **La Feature no menciona la bolsa** (ver riesgos). |
| Tests | `__tests__/helpers/db.ts` (`chain`, `chainReject`), `sql-ligado.ts` (`renderizar`, `gruposHuerfanos`, `vecesLigado`), `orden-sql.ts`, `keyed-db.ts` (`transaction` ejecuta el callback contra el mismo mock), `services/flito-servicios-adicionales.test.ts` (`grabando`/`espiando`), `services/flito-liquidacion.test.ts` (`transactionMock.mockImplementation(async (cb) => cb({ insert: txInsert }))`), `services/finanzas.reporte.test.ts` (`QueryBuilder` + `renderizar`). | El mock ignora `where`/`orderBy` y devuelve la fila entera: los predicados, el orden y la proyección se afirman sobre el **SQL renderizado**. |

---

## Alternativas

### A. Modelo: cómo se refleja en la liquidación lo asignado

#### Opción A1 — Columna `valor_servicios_adicionales` en `flito_liquidaciones` + lista en `detalle.serviciosAdicionales.items` (**recomendada**)

| | |
|---|---|
| Pros | Es exactamente el patrón de los otros cinco conceptos (`valor_* ` + `detalle[k]`): `aDto`, `reversar` (snapshot = `{...detalle}`), la elegibilidad y la compuerta de Siigo (`conceptosAplicables` sobre `ValoresLiquidacion`) y el reporte (`CASE WHEN seLiquido THEN columna`) lo absorben sin un join nuevo. La factura necesita la lista **solo al armar** (`cargarTramites`), y `detalle->'serviciosAdicionales'->'items'` es una lectura jsonb sin joins. El reverso ya conserva el snapshot completo en `flito_liquidacion_eventos`. |
| Contras | La lista sellada no es consultable en SQL con índices (no hace falta: nadie filtra por servicio sellado). Un `jsonb_array_length` en el reporte para la cantidad sellada. |
| Esfuerzo | **S** (migración de 1 columna, ~40 líneas en liquidación). |
| Riesgos | Que alguien edite `detalle` a mano: mismo riesgo que hoy con los otros cinco. |

#### Opción A2 — Tabla hija `flito_liquidacion_servicios_adicionales (liquidacion_id FK cascade, tipo_id, nombre, valor)`

| | |
|---|---|
| Pros | Lista sellada relacional; `SUM()` por SQL. |
| Contras | Rompe la simetría con los otros conceptos (la columna `valor_*` seguiría haciendo falta para `ValoresLiquidacion`); el reverso borra la fila de la liquidación → el `CASCADE` borra la lista y el snapshot del evento tendría que reconstruirla de todas formas; `cargarTramites` y el reporte ganan un join/agregado más; una tabla y una migración más. |
| Esfuerzo | **M**. |
| Riesgos | Dos verdades (columna + hija) que pueden descuadrar. |

#### Opción A3 — Sin columna: sumar siempre desde la puente, congelando con una marca `sellado_en` en la puente

| | |
|---|---|
| Pros | Una sola tabla. |
| Contras | La puente deja de poder borrarse físicamente (CF-04 dice que sí); un `UPDATE` masivo al sellar y al reversar; el reporte recalcula lo sellado desde filas vivas, que es justo lo que «sellar» prohíbe; Siigo tendría que leer la puente. |
| Esfuerzo | M. Riesgo alto de descuadre. Descartada. |

**Decisión: A1.** ¿Basta el jsonb para la factura? Sí: el armado es una función pura que recibe `TramiteFacturable`; `cargarTramites` añade `serviciosAdicionales: items` leyendo `detalle->'serviciosAdicionales'->'items'` y el armador valida que `Σ items.valor == valor_servicios_adicionales` (AC4 HU3, `servicios_no_cuadran`), que es la comprobación de sanidad que convierte al jsonb en fuente fiable.

### B. Guarda «trámite liquidado» atómica (asignar / quitar / liquidar)

La carrera real: `liquidar()` lee la puente y sella; `asignar()` comprueba «no liquidado» e inserta. Sin serialización, un servicio puede entrar en la puente **después** de que el sello lo leyera y **antes** del `COMMIT` del sello: liquidación sellada sin ese servicio, y la fila puente ya no se puede quitar (409). Comprobar dentro de una transacción no basta por sí solo (READ COMMITTED no serializa dos lecturas).

#### Opción B1 — `SELECT … FOR UPDATE` sobre la fila de `flito_tramites` en las tres transacciones (**recomendada**)

| | |
|---|---|
| Pros | Patrón ya usado en el repo (`flito-comparendos.gestion.service.ts:160`, `flito-bolsas.service.ts:234`, `flito-bolsas-transito.service.ts:424`, `.for('update')` de Drizzle, y el `chain` del mock ya expone `for`). La fila del trámite siempre existe (a diferencia de la de liquidación, que es justo lo que se está creando). El sync actualiza trámites en transacciones **por trámite** (`flito-sync.service.ts:118`), así que la espera mutua es de milisegundos. |
| Contras | `liquidar()` debe leer la puente **dentro** de su transacción (AC3 HU2 ya lo pide) y recomponer el cálculo ahí. |
| Esfuerzo | S. |

#### Opción B2 — `pg_advisory_xact_lock(hashtext(tramite_id))`

| | |
|---|---|
| Pros | No toca la fila del trámite (cero interacción con el sync). |
| Contras | Patrón nuevo en el repo; el mock no lo conoce (`execute`); invisible en el esquema. |
| Esfuerzo | S. Se descarta por la regla 5 (ya hay patrón equivalente). |

#### Opción B3 — Solo comprobar dentro de la transacción, sin bloqueo

Cubre «entre `liquidar` y `asignar` hay ventana» **solo a medias**: la comprobación y el INSERT quedan en la misma transacción (AC5), pero la carrera descrita arriba sigue abierta. Descartada.

### C. Reporte: subconsulta correlacionada vs LEFT JOIN agregado vs LATERAL

| Opción | Evaluación |
|---|---|
| **C1 Subconsulta correlacionada** `(SELECT SUM(valor) FROM puente WHERE tramite_id = t.id)` (**recomendada**) | Es el patrón del módulo (`delPrimerComprador`, `SELECT_CONCILIACION_SOAT`): no multiplica filas, no toca `conJoins` (que comparten conteo, página, totales, export, consolidado y **la elegibilidad Siigo**), no entra al `GROUP BY` del consolidado porque va dentro de `SUM()`. Con el índice `idx_flito_tramite_serv_adic_tramite` es un index-only scan por fila; el reporte pagina a 200 y el export topa en 20 000. Dos subconsultas por fila (suma y cuenta) es el coste. |
| C2 LEFT JOIN a un agregado `(SELECT tramite_id, SUM, COUNT … GROUP BY tramite_id) sa` en `conJoins` | Una pasada por la puente entera en cada consulta aunque el filtro pida 50 trámites; y modifica `conJoins`, que es compartido por 7 llamadores incluida la elegibilidad Siigo (`EXPR_DOC_COMPLETA` resuelve columnas contra esos joins). Más riesgo que beneficio. |
| C3 `LEFT JOIN LATERAL` | Mismo plan que C1 en Postgres para un agregado por fila, pero también toca `conJoins`, y Drizzle no tiene API de `lateral` (habría que meter SQL crudo en el builder). |

### D. Permisos: dónde viven las rutas nuevas (el conflicto que el qa-agent midió)

Hechos: `finanzas/` no está en `FICHEROS_EN_ALCANCE`; la valla (`finanzas: 1`) prohíbe importar
`exigir-funcion.js` en ese directorio; poner `finanzas.routes.ts` en alcance obliga a meter
`finanzas` en `DIRECTORIOS_RECONDUCIDOS`, donde no puede quedar ningún `requireRole(` (choca con
`LECTURA`); y una función sembrada que el catálogo no monte **impide arrancar el API**.

#### Opción D-a — Módulo nuevo reconducido `apps/api/src/modules/finanzas-servicios-adicionales/` con GET/POST/DELETE por `exigirFuncion`, el GET con `finanzas.servicios_adicionales.ver` (admin, financiera, auditor) (**recomendada**)

| | |
|---|---|
| Pros | Directorio nuevo = entra entero en `DIRECTORIOS_RECONDUCIDOS` (20→21) sin tocar la valla (`finanzas: 1` intacto, `finanzas.routes.ts` no cambia). Un recurso, un fichero, un modelo de guarda: el «auditor solo lee» queda **en el motor y editable desde el panel de roles**, no cableado. El `modulo` del catálogo sigue siendo `finanzas` (es una cadena libre: `flito-parametrizacion/` declara `parametrizacion`; las páginas del grupo «Finanzas» ya usan `finanzas`). |
| Contras | Desvío literal de AC2 («dos funciones») y AC3 («la misma `LECTURA`»): son **tres** funciones y el GET va por el motor. La intención (auditor lee, cliente 403, admin/financiera escriben) se conserva y la prueba de paridad la fija. La llave del catálogo es `finanzas-servicios-adicionales/finanzas-servicios-adicionales.routes.ts POST …` y no `finanzas/finanzas.routes.ts …`. |
| Esfuerzo | S (+ ~12 líneas en tests de permisos: 21 directorios, 24 ficheros, 247 montajes). |

#### Opción D-b — GET en `finanzas.routes.ts` bajo `LECTURA`; POST/DELETE en el módulo nuevo

| | |
|---|---|
| Pros | AC2/AC3 literales. |
| Contras | Un recurso partido en dos directorios con dos modelos de permiso; el módulo nuevo nace con 2 rutas y la lectura del panel no aparece en el panel de roles; si mañana se reconduce finanzas, el GET se muda otra vez. |
| Esfuerzo | S. |

#### Opción D-c — Reconducir `finanzas/` entero en la HU 1 (7 rutas → 7 funciones)

| | |
|---|---|
| Pros | Cierra la deuda del directorio. |
| Contras | Acopla la Feature a una decisión de producto que la valla exige explícita («reconducirlo exige decisión de producto»); +7 funciones, +21 filas de reparto, +7 en foto y fixture; memoria del equipo: «no acoplar Features sin relación», «corregir lo existente, no agregar». |
| Esfuerzo | M. |

**Decisión: D-a.** Se registra el desvío de AC2/AC3 para que el tech-lead ajuste el texto de la HU #12545 (o lo acepte como nota del PR).

---

## Decisión y justificación (resumen por punto del encargo)

| # | Decisión |
|---|---|
| 1 | Puente `flito_tramite_servicios_adicionales` (viva, DELETE físico) + **A1**: `flito_liquidaciones.valor_servicios_adicionales` + `detalle.serviciosAdicionales = { valor, origen, bloquea, items[] }`. |
| 2 | **B1**: `FOR UPDATE` sobre `flito_tramites` en `asignar`, `quitar` y `liquidar`; en `liquidar` la puente se lee tras el bloqueo y se recompone el cálculo con una función pura. Tests: `transactionMock.mockImplementation(async (fn) => fn(tx))` (patrón `flito-liquidacion.test.ts:145`). |
| 3 | Sexto `ConceptoLiquidado` `serviciosAdicionales` (`null` sin servicios, nunca bloquea); entra en `baseGmf` por `sumar()`; `liquidar()` copia `items` al `detalle`; `reversar()` **sin cambios** (el snapshot ya incluye `detalle` entero); `facturar()` sin cambios. |
| 4 | **C1** en un archivo hermano nuevo `finanzas.servicios-adicionales.expr.ts` (leaf, sin importar `finanzas.service.ts`); `SELECT_FILA` gana `serviciosAdicionales` + `serviciosAdicionalesCantidad`; `SELECT_TOTALES` gana `serviciosAdicionales` y lo suma en `totalServicio`; `EXPR_BASE_GMF` gana el sumando (y con él `EXPR_GMF`/`EXPR_TOTAL` para los NO sellados); Excel: columna 11 (índice 10), justo tras «Modelo». |
| 5 | `servicio_adicional` al final de `CONCEPTOS_FACTURABLES`; semilla 0195 con el `CROSS JOIN` de la 0128; armado: n líneas desde `tramite.serviciosAdicionales` con `description = item.nombre` (excepción explícita); elegibilidad: **sin código nuevo**, `conceptosAplicables` lo cubre porque la columna es `NULL` sin servicios. |
| 6 | Contratos HTTP abajo; `audit()` con `action: 'create'`/`'delete'` y `resource: 'flito_tramite_servicio_adicional'` (el `AuditAction` es un tipo cerrado; no se amplía). |
| 7 | `finanzas.service.ts` gana ~12 líneas (imports + 3 claves + 1 sumando); las `EXPR_*` nuevas viven en el archivo hermano. Ni `FICHEROS_EN_ALCANCE` ni el lector tocan `finanzas/`: el módulo nuevo es un directorio propio. |
| 8 | Tests P1 y mutantes al final. |

---

## Diagrama de secuencia (Mermaid)

```mermaid
sequenceDiagram
    autonumber
    participant W as Web (panel Reporte de costos)
    participant R as finanzas-servicios-adicionales.routes.ts
    participant S as finanzas-servicios-adicionales.service.ts
    participant DB as PostgreSQL
    participant L as flito-liquidacion.service.ts
    participant F as finanzas.service.ts (reporte)
    participant SG as siigo (emision/armado)

    W->>R: POST /api/finanzas/tramites/:id/servicios-adicionales { tipoId }
    R->>R: exigirFuncion('finanzas.servicios_adicionales.asignar') · Zod
    R->>S: asignar(tramiteId, tipoId, usuarioId)
    S->>DB: BEGIN · SELECT id FROM flito_tramites WHERE id=$1 FOR UPDATE
    S->>DB: SELECT 1 FROM flito_liquidaciones WHERE tramite_id=$1
    alt hay liquidación
        S-->>R: TramiteLiquidadoError → 409 TRAMITE_LIQUIDADO
    else
        S->>DB: SELECT tipo WHERE id=$2 AND activo
        alt no hay tipo activo
            S-->>R: TipoNoDisponibleError → 404 TIPO_NO_DISPONIBLE
        else
            S->>DB: INSERT puente (snapshot nombre/descripcion/valor) RETURNING
            alt 23505 (UNIQUE tramite_id, tipo_id)
                S-->>R: ServicioYaAsignadoError → 409 SERVICIO_YA_ASIGNADO
            else
                S->>DB: COMMIT
                R->>R: audit(create, flito_tramite_servicio_adicional)
                R-->>W: 201 TramiteServicioAdicional
            end
        end
    end

    W->>L: POST liquidar (ruta existente)
    L->>L: calcular() fuera de tx (faltantes; incluye la suma vigente de la puente)
    L->>DB: BEGIN · SELECT id FROM flito_tramites … FOR UPDATE
    L->>DB: SELECT tipo_id, nombre, valor FROM puente WHERE tramite_id ORDER BY asignado_en
    L->>L: conServiciosAdicionales(calculo, items) → baseGmf, gmf, total recompuestos
    L->>DB: INSERT flito_liquidaciones (valor_servicios_adicionales, detalle.items) · evento · bolsas
    L->>DB: COMMIT

    W->>F: GET /api/finanzas/reporte-costos
    F->>DB: SELECT … CASE WHEN liq.id IS NOT NULL THEN liq.valor_servicios_adicionales ELSE (SELECT SUM(valor) FROM puente …) END
    F-->>W: fila.serviciosAdicionales, serviciosAdicionalesCantidad; totales.serviciosAdicionales ⊂ totalServicio

    SG->>DB: cargarTramites: valor_servicios_adicionales + detalle->'serviciosAdicionales'->'items'
    SG->>SG: conceptosAplicables ∋ 'servicio_adicional' ⇔ columna NOT NULL
    SG->>SG: lineasDe: una línea por item { code: mapeo.codigoProducto, description: item.nombre, price: item.valor }
```

---

## Contrato de endpoints (HU #12545)

Montaje: `app.use('/api/finanzas', finanzasServiciosAdicionalesRoutes)` en `app.ts`, junto a la
línea 271 (el router propio lleva `router.use(authMiddleware)`; no hay solape de rutas con
`finanzas.routes.ts`, cuyo único `/tramites/:id/*` es `/soportes`).

Todo id (`:id`, `:asignacionId`, `tipoId`) que no sea uuid es **404** (patrón `idUuid` de
`flito-parametrizacion.routes.ts`), nunca 400 ni 22P02.

### `GET /api/finanzas/tramites/:id/servicios-adicionales` — `exigirFuncion('finanzas.servicios_adicionales.ver')`

- 200 `ServiciosAdicionalesDeTramite`:
  ```json
  { "items": [{ "id": "…", "tipoId": "…", "nombre": "Diagnóstico", "descripcion": null, "valor": 85000,
                "asignadoPorId": 5, "asignadoPorNombre": "Ana Pérez", "asignadoEn": "2026-09-14T15:00:00.000Z" }],
    "total": 125000, "liquidado": false }
  ```
  `items` en `ORDER BY asignado_en ASC, id ASC` (desempate estable; el aserto de orden va sobre el
  SQL renderizado). `total` = suma en JS de `items.valor` redondeada a centavos. `liquidado` =
  existe fila en `flito_liquidaciones` (cualquier estado). `Cache-Control: no-store` (como
  `/soportes`).
- 404 `{ "error": "El trámite no existe" }`.
- 403 por el motor (auditor **sí** entra; cliente no).

### `POST /api/finanzas/tramites/:id/servicios-adicionales` — `exigirFuncion('finanzas.servicios_adicionales.asignar')`

- Body Zod: `{ tipoId: z.string().uuid() }` (sin él o malformado → 400 `{ error }` sin tocar la base).
- 201 `TramiteServicioAdicional` (la fila recién insertada, con `asignadoPorNombre` del usuario que
  asigna, tomado de `req.user`/lectura de `users.name`).
- 404 `{ "error": "El trámite no existe" }`.
- 404 `{ "error": "El tipo de servicio adicional no existe o está dado de baja", "codigo": "TIPO_NO_DISPONIBLE" }`.
- 409 `{ "error": "Ese servicio ya está asignado a este trámite", "codigo": "SERVICIO_YA_ASIGNADO" }` (lo resuelve el UNIQUE: 23505 → 409, nunca 500).
- 409 `{ "error": "Reversa la liquidación para cambiar los servicios", "codigo": "TRAMITE_LIQUIDADO" }`.
- `audit(req, { action: 'create', resource: 'flito_tramite_servicio_adicional', resourceId: asignacion.id, detail: 'Servicio «Diagnóstico» (85000) asignado al trámite <idFlit>; tipo <tipoId>' })`.

### `DELETE /api/finanzas/tramites/:id/servicios-adicionales/:asignacionId` — `exigirFuncion('finanzas.servicios_adicionales.quitar')`

- 204 sin cuerpo; la fila desaparece (DELETE físico, justificado en CF-04: ninguna liquidación sellada la referencia, la sellada lleva su propia copia).
- 404 `{ "error": "El trámite no existe" }` / 404 `{ "error": "La asignación no existe en este trámite" }` (id inexistente **o de otro trámite**: el DELETE lleva `WHERE id = $1 AND tramite_id = $2`, 0 filas → 404).
- 409 `TRAMITE_LIQUIDADO` (mismo cuerpo que el POST).
- `audit(req, { action: 'delete', resource: 'flito_tramite_servicio_adicional', resourceId: asignacionId, detail: 'Servicio «Diagnóstico» (85000) quitado del trámite <idFlit>; tipo <tipoId>' })` — el `detail` lleva nombre y valor porque la fila ya no existe.

### Reporte (HU #12546) — delta de `GET /api/finanzas/reporte-costos` y `/consolidado`

- `FilaReporte` += `serviciosAdicionales: number | null` (sellado si `sellada`, suma vigente si no; `null` cuando no hay ninguno) y `serviciosAdicionalesCantidad: number` (0 si ninguno).
- `TotalesReporte` (y por herencia `TotalesConsolidado`/`FilaConsolidado`) += `serviciosAdicionales: number`; `totalServicio` lo incluye; `total` también (vía `EXPR_TOTAL`).
- Excel detalle: 32 columnas, `'Servicios adicionales'` en índice 10 (tras «Modelo»), formato dinero, `null` → celda vacía. El Excel del consolidado **no gana columna** (13, como dice su cabecera); su «Servicio» ya incluye el sumando (pendiente PO, ver riesgos).

### Siigo (HU #12547) — delta

- `GET /api/siigo/parametrizacion/mapeo-conceptos` lista «Servicio adicional» pendiente de producto por ambiente (sale solo de la semilla 0195 + `CONCEPTO_FACTURABLE_LABEL`); `PATCH` existente le asigna producto.
- Elegibilidad: `conceptosAplicables` incluye `servicio_adicional` ⇔ `valorServiciosAdicionales !== null`; sin mapeo/producto → `concepto_sin_mapeo`/`concepto_sin_producto` con etiqueta «Servicio adicional» (código existente).
- Armado: ver §Notas backend HU3.

---

## Modelo de datos (Drizzle)

### `flito_tramite_servicios_adicionales` (migración **0193**, HU 1)

```ts
/**
 * Servicios adicionales ASIGNADOS a un trámite (HU #12545, Feature #12544). Fila VIVA: se crea al
 * asignar y se borra físicamente al quitar (CF-04); mientras el trámite no está liquidado nadie la
 * referencia, y al sellar la liquidación copia nombre/valor a su propio `detalle`. `nombre`,
 * `descripcion` y `valor` son el SNAPSHOT del tipo en el instante de asignar: editar o dar de baja el
 * tipo después no los cambia (CF-03). FK al tipo RESTRICT (el catálogo no borra: baja lógica) y a
 * users RESTRICT por ADR-0005 (`asignado_por_id` va en pareja con `asignado_en`).
 */
export const flitoTramiteServiciosAdicionales = pgTable('flito_tramite_servicios_adicionales', {
  id: uuid('id').primaryKey().defaultRandom(),
  tramiteId: uuid('tramite_id').notNull().references(() => flitoTramites.id, { onDelete: 'cascade' }),
  tipoId: uuid('tipo_id').notNull().references(() => flitoServiciosAdicionalesTipos.id, { onDelete: 'restrict' }),
  nombre: varchar('nombre', { length: 120 }).notNull(),
  descripcion: text('descripcion'),
  valor: numeric('valor', { precision: 14, scale: 2 }).notNull(),
  asignadoPorId: integer('asignado_por_id').references(() => users.id, { onDelete: 'restrict' }),
  asignadoEn: timestamp('asignado_en', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tramiteTipoUq: uniqueIndex('idx_flito_tramite_serv_adic_tramite_tipo').on(t.tramiteId, t.tipoId),
  tramiteIdx: index('idx_flito_tramite_serv_adic_tramite').on(t.tramiteId),
  valorChk: check('flito_tramite_serv_adic_valor_chk', sql`${t.valor} >= 0`),
}));
```

Notas del SQL 0193 (mismas reglas que la 0191: sin `BEGIN/COMMIT`, idempotente, dollar-quoting
etiquetado, tuplas de permisos una por línea byte a byte con `catalogo-operaciones.ts`):

- `users.id` es **integer** (`schema.ts:75`): `asignado_por_id integer REFERENCES users(id) ON DELETE RESTRICT`. Nullable (el actor puede faltar en semillas; hoy siempre viene de `req.user`).
- `CONSTRAINT flito_tramite_serv_adic_tramite_tipo_uq UNIQUE (tramite_id, tipo_id)` como **constraint** (no solo índice): es lo que el 23505 nombra y lo que `ON CONFLICT` podría usar. En Drizzle se declara con `uniqueIndex` (equivalente funcional; el test de la migración afirma sobre el SQL).
- `COMMENT ON COLUMN … valor IS 'Snapshot del valor del tipo al asignar; nunca se relee del catálogo.'`
- Paso de permisos: 3 funciones `finanzas.servicios_adicionales.{ver,asignar,quitar}` (`modulo 'finanzas'`, `tipo 'operacion'`); reparto `ver` → admin, financiera, auditor; `asignar`/`quitar` → admin, financiera. 7 tuplas. `DO $resumen0193$ … RAISE NOTICE` con las cuentas.

### `flito_liquidaciones` (migración **0194**, HU 2)

```ts
  valorLogistica: numeric('valor_logistica', { precision: 14, scale: 2 }),
  /** HU #12546: suma sellada de los servicios adicionales. NULL = ninguno (o sellada antes de la HU). */
  valorServiciosAdicionales: numeric('valor_servicios_adicionales', { precision: 14, scale: 2 }),
```

SQL: `ALTER TABLE flito_liquidaciones ADD COLUMN IF NOT EXISTS valor_servicios_adicionales numeric(14,2);`
+ `COMMENT ON COLUMN … IS 'HU #12546 suma sellada de los servicios adicionales del trámite. NULL = no aplica: sin servicios, o sellada antes de la HU (sin backfill). La lista con nombre y valor de cada uno va en detalle->''serviciosAdicionales''->''items''.'`
Grep previo hecho: la columna **no existe** hoy (memoria `ac-migracion-nombra-columnas-imposibles`).

Forma de `detalle.serviciosAdicionales` (jsonb, la escribe `liquidar()`):

```json
{ "valor": 125000, "origen": "asignacion", "bloquea": false,
  "items": [{ "tipoId": "…", "nombre": "Diagnóstico", "valor": 85000 },
            { "tipoId": "…", "nombre": "Derecho de petición", "valor": 40000 }] }
```

Sin servicios: `{ "valor": null, "origen": "Sin servicios adicionales", "bloquea": false, "items": [] }` y columna `NULL`.

### `siigo_mapeo_conceptos` (migración **0195**, HU 3) — sin DDL

```sql
INSERT INTO siigo_mapeo_conceptos (ambiente, concepto, factura_linea_propia, linea_propia_pendiente, notas)
SELECT a.ambiente, 'servicio_adicional', true, false, NULL
FROM (VALUES ('pruebas'), ('produccion')) AS a(ambiente)
ON CONFLICT DO NOTHING;
```
(`ON CONFLICT DO NOTHING` sin target, como la 0128: lo ataja `idx_siigo_mapeo_unico_activo`.) No hay
CHECK sobre `concepto` que ampliar.

---

## Cómo cambia cada pieza (lo que el backend-agent codea)

### HU #12545 — `finanzas-servicios-adicionales.service.ts`

```ts
// Errores (la ruta traduce la clase a código HTTP, como servicioAdicionalFallo)
export class ServicioAdicionalTramiteError extends Error {}
export class TramiteNoEncontradoError extends ServicioAdicionalTramiteError {}          // 404
export class TipoNoDisponibleError extends ServicioAdicionalTramiteError {}            // 404 TIPO_NO_DISPONIBLE
export class ServicioYaAsignadoError extends ServicioAdicionalTramiteError {}          // 409 SERVICIO_YA_ASIGNADO
export class TramiteLiquidadoError extends ServicioAdicionalTramiteError {}            // 409 TRAMITE_LIQUIDADO
export class AsignacionNoEncontradaError extends ServicioAdicionalTramiteError {}      // 404

type Ejecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Bloquea la fila del trámite (FOR UPDATE) y devuelve idFlit; lanza TramiteNoEncontradoError. */
async function bloquearTramite(tx: Ejecutor, tramiteId: string): Promise<{ id: string; idFlit: string }>;
/** true si hay fila en flito_liquidaciones (cualquier estado). */
export async function tramiteLiquidado(ejecutor: Ejecutor, tramiteId: string): Promise<boolean>;
/** Los asignados de un trámite, ORDER BY asignado_en ASC, id ASC. Lo reutiliza liquidar() con `tx`. */
export async function serviciosAsignadosDe(ejecutor: Ejecutor, tramiteId: string): Promise<FilaAsignacion[]>;

export async function listar(tramiteId): Promise<ServiciosAdicionalesDeTramite>;      // 404 si el trámite no existe
export async function asignar(tramiteId, tipoId, usuarioId): Promise<TramiteServicioAdicional>;
export async function quitar(tramiteId, asignacionId, usuarioId): Promise<{ tipoId; nombre; valor }>; // lo que audita la ruta
```

`asignar` y `quitar` = `db.transaction(async (tx) => { bloquearTramite; if (await tramiteLiquidado(tx, id)) throw TramiteLiquidadoError; … })`. El 23505 del INSERT se traduce a `ServicioYaAsignadoError` **dentro** del `catch` (patrón `esChoqueDeLlave` del catálogo); el `tipo` se lee con `and(eq(id), eq(activo, true))` (RN-03 del catálogo: inexistente = dado de baja = 404). `listar` no transacciona: `select` de la puente con `leftJoin(users)` para `asignadoPorNombre` + `tramiteLiquidado(db, id)`.

Mutante 1 (AC8): quitar `if (await tramiteLiquidado(...))` → rojo en AC5/AC6. Mutante 2: `valor: tipo.valor` → leer por join al catálogo → rojo en AC4 (el test cambia el valor del tipo en el mock **después** y afirma que la fila insertada lleva 85000: se afirma sobre el payload de `values()` grabado, no sobre lo que el mock devolvió).

### HU #12546 — `flito-liquidacion.service.ts`

```ts
export interface ItemServicioSellado { tipoId: string; nombre: string; valor: number }   // → shared-types
export interface ConceptoServiciosAdicionales extends ConceptoLiquidado { items: ItemServicioSellado[] }

export interface CalculoLiquidacion {
  …; logistica: ConceptoLiquidado;
  serviciosAdicionales: ConceptoServiciosAdicionales;   // sexto concepto
  baseGmf; tasaGmf; valorGmf; total; faltantes;
}

/** Concepto a partir de las filas vivas de la puente. Nunca bloquea; sin filas vale null. */
export function conceptoServiciosAdicionales(items: ItemServicioSellado[]): ConceptoServiciosAdicionales {
  if (items.length === 0) return { valor: null, origen: 'Sin servicios adicionales', bloquea: false, items: [] };
  return { valor: redondear(items.reduce((a, i) => a + i.valor, 0)), origen: 'asignacion', bloquea: false, items };
}

/** Base, GMF y total a partir de los SEIS conceptos. Única definición: la usan calcularDeFila y liquidar. */
function totalizar(c: Pick<CalculoLiquidacion, 'soat'|'impuesto'|'derecho'|'tramiteDigital'|'logistica'|'serviciosAdicionales'>) {
  const baseGmf = redondear(sumar(c.soat.valor, c.impuesto.valor, c.derecho.valor, c.tramiteDigital.valor, c.logistica.valor, c.serviciosAdicionales.valor));
  const valorGmf = redondear(baseGmf * TASA_GMF);
  return { baseGmf, tasaGmf: TASA_GMF, valorGmf, total: redondear(baseGmf + valorGmf) };
}

/** El cálculo con OTRA lista de servicios (la leída dentro de la transacción del sello). Pura. */
export function conServiciosAdicionales(base: CalculoLiquidacion, items: ItemServicioSellado[]): CalculoLiquidacion {
  const serviciosAdicionales = conceptoServiciosAdicionales(items);
  return { ...base, serviciosAdicionales, ...totalizar({ ...base, serviciosAdicionales }) };
}
```

- `calcular(tramiteId)`: además de la proyección, `await serviciosAsignadosDe(db, tramiteId)` → `calcularDeFila(f, items)`. **No** se añade nada a `faltantes`.
- `liquidar()`: pre-checks como hoy (existente, `calcular` → faltantes). Dentro de `db.transaction`: `bloquearTramite(tx)` → `items = serviciosAsignadosDe(tx, tramiteId)` → `calculo = conServiciosAdicionales(calculoPrevio, items)` → `detalle` con `serviciosAdicionales` → `valores.valorServiciosAdicionales = valor === null ? null : String(valor)` → `salidas = salidasDe(calculo, ids)` (mover la llamada dentro: es pura y depende del GMF recompuesto) → insert + evento + bolsas como hoy. El evento `liquidar` hereda `items` porque `snapshot = { ...detalle, total }`.
- `aDto()`: `serviciosAdicionales: (d.serviciosAdicionales as ConceptoServiciosAdicionales | undefined) ?? { valor: num(l.valorServiciosAdicionales), origen: 'Sellado', bloquea: false, items: [] }` — la lectura sellada sale de la columna/detalle, no de la puente (AC3).
- `reversar()`, `facturar()`, `liquidarLote()`: **sin cambios**. `salidasDe()`: ver riesgo «bolsa».
- `identificadoresDe`, `proyeccionCalculo`: sin cambios.
- Tamaño: 662 + ~45 → ~707 < 800.

### HU #12546 — reporte

`finanzas.servicios-adicionales.expr.ts` (nuevo, **leaf**: importa solo `drizzle-orm` y `schema.js`, para no crear un ciclo con `finanzas.service.ts`):

```ts
const SA = flitoTramiteServiciosAdicionales;
/** La misma prueba que `seLiquido` de finanzas.service.ts; vive aquí para que ese archivo importe de este y no al revés. */
export const SE_LIQUIDO = sql`${flitoLiquidaciones.id} IS NOT NULL`;
// Subconsultas correlacionadas (patrón `delPrimerComprador`): un join multiplicaría la fila y los totales.
const SUMA_VIGENTE = sql`(SELECT SUM(${SA.valor}) FROM ${SA} WHERE ${SA.tramiteId} = ${flitoTramites.id})`;
const CUENTA_VIGENTE = sql`(SELECT COUNT(*) FROM ${SA} WHERE ${SA.tramiteId} = ${flitoTramites.id})::int`;
export const EXPR_SERVICIOS_ADICIONALES = sql`CASE WHEN ${SE_LIQUIDO} THEN ${flitoLiquidaciones.valorServiciosAdicionales} ELSE ${SUMA_VIGENTE} END`;
// Selladas antes de la HU: detalle sin la clave → jsonb_array_length(NULL) = NULL → 0.
export const EXPR_SERVICIOS_ADICIONALES_CANTIDAD = sql`CASE WHEN ${SE_LIQUIDO}
  THEN COALESCE(jsonb_array_length(${flitoLiquidaciones.detalle}->'serviciosAdicionales'->'items'), 0)
  ELSE ${CUENTA_VIGENTE} END`;
export const SELECT_SERVICIOS_ADICIONALES = {
  serviciosAdicionales: sql<string | null>`${EXPR_SERVICIOS_ADICIONALES}`,
  serviciosAdicionalesCantidad: sql<number>`${EXPR_SERVICIOS_ADICIONALES_CANTIDAD}`,
} as const;
export interface ServiciosAdicionalesDeFila { serviciosAdicionales: number | null; serviciosAdicionalesCantidad: number }
export function serviciosAdicionalesDeFila(r: Record<string, unknown>): ServiciosAdicionalesDeFila;
```

Las claves jsonb `'serviciosAdicionales'` e `'items'` y el `0` van como **texto del template**, no
interpolados: cero parámetros nuevos (memoria `drizzle-no-deduplica-literales`). `${TASA_GMF}` ya se
interpola dos veces en `EXPR_TOTAL` hoy; sigue siendo seguro porque todo va dentro de `SUM()` en el
consolidado. El test renderiza `selectConsolidado` y afirma `gruposHuerfanos(q)` vacío.

En `finanzas.service.ts` (delta ≈ 12 líneas):
- `const seLiquido = SE_LIQUIDO;` (o sustituir usos) — una sola definición.
- `EXPR_BASE_GMF` += `+ COALESCE(${EXPR_SERVICIOS_ADICIONALES}, 0)` → arrastra a `EXPR_GMF` y `EXPR_TOTAL` en las NO selladas; las selladas leen `valor_gmf`/`total` de la fila.
- `EXPR_INCOMPLETA`/`EXPR_BLOQUEADA`: sin cambios.
- `SELECT_FILA` += `...SELECT_SERVICIOS_ADICIONALES`.
- `aFila`: `conceptos` gana `serviciosAdicionales: n(r.serviciosAdicionales)`; la fila devuelve `...serviciosAdicionalesDeFila(r)`.
- `SELECT_TOTALES` += `serviciosAdicionales: COALESCE(SUM(EXPR_SERVICIOS_ADICIONALES), 0)`; `totalServicio: COALESCE(SUM(COALESCE(EXPR_DIGITAL,0) + COALESCE(EXPR_SERVICIOS_ADICIONALES,0)), 0)`; `totalReintegro` intacto.
- `TotalesReporte` += `serviciosAdicionales: number`; `totalesDe` lo mapea; `FilaReporte extends … ServiciosAdicionalesDeFila`.

`finanzas.reporte-columnas.ts`: `ConceptosDeFila` += `serviciosAdicionales: number | null`; `subtotalesDe`: `totalServicio = pendiente(TD) ? null : redondear((f.tramiteDigital ?? 0) + (f.serviciosAdicionales ?? 0))` (los servicios nunca están pendientes: no entran en el `Set`).

`finanzas.consolidado.ts`: `GrupoConsolidado` y `NUMERICOS` += `serviciosAdicionales`; `totalesEnCero` += `serviciosAdicionales: 0`. Nada más: `selectConsolidado` reusa `SELECT_TOTALES`.

`finanzas.export-excel.ts`: insertar `dinero('Servicios adicionales', 'serviciosAdicionales')` justo después de `{ header: 'Modelo', … }`; `filasExcelDetalle` += `serviciosAdicionales: f.serviciosAdicionales`; comentario de cabecera: «32 columnas desde la HU #12546 (CF-10 del Feature #12544, pendiente de visto bueno del PO)». Consolidado: sin cambios.

### HU #12547 — Siigo

`packages/shared-types/src/siigo-facturacion.ts`:
- `CONCEPTOS_FACTURABLES` += `'servicio_adicional'` (al final); `CONCEPTO_FACTURABLE_LABEL.servicio_adicional = 'Servicio adicional'`; `ValoresLiquidacion.valorServiciosAdicionales: string | null`; `CONCEPTO_FACTURABLE_COLUMNA_LIQUIDACION.servicio_adicional = 'valorServiciosAdicionales'`. El typecheck señala los dos `Record<ConceptoFacturable,…>` (ambos en este archivo) y todos los objetos literales `ValoresLiquidacion` (`facturacion.emision.service.ts:300`, `facturacion.elegibilidad.service.ts:218`, `siigo.mock.ts` si construye alguno, fixtures de tests).

`facturacion.armado.ts`:
- `TramiteFacturable.serviciosAdicionales: ItemServicioSellado[]` (**obligatorio**, por el mismo motivo que los seis campos de `ValoresLiquidacion`: un `{}` no debe compilar).
- Nuevo `MotivoRechazoArmado` `'servicios_no_cuadran'`.
- En `lineasDe`, tras las tres guardas comunes (descarte por `facturaLineaPropia = false`, `concepto_sin_mapeo`, `concepto_sin_producto`) y antes del `aNumero`: `if (concepto === 'servicio_adicional') { lineas.push(...lineasDeServicios(tramite, m)); continue; }`.
- `lineasDeServicios(tramite, m)`: `total = aNumero(valorServiciosAdicionales)`; `suma = Σ items.valor` redondeada a centavos; si `|suma − total| > 0.005` o (`total > 0` y `items.length === 0`) → `FacturaNoArmableError('servicios_no_cuadran', …, tramite.idFlit)`; cada item → `{ code: m.codigoProducto, description: item.nombre, quantity: 1, price: item.valor }` (item de valor 0 sí genera línea; valor negativo → `importe_negativo` como los demás). **Excepción documentada en el comentario**: la descripción es el nombre sellado y no `m.nombreProducto ?? label` (decisión del PO 2026-09-14: en la factura se lee qué servicio fue).
- `conceptosFacturados` y `conceptosAplicables`: sin cambios (data-driven).

`facturacion.emision.service.ts` `cargarTramites`: proyectar `valorServiciosAdicionales: flitoLiquidaciones.valorServiciosAdicionales` y `serviciosAdicionales: sql<unknown>\`COALESCE(${flitoLiquidaciones.detalle}->'serviciosAdicionales'->'items', '[]'::jsonb)\``; mapear a `ItemServicioSellado[]` con `Number(valor)` y validación mínima (array de objetos con `nombre` string y `valor` numérico; lo que no cumpla → `[]`, y el armador lanzará `servicios_no_cuadran` si la columna dice otra cosa). `FilaTramiteEmision` gana el campo.

`facturacion.elegibilidad.service.ts` `cargarFilas`: proyectar/mapear `valorServiciosAdicionales`. Nada más: «sin mapeo → no elegible **solo si** el trámite tiene servicios» es lo que ya hace la compuerta por `conceptosAplicables`.

`mapeo-conceptos.service.ts`: sin código nuevo (lista/valida contra `CONCEPTOS_FACTURABLES`; línea 533 acepta el concepto nuevo solo). Web `MapeoConceptos.tsx`/`DialogoEnvioFacturacion.tsx`: sin cambios (iteran la constante); verificar visualmente.

### HU #12548 — web (el ux-agent diseña; aquí solo el contrato que consume)

- `useServiciosAdicionalesTramite.ts`: `GET/POST/DELETE` de arriba + `GET /api/flito/parametrizacion/servicios-adicionales` (solo activos; excluir `tipoId` ya asignados; filtro por nombre plegado en cliente).
- `tiposReporteCostos.ts` refleja `FilaReporte`/`TotalesReporte` (dos campos + uno).
- `FUNCIONES_POR_ROL` (`apps/web/e2e/helpers/auth.ts`): `finanzas.servicios_adicionales.ver` a admin, financiera **y auditor**; `.asignar`/`.quitar` a admin y financiera.
- Botón «Servicios» decide con `hasFuncion('finanzas.servicios_adicionales.ver')`; «Añadir»/«Quitar» con `.asignar`/`.quitar` y `!liquidado`.

---

## Archivos a crear/modificar (por HU)

### HU #12545 — asignación (migración 0193)

| Acción | Archivo |
|---|---|
| Crear | `apps/api/src/db/migrations/0193_tramite_servicios_adicionales.sql` |
| Modificar | `apps/api/src/db/schema.ts` (tabla nueva, tras `flitoServiciosAdicionalesTipos`) |
| Crear | `apps/api/src/modules/finanzas-servicios-adicionales/finanzas-servicios-adicionales.service.ts` |
| Crear | `apps/api/src/modules/finanzas-servicios-adicionales/finanzas-servicios-adicionales.routes.ts` |
| Modificar | `apps/api/src/app.ts` (import + `app.use('/api/finanzas', …)` junto a la l.271) |
| Modificar | `apps/api/src/modules/permisos/inventario-guardas.ts` (`FICHEROS_EN_ALCANCE` += `{ modulo: 'finanzas', fichero: 'finanzas-servicios-adicionales/finanzas-servicios-adicionales.routes.ts' }`) |
| Modificar | `apps/api/src/modules/permisos/catalogo-operaciones.ts` (3 `op(...)` con la constante `FSA = 'finanzas-servicios-adicionales/finanzas-servicios-adicionales.routes.ts'`) |
| Modificar | `apps/api/src/modules/permisos/inventario.generado.ts` (3 entradas `modulo: "finanzas"`, roles `["admin","auditor","financiera"]` para `ver` y `["admin","financiera"]` para las otras; comentario «+3 por la HU #12545») |
| Modificar | `packages/shared-types/src/flito-servicios-adicionales.ts` (+ `TramiteServicioAdicional`, `AsignarServicioAdicionalInput`, `ServiciosAdicionalesDeTramite`, `ItemServicioSellado`, `CODIGO_SERVICIO_ADICIONAL_TRAMITE = { TIPO_NO_DISPONIBLE, SERVICIO_YA_ASIGNADO, TRAMITE_LIQUIDADO }`); reexport en `index.ts` si el archivo no se reexporta con `*` |
| Modificar | `apps/api/__tests__/helpers/permisos-seed-sql.ts` (`MIGRACIONES_CON_REPARTO` += `'0193_tramite_servicios_adicionales.sql'`) |
| Modificar | `apps/api/__tests__/fixtures/permisos-rutas-reconducidas.ts` (3 rutas) |
| Modificar | `apps/api/__tests__/services/permisos.reconduccion-cierre.test.ts` (`DIRECTORIOS_RECONDUCIDOS` += `'finanzas-servicios-adicionales'` → 21; ficheros 23→24; montajes 244→247; comentarios) |
| Modificar | `apps/api/__tests__/services/permisos-catalogo.test.ts` solo si fija cardinales (revisar; compara conjuntos) |
| Crear | `apps/api/__tests__/db/migracion-0193.test.ts` (anterior = 0192, **no** «es la última»; parseable por el helper; DDL esperado; 3 funciones + 7 tuplas; idempotencia por texto `IF NOT EXISTS`/`ON CONFLICT`) |
| Crear | `apps/api/__tests__/services/finanzas-servicios-adicionales.test.ts` (servicio) y `apps/api/__tests__/finanzas-servicios-adicionales.routes.test.ts` (rutas 400/403/404/409/201/204 + audit) |
| No tocar | `finanzas/finanzas.routes.ts`, `permisos.valla-legacy.test.ts` (`finanzas: 1` sigue siendo cierto) |

### HU #12546 — liquidación + reporte (migración 0194)

| Acción | Archivo |
|---|---|
| Crear | `apps/api/src/db/migrations/0194_liquidaciones_valor_servicios_adicionales.sql` |
| Modificar | `apps/api/src/db/schema.ts` (`valorServiciosAdicionales` en `flitoLiquidaciones`) |
| Modificar | `apps/api/src/modules/flito-liquidacion/flito-liquidacion.service.ts` (concepto 6, `totalizar`, `conServiciosAdicionales`, `liquidar` con `FOR UPDATE` + lectura en tx, `aDto`) |
| Crear | `apps/api/src/modules/finanzas/finanzas.servicios-adicionales.expr.ts` |
| Modificar | `apps/api/src/modules/finanzas/finanzas.service.ts` (≈12 líneas: import, `seLiquido`, `EXPR_BASE_GMF`, `SELECT_FILA`, `aFila`, `SELECT_TOTALES`, `TotalesReporte`, `totalesDe`, `FilaReporte`) |
| Modificar | `apps/api/src/modules/finanzas/finanzas.reporte-columnas.ts` (`ConceptosDeFila`, `subtotalesDe`) |
| Modificar | `apps/api/src/modules/finanzas/finanzas.consolidado.ts` (`GrupoConsolidado`, `NUMERICOS`, `totalesEnCero`) |
| Modificar | `apps/api/src/modules/finanzas/finanzas.export-excel.ts` (columna 11, `filasExcelDetalle`, cabecera) |
| Modificar | `packages/shared-types/src/flito-bolsas.ts` **solo si** se acepta el riesgo «bolsa» (ver abajo) |
| Crear | `apps/api/__tests__/db/migracion-0194.test.ts` (anterior = 0193) |
| Modificar | `apps/api/__tests__/services/flito-liquidacion.test.ts`, `flito-liquidacion-reversar-correccion.test.ts`, `flito-liquidacion.routes.test.ts` (fixtures con el sexto concepto; `transactionMock` que ejecuta el callback con `select`+`insert`) |
| Modificar | `apps/api/__tests__/services/finanzas.reporte.test.ts`, `finanzas.consolidado.test.ts`, `finanzas.export-excel.test.ts`, `finanzas.reporte-columnas.test.ts`, `finanzas-facturacion-electronica.test.ts` (si fija la lista de claves de `SELECT_FILA`) |
| Revisar | cualquier spec que construya `TotalesReporte`/`FilaReporte` literal (`grep -rl "totalServicio" apps/api/__tests__`) |

### HU #12547 — Siigo (migración 0195)

| Acción | Archivo |
|---|---|
| Modificar | `packages/shared-types/src/siigo-facturacion.ts` |
| Crear | `apps/api/src/db/migrations/0195_siigo_mapeo_servicio_adicional.sql` |
| Modificar | `apps/api/src/modules/siigo/facturacion.armado.ts` (`TramiteFacturable`, motivo nuevo, `lineasDeServicios`) |
| Modificar | `apps/api/src/modules/siigo/facturacion.emision.service.ts` (`cargarTramites`, `FilaTramiteEmision`) |
| Modificar | `apps/api/src/modules/siigo/facturacion.elegibilidad.service.ts` (`cargarFilas`) |
| Revisar | `apps/api/src/modules/siigo/siigo.mock.ts`, `facturacion.lote.repo.ts`, `facturacion.trabajador.service.ts`, `siigo.facturacion-tramites.service.ts`: todo literal `ValoresLiquidacion`/`TramiteFacturable` que el typecheck marque (`grep -rn "valorGmf:" apps/api/src/modules/siigo`) |
| Crear | `apps/api/__tests__/db/migracion-0195.test.ts` (anterior = 0194) |
| Modificar | `apps/api/__tests__/services/siigo-facturacion-armado.test.ts`, `siigo-elegibilidad.test.ts`, `siigo-mapeo-conceptos.test.ts`, `siigo-compuerta.test.ts` (fixtures con el séptimo campo `valorServiciosAdicionales`; el armado además con `serviciosAdicionales: []`) |
| Verificar | `apps/web/src/components/siigo/MapeoConceptos.tsx`, `apps/web/src/components/finanzas/DialogoEnvioFacturacion.tsx` (sin cambios esperados) |

### HU #12548 — web (lista de la HU, con dos añadidos)

`apps/web/src/components/finanzas/PanelServiciosAdicionales.tsx` (nuevo), `useServiciosAdicionalesTramite.ts` (nuevo), `TablaReporteCostos.tsx`, `TotalesReporteCostos.tsx`, `tiposReporteCostos.ts`, `apps/web/src/pages/FinanzasReporteCostos.tsx`, `apps/web/e2e/helpers/auth.ts` (**tres** funciones, `ver` también al auditor), `apps/web/e2e/tests/finanzas-reporte-costos.spec.ts`, `apps/web/src/content/ayuda/finanzas_reporte_costos.md`, y el test de columnas de la HU #12539 (compacta 9, completa 28→29).

---

## Impacto en shared-types

`packages/shared-types/src/flito-servicios-adicionales.ts` (HU 1):

```ts
export interface TramiteServicioAdicional {
  id: string; tipoId: string; nombre: string; descripcion: string | null; valor: number;
  asignadoPorId: number | null; asignadoPorNombre: string | null; asignadoEn: string;
}
export interface AsignarServicioAdicionalInput { tipoId: string }
export interface ServiciosAdicionalesDeTramite { items: TramiteServicioAdicional[]; total: number; liquidado: boolean }
/** Lo que la liquidación sella por servicio y lo que Siigo convierte en línea. */
export interface ItemServicioSellado { tipoId: string; nombre: string; valor: number }
export const CODIGO_SERVICIO_ADICIONAL_TRAMITE = {
  TIPO_NO_DISPONIBLE: 'TIPO_NO_DISPONIBLE', SERVICIO_YA_ASIGNADO: 'SERVICIO_YA_ASIGNADO', TRAMITE_LIQUIDADO: 'TRAMITE_LIQUIDADO',
} as const;
```

`siigo-facturacion.ts` (HU 3): ver arriba. `flito-bolsas.ts` (condicional): `ConceptoBolsa.SERVICIOS_ADICIONALES = 'servicios_adicionales'` + label «Servicios adicionales».

No hay OpenAPI; el contrato es el tipo.

---

## Tests P1 por HU (mutantes nombrados y patrón de mocks)

Reglas transversales: `process.env.TZ = 'UTC'` + fake timers; los predicados/orden/proyección se
afirman con `renderizar()` sobre lo que el servicio pasó (`grabando`/`espiando`); la fila devuelta
por `chain` no prueba nada por sí sola (memoria `mock-chain-inventa-columnas`); revertir mutantes
**por copia** del archivo, no con `git checkout --`.

### HU #12545

| AC | Test | Cómo | Mutante que lo pone rojo |
|---|---|---|---|
| AC1 | `db/migracion-0193.test.ts` | Lee el SQL; afirma `CREATE TABLE IF NOT EXISTS flito_tramite_servicios_adicionales`, columnas/FKs/`ON DELETE`, `UNIQUE (tramite_id, tipo_id)`, `CREATE INDEX IF NOT EXISTS … (tramite_id)`, `CHECK (valor >= 0)`; **anterior = `0192_…`** (`sqls[i-1]`, nunca `length - 1`). | Quitar el UNIQUE del SQL. |
| AC2 | mismo + `permisos.paridad-reconduccion` (existente) | `repartoDeSql([...0193])` → `ver` a {admin, financiera, auditor}; `asignar`/`quitar` a {admin, financiera} y a nadie más; `montajesDeFunciones()` cubre las 3 llaves. | Quitar `('financiera','finanzas.servicios_adicionales.quitar')` de la semilla → paridad roja. |
| AC3 | `services/finanzas-servicios-adicionales.test.ts` | `espiando` graba `where`/`orderBy`; `renderizar(orderBy)` contiene `"asignado_en" asc` y `"id" asc`; `ordenarComoPostgres` con **3** filas de ids desalineados; `total` = 125000; `liquidado` según el mock de `flito_liquidaciones`. | Quitar el `orderBy`. |
| AC4 | idem | `transactionMock.mockImplementation(async (fn) => fn(tx))` con `tx = { select, insert }`; el `select` del tipo devuelve valor `'85000.00'`; se afirma sobre `sobre.values` del INSERT grabado (`valor: '85000.00'`, `nombre`, `descripcion`, `asignadoPorId`), no sobre la fila devuelta. Luego el mock del tipo pasa a 90000 y `listar` sigue devolviendo 85000 (porque lee la puente). | Mutante 2: leer el valor por join al catálogo. |
| AC5 | idem | tipo inactivo → 404 `TipoNoDisponibleError` y `insert` no llamado; `chainReject({ code: '23505' })` en el insert → `ServicioYaAsignadoError`; liquidación presente → `TramiteLiquidadoError` sin `insert`; afirmar que el `select` de `flito_liquidaciones` ocurre **dentro** del callback de `transaction` (el `tx.select` es un mock distinto de `db.select`) y que hay un `.for('update')` (grabar `for` en el chain). | Mutante 1: quitar `tramiteLiquidado`. Quitar `.for('update')` → rojo en el aserto del bloqueo. |
| AC6 | idem | `delete` grabado con `where` renderizado que liga `asignacionId` **y** `tramiteId`; 0 filas → `AsignacionNoEncontradaError`; liquidado → 409 sin `delete`. | Quitar `tramite_id` del `where` del DELETE. |
| AC7 | `finanzas-servicios-adicionales.routes.test.ts` | Montar el router con `exigirFuncion` mockeado como en `permisos-exigir-funcion.test.ts` / los routes tests reconducidos (leer uno: `flito-parametrizacion.routes.test.ts`); admin/financiera/auditor/cliente × GET/POST/DELETE; `audit` mock con `action`/`resource`/`detail` esperados; 400 Zod sin tocar `db`. | Cambiar `exigirFuncion('…quitar')` por `…asignar` en el DELETE → paridad + este test. |
| AC8 | — | `npm run typecheck`, `NODE_OPTIONS=--max-old-space-size=8192 npm run build:api`, `npx eslint` sobre los archivos tocados; `permisos.valla-legacy`, `reconduccion-cierre`, `permisos-catalogo`, `paridad-reconduccion` en verde. | — |

### HU #12546

| AC | Test | Cómo | Mutante |
|---|---|---|---|
| AC1 | `db/migracion-0194.test.ts` | `ADD COLUMN IF NOT EXISTS valor_servicios_adicionales numeric(14,2)`, `COMMENT`, sin `UPDATE` (no backfill); anterior = 0193. | Añadir un `UPDATE … SET valor_servicios_adicionales = 0`. |
| AC2 | `flito-liquidacion.test.ts` | Fixture con 5 conceptos + puente `[85000, 40000]`: `serviciosAdicionales = { valor: 125000, origen: 'asignacion', bloquea: false, items }`; `baseGmf` exacto; `valorGmf = redondear(base*0.004)`; sin filas → `valor: null`, `faltantes` sin el concepto, `baseGmf` igual que la fixture actual. | Quitar `c.serviciosAdicionales.valor` de `sumar(...)` en `totalizar`. |
| AC3 | idem | `transactionMock` ejecuta el callback con `tx = { select: txSelect, insert: txInsert }`; `txSelect` responde `flito_tramites` (FOR UPDATE) y la puente; afirmar `values()` del insert: `valorServiciosAdicionales: '125000'`, `detalle.serviciosAdicionales.items.length === 2`; y que la lectura de la puente usada para el sello es la de `txSelect` (hacer que `db.select` devuelva 1 servicio y `txSelect` 2: el sello debe llevar 2). `aDto` con detalle lo devuelve desde el detalle; sin clave → desde la columna con `items: []`. | Leer la puente con `db` en vez de `tx` → el sello lleva 1 y el test pide 2. |
| AC4 | `flito-liquidacion-reversar-correccion.test.ts` | `reversar` con `l.detalle.serviciosAdicionales.items` → el `insert` del evento lleva los items; `delete` no toca la puente (`deleteMock` llamado solo con `flito_liquidaciones`: afirmar sobre la tabla del `delete` grabada); `facturar` no toca la columna (`set` grabado sin `valorServiciosAdicionales`). | Añadir un `tx.delete(puente)` en reversar. |
| AC5 | `finanzas.reporte.test.ts` | `renderizar(sql\`${SELECT_FILA.serviciosAdicionales}\`)` contiene `CASE WHEN "flito_liquidaciones"."id" IS NOT NULL THEN "flito_liquidaciones"."valor_servicios_adicionales" ELSE (SELECT SUM(` y `WHERE "flito_tramite_servicios_adicionales"."tramite_id" = "flito_tramites"."id"`; `serviciosAdicionalesCantidad` contiene `jsonb_array_length`; `EXPR_BASE_GMF` (vía `EXPR_TOTAL`) contiene `COALESCE(CASE WHEN … valor_servicios_adicionales`; `EXPR_INCOMPLETA` renderizada **sin** `servicios` (byte a byte igual que antes); `vecesLigado` de cada parámetro nuevo = 0 (no hay parámetros nuevos). | Quitar el sumando de `EXPR_BASE_GMF`. |
| AC6 | `finanzas.reporte.test.ts` + `finanzas.consolidado.test.ts` | `SELECT_TOTALES.totalServicio` renderizado contiene los dos `COALESCE(...)` sumados; fixture de `plegarConsolidado` con `serviciosAdicionales: 5000`, `tramiteDigital: 300000` → `totalServicio = 305000` y `total === totalReintegro + totalServicio`; `gruposHuerfanos(renderizar(ensamblarConsolidado(QueryBuilder…)))` = `[]`. | Quitar `COALESCE(EXPR_SERVICIOS_ADICIONALES, 0)` de `totalServicio` → RN-02 rojo. |
| AC7 | `finanzas.export-excel.test.ts` + `finanzas.reporte-columnas.test.ts` | 32 cabeceras escritas a mano; `indexOf('Modelo') + 1 === indexOf('Servicios adicionales')`; fila con 125000 → número; fila sin → `null`; `subtotalesDe({ tramiteDigital: 300000, serviciosAdicionales: 125000, … })` → `totalServicio 425000`; con `serviciosAdicionales: null` → 300000. | Poner la columna al final del array. |
| AC8 | — | Gates + `npx eslint apps/api/src/modules/finanzas/finanzas.service.ts apps/api/src/modules/flito-liquidacion/flito-liquidacion.service.ts` y leer el número. | — |

### HU #12547

| AC | Test | Cómo | Mutante |
|---|---|---|---|
| AC1 | typecheck + `siigo-mapeo-conceptos` | `CONCEPTOS_FACTURABLES.at(-1) === 'servicio_adicional'`; label; `esConceptoFacturable`; `CONCEPTO_FACTURABLE_COLUMNA_LIQUIDACION.servicio_adicional === 'valorServiciosAdicionales'`. | — (lo vigila el compilador) |
| AC2 | `db/migracion-0195.test.ts` | `INSERT INTO siigo_mapeo_conceptos … 'servicio_adicional', true, false` con `CROSS JOIN`/`VALUES ('pruebas'), ('produccion')` y `ON CONFLICT DO NOTHING`; anterior = 0194. | Quitar `ON CONFLICT`. |
| AC3 | `siigo-elegibilidad*.test.ts` | Con `valorServiciosAdicionales: '125000.00'` y sin fila de mapeo → motivo `concepto_sin_mapeo` etiqueta «Servicio adicional»; con `null` → resultado byte a byte igual al de la fixture previa; `conceptosAplicables` incluye/excluye. | Forzar `conceptosAplicables` a ignorar la columna nueva. |
| AC4 | `siigo-facturacion-armado.test.ts` | Mapeo `servicio_adicional → SA-01`; dos líneas con `description` = nombre sellado y `code 'SA-01'`; items que no suman → `servicios_no_cuadran`; `valor > 0` con `items: []` → idem; item de valor 0 → línea con `price 0`. | Quitar el bucle (una sola línea con la suma) → rojo; quitar la comprobación de suma → rojo. |
| AC5 | idem | Elegidos `['tramite_digital']` → sin líneas de servicio; `[]` → todas; `facturaLineaPropia: false` → descartado sin lanzar aunque no tenga producto. | Mover el descarte después de las guardas. |

### HU #12548

Cubierto por el ux-agent y el AC7 de la HU (mocks de API en Playwright). Nota para el gate B: la HU
cambia `FUNCIONES_POR_ROL` → correr el **smoke entero** (memoria `e2e-fixture-funciones-por-rol`).

---

## Notas operativas por agente

### backend-agent (HU 1)

- Empezar por la migración y `schema.ts`; luego el servicio; luego las rutas; luego el cableado de permisos (inventario-guardas → catálogo → foto → fixture → tests de cierre) **en el mismo commit** que la migración: `verificarCatalogoAlArrancar` compara base y código al arrancar.
- Tuplas de la semilla: generarlas con `npm run permisos:seed -w apps/api` sobre la foto ya editada y pegarlas (una por línea); el test de la 0179 compara esas líneas con el generador.
- Pre-PR: `grep -c "requireRole(" apps/api/src/modules/finanzas/*.ts` (== 1), `grep -rn "exigir-funcion" apps/api/src/modules/finanzas/` (vacío), `npx vitest run apps/api/__tests__/services/permisos*.test.ts`, `ls apps/api/src/db/migrations | tail -3` tras rebase (memoria `tip-de-rafaga`).
- No importar nada de `finanzas/finanzas.service.ts` desde el módulo nuevo (mantener el directorio nuevo como leaf de permisos y evitar arrastrar `conJoins`).
- Ejecutar la suite **completa** antes del PR: el stub pelado de `transaction` en otros specs no debería activarse (ningún handler existente cambia), pero la HU 2 sí lo activará en `flito-liquidacion.routes.test.ts`.

### backend-agent (HU 2)

- Orden: 0194 + schema → liquidación (`totalizar` primero, con los tests actuales en verde antes de añadir el sexto concepto) → `finanzas.servicios-adicionales.expr.ts` → deltas en `finanzas.service.ts` → columnas/consolidado/Excel.
- `liquidar()`: mover `salidasDe()` dentro de la transacción; el `FOR UPDATE` sobre `flito_tramites` va **antes** de leer la puente. Los specs que mockean `transaction: vi.fn()` y ejercen `liquidar` (`flito-liquidacion.routes.test.ts`, `flito-liquidacion.test.ts`) necesitan el callback ejecutado con un `tx` que tenga `select` e `insert` (`createKeyedDb` ya lo hace; en los de `chain`, `mockImplementation(async (fn) => fn(tx))`).
- `finanzas.service.ts`: si tras el delta `npx eslint` marca `max-lines`, mover también `EXPR_GMF`/`EXPR_TOTAL` al archivo hermano (dependen solo de `EXPR_BASE_GMF`, que puede exportarse); **no** mover `conJoins`/`condiciones`.
- El Excel del consolidado NO cambia; documentar en la cabecera que «Servicio» incluye los servicios adicionales.

### backend-agent (HU 3)

- Hacer primero el cambio en shared-types y dejar que el typecheck liste cada `ValoresLiquidacion` literal; **no** usar `Partial` ni `as` para callar el compilador.
- `lineasDeServicios` como función aparte (mantiene `lineasDe` legible y el archivo bajo 800; hoy 450).
- El `description` de la línea de servicio se recorta a lo que Siigo admite (revisar `siigo.client.ts`/errores `invalid_description` si existen; si no hay tope conocido, `slice(0, 500)` con comentario).

### frontend-agent / ux-agent (HU 4)

- Contrato arriba; tres funciones (no dos) en `FUNCIONES_POR_ROL`; `liquidado` viene en el GET y en la fila (`sellada`): el panel pasa a solo lectura con cualquiera de los dos.
- Los 409/404 del panel se muestran en línea y **recargan** la lista (AC3): el estado del servidor manda.

### db-review-agent

- 0193: FKs con cláusula explícita (ADR-0005), UNIQUE + índice, CHECK, comentarios; 0194: `IF NOT EXISTS`, comentario, sin backfill; 0195: sin DDL, `ON CONFLICT DO NOTHING`.

### qa-agent

- Los mutantes con nombre arriba; `git diff` antes de leer el test (memoria `mutante-comprobar-donde-cayo`); revertir por copia.

---

## Riesgos abiertos y qué falta decidir

1. **Bolsa del cliente (no está en ningún AC).** Al sellar, `salidasDe()` asienta una salida por concepto cobrable + GMF (`flito-bolsas.service.ts`). Si los servicios entran en `total` pero no en la bolsa, el saldo de la compañía queda **sobrestimado en la suma de los servicios de cada trámite sellado** (el GMF sí se descuenta, porque se calcula sobre la base ya con servicios). Recomendación: en la HU 2, `ConceptoBolsa.SERVICIOS_ADICIONALES = 'servicios_adicionales'` (+ label), una salida con la suma y llave `tramite:{id}:servicios_adicionales` (organismo `null`, como trámite digital); `reversarSalidasLiquidacion` ya devuelve por `tramiteId`. No hay CHECK en `flito_bolsa_movimientos.concepto`, así que no requiere migración. **Decide David/tech-lead**: añadir AC a la HU #12546 o dejarlo fuera explícitamente.
2. **Desvío de AC2/AC3 de la HU #12545** (tres funciones, GET por el motor, llave del catálogo en el módulo nuevo). Decide tech-lead: ajustar el texto de la HU.
3. **Excel del consolidado** sigue en 13 columnas: «Servicio» ya incluye los servicios adicionales pero no hay columna propia. Decide PO junto con el visto bueno del CF-10 (32 cabeceras del detalle).
4. **Liquidaciones selladas antes de la HU 2** muestran `serviciosAdicionales = null` y cantidad 0 aunque hoy la puente esté vacía por definición (la HU 1 entra antes; ningún trámite sellado puede tener puente). Sin backfill, por diseño.
5. **`FOR UPDATE` sobre `flito_tramites`** bloquea brevemente contra el sync (transacción por trámite). Si algún día el sync pasa a lotes largos, cambiar a `pg_advisory_xact_lock` es un cambio local en `bloquearTramite()`.
6. **Tope de `description` en Siigo**: comprobar en `siigo.client.ts`/Apiary antes de mandar un nombre de 120 caracteres; hoy `nombreProducto` es `varchar(200)` y nunca se ha recortado.
7. **`asignadoPorNombre`** expone el nombre de un usuario interno a los tres roles lectores; no es PII de terceros (Ley 1581 no aplica a la trazabilidad de empleados en este contexto), y ya se hace en bolsas (`registradoPorNombre`).
