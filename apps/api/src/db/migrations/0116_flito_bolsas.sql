-- 0116 — Bolsas prepago del cliente y sus movimientos (HU #11121, Feature #11120 §2.1).
--
-- Una bolsa por cliente: un saldo prepago del que se descuentan los conceptos gestionados en los
-- organismos. Esta migración trae el esquema y las ENTRADAS (recargas). Las salidas automáticas
-- las engancha la HU #11122 al sellado de la liquidación.
--
-- El saldo vive DENORMALIZADO en flito_bolsas y cada movimiento guarda además su saldo_resultante.
-- No es redundancia gratuita: sumar todos los movimientos en cada lectura se vuelve caro con el
-- histórico de un año, y el saldo resultante por fila permite auditar el extracto línea a línea sin
-- recalcular nada (AC5). La consistencia la garantiza el lock de la fila de la bolsa al escribir.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001). Idempotente.

CREATE TABLE IF NOT EXISTS flito_bolsas (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- UNIQUE: la bolsa es UNA sola por cliente (Feature §3). El consumo se reparte entre organismos
  -- por movimiento, no abriendo una bolsa por OT.
  --
  -- RESTRICT y no CASCADE: esto es un libro contable, no configuración. Borrar un cliente no puede
  -- llevarse por delante su saldo y su histórico (retención contable de 10 años). Es el criterio de
  -- flito_liquidaciones, que tampoco cascadea desde clients; en el repo los clientes se desactivan
  -- con `active`, no se borran.
  compania_id            integer NOT NULL UNIQUE REFERENCES clients(id) ON DELETE RESTRICT,
  saldo                  numeric(14,2) NOT NULL DEFAULT 0,
  -- Base del nivel de riesgo (HU #11125): normal > 30 %, bajo <= 30 %, crítico <= 10 % de la última
  -- recarga. NULL mientras el cliente no haya recargado nunca: ahí no hay nivel que calcular, y es
  -- la diferencia entre «sin recargas» y «agotada».
  ultima_recarga_valor   numeric(14,2),
  ultima_recarga_en      timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- El saldo SÍ puede ser negativo (decisión de negocio del refinamiento): si el organismo aprobó,
  -- el gasto ya ocurrió y bloquearlo desalinearía el sistema de la realidad. Por eso no hay CHECK
  -- sobre `saldo`.
  CONSTRAINT flito_bolsas_ultima_recarga_coherente
    CHECK ((ultima_recarga_valor IS NULL) = (ultima_recarga_en IS NULL))
);

-- Libro append-only. Nada se edita ni se borra: una corrección es otro movimiento (HU #11123).
CREATE TABLE IF NOT EXISTS flito_bolsa_movimientos (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bolsa_id                uuid NOT NULL REFERENCES flito_bolsas(id) ON DELETE RESTRICT,
  -- Redundante con bolsa_id, pero el extracto filtra y agrupa por cliente en casi toda consulta y
  -- el join extra no aporta nada.
  compania_id             integer NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  tipo                    varchar(10) NOT NULL,   -- 'entrada' | 'salida'
  origen                  varchar(20) NOT NULL,   -- 'recarga' | 'automatico' | 'manual'
  -- Las cuatro columnas siguientes son NULL en una recarga: el dinero entra a la bolsa del cliente
  -- sin pasar por un organismo ni por un trámite. Las llenan las salidas de la HU #11122.
  concepto                varchar(30),            -- 'derecho' | 'soat' | 'impuesto' | 'tramite_digital' | 'logistica' | 'gmf' (HU #11160)
  organismo_codigo        varchar(5) REFERENCES organismos_transito_config(codigo),
  tramite_id              uuid REFERENCES flito_tramites(id) ON DELETE SET NULL,
  -- El valor es SIEMPRE positivo; la dirección la da `tipo`. Guardar salidas en negativo obligaría
  -- a recordar el signo en cada suma del extracto.
  valor                   numeric(14,2) NOT NULL,
  saldo_resultante        numeric(14,2) NOT NULL,
  -- Periodo contable 'YYYY-MM' al que se imputa. Lo usa el cierre mensual (HU #11126); se guarda
  -- explícito para que un movimiento rezagado pueda imputarse a un periodo distinto al de su fecha.
  periodo                 varchar(7) NOT NULL,
  fecha                   date NOT NULL,
  observacion             text,
  -- RESTRICT: una entrada de dinero no puede quedarse sin su comprobante. Si hay que retirar un
  -- soporte, primero se corrige el movimiento (HU #11123), no al revés.
  soporte_id              uuid REFERENCES flito_soportes(id) ON DELETE RESTRICT,
  registrado_por_id       integer REFERENCES users(id) ON DELETE SET NULL,
  -- Se copia el nombre además del id: si el usuario se borra, el libro debe seguir diciendo quién
  -- movió el dinero. Mismo criterio que flito_soportes.subido_por_nombre.
  registrado_por_nombre   varchar(150) NOT NULL,
  -- Anti doble cobro de las salidas automáticas (HU #11122). NULL en lo que registra una persona:
  -- dos recargas iguales el mismo día son dos recargas, no un duplicado.
  llave_idempotencia      varchar(200),
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flito_bolsa_mov_tipo_valido   CHECK (tipo IN ('entrada', 'salida')),
  CONSTRAINT flito_bolsa_mov_origen_valido CHECK (origen IN ('recarga', 'automatico', 'manual')),
  CONSTRAINT flito_bolsa_mov_valor_positivo CHECK (valor > 0),
  CONSTRAINT flito_bolsa_mov_periodo_formato CHECK (periodo ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  -- Una recarga es dinero que entra y no pertenece a ningún concepto ni organismo.
  CONSTRAINT flito_bolsa_mov_recarga_es_entrada
    CHECK (origen <> 'recarga' OR (tipo = 'entrada' AND concepto IS NULL AND tramite_id IS NULL))
);

-- El extracto del cliente siempre se lee en orden cronológico.
CREATE INDEX IF NOT EXISTS idx_flito_bolsa_mov_compania
  ON flito_bolsa_movimientos (compania_id, created_at);

-- Cierre mensual y consolidados por periodo.
CREATE INDEX IF NOT EXISTS idx_flito_bolsa_mov_periodo
  ON flito_bolsa_movimientos (compania_id, periodo);

-- Extracto por organismo (bolsa simbólica, HU #11124). Parcial: las recargas no tienen organismo.
CREATE INDEX IF NOT EXISTS idx_flito_bolsa_mov_organismo
  ON flito_bolsa_movimientos (organismo_codigo, concepto)
  WHERE organismo_codigo IS NOT NULL;

-- Índice parcial en vez de UNIQUE de columna: en un UNIQUE normal NULL no colisiona con NULL, pero
-- tampoco queremos que la llave sea obligatoria. Lo usa la HU #11122 para no cobrar dos veces.
CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_bolsa_mov_llave
  ON flito_bolsa_movimientos (llave_idempotencia)
  WHERE llave_idempotencia IS NOT NULL;
