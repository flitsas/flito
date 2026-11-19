# Contrato `ia-consumo` v1 — registro de consumo de APIs de IA

Común a todos los aplicativos FLIT (FLIT 2.0, FLITO y siguientes). Cada aplicativo (y en FLIT cada
servicio con base propia) tiene SUS tablas con EXACTAMENTE esta estructura y estos catálogos, para poder
consolidarlas después sin traducir. Cambiar este contrato = nueva versión (v2), nunca a mano en un solo lado.

## Reglas

1. **Una fila por cada llamada HTTP real al proveedor.** Reintentos, segunda pasada (Haiku→Sonnet) y
   failover a otro proveedor = filas distintas unidas por `correlacion_id` (misma operación de negocio).
2. **Nunca bloquea ni rompe la llamada.** Encolar en memoria y escribir por lotes en segundo plano
   (cola acotada, p. ej. 10 000; si se llena se descarta y se loguea un contador). Si la BD falla →
   log estructurado de advertencia y se sigue. Al apagar, vaciar la cola con un tope de pocos segundos.
3. **Se registra también el fallo**: timeout, 429, 5xx, red, respuesta cortada, respuesta no interpretable.
4. **Nunca** se guarda la imagen/PDF ni su base64, ni llaves/encabezados. `error_mensaje` recortado a 500 chars.
5. Prompt y respuesta completos SOLO en `ia_consumo_detalle`, controlado por bandera de configuración
   `IA_CONSUMO_DETALLE` (`true`/`false`; por defecto `false`) y retención `IA_CONSUMO_DETALLE_DIAS`
   (por defecto 30). `respuesta_texto` y `prompt_texto` recortados a 64 KB c/u.
6. Bandera maestra `IA_CONSUMO_LOG` (por defecto `true`) para apagar el registro sin redeploy de código.
7. El contexto de negocio (módulo, proceso, placa, entidad, origen) lo abre el código que llama, en un
   ámbito ambiental (AsyncLocal en .NET / AsyncLocalStorage en Node); el cliente HTTP lo lee. Usuario y
   tenant se toman de la petición. Sin contexto ⇒ `modulo='desconocido'`, `proceso='desconocido'` (nunca falla).
8. `placa` en MAYÚSCULAS, sin espacios ni guiones. Fechas en UTC.
9. Costo: `costo_usd_estimado = (tokens_entrada*precio_entrada + tokens_salida*precio_salida +
   tokens_cache_lectura*precio_cache_lectura + tokens_cache_escritura*precio_cache_escritura) / 1e6`
   con la tarifa vigente (`vigente_desde <= fecha_inicio`, la más reciente) de (proveedor, modelo_respondido
   o, si es nulo, modelo_solicitado). Sin tarifa ⇒ NULL (no 0). Tarifas cacheadas en memoria (p. ej. 10 min).

## DDL (PostgreSQL; el esquema lo pone cada servicio según su convención)

```sql
CREATE TABLE ia_consumo_log (
  id                      uuid PRIMARY KEY,                 -- uuid v7 generado en la app
  correlacion_id          uuid        NOT NULL,
  intento                 smallint    NOT NULL DEFAULT 1,   -- 1.. dentro de la misma pasada/proveedor
  pasada                  smallint    NOT NULL DEFAULT 1,   -- 1 = primera, 2 = segunda pasada / failover
  fecha_inicio            timestamptz NOT NULL,
  fecha_fin               timestamptz NOT NULL,
  latencia_ms             integer     NOT NULL,
  aplicativo              text        NOT NULL,             -- flit | flito | ...
  servicio                text        NOT NULL,             -- core-api | core-comparendos | core-diagnostico | api
  ambiente                text        NOT NULL,             -- dev | qa | pdn | local
  tenant_id               text        NULL,
  usuario_id              text        NULL,
  usuario_login           text        NULL,
  origen                  text        NOT NULL,             -- catálogo
  modulo                  text        NOT NULL,             -- catálogo
  proceso                 text        NOT NULL,             -- catálogo
  tipo_tarea              text        NOT NULL,             -- catálogo
  placa                   text        NULL,
  entidad_tipo            text        NULL,                 -- tramite | comparendo | recibo | dictamen | ...
  entidad_id              text        NULL,
  archivo_mime            text        NULL,
  archivo_bytes           bigint      NULL,
  archivo_paginas         integer     NULL,
  archivo_sha256          text        NULL,
  proveedor               text        NOT NULL,             -- anthropic | openai | kimi | deepseek | tesseract
  modelo_solicitado       text        NULL,
  modelo_respondido       text        NULL,
  id_respuesta_proveedor  text        NULL,                 -- msg_... / chatcmpl-...
  max_tokens              integer     NULL,
  prompt_codigo           text        NULL,
  prompt_version          text        NULL,
  prompt_hash             text        NULL,                 -- sha256 hex del texto del prompt
  http_status             integer     NOT NULL DEFAULT 0,   -- 0 = sin respuesta HTTP (timeout/red)
  resultado               text        NOT NULL,             -- catálogo
  stop_reason             text        NULL,
  error_codigo            text        NULL,
  error_mensaje           text        NULL,
  tokens_entrada          integer     NOT NULL DEFAULT 0,
  tokens_salida           integer     NOT NULL DEFAULT 0,
  tokens_cache_lectura    integer     NOT NULL DEFAULT 0,
  tokens_cache_escritura  integer     NOT NULL DEFAULT 0,
  costo_usd_estimado      numeric(12,6) NULL,
  metadatos               jsonb       NULL
);
CREATE INDEX ix_ia_consumo_log_fecha        ON ia_consumo_log (fecha_inicio);
CREATE INDEX ix_ia_consumo_log_modulo_fecha ON ia_consumo_log (modulo, fecha_inicio);
CREATE INDEX ix_ia_consumo_log_placa        ON ia_consumo_log (placa) WHERE placa IS NOT NULL;
CREATE INDEX ix_ia_consumo_log_usuario      ON ia_consumo_log (usuario_id, fecha_inicio) WHERE usuario_id IS NOT NULL;
CREATE INDEX ix_ia_consumo_log_correlacion  ON ia_consumo_log (correlacion_id);

CREATE TABLE ia_consumo_detalle (
  consumo_id      uuid PRIMARY KEY REFERENCES ia_consumo_log(id) ON DELETE CASCADE,
  fecha_inicio    timestamptz NOT NULL,                     -- para la retención
  prompt_texto    text NULL,
  respuesta_texto text NULL
);
CREATE INDEX ix_ia_consumo_detalle_fecha ON ia_consumo_detalle (fecha_inicio);

CREATE TABLE ia_tarifa_modelo (
  id                         serial PRIMARY KEY,
  proveedor                  text          NOT NULL,
  modelo                     text          NOT NULL,      -- id exacto o prefijo sin fecha (ver nota)
  vigente_desde              date          NOT NULL,
  precio_entrada_mtok        numeric(12,6) NOT NULL,      -- USD por millón de tokens
  precio_salida_mtok         numeric(12,6) NOT NULL,
  precio_cache_lectura_mtok  numeric(12,6) NOT NULL DEFAULT 0,
  precio_cache_escritura_mtok numeric(12,6) NOT NULL DEFAULT 0,
  moneda                     text          NOT NULL DEFAULT 'USD',
  UNIQUE (proveedor, modelo, vigente_desde)
);
```

Nota tarifa: buscar primero por modelo exacto y, si no hay, por el modelo sin sufijo de fecha
(`claude-haiku-4-5-20251001` → `claude-haiku-4-5`). La semilla de Anthropic se toma de la tabla oficial de
precios (skill `claude-api`), con la fecha de hoy como `vigente_desde`; proveedores sin precio confirmado
NO se siembran (costo NULL).

Retención del detalle: tarea diaria `DELETE FROM ia_consumo_detalle WHERE fecha_inicio < now() - N días`.

## Catálogos (texto en minúscula_con_guion_bajo)

- **origen**: `usuario` · `job` · `sistema` · `ciudadano` (ruta pública por token, sin login) · `prueba_prompt`
- **resultado**: `exito` · `rate_limit` · `timeout` · `red` · `error_proveedor` (5xx u otro HTTP no 2xx) ·
  `rechazado` (4xx por el contenido/archivo) · `respuesta_invalida` (2xx pero no interpretable/cortada) ·
  `cancelado` · `no_configurado`
- **tipo_tarea**: `ocr` · `clasificacion` · `orientacion` · `particion` · `chat` · `redaccion` · `captcha` ·
  `validacion_identidad` · `recorte` · `salud`

### modulo / proceso — FLIT
| modulo | proceso | tipo_tarea |
|---|---|---|
| tramites | ocr_documento | ocr |
| tramites | clasificar_lote | clasificacion |
| tramites | ocr_lote | ocr |
| tramites | orientacion_pagina | orientacion |
| tramites | ocr_licencia_transito | ocr (entidad tramite) |
| dr_flit | chat | chat |
| comparendos | ocr_comparendo | ocr |
| comparendos | evaluar_prompt | ocr (origen prueba_prompt) |
| comparendos | probar_prompt | ocr (origen prueba_prompt) |
| diagnostico | redactar_dictamen | redaccion |

### modulo / proceso — FLITO
| modulo | proceso | tipo_tarea |
|---|---|---|
| soat | ocr_factura_soat | ocr |
| impuestos | ocr_recibo_impuesto | ocr |
| impuestos | ocr_recibo_caja | ocr |
| tramites | ocr_derecho_tramite | ocr |
| tramites | ocr_factura_venta | ocr |
| tramites | ocr_vehiculo_factura_venta | ocr |
| tramites | ocr_comprobante_universal | ocr |
| tramites | particion_consolidado | particion |
| tramites | ocr_documento | ocr |
| tramites | copiloto_checklist | chat |
| identidad | validar_identidad | validacion_identidad (origen ciudadano) |
| identidad | recortar_cedula | recorte |
| vehiculos | ocr_vehiculo | ocr |
| vehiculos | ocr_declaracion_impuesto | ocr |
| drive | ocr_pagina_drive | ocr |
| runt | ocr_cedula | ocr |
| runt | captcha | captcha |
| sistema | salud_modelos | salud (origen sistema) |
| bolsas_documentos | ocr_fecha_expedicion | ocr |
| dr_flit | chat | chat |

Si al implementar aparece un uso no listado, se agrega aquí (mismo PR) con el mismo formato.
