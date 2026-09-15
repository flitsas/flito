-- 0195_siigo_mapeo_servicio_adicional.sql
-- Feature #12544 — Servicios adicionales por tramite. HU #12547 (facturacion en Siigo):
--   el septimo concepto facturable, `servicio_adicional`, gana su fila de mapeo en los DOS
--   ambientes. Es la contraparte de la 0194: la liquidacion ya sella
--   valor_servicios_adicionales y el desglose en detalle->'serviciosAdicionales'->'items', y sin
--   fila en siigo_mapeo_conceptos la compuerta cierra con `concepto_no_listo` sin decir que falta
--   la fila misma.
-- Autor: equipo FLITO. Antecedentes: 0128 (tabla y semilla de los seis primeros conceptos),
--   0194 (valor_servicios_adicionales), ADR-DB-001.
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado.
--   - Idempotente: ON CONFLICT DO NOTHING SIN target, porque lo que ataja es el indice unico
--     PARCIAL idx_siigo_mapeo_unico_activo (ambiente, concepto, COALESCE(tipo_tramite,'')) WHERE
--     activo. SIN target a proposito, no porque sea imposible: un indice parcial SI se puede
--     nombrar dando su index_predicate, pero eso obliga a repetir la expresion COALESCE(...) de
--     forma que la inferencia la case, y cualquier cambio futuro del indice rompe este INSERT en
--     mitad del CD. Sin target no hay nada que casar, y es lo que ya hace la 0128. La 2a pasada
--     no duplica
--     filas ni pisa la configuracion que ya hizo quien parametriza.
--   - factura_linea_propia = true y linea_propia_pendiente = false: no hay decision abierta como la
--     del GMF. Un servicio adicional es un cobro identificable que el cliente pidio; se factura
--     como linea propia.
--   - SIN codigo_producto (NULL). La fila nace para que la pantalla muestre el trabajo pendiente,
--     no para fingir que ya esta hecho: quien parametriza elige el producto de Siigo. Hasta
--     entonces la compuerta cierra, que es lo correcto.
--   - SIN validacion_estado: toma su DEFAULT (`sin_validar`), igual que los seis de la 0128.
--     VALIDACION_BLOQUEA_FACTURACION mira ese campo, y sembrar otro valor cambiaria el bloqueo de
--     facturacion sin que ninguna HU lo pida.
--   - Se siembran los DOS ambientes por el mismo motivo que la 0128: un ambiente recien migrado
--     tiene que poder configurarse sin que nadie recuerde insertar filas a mano.

-- ── Paso 1 — La fila del septimo concepto, en los dos ambientes ──────────────────────────────────
INSERT INTO siigo_mapeo_conceptos (ambiente, concepto, factura_linea_propia, linea_propia_pendiente, notas)
SELECT a.ambiente, c.concepto, c.linea_propia, c.pendiente, c.notas
FROM (VALUES ('pruebas'), ('produccion')) AS a(ambiente)
CROSS JOIN (VALUES
  ('servicio_adicional', true, false, NULL)
) AS c(concepto, linea_propia, pendiente, notas)
ON CONFLICT DO NOTHING;

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0195$
DECLARE n_filas int; n_con_producto int;
BEGIN
  SELECT count(*) INTO n_filas FROM siigo_mapeo_conceptos
    WHERE concepto = 'servicio_adicional' AND activo;
  IF n_filas < 2 THEN
    RAISE EXCEPTION '0195: servicio_adicional no quedo sembrado en los dos ambientes (filas activas=%)', n_filas;
  END IF;
  SELECT count(*) INTO n_con_producto FROM siigo_mapeo_conceptos
    WHERE concepto = 'servicio_adicional' AND activo AND codigo_producto IS NOT NULL;
  RAISE NOTICE '0195: servicio_adicional mapeado en % filas activas; % ya tienen codigo de producto de Siigo (el resto espera a quien parametriza)', n_filas, n_con_producto;
END $resumen0195$;
