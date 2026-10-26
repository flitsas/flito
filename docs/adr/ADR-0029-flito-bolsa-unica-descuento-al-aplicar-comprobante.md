# ADR-0029 — Bolsa única (compañía | tránsito) en tablas nuevas, con copia de ids preservados, y descuento al aplicar el comprobante

- **Estado:** Aceptado (2026-10-23). Aprobado por David Chica en la sesión de diseño (Opción A), con las decisiones de cierre Q1-Q7.
- **Fecha:** 2026-10-23
- **Features:** #13886 (bolsa de clientes) y #13887 (bolsa de tránsito), Épica #13412
- **Relacionados:**
  - ADR-0006 (conciliación de boletas SOAT): se **conserva** su llave `salida:soat:<soatId>` / `consumo:soat:<soatId>` como garantía de «nunca dos veces», ahora compartida con el comprobante.
  - ADR-0018 (comprobantes universales, valor documental): aquí se le añade el efecto en bolsa.
  - ADR-0024/0025 (frontera por enlace y permisos por función).
  - ADR-0028 (expediente documental de la compañía, Épica #13407): consume el contrato `estadoBolsaDeCompania`.
  - No supersede ninguno.
- **Diseño operativo:** `docs/arquitectura/feature-13886-13887-bolsa-unica.md`

## Contexto

FLITO tiene dos libros de bolsa con reglas hermanas pero separadas:

- el del cliente: `flito_bolsas`, `flito_bolsa_movimientos` y `flito_bolsa_cierres`, una bolsa por compañía que se **autocrea** al primer movimiento;
- el de tránsito: `flito_bolsas_transito`, `flito_bolsa_transito_cobertura` y `flito_bolsa_transito_movimientos`, con la pareja (secretaría, concepto) única **sin** condición de estado.

Hoy el descuento ocurre al **sellar la liquidación** y, para el SOAT, también al conciliar boletas (ADR-0006).

El humano cerró el 2026-10-23 las decisiones D1-D14 (ver el diseño):

- un modelo único con alcance;
- bolsas que nunca se borran, solo se inactivan;
- migración de ambos libros y retiro de los viejos;
- creación solo manual;
- descuento **al aplicar el comprobante** por su valor documental, hasta dos movimientos (compañía + tránsito);
- reversión enlazada al movimiento original;
- bloqueo si el movimiento cayó en un periodo cerrado;
- corte por fecha configurable.

Hay tres restricciones técnicas:

- `schema.ts` y `flito-bolsas.service.ts` están en su techo ESLint congelado y no pueden crecer;
- las migraciones son SQL a mano;
- la operación «aplicar comprobante» ya existe (`flito-comprobantes.aplicar.ts` → `aplicarEnTx`), pero **no existe** ninguna operación sobre un comprobante ya aplicado (desaplicar o reemplazar).

## Decisión

1. **Tablas nuevas `flito_bolsas_unicas*`** (bolsas, conceptos, cobertura, movimientos, cierres, eventos) en `apps/api/src/db/schema/flito-bolsas-unicas.ts`, re-exportado desde `schema.ts`. `alcance` ∈ {`compania`, `transito`} es inmutable.
2. **Unicidad en la base, no en el código:**
   - 1:1 compañía-bolsa con el índice **parcial** `… (compania_id) WHERE alcance='compania'`, que incluye las bolsas inactivas;
   - pareja (secretaría, concepto) única **solo entre activas**, con `activa` copiado en la cobertura e índice parcial;
   - una sola reversión por movimiento, con índice único parcial sobre `revierte_movimiento_id`.
3. **Migración por copia con UUID preservados**, una por Feature (cliente y tránsito), con `LOCK EXCLUSIVE`, verificación `saldo = Σ libro` y conteos dentro de la misma transacción (falla en vez de corregir), y repunte de `flito_concil_lineas` solo por DDL. Las bolsas de cliente sin movimientos ni cierres no se migran. Los libros viejos se retiran en una migración **posterior**, después de verificar PDN.
4. **Sin autocreación.** Recargar sin bolsa devuelve 409 `bolsa_inexistente`. La liquidación y la conciliación sin bolsa (o con bolsa inactiva) no asientan en ese lado.
5. **Gancho del descuento dentro de la transacción de aplicar** (`descontarComprobante(tx, …)`, llamado después de `cerrarComoPago`). Si el dueño SOAT o derecho rechaza tras el commit, la compensación existente también revierte el descuento. Orden de locks fijo: comprobante → trámite → bolsa compañía → bolsa tránsito.
6. **Llaves de idempotencia:**
   - SOAT: la de ADR-0006, compartida con la conciliación;
   - el resto de conceptos: `salida:comprobante:<id>` / `consumo:comprobante:<id>`;
   - al revertir: entrada nueva enlazada y llave del original liberada con el prefijo `rev:`, que es el precedente de `reversarSalidasLiquidacion` y la única columna reescrita, sin tocar dinero.
7. **Corte por configuración**, con `FLITO_BOLSAS_CORTE_COMPROBANTES` (fecha ISO, opcional) en `config/env.ts`. Sin valor, el comportamiento es el de hoy. Con valor, la liquidación deja de mover la bolsa desde esa fecha y el comprobante aplicado desde esa fecha descuenta. Lo que ya descontó una liquidación anterior al corte no se vuelve a descontar.
   > **D12 reemplazada por HU #13965 (2026-10-25, decisión de David Chica):** corte automático al aplicar la migración `0260_flito_bolsas_corte_automatico.sql`, que registra el instante `now()` en la tabla de una fila `flito_bolsas_corte` (re-aplicarla no lo sobrescribe). La comparación es por **instante**, no por día de Colombia: el comprobante descuenta si `aplicado_en >= corte_en`, la liquidación deja de mover la bolsa cuando ahora `>= corte_en` y el backfill toma `aplicado_en < corte_en`. Sin la fila (0260 sin aplicar), todo sigue como antes. La variable de entorno se eliminó de `config/env.ts` y `.env.example`.
8. **Contrato con #13407:** `estadoBolsaDeCompania(companiaId: number): Promise<{ existe: boolean; activa: boolean }>` en `apps/api/src/modules/flito-bolsas/flito-bolsas.estado-compania.ts`. El modelo de bolsa no tiene documentos.
9. **Reparto para respetar los techos:** la lógica nueva va en `flito-bolsas.libro.ts`, `.catalogo.service.ts`, `.resolver.ts`, `.descuento.ts` y `.estado-compania.ts`; `flito-bolsas.service.ts` solo puede bajar de líneas.

## Alternativas descartadas

- **B. Evolución in situ de `flito_bolsas`**, que absorbería tránsito. Es más barata (esfuerzo M) y conserva los nombres genéricos. Se descarta por tres motivos:
  - hace `ALTER` y cambia la unicidad sobre el libro vivo;
  - rompe el `onConflictDoNothing(companiaId)` del código viejo durante el deploy;
  - el rollback exige una migración inversa sobre datos mezclados.

  Además, `flito_bolsas` «se transforma» en lugar de retirarse, lo que se aparta de la letra de D5. Es viable si el Líder Técnico prioriza los nombres y acepta esa lectura de D5.
- **C. Fachada de servicio sobre los dos libros físicos.** Se descarta porque incumple D1 y D5 y obliga a duplicar en dos libros cada regla nueva (inactivar, reversión, bloqueo por cierre).
- **Descontar después del commit del dueño, en lugar de dentro de la tx de aplicar.** Evitaría el par salida + reversión cuando el dueño rechaza, pero un fallo del proceso entre el commit y el descuento dejaría comprobantes aplicados sin descuento. Se prefiere la atomicidad.

## Consecuencias

- **(+)**
  - Las restricciones de D1, D3 y D13 viven en índices de PostgreSQL.
  - El rollback es trivial hasta el retiro.
  - Cada Feature migra su libro.
  - El corte se despliega apagado.
- **(−)**
  - Se copia el histórico del cliente.
  - El deploy de las migraciones de datos exige un runbook (pre-flight, `pg_dump`, api parada).
  - Quedan nombres de tabla `_unicas`.
  - El fallback temporal de #13407 (`EXISTS` sobre `flito_bolsas`) deja de ser correcto desde la HU-A y debe migrarse a `estadoBolsaDeCompania`, como tarde en el PR del retiro.
- **Dependencia interna:** la operación de desaplicar o reemplazar un comprobante aplicado no existe hoy. La construye la HU-R de #13886, en `flito-comprobantes`, antes de la HU-D.

## Decisiones de cierre (Q1-Q7)

Las comunicó el hilo principal el 2026-10-23, atribuidas a David Chica:

- **Q1.** La conciliación de boletas SOAT (ADR-0006) **sigue** moviendo las bolsas, con la misma llave de idempotencia que el comprobante SOAT.
- **Q2.** El gancho en `aplicarEnTx` y la operación nueva de desaplicar/reemplazar son HUs de **#13886**, no de #12606.
- **Q3.** Las bolsas de tránsito **sí** tienen cierre mensual (único por `bolsa_id` + periodo), y el bloqueo por periodo cerrado (D14) también rige en tránsito.
- **Q4.** **Sí** hay backfill al activar el corte.
- **Q5.** Si hay descuadre entre saldo y suma del libro, la migración falla. Se corrige **antes** con un movimiento de ajuste manual auditado y se vuelve a correr.
- **Q6.** El GMF (4x1000) **deja** de descontarse de la bolsa.
- **Q7.** Una bolsa inactiva **no** admite recargas, movimientos manuales (incluidas las correcciones) ni descuentos; primero hay que reactivarla.

## D15 — Autogestión por compañía (2026-10-23, David Chica)

Una compañía puede autogestionar SOAT, impuestos o logística (`clients.soat_autogestionable`, `impuestos_autogestionable`, `logistica_autogestionable`); en tránsito, los impuestos de un organismo con modalidad `autogestionado` tampoco los gestiona FLIT. Derechos, trámite digital y servicios adicionales no tienen autogestión.

- **Crear o editar la bolsa:** un concepto autogestionado **se puede marcar**. La UI lo muestra con el aviso «no llegarán movimientos salvo excepciones» y un enlace a Parametrización para habilitar la gestión. La API entrega `conceptosAutogestionados`, calculado al consultar y nunca guardado en la bolsa (HU #13900, AC11; HU #13901, AC10).
- **Cambio posterior:** si la autogestión cambia después de crear la bolsa, el detalle muestra el mismo aviso.
- **Descuento (HU #13902, AC11):** un comprobante aplicado a un concepto que la compañía autogestiona **no descuenta**, aunque se aplique como soporte (Épica #12245, cierre e). Sí descuenta si el trámite tiene una excepción de autogestión vigente (`flito_excepciones_autogestion`) o si es un SOAT del canal cliente (`origen = 'cliente'`). Es la misma regla que usa el reporte de costos.
- **Tránsito (HU #13907/#13908, AC9):** mismo aviso para el concepto impuesto en las secretarías cuyo organismo tiene modalidad `autogestionado`.
- **Habeas Data (HU #13900):** en la proyección cliente (usuario con enlace de compañía) se ocultan quién inactivó la bolsa y el motivo; la fecha sí se muestra.
