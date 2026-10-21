# Diseño slim: Feature #13694, Dr. Flit (panel lateral sin IA)

> **Modo:** slim (architecture-agent, 2026-10-21). Solo `apps/web`. Sin API, esquema, `shared-types`, `package*.json` ni dependencias nuevas.
> **Fuente:** `docs/ado-drafts/epic-12756-12757/HUS-F3-13694.md` (4 HUs, P9 cerrada) sobre el código de F1 (`docs/diseno/feature-13691-ayuda-flito-v2-slim.md`, §8 «Contrato hacia F3 y F4»).
> **Habla con:** el módulo web de Ayuda FLITO (`lib/ayuda*.ts`, `content/ayuda/`). No toca módulos legacy ni `flito-*` del API.
> **Dependencia de UX:** `docs/ux/flito-dr-flit.md` (ux-agent full) **todavía no existe**. Este diseño fija fronteras, datos y funciones; la colocación visual, el copy y la confirmación de «Terminar chat» los fija UX. HU-1 no arranca sin ambos.

## Patrón reutilizado

| Necesidad | Se reutiliza (path real) | Qué NO se hace |
|---|---|---|
| Visibilidad del botón y de las fichas | `apps/web/src/lib/ayudaFlito.ts`: `puedeVerAyudaFlito`, `capitulosVisibles`, `capitulosEnOrdenDeIndice`, `puedeVerEntradaAyuda`, `esClaveAyuda`, `entradaAyudaPorClave` | Importar `hasPage` / `lib/permissions` (ciclo `permissions → navItems → ayudaFlito`) |
| Resumen de módulo | `lib/ayudaBusqueda.ts`: `resumenDeEntrada` | Duplicar la fuente del resumen |
| Normalización y pesos | `lib/ayudaBusqueda.ts`: `normalizarBusquedaAyuda` y la tabla `PESO` | Una normalización o unos pesos paralelos |
| Secciones y anclas | `lib/ayudaMarkdown.ts`: `parseMarkdown` (bloques `h1–h3` con `id`, sufijo `-2` incluido), `textoPlano` | Recalcular anclas con `anclaDeEncabezado(texto)` (cita el primer duplicado) |
| Carga de fichas | `content/ayuda/cargarFichas.ts`: `leerFichaParseada`, `leerFichasParseadas(claves)` con **solo** claves visibles | Cargar el glob completo |
| Almacén de pestaña + barrido en las 4 salidas | `lib/conciliacionAviso.ts` (módulo sin imports porque `auth.tsx` va en el chunk de entrada) + sus 4 llamadas en `lib/auth.tsx` | Meter la lógica de conversación en el entry |
| Funciones puras importables desde Playwright | `e2e/tests/flito-ayuda-busqueda.spec.ts` (importa `src/lib/ayudaBusqueda`) | Vitest en `apps/web` (no existe) |
| Montaje post-login | `components/Layout.tsx` ya es `lazy()` en `App.tsx:118`; el panel es un segundo `lazy()` dentro | Import estático del panel |

## Delta respecto a la Ayuda v2 (#13691)

F1 cerró las piezas puras y dijo «la búsqueda por sección es de F3». F3 añade:

1. **Una función de búsqueda por sección** (`lib/drFlitBusqueda.ts`), sobre la salida de `parseMarkdown`. `ordenarPorRelevancia` no cambia.
2. **Un único cambio en un archivo de F1:** `lib/ayudaBusqueda.ts` pasa a `export const PESO` (hoy es `const`). Mismo objeto, mismo valor, `as const`. Ningún comportamiento de la Ayuda cambia; el spec `flito-ayuda-busqueda.spec.ts` sigue verde sin tocarse.
3. **Un modelo de conversación versionado** (`lib/drFlitConversacion.ts`) y un almacén mínimo sin imports (`lib/drFlitAlmacen.ts`) que `auth.tsx` llama en sus 4 salidas.
4. **Una superficie global del shell**: montaje en `components/shell/DrFlitMontaje.tsx` (botón eager + panel `lazy()` con reintento), componentes en `components/drflit/`.
5. Sin cambios en: `catalogo.ts`, `ayudaFlito.ts`, `ayudaMarkdown.ts`, `ayudaFicha.ts`, `cargarFichas.ts`, `FlitoAyuda.tsx`, `App.tsx`, `sw.js`.

## Contrato delta

### 1. Visibilidad del botón (HU-1 AC1/AC2, fail-closed)

`tipoEnlace` del contexto vale `null` **tanto** «aún no llegó `/mios`» como «llegó sin enlace», así que no sirve como señal de resolución. La señal es `funciones` (es `null` hasta que `/mios` responde) más `permisosError`:

```ts
// components/shell/DrFlitMontaje.tsx (lógica en línea, ≤5 líneas)
const { user, funciones, permisosError } = useAuth();
const visible = funciones !== null && !permisosError && puedeVerAyudaFlito(user);
```

Con `permisosError` (fallo de `/mios`) `tipoEnlace` es desconocido → oculto. Si el usuario pierde la visibilidad con el panel abierto (refresco de permisos), el montaje se desmonta entero (botón y panel).

### 2. Frontera de carga (HU-1 AC8/AC9)

- `Layout.tsx` (ya chunk post-login) renderiza `<DrFlitMontaje />` junto a `<CommandPalette />`. `DrFlitMontaje` y `DrFlitBoton` son eager **dentro del chunk de Layout**: solo importan `ayudaFlito` (ya presente en el shell por `navItems`) y `useAuth`. El chunk de `/login` no cambia.
- `DrFlitPanel` va con `lazy()` y **solo se instancia tras el primer clic**. Después queda montado (oculto con `hidden` al cerrar) para que la conversación y el scroll sobrevivan a la navegación (AC6), que ya los preserva porque `Layout` no se desmonta al cambiar de ruta.
- **Reintento (AC9):** `React.lazy` cachea la promesa rechazada, así que «Reintentar» no puede re-renderizar el mismo componente. El montaje guarda el componente en estado y lo recrea:
  ```ts
  const crearPanel = () => lazy(() => import('../drflit/DrFlitPanel'));
  const [Panel, setPanel] = useState<ReturnType<typeof crearPanel> | null>(null);
  // abrir: setPanel((p) => p ?? crearPanel());  reintentar: setPanel(crearPanel());
  ```
  `<Suspense fallback={<cargando/>}>` + un error boundary local (no el `ErrorBoundary` de página) con «Reintentar». No hay helper de `lazyConReintento` en el repo; no se crea uno genérico (YAGNI): vive en el montaje.
- Las fichas se cargan dentro del panel con `leerFichasParseadas(capitulosVisibles(user).map(c => c.clave))`, **una vez por sesión de panel** y solo al primer uso de «Tengo una pregunta» (HU-3) o al elegir un módulo (HU-2: `leerFichaParseada(clave)`). Una ficha sin permiso no se pide nunca (HU-3 AC4, verificable en red).

### 3. Búsqueda por sección (HU-3)

Archivo nuevo **`apps/web/src/lib/drFlitBusqueda.ts`**, puro (solo importa `./ayudaMarkdown`, `./ayudaBusqueda`, tipos de `./ayudaFicha` y `../content/ayuda/catalogo`; nada de React, `api`, ni `import.meta`).

```ts
export interface SeccionAyuda {
  clave: string;          // clave de la ficha
  ancla: string;          // id del bloque h1–h3 tal como lo emite parseMarkdown (incluye -2, -3)
  tituloFicha: string;    // EntradaAyuda.etiqueta
  tituloSeccion: string;  // textoPlano(children) del encabezado
  texto: string;          // textoPlano de p/ul/ol/callout/quote hasta el siguiente encabezado; sin `pre`
  palabrasClave: readonly string[]; // las de la ficha (encabezado), heredadas por cada sección
  consultas: readonly string[];
}

export interface CitaSeccion { clave: string; ancla: string; tituloFicha: string; tituloSeccion: string }

/** Secciones de UNA ficha, en orden de aparición. `ficha === null` (pendiente) → []. */
export function seccionesDeFicha(entrada: EntradaAyuda, ficha: FichaParseada | null): SeccionAyuda[];

/** Hasta `n` citas. El llamador pasa SOLO fichas visibles (como ordenarPorRelevancia). Determinista, no muta. */
export function buscarSecciones(
  fichas: readonly { entrada: EntradaAyuda; ficha: FichaParseada | null }[],
  consulta: string,
  n = 3,                  // P9-1 (a)
): CitaSeccion[];

/** ¿El ancla existe hoy en esa ficha? Lo usa la rehidratación (HU-4 AC5). */
export function anclaExiste(ficha: FichaParseada | null, ancla: string): boolean;

export const MAX_CITAS = 3;
```

Reglas (cerradas aquí; QA las cubre con la función importada desde `src`):
- Secciones = cada bloque `h1|h2|h3` de `parseMarkdown(ficha.cuerpo)`. El texto previo al primer encabezado no es citable (lo cubre el resumen de la ficha).
- Términos = `normalizarBusquedaAyuda(consulta).split(' ')` menos una lista **cerrada** de palabras vacías declarada en el archivo (`a al de del el la las lo los en y o u un una unos unas por para con que se me mi es`). Sin términos útiles → `[]` (respuesta «sin resultados»). La pregunta natural («¿cómo hago para conciliar?») no puede exigir todas las palabras, por eso:
- Filtro: la sección entra si **al menos un** término aparece en algún campo. Orden: (1) más términos distintos cubiertos, (2) más puntos, (3) orden de la ficha en la entrada (= `capitulosEnOrdenDeIndice`), (4) orden de la sección en la ficha.
- Puntos por término y campo (presencia, no frecuencia), con la tabla `PESO` exportada de F1: `tituloSeccion → PESO.titulo` (8), `tituloFicha → PESO.palabrasClave` (4), `palabrasClave → PESO.consultas` (2), `consultas → PESO.consultas` (2), `texto → PESO.cuerpo` (1). Bonus `PESO.tituloContiene` (30) si el título de sección normalizado contiene la consulta normalizada sin palabras vacías.
- Comprobación de diseño de HU-3 AC1: «¿cómo se entra a trámites?» → términos `como entra tramites`; «Cómo se entra» de la ficha de trámites cubre los 3 (2·8 + 4 + bonus) y gana a la misma sección de otra ficha (cubre 2). Si el contenido real de F2 contradice esto, se ajusta en HU-3 con el spec, no en este documento.

### 4. Modelo de conversación y almacenamiento (HU-2/3/4)

**`apps/web/src/lib/drFlitAlmacen.ts`** — sin imports (va al entry vía `auth.tsx`, mismo motivo que `conciliacionAviso.ts`):

```ts
export const PREFIJO_DRFLIT = 'flito:drflit:';
export function claveConversacion(userId: string | number): string; // `flito:drflit:conversacion:<userId>`
export function leerCrudo(userId): string | null;                    // try/catch → null
export function escribirCrudo(userId, valor: string): void;          // try/catch silencioso (storage bloqueado/lleno)
export function limpiarConversacionDrFlit(): void;                   // borra toda clave con PREFIJO_DRFLIT; try/catch
```

El `userId` en la clave es defensa en profundidad (como el aviso de conciliación): si un barrido fallara, otro usuario de la pestaña no lee la conversación ajena. Nada de Dr. Flit en `localStorage` (HU-4 AC4).

**`apps/web/src/lib/drFlitConversacion.ts`** — puro (importa `drFlitAlmacen`, `ayudaFlito`, tipos):

```ts
export const VERSION_CONVERSACION = 1;
export const MAX_MENSAJES = 50;
export const MAX_PREGUNTA = 300;

export interface RefFicha { clave: string; ancla?: string }   // sin ancla = ficha completa
type Base = { id: string; ts: number };
export type MensajeDrFlit =
  | (Base & { de: 'usuario'; tipo: 'pregunta'; texto: string })      // texto tal cual (P9-4a), ≤300
  | (Base & { de: 'usuario'; tipo: 'modulo'; clave: string })        // «Explícame X»: la etiqueta se deriva del catálogo
  | (Base & { de: 'drflit'; tipo: 'explicacion'; ref: RefFicha })    // resumen se deriva al pintar, NO se guarda
  | (Base & { de: 'drflit'; tipo: 'citas'; respondeA: string; refs: RefFicha[] })   // 1..3
  | (Base & { de: 'drflit'; tipo: 'sinResultados'; respondeA: string });            // la consulta se lee de respondeA

export interface ConversacionGuardada { v: typeof VERSION_CONVERSACION; mensajes: MensajeDrFlit[] }

export function serializar(mensajes: readonly MensajeDrFlit[]): string;  // recorta a los 50 más recientes
export function restaurar(crudo: string | null): MensajeDrFlit[];        // JSON inválido, v ≠ 1, forma rota → []
export function agregar(mensajes, nuevo): MensajeDrFlit[];               // inmutable + tope
export type EstadoRef = 'disponible' | 'no-disponible' | 'por-verificar';
export function estadoReferencia(user: UsuarioAyuda | null, ref: RefFicha, fichas?: Map<string, FichaParseada | null>): EstadoRef;
```

Reglas:
- **Qué se guarda (HU-4 AC4):** solo lo que está en la unión. Títulos de ficha/sección, resúmenes y cuerpos **nunca**: se derivan al pintar desde el catálogo y la ficha cargada. Los estados efímeros (cargando, error, reintento, confirmación de «Terminar chat», bienvenida) no se guardan.
- **`restaurar` es tolerante por mensaje:** descarta el mensaje con `tipo` desconocido, campos de tipo erróneo, `clave` que no pasa `esClaveAyuda`, `texto` > 300 o `refs` > 3; el resto sobrevive. Payload ilegible o `v` distinta → `[]` y se borra la clave. Nunca `console.*` (HU-3 AC7, HU-4 AC6).
- **Rehidratación sin saltarse permisos (HU-4 AC5):** `estadoReferencia` es síncrona para el permiso (`!puedeVerEntradaAyuda` → `no-disponible`, sin descargar la ficha) y, para las visibles, pasa de `por-verificar` a `disponible`/`no-disponible` cuando el panel carga **solo las claves visibles referenciadas** y comprueba `anclaExiste`. `no-disponible` pinta «Esta referencia ya no está disponible», sin título ni enlace.
- **Cuándo se escribe:** el panel llama `escribirCrudo(user.id, serializar(m))` tras cada `agregar`. Lectura inicial al montar el panel con `restaurar(leerCrudo(user.id))`. Con storage bloqueado la conversación vive en memoria (HU-4 AC6).
- **«Terminar chat» (HU-4 AC2):** confirma (UX), luego `limpiarConversacionDrFlit()` + estado vacío.

**Extensibilidad F4/F5** (no se diseñan aquí, solo se deja el hueco):
- La unión se amplía por `tipo`. Un `tipo` nuevo **no** sube `v`: un cliente viejo lo descarta en `restaurar` sin romper. Solo se sube `v` si cambia la forma de un `tipo` existente.
- F4 añadirá p. ej. `{ de: 'drflit'; tipo: 'respuestaIa'; …; refs: RefFicha[] }` y usará `buscarSecciones` como respaldo determinista y como contexto acotado por permisos. Si F4 decide guardar texto generado, esa decisión pasa por `security-agent` (no está cubierta por P9-4).
- F5 colgará «Necesito soporte» del componente que pinta `sinResultados` (`DrFlitMensaje`), sin cambio de modelo; si persiste el número de caso, será un `tipo` nuevo.

### 5. Punto de enganche del borrado en `auth.tsx` (HU-4 AC3)

Una línea `limpiarConversacionDrFlit();` inmediatamente después de cada `limpiarAvisos();`, en los cuatro caminos que ya existen (no se crea un quinto ni un agregador):

| Camino | Ubicación actual |
|---|---|
| Arranque sin token | `useEffect` inicial, rama `if (!token)` |
| Token inválido en `/auth/me` | mismo `useEffect`, `.catch(() => { clearToken(); limpiarAvisos(); … })` |
| `SESSION_ENDED_EVENT` (401) | `onSessionEnded` |
| Cerrar sesión | `logout` |

Import: `import { limpiarConversacionDrFlit } from './drFlitAlmacen';` — el módulo no importa nada, así que el entry crece unas decenas de bytes. Además, el panel se desmonta solo al quedar `user === null` (el `Layout` no se monta fuera de `ProtectedRoute`), de modo que no queda conversación en memoria para el siguiente usuario.

## Archivos a crear/modificar

| Archivo | Acción | HU |
|---|---|---|
| `apps/web/src/components/shell/DrFlitMontaje.tsx` | crear: gate fail-closed, estado abierto/cerrado, `lazy()` con reintento, Suspense + boundary local | 1 |
| `apps/web/src/components/drflit/DrFlitBoton.tsx` | crear: botón flotante (`aria-expanded`, `aria-controls`, retorno de foco) | 1 |
| `apps/web/src/components/drflit/DrFlitPanel.tsx` | crear: `<aside role="complementary" aria-label="Dr. Flit">` no modal, Esc solo con foco dentro (`onKeyDown` del panel, no `window`), bienvenida, enlace «Abrir la Ayuda FLITO»; luego estado de conversación | 1 (+2, 3, 4) |
| `apps/web/src/components/Layout.tsx` | modificar: `<DrFlitMontaje />` junto a `<CommandPalette />` | 1 |
| `apps/web/src/components/drflit/DrFlitModulos.tsx` | crear: lista `capitulosEnOrdenDeIndice(user)` como botones | 2 |
| `apps/web/src/components/drflit/DrFlitMensaje.tsx` | crear: pinta cada `tipo`, `aria-live="polite"` en la región de mensajes; aquí se engancha F5 | 2 (+3, 4) |
| `apps/web/src/lib/drFlitConversacion.ts` | crear: tipos y `agregar` en HU-2; `serializar`/`restaurar`/`estadoReferencia` en HU-4 | 2, 4 |
| `apps/web/src/lib/drFlitBusqueda.ts` | crear | 3 |
| `apps/web/src/lib/ayudaBusqueda.ts` | modificar: `export const PESO` (sin otro cambio) | 3 |
| `apps/web/src/components/drflit/DrFlitPregunta.tsx` | crear: `<label>` «Escriba su pregunta», `maxLength={300}`, Enter envía, vacío no envía | 3 |
| `apps/web/src/lib/drFlitAlmacen.ts` | crear (sin imports) | 4 |
| `apps/web/src/lib/auth.tsx` | modificar: 4 líneas + 1 import | 4 |
| `apps/web/e2e/tests/dr-flit-panel.spec.ts` | crear | 1 |
| `apps/web/e2e/tests/dr-flit-modulos.spec.ts` | crear | 2 |
| `apps/web/e2e/tests/dr-flit-preguntas.spec.ts` | crear (bloque puro importando `src/lib/drFlitBusqueda` + bloque UI) | 3 |
| `apps/web/e2e/tests/dr-flit-sesion.spec.ts` | crear (bloque puro importando `src/lib/drFlitConversacion` + bloque UI) | 4 |

Helpers de E2E: reutilizar `e2e/helpers/ayuda-fixtures.ts` (`loginAs`, `FINANCIERA_USER`, …). Si hace falta abrir el panel en varios specs, añadir `abrirDrFlit(page)` ahí mismo en lugar de un helper nuevo.

Todos los archivos nuevos muy por debajo de 800 líneas; `DrFlitPanel.tsx` es el único con riesgo de crecer: si pasa de ~300, la conversación se extrae a un hook `components/drflit/useConversacionDrFlit.ts`.

## E2E previstos

| Spec | Cubre | Notas |
|---|---|---|
| `dr-flit-panel.spec.ts` | HU-1 AC1–AC9 | AC2: `page.route('**/permisos/mios', …)` con demora y aserción de que el botón no existe mientras tanto; usuario con enlace de cliente nunca lo ve. AC8: `page.on('request')` sin URL que contenga `DrFlitPanel` antes del clic. AC9: `page.route` que aborta el chunk del panel la 1.ª vez → «Reintentar» → bienvenida. AC4: Esc con un diálogo de página abierto. AC7: viewport `<lg` sin scroll horizontal. Axe con `e2e/helpers/axe.ts` |
| `dr-flit-modulos.spec.ts` | HU-2 AC1–AC5 | Financiera sin «Integración con Siigo»; enlace a `/flito/ayuda/flito_tramites`; ficha pendiente; error de carga con `page.route` sobre el chunk de la ficha |
| `dr-flit-preguntas.spec.ts` | HU-3 AC1–AC9 | Bloque puro: `buscarSecciones` con fichas leídas por `fs` + `parsearFicha` (como `flito-ayuda-busqueda.spec.ts`), incluye ficha sintética con encabezado duplicado → ancla `-2` (AC2) y `CONCILIACION` = `conciliación` (AC3). Bloque UI: AC4 sin request al chunk de `siigo_credenciales`; AC5 URL `/flito/ayuda` sin query; AC7 ninguna request ni `console` contiene la pregunta |
| `dr-flit-sesion.spec.ts` | HU-4 AC1–AC7 | Bloque puro: `restaurar` con JSON corrupto, `v: 0`, `tipo` desconocido, 60 mensajes → 50. Bloque UI: recarga conserva; «Terminar chat»; las 4 salidas (logout, 401 vía `page.route`, arranque sin token, `/auth/me` 500) seguidas de otro login en la misma pestaña → panel vacío; lectura de `sessionStorage` sin resúmenes ni cuerpos y `localStorage` sin claves `flito:drflit:` |

## ADR: no aplica

Sin modelo de datos de servidor, contrato de API, dependencia ni cambio de auth. El único tradeoff de datos personales (texto libre del usuario en `sessionStorage`) lo decidió el humano en P9-4 (a), con tope, alcance de pestaña y barrido en las 4 salidas; lo revisa `security-agent` diff-scoped en HU-4. No se pone PII en URLs: «Abrir la Ayuda FLITO» no prellena la búsqueda (regla 14).

## Notas operativas (frontend)

- **Orden:** ux full (`docs/ux/flito-dr-flit.md`) → HU-1 → HU-2 → HU-3 → HU-4. HU-2 crea `drFlitConversacion.ts` solo con los tipos y `agregar` (memoria); HU-4 añade persistencia sin cambiar los tipos.
- **Nunca `hasPage`** en ningún archivo de Dr. Flit. Visibilidad: `puedeVerAyudaFlito` / `capitulosVisibles` / `puedeVerEntradaAyuda`.
- **Puros importables desde Playwright:** `drFlitBusqueda.ts`, `drFlitConversacion.ts` y `drFlitAlmacen.ts` no importan React, `lib/api`, ni `import.meta`. `drFlitConversacion.ts` sí importa `ayudaFlito.ts` (ya puro: lo importa F1 desde specs).
- **Nada a consola ni a red con la pregunta:** sin `console.*` en los tres módulos ni en los componentes; sin RUM/telemetría del texto (`lib/rum.ts` no se toca).
- **Verificación P1 por HU:** `npm run typecheck -w apps/web` + el spec `dr-flit-*` de la HU. HU-1 y HU-4 (tocan el shell y el entry) añaden `npm run build:web && npm run check:bundle`. HU-3 corre además `flito-ayuda-busqueda.spec.ts` (por exportar `PESO`).
- **Gates:** `security-agent` diff-scoped solo en HU-4 (sessionStorage con texto libre + `auth.tsx`). `db-review`: N/A. `flit-ayuda-flito`: N/A (superficie del shell).

## Riesgos abiertos

1. **`docs/ux/flito-dr-flit.md` no existe**: HU-1 queda bloqueada hasta tenerlo (colocación frente al dock `fixed bottom-0 z-30`, `z-index` del panel frente a modales de página).
2. **Lista de palabras vacías y orden por cobertura** son una decisión de este diseño (no de P9). Si el contenido real de F2 da citas pobres, se ajusta en HU-3 con el spec puro como red, sin cambiar la firma.
3. **`funciones !== null` como señal de «permisos resueltos»** depende del contrato actual de `AuthProvider` (comentario «`null` hasta que `/mios` responda»). Si alguien cambia esa semántica, el AC2 de HU-1 lo detecta en E2E.
