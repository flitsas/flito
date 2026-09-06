-- 0176_flito_soat_retirar_estados_revision.sql
-- Feature #12074 — El canal Cliente del SOAT deja de pasar por la revisión de Operaciones.
-- HU #12080 (retirar del backend el circuito que quedó sin usuarios, incluido el modelo de datos).
-- Autor: equipo FLITO. Antecedentes: ADR-0008 §2/§6/§8 (que es lo que esta migración deroga),
-- migraciones 0167 (creó los dos estados y las dos tablas) y 0170 (sembró el catálogo).
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo con `sql.begin()`,
-- `src/scripts/db-apply.ts`). Eso importa aquí más que de costumbre: el guarda del paso 1 aborta con
-- RAISE EXCEPTION, y como la transacción es del runner el abort deshace TODO el archivo y no marca
-- la migración como aplicada. No queda un enum recreado a medias ni una tabla borrada sin su
-- columna.
--
-- Ningún comentario de este archivo escribe el par de dólares que abre un bloque (lección de la
-- 0156, repetida en la cabecera de la 0167): el guarda `scanForTxControl` tapa los bloques citados
-- con dólares ANTES de quitar los comentarios, así que un par suelto dentro de un `--` emparejaría
-- con el que abre el bloque de abajo y dejaría su contenido a la intemperie.
--
-- ============================================================================
-- QUÉ HACE, Y POR QUÉ ES UNA MIGRACIÓN Y NO SOLO CÓDIGO
-- ============================================================================
--
--   1. Guarda: si queda alguna fila en `pendiente_revision` o `rechazada`, ABORTA.
--   2. RECREA `flito_soat_estado` sin esos dos valores (PostgreSQL no sabe quitarlos en sitio).
--   3. Borra `flito_soat_solicitud.causal_rechazo_id` y `.observacion_rechazo`.
--   4. Borra `flito_soat_causales_rechazo`, el catálogo que la 0170 sembró.
--
-- El código ya no escribe ninguno de esos valores ni esas columnas —las HU #12078 y #12079 dejaron
-- el alta despachando al gestor y la pantalla de revisión retirada—, pero mientras el TIPO los
-- admita el sistema sigue teniendo dos estados alcanzables por cualquier `UPDATE` a mano y por
-- cualquier `?estado=` que llegue de un enlace guardado. Un ciclo se retira en la base o no se
-- retira.
--
-- ============================================================================
-- LA DECISIÓN DE PII: `observacion_rechazo` SE SUPRIME, NO SE ARCHIVA
-- ============================================================================
--
-- `observacion_rechazo` es TEXTO LIBRE escrito por un empleado de FLIT sobre el caso de un tercero:
-- puede nombrar al propietario del vehículo, su documento o su placa. No hay forma de saber qué
-- contiene cada fila sin leerlas, y leerlas sería exactamente el acceso que no queremos multiplicar.
--
-- **Se suprime con la columna, sin exportar ni archivar**, y esa es la decisión por defecto de esta
-- HU. Un volcado a CSV «por si acaso» crearía una copia de datos personales fuera de la base, sin
-- retención, sin control de acceso y sin nadie que responda por ella: sería más exposición, no
-- menos. La supresión es lo que el principio de minimización pide cuando la finalidad —revisar una
-- solicitud— deja de existir.
--
-- Si el PO quisiera lo contrario, esa decisión tendría que tomarse **ANTES de aplicar** esta
-- migración: una vez aplicada, la columna no está y no hay de dónde sacarla salvo un backup.
--
-- El paso 3 emite un RAISE NOTICE con cuántas observaciones se van a suprimir, para que el log del
-- CD deje constancia del volumen exacto (el CD aplica las migraciones y loguea su salida).
--
-- ============================================================================
-- SEGUNDA PASADA
-- ============================================================================
--
-- El archivo se puede aplicar dos veces (P6). La recreación del enum lo es por construcción —la
-- segunda vez recrea un tipo que ya tiene los cuatro valores— y los tres DROP llevan `IF EXISTS`.
-- Lo único que la segunda pasada hace de más es reescribir físicamente `flito_soat` por el
-- `ALTER COLUMN ... TYPE`: ni una fila cambia de valor.
--
-- ============================================================================
-- LO QUE ESTA MIGRACIÓN NO HACE, A PROPÓSITO
-- ============================================================================
--
--   · **Ningún `UPDATE` de saneo.** Mover las filas atascadas a `pendiente` o a `solicitado` sería
--     decidir por el negocio a dónde va cada solicitud de un cliente real, en silencio y sin
--     rastro. Por eso el paso 1 aborta y nombra el recuento: resolverlas es un acto humano, con la
--     versión ANTERIOR del API todavía desplegada, que es la única que tiene las rutas para hacerlo.
--   · **Ningún `DELETE` sobre `flito_estado_historial`.** Sus columnas de estado son `varchar(30)`,
--     no este enum, así que no bloquean el DROP TYPE: no hay ninguna necesidad técnica. Y borrarlas
--     destruiría la trazabilidad del período en que el circuito existió, que es justo lo que un
--     historial existe para conservar.
--   · **Ningún `CASCADE`.** Ver el paso 4.

-- ── 1. Guarda: nada vivo en los dos estados que se retiran ──────────────────
--
-- La comparación es por `estado::text` y no `estado = 'pendiente_revision'`. Es deliberado y es lo
-- que hace que este bloque se pueda ejecutar DOS VECES: comparar contra un literal exige que el
-- valor exista en el tipo, así que en la segunda pasada —con el tipo ya recreado— el literal sería
-- un `22P02 invalid input value for enum` y el archivo moriría por el guarda en vez de por lo que
-- comprueba. Por texto no depende del tipo en absoluto.
--
-- El mensaje nombra cuántas hay DE CADA UNA y el total: «hay filas atascadas» no le dice a nadie si
-- son dos que se pueden llamar por teléfono o doscientas que son un problema de proceso.
DO $guarda$
DECLARE
  n_pendiente_revision bigint;
  n_rechazada          bigint;
BEGIN
  SELECT
    count(*) FILTER (WHERE estado::text = 'pendiente_revision'),
    count(*) FILTER (WHERE estado::text = 'rechazada')
    INTO n_pendiente_revision, n_rechazada
  FROM flito_soat;

  IF (n_pendiente_revision + n_rechazada) > 0 THEN
    RAISE EXCEPTION
      'No se puede retirar la revisión del canal Cliente: quedan % solicitudes en estados que esta migración elimina (pendiente_revision: %, rechazada: %). Resuélvelas con la versión ANTERIOR del API —que todavía tiene POST /:id/validar, POST /:id/rechazar-solicitud y PATCH /:id/solicitud— y vuelve a aplicar. Esta migración NO decide por el negocio a dónde va cada una.',
      n_pendiente_revision + n_rechazada, n_pendiente_revision, n_rechazada;
  END IF;
END
$guarda$;

-- ── 2 y 3. El enum, recreado sin los dos valores ────────────────────────────
--
-- PostgreSQL no permite quitar un valor de un ENUM en uso: hay que renombrar el tipo, crear el
-- nuevo, recastear la columna y borrar el viejo. Es exactamente lo que la 0101 hizo con ESTE MISMO
-- tipo (`0101_flito_estados_4.sql:11-16`), y este bloque está calcado de allí.
--
-- **El `DROP DEFAULT` va PRIMERO y no es cosmético.** La expresión por defecto de la columna es
-- `'pendiente'::flito_soat_estado` y queda ligada al tipo VIEJO en cuanto este se renombra.
--
-- MEDIDO sobre la BD local, quitando esta línea y dejando el resto igual: falla el `ALTER COLUMN ...
-- TYPE` —no el `DROP TYPE` del final— con
--
--     ERROR: 42804: default for column "estado" cannot be cast automatically to type flito_soat_estado
--
-- Se deja escrito el error EXACTO porque la suposición cómoda es la otra (que el estorbo aparece al
-- soltar el tipo viejo, con un 2BP01) y no es la que ocurre: PostgreSQL se planta un paso antes,
-- cuando intenta recastear el default junto con la columna. El default se vuelve a poner tres líneas
-- más abajo, ya contra el tipo nuevo.
--
-- El `USING estado::text::flito_soat_estado` no puede fallar por datos: el paso 1 acaba de
-- garantizar que no queda ninguna fila con un valor que el tipo nuevo no tenga.
ALTER TABLE flito_soat ALTER COLUMN estado DROP DEFAULT;
ALTER TYPE flito_soat_estado RENAME TO flito_soat_estado_old;
CREATE TYPE flito_soat_estado AS ENUM ('pendiente', 'solicitado', 'con_novedad', 'pagado');
ALTER TABLE flito_soat ALTER COLUMN estado TYPE flito_soat_estado USING estado::text::flito_soat_estado;
ALTER TABLE flito_soat ALTER COLUMN estado SET DEFAULT 'pendiente';
DROP TYPE flito_soat_estado_old;

-- ── 3. Cuánta PII se suprime, al log del CD ─────────────────────────────────
--
-- Va inmediatamente ANTES del DROP y no en el guarda del paso 1: si aquel aborta no se suprime
-- nada y el aviso habría sido falso.
--
-- **Y aquí, pasado el guarda, un `n > 0` significa MÁS que un volumen.** Es la señal de que alguien
-- escribió por fuera de la aplicación. La observación solo la escribía el rechazo del admin, que la
-- guardaba y movía el estado a `rechazada` en la MISMA transacción; `reversar()` prohibía salir de
-- ese estado y entrar en él, y ninguna migración movió `estado` por su cuenta. Así que una fila con
-- `observacion_rechazo` no nula y el estado FUERA de los dos que el paso 1 acaba de descartar no la
-- pudo dejar ningún camino del código: es un UPDATE a mano contra la base.
--
-- No se convierte en un segundo guarda que aborte, y es decisión tomada (`db-review`): abortar por
-- ese caso dejaría al operador con un mensaje que le manda a las rutas de la revisión, y esas rutas
-- no podrían tocar una fila huérfana como esa. El NOTICE deja el rastro en el log del CD, que es lo
-- que permite ir a mirarlo; la decisión de qué hacer con ella no es de esta migración.
--
-- La consulta vive dentro del `IF EXISTS` porque plpgsql no resuelve las referencias a columnas
-- hasta que la sentencia se EJECUTA: en la segunda pasada la rama no se toma y la columna ausente
-- no es un 42703.
DO $pii$
DECLARE
  n_observaciones bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'flito_soat_solicitud'
      AND column_name = 'observacion_rechazo'
  ) THEN
    SELECT count(*) INTO n_observaciones
    FROM flito_soat_solicitud
    WHERE observacion_rechazo IS NOT NULL;
    RAISE NOTICE 'HU #12080: se suprimen % observaciones de rechazo (texto libre escrito sobre el caso de un tercero). La decisión de PII está en la cabecera de esta migración: se suprimen, no se exportan.', n_observaciones;
  ELSE
    RAISE NOTICE 'HU #12080: observacion_rechazo ya no existe; no hay nada que suprimir.';
  END IF;
END
$pii$;

-- ── 4. Las dos columnas del rechazo, y DESPUÉS el catálogo ──────────────────
--
-- El orden importa y es el único correcto: `causal_rechazo_id` tiene una FK contra
-- `flito_soat_causales_rechazo`, así que la tabla no se puede borrar mientras la columna exista.
--
-- **Sin `CASCADE`, y esa es la decisión.** `DROP TABLE ... CASCADE` funcionaría en una línea y
-- borraría la columna EN SILENCIO, como efecto colateral: la migración diría «borro un catálogo»
-- mientras además suprime una columna de texto libre con datos personales de terceros. Nombrar los
-- dos DROP por separado es lo que hace que este archivo diga lo que hace. Y si algún día apareciera
-- otro objeto dependiente que nadie previó, sin CASCADE la migración FALLA y alguien lo mira; con
-- CASCADE se lo lleva por delante.
--
-- `idx_flito_soat_solicitud_causal` no necesita un DROP propio: el índice cae con su columna.
--
-- `IF EXISTS` en los tres: es lo que hace que la segunda pasada no muera con un 42703/42P01. No
-- oculta nada —lo que se borra sigue nombrado uno por uno— y no es lo mismo que un CASCADE, que
-- borraría objetos que este archivo no nombra.
ALTER TABLE flito_soat_solicitud
  DROP COLUMN IF EXISTS causal_rechazo_id,
  DROP COLUMN IF EXISTS observacion_rechazo;

DROP TABLE IF EXISTS flito_soat_causales_rechazo;

-- ── 5. Los comentarios que tienen que seguir siendo verdad ──────────────────
--
-- Son DOS y no uno. El de la tabla es el evidente; el de la COLUMNA `flito_soat.origen` se escapa
-- con facilidad porque lo fijó otra migración —la 0167, en su paso 4— y vive en la base desde
-- entonces sin que nada en este repo lo vuelva a nombrar. Dice, literalmente, que «la PII del
-- propietario y el detalle del rechazo viven fuera (flito_compradores y flito_soat_solicitud)», y
-- tras esta migración NO hay ningún detalle del rechazo en `flito_soat_solicitud`.
--
-- Se refresca aquí por el mismo criterio que la tabla, y merece decirse por qué importa más de lo
-- que parece: ese comentario no es prosa decorativa, es la explicación de POR QUÉ `origen` es la
-- única columna del canal en `flito_soat` —porque `buscarConAcceso()` sirve la fila entera al gestor
-- del proveedor—. Un `COMMENT` que sigue justificando una decisión de exposición citando datos que
-- ya no existen es exactamente lo que hace que la próxima revisión valide el reparto por una razón
-- caducada. `COMMENT ON` reescribe, así que no hace falta borrar antes ni hay nada que sea
-- idempotente aquí: la segunda pasada deja el mismo texto.
COMMENT ON TABLE flito_soat_solicitud IS
  'Satélite 1:1 de flito_soat con lo que solo existe cuando el SOAT nació del canal Cliente: quién lo radicó, cuándo, y el desenlace de la consulta al RUNT del alta. Las columnas revisado_por_id / revisado_por_nombre / revisado_en y el contador reenvios son el rastro de la revisión de Operaciones que existió entre las migraciones 0167 y 0176; desde la HU #12080 no las escribe nadie y se conservan por trazabilidad. La causal y la observación del rechazo se retiraron con esa misma HU (Feature #12074), junto a la tabla flito_soat_causales_rechazo.';

COMMENT ON COLUMN flito_soat.origen IS
  'De qué puerta salió esta fila (Feature #11912): tramite = el sync de FLIT (la única que existía hasta la 0167, y de ahí el DEFAULT); cliente = una compañía la pidió sin trámite digital. Es la ÚNICA columna del canal Cliente en esta tabla, a propósito: buscarConAcceso() hace select de la fila entera y la sirve a las rutas del gestor del proveedor, así que la PII del propietario vive fuera, en flito_compradores. El detalle del rechazo que este comentario nombraba también vivía fuera, en flito_soat_solicitud, y desde la migración 0176 (HU #12080) ya no existe: se retiró la revisión de Operaciones del canal. varchar + CHECK y no un enum: ampliarlo es un DROP/ADD CONSTRAINT barato, mientras que un enum arrastraría a cada migración futura la trampa del 55P04 que el Feature #11912 pagó dos veces.';
