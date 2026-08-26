-- 0115 — Trazabilidad: de qué archivo salió cada derecho, e historial de estados de SOAT/impuestos.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001): el runner envuelve cada fichero en su transacción.
-- Idempotente: se puede aplicar dos veces sin efecto adicional.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) De qué archivo salió cada derecho
--
-- La tabla solo guardaba `origen` ('manual' | 'drive'), que dice el CANAL pero no el documento.
-- Con los consolidados del Drive —un PDF de trece páginas por día— saber que vino «del Drive» no
-- permite volver al papel: hacen falta el archivo y la página.
--
-- `procesamiento_id` apunta al registro del barrido, que ya guarda nombre, fileId, quién lo subió y
-- cuándo, y que sobrevive al borrado del archivo en el Drive. `archivo_origen` se guarda ADEMÁS,
-- desnormalizado a propósito: es el único dato disponible en la carga manual, que no tiene registro
-- de procesamiento, y así una sola columna sirve a los dos canales.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE flito_derechos_tramite ADD COLUMN IF NOT EXISTS archivo_origen VARCHAR(255);
ALTER TABLE flito_derechos_tramite ADD COLUMN IF NOT EXISTS procesamiento_id INTEGER;
-- Páginas del consolidado de las que salió esta placa. Lista de enteros; null en carga manual.
ALTER TABLE flito_derechos_tramite ADD COLUMN IF NOT EXISTS paginas JSONB;

COMMENT ON COLUMN flito_derechos_tramite.archivo_origen IS
  'Nombre del archivo del que se extrajo el recibo: el consolidado del Drive o el fichero subido a mano.';
COMMENT ON COLUMN flito_derechos_tramite.procesamiento_id IS
  'Barrido del Drive que lo produjo. Null en carga manual y en los derechos anteriores a esta columna.';
COMMENT ON COLUMN flito_derechos_tramite.paginas IS
  'Páginas del consolidado correspondientes a esta placa. Null en carga manual.';

-- ON DELETE SET NULL y no CASCADE: si algún día se purga el registro de procesamientos, el derecho
-- debe sobrevivir — es el comprobante de un pago, no un detalle del barrido.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'flito_derechos_tramite_procesamiento_id_fkey'
  ) THEN
    ALTER TABLE flito_derechos_tramite
      ADD CONSTRAINT flito_derechos_tramite_procesamiento_id_fkey
      FOREIGN KEY (procesamiento_id) REFERENCES procesamiento_cuentas(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_flito_derechos_procesamiento
  ON flito_derechos_tramite (procesamiento_id);

-- NO se rellenan los derechos existentes. Los 56 que hoy vienen del Drive no son atribuibles a un
-- procesamiento concreto: en cualquier ventana de diez minutos hay tres barridos, así que
-- correlacionar por fecha sería inventar. Se quedan en null y la pantalla lo dice.

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Historial de estados de SOAT e impuestos
--
-- Los trámites tienen `flito_tramite_historial` desde el principio; SOAT e impuestos no tenían nada
-- equivalente y su rastro vivía disperso en `audit_logs`, en texto libre y sin campos de estado.
--
-- Una tabla para los dos conceptos, discriminados por `concepto`: comparten los mismos cuatro
-- estados (pendiente, solicitado, con_novedad, pagado) y las mismas transiciones, así que dos tablas
-- gemelas serían dos veces el mismo código.
--
-- Sin FK hacia flito_soat/flito_impuestos: una FK solo puede apuntar a UNA tabla, y este historial
-- sirve a dos. La integridad la da `concepto` + el filtro de los lectores.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS flito_estado_historial (
  id BIGSERIAL PRIMARY KEY,
  concepto VARCHAR(20) NOT NULL,
  registro_id UUID NOT NULL,
  -- Null en el alta: antes de existir no había estado del que venir.
  estado_anterior VARCHAR(30),
  estado_nuevo VARCHAR(30) NOT NULL,
  motivo TEXT,
  usuario_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Se copia el correo además del id: si el usuario se borra, el historial debe seguir diciendo
  -- quién lo hizo. Mismo criterio que `flito_soportes.subido_por_nombre`.
  usuario_email VARCHAR(150),
  -- 'usuario' | 'sistema' | 'auditoria'. El último marca las filas reconstruidas más abajo, para
  -- que no se confundan con las que se registraron en el momento.
  origen VARCHAR(20) NOT NULL DEFAULT 'usuario',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flito_estado_historial_registro
  ON flito_estado_historial (concepto, registro_id, created_at DESC);

COMMENT ON TABLE flito_estado_historial IS
  'Cambios de estado de SOAT e impuestos. El equivalente de flito_tramite_historial para los dos conceptos.';
COMMENT ON COLUMN flito_estado_historial.origen IS
  'usuario | sistema | auditoria. "auditoria" = fila reconstruida desde audit_logs, no registrada en el momento.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Reconstrucción del pasado desde audit_logs
--
-- El detalle de la auditoría trae la transición literal —«Envío al gestor (pendiente→solicitado).»,
-- «Impuesto creado en "pendiente" (…)»— así que se extrae con una regla fija, sin interpretar.
--
-- Tres cortafuegos: los estados tienen que estar entre los cuatro válidos, el `resource_id` tiene
-- que ser un UUID (los lotes guardaban ids unidos por comas), y el registro tiene que existir
-- todavía. Lo que no cumpla se queda fuera en silencio, que es lo correcto: es mejor un historial
-- corto y cierto que uno completo y adivinado.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO flito_estado_historial
  (concepto, registro_id, estado_anterior, estado_nuevo, motivo, usuario_id, usuario_email, origen, created_at)
SELECT r.concepto, r.rid, r.anterior, r.nuevo, r.detail, r.user_id, r.user_email, 'auditoria', r.created_at
FROM (
  SELECT
    CASE a.resource WHEN 'flito_soat' THEN 'soat' ELSE 'impuesto' END AS concepto,
    a.resource_id::uuid AS rid,
    -- Cambio de estado: «(anterior→nuevo)». Alta de impuesto: «creado en "estado"».
    (regexp_match(a.detail, '\(([a-z_]+)→([a-z_]+)\)'))[1] AS anterior,
    COALESCE(
      (regexp_match(a.detail, '\(([a-z_]+)→([a-z_]+)\)'))[2],
      (regexp_match(a.detail, 'creado en "([a-z_]+)"'))[1],
      -- El alta del SOAT no dice el estado en el texto («SOAT creado para VIN …»), pero no hace
      -- falta leerlo: el sync lo crea SIEMPRE en `pendiente` y no hay otra vía de alta
      -- (flito-sync.service.ts, `estado: EstadoSoat.PENDIENTE`). Es la única inferencia de toda la
      -- reconstrucción, y se apoya en el código, no en el texto.
      CASE WHEN a.resource = 'flito_soat' AND a.action = 'create' THEN 'pendiente' END
    ) AS nuevo,
    a.detail, a.user_id, a.user_email, a.created_at
  FROM audit_logs a
  WHERE a.resource IN ('flito_soat', 'flito_impuesto')
    AND a.action IN ('create', 'update')
    -- Un UUID y solo uno: descarta las filas de lote, que unían varios ids con comas.
    AND a.resource_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
) AS r
WHERE r.nuevo IN ('pendiente', 'solicitado', 'con_novedad', 'pagado')
  AND (r.anterior IS NULL OR r.anterior IN ('pendiente', 'solicitado', 'con_novedad', 'pagado'))
  AND (
    (r.concepto = 'soat'     AND EXISTS (SELECT 1 FROM flito_soat s      WHERE s.id = r.rid)) OR
    (r.concepto = 'impuesto' AND EXISTS (SELECT 1 FROM flito_impuestos i WHERE i.id = r.rid))
  )
  -- Idempotencia: la misma fila de auditoría no se reconstruye dos veces.
  AND NOT EXISTS (
    SELECT 1 FROM flito_estado_historial h
    WHERE h.origen = 'auditoria'
      AND h.concepto = r.concepto
      AND h.registro_id = r.rid
      AND h.created_at = r.created_at
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) Lo que `audit_logs` nunca llegó a guardar, recuperado del propio registro
--
-- Los envíos en lote auditaban con `ids.join(',')` en `resource_id`, que es varchar(50): dos UUID
-- son 73 caracteres, Postgres rechazaba el INSERT y `audit()` se tragaba el error. La operación se
-- completaba sin dejar rastro — y en esta base NO hay una sola fila de auditoría con comas, así que
-- se perdieron todas. Ocho SOAT están hoy en `solicitado` sin ninguna fila que lo cuente.
--
-- Esto no se adivina: `enviado_en`, `enviado_por_id` y `pagado_en` son columnas del registro y
-- guardan el hecho con su fecha y su autor. Se leen de ahí y no del texto de nadie.
--
-- El estado anterior sí se asume —`pendiente` antes de un envío, `solicitado` antes de un pago—
-- porque es el único camino que el dominio permite hacia cada uno.
-- ─────────────────────────────────────────────────────────────────────────────

-- SOAT: envío al gestor.
INSERT INTO flito_estado_historial
  (concepto, registro_id, estado_anterior, estado_nuevo, motivo, usuario_id, usuario_email, origen, created_at)
SELECT 'soat', s.id, 'pendiente', 'solicitado',
       'Envío al gestor (recuperado de enviado_en: la auditoría del lote no llegó a escribirse).',
       s.enviado_por_id, u.email, 'auditoria', s.enviado_en
FROM flito_soat s
LEFT JOIN users u ON u.id = s.enviado_por_id
WHERE s.enviado_en IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM flito_estado_historial h
    WHERE h.concepto = 'soat' AND h.registro_id = s.id AND h.estado_nuevo = 'solicitado'
  );

-- SOAT: pago.
INSERT INTO flito_estado_historial
  (concepto, registro_id, estado_anterior, estado_nuevo, motivo, usuario_id, usuario_email, origen, created_at)
SELECT 'soat', s.id, 'solicitado', 'pagado',
       'Pago confirmado por factura (recuperado de pagado_en).',
       NULL, NULL, 'auditoria', s.pagado_en
FROM flito_soat s
WHERE s.pagado_en IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM flito_estado_historial h
    WHERE h.concepto = 'soat' AND h.registro_id = s.id AND h.estado_nuevo = 'pagado'
  );

-- Impuestos: envío al gestor.
INSERT INTO flito_estado_historial
  (concepto, registro_id, estado_anterior, estado_nuevo, motivo, usuario_id, usuario_email, origen, created_at)
SELECT 'impuesto', i.id, 'pendiente', 'solicitado',
       'Envío al gestor (recuperado de enviado_en: la auditoría del lote no llegó a escribirse).',
       i.enviado_por_id, u.email, 'auditoria', i.enviado_en
FROM flito_impuestos i
LEFT JOIN users u ON u.id = i.enviado_por_id
WHERE i.enviado_en IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM flito_estado_historial h
    WHERE h.concepto = 'impuesto' AND h.registro_id = i.id AND h.estado_nuevo = 'solicitado'
  );

-- Impuestos: pago.
INSERT INTO flito_estado_historial
  (concepto, registro_id, estado_anterior, estado_nuevo, motivo, usuario_id, usuario_email, origen, created_at)
SELECT 'impuesto', i.id, 'solicitado', 'pagado',
       'Pago conciliado (recuperado de pagado_en).',
       NULL, NULL, 'auditoria', i.pagado_en
FROM flito_impuestos i
WHERE i.pagado_en IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM flito_estado_historial h
    WHERE h.concepto = 'impuesto' AND h.registro_id = i.id AND h.estado_nuevo = 'pagado'
  );
