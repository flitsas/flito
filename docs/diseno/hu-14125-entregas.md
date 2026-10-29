# Diseño slim — HU #14125 Pestaña Entregas

Feature #14094, Épica #13758. Decisiones de David del 2026-10-29 (mockup «pasa») cerradas: no se reabren.
Extensión de `flito-logistica`. Sin módulo nuevo, sin página nueva, sin ADR.

La ruta del router sigue `/flito/logistica`. Entregas es una pestaña de esa consola, después de Viajes y antes de Actas. Viajes (`ViajesACliente`) sigue registrando el destino. Mi ruta sigue entregando en campo. Actas conserva Ver / Firmar y despachar / Devolver.

## Patrón reutilizado

Lectura de la consola en `apps/api/src/modules/flito-logistica/flito-logistica.routes.ts`, con el mismo cierre de enlace que la línea de tiempo (HU #14124):

```ts
router.post('/traslados/buscar', soloSinEnlace(), exigirFuncion('logistica.consola.ver'), ...)
```

`soloSinEnlace()` va **antes** de `exigirFuncion`. El router ya monta `authMiddleware`. El módulo `logistica` está abierto al enlace `compania` (`FRONTERA_POR_ENLACE`); esta ruta se cierra igual. Proveedor y organismos ya los cierra la frontera del módulo, antes del handler.

La placa en body sigue `POST /api/flito/tramites/buscar` y `POST /api/flito/logistica/consultar-vehiculo`: filtro en el cuerpo, nunca en query ni en la URL del router. La normalización es `normPlaca` de `flito-logistica.aprobado.ts` (mayúsculas, sin espacios ni guiones).

La pestaña nueva sigue el corte de `TabMotivosLlegada` / `ViajesACliente`: componente propio, la página solo inserta la entrada en `TABS`.

## Función

`logistica.consola.ver`. Ya sembrada. La exige `GET /api/flito/logistica/` («Ver la consola de logística»). Reparto de la foto: `admin` y `auditor`. La acción `accion.logistica.ver_consola` ya la concede. Quien entra a la consola a leerla (el auditor incluido; el mensajero no: su página es Mi ruta) ya la tiene.

No hay función nueva, ni seed, ni migración de permisos. No se toca `acciones-gestion.ts` ni `sql-legado.ts`.

Regla «un código, un reparto»: la línea nueva del catálogo copia **byte a byte** el nombre y la descripción ya sembrados. No se edita el texto de `GET /`.

```ts
op(`${LOG} POST /traslados/buscar`, 'logistica.consola.ver',
  'Ver la consola de logística',
  'Abrir la trazabilidad de documentos en tránsito.'),
```

La fila nueva de `inventario.generado.ts` lleva `roles: ["admin","auditor"]`, los mismos que `GET /`. Otro reparto rompe `CatalogoIncoherenteError`.

Vecinos que no sirven: `logistica.traslado.registrar` es el alta de Viajes (y el mensajero puede tenerla sin entrar a la consola). `logistica.actas.listar` es el panel de actas. `logistica.ruta.ver` es Mi ruta. `companiasCerrables` de `GET /facetas` son LT clasificadas aún sin viaje.

## Contrato delta

`POST /api/flito/logistica/traslados/buscar`

Declararla en el router junto a `POST /traslados`, antes de `POST /traslados/:id/…`. No choca con `GET /:id` (otro método). `Cache-Control: no-store`. Sin `audit` (el motivo no puede llevar la placa). Sin `logPiiAccess`: el DTO no lleva PII; la placa solo filtra. Sin limitador nuevo: no devuelve placa y el front no dispara en cada tecla.

| Quién | Respuesta |
|---|---|
| Sin token | 401 del `authMiddleware` ya montado |
| Enlace distinto de `ninguno` (compañía, y cualquiera que llegue) | 403 `{ error: 'Sin permisos' }` de `soloSinEnlace`, antes de Zod y antes de mirar si hay viajes |
| Proveedor u organismos | 403 de la frontera del módulo, mismo cuerpo |
| Interno sin `logistica.consola.ver` | 403 `{ error: 'Sin permisos' }` de `exigirFuncion` |
| Body que no cumple el Zod | 400 `{ error: 'Datos inválidos' }` (igual que `POST /consultar-vehiculo`) |
| Cero filas | 200 con `viajes: []` (el vacío lo distingue el front) |

Zod del body, `.strict()`:

```ts
z.object({
  placa: z.string().trim().max(10).optional(),
  estado: z.enum(['registrado', 'en_ruta', 'entregado', 'devuelto', 'anulado']).optional(),
  destino: z.enum(['flit', 'cliente']).optional(),
  companiaId: z.number().int().positive().optional(),
}).strict()
```

Sin `page`, sin `pageSize`, sin `limite` de cliente. El tope no viaja en el body: el servicio, **después** de aplicar los filtros, lee `LIMIT 201`, devuelve 200 y `truncado: true` si sobró una. Constante `TOPE_ENTREGAS = 200` en el servicio de esta lectura. Así una placa o una compañía concretas se buscan en toda la tabla; el tope solo corta el listado sin filtro estrecho. La UI aprobada no pagina y no muestra `truncado`.

Placa ausente, `""` o que queda vacía tras `normPlaca`: no filtra. Si viene, igualdad exacta de `normPlaca(vehicles.plate)` contra `normPlaca(body.placa)`. No es `ILIKE` ni prefijo. Estado, destino y `companiaId` ausentes no filtran. Los cuatro se combinan con AND.

Qué viajes entran: **todas** las filas de `flito_logistica_traslados` (incluido `legado = true`), de todas las compañías. No se filtra por `mensajero_id` ni por la compañía del usuario. El enlace de compañía no llega a la consulta. No hay columna de proveedor en el traslado: el alcance es el personal sin enlace, no un id de proveedor.

Orden: `registrado_en DESC`, desempate `id DESC`.

La placa está en `vehicles.plate`. El documento (`flito_logistica_documentos.vehiculo_id`) no tiene columna `placa`; `identificador` es el código de barras, no la placa. El viaje casa si **alguna** de sus líneas de LT apunta a un vehículo con esa placa (`EXISTS`). El `COUNT` de LT va en un subselect por `traslado_id`, todas las líneas, también devueltas y anuladas. Un join directo duplicaría la fila y inflaría el conteo.

Compañías del select: en la **misma** respuesta, no en `GET /facetas`. Distintas compañías que tienen al menos un traslado, **sin** aplicar los filtros del body, ordenadas por nombre. Campos: `companiaId`, `nombre` (`clients.name`, null si no hay). Sin NIT.

## DTO

En `packages/shared-types/src/flito-logistica.ts` (ya reexportado por `index.ts`). Códigos, no etiquetas: el front pinta el texto.

```ts
type EstadoTrasladoLogistica = 'registrado' | 'en_ruta' | 'entregado' | 'devuelto' | 'anulado';
type DestinoTrasladoLogistica = 'flit' | 'cliente';

interface FilaEntregaLogistica {
  id: string;
  companiaId: number;
  companiaNombre: string | null;
  destino: DestinoTrasladoLogistica;
  estado: EstadoTrasladoLogistica;
  cantidadLt: number;
  registradoEn: string; // ISO
}
interface CompaniaConViajeLogistica {
  companiaId: number;
  nombre: string | null;
}
interface ListadoEntregasLogistica {
  viajes: FilaEntregaLogistica[];
  companias: CompaniaConViajeLogistica[];
  truncado: boolean;
}
```

Etiquetas junto al tipo: Registrado, En ruta, Entregado, Devuelto, Anulado. Destino: `cliente` → «Cliente», `flit` → «FLIT».

La fila no lleva mensajero, precio, placa, cédula, dirección, firma, payload, origen, NIT ni `legado`.

## UI

`FlitoLogistica.tsx`: en `TABS`, la clave `entregas` con etiqueta «Entregas», después de Viajes (`viajes-cliente`, solo si hay `logistica.traslado.registrar`) y antes de Actas. Se pinta si `hasFuncion('logistica.consola.ver')`. Sin badge. La petición sale solo con la pestaña activa.

Filtros en estado de React, nunca en la URL (la placa no puede ir en query):

- Select de estado (Todas + los cinco códigos).
- Select de destino (Todos, Cliente, FLIT). El destino no es chip.
- Select de compañía, opciones = `companias` de la última respuesta. «Todas» omite `companiaId`.
- Campo placa. Sin botón Buscar. Al cambiar un select se vuelve a pedir la lista. La placa espera 400 ms sin teclear y entonces pide.

Al activar la pestaña, el primer body es `{}`.

Fila, en este orden: compañía (nombre, o `compañía #<id>` si el nombre viene vacío — helper `nombreCompania` de `viajesCliente.ts`), destino en texto, estado en `StatusChip`, cantidad de LT, fecha de registro (`es-CO`, fecha y hora corta, el mismo `fecha()` de la consola). Tonos del chip, los del kit: registrado `neutral`, en ruta `warning`, entregado `success`, devuelto `danger`, anulado `neutral`. Sin clic de fila, sin modal, sin acciones de destino, sin paginador. Voz de usted.

| Estado | Qué ve |
|---|---|
| Cargando | El cargando del kit, sin copy nuevo |
| 403 | «No tiene permiso para ver los viajes.» Sin Reintentar. No se muestra el `{ error: 'Sin permisos' }` del API |
| Otro fallo (red, 400, 500) | «No se pudieron cargar los viajes. Inténtelo de nuevo.» + Reintentar. Nunca el error crudo |
| 200, `viajes` vacío y ningún filtro | «Aún no hay viajes. Regístrelos en Viajes: cuando queden registrados, aparecen aquí.» Sin botón |
| 200, `viajes` vacío y algún filtro (placa, estado, destino o compañía) | «Ningún viaje coincide con estos filtros. Pruebe otra placa o quite un filtro.» + Limpiar filtros (borra los cuatro y vuelve a pedir) |
| 200 con filas | La tabla |

`truncado` no se pinta.

## Modelo de datos

Sin DDL. `flito_logistica_traslados` ya tiene `compania_id`, `destino` (`flit` \| `cliente`), `estado` (los cinco), `registrado_en`. `flito_logistica_traslado_lts` ya cuenta las LT. La placa ya está en `vehicles.plate`. El índice `(compania_id, estado)` se queda como está; no se crea índice por `registrado_en`. El tope corta la lectura.

## Archivos a crear/modificar

Crear:

- `apps/api/src/modules/flito-logistica/flito-logistica.entregas.ts` — `listarEntregas` y `TOPE_ENTREGAS`. No meterlo en `flito-logistica.consulta.ts` (ya pasa de 500 líneas con la línea de tiempo).
- `apps/api/__tests__/services/flito-logistica.entregas.test.ts` — test P1. Este archivo, no el glob del módulo.
- `apps/web/src/components/flito/logistica/TabEntregas.tsx`
- `apps/web/e2e/tests/flito-logistica-entregas.spec.ts`

Modificar:

- `apps/api/src/modules/flito-logistica/flito-logistica.routes.ts` — el POST.
- `apps/api/src/modules/flito-logistica/flito-logistica.service.ts` — `export * from './flito-logistica.entregas.js'`.
- `apps/api/src/modules/permisos/catalogo-operaciones.ts` — una línea `op`, mismo código y mismo texto.
- `apps/api/src/modules/permisos/inventario.generado.ts` — una guarda, roles `["admin","auditor"]`.
- `apps/api/__tests__/services/frontera-enlace.centinela.test.ts` — tupla `['POST /api/flito/logistica/traslados/buscar', 'soloSinEnlace']` en el mismo orden en que `rutasAbiertas()` enumera el fichero. La #14124 se olvidó este centinela y el CI falló.
- `apps/api/__tests__/services/permisos.reconduccion-cierre.test.ts` — `GUARDAS_MEDIDAS` y `montajes` pasan de 662 a 663 (los dos `expect`).
- `packages/shared-types/src/flito-logistica.ts` — tipos y etiquetas.
- `apps/web/src/pages/FlitoLogistica.tsx` — la entrada de pestaña.
- `apps/web/src/content/ayuda/flito_logistica.md` — la ficha: hay pestaña nueva. El hilo carga `flit-ayuda-flito` antes del PR.

No se tocan: `schema.ts`, `src/db/migrations/`, `App.tsx` (la ruta ya existe), Mi ruta, Actas, `ViajesACliente`, el árbol de acciones.

## ADR: no aplica

No hay tabla, contrato de módulo ni precedente nuevo. La placa en body y `soloSinEnlace` antes de la función ya están en el módulo.

## Notas operativas

Backend:

- P1: `npm test -w apps/api -- __tests__/services/flito-logistica.entregas.test.ts`.
- El test cubre: enlace → 403 `{ error: 'Sin permisos' }` sin leer viajes (aunque el body traiga una placa que existe); interno sin la función → el mismo 403; orden `registrado_en DESC`; filtro de placa por igualdad normalizada y la respuesta sin placa; viaje con varias LT que no se duplica y `cantidadLt` igual al número de líneas; filtros de estado, destino y compañía; `companias` lista compañías con viaje y no cambia al filtrar; `legado` entra; no filtra por mensajero; tope 200 con `truncado`.
- Los dos centinelas van en el mismo cambio que la ruta. Si la ruta lleva `soloSinEnlace` y `exigirFuncion` y el centinela no, el CI falla.

Frontend:

- `api.post` de `src/lib/api.ts`. Sin `fetch` suelto y sin query.
- `npm run build -w packages/shared-types` y `typecheck` de `apps/web`. E2E del spec de esta pestaña si el entorno está arriba.
- La ficha de ayuda es delta de comportamiento visible, no un copy de más.

## Qué no entra

Línea de tiempo en la UI (HU #14126). Detalle de viaje. Acciones de acta (ver, firmar, despachar, devolver). Mi ruta. Mensajero, precio, placa, cédula, dirección o firma en la fila. Clic, modal, paginador. Botón Buscar. Migración. Función nueva. Cambiar la descripción de una operación ya sembrada.

## HANDOFF

```
HANDOFF
  Modo: slim
  Resultado: OK
  Decisión recomendada: pestaña Entregas en /flito/logistica; POST /api/flito/logistica/traslados/buscar con logistica.consola.ver (ya sembrada, reparto admin+auditor); soloSinEnlace antes de exigirFuncion
  ADR: no aplica
  Archivos: docs/diseno/hu-14125-entregas.md; flito-logistica.entregas.ts; flito-logistica.routes.ts; flito-logistica.service.ts; catalogo-operaciones.ts; inventario.generado.ts; frontera-enlace.centinela.test.ts; permisos.reconduccion-cierre.test.ts; flito-logistica.entregas.test.ts; packages/shared-types/src/flito-logistica.ts; TabEntregas.tsx; FlitoLogistica.tsx; flito-logistica-entregas.spec.ts; content/ayuda/flito_logistica.md
  Siguiente: backend-agent y frontend-agent
  Pendiente humano: ninguno (mockup «pasa» el 2026-10-29). Flujo local: no merge
  Migración: no
  Función: logistica.consola.ver
  Endpoint: POST /api/flito/logistica/traslados/buscar
  Reconocimiento: 61
```
