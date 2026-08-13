-- 0148_siigo_sin_emision_global.sql
-- Feature #11242 — se retira la configuración global de emisión y se cierran cuatro preguntas.
-- Autor: equipo FLITO. Motivo: la emisión se elige en cada envío, y las incógnitas se respondieron.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- ============================================================================
-- QUÉ CAMBIÓ
-- ============================================================================
--
-- `siigo_config_emision` guardaba UNA configuración vigente por ambiente con la que nacían TODAS las
-- facturas: tipo de comprobante, vendedor, forma de pago y centro de costo. La 0147 ya había movido
-- esa elección al envío, dejando la global como respaldo de lo que nadie eligiera. Ahora se retira
-- el respaldo entero.
--
-- El motivo, en una frase: una configuración global significaba que cambiar el vendedor de una
-- empresa lo cambiaba para todas, y que una factura podía salir con un vendedor que quien la envió
-- nunca vio. Los cuatro campos son una ELECCIÓN de quien factura y se hace en cada envío, contra los
-- catálogos leídos de Siigo en ese momento.
--
-- **Se van también cuatro columnas que sostenían preguntas de negocio abiertas** (§6 de
-- `docs/features/siigo-facturacion-electronica.md`). Estaban implementadas como configuración para
-- que responderlas fuera un UPDATE y no un cambio de programa. El 2026-08-13 se respondieron, y una
-- respuesta no necesita una palanca — dejarla sería ofrecer la posibilidad de deshacer por descuido
-- una decisión de negocio:
--
--   · Pregunta 7 (retenciones) → se configuran en el TERCERO en Siigo. FLITO no envía `retentions[]`.
--   · Pregunta 15 (moneda) → COP. Y en COP no se envía `currency`: el campo es para moneda
--     extranjera, así que la respuesta correcta es omitirlo, no fijarlo.
--   · Pregunta 12 (numeración) → el consecutivo lo asigna Siigo. `number` no existe en `InvoiceIn`.
--   · Plazo de vencimiento → no se maneja. No se envía `payments[].due_date`.
--
-- ============================================================================
-- POR QUÉ ESTAS SÍ SE BORRAN, SI LA 0145 CONSERVÓ LAS SUYAS
-- ============================================================================
--
-- La 0145 conservó `clasificacion_tributaria` y `confirmado_por_id` porque eran el registro de QUIÉN
-- firmó y CON QUÉ se emitió: borrarlas eliminaba la respuesta a «¿con qué parametrización salió
-- aquella factura de marzo?».
--
-- Aquí no ocurre eso, y por una razón concreta: **lo que se emitió con cada lote ya está guardado en
-- el propio lote**. La 0147 añadió `documento_tipo_codigo`, `vendedor_codigo`, `forma_pago_codigo` y
-- `centro_costo_codigo` a `siigo_lotes_facturacion` como snapshot inmutable, y esas columnas son la
-- respuesta a esa pregunta. Estas de aquí son la configuración que YA NO se usa, no el historial.
--
-- Las filas históricas sí se conservan: no se borra ninguna.

-- ── Fuera la configuración global de emisión ─────────────────────────────────

ALTER TABLE siigo_config_emision
  DROP COLUMN IF EXISTS documento_tipo_codigo,
  DROP COLUMN IF EXISTS vendedor_codigo,
  DROP COLUMN IF EXISTS forma_pago_codigo,
  DROP COLUMN IF EXISTS centro_costo_codigo,
  DROP COLUMN IF EXISTS plazo_vencimiento_dias,
  DROP COLUMN IF EXISTS estrategia_numeracion,
  DROP COLUMN IF EXISTS retenciones_estrategia,
  DROP COLUMN IF EXISTS moneda,
  DROP COLUMN IF EXISTS notas;

-- ── Lo que queda, y por qué sigue en tabla y no en el entorno ────────────────
--
-- Dos valores operativos por ambiente. Siguen aquí, y no en una variable `SIIGO_*`, porque son por
-- ambiente, quedan historiados y admiten `CHECK`, mientras que una variable de entorno se pone mal
-- en un despliegue sin que nadie se entere. No hay pantalla que los edite ni endpoint que los
-- escriba: se cambian con una migración, que es exactamente la fricción que se busca para un valor
-- que decide desde cuándo se factura ante la DIAN.

COMMENT ON TABLE siigo_config_emision IS
  'Parametros operativos del ambiente. Dejo de ser la configuracion global de emision el 2026-08-13: '
  'comprobante, vendedor, forma de pago y centro de costo se eligen en cada envio y se guardan en '
  'siigo_lotes_facturacion. Aqui solo quedan historico_desde y arrendamiento_en_proceso_min.';

COMMENT ON COLUMN siigo_config_emision.historico_desde IS
  'Desde que fecha se factura electronicamente. Lo anterior NO se emite: no hay historico que migrar '
  '(pregunta 13, respondida el 2026-08-13). Se ajusta con una migracion, no desde ninguna pantalla.';

COMMENT ON COLUMN siigo_config_emision.arrendamiento_en_proceso_min IS
  'Minutos tras los cuales una factura en_proceso se considera huerfana y se reconcilia.';

-- ── El snapshot del lote deja de admitir «usar la configuracion global» ──────
--
-- En la 0147, `NULL` significaba «usar la global». Ya no hay global, así que `NULL` pasa a significar
-- lo único que puede significar: un lote encolado antes de este cambio, al que le falta con qué
-- emitir. `prepararEmision` lo rechaza con un mensaje que dice justo eso y pide reenviarlo.
--
-- **No se pone NOT NULL, y es deliberado.** Hacerlo obligaría a inventar un valor para esos lotes
-- —el peor momento para elegir un vendedor es una migración— o a borrarlos. Se prefiere una fila que
-- falla ruidosamente al emitir sobre una fila que emite con datos que nadie eligió.

COMMENT ON COLUMN siigo_lotes_facturacion.vendedor_codigo IS
  'Snapshot inmutable de lo elegido al enviar. NULL = lote anterior al 2026-08-13, sin con que emitir: '
  'se rechaza al emitir y hay que reenviar los tramites. Ya NO significa «usar la configuracion global».';

COMMENT ON COLUMN siigo_lotes_facturacion.documento_tipo_codigo IS
  'Snapshot inmutable de lo elegido al enviar. NULL = lote anterior al 2026-08-13 (ver vendedor_codigo).';

COMMENT ON COLUMN siigo_lotes_facturacion.forma_pago_codigo IS
  'Snapshot inmutable de lo elegido al enviar. Siempre de contado: FLITO no envia payments[].due_date, '
  'asi que las formas de pago con vencimiento no se ofrecen al elegir.';

COMMENT ON COLUMN siigo_lotes_facturacion.centro_costo_codigo IS
  'Snapshot inmutable de lo elegido al enviar. NULL es legitimo aqui: solo es obligatorio cuando el '
  'comprobante lo exige (cost_center_mandatory de /v1/document-types).';
