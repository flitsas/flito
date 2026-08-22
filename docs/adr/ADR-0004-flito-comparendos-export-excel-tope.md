# ADR-0004 — Export a Excel del consolidado de comparendos: tope duro y rastro obligatorio

## Estado

**Propuesto** — Feature [#11495](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11495) (17b), HU [#11558](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11558).
Pendiente de aprobación del Líder Técnico. Requiere además gate de `security-agent` antes del PR (ruta nueva sobre datos personales, AGENTS.md tabla de gates).

## Contexto

El Feature #11492 (17a) fijó **a propósito** un techo de extracción para la lectura del consolidado, y lo dejó escrito en dos sitios que hoy son la fuente de verdad:

- `packages/shared-types/src/flito-comparendos.ts` — `COMPARENDOS_REGISTROS_LIMIT_MAX = 50`, tope **y** valor por defecto de página: «El número sale de multiplicarlo por el limitador de la lectura (60 peticiones por minuto y usuario): 50 filas × 60 = 3 000 NITs y placas por minuto, que es el techo de exfiltración que el módulo acepta para un administrador con sesión válida».
- `apps/api/src/modules/flito-comparendos/flito-comparendos.routes.ts` — `registrosLimiter` (60/min por usuario) con el razonamiento explícito de que «este límite no corta el bucle: le pone precio», y la nota de que bajar la página de 200 a 50 dividió el techo por cuatro sin quitarle nada al uso real.

A eso se suman las otras dos piezas del mismo diseño: la paginación es por **cursor opaco** (no `offset`), y los filtros que identifican —NIT y placa— viajan en el cuerpo de `POST /registros/buscar`, nunca en la query (AGENTS.md §14). El registro de acceso queda escrito **antes** de responder, en `entregarPagina`, con `accion: 'search'` y el número de filas entregadas.

La HU #11558 pide exportar a Excel el conjunto filtrado. **Eso rompe el techo por definición**: entrega en una sola petición lo que la API interactiva entrega en decenas. Con el techo de 17a, llevarse 5 000 filas cuesta 100 peticiones y algo más de un minuto y medio de reloj; con un export sin límite cuesta una petición. No hay forma de añadir el export y dejar el techo intacto: la decisión no es «si se baja el techo», es **cuánto se baja, a cambio de qué contrapartidas, y qué queda escrito cuando alguien lo usa**.

Dato de contexto que no cambia la decisión pero sí su lectura: los datos del módulo son de terceros (NIT del monitoreado, placa que identifica indirectamente al propietario, según los `COMMENT` de la migración `0150`), y el módulo ya tiene retención declarada (`COMPARENDOS_RETENTION_MONTHS`, 24 meses parametrizables — ADR-0001) y registro de acceso propio (`flito-comparendos.pii.ts`, HU #11511), cuyo `AccesoComparendos.accion` **ya contempla `'export'`**: el contrato se escribió previendo esta HU.

## Decisión

1. **`POST /api/flito/comparendos/registros/export`, sin variante `GET`.** Mismo par query/cuerpo que `POST /registros/buscar` (`estado`, `q` en query; `nit`, `placa` en el cuerpo), ambos `.strict()`, sin `limit` ni `cursor` — un export no pagina. En el front: `fetch` con el cuerpo, `blob`, `URL.createObjectURL` y `revokeObjectURL` inmediato. **Prohibido** `<a download href="…?nit=…">`: ese patrón devuelve el NIT y la placa a la URL, que es exactamente lo que el §14 y el diseño de 17a sacaron de ahí.
2. **Tope duro de 5 000 filas**, en constante `COMPARENDOS_EXPORT_MAX_FILAS` con override por env (rango acotado en `config/env.ts`, como `COMPARENDOS_INACTIVACION_MAX_FILAS`). Por encima → **422 `export_demasiado_grande`**, con mensaje que le diga al usuario que afine los filtros. La comprobación se hace **pidiendo tope + 1 filas** —el mismo truco de `listarRegistros`, que pide `limit + 1`— y **no** con un `count(*)` sobre la tabla filtrada, que es la consulta cara y además obligaría a recorrer dos veces lo mismo.
3. **Limitador propio: 5 peticiones por minuto y usuario** (`exportLimiter`, `keyGenerator: userOrIpKey('flito-comparendos-export')`, `store: makeStore('rl:flito-comparendos-export:')`). Independiente del de `/registros` y mucho más estricto que sus 60/min: son dos cuotas separadas a propósito, para que gastar la del export no afloje la de la lectura ni al revés.
4. **Registro de acceso obligatorio, antes de escribir un solo byte del archivo**: `registrarAccesoComparendos(req, { recurso: RECURSO_REGISTROS, accion: 'export', campos: [...CAMPOS_PII_REGISTRO, ...CAMPOS_PII_OBSERVACION], filas, filtros })`, con `filas` = las filas **realmente entregadas** (no el tope, no lo pedido). Respuesta con `Cache-Control: no-store`.
   > **Corrección (2026-08-19, durante la HU #11558).** Este ADR se redactó con `campos: [...CAMPOS_PII_REGISTRO]` a secas, y eso era un defecto: el AC2 mete la **observación** en el archivo, y `CAMPOS_PII_OBSERVACION` existe desde la HU #11557 precisamente porque es el único campo del módulo que redacta una PERSONA —ahí puede acabar un nombre, un teléfono o un radicado sin que ninguna validación lo impida—. Declarar solo NIT y placa dejaría un export de 5 000 observaciones registrado como si no hubiera salido ninguna, y los siete criterios de aceptación pasarían igual. La regla de `flito-comparendos.pii.ts` es la que manda: **toda lectura que devuelva la observación tiene que declararla**.
5. **El archivo no incluye `payload_simit` ni `payload_municipal`.** `CAMPOS_PII_PAYLOAD` no entra en el registro de acceso de esta ruta porque esos campos no salen. Las columnas del `.xlsx` son la proyección de `ComparendoRegistro`, por lista blanca explícita y no por `Object.keys` de la fila.
6. **Orden de operaciones en la ruta, y es normativo:** validar → consultar tope+1 → si excede, `422` **JSON**; solo entonces registro de acceso, cabeceras de adjunto y workbook. Un `Content-Disposition` puesto antes de saber el tamaño produce un `.xlsx` truncado con un JSON de error dentro, que el usuario abre y no entiende.
7. Guardas heredados del router: `authMiddleware` + `requireRole('admin')` a nivel de `router.use` (roles solo de `USER_ROLES`; `operaciones` no existe, CF-12).

### El argumento, dicho entero

El techo de 50 filas protege **una API interactiva contra el barrido silencioso página a página**: el atacante ahí es una sesión válida que pagina en bucle produciendo 60 líneas de log por minuto indistinguibles de una tabla que alguien navega deprisa. El export es otro gesto: **deliberado, autenticado, restringido a `admin`, auditado con el número exacto de filas y limitado a 5 por minuto**. Quien puede exportar **ya podía paginar** —el dato no es más accesible que ayer—; lo que cambia es que ahora queda escrito **cuánto se llevó, en una sola línea**, que es justo lo que la Ley 1581 art. 17 pide poder responder cuando un titular pregunta quién consultó sus datos. Un `pii_access_log` con `accion=export filas=5000` es una respuesta; 100 filas de `accion=search filas=50` es un ejercicio de reconstrucción.

## Alternativas consideradas

### Opción A — Export sin tope (todo el conjunto filtrado)

| | |
|---|---|
| **Pros** | Cero fricción para el usuario; no hay que explicar un 422; ningún filtro «legítimo pero grande» queda bloqueado; menos código. |
| **Contras** | Convierte una petición en un volcado de la tabla entera: sin filtros, `GET /registros` sin `estado` ni `q` devuelve todo el histórico; el pico de memoria de `exceljs` crece sin cota y es el proceso del API el que muere; anula por completo el razonamiento de 17a sin poner nada en su sitio; incompatible con el timeout del proxy (~120 s, ADR-0001). |
| **Esfuerzo** | **S** |
| **Riesgos** | Alto: un OOM del API por un click; techo de exfiltración = tamaño de la tabla, en una petición. |

Descartada. No es una alternativa de seguridad: es la ausencia de decisión.

### Opción B — Tope conservador de 2 000 filas

| | |
|---|---|
| **Pros** | Techo por minuto de 2 000 × 5 = 10 000 filas, 3,3× el interactivo (frente a 8,3× con 5 000); pico de memoria de `exceljs` claramente dentro de lo medido en `soat`/`vehicles`; el 422 aparece pronto y **enseña** a filtrar, que es el comportamiento que se quiere. |
| **Contras** | 2 000 es probable que corte exports legítimos —un NIT grande con varios años de histórico— y el usuario responde troceando por `estado` y pegando hojas a mano, que produce **más** peticiones y un rastro peor; el 422 frecuente erosiona la confianza en la pantalla; obliga antes a la conversación sobre export asíncrono. |
| **Esfuerzo** | **M** (idéntico al de 5 000: solo cambia la constante) |
| **Riesgos** | Medio: fricción que empuja al usuario a rodear el mecanismo en lugar de usarlo. |

Es la alternativa seria y la que se descarta por poco. Si tras dos o tres meses el `pii_access_log` muestra que casi ningún export pasa de 2 000 filas, **bajar la constante es un cambio de una línea y no necesita otro ADR** — el env override existe justamente para eso.

### Opción C — Tope duro de 5 000 filas + limitador propio + registro de acceso (elegida)

| | |
|---|---|
| **Pros** | Cubre el caso real de negocio (un NIT con histórico completo) sin trocear; el tope es un número **defendible**, no infinito, y su lectura por minuto (25 000) queda escrita en este ADR en vez de emerger sin que nadie la calcule; la comprobación tope+1 reutiliza el patrón ya vigente de `listarRegistros` y evita el `count(*)`; el rastro por petición es más legible que el equivalente paginado; el env override permite corregir el número con datos reales sin tocar código. |
| **Contras** | Sube el techo por minuto de 3 000 a 25 000 filas (**8,3×**) — hay que decirlo sin adornos; 5 000 filas de `exceljs` se construyen en memoria en el proceso del API y bloquean parcialmente el event loop; el 422 sigue existiendo y alguien lo encontrará; añade una constante y un limitador más al módulo. |
| **Esfuerzo** | **M** |
| **Riesgos** | Medio-bajo, condicionados a que el registro de acceso se escriba **siempre** y a que nadie mueva `COMPARENDOS_EXPORT_MAX_FILAS` en producción sin revisar este ADR. |

**Elegida.** Frente a B gana porque el coste de cortar un export legítimo (troceo manual, más peticiones, rastro peor) es mayor que el delta de riesgo entre 10 000 y 25 000 filas por minuto **cuando las dos cifras ya están por encima del techo interactivo y las dos quedan igual de auditadas**. Frente a A gana porque A no decide nada. La diferencia entre B y C no es de arquitectura sino de calibración, y este ADR deja el mecanismo para recalibrar (env) y el dato con el que hacerlo (`filas` en el `pii_access_log`).

### Opción D — Export asíncrono con generación diferida

Encolar la generación, escribir el `.xlsx` en MinIO/S3 y entregar una URL firmada de vida corta; la pantalla consulta estado.

| | |
|---|---|
| **Pros** | Desacopla del timeout del proxy (~120 s) y del event loop; permite topes mucho más altos sin arriesgar el proceso; el artefacto queda identificado y su descarga se puede auditar aparte. |
| **Contras** | Introduce **un archivo con datos personales en reposo fuera de la base**, con su propio ciclo de vida, su propia retención y su propia URL firmada — tres superficies nuevas de fuga que hoy no existen; el módulo no tiene cola (ADR-0001 dejó el sync síncrono en v1 precisamente por no meterla); duplica el trabajo de la HU; una URL firmada es un enlace que se reenvía por correo, que es peor que el blob que se revoca. |
| **Esfuerzo** | **L** |
| **Riesgos** | Alto para el alcance de 17b: mucha maquinaria nueva para un problema que a 5 000 filas todavía no está demostrado. |

Descartada **por ahora**, no por siempre: es la sucesora natural si se cumplen las señales de la sección de coste. Si se toma, será con ADR propio y con retención explícita del objeto.

## Contrato del endpoint

```
POST /api/flito/comparendos/registros/export
  auth: authMiddleware + requireRole('admin')     (heredados del router)
  rate: exportLimiter — 5/min por usuario
  query:  { estado?: 'activo'|'inactivo', q?: string(3..60) }        .strict()
  body:   { nit?: string, placa?: string }                           .strict()
          (mismos esquemas que POST /registros/buscar; sin limit ni cursor)

  200  application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
       Content-Disposition: attachment; filename="comparendos_<YYYYMMDD-HHmm>.xlsx"
       Cache-Control: no-store
  400  { error: 'Datos inválidos', details }                 — Zod (incluye ?nit= en query)
  422  { error: '…', codigo: 'export_demasiado_grande' }     — ComparendosError(422)
  429  { error: 'Demasiados exports seguidos, espere 1 minuto' }
```

El 422 es JSON y sale **antes** de cualquier cabecera de adjunto (decisión 6). `codigo` estable en minúsculas, como el resto de `flito-comparendos.errors.ts`.

## Impacto sobre ADR-0001

Con precisión, porque aquí es fácil decir de más:

- **No lo supersede.** ADR-0001 decide el módulo, la ingesta, el sync síncrono y el modelo de datos; nada de eso cambia. Al contrario: su tabla de alternativas descartó «solo JSONB sin columnas canónicas» razonando que «encarece 17b (filtros/**export**)» — este ADR es el cobro de aquella inversión, no su contradicción.
- **No lo enmienda en su texto, porque el techo de extracción nunca estuvo en él.** El `50 × 60 = 3 000` vive en `packages/shared-types/src/flito-comparendos.ts` y en el comentario de `registrosLimiter`, no en ADR-0001. Lo que este ADR **complementa** es la decisión de 17a tal como quedó **en código**: el techo deja de ser el único mecanismo y pasa a ser el techo de *la ruta interactiva*, con el export gobernado por su propia cota (5 000) y su propia cuota (5/min).
- **Qué habría que tocar en ADR-0001 si esto se aprueba:** añadir una línea en su bloque final, junto a la «Corrección (2026-08-13)», del tipo *«Enmienda (fecha): el techo de extracción del módulo deja de ser únicamente el de la lectura paginada; ver ADR-0004 para el export de 17b»*, y **nada más**. No se toca ninguna de sus siete decisiones numeradas.
- **Qué habría que tocar en código si esto se aprueba** (lo ejecuta `backend-agent`, no este ADR): el comentario de `COMPARENDOS_REGISTROS_LIMIT_MAX` en shared-types y el de `registrosLimiter` deben dejar de leerse como «el techo del módulo» y pasar a decir «el techo de la lectura interactiva; el export tiene el suyo (ADR-0004)». Dejar esos comentarios como están sería peor que no tenerlos: afirmarían un techo que ya no es el del módulo.
- ADR-0002 y ADR-0003 no se ven afectados.

## Riesgo de datos personales (Ley 1581) y cómo queda cubierto

- **Qué sale.** `nit_monitoreado` (PII cuando el monitoreado es persona natural) y `placa` (identifica indirectamente al propietario) — los dos declarados en `CAMPOS_PII_REGISTRO`— y la **observación de gestión** (`CAMPOS_PII_OBSERVACION`), que es texto libre escrito por una persona y puede contener lo que a esa persona le pareciera relevante. El resto de columnas describe la infracción, no a una persona. Los payloads crudos **no salen** (decisión 5).
- **Art. 17 (deber de informar al titular quién consultó sus datos).** Cada export escribe una fila en `pii_access_log` con usuario, hora, `accion='export'`, `campos_accedidos` y `motivo` con `filas=N` y los filtros **enmascarados** (`resumirFiltros` aplica `maskDocument` a las claves que casan `FILTRO_SENSIBLE`, que ya incluye `nit` y `placa`). El rastro es más informativo que el de la ruta interactiva, no menos.
- **Por qué `await` y no fuego-y-olvido.** Igual que en `entregarPagina`: `logPiiAccess` es best-effort y nunca tumba la operación, pero esperar garantiza que la fila está escrita antes de que salga el archivo. Un rastro que se pierde porque el proceso murió a mitad del `.xlsx` no es un rastro. Aquí importa más que en el listado: la petición que se pierde vale 5 000 filas, no 50.
- **URL sin PII.** El `POST` sin variante `GET` mantiene NIT y placa fuera del access log de nginx, del historial del navegador y del `Referer` — los tres sitios que, como razona el comentario de `ComparendosRegistrosBusqueda`, no están bajo la retención de 24 meses del módulo ni bajo `pii_access_log`.
- **Retención.** El archivo no se persiste en ninguna parte: se genera, se entrega y muere en el proceso; el blob del navegador se revoca. No hay artefacto nuevo que retener — y esa es justamente la propiedad que la Opción D sacrificaba.
- **Lo que sigue descubierto.** El `.xlsx` ya en el disco del usuario queda fuera del alcance técnico del módulo. Es un control de política (acuerdo de uso, formación), no de código, y conviene que quede dicho aquí para que nadie lo dé por resuelto.

## Coste de generar 5 000 filas con `exceljs` en el proceso del API

`apps/api/src/shared/utils/excel.ts` (`sendExcel`) usa el `Workbook` **en memoria**: construye todas las filas con `addRow` y luego `workbook.xlsx.write(res)`. No es streaming. Con ~20 columnas por fila eso significa decenas de miles de objetos JS vivos a la vez más el buffer del ZIP, y la compresión hace trabajo síncrono en el mismo hilo que atiende al resto del API. Los usos actuales (`soat`, `vehicles`) trabajan con volúmenes menores y nadie ha medido este caso.

Se acepta a 5 000 filas **con la condición de medirlo** en la HU (duración, delta de RSS, lag del event loop, con la tabla poblada). Señales que obligan a reabrir la decisión y pasar a la Opción D (o, como paso intermedio más barato, a `exceljs` `stream.xlsx.WorkbookWriter`, que escribe incremental sobre `res` y baja el pico de memoria sin necesidad de cola ni de objeto en S3):

- **p95 del endpoint > 5 s**, o cualquier export acercándose al `proxy_read_timeout` de nginx (~120 s, el mismo techo que ya acotó el sync en ADR-0001).
- **Delta de RSS por export > ~150 MB**, o cualquier OOM del proceso correlacionado con la ruta.
- **Lag del event loop perceptible** durante la generación (peticiones concurrentes al API degradándose mientras alguien exporta).
- **Cualquier petición de subir `COMPARENDOS_EXPORT_MAX_FILAS` por encima de ~20 000**: a esa escala el debate ya no es el tope, es la arquitectura — y entonces toca ADR sucesor con `Supersedes` a este.

### Medición (HU #11651, 2026-08-22) — el tope baja de 5 000 a 2 000

La condición se cumplió: está medido. **Y la medición desmiente el 5 000.**

**Método.** `sendExcel` con filas sintéticas de la forma real —todas las columnas de `COLUMNAS_EXPORT`, textos distintos por fila para que `exceljs` no comprima la tabla de cadenas— sobre un sumidero que drena, como hace el socket real. Se mide el delta de RSS sobre el reposo del proceso, el pico de heap y el retraso real de un `setInterval` de 20 ms (lag del event loop). Instrumento en `apps/api/__tests__/helpers/export-coste.ts`; escenarios en `flito-comparendos-export-coste.test.ts` (secuencial) y `flito-comparendos-export-concurrencia.test.ts` (simultáneo). **Cada escenario se corre en un proceso propio**: Vitest reutiliza los workers entre archivos y un proceso que ya construyó un workbook grande arranca el siguiente con las arenas del allocator calientes, lo que hace que el delta salga optimista — así se midió la primera vez, en la HU #11558, y por eso su «peor caso» daba un delta MENOR que su caso realista.

**Resultado, peor caso del archivo (observación al máximo en todas las filas), delta de RSS:**

| filas | 1 export | 2 simultáneos | 3 simultáneos | 4 | 5 |
|------:|---------:|--------------:|--------------:|--:|--:|
| 5 000 | +152 MB  | **+247 MB**   | +365 MB       | — | — |
| 4 000 | +102 MB  | +166 MB       | —             | — | — |
| 3 000 | + 58 MB  | +116 MB       | +203 MB       | — | — |
| 2 500 | + 91 MB  | +140 MB       | +150 MB       | — | — |
| 2 000 | + 93 MB  | **+106 MB**   | +124 MB       | +169 MB | +239 MB |

Duración de 1,0 a 1,7 s por export aislado y lag máximo del event loop de 0,4 a 1,0 s; con dos simultáneos, 2,0 s y 2,2 s respectivamente.

**Cómo se lee.** El presupuesto no es 512 MB: es **512 − lo que el API ya ocupa**. Con el extremo pesimista del rango del PR #153 (250 MB en régimen) quedan **262 MB** para la generación. Con 5 000 filas, dos exports simultáneos consumen 247 de esos 262 — a **15 MB** del `max_memory_restart`— y tres lo cruzan (615 MB proyectados). Y esos dos simultáneos no son hipótesis: `exportLimiter` tiene `keyGenerator: userOrIpKey(…)`, o sea cuota **por usuario**, y no existe ninguna cota global ni semáforo, así que dos administradores distintos los lanzan y pasan los dos.

Dos de las señales de reapertura escritas arriba estaban ya disparadas con el valor anterior: el delta por export de 5 000 filas es de ~152 MB (el umbral era ~150 MB) y el lag del event loop llega a 1 s aislado y 2 s en concurrencia.

**Decisión: `COMPARENDOS_EXPORT_MAX_FILAS` pasa de 5 000 a 2 000**, que es la **Opción B** de este mismo ADR — la que se descartó «por poco» y sobre la que quedó escrito que bajar a ella «es un cambio de una línea y no necesita otro ADR». Con 2 000, dos exports simultáneos consumen 106 MB de los 262 (40 % del presupuesto) y el proceso aguanta hasta cuatro a la vez. Las contras de la Opción B siguen siendo las de su tabla y no se maquillan: un NIT grande con varios años de histórico puede no caber en un archivo y el usuario trocea por filtro. El techo de extracción por minuto baja a la vez de 25 000 a 10 000 filas, que es una mejora de privacidad, no un daño colateral.

**Sobre las dos salidas que se retiraron del alcance, con un número en vez de una intuición.** Se midió aparte el mismo par de exports encadenado en lugar de solapado —que es lo que haría un semáforo en proceso que serializase la generación—: 5 000 filas cuestan 246 MB solapados y **198 MB encadenados**; 2 000 filas, 105 y 95 MB. Solapar cuesta un 24 % más, pero el grueso del coste no es el solapamiento sino que el RSS no vuelve al sistema operativo entre un export y el siguiente. Traducido: **con el tope en 5 000, el semáforo por sí solo no habría arreglado el defecto** —dejaba el proceso en 198 MB de los 262 de presupuesto, con dos exports y sin margen para un tercero—. La salida que sí baja el pico es no tener el libro entero en memoria (`WorkbookWriter`), o tener menos filas, que es lo que hace esta HU.

**Lo que esto NO resuelve, y es la parte que hay que leer.** Bajar el tope acota el coste por export; **no acota la concurrencia**, porque nada la acota. Con 2 000 filas la pared está en **cinco exports simultáneos** (+239 MB de 262). Cinco administradores exportando a la vez siguen reiniciando el proceso, y ningún valor del tope arregla eso: es una propiedad del diseño —workbook entero en memoria, sin cota global— y no de la calibración. Las dos salidas que sí lo arreglarían (semáforo en proceso que serialice la generación, o `stream.xlsx.WorkbookWriter` escribiendo incremental sobre `res`) quedaron **fuera del alcance** de la HU #11651 por decisión del Líder Técnico el 2026-08-20. Este párrafo existe para que el día que aparezca un reinicio de PM2 correlacionado con la ruta, nadie tenga que volver a descubrir por qué.

## Consecuencias

**Positivas**

- El export existe con una cota escrita y defendible, en vez de aparecer como efecto secundario de una HU de UI.
- El rastro de una extracción masiva pasa a ser legible de un vistazo (`accion=export filas=N`), que es lo que el art. 17 necesita.
- Se reutilizan tres patrones ya vigentes del módulo —`limit + 1` en lugar de `count(*)`, `userOrIpKey` + `makeStore` para el limitador, `registrarAccesoComparendos`— sin inventar ninguno.
- Ninguna dependencia nueva: `exceljs` ya está en `apps/api/package.json` y `sendExcel` ya existe.
- El env override permite recalibrar el tope con datos reales sin volver a pasar por un ADR (mientras el movimiento sea hacia abajo o dentro del rango ya razonado).

**Negativas — dichas sin adornos**

- **El techo de exfiltración por minuto sube de 3 000 a 25 000 filas (8,3×).** Es el precio de la funcionalidad y no hay forma de tenerla sin pagarlo; lo que se compra a cambio es visibilidad, no imposibilidad.
- El export se construye en memoria en el proceso del API: a 5 000 filas es un pico medible que hoy nadie ha medido.
- Aparece un cuarto limitador en el módulo; la matriz de cuotas por ruta empieza a necesitar su propia tabla en la documentación del Feature.
- El 422 es una fricción real: alguien con un filtro amplio verá un error donde esperaba un archivo, y la pantalla tiene que explicarlo bien o el usuario creerá que está roto.
- `COMPARENDOS_EXPORT_MAX_FILAS` es una perilla de producción con impacto directo en privacidad. Subirla es una decisión de seguridad disfrazada de variable de entorno, y este ADR es el único sitio donde eso está escrito.

**Sin resolver**

- El número 5 000 es un juicio, no una medición: no hay dato histórico de cuántas filas pide un export real. Se revisa con el `pii_access_log` a los dos o tres meses.
- Si el `.xlsx` debe llevar una hoja de metadatos (filtros aplicados, usuario, fecha) es decisión de UX y de la HU, no de este ADR; si se añade, el usuario y la fecha van ahí, nunca el NIT o la placa sin enmascarar en un pie de página.
- Un tope por **día** además del de por minuto (p. ej. 20 exports/día/usuario) es una mitigación razonable que no se toma aquí porque el módulo no tiene hoy contador diario; queda anotada por si el gate de seguridad la pide.
- **Supersedes:** ninguno. Complementa ADR-0001 (ver sección de impacto).

## Notas operativas por agente

- **backend-agent** — `flito-comparendos.routes.ts` (ruta + `exportLimiter` + esquemas, orden de operaciones de la decisión 6), `flito-comparendos.registros.service.ts` (variante de `listarRegistros` sin cursor con `limit = MAX + 1`; reutilizar el mismo armado de condiciones, no duplicarlo — **incluido el caso de la placa que al normalizar no deja nada, que no puede degradarse a «sin filtro»**), `flito-comparendos.errors.ts` (`ComparendosExportDemasiadoGrandeError`, 422, `codigo: 'export_demasiado_grande'`), `config/env.ts` (`COMPARENDOS_EXPORT_MAX_FILAS`, entero acotado, default 5 000), `packages/shared-types/src/flito-comparendos.ts` (constante y tipo del cuerpo del export; actualizar el comentario de `COMPARENDOS_REGISTROS_LIMIT_MAX` según la sección de impacto). **Sin migración**: no hay tabla nueva. Nada de `drizzle-kit generate`.
- **frontend-agent** — `fetch` + `blob` + `createObjectURL`/`revokeObjectURL`. Prohibido `<a download>` con querystring. Tratar el 422 como mensaje accionable («afina los filtros»), no como error genérico; el 429 con su propio mensaje.
- **qa-agent** — casos mínimos: filtro que devuelve exactamente el tope (200), tope + 1 (422 **sin** cabecera de adjunto), `?nit=` en la query (400), sexta petición del minuto (429), y verificación de que cada 200 deja **una** fila en `pii_access_log` con `accion='export'`, el `filas` correcto y el NIT enmascarado en el `motivo`. Añadir la medición de memoria/duración de la sección de coste.
- **security-agent** — gate obligatorio pre-PR: ruta nueva sobre datos personales. Puntos de revisión: ausencia de `payload_*` en la proyección del `.xlsx`, `no-store`, orden registro-de-acceso → cabeceras, y si procede pronunciarse sobre el tope diario que queda sin resolver.
