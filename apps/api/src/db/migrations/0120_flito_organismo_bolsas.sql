-- 0120 — Bolsa prepago de FLIT en el Organismo de Tránsito (HU #11161, Feature #11120 §4).
--
-- Invierte el modelo del organismo. Hasta la HU #11124 su «bolsa» era una vista DERIVADA: cobrado a
-- los clientes menos pagado por FLIT, es decir una DEUDA que crecía hacia arriba. El negocio funciona
-- al revés: FLIT precarga dinero en la secretaría y ella lo consume cada vez que emite un derecho de
-- trámite. Lo que hay que poder responder es «a Medellín le quedan 8.000.000», y eso exige un saldo
-- real, no una resta calculada al vuelo.
--
-- La DEUDA no necesita tabla ni columna: es el saldo en negativo. Si el organismo siguió emitiendo
-- derechos después de agotar el saldo, ese gasto ya ocurrió; la siguiente carga lo neta sumando.
--
-- Solo el DERECHO consume esta bolsa. SOAT e impuesto llevan organismo en el libro del cliente
-- porque se gestionan ante uno, pero no salen de este saldo; trámite digital y logística son
-- honorarios de FLIT; y el GMF ya viene incluido en el total del comprobante del organismo.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001). Idempotente.

-- ─────────────────────────── Qué organismos llevan bolsa ─────────────────────
--
-- Apagado por defecto: no todas las secretarías operan con saldo prepago, y encenderlo para todas
-- llenaría el módulo de cuentas que nadie mantiene. Es una decisión por organismo, no global.
ALTER TABLE organismos_transito_config
  ADD COLUMN IF NOT EXISTS flito_lleva_bolsa boolean NOT NULL DEFAULT false;

-- ─────────────────────────── Saldo ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS flito_organismo_bolsas (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- UNIQUE: una bolsa por organismo. RESTRICT y no CASCADE porque esto es un libro contable:
  -- desactivar un organismo no puede llevarse por delante su saldo ni su histórico.
  organismo_codigo     varchar(5) NOT NULL UNIQUE
                         REFERENCES organismos_transito_config(codigo) ON DELETE RESTRICT,
  -- Denormalizado igual que flito_bolsas.saldo: sumar el libro entero en cada lectura se vuelve caro
  -- con el histórico de un año. La consistencia la da el lock de esta fila (FOR UPDATE) al escribir.
  --
  -- SIN CHECK de no negatividad, y es el punto central de la HU: el saldo negativo es el PRÉSTAMO
  -- del organismo, un estado legítimo del negocio.
  saldo                numeric(14,2) NOT NULL DEFAULT 0,
  -- Base del nivel de alerta. NULL mientras no se le haya cargado nada: distingue «sin cargas» de
  -- «saldo agotado», que no son lo mismo en el tablero.
  ultima_carga_valor   numeric(14,2),
  ultima_carga_en      timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flito_org_bolsa_ultima_carga_coherente
    CHECK ((ultima_carga_valor IS NULL) = (ultima_carga_en IS NULL))
);

-- ─────────────────────────── Libro append-only ───────────────────────────────
--
-- Mismo criterio que flito_bolsa_movimientos: nada se edita ni se borra, el valor se guarda siempre
-- positivo y la dirección la da `tipo`, y cada fila lleva su saldo_resultante para poder auditar el
-- extracto línea a línea sin recalcular nada.

CREATE TABLE IF NOT EXISTS flito_organismo_movimientos (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bolsa_id              uuid NOT NULL REFERENCES flito_organismo_bolsas(id) ON DELETE RESTRICT,
  organismo_codigo      varchar(5) NOT NULL
                          REFERENCES organismos_transito_config(codigo) ON DELETE RESTRICT,
  tipo                  varchar(10) NOT NULL,   -- 'entrada' | 'salida'
  origen                varchar(20) NOT NULL,   -- 'carga' | 'automatico'
  -- Trámite cuyo derecho originó el consumo. NULL en las cargas: el dinero entra sin trámite detrás.
  -- SET NULL y no CASCADE: borrar un trámite no puede borrar el movimiento de dinero que provocó.
  tramite_id            uuid REFERENCES flito_tramites(id) ON DELETE SET NULL,
  valor                 numeric(14,2) NOT NULL,
  saldo_resultante      numeric(14,2) NOT NULL,
  periodo               varchar(7) NOT NULL,    -- 'YYYY-MM'
  fecha                 date NOT NULL,
  observacion           text,
  soporte_id            uuid REFERENCES flito_soportes(id) ON DELETE RESTRICT,
  registrado_por_id     integer REFERENCES users(id) ON DELETE SET NULL,
  registrado_por_nombre varchar(150) NOT NULL,
  -- Anti doble consumo del sellado, igual que en la bolsa del cliente. NULL en lo que registra una
  -- persona: dos cargas iguales el mismo día son dos cargas, no un duplicado.
  llave_idempotencia    varchar(200),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flito_org_mov_valor_positivo CHECK (valor > 0),
  CONSTRAINT flito_org_mov_tipo_valido CHECK (tipo IN ('entrada', 'salida')),
  CONSTRAINT flito_org_mov_origen_valido CHECK (origen IN ('carga', 'automatico')),
  -- Una carga es dinero que entra y no cuelga de ningún trámite.
  CONSTRAINT flito_org_mov_carga_coherente
    CHECK (origen <> 'carga' OR (tipo = 'entrada' AND tramite_id IS NULL))
);

-- El libro siempre se lee por organismo y en orden cronológico.
CREATE INDEX IF NOT EXISTS idx_flito_org_mov_organismo
  ON flito_organismo_movimientos (organismo_codigo, created_at);

-- Única protección anti doble consumo. Parcial: lo que registra una persona no lleva llave.
CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_org_mov_llave
  ON flito_organismo_movimientos (llave_idempotencia)
  WHERE llave_idempotencia IS NOT NULL;

-- «¿Qué consumió este trámite?» sin barrer el libro entero; lo usa el reverso de la liquidación.
CREATE INDEX IF NOT EXISTS idx_flito_org_mov_tramite
  ON flito_organismo_movimientos (tramite_id)
  WHERE tramite_id IS NOT NULL;

-- ─────────────────────────── Migración de los pagos ya registrados ───────────
--
-- `flito_organismo_pagos` (HU #11124) registraba «cuánto le hemos pagado a este organismo». En el
-- modelo nuevo eso es exactamente una CARGA de su bolsa, así que se convierte en vez de perderse.
-- La tabla original NO se borra: es la evidencia de la que salió cada carga.

-- 1. Una bolsa por cada organismo con pagos previos.
INSERT INTO flito_organismo_bolsas (organismo_codigo, saldo)
SELECT DISTINCT p.organismo_codigo, 0
FROM flito_organismo_pagos p
ON CONFLICT (organismo_codigo) DO NOTHING;

-- 2. Si FLIT ya le transfería dinero, ese organismo opera con bolsa. Encenderlo aquí evita que la
--    migración deje cuentas con saldo pero invisibles en el módulo.
UPDATE organismos_transito_config c
SET flito_lleva_bolsa = true
WHERE EXISTS (SELECT 1 FROM flito_organismo_pagos p WHERE p.organismo_codigo = c.codigo);

-- 3. Cada pago pasa a ser una entrada, conservando valor, fecha y soporte (AC11). El
--    saldo_resultante se reconstruye como suma corrida en orden cronológico, que es lo que habría
--    quedado si las cargas se hubieran registrado con el modelo nuevo desde el principio.
--
--    La llave `carga:pago:{id}` es lo que hace idempotente esta migración: reejecutarla no duplica.
INSERT INTO flito_organismo_movimientos (
  bolsa_id, organismo_codigo, tipo, origen, valor, saldo_resultante,
  periodo, fecha, observacion, soporte_id, registrado_por_id, registrado_por_nombre,
  llave_idempotencia, created_at
)
SELECT
  b.id,
  p.organismo_codigo,
  'entrada',
  'carga',
  p.valor,
  SUM(p.valor) OVER (
    PARTITION BY p.organismo_codigo
    ORDER BY p.fecha, p.created_at, p.id
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ),
  to_char(p.fecha, 'YYYY-MM'),
  p.fecha,
  COALESCE(p.observacion, 'Migrado desde el registro de pagos al organismo (HU #11161)'),
  p.soporte_id,
  p.registrado_por_id,
  p.registrado_por_nombre,
  'carga:pago:' || p.id::text,
  p.created_at
FROM flito_organismo_pagos p
JOIN flito_organismo_bolsas b ON b.organismo_codigo = p.organismo_codigo
ON CONFLICT (llave_idempotencia) WHERE llave_idempotencia IS NOT NULL DO NOTHING;

-- 4. Saldo y última carga, recalculados DESDE EL LIBRO y no desde los pagos.
--
--    Es lo que mantiene el paso idempotente: si esta migración se reejecuta cuando ya existan
--    consumos (el backfill del histórico es otra HU), el saldo se recompone como entradas − salidas
--    en vez de volver a ponerlo en «solo cargas», que borraría el consumo ya asentado.
UPDATE flito_organismo_bolsas b
SET saldo              = COALESCE(t.saldo, 0),
    ultima_carga_valor = t.ultima_carga_valor,
    ultima_carga_en    = t.ultima_carga_en,
    updated_at         = now()
FROM (
  SELECT
    m.organismo_codigo,
    SUM(CASE WHEN m.tipo = 'entrada' THEN m.valor ELSE -m.valor END) AS saldo,
    (array_agg(m.valor ORDER BY m.created_at DESC)
       FILTER (WHERE m.origen = 'carga'))[1]                          AS ultima_carga_valor,
    MAX(m.created_at) FILTER (WHERE m.origen = 'carga')               AS ultima_carga_en
  FROM flito_organismo_movimientos m
  GROUP BY m.organismo_codigo
) t
WHERE b.organismo_codigo = t.organismo_codigo;
