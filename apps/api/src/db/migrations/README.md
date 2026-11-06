# Migrations operaciones-system

## Filosofía

Las migrations en este proyecto son **SQL plano**, NO formato drizzle.
Solo `0001-0004` fueron generadas por `drizzle-kit generate`. El resto (`0005+`)
son SQL escritos a mano para tener control total del schema.

`drizzle-kit` está **retirado** (dependencia, config, `meta/` y scripts; ver
[ADR-0035](../../../../../docs/adr/ADR-0035-integridad-de-migraciones-y-retiro-de-drizzle-kit.md)):
su journal se quedó en `0004`, así que `generate` emitiría una migración recreando ~120 tablas y
`migrate` aplicaría solo 5 de 64. `npm run db:generate` y `npm run db:migrate` terminan con error.
`push`, `check`, `introspect` y `studio` tampoco se usan: readoptarlos exige un ADR nuevo.

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
| `npm run db:apply -- --dry` | Muestra qué aplicaría sin aplicar nada |
| `npm run db:apply -- --mark-all` | Marca como aplicadas las que falten, SIN ejecutar (solo VPS donde el SQL ya corrió manualmente con `psql`). No reescribe el sha de las ya registradas |
| `npm run db:apply -- --check-drift` | Solo lectura (lo impone Postgres): reporta deriva y huérfanas. Salida: `0` limpio, `3` con hallazgos, `1` error |
| `npm run db:apply -- --allow-drift=<motivo>` | Continúa pese a los hallazgos y registra archivo y motivo. El motivo es obligatorio |

## Integridad: deriva y huérfanas (ADR-0035)

Antes de aplicar nada, el runner compara el ledger con el disco. El log es estable y se consulta
con `grep '\[drift\]'`:

```
[drift] deriva archivo=… ledger=… disco=…
[drift] huerfana archivo=… ledger=… pista=…
[drift] resumen intactas=N aceptadas=N derivas=N huerfanas=N pendientes=N
```

**Estado actual: sin activar.** `DRIFT_ABORTA = false` en `db-apply.ts`: el arranque normal informa
y sale con 0. El aborto se activa en un segundo PR, solo tras medir `--check-drift` en DEV, QA y PDN
(ADR-0035 §A). Hasta entonces, una renombrada pendiente se aplica como hasta hoy, con
`[drift] aviso-reejecucion`.

| Pista de la huérfana | Significa | Qué hacer |
|---|---|---|
| `sha:<pendiente>` | Un pendiente tiene el mismo contenido: **se re-ejecutaría** | Restaurar el nombre registrado |
| `registrada:<nombre>` | Ese contenido ya está registrado bajo otro nombre | Comprobar que el doble efecto fue inocuo; añadir al manifiesto con `shaDisco: null` |
| `nombre:<pendiente>` | Un pendiente tiene el mismo nombre sin número y otro contenido: **se re-ejecutaría con cambios** | Restaurar el nombre registrado, revisando el diff |
| `ninguna` | Sin rastro: migración retirada | Investigar; manifiesto si procede |

Con `--allow-drift` en una pista `sha:` o `nombre:`, el pendiente **se ejecuta de nuevo** bajo su nuevo
nombre, y el log lo avisa expresamente.

### Manifiesto `derivas-aceptadas.json`

Excepciones aprobadas y versionadas. Cada entrada acepta **el par exacto**: otra edición del archivo
cambia `shaDisco` y vuelve a ser un hallazgo. El ledger no se toca. Un archivo puede tener varias
entradas si los ambientes difieren. Para una huérfana, `shaDisco: null`.

```json
[{ "archivo": "0045_….sql", "shaLedger": "…", "shaDisco": "…", "motivo": "…", "wi": "#…" }]
```

### Check de CI

Un PR a `develop` que modifica, borra o renombra un `.sql` de esta carpeta que ya existe en `develop`
falla (`scripts/check-migraciones-inmutables.mjs`, en el job `naming`). Se arregla con una migración
nueva. Solo si una migración nueva nunca llegaría a correr (la original falló o rompe la cadena en BD
limpia), el mismo PR añade al manifiesto una entrada con motivo cuyo `shaDisco` coincide con el archivo
editado (`null` si se borró). Renumerar un archivo que aún no está en `develop` pasa.

### Fricción local tras activar el aborto

Cambiar de rama con una migración ya aplicada deja una huérfana local, y el job `migrate` de
`docker-compose.yml` abortará y dejará la API local abajo. Salida documentada, solo local, en
`docker-compose.override.yml` (no versionado):

```yaml
services:
  migrate:
    command: ['node', 'dist/scripts/db-apply.js', '--allow-drift=local: cambio de rama']
```

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
