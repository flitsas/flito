-- 0156_flito_comparendos_gestion_check.sql
-- Feature #11495 (17b) — Monitoreo de comparendos. HU #11557 (gestionar causal y observación de un
-- comparendo).
-- Autor: equipo FLITO. Motivo: la 0154 abrió la zona de auditoría de la gestión
-- (`gestion_actualizada_en`, `gestion_actualizada_por`) y dejó escrito, en su propia cabecera, que
-- el `CHECK` que ata esas dos columnas entre sí «va con la HU #11557, que es la que introduce el
-- endpoint que las escribe». Esta es esa HU y este es ese CHECK.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo con `sql.begin()`).
-- Idempotente: se puede re-aplicar entera sin efecto adicional y sin cambiar una sola fila.
--
-- Pantalla y contrato: docs/ux/flito-comparendos-visor.md. FK de auditoría: ADR-0005.
--
-- ============================================================================
-- QUÉ AFIRMA Y POR QUÉ AHORA
-- ============================================================================
--
-- «O las dos puestas, o las dos nulas». Las dos columnas son una sola cosa —el sello de la última
-- gestión— y cada estado mixto es una mentira distinta:
--
--   · fecha sin autor  → «esto se gestionó el 3 de marzo, y no fue nadie». Es exactamente el daño
--                        que el `ON DELETE RESTRICT` de la 0154 existe para impedir (ADR-0005), y
--                        sin este CHECK un `UPDATE` que pusiera la fecha con el autor en NULL lo
--                        reintroduciría por la puerta de al lado.
--   · autor sin fecha  → «esto lo gestionó Ana, en algún momento». Un rastro sin cuándo no sirve
--                        para reconstruir nada: es la mitad de una auditoría.
--
-- En la 0154 la restricción no habría defendido nada (no existía ni un camino de código capaz de
-- escribir una de las dos columnas) y sí habría obligado a decidir de antemano cómo se comporta un
-- `UPDATE` que aún no existía. Ahora ese camino existe y es uno solo —`gestionarComparendo`, en
-- `flito-comparendos.gestion.service.ts`—, que escribe las dos en el mismo `set()` y nunca las
-- condiciona al valor de la causal o de la observación: limpiar la gestión también deja sello, y por
-- eso el CHECK no puede formularse contra `causal_id`/`observacion`, solo entre las dos columnas de
-- auditoría (RN-38).
--
-- El CHECK es además lo que convierte un descuido futuro en un `23514` inmediato en vez de en una
-- fila que miente: el día que alguien escriba un segundo camino de escritura —el export no, pero sí
-- una corrección masiva o un script de operación— la base le exige el sello completo.
--
-- ============================================================================
-- POR QUÉ **NO** SE AÑADE `NOT VALID`
-- ============================================================================
--
-- `ADD CONSTRAINT ... NOT VALID` seguido de `VALIDATE CONSTRAINT` es el patrón para no escanear una
-- tabla grande bajo `ACCESS EXCLUSIVE`, y aquí no aporta.
--
-- Lo que hace seguro el `ADD CONSTRAINT` no es que las columnas estén vacías —**no lo están en todas
-- partes**: en la base de demo local hay filas con el sello ya escrito, sembradas fuera del API—,
-- sino que **no hay filas MIXTAS**, que es lo único que el CHECK puede rechazar. Y no las hay porque
-- las dos columnas nacieron juntas en la 0154 y solo se escriben juntas: hasta esta HU ningún camino
-- de código las tocaba, y el que entra ahora (`gestionarComparendo`) las pone siempre en el mismo
-- `set()`. Comprobado antes de aplicar, y así es como se comprueba en cualquier ambiente:
--
--     SELECT count(*) FROM flito_comparendos_registros
--     WHERE (gestion_actualizada_en IS NULL) <> (gestion_actualizada_por IS NULL);
--
-- La distinción importa y no es una precisión de estilo: «todas en NULL» es una frase que alguien
-- recicla en la migración siguiente, donde puede ser falsa y llevarse por delante el despliegue. Si
-- algún día ese conteo NO fuera cero, lo correcto es que el `ALTER TABLE` falle en el `db:apply`
-- —ruidoso, atómico y antes de que nada dependa del CHECK— en vez de esconderlo tras un `NOT VALID`
-- que dejaría la restricción sin responder por lo que ya está en la tabla.
--
-- Además, el runner envuelve el archivo en una transacción, dentro de la cual `VALIDATE` no libera
-- el lock antes de tiempo: el patrón en dos pasos solo tiene sentido en dos transacciones, y por
-- tanto en dos migraciones. Se paga el escaneo de una tabla acotada por la purga de retención de 24
-- meses (0152) y se gana una restricción válida desde el primer minuto.
--
-- ============================================================================
-- POR QUÉ UN BLOQUE `DO` Y NO UN `ALTER TABLE` PELADO
-- ============================================================================
--
-- Porque PostgreSQL no admite `ADD CONSTRAINT IF NOT EXISTS`, y la idempotencia no es opcional: esta
-- migración se re-aplica en cada ambiente que vaya por detrás, y una segunda pasada que abortara con
-- `42710` dejaría parada la cadena entera. Es el mismo patrón que ya usan la 0132 y la 0134
-- (`IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ...)`), y no se inventa aquí.
--
-- Ningún comentario de este archivo escribe el par de dólares que abre un bloque, y no es manía: el
-- guarda de ADR-DB-001 (`scanForTxControl`) tapa los bloques citados con dólares ANTES de quitar los
-- comentarios, así que un par suelto dentro de un `--` empareja con el que abre el bloque de abajo,
-- deja su `BEGIN` a la intemperie y el `db:apply` aborta con exit 2 por una migración que está bien.
-- Verificado: con `DO` y los dos dólares escritos en esta misma cabecera, el guarda señalaba la
-- línea del `BEGIN`.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'flito_comparendos_gestion_auditoria_chk'
  ) THEN
    ALTER TABLE flito_comparendos_registros
      ADD CONSTRAINT flito_comparendos_gestion_auditoria_chk
      -- La igualdad entre dos predicados y no un `(a IS NULL AND b IS NULL) OR (...)`: dice lo
      -- mismo, cabe en una línea y no tiene una rama que alguien pueda editar a medias.
      CHECK ((gestion_actualizada_en IS NULL) = (gestion_actualizada_por IS NULL));
  END IF;
END $$;

COMMENT ON CONSTRAINT flito_comparendos_gestion_auditoria_chk ON flito_comparendos_registros IS
  'El sello de la última gestión es una sola cosa: o están las dos columnas o no está ninguna. Una '
  'fecha sin autor diría que la fila se gestionó y no fue nadie; un autor sin fecha, que se gestionó '
  'en algún momento. Lo escribe PATCH /api/flito/comparendos/registros/:id/gestion (HU #11557), que '
  'las pone siempre juntas, también cuando lo que se gestiona es vaciar la causal y la observación.';
