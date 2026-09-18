-- 0204_tarifas_primera_fijacion_desde_siempre.sql
-- Bug #12682: las primeras fijaciones hechas por la API (`fijarTarifa`) nacian con
--   `vigente_desde = now()`. Los tramites sincronizados con `fecha_aprobacion` anterior a ese
--   instante quedaban fuera de la ventana `[vigente_desde, vigente_hasta)` y el reporte de costos
--   mostraba «No configurado». La correccion del binario pone la PRIMERA vigencia de cada llave en
--   2000-01-01T00:00:00Z (mismo epoch que la 0183); este archivo repara las filas ya grabadas.
-- Autor: equipo FLITO. Antecedentes: 0183 (migradas del modelo viejo «desde siempre»), 0182
--   (EXCLUDE por llave), ADR-DB-001 (sin control de transaccion propio).
--
-- Que hace: por cada llave (compania_id, concepto, COALESCE(tipo_tramite,'')), la vigencia con
--   `vigente_desde` MAS ANTIGUA (empate: `fijado_en`, luego `id`) pasa a 2000-01-01T00:00:00Z SI
--   aun no lo es. No toca `fijado_en` ni las demas filas de la llave (cambios posteriores siguen
--   abriendo en `now()`). Mover solo la mas antigua no puede crear solape con la EXCLUDE.
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. Un solo bloque DO con dollar-quoting etiquetado.
--   - Idempotente en sentido fuerte: la 2a pasada no toca una fila (`vigente_desde <> epoch`).

DO $primerafijacion0204$
DECLARE
  n int;
BEGIN
  UPDATE flito_tarifas_vigencias v
     SET vigente_desde = '2000-01-01T00:00:00Z'
   WHERE v.vigente_desde <> '2000-01-01T00:00:00Z'
     AND v.id = (
       SELECT o.id
         FROM flito_tarifas_vigencias o
        WHERE o.compania_id = v.compania_id
          AND o.concepto = v.concepto
          AND COALESCE(o.tipo_tramite, '') = COALESCE(v.tipo_tramite, '')
        ORDER BY o.vigente_desde ASC, o.fijado_en ASC, o.id ASC
        LIMIT 1
     );
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '0204: % vigencia(s) de primera fijacion pasan a regir desde siempre (2000-01-01)', n;
END $primerafijacion0204$;
