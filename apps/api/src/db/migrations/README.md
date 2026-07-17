# Migrations operaciones-system

## Filosofía

Las migrations en este proyecto son **SQL plano**, NO formato drizzle.
Solo `0001-0004` fueron generadas por `drizzle-kit generate`. El resto (`0005+`)
son SQL escritos a mano para tener control total del schema.

`drizzle-kit migrate` aplicaría solo las 5 que aparecen en `meta/_journal.json`
y dejaría la BD inconsistente. **NO usar.**

## Cómo aplicar pendientes

```bash
cd apps/api
DATABASE_URL=postgres://... npm run db:apply
```

El runner mantiene su propia tabla `_kyverum_applied_migrations(filename, sha256, applied_at)`
y aplica solo lo pendiente, en orden alfabético, en transacción.

Modos:

| Comando | Uso |
|---|---|
| `npm run db:apply` | Aplica las pendientes (idempotente) |
| `npm run db:apply -- --dry` | Muestra qué aplicaría sin tocar BD |
| `npm run db:apply -- --mark-all` | Marca todas como aplicadas SIN ejecutar (solo VPS donde el SQL ya corrió manualmente con `psql`) |

## Convenciones para nuevas migrations

1. Nombre: `NNNN_descripcion_corta.sql` (ej: `0064_audit_action_extender.sql`)
2. Numeración secuencial — buscar el último número con `ls -1 *.sql | tail -1`
3. Idempotente cuando posible: `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
4. Para columnas con NOT NULL en tabla existente: agregar como nullable, backfill, agregar constraint en migration siguiente
5. Documentar en el header: ola/sprint, autor, motivo
6. Antes de aplicar en producción: backup `pg_dump` a `/var/backups/operaciones/pre_NNNN_<ts>.sql.gz`

## Estado actual al 2026-05-08

64 migrations en disco, todas aplicadas en VPS Dev2 (`operaciones_db`). El runner
fue introducido tras detectar que `drizzle-kit migrate` solo aplicaría 5 de 64.
