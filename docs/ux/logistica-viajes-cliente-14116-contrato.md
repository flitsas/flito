# Diseño slim — Facetas `companiasCerrables` (HU #14116)

Feature C2 #14092 · Épica 13758 · ADR-0030. Extiende `GET /flito/logistica/facetas`.
No hay GET nuevo. No se lee Tarifas. El `POST /traslados` ya existe (#14114).

---

## Patrón reutilizado

| Pieza | Path real |
|---|---|
| Facetas actuales | `apps/api/src/modules/flito-logistica/flito-logistica.consulta.ts` → `facetas()` (`companiasCerrables` = `GROUP BY` de documentos `clasificado`) |
| Ruta (sin cambio de método/path/guarda) | `apps/api/src/modules/flito-logistica/flito-logistica.routes.ts` `GET /facetas` + `exigirFuncion('logistica.consola.filtrar')` |
| Precio de entrega a cliente | `apps/api/src/modules/flito-logistica/flito-logistica-precios.ts` → `precioTrasladoDe(companiaId, 'cliente', ahora)` (#14114). Internamente `tarifaDe(…, 'logistica_cliente', null, enFecha)`. |
| Shape de LT | `LtPendienteFirmaDto` en `flito-logistica.pendientes-firma.ts`: `{ documentoId, placa, numeroLt, idFlit }`. Placa = `flito_logistica_documentos.identificador` (la que se grabó al escanear). |
| POST que congela el mismo precio | `registrarTraslado`: `if (precio == null) throw PrecioTrasladoNoConfiguradoError`. Un `0` configurado **pasa**. |

UI de consumo (no este delta, #14116 frontend): `apps/web/src/pages/FlitoLogistica.tsx` tipo local `Facetas.companiasCerrables` y `docs/ux/logistica-viajes-cliente-14116-full.md` § Datos.

---

## Contrato delta

`GET /api/flito/logistica/facetas` — mismo path, mismo auth, **sin query nueva**.

Cada ítem de `companiasCerrables` **añade** dos campos. `companiaId`, `nombre`, `disponibles` no se tocan (`disponibles === lts.length`).

```ts
interface LtClasificadaCerrable {
  documentoId: string;          // UUID opaco → body de POST /traslados
  placa: string | null;         // identificador del documento; no VIN
  numeroLt: string | null;
  idFlit: string | null;
}

interface CompaniaCerrableLogistica {
  companiaId: number;
  nombre: string | null;
  disponibles: number;
  precioEntregaCliente: number | null;  // ver semántica abajo
  lts: LtClasificadaCerrable[];
}
```

**Semántica de `precioEntregaCliente`** (alinear GET con POST #14114):

| `precioTrasladoDe` | DTO | UI |
|---|---|---|
| `null` (sin vigencia) | `null` | aviso AC3; **nunca** pintar `$0` |
| `{ valor: 0, vigenciaId }` | `0` | precio configurado en cero; hay primaria; el POST **no** 422 |
| `{ valor: 12000, … }` | `12000` | «Se cobrará $12.000 por LT» |

Prohibido coerción `0 → null` (desalinearía el GET del POST). Prohibido devolver `vigenciaId`, concepto, destino `flit` o el catálogo de Tarifas.

**Query (backend):**

1. Una lectura de documentos `estado = clasificado` + `gestionableDocs` (alcance + no autogestionable) + `companiaId IS NOT NULL`, con `identificador`, `numeroLt`, `id`, `companiaId`, `clients.name`, `flito_tramites.idFlit` (leftJoin trámite). Agrupar en memoria por `companiaId`.
2. Por cada `companiaId` distinto: `precioTrasladoDe(id, 'cliente', new Date())` en `Promise.all`. Mapear `null` / `valor` como la tabla.
3. No exponer vigencia. Idempotencia: **no aplica** (GET).

El `GROUP BY` + `count(*)` de hoy se sustituye por esa lectura; no se añade un segundo endpoint ni un GET de Tarifas.

---

## PII (placa)

Hoy `GET /facetas` **no lleva query**. La placa **no entra en query**. Va en el JSON de respuesta, igual que:

- `GET /flito/logistica` (`TramiteFila.placa` = `vehicles.plate`)
- `GET` pendientes de firma (`placa` = `identificador`)
- `miRuta` (`RutaDocumento.placa`)

**No se mueve a `POST …/buscar`.** Partir `companiasCerrables` a otro recurso rompería los consumidores actuales de facetas (filtros de la consola) e inventaría el GET/POST que el requerimiento prohíbe. Convertir *todo* `/facetas` a POST es cambio de contrato ajeno a esta HU.

Mitigación (declarada para `security-agent`; no es la excepción GET+query de AGENTS.md §14 porque no hay PII en query):

- Auth + `exigirFuncion('logistica.consola.filtrar')` (sin cambio).
- DTO sin VIN, propietario, NIT, cédula, vigencia.
- Placa solo en body de respuesta; **nunca** en URL, logs, `audit.detail` ni `logPiiAccess` de este GET (el listado de consola ya no audita cada placa de faceta).
- Alcance de enlace (#13426) se conserva: `gestionableDocs`.

---

## Archivos a crear/modificar

| Acción | Archivo | Qué |
|---|---|---|
| Modificar | `packages/shared-types/src/flito-logistica.ts` | `LtClasificadaCerrable` + `CompaniaCerrableLogistica` (ya se reexporta en `index.ts`) |
| Modificar | `apps/api/src/modules/flito-logistica/flito-logistica.consulta.ts` | `FacetasLogistica.companiasCerrables` usa el tipo; `facetas()` trae LTs + precio |
| No tocar | `flito-logistica.routes.ts` | Path, método y guarda iguales |
| Crear | `apps/api/__tests__/services/flito-logistica.facetas-cerrables.test.ts` | P1: null vs 0; LTs solo `clasificado` de esa compañía; sin `vigenciaId` |
| Modificar si asertan shape | `apps/api/__tests__/services/flito-logistica.operar-ajenas.test.ts` | Extraer `precio`/`lts` si el aserto es igualdad estricta |
| Frontend (después) | `apps/web/src/pages/FlitoLogistica.tsx` | Tipo `Facetas` consume shared-types; pestaña Viajes a cliente |
| Mocks E2E | `flito-logistica.spec.ts` (objeto con `disponibles: 1`); el resto usa `[]` y sigue válido | Añadir `precioEntregaCliente` + `lts` en el mock no vacío |

Sin migración. Sin `package.json`. Sin ADR.

---

## ADR: no aplica

Extensión de DTO de un GET existente. El adaptador de precio ya está en #14114. No sienta precedente nuevo (placa en respuesta de logística ya existe).

---

## Notas operativas

**backend-agent (primero, este worktree):**

- Reusar `precioTrasladoDe`; no llamar `tarifaDe` a mano ni el GET de Tarifas.
- `enFecha = new Date()` — la misma «ahora» que `registrarTraslado`.
- Placa = `documentos.identificador`, no un join extra a `vehicles` (análoga pendientes-firma; el mensajero ya la grabó al clasificar).
- No loguear placa. No añadir query params.
- Tests P1 = el archivo nuevo de arriba, no el glob del módulo.
- Mutantes: no (impl no muta).

**frontend-agent (después del GET verde):**

- Un `null` apaga la primaria (AC3). Un `0` no.
- Body del POST: `lts: grupo.lts.map(({ documentoId }) => ({ documentoId }))`. No recomponer el grupo en el cliente.
- No llamar `/flito/tarifas`.

**qa-agent B:** matriz AC1 (un POST por compañía, `documentoId` del grupo) y AC2 (precio en tarjeta/modal **antes** del POST). Mutantes: hasta 3 si se testea la rama null vs número.

**security-agent:** dispara (PII placa en respuesta de GET existente). Veredicto esperado: PASS con la mitigación de arriba; no exigir `POST /buscar`.

**db-review-agent:** no aplica (no `schema.ts` ni `migrations/`).

---

## Eslabón: ¿HU BACKEND aparte?

**No.** El backend de este delta se hace **en el worktree #14116, antes de `frontend-agent`.**

P9: el pedido es un ítem (viajes a cliente). El GET enriquecido no es un segundo ítem ni un hallazgo: ya está en § Datos de la spec UX. Cortar una HU BACKEND solo por la capa dejaría un JSON más rico que el operador no puede usar, y un frontend [FRONTEND] que no es usable sin el GET.

Cadena: #14114 (POST) → #14115 (adaptadores acta) → **#14116 backend (este delta) → #14116 frontend**. Sin WI nuevo en ADO.
