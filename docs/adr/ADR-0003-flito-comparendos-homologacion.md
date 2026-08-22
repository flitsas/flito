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

---

## Enmienda propuesta — tipo de registro y número de resolución (HU #11712)

**Estado de la enmienda: Propuesta.** Pendiente de aprobación del Líder Técnico. No modifica nada de
lo ya aceptado arriba: lo extiende. `Supersedes`: ninguno.

**Contexto.** Los dos endpoints devuelven comparendos Y multas en la misma lista. Un comparendo se
convierte en multa con el tiempo y lo que los distingue es el número de resolución: nulo → sigue
siendo comparendo; con valor → ya es multa. Decisión de negocio de David (2026-08-21): se PERSISTE
—columnas nuevas y migración—, no se deriva en vuelo. El motivo es el de RN-25: la poda recorta el
payload a la lista blanca, así que un dato que no sea columna no se puede ni filtrar ni indexar, y
el histórico ya podado no lo tiene.

### 7. Campos DERIVADOS: no son `target_field` y no se siembran en el mapa

`tipo_registro` NO entra en `CAMPOS_CANONICOS`. El mapa alimenta lo que el proveedor DICE; el tipo
no lo dice nadie, se deduce. Meterlo en el mapa permitiría que una fila de una tabla de texto
decidiera el valor de una columna `enum`: un `source_path` mal elegido —`comparendo`, que en SIMIT
es el booleano `true` (0158)— llegaría a `homologar` y el INSERT reventaría con `22P02` a mitad de
corrida, matando el NIT entero. Es la misma clase de fallo que la v2 evitó por sombreado, con
consecuencia peor. `tipo_registro` se calcula en código, como ya se calculan `origen_merge` y
`municipio_fuente`, que tampoco están en el mapa.

`numero_resolucion` **e** `id_resolucion` SÍ son `target_field`: eso sí lo dice el proveedor.

**`id_resolucion` es columna y canónico PROPIO, no una prioridad más de `numero_resolucion`.** El
valor real que manda SIMIT es `"idResolucion": "115697134"`: un identificador de SISTEMA, no un
número legible. Como candidato de `numeroResolucion` acabaría pintado en la columna «N.º resolución»
del visor las veces —hoy desconocidas— en que el número no viniera y el id sí, y nadie sabría
distinguir una cosa de la otra. Pero David confirma que **los dos vienen nulos mientras el registro
es un comparendo y con valor cuando ya es multa**, así que los dos son señal válida del TIPO. De ahí
la forma final: dos canónicos distintos, dos columnas, y el tipo derivado de **cualquiera de los
dos**. `id_resolucion` **no se publica en el API** ni sale al export: su único uso es esa deducción.

El invariante que esto obliga a escribir en la base es una disyunción, y por eso el CHECK de la 0160
no puede ser el `(a IS NULL) = (b IS NULL)` de la 0156:

```sql
CONSTRAINT flito_comparendos_tipo_resolucion_chk CHECK (
  (tipo_registro IS NULL AND numero_resolucion IS NULL AND id_resolucion IS NULL)
  OR (tipo_registro IS NOT NULL
      AND (tipo_registro = 'multa') = (numero_resolucion IS NOT NULL OR id_resolucion IS NOT NULL))
)
```

Ninguna de las dos piezas que parecen sobrar sobra, y **hacen cosas distintas** (verificado contra
PostgreSQL 16 en una base desechable, no deducido — el borrador de esta enmienda las confundía):

- **La primera rama está para ADMITIR el histórico**, no para cerrar un hueco. Sin ella,
  `tipo_registro IS NOT NULL` da `FALSE` y el CHECK rechaza toda fila sin tipo; como al aplicar la
  migración las tres columnas acaban de nacer y la tabla entera está en `(NULL, NULL, NULL)`, el
  propio `ADD CONSTRAINT` moriría al validar (`is violated by some row`).
- **La guarda `tipo_registro IS NOT NULL AND` de la segunda rama es la que cierra el hueco.** La
  comparación desnuda `(NULL = 'multa') = (…)` evalúa a `NULL` y un CHECK que evalúa a `NULL` PASA,
  así que sin esa guarda se colaría la fila peor: sin tipo y con resolución. Con ella,
  `FALSE AND NULL` es `FALSE`.

Juntas dicen lo que se quería decir: «sin tipo» solo es legal si tampoco hay resolución —que es
exactamente el histórico del punto 11— y, con tipo, `multa` equivale a tener alguna de las dos
resoluciones.

### 8. El tipo se deriva del valor YA RESUELTO, y una sola vez

`tipo_registro` se calcula en `resolverCampos`, DESPUÉS de `elegir('numeroResolucion')` y
`elegir('idResolucion')`, y nunca en `homologar`. Si el tipo se homologara por origen y luego se
resolviera como un campo más, las dos columnas podrían discrepar en la misma fila: SIMIT sin
resolución (tipo `comparendo`, gana por RN-13) y municipal con resolución (el número entra por el
segundo escalón) daría un comparendo CON número de resolución. Derivar del valor resuelto hace que
el invariante `tipo = 'multa' ⟺ (numero_resolucion IS NOT NULL OR id_resolucion IS NOT NULL)` se
cumpla por construcción y se pueda sostener con el `CHECK` de arriba.

### 9. La ausencia de resolución no es evidencia negativa (regla monótona)

Cuando las fuentes «discrepan» sobre el tipo, no discrepan: una afirma y la otra calla. Que SIMIT no
traiga `numeroResolucion` es indistinguible de que no publique el campo para ese ítem, así que no
significa «no hay resolución». Por eso la promoción a multa es **monótona**: cualquier fuente que
presente un número de resolución promueve la fila, y RN-13 lo consigue sin regla nueva
(`simit ?? municipal ?? previo`). El tercer escalón impide además la regresión por silencio: una
fila que ya fue multa no vuelve a comparendo porque el proveedor deje de mandar el campo.

No hay regreso automático multa → comparendo. Una resolución revocada existe, pero exigiría una
señal POSITIVA del proveedor, y hoy ninguna de las dos fuentes la tiene. `estado_fuente` no sirve
para eso: es texto crudo sin normalizar (ver abajo). Riesgo abierto, no deuda oculta.

Si las dos fuentes traen números de resolución DISTINTOS, manda SIMIT (RN-13, sin excepción): las
dos coinciden en que es multa, y la discrepancia es del número, no del tipo.

### 10. `estado_fuente` cambia de alcance, no de contrato

La cadena de candidatos suma `estadoPago`. Desde la v3, `estado_fuente` es «lo primero que dijo el
proveedor sobre el estado de esta deuda» tomado de una escalera que ya cruza tres vocabularios
—comparendo, cartera y pago—, y por tanto dos filas pueden llevar estados de vocabularios distintos.
Sigue siendo texto crudo, sin normalizar y sin enumerar: el contrato de `ComparendoRegistro` no
cambia. Lo que sí queda prohibido explícitamente es **inferir de `estado_fuente` si la fila es
comparendo o multa**; para eso está `tipo_registro`.

### 11. El histórico queda en `NULL`, y `NULL` se muestra como «sin dato»

Las tres columnas nacen NULLABLE y SIN default. El histórico no se puede reconstruir —los payloads ya
fueron podados y las rutas de la resolución no estaban en la lista blanca de las versiones
anteriores, que es el mismo drift v1→v2 documentado más arriba— y un default `comparendo` sería una
afirmación que nadie ha comprobado. Ausencia en el JSONB significa «podado», no «el proveedor dijo
que no hay».

El coste de mentir no es transitorio: las filas `inactivo` ya no las visita ningún sync (CF-10), así
que un default optimista se quedaría en pantalla para siempre. `NULL` = «no se sabe» es además el
vocabulario que esta tabla ya usa para el histórico (`gestion_actualizada_en/por`, HU #11556) y el
que usan todas las columnas de fuente. Consecuencia vinculante para el visor (HU #11713): `NULL` se
pinta como «sin dato», nunca como «Comparendo», no se suma a ningún contador de comparendos y un
filtro por tipo no lo incluye en ninguno de los dos valores.

### Consecuencia sobre RN-25 y la Ley 1581

El número de resolución **no** «identifica un acto administrativo y no a una persona» —eso, dicho en
abstracto, no se sostiene: es una llave de consulta hacia el registro que el organismo tiene del
caso, igual que la placa, que este módulo sí declara PII indirecta—. Lo que decide es otra cosa: **no
añade vinculabilidad sobre lo que la fila ya publica**, porque `numero_comparendo` es la misma clase
de llave hacia el mismo registro y ya viaja en el listado y en el Excel. La resolución no abre una
puerta nueva: abre la misma. Entra a la lista blanca con finalidad declarada (distinguir comparendo
de multa), que es lo que exige el principio de minimización.

Las cuatro rutas nuevas son además **escalares de primer nivel**: no abren ningún contenedor, así
que `injertarHoja` no gana superficie. Y si algún municipio emitiera la resolución como OBJETO, la
protegen **dos mecanismos distintos, en dos puntos distintos del flujo**, que es importante no
confundir (el borrador de esta enmienda los confundía y eso ocultó el fallo de AC6):

- **No se persiste:** `esEscalarPersistible`, dentro de `injertarHoja` — la poda del payload (RN-25).
- **No se homologa:** `primerValor` lo salta (`esValorHomologable`) y **sigue al candidato
  siguiente**; solo si no hay ninguno el campo queda `null` y la fila se queda en comparendo. Con un
  respaldo de prioridad 2 bueno, la fila sí se promueve, que es lo correcto.

Las dos funciones se parecen y no son la misma: la de la poda admite `boolean` y `null` (son valores
legítimos que guardar), la de la homologación no (de un `true` no sale un canónico).

Siguen FUERA del mapa, y por tanto de la lista blanca: `infractor.*` (SIMIT), `nombres`,
`apellidos`, `contraventores`, `estadoCuenta.direccion` e `identificador` (municipal), y los bloques
`informacionMoroso` / `informacionMorosoCobro` del envelope UTS, hoy no ingeridos y que nombran a
una persona natural desde el propio nombre de la clave.

### Lo implementado (HU #11712)

- **Migración** `0160_flito_comparendos_tipo_registro.sql`: `CREATE TYPE` con guarda, tres
  `ADD COLUMN IF NOT EXISTS` sin default, el CHECK, tres `COMMENT ON COLUMN` y la **v3 completa** del
  `field_map` (41 filas: las 35 de la v2 re-sembradas + 6). Ni un `UPDATE`.
- **Mapa v3.** SIMIT: `numeroResolucion` → `numeroResolucion` (p1), `idResolucion` → `idResolucion`
  (p1), `estadoPago` → `estadoFuente` (p3, delante de `estado`, que baja a p4). Municipal:
  `nroResolucion` → `numeroResolucion` (p1, nombre verificado), `numeroResolucion` (p2, respaldo),
  `estadoPago` → `estadoFuente` (p3, **detrás** de `estado`, que allí no es un alias inerte sino lo
  que emite el mock del UTS, el modo por defecto). **`fechaResolucion` y `idEstadoComparendo` no se
  mapean**, y el porqué está en la cabecera de la migración y en un test.
- **Contrato.** `ComparendoRegistro` publica `tipoRegistro: 'comparendo' | 'multa' | null` y
  `numeroResolucion: string | null`; `id_resolucion` no se publica. El export a Excel gana «Tipo» y
  «N.º resolución», y un tipo nulo deja la celda **vacía**, nunca «Comparendo».
- **Vigilancia.** `flito-comparendos-migracion-0160-paridad.test.ts` (enum, columnas sin default,
  CHECK contra `schema.ts`, v3 ⊇ v2 leída del `.sql` de la 0158, PII), más los casos de la regla
  monótona en `flito-comparendos-merge.test.ts` y los de superficie de poda en
  `flito-comparendos-poda.test.ts`.
- **Deuda de la paridad 0151.** Añadir canónicos rompía la comparación «listas idénticas» contra la
  migración ya aplicada. Se convirtió en **direccional**: `sqlCampos ⊆ CAMPOS_CANONICOS` sigue siendo
  fallo duro (es la dirección con riesgo de PII) y el excedente del runtime se declara en
  `CANONICOS_POSTERIORES_A_0151`. **No** se re-podó: la 0151 agrega por claves de primer nivel y
  repetirla hoy borraría `estadoCuenta.secretaria.*` e `infracciones.0.*`, que la v2 persiste
  legítimamente.

### Fuera de alcance y desviaciones declaradas (HU #11712)

- **El CHECK no se prueba contra una base real en la suite automática.** El AC2 pide un test que
  intente insertar `tipo = 'comparendo'` con resolución y que **la base** lo rechace, y eso no
  existe: los tests del API no tienen infraestructura de base de datos (`setup.ts` usa un
  `DATABASE_URL` falso y todo va contra un mock de drizzle), y montarla para una aserción no es una
  decisión que quepa en esta HU.
  Lo que sí hay, y lo que cada cosa cubre:
  - `flito-comparendos-migracion-0160-paridad.test.ts`: análisis **estático** — que la expresión del
    `.sql` y la de `schema.ts` son la misma y son la esperada, con sus dos piezas.
  - `mienteLaFila`, en `flito-comparendos-merge.test.ts`: el CHECK **replicado en TypeScript**, que
    demuestra que ninguna combinación de fuentes e histórico produce una fila que lo viole.
  - **Verificación manual contra PostgreSQL 16.14** (base desechable, durante la HU y repetida por el
    gate de db-review): la fila mentirosa muere con `23514` y el histórico entra.
  Lo que NO queda cubierto por un test que corra solo: que el CHECK esté **realmente aplicado** en un
  ambiente. Lo detecta el `db:apply` y, si faltara, la primera escritura mentirosa pasaría sin ruido.
- **`id_resolucion` se normaliza a mayúsculas** igual que el número. Sobre el valor observado
  (`115697134`, todo dígitos) es un no-op, y su único uso es la presencia —de ahí sale el tipo—, así
  que ni siquiera un identificador sensible a mayúsculas se rompería *para lo que se usa*. Queda
  anotado porque es un identificador opaco del proveedor y esa normalización no le aporta nada; si
  algún día se publica o se usa para volver a consultar, hay que quitarla.
