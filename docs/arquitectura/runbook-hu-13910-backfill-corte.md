# Runbook — backfill de comprobantes al activar el corte (HU #13910, ADR-0029 Q4)

Script: `apps/api/src/scripts/flito-bolsas-backfill-comprobantes.ts`. Descuenta de las bolsas (compañía y
tránsito) los comprobantes de pago **aplicados antes** de `FLITO_BOLSAS_CORTE_COMPROBANTES`, con el mismo
gancho, las mismas llaves y las mismas omisiones que el descuento normal. Es idempotente: re-ejecutarlo no
duplica movimientos.

## Cuándo

En el **mismo acto** en que se fija `FLITO_BOLSAS_CORTE_COMPROBANTES` en PDN (diseño §«Activación del
corte»: con las HUs A, C, R, D, F y H ya desplegadas). Sin el corte configurado el script termina con
error y no lee ni escribe nada.

## Pasos

1. **Fijar el corte** (`FLITO_BOLSAS_CORTE_COMPROBANTES=AAAA-MM-DD`) en el `.env` de PDN y reiniciar la api
   para que el gancho normal empiece a descontar desde esa fecha.
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

## Datos personales (Ley 1581)

El reporte y los logs llevan solo ids (comprobante, bolsa, movimiento), concepto, valor y motivo. No
imprimen placas, VIN, NIT ni nombres. No pegar la salida en canales públicos de todos modos.
