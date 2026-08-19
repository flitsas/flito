# UX — FLITO · Visor de comparendos monitoreados (Feature #11495, 17b)

> Gate previo obligatorio a las HU FRONTEND de 17b. Hoy **no existe una sola línea del módulo en
> `apps/web`**: esta pantalla se crea desde cero, así que aquí no hay «lo que ya había» que respetar,
> sino un lenguaje visual —el de `components/flit/`— que hay que replicar sin inventar nada.
>
> El servidor MCP `user-stitch` no está disponible en esta sesión: **los wireframes ASCII de este
> documento son la entrega**, no el borrador de algo visual que venga después.
>
> Segunda especificación de `docs/ux/`; sigue el formato de
> `docs/ux/finanzas-envio-facturacion-electronica.md`.

---

## Contexto y roles

El backend de 17a (Feature #11492) ya está entregado y montado en `/api/flito/comparendos`, con
`authMiddleware` + `requireRole('admin')` **a nivel de router** (`flito-comparendos.routes.ts:69-70`).
Eso no es un detalle de implementación: es lo que fija toda la matriz de permisos de esta pantalla
antes de que nadie diseñe nada.

| Rol de `USER_ROLES` | ¿Ve la página? | Por qué |
|---|---|---|
| `admin` | **Sí, y es el único** | En FLITO el operador ES el admin: el rol `operaciones` se fusionó en `admin` (CF-12, `permissions.ts:25`). `ROLE_DEFAULT_PAGES.admin = Object.keys(PAGES)`, así que basta con dar de alta el slug |
| `auditor` | **No** | Es el único caso que hay que argumentar, porque `auditor` sí entra a casi todo FLITO en lectura. Aquí no: el router entero exige `admin`. Darle la página sin darle el API sería regalarle una pantalla que responde 403 en cada petición |
| resto (`financiera`, `proveedor`, `gestor_impuestos`, `transito`, `compliance`, `lider_pesv`, `supervisor_flota`, `conductor`, `mensajero`) | No | Ni el slug ni el rol. `ProtectedRoute page="flito_comparendos"` los manda a `NoAccess` |

**Consecuencia de diseño, y es la más importante del documento: esta pantalla no tiene modo lectura.**
No hay ningún control que haya que ocultar por rol, ningún botón que se pinte inhabilitado «porque
usted es auditor», ninguna rama `puedeEditar`. Quien entra, puede todo lo que la pantalla ofrece.
Cualquier condicional por rol dentro de estos componentes sería código muerto que un día miente.

### El slug no existe: es el primer requerimiento

`flito_comparendos` **no está en `PAGES`** (`packages/shared-types/src/permissions.ts:58-117`). Hace
falta añadirlo, y con él tres cosas más:

```
PAGES.flito_comparendos = 'FLITO — Comparendos'
PAGE_GROUPS → grupo «FLITO (SOAT e Impuestos)»: añadir 'flito_comparendos'
NAV_ITEMS   → { page: 'flito_comparendos', to: '/flito/comparendos', section: 'gestion',
                label: 'Comparendos',
                keywords: 'comparendo simit multa infraccion placa nit transito monitoreo' }
App.tsx     → <Route path="/flito/comparendos"
                element={<ProtectedRoute page="flito_comparendos"><Lazy><FlitoComparendos/></Lazy></ProtectedRoute>} />
```

- **`ROLE_DEFAULT_PAGES` no se toca en ninguna fila.** `admin` obtiene el slug solo por ser admin;
  añadírselo a `auditor` —el reflejo, porque ahí están todas las vistas FLITO— sería justo el error
  que el backend ya cerró.
- **`roles: ['admin']` en el `NavItem` sobra.** Ese campo existe para restringir *dentro* de quienes
  ya tienen el slug (`soat`, `flito_impuestos`); aquí el slug ya es exclusivo de `admin` y añadirlo
  duplicaría la regla en dos sitios que pueden divergir.
- Tocar `shared-types` activa la **regla 7 de `AGENTS.md`**: `grep` de usos en `apps/web` antes de
  darlo por aditivo. Lo es —una clave nueva en `PAGES`—, pero el `grep` se hace y se pega.

---

## Lo que existe, lo que hay que pedir

### Endpoints que esta pantalla consume (todos verificados en el router de 17a)

| Qué | Endpoint | Estado | Notas que condicionan el diseño |
|---|---|---|---|
| Lista sin filtros de identidad | `GET /flito/comparendos/registros` | **Existe** | Query: `estado`, `q`, `limit`, `cursor`. `.strict()`: `?nit=` es un **400**, no una consulta que funciona |
| Lista con NIT o placa | `POST /flito/comparendos/registros/buscar` | **Existe** | Misma forma de respuesta. `nit`/`placa` en el **cuerpo**, coincidencia **exacta** sobre el valor normalizado. La paginación sigue en la query |
| Detalle + timeline | `GET /flito/comparendos/registros/:id` | **Existe** | Devuelve `ComparendoRegistroDetalle` = registro + `eventos[]` |
| Catálogo de municipios | `GET /flito/comparendos/municipios` | **Existe** | Imprescindible: el registro trae `municipioFuente` = `codigoFuente` («ITAGUI»), no el nombre |
| Catálogo de causales | `GET /flito/comparendos/causales` | **Existe** | Trae `orden`, que es el orden del selector |
| Catálogo de NITs (alias) | `GET /flito/comparendos/nits` | **Existe** | Opcional recomendado: convierte «900123456» en «900123456 · Transportes X» |
| Gestión | `PATCH /flito/comparendos/registros/:id/gestion` | **Lo crea la HU #11557** | Bloquea la Pantalla 3 |
| Export xlsx | `POST /flito/comparendos/registros/export` | **Lo crea la HU #11558** | Filtros en el cuerpo, tope 5.000 filas (422 `export_demasiado_grande`), 5 peticiones/minuto (429) |
| Timeline suelto | `GET /flito/comparendos/registros/:id/eventos` | Existe | **No se usa**: `GET /registros/:id` ya devuelve `eventos[]` y pedirlo aparte sería una segunda petición por cada detalle abierto para el mismo dato |

### Requerimientos nuevos para architecture-agent / backend-agent

**1. `PageSlug flito_comparendos`** en `packages/shared-types/src/permissions.ts` (arriba). Sin él la
página no se puede registrar en `App.tsx` con guarda de permiso, y la **regla 10** lo exige.

**2. Contratos de 17b en `packages/shared-types/src/flito-comparendos.ts`.** El archivo declara hoy,
por escrito y a propósito, que el slug, el export y el PATCH de gestión son de 17b y no se publican
antes de tiempo (líneas 5-8). Ahora toca publicarlos, y la pantalla necesita exactamente esto:

```ts
/** Cuerpo del PATCH de gestión. Los dos campos son opcionales, pero no puede venir vacío. */
export interface ComparendosGestionRequest {
  causalId?: string | null;   // null = quitar la causal
  observacion?: string | null;
}
/** Cuerpo del export: los MISMOS filtros de la vista, sin `cursor` ni `limit`. */
export interface ComparendosExportRequest {
  estado?: ComparendosRegistroEstado;
  q?: string;
  nit?: string;
  placa?: string;
}
export const COMPARENDOS_EXPORT_MAX_FILAS = 5000;
export const COMPARENDOS_OBSERVACION_MAX = /* el tope real de la columna */;
export type ComparendosEventoTipo = 'primera_llegada' | 'inactivacion' | 'reaparicion' | 'gestion';
```

> **Nota de la HU [#11557](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11557)
> (2026-08-19) — lo publicado, con sus nombres reales.** El PATCH de gestión ya existe y
> `packages/shared-types` exporta **`ComparendosGestionPatch`** (no `ComparendosGestionRequest`: el
> nombre del work item y del diseño del Feature es este) y **`COMPARENDOS_OBSERVACION_MAX = 1000`**.
> El tope **no sale de la columna** —`observacion` es `TEXT` y no tiene ninguno—: es un límite de
> producto, y esa constante es dónde vive. El esquema `zod` del endpoint la importa, así que el
> contador del formulario y el servidor no pueden discrepar.
>
> Dos cosas que este documento da por hechas y conviene fijar por escrito: el cuerpo **no puede venir
> vacío** (un `{}` es 400, no un 200 que dejaría un evento de un cambio que no ocurrió) y una
> observación que al recortar queda en blanco se guarda como `NULL`, no como cadena vacía. La
> respuesta es el **registro completo con su `eventos[]`** —la misma forma de `GET /registros/:id`—,
> así que el panel se refresca sin una segunda petición, tal como pide «Al guardar bien».
>
> El evento `gestion` del timeline publica `detalle.motivo` (`gestion_registrada` o
> `gestion_retirada`) y **nada más**: la lista blanca de RN-35 sigue siendo `origen` y `motivo`, así
> que la columna «Detalle que se pinta» del cuadro de los cuatro tipos no puede decir «la causal que
> se puso» leyéndola del evento — la causal actual se lee de la fila (`causalId`), que es lo que la
> opción A ya especifica. Publicar la causal del evento sería ampliar esa lista blanca: decisión de
> la HU de frontend que la necesite, no efecto colateral de que la columna sea JSONB.
>
> **Resuelto en la HU #11562 (2026-08-19): NO se amplía.** La HU de frontend que la habría
> necesitado es esta, y decidió que la lista blanca se queda en `origen` y `motivo`. Dos razones y
> ninguna es de esfuerzo: el `actorId` es el identificador de una persona identificable y el
> timeline suelto está exento de `pii_access_log` y de `Cache-Control: no-store` **por no llevar
> datos personales** —publicarlo obligaría a cambiar las dos cosas—; y la causal por evento no añade
> nada que la pantalla no tenga ya, porque la asignada está en la fila y el cambio queda dicho por
> la propia etiqueta del evento. El wireframe del historial, que las dibujaba, se corrigió.

- **`COMPARENDOS_OBSERVACION_MAX` no es opcional para el diseño.** Sin él, el contador de caracteres
  del formulario de gestión sería un número inventado y el usuario descubriría el tope real en un 400
  después de escribir. Vale el mismo argumento que ya sostiene a `COMPARENDOS_REGISTROS_LIMIT_MAX`
  («vive aquí para que la pantalla no lo adivine ni pida 200 y reciba un 400»).
- **`'gestion'` en `ComparendosEventoTipo`** lo añade la HU #11556. Hasta entonces el timeline pinta
  tres tipos; el cuarto entra sin tocar el componente **si y solo si** el mapa de etiquetas es un
  `Record<ComparendosEventoTipo, …>`: así, añadir el tipo **no compila** hasta que alguien le escriba
  su texto. Ese es el mecanismo, no la disciplina.

**3. Fecha y autor de la última gestión — la columna que el enunciado pide y el contrato no puede
servir.** `ComparendoRegistro` trae `causalId` y `observacion`, pero **no** cuándo se gestionó ni
quién. `actualizadoEn` no sirve: lo mueve también el sync, así que una fila tocada anoche por una
corrida diría «gestionada anoche» siendo mentira. Dos salidas:

| Opción | Qué implica | Veredicto |
|---|---|---|
| **A — sin fecha en la lista** | La columna «Gestión» muestra la causal o «Sin gestión»; el **cuándo** y el **quién** viven en el detalle, en el evento `gestion` del timeline (HU #11556) | **Es lo que especifica este documento.** No necesita nada nuevo y no muestra ningún dato que no exista |
| B — `gestionActualizadaEn` / `gestionActualizadaPor` en `ComparendoRegistro` | La lista podría ordenar y filtrar por gestión reciente | **Requerimiento para architecture/backend en la HU #11557**, si producto lo quiere. **No** se diseña contra ello hoy |

> **Nota de la HU [#11556](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11556)
> (2026-08-18) — corrección de referencia cruzada, no un rediseño.** La **opción B se adelantó una
> HU**: `gestionActualizadaEn` y `gestionActualizadaPor` ya existen en `ComparendoRegistro` y en el
> esquema desde la #11556, no desde la #11557, y llegan en `null` mientras nadie haya gestionado.
> **Esta pantalla sigue especificada contra la opción A** y no cambia nada de lo escrito aquí: que el
> dato exista en el contrato no obliga a pintarlo. La pregunta 13 al PO —¿la lista necesita el
> «cuándo»?— **sigue abierta**, y si la respuesta fuera que sí, *ordenar* por gestión exigiría un
> índice parcial y un cursor distinto del de RN-32: otra HU, no un ajuste de esta.

**4. `municipioFuente` es `null` cuando el comparendo solo lo reportó SIMIT** (comentario del
contrato, línea 228). No es un dato faltante: es información. La celda dice «—» y el detalle lo
explica; no se rellena con el municipio del organismo ni con nada deducido.

### Lo que esta pantalla NO muestra, y por qué queda escrito

- **Fecha de notificación.** No existe en el esquema y depende del spike #11501. No se pinta, no se
  deja la columna vacía «para cuando llegue» y no se aproxima con `fechaComparendo`. Si el spike la
  trae, es una columna nueva con su HU.
- **`payload_simit` / `payload_municipal`.** No salen por el API (contrato, líneas 206-210). No hay
  «ver respuesta cruda» en el detalle.
- **Cualquier dato del infractor** (nombre, cédula, dirección). No está en el esquema y no se pide.
  `nitMonitoreado` es «el NIT con el que se PREGUNTÓ, no el del infractor» y el copy de la pantalla
  tiene que decirlo, porque la confusión es natural y cambia lo que alguien concluye de la tabla.

---

## Las cinco reglas duras y qué le hacen a la interfaz

**1. Paginación por cursor opaco, no por offset.** `COMPARENDOS_REGISTROS_LIMIT_MAX = 50` es tope
**y** valor por defecto; `nextCursor: null` significa que no hay más. Consecuencias:

- **No hay total, así que no hay «página 3 de 47».** `Paginacion.tsx` exige `total` y `totalPaginas`
  y no se puede reutilizar (ver «Decisiones», descarte 1).
- El cursor **se manda tal cual llegó**: no se construye, no se decodifica, no se recorta. Es
  base64url de `<createdAt>|<uuid>` y el módulo responde 400 `cursor_invalido` a cualquier otra cosa.
- **Cambiar cualquier filtro descarta el cursor y la pila de cursores.** Un cursor apunta a una
  posición dentro de un orden que el filtro acaba de cambiar; conservarlo devolvería una página que
  no es «la siguiente» de nada.
- No se pide `limit`: ausente = 50, que es lo que la tabla quiere. Mandarlo sería repetir en la
  pantalla un número que ya vive en shared-types.

**2. Ni NIT ni placa en la URL — nunca** (`AGENTS.md` §14). Esto no es solo «usar el POST»:

- Los filtros de identidad viven en **estado de React**, no en `useSearchParams`.
- No hay ruta `/flito/comparendos?nit=…`, ni `/flito/comparendos/nit/900123456`.
- El export es `POST` con el cuerpo y descarga por blob (`api.downloadPost`): **nada de
  `<a href="/api/…/export?nit=…" download>`**, que dejaría el NIT en el historial y en el `Referer`.
- El `:id` del detalle sí es un UUID opaco, y el §14 lo admite explícitamente. Aun así el detalle no
  tiene ruta propia (ver «Decisiones», descarte 3).

**3. Los campos de fuente son inmutables (RN-04).** Todo lo que está por encima de `estado` en
`ComparendoRegistro` lo escribe el sync y **no hay endpoint que lo edite**. En la interfaz eso
significa: se presentan en un `<dl>`, no en `<input readOnly>` ni en `<input disabled>`. Un campo
deshabilitado sigue pareciendo un campo y sigue invitando a intentarlo; una lista de definición dice
«esto es un dato», que es la verdad. **Lo único gestionable es `causalId` y `observacion`.**

**4. `monto` es una cadena decimal** (`numeric(14,2)`). Se formatea para mostrar con
`Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 })` sobre
`Number(monto)`, **y no se acumula**: la tabla **no lleva fila de totales** ni «suma de la página».
Sumar 50 cadenas decimales en `double` es exactamente cómo un importe pierde el último centavo, y un
total de página tampoco significa nada (es el total de 50 filas arbitrarias, no de la cartera).
Quien necesite sumar, exporta.

**5. `estado` y `estadoFuente` no son lo mismo, y la pantalla tiene que impedir que se confundan.**

| | `estado` | `estadoFuente` |
|---|---|---|
| Qué es | Estado de **monitoreo**: `activo` / `inactivo` | Lo que dice el **proveedor**, texto libre |
| Qué significa `inactivo` | «Las fuentes dejaron de reportarlo con cobertura completa» (CF-10) | — |
| Qué **no** significa | **Ni pagado ni resuelto** | — |
| En la interfaz | `StatusChip` + tooltip de columna + copy explícito | Texto plano en el **detalle**, sin chip y sin color |

**No se le asigna tono cromático a `estadoFuente` bajo ningún concepto.** No está enumerado; cualquier
mapa de colores sería una lista de valores observados un martes, y el proveedor que mañana escriba
«PAGADO PARCIAL» caería en el color de «PAGADO».

---

## Flujo de usuario

### Operador FLITO (`admin`) — el único rol con la página

```mermaid
flowchart TD
  A[Menú Gestión → Comparendos] --> B[GET /registros sin filtros, 50 filas]
  B --> B1[Carga en paralelo de catálogos:<br/>municipios, causales, NITs]
  B -- cargando --> C1[Filas fantasma + aria-busy]
  B -- falla --> C2["Banda de error + Reintentar<br/>los filtros siguen usables"]
  C2 -->|Reintentar| B
  B -- 0 filas y sin filtros --> C3["Vacío A: todavía no hay datos"]
  B -- 0 filas con filtros --> C4["Vacío B: el filtro no arroja nada<br/>+ Quitar los filtros"]
  C4 -->|Quitar los filtros| B
  B -- N filas --> D[Tabla llena]

  D --> E{¿Qué hace?}
  E -- filtra por estado --> F1[Pills: aplican al clic] --> B
  E -- busca por número --> F2["Campo q, mínimo 3 caracteres<br/>Enter o Buscar"] --> B
  E -- busca por NIT o placa --> F3["POST /registros/buscar<br/>los valores van en el CUERPO"] --> B
  E -- pagina --> F4{¿nextCursor?}
  F4 -- null --> F5[Siguiente inhabilitado] --> D
  F4 -- cursor --> F6[GET con cursor] --> D
  F6 -- 400 cursor_invalido --> F7["Aviso + Volver a la primera página"] --> B
  E -- exporta --> G[Ruta del export]
  E -- abre una fila --> H[Panel de detalle]

  H --> H1[GET /registros/:id]
  H1 -- cargando --> H2[Esqueleto dentro del panel]
  H1 -- falla --> H3["Error dentro del panel + Reintentar"]
  H3 -->|Reintentar| H1
  H1 -- 404 --> H4["Ya no existe + Cerrar y recargar la lista"]
  H1 -- ok --> H5["Ficha de fuente en solo lectura<br/>+ timeline<br/>+ bloque de gestión"]
  H5 --> I{¿Gestiona?}
  I -- no --> J[Cierra: el foco vuelve a la fila] --> D
  I -- sí --> K[Elige causal y escribe observación]
  K --> L{¿Cambió algo?}
  L -- no --> M[Guardar inhabilitado] --> K
  L -- sí --> N[PATCH /registros/:id/gestion]
  N -- en curso --> N1["Guardando…, botón inhabilitado"]
  N -- falla --> N2["Error sobre el formulario<br/>lo escrito NO se pierde"] --> K
  N -- 404 --> N3["El comparendo ya no está<br/>Cerrar y recargar"]
  N -- ok --> O["Aviso Gestión guardada<br/>+ la fila de la tabla se actualiza en sitio"] --> H5

  G --> G1[POST /registros/export con los filtros de la vista en el cuerpo]
  G1 -- en curso --> G2["Preparando el archivo…, botón aria-busy"]
  G1 -- 422 --> G3["Son demasiadas filas: afina los filtros"]
  G1 -- 429 --> G4["Espera un minuto"]
  G1 -- otro error --> G5["No se pudo generar el archivo + Reintentar"]
  G1 -- ok --> G6["Descarga por blob<br/>anuncio: Archivo descargado"] --> D
```

### Cualquier otro rol

```mermaid
flowchart TD
  A[Escribe /flito/comparendos] --> B{¿hasPage flito_comparendos?}
  B -- no --> C["NoAccess: la pantalla ni se monta"]
  B -- no --> D[El ítem del menú tampoco aparece:<br/>FlitSidebar y CommandPalette filtran por slug]
  E[[Llamada directa al API]] --> F["403 de requireRole('admin')<br/>en el router entero, no ruta a ruta"]
```

---

## Pantalla 1 — Visor de comparendos

Ruta `/flito/comparendos`. Es la pantalla ancla del módulo.

### Wireframe · vista completa

```
┌─ PageHeaderCard ───────────────────────────────────────────────────────────────────────┐
│ Comparendos monitoreados                                    [Exportar a Excel]         │
│ Lo que SIMIT y los municipios reportan de los NIT que se vigilan. Los datos vienen     │
│ de la fuente y no se editan aquí: lo único que se registra es la causal y la           │
│ observación de gestión.                                                                │
└────────────────────────────────────────────────────────────────────────────────────────┘

┌─ FlitCard · Filtros ───────────────────────────────────────────────────────────────────┐
│  ( Todos )( Activos )( Inactivos )        ← FlitPillGroup, aplican al clic             │
│                                                                                        │
│  N.º de comparendo        NIT monitoreado        Placa                                 │
│  [ 11001000123456…    ]   [ 900123456       ]    [ ABC123    ]   [Buscar] [Limpiar]   │
│  Desde 3 caracteres       Exacto, sin puntos     Exacta                                │
│                                                                                        │
│  ⓘ El NIT y la placa se buscan exactos y no viajan en la dirección del navegador.      │
└────────────────────────────────────────────────────────────────────────────────────────┘

┌─ FlitTable ────────────────────────────────────────────────────────────────────────────┐
│ N.º COMPARENDO │ PLACA  │ NIT MONITOREADO │ FECHA    │ INFRACCIÓN      │ MUNICIPIO │…  │
├────────────────┼────────┼─────────────────┼──────────┼─────────────────┼───────────┼───┤
│ 11001000123456 │ ABC123 │ 900123456       │ 12 jul   │ C29 · Estacionar│ Medellín  │…  │
│ ↑ botón que abre el detalle                          │ en zona prohib. │           │   │
│ 05001000998877 │ —      │ 900123456       │ 3 jul    │ D02 · Sin SOAT  │ —         │…  │
│ 76001000445566 │ XYZ987 │ 830009988       │ 28 jun   │ — · —           │ Cali      │…  │
└────────────────┴────────┴─────────────────┴──────────┴─────────────────┴───────────┴───┘
   …continúa a la derecha (mismo scroll horizontal de FlitTable):
   ┌───────────┬──────────┬──────────────┬─────────────┬────────────┬─────────────┐
   │   MONTO   │ ORIGEN   │   ESTADO     │  REGISTRADO │ INACTIVADO*│  GESTIÓN    │
   ├───────────┼──────────┼──────────────┼─────────────┼────────────┼─────────────┤
   │ $ 604.100 │ Ambos    │ ● Activo     │ 2 jul       │     —      │ Notificado  │
   │ $ 243.000 │ SIMIT    │ ● Activo     │ 1 jul       │     —      │ Sin gestión │
   │ $ 604.100 │ Municipal│ ○ Inactivo   │ 12 may      │  28 jun    │ Pagado      │
   └───────────┴──────────┴──────────────┴─────────────┴────────────┴─────────────┘
   * «Inactivado» solo se pinta con el filtro Inactivos puesto (ver «Columnas»).

┌─ PaginacionCursor ─────────────────────────────────────────────────────────────────────┐
│  50 comparendos en esta página · página 2            [← Anterior]  [Siguiente →]       │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### Columnas y prioridad visual

Son **quince** los datos que el enunciado pide colocar y una tabla no muestra quince columnas sin
convertirse en una hoja de cálculo ilegible. El criterio del reparto es uno solo: **arriba va lo que
sirve para reconocer la fila y decidir si se abre; abajo va lo que se lee cuando ya se abrió.**

| Nivel | Columna | Campo | Por qué ahí |
|---|---|---|---|
| **A · siempre** | N.º comparendo | `numeroComparendo` | Es la llave de negocio, única en el país (CF-07). Es además el **botón** que abre el detalle |
| **A** | Placa | `placa` | La primera pregunta operativa es «¿de qué vehículo?». `null` → «—» (hay comparendos sin placa) |
| **A** | NIT monitoreado | `nitMonitoreado` | Es el eje del módulo: de qué empresa vigilada salió esta consulta. Con alias del catálogo si lo hay |
| **A** | Fecha | `fechaComparendo` | Ordena la conversación con el organismo. `null` → «—»: hay fuentes que no la traen |
| **A** | Infracción | `codigoInfraccion` + `descripcionInfraccion` | Una sola columna: el código sin descripción no dice nada y la descripción sin código no se puede citar. Descripción a **una línea** con recorte |
| **A** | Municipio | `municipioFuente` → nombre | Decide quién gestiona. `null` = solo lo vio SIMIT |
| **A** | Monto | `monto` | Es el criterio de prioridad. Alineado a la derecha, cifras tabulares |
| **A** | Estado | `estado` | `StatusChip`. La distinción activo/inactivo cambia por completo cómo se lee la fila |
| **A** | Gestión | `causalId` → nombre de la causal | Responde «¿esto ya lo miró alguien?», que es la razón de abrir la pantalla |
| **B · colapsa por debajo de 1280 px** | Organismo | `organismo` | Contexto útil, rara vez decisivo: casi siempre se deduce del municipio |
| **B** | Origen | `origenMerge` | «SIMIT» / «Municipal» / «Ambos». Importa cuando algo no cuadra, no en la lectura normal |
| **B** | Registrado | `primeraVistoEn` | Antigüedad en el sistema. Se distingue de la fecha del comparendo y por eso no van juntas |
| **B · condicional** | Inactivado | `inactivadoEn` | **Solo se pinta con el filtro «Inactivos»**: en la vista de activos es una columna de guiones por definición (`null` mientras está activo) |
| **C · solo en el detalle** | Estado en la fuente | `estadoFuente` | Texto libre, no comparable entre filas: en columna es ruido y **sugeriría** que se puede filtrar por él |
| **C** | Observación | `observacion` | Texto largo. En una celda o se recorta hasta ser inútil o rompe el alto de la fila |
| **C** | Visto por última vez | `ultimoVistoEn` | Es «cuándo corrió el último sync que lo tocó», no un hecho del comparendo |
| **C** | Última corrida | `ultimoSyncRunId` | Puente al detalle de la corrida; identificador técnico |
| **C** | Visto en SIMIT / municipal | `vistoEnSimit`, `vistoEnMunicipal` | El desglose de `origenMerge`, que ya está en el nivel B |

**Cómo colapsa el nivel B:** con las utilidades que el repo ya usa (`hidden xl:table-cell` sobre `th`
y `td`), no con un menú de columnas configurable. Un selector de columnas es un patrón nuevo,
guarda estado por usuario y ninguna otra pantalla de FLITO lo tiene (regla 3).

**Lo que se oculta por ancho no se pierde: está entero en el detalle.** Esa es la condición para
poder ocultarlo.

**Recorte de la descripción de la infracción:** una línea con `line-clamp-1`. **El texto completo NO
se pone en un `title`**: un `title` no lo ve el teclado, no lo anuncia bien un lector de pantalla y
no existe en táctil. El texto completo vive en el detalle, que está a un clic y a un Enter.

### Estados (4)

Los cuatro se resuelven en este orden —**el error antes que el vacío**—: si la consulta falló no se
sabe si hay filas, y decir «no hay comparendos» sería afirmar algo que nadie comprobó.

#### 1 · Cargando

Dos cargas distintas y no se pintan igual:

- **Primera entrada a la página** (chunk lazy): `PageContentSkeleton`, que ya monta `<Lazy>` en
  `App.tsx`. No se toca.
- **Carga de la tabla** (primera consulta y cada cambio de filtro o de página): **ocho filas
  fantasma** dentro de `FlitTable`, con el mismo lenguaje de barras de `PageContentSkeleton`
  (`animate-pulse motion-reduce:animate-none`, `background: var(--flit-border-soft)`, radio 8). El
  contenedor lleva `role="status" aria-busy="true" aria-label="Cargando comparendos"`.

> **La barra de filtros nunca se desmonta ni se inhabilita mientras carga.** Quien acaba de escribir
> un filtro y ve que tarda, lo primero que hace es corregirlo; bloquear el campo en ese momento es
> quitarle el control justo cuando lo necesita. Lo que sí se hace es descartar la respuesta de la
> consulta anterior si llega tarde (una petición por vuelo, la última gana).

Filas fantasma y no un spinner centrado: el spinner obliga a la tabla a saltar de alto cuando llegan
los datos, y ocho filas de 50 ya insinúan la forma de lo que viene.

#### 2 · Error

Banda dentro de `FlitCard` con `role="alert"`, encima de la tabla, con la tabla anterior **borrada**
(mostrar datos viejos bajo un error es afirmar que siguen siendo válidos):

| Caso | Copy | Acción |
|---|---|---|
| Genérico (500, red, tiempo agotado) | «No se pudieron cargar los comparendos: `<mensaje del servidor>`.» — **⚠ en suspenso: ver el aviso al final de esta subsección** | `[Reintentar]` |
| **429** del limitador de lectura | «Se hicieron demasiadas consultas seguidas. Espera un minuto y vuelve a intentarlo. El módulo limita las consultas porque cada página trae datos personales.» | `[Reintentar]` |
| **400 `cursor_invalido`** | «El listado cambió mientras paginabas y esta página ya no existe. Vuelve al principio para ver los datos actuales.» | `[Volver a la primera página]` |
| **403** | «Tu usuario ya no tiene acceso a los comparendos. Habla con un administrador.» | Sin reintento |

- ~~`<mensaje del servidor>` sale de `errorMessage(e)`, que conserva el texto del backend.~~ **Ya no:
  la HU #11559 retiró el eco del backend. Ver el aviso al final de esta subsección.**
- **`cursor_invalido` es la excepción a esa regla y por eso está en la tabla.** El mensaje real del
  backend es «El cursor de paginación no es válido o pertenece a otra versión del listado. Pide la
  primera página sin `cursor`» — correcto para quien integra contra el API, incomprensible para quien
  solo estaba pasando de página. Se detecta por `codigo` (que `ApiError.rawDetails` conserva), **no**
  por el texto.
- El 429 **no oculta el botón de reintentar**: esconderlo obligaría a recargar la página entera, que
  es otra petición.

> **⚠ Aviso vigente para #11560, #11557 y #11558 — `<mensaje del servidor>` no se pinta hoy en
> ninguna pantalla del módulo, y no debe reinstalarse mientras esta decisión siga abierta.**
>
> - **Qué cambió.** La **HU #11559** (implementada) eliminó el eco del texto del backend: el copy de
>   error se **deriva del código de estado**. El motivo no fue una lista de huecos que tapar uno a
>   uno: `security-agent` demostró que el filtro que intentaba sanear ese texto en el cliente dejaba
>   pasar un NIT con separadores (`900.123.456-7`, que es como lo escriben SIMIT y los organismos),
>   una cédula con puntos, una placa, un host interno y una IP privada —y que el caso de test usaba
>   el NIT **sin** formato, el único que sí bloqueaba, así que el agujero estaba en verde—. Un filtro
>   por forma siempre va por detrás del siguiente formato.
> - **La decisión de producto/UX sigue abierta.** Está planteada al Líder Técnico y **no está
>   aprobada**: este documento no la da por cerrada en ningún sentido. Lo firme hasta que se cierre
>   es la conducta: **no pintar el mensaje del servidor**.
> - **Si algún día se quiere ese texto en pantalla, el camino no es un filtro en el cliente** —ya se
>   intentó y falló— **sino un contrato del servidor**: un campo aparte, garantizado libre de datos
>   del titular. Eso es un requerimiento para architecture-agent / backend-agent, no una tarea de
>   frontend.
> - **Copy en vigor**, tal como quedó en `FlitoComparendos.tsx` con la #11559: genérico «No se
>   pudieron cargar los comparendos. Vuelve a intentarlo; si sigue fallando, avisa a soporte.»; sin
>   respuesta (`ApiError.status === 0`) «No hubo respuesta del servidor al cargar los comparendos.
>   Revisa tu conexión y vuelve a intentarlo.». El 403, el 429 y el `cursor_invalido` no cambian: ya
>   eran copy propio derivado del estado o del `codigo`.

#### 3 · Vacío — dos casos que no dicen lo mismo

**Caso A · no hay datos todavía** (sin ningún filtro puesto y `items.length === 0`):

```
Todavía no hay comparendos registrados.

Los comparendos aparecen aquí después de una sincronización con SIMIT y con los
municipios configurados. Si acabas de dar de alta los NIT que se vigilan, todavía
no se ha consultado a ninguna fuente.
```

> **Sin botón de acción, y es deliberado.** Lo natural sería «Ir a la sincronización», pero **esa
> pantalla no existe todavía** en `apps/web`: un enlace a ninguna parte es peor que ninguno. Cuando
> la HU de la pantalla de sincronización aterrice, aquí se añade `[Ir a la sincronización]` y esa HU
> hereda esta línea como parte de su alcance.

**Caso B · el filtro no arroja resultados** (hay al menos un filtro puesto):

```
Ningún comparendo coincide con lo que buscaste.

Filtros puestos: estado «Activos» · placa «ABC123»

El NIT y la placa se buscan exactos: «ABC 123» y «ABC123» son la misma placa,
pero un NIT con dígito de verificación («900123456-1») no encuentra al mismo
NIT sin él. El número de comparendo sí busca por fragmento.

                                                        [Quitar los filtros]
```

- **Se repite qué filtros estaban puestos.** Es lo que convierte «no hay nada» en «no hay nada *de
  esto*», que es una conclusión muy distinta y la única accionable.
- La explicación de la búsqueda exacta **solo se pinta si había NIT o placa**. Con un filtro de
  estado o de número, esa frase sería ruido.
- `[Quitar los filtros]` limpia todo, vuelve a `estado = todos` y **descarta la pila de cursores**.

Los dos vacíos usan `FlitEmpty`, con el texto principal en `--flit-text-secondary` (no en
`--flit-text-muted`, que no llega a 4.5:1 y es el gris de los guiones, no el del texto que hay que
leer).

#### 4 · Lleno

Tabla + paginación. **El contador dice lo que sabe y nada más:**

```
50 comparendos en esta página · página 2      [← Anterior]  [Siguiente →]
```

- **No dice «de 1.284».** El API no devuelve total y no lo devuelve a propósito (`COUNT(*)` sobre la
  tabla completa en cada página es justo lo que la paginación por cursor evita). Inventar «página 2
  de muchas» o pedir un total que nadie sirve sería el peor de los dos mundos.
- `[Siguiente →]` inhabilitado cuando `nextCursor === null`. Con la primera página, `[← Anterior]`
  también.
- La última página no lleva ningún cartel de «fin de la lista»: los dos botones inhabilitados ya lo
  dicen y un cartel más sería ruido en cada consulta corta.

### Acciones y validaciones

| # | Acción | Precondición | Qué hace |
|---|---|---|---|
| A1 | Pills de estado | siempre | Aplica **al clic** (`estado = activo \| inactivo \| ausente`), resetea la paginación |
| A2 | Campo «N.º de comparendo» | ≥ 3 caracteres o vacío | Se aplica con **Enter o con `[Buscar]`**, nunca al teclear |
| A3 | Campo «NIT monitoreado» | ≥ 5 caracteres tras quitar puntos, solo dígitos con guion opcional | Idem. Fuerza la ruta `POST /registros/buscar` |
| A4 | Campo «Placa» | ≥ 3 caracteres, letras/dígitos/espacio/guion | Idem |
| A5 | `[Buscar]` | siempre | Lanza la consulta con los tres campos, descarta cursores |
| A6 | `[Limpiar]` | hay algún filtro | Vacía los tres campos y las pills, vuelve a `GET /registros` |
| A7 | Clic en el n.º de comparendo | siempre | Abre el panel de detalle (Pantalla 2) |
| A8 | `[← Anterior]` / `[Siguiente →]` | según la pila y `nextCursor` | Navega por cursor |
| A9 | `[Exportar a Excel]` | siempre; inhabilitado mientras se genera | POST del export (más abajo) |

**Por qué los tres campos de texto exigen un submit explícito y no un debounce**, que es lo que hace
`FlitoDerechos` con su campo de búsqueda:

1. **Cada consulta deja una fila en el registro de acceso PII** (`registrarAccesoComparendos`,
   Ley 1581 art. 17). Un debounce de 300 ms escribiendo «900123456» son tres o cuatro filas por
   búsqueda, y ese registro existe para poder responder «¿quién consultó los datos de este titular?».
   Llenarlo de teclas a medio escribir es degradar la única prueba que el módulo tiene.
2. **El limitador es de 60 por minuto.** Un teclado rápido con debounce se come la cuota del usuario
   en una sola sesión de búsqueda.
3. **La ruta cambia según lo que se escriba** (`GET` sin NIT/placa, `POST /buscar` con ellos).
   Cambiar de verbo y de endpoint a mitad de un tecleo es un comportamiento que no se puede explicar
   a quien lo ve.

Las pills sí aplican al clic: son un gesto único y deliberado, no un flujo de teclas.

**Validaciones antes de salir a la red** (todas evitan un 400 que el usuario no puede interpretar):

| Campo | Regla | Mensaje bajo el campo |
|---|---|---|
| N.º de comparendo | ≥ 3 caracteres | «Escribe al menos 3 caracteres del número.» |
| NIT | ≥ 5 dígitos ya sin puntos ni espacios | «El NIT debe tener al menos 5 dígitos.» |
| NIT | solo dígitos, guion opcional para el DV | «El NIT admite solo números, con guion opcional para el dígito de verificación.» |
| Placa | ≥ 3 caracteres | «La placa debe tener al menos 3 caracteres.» |
| Placa | letras, dígitos, espacio y guion | «La placa admite letras, números, espacio y guion.» |

- El mensaje se pinta **bajo el campo**, referenciado con `aria-describedby`, y `[Buscar]` no dispara
  nada mientras haya uno vivo. No se usa `aria-invalid` sin mensaje visible.
- **El texto se normaliza al mandarlo, no al escribirlo**: quien escribe «900.123.456» ve
  «900.123.456» y el cuerpo lleva `900123456`. Reescribir el campo bajo los dedos es de las cosas más
  desconcertantes que puede hacer un formulario.
- **Ninguna validación intenta adivinar si el NIT existe**: eso lo responde la lista vacía, no el
  formulario.

### La acción de exportar — sus cuatro estados

Es la única acción de esta pantalla con datos propios, así que tiene sus cuatro estados como
cualquier otra superficie (regla 9).

```
1 · Reposo    [Exportar a Excel]
2 · Ocupado   [Preparando el archivo…]   ← disabled + aria-busy="true"
              región aria-live: «Preparando el archivo de comparendos.»
3 · Error     banda role="alert" bajo la cabecera, con el copy de la tabla de abajo
4 · Hecho     región aria-live: «Archivo descargado: comparendos-2026-08-14.xlsx»
```

| Situación | Copy | Acción |
|---|---|---|
| **422 `export_demasiado_grande`** | «Son demasiadas filas para un solo archivo: el máximo son 5.000 y tu filtro trae más. Afina la búsqueda —por estado, por NIT o por placa— y vuelve a exportar.» | `[Cerrar el aviso]`; el botón vuelve a reposo |
| **429** | «Ya se descargaron varios archivos en el último minuto. Espera un minuto y vuelve a intentarlo.» | `[Reintentar]` |
| Otro error con respuesta | «No se pudo generar el archivo: `<mensaje del servidor>`.» — **⚠ en suspenso: ver la nota bajo esta tabla** | `[Reintentar]` |
| **Sin respuesta** (`ApiError.status === 0`) | «El archivo tardó demasiado en generarse. Vuelve a intentarlo con un filtro más estrecho.» | `[Reintentar]` |

> **⚠ `<mensaje del servidor>` también está en suspenso aquí** (ver el aviso de «Pantalla 1 ·
> Estados · 2 · Error»). La **#11559** dejó de hacer eco del texto del backend y deriva el copy del
> código de estado, porque el filtro que intentaba sanearlo en el cliente dejaba pasar NIT con
> separadores (`900.123.456-7`), cédulas con puntos, placas, hosts internos e IP privadas. **La
> decisión de producto/UX sigue abierta y sin aprobar.** Mientras siga abierta, la **#11558** pinta
> «No se pudo generar el archivo. Vuelve a intentarlo.» y **no** añade nada que venga del servidor.
> Traer ese texto exigiría un **campo aparte en el contrato del servidor**, garantizado libre de datos
> del titular — no un filtro en el frontend.

- **El export manda exactamente los filtros de la vista** —`estado`, `q`, `nit`, `placa`— y
  **nunca** `cursor` ni `limit`: se exporta el conjunto filtrado, no la página. Que el archivo
  contenga otra cosa de lo que se está viendo es la forma más silenciosa de equivocarse.
- **Se implementa con `api.downloadPost('/flito/comparendos/registros/export', nombre, cuerpo)`**,
  que ya existe en `lib/api.ts:201`. No hace falta nada nuevo: `request()` comprueba el
  `content-type` antes de `res.ok`, así que un 422 o un 429 —que responden JSON— caen en la rama de
  error y llegan como `ApiError` con su `codigo` dentro de `rawDetails`. Un blob solo se devuelve
  cuando de verdad viene un xlsx.
- Nombre del archivo: `comparendos-YYYY-MM-DD.xlsx`. **Sin NIT ni placa en el nombre**: un archivo se
  reenvía por correo y su nombre acaba en asuntos, en carpetas compartidas y en copias de seguridad.
- El tope de 5.000 se anuncia **antes** de fallar, en el texto de ayuda junto al botón: «Se exporta
  el conjunto filtrado, hasta 5.000 filas.» El 422 debería ser la excepción, no el modo normal de
  enterarse.

### Permiso y comportamiento por rol

| Elemento | `admin` | Cualquier otro rol |
|---|---|---|
| Ítem «Comparendos» en el menú | sí | no aparece: `FlitSidebar` y `CommandPalette` filtran por slug |
| Página | sí | `NoAccess` (guarda `hasPage` en `App.tsx`) |
| Filtros, tabla, paginación | sí | inalcanzables |
| Detalle, timeline, gestión, export | sí | inalcanzables |
| Llamada cruda al API | 200 | **403 del router entero**, no de la pantalla |

**No hay ni un condicional de rol dentro de los componentes de este módulo.** Toda la decisión está
en la guarda de la ruta y en el `NavItem`, que es donde se puede leer de un vistazo.

### Datos que consume

| Qué | Endpoint | Cuándo | Notas |
|---|---|---|---|
| Página de registros | `GET /registros` | al montar, y en cada filtro/página **sin** NIT ni placa | `estado`, `q`, `cursor` en query. `limit` no se manda |
| Página de registros | `POST /registros/buscar` | en cada filtro/página **con** NIT o placa | Los dos en el **cuerpo**; `estado`, `q`, `cursor` siguen en query |
| Municipios | `GET /municipios` | una vez al montar | `codigoFuente → nombre`. Si falla: se pinta el `codigoFuente` crudo y **la tabla no se cae** |
| Causales | `GET /causales` | una vez al montar | `id → nombre` para la columna «Gestión» y para el selector del formulario |
| NITs | `GET /nits` | una vez al montar (opcional) | Solo para el alias. Si falla: se pinta el NIT a secas |
| Export | `POST /registros/export` | al pulsar | **HU #11558** |

**Los tres catálogos se piden una sola vez por montaje y en paralelo con la primera página**, y su
fallo **nunca** bloquea la tabla: son etiquetas, no datos. Una pantalla que no muestra ni un
comparendo porque no pudo traducir «ITAGUI» a «Itagüí» estaría cambiando información por cosmética.

---

## Pantalla 2 — Panel de detalle con timeline

Se abre desde el número de comparendo. Es un `FlitModal wide` (ver «Decisiones», descarte 2).

### Wireframe

```
╔═ Comparendo 11001000123456 ══════════════════════════════════════════════ [X] ═╗
║                                                                                ║
║  ● Activo        Origen: Ambos        Municipio: Medellín                      ║
║  ─────────────────────────────────────────────────────────────────────────────  ║
║                                                                                ║
║  DATOS DE LA FUENTE · no se editan aquí                                        ║
║  ┌──────────────────────────────┬──────────────────────────────────────────┐   ║
║  │ N.º de comparendo            │ 11001000123456                           │   ║
║  │ NIT monitoreado              │ 900123456 · Transportes X                │   ║
║  │   (el NIT con el que se preguntó, no el del infractor)                  │   ║
║  │ Placa                        │ ABC123                                   │   ║
║  │ Fecha del comparendo         │ 12 de julio de 2026                      │   ║
║  │ Infracción                   │ C29 — Estacionar en zona prohibida       │   ║
║  │ Organismo                    │ Secretaría de Movilidad de Medellín      │   ║
║  │ Municipio                    │ Medellín                                 │   ║
║  │ Monto                        │ $ 604.100                                │   ║
║  │ Estado en la fuente          │ EN COBRO COACTIVO                        │   ║
║  │   (lo que reporta el proveedor, tal cual)                               │   ║
║  │ Visto en                     │ SIMIT · Municipal                        │   ║
║  │ Registrado                   │ 2 jul 2026, 03:12                        │   ║
║  │ Visto por última vez         │ 14 ago 2026, 03:07                       │   ║
║  │ Inactivado                   │ —                                        │   ║
║  └──────────────────────────────┴──────────────────────────────────────────┘   ║
║                                                                                ║
║  GESTIÓN                                    ← Pantalla 3, en línea             ║
║  ┌────────────────────────────────────────────────────────────────────────┐    ║
║  │ Causal        [ Notificado al cliente          ▾ ]                     │    ║
║  │ Observación   [ Se envió copia al cliente el 3 de julio.          ]     │    ║
║  │               [                                                  ]     │    ║
║  │               132 / 1000 caracteres                                    │    ║
║  │                                        [Cancelar]  [Guardar gestión]   │    ║
║  └────────────────────────────────────────────────────────────────────────┘    ║
║                                                                                ║
║  HISTORIAL                                                                     ║
║  ┌────────────────────────────────────────────────────────────────────────┐    ║
║  │ ● Gestión registrada          14 ago 2026, 09:14                       │    ║
║  │                                                                        │    ║
║  │ ● Reapareció en las fuentes   28 jun 2026, 03:20                       │    ║
║  │   Origen: municipal                                                    │    ║
║  │                                                                        │    ║
║  │ ● Dejó de reportarse          12 may 2026, 03:11                       │    ║
║  │   Motivo: ausente en todas las fuentes con cobertura completa          │    ║
║  │                                                                        │    ║
║  │ ● Primera vez que se vio       2 jul 2026, 03:12                       │    ║
║  │   Origen: simit                                                        │    ║
║  └────────────────────────────────────────────────────────────────────────┘    ║
╚════════════════════════════════════════════════════════════════════════════════╝
```

> **Corrección de la HU #11562 (2026-08-19) — el wireframe de arriba dibujaba dos cosas que no se
> pueden pintar, y ya no las dibuja.** Cada evento llevaba «· María Ruiz» y una línea «Causal:
> Notificado al cliente». **Ninguna de las dos sale del contrato**: del `detalle` del evento el API
> publica `origen` y `motivo` y nada más (RN-35), y `causalId` y `actorId` se guardan a propósito
> SIN publicarse — hay un test del backend que congela justamente eso. Pintarlas exigiría ampliar
> esa lista blanca con el nombre de una persona identificable, y **la decisión es que no**: es PII y
> el evento ya vive dentro de una respuesta que solo ve quien puede ver el comparendo entero, pero
> ampliarla lo metería también en el timeline suelto (`GET /registros/:id/eventos`), que hoy no deja
> registro de acceso ni sale con `no-store` **precisamente porque no lleva ningún dato personal**.
>
> Lo que sí se pinta del evento de gestión es su `motivo`, que es la etiqueta: «Gestión registrada»
> o «Gestión retirada». Y el **quién y cuándo de la última gestión** —que es lo que el AC5 pide— se
> muestra en la cabecera de la sección GESTIÓN, leído de la FILA (`gestionActualizadaEn` y
> `gestionActualizadaPor`, que desde la #11562 trae `{ id, nombre }`), no del timeline. El «·
> Sistema» de los eventos de sync se retira por lo mismo: era un autor decorativo que el contrato no
> da, y con la etiqueta puesta ya se sabe que ese evento lo escribió una corrida.

**Orden de las tres secciones y por qué:** primero **qué es** (los datos, que es lo que se vino a
mirar), después **qué hago** (la gestión, la única acción posible), y al final **qué le ha pasado**
(el historial, que es la segunda pregunta, no la primera). Es el mismo criterio con el que
`HistorialEstados` se pliega por defecto en SOAT e impuestos.

**El historial aquí NO se pliega**, y esa es la diferencia con `HistorialEstados`: allí es una
consulta aparte que se paga al abrir; aquí los `eventos[]` ya vienen dentro de la misma respuesta,
así que plegarlos solo escondería algo que ya está en memoria. Con más de 8 eventos, la lista se
recorta a los 8 más recientes con un `[Ver los N anteriores]` que despliega el resto.

### Los cuatro tipos de evento y su copy

`Record<ComparendosEventoTipo, …>` en shared-types, por el mismo motivo que en el otro documento:
añadir un tipo mañana **no compila** hasta que alguien le escriba su texto.

| `tipo` | Etiqueta | Detalle que se pinta | Tono |
|---|---|---|---|
| `primera_llegada` | Primera vez que se vio | «Origen: `detalle.origen`» | `active` |
| `inactivacion` | Dejó de reportarse | «Motivo: `detalle.motivo`» | `draft` |
| `reaparicion` | Reapareció en las fuentes | «Origen: `detalle.origen`» | `warning` |
| `gestion` (HU #11556) | «Gestión registrada» o «Gestión retirada», según `detalle.motivo` | Nada más: el motivo YA es la etiqueta | `success` |

- **`detalle` se pinta por lista blanca de `origen` y `motivo`, y de nada más.** El API ya lo proyecta
  así (RN-35), pero el componente no itera `Object.entries(detalle)`: si alguna vez entrara otra
  clave por esa columna JSONB, se pintaría sola en pantalla sin que nadie lo hubiera decidido.
- Un tipo desconocido —porque el backend añadió uno y el navegador está cacheado— se pinta con su
  `tipo` crudo y tono `neutral`. Nunca desaparece de la lista: un timeline con huecos es peor que uno
  con una etiqueta fea.
- «Dejó de reportarse» y no «Inactivado»: **`inactivo` no significa pagado**, y la etiqueta es el
  sitio más barato donde impedir esa lectura.

### Estados (4) del panel

| Estado | Qué se ve |
|---|---|
| **Cargando** | El panel se abre **de inmediato** con el número de comparendo en el título (ya se conoce de la fila) y el cuerpo en esqueleto: tres bloques de barras con la forma de las tres secciones. `role="status" aria-busy="true"`. Abrir un modal vacío que tarda 400 ms en aparecer se siente como un clic perdido |
| **Error** | Dentro del panel, `role="alert"`: «No se pudo cargar el comparendo: `<mensaje del servidor>.`» — **⚠ en suspenso: ver la nota bajo esta tabla** + `[Reintentar]` + `[Cerrar]`. **El modal no se cierra solo**: cerrarlo por un error obliga a buscar la fila otra vez |
| **Error 404** | «Este comparendo ya no está en el sistema. Puede que se haya purgado por retención de datos.» + `[Cerrar y actualizar la lista]`, que cierra **y** recarga la página actual de la tabla |
| **Vacío** | **No existe un panel vacío**: un registro con todos sus campos nulos sigue teniendo número, NIT, estado y al menos un evento (`primera_llegada`). Lo que sí hay son **campos** vacíos, y cada uno se pinta «—» con `<span class="sr-only">Sin dato</span>`. Si `eventos[]` llegara vacío —que no debería—, la sección dice «Sin movimientos registrados», el mismo texto que ya usa `HistorialEstados` |
| **Lleno** | El wireframe de arriba |

> **⚠ `<mensaje del servidor>` de la fila «Error» está en suspenso** (ver el aviso de «Pantalla 1 ·
> Estados · 2 · Error»). La **#11559** retiró el eco del texto del backend y deriva el copy del código
> de estado, porque el filtro que intentaba sanearlo en el cliente dejaba pasar NIT con separadores
> (`900.123.456-7`), cédulas con puntos, placas, hosts internos e IP privadas. **Aquí pesa más que en
> la lista: este panel se pide por identificador, así que es justo donde un mensaje del backend tiene
> más probabilidad de repetir el dato consultado.** Mientras la decisión de producto/UX siga abierta
> —lo está, planteada al Líder Técnico y sin aprobar—, quien implemente el panel (**#11560**) pinta
> «No se pudo cargar el comparendo. Vuelve a intentarlo.» sin nada del servidor. Si se quisiera ese
> texto, hace falta un **campo aparte en el contrato del servidor**, garantizado libre de datos del
> titular, no un filtro en el cliente.

### Datos

`GET /flito/comparendos/registros/:id` — una sola petición. `GET /registros/:id/eventos` **no se
usa**: el detalle ya trae `eventos[]`.

---

## Pantalla 3 — Formulario de gestión (dentro del panel)

Depende de la **HU #11557**. Mientras ese endpoint no exista, el bloque **no se monta**: no se pinta
un formulario deshabilitado ni un «próximamente», que son dos formas de prometer algo que la pantalla
no puede cumplir.

> **Corrección de la HU #11562 (2026-08-19) — el contador dice 1000, no 500.** Los wireframes de
> esta sección y el del panel enseñaban «0 / 500» porque se dibujaron antes de que la #11557
> publicara `COMPARENDOS_OBSERVACION_MAX`. **La constante manda y vale 1000**, que es además el
> número que importa el esquema `zod` del endpoint. Un `500` escrito en el formulario habría
> bloqueado texto perfectamente válido quinientos caracteres antes que el servidor, que es peor que
> no tener contador: el usuario no descubre un límite del producto, descubre un error de la
> pantalla.

### Wireframe · los tres momentos

```
Reposo, sin cambios                          Con cambios sin guardar
┌────────────────────────────────────┐       ┌────────────────────────────────────┐
│ Causal      [ Sin causal      ▾ ]  │       │ Causal      [ Notificado…     ▾ ]  │
│ Observación [                   ]  │       │ Observación [ Copia enviada.    ]  │
│             0 / 1000               │       │             15 / 1000              │
│         [Cancelar]  [Guardar]⊘     │       │         [Cancelar]  [Guardar]      │
└────────────────────────────────────┘       └────────────────────────────────────┘

Guardando                                     Error al guardar
┌────────────────────────────────────┐       ┌────────────────────────────────────┐
│ (los dos campos inhabilitados)     │       │ ⚠ No se pudo guardar la gestión:   │
│         [Cancelar]⊘ [Guardando…]⊘  │       │   <mensaje del servidor>           │
└────────────────────────────────────┘       │ (lo escrito sigue en los campos)   │
                                              │         [Cancelar]  [Guardar]      │
                                              └────────────────────────────────────┘
```

### Acciones y validaciones

| # | Acción | Precondición | Qué hace |
|---|---|---|---|
| B1 | Elegir causal | siempre | Cambia el borrador. «— Sin causal —» es una opción real y manda `causalId: null` |
| B2 | Escribir observación | ≤ `COMPARENDOS_OBSERVACION_MAX` | Cambia el borrador |
| B3 | `[Guardar gestión]` | **hay algún cambio** y no hay guardado en curso | `PATCH /registros/:id/gestion` con **solo lo que cambió** |
| B4 | `[Cancelar]` | hay algún cambio | Devuelve los dos campos a lo que dice el servidor. Sin confirmación: no se pierde nada que no se acabe de escribir |

**El selector de causales tiene una trampa que hay que resolver en el diseño, no en el código de
alguien con prisa:** el catálogo tiene causales que se pueden desactivar (`activo`), y un comparendo
puede tener asignada una causal que **hoy está inactiva**. Reglas:

1. El selector lista las causales **activas**, en el orden de `orden` (que existe justamente para
   que no se ordene alfabéticamente).
2. **Si la causal asignada está inactiva, se añade igualmente al selector**, marcada «(inactiva)» y
   preseleccionada. Si no, el selector no podría representar el valor actual y el primer guardado de
   cualquier otro campo **cambiaría la causal sin que nadie lo pidiera**.
3. Las causales inactivas **no se pueden elegir de nuevo**: solo aparece la ya asignada.

**Validaciones:**

| Regla | Mensaje |
|---|---|
| Observación por encima del tope | «La observación admite hasta N caracteres.» (el contador se pone en `--flit-danger` a partir del tope) |
| Nada cambió | Ningún mensaje: `[Guardar gestión]` está inhabilitado. Un botón activo que no hace nada enseña a desconfiar del botón |
| Guardado en curso | Los dos campos y los dos botones inhabilitados, el primario dice «Guardando…» |

**El cuerpo lleva solo lo que cambió** (`{ causalId }`, `{ observacion }` o los dos). Es lo que hace
que dos personas trabajando el mismo comparendo no se pisen el campo que no tocaron.

**Al guardar bien:**

1. Aviso de confirmación: **«Gestión guardada.»** con el `toast.success` que ya usa el resto de FLITO.
2. La respuesta del `PATCH` reemplaza el registro del panel, así que el timeline muestra el nuevo
   evento `gestion` **sin recargar** (si la HU #11556 ya lo emite; si no, el panel se refresca con un
   `GET /registros/:id`).
3. **La fila de la tabla se actualiza en sitio**, sin volver a pedir la página: la columna «Gestión»
   pasa a la causal nueva. Pedir la página otra vez movería la lista bajo los pies de quien acababa
   de gestionar —y, con cursor, una fila reordenada puede desaparecer de la vista.

**Errores:**

| Situación | Copy | Qué pasa con lo escrito |
|---|---|---|
| 400 de validación | «No se pudo guardar la gestión: `<mensaje del servidor>`.» — **⚠ en suspenso: ver la nota bajo esta tabla** | **Se conserva** |
| 404 | «Este comparendo ya no está en el sistema. Copia tu observación antes de cerrar.» | Se conserva, campos inhabilitados |
| 403 | «Tu usuario ya no puede gestionar comparendos.» | Se conserva |
| 500 / sin respuesta | «No se pudo guardar la gestión: `<mensaje del servidor>`.» — **⚠ en suspenso: ver la nota bajo esta tabla** + `[Reintentar]` | **Se conserva** |

> **⚠ `<mensaje del servidor>` está en suspenso en las dos filas de arriba y en el wireframe «Error al
> guardar»** (ver el aviso de «Pantalla 1 · Estados · 2 · Error»). La **#11559** retiró el eco del
> texto del backend y deriva el copy del código de estado, porque el filtro que intentaba sanearlo en
> el cliente dejaba pasar NIT con separadores (`900.123.456-7`), cédulas con puntos, placas, hosts
> internos e IP privadas. **Este formulario se trabaja sobre un comparendo concreto e identificado**,
> así que es de los peores sitios donde reinstalar el eco. Mientras la decisión de producto/UX siga
> abierta —lo está, planteada al Líder Técnico y sin aprobar—, la **#11557** pinta «No se pudo guardar
> la gestión: revisa la causal y la observación.» en el 400 y «No se pudo guardar la gestión. Vuelve a
> intentarlo.» en el 500 o sin respuesta, **sin** repetir nada del servidor; lo escrito se conserva
> igual en los dos casos. Traer el detalle real del 400 exigiría un **campo aparte en el contrato del
> servidor**, garantizado libre de datos del titular — no un filtro en el frontend.

> **Lo escrito no se borra nunca por un error.** Una observación es texto que alguien redactó
> mirando un caso; perderla por un 500 es la clase de cosa que hace que la gente deje de usar el
> campo.

### Datos

`PATCH /flito/comparendos/registros/:id/gestion` — **HU #11557**. Es el **único** endpoint de
escritura que esta pantalla consume.

---

## Copy — catálogo completo

**Etiquetas de columna** (mayúsculas las pone `FlitTh`, no el texto):

| Columna | Etiqueta |
|---|---|
| `numeroComparendo` | N.º comparendo |
| `placa` | Placa |
| `nitMonitoreado` | NIT monitoreado |
| `fechaComparendo` | Fecha |
| infracción | Infracción |
| `organismo` | Organismo |
| `municipioFuente` | Municipio |
| `monto` | Monto |
| `origenMerge` | Origen |
| `estado` | Estado |
| `primeraVistoEn` | Registrado |
| `inactivadoEn` | Inactivado |
| gestión | Gestión |

**Valores:**

| Valor | Copy | Presentación |
|---|---|---|
| `estado: 'activo'` | Activo | `StatusChip tone="active"` |
| `estado: 'inactivo'` | Inactivo | `StatusChip tone="draft"` |
| `origenMerge: 'simit'` | SIMIT | texto |
| `origenMerge: 'municipal'` | Municipal | texto |
| `origenMerge: 'ambos'` | Ambos | texto |
| `causalId === null` | Sin gestión | `StatusChip tone="draft"` |
| cualquier campo `null` | — | texto + `sr-only` «Sin dato» en el detalle |

**Textos de ayuda que no son decorativos:**

| Dónde | Texto |
|---|---|
| Subtítulo de la página | «Lo que SIMIT y los municipios reportan de los NIT que se vigilan. Los datos vienen de la fuente y no se editan aquí: lo único que se registra es la causal y la observación de gestión.» |
| Bajo los filtros de identidad | «El NIT y la placa se buscan exactos y no viajan en la dirección del navegador.» |
| Ayuda de la columna Estado (`aria-describedby` de la cabecera) | «Activo o inactivo es lo que dicen las fuentes, no si está pagado: “inactivo” significa que dejaron de reportarlo.» |
| Junto a «Estado en la fuente», en el detalle | «Lo que reporta el proveedor, tal cual. No está normalizado.» |
| Junto a «NIT monitoreado», en el detalle | «El NIT con el que se preguntó, no el del infractor.» |
| Junto al botón de exportar | «Se exporta el conjunto filtrado, hasta 5.000 filas.» |

**Mensajes de error, de vacío y de confirmación:** los de las tablas de las Pantallas 1, 2 y 3. Los
tres de 17b que el enunciado pide explícitamente:

- **422 tope excedido:** «Son demasiadas filas para un solo archivo: el máximo son 5.000 y tu filtro
  trae más. Afina la búsqueda —por estado, por NIT o por placa— y vuelve a exportar.»
- **429 del export:** «Ya se descargaron varios archivos en el último minuto. Espera un minuto y
  vuelve a intentarlo.»
- **429 de la lectura:** «Se hicieron demasiadas consultas seguidas. Espera un minuto y vuelve a
  intentarlo. El módulo limita las consultas porque cada página trae datos personales.»

**Tono:** español colombiano de producto, tuteo (es el mismo de `FlitoDerechos` y del reporte de
costos), sin anglicismos. Cada error dice **qué pasó** y **qué hacer**; ninguno dice «ha ocurrido un
error inesperado».

---

## Accesibilidad

**Etiquetas y nombres accesibles**

- Los tres filtros usan `FlitField`, que ya envuelve el `<input>` en un `<label>`: la asociación es
  estructural y no depende de que alguien acierte un `htmlFor`.
- Pills de estado: `FlitPillGroup` con `role="group" aria-label="Filtrar por estado de monitoreo"`,
  y cada pill con `aria-pressed={activo}`. Sin `aria-pressed`, un lector de pantalla anuncia tres
  botones idénticos sin decir cuál está puesto.
- Número de comparendo (celda 1): **es un `<button>`**, no un `<div onClick>`, con
  `aria-label="Ver el comparendo 11001000123456"`. El texto visible es solo el número; el nombre
  accesible dice qué hace.
- `[Exportar a Excel]`: texto visible suficiente. En estado ocupado, `aria-busy="true"` **y** el
  texto cambia a «Preparando el archivo…»: el atributo solo no lo anuncia nadie.
- Tabla: `<caption class="sr-only">Comparendos monitoreados</caption>`. `FlitTh` ya pone
  `scope="col"`.
- Cabecera de «Estado»: `aria-describedby` apuntando al texto de ayuda, para que la aclaración de
  «inactivo ≠ pagado» esté también en el árbol accesible y no solo en un tooltip visual.

**Orden de tabulación**

1. Barra de filtros: pill Todos → Activos → Inactivos → N.º de comparendo → NIT → Placa →
   `[Buscar]` → `[Limpiar]`.
2. `[Exportar a Excel]` (está en la cabecera, arriba del todo en el DOM, y ahí se queda: es una
   acción de toda la pantalla, no de los filtros).
3. Tabla: fila a fila, un solo tabulador por fila (el botón del número). **Las celdas no son
   enfocables**: 50 filas × 13 celdas serían 650 paradas de tabulador para llegar a la paginación.
4. `[← Anterior]` → `[Siguiente →]`.

Dentro del panel: `[X] Cerrar` (lo pone `FlitModal`) → los datos de fuente (no enfocables, son un
`<dl>`) → Causal → Observación → `[Cancelar]` → `[Guardar gestión]` → historial → `[Ver los N
anteriores]` si existe.

**Foco al abrir y al cerrar el panel**

- `FlitModal` ya atrapa el foco (`useFocusTrap`) y lo restaura al cerrar. No se reimplementa.
- **Foco inicial: el título del panel**, no el primer campo del formulario de gestión. El detalle se
  abre para leer; empezar en el `<select>` de causal saltaría por encima de todo lo que se vino a
  mirar, y un `select` enfocado en un modal recién abierto se cambia sin querer con la rueda del
  ratón.
- **Al cerrar, la fila que abrió el panel puede haber desaparecido** (se gestionó y el filtro era
  otro, o la lista se recargó). `useFocusTrap` devolvería el foco a un nodo desmontado y acabaría en
  `<body>`. Regla: si el disparador ya no está en el DOM, el foco va al `<caption>`/encabezado de la
  tabla (`tabIndex={-1}`).
- Esc cierra el panel. **Con cambios sin guardar en el formulario de gestión, Esc pide confirmación**
  («Tienes una gestión sin guardar. ¿Cerrar y perderla?») — es el mismo criterio que
  `DiagnosticoEvaluacionDrawer` ya aplica en PESV. Sin cambios, cierra directo.

**Anuncio de estados**

| Qué | Cómo |
|---|---|
| Tabla cargando | `role="status" aria-busy="true" aria-label="Cargando comparendos"` en el contenedor de filas fantasma |
| Error de la lista, del panel o del guardado | `role="alert"` — interrumpe, que es lo correcto para algo que impide seguir |
| Export ocupado / terminado | Región `aria-live="polite"` en la página: «Preparando el archivo de comparendos.» → «Archivo descargado: comparendos-2026-08-14.xlsx» |
| Resultado de la búsqueda | La misma región `polite`: «50 comparendos» / «Ningún comparendo coincide con lo que buscaste». Sin esto, quien navega con lector no se entera de que la tabla cambió bajo el mismo encabezado |
| Gestión guardada | `toast.success('Gestión guardada.')` + la región `polite` |

**Contraste y color (regla 12, ≥ 4.5:1)**

- Solo tokens ya usados. `StatusChip` con sus tonos existentes; no se añade ninguno.
- `--flit-text-muted` **solo** para los guiones de ausencia y para textos de ayuda secundarios sobre
  fondo blanco. **Nunca** para el contenido de una celda que hay que leer (monto, fecha, causal): ahí
  va `--flit-text-primary`, y `--flit-text-secondary` en los textos de apoyo.
- **Punto delicado 1 — Activo/Inactivo no puede distinguirse solo por color.** `StatusChip` ya lleva
  la etiqueta de texto dentro; el punto de color es `aria-hidden`. No se sustituye el chip por un
  punto de color a secas «para que la tabla respire».
- **Punto delicado 2 — la columna «Inactivado» y la fila inactiva.** No se atenúa la fila entera de
  un comparendo inactivo: bajar la opacidad de una fila es exactamente cómo se pierden 4.5:1 en trece
  columnas de golpe, y además «inactivo» **no** significa «resuelto». El chip lo dice; la fila se
  pinta normal.
- **Punto delicado 3 — el monto alineado a la derecha** con `tabular-nums`. Sin cifras tabulares, las
  columnas de pesos no alinean sus unidades y comparar dos montos exige leerlos enteros.
- **Punto delicado 4 — el contador de caracteres de la observación** pasa a `--flit-danger` al
  superar el tope, pero además el mensaje de error aparece en texto: el color no carga solo con la
  información.

**Datos personales en pantalla (Ley 1581)**

| Dato | Lista | Detalle | Justificación |
|---|---|---|---|
| `numeroComparendo` | sí | sí | Consecutivo del Estado, no identifica a una persona |
| `placa` | **sí** | sí | Cuasi-PII. Sin ella la lista no sirve para nada: el trabajo es «este vehículo tiene un comparendo». El rol que la ve es el único que opera el módulo |
| `nitMonitoreado` | **sí** | sí | Cuasi-PII (un NIT de persona natural es un documento). Es el eje del módulo: sin él no se sabe de qué empresa vigilada salió la fila |
| cédula, teléfono, dirección, nombre del infractor | **no existen en el esquema** | — | No se piden ni se muestran |
| Cualquiera de los anteriores en la URL | **nunca** | nunca | §14 |

- La respuesta sale con `Cache-Control: no-store` desde el servidor; el navegador no la guarda.
- **Aviso para QA y para backend:** ~~los mensajes de error del servidor se pintan literales.~~
  **Desde la #11559 ya no: el copy de error se deriva del código de estado y la pantalla no hace eco
  del texto del backend** (la historia completa y la decisión abierta están en el aviso de
  «Pantalla 1 · Estados · 2 · Error»). **Lo que caduca es la descripción del comportamiento actual,
  no la exigencia al backend**, que sigue vigente igual: el día que exista el campo del contrato ese
  texto sí llegaría a pantalla. Si algún error del módulo llegara a incluir el NIT o la placa
  consultada en su texto, ese valor acabaría en una captura de pantalla compartida por chat. El
  contrato esperado es «no se encontró el comparendo», no «no se encontró el comparendo de ABC123».
  Hay un caso a vigilar en las pruebas.

---

## Notas para QA (insumo para los TC Gherkin de `qa-agent`)

**Permisos y acceso**
1. `admin` entra a `/flito/comparendos` y ve filtros, tabla y paginación.
2. `auditor` navega a `/flito/comparendos` → `NoAccess`. **No** aparece «Comparendos» en el menú ni
   en el Command Palette.
3. `financiera`, `proveedor`, `gestor_impuestos` y `mensajero`: igual que `auditor`.
4. Ningún componente del módulo contiene una condición por rol (comprobable por revisión: `grep` de
   `role ===` bajo `components/comparendos/`).

**Los cuatro estados de la lista**
5. Consulta en curso → filas fantasma con `aria-busy="true"`; la barra de filtros sigue habilitada.
6. `GET /registros` 500 → «No se pudieron cargar los comparendos: …» + `[Reintentar]`; la tabla
   anterior **no** se queda pintada bajo el error.
7. `[Reintentar]` vuelve a llamar al endpoint con los mismos filtros.
8. Respuesta `{ items: [], nextCursor: null }` **sin filtros** → vacío **A**, sin botón de acción.
9. Misma respuesta **con** un filtro → vacío **B**, con el resumen de filtros puestos y
   `[Quitar los filtros]`.
10. Vacío B **con placa** → aparece la explicación de la búsqueda exacta; **sin** NIT ni placa → no
    aparece.
11. `[Quitar los filtros]` deja la vista como la primera carga y dispara `GET /registros` sin query.

**Paginación por cursor**
12. La primera petición **no** manda `limit` ni `cursor`.
13. Con `nextCursor: "abc"`, `[Siguiente →]` manda `?cursor=abc` **tal cual** (sin recortar, sin
    codificar dos veces).
14. Con `nextCursor: null`, `[Siguiente →]` está inhabilitado.
15. En la primera página, `[← Anterior]` está inhabilitado.
16. Tras avanzar dos páginas, cambiar el filtro de estado vuelve a la primera página **sin `cursor`**.
17. 400 con `codigo: 'cursor_invalido'` → se pinta el copy propio («El listado cambió mientras
    paginabas…»), **no** el mensaje del servidor con la palabra `cursor`, y el botón dice «Volver a
    la primera página».
18. El contador **no** dice «de N páginas» ni «de N registros en total».

**PII y ruta de la búsqueda**
19. Buscar solo por número → `GET /registros?q=…`. La URL del navegador **no cambia**.
20. Escribir un NIT → `POST /registros/buscar` con `{"nit":"900123456"}` en el **cuerpo**;
    `?nit=` **no** aparece en ninguna petición.
21. Escribir una placa → idem con `{"placa":"ABC123"}`.
22. NIT y placa a la vez → un solo `POST` con los dos en el cuerpo.
23. Con NIT puesto, paginar sigue usando `POST /registros/buscar` (con `?cursor=` en la query) y no
    se cae al `GET`.
24. **En ningún momento** la barra de direcciones contiene un NIT o una placa (comprobable
    afirmando sobre `window.location.search` tras cada interacción).
25. Escribir «900.123.456» manda `900123456` en el cuerpo y **el campo sigue mostrando los puntos**.
26. Teclear en cualquiera de los tres campos **no** dispara ninguna petición hasta Enter o
    `[Buscar]`.

**Validación de los filtros**
27. `q` con 2 caracteres → mensaje bajo el campo y `[Buscar]` no lanza petición.
28. NIT con letras → «El NIT admite solo números…».
29. Placa con 2 caracteres → «La placa debe tener al menos 3 caracteres.».

**Columnas y formato**
30. Una fila con `placa: null`, `municipioFuente: null` y `monto: null` pinta «—» en las tres, sin
    romper el alto de la fila.
31. `monto: "604100.00"` se pinta «$ 604.100».
32. **No hay fila de totales** en el pie de la tabla.
33. `estado: 'inactivo'` pinta el chip «Inactivo»; la fila **no** se atenúa.
34. La columna «Inactivado» solo existe con el filtro «Inactivos» puesto.
35. `municipioFuente: 'ITAGUI'` se pinta «Itagüí» con el catálogo cargado, y «ITAGUI» si
    `GET /municipios` falló — **y en los dos casos la tabla se pinta**.
36. `estadoFuente` **no** aparece en ninguna columna de la tabla.
37. Una descripción de infracción de 200 caracteres se recorta a una línea y **no** se pone en un
    `title`.

**Detalle y timeline**
38. Clic en el número abre el panel con el número ya en el título y el cuerpo en esqueleto.
39. `GET /registros/:id` 500 → error dentro del panel + `[Reintentar]`; el panel **no** se cierra.
40. 404 → «Este comparendo ya no está en el sistema…» + `[Cerrar y actualizar la lista]`.
41. Los eventos se pintan del más reciente al más viejo, con las etiquetas de la tabla de copy.
42. Un evento con `detalle: { origen: 'simit' }` pinta «Origen: simit»; uno con
    `detalle: { motivo: '…' }` pinta «Motivo: …»; uno con **una tercera clave** no la pinta.
43. Un `tipo` desconocido se pinta con su valor crudo y tono neutro, **sin desaparecer** de la lista.
44. `eventos: []` → «Sin movimientos registrados».
45. **Ningún campo de fuente es editable**: no hay `<input>`, `<select>` ni `<textarea>` en la
    sección de datos de fuente (comprobable contando controles dentro de esa región).

**Gestión (HU #11557)**
46. Sin cambios, `[Guardar gestión]` está inhabilitado.
47. Cambiar solo la observación manda `{"observacion":"…"}` — **sin** `causalId`.
48. Elegir «— Sin causal —» manda `{"causalId":null}`.
49. Un comparendo con una causal **inactiva** la muestra preseleccionada y marcada «(inactiva)»; el
    resto de causales inactivas **no** están en la lista.
50. El selector ordena por `orden`, no alfabéticamente.
51. Guardado en curso → los dos campos y los dos botones inhabilitados, el primario dice
    «Guardando…».
52. 500 al guardar → mensaje de error **y lo escrito sigue en los campos**.
53. Guardado correcto → «Gestión guardada.», el timeline suma el evento y **la fila de la tabla
    cambia su columna «Gestión» sin que se vuelva a pedir la página**.
54. Esc con cambios sin guardar → pide confirmación. Sin cambios → cierra directo.

**Export (HU #11558)**
55. `[Exportar a Excel]` manda `POST /registros/export` con los filtros de la vista en el cuerpo —
    incluidos NIT y placa— y **sin** `cursor` ni `limit`.
56. Mientras genera, el botón está inhabilitado, dice «Preparando el archivo…» y lleva
    `aria-busy="true"`.
57. 422 `export_demasiado_grande` → el copy del tope de 5.000, y el botón vuelve a reposo.
58. 429 → el copy del limitador.
59. **No existe ningún `<a download>` con querystring** en la pantalla (comprobable por revisión).
60. El nombre del archivo no contiene NIT ni placa.

**Accesibilidad**
61. Los tres campos de filtro tienen `<label>` asociado.
62. El botón del número de comparendo tiene `aria-label` con el número.
63. Al cerrar el panel, el foco vuelve a la fila que lo abrió; si esa fila ya no existe, va al
    encabezado de la tabla y **no** a `<body>`.
    > **Precisión de la HU #11562 (2026-08-19).** El respaldo es el **encabezado de la región de
    > resultados** (`<h2>Lista de comparendos</h2>`, `sr-only focus:not-sr-only`, `tabIndex={-1}`) y
    > no el `<caption>` de la tabla. El caso en que el respaldo hace falta —cerrar tras un 404, que
    > además recarga la lista— es justo aquel en el que la tabla se desmonta: el foco aterrizaría en
    > un `<caption>` que también desaparece. Ese encabezado existe en los cuatro estados de la vista.
    > Dos cosas más que se descubrieron implementándolo y que conviene probar tal cual: **(a)** el
    > disparador puede seguir montado en el instante en que el modal se cierra y desmontarse uno o
    > dos fotogramas después (la recarga de la lista llega en su propio efecto), así que la
    > comprobación se repite durante unos fotogramas; **(b)** el foco se hace **visible** al llegar
    > ahí, porque un elemento enfocado que no se ve incumple «foco visible» para quien navega con
    > teclado sin lector.
64. Los errores se anuncian (`role="alert"`); el estado ocupado del export se anuncia por la región
    `aria-live`.
65. Todo control interactivo es alcanzable con teclado y tiene foco visible (`flit-focus`).

**Mocks que hacen falta en todos los casos de esta sección** —incluidos los que no los miran, por el
mismo motivo que en el otro documento: un mock que solo cubre lo que el test afirma deja el resto en
un estado que nadie eligió— `GET /flito/comparendos/registros`, `POST …/registros/buscar`,
`GET …/registros/:id`, `GET …/municipios`, `GET …/causales`, `GET …/nits`, y
`PATCH …/registros/:id/gestion` + `POST …/registros/export` en cuanto existan.

---

## Reparto de archivos (regla 19: ≤ 800 líneas útiles)

| Archivo | Líneas útiles estimadas | Qué contiene | HU que lo trae |
|---|---|---|---|
| `pages/FlitoComparendos.tsx` | ≈ 190 | Cabecera, cableado del hook, montaje de barra, tabla, paginación y panel; región `aria-live` | Visor |
| `components/comparendos/useComparendosLista.ts` | ≈ 110 | Filtros, elección de ruta `GET`/`POST`, pila de cursores, los 4 estados, invalidación | Visor |
| `components/comparendos/BarraFiltrosComparendos.tsx` | ≈ 120 | Pills, tres campos con sus validaciones y mensajes, Buscar/Limpiar | Visor |
| `components/comparendos/TablaComparendos.tsx` | ≈ 150 | Columnas, niveles A/B, formato de monto y fechas, filas fantasma, los dos vacíos | Visor |
| `components/comparendos/PaginacionCursor.tsx` | ≈ 45 | Anterior/Siguiente sobre cursor, contador sin total | Visor |
| `components/comparendos/PanelDetalleComparendo.tsx` | ≈ 150 | `FlitModal`, `<dl>` de fuente, los 4 estados, foco | Detalle |
| `components/comparendos/TimelineComparendo.tsx` | ≈ 75 | Los cuatro tipos, lista blanca de `detalle`, recorte a 8 | Detalle |
| `components/comparendos/FormularioGestion.tsx` | ≈ 120 | Selector con la causal inactiva, contador, `PATCH`, errores | #11557, montado en #11562 |
| `components/comparendos/useComparendoDetalle.ts` | ≈ 90 | El `GET` del panel, sus errores y el reemplazo con el cuerpo del `PATCH` | Detalle |
| `components/comparendos/formato.ts` | ≈ 60 | Monto y fechas. Sale de `TablaComparendos.tsx` en la #11562 porque el panel pinta los mismos datos, y es donde se ve la distinción entre `fechaColombia` (día) y `fechaHoraColombia` (día y hora) | Detalle |
| `components/comparendos/ExportarComparendos.tsx` | ≈ 70 | Botón, estado ocupado, 422/429, `downloadPost` | #11558 |
| `packages/shared-types/src/permissions.ts` | +3 | El slug | Visor |
| `packages/shared-types/src/flito-comparendos.ts` | +40 | Contratos de 17b y los mapas de copy | #11556/#11557/#11558 |

Total nuevo en `apps/web`: **≈ 1.030 líneas en 9 archivos**, ninguno por encima de 190 —menos de un
cuarto del techo—. El reparto no es cosmético: **la tabla, el panel y el formulario cambian por
motivos distintos** (columnas, presentación de la fuente, reglas de gestión), y juntarlos obligaría a
leer la lógica del `PATCH` para retocar un ancho de columna.

---

## Decisiones y descartes

**1. `Paginacion.tsx` no se reutiliza; se añade `PaginacionCursor.tsx`.** El componente existente
pide `total`, `page` y `totalPaginas` (`Paginacion.tsx:9-13`) y su contador —«1.284 registros ·
página 3 de 26»— **es su razón de existir**: «es la única forma de saber que un filtro dejó fuera lo
que se estaba buscando», dice su propia cabecera. Con cursor no hay total, así que reutilizarlo
exigiría pasarle números inventados. El nuevo componente **copia sus clases y sus estilos tal cual**
(`rounded-lg border px-3 py-1.5 text-sm font-semibold disabled:opacity-40`,
`--flit-border-input` / `--flit-blue-text`) para que sean indistinguibles en pantalla: es el mismo
patrón visual con otro contrato de datos, no un patrón nuevo. **Es el único componente nuevo de este
diseño**, y queda propuesto en `components/comparendos/` —no en `components/flit/`— hasta que una
segunda pantalla pagine por cursor.

**2. El detalle es un `FlitModal wide`, no un drawer lateral.** Los dos patrones existen en el repo
(`FlitModal` en todo FLITO; `DiagnosticoEvaluacionDrawer` en PESV), así que la decisión hay que
argumentarla. Modal porque: (a) el contenido es **lectura y una acción corta**, no un banco de
trabajo con carga de evidencias como el de PESV; (b) `FlitModal` ya trae `useFocusTrap`, cierre por
Esc con el desempate de modales apilados, `ModalPortal` y el cierre por backdrop —todo lo que el
drawer de PESV tuvo que reimplementar a mano—; (c) el drawer tiene sentido cuando hace falta ver la
lista mientras se trabaja el elemento, y aquí no: gestionar un comparendo no depende de los otros
cuarenta y nueve.

**3. Descartado: ruta propia para el detalle (`/flito/comparendos/:id`).** El UUID es opaco y el §14
lo admitiría. Se descarta porque **los filtros y el cursor no están en la URL** (decisión 4): al
volver desde un enlace directo, el detalle se abriría sobre una lista sin filtros y en la primera
página, y el usuario acabaría en un sitio que no reconoce. Un enlace que se puede compartir pero
lleva a un contexto falso es peor que no tenerlo. **Se reconsidera** el día que exista un motivo real
para enlazar un comparendo desde fuera (una alerta, un correo): entonces la HU decide qué pasa con la
lista de detrás.

**4. Descartado: llevar los filtros a la query del router.** `estado` y `q` **podrían** ir (no
identifican a nadie) y NIT y placa **no** pueden. Poner la mitad significaría que copiar la URL
comparte una vista distinta de la que se está mirando, sin decirlo. O todos o ninguno, y todos es
ilegal: **ninguno**. Coste asumido: recargar la página pierde los filtros. Se acepta porque la
alternativa es una URL que miente.

**5. Descartado: `ChipSinGestion` para la columna «Gestión».** El nombre encaja y el componente no:
cuenta **el tiempo transcurrido desde que algo se envió** y su tono por defecto es `warning`, porque
allí «sin gestión» significa un ANS incumplido. Aquí «sin causal» no es un incumplimiento —hay
comparendos que no requieren gestión— y no existe la fecha desde la que contar (requerimiento 3).
Se usa `StatusChip tone="draft">Sin gestión`, que es lo que el chip haría sin la parte que no aplica.

**6. Descartado: buscar mientras se escribe (debounce), aunque sea lo que hace `FlitoDerechos`.** Tres
motivos, en orden de peso: el registro de acceso PII, el limitador de 60/min y el cambio de verbo
`GET`↔`POST` a mitad de tecleo. Los tres están desarrollados en «Acciones y validaciones» de la
Pantalla 1. **Es la única divergencia deliberada respecto de una pantalla FLITO existente, y por eso
va escrita aquí y no enterrada en un comentario.**

**7. Descartado: selector de columnas configurable.** El nivel B colapsa por ancho con las utilidades
que el repo ya usa. Un selector guarda estado por usuario, exige persistencia y no existe en ninguna
otra pantalla: es un patrón nuevo para un problema que un breakpoint resuelve.

**8. Descartado: fila de totales o «suma de la página».** `monto` es cadena decimal y la regla es no
sumarla en el cliente. Aunque se pudiera, el total de 50 filas arbitrarias no responde ninguna
pregunta real. Quien necesita sumar, exporta.

**9. Descartado: colorear `estadoFuente`.** Es texto libre del proveedor. Cualquier mapa de tonos
sería una lista de valores observados una vez, y el valor nuevo del mes que viene caería en el color
equivocado sin que nadie se entere.

**10. Diferido: enlace del vacío A a la pantalla de sincronización.** Esa pantalla no existe todavía
en `apps/web`. El texto del vacío ya explica de dónde salen los datos; el botón entra con la HU que
traiga esa pantalla.

**11. Diferido: filtros por rango de fechas, por municipio y por causal.** `RangoFechas` está listo
para el primero, pero **el API no acepta ninguno de los tres** (`registrosQuerySchema` es `.strict()`
y solo admite `estado`, `q`, `limit`, `cursor`). Diseñarlos hoy sería diseñar contra datos que no
existen. **Son un insumo para architecture-agent** si producto los pide: cada uno necesita índice y
contrato, no solo un campo en la barra.

**12. Diferido: ordenar por columna.** El orden lo fija el cursor (`created_at DESC, id DESC`) y es
lo que hace que la paginación sea correcta. Un orden distinto exige un cursor distinto, es decir,
backend. No se pinta ninguna cabecera pulsable que sugiera lo contrario.

**13. Pregunta abierta para el PO (no bloquea la implementación).** La columna «Gestión» muestra la
causal pero no **cuándo** se gestionó ni **quién**, porque el contrato no lo trae (requerimiento 3).
¿Basta con tenerlo en el timeline del detalle, o la lista necesita «gestionado hace 3 días» para
poder priorizar? Si es lo segundo, la HU #11557 añade dos campos y esta columna crece. **No cambia
nada de lo aquí especificado.**

> **Actualización (HU #11556, 2026-08-18).** Los dos campos **ya existen**: los añadió la #11556 —no
> la #11557— al esquema y al contrato. Lo que sigue abierto es solo la mitad de producto: si la
> columna debe mostrarlos. Ordenar por ellos seguiría siendo otra HU (índice parcial + cursor nuevo).

---

```
HANDOFF
  Entrega: docs/ux/flito-comparendos-visor.md
  Pantallas: 3 (visor con tabla y filtros; panel de detalle con timeline; formulario de gestión)
             + 1 acción con datos propios (export xlsx) con sus 4 estados
  Requerimientos nuevos de datos: 4
    1. PageSlug `flito_comparendos` en shared-types (+ PAGES, PAGE_GROUPS, NAV_ITEMS, App.tsx)
    2. Contratos de 17b en shared-types: ComparendosGestionRequest, ComparendosExportRequest,
       COMPARENDOS_EXPORT_MAX_FILAS, COMPARENDOS_OBSERVACION_MAX, y 'gestion' en
       ComparendosEventoTipo
    3. Fecha/autor de la última gestión en ComparendoRegistro — OPCIONAL: el diseño entregado
       funciona sin ellos (opción A)
    4. Nada más: los seis endpoints de lectura y los dos catálogos ya existen y están verificados
  Siguiente: architecture-agent para los puntos 1 y 2 (van dentro de las HU #11557 y #11558 de
             backend, que son precondición de las HU FRONTEND de gestión y export).
             frontend-agent puede implementar YA el visor y el panel de detalle: no dependen de
             ningún endpoint nuevo salvo el slug de permiso.
             Pregunta al PO: decisión 13 (¿la lista necesita el «cuándo» de la gestión?).
```
