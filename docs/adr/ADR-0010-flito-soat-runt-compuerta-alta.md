# ADR-0010 — El RUNT vuelve a ser compuerta del alta del canal Cliente (pero el organismo no)

## Estado

**Propuesto** — HU [#11966](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11966) (Feature [#11912](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11912)). **Pendiente de aprobación del Líder Técnico**: no lo aprueba ningún agente.

**Supersedes** [ADR-0009](./ADR-0009-flito-soat-runt-no-bloquea-alta.md) **completo, para solicitudes nuevas**. Las radicadas mientras el 0009 rigió no se reescriben ni se reconsultan.

**Restaura parcialmente** [ADR-0008](./ADR-0008-flito-soat-canal-cliente.md) (sigue **Propuesto**; no se reescribe):

- §6: la preconsulta como paso bloqueante, y el `409 soat_vigente` y el `503 runt_no_disponible` como aborto de `POST /cliente`.
- §1.6, en la parte de resolver los datos del RUNT **antes** del INSERT.

**NO restaura** de ADR-0008: **el organismo como compuerta**. Ver la decisión 5.

**Conserva** de ADR-0008: no persistir el payload crudo (§1.6, esa frase), el satélite 1:1 (§1.2), el propietario en `flito_compradores` (§1.3), RN-01 y el 404-no-403 del aislamiento (§5).

## Contexto

ADR-0008 diseñó el alta con el RUNT como compuerta. La HU #11935 (ADR-0009) invirtió la regla: crear es enviar, el RUNT informa **después** con un job post-commit, y Operaciones decide. Con esa regla entregada en DEV/QA, el PO revisó el resultado y **anuló la inversión**: una solicitud que el registro nacional no confirma no debe existir, porque el trabajo de validarla a mano cuesta más que negarla en el momento y porque el Cliente no se entera de que su vehículo no cuadra hasta que alguien lo llama.

**Esto no es un revert del 0009**, y por eso hace falta un ADR nuevo en vez de marcar aquel «Rechazado» y volver al 0008:

1. **ADR-0009 rigió código entregado.** Hay filas en DEV/QA con `verificacion_estado` poblado y con `organismo_codigo` NULL creadas bajo esa regla, y las cuatro columnas del satélite se quedan en el esquema. Borrar o reescribir el 0009 dejaría el modelo sin explicación de por qué existen.
2. **El organismo sigue sin ser compuerta.** ADR-0008 §1.6 sí lo exigía. Si el repo dijera «vuelve a regir el 0008», el siguiente que lo lea reintroduciría el `422 organismo_no_catalogado` que el AC5 de la #11966 prohíbe.
3. Siete archivos del repo citan ADR-0009 por nombre. El repo no puede quedar afirmando lo contrario que el Feature.

Hechos medidos en el worktree `flito-11966` antes de decidir:

- `consultarRunt` (`flito-soat-cliente.service.ts`) **ya traducía** cada «no» del RUNT a 503/422/409. La #11935 quitó la *llamada*, no la lógica: la compuerta estaba escrita.
- `consultarVehiculoRunt` (`runt/runt.service.ts`) devuelve `{ ok:false, message }` **tanto** cuando la pasarela contesta HTTP 200 con un rechazo de negocio **como** cuando hay timeout, red, no-200 o circuito abierto. El repo distinguía los dos casos con un predicado sobre el texto (`/propietari/i`, dos veces: `certificacion-runt.ts:181` y `soat/refresh.service.ts:76`).
- `verificarRuntPostAlta` / `programarVerificacionRunt` se programaban **solo** desde el alta, con `setImmediate`. No existe cron ni barrido que procese filas viejas (comprobado por `grep` sobre `verificacionEstado` en `apps/api/src`).
- El Excel de la cola dejaba nueve celdas vacías en cada fila del canal (`datos.get(f.id) ?? SIN_TRAMITE`), porque el canal no tiene trámite y por tanto no tiene `flit_raw`.

## Decisión

1. **Un `ok:false` de Kyverum se clasifica por TRANSPORTE primero y por mensaje después.** `runt.service.ts` anota `httpStatus` en el `{ ok:false }` (cambio aditivo: nadie más lo lee). `httpStatus === 200` significa «el RUNT respondió que no» → 422 de negocio. El predicado `/propietari/i` se conserva **debajo**, como red para la vía directa, que no pasa por la pasarela. **El defecto es «caído» → 503, que no crea nada.**

   Es la decisión cara del ADR y sienta precedente: sin ella, el AC4 («ese desenlace NO se usa cuando el RUNT sí respondió que los datos no coinciden») dependería de que Kyverum no corrija una redacción, y se rompería en silencio.

2. **Una sola compuerta para los dos endpoints.** `verificarRuntCompuerta()` la llaman `POST /cliente/preconsulta` y `POST /cliente`, y los dos devuelven exactamente lo mismo ante la misma respuesta de Kyverum. Dos copias divergen y el paso 1 del wizard acaba negando lo que el paso 2 acepta.

3. **VIN opcional en la entrada; VIN efectivo = el del RUNT.** Si el Cliente teclea VIN y difiere del registro, `422 runt_no_cuadra` con `campo: 'vin'` — y **nunca** el VIN bueno en el cuerpo, que convertiría el endpoint en un lector de VIN por placa. Si el RUNT no publica VIN, `422 runt_sin_vin` (código nuevo) y no se crea: `flito_soat.vin` es NOT NULL UNIQUE y es la columna sobre la que vive la RN-01.

4. **El propietario se guarda PARTIDO** (`nombres`/`apellidos` XOR `razon_social`, con CHECK en la base y en `schema.ts`) y `nombre_completo` pasa a ser un **derivado** para la búsqueda de la cola, no la fuente. Contacto y domicilio (`correo`, `celular`, `direccion`, `municipio`, `departamento`) son obligatorios **en la app** para este canal; las columnas siguen nullable porque las necesitan las ~7 052 filas del sync.

5. **El organismo NO es compuerta.** `organismo_codigo` sigue nullable, el `422 organismo_no_catalogado` desaparece de los dos endpoints, y el `leftJoin` de `conJoinsCola`/`detalle`/export se queda. Si el nombre del RUNT no cruza catálogo, la fila se crea con `NULL` y el satélite anota `organismo_no_catalogado`.

6. **El Excel del canal lee columnas PERSISTIDAS; el del trámite sigue leyendo `flit_raw`.** Un archivo, dos fuentes, y **la bifurcación es por `f.origen === ORIGEN_CLIENTE`**, nunca por ausencia de trámite: un SOAT de trámite huérfano (borrado, o con `soat_id` nulo) también cae en «sin datos» y con la variante perezosa cambiaría de fuente en nueve columnas **en verde**.

7. **El job post-commit se BORRA**, no se deja dormido. `verificarRuntPostAlta`, `programarVerificacionRunt`, `rellenarVehiculoDesdeRunt` y `DATOS_RUNT_VACIOS` desaparecen. Sin función no hay reconsulta posible por descuido, que es lo que hace **estructural** el «las filas ya radicadas no se reconsultan» del AC6.

8. **Cero UPDATE sobre las filas radicadas bajo ADR-0009.** La migración 0172 no lleva backfill, y es deliberado.

## Consecuencias

- `verificacion_estado = 'pendiente' | 'caido' | 'sin_registro' | 'no_cuadra'` queda como **residuo histórico**: solo lo llevan las filas del intervalo #11935–#11966. Una fila nueva nace en `ok` con `soat_vigente = false`. Los cuatro valores siguen en el CHECK y en `ESTADOS_VERIFICACION_SOLICITUD_SOAT` porque esas filas existen y hay que poder leerlas.
- Las filas de la #11935 con `organismo_codigo` NULL siguen ahí y Operaciones las trabaja a mano.
- Las filas de la #11935 pueden tener un VIN **tecleado** que el registro nunca confirmó (el job pudo no correr, o marcar `no_cuadra` sin bloquear). Su `Vin` en el Excel es ese. No es alcance de esta HU; es una decisión de producto ya tomada, y por eso el job se borra en vez de dejarse dormido: «arreglarlas de paso» es exactamente lo que el AC6 prohíbe.
- El alta pasa a consultar el RUNT **dentro de la petición**, así que `POST /cliente` gana el registro de acceso a datos personales que hasta ahora solo tenía la preconsulta (Ley 1581 art. 17).
- La columna `Departamento` del `.xlsx` deja de ser siempre jurisdicción del organismo: para una fila del canal es el **domicilio del titular**. Junto con `Municipio`, entra en `CAMPOS_PII_COLA_EXPORT`.
- Los CF-07/10 del Feature #11912 vuelven a estar alineados **sin reescribir el Feature**.
- **Riesgo residual, medido y aceptado:** si Kyverum señalara un rechazo de propietario con un no-200 **y** cambiara la redacción del mensaje, el desenlace sería un 503 en vez de un 422 — no crea filas falsas, pero le dice al usuario que el RUNT está caído cuando no lo está. La compuerta loguea `{ desenlace, httpStatus }` sin placa ni documento para poder medirlo en DEV.

## Relación con otros ADR

- **ADR-0008** — restauración parcial, arriba. No se reescribe.
- **ADR-0009** — **superseded por este**. Su cuerpo se conserva intacto: es la única explicación de por qué existen las cuatro columnas del satélite.
- **ADR-DB-001** — la `0172` no lleva `BEGIN/COMMIT` propio.
