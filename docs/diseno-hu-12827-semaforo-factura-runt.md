# Diseño slim — HU #12827 · Impuestos: semáforo factura vs RUNT

Épica #12809 · Feature #12822 · Módulo **FLITO** `flito-impuestos` (`/api/flito/impuestos`), no el legacy `liquidacion`.
Estado: **Propuesto** (diseño slim, sin ADR). Rama apilada sobre la HU 12826 (`45298aef`).

Alcance: el **segundo paso** de la cola de la 12825 (`registrarPasoAnalisis('comparacion', …)`). Lee lo que la 12826
dejó en `extraccion_factura_venta`, consulta el RUNT **una vez**, compara campo a campo, calcula el semáforo y lo
persiste. Deja la respuesta del RUNT en memoria del job para la 12828.
**Fuera:** autocertificación (12828), UI y preset «Con alertas» (12830/12831), dirección (12833).

## Patrón reutilizado

| Pieza | Vecino |
|---|---|
| Punto de extensión | `PasoAnalisis` / `registrarPasoAnalisis` en `apps/api/src/modules/flito-impuestos/flito-impuestos.analisis.service.ts`; orden en `flito-impuestos.analisis.pasos.ts` |
| Paso con `UPDATE … WHERE analisis_estado='en_curso'` y log sin PII | `pasoExtraccion` en `flito-impuestos.extraccion.ts` |
| Consulta al RUNT (documento → placa, si no VIN; `limitadorRunt`; `catch`; traspaso antes que caída; `runtSinRegistro`) | `certificarImpuesto`, `certificacion.service.ts:186-235` |
| Datos del vehículo para la consulta | `datosDelVehiculo`, `certificacion.service.ts:78` (hoy privada → se **exporta**, sin cambio de lógica) |
| Extracción de la respuesta RUNT y normalizadores | `extraerVehiculoRunt`, `normalizarIdentificador`, `normalizarTexto`, `runtSinRegistro`, `esTraspasoEnSincronizacion` en `certificacion-runt.ts` |
| Motor de comparación PURO + test sin red | `compararConRunt` (`certificacion-runt.ts`) |
| Enum en PG | `flitoImpuestoAnalisisEstadoEnum` (`schema.ts:2642`) + migración 0206 (`DO $$ … duplicate_object`) |

Sin dependencias nuevas.

## Decisiones

### D1. Esquema — migración `0207_flito_impuestos_semaforo.sql`

Número **esperado 0207** (origin/develop termina en `0206_flito_impuestos_analisis.sql`; la 12826 no trae migración).
El backend lo confirma con `git fetch origin develop && git ls-tree --name-only origin/develop apps/api/src/db/migrations/ | grep -E '/0[0-9]{3}_' | tail -1`
**justo antes** de crear el archivo (la 12833 y otras sesiones también traen migración). Antes, `grep -n "semaforo\|comparacion_factura_runt\|comparacionFacturaRunt" apps/api/src/db/schema.ts` debe salir vacío (un `ADD COLUMN IF NOT EXISTS` sobre columna existente es no-op silencioso).

```sql
DO $$ BEGIN
  CREATE TYPE flito_impuesto_semaforo AS ENUM ('verde', 'naranja', 'rojo');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE flito_impuestos
  ADD COLUMN IF NOT EXISTS semaforo                 flito_impuesto_semaforo,  -- NULL = sin calcular
  ADD COLUMN IF NOT EXISTS comparacion_factura_runt jsonb;                    -- detalle + motivo
```

- Espejo en `schema.ts`: `flitoImpuestoSemaforoEnum` junto a la línea 2642; columnas `semaforo` y
  `comparacionFacturaRunt: jsonb(...).$type<ComparacionFacturaRunt>()` junto a `analizadoEn` (~3157).
- **El motivo vive solo en el jsonb** (`motivo`), no en columna: el preset filtra por color, no por motivo.
- **Sin índice en esta HU.** El preset «Con alertas» se combinará con `estado = 'solicitado'` (ya indexado:
  `idx_flito_impuestos_estado`) y `semaforo` tiene 3 valores. Mismo criterio que la 12825 con estas columnas:
  no fijar la forma de una consulta que diseña otra HU. Si el `EXPLAIN` de la 12830 lo pide, esa HU agrega un
  índice parcial `WHERE semaforo IN ('naranja','rojo')` en su migración.
- Sin backfill: históricos quedan `NULL`.
- P6: aplicar **este** archivo dos veces sobre la BD local ya migrada.

### D2. Consulta RUNT única y compartida con la 12828 — contexto del job

Extensión **mínima** de la firma de la 12825 (aditiva: `pasoExtraccion` desestructura `{ impuestoId }` y no se entera):

```ts
// flito-impuestos.analisis.service.ts
export interface ContextoAnalisis { consultaRunt?: ConsultaRuntAnalisis }   // memo del job, solo memoria
export type PasoAnalisis = (c: { impuestoId: string; runt: LimitadorRunt; job: ContextoAnalisis }) => Promise<void>;
// en ejecutarAnalisis: const job: ContextoAnalisis = {};  … await paso({ impuestoId: id, runt: limitadorRunt, job });
```

- `job` se crea **una vez por ejecución** de `ejecutarAnalisis` y muere con ella. Un reintento o una
  recuperación es un análisis nuevo y consulta de nuevo (correcto: «una consulta por análisis»).
- **Nada del RUNT crudo se persiste** (ni `data` ni el payload): solo los 6 valores comparados en el jsonb (D6).
- Archivo nuevo `flito-impuestos.runt-consulta.ts`:

```ts
export type ConsultaRuntAnalisis =
  | { estado: 'ok'; via: 'documento' | 'vin'; data: unknown; vehiculo: DatosVehiculoRuntExtraido & ColorCilindrajeRunt }
  | { estado: 'sin_respuesta' | 'sin_registro' | 'traspaso' | 'sin_identificador' };
export async function consultarRuntDeImpuesto(impuestoId: string, runt: LimitadorRunt): Promise<ConsultaRuntAnalisis>;
```

  Replica **exactamente** la regla de `certificarImpuesto`: `datosDelVehiculo(id)`; sin placa, o sin documento
  ni VIN → `sin_identificador` (no se consulta); documento → `consultarVehiculoRunt(placa, undefined, documento)`,
  si no `consultarVehiculoRunt(placa, vin, undefined)`, **dentro de `runt.ejecutar(...)`**; `throw` → `sin_respuesta`;
  `!ok || !data` → `esTraspasoEnSincronizacion(message)` ? `traspaso` : `sin_respuesta`; `runtSinRegistro(data)` →
  `sin_registro`; si no, `ok` con `extraerVehiculoRunt(data)` + `extraerColorCilindrajeRunt(data)` (D5).
- `via` y `data` quedan en el memo para que la **12828** decida la prueba de propiedad (RN-02) y llame a
  `compararConRunt` **sin** volver al RUNT. Regla para la 12828 (ya dicha en la 12825 §3): no llamar a
  `certificarImpuesto` desde un paso; leer `job.consultaRunt`. Si `job.consultaRunt` es `undefined` (la
  comparación no consultó, p. ej. factura ilegible), la 12828 no autocertifica.
- `certificarImpuesto` **no se refactoriza** aquí (~15 líneas duplicadas, declarado como Nota). Unificar
  ambos caminos sobre `consultarRuntDeImpuesto` es natural en la 12828, que ya toca certificación.

### D3. Factura ilegible vs fallo técnico — dónde se escribe el rojo

| Situación | Quién la detecta | Escritura | `analisis_estado` |
|---|---|---|---|
| Sin factura, URL nula, descarga/HTTP/tope, `OcrNoDisponibleError` (**técnico**) | `pasoExtraccion` lanza (sin cambios) | **nada**: `semaforo` queda `NULL` | `error_analisis` (lo pone la cola) |
| Factura obtenida y leída, pero **ningún** comparable (`vin, marca, linea, anioVehiculo, color, cilindrada`) con `confiable:true` (**ilegible**: sin Notas Finales ni OCR utilizable) | `pasoComparacion`, **antes** de consultar el RUNT | `semaforo='rojo'`, `motivo='error_lectura_factura'` | `error_analisis`: el paso persiste y luego **lanza** `FacturaIlegibleError`; la cola marca el error como hoy |
| `extraccion_factura_venta` `NULL` (no debería: la extracción habría lanzado) | `pasoComparacion` | nada, lanza | `error_analisis` |

- No cambia la cola: «persistir y lanzar» reutiliza el `catch` de `ejecutarAnalisis` y corta la 12828 (que no
  debe correr sin factura). La cola no necesita conocer motivos.
- Ilegible **no** consulta el RUNT (ahorra cupo del limitador).
- Distinguir técnico de ilegible importa porque el técnico se arregla con «Reintentar validación» (FLIT publica
  la factura, Anthropic vuelve) y el ilegible exige una persona. Ver Pendiente humano P2.
- **Reset en el reintento:** `reanalizarImpuesto` (`analisis.service.ts`) añade `semaforo: null,
  comparacionFacturaRunt: null` a su `UPDATE` condicional. Si no, un reintento que termina en fallo técnico
  dejaría visible el semáforo de la corrida anterior. (El envío inicial solo marca filas con `analizado_en IS
  NULL`, que no tienen semáforo; la recuperación del cron re-ejecuta el mismo análisis y no necesita reset.)

### D4. Reglas de comparación (función PURA, archivo nuevo `flito-impuestos.comparacion-factura-runt.ts`)

Base: `normalizarTexto` / `normalizarIdentificador` de `certificacion-runt.ts` (no se duplican). Para texto,
además, puntuación → espacio y se quitan paréntesis con su contenido (`GRIS (V)` → `GRIS`).

| Campo | Factura (12826) | RUNT | Regla de «coincide» |
|---|---|---|---|
| `vin` | `vin` | `vehiculo.vin` (+alias) | `normalizarIdentificador` **exacto** |
| `marca` | `marca` | `marca` | texto normalizado igual, **o** tras mapa mínimo de sinónimos (`VW→VOLKSWAGEN`, `MERCEDES→MERCEDES BENZ`, `GM CHEVROLET→CHEVROLET`), **o** inclusión por tokens (abajo) |
| `linea` | `linea` | `linea` | igual normalizado **o** inclusión por tokens |
| `anio` | `anioVehiculo` | `modelo` (= **año modelo**; alias `anioModelo`, `anoModelo`) | entero de 4 dígitos, **exacto** |
| `color` | `color` | `color` (D5) | igual normalizado; género (`BLANCA→BLANCO`, `NEGRA→NEGRO`, `ROJA→ROJO`, `PLATEADO→PLATA`) **o** inclusión por tokens (`BLANCO PERLA` vs `BLANCO`) |
| `cilindrada` | `cilindrada` | `cilindraje` (D5) | solo dígitos → entero **exacto** (sin tolerancia). **AC3:** factura `0` y RUNT `0` o vacío → `coincide` con `nota:'electrico'`; factura `0` y RUNT `>0` → `difiere` |

- **Placa: no se compara** (no está en la lista de campos; test lo asegura).
- **Inclusión por tokens:** coincide si todos los tokens del valor más corto están en el más largo, siempre que
  el corto tenga ≥1 token alfabético de ≥2 caracteres (un `2.0` o un `4X4` solos no alcanzan). Documentar en la
  cabecera del archivo con ejemplos inventados (`K3` / `K3 CROSS`).
- **Resultado por campo:** `coincide` | `difiere` | `no_verificable`. `no_verificable` cuando la factura trae el
  campo con `confiable:false` o `null` (`origen:'factura'`), o el RUNT no lo publica (`origen:'runt'`), salvo la
  excepción eléctrica. `no_verificable` **no cuenta** como diferencia.
- **Semáforo:** `difieren ≥ 1` → `naranja`; `difieren = 0` y `coinciden ≥ 1` → `verde`; `coinciden = 0` y
  `difieren = 0` con factura legible (todo no verificable del lado RUNT) → **`naranja`** por defecto (P1).
- El sinónimo de marca es un `Record` cerrado en el archivo; ampliar = cambio de código revisado, no
  configuración. Una marca desconocida que no coincide da `naranja` y lo resuelve una persona: preferimos
  falso naranja a falso verde.

Firmas:
```ts
export const CAMPOS_COMPARACION_FACTURA_RUNT = ['vin','marca','linea','anio','color','cilindrada'] as const; // en shared-types
export function facturaIlegible(e: ExtraccionFacturaVentaImpuesto): boolean;
export function compararFacturaConRunt(e: ExtraccionFacturaVentaImpuesto, r: DatosComparablesRunt):
  { semaforo: 'verde' | 'naranja'; comparacion: ComparacionFacturaRunt };
```

### D5. Campos del RUNT

`extraerVehiculoRunt` ya da `vin`, `marca`, `linea`, `modelo` (año modelo). **No** da color ni cilindraje. Se
añade en `certificacion-runt.ts` una función **aparte** (no se amplía `DatosVehiculoRuntExtraido`, para no romper
los `toEqual` de los tests de certificación):

```ts
export interface ColorCilindrajeRunt { color: string | null; cilindraje: string | null }
export function extraerColorCilindrajeRunt(data: unknown): ColorCilindrajeRunt;
// alias, vehiculo y luego datosTecnicos, con `primero`: color ['color','nombreColor','colorVehiculo'];
// cilindraje ['cilindraje','cilindrada','capacidadMotor']
```

`color` y `cilindraje` están en la consulta real documentada en la cabecera de `extraerVehiculoRunt`
(2026-07-31); los alias extra no cuestan nada, igual que los del VIN.

### D6. Mapeo motivo → semáforo y persistencia

| Consulta / factura | `semaforo` | `motivo` | `analisis_estado` |
|---|---|---|---|
| ok + comparación | `verde` / `naranja` | `null` | `completado` + `analizado_en` (lo pone la cola) |
| `sin_respuesta`, `sin_registro`, `traspaso`, `sin_identificador` | `rojo` | `runt_sin_respuesta` (el traspaso cae aquí, AC2) | `completado` |
| factura ilegible | `rojo` | `error_lectura_factura` | `error_analisis` |

`UPDATE flito_impuestos SET semaforo, comparacion_factura_runt WHERE id=$1 AND analisis_estado='en_curso'`
(mismo guard que la extracción; asertarlo sobre condiciones capturadas, no sobre la fila del mock).

La causa fina del rojo RUNT (`sin_registro`/`traspaso`/…) va en `detalleRunt` del jsonb para soporte, pero el
**contrato de UI** es solo `motivo` y su copy.

### D7. shared-types

En `packages/shared-types/src/flito-estados.ts` (junto a `AnalisisEstadoImpuesto`):

```ts
export const SemaforoImpuesto = { VERDE: 'verde', NARANJA: 'naranja', ROJO: 'rojo' } as const;
export type SemaforoImpuesto = typeof SemaforoImpuesto[keyof typeof SemaforoImpuesto];
export const SEMAFORO_IMPUESTO_LABEL: Record<SemaforoImpuesto, string>; // «Coincide con el RUNT», «Con diferencias», «Sin validar»
export const MotivoSemaforoRojo = { RUNT_SIN_RESPUESTA: 'runt_sin_respuesta', ERROR_LECTURA_FACTURA: 'error_lectura_factura' } as const;
export type MotivoSemaforoRojo = typeof MotivoSemaforoRojo[keyof typeof MotivoSemaforoRojo];
export const MOTIVO_SEMAFORO_ROJO_LABEL: Record<MotivoSemaforoRojo, string>;
//   runt_sin_respuesta → «El RUNT no respondió o no tiene registro del vehículo» (copy del AC2)
//   error_lectura_factura → «No se pudo leer la factura de venta»
```

En `packages/shared-types/src/flito-certificacion.ts` (hogar de la comparación contra el RUNT):

```ts
export const CAMPOS_COMPARACION_FACTURA_RUNT = ['vin','marca','linea','anio','color','cilindrada'] as const;
export type CampoComparacionFacturaRunt = typeof CAMPOS_COMPARACION_FACTURA_RUNT[number];
export const CAMPO_COMPARACION_FACTURA_RUNT_LABEL: Record<CampoComparacionFacturaRunt, string>;
export type ResultadoCampoFacturaRunt = 'coincide' | 'difiere' | 'no_verificable';
export interface ComparacionCampoFacturaRunt {
  campo: CampoComparacionFacturaRunt; resultado: ResultadoCampoFacturaRunt;
  valorFactura: string | null; valorRunt: string | null;
  origenNoVerificable?: 'factura' | 'runt'; nota?: 'electrico';
}
export interface ComparacionFacturaRunt {
  version: 1;
  motivo: MotivoSemaforoRojo | null;            // null ⇔ verde/naranja
  detalleRunt?: 'sin_respuesta' | 'sin_registro' | 'traspaso' | 'sin_identificador';
  campos: ComparacionCampoFacturaRunt[];        // [] cuando es rojo
  resumen: { coinciden: number; difieren: number; noVerificables: number };
  calculadoEn: string;                          // ISO
}
```

- Tipo **propio** y no `ResultadoCampo`/`ComparacionCampo` de la certificación: aquel compara BD FLITO vs RUNT,
  tiene `SIN_DATO_FLITO` y `bloqueante`, y es el contrato del certificado. Semánticas distintas; mezclarlas
  acopla la 12828 con la 12830.
- El semáforo **no** se duplica en el jsonb: la columna manda.
- Regla 7: tipos nuevos, no rompen; aun así `grep -rn "SemaforoImpuesto\|ComparacionFacturaRunt" apps/web/src` (vacío esperado) y `npm run build -w packages/shared-types`.

### D8. DTO de la cola

**No se expone en esta HU** (recomendado). La 12830 añade `semaforo` + `comparacionFacturaRunt` al DTO de cola/
detalle junto con el preset y su grep de regla 7, y hace el cambio en `flito-impuestos.service.ts` (786 l.) con su
propio presupuesto de líneas. Aquí el backend no toca `flito-impuestos.service.ts` ni `.routes.ts` (804 l.).

### D9. AC4 — no bloquea pago

Se cumple **por construcción**: ni conciliación de recibos ni recibo de caja (`flito-recibos.service.ts`,
`flito-recibos.fase.ts`) leen `semaforo`. Para que siga siendo cierto, un test valla lee el fuente de esos dos
archivos y aserta que no contienen `semaforo` ni `comparacionFacturaRunt` (el mock `chain` devuelve la fila
entera y no probaría nada con un fixture en rojo).

### D10. PII y logs

- El paso lee `ownerDocument` y VIN para consultar el RUNT, y persiste VIN de factura y RUNT en el jsonb:
  `logPiiAccess` con actor sistema, reutilizando `registrarAccesoSistema` de `flito-impuestos.extraccion.ts`
  (exportarla y parametrizar `camposAccedidos` y el motivo: `['documento_propietario','vin']`,
  `analisis_post_envio (sistema) — comparación factura vs RUNT`).
- Logs: solo `{ impuestoId, semaforo, motivo, detalleRunt, resumen }`. **Nunca** placa, documento, VIN, valores
  ni `message` del RUNT (puede traer nombre del propietario en el traspaso). Ojo: `certificarImpuesto` sí loguea
  `placa` (preexistente, Nota; no copiarlo).

## Contrato delta

- Sin endpoints nuevos. Sin cambios en respuestas HTTP (D8).
- BD: `flito_impuestos.semaforo` (enum `verde|naranja|rojo`, NULL = sin calcular) y `comparacion_factura_runt` (jsonb `ComparacionFacturaRunt`).
- Cola: `PasoAnalisis` recibe además `job: ContextoAnalisis` (memo en memoria; `job.consultaRunt` para la 12828).
- Orden en `registrarPasosAnalisisImpuestos`: `extraccion` → `comparacion` → (12828) `autocertificacion`.
- `reanalizarImpuesto` resetea `semaforo` y `comparacion_factura_runt` a NULL.

## Archivos a crear/modificar (lista cerrada)

**Crear**
- `apps/api/src/db/migrations/0207_flito_impuestos_semaforo.sql` (número a confirmar, D1)
- `apps/api/src/modules/flito-impuestos/flito-impuestos.comparacion-factura-runt.ts` — PURO: normalización, sinónimos, `facturaIlegible`, `compararFacturaConRunt`
- `apps/api/src/modules/flito-impuestos/flito-impuestos.runt-consulta.ts` — `ConsultaRuntAnalisis`, `consultarRuntDeImpuesto`
- `apps/api/src/modules/flito-impuestos/flito-impuestos.comparacion.ts` — `pasoComparacion`, `FacturaIlegibleError`, persistencia, `logPiiAccess`
- `apps/api/__tests__/services/flito-impuestos.comparacion-factura-runt.test.ts`
- `apps/api/__tests__/services/flito-impuestos.comparacion.test.ts`

**Modificar**
- `apps/api/src/db/schema.ts` — enum + 2 columnas + import del tipo
- `apps/api/src/modules/flito-impuestos/flito-impuestos.analisis.service.ts` — `ContextoAnalisis`, `job` en `PasoAnalisis` y en `ejecutarAnalisis`; reset en `reanalizarImpuesto`
- `apps/api/src/modules/flito-impuestos/flito-impuestos.analisis.pasos.ts` — `registrarPasoAnalisis('comparacion', pasoComparacion)`
- `apps/api/src/modules/flito-impuestos/certificacion-runt.ts` — `+extraerColorCilindrajeRunt`
- `apps/api/src/modules/flito-impuestos/certificacion.service.ts` — solo `export` de `datosDelVehiculo` (y su tipo)
- `apps/api/src/modules/flito-impuestos/flito-impuestos.extraccion.ts` — exportar/parametrizar `registrarAccesoSistema`
- `packages/shared-types/src/flito-estados.ts`, `packages/shared-types/src/flito-certificacion.ts`
- `apps/api/__tests__/services/flito-impuestos.analisis.test.ts` (la de la 12825) — casos de `job` y reset

**No se tocan:** `flito-impuestos.service.ts`, `flito-impuestos.routes.ts`, `flito-recibos*.ts`, `apps/web`.

## Tests P1

`TZ=UTC npm test -w apps/api -- __tests__/services/flito-impuestos.comparacion-factura-runt.test.ts __tests__/services/flito-impuestos.comparacion.test.ts __tests__/services/flito-impuestos.analisis.test.ts __tests__/services/flito-impuestos.extraccion.test.ts`
(+ el test existente de certificación si `grep -l datosDelVehiculo\|certificacion-runt apps/api/__tests__` muestra que mockea el módulo), `npm run build -w packages/shared-types`, `NODE_OPTIONS=--max-old-space-size=8192 npm run build:api`, `npx eslint` de los archivos tocados.

- **Puro:** verde con los 6 iguales; naranja con uno distinto; `confiable:false` → `no_verificable` y sigue verde;
  placa distinta en RUNT no cambia nada (la lista de `campos` no contiene `placa`); año contra `modelo` del RUNT
  (no contra `anioVehiculo` de otro lado); VIN con un carácter distinto → difiere; línea por inclusión de tokens y
  el corto numérico que **no** alcanza; marca `VW`/`VOLKSWAGEN`; color `BLANCA`/`BLANCO PERLA`; eléctrico 0/0 y
  0/vacío coinciden, 0/1598 difiere; `facturaIlegible` con 0 confiables; `extraerColorCilindrajeRunt` por las dos vías.
- **Paso:** con `consultarVehiculoRunt` y `datosDelVehiculo` mockeados: `runt.ejecutar` llamado **1** vez y
  `job.consultaRunt.estado==='ok'`; `ok:false` / throw / `runtSinRegistro` / mensaje con «propietario» → rojo
  `runt_sin_respuesta`; sin placa → rojo sin consultar; ilegible → escribe rojo `error_lectura_factura`, **no**
  consulta el RUNT y lanza; el `UPDATE` lleva `analisis_estado='en_curso'` (condiciones capturadas); log sin VIN/placa.
- **Cola:** dos pasos falsos comparten el mismo `job` y un segundo `ejecutarAnalisis` recibe uno nuevo; paso que
  persiste y lanza → `error_analisis` y el paso siguiente no corre; `reanalizarImpuesto` pone `semaforo: null`.
- **Valla AC4** (en el test del paso): los fuentes de `flito-recibos.service.ts` y `flito-recibos.fase.ts` no mencionan `semaforo`.

Mutantes sugeridos a QA (≤3): quitar la excepción eléctrica; contar `no_verificable` como diferencia; añadir `placa` a los campos comparados.

## ADR: no aplica

Extensión del punto de extensión de la 12825 con el motor de comparación y la consulta RUNT de la certificación.
Sin dependencias, tablas ni endpoints nuevos; dos columnas en tabla existente.

## Notas operativas

- **backend-agent:** leer `datosDelVehiculo` completo antes de exportarla (confirmar el respaldo `compradorDocumento`
  → documento). `calculadoEn` con `new Date().toISOString()`. No poner `Date` crudo en fragmentos `sql`.
- **db-review-agent:** aplica (migración + `schema.ts`): enum, idempotencia, decisión de no indexar (D1).
- **security-agent:** aplica (PII: documento para el RUNT, VIN persistido en jsonb, `logPiiAccess` de sistema, logs).
- **ux-agent / frontend:** omit en esta HU (BACKEND-only). La 12830 consume `SemaforoImpuesto`, `MOTIVO_SEMAFORO_ROJO_LABEL`, `ComparacionFacturaRunt`.
- **12828:** leer `job.consultaRunt` (nunca reconsultar ni llamar `certificarImpuesto` desde el paso); candidata a mover `certificarImpuesto` sobre `consultarRuntDeImpuesto`.

## Pendiente humano (P9)

1. **Verde vacío:** si la factura es legible pero todos los comparables quedan `no_verificable` (el RUNT no publica
   esos campos), el diseño da **naranja** (nadie verificó nada). ¿Confirmar, o verde? Relacionado: ¿un verde exige
   que el **VIN** coincida? El AC no lo pide; el diseño no lo exige.
2. **Fallo técnico de la factura** (sin factura en FLIT, descarga caída, OCR caído): el diseño deja `semaforo NULL`
   + `error_analisis` (reintentable), y reserva `rojo error_lectura_factura` para la factura leída pero inservible.
   ¿O el PO quiere rojo `error_lectura_factura` también ahí?
3. **Sin placa, o sin documento ni VIN:** no se puede consultar; el diseño lo trata como `rojo runt_sin_respuesta`. Confirmar el copy.
4. **Cilindrada sin tolerancia** (1598 vs 1600 = naranja). Confirmar.
5. **Rojo RUNT queda `completado`** (el AC2 solo exige `error_analisis` para la factura ilegible); se reintenta con «Reintentar validación».
