-- 0141_siigo_factura_envios.sql
-- Feature #11243 — Entrega y seguimiento de la factura electrónica. HU #11334.
-- Autor: equipo FLITO. Motivo: registrar a quién y cuándo se envió cada factura, y el reenvío.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- ============================================================================
-- QUÉ REGISTRA Y QUÉ NO
-- ============================================================================
--
-- El correo lo envía **Siigo**, no FLITO. Esta tabla no es una cola de salida: no hay nada que un
-- worker nuestro tenga que despachar. Es el acta de lo que le pedimos a Siigo y de lo que contestó.
-- Por eso no toca `notification_outbox` —que es para los correos que enviamos nosotros— y por eso
-- una fila aquí no significa que el cliente haya leído nada, solo que Siigo aceptó enviarlo.
--
-- LOS TRES ESTADOS SON TRES, NO DOS
--
-- `enviado` / `fallido` / `no_realizado`. El tercero es el AC3 entero: un cliente sin correo en su
-- ficha nunca llegó a salir, así que no hay cuota gastada ni nada que reintentar — hay un dato que
-- falta y una persona que debe completarlo. Si `no_realizado` cayera en el cajón de `fallido`, la
-- bandeja invitaría a reintentar algo que va a volver a no salir, indefinidamente.
--
-- POR QUÉ `siigo_facturas` NO GANA NINGUNA COLUMNA
--
-- «¿Se envió?» es una consecuencia de que existan filas aquí, no un estado que alguien tenga que
-- mantener sincronizado. Un `enviada boolean` en la factura habría que actualizarlo en cada
-- reenvío, y un flag que se olvida de actualizarse es exactamente la suposición que esta historia
-- viene a eliminar. Además el AC4 exige que el envío anterior se CONSERVE: eso es una tabla de
-- filas, no una columna que se pisa.
--
-- ============================================================================
-- CORREOS, LEY 1581 Y POR QUÉ EL APPEND-ONLY AQUÍ TIENE UNA PUERTA
-- ============================================================================
--
-- Aquí se guardan direcciones de correo, que son datos personales. Chocan dos cosas legítimas:
--
--   * El registro debe ser **inalterable**, o no prueba nada. Un acta de entrega que se puede
--     reescribir no sirve para responder «no me llegó».
--   * El titular puede pedir **supresión** (Ley 1581), y FLITO ya tiene un flujo de olvido que
--     cubre 14 tablas. Una tabla nueva con PII que quede fuera de ese flujo es un agujero.
--
-- La salida NO es elegir una: es separar el HECHO del DATO PERSONAL. Que hubo un envío, cuándo,
-- con qué resultado y a petición de quién es inmutable para siempre. Las direcciones concretas se
-- pueden redactar sin borrar el hecho — queda `[]` y la marca `destinatarios_purgados_en`, de modo
-- que la fila sigue diciendo «se envió a 2 direcciones el día X», que es lo que prueba la entrega,
-- sin conservar cuáles eran.
--
-- El disparador de abajo permite EXACTAMENTE esa transición y ninguna otra. No es un append-only
-- con una excepción cómoda: cualquier UPDATE que toque cualquier otra columna, o que intente
-- rellenar destinatarios en vez de vaciarlos, o que despurgue una fila ya purgada, sigue muriendo
-- con el mismo error que en `siigo_operaciones` (0126) y `siigo_factura_correcciones` (0140).
--
-- Sin esta puerta, la única forma de atender un derecho de supresión sería un DELETE administrativo
-- fuera de la aplicación — es decir, sin rastro y sobre la fila entera. Peor en las dos mitades.

CREATE TABLE IF NOT EXISTS siigo_factura_envios (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT y no CASCADE, porque RESTRICT es lo que de verdad ocurre: un CASCADE dispararía el
  -- BEFORE DELETE de estas actas, que levanta excepción, y el borrado de la factura fallaría con un
  -- error que nombra otra tabla. Decir aquí lo que pasa evita una hora de depuración a quien lo lea.
  factura_id     uuid NOT NULL REFERENCES siigo_facturas(id) ON DELETE RESTRICT,

  -- 'emision'  = el correo que Siigo manda solo porque la creación se lo pidió (`mail: true`).
  -- 'reenvio'  = el que pide una persona desde FLITO.
  -- Registrar el primero es el AC7: si no, el envío que el cliente de verdad recibe —el primero—
  -- sería justo el único invisible en el historial.
  origen         varchar(12) NOT NULL,
  resultado      varchar(16) NOT NULL,

  -- [{ "correo": "...", "origen": "compania" }]. Con la PROCEDENCIA de cada dirección, no solo la
  -- dirección: es lo que hace auditable el AC2 y lo que permitirá responder con datos, y no con
  -- opiniones, si algún día se decide añadir el contacto fiscal como destinatario.
  destinatarios  jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Cuándo se redactaron las direcciones por un derecho de supresión. NULL = nunca se ha purgado.
  destinatarios_purgados_en timestamptz,

  -- Qué contestó Siigo, o por qué no se llegó a llamar. Nombre de motivo en `codigo`, texto para
  -- una persona en `motivo`.
  codigo         varchar(60),
  motivo         text,

  -- NULL cuando el envío lo originó la emisión: ahí no hay una persona que lo pidiera.
  solicitado_por integer REFERENCES users(id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT siigo_envio_origen_chk    CHECK (origen IN ('emision', 'reenvio')),
  CONSTRAINT siigo_envio_resultado_chk CHECK (resultado IN ('enviado', 'fallido', 'no_realizado')),
  -- El tope es de Siigo (§3 de la documentación), no una preferencia nuestra. Vive también en la
  -- base porque una constante de TypeScript no protege de un INSERT hecho desde otro sitio.
  CONSTRAINT siigo_envio_destinatarios_arr_chk CHECK (jsonb_typeof(destinatarios) = 'array'),
  CONSTRAINT siigo_envio_destinatarios_tope_chk CHECK (jsonb_array_length(destinatarios) <= 5),
  -- Un envío que dice haber salido tiene que decir a dónde. La excepción es una fila ya purgada:
  -- ahí el vacío significa «se borraron», no «no había».
  CONSTRAINT siigo_envio_enviado_con_destino_chk CHECK (
    resultado <> 'enviado'
    OR jsonb_array_length(destinatarios) > 0
    OR destinatarios_purgados_en IS NOT NULL
  ),
  -- Lo que no salió tiene que decir por qué. Es la mitad accionable del AC3.
  CONSTRAINT siigo_envio_no_realizado_chk CHECK (
    resultado <> 'no_realizado' OR codigo IS NOT NULL
  )
);

-- «¿Qué envíos tiene esta factura?», el más reciente primero. Es la consulta del AC4 y la única
-- que hace la pantalla.
CREATE INDEX IF NOT EXISTS idx_siigo_envios_factura
    ON siigo_factura_envios (factura_id, created_at DESC);

-- «¿Qué queda por purgar de este titular?» — recorrido del flujo de olvido. Parcial porque solo
-- interesan las filas que todavía conservan direcciones.
CREATE INDEX IF NOT EXISTS idx_siigo_envios_sin_purgar
    ON siigo_factura_envios (factura_id)
 WHERE destinatarios_purgados_en IS NULL AND jsonb_array_length(destinatarios) > 0;

-- «¿Qué actas mencionan ESTA dirección?» — el segundo camino de la purga. Buscar solo por la
-- compañía de la factura deja fuera las actas de trámites sin empresa resuelta y los destinatarios
-- escritos a mano en la factura de un tercero: en ambos casos el titular pediría supresión y se le
-- diría que se hizo. GIN con `jsonb_path_ops`, que es el operador `@>` y nada más — la mitad de
-- tamaño que el GIN por defecto, y aquí no se consulta por clave suelta.
CREATE INDEX IF NOT EXISTS idx_siigo_envios_destinatarios
    ON siigo_factura_envios USING gin (destinatarios jsonb_path_ops);

-- ── Append-only con puerta de redacción ─────────────────────────────────────
--
-- Mismo mecanismo que 0126 y 0140. Función propia y no reutilizada: el mensaje nombra a ESTA tabla,
-- y quien lo lea en un log tiene que saber cuál se intentó tocar.

CREATE OR REPLACE FUNCTION fn_siigo_envios_worm()
RETURNS trigger
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- La única mutación admitida: vaciar las direcciones y marcar cuándo se hizo. Se comprueba
    -- columna por columna en vez de con `row(NEW) IS DISTINCT FROM row(OLD)` porque una columna
    -- nueva en el futuro debe entrar por esta lista a mano — un olvido tiene que romper el test,
    -- no colarse en la puerta.
    IF NEW.id = OLD.id
       AND NEW.factura_id     = OLD.factura_id
       AND NEW.origen         = OLD.origen
       AND NEW.resultado      = OLD.resultado
       AND NEW.created_at     = OLD.created_at
       AND NEW.codigo         IS NOT DISTINCT FROM OLD.codigo
       AND NEW.motivo         IS NOT DISTINCT FROM OLD.motivo
       AND NEW.solicitado_por IS NOT DISTINCT FROM OLD.solicitado_por
       -- Solo se vacía. Nunca se rellena ni se sustituye por otras direcciones.
       AND NEW.destinatarios = '[]'::jsonb
       -- Y solo se purga lo que aún no estaba purgado: una fila redactada no se vuelve a tocar.
       AND OLD.destinatarios_purgados_en IS NULL
       AND NEW.destinatarios_purgados_en IS NOT NULL
       -- Y con fecha creíble. Sin esto se podría fechar la purga en 1999 o en 2099 sobre un
       -- registro que se presenta como prueba: la fecha es parte de lo que el acta afirma.
       AND NEW.destinatarios_purgados_en <= now()
    THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'siigo_factura_envios es append-only (solo se admite purgar destinatarios): % no permitido',
    TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_siigo_envios_no_update ON siigo_factura_envios;
CREATE TRIGGER trg_siigo_envios_no_update BEFORE UPDATE ON siigo_factura_envios
  FOR EACH ROW EXECUTE FUNCTION fn_siigo_envios_worm();

DROP TRIGGER IF EXISTS trg_siigo_envios_no_delete ON siigo_factura_envios;
CREATE TRIGGER trg_siigo_envios_no_delete BEFORE DELETE ON siigo_factura_envios
  FOR EACH ROW EXECUTE FUNCTION fn_siigo_envios_worm();

-- TRUNCATE no dispara los triggers de FILA: sin este, el append-only tiene una puerta trasera que
-- vacía la tabla entera de una sentencia. La función sirve tal cual porque levanta excepción para
-- cualquier TG_OP que no sea la purga. Es `FOR EACH STATEMENT` porque TRUNCATE no tiene filas.
DROP TRIGGER IF EXISTS trg_siigo_envios_no_truncate ON siigo_factura_envios;
CREATE TRIGGER trg_siigo_envios_no_truncate BEFORE TRUNCATE ON siigo_factura_envios
  FOR EACH STATEMENT EXECUTE FUNCTION fn_siigo_envios_worm();

-- Endurecimiento por ownership, igual que en 0126 y 0140. El guard existe porque en docker-compose
-- el POSTGRES_USER es `operaciones_app` y no hay ningún rol `postgres`: sin él la cadena moriría con
-- `role "postgres" does not exist`. Los disparadores sí se crean siempre.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    ALTER TABLE siigo_factura_envios OWNER TO postgres;
    ALTER FUNCTION fn_siigo_envios_worm() OWNER TO postgres;
  END IF;
END $$;

-- SELECT + INSERT + UPDATE. El UPDATE está aquí solo para que el flujo de olvido pueda purgar; lo
-- que ese UPDATE puede hacer lo decide el disparador, no este GRANT. NO DELETE, NO TRUNCATE.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operaciones_app') THEN
    GRANT SELECT, INSERT, UPDATE ON siigo_factura_envios TO operaciones_app;
  END IF;
END $$;

COMMENT ON TABLE siigo_factura_envios IS
  'Acta de entrega por correo de cada factura (HU #11334). Append-only; la única mutación admitida '
  'es redactar los destinatarios por un derecho de supresión, conservando el hecho del envío.';
COMMENT ON COLUMN siigo_factura_envios.origen IS
  'emision = correo que Siigo mandó solo al crear la factura (mail: true); reenvio = lo pidió una persona.';
COMMENT ON COLUMN siigo_factura_envios.destinatarios IS
  'Array [{correo, origen}]. La procedencia de cada dirección es lo que hace auditable la resolución.';
COMMENT ON COLUMN siigo_factura_envios.destinatarios_purgados_en IS
  'Cuándo se redactaron las direcciones por Ley 1581. NULL = nunca. El hecho del envío se conserva.';
