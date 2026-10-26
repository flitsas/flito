# Runbook — migración 0266: retiro (archivo) de los libros viejos de bolsas (HU #13911)

- **HU:** #13911 · **Feature:** #13887 · **Épica:** #13412 · **ADR:** ADR-0029 (Opción A)
- **Diseño:** [`feature-13886-13887-bolsa-unica.md`](feature-13886-13887-bolsa-unica.md), «Plan de migración SQL» (fila HU-I)
- **Decisión:** David Chica, 2026-10-26 — sin precondición de PDN; la migración se verifica sola y **archiva**
  las tablas en el esquema `archivo_bolsas` en lugar de borrarlas, para conservar el rollback.
- **Archivo:** `apps/api/src/db/migrations/0266_flito_bolsas_retiro_libros.sql`
- **Requisitos:** la 0249, la 0250 y la 0257 aplicadas (el runner las aplica en orden).
- **Quién lo corre:** `devops-agent`, o la persona que despliega, en cada ambiente (DEV → QA → PDN).

## Qué hace

Los seis libros viejos —`flito_bolsas`, `flito_bolsa_movimientos`, `flito_bolsa_cierres`,
`flito_bolsas_transito`, `flito_bolsa_transito_cobertura`, `flito_bolsa_transito_movimientos`— salen de
`public` a `archivo_bolsas` con `ALTER TABLE … SET SCHEMA`. Datos, índices, secuencias y FKs entre ellos
viajan intactos. El modelo único (`flito_bolsas_unicas*`) no se toca. Ningún código lee ya esas tablas.

Antes de mover, y dentro del mismo bloque atómico:

1. **Restricciones de fuera (AC4).** Si alguna tabla distinta de los seis libros tiene una restricción que
   los referencia (`pg_constraint.confrelid`), falla nombrándola. `SET SCHEMA` no rompería esa FK (sigue al
   OID), por eso se busca explícitamente.
2. **Copia fiel (AC1).** Por cada bolsa migrada —de cliente con movimientos o cierres (D5) y todas las de
   tránsito— exige que exista en el modelo único con el mismo id y alcance, que cada movimiento viejo esté
   copiado con mismo id, bolsa, tipo y valor, que conteo y suma de los copiados coincidan con el libro viejo,
   y que el saldo viejo sea la suma de su propio libro. Los cierres viejos de cliente deben existir con mismo
   id, bolsa, periodo y saldo final. **No** compara el saldo actual del modelo único: tras la 0250/0257 recibe
   movimientos nuevos que el libro viejo no tiene, y eso es correcto.

Si algo no cuadra, la migración termina con error y **no mueve nada**. El mensaje lista solo ids e importes:

```
flito_bolsas retiro (0266): N bolsas no cuadran con el modelo único; no se retira nada:
  <bolsa_id> [compania|transito] migrada=t|f saldo_viejo=… movimientos viejo/copia=…/… suma viejo/copia=…/…
```

Idempotente: si los seis ya no están en `public`, emite un `NOTICE` y termina sin verificar ni tocar nada.
Si solo **algunos** siguen en `public` (estado a medias que esta migración no produce), falla y pide revisión.

## 1. Antes del deploy

```bash
# Respaldo completo (obligatorio en PDN; recomendado en QA).
pg_dump --format=custom --file="flito-pre-0266-$(date +%Y%m%d-%H%M).dump" "$DATABASE_URL"
```

Pre-flight opcional, solo lectura, para ver si la verificación va a pasar: ejecutar el archivo dentro de una
transacción que se deshace.

```bash
{ echo 'BEGIN;'; cat apps/api/src/db/migrations/0266_flito_bolsas_retiro_libros.sql; echo 'ROLLBACK;'; } \
  | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
```

## 2. Aplicar

En local la aplica el job `migrate` de `docker-compose.yml`. En QA/PDN, a mano tras el deploy:

```bash
docker compose -f docker-compose.prod.yml run --rm api node dist/scripts/db-apply.js
```

Comprobación:

```sql
-- Debe devolver 6 filas, todas en archivo_bolsas.
SELECT table_schema, table_name FROM information_schema.tables
WHERE table_name IN ('flito_bolsas','flito_bolsa_movimientos','flito_bolsa_cierres',
                     'flito_bolsas_transito','flito_bolsa_transito_cobertura','flito_bolsa_transito_movimientos')
ORDER BY 2;
```

### Si falla

- **«N bolsas no cuadran» / «cierres sin copia fiel»:** no se corrige en silencio. Con los ids del mensaje se
  investiga qué escribió en el libro viejo después de la 0250/0257 (o qué falta en el modelo único) y se
  ajusta con el procedimiento auditado de los runbooks de la
  [0250](runbook-hu-13899-migracion-0250-bolsa-unica.md) y la
  [0257](runbook-hu-13906-migracion-0257-bolsa-transito.md). Después se vuelve a correr.
- **«N restricciones aún referencian un libro viejo»:** re-apuntar esas FK al modelo único (mismos UUID: solo
  DDL, patrón del paso 5 de la 0250) en una migración nueva, y volver a correr.

## 3. Rollback (mientras exista `archivo_bolsas`)

El código ya no lee los libros viejos, así que el rollback de la **aplicación** a una versión anterior a la
HU #13911 solo necesita que las tablas vuelvan a `public`:

```sql
BEGIN;
ALTER TABLE IF EXISTS archivo_bolsas.flito_bolsas                     SET SCHEMA public;
ALTER TABLE IF EXISTS archivo_bolsas.flito_bolsa_movimientos          SET SCHEMA public;
ALTER TABLE IF EXISTS archivo_bolsas.flito_bolsa_cierres              SET SCHEMA public;
ALTER TABLE IF EXISTS archivo_bolsas.flito_bolsas_transito            SET SCHEMA public;
ALTER TABLE IF EXISTS archivo_bolsas.flito_bolsa_transito_cobertura   SET SCHEMA public;
ALTER TABLE IF EXISTS archivo_bolsas.flito_bolsa_transito_movimientos SET SCHEMA public;
COMMIT;
```

Notas:

- El runner registra la 0266 como aplicada; si después se vuelve a desplegar el código de la HU #13911, la
  0266 **no** se re-ejecuta sola. Para archivar otra vez, correr el archivo a mano (`psql … < 0266_…sql`):
  vuelve a verificar y a mover.
- Los libros archivados quedan congelados en el estado de la 0266: lo que el modelo único registró después no
  está en ellos. Una versión anterior a la 0250/0257 que vuelva a escribir en el libro viejo deja de ver esos
  movimientos; por eso este rollback es para emergencias y debe ir seguido de una reconciliación.
- Si `archivo_bolsas` ya se borró, el rollback es `pg_restore` de las seis tablas desde el dump del paso 1:
  `pg_restore --data-only`/`--table=<tabla>` sobre las tablas recreadas con el DDL de las migraciones 0001-0257.

## 4. Limpieza diferida (tarea de operación, no de migración)

Cuando PDN lleve un ciclo estable con el modelo único (al menos un cierre mensual completo sin incidencias) y
con un `pg_dump` reciente archivado:

```sql
DROP SCHEMA archivo_bolsas CASCADE;
```

No lo hace ninguna migración: es una decisión de operación, con su propio respaldo previo. Mientras tanto, las
tablas archivadas conservan sus FK `RESTRICT` hacia `clients`, `users` y `flito_soportes` (las mismas que ya
tiene el libro único sobre los mismos ids).
