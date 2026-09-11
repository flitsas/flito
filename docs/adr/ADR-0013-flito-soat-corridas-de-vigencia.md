# ADR-0013 — La vigencia del SOAT es un hecho del VEHÍCULO, con una fila por corrida y sin PII

## Estado

**Propuesto** — HU [#12096](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12096) (Feature [#12075](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12075)). **Pendiente de aprobación del Líder Técnico**: no lo aprueba ningún agente.

Redactado **antes** de implementar, sobre el punto de extensión que dejó la HU #12095. Recoge las
cuatro decisiones que David resolvió el 2026-09-07 (§1, §4.2, §4.3, §6) y el delta de API que entró al
alcance después (§7). El `security-agent` revisa §6 antes del PR.

**No supersede a nadie.** Es ortogonal a [ADR-0010](./ADR-0010-flito-soat-runt-compuerta-alta.md) y a
[ADR-0012](./ADR-0012-flito-soat-hmac-vin-en-pii-access-log.md): aquellos deciden qué pasa cuando una
PERSONA radica una solicitud; este decide qué pasa cuando un PROCESO, sin persona detrás, mide un
vehículo que FLITO ya compró. Reutiliza sus primitivas (`soatVigenteSegunRunt`,
`fechaVencimientoSoatRunt`, `causaDeCaida`) sin cambiarlas.

**Alcance.** Decide el modelo de datos de la vigencia, la llave de la tabla de corridas y la retirada
del KV, el criterio del censo, qué escribe el silencio del RUNT, el ritmo y el rastro. **No decide**
la política de alertas sobre `sin_registro` (§«Lo que no compra» #3) ni la pantalla, que es la HU
#12097 y tiene su propio documento de UX.

---

## Contexto

La HU #12095 entregó **solo el andamiaje**: cuándo arranca la corrida (00:10 de Colombia), quién la
ejecuta cuando hay varias instancias (`withLock`), cómo se apaga (`SOAT_VIGENCIA_CRON_ENABLED`), por
qué no se repite el mismo día y cuándo se reintenta (cada hora, hasta tres veces). El **qué hace**
—elegir vehículos, consultar, escribir— quedó aislado en `recorrerVigenciaSoat`, que hoy devuelve
ceros y lo dice en su docstring.

Esa separación dejó tres ataduras que este ADR no puede romper:

1. **`pendientes > 0` es lo ÚNICO que dispara el reintento horario.** Un recorrido que devolviera
   cero pendientes ante un RUNT caído cerraría el día como completo.
2. **`dia` e `intento` entran en la firma** para que el recorrido excluya lo que ya verificó **con
   éxito** ese día. La palabra «con éxito» está en la cabecera del service y es la que decide el
   predicado de §4.
3. **El estado del día vive hoy en UNA clave de `system_kv`** (`flito-soat.vigencia.corrida-dia`)
   que el día siguiente sobrescribe. La cabecera del service declara esa deuda y fija su forma: una
   fila **por corrida**, no por día vivo, y la lectura del cron pasa a «último estado del día de hoy».

Y una regla del negocio que atraviesa todo: **RN-D7 — la corrida no mueve el estado de ninguna
solicitud.** Lo que esta HU escribe es el estado de vigencia de un VEHÍCULO frente al registro
nacional. Son dos cosas distintas que van a compartir tabla, y la mitad de las decisiones de abajo
existen para que nadie las confunda.

---

## 1 · Los nombres de columna se desvían del AC1, y es deliberado

> **Decisión de David, 2026-09-07.** Se adoptan los nombres propuestos aquí. **El AC de ADO NO se
> reescribe**: la desviación se declara en el PR y en la Discussion del work item con el argumento de
> esta sección. Este ADR es el sitio donde queda escrita.

El AC1 nombra cuatro columnas: `estado`, `verificada_en`, `vence_el` y `poliza`. **Dos de las cuatro
no se pueden usar tal cual sobre `flito_soat`**, y no es una preferencia de estilo:

| AC1 dice | Hecho medido en el repo | Se implementa como |
|---|---|---|
| `estado` | **Ya existe.** `flito_soat.estado` es el enum `flito_soat_estado` (`schema.ts:2681`), con los cuatro estados de la solicitud (`pendiente`, `solicitado`, `con_novedad`, `pagado`). `ADD COLUMN estado` es un 42701. | **`estado_vigencia`** |
| `verificada_en` | Sin choque. | `verificada_en` |
| `vence_el` | Sin choque. Cerca de `flito_soat_solicitud.soat_vigente_hasta`, pero es otra tabla y otro momento (la compuerta del alta, migración 0171). Lo separa el `COMMENT`. | `vence_el` |
| `poliza` | No choca literalmente, pero `flito_soat.numero_poliza` ya existe y es **la llave operativa de la conciliación** (Feature #11623, `idx_flito_soat_numero_poliza`). | **`poliza_runt`** |

**Por qué `estado_vigencia` y no `estado` con otro prefijo o en otra tabla.** El choque de nombre es
el síntoma; la enfermedad es que **confundir las dos columnas es exactamente lo que RN-D7 prohíbe**.
Una columna llamada `estado` sobre `flito_soat` ya significa algo en este repo desde la migración
0101, y significa *«en qué punto del flujo de adquisición está esta solicitud»*. Un segundo `estado`
sobre la misma fila haría que cualquier `WHERE estado = …` escrito de memoria —en una consulta de
soporte, en un export futuro, en un `psql`— apuntara a la columna equivocada la mitad de las veces, y
las dos devuelven filas. El sufijo no es decoración: es lo que hace que las dos preguntas sigan siendo
distinguibles a las 7 a.m.

**Por qué `poliza_runt` y no `poliza`.** Dos columnas de número de póliza sobre una fila es una trampa
de calidad de dato: nadie sabría por cuál cruza la boleta de conciliación. Y el sufijo **gana una
señal que con `poliza` se perdería**: `numero_poliza` es lo que el OCR leyó de la factura que subió el
gestor, y `poliza_runt` es lo que dice el registro nacional. **Que diverjan es información** —una
póliza reexpedida, un dígito mal leído—, no ruido. Con un solo nombre esa comparación no se puede ni
plantear.

**Lo que esta desviación cuesta, escrito:** el AC1 y el código dirán cosas distintas, y quien haga QA
formal comparando literales encontrará una diferencia. Por eso va en el PR y en la Discussion, no solo
aquí.

---

## 2 · Una fila por corrida: llave, lectura y quién la escribe

### 2.1 El descubrimiento que hace suficiente la lista de columnas del AC1

`decidirCorrida()` —la función pura donde vive todo el comportamiento temporal del cron— necesita
`proximoIntentoEn`, y **esa columna no está en el AC1**. No hace falta añadirla: CF-06 fija que la
cadencia se mide desde el **arranque** del intento (`siguiente = reloj.ms + REINTENTO_MS`; 00:10,
01:10, 02:10, 03:10, «pase lo que pase con la duración de cada pasada»). Es decir:

```
proximoIntentoEn = (estado === 'en_curso' && intento <= MAX_REINTENTOS)
                     ? iniciada_en + REINTENTO_MS
                     : null
```

`iniciada_en` **sí** está en el AC1, y resulta ser exactamente el ancla que la cadencia ya usaba. Con
esa derivación, el mapeo de la fila de corrida a `EstadoDelDia` es **total, sin una columna de más**:

| Campo de `EstadoDelDia` | De dónde sale |
|---|---|
| `dia` | `dia` |
| `estado` | `estado` de la corrida con `intento` máximo del día |
| `intentos` | `max(intento)` del día |
| `verificados` | `sum(verificados)` del día — acumulado; la FILA guarda por corrida, que es lo que el AC7 pide |
| `pendientes` | `fallidos` de la última corrida |
| `proximoIntentoEn` | **derivado** de `iniciada_en` + `intento` + `estado` |
| `actualizadoEn` | `cerrada_en ?? iniciada_en` |

Persistir `proximo_intento_en` además de `iniciada_en` habría creado dos fuentes del mismo hecho, con
la posibilidad de que divergieran (un `UPDATE` a mano sobre una y no la otra) y sin que nada lo
detectara. Derivarlo lo hace imposible por construcción.

### 2.2 La llave

**Elegida: `id uuid PRIMARY KEY` + `UNIQUE (dia, intento)`.**

- El AC1 nombra `id` explícitamente, y un identificador propio es lo que permitirá que una pantalla
  de corridas —si algún día existe— referencie una fila por un solo valor.
- El **único sobre `(dia, intento)`** es lo que hace que la escritura de ENTRADA de `ejecutarIntento`
  siga siendo un upsert idempotente (`ON CONFLICT (dia, intento) DO UPDATE`), calcado del upsert que
  hoy hace `guardarEstadoDelDia` sobre `systemKv.k`. Sin él, un proceso que muriera entre la
  escritura de entrada y la de cierre dejaría **dos filas del mismo intento** y «el último estado del
  día» pasaría a ser ambiguo.
- Sirve además como índice de `WHERE dia = $1` por prefijo izquierdo: **no se crea un segundo índice
  sobre `dia`**.

**Alternativa 2 — PK compuesta `(dia, intento)` sin `id`.** Un objeto menos, y el precedente existe
(`flito_gestor_organismos`: «la fila ES el par»). Descartada porque el AC1 nombra `id` y porque
cualquier lector futuro quedaría obligado a referenciar por par.

**Alternativa 3 — solo `id`, sin único.** Descartada: admite duplicados de `(dia, intento)` y rompe
la idempotencia de la escritura de entrada, que es la protección de CF-08.

### 2.3 Cómo se LEE, con el mock en contra

`ORDER BY intento DESC LIMIT 1` es lo natural **y es exactamente lo que la suite no puede comprobar**:
el mock de drizzle trata `orderBy` como passthrough (`__tests__/helpers/orden-sql.ts` lo deja escrito:
«un test que afirme "la primera fila es la más reciente" mirando la respuesta del mock pasa igual con
`asc`, con `desc` y sin `ORDER BY`»). Un `leerEstadoDelDia` cuya corrección dependa del orden sería
verde para siempre, incluso invertido.

Por eso la lectura se parte en **dos consultas que no dependen del orden**:

```
A)  SELECT max(intento), sum(verificados), count(*)
      FROM flito_soat_verificacion_corridas WHERE dia = $1
B)  SELECT estado, fallidos, iniciada_en, cerrada_en
      FROM flito_soat_verificacion_corridas WHERE dia = $1 AND intento = $2
```

- **(A) es un agregado sobre un conjunto filtrado, sin `GROUP BY`.** Importa que no lo haya: en un
  `GROUP BY`, un literal repetido produce DOS parámetros y PostgreSQL responde `42803` —«column must
  appear in the GROUP BY clause»— en cada llamada. Aquí no hay agrupación y `dia` va una sola vez.
- **(B) es por llave exacta.** El aserto se escribe con `__tests__/helpers/sql-ligado.ts`, que lee
  QUÉ valor quedó ligado a QUÉ comparación por posición: `expect(sql).toContain(…)` +
  `expect(params).toContain(…)` es la clase de verde vacío que ese helper existe para cerrar.
- **Coste:** dos lecturas indexadas cada cinco minutos. La cabecera del cron promete un latido
  despreciable («una lectura por clave primaria»); esto lo sigue siendo.

### 2.4 Quién escribe la fila — el cron gana un parámetro

El cron conoce `dia`, `intento`, `iniciada_en`, `cerrada_en` y `estado`; el recorrido conoce `total`,
`cambiaron` y `motivos`. Tres repartos posibles:

**A — Dos escritores, columnas disjuntas.** `ejecutarIntento` queda intacto y se cumple al pie de la
letra la promesa de la cabecera («la #12096 reemplaza el cuerpo de esas dos funciones y NADA más de
este archivo cambia»). **Contra:** una fila con dos dueños y una regla de no-solapamiento que solo
vive en un comentario. Es lo que se pudre.

**B — Un solo escritor · ELEGIDA.** `ResultadoRecorridoVigencia` crece a
`{ considerados, verificados, pendientes, cambiaron, motivos }` y `guardarEstadoDelDia` gana un
segundo parámetro opcional: la escritura de ENTRADA no lo pasa, la de CIERRE sí. Cuesta unas seis
líneas del cron.

**C — El recorrido escribe la fila entera y el cron solo lee.** Descartada: elimina la escritura de
entrada, que es la protección de CF-08 contra el proceso que muere a mitad de la corrida.

**Por qué B y no A.** La promesa de la cabecera era sobre **dónde vive el estado**, no sobre el número
de líneas del diff, y su espíritu se cumple entero: `EstadoDelDia`, `decidirCorrida`, `ahoraEnBogota`,
el candado, la puerta por env y la cadencia **no se tocan**. Eso es lo que tiene 29 tests detrás.

**No hay ninguna resta de contadores, y conviene decirlo porque es donde se metería el error:**
`ResultadoRecorridoVigencia.verificados` ya significa por contrato «verificados con éxito **en este
intento**», que es exactamente lo que la fila guarda; el acumulado del día lo reconstruye el `sum()`
de (A). `EstadoDelDia.verificados` (acumulado) se usa solo para el log y no se persiste.

### 2.5 El KV se RETIRA, sin backfill

**Alternativa 1 — espejo** (el KV sigue siendo la verdad del cron y la tabla es constancia). Cero
riesgo para la suite de la #12095. Descartada: dos fuentes de verdad del mismo hecho, y la cabecera
del service pide explícitamente mover la lectura.

**Alternativa 2 — migrar con datos** (sembrar la corrida de hoy desde el KV). Descartada, y la razón
es la misma que la migración 0174 dejó escrita para `runt_consultado_en`: el KV solo guarda
acumulados del día, así que `iniciada_en` habría que **fabricarlo** desde `system_kv.updated_at`, que
es el instante del CIERRE y no el del arranque. Con `proximoIntentoEn` derivado de `iniciada_en`
(§2.1), un `iniciada_en` falso desplaza el reintento. Rellenar con una suposición es escribir como
hecho lo que nadie observó.

**Alternativa 3 — retirar · ELEGIDA.** `DELETE FROM system_kv WHERE k = 'flito-soat.vigencia.corrida-dia'`,
precedido de un `RAISE NOTICE` con lo que la clave contenía (día, estado, intentos — ningún dato
personal), calcado del NOTICE-antes-del-DROP de la migración 0176. El CD aplica las migraciones y
loguea su salida, así que la constancia de lo que se borró queda en el log del despliegue.

> **Riesgo asumido y acotado.** Si el CD aterriza **entre las 00:10 y las 01:10 de Colombia** un día
> en que la corrida ya pasó, el API nuevo no encuentra fila (el viejo escribió en el KV) y **puede
> repetir la corrida**. Impacto real: se reconsulta el RUNT y se reescriben las mismas columnas —RN-D7
> garantiza que nada más se mueve—. Mitigación **operativa, no de código**: no desplegar la 0177 en
> esa ventana. Es la única ventana en toda la vida del sistema en que esto puede ocurrir.

---

## 3 · El censo: qué significa «el comprobante ya lo cargó el gestor»

El AC2 pide las filas «cuyo comprobante de SOAT ya cargó el gestor, **y solo esas**», con el criterio
escrito en el docblock. Candidatos que existen de verdad en el esquema:

| # | Predicado | Qué lo sostiene en el repo |
|---|---|---|
| **1** | `EXISTS (flito_soportes WHERE soat_id = … AND tipo = 'factura_soat' AND descartado = false)` | `TIPO_FACTURA_SOAT = 'factura_soat'` (`flito-soat.service.ts:1624`), el mismo literal que `TipoSoporte.FACTURA_SOAT`. Es **el** comprobante que sube el gestor: la superficie del ZIP «tiene UN solo tipo» (`flito-soat.routes.ts:300`). |
| 2 | `flito_soat.estado = 'pagado'` | RN-03: `pagarEnTx` es el único escritor de `pagado` y **revalida** que exista el soporte (`'No se puede marcar pagado un SOAT sin factura cargada'`). Luego `pagado ⇒ comprobante`, pero no al revés. |
| 3 | `pagado_en IS NOT NULL` | Mismo conjunto que 2: se escriben en el mismo `set()`. |
| 4 | `numero_poliza IS NOT NULL` | Subconjunto estricto: «cuando no hay póliza legible NO se escribe nada». Descartado. |

**La diferencia entre 1 y 2 son los SOAT en `solicitado` cuyo comprobante entró y cayó en la cola de
revisión OCR** (`persistirCarga` → `flito_revisiones`): el gestor ya lo cargó y el SOAT no está pagado.

**Elegido: el 1.** Dos razones, y ninguna es la literalidad del AC:

1. El criterio 2 es una afirmación sobre el **flujo interno de FLITO**, no sobre el comprobante. El
   AC2 pregunta por el documento.
2. **El vehículo en revisión OCR es donde más vale preguntar**: es precisamente el caso en que FLITO
   no sabe si la póliza existe. Y no cuesta nada, porque RN-D7 impide que la corrida resuelva la
   revisión por accidente — solo escribe columnas de vigencia.

> **Consecuencia que hay que escribir junto a la decisión, o se lee mal:** con este criterio el censo
> es mayor y `estado_vigencia = 'sin_registro'` aparecerá también en vehículos cuyo comprobante sigue
> en revisión. **`sin_registro` no es una alerta contra la aseguradora ni contra el gestor**: es un
> hecho sobre lo que el RUNT reporta hoy. Va en el `COMMENT ON COLUMN`, que es donde lo lee quien
> consulta la base sin leer este ADR.

**Dos trampas de implementación, las dos medidas:**

- **`exists()`, nunca un `JOIN`.** El índice único parcial `idx_flito_soportes_soat_factura_venta` es
  de `factura_venta`; para `factura_soat` **puede haber varias filas vivas por SOAT** («los demás
  tipos de soporte de un SOAT sí pueden repetirse», `schema.ts`). Un join duplicaría filas e inflaría
  `total`, y un total inflado no se ve como un error: se ve como más trabajo.
- **`flito_soportes` no tiene índice por `soat_id` solo.** Tiene `hashIdx` y tres únicos parciales,
  ninguno utilizable aquí. El `EXISTS` es el único predicado selectivo del censo, así que la
  migración crea `idx_flito_soportes_soat_tipo (soat_id, tipo) WHERE soat_id IS NOT NULL AND descartado = false`.

**Lo que NO se filtra, y es una decisión.** No se añade `FRONTERA_AUTOGESTION_SOAT` ni se excluye
`gestion_operaciones`. El AC2 dice «y solo esas»: la existencia del comprobante es condición
**necesaria y suficiente**. Añadir la frontera de autogestión sería inventar alcance, y además sería
falso: un SOAT con `excepcion_autogestion` lo compró FLITO igual.

---

## 4 · Qué escribe el silencio del RUNT

### 4.1 El hallazgo: `soatVigenteSegunRunt` devuelve `false` por silencio

Medido en `tramites/preflight.ts:113-118`: cuando `vehiculoResp.ok` es falso, el check `soat` sale
`unknown`, y `soatVigenteSegunRunt` solo cuenta `status === 'ok'`. Por tanto:

```ts
soatVigenteSegunRunt(respuesta) ? 'vigente' : 'sin_registro'   // ← rompe el AC5 en la primera caída
```

Con el RUNT caído eso escribe `sin_registro`: **dar por vencido por silencio**, que es literalmente lo
que el AC5 prohíbe. Y no se ve: la función devuelve un booleano perfectamente sano.

**El orden del clasificador es, por tanto, transporte PRIMERO** —la misma forma que ADR-0010 ya fijó
para la compuerta del alta, por la misma razón:

1. `circuitoAbierto('runt-vehicle')` → `no_verificado`, motivo `circuito`. **No se llama al RUNT.**
2. `respuesta.ok === false` → `no_verificado`, motivo `causaDeCaida(respuesta.message)`.
3. `runtSinRegistro(respuesta.data)` → `sin_registro` (el vehículo no está en el registro nacional).
4. Solo aquí: `soatVigenteSegunRunt(respuesta)` → `vigente` | `sin_registro`, y
   `fechaVencimientoSoatRunt(respuesta.data)`.

> **Asimetría de firmas, que es una fuente de bug silencioso:** `soatVigenteSegunRunt` recibe **la
> respuesta entera** (`{ok, data}`) y `fechaVencimientoSoatRunt` recibe **`data`**. Pasarle la
> respuesta entera a la segunda devuelve `null` siempre, sin error y sin tipo que lo impida.

> **`consultarVehiculoRunt` casi nunca lanza.** Atrapa todo y devuelve `{ok:false, message}`, incluido
> el `CircuitoAbiertoError`. Por eso `causaDeCaida` se aplica **al mensaje de la respuesta** y no
> dentro de un `catch`: funciona directamente porque acepta `unknown` y hace `String(err ?? '')`.
> Vocabulario cerrado de cuatro valores (`timeout | red | circuito | otro`): por construcción no puede
> publicar una placa. **Cero vocabulario nuevo en este ADR.**

### 4.2 La tabla de escritura, y qué instante registra `verificada_en`

| Desenlace | `estado_vigencia` | `verificada_en` | `vence_el` | `poliza_runt` |
|---|---|---|---|---|
| RUNT responde, hay SOAT vigente | `vigente` | **ahora** | si vino | si vino |
| RUNT responde, no hay (vencido / sin póliza / sin registro) | `sin_registro` | **ahora** | intacto | intacto |
| RUNT no responde (o circuito abierto) | `no_verificado` | **intacto** | **intacto** | **intacto** |

> ### El silencio no toca `verificada_en` — decisión de David, 2026-09-07
>
> `verificada_en` registra **la última vez que el RUNT RESPONDIÓ**, y en la rama `no_verificado` **no se
> toca**. Puede ser `NULL`: significa «de este vehículo no consta ninguna respuesta del registro».
>
> El borrador de este ADR proponía lo contrario —registrar el último INTENTO, con respuesta o sin
> ella— para que la pantalla de la #12097 pudiera pintar «Último intento hoy». **Se descartó, y las dos
> razones pesan más que esa línea de chip.**
>
> **1 · La variante del intento rompe la métrica que justifica el Feature.** La descripción del #12075
> mide *«cuánto tiempo lleva sin actualizarse el dato más viejo de la cola»*. Si la columna se moviera
> con cada intento fallido, **la cola se vería fresca aunque el RUNT llevara una semana caído**: cada
> madrugada, sus cuatro intentos rejuvenecerían todas las filas sin haber medido ni un vehículo. Es un
> indicador que miente por construcción, y miente **exactamente en el escenario que existe para
> detectar**. Ese coste no estaba en el borrador y es mayor que el de la segunda línea del chip.
>
> **2 · Es la única variante en la que el predicado del AC6 es una sola condición y es correcta.** Con
> `verificada_en` = «última respuesta»:
>
> | Situación | `verificada_en` | ¿vuelve a entrar en el reintento horario? |
> |---|---|---|
> | Verificado con respuesta hoy | hoy | **no** — correcto |
> | Falló hoy, hubo respuesta antes | fecha vieja | **sí** — correcto |
> | Falló hoy, nunca hubo respuesta | `NULL` | **sí** — correcto |
>
> Las tres salen bien de `verificada_en IS NULL OR verificada_en < corte`, sin una cláusula más. Con la
> variante del intento pasa lo contrario: el vehículo que **falló** queda marcado como reciente, el
> reintento horario **lo salta** —justo al que había que reintentar— y hace falta añadir
> `OR estado_vigencia = 'no_verificado'` solo para deshacer ese daño. Es decir: **la cláusula extra la
> necesitaba la variante descartada, no esta.** El borrador de este ADR lo atribuía al revés.
>
> **Lo que esta decisión cuesta, sin disimulo.** Cuando nunca ha habido respuesta, `estado_vigencia`
> vale `'no_verificado'` y `verificada_en` es `NULL` **tanto si se intentó y falló como si la corrida
> todavía no ha llegado a esa fila**: el valor que escribe un fallo es idéntico al `DEFAULT` de la
> columna. Ninguna columna del AC1 distingue «no lo intentamos aún» de «lo intentamos y no hubo
> respuesta». Eso tiene una consecuencia sobre el filtro de la cola, y está en §7.2.
>
> **Alternativa también descartada:** dos columnas (`verificada_en` + `intentada_en`), que diría la
> verdad sobre las dos preguntas. Cae por la misma regla que `estado_vigencia_previo` (§4.3): no se
> inventan columnas fuera del AC1.

### 4.3 El AC5 admitía otra lectura, y aquí queda por qué se descartó

> **Decisión de David, 2026-09-07.** Se acepta que en `no_verificado` **la etiqueta `vigente` anterior
> se pierde**. **No** se añade `estado_vigencia_previo` ni ninguna columna de más.

El AC5 dice: *«sin respuesta del RUNT ⇒ `no_verificado`, conserva el último dato conocido, nunca
vencido por silencio»*. Las dos mitades tiran en direcciones distintas y admiten dos lecturas:

- **Lectura estrecha (elegida):** «el último dato conocido» son `vence_el` y `poliza_runt` —los datos
  que el RUNT entregó—, y `estado_vigencia` **sí** se sobreescribe a `no_verificado`, porque el AC lo
  dice con esas palabras («⇒ `no_verificado`»). Lo que se conserva es el DATO; lo que se pierde es la
  ETIQUETA.
- **Lectura amplia (descartada):** «el último dato conocido» incluye el propio estado, así que un
  `vigente` de ayer debería sobrevivir al silencio de hoy. Implementarla exige o un cuarto valor del
  vocabulario (algo como `vigente_no_confirmado`) o una columna `estado_vigencia_previo` — **y ni el
  cuarto valor ni la columna están en el AC1**.

**Se descarta la amplia por no inventar columnas fuera del AC1.** Queda escrito aquí para que en QA
formal nadie lo lea como defecto: que un SOAT que ayer estaba `vigente` aparezca hoy como
`no_verificado` tras una caída del RUNT **es el comportamiento decidido**, no una regresión. El dato
que importa —hasta cuándo vence la póliza— sigue en `vence_el`, intacto.

### 4.4 El predicado del AC6: se excluye lo verificado **con éxito** hoy

La cabecera del service de la #12095 lo dice con esas palabras: `dia` e `intento` viajan hacia dentro
«para que el recorrido pueda excluir lo que ya verificó **con éxito** ese día». Con la decisión de
§4.2, «con éxito» **es exactamente lo que `verificada_en` registra**, así que el predicado es uno solo:

```
verificada_en IS NULL OR verificada_en < <inicio del día en Bogotá>
```

Nada más. La segunda condición excluye lo verificado hoy; la primera deja entrar lo que nunca obtuvo
respuesta. Un vehículo que falló esta madrugada conserva su fecha vieja —o su `NULL`— y **vuelve a
entrar en el reintento horario**, que es lo que el AC6 pide y lo que hace que `pendientes > 0` sirva
de algo.

El corte se calcula **en JavaScript** como `${dia}T00:00:00-05:00` —Colombia no tiene horario de
verano, así que el desplazamiento es constante— y viaja como parámetro ligado. No se usa
`AT TIME ZONE` en SQL: el valor entra una sola vez, el predicado es determinista y el aserto se puede
escribir con `sql-ligado`.

**`updated_at` de `flito_soat` NO se toca.** Hoy ningún lector ordena por ella (la cola ordena por
`created_at`), pero **todos** sus escritores actuales son acciones humanas del módulo. Que la corrida
la moviera cada madrugada la vaciaría de significado sin que nada se pusiera rojo.

**La corrida no llama a `registrarCambio` ni escribe en `flito_estado_historial`.** Ese historial es
de transiciones de estado de la SOLICITUD (`ConceptoHistorial.SOAT`), y aquí no hay ninguna. Es la
mitad ejecutable de RN-D7.

---

## 5 · Ritmo, tope y el hallazgo del circuit breaker

### 5.1 El breaker del RUNT es compartido con el camino de usuario

`consultarVehiculoRunt` sale por `withCircuitBreaker('runt-vehicle', …)` (`runt.service.ts:109`), y ese
breaker es **de proceso y global** (`services/circuitBreaker.ts`): `THRESHOLD = 5` fallos consecutivos,
`RESET_MS = 60 s`. Lo comparten **todo** lo que consulta el RUNT: la preconsulta del canal Cliente, el
alta, la certificación de impuestos y el pre-vuelo de trámites.

Dos consecuencias que el AC6 («no degradar las consultas de usuarios») obliga a atajar:

1. **Con el circuito abierto, `fn()` no se ejecuta**: la llamada rebota al instante. Un censo de N
   vehículos contra un RUNT caído se quema en milisegundos y marca todo `no_verificado` en un solo
   intento. Eso no es un intento de verificación: es un no-op rápido que además consume uno de los
   tres reintentos horarios.
2. **Mientras la corrida lo mantiene abierto, cualquier persona que consulte recibe 503.** Eso es,
   literalmente, degradar las consultas de usuarios.

**Solución, con la herramienta que ya existe exactamente para esto:** `circuitoAbierto('runt-vehicle')`
—consulta pura, no muta, respeta el medio-abierto— cuyo docblock dice que existe «para poder decidir
ANTES de empezar un trabajo que se sabe que va a rebotar». Se consulta antes de cada tanda; si está
abierto, la corrida **para** y devuelve el resto como `pendientes`, que es justo la señal que
reprograma a la hora siguiente.

### 5.2 Dónde vive cada perilla, y por qué ahí

El AC6 pide dos cosas distintas y conviene no confundirlas: un **tope declarado** para el reintento
por vehículo, y un **ritmo limitado por constante configurable**.

| Qué | Dónde | Valor | Razón |
|---|---|---|---|
| **Ritmo** — `SOAT_VIGENCIA_CONCURRENCIA` | `config/env.ts`, junto a `SOAT_VIGENCIA_CRON_ENABLED` | `z.coerce.number().int().min(1).max(8).default(2)` | Calcado de `COMPARENDOS_SYNC_CONCURRENCIA` (`.min(1).max(12).default(5)`). **Default 2 y no 5**: aquel sync va contra otra fuente, a demanda, y no comparte breaker con el camino de usuario. Aquí sí, y el umbral del breaker es 5. |
| **Tope de reintento por vehículo** — `MAX_REINTENTOS_VEHICULO` | constante del service | `1` (dos consultas máximo por vehículo y corrida) | Ya hay tres reintentos horarios (CF-06). 4 corridas × N vehículos × k reintentos es exactamente cómo «un reintento deja de ser un reintento y pasa a ser una tormenta», que son las palabras del propio cron. Constante y no env: es la forma del algoritmo, no una perilla de operación. |
| **Presupuesto de la corrida** — `PRESUPUESTO_CORRIDA_MS` | constante del service | `40 × 60_000` (80 % de `LOCK_TTL_MS`) | Responde la pregunta que la cabecera del cron deja abierta: «la HU #12096 tendrá que revisarlo si el recorrido real puede tardar más de esto: pasarse del TTL es que otra instancia entre en paralelo». |

**Mecanismo:** `conConcurrencia` (`shared/utils/con-concurrencia.ts`), el pool sin dependencias que ya
usan `flito-recibos.service.ts:151` y `certificacion.service.ts`. Es un pool de promesas: **no bloquea
el event loop** —nada de `sleep` en bucle— y da contrapresión natural con como mucho N en vuelo. Se
recorre por tandas para poder consultar el breaker y el presupuesto entre una y otra.

**Alternativa descartada — `LIMIT` en el censo.** Truncaría en silencio y haría que `total` mintiera.
El presupuesto trunca **por tiempo** y devuelve el resto como `pendientes`, que es la señal que el
reintento horario ya sabe leer.

**Alternativa descartada — subir `LOCK_TTL_MS`.** Pasarlo de una hora recrea el día congelado contra
el que la cabecera del cron advierte por escrito.

---

## 6 · El rastro: `audit_logs` con actor `sistema`, y **no** `pii_access_log`

> **Decisión de David, 2026-09-07.** No se escribe `pii_access_log` por vehículo. El rastro es
> `audit_logs` con `userId: null` / `userEmail: 'sistema'` sobre los que **cambiaron**, más la fila de
> corrida. El `security-agent` la revisa igual antes del PR.

**El actor «proceso» ya tiene una forma en este repo**, y es una sola:
`flito-compuerta.service.ts:238` — `{ userId: null, userEmail: 'sistema', action: 'update',
resource: 'flito_soat', resourceId: <uuid>, detail: … }`. `userId: null` + `userEmail: 'sistema'` **es**
«originada por el proceso, no por una persona» (AC3). `resourceId` es el uuid del SOAT —identificador
opaco, el mismo patrón que `registrarAccesoSoat` ya escribe— y `detail` va sin placa, sin VIN y sin
documento.

**Se auditan solo los vehículos cuya vigencia CAMBIÓ**, más una fila por corrida con los totales.
`audit_logs` responde «quién CAMBIÓ qué» —lo dice la cabecera de `shared/historial/estado-historial.ts`—
y una consulta que no cambió nada no cambió nada. Una fila por vehículo y corrida serían N filas
diarias de ruido.

### Por qué no `pii_access_log`, y qué lo sostiene

El recorrido llama a `consultarRuntCrudo(vin)` y, sobre la respuesta, **solo** a `soatVigenteSegunRunt`
y `fechaVencimientoSoatRunt`. **Nunca** a `extraerDatosCanal` ni a `consultarYClasificar`. Por tanto
no lee ni un campo del titular: `camposAccedidos` sería `[]` en las N líneas diarias, y la HU #11967
ya rechazó por escrito escribir líneas que cuenten divulgaciones que no ocurrieron —*«escribir la
lista de siempre en esas líneas convertiría el registro en una cuenta de divulgaciones que nunca
ocurrieron, y es con ese registro con el que se responde al artículo 17»*—. A eso se suma que
`logPiiAccess` exige un `Request`: fabricarlo produce `user_id NULL`, `ip NULL` y `user_agent ''`, una
fila que no responde ninguna pregunta, con retención de seis años.

> ### Requisito ESTRUCTURAL y verificable, no una buena intención
>
> **Toda la decisión anterior cuelga de un solo hecho**, así que el hecho tiene que ser comprobable y
> no confiado:
>
> **`flito-soat-vigencia.service.ts` no puede importar ni llamar a `extraerDatosCanal` ni a
> `consultarYClasificar`.**
>
> - `extraerDatosCanal` produce `DatosRuntCanal`, que **incluye `propietarioNombre`**; todo lo que
>   entra ahí «acaba persistido o publicado como dato del RUNT» (su propio docblock).
> - `consultarYClasificar` llama a `extraerDatosCanal` por dentro (paso 3 de
>   `clasificarDesenlaceRunt`) y además loguea el desenlace.
>
> **Cómo se comprueba** —y esto es carga del `qa-agent`, no una nota—: un test que afirme sobre el
> texto del módulo que ninguno de los dos identificadores aparece, y un mutante que los introduzca y
> deba ponerlo rojo. Un aserto sobre la lista de importaciones es más barato y más duradero que
> cualquier revisión de código, y sobrevive a la persona que hoy conoce la razón.
>
> El día que alguien necesite el propietario en este recorrido, ese test se pone rojo, sube aquí, y la
> decisión de `pii_access_log` se vuelve a tomar. Que es exactamente lo que tiene que pasar.

---

## 7 · El delta de API de la cola — extensión declarada, por encima de los AC

> **Qué es esto y por qué está aquí.** No lo pide ningún AC de la #12096 **ni de la #12095**, y la
> #12097 es de front. Es una extensión de alcance **decidida** —no derivada—, porque sin ella la
> pantalla de la #12097 no tiene qué pintar y ninguna de las tres HUs la cubre. Se declara como
> extensión, no se disfraza de AC.

Contrato de origen: `/home/david/flit/flito-hu12097/docs/ux/flito-soat-vigencia-en-la-cola.md` §7.

### 7.1 Lo que viaja en la fila

```ts
/** `null` = este SOAT no entra en la verificación diaria: no tiene comprobante vivo cargado. */
vigencia: {
  /** Ya DERIVADO en el servidor, incluido `vencido`. La columna solo tiene tres valores. */
  estado: 'vigente' | 'vencido' | 'sin_registro' | 'no_verificado';
  /**
   * ISO de la última vez que el RUNT RESPONDIÓ, o `null` si nunca respondió (§4.2).
   * Su significado lo da `estado`: con los tres primeros es «cuándo se midió»; con
   * `no_verificado` es «desde cuándo no sabemos nada de este vehículo».
   */
  verificadaEn: string | null;
  /** `yyyy-mm-dd`. Solo con `vigente`/`vencido`, y puede faltar. */
  venceEl: string | null;
} | null
```

**Cuatro valores en el DTO frente a tres en la columna, y es correcto.** `vencido` es una función del
reloj, no un hecho almacenado: guardarlo obligaría a reescribir filas cada medianoche —un segundo cron
para mantener una columna derivada— y a que la fila mintiera entre la medianoche y esa reescritura. Se
deriva en la consulta:

```
CASE WHEN estado_vigencia = 'vigente'
      AND vence_el IS NOT NULL
      AND vence_el < $hoyBogota  THEN 'vencido'
     ELSE estado_vigencia END
```

**`vencido` solo se deriva desde `vigente`.** Una fila `sin_registro` con un `vence_el` viejo —el
último conocido, que el AC5 conserva— **no** se reetiqueta a `vencido`: `sin_registro` significa que el
RUNT no reporta SOAT hoy, y dejar que un dato conservado la reetiquete sería exactamente la confusión
que el UX §3 combate («la primera es un problema del vehículo; la segunda es un problema nuestro»).

### 7.1.b Consecuencia declarada sobre el contrato de UX

`verificadaEn: string | null` **no es lo que pedía** `docs/ux/flito-soat-vigencia-en-la-cola.md` §7,
que lo declaraba `string` y «nunca null» para poder pintar «Último intento hoy». Con la decisión de
§4.2 esa línea no se puede escribir sin mentir, así que **la pantalla gana una superficie más** y dice
lo que la fila realmente sabe:

| Fila | Chip | Segunda línea |
|---|---|---|
| `no_verificado`, `verificadaEn` con fecha | `No se pudo consultar` | **`Verificado hace 3 días`** |
| `no_verificado`, `verificadaEn` = `null` | `No se pudo consultar` | **`Sin verificar aún`** |

La primera **informa más** que «Último intento hoy»: da las dos cosas a la vez —que hoy falló y desde
cuándo no sabemos nada del vehículo—, que es justo la pregunta que el Feature viene a responder. La
segunda absorbe de forma natural el caso del comprobante cargado a las 10:00 cuya primera corrida es a
las 00:10 del día siguiente, sin inventar ningún estado.

Los cuatro textos de chip y el resto del §3 del documento de UX **no cambian**. Lo que cambia es una
línea de copy y que el front tiene que tratar `verificadaEn` como anulable.

### 7.2 El universo de los filtros — corrección derivada de §4.2

> ⚠ **Esto se desvía de la instrucción del 2026-09-07** («mantén el universo por
> `verificada_en IS NOT NULL`; con la variante elegida sigue siendo correcto»). La desviación es
> **consecuencia del propio cambio**, y va con la derivación entera para que se pueda rechazar con
> datos.

El borrador usaba `verificada_en IS NOT NULL` como universo de los tres filtros. Mientras esa columna
registraba **el último intento**, ese predicado significaba «la corrida ya tocó esta fila» y era el
universo correcto. Con la decisión de §4.2 significa otra cosa —«el RUNT respondió alguna vez»— y deja
de servir. Los cinco casos:

| # | Situación | ¿comprobante? | `estado_vigencia` | `verificada_en` |
|---|---|---|---|---|
| 1 | Sin comprobante | no | `no_verificado` (DEFAULT) | `NULL` |
| 2 | Comprobante cargado hoy, corrida aún no | sí | `no_verificado` (DEFAULT) | `NULL` |
| 3 | Intentado, falló, **nunca** hubo respuesta | sí | `no_verificado` (escrito) | `NULL` |
| 4 | Intentado, falló, hubo respuesta antes | sí | `no_verificado` | fecha vieja |
| 5 | Verificado con respuesta | sí | `vigente` / `sin_registro` | fecha |

Con `verificada_en IS NOT NULL`, el filtro **«No se pudo consultar» deja fuera la fila 3**, que es una
fila que falló de verdad. Y no es un caso de laboratorio: la 3 aparece cuando el RUNT falla los cuatro
intentos de un día sobre un vehículo que nunca se había podido medir, y de forma **permanente** sobre
un VIN que el registro nunca acepta. Es decir, **el filtro se vacía precisamente durante la avería que
existe para hacer visible**.

**Se propone el universo que el documento de UX pedía literalmente: las filas con comprobante vivo** —
el mismo `EXISTS` de §3, que además es el predicado que decide si `vigencia` viaja o es `null`, así
que no añade una condición nueva al modelo sino que reutiliza la que ya hay—. Descarta solo la fila 1.

**Su coste, que también se dice.** La fila 2 —comprobante cargado hoy, corrida todavía no— entra bajo
el filtro «No se pudo consultar» aunque nunca se intentó consultar. Es una **sobre-cuenta acotada a
menos de un día** y **visible en pantalla**: su chip lleva «Sin verificar aún» (§7.1.b). Se prefiere a
la **sub-cuenta indefinida** de la fila 3, porque una lista de fallos que oculta fallos es peor que una
que trae de más: nadie sabe que falta algo.

**Alternativa exacta, descartada:** distinguir las filas 2 y 3 exigiría una columna `intentada_en`, que
es justo lo que §4.2 acaba de descartar por estar fuera del AC1.

**Coste de ejecución:** el `EXISTS` aparece dos veces en la consulta de la cola —en la proyección de
`vigencia` y, cuando hay filtro, en el `WHERE`—. Las dos lo resuelve
`idx_flito_soportes_soat_tipo`, que la 0177 crea para el censo.

### 7.3 Dónde entra, y las costuras compartidas

**`condicionesCola`** (`flito-soat.service.ts:370`) es el único sitio donde se escribe el filtro. No es
comodidad: su docblock deja escrito que la comparten «la página, el conteo, las facetas y —desde la HU
#11909— el export a Excel», y que un predicado paralelo «empezaría idéntico y divergiría en el primer
filtro que se añada a uno y no al otro; y la divergencia no se ve: los dos devuelven filas».
Escribiéndolo ahí, las cuatro superficies quedan cubiertas de una vez.

- **`facetasCola`** (`:609`) **no cambia**: el `select` de vigencia tiene cuatro opciones fijas
  (UX §5.1), no derivadas de los datos. Lo hereda todo del predicado compartido.
- **`cola`** (`:535`) gana la proyección de §7.1 y su ensamblado.
- **`colaFiltrosCampos`** (`flito-soat.routes.ts:179-195`) **tiene que declarar `vigencia`**. El
  esquema del `POST /export` se deriva de ese objeto con `.strict()`: mandar `vigencia` sin
  declararlo ahí **no es un filtro ignorado, es un 400**.
- **`CAMPOS_SOLO_INTERNOS`** (`:228`) gana `'vigencia'`: el rol `cliente` no ve nada de esto (UX §6).
  Es la lista que `sinCamposInternos` recorre, con `satisfies readonly (keyof SoatColaItem)[]`, así
  que el tipo y el borrado no se pueden separar.
- **`filtrosPermitidos`** (`:346`) gana `vigencia: undefined` para el `cliente`, la imagen espejo de
  lo anterior. Su propio docblock lo pide: *«si mañana se añade uno, entra en esta lista»*. Sin ello,
  un `cliente` podría filtrar por un campo que no recibe e inferirlo del conteo.

**El corte del día** (`$hoyBogota`) se calcula una vez por petición reutilizando `ahoraEnBogota()`, que
el cron ya exporta. Una sola definición de «hoy en Bogotá» en el módulo, y no dos que puedan divergir
cinco horas.

---

## Modelo de datos

```sql
-- flito_soat: cuatro columnas de vigencia del VEHÍCULO (no de la solicitud, RN-D7)
estado_vigencia varchar(15) NOT NULL DEFAULT 'no_verificado'   -- vigente | sin_registro | no_verificado
verificada_en   timestamptz                                     -- última RESPUESTA del RUNT; NULL = nunca respondió
vence_el        date                                            -- último vencimiento conocido; sobrevive al silencio
poliza_runt     varchar(60)                                     -- lo que dice el RUNT; NO es numero_poliza (el del OCR)

-- una fila por corrida
flito_soat_verificacion_corridas(
  id uuid PK, dia date, intento smallint, iniciada_en timestamptz, cerrada_en timestamptz,
  estado varchar(10), total int, verificados int, cambiaron int, fallidos int, motivos jsonb)
UNIQUE (dia, intento)
```

`varchar` + `CHECK` y **no** un enum de PostgreSQL, en las dos tablas. Es la decisión que `origen` ya
dejó razonada en `schema.ts`: «ampliarlo es un `DROP`/`ADD CONSTRAINT` barato, mientras que un enum
arrastraría a cada migración futura la trampa del `55P04` que este Feature ya paga dos veces». Los dos
CHECK se declaran **también en `schema.ts`**, por la lección que la 0157 dejó escrita: un CHECK que
solo vive en la base convence a quien lee el esquema de que añadir un valor no necesita migración, y el
primer INSERT nuevo muere con `23514`.

`motivos jsonb NOT NULL DEFAULT '{}'`, con forma
`{ causas: Partial<Record<'timeout'|'red'|'circuito'|'otro', number>>, reintentos: number }`.
**Vocabulario cerrado**: agrupa MOTIVOS, no filas. Por construcción no puede contener una placa, un VIN
ni un documento — no hay ninguna clave dinámica.

Índices que crea la migración 0177:

- `uq_flito_soat_verif_corrida_dia_intento (dia, intento)` — único; sirve también `WHERE dia = $1`.
- `idx_flito_soportes_soat_tipo (soat_id, tipo) WHERE soat_id IS NOT NULL AND descartado = false` —
  el `EXISTS` del censo es su único predicado selectivo y esa tabla no tiene índice por `soat_id` solo.
- **`verificada_en` NO se indexa — decisión negativa, tomada con medición.** El diseño llegó a
  proponer `idx_flito_soat_verificada_en (verificada_en)` para el predicado del AC6 y el de §7.2. El
  gate de esquema lo midió **inerte** y se retiró antes del PR: un btree se declara `ASC NULLS LAST`
  y solo puede suplir ese orden hacia adelante o `DESC NULLS FIRST` hacia atrás, mientras que el
  censo pide `ASC NULLS FIRST` —lo nunca verificado primero—; con `EXPLAIN` y `enable_seqscan = off`
  sale `Sort (NULLS FIRST) → Seq Scan` aunque se penalice el seqscan a 1e10. Y el predicado tampoco
  lo usaría: `verificada_en IS NULL OR verificada_en < corte` es un `OR` de baja selectividad y sin
  `LIMIT`. **Cuándo sí crearlo:** el día que exista una consulta de antigüedad con `LIMIT`, con la
  cláusula de orden de esa consulta y comprobando con `EXPLAIN` que entra.

**Sin backfill, en las dos tablas.** De las corridas anteriores no consta nada por corrida y de los
vehículos no consta ninguna verificación. Rellenarlo sería escribir como hecho lo que nadie observó —la
regla que la migración 0174 dejó escrita—. La segunda pasada del archivo no cambia ni una fila.

---

## Archivos

**Crear**

- `apps/api/src/db/migrations/0177_flito_soat_vigencia_runt.sql`
- `apps/api/__tests__/services/flito-soat-vigencia.recorrido.test.ts`

**Modificar**

- `apps/api/src/db/schema.ts` — cuatro columnas + CHECK + índice en `flitoSoat`; tabla
  `flitoSoatVerificacionCorridas`; índice nuevo en `flitoSoportes`
- `apps/api/src/modules/flito-soat/flito-soat-vigencia.service.ts` — el recorrido,
  `vehiculosAVerificar()`, el clasificador de §4.1, los dos topes de §5.2
- `apps/api/src/modules/flito-soat/flito-soat-vigencia.cron.ts` — cuerpo de
  `leerEstadoDelDia`/`guardarEstadoDelDia` (KV → tabla) y el segundo parámetro de §2.4; retirar
  `KV_CLAVE_CORRIDA`. **`decidirCorrida`, `ahoraEnBogota`, el candado, la puerta por env y la cadencia
  no se tocan**
- `apps/api/src/modules/flito-soat/flito-soat.service.ts` — §7.3: `condicionesCola`, `cola`,
  `CAMPOS_SOLO_INTERNOS`, `filtrosPermitidos`, `FiltrosCola`, `SoatColaItem`
- `apps/api/src/modules/flito-soat/flito-soat.routes.ts` — `colaFiltrosCampos` + parseo de la query
- `apps/api/src/config/env.ts` — `SOAT_VIGENCIA_CONCURRENCIA`
- `apps/api/__tests__/services/flito-soat-vigencia.cron.test.ts` — los ~10 puntos atados a
  `system_kv` (líneas 109, 125-139, 209, 245-250, 286, 635)
- `packages/shared-types/src/flito-estados.ts` — §«Impacto en shared-types»
- `.env.example` y la documentación de despliegue que declare las variables del cron

**Sin dependencias nuevas.** Todo lo necesario ya está en el repo: `conConcurrencia`,
`circuitoAbierto`, `causaDeCaida`, `runtSinRegistro`, `withLock`, `exists` de drizzle.

---

## Impacto en `shared-types`

En `packages/shared-types/src/flito-estados.ts`, junto a `TipoSoporte`:

- `EstadoVigenciaSoat` — los **tres** valores persistidos (`vigente | sin_registro | no_verificado`).
- `EstadoVigenciaSoatVista` — los **cuatro** del DTO, con `vencido`. Separado del anterior a propósito:
  un solo tipo con cuatro valores dejaría que alguien escribiera `'vencido'` en la columna y el CHECK
  lo rechazaría en producción con un `23514` que TypeScript no vio venir.
- `ResumenMotivosCorrida` — la forma del jsonb, con el vocabulario cerrado de causas.

Van a `shared-types` y no al API por dos razones concretas: `schema.ts` los necesita para `$type<>()` y
ya toma de ahí sus tipos de jsonb persistido (`ExtraccionSoat`, `ProcedenciaCompradorPersistida`), y
`EstadoVigenciaSoatVista` es contrato de la respuesta que la HU #12097 consume.

**Lo que NO sube a `shared-types`:** `MAX_REINTENTOS_VEHICULO`, `PRESUPUESTO_CORRIDA_MS` y el nombre
del circuito. Son detalle de ejecución del servidor, igual que
`OCR_CONCURRENCIA_CARGA_MASIVA` deja escrito en su propio comentario.

---

## Lo que este ADR NO compra (léase antes de aprobar)

1. **No garantiza que el SOAT exista**, solo que el RUNT lo reporta. `sin_registro` puede ser un
   retraso del registro nacional tanto como una póliza que no existe.
2. **No distingue «vencido» de «el RUNT no reporta póliza»** en la columna: `soatVigenteSegunRunt`
   colapsa `fail` y `unknown` en `false`, y los dos caen en `sin_registro`. Separarlos exigiría un
   cuarto valor fuera del AC1 o volver a derivar el pre-vuelo, duplicando la cadena de alias que
   `extraerVehiculoRunt` centraliza. El `vencido` del DTO (§7.1) es otra cosa: sale de `vence_el`, no
   del check.
3. **No dispara ninguna alerta.** Nadie se entera de un `sin_registro` si no abre la cola y filtra. Una
   notificación es otra HU y otra decisión de producto.
4. **No mide nada de la corrida más allá de sus totales.** No hay duración por vehículo ni latencia del
   RUNT: `flito_comparendos_sync_steps` es el precedente de eso y aquí no se replica, porque una fila
   por vehículo y noche es telemetría cara para una pregunta que nadie ha hecho todavía.
5. **No cubre el histórico.** Antes de la 0177 no consta ninguna verificación de ningún vehículo, y no
   se inventa.

---

## Riesgos abiertos y qué falta decidir

| # | Qué | Dueño |
|---|---|---|
| 1 | **§7.2 — el universo de los tres filtros de la cola.** Es consecuencia de la decisión de §4.2 y la única línea abierta que toca el código: `verificada_en IS NOT NULL` deja el filtro «No se pudo consultar» vacío durante la avería. Se propone el `EXISTS` del comprobante, con el coste de las dos opciones medido. | David |
| 2 | **§7 — la extensión de API.** Está decidida como extensión declarada, pero no la cubre ningún AC: si el PO prefiere que sea alcance de la #12097, hay que moverla y la #12097 deja de ser de front. | PO / David |
| 3 | **§6 — el rastro.** Aprobada por David; **el `security-agent` la revisa antes del PR**. Si pide `pii_access_log`, entra con HMAC del VIN según ADR-0012 y hay que decidir la retención. | `security-agent` |
| 4 | **§1 — la desviación de nombres** hay que declararla en el PR y en la Discussion del WI #12096. Si no se declara, QA formal la encuentra como defecto. | quien abra el PR |
| 5 | **§2.5 — la ventana de despliegue** de la 0177 (00:10–01:10 de Colombia). Mitigación operativa. | quien despliegue |
| 6 | **El tamaño real del censo no se ha medido** (sin acceso a la base). El presupuesto de 40 minutos y la concurrencia 2 son un techo declarado, no una medida. Primera corrida en DEV con `SOAT_VIGENCIA_CRON_ENABLED=1`: mirar `total` y la duración **antes** de fijar el default en producción. | operaciones |

---

## Notas operativas por agente

### `backend-agent`

- **El orden del clasificador de §4.1 es el ADR.** Invertirlo escribe `sin_registro` por silencio y
  rompe el AC5 en la primera caída del RUNT, en verde.
- Firmas asimétricas: `soatVigenteSegunRunt(respuesta)` / `fechaVencimientoSoatRunt(respuesta.data)`.
- `causaDeCaida(respuesta.message)` — sin `new Error(...)`: acepta `unknown`.
- **Prohibido** importar `extraerDatosCanal` o `consultarYClasificar` (§6).
- El error que salga del recorrido debe ser una clase con **nombre propio** (`RuntSinRespuestaError`):
  el cron loguea `err.name`, nunca el mensaje, y ese canal está cerrado a propósito desde la #12095.
- `exists()` y no `JOIN` en el censo (§3).

### `qa-agent` — los cuatro asertos que el mock puede dejar vacíos

- El censo y el filtro de vigencia se comprueban sobre el **SQL renderizado**
  (`helpers/sql-ligado.ts`): el `chain` del mock devuelve la fila entera aunque el `select` pida menos
  e ignora el `where`, así que afirmar sobre las filas devueltas es una tautología.
- **Ningún `orderBy` en `leerEstadoDelDia`.** Si aparece, el test es verde vacío
  (`helpers/orden-sql.ts`).
- **Mutantes que deben poner rojo**, nombrados: quitar `descartado = false` del `EXISTS`; invertir el
  orden transporte/vigencia de §4.1; quitar la guarda de `circuitoAbierto`; **escribir `verificada_en`
  en la rama `no_verificado`** —§4.2: es lo que rompe la métrica del Feature y hace que el reintento
  horario salte al vehículo que falló—; derivar `vencido` también desde `sin_registro`; introducir un
  import de `extraerDatosCanal`.
- `TZ=UTC` en el archivo, como el de la #12095: en `-05` el mutante del reloj sobrevive.
- Ningún test debe meter placa, VIN ni póliza en un `data-*` — los selectores de axe arrastran valores
  de atributo al informe.

### `security-agent`

- Revisar §6 completa, y en particular el requisito estructural: **es lo único que sostiene la
  decisión de no escribir `pii_access_log`**.
- `motivos` es un vocabulario cerrado. Comprobar que ninguna clave del jsonb sea dinámica.
- El filtro viaja como `vigencia=vencido|sin_registro|no_verificado`: valores máquina, en query, sin
  cuasi-PII (AGENTS.md §14). El **número de póliza del RUNT no se proyecta en la cola** (UX §7.4).

### `frontend-agent`

- Nada en esta HU. El contrato que consume la #12097 es §7.1, y su regla de compatibilidad está en el
  documento de UX: **`vigencia` ausente tiene que renderizar la fila exactamente como hoy** —el merge
  es el deploy y el bundle puede ir por delante del API.
