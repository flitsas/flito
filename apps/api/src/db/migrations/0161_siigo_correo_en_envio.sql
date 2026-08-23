-- 0161_siigo_correo_en_envio.sql
-- HU #11708 (Feature #11243) — el correo al cliente se ELIGE en el envío, y a qué direcciones.
-- Autor: equipo FLITO. Motivo: el ambiente no puede seguir siendo quien decide a quién se le manda.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- ============================================================================
-- QUÉ CAMBIA
-- ============================================================================
--
-- Hasta hoy, que la factura saliera por correo se DEDUCÍA del ambiente: `efectosExternosPermitidos`
-- decidía —producción sí, el resto no— y ese booleano bajaba al armador como `mail: true`. Nadie
-- podía decidirlo factura a factura, y el día que un caso pedía otra cosa no había dónde decirlo.
--
-- A partir de esta historia es una elección del envío, y viaja con el LOTE por el mismo motivo que
-- los conceptos (A1) y la emisión elegida (A2): **el envío solo encola**. La emisión ocurre después,
-- en el cron y en otro proceso, así que sin snapshot habría que volver a deducirla —y saldría una
-- factura que nadie pidió, o no saldría el correo que sí se pidió.
--
-- **La elección NO sustituye al filtro del ambiente: se multiplica por él.** Es un Y y nunca un O.
-- La elección puede apagar el correo en producción; no puede encenderlo fuera de ella. Un «reenviar»
-- desde pruebas manda una factura de ensayo a un cliente REAL, y eso no se deshace desde aquí.
-- La regla vive en el código (`decidirCorreoDeEmision`), no en un CHECK: la columna guarda lo que la
-- persona eligió, que es un hecho, y el filtro se aplica al usarla.
--
-- ============================================================================
-- POR QUÉ LAS DIRECCIONES SE GUARDAN AQUÍ, Y QUÉ OBLIGA ESO
-- ============================================================================
--
-- `correo_destinatarios` es un dato personal (Ley 1581) en una tabla que hasta hoy no tenía ninguno.
-- No hay forma de evitarlo si las direcciones elegidas deben mandar sobre las de la ficha: entre el
-- clic y la emisión pasan minutos y un proceso distinto, y la ficha del cliente pudo cambiar.
--
-- La consecuencia se asume entera: **toda dirección que este programa guarda tiene que estar al
-- alcance de la purga por derecho de supresión**. `purgarDestinatariosDeLotes` limpia esta columna
-- en el mismo flujo y la misma transacción que ya redacta las actas de `siigo_factura_envios`. Sin
-- eso quedaría una copia inalcanzable, que es exactamente lo que el acta existe para no tener.
--
-- Vaciarla deja `correo_solicitado = true`, y lo que pasa entonces DEPENDE DE POR QUÉ se purgó. La
-- primera versión de este párrafo decía que el lote «cae al camino de la ficha del cliente, que para
-- entonces también está anonimizada», y eso solo es cierto por uno de los dos caminos:
--
--   · Purgado por la rama de COMPAÑÍA —el titular es el cliente de los trámites del lote—, el lote
--     cae a la ficha de ese cliente, que la misma transacción acaba de anonimizar. La emisión deja
--     su acta `no_realizado` con `cliente_sin_correo` y no sale nada: justo lo que el titular pidió.
--   · Purgado por la rama de DIRECCIÓN —el titular no es el cliente del lote, sino alguien cuya
--     dirección se escribió a mano en la factura de otra empresa—, la ficha de esa otra empresa
--     sigue intacta. El lote cae a ella y la factura sale a la dirección de la ficha: NO al titular
--     —su dirección ya no está—, pero tampoco a donde alguien decidió mandarla. La purga revierte en
--     silencio un desvío deliberado. No es una fuga de datos del titular; es una instrucción de
--     envío que cambia sin que nadie lo pida ni lo vea.
--
-- Queda escrito y no corregido a propósito: apagar `correo_solicitado` al purgar por dirección
-- cancelaría un correo que el cliente del lote sí espera, y cuál de los dos daños es peor es una
-- pregunta para contabilidad. Lo que no puede seguir es que el archivo afirme lo contrario.
--
-- No lleva marca de purga como la del acta: aquí no hay disparador que distinga una purga de
-- cualquier otro UPDATE, así que una columna más solo añadiría un dato que nadie leería. El hecho
-- del envío —quién recibió qué y cuándo— se conserva en el acta, que es su sitio.

-- ── Lo que se eligió sobre el correo en ESTE lote ────────────────────────────

ALTER TABLE siigo_lotes_facturacion
  ADD COLUMN IF NOT EXISTS correo_solicitado    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS correo_destinatarios jsonb   NOT NULL DEFAULT '[]'::jsonb;

-- El tope es el de Siigo (5 por envío) y se comprueba también aquí, no solo en el servicio: esta
-- columna la escribe hoy un camino y podría escribirla otro mañana. Y `jsonb_typeof` porque un
-- objeto suelto donde se espera una lista se leería como cero destinatarios sin quejarse.
DO $$ BEGIN
  ALTER TABLE siigo_lotes_facturacion
    ADD CONSTRAINT siigo_lotes_correo_dest_arr_chk
    CHECK (jsonb_typeof(correo_destinatarios) = 'array');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE siigo_lotes_facturacion
    ADD CONSTRAINT siigo_lotes_correo_dest_tope_chk
    CHECK (jsonb_array_length(correo_destinatarios) <= 5);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- La purga por derecho de supresión busca también POR DIRECCIÓN, no solo por la compañía de los
-- trámites del lote: `flito_tramites.compania_id` es NULLABLE y las direcciones escritas a mano
-- pueden ser de un tercero que no es el cliente de esos trámites — que es justamente quien ejerce el
-- derecho.
--
-- **Btree parcial, no GIN, y el motivo importa.** La purga NO compara con contención (`@>`): compara
-- en minúsculas, desplegando el array con `jsonb_array_elements`, porque la escritura normaliza y las
-- filas antiguas están en forma cruda. Un GIN `jsonb_path_ops` sirve a `@>` y a nada más, así que
-- aquí no lo usaría ninguna consulta: nacería muerto, pagando escrituras a cambio de cero.
-- Comprobado contra PostgreSQL 16.14 penalizando el seq scan (`enable_seqscan = off`): con el
-- predicado real el planner sigue prefiriendo el recorrido secuencial, luego no existe camino por
-- índice; con `@>` sí aparece el Bitmap Index Scan.
--
-- Lo que la consulta SÍ puede aprovechar es el predicado con el que ella misma acota
-- (`facturacion.lote.repo.ts`): `jsonb_array_length(correo_destinatarios) > 0`. De ahí el parcial,
-- espejo de `idx_siigo_envios_sin_purgar` de la 0141. La enorme mayoría de los lotes no eligen
-- direcciones, así que el índice solo cubre la minoría que hay que recorrer.
CREATE INDEX IF NOT EXISTS idx_siigo_lotes_correo_destinatarios
    ON siigo_lotes_facturacion (id)
 WHERE jsonb_array_length(correo_destinatarios) > 0;

COMMENT ON COLUMN siigo_lotes_facturacion.correo_solicitado IS
  'Se pidio el correo al cliente al enviar (HU #11708). false = no se pidio: la emision deja acta '
  'no_realizado con motivo "no solicitado en el envio". Se multiplica por efectosExternosPermitidos '
  '(ambiente): es un Y, nunca un O — no enciende el correo fuera de produccion.';

COMMENT ON COLUMN siigo_lotes_facturacion.correo_destinatarios IS
  'Direcciones elegidas al enviar, [{correo, origen}]. Vacio = las que resuelva la ficha del '
  'cliente, no "a nadie". DATO PERSONAL (Ley 1581): lo vacia purgarDestinatariosDeLotes en el mismo '
  'flujo de supresion que redacta las actas de siigo_factura_envios.';
