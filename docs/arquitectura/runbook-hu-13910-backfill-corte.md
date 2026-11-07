# Runbook — backfill de comprobantes al activar el corte (HU #13910, ADR-0029 Q4; corte de HU #13965)

Script: `apps/api/src/scripts/flito-bolsas-backfill-comprobantes.ts`. Descuenta de las bolsas (compañía y
tránsito) los comprobantes de pago **aplicados antes** del corte, con el mismo
gancho, las mismas llaves y las mismas omisiones que el descuento normal. Es idempotente: re-ejecutarlo no
duplica movimientos.

**El corte (HU #13965, reemplaza ADR-0029 D12)** es el **instante** en que se aplica la migración
`0260_flito_bolsas_corte_automatico.sql` en el ambiente: queda en la fila única de `flito_bolsas_corte`
(`corte_en`, timestamptz) y re-aplicarla no lo cambia. Ya no hay variable de entorno. La comparación es por
instante, no por día de Colombia: con corte hoy 15:00 COT, un comprobante aplicado hoy a las 09:00 COT es
anterior al corte y es candidato de este backfill.

## Cuándo

Justo después de aplicar la 0260 en PDN (diseño §«Activación del corte»: con las HUs A, C, R, D, F y H ya
desplegadas). Sin la fila del corte (0260 sin aplicar) el script termina con error (`SinCorteError`) y no
lee ni escribe nada.

## Pasos

1. **Registrar el corte**: aplicar la 0260 con el procedimiento de migraciones de PDN (`pg_dump` previo y
   `docker compose -f docker-compose.prod.yml run --rm api node dist/scripts/db-apply.js`). Desde ese
   instante el gancho normal descuenta y la liquidación deja de mover la bolsa. Comprobar el corte:
   `SELECT corte_en FROM flito_bolsas_corte;` (una fila).
2. **Simulación** (no escribe; corre el mismo camino dentro de una transacción que se deshace):

   ```bash
   docker compose -f docker-compose.prod.yml run --rm api \
     node dist/scripts/flito-bolsas-backfill-comprobantes.js --usuario=<id_usuario_que_ejecuta>
   ```

   En local: `npx tsx src/scripts/flito-bolsas-backfill-comprobantes.ts --usuario=<id>` desde `apps/api`.
3. **Revisar el reporte** con Financiera. Una línea por comprobante y alcance:
   `comprobante <id> | compania|transito | bolsa <id> | <concepto> | <valor> | descontado|ya_descontado|omitido: <motivo>`.
   Motivos esperables: `cubierto_por_liquidacion`, `cubierto_por_conciliacion`, `sin_bolsa`, `inactiva`,
   `concepto_no_cubierto`, `sin_organismo`, `sin_compania`, `autogestionado`. Si una bolsa debería cubrir
   y sale `inactiva`/`sin_bolsa`, se corrige la bolsa **antes** de aplicar. `(saldo negativo)` no bloquea
   (D11); se informa.
4. **Aplicar**, con el mismo usuario:

   ```bash
   docker compose -f docker-compose.prod.yml run --rm api \
     node dist/scripts/flito-bolsas-backfill-comprobantes.js --usuario=<id> --apply
   ```

   Los movimientos se fechan el día de ejecución, se imputan al periodo vigente (si ese mes está cerrado,
   al primero abierto), con `registrado_por` = `--usuario` y observación «Backfill corte comprobantes
   (ADR-0029)».
5. **Si falla a mitad**: cada comprobante va en su propia transacción. Los anteriores quedan completos y el
   que falló sin ningún movimiento. Corregir la causa (el log de error trae el id del comprobante) y volver
   a ejecutar el paso 4: retoma con los pendientes sin duplicar (los ya hechos salen como `ya_descontado`).
6. **Verificación**: una segunda simulación debe mostrar 0 líneas `descontado`.

## Vía SQL desde un cliente gráfico (HU #13972)

Para cuando no se puede correr el script TS en el ambiente: dos archivos SQL **autocontenidos** que dan el
mismo resultado que el script (mismas llaves, omisiones, orden, periodo imputable y `saldo_resultante`; lo
prueba `apps/api/__tests__/scripts/flito-bolsas-backfill-comprobantes-sql.test.ts` contra el TS):

- `apps/api/src/db/manual/flito-bolsas-backfill-comprobantes-simulacion.sql` — `BEGIN … ROLLBACK`: no escribe.
- `apps/api/src/db/manual/flito-bolsas-backfill-comprobantes-aplicar.sql` — `BEGIN … COMMIT`: escribe.

Viven fuera de `migrations/`: el runner (`db:apply`) **no** los aplica. No usan metacomandos de psql (`\set`,
`\i`, `:var`) y crean solo funciones y una tabla **temporales** (`pg_temp`), que desaparecen con la sesión.

Pasos (DBeaver o pgAdmin, conectado a la BD del ambiente con un usuario que pueda escribir en las tablas de bolsas):

1. **Corte registrado** (paso 1 de arriba). Sin la 0260 aplicada el SQL se detiene con
   `Falta el corte: aplique la migración 0260 antes del backfill` y no lee ni escribe nada más.
2. **Abrir `…-simulacion.sql`** y editar **el único valor**: el id del usuario que ejecuta (`users.id`), entre las
   comillas de la línea `SET LOCAL flito.backfill_usuario = '';` al inicio del archivo (p. ej. `'17'`). Es el
   `registrado_por` de los movimientos, el mismo que `--usuario` del script TS. Vacío, no numérico o
   inexistente → se detiene con `Falta el id del usuario…` / `El usuario N no existe…`.
3. **Ejecutar el archivo COMPLETO como script**: DBeaver → *Execute SQL Script* (Alt+X), con «detener en error»
   (por defecto); pgAdmin → Query Tool → *Execute* (F5) sin nada seleccionado (corre todo el editor). No ejecutar sentencias sueltas.
4. **Leer el reporte**: una fila por comprobante × alcance con `linea, comprobante_id, alcance, bolsa_id, concepto,
   valor, resultado, motivo, saldo_negativo`. `resultado`: `descontado` (se asentaría) | `ya_descontado` |
   `omitido` (con `motivo`, los mismos del script TS: `cubierto_por_liquidacion`, `cubierto_por_conciliacion`,
   `sin_bolsa`, `inactiva`, `concepto_no_cubierto`, `sin_organismo`, `sin_compania`, `autogestionado`,
   `sin_valor`, `ya_no_es_candidato`). En DBeaver sale en la pestaña de resultados del `SELECT`; en pgAdmin,
   que solo muestra el resultado de la última sentencia, se lee en la pestaña **Messages**: el SQL emite cada
   línea como `NOTICE` (`comprobante <id> | <alcance> | bolsa <id> | <concepto> | <valor> | <resultado>`) más un
   resumen (candidatos, descuentos nuevos y su total). Revisarlo con Financiera igual que en el paso 3 de arriba.
5. **Abrir `…-aplicar.sql`**, poner el **mismo** usuario y ejecutarlo completo igual que en el paso 3. El
   reporte es el mismo de la simulación, con `descontado` = asentado ahora.
6. **Verificación**: volver a correr la simulación: 0 filas `descontado` (todo `ya_descontado` u `omitido`).

**Si aborta** (cualquier `ERROR` en los mensajes): a diferencia del script TS (una transacción por
comprobante), el SQL corre **todo en una sola transacción**, así que un fallo deshace **todo**: no queda
ningún comprobante a medias ni ningún movimiento de esa ejecución (el `COMMIT` final sobre una transacción
abortada responde `ROLLBACK`). Si el cliente quedó con la transacción abierta, ejecutar `ROLLBACK;`. Se
corrige la causa (el mensaje trae el id del comprobante cuando es de un comprobante) y se vuelve a ejecutar
el archivo completo: es idempotente por llave, así que lo que ya estuviera asentado (por el TS, por una
ejecución anterior o por el gancho) sale como `ya_descontado` y no se duplica.

Diferencias con el script TS que no cambian el resultado: el SQL recorre **todos** los candidatos (no tiene
filtro por comprobante) y fecha los movimientos con el día de Colombia del inicio de la transacción.

## Datos personales (Ley 1581)

El reporte y los logs (y, en la vía SQL, el resultado y los `NOTICE`) llevan solo ids (comprobante, bolsa,
movimiento), concepto, valor y motivo. No
imprimen placas, VIN, NIT ni nombres. No pegar la salida en canales públicos de todos modos.
