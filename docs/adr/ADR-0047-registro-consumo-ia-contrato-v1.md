# ADR-0047 — Registro de consumo de APIs de IA (contrato `ia-consumo` v1)

- **Estado:** Propuesto — 2026-11-18. Plan aprobado por el humano (Frente B, FLITO); falta revisión del
  Líder Técnico en el PR.
- **Fecha:** 2026-11-18
- **Work item:** sin work item de ADO al abrir la rama (ver «Pendientes»).
- **Contrato:** [`docs/contratos/ia-consumo.v1.md`](../contratos/ia-consumo.v1.md), común a FLIT 2.0 y FLITO.
  FLIT 2.0 lo implementa en paralelo (Frente A). Cambiarlo es una v2, nunca a mano en un solo lado.
- **Módulo:** transversal (`apps/api/src/shared/ia-consumo/` + cron en `modules/ia-consumo/`). Habla con
  los `flito-*` y con los legacy: toda llamada a IA de cualquier módulo pasa por el cliente central.
- **Relación con ADR-0042** (Propuesto, auditoría portable del uso de IA): **no lo sustituye**. Este ADR
  implementa solo la parte «consumo y costo» con el contrato común a ambos aplicativos, que es más
  pequeño: tres tablas sin cifrado ni particiones, sin contenido salvo bandera. Si ADR-0042 se aprueba,
  su `cliente-ia` y su emisor deben construirse sobre este cliente y estas tablas (o declarar una v2 del
  contrato), no al lado. Su «valla» (un solo punto habla con `api.anthropic.com`) ya queda aquí.

## Contexto

Hoy nadie lee `usage` de las respuestas de Anthropic: no se sabe cuánto cuesta cada módulo, cada usuario
ni cada placa. Había 13 puntos de llamada (6 por el cliente central `modules/tramites/anthropic.ts`, 5 con
`https.request`/`httpsJson` directo sin reintento ni métrica, la salud de modelos y Dr. Flit con
`requestWithRetry` propio) y un respaldo local con Tesseract.

## Decisión

1. **Un solo cliente.** `modules/tramites/anthropic.ts` es el único archivo que nombra
   `api.anthropic.com` (test-valla en `ia-consumo.test.ts`). Expone tres formas para no cambiar el
   contrato de ningún llamador: `anthropicMessages` (la de siempre, ahora con `consumoId` y opciones de
   timeout/reintentos), `anthropicPeticion` (respuesta HTTP o `UpstreamError`: Dr. Flit, salud) y
   `anthropicMensajesCrudo` (el cuerpo de cualquier status, como el `https.request` de antes: vehículos,
   Drive, RUNT, captcha). Cada llamada migrada conserva su timeout y su número de intentos (uno).
2. **Una fila por intento HTTP.** `requestWithRetry` gana un gancho `onIntento` (no altera el flujo; si
   lanza, se ignora) y el cliente registra cada intento. Reintentos y Haiku → Sonnet comparten
   `correlacion_id`; la segunda pasada lleva `pasada = 2`. El captcha del RUNT conserva su bucle propio
   de 4 intentos y lo refleja en `intento` (`intentoInicial`).
3. **Contexto ambiental** con `AsyncLocalStorage` (`conContextoIa`), abierto por quien llama con su
   `proceso` del catálogo; `authMiddleware` pone usuario y tenant (`transitoCodigo`). Para que el usuario
   sobreviva a `multer` (que entrega `next()` desde un evento del parser), se atan los eventos del `req`
   al ámbito (`AsyncResource.bind`, como `bindEmitter` de cls-hooked).
4. **Escritor asíncrono at-most-once**: cola en memoria (10 000), lotes de 200 cada 5 s, vaciado al
   apagar con tope de 3 s; BD caída o cola llena ⇒ se descarta, `warn` y métrica
   `ia_consumo_descartados_total`. El costo se calcula al vaciar, con tarifas cacheadas 10 min.
5. **Correcciones posteriores**: `anotarConsumoIa(id, …)` marca `respuesta_invalida` cuando el 200 no era
   interpretable para quien llama, o la placa cuando se conoce después de leer el documento.

## Decisiones fuera del contrato (a revisar en FLIT 2.0 para que ambos lados coincidan)

- **Clasificación de `resultado`:** 400/413/415/422 ⇒ `rechazado`; 401/403/404/529 y demás no-2xx ⇒
  `error_proveedor`; 200 con `stop_reason` `max_tokens` o `refusal` ⇒ `respuesta_invalida` (salvo la salud
  de modelos, que pide `max_tokens: 1`).
- **Sin `origen` en el contexto:** `usuario` si hay usuario, si no `job`.
- **Sin `tipo_tarea` en el contexto:** se deduce de la operación del cliente (`ocr`, `biometric` ⇒
  `validacion_identidad`, `checklist`/`chat` ⇒ `chat`, …), porque el catálogo no tiene «desconocido».
- **Sin llave** (`anthropicMessages`): fila `no_configurado` con `http_status = 0` aunque no haya llamada
  HTTP. `anthropicMensajesCrudo` sí sale con llave vacía, como antes.
- **Tesseract:** también cuando el texto sale de la capa de `pdftotext` (el respaldo local no distingue
  la capa); `metadatos.motivo` dice por qué se usó.
- **`error_mensaje`:** además de recortado a 500, sin cédulas (6-12 dígitos) ni correos.
- **Haiku 5.5** tiene dos tramos de precio; se siembra el de prompts ≤ 100 000 tokens.
- **Retención del detalle** siempre activa (sin puerta positiva, a diferencia de RN-DRF3): borrar lo
  vencido es justo lo que la retención protege.
- **Usos agregados al catálogo FLITO:** `bolsas_documentos / ocr_fecha_expedicion / ocr` y
  `dr_flit / chat / chat`.

## Consecuencias

- Migración `0306_ia_consumo_log.sql` (SQL a mano, idempotente) con semilla de tarifas Anthropic.
- Banderas `IA_CONSUMO_LOG` (true), `IA_CONSUMO_DETALLE` (false), `IA_CONSUMO_DETALLE_DIAS` (30). En
  DEV/QA/PDN se fijan en `flit-gitops` si se quiere otro valor que el defecto (no se tocan en este PR).
- Ley 1581: el registro guarda placa, usuario y huella del archivo; el detalle (apagado por defecto)
  guarda texto extraído de documentos. Registro de terceros actualizado (§5.1).
- Riesgo aceptado: una corrección (`anotarConsumoIa`) sobre un lote en vuelo puede perderse.
