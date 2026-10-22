# Diseño slim — HU #12842: regla de 30 días, datos del SOAT activo y póliza del RUNT

Feature #12840 · Épica #12616 · Canal Cliente de **`flito-soat`** (módulo FLITO; no toca el legacy `soat/`).
La HU FRONTEND #12844 consume este contrato. Estado: **Propuesto** (diseño; no hay ADR).

## Patrón reutilizado

Es una extensión de la HU #12212 / ADR-0010, sin tabla, columna ni endpoint nuevos:

- `apps/api/src/modules/flito-soat/flito-soat-cliente-runt.ts`: `alias`, `fechaValida`, `diaEnBogota`, `fechaVencimientoSoatRunt`, `polizaSoatRunt`, `clasificarDesenlaceRunt` y `DesenlaceRunt`.
- `apps/api/src/modules/flito-soat/flito-soat-cliente.service.ts`: `verificarRuntCompuerta`, una sola compuerta para la preconsulta y el alta (esto cubre el AC9 por construcción), y la proyección explícita de la preconsulta (~L749).
- Qué cuenta como vigente: sigue siendo `soatVigenteSegunRunt` → `derivePreflightChecks` (`tramites/preflight.ts`). Ya lee **solo `soat[0]`** (`firstSoat`). Si `soat` viene vacío da `unknown` y si `soat[0]` está vencido da `fail`. En los dos casos sale `ok` y un 200 con `vigenciaProxima: null` (AC8), sin tocar `preflight.ts`, que es legacy y compartido.

## Decisiones fijadas

### D1. Tipo compartido: archivo nuevo `packages/shared-types/src/flito-soat-activo.ts`

Lo fijó el bloque DUEÑOS. No se toca `flito-estados.ts`, `flito-certificacion.ts` ni `flito-soat-procedencia.ts`. En `index.ts` va `export * from './flito-soat-activo.js';` justo debajo de la línea de `flito-soat-procedencia.js` (L65).

```ts
/** El SOAT que el RUNT reporta en `data.soat[0]`. Fechas `yyyy-mm-dd` (día en Bogotá). Ausente = null. */
export interface SoatActivoRunt {
  poliza: string | null;          // numSoat, normalizada con polizaParaColumna (= lo que se persiste)
  fechaExpedicion: string | null; // fechaExpedicion
  inicioVigencia: string | null;  // fechaInicioPoliza
  vencimiento: string | null;     // fechaVencimSoat
  aseguradora: string | null;     // razonSocialAsegur (el RUNT no trae NIT: no hay clave nit)
  estado: string | null;          // `estado` ("VIGENTE") — NUNCA `estadoSoat` ("EMITIDA")
}

/** Aviso del 200 cuando al SOAT vigente le quedan ≤ 30 días (AC5). */
export interface VigenciaProximaSoat extends SoatActivoRunt {
  venceEl: string;
}

/** Datos del cuerpo del `409 soat_vigente` (AC4). */
export interface DatosSoatVigente409 {
  fechaVencimiento?: string;      // se CONSERVA: ausente (no null) si no hay fecha, como hoy
  soatActivo: SoatActivoRunt;     // siempre presente en el 409, con null por dato ausente
}

export const DIAS_RENOVACION_ANTICIPADA = 30;
```

**Por qué `soatActivo` va anidado en el 409 y plano en `vigenciaProxima`.** Los `datos` de `fallo()` salen en el nivel superior del cuerpo del error, y ese nivel ya tiene una clave `estado?: EstadoSoat` (el 409 de solicitud propia, `apps/web/src/lib/soatCliente.ts` ~L183). Si el `estado` del RUNT fuera plano, chocaría con esa clave en el parser web. `vigenciaProxima` ya es un objeto con espacio propio, así que ahí los seis datos van planos junto a `venceEl`, como pide el AC5.

### D2. Un solo nodo, un solo normalizador de fecha (`flito-soat-cliente-runt.ts`)

- **`nodoSoatRunt(data)`** (privada): hace `Array.isArray(d.soat) ? d.soat[0] : d.soat`. La usan `fechaVencimientoSoatRunt`, `polizaSoatRunt` y el extractor nuevo, así que hay una sola lectura de `soat[0]` y no tres copias.
- **`fechaRuntEnBogota(valor: string | null): string | null`** (privada), en este orden:
  1. Si es ISO con hora **y** huso o `Z` (`/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/`), devuelve `diaEnBogota(new Date(valor))`. Si `Date` da `NaN`, devuelve `null`. Es un instante absoluto proyectado a `America/Bogota`, sin la zona del proceso. Con `-05:00` coincide con los 10 primeros caracteres. Con `Z` o con otro huso corrige el día, cosa que el `slice` de hoy no hace.
  2. Si es `yyyy-mm-dd` sin hora, pasa por `fechaValida` (la regla de hoy).
  3. Si es `dd/mm/yyyy` o `dd-mm-yyyy`, pasa por `fechaValida` (la regla de hoy).
  4. Si no encaja en nada, devuelve `null`.
- `fechaVencimientoSoatRunt` pasa a ser `fechaRuntEnBogota(alias(nodo, ['fechaVencimSoat','fechaVencimiento']))`. Mantiene los mismos alias y el mismo resultado para todo lo que ya parseaba.
- **`polizaSoatRunt` (AC7)**: los alias quedan `['numSoat', 'numeroPoliza', 'noPoliza', 'numPoliza', 'poliza']`. `numSoat` va primero porque es el campo medido en la respuesta real, y los alias viejos se mantienen. La normalización sigue con `polizaParaColumna`. **Hay que comprobarlo:** si `alias()` descarta valores que no son `string` y el RUNT manda `numSoat` como número, `alias` tiene que convertirlo con `String()`. Hay que cubrirlo con un caso de test.
- **Extractor nuevo, exportado, junto a los dos anteriores:**
  ```ts
  export function soatActivoRunt(data: unknown): SoatActivoRunt
  ```
  Crea un objeto literal con las seis claves escritas una por una:
  - `poliza`: `polizaSoatRunt(data)`.
  - `fechaExpedicion`: `fechaRuntEnBogota(alias(n, ['fechaExpedicion']))`.
  - `inicioVigencia`: `fechaRuntEnBogota(alias(n, ['fechaInicioPoliza', 'fechaInicioVigencia']))`.
  - `vencimiento`: `fechaVencimientoSoatRunt(data)`.
  - `aseguradora`: `alias(n, ['razonSocialAsegur', 'aseguradora'])`.
  - `estado`: `alias(n, ['estado'])`. Se excluye `estadoSoat` a propósito y el test lo afirma.

  Si el nodo no existe, devuelve las seis claves en `null` (AC6).

### D3. Umbral de 30 días: se reemplaza el cuerpo, se conserva el nombre

`limiteRenovacionAnticipada(hoy: string): string` **mantiene el nombre y la firma**. Solo lo usan `esRenovacionAnticipada` y el test, así que renombrarlo movería imports sin ganar nada. El docblock se reescribe entero porque el «mes calendario con clamp» queda derogado (AC3). Aritmética:

```ts
const [a, m, d] = [hoy.slice(0,4), hoy.slice(5,7), hoy.slice(8,10)].map(Number);
const limite = new Date(Date.UTC(a, m - 1, d + DIAS_RENOVACION_ANTICIPADA));
return yyyy-mm-dd desde getUTCFullYear/getUTCMonth/getUTCDate;
```

- Usa `Date.UTC` sobre enteros, sin `Date` local ni hora del proceso. El desborde de día lo resuelve `Date.UTC`, que aquí sí es la semántica buscada.
- `hoy` sigue viniendo de `diaEnBogota()`.
- `esRenovacionAnticipada` no cambia: la comparación lexicográfica es inclusiva (`venceEl <= limite`) y sin fecha devuelve `false`, así que un SOAT vigente sin fecha sigue bloqueando (AC6).
- Comprobación de los AC:
  - AC1: 2026-03-10 + 30 = **2026-04-09**. Vence el 04-09 → 200; vence el 04-10 → 409.
  - AC2: 2027-01-31 + 30 = **2027-03-02**. Vence el 03-02 → pasa; vence el 03-03 → 409.

`DIAS_RENOVACION_ANTICIPADA` se importa de shared-types (D1), así la web no repite el 30 en el copy de la #12844.

### D4. Forma nueva de `DesenlaceRunt` y del servicio

```ts
export type DesenlaceRunt =
  | ({ clase: 'ok' } & PayloadOk)
  | ({ clase: 'renovacion_anticipada'; venceEl: string; soatActivo: SoatActivoRunt } & PayloadOk)
  | { clase: 'vigente'; fechaVencimiento: string | null; soatActivo: SoatActivoRunt }
  | { clase: 'revise'; codigo: CodigoRevise; campo?: 'vin' }
  | { clase: 'caido' };
```

`poliza` sale del desenlace: ahora es `soatActivo.poliza`. `clasificarDesenlaceRunt` llama `soatActivoRunt(respuesta.data)` una sola vez dentro de la rama `soatVigenteSegunRunt` y la usa en ambas salidas.

En `flito-soat-cliente.service.ts`:

- **Proyector explícito** (privado): `proyectarSoatActivo(s: SoatActivoRunt): SoatActivoRunt`. Devuelve `{ poliza: s.poliza, fechaExpedicion: s.fechaExpedicion, inicioVigencia: s.inicioVigencia, vencimiento: s.vencimiento, aseguradora: s.aseguradora, estado: s.estado }`. No usa spread (AC5), para que un campo nuevo del extractor no se publique sin que alguien lo decida.
- **409 `vigente`**: `fallo(409, SOAT_VIGENTE, <mensaje igual>, { ...(fv ? { fechaVencimiento: fv } : {}), soatActivo: proyectarSoatActivo(desenlace.soatActivo) })`.
  - El spread condicional **solo** sirve para la ausencia de `fechaVencimiento` y así conserva el contrato «ausente, nunca null» que lee la web.
  - `datos` deja de ser `undefined` en ese caso.
  - Tipar el literal como `DatosSoatVigente409`.
- **`ResultadoRunt.vigenciaProxima`** pasa a ser `VigenciaProximaSoat | null`. En `renovacion_anticipada` queda `{ venceEl, ...las seis claves explícitas vía proyectarSoatActivo }`, construido de forma explícita.
- **Persistencia (~L1151)**: sigue leyendo `vigenciaProxima.poliza` y `vigenciaProxima.venceEl`, con la misma clave y la misma mecánica de «ausente cuando no hay aviso». Hoy `poliza_runt` queda en null con el payload real porque ningún alias casaba. Desde esta HU se guarda (AC7).
- **Preconsulta (~L749)**: `vigenciaProxima` pasa de `{ venceEl }` al objeto completo `VigenciaProximaSoat`, con las siete claves escritas una por una. Hay que reescribir los comentarios de ~L556, ~L745-749 y `cliente-runt.ts` ~L385-389, que hoy dicen «la póliza no se publica».
- **AC9**: se cumple por construcción, porque una sola compuerta sirve a los dos endpoints. El test existente del AC6 (`describe` en ~L458) se extiende para comparar el 409 **campo por campo** entre la preconsulta y el alta, y para verificar que el alta no inserta nada (`insert` no llamado).

## Contrato delta

| Endpoint (existentes, `/api/flito/soat/cliente/...`) | Antes | Después |
|---|---|---|
| preconsulta `200` | `vigenciaProxima: { venceEl } \| null` | `vigenciaProxima: VigenciaProximaSoat \| null` (venceEl + 6) |
| preconsulta / alta `409 soat_vigente` | `{ codigo, mensaje, fechaVencimiento? }` | `+ soatActivo: SoatActivoRunt` (siempre) |
| umbral | mes calendario con clamp | `hoy + 30 días` inclusive, en Bogotá |
| alta por renovación anticipada | `poliza_runt` casi siempre null | `poliza_runt = numSoat` normalizada |

Todos los cambios son **aditivos** para la web actual: ignora las claves que no conoce. Por eso esta HU no necesita tocar `apps/web`.

## Archivos a crear/modificar

**Crear**
- `packages/shared-types/src/flito-soat-activo.ts`: `SoatActivoRunt`, `VigenciaProximaSoat`, `DatosSoatVigente409` y `DIAS_RENOVACION_ANTICIPADA`.
- `apps/api/__tests__/services/flito-soat.cliente-soat-activo.test.ts`: extractor y contrato. Cubre:
  - AC4: las seis claves; `estado` y no `estadoSoat`; conversión de ISO `-05:00`, `Z` y otros husos a día en Bogotá.
  - AC5: `vigenciaProxima` exacto con `toStrictEqual`, que también detecta una clave de más.
  - AC6: `null` por dato ausente; vigente sin fecha → 409.
  - AC7: `numSoat` string y number, más los alias viejos.
  - AC8: `soat[0]` vencido y `soat` vacío → 200 con null; un `soat[1]` vigente no cuenta.
  - AC10: aserto sobre los spies de `logger` de que ni la póliza ni el VIN aparecen en claro.

**Modificar**
- `packages/shared-types/src/index.ts`: añadir el `export *` debajo de `flito-soat-procedencia.js`.
- `apps/api/src/modules/flito-soat/flito-soat-cliente-runt.ts`: D2, D3 y D4, más el comentario de cabecera y el RN-B1 si vive aquí.
- `apps/api/src/modules/flito-soat/flito-soat-cliente.service.ts`: D4 (compuerta, proyector, preconsulta y comentarios).
- `apps/api/__tests__/services/flito-soat.cliente-renovacion-anticipada.test.ts`: AC3.
  - Los `it` de `limiteRenovacionAnticipada` y `esRenovacionAnticipada` se reescriben a 30 días **sin bajar el número de casos**. Hoy el archivo tiene 38 `it`/`test` y el `describe` del límite ocupa ~L229-265.
  - Se sustituyen los casos de clamp y cambio de año por los ejemplos de AC1 y AC2, fin de febrero bisiesto y diciembre → enero.
  - Se cambian los títulos de los `describe`.
  - Se adaptan los asertos que leen `desenlace.poliza` a `desenlace.soatActivo.poliza`.

**No se tocan en esta HU**
- `apps/web/**` (es la #12844).
- `tramites/preflight.ts`.
- `flito-soat-vigencia.service.ts`: hereda el cambio de `polizaSoatRunt` y de `fechaVencimientoSoatRunt` sin editarse.
- `schema.ts` y las migraciones: la columna `poliza_runt` ya existe.

**Grep obligatorio (AC10 / regla 7)**
```
grep -rn "vigenciaProxima\|fechaVencimiento\|soatActivo\|SoatActivoRunt" apps/web/src
```
El resultado va al HANDOFF. Lo esperado es `soatCliente.ts` ~L115 y ~L196/249, y los consumidores del aviso de #12213. Ninguno se rompe porque el cambio es aditivo.

**Verificación P1**
```
npm run build -w packages/shared-types
npm test -w apps/api -- __tests__/services/flito-soat.cliente-renovacion-anticipada.test.ts __tests__/services/flito-soat.cliente-soat-activo.test.ts <test existente de flito-soat-vigencia.service>
NODE_OPTIONS=--max-old-space-size=8192 npm run build:api
npx eslint apps/api/src/modules/flito-soat/flito-soat-cliente-runt.ts apps/api/src/modules/flito-soat/flito-soat-cliente.service.ts   # max-lines 800
```
En esa línea de `eslint`, `cliente-runt.ts` hoy mide 617 líneas brutas. Hay que revisar el número real del servicio.

## ADR: no aplica

No hay contrato, tabla ni módulo nuevo. ADR-0010 ya fija la compuerta RUNT, y esto amplía su payload. Lo que cambia es una **regla de negocio**, RN-B1: «la póliza no se publica» pasa a «se publica la póliza del RUNT en el 409 y en el aviso». El cambio se registra en el comentario de cabecera del módulo con referencia a la HU #12842 y en el cuerpo del PR, no en un ADR.

## Notas operativas

**backend-agent**
- Nunca se usa `new Date()` para decidir el umbral. El único `new Date(valor)` permitido es el de `fechaRuntEnBogota` sobre un ISO con huso, que es un instante absoluto.
- El log de la compuerta (~L579, «nada más entra en esta línea») **no debe** recibir el desenlace entero, porque ahora trae `soatActivo.poliza`. Solo lleva `clase` y `httpStatus`, como hoy. Añadir el aserto negativo del AC10.
- `estado` se devuelve tal como lo manda el RUNT, recortado (`trim`), con `null` si está vacío. No se traduce ni se infiere de `estadoSoat`.

**frontend-agent (#12844, no en esta HU)**
- `soatCliente.ts`:
  - importar `VigenciaProximaSoat` y `SoatActivoRunt` de `@operaciones/shared-types`;
  - `vigenciaProxima?: VigenciaProximaSoat | null` sigue opcional en la lectura por el desfase del deploy;
  - el parser del error lee `cuerpo.soatActivo` en un campo propio y nunca lo mezcla con `estado?: EstadoSoat`;
  - borrar el comentario «No trae la póliza y no puede traerla».
- El copy usa `DIAS_RENOVACION_ANTICIPADA`.

## Riesgos

1. **Publicación de la póliza (Ley 1581 / enumeración).** El número de póliza no es un dato personal. Aun así, desde la HU #12090 cualquier usuario autenticado del canal que conozca un VIN obtiene esta ficha. A partir de ahora también ve la póliza, la aseguradora y las fechas del SOAT de un vehículo ajeno, y los VIN de una flota son consecutivos.
   - Mitigaciones actuales: auth, `requireRole`, rate limiter del canal y DTO explícito sin spread, sin payload crudo.
   - Debe pasar `security-agent` diff-scoped: el disparador es una ruta que publica un dato nuevo. Evaluará si hace falta `logPiiAccess` en la lectura.
   - **Pendiente humano:** confirmar que el PO acepta derogar RN-B1 para el canal Cliente. El AC4 y el AC5 lo implican, pero no lo dicen de forma explícita.
2. **Logs.** Ni la póliza ni el VIN en claro. `logger` redacta por nombre de campo, no por contenido. El riesgo concreto es que alguien loguee `desenlace` o `vigenciaProxima` enteros. Se cubre con un test sobre los spies.
3. **Cron de vigencia (apagado).** `flito-soat-vigencia.service.ts` L283-284 hereda dos cambios:
   - Con `numSoat`, el cron empezará a escribir `poliza_runt` en filas donde antes dejaba null, porque ningún alias casaba con el payload real.
   - `venceEl` se normaliza ahora con huso. Con `-05:00` el resultado es idéntico.

   Al reencenderlo, las comparaciones `poliza_runt` contra `numero_poliza` del OCR empezarán a tener datos: pueden aparecer diferencias («reexpedida») que antes quedaban ocultas bajo el null. No bloquea esta HU. Hay que declararlo en el PR y correr el test existente del servicio de vigencia en P1.
4. **Día del vencimiento.** `preflight.ts` decide qué está vigente comparando el instante de vencimiento con el reloj del proceso (`vence >= ISO_NOW()`). El mismo día del vencimiento, pasada la medianoche de Bogotá, el `soat[0]` puede salir como vencido y dar un 200 con `vigenciaProxima: null` en vez del aviso. Es la dirección segura (no bloquea a nadie) y viene de antes: no se corrige aquí. Va como Nota.
