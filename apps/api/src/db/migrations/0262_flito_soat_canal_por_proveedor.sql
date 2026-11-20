-- HU #13967 (Feature #13966, Épica #13671) — «SOAT sin trámite» se gobierna por el PERMISO y el PROVEEDOR elegido.
--
-- Regla de negocio (PO): puede solicitar SOAT sin trámite quien tenga la función `soat.solicitud.crear` y pertenezca
-- a una compañía con proveedor elegido (`clients.flito_proveedor_soat_sin_tramite_id IS NOT NULL`). NULL = «Sin
-- proveedor» = canal cerrado. El interruptor `clients.soat_sin_tramite` desaparece del código; la columna física se
-- queda con su DEFAULT y sin uso (se retira en #13968). NO hay DROP COLUMN aquí.
--
-- Aplicar en PDN justo después del deploy del código: mientras no se aplique, las compañías con canal cerrado que
-- conservan proveedor quedan con el canal abierto (ver conteo pierden_proveedor).
--
-- ANTES DE APLICAR EN PDN: `pg_dump` de la base, y anotar el conteo previo:
--
--   SELECT count(*) FILTER (WHERE soat_sin_tramite) AS abiertas,
--          count(*) FILTER (WHERE NOT soat_sin_tramite AND flito_proveedor_soat_sin_tramite_id IS NOT NULL) AS pierden_proveedor,
--          count(*) FILTER (WHERE soat_sin_tramite AND flito_proveedor_soat_sin_tramite_id IS NULL) AS incoherentes_debe_ser_0
--   FROM clients;
--
-- `abiertas` conservan su proveedor (siguen abiertas). `pierden_proveedor` son compañías con el canal APAGADO que
-- guardaban un proveedor (la 0175 lo conservaba al apagar): se les quita para que sigan cerradas. `incoherentes`
-- debe ser 0 (lo garantizaba el CHECK `clients_sin_tramite_gestor_chk`).
--
-- Pasos, en orden e idempotentes:
--   1. Si la columna `soat_sin_tramite` existe: NOTICE con el conteo y NULL al proveedor de las compañías cerradas.
--   2. Se retira el CHECK `clients_sin_tramite_gestor_chk` (0175): ya no hay flag que atar.
--   3. COMMENT ON COLUMN de la columna obsoleta y del proveedor.
--   4. Se renombra la acción `accion.clientes.soat_sin_tramite` (mismo código y mismas operaciones).
-- La segunda pasada no cambia nada: el UPDATE no encuentra filas, el DROP lleva IF EXISTS, el COMMENT es el mismo y
-- el renombre solo escribe si difiere.

-- 1. Las compañías con el canal apagado quedan sin proveedor.
DO $$
DECLARE
  afectadas integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'clients' AND column_name = 'soat_sin_tramite'
  ) THEN
    SELECT count(*) INTO afectadas FROM clients
     WHERE soat_sin_tramite = false AND flito_proveedor_soat_sin_tramite_id IS NOT NULL;
    RAISE NOTICE '0262: compañías con el canal apagado que pierden su proveedor SOAT sin trámite: %', afectadas;
    UPDATE clients SET flito_proveedor_soat_sin_tramite_id = NULL
     WHERE soat_sin_tramite = false AND flito_proveedor_soat_sin_tramite_id IS NOT NULL;
  END IF;
END $$;

-- 2. El CHECK «canal encendido ⇒ gestor configurado» ya no tiene flag que atar.
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_sin_tramite_gestor_chk;

-- 3. Qué significa cada columna desde esta HU.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'clients' AND column_name = 'soat_sin_tramite'
  ) THEN
    COMMENT ON COLUMN clients.soat_sin_tramite IS
      'OBSOLETA (HU #13967): sin uso. El canal SOAT sin trámite lo abre flito_proveedor_soat_sin_tramite_id. '
      'Se retira en #13968.';
  END IF;
END $$;

COMMENT ON COLUMN clients.flito_proveedor_soat_sin_tramite_id IS
  'Proveedor al que van las solicitudes de SOAT sin trámite de la compañía (HU #12078). Desde la HU #13967 es '
  'también el interruptor del canal: NULL = Sin proveedor = canal cerrado. Un proveedor inactivo NO cierra el canal: '
  'la solicitud cae en la contingencia de Operaciones.';

-- 4. La acción se renombra: conserva su código y sus operaciones.
UPDATE permisos_funciones SET nombre_negocio = 'Elegir proveedor de SOAT sin trámite', descripcion = 'Elegir el proveedor al que van los SOAT sin trámite de un cliente.'
  WHERE codigo = 'accion.clientes.soat_sin_tramite' AND (nombre_negocio, descripcion) IS DISTINCT FROM ('Elegir proveedor de SOAT sin trámite', 'Elegir el proveedor al que van los SOAT sin trámite de un cliente.');
