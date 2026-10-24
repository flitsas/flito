# TCs — HU #13902 · [BACKEND] – Bolsas: descontar la bolsa de la compañía al aplicar el comprobante, con corte por fecha

> **qa-agent modo A** · contexto `desarrollo-gate` · 2026-10-24 · Feature #13886 (Épica #13412) · HU `Active`.
> **Fuente de los AC:** resumen AC1–AC11 que trae el prompt del hilo (el Gherkin completo vive en ADO). Esta
> invocación tenía prohibido consultar ADO, así que **los AC no se contrastaron contra ADO**. Antes del modo B el
> hilo confirma que el Gherkin de ADO #13902 coincide con este resumen. Si difiere, manda ADO y esta matriz se
> ajusta.
> **Diseño:** `docs/arquitectura/feature-13886-13887-bolsa-unica.md` (HU-C; diagrama «Aplicar comprobante», interfaz
> del gancho `flito-bolsas.descuento.ts` reglas 1–10, contrato con conciliación y liquidación, D15) · **ADR:**
> `docs/adr/ADR-0029-flito-bolsa-unica-descuento-al-aplicar-comprobante.md` (decisiones 5–7 y §D15).
> **Implementación:** `backend-agent` en `/home/david/flit/flito-hu13902` (rama
> `HU/13902-davidchica-bolsa-descuento-al-aplicar-comprobante`). Este documento no escribe código ni ADO.
> **Alcance:** solo el lado **compañía**. El lado tránsito del gancho (regla 4) es de HU-F/H y la reversión por
> desaplicar o reemplazar es de HU-D. Si el diff de esta HU toca tránsito, se añaden TCs y se declara.

## Datos de prueba (sintéticos)

Ningún NIT, nombre ni placa real. Importes en COP con dos decimales. Corte de referencia
`FLITO_BOLSAS_CORTE_COMPROBANTES=2026-12-01` (hora de Colombia, UTC−5, sin horario de verano).

| Dato | Valor | Uso |
|---|---|---|
| `CORTE` | `2026-12-01` → instante de corte `2026-12-01T05:00:00.000Z` (00:00 COT) | AC1, AC3, AC7, AC10 |
| `C1` / `B1` | Compañía `9001` «Compañía Sintética Uno», sin autogestión (`soat_/impuestos_/logistica_autogestionable = false`). Bolsa única `B1` (`alcance='compania'`, `activa=true`), saldo `1000000.00`, conceptos `{soat, impuesto, derecho, tramite_digital, logistica, servicios_adicionales}` | AC2, AC5, AC6, AC8, AC9 |
| `C2` / `B2` | Compañía `9002`. Bolsa `B2` activa **sin** el concepto `logistica` | AC4 (`concepto_no_cubierto`) |
| `C3` | Compañía `9003` **sin** bolsa | AC4 (`sin_bolsa`) |
| `C4` / `B4` | Compañía `9004`. Bolsa `B4` `activa=false`, saldo `300000.00` | AC4 (`inactiva`) |
| `T0` | Trámite con `compania_id = NULL` | AC4 (`sin_compania`) |
| `C5` / `B5` | Compañía `9005` con `logistica_autogestionable = true`, `soat_autogestionable = true`, `impuestos_autogestionable = true`. Bolsa `B5` activa con los seis conceptos, saldo `1000000.00` | AC11 |
| `T1`…`T5` | Trámites de `C1` (`T1`–`T4`) y de `C5` (`T5`) | todos |
| `S1` | SOAT de `T1`, `origen='flito'` | AC6 (llave `salida:soat:<S1>`) |
| `S5c` | SOAT de `T5`, `origen='cliente'` | AC11 (canal cliente) |
| `X5` | Fila en `flito_excepciones_autogestion` para `T5`, concepto `logistica`, vigente | AC11 (excepción vigente) |
| `X5v` | Igual que `X5` pero **vencida** / no vigente | AC11 borde |
| `CP1` | Comprobante `esPago=true`, concepto `derecho`, `valor='250000.00'`, trámite `T2`, `aplicadoEn = 2026-12-02T15:00:00Z` | AC2, AC6, AC8 |
| `CP2` | Comprobante `esPago=true`, concepto `soat`, valor `400000.00`, trámite `T1` (SOAT `S1`) | AC6 |
| `CP3` | Comprobante `esPago=true`, `aplicadoEn = 2026-12-01T04:30:00Z` (= **30-nov 23:30 COT**) | AC3 |
| `CP3b` | Igual que `CP3` pero `aplicadoEn = 2026-12-01T05:00:00Z` (= 01-dic 00:00 COT, el instante exacto del corte) | AC3 borde |
| `CP4` | Comprobante `esPago=false` (documentación) | AC4 (`no_es_pago`) |
| `CP5` | Comprobante `esPago=true`, valor `1200000.00` sobre `B1` con saldo `1000000.00` | AC5 |
| `ctxM` | Usuario sintético `id 7001`, «QA Sintético», aplica a mano | AC2, AC9 |
| `ctxA` | Usuario sintético `id 7002`, «Cargador Sintético», que **cargó** el comprobante auto-aplicado | AC9 |

## Matriz AC → TC

| AC | TC | Tipo | Archivo de test destino | Resultado |
|---|---|---|---|---|
| AC1 | TC-01, TC-02, TC-03 | happy / error | `env.flito-bolsas-corte.test.ts` (nuevo), `flito-bolsas-descuento.test.ts`, `flito-liquidacion.test.ts` | pendiente |
| AC2 | TC-04, TC-05 | happy | `flito-bolsas-descuento.test.ts`, `flito-comprobantes.aplicar.test.ts` | pendiente |
| AC3 | TC-06, TC-07 | borde | `flito-bolsas-descuento.test.ts` | pendiente |
| AC4 | TC-08 | borde | `flito-bolsas-descuento.test.ts` | pendiente |
| AC5 | TC-09 | error / borde | `flito-bolsas-descuento.test.ts`, `flito-comprobantes.aplicar.test.ts` | pendiente |
| AC6 | TC-10, TC-11, TC-12 | borde (dinero) | `flito-bolsas-descuento.test.ts`, `flito-conciliacion-conciliar.test.ts` | pendiente |
| AC7 | TC-13, TC-14 | happy / borde | `flito-liquidacion.test.ts`, `flito-bolsas-descuento.test.ts` | pendiente |
| AC8 | TC-15 | error | `flito-comprobantes.aplicar.test.ts` | pendiente |
| AC9 | TC-16 | happy | `flito-comprobantes.aplicar.test.ts` (o el test de la auto-aplicación que declare el impl) | pendiente |
| AC10 | TC-17 | borde (dinero) | `flito-liquidacion-reversar-correccion.test.ts` | pendiente |
| AC11 | TC-18, TC-19, TC-20, TC-21 | borde (dinero) | `flito-bolsas-descuento.test.ts` | pendiente |
| Gate | TC-22 | comandos | lint + build + shared-types | pendiente |

Todos `pendiente`: modo A; se ejecutan en modo B tras la impl P1. Paths de test relativos a
`apps/api/__tests__/services/`. Los nombres `flito-bolsas-descuento.test.ts` y `env.flito-bolsas-corte.test.ts`
son los esperados; si el `backend-agent` elige otros, los declara en su HANDOFF y el modo B usa los suyos.

**Prioridad para el modo B (dinero):** TC-10/11/12 (AC6), TC-18/19/20/21 (AC11), TC-06/07 (AC3), TC-17 (AC10).

---

### AC1 — Sin corte no cambia nada; formato inválido tumba el arranque

`describe('FLITO_BOLSAS_CORTE_COMPROBANTES — AC1: el corte se despliega apagado', …)`

**TC-01 · `it.each` en `env.flito-bolsas-corte.test.ts`** (patrón de `env.ops08.test.ts` y `COMPROBANTES_AUTO_APLICAR`)
- `'acepta la variable ausente y deja el corte en undefined'` → parse OK, `env.FLITO_BOLSAS_CORTE_COMPROBANTES === undefined`.
- `'acepta 2026-12-01'` → parse OK.
- `'rechaza formatos que no son AAAA-MM-DD'` con `['01/12/2026', '2026-12-1', '2026-13-01', '2026-12-01T00:00:00', 'mañana', '']`
  → el parse lanza (o `safeParse().success === false`) y el mensaje nombra la variable. `2026-02-30` también se
  rechaza si el impl valida fecha real (si solo valida regex, se declara como Nota, no FAIL).

**TC-02 · `it('sin corte configurado el gancho no asienta y devuelve omitido sin movimientos')`** (`flito-bolsas-descuento.test.ts`)
- Pre: variable ausente; `B1` saldo 1 000 000; `CP1`.
- Esperado: 0 INSERT en `flito_bolsas_unicas_movimientos`; saldo `B1` = 1 000 000; el DTO no trae movimientos ni
  alertas. (Si el impl ni siquiera llama al gancho sin corte, el test se escribe sobre `aplicarEnTx` y se declara.)

**TC-03 · `it('sin corte la liquidación descuenta como hoy, GMF incluido')`** (`flito-liquidacion.test.ts`, regresión)
- Esperado: las aserciones existentes del describe de asiento de liquidación siguen en verde sin reescribir
  (salidas por concepto + GMF, llaves `salida:<…>`, saldo baja en Σ). Ninguna aserción de negocio cambia.

### AC2 — Desde el corte, aplicar descuenta en la misma tx con origen «comprobante»

`describe('descontarComprobante — AC2: aplicar un pago desde el corte descuenta la bolsa', …)`

**TC-04 · `it('saldo 1.000.000 menos 250.000 deja 750.000 con origen comprobante y llave salida:comprobante:<id>')`**
- Pre: `CORTE`; `B1` saldo `1000000.00`; `CP1` (derecho, 250 000, `aplicadoEn` 02-dic).
- Esperado: exactamente 1 movimiento `tipo='salida'`, `origen='comprobante'`, `concepto='derecho'`,
  `comprobante_id = CP1`, `tramite_id = T2`, `valor='250000.00'`, `saldo_resultante='750000.00'`,
  `llave_idempotencia = 'salida:comprobante:' + CP1`, `periodo` = periodo imputable (2026-12 si está abierto);
  `flito_bolsas_unicas.saldo = '750000.00'`. El DTO `bolsa` trae el movimiento y `alertas = []`.

**TC-05 · `it('el descuento corre dentro de la tx de aplicar: si aplicarEnTx falla después, no queda movimiento')`**
(`flito-comprobantes.aplicar.test.ts`)
- Pasos: forzar un error de BD posterior a `descontarComprobante` dentro de `aplicarEnTx` (mock de la tx).
- Esperado: el gancho recibió **la misma** `tx` (no `db`); tras el rollback, 0 movimientos y saldo intacto; el
  comprobante no queda `aplicado`. Borde: el orden de locks registrado en el mock es comprobante → trámite → bolsa.

### AC3 — Antes del corte (hora Colombia) se omite con `antes_del_corte`

`describe('descontarComprobante — AC3: el corte se mide en hora de Colombia', …)`

**TC-06 · `it('aplicado el 30-nov 23:30 COT (01-dic 04:30Z) con corte 2026-12-01 se omite antes_del_corte')`**
- Pre: `CORTE`; `CP3`.
- Esperado: `omitidos` contiene `{ motivo: 'antes_del_corte' }` con el `comprobanteId`; 0 movimientos; saldo
  intacto. **Este TC mata la comparación en UTC** (en UTC el comprobante ya sería del 01-dic): ver M3.

**TC-07 · `it('aplicado exactamente a las 00:00 COT del día del corte sí descuenta')`** (borde `≥`)
- Pre: `CORTE`; `CP3b` (`2026-12-01T05:00:00Z`).
- Esperado: 1 salida `origen='comprobante'`; mata la variante `>` en vez de `≥`.

### AC4 — Omisiones sin alerta, cada una con su motivo

`describe('descontarComprobante — AC4: lo que no aplica se omite sin alerta', …)`

**TC-08 · `it.each` de cinco casos** (todos con `CORTE` vigente y `aplicadoEn` posterior)

| Caso | Pre | Motivo esperado |
|---|---|---|
| concepto no cubierto | `B2` sin `logistica`; comprobante `logistica` de `C2` | `concepto_no_cubierto` |
| sin bolsa | trámite de `C3` | `sin_bolsa` |
| bolsa inactiva | trámite de `C4` (`B4` inactiva, saldo 300 000) | `inactiva` |
| sin compañía | trámite `T0` | `sin_compania` |
| no es pago | `CP4` (`esPago=false`) sobre `T2` de `C1` | `no_es_pago` |

- Esperado en cada caso: `omitidos = [{ motivo: <esperado>, … }]` (`toEqual` del motivo exacto), `alertas = []`,
  0 INSERT en `_movimientos`, 0 INSERT en `flito_bolsas_unicas` (no autocrea), saldo de `B4` sigue 300 000, y la
  aplicación del comprobante **no** lanza. Logs solo con ids (sin NIT/placa).

### AC5 — Saldo insuficiente: se aplica igual, queda negativo y hay alerta

**TC-09 · `it('con saldo 1.000.000 y comprobante de 1.200.000 deja -200.000 y devuelve alerta con bolsa y saldo')`**
- Pre: `CORTE`; `B1` saldo 1 000 000; `CP5`.
- Esperado: 1 salida de 1 200 000, `saldo_resultante='-200000.00'`, saldo `B1 = '-200000.00'`; `alertas` =
  `[{ bolsaId: B1, saldo: '-200000.00', … }]`; la promesa **no** rechaza (regla «nunca lanza por saldo»).
- En `flito-comprobantes.aplicar.test.ts`: el comprobante queda `aplicado` y el detalle devuelto trae
  `bolsa` con la alerta (`ComprobanteDetalleDto.bolsa`, D11).

### AC6 — Idempotencia: nunca dos cobros por el mismo comprobante o el mismo SOAT (dinero)

`describe('descontarComprobante — AC6: una sola salida por comprobante y por SOAT', …)`

**TC-10 · `it('llamar dos veces con el mismo comprobante deja una sola salida y el saldo en 750.000')`**
- Pre: `CORTE`; `B1` 1 000 000; `CP1`.
- Pasos: `descontarComprobante` dos veces (secuencial; si el arnés lo permite, también `Promise.all` sobre la BD
  real con `FOR UPDATE`).
- Esperado: 1 movimiento con la llave `salida:comprobante:<CP1>`; saldo 750 000 (no 500 000); la segunda llamada
  no lanza y devuelve 0 movimientos nuevos. Mata la variante que solo confía en el `catch` del índice único sin
  devolver el resultado coherente.

**TC-11 · `it('SOAT ya conciliado con salida:soat:<S1> se omite cubierto_por_conciliacion')`**
- Pre: `CORTE`; en `B1` existe una salida `origen='conciliacion'` con llave `salida:soat:<S1>` (400 000; saldo
  600 000).
- Pasos: aplicar `CP2` (SOAT de `T1`).
- Esperado: `omitidos = [{ motivo: 'cubierto_por_conciliacion' }]`; sigue 1 salida para `S1`; saldo 600 000.
  Además se afirma que la llave que el gancho **intentó** usar para el SOAT es `salida:soat:<S1>` y **no**
  `salida:comprobante:<CP2>` — si usara la del comprobante, cobraría dos veces. Mata M1.

**TC-12 · `it('orden inverso: comprobante SOAT primero y conciliación después cobra una sola vez')`**
(`flito-conciliacion-conciliar.test.ts`, mock `createKeyedDb` como hoy)
- Pre: `CORTE`; `CP2` aplicado y descontado (salida `origen='comprobante'`, llave `salida:soat:<S1>`; saldo 600 000).
- Pasos: `conciliarBoleta` de `S1`.
- Esperado: 0 INSERT nuevos en `_movimientos` del lado cliente; la línea de conciliación apunta
  (`movimiento_bolsa_id`) al movimiento existente del comprobante; saldo 600 000.

### AC7 — Con corte vigente la liquidación no mueve la bolsa; lo liquidado antes del corte no se cobra otra vez

**TC-13 · `it('con corte vigente liquidar no asienta ninguna salida, tampoco el GMF')`** (`flito-liquidacion.test.ts`)
- Pre: `CORTE`; `fechaContable()` = 2026-12-03; `B1` activa.
- Esperado: 0 INSERT en `flito_bolsas_unicas_movimientos` (ni concepto ni `gmf`); saldo `B1` intacto; la
  liquidación queda sellada como hoy. Borde: con `fechaContable()` = 2026-11-30 (antes del corte) **sí** asienta
  como hoy (GMF incluido).

**TC-14 · `it('trámite liquidado antes del corte y comprobante aplicado después se omite cubierto_por_liquidacion')`**
(`flito-bolsas-descuento.test.ts`)
- Pre: `CORTE`; en `B1` una salida viva `origen='automatico'`, `tramite_id = T2`, `concepto='derecho'` (fecha
  2026-11-20); `CP1` aplicado el 02-dic.
- Esperado: `omitidos = [{ motivo: 'cubierto_por_liquidacion' }]`; 0 salidas nuevas; saldo intacto.
- Borde: si esa salida automática ya fue **reversada** (llave `rev:` + entrada de reversa), no está viva y el
  comprobante **sí** descuenta. Borde 2: salida automática del mismo trámite pero **otro** concepto → sí descuenta.

### AC8 — Rechazo del dueño tras el commit: entrada enlazada que revierte la salida

**TC-15 · `it('si el dueño rechaza después del commit, una entrada con revierte_movimiento_id devuelve el saldo')`**
(`flito-comprobantes.aplicar.test.ts`, camino `pagarDespuesDelCommit`)
- Pre: `CORTE`; `CP1` aplicado → salida `M` (saldo 750 000); el dueño (derecho o SOAT) rechaza en el post-commit.
- Esperado: 1 entrada `tipo='entrada'`, `origen='comprobante'`, `revierte_movimiento_id = M`, `comprobante_id =
  CP1`, valor 250 000; saldo `B1` = 1 000 000; la llave de `M` pasa a `rev:salida:comprobante:<CP1>` (única
  columna reescrita; valor de `M` intacto). La compensación corre con `compensacion: true` (sin el bloqueo de
  periodo cerrado D14).
- Borde: si la compensación se ejecuta dos veces, el índice único parcial de `revierte_movimiento_id` impide una
  segunda entrada (sigue 1; saldo 1 000 000).

### AC9 — La auto-aplicación descuenta igual y a nombre de quien cargó

**TC-16 · `it('la auto-aplicación descuenta igual que la manual y registra a quien cargó el comprobante')`**
- Pre: `CORTE`; `COMPROBANTES_AUTO_APLICAR` activo; `CP1` cargado por `ctxA` y auto-aplicado.
- Esperado: el mismo movimiento que TC-04 (valor, llave, origen, saldo) con `registrado_por_id = 7002` y
  `registrado_por_nombre = 'Cargador Sintético'`; nunca un usuario de sistema ni `null`. Contraste: la aplicación
  manual por `ctxM` registra `7001`.
- Archivo: el que cubre hoy la auto-aplicación; si no es `flito-comprobantes.aplicar.test.ts`, el impl lo declara.

### AC10 — Reversar después del corte una liquidación anterior al corte: un único descuento neto (dinero)

**TC-17 · `it('reversar tras el corte una liquidación previa devuelve sus salidas y descuenta el comprobante una vez')`**
(`flito-liquidacion-reversar-correccion.test.ts`)
- Pre: `CORTE`; `T2` liquidado el 2026-11-20 → salida automática `derecho` 250 000 (saldo 750 000); `CP1`
  aplicado el 02-dic y omitido `cubierto_por_liquidacion` (saldo sigue 750 000).
- Pasos: `reversar()` de la liquidación de `T2` el 2026-12-05.
- Esperado, en la misma tx: entrada de reversa 250 000 (llave original liberada con `rev:`) **y** salida
  `origen='comprobante'` de `CP1` por 250 000 → saldo final **750 000** (neto un solo descuento). Conteo: 1
  salida automática + 1 entrada de reversa + 1 salida de comprobante.
- Borde: si el trámite tiene dos comprobantes aplicados, se descuentan ambos; si la reversa ocurre **antes** del
  corte, no se llama a `descontarComprobante` (saldo 1 000 000).
- Borde de rollback: si el descuento del comprobante falla con error de BD, la reversa tampoco queda.

### AC11 (D15) — Lo autogestionado no descuenta, salvo excepción vigente o SOAT del canal cliente (dinero)

`describe('descontarComprobante — AC11: autogestión por compañía (D15)', …)`

**TC-18 · `it.each` «autogestionado no descuenta» sobre `C5`/`B5`** (saldo 1 000 000)
- Casos: `logistica` (`logistica_autogestionable`), `impuesto` (`impuestos_autogestionable`), `soat` con `origen='flito'`
  (`soat_autogestionable`).
- Esperado: 0 movimientos; saldo 1 000 000; el comprobante se aplica igual (también como soporte). Motivo en
  `omitidos`: el que fije el impl (p. ej. `autogestionado`); el test lo nombra con `toEqual`. Si el impl lo omite
  sin motivo, es hallazgo para el gate (AC4 exige motivo por omisión). Mata M2.

**TC-19 · `it('con excepción de autogestión vigente para el trámite sí descuenta')`**
- Pre: `X5` vigente para `T5` / `logistica`.
- Esperado: 1 salida `origen='comprobante'` en `B5`; saldo baja en el valor.
- Borde: con `X5v` (vencida o no vigente) **no** descuenta. Borde 2: excepción vigente de **otro** trámite o de
  otro concepto → no descuenta.

**TC-20 · `it('SOAT del canal cliente (origen=cliente) sí descuenta aunque la compañía autogestione SOAT')`**
- Pre: `S5c` (`origen='cliente'`) en `T5`; comprobante SOAT de `T5`.
- Esperado: 1 salida con llave `salida:soat:<S5c>` en `B5`. Contraste con TC-18 caso `soat` (`origen='flito'`).

**TC-21 · `it.each` «los conceptos sin autogestión descuentan siempre»** sobre `C5`
- Casos: `derecho`, `tramite_digital`, `servicios_adicionales` (no tienen autogestión según D15).
- Esperado: 1 salida cada uno. Mata la variante que trata «compañía con alguna autogestión» como bloqueo general.
- Nota de consistencia: D15 dice «la misma regla que usa el reporte de costos». Si el impl reutiliza ese helper,
  en modo B se comprueba con un `grep` de import; si duplica la lógica, es Nota (no FAIL) salvo que difieran.

### Gate de comandos

**TC-22**
- `npm run lint` exit 0 sin errores nuevos; `flito-bolsas.service.ts` no crece (techo congelado, ADR-0029 §9); los
  archivos nuevos (`flito-bolsas.descuento.ts`, `flito-bolsas.resolver.ts`) ≤ 800 líneas.
- `NODE_OPTIONS=--max-old-space-size=8192 npm run build:api` exit 0.
- Si se tocó `packages/shared-types` (`ComprobanteDetalleDto.bolsa`, `DescuentoBolsaDto`):
  `npm run build -w packages/shared-types`, `npm run typecheck -w apps/web` y el grep de la regla 7
  (`grep -rn "ComprobanteDetalleDto\|DescuentoBolsaDto" apps/web/src`) pegados.

---

## Mutantes previstos para el modo B (tope 3, P2)

| # | Mutación (temporal, en la rama de la HU) | Debe matarlo | Comando |
|---|---|---|---|
| M1 | En `flito-bolsas.descuento.ts`, usar para el SOAT la llave `salida:comprobante:<id>` en vez de `salida:soat:<soatId>` (rompe la garantía compartida con ADR-0006) | TC-11 (y TC-12) | `npm test -w apps/api -- __tests__/services/flito-bolsas-descuento.test.ts __tests__/services/flito-conciliacion-conciliar.test.ts` |
| M2 | En `flito-bolsas.descuento.ts` (o el resolver), quitar la comprobación de autogestión: todo concepto cubierto descuenta | TC-18 | `npm test -w apps/api -- __tests__/services/flito-bolsas-descuento.test.ts` |
| M3 | Comparar `aplicadoEn` con el corte en UTC (`new Date(corte + 'T00:00:00Z')`) en lugar de hora de Colombia | TC-06 | `npm test -w apps/api -- __tests__/services/flito-bolsas-descuento.test.ts` |

Alternativas si alguno no aplica a la forma del impl (el tope sigue siendo 3; se declara el cambio): quitar la
regla `cubierto_por_liquidacion` → TC-14; quitar el re-descuento en `reversar()` → TC-17; ignorar la excepción
vigente → TC-19.

## Comandos del modo B (P1)

```bash
# Tests de ESTE WI (lista explícita; nada de glob del directorio). Ajustar a los que el diff realmente crea o toca.
npm test -w apps/api -- \
  __tests__/services/env.flito-bolsas-corte.test.ts \
  __tests__/services/flito-bolsas-descuento.test.ts \
  __tests__/services/flito-comprobantes.aplicar.test.ts \
  __tests__/services/flito-conciliacion-conciliar.test.ts \
  __tests__/services/flito-liquidacion.test.ts \
  __tests__/services/flito-liquidacion-reversar-correccion.test.ts
# + el test de auto-aplicación si vive en otro archivo (declarado por el impl)

npm run lint
NODE_OPTIONS=--max-old-space-size=8192 npm run build:api
```

Sin `schema.ts` ni `migrations/` previstos en esta HU ⇒ `db-review-agent` no aplica salvo que el diff los toque
(p. ej. un índice para `cubierto_por_liquidacion`). Sin rutas nuevas, el `security-agent` probablemente no aplica
(P5); lo decide el hilo con el diff, porque el gancho escribe movimientos con `registrado_por_*`.

## Riesgos / notas para la implementación

- **Hora de Colombia.** Es el borde con más probabilidad de error silencioso: el contenedor corre en UTC. TC-06 y
  TC-07 juntos fijan el instante exacto (`T05:00:00Z`). Un test que solo use fechas lejanas al corte no lo cubre.
- **Llave del SOAT.** El SOAT es el único concepto cuya llave no es la del comprobante. Si el test de AC6 solo
  comprueba «no hay dos salidas» con una sola fuente (comprobante dos veces), M1 sobrevive: hace falta TC-11/TC-12.
- **Test con mocks vs BD real.** Si `flito-bolsas-descuento.test.ts` depende de `DATABASE_URL` y sale `skipped`, AC2–
  AC6 y AC11 quedan sin evidencia: `SIN-ENTORNO` para esa parte, nunca `PASS`. El gate exige `N passed` con N > 0.
- **Motivo de la omisión por autogestión.** El resumen de AC11 no nombra el motivo; el impl lo fija y lo declara.
  Lo que no se acepta es omitir sin motivo.
- **Corte en `env.ts`.** «El arranque falla» se prueba sobre el esquema Zod (o el parse de `config/env.ts`), no
  levantando el proceso. Si el impl valida en otro sitio, lo declara.
- Datos 100 % sintéticos; `Compañía Sintética …` y los ids `90xx` existen solo para comprobar que no salen en logs.
