# Diseño slim — HU #12541 Catálogo de tipos de servicio adicional

Feature #12540 (épica #12246). Salida del `architecture-agent` en modo slim, 2026-09-14. ADR: no aplica
(extensión de patrón: tabla de catálogo + baja lógica + índice parcial, con precedentes 0182, 0190 y ADR-0005).

## Patrón reutilizado

- Servicio + errores tipados + `fallo(res, e)` en la ruta: `flito-tarifas.service.ts` (`TarifaError` /
  `TarifaNoEncontradaError` / `TarifaConflictoError`) y `tarifaFallo()` en `flito-parametrizacion.routes.ts`.
- Detección de 23505: `esChoqueDeLlave` local al servicio (`(e as { code?: string }).code === '23505'`) con
  relectura de la fila que choca tras el catch. Sin pre-chequeo antes del INSERT: una sola verdad (el índice),
  el mismo camino cubre la carrera.
- Índice único parcial con expresión en Drizzle: `uniqueIndex(...).on(sql`...`).where(sql`...`)` (schema.ts ~3535).
- Baja lógica + FK a users RESTRICT: 0190; ADR-0005 (FK en pareja con marca de tiempo → RESTRICT explícito
  con `COMMENT ON COLUMN`).
- Plegado con `translate()`, no `unaccent()` (0165/0182).
- Siembra de permisos parseable por `apps/api/__tests__/helpers/permisos-seed-sql.ts` (formato de la 0190).
- Rutas en el MISMO `flito-parametrizacion.routes.ts` (487 líneas `max-lines` hoy, tope 800). No abrir fichero
  de rutas nuevo: obligaría a tocar `FICHEROS_EN_ALCANCE` y el prefijo del lector de guardas.

## Nombre plegado: UNA expresión

```ts
/** La MISMA expresión del índice parcial de la 0191; si cambia allí, cambia aquí. */
export const nombrePlegado = (x: AnyPgColumn | string): SQL =>
  sql`lower(translate(${x}, 'áéíóúÁÉÍÓÚñÑüÜ', 'aeiouAEIOUnNuU'))`;
```

Se usa en el orden del listado, en la relectura del que choca tras el 23505
(`where(and(eq(t.activo, true), eq(nombrePlegado(t.nombre), nombrePlegado(d.nombre))))`) y, en SQL plano,
en el índice y el `ON CONFLICT` de la migración. Test: `renderizar(nombrePlegado(t.nombre)).sql` exacto.

## Migración `0191_servicios_adicionales_tipos.sql`

Sin BEGIN/COMMIT; idempotente (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`); DO con etiqueta `$resumen0191$`.

- Tabla `flito_servicios_adicionales_tipos`: `id uuid PK gen_random_uuid()`, `nombre varchar(120) NOT NULL`,
  `descripcion text`, `valor numeric(14,2) NOT NULL`, `activo boolean NOT NULL DEFAULT true`,
  `dado_de_baja_en timestamptz`, `dado_de_baja_por_id integer REFERENCES users(id) ON DELETE RESTRICT`,
  `creado_por_id` (RESTRICT), `creado_en timestamptz NOT NULL DEFAULT now()`, `actualizado_por_id` (RESTRICT),
  `actualizado_en timestamptz NOT NULL DEFAULT now()`.
  CHECKs: `flito_serv_adic_tipos_valor_chk (valor >= 0)`, `flito_serv_adic_tipos_nombre_chk (btrim(nombre) <> '')`,
  `flito_serv_adic_tipos_baja_chk (activo = (dado_de_baja_en IS NULL))`. `COMMENT ON` tabla y las tres FK.
- `CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_serv_adic_tipos_nombre_activo ON ... (lower(translate(nombre,
  'áéíóúÁÉÍÓÚñÑüÜ', 'aeiouAEIOUnNuU'))) WHERE activo;`
- Siembra: `INSERT ... (nombre, valor) VALUES ('Paz y salvo de impuestos', 0), ('Diagnóstico', 0),
  ('Derecho de petición', 0) ON CONFLICT (lower(translate(nombre, 'áéíóúÁÉÍÓÚñÑüÜ', 'aeiouAEIOUnNuU'))) WHERE activo
  DO NOTHING;` (sin autor: el admin nace después que la migración).
- `permisos_funciones` (codigo, modulo, nombre_negocio, descripcion, tipo) × 4, `tipo 'operacion'`,
  `modulo 'parametrizacion'`: `.crear` «Crear un tipo de servicio adicional» / «Dar de alta un tipo de servicio
  adicional con su nombre, descripción y valor.»; `.dar_de_baja` «Dar de baja un tipo de servicio adicional» /
  «Retirar un tipo del catálogo sin borrarlo. No se reactiva; su nombre queda libre.»; `.editar` «Editar un tipo
  de servicio adicional» / «Cambiar el nombre, la descripción o el valor de un tipo activo.»; `.listar` «Ver los
  tipos de servicio adicional» / «Consultar el catálogo de tipos de servicio adicional y su valor.»
  `ON CONFLICT (codigo) DO NOTHING`. Los textos deben ser byte a byte los de `catalogo-operaciones.ts`.
- `permisos_rol_funcion` × 8 (`admin` y `financiera` × 4) `ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING`.
- DO `$resumen0191$`: RAISE NOTICE con tipos activos (>= 3), funciones (4), reparto (8).

## Modelo Drizzle (schema.ts, tras `flitoTarifasVigencias`)

`flitoServiciosAdicionalesTipos` con las columnas de arriba en camelCase (`dadoDeBajaEn`, `dadoDeBajaPorId`,
`creadoPorId`, `creadoEn`, `actualizadoPorId`, `actualizadoEn`), FKs `{ onDelete: 'restrict' }`,
`uniqueIndex('idx_flito_serv_adic_tipos_nombre_activo').on(sql`lower(translate(${t.nombre}, ...))`).where(sql`${t.activo}`)`
y los tres `check(...)` con los mismos nombres de la migración.

## Contrato y shared-types

`packages/shared-types/src/flito-servicios-adicionales.ts` (+ `export *` en `index.ts`):
`ServicioAdicionalTipo { id, nombre, descripcion: string|null, valor: number, activo, dadoDeBajaEn: string|null,
dadoDeBajaPorId: number|null, creadoEn, creadoPorId: number|null, actualizadoEn, actualizadoPorId: number|null }`,
`CrearServicioAdicionalInput { nombre; descripcion?: string|null; valor: number }`,
`EditarServicioAdicionalInput = Partial<CrearServicioAdicionalInput>`, `SERVICIO_ADICIONAL_VALOR_MAX`
(= tope de TARIFA_VALOR_MAX), `SERVICIO_ADICIONAL_NOMBRE_MAX = 120`. `numeric` → `Number()` como `aTarifa`.

| Ruta (bajo `/api/flito/parametrizacion`) | Función | Respuesta |
|---|---|---|
| `GET /servicios-adicionales[?incluirBajas=1]` | `…listar` | 200 `ServicioAdicionalTipo[]`; orden `nombrePlegado ASC, id ASC` |
| `POST /servicios-adicionales` | `…crear` | 201; 400 (`mensajeDe`); 409 `{ error, codigo: 'NOMBRE_DUPLICADO', choca: { id, nombre } }` |
| `PATCH /servicios-adicionales/:id` | `…editar` | 200; 400 vacío/inválido; 404 inexistente, uuid inválido o dado de baja; 409 |
| `POST /servicios-adicionales/:id/baja` | `…dar_de_baja` | 200 (`activo:false`, `dadoDeBajaEn`); 404 inexistente/uuid inválido/ya de baja |

Sin `DELETE` ni reactivación. Zod: `nombre z.string().trim().min(1).max(120)`, `descripcion
z.string().trim().max(2000).nullable().optional()`, `valor` = el `valorSchema` ya definido en routes.ts (~516);
PATCH con `.refine` «Nada que actualizar». `idUuid()` como `flito-conciliacion.routes.ts` (uuid inválido → 404).
Auditoría `audit(req, { action: 'create'|'update', resource: 'flito_servicio_adicional_tipo', ... })`; la baja va
como `update` con detail «Tipo «X» dado de baja» (no ampliar `AuditAction`).
`exigirFuncion('parametrizacion.servicios_adicionales.<x>')` literal (el lector de guardas no acepta variables).

## Servicio `flito-servicios-adicionales.service.ts`

`nombrePlegado`, `ServicioAdicionalError` / `ServicioAdicionalNoEncontradoError` /
`ServicioAdicionalConflictoError(message, choca)`, `aDto(fila)`, `listarTipos(incluirBajas)`,
`crearTipo(d, usuarioId)`, `editarTipo(id, cambios, usuarioId)`, `darDeBajaTipo(id, usuarioId)`. Escrituras con
`.returning()` → DTO sin segunda lectura; `editar`/`baja` con `where(and(eq(t.id,id), eq(t.activo,true)))` → 0
filas = 404 (cubre inexistente, dado de baja y segunda baja). `editar` siempre escribe
`actualizadoPorId`/`actualizadoEn: new Date()`.

## Inventario de permisos

`npm run permisos:seed -w apps/api` escupe SQL por stdout; no produce archivo. Se commitea: (a) 4 `op(...)` en
`apps/api/src/modules/permisos/catalogo-operaciones.ts`, (b) 4 filas en `inventario.generado.ts` (junto a tarifas,
`+4 por la HU #12541` en el comentario de cabecera), (c) las tuplas de la 0191. «Coincide» = `migracion-0179.test.ts`
verde, que compara el stdout del generador con la suma de `MIGRACIONES_CON_REPARTO` → añadir la 0191 a esa lista.

## Archivos

Producción: `0191_servicios_adicionales_tipos.sql`; `schema.ts`; `flito-servicios-adicionales.service.ts` (nuevo);
`flito-parametrizacion.routes.ts` (bloque al final, antes de `export default`); `catalogo-operaciones.ts`;
`inventario.generado.ts`; `packages/shared-types/src/flito-servicios-adicionales.ts` (nuevo) + `index.ts`.

Tests: `__tests__/helpers/permisos-seed-sql.ts` (`MIGRACIONES_CON_REPARTO`); `__tests__/fixtures/permisos-rutas-reconducidas.ts`
(4 filas); `__tests__/services/permisos.reconduccion-cierre.test.ts` (240 → 244, título «+4 de la #12541»);
`__tests__/db/migracion-0191.test.ts` (nuevo, calcado de 0190: sin tx control, etiqueta DO, número único,
`funcionesDeSql`/`repartoDeSql`, literal translate DOS veces con `WHERE activo`, `ON DELETE RESTRICT` ×3, tres
tuplas `, 0)`, «la anterior es 0190_», bloque `describe.skipIf(!TEST_DATABASE_URL)` ×2);
`__tests__/services/flito-servicios-adicionales.test.ts` (nuevo, en `services/`, mocks de tarifas: `chain`,
`chainReject`, `espiando`, `grabando`, `TZ=UTC` + fake timers; asertar `where`/`orderBy` sobre SQL renderizado);
`__tests__/services/flito-parametrizacion.routes.test.ts` (describe nuevo con supertest: 201/200 financiera,
403 por función y para auditor, 400 nombra `valor`, 409 `NOMBRE_DUPLICADO`, `/baja` ×2 → 200 y 404, `DELETE` → 404
sin `deleteMock`, uuid inválido → 404 sin `updateMock`).

Sin tocar: `app.ts` (ya monta el router), `FICHEROS_EN_ALCANCE`, web.

## Notas operativas

- `max-lines` de routes.ts: leer el número con `npx eslint apps/api/src/modules/flito-parametrizacion/flito-parametrizacion.routes.ts`.
- Gate de paridad: `npx vitest run __tests__/db/migracion-0179.test.ts __tests__/services/permisos.reconduccion-cierre.test.ts
  __tests__/services/permisos.paridad-reconduccion.test.ts __tests__/services/permisos-catalogo.test.ts` (desde apps/api).
- `build:api` con `NODE_OPTIONS=--max-old-space-size=8192`; no typechequea `__tests__`.
- La 0191 no requiere extensiones. `verificarCatalogoAlArrancar` compara base vs código al arrancar: en local,
  aplicar la 0191 antes de levantar el API.
