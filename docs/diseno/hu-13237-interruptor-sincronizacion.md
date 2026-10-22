# Diseño slim — HU #13237 · Interruptor de sincronización por fuente

Feature #13236 · Épica #12736 · módulo **`flito-sync`** (FLITO; el legacy no se toca) · BACKEND.
Rama `HU/13237-davidchica-interruptor-sincronizacion` sobre `develop` c3bf6972.
Decisiones del humano (1–6 del pedido) cerradas; este documento no las reabre.

---

## Patrón reutilizado

| Pieza | Vecino que se copia |
|---|---|
| Tabla con quién/cuándo + siembra de función solo a admin | `apps/api/src/db/migrations/0214_flit2_acceso.sql` (tabla + `permisos_funciones` + `permisos_rol_funcion` en VALUES + `DO $resumen$`) |
| Sub-router con su propio `authMiddleware`, montado con `router.use` desde el router padre (fuera del inventario de 22 ficheros de `montajesDeFunciones()`) | `apps/api/src/modules/flito-sync/flit2-estado.routes.ts` montado desde `flit2.routes.ts` |
| Validación Zod `.strict()` + 400 `datos_invalidos` sin eco del cuerpo | `datosInvalidos()` de `apps/api/src/modules/flito-sync/flit2.routes.ts` |
| Forma de «quién y cuándo» | `Flit2AccesoMeta.actualizadoPor` / `actualizadoEn` (`packages/shared-types/src/flito-flit2.ts`) |
| Composición pura del estado + extensión de `EntradaEstado` | `componerEstado()` en `apps/api/src/modules/flito-sync/flit2-estado.service.ts` |
| Rama de `catch` por tipo de error en la corrida | `correrLecturaFlit2Programada()` (`flito-sync.cron.ts`) y `correrLecturaTrasAcceso()` (`flit2-lectura-acceso.ts`) |
| Test de migración | `apps/api/__tests__/db/migracion-0214.test.ts` y `migracion-0216.test.ts` («la anterior es …», nunca «es la última») |

---

## Decisión: tabla propia `flito_sync_interruptor` (no `system_kv`, no la fila de lectura)

| Criterio | `system_kv` (`k='flito.sync.interruptor.flit2'`, `v` jsonb) | Columna en `flito_sync_flit2_lectura` (id=1) | **Tabla propia (2 filas)** |
|---|---|---|---|
| Integridad | `v` jsonb sin tipo; `encendido: "no"` entra; quién sin FK | Solo sirve a FLIT 2; FLIT 1 quedaría en otro sitio | `CHECK` de fuente, `boolean NOT NULL`, FK `users(id)` |
| Quién / cuándo | A mano dentro del jsonb, sin FK | `updated_at` de esa fila lo mueve CADA página (cursor): no dice quién apagó | `updated_at` / `updated_by` propios, solo los mueve el PUT |
| Idempotencia de siembra | `ON CONFLICT (k) DO NOTHING`, igual | `ADD COLUMN IF NOT EXISTS` | `ON CONFLICT (fuente) DO NOTHING` |
| Consulta por página | PK, trivial | Ya se lee, gratis | PK de una tabla de 2 filas, trivial |
| Contención | Ninguna | **Sí**: el PUT escribiría la fila que la transacción de cada página actualiza con guarda optimista (`cursor IS NOT DISTINCT FROM`); un PUT a mitad de página espera el lock o, peor, invita a mezclar el `set` | Ninguna: fila distinta a la del cursor |

**Elegida: tabla propia.** El precedente de la casa ya dejó escrito por qué una clave de `system_kv` no basta cuando hay que responder «quién y cuándo» (cabecera de la tabla de corridas de vigencia en `schema.ts`, ~L2993). La fila id=1 queda descartada por la contención con el cursor (AC7) y porque FLIT 1 no vive ahí. `system_kv` sigue guardando `flito.ultima_sincronizacion`; no se toca.

**Fila ausente = encendida** (fail-open coherente con la decisión 1: sembrada encendida, sin cambio de comportamiento). Se loguea `warn` sin PII. Un **error** de base al leer la guarda no se traga: se propaga (en el tick lo captura la rama genérica; en una página, la página tampoco habría podido escribir).

---

## Modelo de datos (migración `0217_sync_interruptor_fuente.sql`)

Confirmado: la última en `develop` c3bf6972 es `0216_flit2_pii_enmascarada.sql` → esta es **0217**. Si al rebasear aparece otra 0217, renumerar (la migración no está aplicada en ningún ambiente hasta el merge).

```sql
-- Sin BEGIN/COMMIT (el runner envuelve). Sin unaccent(). Idempotente.
CREATE TABLE IF NOT EXISTS flito_sync_interruptor (
  fuente      varchar(10) PRIMARY KEY,
  encendido   boolean     NOT NULL DEFAULT true,
  updated_at  timestamptz NULL,                       -- null = nadie lo ha cambiado desde la siembra
  updated_by  integer     NULL REFERENCES users(id),
  CONSTRAINT ck_flito_sync_interruptor_fuente CHECK (fuente IN ('flit1', 'flit2'))
);
COMMENT ON TABLE flito_sync_interruptor IS 'HU #13237: interruptor por fuente de la sincronización FLIT, propio de cada ambiente. Sembrado encendido.';

INSERT INTO flito_sync_interruptor (fuente) VALUES ('flit1'), ('flit2')
ON CONFLICT (fuente) DO NOTHING;                      -- la 2.ª pasada NO re-enciende lo que alguien apagó

INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('tramites.sincronizacion.configurar', 'tramites', 'Configurar la sincronización con FLIT',
   'Encender o apagar, en este ambiente, la entrada de trámites desde FLIT 1 y desde FLIT 2.', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

-- VALUES explícitos (no CROSS JOIN): lo parsea __tests__/helpers/permisos-seed-sql.ts.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'tramites.sincronizacion.configurar')
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

DO $resumen0217$ ... -- calco del 0214: cuenta 2 filas (flit1, flit2), 1 función, 1 reparto admin;
                     -- RAISE EXCEPTION si no cuadra; RAISE NOTICE con cuántas fuentes quedan APAGADAS
                     -- (sin nombres de usuario). Por código exacto, nunca por prefijo `tramites.*`.
END $resumen0217$;
```

Nombre/descripción **byte a byte** iguales a la entrada de `catalogo-operaciones.ts` (lo comprueba el test, como en la 0214).
Drizzle en `schema.ts`: `flitoSyncInterruptor` junto a `flitoSyncFlit2Lectura` (varchar PK, boolean, timestamptz con `withTimezone`, FK `users.id`).

---

## Contrato delta

Tipos nuevos en `packages/shared-types/src/flito-flit2.ts`:

```ts
export type FuenteSincronizacion = 'flit1' | 'flit2';
export type MotivoFuenteDeshabilitada = 'maestro' | 'interruptor';
export interface InterruptorFuente {
  fuente: FuenteSincronizacion; encendido: boolean;
  actualizadoEn: string | null; actualizadoPor: { id: number; nombre: string } | null;
}
export interface InterruptoresSincronizacion { fuentes: InterruptorFuente[]; maestroFlit2: boolean }
export interface GuardarInterruptorInput { encendido: boolean }
export interface EstadoHabilitacionFuente { habilitada: boolean; motivoDeshabilitada: MotivoFuenteDeshabilitada | null }
// Flit2EstadoConexion extends EstadoHabilitacionFuente (campos nuevos, requeridos).
// Nuevo SyncEstadoFlit1 { ultimaSincronizacion: string | null; hayTramites: boolean } & EstadoHabilitacionFuente.
```

| Método y ruta | Guarda | Respuestas |
|---|---|---|
| `GET /api/flito/sync/interruptores` | `exigirFuncion('tramites.sincronizacion.configurar')` | 200 `InterruptoresSincronizacion` (siempre las 2 fuentes, orden flit1, flit2; sin clientId ni nada de credenciales) · 401 · 403 |
| `PUT /api/flito/sync/interruptores/:fuente` body `{ encendido }` | idem | 200 `InterruptorFuente` (ya persistido) · 400 `{ error, codigo:'datos_invalidos', faltantes }` si `:fuente ∉ {flit1,flit2}` o `encendido` no booleano / clave extra (`.strict()`) · 401 · 403 |
| `POST /api/flito/sync/sincronizar` (existente) | `sync.sync.lanzar` | **nuevo** 409 `{ error, codigo:'FUENTE_APAGADA', fuente:'flit1' }` antes de cualquier otra cosa |
| `GET /api/flito/sync/estado` (existente, FLIT 1) | `sync.sync.ver_estado` | + `habilitada`, `motivoDeshabilitada: 'interruptor' \| null` |
| `GET /api/flito/sync/flit2/estado` (existente) | `sync.sync.ver_estado` | + `habilitada`, `motivoDeshabilitada`: `'maestro'` si `FLIT2_SYNC_CRON=false` (precede), si no `'interruptor'` si apagada, si no `null` |

`codigo: 'FUENTE_APAGADA'` va en mayúsculas porque así lo nombra el AC5; el resto de códigos del módulo son `snake_case` en minúscula (`lectura_concurrente`). Se respeta el AC; queda anotado.

Auditoría del PUT (AC10): `audit(req, { action: 'update', resource: 'flito_sync_interruptor', resourceId: fuente, detail: 'Interruptor flit2: encendido → apagado' })` — también con anterior = nuevo (`'… encendido → encendido (sin cambio)'`). `audit_logs` ya guarda usuario y fecha. Sin nombres ni datos de persona en el detalle.

Persistencia del PUT en una transacción: `SELECT encendido … WHERE fuente = $1 FOR UPDATE` (anterior) → `UPDATE … SET encendido, updated_at = now(), updated_by = sub`. Fila ausente → `INSERT … ON CONFLICT (fuente) DO UPDATE` con anterior = `true` (default sembrado). Dos PUT a la vez se serializan por el `FOR UPDATE`: gana el último, cada uno audita su par.

---

## Dónde va cada guarda

Servicio nuevo `flito-sync-interruptor.service.ts`:
- `fuenteHabilitada(fuente): Promise<boolean>` — `SELECT encendido` por PK; ausente → `true` + `warn`.
- `estadoHabilitacionFlit1()` / `estadoHabilitacionFlit2()` → `EstadoHabilitacionFuente` (la de FLIT 2 aplica `env.FLIT2_SYNC_CRON` primero).
- `exigirFuenteHabilitada(fuente)` → lanza `FuenteApagadaError` (`codigo 'FUENTE_APAGADA'`, `status 409`, `fuente`).
- `listarInterruptores()`, `guardarInterruptor(fuente, encendido, userId)` → `{ anterior, actual }`.

| AC | Archivo · función | Qué |
|---|---|---|
| 5 | `flito-sync.routes.ts` · handler `POST /sincronizar` | Primera línea del handler: `if (!(await fuenteHabilitada('flit1')))` → 409. Antes de `leerUltimaSincronizacion`, `sincronizar` y `guardarUltimaSincronizacion`: no consulta FLIT 1, no escribe, no mueve la última. FLIT 1 es una sola llamada, no paginada: no hay guarda «a mitad» (fuera del pedido). |
| 6, 8 | `flit2-lectura.service.ts` · `leerConCandado` | Antes de `conCandadoLectura`: `await exigirFuenteHabilitada('flit2')`. Cubre los dos orígenes (cron y tras guardar el acceso) sin reservar conexión ni pedir el pase. El cursor no se toca: al encender, el siguiente tick entra por la rama `cursor` de `leerIncremental` (no hay reinicio). El maestro (AC8) ya lo cumple `startFlitSync` (no arma el timer) y `lanzarLecturaTrasAcceso` (no lanza); no se duplica. |
| 6 | `flito-sync.cron.ts` · `correrLecturaFlit2Programada` y `flit2-lectura-acceso.ts` · `correrLecturaTrasAcceso` | Nueva rama `catch` `e instanceof FuenteApagadaError` → `log.debug` (cron: cada 5 min no debe ensuciar el log en `warn`). Sin ella caería en la rama `log.error` genérica. `registrarTick` sigue igual (el timer sigue vivo; solo no lee). |
| 7 | `flit2-lectura.service.ts` · bucle `while` de `leerIncremental` | Al inicio de cada vuelta, **antes** de `leerPaginaConEsperas`: `if (!(await fuenteHabilitada('flit2'))) { r.detenidaPor = 'fuente_apagada'; break; }`. La página anterior ya hizo commit (cursor movido dentro de su transacción). `r.hasMore` queda en el valor de la última página → `atrasada` refleja trabajo pendiente. |
| 7 | `flit2-lectura.service.ts` · bucle de `releerEnmascarados` y la condición que la lanza | Misma guarda por página (la relectura también pide a FLIT 2: «no entra nada»). Y no se lanza la relectura si `r.detenidaPor` está puesto. |
| 9 | `flito-sync.routes.ts` `GET /estado` y `flit2-estado.service.ts` | FLIT 1: `Promise.all` suma `estadoHabilitacionFlit1()`. FLIT 2: `obtenerEstadoConexion` lee la fila `flit2` en el mismo `Promise.all`; `EntradaEstado` gana `interruptorFlit2: boolean` y `maestro: boolean`; `componerEstado` (pura) calcula `habilitada`/`motivoDeshabilitada`. |

`Flit2LecturaResultado` (shared-types) gana `detenidaPor?: 'fuente_apagada'` (opcional: no rompe consumidores). `detalleAuditoria` puede añadir «detenida: fuente apagada» — solo totales, sin PII.

### AC7 frente al candado y al cursor optimista

- El candado de sesión (`conCandadoLectura`) se sigue tomando **una vez por corrida**; la guarda por página no lo suelta ni lo retoma. Apagar a mitad hace `break`: `leerIncremental` termina por el camino normal (`anotar(ultimaExitosaEn…, atrasada: r.hasMore)`), `leerConCandado` desmarca `enCurso` en su `finally` y suelta el candado.
- El cursor optimista no cambia: la guarda va **entre** transacciones de página, nunca dentro. Una página en vuelo (fetch + transacción) termina y mueve el cursor con su `IS NOT DISTINCT FROM`; la siguiente no se pide. No hay estado intermedio que reconciliar.
- La lectura de la guarda va por el pool normal, fuera de la transacción de la página: no amplía la ventana de la transacción ni toma locks sobre la fila del cursor.
- Ventana residual aceptada: si el PUT llega mientras la página está en vuelo, esa página entra (decisión 3: «termina la página actual»). Como mucho, una página (`PAGE_SIZE`) después del apagado.

### Caché: no

Una lectura por PK sobre una tabla de 2 filas por página (≤ `MAX_PAGINAS_SEGURIDAD` = 200 por corrida, en la práctica pocas) es despreciable frente al fetch HTTP de la página. Una caché en memoria (a) alargaría la ventana del AC7 más allá de «una página», y (b) con PM2 en cluster no tendría invalidación entre procesos: el PUT atendido por un worker no limpiaría la caché del worker que corre el cron. Sin caché, el valor viejo dura como máximo la página en vuelo.

---

## Permisos y el inventario de guardas

- `exigirFuncion('tramites.sincronizacion.configurar')`; nada de `requireRole(` (la valla legacy los cuenta).
- Las rutas nuevas viven en un **fichero aparte** `flito-sync-interruptores.routes.ts`, con su propio `router.use(authMiddleware)`, montado desde `flito-sync.routes.ts` con `router.use(interruptoresRouter)` — calco de `flit2-estado.routes.ts`. `montajesDeFunciones()` lee una lista fija de 22 ficheros (`permisos.paridad-reconduccion.test.ts`) y `inventario.generado.ts` es la foto «ANTES» del `requireRole`: una ruta nueva **dentro** de `flito-sync.routes.ts` exigiría fila en `RUTAS_RECONDUCIDAS` sin foto «ANTES» que la respalde. Fuera del inventario no se toca ni la fixture ni la foto.
- `flito-sync.routes.ts` sí cambia (guarda del 409 y estado), pero sin `exigirFuncion` nuevo: sus dos filas del inventario (`GET /estado`, `POST /sincronizar`) quedan igual.
- Catálogo: **una** entrada en `OPERACIONES_DECLARADAS` (`catalogo-operaciones.ts`), bloque «Sincronización FLITO», con `const SYI = 'flito-sync/flito-sync-interruptores.routes.ts'` y etiqueta `` `${SYI} PUT /interruptores/:fuente` ``. El `GET` reutiliza el código sin otra entrada (como `POST /acceso/probar` reutiliza `guardar_acceso`).
- `__tests__/helpers/permisos-seed-sql.ts`: añadir `'0217_sync_interruptor_fuente.sql'` a `MIGRACIONES_CON_REPARTO` (paridad con la 0179, como se hizo con la 0214).

---

## Archivos a crear/modificar

| # | Archivo | Acción | Vecino patrón |
|---|---|---|---|
| 1 | `apps/api/src/db/migrations/0217_sync_interruptor_fuente.sql` | crear | `0214_flit2_acceso.sql` |
| 2 | `apps/api/src/db/schema.ts` | `flitoSyncInterruptor` | `flitoSyncFlit2Lectura` / `flitoSyncFlit2Acceso` |
| 3 | `apps/api/src/modules/flito-sync/flito-sync-interruptor.service.ts` | crear (servicio + `FuenteApagadaError`) | `flit2-acceso.service.ts` (meta con quién/cuándo, join a `users` para `nombre`) |
| 4 | `apps/api/src/modules/flito-sync/flito-sync-interruptores.routes.ts` | crear (GET + PUT, Zod `.strict()`, audit) | `flit2-estado.routes.ts` + `datosInvalidos()` de `flit2.routes.ts` |
| 5 | `apps/api/src/modules/flito-sync/flito-sync.routes.ts` | montar sub-router; 409 en `/sincronizar`; `habilitada` en `/estado` | — |
| 6 | `apps/api/src/modules/flito-sync/flit2-lectura.service.ts` | guarda en `leerConCandado`, por página en `leerIncremental` y `releerEnmascarados`; RN nueva en cabecera | — (665 líneas brutas; margen amplio bajo 800) |
| 7 | `apps/api/src/modules/flito-sync/flito-sync.cron.ts` | rama `catch` `FuenteApagadaError` + línea en cabecera | — |
| 8 | `apps/api/src/modules/flito-sync/flit2-lectura-acceso.ts` | rama `catch` `FuenteApagadaError` | `flito-sync.cron.ts` |
| 9 | `apps/api/src/modules/flito-sync/flit2-estado.service.ts` | `EntradaEstado` + `componerEstado` + `obtenerEstadoConexion` | — |
| 10 | `apps/api/src/modules/permisos/catalogo-operaciones.ts` | 1 op | entradas `FL2` de la HU #13061 |
| 11 | `packages/shared-types/src/flito-flit2.ts` | tipos del contrato | `Flit2AccesoMeta`, `Flit2EstadoConexion` |
| 12 | `apps/api/__tests__/db/migracion-0217.test.ts` | crear: estático (sin BEGIN/COMMIT, sin `unaccent`, `DO $resumen0217$`), «la anterior es `0216_`» con `SQLS[SQLS.indexOf(ARCHIVO) - 1]`, nunca `sqls.length - 1`; paridad catálogo↔SQL; reparto solo admin | `migracion-0214.test.ts` |
| 13 | `apps/api/__tests__/helpers/permisos-seed-sql.ts` | +0217 en `MIGRACIONES_CON_REPARTO` | entrada `0214` |
| 14 | `apps/api/__tests__/services/flito-sync.interruptores.test.ts` | crear: AC1–5, 9 (FLIT 1), 10 por supertest | tests vecinos de `flito-sync` en `__tests__/services/` |
| 15 | `apps/api/__tests__/services/flito-sync.flit2-lectura.test.ts` | ampliar: AC6 (no llama al port), AC7 (apagar tras la 1.ª página → 1 página, cursor = `nextCursor` de esa página, el port no recibe una 2.ª llamada) | el propio fichero |
| 16 | test existente del cron / de `componerEstado` | ampliar: AC8 y AC9 FLIT 2 (pura, sin base) | el propio fichero |

---

## ADR: no aplica

Extiende `flito-sync` con su patrón (tabla de configuración + función sembrada a admin, como la 0214). No hay dependencia nueva, ni PII nueva, ni integración externa nueva, ni GET con PII en la query.

---

## Notas operativas

**backend-agent**
- P1: tests de las filas 12–16 únicamente; nada del glob del directorio.
- `npm run build -w packages/shared-types` antes de leer cualquier rojo de paridad (dist viejo).
- Migración: aplicar **solo la 0217** dos veces contra la BD local (P6); la 2.ª pasada no debe re-encender una fuente apagada a mano entre pasadas (probarlo con un `UPDATE … SET encendido=false` entre las dos).
- Mutantes que el QA debería poder usar (máx. 3): quitar la guarda por página (AC7 debe caer), invertir la precedencia maestro/interruptor en `componerEstado` (AC8/9), mover el 409 después de `leerUltimaSincronizacion`/`sincronizar` (AC5: el spy de `sincronizar` debe asertar 0 llamadas).
- El mock `chain` devuelve la fila entera aunque el `select` pida menos: el test del GET debe asertar que la respuesta **no** contiene claves ajenas (`clientId`, `secret*`), no solo que contiene las suyas.

**frontend-agent:** fuera de esta HU (BACKEND). Al añadir campos requeridos a `Flit2EstadoConexion`, `grep -rn "Flit2EstadoConexion" apps/web` (regla 7): los fixtures/mocks que construyan el objeto completo fallarán `tsc` y hay que darles `habilitada: true, motivoDeshabilitada: null`. Si la UI de esta Feature usa `hasFuncion('tramites.sincronizacion.configurar')`, el código va a `FUNCIONES_POR_ROL.admin` en `apps/web/e2e/helpers/auth.ts` (como `tramites.flit2.*` en L213) — en la HU de UI, no en esta.

**security-agent / db-review-agent:** ambos disparan (ruta nueva + migración). Puntos: respuesta del GET sin credenciales; detalle de auditoría sin PII; `ON CONFLICT DO NOTHING` en la siembra del interruptor; FK `updated_by` sin `ON DELETE` (la baja de usuarios es lógica, 0190).

---

## Riesgos abiertos y qué falta decidir

1. **Alerta del estado con la fuente apagada (pendiente humano, menor).** `componerEstado` levanta `alerta=true` tras 30 min sin lectura exitosa: apagar FLIT 2 a propósito pintaría alerta a la media hora. Recomendación: `alerta=false` cuando `habilitada=false` (el motivo ya informa). Si el humano no lo valida, se deja como está y se anota en el PR.
2. **`automatica.proximaEn` con el interruptor apagado.** El timer sigue armado (el maestro manda el timer, el interruptor solo la lectura), así que el estado seguirá anunciando una «próxima corrida» que no leerá. Recomendación: dejar `automatica` como pulso del proceso y que la UI priorice `habilitada`. Sin cambio en esta HU.
3. **Inventario de guardas.** Si algún test de cierre (`permisos.reconduccion-cierre.test.ts`) recorre todos los `exigirFuncion` del módulo y no solo los 22 ficheros, el fichero nuevo pediría fila en `RUTAS_RECONDUCIDAS`. No verificado con lectura (presupuesto); el patrón de `flit2-estado.routes.ts` / `flit2-probar.routes.ts` indica que no. Si el CI lo pide, añadir la fila y su foto, no mover las rutas.
4. **Una entrada de catálogo para dos rutas.** Si algún test exige una entrada por ruta con `exigirFuncion`, añadir la del `GET` con el mismo código.
5. **Número de migración.** 0217 a la fecha de c3bf6972; con sesiones en paralelo, revisar `ls migrations | tail` antes del PR y ajustar el test «la anterior es …».
6. **Código `FUENTE_APAGADA` en mayúsculas** frente a la convención minúscula del módulo: se sigue el AC5 literal.
