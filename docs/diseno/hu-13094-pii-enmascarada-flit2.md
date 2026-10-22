# HU #13094 — Defensa ante datos personales enmascarados de FLIT 2 (delta)

Feature #13059 · Épica #12736 · Base: diseños `hu-13091-lectura-incremental-flit2.md`,
`hu-13092-lectura-programada-flit2.md` y `hu-13093-compradores-soat-flit2.md`. Contrato:
`docs/integraciones/flit2-api.md` §4 (sin `external.tramites.pii.read`, los campos PII de
`compradores[]` —documento, nombre, dirección, celular, correo— llegan enmascarados, nunca ausentes;
nada más del ítem se enmascara).

Es una **defensa**: los tres clientIds tienen `pii.read` (HU FLIT #13088). Reglas en la cabecera de
`apps/api/src/modules/flito-sync/flit2-lectura.service.ts` como **RN-18…RN-20**.

## Esquema (migración 0216, a mano e idempotente)

| Tabla | Columna | Uso |
|---|---|---|
| `flito_tramites` | `flit2_pii_enmascarada boolean NOT NULL DEFAULT false` + índice parcial `idx_flito_tramites_flit2_pii_enmascarada (id) WHERE flit2_pii_enmascarada` | Trámite leído sin el scope; espera la relectura |
| `flito_sync_flit2_lectura` | `pii_enmascarada_desde timestamptz` | Primera lectura enmascarada pendiente de recuperar; null = nada que recuperar |
| `flito_sync_flit2_lectura` | `cursor_relectura text` (CHECK 1..2000) | Posición de la relectura de recuperación; null = empieza desde el arranque |

`schema.ts` (techo congelado 3400) solo gana la columna y el índice de `flito_tramites`; las dos
columnas de la lectura van en `db/schema/flito-sync.ts`, donde ya vive esa tabla.

## Detección (RN-18, AC1)

Por el **scope del pase**, nunca por el patrón del dato:

- `Flit2SyncPort.verificarAcceso()` devuelve `{ conPii }` (el HTTP lo saca de `obtenerPase()`).
- `PaginaFlit2.conPii`: el adaptador HTTP captura el `conPii` del pase con que salió **esa** página
  (dentro de `conPase`), así un pase renovado a mitad de corrida con otro scope se respeta página a
  página. Si el adaptador no lo dice, vale el del acceso.
- Página sin el scope: cada trámite aplicado queda con la marca `true`, y en la misma transacción de la
  página se anota `pii_enmascarada_desde` (solo si estaba en null) y se pone `cursor_relectura = null`.
- Un trámite que se aplica **con** el scope pierde la marca (lectura normal con versión nueva, o
  relectura).

## Trámite enmascarado (RN-19, AC2, AC3)

- No se mapean los compradores: ni se escriben, ni se toca el titular del vehículo; se conservan los
  guardados (mismo camino que RN-15, `compradores` vacío). Un trámite nuevo nace sin compradores.
- Lo demás (estado, vehículo, organismo, compañía, `tipo_propiedad` por conteo) sí se aplica: no es PII.
- SOAT e impuesto no arrancan aunque esté asignado y tenga un principal guardado; la lectura no falla.

## Recuperación (RN-20, AC4)

**Decisión (backend-agent): misma corrida, después de la normal.** La relectura corre dentro de
`leerIncremental`, es decir bajo el mismo candado de `leerConCandado` y con el tope de tiempo que le
quede a la corrida, **solo si**:

1. la lectura normal terminó bien y al día (`hasMore = false`), con tiempo restante;
2. la última página normal salió con el scope (o el acceso lo tenía, si no hubo páginas);
3. la fila tiene `pii_enmascarada_desde` o `cursor_relectura` no null.

Motivo: la posición normal tiene prioridad (lo nuevo de FLIT 2 no se retrasa por recuperar lo viejo), no
hace falta otro cron ni otro candado, y el botón y el cron recuperan igual.

- Parte «desde el cursor vacío»: `since = since_arranque`, el mismo arranque de la lectura normal, que
  cubre todo lo que FLITO leyó alguna vez. Con `cursor_relectura`, sigue desde ahí.
- Solo aplica trámites **existentes y marcados**, con versión **igual o mayor** a la guardada (menor,
  nunca: sería retroceder). Lo demás se cuenta como «sin cambios» de la relectura; no crea trámites.
- El cursor normal (`cursor`) no se toca. La relectura tiene su propia guarda optimista sobre
  `cursor_relectura`.
- Resultado: solo contadores en el log (`relectura FLIT 2 de trámites enmascarados`). El
  `Flit2LecturaResultado` (shared-types) y la auditoría de la corrida no cambian: la relectura no suma a
  los totales de la lectura normal.

**Decisión (backend-agent): corte y reanudación.** Cada página de la relectura guarda su cursor en
`cursor_relectura` (columna nueva de la 0216) en la misma transacción que aplica la página. Si la corta
el tope (RN-10), un 429 que no cabe, un error del feed o una página que vuelve sin el scope, el cursor
queda y la corrida siguiente la retoma desde ahí. Un fallo de la relectura **no** tumba la lectura normal,
que ya quedó guardada y anotada: se loguea el código (sin PII) y ya.

**Decisión (backend-agent): limpieza de `pii_enmascarada_desde`.** Se pone en null, junto con
`cursor_relectura`, en la transacción de la **última** página de una relectura completa (`hasMore =
false`). Una página enmascarada en la lectura normal reinicia la relectura (`cursor_relectura = null`)
para no dejar atrás el trámite recién marcado. Un trámite que siga marcado tras una relectura completa
(p. ej. borrado en FLIT 2: los tombstones se ignoran) conserva la marca, pero no vuelve a disparar
relecturas; se recupera si llega una versión nueva con el scope.

## Sin PII (AC5)

Logs: solo conteos (`items`, contadores, `codigo`, `paginas`). `flit_raw` sigue con la lista blanca de
`rawSinPii`, así que tampoco guarda los valores enmascarados. La auditoría solo lleva totales (RN-13).

## Nota pendiente de QA #13093 (decisión, backend-agent)

«Con 2 compradores y 1 omitido, el que queda se guarda con porcentaje null»: **se mantiene**. El
porcentaje se conserva tal como llega; solo un comprador **único** en FLIT 2 sin porcentaje es 100 %.
Poner 100 % al superviviente de una copropiedad le atribuiría una propiedad que no tiene. Con esta HU
el caso ya no puede venir del enmascarado (con la página sin scope no se escribe ningún comprador); solo
queda para un dato incompleto de FLIT 2, que el log cuenta (`omitidos`).

## Tests

- `__tests__/services/flito-sync.flit2-lectura.test.ts` — bloque «HU #13094 · PII enmascarada» (AC1-AC5).
- `__tests__/services/flito-sync.flit2-sync-http.test.ts` — `conPii` del acceso y por página; fake.
- `__tests__/db/migracion-0216.test.ts` — estática + Drizzle + P6 con `TEST_DATABASE_URL`.
- `__tests__/db/migracion-0215.test.ts` — lista de columnas de la lectura ampliada con las de la 0216.
