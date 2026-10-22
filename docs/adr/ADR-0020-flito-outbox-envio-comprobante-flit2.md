# ADR-0020 — Escrituras de FLITO hacia FLIT 2 por outbox en tabla, drenado por cron con cerrojo de ciclo y toma `SKIP LOCKED`

## Estado

**Aceptado** — 2026-10-05 por David Chica (Líder Técnico). Propuesto el 2026-10-02 por architecture-agent y revisado el
2026-10-05 con las decisiones cerradas entre David y la sesión FLIT 2 (diseño §13).
HU [#13268](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/13268) (Feature #13267, Épica #12741); prepara la HU #13269 (reemplazo de comprobante).
Diseño detallado: [`docs/diseno/feature-13267-envio-comprobante-flit2.md`](../diseno/feature-13267-envio-comprobante-flit2.md).
Módulos: `flito-impuestos` y `flito-sync` (FLITO; no toca los módulos legacy `liquidacion/` ni `tramites/`).

**Referencia del contrato:** repo `flitsas/flit` @ `c2b7f68db` (PR flitsas/flit#513, **sin mergear**):
`contracts/openapi/external-api.v1.json` (operationId `enviarAdjunto`, `x-estado: anunciada`) y
`docs/integraciones/external-api-tramites-sync.md` §7. Cuando la PR se mergee, la referencia pasa a `main`.

## Contexto

Es la **primera escritura** de FLITO hacia FLIT 2 (hasta hoy solo leía: feed, URL de factura). El contrato
(`POST /api/v1/external/tramites/{id}/adjuntos`) comparte con el feed y con la URL de factura una cuota de
**120 req/min por `client_id` en ventana deslizante** (el endpoint de token va aparte: 10/min por IP), exige el
scope `external.tramites.attachments.write` (hoy no existe; lo da de alta la HU #13263 de FLIT 2) y define
desenlaces transitorios (5xx, 503 `storage_unavailable`, 429 con `Retry-After` en segundos enteros), de estado
(409 `not_allowed_in_state` con extensiones `estado` y `terminal`) y definitivos. El pago de un impuesto llega a
`pagado` por seis caminos con transacciones de forma distinta; cuatro pasan por `conciliar`
(`flito-recibos.service.ts`). Hasta desplegar su HU #13263 el servidor de FLIT 2 responde **404 sin cuerpo** en la
ruta, y ese 404 **consume cuota**.

En FLIT 2 un trámite admite el adjunto en `preasignacion`, `asignado`, `entregado` y `rechazado` con subsanación
activa (preasignación y asignado solo existen en 4 de 96 tipos; los traspasos entran directo por `entregado`, donde
el adjunto se archiva con `pagadoMarcado:false`). `borrador`, `preparado` y `rechazado` sin subsanación activa
responden 409 `terminal:false`; `aprobado`, `anulado` y `revocado`, 409 `terminal:true`. «radicado» no es un
estado. FLITO ya persiste del feed `flito_tramites.sync_version` y el estado FLIT 2 del trámite en `flit_estado`
(grafía capitalizada de `flito-sync/flit2-mapeo.ts`).

## Decisión

1. **Outbox en la transacción del pago.** Cada camino a `pagado` llama `programarEnvioFlit2(tx, impuestoId)`,
   que solo inserta/actualiza una fila en `flito_impuesto_envios_flit2` (una por impuesto). Nunca hay red
   dentro de la transacción. Los pagos anteriores al despliegue no tienen fila: no hay envío retroactivo.
2. **Drenado por cron** (60 s) con `withLock` de ciclo (tabla `system_locks`, global entre procesos) y toma de
   filas en **una sola sentencia** (CTE `FOR UPDATE SKIP LOCKED` + `UPDATE … RETURNING` con arrendamiento),
   calco de `tomarLote` de `siigo/facturacion.cola.service.ts`. Lote ≤ 50 por ciclo, `conConcurrencia` 4.
   Reutiliza el JWT cacheado de `obtenerPase()`; no pide token por envío.
3. **Puerto FLIT 2 extendido** (`Flit2SyncPort.enviarAdjunto`) que **devuelve** el desenlace clasificado
   (`enviado | reintentable | espera | estacionar | pausa | definitivo`) en lugar de lanzar; solo lanza los
   errores del pase. La clasificación es una función pura por `code` RFC 7807 (y por ausencia de cuerpo en el 404).
4. **Esperas que no consumen intento:** 429 (`Retry-After`), interruptor de la fuente apagado, pase bloqueado,
   y «pausas de configuración» (403 `insufficient_scope`, 400 `invalid_tipo`, **404 sin cuerpo** = ruta aún no
   desplegada). La pausa es **global y persistida** (clave propia en `system_locks` con vencimiento) y mientras
   dura la cola se sondea con **una sola petición cada 20 min** (rango acordado 15-30), no en cada ciclo de 60 s,
   porque el 404 gasta cuota. Solo el 404 problem+json `procedure_not_found` es definitivo.
5. **Trámite aún no listo = estacionamiento guiado por el feed.** 409 `not_allowed_in_state terminal:false` **no
   gasta intento**: la fila pasa a `en_espera` y guarda la `sync_version` del trámite en ese momento
   (`sync_version_espera`). La toma la vuelve a elegir cuando `flito_tramites.sync_version` supera la guardada
   **y** `flit_estado` es uno de los que admiten envío (preasignación, asignado, entregado, rechazado); si vuelve a
   dar `terminal:false`, se estaciona otra vez con la versión nueva, sin gastar intento. Red de seguridad: sondeo
   cada 24 h; a los 30 días en `en_espera` → `error`. `terminal:true` es definitivo (`error`).
6. **Pre-validación local:** MIME (`application/pdf`, `image/jpeg`, `image/png`, `image/webp`, detectado por bytes
   y enviado como `Content-Type` de la parte `file`), tamaño ≤ 20 MB y archivo no vacío se comprueban **antes** de
   llamar: fuera de límite → `error` sin gastar llamada.
7. **Variable de despliegue** `FLIT2_ADJUNTOS_ENVIO_HABILITADO` (default apagada): con ella apagada se siguen
   escribiendo filas y el cron no envía. FLITO puede mergear y desplegar antes que FLIT 2 con la variable apagada.
8. **Generación (`version`)** en la fila: un reemplazo (#13269) la sube y el worker solo escribe su desenlace si
   la generación no cambió desde que tomó la fila. FLIT 2 acepta el reemplazo en todos los estados que admiten
   envío (incluido `entregado`) y devuelve `reemplazoDe`. **FLITO no decide nada con `pagadoMarcado`**: solo lo
   guarda (su semántica tras un reemplazo sigue abierta en FLIT 2 #13263).
9. **Estado como `varchar` + CHECK**, no enum de Postgres (evita `55P04` al ampliar; `en_espera` ya nace así).

## Alternativas consideradas

- **Hook post-commit + cola en memoria** (patrón del análisis post-envío, HU #12825): requiere un «después del
  commit» en seis sitios, el ritmo sería por proceso y un reinicio pierde la cola; acabaría necesitando la misma
  tabla. Rechazada.
- **Envío síncrono en la petición del pago:** la carga masiva pagaría N llamadas en el request y frenaría el
  feed; AC5/AC7 obligan a persistir igual. Rechazada.
- **Tabla de historial (una fila por envío):** complica «vigente», el reemplazo y el detalle; el historial ya
  queda en `audit_logs`. Rechazada.
- **409 `terminal:false` como reintento con backoff largo (1 h / 6 h) sin mirar el feed** (default de la primera
  versión de este ADR): gasta los 3 intentos en un trámite que puede tardar días en llegar a `entregado` y sondea a
  ciegas. Rechazada a favor del estacionamiento guiado por `sync_version` (decisión 5).
- **Pausa global solo en memoria del proceso:** con PM2 en cluster otro proceso puede ganar el cerrojo del ciclo
  siguiente y volver a pegarle a la ruta 404 en cada minuto. Rechazada (decisión 4).

## Consecuencias

- Latencia de hasta ~60 s entre pago y envío (y hasta un ciclo después del feed para las filas `en_espera`).
- Precedente: **toda escritura futura de FLITO hacia FLIT 2** (otros tipos documentales, estados) usa esta misma
  forma: fila outbox en la `tx` del hecho + cron con cerrojo de ciclo + desenlace clasificado por el puerto +
  estacionamiento guiado por `sync_version` cuando el estado remoto aún no admite la escritura. El catálogo `tipo`
  del contrato se amplía sin endpoint nuevo; aquí se ampliaría con una columna `tipo` y el índice único pasaría a
  `(impuesto_id, tipo)` en una migración nueva.
- La cuota de 120/min (ventana deslizante, compartida con feed y URL de factura) se reparte por constante comentada
  (lote del envío ≤ 50/min); un 429 corta el ciclo.
- Nueva variable de entorno por ambiente; nueva migración (requiere `db-review-agent`) y nuevo cron en `server.ts`.
- **Precondición del encendido en PDN:** la HU #13265 de FLIT 2 (bloqueo del gestor) debe llegar a PDN junto con
  las dos HUs de FLIT 2 que habilitan el envío (#13263 endpoint y #13264 marca de pagado) **o antes**. Sin ella no se enciende
  `FLIT2_ADJUNTOS_ENVIO_HABILITADO` en PDN.
- Contrato anunciado, no publicado: si FLIT 2 cambia un `code` al mergear la PR #513, cambia solo
  `flit2-adjuntos.ts`.
