# Diseño slim — HU #13629: lectura automática de FLIT 1 (ventana móvil + nocturna)

Feature #13612 · Épica #13576 · Módulo FLITO `flito-sync` (habla con FLIT **1**, `flit-http.adapter.ts`;
no toca el legacy `soat`/`tramites`). Apilada sobre la HU #13628 (tabla `flito_sync_flit1_lectura`, 0241).
Estado: **Propuesto** (diseño slim; sin ADR).

## Patrón reutilizado

| Pieza | Vecino que se calca |
|---|---|
| Timer `setInterval` + `unref` + guarda `enCurso` del proceso | `apps/api/src/modules/flito-sync/flito-sync.cron.ts` (FLIT 2) |
| Advisory lock de sesión sobre conexión reservada, no bloqueante | `apps/api/src/modules/flito-sync/flit2-candado.ts` |
| Fila única de estado de la lectura, `UPDATE … WHERE id = 1` cortos, sin tx larga | `flito_sync_flit1_lectura` (0241) + `flito-sync-flit1-parametros.service.ts` (RN-06) |
| Interruptor por fuente en base | `flito-sync-interruptor.service.ts` (`fuenteHabilitada('flit1')`) |
| Escritura por trámite, transacción propia, fallo a la Bitácora | `sincronizar()` / `sincronizarUno()` (HU #13626/#13627) |
| Fechas en Bogotá | `shared/utils/fecha-rango.ts` (`hoyColombia`) + `arranquePorDefecto` de la #13628 |

## Decisiones

### D1. Timer fijo de 60 s; la decisión «¿toca?» vive en la base, con el candado tomado

- `startFlitSync()` arma un **segundo** timer (`TICK_FLIT1_MS = 60_000`, `unref`) junto al de FLIT 2. Cada tick:
  1. `enCurso` local → se salta (log `debug`).
  2. Maestro de entorno apagado → el timer ni se arma (D7).
  3. `fuenteHabilitada('flit1')` **antes** de reservar conexión (calco de FLIT 2: no se reserva una conexión
     por minuto para nada). Apagada → no lee FLIT 1 ni escribe nada salvo poner `proxima_prevista_en = NULL`
     si no lo estaba (una sola escritura; el estado no debe mostrar una «próxima» que no va a pasar).
  4. `conCandado(CLAVE_CANDADO_LECTURA_FLIT1, …)`. No tomado → `log.info('… otra corrida tiene el candado, se salta este tick')` (AC5: el salto queda en el log).
  5. Dentro del candado: **relee** la fila (parámetros + marcas) y decide con una función pura (D3). Así el
     cambio de frecuencia/ventana aplica en el siguiente tick sin reiniciar (AC8) y en PM2 cluster corre como
     mucho una periódica por periodo (AC5): el segundo proceso entra al candado después y ve la marca nueva.
- **Tolerancia de medio tick:** toca periódica si `ahora ≥ ultima_corrida_en + frecuencia − 30 s`. Sin ella, con
  frecuencia 2 min y tick de 1 min, el periodo efectivo sería 3 min. Periodo real: frecuencia ± 30 s.
- **Candado:** un solo par para periódica **y** nocturna (eso es lo que hace que no se pisen):
  `CLAVE_CANDADO_LECTURA_FLIT1 = [13_629, 1] as const` (forma de dos enteros, `objsubid = 2`, mismo criterio
  que el comentario de `flit2-candado.ts`; distinto de `[13_092, 2]`).
- **Refactor mínimo del candado:** extraer el cuerpo de `conCandadoLectura` a `conCandado(clave, fn)` en un
  archivo nuevo `candado-advisory.ts`; `flit2-candado.ts` queda como `conCandadoLectura = (fn) => conCandado(CLAVE_CANDADO_LECTURA_FLIT2, fn)`,
  con su clave y su texto de log intactos (el test `flito-sync.flit2-candado.test.ts` debe seguir verde sin
  tocarlo). El `log.warn` de «no se pudo soltar» recibe la etiqueta de la fuente.

### D2. Marcas de la última corrida: migración 0242 con dos columnas nuevas

Ninguna columna de la 0241 sirve como marca de **intento**: `ultima_buena_en` no se mueve si falla y
`proxima_prevista_en` se calcula con la frecuencia vieja (rompería AC8). Derivar el intento de
`max(ultima_buena_en, ultimo_fallo_en)` funciona a medias y no cubre la nocturna. Se añaden:

| Columna | Tipo | Significado |
|---|---|---|
| `ultima_corrida_en` | `timestamptz NULL` | Inicio de la última corrida automática (buena o fallida). Se escribe **al empezar**, dentro del candado, antes de llamar a FLIT 1: un proceso que muere a mitad no provoca reintento cada minuto |
| `nocturna_buena_dia` | `date NULL` | Día (Bogotá) de la última nocturna **buena** |

`ALTER TABLE flito_sync_flit1_lectura ADD COLUMN IF NOT EXISTS …` ×2, `COMMENT ON COLUMN`, sin `BEGIN/COMMIT`,
bloque `DO $resumen0242$` con `RAISE NOTICE`. Sin literales de rol ni permisos. **Verificar el número al
implementar** (memoria «tip de ráfaga ≠ solo tus merges»): hoy develop termina en 0240 y esta cadena trae 0241.
Escritura del estado, siempre `UPDATE … WHERE id = 1` cortos fuera de transacción (RN-06 de la #13628):

| Momento | Columnas |
|---|---|
| Inicio (con candado, tras decidir que toca) | `ultima_corrida_en = inicio`, `proxima_prevista_en = inicio + frecuencia` |
| Corrida buena | `ultima_buena_en = inicio` (+ `nocturna_buena_dia = hoy` si fue nocturna) |
| Corrida fallida | `ultimo_fallo_en = now`, `ultimo_fallo_codigo = <código>` — **no** toca `ultima_buena_en` |
| Tick sin corrida, parámetros cambiados | `proxima_prevista_en = ultima_corrida_en + frecuencia` solo si difiere |

`ultima_buena_en` guarda el **inicio** de la corrida, no el fin: lo que FLIT 1 creó mientras se leía cae en la
siguiente ventana. `GET /flit1/estado-lectura` de la #13628 no cambia (no expone las columnas nuevas).

### D3. Función pura de planificación (el corazón testeable)

`planificarLecturaFlit1({ ahora, parametros, marcas, semillaKv }) → { toca: false, motivo } | { toca: true, tipo: 'periodica' | 'nocturna', initialDate, finalDate }`

- `hoy = hoyColombia(ahora)`; `finalDate = hoy + 1 día` (límite exclusivo `$lt`, AC1); fechas en `YYYYMMDD`.
- **Toca periódica:** `ultima_corrida_en` null, o `ahora ≥ ultima_corrida_en + frecuencia − 30 s`.
- **Nocturna pendiente:** hora Bogotá ≥ 02:00 y `nocturna_buena_dia ≠ hoy`.
- **Toca nocturna:** pendiente **y** (`ultima_corrida_en < hoy 02:00 Bogotá` **o** toca periódica). La primera
  rama la dispara en el primer tick ≥ 02:00 (o en el primero del día si el proceso no estaba vivo, AC2); la
  segunda hace que, si falla, se reintente en el siguiente slot de frecuencia y no cada minuto.
  Una nocturna ocupa el slot de la periódica (su rango es superconjunto: `nocturna ≥ ventana` por CHECK).
- **Rango** con `N = ventana` (periódica) o `nocturna`:
  `base = día Bogotá de ultima_buena_en` · si es null: `semilla` (D4) ·
  `initialDate = max(hoy − 90, min(hoy − N, base))` (AC3 + AC4, tope 90).
- Bogotá es UTC−5 fijo (sin horario de verano): `hora Bogotá` y `hoy 02:00 Bogotá` se calculan desde UTC, nunca
  con `getHours()`/`getDate()` locales (la ruta manual sí usa la hora local del servidor: deuda de la ruta que
  retira la #13631, no se toca aquí).

### D4. `system_kv['flito.ultima_sincronizacion']`: semilla de solo lectura

Se acepta la propuesta del hilo, con orden de precedencia explícito para la semilla (solo cuando
`ultima_buena_en` es null):

1. `arranque` **guardado** en la fila (no null) — un operador que lo fijó a mano manda;
2. si no, el día Bogotá de `system_kv['flito.ultima_sincronizacion'].at` (PDN la tiene) — el día **completo**:
   la ruta manual usaba `finalDate = hoy` exclusivo, así que el día de `at` nunca se leyó;
3. si no, `arranquePorDefecto(hoy)` (hace 1 mes).

Siempre con el tope de 90 días. La clave **no se escribe nunca** desde la lectura automática ni se lee
después de la primera buena. El estado expuesto (AC8 de la #13628, RN-07) sigue vacío hasta la primera
corrida: la semilla solo entra en `initialDate`. Un valor ilegible en la clave se trata como ausente (log
`warn` sin valor).

**Convivencia con `POST /flito/sync/sincronizar` hasta la #13631:**
- La ruta manual sigue leyendo/escribiendo la clave como hoy; **no** mueve `ultima_buena_en` (su rango es
  arbitrario, no prueba continuidad de la ventana).
- La ruta manual **toma el mismo candado** `CLAVE_CANDADO_LECTURA_FLIT1`; si está tomado responde `409
  { codigo: 'LECTURA_EN_CURSO' }` sin llamar a FLIT 1. Sin esto, una manual y una automática sobre el mismo
  radicado compiten y una de las dos termina en `23505` → entrada «falló» espuria en la Bitácora. Son ~6 líneas
  en la ruta. **Pendiente de confirmar por el humano** (cambia el contrato de la ruta manual: P-2).
- `GET /flito/sync/estado` sigue mostrando la clave: quedará atrasada respecto de la automática hasta la
  #13631. Nota, no se corrige aquí.

### D5. Cuándo la corrida es «buena»

**Buena = el reporte de FLIT 1 se obtuvo y se parseó, y el bucle terminó.** Los fallos de trámites
individuales **no** impiden mover `ultima_buena_en`; si hubo alguno, además se escribe
`ultimo_fallo_codigo = 'tramites_con_fallo'` (y `ultimo_fallo_en`), para que el estado lo muestre.

Por qué: con la transacción por trámite (#13627), un solo radicado envenenado (violación persistente)
congelaría `ultima_buena_en` y la ventana crecería sola hasta 90 días, releyendo todo cada 2 minutos para
siempre. El fallo ya queda en la Bitácora por radicado (HU #13627) y la nocturna (60 días) lo reintenta cada
noche; si el radicado envejece más que la nocturna, deja de reintentarse — riesgo aceptado y visible
(Bitácora + `tramites_con_fallo`).

Para contarlo, `sincronizar()` lleva un contador local de fallidos y devuelve
`ResultadoCorrida = ResultadoSync & { tramitesFallidos: number }` (tipo **local** del servicio): no se toca
`packages/shared-types` y la ruta manual sigue recibiendo un superconjunto compatible.

**Fallo de corrida** (no buena): el adaptador lanza o el `select` inicial de la fila falla. Códigos
(`^[a-z0-9_]{1,40}$`, CHECK de la 0241): `flit1_http_<status>`, `flit1_timeout`, `flit1_red`,
`flit1_respuesta_invalida`, `base_datos`, `desconocido`.
Para eso `flit-http.adapter.ts` deja de lanzar `new Error(\`FLIT report ${status}: ${texto}\`)` (el cuerpo de
FLIT 1 puede traer PII y hoy acaba en el log y en el 500 de la ruta manual) y lanza
`Flit1ReporteError { codigo, status }` sin el cuerpo. Y añade `signal: AbortSignal.timeout(FLIT1_REPORTE_TIMEOUT_MS)`
(constante, 5 min): hoy el `fetch` no tiene timeout, y un FLIT 1 colgado retendría el candado (y `enCurso`)
indefinidamente, parando todas las lecturas siguientes.

### D6. AC6 — solo se escribe lo que cambió (opt-in de FLIT 1)

Corrección de una premisa del pedido: **`escribirTramite` hoy no evita el UPDATE** — lo hace siempre (con
`sincronizadoEn` y `updatedAt` nuevos); lo único que se salta lo idéntico es el historial
(`registrarDiferencias`) y la Bitácora (`detalleBitacora` → null). Además `reemplazarCompradores` borra e
inserta siempre. Los tres puntos se cambian, con una opción `{ soloSiCambia: true }` que pasa **solo FLIT 1**
(`sincronizarUno`/`upsertTramite`); FLIT 2 sigue exactamente igual (sus tests y su `syncVersion` no se tocan).

1. **Vehículo — `upsertVehiculo(tx, tf, companiaId, { soloAlta, soloSiCambia })`.** Orden fijo:
   (a) `soloAlta` con VIN existente → devuelve el id sin leer más (Bug #13585, primero);
   (b) el `select` del existente pasa a traer las 10 columnas que escribe `setVehiculoDesdeFlit`;
   (c) `parche = claves de setVehiculoDesdeFlit(tf) cuyo valor difiere del existente`;
   (d) `parche` vacío → sin UPDATE; si no, `UPDATE set({ ...parche, updatedAt })`.
   La placa vacía sigue sin borrar porque `setVehiculoDesdeFlit` ni la incluye (spread condicional): el diff
   compara solo lo que la función ya decidió escribir. Upsert sigue por VIN; el trámite, por `id_flit`.
2. **Trámite — `escribirTramite(…, { soloSiCambia })`.** Compara **todas** las columnas de `valores` salvo
   `sincronizadoEn`, normalizadas: fechas por `getTime()`, `valorImpuestoLiquidado` como numeric
   (`'1000.00'` = `1000`), `flitRaw` por igualdad profunda **independiente del orden de claves** (jsonb
   reordena). Sin diferencias → sin UPDATE, devuelve `{ row: existente, huboCambios: false, diferencias: [] }`.
   El historial y la Bitácora ya no se llaman en ese caso (darían vacío igual).
3. **Compradores.** En `upsertTramite`, si `diferenciasCompradores(guardados, nuevos)` es vacío **y** coinciden
   `orden` y `porcentajeParticipacion` (que `CAMPOS_COMPRADOR` no compara), no se llama a
   `reemplazarCompradores`.
4. **Conteo:** sigue la regla actual (`huboCambios` del trámite). Un cambio solo de vehículo cuenta como
   «sin cambios» del trámite (la Bitácora tampoco lo registra: no es su lista de campos). P-4.

Consecuencia declarada: `flito_tramites.sincronizado_en` deja de significar «visto en la última lectura» y
pasa a «última vez que cambió». Lo expone `flito-tramites.service.ts` en el DTO de la bandeja; ningún uso en
`apps/web` (grep sin resultados). Nota en el PR.

### D7. Interruptor de entorno: reutilizar `SYNC_HABILITADO`

Existe ya `SYNC_HABILITADO` en `config/env.ts` (default true; `false`/`0` apaga), documentada en
`.env.example` y en `server.ts` como «noop si `SYNC_HABILITADO=false`», pero **nadie la lee**: es exactamente
el maestro del job de FLIT (1) que nunca se cableó. Se reutiliza (corregir lo existente antes que añadir
`FLIT1_SYNC_CRON`): `startFlitSync()` arma el timer de FLIT 1 solo si `env.SYNC_HABILITADO`. Encendida por
defecto en todos los ambientes, como pide la HU («empieza sola al desplegar»). Un ambiente sin acceso a
FLIT 1 la pone en `false`; en caliente, el interruptor de base `flit1` (sembrado encendido por la 0217) la
apaga sin desplegar. `SYNC_CRON` e `intervalMsFromCron` quedan muertos (la frecuencia vive en la base):
retirarlos no es de esta HU — Nota/pregunta (P-5).

Riesgo que decide el humano (P-1): `FLIT_BASE_URL` apunta por defecto a **PDN de FLIT 1** desde DEV, QA y
PDN. Con la lectura encendida en los tres, FLIT 1 PDN recibe 3 GETs de 8 días cada ~2 min y una nocturna de
60 días por ambiente. Es solo lectura, pero DEV y QA escribirían en sus bases datos reales de PDN cada 2 min.

### D8. Logs sin PII (AC10)

Por corrida: `{ tipo, initialDate, finalDate, leidos, nuevos, actualizados, sinCambios, omitidosOtraFuente, fallidos, ms }`.
Fallo: `{ codigo }`. Salto: mensaje fijo. Nunca `err.message`, cuerpo de FLIT 1, VIN, placa, documento ni
`idFlit` (el `log.error({ idFlit })` existente por trámite es preexistente: Nota; el radicado no es PII de
persona y ya está en la Bitácora). La corrida automática no escribe `audit_logs` de «corrida» (calco de FLIT 2,
HU #13626): cada trámite cambiado ya deja su entrada.

## Contrato delta

- **Sin endpoints nuevos.** `GET /api/flito/sync/flit1/estado-lectura` (de la #13628) empieza a llenarse.
- `POST /api/flito/sync/sincronizar`: nuevo `409 { codigo: 'LECTURA_EN_CURSO' }` si la automática tiene el
  candado (sujeto a P-2); el 500 deja de devolver `detalle: error.message` cuando el error es `Flit1ReporteError`
  (devuelve `codigo`).
- Base: `flito_sync_flit1_lectura` + `ultima_corrida_en timestamptz NULL`, `nocturna_buena_dia date NULL`.
- Env: `SYNC_HABILITADO` pasa a tener efecto (maestro de la lectura automática de FLIT 1).
- `packages/shared-types`: **sin cambios**.

## Archivos a crear/modificar

| Acción | Archivo |
|---|---|
| Crear | `apps/api/src/db/migrations/0242_flito_sync_flit1_lectura_marcas.sql` (número a verificar) |
| Modificar | `apps/api/src/db/schema.ts` (o el archivo de `schema/` donde viva `flitoSyncFlit1Lectura`): 2 columnas |
| Crear | `apps/api/src/modules/flito-sync/candado-advisory.ts` (`conCandado(clave, fn)`) |
| Modificar | `apps/api/src/modules/flito-sync/flit2-candado.ts` (delegar; clave y API intactas) |
| Crear | `apps/api/src/modules/flito-sync/flit1-lectura-automatica.service.ts` (cabecera RN-xx; `planificarLecturaFlit1` pura, `leerMarcasFlit1`, `leerSemillaKv`, `correrLecturaFlit1Programada(ahora)`, escrituras de estado, `CLAVE_CANDADO_LECTURA_FLIT1`, `codigoFalloFlit1(e)`) |
| Modificar | `apps/api/src/modules/flito-sync/flito-sync.cron.ts` (timer FLIT 1 con `SYNC_HABILITADO`; cabecera: deja de decir «FLIT 1 solo manual») |
| Modificar | `apps/api/src/modules/flito-sync/flito-sync.service.ts` (`soloSiCambia` en `upsertVehiculo` y `escribirTramite`; compradores; contador de fallidos; `ResultadoCorrida`; cabecera) |
| Modificar | `apps/api/src/modules/flito-sync/flit-http.adapter.ts` (`Flit1ReporteError`, timeout, sin cuerpo en el error) |
| Modificar | `apps/api/src/modules/flito-sync/flito-sync.routes.ts` (candado + 409; 500 sin `message` crudo) |
| Modificar | `apps/api/.env.example` (comentario de `SYNC_HABILITADO` con su efecto real) |
| Crear (tests) | `apps/api/__tests__/services/flito-sync.flit1-planificacion.test.ts` (pura) · `flito-sync.flit1-lectura-automatica.test.ts` (tick/candado/estado) · `flito-sync.flit1-solo-si-cambia.test.ts` (AC6) · `flito-sync-migracion-0242.test.ts` |

`flito-sync.service.ts` va en 543 líneas: el nuevo código va en el servicio nuevo, no ahí (≤ 800, gate `max-lines`).

## ADR: no aplica

Extensión de `flito-sync` con su patrón (timer + advisory lock + fila única). El único precedente es el par
de claves `[13_629, 1]`, documentado en código igual que `[13_092, 2]`.

## Notas operativas

**backend-agent**
- Implementar `planificarLecturaFlit1` primero y cubrirla sola: AC1 (rango ventana, `finalDate = mañana`),
  AC2 (01:59 → no nocturna; 02:00 → nocturna; proceso caído a las 02:00 → primer tick del día; nocturna
  fallida → reintento en el siguiente slot, no al minuto), AC3 (semilla: arranque guardado › kv › 1 mes),
  AC4 (min con última buena; tope 90), AC8 (cambio de frecuencia en el siguiente tick), borde de día
  (`2026-10-17T04:30Z` = 23:30 del 16 en Bogotá → hoy 20261016, final 20261017).
- **Fechas:** `vi.useFakeTimers()` + `vi.setSystemTime(...)` y `process.env.TZ = 'UTC'` en el archivo; y un
  caso con `TZ='Asia/Tokyo'` para probar que no depende del huso del servidor (memoria «tests de hora verdes
  por el huso local»).
- **Candado:** mockear `candado-advisory.ts` (no `db.$client.reserve`) en los tests de la corrida; el test de
  `flit2-candado` existente cubre el mecanismo y debe pasar sin cambios.
- **Transacción:** `sincronizar` usa `db.transaction`; los tests nuevos deben dar un stub que **ejecute** el
  callback con un `tx` (memoria «stub pelado de `transaction`»). AC6 se prueba asertando que **no** hubo
  `tx.update(vehicles)` / `tx.update(flitoTramites)` / `delete` de compradores con fila idéntica, y que sí lo
  hubo cambiando un solo campo. Con el mock `chain` que devuelve la fila entera, asertar sobre la proyección
  pedida, no sobre lo devuelto (memoria «mock `chain` inventa columnas»). Caso #13585: anulado + VIN existente
  → cero `select` de columnas y cero UPDATE.
- **P1:** `npm test -w apps/api -- __tests__/services/flito-sync.flit1-planificacion.test.ts __tests__/services/flito-sync.flit1-lectura-automatica.test.ts __tests__/services/flito-sync.flit1-solo-si-cambia.test.ts __tests__/services/flito-sync-migracion-0242.test.ts __tests__/services/flito-sync.anulado-vehiculo-bug13585.test.ts __tests__/services/flito-sync.bitacora-flit1.test.ts __tests__/services/flito-sync.bitacora-fallos-flit1.test.ts __tests__/services/flito-sync.flit2-candado.test.ts __tests__/services/flito-sync.flit2-cron.test.ts __tests__/services/flito-sync.test.ts`
  (los existentes porque el diff toca `upsertVehiculo`/`escribirTramite`/candado/cron que ellos cubren; el
  `flito-sync.flit2-lectura.test.ts` también, porque FLIT 2 llama a las dos funciones con la opción por defecto).
  Más `NODE_OPTIONS=--max-old-space-size=8192 npm run build:api` y `npx eslint` de los archivos tocados.
- Migración: aplicar el archivo nuevo dos veces a la BD local (P6). Test de migración: «la anterior es 0241»,
  no «es la última».
- `security-agent` **aplica** (cambia el manejo de errores con cuerpo externo y logs; nueva superficie
  programada). `db-review-agent` **aplica** (0242 + schema).

**frontend-agent:** no aplica (la #13630/#13631 son las de pantalla).

## Pendiente humano (decisiones a confirmar)

- **P-1. Encendido en DEV/QA.** Con `SYNC_HABILITADO` por defecto encendida y `FLIT_BASE_URL` por defecto en
  PDN de FLIT 1, DEV y QA leerán PDN cada ~2 min y escribirán datos reales en sus bases. ¿Se acepta, o DevOps
  pone `SYNC_HABILITADO=false` (o apaga el interruptor `flit1`) en DEV/QA? Recomendación: encendida en PDN y
  QA; en DEV, decidirlo con quien consume DEV.
- **P-2. Ruta manual con el mismo candado (409 `LECTURA_EN_CURSO`).** Recomendado; cambia el contrato de una
  ruta que la #13631 retira.
- **P-3. Precedencia de la semilla:** arranque guardado › `system_kv` › hace 1 mes, y tope de 90 días también
  para la primera lectura (un arranque de hace 6 meses leería solo 90 días). Confirmar.
- **P-4. Corrida «buena» con trámites fallidos:** mueve `ultima_buena_en` y marca `ultimo_fallo_codigo =
  'tramites_con_fallo'` (D5). Confirmar que el estado puede mostrar a la vez «última buena» reciente y ese
  fallo; y que un cambio solo de vehículo cuenta como «sin cambios».
- **P-5.** Retirar `SYNC_CRON` / `intervalMsFromCron` (muertos): ¿CHORE/HU aparte o se deja?
