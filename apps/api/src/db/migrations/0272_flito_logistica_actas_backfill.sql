-- 0272_flito_logistica_actas_backfill.sql
-- HU #14109 (Feature #14091, Epica #13758) — ADR-0030. Backfill de las actas existentes al modelo nuevo.
-- Datos puros; las tablas/columnas las crea la 0271.
--
-- Cada acta existente recibe: su traslado LEGADO (destino cliente, origen organismo), sus lineas por LT
-- (sin precio: concepto 'legado', precio NULL — NO hay precio retroactivo), sus lineas de acta y sus firmas.
-- Sin BEGIN/COMMIT propio (ADR-DB-001). Idempotente: ids deterministas (traslado = id del acta) y guardas
-- NOT EXISTS / ON CONFLICT; la segunda pasada no cambia NI UNA FILA.
--
-- PII: aqui NO se cifra (el cifrado es de aplicacion y la migracion no tiene la llave). La firma `recibe` copia
-- solo los 4 ultimos digitos; `receptor_documento` sigue en claro en el acta hasta la HU #14112.
-- Las columnas viejas del acta NO se borran.

-- 1. Guarda: toda acta tiene punto.
UPDATE flito_logistica_actas SET punto = 'cliente' WHERE punto IS NULL;

-- 2. Un traslado legado por acta sin traslado (id del traslado = id del acta: reintento inocuo).
INSERT INTO flito_logistica_traslados
  (id, compania_id, destino, origen, estado, mensajero_id, registrado_en, legado, updated_at)
SELECT a.id, a.compania_id, 'cliente', 'organismo',
       CASE a.estado WHEN 'generada' THEN 'registrado' WHEN 'despachada' THEN 'en_ruta'
                     WHEN 'entregada' THEN 'entregado' ELSE 'devuelto' END,
       a.mensajero_id, a.created_at, TRUE, a.updated_at
FROM flito_logistica_actas a
WHERE a.traslado_id IS NULL AND a.compania_id IS NOT NULL AND a.punto = 'cliente'
ON CONFLICT (id) DO NOTHING;

UPDATE flito_logistica_actas a SET traslado_id = a.id
WHERE a.traslado_id IS NULL AND a.compania_id IS NOT NULL AND a.punto = 'cliente'
  AND EXISTS (SELECT 1 FROM flito_logistica_traslados t WHERE t.id = a.id AND t.legado);

-- 3. Una linea por LT del acta, sin precio (estado heredado del traslado legado; id de la linea = id del documento).
INSERT INTO flito_logistica_traslado_lts (id, traslado_id, destino, documento_id, estado, concepto_precio, precio, created_at)
SELECT d.id, t.id, 'cliente', d.id, t.estado, 'legado', NULL, t.registrado_en
FROM flito_logistica_documentos d
JOIN flito_logistica_actas a ON a.id = d.acta_id
JOIN flito_logistica_traslados t ON t.id = a.traslado_id AND t.legado
ON CONFLICT DO NOTHING;

-- 4. Lineas del acta (punto cliente, compania del acta), enlazadas a su linea de traslado.
INSERT INTO flito_logistica_acta_lineas (acta_id, documento_id, punto, traslado_lt_id, compania_id)
SELECT d.acta_id, d.id, 'cliente', tl.id, a.compania_id
FROM flito_logistica_documentos d
JOIN flito_logistica_actas a ON a.id = d.acta_id AND a.punto = 'cliente'
JOIN flito_logistica_traslado_lts tl ON tl.documento_id = d.id AND tl.traslado_id = a.traslado_id
ON CONFLICT DO NOTHING;

-- 5. Firmas. `entrega` (Operaciones): sin cedula. `recibe`: solo documento_ultimos (cifrado = NULL, ver cabecera).
INSERT INTO flito_logistica_acta_firmas (acta_id, rol, nombre, firma_storage_key, firmado_en)
SELECT a.id, 'entrega', COALESCE(NULLIF(btrim(a.entrega_nombre), ''), 'Sin registrar'),
       a.firma_entrega_storage_key, a.created_at
FROM flito_logistica_actas a
WHERE a.firma_entrega_storage_key IS NOT NULL
ON CONFLICT (acta_id, rol) DO NOTHING;

INSERT INTO flito_logistica_acta_firmas
  (acta_id, rol, nombre, documento_cifrado, documento_ultimos, firma_storage_key, firmado_en, lat, lng)
SELECT a.id, 'recibe', COALESCE(NULLIF(btrim(a.receptor_nombre), ''), 'Sin registrar'),
       NULL, NULLIF(right(btrim(a.receptor_documento), 4), ''), a.firma_storage_key,
       COALESCE(a.entregado_en, a.updated_at), a.entregado_lat, a.entregado_lng
FROM flito_logistica_actas a
WHERE a.firma_storage_key IS NOT NULL
ON CONFLICT (acta_id, rol) DO NOTHING;
