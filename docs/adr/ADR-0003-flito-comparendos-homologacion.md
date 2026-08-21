# ADR-0003 — Homologación SIMIT Verifik ↔ municipal UTS (mapa versionable)

## Estado

**Aceptado** — Feature [#11492](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11492) (17a).  
Aprobado por Líder Técnico (2026-08-13): canónico + JSONB + `field_map` versionable; spike de payloads en HU corta.

## Contexto

El merge exige que SIMIT prevalezca y municipal aporte solo campos ausentes. Aún no hay payloads reales Verifik/UTS en el repo (solo normalización FCM en `simit.direct.ts`, transporte distinto). El Feature pide mapa de campos en diseño técnico previo y señala homologación incompleta como riesgo Medio.

## Decisión

1. Mantener **columnas canónicas** tipadas en `flito_comparendos_registros` más `payload_simit` / `payload_municipal` JSONB (auditoría y re-homologación).
2. Tabla `flito_comparendos_field_map` versionada: `(version, origen, source_path) → target_field`, con flag `provisional`.
3. **v1 provisional** se siembra en la migración `0150_flito_comparendos_ingesta.sql` usando candidatos alineados a `SimitComparendo` / `normalizeComparendos` y alias municipales comunes (detalle en el diseño del Feature).
4. **Spike** (HU BACKEND corta): capturar respuestas reales redactadas → fixtures de test → validar/ajustar mapa → insertar `version=2` con `provisional=false`. El código de merge lee la **máxima versión** activa.
5. Regla de aplicación: para cada `target_field`, tomar valor SIMIT si presente; si no, municipal; nunca pisar un canónico no vacío con municipal.
6. **Normalización de `numero_comparendo` — cerrada por el spike (HU #11501).** La regla vigente la
   implementa `numeroCanonico` en `flito-comparendos-merge.ts`: **mayúsculas y sin espacios internos**
   (`replace(/\s+/g, '')`, no un `trim`), rechazando el vacío. Es más agresiva que la provisional a
   propósito: `' c-1 '`, `'C-1'` y `'C - 1'` son el mismo comparendo — un proveedor que espacie el
   número por bloques no debe crear una segunda deuda. Lo que **no** hace es adivinar separadores:
   `'C 1'` normaliza a `'C1'` y por tanto NO colapsa con `'C-1'`.
   - **No se recorta.** Si el resultado no cabe en `varchar(60)` se descarta el ítem entero
     devolviendo `null`, y el descarte se cuenta. Recortar la llave inventaría un comparendo que no
     existe y podría colisionar con otro que comparta prefijo, fundiendo dos deudas en una fila.
   - **El lookup NO es case-insensitive.** `registros.service` usa `like` y no `ilike` justamente
     porque lo guardado ya está normalizado; un `ilike` aquí sería una red que tapa el día en que
     alguien escriba sin normalizar.
   - Esto **deroga** la regla provisional anterior («`trim` + conservar case del primer visto,
     comparar case-insensitive en lookup»), que rigió hasta la migración 0158.

## Alternativas consideradas

| Alternativa | Por qué no |
|---|---|
| Hardcode if/else en service sin tabla | No versionable; difícil auditar cambios de API |
| Solo JSONB sin canónico | Merge y filtros 17b inestables |
| Esperar payloads reales antes de cualquier schema | Bloquea CRUD/param/token/sync scaffolding innecesariamente |

## Re-merge desde JSONB tras subir la versión del mapa (HU #11501, AC3)

Procedimiento **one-shot y manual**. No hay job productivo en 17a y el AC no lo pide.

**La verdad incómoda primero: para las filas ingeridas bajo la v1, el re-merge desde JSONB NO basta.**
La lista blanca de RN-25 se deriva del mapa **vigente en el momento de ingerir**, así que un
`payload_simit` escrito con la v1 fue podado con la v1 y **no contiene** las rutas que la v2 necesita
(`infracciones.0.*`, `estadoCuenta.*`): esos campos no están «sin homologar», están **ausentes del
JSONB**. La red de ADR-0003 funciona hacia adelante —re-homologar con un mapa que solo mueva nombres
ya conservados—, no hacia atrás. Para esas filas la única vía es **volver a preguntarle al proveedor**
(re-correr el sync del NIT), y por eso conviene subir la versión del mapa *antes* de la primera
ingesta real, no después.

**Por qué hoy no muerde.** El modo `real` no llegó a funcionar contra ninguna de las dos fuentes hasta
la corrección de payloads reales (2026-08-20), y `COMPARENDOS_SIMIT_MODE=mock` está abortado en
producción por RN-16. Lo persistido bajo la v1 es, a lo sumo, ruido de DEV.

**Procedimiento**, si algún día hay filas que sí valga la pena rescatar:

1. **Identificar candidatas.** Filas de `flito_comparendos_registros` con `payload_simit` /
   `payload_municipal` no nulo y algún canónico en `NULL` que la versión vigente sí sabría llenar.
   Es una consulta de lectura; no hay columna que registre con qué versión se ingirió cada fila (ver
   deuda abajo), así que la fecha de la corrida y la de la migración del mapa son el criterio.
2. **Decidir por fila** si el JSONB contiene la ruta que hace falta (`payload_simit ? 'infracciones'`).
   Si no la contiene, la fila **no** es candidata a re-merge: es candidata a re-consulta.
3. **Re-homologar** en un script one-shot que reutilice `homologar()` y `resolverCampos()` de
   `flito-comparendos-merge.ts` con el mapa vigente, escribiendo solo canónicos hoy en `NULL`
   (RN-13: no pisar lo que ya tiene valor).
4. **Si hay que revertir el mapa**, no se borra la versión nueva: `operaciones_app` no tiene `DELETE`
   sobre `flito_comparendos_field_map` y el proyecto no lleva scripts `down`. Se **siembra una v(n+1)
   que copie las filas de la versión buena** —el merge lee la MÁXIMA—; el `INSERT … SELECT` literal
   está en la cabecera de `0158_flito_comparendos_field_map_v2.sql`.

**Deuda conocida:** ninguna fila registra con qué versión del mapa se ingirió, así que el paso 1 es
heurístico. Una columna `field_map_version` en `flito_comparendos_registros` lo volvería mecánico.

## Consecuencias

- **Positivas:** 17a avanza con mocks; spike acota el riesgo de homologación sin reescribir el modelo.
- **Negativas:** Drift v1→v2 confirmado (ver arriba): el re-merge desde JSONB solo rescata lo que la poda de la versión ANTERIOR conservó; el resto exige re-consultar al proveedor.
- **Fixtures del spike:** `apps/api/__tests__/fixtures/comparendos/payloads-fuente.ts` — forma de las respuestas reales del 2026-08-20 con valores fabricados (AC1).
- **Referencia de campos (no de transporte):** `apps/api/src/modules/integraciones/simit.direct.ts` — solo como lista de alias conocidos.
- **Supersedes:** ninguno.
