# Runbook — despliegue de las migraciones 0249/0250 (HU #13899, bolsa única de clientes)

- **HU:** #13899 · **Feature:** #13886 · **Épica:** #13412 · **ADR:** ADR-0029 (Opción A) · **Decisión Q5**
- **Diseño:** [`feature-13886-13887-bolsa-unica.md`](feature-13886-13887-bolsa-unica.md), secciones «Pre-flight» y «Runbook»
- **Quién lo corre:** `devops-agent`, o la persona que despliega, en cada ambiente (DEV → QA → PDN)
- **Archivos:** `apps/api/src/db/migrations/0249_flito_bolsas_unicas.sql` (solo DDL) y
  `apps/api/src/db/migrations/0250_flito_bolsas_unicas_datos_cliente.sql` (copia de datos)

La 0250 **falla a propósito**, y entera, cuando alguna bolsa de cliente no cumple
`saldo = Σ entradas − Σ salidas`. El mensaje solo da el número de bolsas
(`flito_bolsas_unicas: N bolsas de cliente no cuadran …`) y no copia nada. La deriva **no se corrige
en silencio**: se ajusta antes de migrar, con el procedimiento auditado de abajo, y después se vuelve a
correr.

---

## 1. Pre-flight de descuadre (solo lectura, ANTES del deploy, con el código viejo desplegado)

```sql
-- 1.a ¿Cuántas bolsas no cuadran? Debe dar 0.
SELECT count(*) FROM flito_bolsas b
WHERE b.saldo <> COALESCE((SELECT sum(CASE WHEN tipo = 'entrada' THEN valor ELSE -valor END)
                           FROM flito_bolsa_movimientos WHERE bolsa_id = b.id), 0);

-- 1.b Si da > 0: cuáles y cuánto. Solo ids e importes; NUNCA NIT ni nombre en el work item ni en el chat.
SELECT b.id AS bolsa_id, b.compania_id, b.saldo,
       COALESCE(l.libro, 0) AS libro,
       b.saldo - COALESCE(l.libro, 0) AS diferencia,
       (SELECT m.saldo_resultante FROM flito_bolsa_movimientos m
         WHERE m.bolsa_id = b.id ORDER BY m.created_at DESC LIMIT 1) AS saldo_resultante_ultimo
FROM flito_bolsas b
LEFT JOIN LATERAL (SELECT sum(CASE WHEN tipo = 'entrada' THEN valor ELSE -valor END) AS libro
                   FROM flito_bolsa_movimientos WHERE bolsa_id = b.id) l ON true
WHERE b.saldo <> COALESCE(l.libro, 0);

-- 1.c Informativo (no bloquea): bolsas autocreadas sin historia que la 0250 NO migrará (D5).
SELECT count(*) FROM flito_bolsas b
WHERE NOT EXISTS (SELECT 1 FROM flito_bolsa_movimientos m WHERE m.bolsa_id = b.id)
  AND NOT EXISTS (SELECT 1 FROM flito_bolsa_cierres c WHERE c.bolsa_id = b.id);
```

Con `1.a = 0`, saltar al paso 3.

## 2. Ajuste manual auditado (solo si el pre-flight da > 0)

Por cada `bolsa_id` de la consulta 1.b, quien despliega decide el caso mirando
`saldo_resultante_ultimo`:

**Caso A — falta un movimiento en el libro y el saldo ya lo reflejaba.**
Se usa la ruta existente, **con el código viejo todavía desplegado** (la nueva exige bolsa en el
modelo único, que aún no existe):

- `POST /api/flito/bolsas/:companiaId/movimientos-manuales`, con la función `bolsas.movimiento.registrar`.
- `tipo` sale del signo de `diferencia` (positiva → `entrada`; negativa → `salida`) y `valor` es su valor absoluto.
- `motivo`: «Ajuste previo a la migración al modelo único (ADR-0029): saldo X vs libro Y».
- Se adjunta soporte si existe.

**Ojo:** el movimiento manual mueve a la vez el saldo **y** el libro. Por sí solo no cierra un
descuadre: solo lo cierra cuando la deriva es un movimiento que falta en el libro y el saldo ya lo
había contado. Hay que volver a correr 1.a después del ajuste para comprobarlo.

**Caso B — la deriva está en el saldo denormalizado (el libro es la verdad).**
Lo corrige un DBA:

1. `pg_dump` previo (ver paso 3.1).
2. Corrección:
   ```sql
   UPDATE flito_bolsas b
   SET saldo = COALESCE((SELECT sum(CASE WHEN tipo = 'entrada' THEN valor ELSE -valor END)
                         FROM flito_bolsa_movimientos WHERE bolsa_id = b.id), 0),
       updated_at = now()
   WHERE b.id = '<bolsa_id>';
   ```
3. La evidencia queda en el comentario de la HU #13899 (o del Bug del ambiente): `bolsa_id`, saldo
   antes y después, libro, quién y cuándo. Sin NIT ni nombre.

Después de cualquiera de los dos casos, se vuelve a correr **1.a hasta que dé 0**.

## 3. Secuencia del deploy

La migración es manual fuera de local: `docker-compose.prod.yml` no tiene el job `migrate` y `cd.yml`
no ejecuta `db:apply`.

1. **Respaldo:** `pg_dump` de la base del ambiente (obligatorio en PDN), guardado con fecha.
2. **Parar la API:** `docker compose -f docker-compose.prod.yml stop api`. Así el código viejo no
   escribe en el libro viejo después de la copia. Además, la 0250 toma
   `LOCK … IN EXCLUSIVE MODE` sobre los tres libros dentro de su transacción.
3. **Migrar con la imagen nueva:**
   `docker compose -f docker-compose.prod.yml run --rm api node dist/scripts/db-apply.js`.
   El runner aplica 0249 y 0250, cada una en su transacción.
   - **0249 y 0250 van en el MISMO `db:apply`, con la API parada.** Nunca se aplica la 0249 sola y
     se arranca la app en medio: el código nuevo podría crear bolsas de compañía en
     `flito_bolsas_unicas` con ids nuevos, y el índice único parcial `uq_flito_bolsas_unicas_compania`
     haría fallar la 0250 al copiar la bolsa vieja de esa misma compañía.
   - Si sale `N bolsas de cliente no cuadran`, la transacción se deshace y **no queda nada copiado**.
     Se vuelve a levantar la API vieja, se repiten los pasos 1-2 y se reintenta.
4. **Arrancar:** `docker compose -f docker-compose.prod.yml up -d api` (imagen nueva).
5. **Verificación posterior (solo lectura):**
   ```sql
   -- Todo lo viejo tiene copia y las bolsas migradas cuadran.
   SELECT (SELECT count(*) FROM flito_bolsa_movimientos m
            WHERE NOT EXISTS (SELECT 1 FROM flito_bolsas_unicas_movimientos x WHERE x.id = m.id)) AS movs_sin_copia,
          (SELECT count(*) FROM flito_bolsas_unicas u
            WHERE u.alcance = 'compania'
              AND u.saldo <> COALESCE((SELECT sum(CASE WHEN tipo='entrada' THEN valor ELSE -valor END)
                                       FROM flito_bolsas_unicas_movimientos WHERE bolsa_id = u.id), 0)) AS descuadres;
   -- La FK de conciliación apunta al libro único.
   SELECT con.conname, con.confrelid::regclass FROM pg_constraint con
   JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
   WHERE con.contype = 'f' AND con.conrelid = 'flito_conciliacion_lineas'::regclass AND a.attname = 'movimiento_bolsa_id';
   ```
   Lo esperado es `0 | 0` y una sola fila con destino `flito_bolsas_unicas_movimientos`.
6. **Smoke:** `devops-agent` M1, una vez al tip.

## 4. Rollback

Hasta la migración de retiro (HU-I, 0253), los libros viejos siguen intactos. Volver atrás es
redesplegar la imagen anterior; los movimientos escritos en el libro único después del deploy hay
que reconciliarlos a mano y dejarlos anotados en el work item. La FK de
`flito_conciliacion_lineas.movimiento_bolsa_id` apunta al libro único: si se vuelve a la imagen vieja,
la conciliación escribiría ids del libro viejo. Por eso, si hay rollback, se restaura el `pg_dump`
del paso 3.1 en lugar de convivir con las dos versiones.

## 5. Idempotencia

0249 y 0250 vuelven a correr sin error y sin duplicar (`IF NOT EXISTS`, `ON CONFLICT (id) DO NOTHING`).
Los conceptos y el evento `migrar` se crean solo para las bolsas insertadas en esa corrida. Está
comprobado en `__tests__/services/flito-bolsas-unicas-migracion.test.ts` (TC-12) y aplicándolas dos
veces sobre la base local (P6).
