# ADR-0021 — El outbox del comprobante de pago gana `destino` y envía a FLIT 1 en tres pasos con URL de subida validada

## Estado

**Aceptado — 2026-10-06 por David Chica (Líder Técnico).** Propuesto el mismo día por architecture-agent; aprobado con
los tres ajustes de la sección «Ajustes de la aprobación», que mandan sobre el texto original donde difieran.
HU [#13310](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/13310) (Feature #13309, Épica #12741); prepara la HU #13311 (reemplazo) y la HU #13312 (indicador en el front).
Diseño detallado: [`docs/diseno/feature-13309-envio-comprobante-flit1.md`](../diseno/feature-13309-envio-comprobante-flit1.md).
Extiende (no sustituye) [ADR-0020](ADR-0020-flito-outbox-envio-comprobante-flit2.md). Módulos: `flito-impuestos` y `flito-sync` (FLITO; no toca los legacy `liquidacion/` ni `tramites/`).

## Contexto

ADR-0020 creó el outbox `flito_impuesto_envios_flit2` (migración 0219, aplicada en DEV) para enviar el comprobante
de pago del impuesto a FLIT 2. Los trámites de FLIT 1 (`flito_tramites.fuente = 'flit'`) necesitan el mismo envío,
pero el contrato es otro y **sin autenticación**: (1) `POST {FLIT1_ARCHIVOS_BASE_URL}/api/v1/files` registra el
archivo y devuelve su `id` y una `presignedUrl` de S3; (2) `POST` multipart a esa URL con sus `fields` + `file`;
(3) `PUT {FLIT1_TRAMITES_BASE_URL}/api/v1/vehicleTaxesQuery/{idReal}` enlaza el `id` como recibo de pago. El
`idReal` se deriva de `id_flit` (`FLIT-0[124]<dígitos>`). La respuesta del paso 3 y sus errores son desconocidos.
La URL del paso 2 la dicta una respuesta remota: es una superficie SSRF/exfiltración del comprobante (PII).

Ya acordado y fuera de discusión aquí: reintento desde el paso 1 si fallan el 1 o el 2; solo el PUT si falla el 3
con el archivo subido; 5xx/429/red reintentables y el resto de 4xx definitivos (código + paso, sin cuerpo);
límites del archivo antes de llamar; sin retroactivo; la `presignedUrl` no se persiste ni se loguea.

## Decisión

1. **Una columna `destino` (`'flit1'|'flit2'`) en la tabla existente**, sin renombrarla (migración 0221). Una fila
   por impuesto sigue siendo la regla (un trámite tiene una sola fuente). CHECK nuevos impiden a una fila `flit1`
   los estados y columnas de FLIT 2 (`en_espera`, `ya_cargado_gestor`, `estado_flit2`, `adjunto_id`, espera) y a
   una fila `flit2` las columnas de FLIT 1. Columnas nuevas: `archivo_flit1_id` (se persiste **solo** tras el paso
   2) y `ultimo_paso` (1-3). El `DEFAULT 'flit2'` solo rellena las filas existentes y se retira.
2. **Ciclo FLIT 1 propio** (servicio, toma `SKIP LOCKED`, pausa en `system_locks` y cron con su `withLock`),
   que comparte con FLIT 2 la fila, el upsert del pago (`programarEnvioComprobante`, mapea fuente → destino), la
   lectura del detalle y los helpers del soporte (archivo común `flito-impuestos.envio-comun.ts`). La toma FLIT 2
   filtra `destino = 'flit2'`. Apagar, pausar o cortar un destino nunca frena al otro.
3. **Puerto `Flit1AdjuntosPort.enviarComprobante(idReal, archivo, archivoIdSubido)`** en `flito-sync/`, que
   **devuelve** el desenlace clasificado (`enviado | reintentable | definitivo | pausa`, con `paso` y `archivoId`
   cuando el paso 2 ya pasó) y nunca expone la `presignedUrl` fuera del adaptador. `fetch` nativo, `redirect:'error'`,
   timeouts 10/60/15 s. Sin dependencia nueva.
4. **Validación fija de la URL de subida (ajuste A-1):** la URL del paso 2 sale SIEMPRE de `presignedUrl.url` de la
   respuesta del paso 1; no hay variable de allowlist. Antes del paso 2 se exige en código: `https:`, sin user/pass, y
   `URL().hostname` (minúsculas) que termina en `.amazonaws.com` (sufijo con punto: `evilamazonaws.com` no pasa);
   `redirect: 'error'`. URL que no cumple = **pausa global FLIT 1** (no consume intento; sondeo cada 20 min), no
   `error` de la fila; el log no lleva la URL.
5. **Tope de 3 intentos** (`MAX_INTENTOS_ENVIO_FLIT1 = 3`, paridad con FLIT 2); un intento = una pasada por la fila,
   haga 1, 2 o 3 pasos; backoff 5 min / 30 min. 429 consume intento (no comparte cuota con nada).
6. **Encendido por tres variables + interruptor:** `FLIT1_ARCHIVOS_BASE_URL`, `FLIT1_TRAMITES_BASE_URL` (https,
   origen + path del stage, sin query/hash) y `FLIT1_ADJUNTOS_ENVIO_HABILITADO` (default apagada), más
   `fuenteHabilitada('flit1')`. Falta o invalidez de cualquiera = ciclo omitido; las filas siguen `pendiente`.
7. **Id real** = dígitos tras `FLIT-0[124]`, normalizados sin ceros a la izquierda (`FLIT-010045` → `45`, ajuste A-3);
   todo ceros u otro formato → `error` sin llamar.
8. **Detalle (AC10):** campo nuevo `envioComprobante: { destino, estado, intentos, ultimoIntentoEn } | null`;
   `envioFlit2` se conserva sin cambios (null para FLIT 1) hasta que el front migre (HU #13312).
9. **403/404 de API Gateway = pausa de configuración (ajuste A-2, como FLIT 2):** un 403 o 404 SIN cuerpo, o con
   cuerpo no JSON / el típico de API Gateway (`{"message":"Missing Authentication Token"}`, `Forbidden`), en
   cualquier paso hacia los hosts `FLIT1_*` = **pausa global** persistida en `system_locks`, sondeo de una sola
   petición cada 20 min, sin consumir intento (calco de ADR-0020 §4). El resto de 4xx ≠ 429 = `error` definitivo
   (código + paso, sin cuerpo).
10. **Cuerpo del paso 3:** `{ idAttachmentPdfDraft: "", idAttachmentPdfPrepared: "", idAttachedPaymentReceipt }` —
   cadena vacía, ni `null` ni ausente. `filename` = `impuesto-<uuid>.<ext>` con la extensión del MIME real detectado
   por bytes (`pdf|jpg|png|webp`); `category` siempre `"impuestos-flito"`.

## Alternativas consideradas

- **Tabla hermana `flito_impuesto_envios_flit1`:** semántica limpia, pero duplica upsert del pago, `completar`,
  reemplazo y lectura del detalle, y no puede impedir por CHECK que un impuesto tenga fila en las dos. Rechazada.
- **Renombrar la tabla a `flito_impuesto_envios`:** con la 0219 aplicada y código desplegado que la nombra, abre una
  ventana en la que el cron del binario viejo falla tras la migración; no aporta comportamiento. Rechazada (deuda
  de nombre declarada con `COMMENT ON TABLE`).
- **Allowlist exacta de hosts S3 (`FLIT1_S3_HOSTS`):** era la propuesta original (más estrecha que el sufijo).
  Descartada en la aprobación (A-1): exige medir y mantener el host del bucket por ambiente; se acepta el riesgo
  residual del sufijo `.amazonaws.com` (cualquier bucket de AWS) frente a una respuesta manipulada del paso 1.
- **Extender el adaptador de lectura `flit-http.adapter.ts`:** usa otra base (`FLIT_BASE_URL`) con host por defecto
  en código; mezclar escritura sin auth amplía su superficie. Rechazada.
- **Host S3 no permitido como `error` de la fila:** un cambio de bucket en FLIT 1 llevaría toda la cola a `error` en
  ~35 min y crearía un archivo huérfano por fila y minuto. Rechazada a favor de la pausa global.

## Consecuencias

- Nueva migración 0221 (requiere `db-review-agent`), cuatro variables de entorno nuevas por ambiente (incluido
  `IMPUESTOS_ENVIO_FLIT1_CRON_ENABLED`) y un cron nuevo en `server.ts`.
- La tabla `flito_impuesto_envios_flit2` guarda filas de los dos destinos: su nombre deja de describirla. Un
  renombrado futuro exige ADR propio y un despliegue en dos tiempos.
- Precedente: un destino nuevo del comprobante se añade como valor de `destino` + CHECK de sus columnas + ciclo
  propio con su puerto clasificador; nunca como rama dentro del ciclo de otro destino.
- Cada reintento desde el paso 1 deja un registro de archivo huérfano en FLIT 1 (acordado; acotado por el tope).
- El encendido en cada ambiente exige probar un envío real (formato del id real y respuesta del PUT sin confirmar).
- Riesgo residual aceptado (A-1): la URL de subida solo se ata a `*.amazonaws.com`, no a un bucket concreto.

## Ajustes de la aprobación (David Chica, 2026-10-06)

- **A-1 — Sin `FLIT1_S3_HOSTS`.** La URL de subida sale siempre de `presignedUrl.url`; validación fija en código:
  `https:`, sin credenciales, hostname en minúsculas terminado en `.amazonaws.com` (con punto), `redirect: 'error'`.
  Lo que no cumple → pausa global (no consume intento, no pasa a `error`), log sin la URL.
- **A-2 — R-2 como FLIT 2.** 403/404 sin cuerpo o con el cuerpo típico de API Gateway en cualquier paso hacia los
  hosts `FLIT1_*` → pausa global de configuración en `system_locks`, sondeo de una petición cada 20 min, sin
  consumir intento. El resto de 4xx ≠ 429 → `error` definitivo.
- **A-3 — Ceros a la izquierda fuera** (`FLIT-010045` → `45`); todo ceros → `error` sin llamar.
