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

## Datos personales (Ley 1581)

El reporte y los logs llevan solo ids (comprobante, bolsa, movimiento), concepto, valor y motivo. No
imprimen placas, VIN, NIT ni nombres. No pegar la salida en canales públicos de todos modos.
