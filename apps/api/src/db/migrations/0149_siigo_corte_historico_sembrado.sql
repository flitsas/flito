-- 0149_siigo_corte_historico_sembrado.sql
-- Feature #11242 — siembra el corte del histórico e indexa el vínculo factura → lote.
-- Autor: equipo FLITO. Motivo: la 0148 dejó `siigo_config_emision` sin escritor y la tabla vacía,
-- y con ella vacía el único control que impide facturar histórico no autorizado no se aplicaba.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- ============================================================================
-- POR QUÉ HAY QUE SEMBRARLA, Y POR QUÉ AHORA
-- ============================================================================
--
-- `historico_desde` decide desde qué fecha se emite factura electrónica: lo anterior no se factura.
-- Lo lee `facturacion.elegibilidad.service.ts` con una subconsulta por la fila VIGENTE del ambiente.
--
-- Hasta la 0148 esa fila la escribía la pantalla de parametrización (`config-emision.routes.ts`).
-- La 0148 retiró la configuración global de emisión y con ella ese endpoint, que era su único
-- escritor — pero la tabla se quedó con dos columnas que SÍ se leen y sin nadie que las escriba. En
-- la práctica: cero filas, `historico_desde` NULL para todos los trámites, y la puerta abierta.
--
-- Sembrarla desde una migración no es un parche: es la forma que la 0148 eligió a propósito para
-- estos dos valores («se cambian con una migración, que es exactamente la fricción que se busca
-- para un valor que decide desde cuándo se factura ante la DIAN»). Esta es la primera vez que se
-- ejerce esa vía. Cambiar el corte mañana es otra migración como esta, con su porqué escrito.
--
-- ============================================================================
-- POR QUÉ CADA AMBIENTE LLEVA UNA FECHA DISTINTA
-- ============================================================================
--
-- No es un descuido de copiar y pegar: los dos ambientes tienen exposiciones distintas.
--
--   · `produccion` → 2026-08-13, el día en que se decidió el modelo de emisión por envío. Nada
--     anterior está autorizado a salir ante la DIAN, y una factura emitida de más no se deshace.
--     Si hubiera que facturar histórico, se sube esa fecha con una migración y queda dicho quién
--     lo decidió y cuándo — que es justo lo que una pantalla no dejaba.
--
--   · `pruebas` → 2026-01-01. En pruebas NO hay efectos externos: `efectosExternosPermitidos`
--     deja `timbrarEnDian` y `enviarCorreoAlCliente` en falso, así que el documento se crea en
--     Siigo y ahí se queda. Con la fecha de producción, QA no podría ejercer el flujo salvo con
--     trámites facturados hoy mismo, y un control que solo se puede probar el día que se instala
--     es un control que nadie prueba.
--
-- El código, por su parte, ya no da por bueno el vacío: sin fila vigente, la elegibilidad devuelve
-- `sin_corte_configurado` y NO deja facturar nada. Esta siembra es lo que hace que ese camino sea
-- excepcional —un ambiente nuevo sin sembrar— y no el estado de todos los días.

-- ── El corte, uno por ambiente ───────────────────────────────────────────────
--
-- `ON CONFLICT (ambiente) WHERE vigente` infiere el índice único PARCIAL de la 0130
-- (`idx_siigo_config_emision_vigente`): sin el `WHERE`, PostgreSQL no reconoce ese índice y la
-- sentencia falla. `DO NOTHING` y no `DO UPDATE`: donde alguien alcanzó a guardar una fila con la
-- pantalla que existió hasta la 0148, esa fila es la verdad —la eligió una persona— y esta
-- migración no la pisa. Sembrar no es reconfigurar.

INSERT INTO siigo_config_emision (ambiente, historico_desde, arrendamiento_en_proceso_min, vigente)
VALUES
  ('produccion', DATE '2026-08-13', 15, true),
  ('pruebas',    DATE '2026-01-01', 15, true)
ON CONFLICT (ambiente) WHERE vigente DO NOTHING;

-- ── El vínculo de una factura con su lote ────────────────────────────────────
--
-- **No hace falta para la reconciliación**, y conviene dejarlo dicho para que nadie lo borre
-- creyendo que sí: la reconciliación entra por `siigo_facturas.id` —la clave primaria— y desde esa
-- única fila alcanza el lote por la primaria del lote. Ese camino no toca este índice.
--
-- Está por lo otro: `lote_id` es una clave foránea SIN índice. Toda comprobación de integridad
-- referencial sobre `siigo_lotes_facturacion` —borrar un lote, cambiarle la clave— obliga a
-- PostgreSQL a recorrer `siigo_facturas` entera, y esa tabla solo crece. De paso habilita la
-- pregunta natural de soporte, «¿qué facturas salieron de este lote?», que hoy es un seq scan.
--
-- El coste es una escritura más por factura emitida, del orden de decenas al día.

CREATE INDEX IF NOT EXISTS idx_siigo_facturas_lote
  ON siigo_facturas (lote_id);

COMMENT ON COLUMN siigo_config_emision.historico_desde IS
  'Desde que fecha se factura electronicamente. Lo anterior NO se emite. Sembrada en la 0149: '
  'produccion 2026-08-13 (dia de la decision), pruebas 2026-01-01 (sin efectos externos, QA tiene '
  'que poder ejercer el flujo). Sin fila vigente NO se factura nada: la elegibilidad devuelve '
  'sin_corte_configurado. Se cambia con una migracion, no desde ninguna pantalla.';
