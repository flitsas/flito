# Runbook — despliegue de la migración 0257 (HU #13906, libro de tránsito al modelo único)

- **HU:** #13906 · **Feature:** #13887 · **ADR:** ADR-0029 (Opción A) · **Decisiones:** D3, D5, Q5, Q7
- **Diseño:** [`feature-13886-13887-bolsa-unica.md`](feature-13886-13887-bolsa-unica.md), «Plan de migración SQL» (fila HU-F), «Pre-flight» y «Runbook»
- **Hermano del lado cliente:** [`runbook-hu-13899-migracion-0250-bolsa-unica.md`](runbook-hu-13899-migracion-0250-bolsa-unica.md). La 0249 y la 0250 deben estar aplicadas antes.
- **Quién lo corre:** `devops-agent`, o la persona que despliega, en cada ambiente (DEV → QA → PDN)
- **Archivo:** `apps/api/src/db/migrations/0257_flito_bolsas_unicas_datos_transito.sql` (copia de datos + re-apunte de FK).
  El número lo fija el PR; si colisiona, se renombra y este runbook se actualiza con él.

La 0257 copia **todas** las bolsas de tránsito, tengan o no movimientos, con su nombre, saldo,
cobertura (activa) e historial. El origen `carga` pasa a `recarga`. Después re-apunta
`flito_conciliacion_lineas.movimiento_transito_id` al libro único (mismos UUID).

**Falla a propósito, y entera,** cuando alguna bolsa de tránsito no cumple
`saldo = Σ entradas − Σ salidas`. El mensaje solo da el número de bolsas
(`flito_bolsas_unicas: N bolsas de tránsito no cuadran …`) y no copia nada. La deriva **no se corrige
en silencio**: se ajusta antes de migrar, con el procedimiento auditado de abajo (Q5), y después se
vuelve a correr.

---

## 1. Pre-flight de descuadre (solo lectura, ANTES del deploy, con el código viejo desplegado)

```sql
-- 1.a ¿Cuántas bolsas de tránsito no cuadran? Debe dar 0.
SELECT count(*) FROM flito_bolsas_transito b
WHERE b.saldo <> COALESCE((SELECT sum(CASE WHEN tipo = 'entrada' THEN valor ELSE -valor END)
                           FROM flito_bolsa_transito_movimientos WHERE bolsa_id = b.id), 0);

-- 1.b Si da > 0: cuáles y cuánto. Solo ids e importes (el nombre de la bolsa no es PII, pero no hace falta).
SELECT b.id AS bolsa_id, b.saldo,
       COALESCE(l.libro, 0) AS libro,
       b.saldo - COALESCE(l.libro, 0) AS diferencia,
       (SELECT m.saldo_resultante FROM flito_bolsa_transito_movimientos m
         WHERE m.bolsa_id = b.id ORDER BY m.created_at DESC LIMIT 1) AS saldo_resultante_ultimo
FROM flito_bolsas_transito b
LEFT JOIN LATERAL (SELECT sum(CASE WHEN tipo = 'entrada' THEN valor ELSE -valor END) AS libro
                   FROM flito_bolsa_transito_movimientos WHERE bolsa_id = b.id) l ON true
WHERE b.saldo <> COALESCE(l.libro, 0);

-- 1.c Colisión de llaves con el libro único (debe dar 0): la llave es única en TODO el libro único.
--     Las familias no se solapan (cliente `salida:`/`recarga:`…, tránsito `consumo:`/`contra:<uuid>`),
--     así que un valor > 0 indica datos manipulados a mano y hay que revisarlos antes de seguir.
SELECT count(*) FROM flito_bolsa_transito_movimientos m
JOIN flito_bolsas_unicas_movimientos x ON x.llave_idempotencia = m.llave_idempotencia AND x.id <> m.id;

-- 1.d Informativo: lo que se va a copiar.
SELECT (SELECT count(*) FROM flito_bolsas_transito) AS bolsas,
       (SELECT count(*) FROM flito_bolsa_transito_cobertura) AS cobertura,
       (SELECT count(*) FROM flito_bolsa_transito_movimientos) AS movimientos;
```

Con `1.a = 0` y `1.c = 0`, saltar al paso 3.

## 2. Ajuste auditado (solo si 1.a da > 0)

Por cada `bolsa_id` de la consulta 1.b, quien despliega decide el caso mirando
`saldo_resultante_ultimo`, y deja la decisión escrita en el comentario de la HU #13906 (o del Bug del
ambiente): `bolsa_id`, saldo antes y después, libro, caso, quién y cuándo.

**Caso A — falta un movimiento en el libro y el saldo ya lo reflejaba.**

- **Diferencia positiva** (falta una entrada): carga por la ruta existente, **con el código viejo
  todavía desplegado**: `POST /api/flito/bolsas/transito/:bolsaId/cargas` (función
  `bolsas.transito.cargar`), `valor` = la diferencia, observación «Ajuste previo a la migración al
  modelo único (ADR-0029): saldo X vs libro Y», soporte si existe.
- **Diferencia negativa** (falta una salida): no hay ruta de salida manual en tránsito. Un DBA hace el
  `INSERT` auditado, con `pg_dump` previo:
  ```sql
  INSERT INTO flito_bolsa_transito_movimientos
    (bolsa_id, tipo, origen, valor, saldo_resultante, periodo, fecha, observacion, registrado_por_nombre)
  VALUES ('<bolsa_id>', 'salida', 'automatico', <abs(diferencia)>, <saldo_actual>,
          to_char(now() AT TIME ZONE 'America/Bogota', 'YYYY-MM'), (now() AT TIME ZONE 'America/Bogota')::date,
          'Ajuste previo a la migración al modelo único (ADR-0029): saldo X vs libro Y', '<quién>');
  ```
  Solo inserta en el libro (el saldo ya lo reflejaba), sin llave de idempotencia, con `origen`
  `automatico` (el CHECK viejo solo admite `carga`/`automatico`/`conciliacion`).

**Ojo:** la carga por la ruta mueve a la vez el saldo **y** el libro. Solo cierra el descuadre cuando
la deriva es un movimiento que falta en el libro y el saldo ya lo había contado; hay que volver a
correr 1.a para comprobarlo.

**Caso B — la deriva está en el saldo denormalizado (el libro es la verdad).** Lo corrige un DBA, con
`pg_dump` previo (paso 3.1):

```sql
UPDATE flito_bolsas_transito b
SET saldo = COALESCE((SELECT sum(CASE WHEN tipo = 'entrada' THEN valor ELSE -valor END)
                      FROM flito_bolsa_transito_movimientos WHERE bolsa_id = b.id), 0),
    updated_at = now()
WHERE b.id = '<bolsa_id>';
```

Después de cualquiera de los dos casos, se vuelve a correr **1.a hasta que dé 0**.

## 3. Secuencia del deploy

La migración es manual fuera de local: `docker-compose.prod.yml` no tiene el job `migrate` y `cd.yml`
no ejecuta `db:apply`.

1. **Respaldo:** `pg_dump` de la base del ambiente (obligatorio en PDN), guardado con fecha.
2. **Parar la API:** `docker compose -f docker-compose.prod.yml stop api`, para que el código viejo no
   escriba en el libro viejo de tránsito después de la copia (cargas, sellados, conciliaciones). La
   0257 además toma `LOCK … IN EXCLUSIVE MODE` sobre los tres libros de tránsito dentro de su
   transacción, y su verificación posterior (conteos por bolsa) detecta cualquier escritura colada.
3. **Migrar con la imagen nueva:**
   `docker compose -f docker-compose.prod.yml run --rm api node dist/scripts/db-apply.js`.
   - **Con la API parada.** El código nuevo crea bolsas de tránsito en `flito_bolsas_unicas`: si
     arrancara antes de la 0257, una bolsa nueva podría tomar un par (secretaría, concepto) que la
     copia necesita y el índice parcial `uq_flito_bolsas_unicas_cobertura_activa` haría fallar la
     migración (o tomar un nombre de `uq_flito_bolsas_unicas_nombre_transito`).
   - Si sale `N bolsas de tránsito no cuadran`, la transacción se deshace y **no queda nada copiado**.
     Se vuelve a levantar la API vieja, se repiten los pasos 1-2 y se reintenta.
4. **Arrancar:** `docker compose -f docker-compose.prod.yml up -d api` (imagen nueva).
5. **Verificación posterior (solo lectura):**
   ```sql
   SELECT (SELECT count(*) FROM flito_bolsa_transito_movimientos m
            WHERE NOT EXISTS (SELECT 1 FROM flito_bolsas_unicas_movimientos x WHERE x.id = m.id)) AS movs_sin_copia,
          (SELECT count(*) FROM flito_bolsas_transito o
            WHERE NOT EXISTS (SELECT 1 FROM flito_bolsas_unicas u WHERE u.id = o.id AND u.alcance = 'transito')) AS bolsas_sin_copia,
          (SELECT count(*) FROM flito_bolsas_unicas u
            WHERE u.alcance = 'transito'
              AND u.saldo <> COALESCE((SELECT sum(CASE WHEN tipo='entrada' THEN valor ELSE -valor END)
                                       FROM flito_bolsas_unicas_movimientos WHERE bolsa_id = u.id), 0)) AS descuadres;
   -- La FK de conciliación (lado tránsito) apunta al libro único.
   SELECT con.conname, con.confrelid::regclass FROM pg_constraint con
   JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
   WHERE con.contype = 'f' AND con.conrelid = 'flito_conciliacion_lineas'::regclass AND a.attname = 'movimiento_transito_id';
   ```
   Lo esperado es `0 | 0 | 0` y una sola fila con destino `flito_bolsas_unicas_movimientos`.
6. **Smoke:** `devops-agent` M1, una vez al tip. Recorrido mínimo: `GET /api/flito/bolsas/transito`
   (mismas bolsas, saldos y cobertura que antes) y el detalle/movimientos de una bolsa.

## 4. Rollback

Hasta la migración de retiro (HU-I), los libros viejos de tránsito siguen intactos. Volver atrás es
redesplegar la imagen anterior **y** restaurar el `pg_dump` del paso 3.1: la FK de
`flito_conciliacion_lineas.movimiento_transito_id` ya apunta al libro único, y la imagen vieja
escribiría ids del libro viejo. No se convive con las dos versiones.

## 5. Idempotencia

La 0257 vuelve a correr sin error y sin duplicar (`ON CONFLICT DO NOTHING`; cobertura y evento
`migrar` solo para las bolsas insertadas en esa corrida; la FK se busca por destino y se crea solo si
no existe). Comprobado en `__tests__/services/flito-bolsas-unicas-migracion.test.ts` (AC3 de la HU
#13906) y aplicándola dos veces sobre la base local (P6).
