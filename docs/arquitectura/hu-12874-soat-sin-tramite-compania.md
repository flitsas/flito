# Diseño slim — HU #12874 · SOAT sin trámite con compañía fija (enlace) o escogida (sin enlace)

Feature #12871 · Épica #13411 · Módulo **`flito-soat`** (FLITO, `/api/flito/soat`), no el legacy `soat`.
Base: rama apilada sobre #13452 (`85757c70`, contiene #12875 y #13426). Estado: **Propuesto**.

## Hallazgos del código (respuesta a las preguntas del hilo)

1. **El alta NO acepta compañía elegida.** `POST /flito/soat/cliente` (`flito-soat-cliente.routes.ts`,
   `altaCliente`) no tiene `companiaId` en `altaSchema`; la compañía sale **siempre** de
   `contextoSoat()` → `ctx.companiaId`, que solo es no nulo con enlace `compania`
   (`flito-soat.service.ts`, `contextoSoat`). La guarda es `canalDeLaCompania(ctx)`
   (`flito-soat-cliente.service.ts`): sin `ctx.companiaId` → 403 `SIN_COMPANIA`; flag apagado → 403
   `CANAL_DESACTIVADO`. **La misma guarda la llaman tres flujos, no uno:** `preconsulta()` (RUNT por
   VIN), `crearSolicitud()` (alta) y `leerFacturaVenta()` (OCR de la factura). Un usuario sin enlace
   hoy recibe 403 en los tres pasos del formulario. **Esta HU necesita backend.**
   Lo bueno: aguas abajo todo consume `canal.companiaId` (RN-01, tenencia del vehículo, destino,
   carpeta de storage, aparcar incompleta), así que el cambio queda **localizado en la guarda**.
2. **No hay endpoint utilizable para el selector.** El único listado con el flag es
   `GET /flito/parametrizacion/companias` (`parametrizacion.companias.listar`, devuelve `document`
   = NIT y otras banderas; desde #12875 cerrado a enlaces). Reutilizarlo obligaría a conceder una
   función de parametrización a quien solo radica y expondría el NIT. → **endpoint nuevo mínimo en
   el módulo SOAT**.
3. **`puedeSolicitarSoat`** (`auth.routes.ts`) exige hoy `tipoEnlace === 'compania'`. Tiene que
   aceptar también `tipoEnlace === 'ninguno'` (ver contrato).
4. Tamaños (ESLint `max-lines`, sin blancos ni comentarios): `FlitoSoatSolicitud.tsx` **753/800**,
   `flito-soat-cliente.routes.ts` 258, `flito-soat-cliente.service.ts` 589, `auth.routes.ts` 143.
   El selector con sus 4 estados **no cabe** en `FlitoSoatSolicitud.tsx`: va en componente aparte.

## Patrón reutilizado

- Guarda de canal: `canalDeLaCompania` en `apps/api/src/modules/flito-soat/flito-soat-cliente.service.ts`
  (se extiende con un parámetro; no se crea otra).
- Alcance por enlace: `contextoSoat()` / `ctx.alcance` (`'todo'` = sin enlace) de
  `apps/api/src/modules/flito-soat/flito-soat.service.ts` — mismo criterio que ya usan cola,
  detalle e incompletas. **No** `soloSinEnlace()`: su propio docblock dice que ninguna ruta SOAT lo
  usa porque todas acotan por `contextoSoat`, y aquí el enlace `compania` también entra.
- Ruta: `router.post('/cliente…', exigirFuncion('soat.solicitud.crear'), soatClienteLimiter, …)` del
  mismo archivo de rutas.
- Capacidad de UI: `puedeSolicitarSoat` en `/me` y en el sobre de `POST /login` (Bug #11937).

## Contrato delta

```
GET /api/flito/soat/cliente/companias          exigirFuncion('soat.solicitud.crear')  (sin query, sin PII en URL)
  alcance 'compania' → 200 { fija: true,  companias: [{ id, nombre }] }   // solo la suya, si su flag está ON
  alcance 'todo'     → 200 { fija: false, companias: [{ id, nombre }, …] } // clients.soat_sin_tramite = true, ORDER BY nombre
  alcance 'proveedor' | 'nada', o enlace compania con flag OFF → 403 { codigo: CANAL_DESACTIVADO | SIN_COMPANIA }
  DTO = solo id + nombre (nunca document/NIT ni banderas).

POST /cliente/preconsulta · POST /cliente/factura/lectura · POST /cliente (multipart)
  + campo opcional companiaId: z.coerce.number().int().positive()
  Resolución en canalDeLaCompania(ctx, companiaIdPedida):
    'compania' → usa ctx.companiaId; si viene companiaId ≠ ctx.companiaId → 403 COMPANIA_NO_PERMITIDA
    'todo'     → companiaId obligatorio, si falta → 400 COMPANIA_REQUERIDA (AC3, defensa en servidor);
                 flag de esa compañía OFF o inexistente → 403 CANAL_DESACTIVADO (mismo desenlace, sin oráculo)
    otro       → 403 SIN_COMPANIA (supuesto: proveedor y organismos no radican)
  Respuestas 201/202 sin cambios.

/me y POST /login: puedeSolicitarSoat =
  funciones ∋ 'soat.solicitud.crear' ∧ ( (enlace=compania ∧ flag de su compañía)
                                        ∨ (enlace=ninguno ∧ ∃ compañía con soat_sin_tramite) )
```

## Archivos a crear/modificar

**Backend (`apps/api`)**
- `src/modules/flito-soat/flito-soat-cliente.service.ts` — `canalDeLaCompania(ctx, companiaIdPedida?)`
  con la tabla de arriba; propagar el parámetro en `preconsulta`, `crearSolicitud`,
  `leerFacturaVenta`; nueva `companiasDelCanal(ctx)`; mensajes del 403 neutros («La compañía no
  tiene habilitada…», hoy dicen «Tu compañía»); entradas nuevas en el `Record` de códigos
  (`[CodigoErrorSolicitudSoat.CANAL_DESACTIVADO]: false` y vecinos) — es exhaustivo y no compila
  sin ellas.
- `src/modules/flito-soat/flito-soat-cliente.routes.ts` — `companiaId` en `preconsultaSchema`,
  `lecturaFacturaSchema`, `altaSchema`; ruta `GET /cliente/companias`; el `audit()` del alta añade
  `compania=<id>` al `detail` (id opaco, no PII) para reconstruir quién radicó a nombre de quién.
- `src/modules/auth/auth.routes.ts` — `puedeSolicitarSoat` con la rama `ninguno`.
- Tests (P1): los archivos de `__tests__` que ya cubren `puedeSolicitarSoat` (/me) y el alta/
  preconsulta del canal Cliente, más uno nuevo para `GET /cliente/companias`. Casos mínimos: sin
  enlace + compañía con canal → 201; sin enlace sin `companiaId` → 400; sin enlace + compañía con
  flag OFF → 403; enlace compañía con `companiaId` ajeno → 403; proveedor → 403; DTO sin `document`.

**shared-types (`packages/shared-types`)**
- Donde vive `CodigoErrorSolicitudSoat`: códigos `COMPANIA_REQUERIDA`, `COMPANIA_NO_PERMITIDA`.
- Tipo `CompaniasCanalSoat = { fija: boolean; companias: { id: number; nombre: string }[] }`.
- Regla 7: `grep` de `CodigoErrorSolicitudSoat` en `apps/web` (mapas de copy exhaustivos).

**Frontend (`apps/web`)**
- Nuevo `src/components/flit/soat/CampoCompaniaSoat.tsx` (o junto a los componentes del formulario
  si ya existe carpeta propia — el frontend-agent elige el vecino): carga `GET
  /flito/soat/cliente/companias` vía `src/lib/api.ts`; 4 estados (cargando, error con
  **Reintentar**, vacío «Ninguna compañía tiene habilitado el canal», lleno); `fija: true` → campo
  de solo lectura con el nombre (AC1); `fija: false` → `<select>` con `<label>` asociado (AC2);
  aviso junto al campo y botón Radicar deshabilitado sin selección (AC3).
- `src/pages/FlitoSoatSolicitud.tsx` — monta el campo arriba del flujo; envía `companiaId` en
  preconsulta, lectura de factura y alta **solo si `fija === false`**; cambiar de compañía con
  datos ya consultados reinicia la preconsulta (RN-01 y tenencia son por compañía).
- `src/pages/FlitoSoat.tsx` / `src/lib/auth.tsx` — sin cambio de lógica: siguen leyendo
  `puedeSolicitarSoat` (AC4, AC5 los resuelve el servidor).
- E2E: spec de la HU; si el fixture `loginAs` necesita `soat.solicitud.crear` para un rol sin
  enlace, añadirlo a `FUNCIONES_POR_ROL`.

**Sin migración**: `clients.soat_sin_tramite` ya existe; la función `soat.solicitud.crear` ya existe.
Sin `db-review-agent`.

## ADR: no aplica

Extiende la guarda y el alcance por enlace ya decididos (#12875 / ADR de la frontera por enlace);
no introduce tabla, módulo ni dependencia.

## Partición backend + frontend

Hace falta backend (≈3 archivos de prod + shared-types). Recomendación: **misma HU #12874,
dos agentes en secuencia** (`backend-agent` → `frontend-agent`), porque P9 corta por ítems del
pedido y no por capas, y el backend no tiene valor solo. Alternativa: HU BACKEND hermana bajo el
Feature #12871 si el PO quiere mantener la etiqueta [FRONTEND] pura. **Decisión del hilo/PO.**
`security-agent` **aplica** (ruta nueva + cambio de autorización del alta).

## Riesgos de seguridad

- **Radicar a nombre de cualquier compañía con canal.** Hoy un usuario sin enlace ya tiene alcance
  `todo` en SOAT (ve y opera todas las solicitudes); radicar no le abre datos nuevos. El control
  real es quién recibe `soat.solicitud.crear` en un rol sin enlace (permisos configurables).
  Mitigaciones del diseño: servidor revalida el flag en cada petición; `companiaId` ajeno de un
  enlace compañía → 403 (no se ignora en silencio, así un intento de manipulación queda visible);
  `audit` con `compania=<id>`; RN-B1 (factura obligatoria) y rate limit sin cambios.
- **RUNT por VIN para usuarios internos:** `preconsulta` ya escribe `pii_access_log`; no cambia.
- **Oráculo de existencia:** compañía inexistente y flag OFF responden igual (se conserva).
- Un usuario sin enlace también necesita `soat.runt.preconsultar` y `soat.factura.leer` para
  completar el formulario: es configuración del rol, no código — verificar en DEV.

## Preguntas para el PO

1. **¿Función específica para radicar «por cuenta de» una compañía?** Recomendación: **no**; reusar
   `soat.solicitud.crear` (permisos dominan sobre roles: concederla a un rol sin enlace *es* la
   decisión). Si el PO quiere separarlo, sería `soat.solicitud.crear_por_compania` + migración de
   siembra.
2. **Sin enlace y ninguna compañía con el canal:** ¿se oculta la acción o se muestra con el selector
   vacío? Recomendación: **ocultar** (es lo que da la regla `∃ compañía` en `puedeSolicitarSoat`,
   coherente con AC5).
3. **¿Se registra quién radicó en nombre de la compañía** (visible para la compañía en el detalle)?
   Recomendación: solo en Bitácora (`audit`) en esta HU; mostrarlo al cliente sería otra HU.
4. Supuesto confirmado en diseño: enlaces `proveedor` y `organismos_transito` no ven la acción
   (403 en servidor). Confirmar.
