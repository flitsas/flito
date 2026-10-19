# Diseño slim — HU #13684: aviso de trámites nuevos o actualizados sin recargar

Feature #13612 · Épica #13576 · Estado del diseño: **Propuesto** (no hay ADR).
Módulo: **FLITO** `flito-tramites` (`/api/flito/tramites`). No toca el legacy `tramites`.
UX: `docs/ux/flito-tramites-sincronizacion-simplificada.md` §«HU #13684».

## Decisión: B (endpoint ligero de novedades). Se descarta A

Hay dos opciones.

**(A) Solo frontend: volver a pedir el mismo `GET /flito/tramites?<query>` y comparar `total` + huella de la página.** No sirve:
- **Un cambio neto de cero no se detecta.** Si entra 1 trámite nuevo y otro sale del filtro (por ejemplo, cambia de estado con un filtro de estado activo), `total` no cambia. Con orden «más antiguos primero» o desde la página 2 en adelante, el nuevo además no aparece en la página visible. Entonces ni `total` ni la huella detectan nada y se incumple AC1.
- **No sabe decir «N nuevos».** La resta de totales da un neto, no la cantidad de trámites nuevos que pide la UX.
- **Coste y Habeas Data.** Descarga cada 45-60 s, por pestaña, la página completa (hasta 200 filas con compradores: documento, correo, celular y dirección), solo para saber si cambió algo. Eso es PII viajando sin que nadie la vea.
- **La huella sí detecta cambios en la página visible (AC2)**, pero el costo de lo anterior no lo compensa.

**(B) `POST /api/flito/tramites/novedades/buscar`** devuelve dos contadores sin PII. Es la recomendada.
- Reusa `construirCondiciones` y los joins del COUNT de `listar`, así que la lógica de filtros es una sola.
- Esfuerzo: **S** en backend y **S** en frontend.
- **No necesita migración**, por lo que no aplica `db-review-agent`.

## Patrón reutilizado

- La ruta sigue a `GET /` de `apps/api/src/modules/flito-tramites/flito-tramites.routes.ts` (L55-73): usa `exigirFuncion('tramites.cola.ver')` y `alcanceDe(req)`.
- La consulta reusa `construirCondiciones` (`flito-tramites.service.ts` L552) más `condicionAlcanceTramites` (`flito-tramites.alcance.ts`). También reusa la cadena de joins del COUNT de `listar` (L623-633).
- El limitador sigue el patrón de `zipSoportesLimiter` (`shared/soportes/soportes-zip.ts`) sobre `shared/middleware/rateLimiter.ts`.

## Contrato delta

```
GET  /api/flito/tramites            (aditivo) respuesta { items, total, page, pageSize, marca }
     marca: string ISO-8601 — hora del servidor de BD tomada en la misma sentencia del COUNT.

POST /api/flito/tramites/novedades/buscar   auth + exigirFuncion('tramites.cola.ver') + novedadesLimiter
  body (Zod .strict()):
    filtros:  z.record(z.string().max(200)).default({})   // MISMAS claves/forma string que la query del GET
    marca:    z.string().datetime({ offset: true })        // la `marca` recibida del GET vigente
    visibles: z.array(z.string().uuid()).max(200).default([])  // ids de la página en pantalla
  200 { nuevos: number, actualizados: number }   Cache-Control: no-store   — sin PII, sin ids
  400 { error: 'Datos inválidos' }   (mismo `bad()` del router)
```

Semántica (todo bajo `and(...construirCondiciones(f), condicionAlcanceTramites(alcance))`):
- **`nuevos`** = `count(distinct id)` con las condiciones del filtro y `created_at > marca`.
  - Se usa `created_at`, que es cuándo FLITO lo ingirió, y **no** `fecha_creacion_flit`. Un trámite que nació en FLIT hace días pero llega ahora es nuevo para el operador.
  - El conteo no depende de la página ni del orden, así que AC1 se cumple aunque el trámite caiga en otra página.
- **`actualizados`** = `count(*)` de `flito_tramites` con `id = ANY(visibles)`, `updated_at > marca` y `created_at <= marca`. Esa última condición evita contar dos veces un trámite que ya cuenta como nuevo (AC2: cambio de un trámite visible).
  - No hace falta re-aplicar los filtros. Los ids vienen de la página ya filtrada y el alcance se vuelve a aplicar con `condicionAlcanceTramites`, de modo que un id ajeno inyectado no cuenta.
- `page`, `pageSize` y `orden` se ignoran aunque lleguen en `filtros`.

### Reuso de filtros sin duplicar

- **Backend.** Se extrae el bloque L56-71 del handler `GET /` a una función pura `filtrosDesdeQuery(q: Record<string, unknown>): FiltrosListado` (los helpers `str`, `lista` y `fecha` ya existen ahí).
  - El GET pasa a llamar `filtrosDesdeQuery(req.query)`.
  - Novedades llama `filtrosDesdeQuery(body.filtros)`.
  - Así los valores desconocidos se ignoran igual en las dos rutas.
- **Frontend.** Se extrae del `useEffect` (FlitoTramites.tsx ~L199-218) la construcción de `URLSearchParams` a una función pura.
  - El GET la usa como query.
  - El sondeo manda `Object.fromEntries(q)` como `filtros` en el body.
  - Con eso se cumple la regla 14: placa, nombre o NIT de `buscar` van en el body del endpoint nuevo. El GET existente no se toca en esta HU.

### Marcas de tiempo: verificado en código

| Columna | Existe | Índice | ¿La lectura sin cambios la mueve? |
|---|---|---|---|
| `flito_tramites.created_at` | sí, `notNull defaultNow` | `idx_flito_tramites_created_at` | no aplica (solo INSERT) |
| `flito_tramites.updated_at` | sí, `notNull defaultNow` | **no** | **FLIT 1: no.** `escribirTramite(..., { soloSiCambia })` (`flito-sync.service.ts` ~L420) vuelve sin hacer UPDATE si `tramiteCambia` es falso, y `solo-si-cambia.ts` ignora `sincronizadoEn`/`updatedAt`. **FLIT 2: sí.** No pasa por `soloSiCambia` (cabecera de `solo-si-cambia.ts`): cada aviso de FLIT 2 mueve `updated_at` aunque traiga lo mismo. |

**Coste.** Un COUNT con los mismos joins que el COUNT del listado, que ya corre en cada carga, más un COUNT por PK sobre un máximo de 200 ids. La tabla tiene unos 7 mil trámites (comentario en `listar`).
- Con un sondeo cada 45-60 s por pestaña visible, el costo es menor que el del GET actual, que además trae la proyección y los compradores.
- **No hace falta índice en `updated_at`**, porque el filtro de `actualizados` va por `id = ANY(...)` usando la PK.
- **Sin migración.**

## Archivos a crear o modificar

Backend (`backend-agent`):
- `apps/api/src/modules/flito-tramites/flito-tramites.routes.ts`:
  - extraer `filtrosDesdeQuery`;
  - agregar la ruta `POST /novedades/buscar` con su Zod;
  - `res.set('Cache-Control','no-store')`.
- `apps/api/src/modules/flito-tramites/flito-tramites.service.ts`:
  - `export` de `construirCondiciones`;
  - extraer la cadena de joins del COUNT a un helper exportado (por ejemplo `conteoBase()`), usado por `listar`;
  - `marca` en `ListadoTramites` y en la respuesta de `listar`, con `marca: sql\`now()\`` en el mismo select del COUNT. Así no hay viaje extra a la BD y el reloj es el de la BD, no el de la app.
  - Neto ≈ 0 líneas en este archivo: está en 866 físicas y no debe crecer.
- **Nuevo** `apps/api/src/modules/flito-tramites/flito-tramites-novedades.service.ts`: `novedades(filtros, marca, visibles, alcance): Promise<{ nuevos; actualizados }>`.
- `apps/api/src/shared/middleware/rateLimiter.ts`: `novedadesLimiter`, por usuario, del orden de 6/min. Es holgado para un sondeo cada 45 s con varias pestañas o una carga, y se puede ajustar.
- Tests nuevos en `apps/api/__tests__/…/flito-tramites-novedades.test.ts`, que son el comando P1. Casos:
  - un nuevo que cumple el filtro cuenta y uno que no lo cumple no cuenta;
  - nuevo en otra página (orden `antiguos`);
  - un visible actualizado cuenta en `actualizados` y no en `nuevos`;
  - una lectura sin cambios (sin UPDATE) da 0;
  - un id fuera del alcance no cuenta;
  - body con clave desconocida responde 400;
  - la respuesta tiene solo las dos claves (sin PII);
  - el GET incluye `marca`.

Frontend (`frontend-agent`):
- `apps/web/src/pages/FlitoTramites.tsx`: tiene **techo congelado de 1190 en `eslint.config.mjs` y hoy está en 1228 físicas**. Solo cambia lo mínimo:
  - usar la función pura de query;
  - guardar `marca` del GET;
  - montar el aviso.
  - Lo nuevo va en archivos aparte.
- **Nuevo** hook `useNovedadesTramites`, junto a los componentes de la página:
  - `setInterval` de unos 50 s;
  - `document.visibilityState === 'visible'` y escucha de `visibilitychange`;
  - pausa si hay un diálogo abierto o una acción en curso (flags que entrega la página);
  - `catch` silencioso (AC4);
  - a lo sumo una petición en vuelo.
- **Nuevo** componente `AvisoNovedadesTramites`:
  - textos «Hay N trámites nuevos · Ver» y «Hay trámites actualizados · Ver»;
  - `role="status"` y `aria-live="polite"` (AC5);
  - botón con texto;
  - patrón de aviso del kit `components/flit/`.
- Todo va por `src/lib/api.ts` (`api.post`).
- E2E: un spec de la HU en `apps/web/e2e/tests/`.

## ADR: no aplica

Es una extensión de un módulo existente, sin tabla nueva y sin dependencia nueva. La regla 14 se respeta con el default en el body, así que no hace falta la excepción GET+query.

## Notas operativas

**Backend**
- La respuesta no incluye ids, placas ni nombres.
- No se loguea el body, porque `filtros.buscar` puede traer placa, cédula o NIT. Tampoco se agrega `logPiiAccess`: no se devuelve PII.
- Con `filtros` vacío el comportamiento es el de la tabla sin filtros, no un error.
- `marca` en el futuro (reloj del cliente manipulado) da 0 y 0. No es un error.

**Frontend**
- **AC3 choca con el código actual.** El `useEffect` de carga hace `setSeleccion(new Set())` en cada recarga, y «Ver» tiene que conservar la selección. «Ver» debe:
  - recargar la misma query, misma página y mismo orden (reusar `recarga`);
  - **no** limpiar la selección, por ejemplo con un flag `conservarSeleccion` en el disparo de «Ver».
  - El efecto de cambio de filtros sí sigue limpiándola.
- Tras «Ver» y tras cualquier recarga propia (por ejemplo después de «Solicitar SOAT»), la `marca` nueva del GET pasa a ser la línea base y el aviso desaparece. Así las acciones del propio operador no generan el aviso «actualizados».
- Si cambian los filtros, el aviso se borra y la línea base se reinicia con el GET nuevo.

**Gates**
- **Aplican:**
  - `security-agent` (diff-scoped): ruta nueva, filtros con cuasi-PII en el body, rate limiter.
  - `qa-agent` B.
  - `flit-code-review`.
  - `flit-ayuda-flito`, si Gestión Trámites tiene ficha: el aviso es comportamiento visible.
- **No aplica:** `db-review-agent` (sin `schema.ts` ni migración).
- `shared-types`: sin cambios. `ListadoTramites` vive en el service y el web usa su tipo local `Paginado`, al que se le agrega `marca`.

## Riesgos abiertos

1. **Falsos «actualizados» por FLIT 2.** Cada aviso de FLIT 2 mueve `updated_at` aunque no cambie nada. Si FLIT 2 reenvía avisos idénticos, el operador verá «Hay trámites actualizados» sin diferencia visible. Se mitiga fuera de esta HU, aplicando `soloSiCambia` a FLIT 2. **Pregunta de producto**: ¿se acepta para esta HU?
2. **Cambios que no tocan `flito_tramites`.** Si cambia el estado de SOAT o de impuesto en `flito_soat`/`flito_impuestos`, por ejemplo hecho por otro operador o por un gestor, no se mueve `flito_tramites.updated_at`, y no hay aviso. El AC2 habla de cambios que vienen de FLIT 1 o FLIT 2, que sí lo mueven. Si producto quiere también esos cambios, `actualizados` debe comparar además `GREATEST(flito_soat.updated_at, flito_impuestos.updated_at)`. Es S y no requiere migración, pero hay que decidirlo antes de implementar.
3. **Ventana de transacción.** `created_at` toma `now()` del inicio de la transacción de la lectura. Si esa transacción empezó antes de `marca` y confirma después, ese trámite no cuenta como nuevo hasta la siguiente recarga. El riesgo es despreciable si la escritura es por trámite. `backend-agent` debe confirmar el alcance de la transacción en `flito-sync` y declararlo.
4. **Trámite existente que entra al filtro** porque cambió de estado: no es nuevo y, si no está visible, tampoco cuenta como actualizado. El AC1/AC2 literal no lo pide. Se deja como Nota.
