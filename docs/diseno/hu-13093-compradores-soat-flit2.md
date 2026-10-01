# HU #13093 — Compradores de FLIT 2 y arranque de SOAT e impuestos (delta de diseño)

- **Feature:** #13059 · **Épica:** #12736 · **Architecture:** slim (extiende la #13091 y la #13092)
- **Base:** `docs/diseno/hu-13091-lectura-incremental-flit2.md`, `docs/diseno/hu-13092-lectura-programada-flit2.md`
- **Contrato:** `docs/integraciones/flit2-api.md` v3.1 §4 (compradores: `ordinal`, `porcentajeParticipacion`, documento, nombre…)
- **Módulo:** `flito-sync` (FLITO). Sin migración: `flito_compradores`, `flito_soat`, `flito_impuestos` y
  `flito_tramite_historial` ya existen.

## 1. Qué cambia

| Pieza | Cambio |
|---|---|
| `flito-sync.service.ts` | Se extraen y exportan `arrancarSoatEImpuesto` (SOAT + impuesto tras guardar el trámite; `sincronizarUno` la llama igual que antes) y `reemplazarCompradores` (borrar + insertar en bloque; `upsertTramite` la usa). `registrarDiferencias` se exporta. `resolverSoat`/`resolverImpuesto` solo piden `vin`, `idFlit` y `valorImpuestoLiquidado`. FLIT 1 no cambia de comportamiento. |
| `flit2-mapeo.ts` | `compradoresDesdeFlit2`: mapeo propio de FLIT 2 que **no lanza** (`mapeo-compradores.ts` sigue lanzando para FLIT 1 con 0 compradores, AC7). |
| `flit2-lectura.service.ts` | `aplicarItem` escribe los compradores, pone el titular del vehículo desde el principal y arranca SOAT e impuesto (RN-14…RN-17). |

## 2. Reglas (RN en la cabecera de `flit2-lectura.service.ts`)

- **RN-14 · Compradores.** Orden = posición tras ordenar por `ordinal` (con los ordinales 1…n del contrato,
  `orden = ordinal − 1`; 0 = principal). Un comprador solo sin porcentaje → 100 % (AC2); con varios, el
  porcentaje tal cual. `tipo_propiedad` sale del conteo de compradores que manda FLIT 2 (AC1). Se reemplazan en
  bloque solo si difieren de los guardados. El titular del vehículo sale del principal (orden 0); sin él, se
  conserva el que había.
- **RN-15 · Retroceso sin compradores (decisión del hilo).** Un trámite **existente** que llega con
  `compradores: []` conserva los guardados (mismo criterio que el vehículo null, AC5 de la #13091; contrato §4
  «Bloques en null»). «Sin comprador» (AC3) es el trámite nuevo o el que nunca tuvo.
- **RN-16 · Historial.** FLIT 1 **no** registra compradores en `flito_tramite_historial`. FLIT 2 deja una fila
  por reemplazo (campo `compradores`, origen `api`, vía `registrarDiferencias`) con un **resumen sin PII**:
  cantidad, orden y porcentaje (`2 compradores: orden 0 60 %, orden 1 40 %`). Si el resumen no cambia pero sí
  la persona o el contacto, el valor nuevo lleva `(cambian datos de persona)`, sin decir cuál.
- **RN-17 · Arranque.** Mismas condiciones y misma función que FLIT 1 (`flit_estado` Asignado, compañía y
  organismo emparejados → `arrancarSoatEImpuesto`), más una: el trámite tiene comprador principal guardado.
  Sin él, espera sin fallar; la entrega posterior que lo trae arranca (AC5). Sin bloque de vehículo, el VIN
  se lee del vehículo guardado.

## 3. Decisiones del backend (a validar en review)

1. **Comprador sin documento o sin nombre** (o documento > 30, la columna): no se escribe y se cuenta en un
   `log.warn` con `{ idFlit2, omitidos }`. La PII enmascarada es la #13094. Si falta así el principal, los
   demás se guardan con su orden, pero no hay titular ni arranque.
2. **Contacto más largo que su columna** → null; nombre recortado a 200 (como el titular del vehículo).
3. **Contadores del arranque** (`soatCreados`…) no se suman al resultado de FLIT 2 (`Flit2LecturaResultado`
   no los tiene y cambiarlo es contrato con la web); el rastro es el audit de cada alta, como en FLIT 1.
4. **`valorImpuestoLiquidado`** del impuesto: el que ya tiene el trámite (FLIT 2 no lo trae; hoy null).
5. Un reemplazo de compradores cuenta el trámite como `actualizados`.

## 4. Pruebas

`apps/api/__tests__/services/flito-sync.flit2-lectura.test.ts`, bloque «HU #13093», con la base en memoria
(ahora admite `delete` solo sobre `flito_compradores`). TC-35/38 de la #13091 pasa a usar un asignado **sin**
comprador: con comprador ya arranca.
