-- 0163_flito_comparendos_clave_negocio_prefijo.sql
-- Feature #11492 (17a) — Monitoreo de comparendos. HU #11806 (normalizar la clave de negocio del
-- comparendo entre fuentes).
-- Autor: equipo FLITO.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo con sql.begin()).
-- Idempotente: se puede re-aplicar entera. La segunda pasada no cambia ni una fila mas.
--
-- SIN DDL. No crea, no altera y no borra ningun objeto: declara una regla en el COMMENT de la
-- columna y repara lo ya persistido. El tipo, el ancho y el unico de `numero_comparendo` se quedan
-- exactamente como estaban.
--
-- Enmienda de docs/adr/ADR-0003-flito-comparendos-homologacion.md §6, PENDIENTE de aprobacion del
-- Lider Tecnico (la escribe esta HU; no la da por aceptada).
--
-- ============================================================================
-- QUE AFIRMA ESTA MIGRACION
-- ============================================================================
--
-- La grafia CANONICA de `numero_comparendo` es la de VEINTE DIGITOS, sin letras delante. Es la que
-- emite SIMIT, que es la fuente que prevalece (CF-08, RN-13), y es la que el operador ve en el
-- portal del SIMIT y la que ya esta en las filas historicas.
--
-- La regla que la produce vive en `numeroCanonico` (`flito-comparendos-merge.ts`, RN-26) y es, en
-- una linea:
--
--     si la cadena ya normalizada (sin espacios, en mayusculas) encaja ENTERA con
--         ^[A-Z]{1,2}[0-9]{20}$
--     entonces la clave son esos veinte digitos; en cualquier otro caso, la cadena tal cual.
--
-- El literal de arriba es el MISMO que usa el UPDATE de abajo y el MISMO que declara
-- `NUMERO_FORMA_NACIONAL` en el codigo. Que las tres copias no se separen no se deja a la buena
-- voluntad: lo vigila `flito-comparendos-migracion-0163-paridad.test.ts`.
--
-- ============================================================================
-- POR QUE ES SEGURA: EL ARGUMENTO ES CF-07, NO «LA LETRA SOBRA»
-- ============================================================================
--
-- CF-07 ya es premisa de este esquema desde la 0150: el numero lo asigna el Estado y es UNICO EN EL
-- PAIS. Por eso el unico de la tabla es (numero_comparendo) y no (nit, numero). Las dos grafias
-- medidas son 05001 + 15 digitos (DIVIPOLA de Medellin) y 11001 + 15 (Bogota): veinte digitos con la
-- DIVIPOLA delante YA SON la identidad completa.
--
-- De ahi sale la propiedad que hace segura la regla bajo la incertidumbre que la HU declara: DA
-- IGUAL si la `D` del portal de Medellin es del municipio o del tipo de comparendo. Bajo las dos
-- lecturas la letra decora un identificador que ya es unico por si solo; no lo extiende. La regla no
-- apuesta por ninguna de las dos hipotesis, se apoya en la tercera cosa que si esta verificada.
--
-- Y NO ES UN RECORTE, que es lo que ADR-0003 §6 prohibe: nunca se quita un digito, solo letras, y
-- solo cuando lo que queda es exactamente la forma nacional de veinte. `D` + 19 digitos y `D` + 21
-- NO disparan y se quedan como estan. El peor caso de esta regla es no fusionar algo que deberia —
-- que es el statu quo, no una regresion.
--
-- ============================================================================
-- ALCANCE: SOLO ESA FORMA, Y SE DICE POR QUE
-- ============================================================================
--
-- Separadores (`D-05001…`), sufijos, prefijos numericos y cualquier otra longitud NO se tocan. No es
-- un olvido: de ninguna de esas formas hay hoy ni un byte medido —solo hay muestra de tres de los
-- municipios sembrados— y la doctrina del modulo (ADR-0003 §6) dice que no se adivinan separadores.
-- Escribir hoy una regla mas ancha seria inventar semantica municipio a municipio.
--
-- La muestra que falta la trae `formaNumero` (misma HU): el sync loguea, por corrida y por fuente,
-- un histograma de FORMAS —`SIMIT|D20`, `MEDELLIN|L1D20`, `BELLO|OTRO`…— sin emitir ni un numero.
-- Es lo unico que puede responder en una corrida real que emiten los municipios sin muestra.
--
-- ============================================================================
-- MEDICION PREVIA (lectura pura, sin efectos)
-- ============================================================================
--
--   SELECT count(*) FILTER (WHERE NOT existe_gemela) AS reparables,
--          count(*) FILTER (WHERE existe_gemela)     AS conflicto
--     FROM (SELECT r.numero_comparendo,
--                  EXISTS (SELECT 1 FROM flito_comparendos_registros g
--                           WHERE g.numero_comparendo = substring(r.numero_comparendo from '[0-9]{20}$')) AS existe_gemela
--             FROM flito_comparendos_registros r
--            WHERE r.numero_comparendo ~ '^[A-Z]{1,2}[0-9]{20}$') t;
--
-- Medido el 2026-08-24 contra la base demo local (operaciones_db, 125 filas): reparables = 0,
-- conflicto = 0. La migracion se queda igualmente: es un no-op idempotente y deja la regla escrita
-- en la base, que es el sitio que sobrevive a los refactors del codigo. En un ambiente con datos
-- reales hay que volver a medirla ANTES de aplicar; si `conflicto` sale > 0, eso es un pendiente
-- humano nominal (ver abajo), no algo que esta migracion decida.
--
-- ============================================================================
-- LAS TRES COSAS QUE ESTA MIGRACION **NO** HACE
-- ============================================================================
--
-- 1. NI UN `DELETE`. `flito_comparendos_eventos` referencia `flito_comparendos_registros` con
--    `ON DELETE CASCADE`: borrar la fila prefijada se llevaria por delante su timeline entero. Eso
--    no es reparar, es perder auditoria. Por eso el UPDATE RENOMBRA la clave y conserva gestion,
--    payloads, eventos y `primera_visto_en`.
--
-- 2. NO FUSIONA las filas cuando ya existen LAS DOS grafias. Se dejan como estan y se emite un
--    RAISE NOTICE con el conteo. Fusionarlas exige decidir que `causal_id`, que `observacion` y que
--    `gestion_actualizada_por` sobreviven, y eso es una decision humana, no una migracion. La fila
--    prefijada dejara de recibir sync y CF-10 la inactivara por ausencia.
--
--    Y por eso el UPDATE lleva su guarda `NOT EXISTS`, que NO es defensiva: sin ella el propio
--    UPDATE revienta contra `uq_flito_comparendos_numero` (23505) en cuanto exista ya la fila de
--    SIMIT, y se lleva por delante la cadena de migraciones entera.
--
-- 3. NO TOCA el `field_map`. No hay v4 y no hace falta: los `source_path` no cambian —el proveedor
--    sigue mandando lo mismo por la misma ruta—, asi que la lista blanca de la poda RN-25, que se
--    DERIVA de esos `source_path`, no se mueve ni un milimetro. Tampoco se editan la 0158 ni la
--    0160: son historial aplicado.

-- ============================================================================
-- 1. La grafia canonica, declarada donde sobrevive a todo
-- ============================================================================
--
-- `COMMENT ON COLUMN` es idempotente por naturaleza: reemplaza el comentario anterior. Reemplaza al
-- de la 0150, que decia solo la mitad (que la clave es unica y que la placa no es llave).

COMMENT ON COLUMN flito_comparendos_registros.numero_comparendo IS
  'Clave de negocio unica (CF-07): el numero lo asigna el Estado y es unico en el pais. La placa NO '
  'es llave: un vehiculo acumula comparendos. GRAFIA CANONICA (HU #11806): los VEINTE DIGITOS del '
  'numero unico nacional (DIVIPOLA de 5 + 15), sin letras delante. Lo normaliza numeroCanonico en '
  'flito-comparendos-merge.ts: mayusculas, sin espacios internos y, si la cadena entera encaja con '
  '^[A-Z]{1,2}[0-9]{20}$, se queda con esos veinte digitos. La regla NO recorta: nunca quita un '
  'digito, solo letras, y solo cuando lo que queda es exactamente la forma nacional, asi que D+19 y '
  'D+21 no disparan. Bogota (11001+15) ya llega canonica y sale intacta. Separadores y sufijos '
  'quedan FUERA de alcance por falta de muestra (ADR-0003 §6). Un numero que no quepa en 60 se '
  'descarta entero: el item se ignora y se cuenta, nunca se trunca la clave.';

-- ============================================================================
-- 2. Reparacion one-shot de lo ya persistido
-- ============================================================================
--
-- Las filas que se escribieron con la grafia prefijada ANTES de que la regla existiera pasan a la
-- canonica, para que el proximo sync las encuentre en vez de crear una segunda deuda al lado.
--
-- Idempotencia: tras la primera pasada ya no queda ninguna fila que encaje con el ~ del WHERE, asi
-- que la segunda no toca nada y el NOTICE dice 0. No hace falta guarda extra.
--
-- El `substring` no puede recortar de mas: solo se ejecuta sobre filas que el WHERE ya confirmo que
-- encajan ENTERAS con la forma nacional prefijada, asi que los veinte digitos que extrae son todos
-- los digitos que la fila tenia.

DO $$
DECLARE
  v_reparadas  bigint;
  v_conflicto  bigint;
BEGIN
  -- Primero se CUENTAN los conflictos, antes de tocar nada: despues del UPDATE el conteo seguiria
  -- dando lo mismo (las filas en conflicto no se tocan), pero contarlo antes deja claro que el
  -- numero que se reporta es el estado de partida y no un efecto de esta migracion.
  SELECT count(*) INTO v_conflicto
    FROM flito_comparendos_registros r
   WHERE r.numero_comparendo ~ '^[A-Z]{1,2}[0-9]{20}$'
     AND EXISTS (SELECT 1 FROM flito_comparendos_registros g
                  WHERE g.numero_comparendo = substring(r.numero_comparendo from '[0-9]{20}$'));

  UPDATE flito_comparendos_registros r
     SET numero_comparendo = substring(r.numero_comparendo from '[0-9]{20}$'),
         updated_at = now()
   WHERE r.numero_comparendo ~ '^[A-Z]{1,2}[0-9]{20}$'
     -- LA GUARDA. Sin ella esto es un 23505 contra uq_flito_comparendos_numero en cuanto la fila de
     -- SIMIT ya exista, y la cadena de migraciones se para en seco.
     AND NOT EXISTS (SELECT 1 FROM flito_comparendos_registros g
                      WHERE g.numero_comparendo = substring(r.numero_comparendo from '[0-9]{20}$'));

  GET DIAGNOSTICS v_reparadas = ROW_COUNT;

  RAISE NOTICE '0163: % fila(s) pasan a la grafia canonica de 20 digitos (gestion, payloads y timeline intactos)', v_reparadas;

  IF v_conflicto > 0 THEN
    RAISE NOTICE '0163: % fila(s) prefijadas CONVIVEN con su gemela de 20 digitos y se dejan COMO ESTAN. Fusionarlas exige decidir que causal_id / observacion / gestion_actualizada_por sobrevive: es una decision humana, no una migracion. La prefijada dejara de recibir sync y CF-10 la inactivara.', v_conflicto;
  END IF;
END $$;
