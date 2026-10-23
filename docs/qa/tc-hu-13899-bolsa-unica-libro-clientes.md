# TCs — HU #13899 · [BACKEND] – Bolsas: modelo único de bolsa y migración del libro de clientes con saldo e historial

> **qa-agent modo A** · contexto `desarrollo-gate` · 2026-10-23 · Feature #13886 (Épica #13412) · HU `Active`.
> **Fuente de los AC:** resumen AC1–AC10 que trae el prompt del hilo (el Gherkin completo vive en ADO). El MCP `ado`
> no estaba expuesto en esta invocación del subagente, así que **los AC no se contrastaron contra ADO**. Antes del
> modo B, el hilo confirma que el Gherkin de ADO #13899 coincide con este resumen; si difiere, manda ADO y esta
> matriz se ajusta.
> **Diseño:** `docs/arquitectura/feature-13886-13887-bolsa-unica.md` (HU-A; plan 0249/0250, contrato (d) y (f) para
> #13407, Q5 y Q7) · **ADR:** `docs/adr/ADR-0029-flito-bolsa-unica-descuento-al-aplicar-comprobante.md`.
> **Implementación:** `backend-agent` en `/home/david/flit/flito-hu13899` (rama
> `HU/13899-davidchica-bolsa-unica-modelo-libro-clientes`). Este documento no escribe código ni ADO.

## Datos de prueba (sintéticos)

Ningún NIT, nombre ni placa real. Importes en COP con dos decimales. Los ids `uuid` son fijos en la fixture para
poder comprobar que **se preservan**.

| Dato | Valor | Uso |
|---|---|---|
| `C1` / `B1` | Compañía id `9001` «Compañía Sintética Uno», NIT `900000001`. Bolsa `B1` = `11111111-…-0001`, saldo `700000.00`. Libro: `M1` entrada `recarga` 1 000 000 (periodo `2026-08`); `M2` salida `automatico` 250 000 con llave `salida:soat:<S1>` y `tramite_id = T1`; `M3` salida `manual` 50 000 con `corrige_movimiento_id = NULL`; `M4` entrada `manual` que corrige a `M3` (`corrige_movimiento_id = M3`, valor 50 000) y `M5` salida `manual` 50 000 — Σ libro = 700 000. Cierre `K1` periodo `2026-08` | AC1, AC4, AC5 |
| `C2` / `B2` | Compañía `9002`. Bolsa `B2` **autocreada**: saldo 0, sin movimientos ni cierres | AC2 |
| `C3` / `B3` | Compañía `9003`. Bolsa `B3` con **solo un cierre** (`K3`, periodo `2026-07`, todo en 0) y ningún movimiento | AC1 borde (D5 excluye solo «sin movimientos **y** sin cierres») |
| `C4` / `B4` | Compañía `9004`, NIT `900000004`, nombre «Compañía Descuadrada». Bolsa `B4` saldo `500000.00`, libro: una entrada `recarga` 450 000 ⇒ descuadre de 50 000 | AC3 (solo en el caso de descuadre; fuera de él no se siembra) |
| `C5` | Compañía `9005` **sin** bolsa en ningún libro | AC6, AC7, AC9 |
| `B6` (post-migración) | Bolsa única de `C6` (`9006`), `alcance='compania'`, `activa=false`, `inactivada_en` y motivo sintético «Inactivada para prueba» | AC8, AC9 |
| `S1` / `T1` | SOAT `S1` (uuid fijo) del trámite `T1` de `C1` | AC5 (llave `salida:soat:<S1>`) |
| `L1` | `flito_concil_lineas` con `movimiento_bolsa_id = M2` | AC5 (re-apunte de FK) |
| `ctx` | Usuario sintético `id 7001`, nombre «QA Sintético», con `bolsas.recarga.registrar` y `bolsas.movimiento.registrar` | AC7, AC8 |

## Matriz AC → TC

| AC | TC | Tipo | Archivo de test destino | Resultado |
|---|---|---|---|---|
| AC1 | TC-01, TC-02, TC-03, TC-04, TC-05, TC-06 | happy / borde | `flito-bolsas-unicas-migracion.test.ts` | pendiente |
| AC2 | TC-07, TC-08 | borde | `flito-bolsas-unicas-migracion.test.ts` | pendiente |
| AC3 | TC-09, TC-10, TC-11 | error | `flito-bolsas-unicas-migracion.test.ts` + revisión del runbook | pendiente |
| AC4 | TC-12 | borde | `flito-bolsas-unicas-migracion.test.ts` + P6 manual | pendiente |
| AC5 | TC-13, TC-14, TC-15 | happy / borde | migración + `flito-conciliacion-conciliar.test.ts` | pendiente |
| AC6 | TC-16, TC-17, TC-18 | happy / borde | `flito-liquidacion.test.ts` (+ `-reversar-correccion`) | pendiente |
| AC7 | TC-19, TC-20 | error / happy | `flito-bolsas.test.ts`, `flito-bolsas.routes.test.ts` | pendiente |
| AC8 | TC-21, TC-22, TC-23, TC-24, TC-25 | error / borde | `flito-bolsas.test.ts`, `flito-bolsas-manuales.test.ts`, `flito-bolsas-cierre.test.ts` | pendiente |
| AC9 | TC-26 | happy / borde | `flito-bolsas-estado-compania.test.ts` | pendiente |
| AC10 | TC-27, TC-28, TC-29 | gate | comandos (no Vitest) | pendiente |

Todos `pendiente`: modo A; se ejecutan en modo B tras la impl P1.

Todos los paths de test son relativos a `apps/api/__tests__/services/`.

---

### AC1 — La migración copia saldo, movimientos y cierres con los mismos ids; saldo = Σ libro; evento «migrar»

Test de migración **contra Postgres real** (siembra los libros viejos, aplica `0249` + `0250`, consulta). Seguir el
arnés de `__tests__/db/migracion-01xx.test.ts` (los que usan `DATABASE_URL`). **Aviso para el modo B:** si el arnés
hace `skipIf(!DATABASE_URL)`, un run en verde **con los tests saltados no cuenta**. El gate exige ver
`N passed` con N > 0 en este archivo; si se saltan, el resultado es `SIN-ENTORNO`, no `PASS`.

`describe('migración 0250 — AC1: el libro del cliente pasa al modelo único con sus ids', …)`

**TC-01 · `it('copia la bolsa con el mismo id, alcance compania, activa y los seis conceptos')`**
- Pre: libros viejos sembrados con `B1`, `B2`, `B3`; `flito_bolsas_unicas*` vacías.
- Pasos: aplicar `0249` + `0250`.
- Esperado: existe `flito_bolsas_unicas.id = B1` con `alcance='compania'`, `compania_id=9001`, `activa=true`,
  `nombre IS NULL`, `saldo='700000.00'`, `ultima_entrada_valor/_en` = `ultima_recarga_valor/_en` viejos,
  `created_at` preservado. `flito_bolsas_unicas_conceptos` de `B1` = exactamente
  `{soat, impuesto, derecho, tramite_digital, logistica, servicios_adicionales}` (sin `gmf`).

**TC-02 · `it('copia cada movimiento con su id, su llave, su corrección y su periodo')`**
- Esperado: para `M1`…`M5`, la fila en `flito_bolsas_unicas_movimientos` con el **mismo id** tiene `bolsa_id=B1` y
  los mismos `tipo, origen, concepto, organismo_codigo, tramite_id, valor, saldo_resultante, periodo, fecha,
  observacion, soporte_id, registrado_por_id, registrado_por_nombre, llave_idempotencia, corrige_movimiento_id,
  created_at`. `M4.corrige_movimiento_id = M3` (la FK auto-referencial resuelve). `comprobante_id` y
  `revierte_movimiento_id` en `NULL`. Conteo nuevo = conteo viejo (5).

**TC-03 · `it('copia los cierres con su id y sus totales, por bolsa')`**
- Esperado: `K1` existe en `flito_bolsas_unicas_cierres` con el mismo id, `bolsa_id=B1`, `periodo='2026-08'` y los
  mismos `saldo_inicial, total_entradas, total_salidas, saldo_final, movimientos, cerrado_por_*, cerrado_en`.

**TC-04 · `it('el saldo de cada bolsa migrada es igual a la suma de su libro y al saldo viejo')`**
- Esperado: para toda bolsa migrada, `saldo = Σ(entrada) − Σ(salida)` en `flito_bolsas_unicas_movimientos` y
  `saldo = flito_bolsas.saldo`. Para `B1`: 700 000. Para `B3`: 0.

**TC-05 · `it('deja un evento migrar por bolsa migrada, sin PII')`**
- Esperado: exactamente 1 fila `accion='migrar'` en `flito_bolsas_unicas_eventos` por cada bolsa migrada (`B1`,
  `B3`), `usuario_nombre='migración 0250'` (o el literal que fije el SQL; el test lo nombra), `usuario_id NULL`.
  `snapshot::text` **no** contiene `900000001`, `Compañía Sintética Uno` ni ningún NIT/nombre de la fixture.

**TC-06 · `it('migra la bolsa que solo tiene cierres aunque no tenga movimientos')`** (borde D5)
- Esperado: `B3` y `K3` están en el modelo único; su evento `migrar` existe. Mata la variante del filtro que solo
  mire movimientos.

### AC2 — Las autocreadas sin historia no se migran; su compañía queda `{existe:false, activa:false}`

`describe('migración 0250 — AC2: la bolsa autocreada sin historia no pasa', …)`

**TC-07 · `it('no migra la bolsa sin movimientos ni cierres, ni sus conceptos ni su evento')`**
- Esperado: no hay fila con `id=B2` ni con `compania_id=9002` en `flito_bolsas_unicas`; 0 filas de `B2` en
  `_conceptos` y `_eventos`. La verificación del paso 6 **no** falla por `B2` (está fuera del JOIN).
- Debe matar el mutante M1 alternativo (quitar el `WHERE EXISTS`), ver § Mutantes.

**TC-08 · `it('estadoBolsaDeCompania de esa compañía es {existe:false, activa:false}')`**
- Pasos: tras la migración, `estadoBolsaDeCompania(9002)`.
- Esperado: `toEqual({ existe: false, activa: false })` — igualdad estricta, sin claves extra.

### AC3 — Ante un descuadre falla entera, sin PII, sin filas copiadas; runbook documenta el ajuste

`describe('migración 0250 — AC3: un descuadre tumba la migración entera', …)`

**TC-09 · `it('con saldo ≠ libro lanza y no deja ninguna fila en el modelo único')`**
- Pre: libros con `B1` (cuadra) **y** `B4` (descuadra 50 000).
- Pasos: aplicar `0250` dentro de la misma transacción que usa el runner (o `BEGIN … ROLLBACK` si el arnés lo
  hace así), capturando el error.
- Esperado: la promesa rechaza; después, `count(*) = 0` en las seis tablas `flito_bolsas_unicas*` (tampoco `B1`,
  que sí cuadraba: falla **entera**); la FK de `flito_concil_lineas.movimiento_bolsa_id` sigue apuntando al libro
  viejo; los libros viejos intactos (mismo conteo y saldos).
- Debe matar el mutante M1.

**TC-10 · `it('el mensaje del error solo lleva conteos o ids, nunca NIT ni nombre')`**
- Esperado: el mensaje casa con `/no cuadran/` y contiene el conteo (`1`); **no** contiene `900000004`,
  `Compañía Descuadrada` ni `9004` en forma de NIT. (Si el SQL decide incluir `bolsa_id`, es un uuid: permitido.)

**TC-11 · Runbook del pre-flight y del ajuste manual** (revisión, no Vitest)
- Comprobación: el documento de runbook que entregue la HU (path que declare el `backend-agent` en su HANDOFF;
  si no lo declara, es hallazgo BLOQUEANTE de AC3) contiene: la consulta de pre-flight saldo vs Σ libro, que solo
  lista ids e importes; el ajuste por `POST /api/flito/bolsas/:companiaId/movimientos-manuales` con el motivo
  «Ajuste previo a la migración al modelo único (ADR-0029)…»; el caso de deriva en el saldo denormalizado
  (`UPDATE … saldo` por DBA con `pg_dump` previo); y la secuencia `pg_dump` → `stop api` → `db-apply` → `up -d api`.
- Comando del modo B: `grep -nE "pre-flight|movimientos-manuales|pg_dump|stop api|db-apply" <runbook>`.

### AC4 — Correr la migración dos veces es idempotente

`describe('migración 0249/0250 — AC4: dos pasadas dejan lo mismo', …)`

**TC-12 · `it('aplicar 0249 y 0250 dos veces no falla ni duplica filas, eventos ni constraints')`**
- Pasos: aplicar `0249` + `0250`; capturar conteos; aplicar ambos otra vez.
- Esperado: la segunda pasada no lanza; conteos de bolsas, conceptos, movimientos, cierres y **eventos `migrar`**
  idénticos (el evento no se duplica); `pg_constraint` tiene **una** `flito_concil_lineas_mov_bolsa_unica_fk` y la
  FK vieja no reaparece; saldos iguales.
- **P6 manual (además del Vitest):** sobre la BD local ya migrada, el archivo nuevo dos veces con
  `docker exec -i flito-postgres psql …` (0249 y luego 0250, dos veces cada uno), pegando ambas salidas sin
  `ERROR`. Avisar al usuario de que se tocó su BD.

### AC5 — `concil_lineas` re-apunta; la conciliación SOAT usa `salida:soat:<id>` sin duplicar

**TC-13 · `it('flito_concil_lineas.movimiento_bolsa_id referencia al libro único y la línea sigue resolviendo')`**
(en `flito-bolsas-unicas-migracion.test.ts`, describe `— AC5`)
- Esperado: `pg_constraint` muestra la FK `movimiento_bolsa_id → flito_bolsas_unicas_movimientos(id)` con
  `ON DELETE RESTRICT`; la FK vieja ya no existe; `L1` hace JOIN con `M2` en el libro único.
- Borde: intentar `DELETE` de `M2` en el libro único falla por la FK (RESTRICT).

`describe('conciliarBoleta — AC5: el lado cliente asienta en el libro único con la llave del SOAT', …)`
(en `flito-conciliacion-conciliar.test.ts`, mock `createKeyedDb` como hoy)

**TC-14 · `it('con bolsa activa asienta una salida con llave salida:soat:<soatId> en flito_bolsas_unicas_movimientos')`**
- Pre: bolsa única activa de `C1`; SOAT `S1` sin salida previa.
- Esperado: 1 INSERT en `flito_bolsas_unicas_movimientos` con `bolsa_id = B1`, `origen='conciliacion'`,
  `llave_idempotencia = 'salida:soat:' + S1`; ningún INSERT en `flito_bolsa_movimientos` (libro viejo).
- Borde (mismo `it` o `it` hermano `'no duplica si el sellado ya asentó la llave'`): con una salida previa con la
  misma llave, la segunda conciliación no inserta (sigue 1 movimiento) y la línea apunta al existente.

**TC-15 · `it('sin bolsa o con la bolsa inactiva no asienta del lado cliente ni crea bolsa')`** (parametrizado
`[sin bolsa (C5), inactiva (B6)]`)
- Esperado: 0 INSERT en `flito_bolsas_unicas` y en `_movimientos` del lado cliente; la conciliación termina sin
  error; la línea queda con `movimiento_bolsa_id = null`. (Cubre también AC8 para conciliación.)

### AC6 — La liquidación ya no crea bolsas; con bolsa activa asienta como hoy

`describe('liquidar — AC6: el libro único sin autocreación', …)` (en `flito-liquidacion.test.ts`)

**TC-16 · `it('liquidar a una compañía sin bolsa no crea bolsa ni movimientos y la liquidación termina')`**
- Pre: `C5`, sin corte configurado (`FLITO_BOLSAS_CORTE_COMPROBANTES` ausente).
- Esperado: 0 INSERT en `flito_bolsas_unicas` (ni `ON CONFLICT DO NOTHING` sobre ella) y 0 en `flito_bolsas`
  vieja; 0 movimientos; la liquidación queda sellada como hoy.
- Debe matar el mutante M3.

**TC-17 · `it('con bolsa activa asienta las mismas salidas, llaves y periodo que antes, en el libro único')`**
- Pre: bolsa única activa de `C1` con los seis conceptos.
- Esperado: las salidas (GMF incluido, porque no hay corte) tienen `bolsa_id = B1`, las mismas llaves
  `salida:<…>` y el mismo `periodoImputable` que la aserción actual del test; el saldo baja en Σ salidas. Las
  aserciones de negocio existentes **no** se reescriben, solo el nombre de tabla.
- Regresión (en `flito-liquidacion-reversar-correccion.test.ts`): `reversar()` devuelve esas salidas en el libro
  único y libera las llaves con `rev:`, igual que hoy.

**TC-18 · `it('con la bolsa inactiva no asienta')`**
- Pre: `B6` inactiva.
- Esperado: 0 movimientos en `B6`; saldo de `B6` intacto; la liquidación termina.

### AC7 — Recargar sin bolsa devuelve 409 `bolsa_inexistente`

`describe('registrarRecarga — AC7: sin bolsa no hay recarga', …)` (en `flito-bolsas.test.ts`)

**TC-19 · `it('sin bolsa lanza BolsaError 409 bolsa_inexistente y no inserta nada')`**
- Pre: `C5`.
- Esperado: `rejects` con error de código `bolsa_inexistente`, status 409, mensaje «Crea la bolsa de la compañía
  primero»; 0 INSERT en `flito_bolsas_unicas` y en `_movimientos`; el soporte no se registra (el comprobante «se
  registra con el dinero, no antes», contrato vigente del describe de la L242).
- Ruta (en `flito-bolsas.routes.test.ts`): `POST /api/flito/bolsas/9005/recargas` → 409, cuerpo con
  `codigo: 'bolsa_inexistente'`, sin el error crudo de BD.
- **Ojo:** el describe actual `registrarRecarga — AC2: el cliente sin bolsa no bloquea la recarga`
  (`flito-bolsas.test.ts` ~L196) afirma lo **contrario** (D6 lo deroga). Debe reescribirse a este TC, no
  borrarse en silencio; el `backend-agent` lo declara en su HANDOFF. Es el único cambio de aserción de negocio
  permitido en los 11 archivos re-apuntados.

**TC-20 · `it('con bolsa activa la recarga se asienta y suma al saldo como hoy')`** (regresión)
- Esperado: los describes existentes `AC1`, `AC5`, idempotencia por clave, carrera y redondeo siguen en verde
  re-apuntados a `flito_bolsas_unicas*` (`bolsa_id = B1`).

### AC8 — Con la bolsa inactiva: recarga, manual y corrección → 409 `bolsa_inactiva`; liquidación y conciliación no asientan; cierre sí

`describe('bolsa inactiva — AC8: no entra ni sale dinero, pero se puede cerrar el mes', …)`

**TC-21 · `it('recargar una bolsa inactiva → 409 bolsa_inactiva y el saldo no cambia')`** (`flito-bolsas.test.ts`)
- Pre: `B6` inactiva, saldo `S`.
- Esperado: 409 `bolsa_inactiva`; 0 movimientos nuevos; saldo `S`; soporte no registrado.
- Debe matar el mutante M2.

**TC-22 · `it('movimiento manual sobre bolsa inactiva → 409 bolsa_inactiva «Reactiva la bolsa primero»')`**
(`flito-bolsas-manuales.test.ts`) — entrada y salida (parametrizado).

**TC-23 · `it('corrección de un movimiento de una bolsa inactiva → 409 bolsa_inactiva')`**
(`flito-bolsas-manuales.test.ts`)
- Pre: movimiento previo de `B6` (sembrado cuando estaba activa).
- Esperado: 409; no se crea la corrección; el original intacto.

**TC-24 · Liquidación y conciliación no asientan con la bolsa inactiva** — cubierto por TC-18 y TC-15 (referencia,
no TC nuevo).

**TC-25 · `it('el cierre mensual de una bolsa inactiva se permite')`** (`flito-bolsas-cierre.test.ts`)
- Pre: `B6` inactiva, periodo anterior abierto.
- Esperado: el cierre se crea en `flito_bolsas_unicas_cierres` con `bolsa_id = B6` y totales correctos; no hay 409.
- Borde: el 409 de cierre duplicado (`(bolsa_id, periodo)` único) sigue funcionando por bolsa.

### AC9 — `estadoBolsaDeCompania` cubre los tres casos

`describe('estadoBolsaDeCompania — AC9: existe y activa', …)` en `flito-bolsas-estado-compania.test.ts` (nuevo;
si el `backend-agent` lo pone dentro de la migración, vale, y lo declara)

**TC-26 · `it.each` de tres casos**
- `sin bolsa (C5)` → `{ existe: false, activa: false }`
- `bolsa activa (B1)` → `{ existe: true, activa: true }`
- `bolsa inactiva (B6)` → `{ existe: true, activa: false }`
- Esperado: `toEqual` estricto en los tres. Borde: la consulta filtra `alcance = 'compania'` (aserción sobre el
  filtro en el mock, o fila de tránsito sembrada en el test de BD real que no debe contaminar el resultado).
  El módulo `flito-bolsas.estado-compania.ts` solo importa `db` y el esquema (sin el resto del módulo): se
  comprueba en modo B con `grep -n "^import" apps/api/src/modules/flito-bolsas/flito-bolsas.estado-compania.ts`.
- Debe matar el mutante M2.

### AC10 — El service baja de líneas, lint y build en verde; swap de #13407 si su archivo existe

**TC-27 · Ratchet de `flito-bolsas.service.ts`** (comandos)
- `git diff develop -- eslint.config.mjs` muestra la entrada de `flito-bolsas.service.ts` **por debajo** de 1120
  (o retirada si baja de 800), y `npm run lint` sale con exit 0 sin errores nuevos. Los archivos nuevos
  (`libro.ts`, `estado-compania.ts`, `schema/flito-bolsas-unicas.ts`) ≤ 800 líneas. `schema.ts` no crece (solo
  `+1` línea `export *` compensada o dentro de su techo de 3400).

**TC-28 · Build** (comandos)
- `NODE_OPTIONS=--max-old-space-size=8192 npm run build:api` exit 0. Si se tocó `packages/shared-types`
  (`MovimientoBolsaDto.companiaId` → `number | null`): `npm run build -w packages/shared-types` y
  `npm run typecheck -w apps/web` en verde + el grep de la regla 7 pegado.

**TC-29 · Swap del fallback de #13407** (condicional)
- Si existe `apps/api/src/modules/flito-bolsas-documentos/flito-bolsas-documentos.bolsa-compania.ts` en la rama al
  hacer el gate: debe importar `estadoBolsaDeCompania` de `../flito-bolsas/flito-bolsas.estado-compania.js` y ya
  **no** consultar `flito_bolsas` / `flitoBolsas`
  (`grep -nE "estadoBolsaDeCompania|flitoBolsas\b|flito_bolsas\b" <archivo>`).
- Si no existe (hoy, 2026-10-23, **no** existe en el worktree): `n/a`, declarado en el HANDOFF; el swap lo hace
  #13407.

---

## Mutantes previstos para el modo B (tope 3, P2)

| # | Mutación (temporal, en la rama de la HU) | Debe matarlo | Comando |
|---|---|---|---|
| M1 | En `0250_*.sql`, comentar el bloque de verificación (paso 6, `RAISE EXCEPTION … no cuadran`) | TC-09 | `npm test -w apps/api -- __tests__/services/flito-bolsas-unicas-migracion.test.ts` |
| M2 | En `flito-bolsas.estado-compania.ts`, devolver `activa: true` siempre que exista fila; y, en el mismo mutante, quitar la comprobación de `activa` en la recarga | TC-26 (caso inactiva) y TC-21 | `npm test -w apps/api -- __tests__/services/flito-bolsas-estado-compania.test.ts __tests__/services/flito-bolsas.test.ts` |
| M3 | Restaurar en el camino de liquidación el `INSERT … ON CONFLICT DO NOTHING` de la bolsa (autocreación) | TC-16 | `npm test -w apps/api -- __tests__/services/flito-liquidacion.test.ts` |

Si el modo B prefiere el filtro D5 en lugar de M2 (quitar el `WHERE EXISTS` de `0250` → TC-07 debe matarlo), lo
cambia y lo declara; el tope sigue siendo 3.

## Comandos del modo B (P1)

```bash
# Tests de ESTE WI (lista explícita; nada de glob del directorio). Ajustar a los que el diff realmente crea o toca.
npm test -w apps/api -- \
  __tests__/services/flito-bolsas-unicas-migracion.test.ts \
  __tests__/services/flito-bolsas-estado-compania.test.ts \
  __tests__/services/flito-bolsas.test.ts \
  __tests__/services/flito-bolsas.routes.test.ts \
  __tests__/services/flito-bolsas-manuales.test.ts \
  __tests__/services/flito-bolsas-cierre.test.ts \
  __tests__/services/flito-conciliacion-conciliar.test.ts \
  __tests__/services/flito-liquidacion.test.ts \
  __tests__/services/flito-liquidacion-reversar-correccion.test.ts \
  __tests__/services/flito-backfill-bolsas.test.ts   # si el script se re-apunta (si se retira, declarar)
# + el resto de los 11 flito-bolsas*.test.ts que el diff re-apunte (salidas, extracto, riesgo, alcance-enlace…)

npm run lint
NODE_OPTIONS=--max-old-space-size=8192 npm run build:api
# P6: 0249 y 0250 dos veces sobre la BD local ya migrada (psql), salida pegada
```

`schema.ts` y `migrations/` en el diff ⇒ el hilo debe lanzar también `db-review-agent` (no es de este gate).
HU-A no añade rutas ni montajes en `app.ts` (el endpoint `/compania/:companiaId/estado` es de HU-B #13900), así
que los tests de frontera/reconducción de la nota final del diseño no son P1 aquí; si el diff sí monta algo, se
añaden y se declara.

## Riesgos / notas para la implementación

- **Test de migración saltado ≠ verde.** Si `flito-bolsas-unicas-migracion.test.ts` depende de `DATABASE_URL` y en
  el run de modo B aparece como `skipped`, AC1–AC5 (parte SQL) quedan sin evidencia: veredicto `SIN-ENTORNO` para
  esa parte, nunca `PASS`.
- **Inversión de contrato en `flito-bolsas.test.ts` (~L196).** El describe «el cliente sin bolsa no bloquea la
  recarga» pasa a ser TC-19. Es el cambio de aserción esperado por D6; cualquier **otra** aserción de negocio
  reescrita en los archivos re-apuntados es hallazgo para el gate.
- **Runbook (TC-11):** el diseño no fija dónde vive. Si el `backend-agent` no lo entrega con la HU, AC3 queda
  incompleto (FAIL de cobertura, no Nota).
- La FK vieja de `movimiento_bolsa_id` se nombra en el SQL (`<fk actual de movimiento_bolsa_id>` en el diseño): el
  test TC-13 debe consultar `pg_constraint` por tabla y columna, no por un nombre supuesto, para no pasar en vacío.
- Datos de la fixture: 100 % sintéticos; los NIT `9000000xx` y los nombres «Compañía Sintética …» existen solo para
  comprobar que **no** aparecen en mensajes ni snapshots.
