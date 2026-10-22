# ADR-0018 — Comprobantes universales: una puerta para cualquier documento, tabla propia `flito_comprobantes` colgada de `flito_soportes`, extracción en tres etapas, escritura por concepto reutilizando a los dueños de cada valor, y valor documental sobre tarifa en los honorarios de FLIT

## Estado

**Propuesto** — 2026-09-16. Autor: architecture-agent. Épica [#12245](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12245) «módulo universal de comprobantes» (FLIT - FLITO); Features F1 [#12605](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12605) «Cargar y leer comprobantes», F2 [#12606](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12606) «Asociar y aplicar comprobantes», F3 [#12607](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12607) «Valor documental en el reporte de costos y la liquidación». Pendiente de aprobación del Líder Técnico (David Chica).

Diseño detallado: [`docs/diseno-epica-12245-comprobantes-universales.md`](../diseno-epica-12245-comprobantes-universales.md).

Decisiones de producto que este ADR NO discute (David Chica, 2026-09-16): D1 (SOAT/impuesto/derecho escriben en la columna existente, una verdad por concepto), D2 (en trámite digital y logística el valor documental manda sobre la tarifa, tolerancia 0, diferencia señalada y aceptable con motivo, no bloquea sellar; **en servicios adicionales el comprobante SOLO marca la diferencia y el catálogo sigue mandando** — cierre de David del 2026-09-16), D3 (`es_pago`: la documentación no-pago se adjunta sin escribir valor), D4 (llaves: placa, VIN, ID FLIT), D5 (auto-aplicar bajo la variable de entorno `COMPROBANTES_AUTO_APLICAR`, encendida por defecto, si cruza con un único trámite y tipo/concepto/valor son confiables; nace en F2, no es parametrización por compañía), D6 (ya pagado → 409 y ofrecer adjuntar como documentación), D7 (150 archivos = tandas de 5 desde el navegador), D8 (sin filtrar candidatos por autogestión ni por gestor), D9 (un archivo consolidado puede contener N documentos → N comprobantes con `paginas`), D11 (un comprobante = un trámite), y la regla de autogestión del mismo día: **si el cliente autogestiona el concepto, el reporte sigue en blanco aunque exista comprobante aplicado** (el comprobante queda como soporte del trámite). También cerrados: `POST /tramites/buscar` por body (regla 6) y la columna 33 «Origen valores» del Excel **fuera** hasta VoBo del PO. El reparto de roles (admin + financiera de partida) tampoco es de arquitectura.

## Contexto medido (worktree `agent-af9d13dad10006571`, develop `0fe5df5d`)

- **Hoy hay tres puertas de carga y tres extractores**, cada uno con su cruce, su dedup por hash y su escritura: `flito-soat.service.ts` (`cargarFacturasMasivo` → `persistirCarga` → `pagarEnTx`, que exige un `flito_soportes` con `tipo = 'factura_soat'` colgado del SOAT, l. 1811), `flito-impuestos/flito-recibos.service.ts` (`cargarRecibos` → `procesarRecibo` → `conciliar`, con `hashReciboYaCargado` filtrando por `TIPOS_RECIBO`) y `flito-derechos/flito-derechos.service.ts` (`cargarDerechos` → `documentosDe` parte el consolidado **página a página** con `shared/pdf/separar-paginas.ts` → `registrar`). Lo dudoso cae en `flito_revisiones`, cuyo `resolver()` ramifica por `modulo` y delega en `marcarPagado` (SOAT, exportada), en `registrarDesdeRevision` (derecho, exportada, l. 783) y en un `resolverImpuesto` privado que **no registra `flito_estado_historial` ni evalúa la diferencia de valor** (eso lo hace `conciliar()` en recibos, que es privada).
- `flito_soportes` (`schema.ts:3302-3371`) tiene **cinco FK nullable** (`soat_id`, `impuesto_id`, `derecho_id`, `siigo_factura_id`, `conciliacion_boleta_id`), un `tipo varchar(40)` **sin CHECK en la base** (0096 lo creó sin él; el único CHECK es el excluyente de la 0139/0157), índices parciales por FK+tipo, y **ningún `tramite_id`**: el trámite se alcanza por sus hijos. `tipo` es una sola columna: un soporte es de UN tipo.
- **`schema.ts` está a 3358 líneas efectivas contra un techo congelado de 3400** (`eslint.config`, `FROZEN_CEILINGS`). Una tabla de ~35 columnas con CHECKs e índices no cabe. El precedente para esto ya existe: `apps/api/src/db/schema/permisos.ts`, declarado aparte y re-exportado desde `schema.ts` (Feature #12072).
- El OCR (`flito-ocr.service.ts`) tiene una única función privada `extraer(doc, prompt, campos, escalación, normalizadores)`: Haiku → Sonnet si algún campo de escalación no salió `alta`, fusión por mayor confianza, normalizador por campo, y `OcrNoDisponibleError(503)` cuando `anthropicMessages` no devuelve 200 (**un 429 de Anthropic llega como 503**: no hay señal distinta de rate limit). Los cinco extractores públicos son esa función con otro prompt. La partición «por grupos de páginas» **no existe**: `tramites/ocr-docs.routes.ts` `PAGE_INSTRUCTION` pide «las páginas del tipo solicitado», no «agrupa todos los documentos»; y `separarPaginas` asume un documento por página (tope 150 páginas).
- La liquidación (`flito-liquidacion.service.ts`) sella seis conceptos como columna + `detalle` jsonb; `calcularDeFila` toma trámite digital y logística de `tarifaDe()` y los servicios de la puente con snapshot. El reporte (`finanzas.service.ts`) resuelve cada concepto con `CASE WHEN liq.id IS NOT NULL THEN columna ELSE estimado END` (`EXPR_DIGITAL` l. 211, `EXPR_LOGISTICA` l. 214, `EXPR_SERVICIOS_ADICIONALES` l. 235) y sus faltantes con `BLOQUEA_*` (l. 290-296); las columnas 1:n van por **subconsulta correlacionada**, nunca por join (`SELECT_CONCILIACION_SOAT`, `EXPR_SERVICIOS_ADICIONALES`). El armado de Siigo valida `Σ items == valor_servicios_adicionales` (`servicios_no_cuadran`, ADR-0017).
- La carga masiva del navegador ya va en tandas de 5 con 115 s por tanda (`apps/web/src/lib/carga-masiva.ts` `enviarCargaEnTandas`, `TIMEOUT_TANDA_CARGA_MS`; topes en `shared-types/carga-masiva.ts`, picker 150). La concurrencia del OCR por lote es 5 (`shared/utils/con-concurrencia.ts`).
- Permisos: un módulo nuevo nace reconducido (`exigirFuncion` por ruta, ADR-0014/0016, precedente `finanzas-servicios-adicionales`). Una página nueva **solo existe por migración de siembra** (`pagina.<slug>`, 0184/0192). Contadores del cierre hoy: 21 directorios, 24 ficheros, 248 montajes.
- Última migración: `0197_permiso_recibo_caja.sql` (recomprobado).

## Decisión

### 1. Tabla propia `flito_comprobantes`, un renglón por documento, `soporte_id NOT NULL → flito_soportes`; sin sexta FK ni `tramite_id` en `flito_soportes`

El comprobante es el **hecho documental leído** (qué tipo, si es pago, de qué concepto, de qué trámite, cuánto, cuándo, con qué confianza y quién lo decidió). El soporte sigue siendo **el archivo**. Una FK `comprobante_id` en `flito_soportes` haría del archivo el dueño del hecho, obligaría a ensanchar el CHECK excluyente por tercera vez y no resolvería el consolidado (N hechos, un archivo). `tramite_id` en `flito_soportes` la convertiría en la sexta forma de colgar un documento, contra el patrón vigente desde 0096 («el trámite se alcanza por sus hijos»).

Cola de pendientes = **la propia tabla** (`estado = 'pendiente'`), no `flito_revisiones`: aquella resuelve *un registro ya identificado*, esta resuelve *a qué trámite y concepto pertenece un documento que puede ser cualquier cosa*. Meterla ahí obligaría a un `modulo` nuevo, una rama más en `resolver()` y a que la pantalla de revisión aprendiera a preguntar «¿de qué concepto es?».

La definición Drizzle vive en **`apps/api/src/db/schema/flito-comprobantes.ts`** y `schema.ts` la re-exporta (precedente `schema/permisos.ts`): el techo de 3400 no deja sitio, y el ratchet solo puede bajar. CHECKs declarados en Drizzle Y en SQL (lección 0157).

### 2. El archivo consolidado entra como UN soporte; al aplicar un sub-documento se materializa un soporte hijo con el `tipo` del destino

D9 dice «N comprobantes compartiendo un solo `flito_soportes`», y así entra: un `flito_soportes` con `tipo = 'consolidado_comprobantes'` (evidencia, sin FK) y N filas de `flito_comprobantes` con `paginas`. Pero **al aplicar** un comprobante a SOAT/impuesto/derecho el destino exige un soporte propio con SU `tipo` (`pagarEnTx` cuenta `tipo = 'factura_soat'`; `hashReciboYaCargado` cruza por `TIPOS_RECIBO`; el ZIP y las pantallas de soportes listan por FK+tipo), y `tipo` es una sola columna: un consolidado con una factura de SOAT en la p. 1 y un recibo de impuesto en la p. 3 no puede ser a la vez `factura_soat` e `recibo_impuesto`. Por eso:

- Archivo de **un solo documento** (`paginas IS NULL`, el 95 % de los casos): el soporte se reescribe en sitio al aplicar (`tipo` del destino + FK), y `soporte_aplicado_id = soporte_id`.
- Archivo **consolidado** (`paginas IS NOT NULL`): al aplicar se recortan las páginas (`recortarPaginas`, pdf-lib), se suben como archivo propio y se inserta un `flito_soportes` hijo con el `tipo` y la FK del destino; `flito_comprobantes.soporte_aplicado_id` lo referencia. El consolidado original queda como evidencia. Es el precedente de derechos (cada página recortada es su propio soporte), aplicado **solo a lo que se aplica**: no se crean 150 soportes para páginas que acabarán descartadas.

### 3. Extracción en tres etapas sobre el mismo `extraer()`; la partición es una pasada aparte con caída a página-por-documento

(a) **Partición**: PDF de 2..100 páginas → una pasada Haiku con `PROMPT_PARTICION_CONSOLIDADO` (nuevo en `flito-ocr.prompts.ts`) que devuelve `documentos: [{ paginas: number[], tipoProbable }]`; recorte con `recortarPaginas()` (nueva en `shared/pdf/separar-paginas.ts`, calco de `extractPages` de `ocr-docs.routes.ts`). Si la pasada falla, no parsea, trae solapes o páginas fuera de rango, o el PDF pasa de 100 (tope de Anthropic por petición), **cae a `separarPaginas`** (una página = un documento), que es el patrón que derechos usa hoy. Las páginas que ningún grupo cubre (portada, resumen) **no** hacen caer la partición: se anotan como `paginasNoLeidas` en el resultado (`ResultadoParticion { documentos, paginasNoLeidas, metodo }`, HU #12610 AC4). Imágenes y PDF de una página no se particionan.
(b) **Universal**: `extraerComprobanteUniversal()` en `flito-ocr.service.ts` con `PROMPT_COMPROBANTE_UNIVERSAL` (tipoDocumento, esComprobantePago, concepto, placa, vin, idFlit, valorTotal, fechaPago, numeroDocumento, emisor; **sin titular ni ningún dato de persona**), sobre la `extraer` privada (Haiku → Sonnet), con normalizadores que restringen `tipoDocumento` y `concepto` a sus catálogos (`null` antes que adivinar).
(c) **Especializada**: si `tipoDocumento` es confiable y ∈ {factura_soat, recibo_impuesto, recibo_caja_impuesto, recibo_derecho}, se llama al extractor existente (`extraerFacturaSoat` / `extraerReciboImpuesto` / `extraerReciboCaja` / `extraerDerechoTramite`) y se fusiona por mayor confianza campo a campo; esa extracción es la que se persiste en el destino (`flito_soat.extraccion`, `flito_impuestos.extraccion`, `flito_derechos_tramite.extraccion`) con su forma de siempre.

Umbral por defecto al extraer; re-marca de `confiable` con `umbralPara()` cuando se conoce el trámite (patrón `remarcarConfiable` de recibos). Concurrencia 5 sobre sub-documentos. **El documento se persiste aunque el OCR falle** (`estado = 'pendiente'`, `motivo_pendiente = 'ocr_no_disponible'`).

### 4. Escribir el valor lo hace el dueño del concepto; el módulo nuevo solo decide y ata

- **SOAT**: atar el soporte (`soat_id`, `tipo = 'factura_soat'`) y `marcarPagado(soatId, extraccion, ctx)` — ya exportada, ya hace historial, auditoría y RN-03. Es el cuerpo de `resolverSoat`, que pasa a ser `aplicarFacturaSoat` exportada y `resolverSoat` la llama.
- **Impuesto**: **`conciliar()` de `flito-recibos.service.ts`**, exportada junto a un `candidatoPorImpuestoId()`; NO el cuerpo de `resolverImpuesto` (que no escribe `flito_estado_historial` ni evalúa la diferencia D-5: es una deuda de revisiones, no un patrón a copiar). Se recomienda que `resolverImpuesto` también pase a llamarla (corrige lo existente, no agrega).
- **Derecho**: `registrarDesdeRevision(tramiteId, extraccion, soporteId, ctx)`. El 400 de «ya tiene derecho» se intercepta antes: el módulo responde 409 `YA_PAGADO` (D6).
- **Trámite digital / logística / servicios adicionales**: el comprobante ES el valor documental (no hay columna de destino sin sellar): `estado = 'aplicado'`, `es_pago = true`, `valor`, `tarifa_referencia` (de `tarifaDe()` o `SUM` de la puente), `diferencia_tarifa`, `marcado_por_diferencia`. **Índice único parcial** `(tramite_id, concepto) WHERE estado = 'aplicado' AND es_pago AND concepto IN (…)`: una sola verdad documental por concepto y trámite. Se aplica también sobre un concepto que la compañía **autogestiona** (D8): el valor documental queda escrito; es el reporte quien no lo cobra (§5). En servicios adicionales el valor documental **no manda** (§5): la fila solo lleva la diferencia con la Σ del catálogo, y el índice se conserva igualmente para SA por consistencia y porque la subconsulta escalar de la diferencia (`diferencia_sa`) necesita ≤ 1 fila. Guarda «trámite no liquidado» dentro de la transacción tras `FOR UPDATE` sobre `flito_tramites` (`bloquearTramite` de `finanzas-servicios-adicionales.service.ts`, ADR-0017 §2); sellado → 409 `TRAMITE_LIQUIDADO`.
- **`es_pago = false`** → `adjuntarDocumentacion`: se ata al destino con `tipo = 'documento_tramite'` (SOAT/impuesto/derecho) o queda solo en `flito_comprobantes` (honorarios); no escribe valor ni estado.

### 5. En el reporte y la liquidación, el documental gana con `COALESCE(documental, tarifa)` por subconsulta correlacionada — solo en trámite digital y logística, y solo si FLITO gestiona el concepto

`finanzas.valores-documentales.ts` (hermano de `finanzas.conciliacion-soat.ts`) expone `EXPR_DOC_TD`, `EXPR_DOC_LG` como `(SELECT c.valor FROM flito_comprobantes c WHERE c.tramite_id = t.id AND c.concepto = '…' AND c.estado = 'aplicado' AND c.es_pago)`; `EXPR_DIGITAL` pasa a `ELSE COALESCE(EXPR_DOC_TD, td.valor)`, `BLOQUEA_DIGITAL` a `COALESCE(EXPR_DOC_TD, td.valor) IS NULL`. `calcularDeFila` lee el documental antes de `tarifaDe()` y lo deja en `detalle.<concepto>.origen = 'Valor documental (comprobante <id>)'`. Sin join en `conJoins` (compartido por 7 llamadores) y sin parámetros repetidos (Bug #12058).

**Autogestión (regla de David, 2026-09-16)**: el `COALESCE` de logística va **dentro** de la rama `GESTIONA_LOGISTICA`: `EXPR_LOGISTICA = CASE WHEN seLiquido THEN columna WHEN NOT GESTIONA_LOGISTICA THEN NULL ELSE COALESCE(EXPR_DOC_LG, lg.valor) END` y `BLOQUEA_LOGISTICA = (GESTIONA_LOGISTICA AND COALESCE(EXPR_DOC_LG, lg.valor) IS NULL)`. Una compañía que autogestiona la logística ve la celda en blanco aunque tenga comprobante aplicado; la excepción por trámite (`flito_excepciones_autogestion`) sigue ganando como hoy. Por simetría, `calcularDeFila` solo consulta el documental de logística cuando `gestionaLogistica`. Trámite digital no tiene autogestión (siempre lo cobra FLITO), así que ahí no hay rama.

**Servicios adicionales**: `EXPR_SERVICIOS_ADICIONALES`, `conceptoServicios`, el sellado y el armado de Siigo **no cambian** (la Σ del catálogo sigue mandando; sin línea «Ajuste por comprobante»). Lo que F3 añade es la lectura de la diferencia (`diferencia_sa`, `diferencia_aceptada_sa`) por la misma subconsulta, para el chip de pantalla y el JSON del reporte. **Corte entre Features**: F2 escribe la fila documental de honorarios; F3 es quien la lee en el reporte y la liquidación.

### 6. Módulo `flito-comprobantes` reconducido, montado en `/api/flito/comprobantes`, con página `pagina.flito_comprobantes` en el grupo Finanzas

Nueve operaciones bajo `modulo = 'comprobantes'` (cinco en la 0198 de F1 #12605: cargar, ver cola, ver, descargar archivo, **releer**; tres en la 0199 de F2 #12606: buscar trámites, aplicar, descartar; una en la 0200 de F3 #12607: aceptar diferencia). La búsqueda de trámites es `POST /tramites/buscar { buscar }` por body (regla 6 del repo; sin GET). El `lote_id` lo genera el navegador (uuid) y viaja en cada tanda de 5 (`enviarCargaEnTandas` con `campos: { loteId }`), así el resumen del lote es una consulta y no un estado en memoria. Sin cola servidor como primera opción (D7); `procesarLoteAsync` (202 + polling) queda como plan B medido. **F1 no cruza ni aplica** (carga, lee, muestra las llaves leídas, deja en cola y permite releer lo que quedó `ocr_no_disponible`); el cruce por llave y la aplicación —manual y automática bajo `COMPROBANTES_AUTO_APLICAR`, encendida por defecto— nacen en F2; el reporte y la liquidación leen el documental en F3.

## Alternativas consideradas

| Alternativa | Por qué no |
|---|---|
| **Sexta FK `comprobante_id` en `flito_soportes`** | Invierte la dirección (el archivo dueño del hecho); obliga a ensanchar por tercera vez el CHECK excluyente (0139/0157); no resuelve N documentos en un archivo; y `EXPR_DOC_COMPLETA`, el ZIP y los índices parciales seguirían sin saber de trámites. |
| **Tabla aparte `flito_valores_documentales (tramite_id, concepto, valor)`** además de la de comprobantes | Dos verdades (el comprobante que dice el valor y la fila que lo repite) que descuadran en cuanto alguien descarta o reaplica; el índice único parcial sobre `flito_comprobantes` da la misma garantía «un valor vivo por concepto» sin segunda tabla. |
| **Un solo prompt gigante** con todos los campos de todos los tipos (SOAT + impuesto + derecho + universal) | 25+ campos en cada llamada → escalación a Sonnet casi siempre (como pasó con la factura de venta, HU #12092), `max_tokens` insuficiente, y tres prompts ya afinados con sus «errores caros» (VALOR ASEGURADO, TOTAL A CARGO, resumen consolidado) que habría que reescribir sin poder medir regresión. La etapa (c) reutiliza esos prompts tal cual. |
| **`flito_revisiones` como cola de pendientes** | Resuelve un registro identificado; aquí lo desconocido es el trámite Y el concepto. Exigiría `modulo` nuevo, rama en `resolver()`, cambios en `FlitoRevisiones.tsx` y `camposEsperados`; y el documental de honorarios no tiene «registro» al que resolver. |
| **Job asíncrono 202 + polling** (`tramites/lote.ts` `procesarLoteAsync`) como primera opción | Patrón existente pero para filas de Excel, no para archivos de 15 MB: habría que persistir los archivos antes de leerlos, añadir tabla de lote y worker in-process, y la pantalla de tandas ya existe y funciona a 5 por 115 s. **Plan B** si QA mide > 115 s por tanda con consolidados (umbral en el diseño). |
| **Un `flito_soportes` por sub-documento al ingresar** | 150 páginas → 150 subidas a S3 y 150 filas antes de saber cuáles son documentos; el hash del recorte no coincide con el del original (pdf-lib reserializa) así que no aporta dedup. El hijo se crea **al aplicar** (§2), que es cuando hace falta un `tipo`. |
| **Línea «Ajuste por comprobante»** en el sello de servicios adicionales para que el documental mande | Inventa una línea en la factura del cliente y toca `lineasDeServicios`; David cerró que en SA el catálogo manda y el comprobante solo marca la diferencia. |
| **Cobrar el documental aunque la compañía autogestione el concepto** | Rompe la frontera de autogestión que aplican las colas, la liquidación y el reporte (`GESTIONA_*`); el comprobante es soporte del trámite, no un cobro. |
| **Resucitar `flito_derechos_pendientes`** como bandeja | Está declarada «SIN LECTOR» y retirada por decisión de negocio (acumulaba comprobantes que no cruzaban); su forma es de derecho (`numero_radicado`, `tipo_tramite_recibo`), no universal; su `resuelto_tramite_id` no sabe de concepto. |
| **Reescribir `tipo` del soporte compartido al aplicar** (D9 literal) | Un consolidado con documentos de conceptos distintos no puede ser de un solo `tipo`; `pagarEnTx` y `TIPOS_RECIBO` dejarían de encontrar «su» documento. |
| **`GET /tramites?buscar=`** (diseño de partida) | Llave de vehículo/trámite en la URL y en los logs de acceso; la regla 6 del repo pide body por defecto. `POST /tramites/buscar { buscar }` sin variante GET (cerrado). |
| **`buscarTramitesPorLlave` en `flito-tramites.service.ts`** (diseño de partida) | El `or(...)` de l. 529-539 es privado dentro de `construirCondiciones`; el cruce necesita joins a `flito_soat`, `flito_impuestos`, `flito_derechos_tramite` y `flito_liquidaciones` que son dominio del módulo nuevo. Va en `flito-comprobantes.cruce.ts` con la misma normalización (`UPPER(REPLACE(plate,'-',''))`). |
| **Exportar el cuerpo de `resolverImpuesto`** como `aplicarReciboImpuesto` (diseño de partida) | No registra `flito_estado_historial` ni evalúa diferencia; copiarlo propaga la deuda. `conciliar()` es el escritor canónico. |

## Consecuencias

- **Corrección al diseño de partida, declarada**: (1) el modelo Drizzle va en `db/schema/flito-comprobantes.ts`, no en `schema.ts`; (2) D9 se cumple al ingresar, y al aplicar un sub-documento nace un soporte hijo (`soporte_aplicado_id`); (3) el escritor de impuestos es `conciliar()` de recibos, no `resolverImpuesto`; (4) la partición es un prompt nuevo con caída a página-por-documento; (5) el cruce vive en el módulo nuevo.
- **Servicios adicionales (cerrado)**: el comprobante solo marca la diferencia; `Σ items == columna` (ADR-0017) y `servicios_no_cuadran` quedan intactos; no hay línea «Ajuste por comprobante». El índice único parcial se conserva también para SA (consistencia y subconsulta escalar de la diferencia).
- **Excel (cerrado)**: la columna 33 «Origen valores» queda **fuera** de F3 #12607 hasta VoBo del PO; en F3 el origen y la diferencia viajan en el JSON del reporte y en pantalla. El libro sigue con sus 32 cabeceras literales (HU #12536).
- **Autogestión (cerrado)**: aplicar un comprobante de pago a un concepto autogestionado se permite (D8) y deja el valor documental; el reporte y la liquidación no lo cobran mientras el concepto sea autogestionado y no haya excepción por trámite. El comprobante es soporte del trámite. Consecuencia práctica: una fila con `logistica_autogestionable = true` y comprobante de logística aplicado muestra la celda en blanco y `origenes.logistica = null`.
- **Auto-aplicación (cerrado)**: `COMPROBANTES_AUTO_APLICAR` en `config/env.ts`, por defecto `'1'`; F1 no la lee (no cruza ni aplica); F2 #12606 la introduce junto con el cruce y `aplicar`. Apagarla deja todo en `pendiente` con el cruce sugerido.
- **Doble verdad asumida y acotada**: `flito_comprobantes.valor` es COPIA para SOAT/impuesto/derecho; el reporte y la liquidación NO lo leen (leen `valor_pagado` / `flito_derechos_tramite.valor`). Solo es verdad para los tres honorarios.
- `flito_soportes` recibe tres literales nuevos de `tipo` (`consolidado_comprobantes`, `comprobante_pago`, `documento_tramite`) **sin migración** (sin CHECK). No entran en `TipoSoporteZip`.
- `POST /tramites/buscar` por body (cerrado): sin variante GET; la búsqueda de candidatos no entra en la URL ni en los logs de acceso.
- **SOAT del canal Cliente** (sin trámite, memoria «Canal Cliente y trámite no se enlazan») queda fuera de esta puerta por D11; la carga masiva de SOAT sigue siendo su vía.
- Contadores de los tests de permisos: 22 directorios, 25 ficheros, 248 + 9 montajes (253 tras F1, 256 tras F2, 257 tras F3). Página nueva ⇒ migración de siembra (0198) o el API no arranca (`verificarCatalogoAlArrancar`).
- `flito-revisiones.service.ts` cambia dos cuerpos privados por llamadas a funciones exportadas; los tests de revisiones que mockean `marcarPagado` siguen valiendo.
- El plan B asíncrono (202 + polling) no es HU de ningún Feature: queda como mitigación condicionada a la medición de QA. El dedup por número de documento queda en «Fuera de alcance / deuda declarada» del diseño.
- Riesgos que quedan escritos en el diseño: tiempo por tanda con consolidados (115 s), rate limit de Anthropic (150 archivos ≈ 300-750 llamadas, hasta ~1000 con consolidados; 503 → `pendiente`), trámite sellado (409), Habeas Data en `extraccion` (nunca en listados; el prompt no pide titular), `EXPR_DOC_COMPLETA` cuenta un `documento_tramite` atado a un SOAT como «documentado» (no filtra por tipo hoy tampoco).

## Cómo verificar que quedó como dice este ADR

```bash
# 1. Tabla aparte y re-exportada; CHECKs en Drizzle y en SQL
grep -n "flitoComprobantes" apps/api/src/db/schema.ts apps/api/src/db/schema/flito-comprobantes.ts
grep -n "CHECK\|CREATE UNIQUE INDEX" apps/api/src/db/migrations/0198_*.sql
# 2. Sin FK nueva ni tramite_id en flito_soportes
grep -n "comprobante_id\|tramite_id" apps/api/src/db/migrations/0198_*.sql | grep -i "flito_soportes"   # vacío
# 3. Los dueños escriben: conciliar exportada, resolverSoat delega
grep -n "^export async function conciliar\|^export async function candidatoPorImpuestoId" apps/api/src/modules/flito-impuestos/flito-recibos.service.ts
grep -n "^export async function aplicarFacturaSoat" apps/api/src/modules/flito-revisiones/flito-revisiones.service.ts
# 4. Reporte: COALESCE por subconsulta, sin join nuevo en conJoins
grep -n "EXPR_DOC_TD\|EXPR_DOC_LG" apps/api/src/modules/finanzas/finanzas.service.ts
grep -c "leftJoin" apps/api/src/modules/finanzas/finanzas.service.ts   # igual que antes
# 5. Autogestión: el COALESCE de logística vive DENTRO de la rama GESTIONA_LOGISTICA
grep -n "WHEN NOT \${GESTIONA_LOGISTICA} THEN NULL" apps/api/src/modules/finanzas/finanzas.service.ts   # sigue antes del ELSE COALESCE
#    Test de SQL renderizado (finanzas.reporte.test.ts): fila con clients.logistica_autogestionable = true, sin
#    flito_excepciones_autogestion vigente y con un flito_comprobantes aplicado de concepto 'logistica' → la
#    celda `logistica` es NULL y `origenes.logistica` es null; con la excepción vigente → el valor documental.
# 6. Servicios adicionales no cambian: ni la expresión, ni el sellado, ni Siigo
grep -n "EXPR_DOC_SA" apps/api/src/modules/finanzas/finanzas.service.ts   # vacío: SA solo lee la diferencia
grep -rn "Ajuste por comprobante" apps/api/src/modules/siigo apps/api/src/modules/flito-liquidacion   # vacío
# 7. Flag de auto-aplicación: env, encendida por defecto, nace en F2
grep -n "COMPROBANTES_AUTO_APLICAR" apps/api/src/config/env.ts apps/api/src/modules/flito-comprobantes/*.ts
# 8. Búsqueda por body
grep -n "post('/tramites/buscar'" apps/api/src/modules/flito-comprobantes/flito-comprobantes.routes.ts
grep -n "get('/tramites'" apps/api/src/modules/flito-comprobantes/flito-comprobantes.routes.ts   # vacío
# 9. Módulo reconducido (22 directorios / 25 ficheros / 257 montajes al cierre de F3)
grep -n "flito-comprobantes" apps/api/src/modules/permisos/inventario-guardas.ts apps/api/__tests__/services/permisos.reconduccion-cierre.test.ts
npx vitest run apps/api/__tests__/services/permisos*.test.ts
```

## Relación con otros ADR

- ADR-0005 (FK a `users`): las cuatro parejas «quién + cuándo» (`subido_por`, `aplicado_por`, `descartado_por`, `diferencia_aceptada_por`) van `RESTRICT`.
- ADR-0014 / ADR-0016 §2: el módulo `flito-comprobantes` nace **reconducido** (`exigirFuncion` por ruta, ninguna guarda a nivel de router, ningún `requireRole`); entra en `DIRECTORIOS_RECONDUCIDOS` y `FICHEROS_EN_ALCANCE`, y los contadores del cierre pasan de 21/24/248 a **22 directorios / 25 ficheros / 257 montajes** (5 en F1 #12605 + 3 en F2 #12606 + 1 en F3 #12607).
- ADR-0017: guarda «no sellado» con `FOR UPDATE` sobre `flito_tramites`; su invariante `Σ items == columna` de servicios adicionales queda intacto porque en SA el comprobante solo marca la diferencia.
- ADR-0008 §1.2 / ADR-0012: `extraccion` no sale en listados; el prompt universal no pide datos de persona.
- ADR-DB-001: migraciones sin `BEGIN/COMMIT`, idempotentes.

## Addendum — Bug #12913 (2026-09-24): el comprobante de servicios adicionales SÍ suma, vía la puente

**Estado: Propuesto** (pendiente del Líder Técnico). Revierte, solo para servicios adicionales (SA), la frase de D2 «el comprobante SOLO marca la diferencia y el catálogo sigue mandando» y el párrafo «Servicios adicionales» de §5. Decisión de producto de David (2026-09-24), no se rediscute aquí. Bug [#12913](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12913), Feature #12607. Habla con `flito-comprobantes` y `finanzas-servicios-adicionales` (FLITO, no legacy).

**Idea:** el valor del comprobante de pago SA **entra a la puente** `flito_tramite_servicios_adicionales` (su dueño, §4). Reporte (`EXPR_SERVICIOS_ADICIONALES`), liquidación (`conceptoServicios`) y Siigo **no cambian**: siguen leyendo Σ puente; sin línea «ajuste». El invariante de ADR-0017 `Σ items == columna` se mantiene porque el valor viaja como item.

**a. Contrato.** `aplicarSchema` gana `servicioTipoId: z.string().uuid().optional()` con refine doble: `esPago && concepto === 'servicios_adicionales'` ⇒ obligatorio (`path: ['servicioTipoId']`); en cualquier otro caso ⇒ prohibido (400, nunca se ignora en silencio). `AplicarComprobanteBody.servicioTipoId?: string` en `packages/shared-types/src/flito-comprobantes.ts`. Tipo inexistente o inactivo → 400 `datos_invalidos` («El servicio elegido ya no está disponible»), comprobado antes de S3 y otra vez en la tx.

**b. Enlace.** Una sola columna: `flito_comprobantes.servicio_tipo_id uuid NULL → flito_servicios_adicionales_tipos(id) ON DELETE RESTRICT`, con CHECK `servicio_tipo_id IS NULL OR (concepto = 'servicios_adicionales' AND es_pago)`. La necesitan el índice único (c), la tarifa por tipo (d) y la guarda de quitar (e). **Sin** `comprobante_id` en la puente: «esta asignación vino de un comprobante» se deriva por `(tramite_id, tipo_id)` contra el comprobante aplicado, sin FK cruzada y sin tocar `schema.ts` (techo 3400, hoy 3380).

**Escritura** (dentro de la tx de `aplicar`, tras `bloquearComprobantePendiente` → `bloquearTramite` → `exigirNoLiquidado`): `fijarDesdeComprobante(tx, tramiteId, tipo, valor, actorId)` exportada por `finanzas-servicios-adicionales.service.ts` = `INSERT … ON CONFLICT (tramite_id, tipo_id) DO UPDATE SET valor = EXCLUDED.valor` (el snapshot nombre/descripción solo se escribe al insertar; `asignado_por` no se reescribe: quien aplicó queda en `aplicado_por_id`). Luego `cerrarComoPago` con `servicio_tipo_id`.

**c. Índice único.** Migración: `DROP INDEX IF EXISTS idx_flito_comprobantes_valor_documental`; `CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_comprobantes_valor_documental_td_lg ON (tramite_id, concepto) WHERE estado='aplicado' AND es_pago AND concepto IN ('tramite_digital','logistica')`; `CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_comprobantes_valor_documental_sa ON (tramite_id, servicio_tipo_id) WHERE estado='aplicado' AND es_pago AND concepto='servicios_adicionales' AND servicio_tipo_id IS NOT NULL`. `esDuplicadoDocumental` reconoce los dos nombres; `traducirDuplicado` en SA busca el anterior por `(tramite, 'servicios_adicionales', servicio_tipo_id)`. Los SA ya aplicados sin tipo (fuera de alcance) quedan como están.

**Lectores con N filas SA** (hoy `documental(...) … limit 1`). En `flito-comprobantes.expr.ts`, dos fábricas SA sin parámetros (Bug #12058):
- `sumaSa(col)` = `(select sum(col) … where filaDocumental(SA))` → `EXPR_DIF_SA`, `tarifaReferencia` y `valor` SA (este último sigue sin mandar dinero).
- `EXPR_MARCADO_SA` = `bool_or(marcado_por_diferencia)`; aceptada SA = `NOT coalesce(bool_or(marcado_por_diferencia AND diferencia_aceptada_en IS NULL), false)` (aceptada solo si TODAS las marcadas lo están).
- `representanteSa(col)` = la misma subconsulta con `order by (marcado_por_diferencia AND diferencia_aceptada_en IS NULL) desc, aplicado_en desc limit 1` → `ComprobanteId/Numero/Fecha/AceptadaPor*/Motivo`. El botón «Aceptar diferencia» apunta al primer pendiente; al aceptarlo pasa al siguiente. DTOs sin cambio de forma.
Usan esto: `finanzas.valores-documentales.ts` (rama `sa`), `PROYECCION_DOCUMENTAL` de `flito-liquidacion.service.ts:318-327`. `cruce.ts`: SA deja de mirar `documentado(SA)` → `admiteHonorario(liquidado, false)` (el duplicado por tipo lo decide el índice al aplicar). `aceptarDiferencia` no cambia (ya es por comprobante).

**d. Tarifa de referencia SA** = `flito_servicios_adicionales_tipos.valor` del tipo elegido (leído en la tx), ya no Σ puente. `tarifaReferenciaDe(tx, tramiteId, concepto, servicioTipoId?)`. Diferencia = valor − catálogo, informativa y aceptable con motivo.

**e. Quitar una asignación que vino de un comprobante** → **409** `asignacion_de_comprobante` («Este servicio viene de un comprobante de pago aplicado; no se puede quitar desde aquí»), comprobado en la tx de `quitar` antes del DELETE. Permitirlo reabriría el bug al revés (comprobante aplicado, costo ausente). **A confirmar con David:** hoy no hay «des-aplicar» comprobante, así que la asignación queda fija salvo re-aplicar otro comprobante del mismo tipo (corrige el valor).

**f. Migración** `0209_flito_comprobantes_servicio_tipo.sql`: `ADD COLUMN IF NOT EXISTS`, CHECK por `DO $$ … IF NOT EXISTS (pg_constraint) …`, los índices de (c). Sin `BEGIN/COMMIT` (ADR-DB-001), sin drizzle-kit. Drizzle: `servicioTipoId` + CHECK + dos `uniqueIndex` en `apps/api/src/db/schema/flito-comprobantes.ts`.

**g. Auto-aplicación.** `decidirAutoAplicar` devuelve `{ razon: 'requiere_tipo_servicio' }` para SA con pago: queda pendiente.

**h. Permisos.** Basta `comprobantes.comprobante.aplicar`; no se exige `finanzas.servicios_adicionales.asignar` (sería un AND oculto sobre un acto que ya es financiero y auditado en el comprobante). Sin ruta nueva (contadores de reconducción intactos). El panel lee el catálogo por `GET /flito/parametrizacion/servicios-adicionales`: verificar que su guarda admite a los roles con `aplicar`.

**Verificación.** `grep -n "limit 1" …/flito-comprobantes.expr.ts` no aparece en `sumaSa`; `grep -rn "Ajuste por comprobante" apps/api/src/modules` vacío; `EXPR_SERVICIOS_ADICIONALES` sin diff.
