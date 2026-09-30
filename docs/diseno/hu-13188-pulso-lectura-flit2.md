# Diseño slim — HU #13188 · Pulso de la lectura automática en el estado de FLIT 2

HU #13188 [BACKEND] · Feature #13060 · Épica #12736. Módulo **FLITO** `flito-sync` (no el legacy).
Base: `develop` 2a2cb3c9. Sin migración, sin dependencia nueva, sin ruta nueva.

## Patrón reutilizado

- `apps/api/src/modules/flito-sync/flito-sync.cron.ts`: ya guarda estado del programa en variables de
  módulo (`timerFlit2`, `enCurso`). Se sigue ese estilo: **funciones + estado de módulo**, no clases.
- `apps/api/src/modules/flito-sync/flit2-estado.service.ts`: `componerEstado(e, ahora)` puro con el
  reloj inyectado + `obtenerEstadoConexion(reloj)` que junta entradas. El bloque nuevo entra como una
  entrada más de `EntradaEstado`; la composición sigue pura.
- `apps/api/src/modules/flito-sync/flit2-lectura.service.ts` → `leerConCandado`: el callback que se
  pasa a `conCandadoLectura` solo corre con el candado tomado. Ahí va la marca `enCurso` (AC4).

Módulo nuevo `flit2-programa.ts` (memoria del proceso) para que cron, lectura y estado lo compartan
sin ciclo: `flit2-programa.ts` no importa nada del módulo (solo el tipo de shared-types).

```
flito-sync.cron.ts ──┐
flit2-lectura.service.ts ──> flit2-programa.ts <── flit2-estado.service.ts
```

## Contrato delta

`GET /api/flito/sync/flit2/estado` (permisos y middleware **sin cambio**) añade:

```ts
// packages/shared-types/src/flito-flit2.ts
export interface Flit2EstadoAutomatica {
  activa: boolean;             // FLIT2_SYNC_CRON encendida y el timer armado en este proceso
  intervaloMs: number | null;  // 300000 con activa=true; null con activa=false
  proximaEn: string | null;    // ISO; null con activa=false
  enCurso: boolean;            // una lectura con el candado tomado EN ESTE PROCESO
  generadoEn: string;          // ISO del `ahora` con que se compuso la respuesta
}
// Flit2EstadoConexion += automatica: Flit2EstadoAutomatica;   (siempre presente, AC5)
```

Decisión de este diseño (no está en los AC): `intervaloMs = null` cuando `activa = false`, coherente con
`proximaEn = null` ("no hay programa"). Si Producto prefiere 300000 siempre, es un cambio de una línea.

Nada sensible (AC6): solo booleanos, un entero y dos horas. Ni origen de la lectura, ni cursor, ni conteos.

## Firma de `flit2-programa.ts`

```ts
// apps/api/src/modules/flito-sync/flit2-programa.ts  (≈50 líneas)
export interface EstadoPrograma {
  activa: boolean; intervaloMs: number | null; proximaEn: Date | null; enCurso: boolean;
}

/** startFlitSync con el cron encendido, justo después de armar el setInterval. proximaEn = ahora + intervaloMs. */
export function marcarProgramaEncendido(intervaloMs: number, ahora: Date): void;
/** startFlitSync con FLIT2_SYNC_CRON=false, y stopFlitSync. activa=false, intervaloMs=null, proximaEn=null. */
export function marcarProgramaApagado(): void;
/** Cada disparo del setInterval, ANTES de decidir si lee o se salta (AC2). Sin programa activo: no-op. */
export function registrarTick(ahora: Date): void;
/** Dentro de leerConCandado, ya con el candado tomado. Contador (no booleano): nunca queda en negativo. */
export function marcarLecturaIniciada(): void;
export function marcarLecturaTerminada(): void;   // Math.max(0, n - 1)
/** Foto inmutable para el estado. enCurso = contador > 0. */
export function leerPrograma(): EstadoPrograma;
/** Solo tests: vuelve al estado de arranque (apagado, contador 0). */
export function reiniciarProgramaParaTest(): void;
```

Estado inicial del módulo = apagado (`activa=false`, contador 0): si el `GET` llega antes de que
`server.ts` llame a `startFlitSync()`, responde "apagada", que es la verdad en ese instante.

## Dónde se llama cada una

| Función | Archivo · función | Momento |
|---|---|---|
| `marcarProgramaEncendido(INTERVALO_FLIT2_MS, new Date())` | `flito-sync.cron.ts` · `startFlitSync` | tras `setInterval(...)`, solo en la rama encendida. Si `timerFlit2` ya existe (doble arranque) se retorna antes: no se reinicia `proximaEn` |
| `marcarProgramaApagado()` | `flito-sync.cron.ts` · `startFlitSync` (rama `!env.FLIT2_SYNC_CRON`) y `stopFlitSync` | — |
| `registrarTick(new Date())` | `flito-sync.cron.ts` · callback del `setInterval` | primera línea del callback: `() => { registrarTick(new Date()); void correrLecturaFlit2Programada(); }`. **No** dentro de `correrLecturaFlit2Programada` (la llaman los tests a mano y el candado tomado/salto debe avanzar igual, AC2) |
| `marcarLecturaIniciada/Terminada` | `flit2-lectura.service.ts` · `leerConCandado` | dentro del callback de `conCandadoLectura`: `async () => { marcarLecturaIniciada(); try { return await leerIncremental(...); } finally { marcarLecturaTerminada(); } }`. Así cubre cron, botón y el futuro origen `'acceso'` (HU #13190) sin tocar a quien llama |
| `leerPrograma()` | `flit2-estado.service.ts` · `obtenerEstadoConexion` | entra en `EntradaEstado.programa`; `componerEstado` arma `automatica` con `generadoEn = ahora.toISOString()` y `proximaEn = activa ? iso(proximaEn) : null` **fuera** del `if (configurado …)` (AC5) |

El `enCurso` local de `flito-sync.cron.ts` **se queda** y no se unifica: es la guarda anti-encimado del
tick (cubre también el `reserve()` antes del candado); el nuevo es "lectura corriendo con candado".
Distintos a propósito.

`obtenerEstadoConexion`: fijar `const ahora = reloj()` una sola vez tras el `Promise.all` y usarlo para
`componerEstado` (ya es así) — `generadoEn` y `alerta` salen del mismo instante.

## Archivos a crear/modificar

| Archivo | Cambio |
|---|---|
| `apps/api/src/modules/flito-sync/flit2-programa.ts` | **crear** (firma arriba) |
| `apps/api/src/modules/flito-sync/flito-sync.cron.ts` | 3 llamadas (encendido, apagado ×2, tick) + comentario de cabecera HU #13188 |
| `apps/api/src/modules/flito-sync/flit2-lectura.service.ts` | `leerConCandado`: envolver `leerIncremental` con iniciada/terminada (617 líneas → sigue < 800) |
| `apps/api/src/modules/flito-sync/flit2-estado.service.ts` | `EntradaEstado.programa: EstadoPrograma`; `componerEstado` añade `automatica`; `obtenerEstadoConexion` pasa `leerPrograma()`; RN-06 en cabecera |
| `packages/shared-types/src/flito-flit2.ts` | `Flit2EstadoAutomatica` + campo `automatica` (y export en el index si ese archivo no se re-exporta con `*`) |
| `apps/api/__tests__/services/flito-sync.flit2-programa.test.ts` | **crear** |
| `apps/api/__tests__/services/flito-sync.flit2-cron.test.ts` | casos AC1–AC3 |
| `apps/api/__tests__/services/flito-sync.flit2-lectura.test.ts` | caso AC4 |
| `apps/api/__tests__/services/flito-sync.flit2-estado.test.ts` | casos AC5/AC6 y fixtures de `EntradaEstado` con `programa` |
| `apps/api/__tests__/services/flito-sync.flit2-estado.routes.test.ts` | la forma del contrato incluye `automatica`; 401/permisos sin cambio (AC6) |

Regla 7 (shared-types): `grep -rn "Flit2EstadoConexion" apps/web` hoy da `components/flito/tramites/EstadoFlit2.tsx`
(tipo + guarda `esEstado`, que no exige el campo → no rompe) y el spec e2e `flito-tramites-estado-flit2.spec.ts`
(fixture: si construye el objeto tipado, `typecheck -w apps/web` lo dirá). Pintar el bloque en la UI **no** es
de esta HU. Correr `npm run build -w packages/shared-types` + `npm run typecheck -w apps/web`.

## Cómo se prueba cada AC (patrón existente)

Relojes: `flito-sync.flit2-cron.test.ts` ya usa
`vi.useFakeTimers({ toFake: ['setInterval','clearInterval','setTimeout','Date'], now: new Date('2026-09-29T15:00:00Z') })`
y `vi.advanceTimersByTimeAsync`; `flit2-lectura.service.js` está mockeado con `leerConCandadoMock`.
`flit2-programa.ts` **no** se mockea en ese archivo: se importa real y se lee con `leerPrograma()`.
`beforeEach` añade `reiniciarProgramaParaTest()`; el `afterEach` ya llama `stopFlitSync()`.

| AC | Archivo | Caso |
|---|---|---|
| unidad | `flito-sync.flit2-programa.test.ts` (nuevo, fechas explícitas, sin timers) | encendido → proximaEn = ahora+intervalo; `registrarTick` avanza; `registrarTick` con programa apagado no enciende; `Terminada` sin `Iniciada` no deja contador negativo; `leerPrograma` devuelve copia (mutarla no cambia el estado) |
| AC1 | cron | `startFlitSync()` → `leerPrograma()`: activa true, intervaloMs 300000, proximaEn `15:05:00Z`, enCurso false. Y vía `componerEstado`: `proximaEn − generadoEn ∈ (0, 300000]` |
| AC2 | cron | avanzar 5 min → proximaEn `15:10`. Con `leerConCandadoMock` en promesa **pendiente** (patrón del caso «AC2: tick con la anterior en curso») avanzar otros 5 min → el tick se salta y proximaEn = `15:15`. Con `mockRejectedValue(new Flit2LecturaEnCursoError())` → también avanza |
| AC3 | cron | `entorno.cron = false; startFlitSync()` → activa false, proximaEn null, intervaloMs null. Y `stopFlitSync()` tras encendido → apagado |
| AC4 | `flito-sync.flit2-lectura.test.ts` | ya mockea `flit2-candado.js` con `candado.tomado`; seguir el patrón de la línea ~857 (`const promesa = leerConCandado('cron', port)` con un port que no resuelve): `leerPrograma().enCurso === true` mientras está pendiente; resolver → false. Variante con `Flit2RespuestaError` → false tras el rechazo. Variante con `candado.tomado = true` antes de llamar → lanza `Flit2LecturaEnCursoError` y enCurso **nunca** pasó a true |
| AC5 | `flito-sync.flit2-estado.test.ts` | `componerEstado` sin acceso y sin ambiente → `automatica` presente con los valores del programa pasado |
| AC6 | `flito-sync.flit2-estado.test.ts` (mock keyed) + `.routes.test.ts` | `Object.keys(res.automatica)` exactamente las 5 claves; 401 sin token y permiso `sync.sync.ver_estado` sin cambio (casos existentes siguen verdes) |

Mutantes sugeridos para qa-agent B (≤3, P2): (1) quitar `registrarTick` del callback → muere AC2;
(2) mover `marcarLecturaIniciada` fuera de `conCandadoLectura` → muere la variante «candado tomado» de AC4;
(3) quitar el `finally` de `marcarLecturaTerminada` → muere la variante con error de AC4.

Comando P1:
`npm test -w apps/api -- __tests__/services/flito-sync.flit2-programa.test.ts __tests__/services/flito-sync.flit2-cron.test.ts __tests__/services/flito-sync.flit2-lectura.test.ts __tests__/services/flito-sync.flit2-estado.test.ts __tests__/services/flito-sync.flit2-estado.routes.test.ts`

## ADR: no aplica

Extensión del módulo con estado en memoria, mismo estilo que `flito-sync.cron.ts`. No sienta precedente.

## Riesgos y limitaciones (declaradas)

1. **Un solo proceso.** Todo el bloque describe **este** proceso de la API. Hoy hay un contenedor API sin
   réplicas; con PM2 en cluster o varias réplicas, cada una tendría su `proximaEn` y el `GET` respondería
   la del proceso que atendió. Si se escala, esto pasa a una fila en base (fuera de alcance).
2. **`enCurso` solo de este proceso.** Si el advisory lock lo tiene otro proceso/servidor, `enCurso` = false
   aquí aunque haya una lectura corriendo allá. El tick de este proceso se salta (AC2 avanza `proximaEn`),
   pero no se reporta la lectura ajena. Declarado; coherente con (1).
3. **Reinicio.** El estado nace apagado y `startFlitSync` lo enciende con `proximaEn = arranque + 5 min`,
   que es exactamente cuándo sale el primer tick (el `setInterval` también se rearma). Entre el `listen` y
   `startFlitSync` (`server.ts:87`) el `GET` diría `activa:false` durante milisegundos — aceptable.
   Una lectura cortada por el reinicio no deja `enCurso` pegado: el contador vive en memoria y muere con
   el proceso; el candado lo suelta Postgres al cerrar la sesión.
4. **Tick concurrente.** `registrarTick` va antes del salto por `enCurso` local o por candado ajeno, así
   que `proximaEn` avanza siempre (AC2). Dos lecturas del mismo proceso no pueden tener el candado a la vez
   (el lock es de sesión y reentrante solo en la misma conexión reservada, que es distinta por llamada) → el
   contador llega como mucho a 1; es contador por defensa, no por diseño.
5. **Arranque con cron apagado.** `marcarProgramaApagado()` explícito; el botón (y el futuro origen
   `'acceso'`) siguen marcando `enCurso` aunque `activa=false` — correcto: `enCurso` habla de la lectura,
   no del programa.
6. **Deriva del `setInterval`.** `proximaEn` es `hora real del tick + intervalo`, no la hora exacta en que
   Node disparará el siguiente; con el event loop bloqueado el siguiente tick puede llegar unos ms tarde y
   el `GET` ver un `proximaEn` ligeramente pasado. No se recorta: la UI debe tolerar `proximaEn < generadoEn`
   (mostrar «en breve»). Nota para la HU de frontend, no bloquea.
7. **Origen `'acceso'` (HU #13190).** No existe aún en `OrigenLectura` (`'cron' | 'boton'`). Esta HU no lo
   añade; basta con que #13190 pase por `leerConCandado` para heredar `enCurso`.

## Notas operativas

- **backend-agent:** P1 arriba. `build:api` con `NODE_OPTIONS=--max-old-space-size=8192` por el tipo de
  shared-types. Imports relativos con `.js`. No tocar la ruta ni permisos.
- **frontend-agent:** nada en esta HU; el campo nuevo no rompe `esEstado`. Verificar solo `typecheck -w apps/web`.
- **security-agent:** no aplica (sin ruta nueva, sin PII, sin auth/multer/deps) — declararlo.
- **db-review-agent:** no aplica (sin `schema.ts` ni migración).
