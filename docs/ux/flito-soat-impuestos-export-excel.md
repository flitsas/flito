# UX slim — Filtro «Creado» y exportar la cola a Excel (HU #11909, Feature #11908)

> **Qué es este documento.** La entrada del `frontend-agent` que implemente la HU #11909 («SOAT e
> Impuestos – Exportar cola a Excel»). Modo **slim**: dos pantallas que ya existen ganan **un filtro**
> y **una acción**; todo lo demás de esas pantallas se queda como está.
>
> **La regla que manda sobre cualquier propuesta de este documento:** el patrón ya existe en
> Comparendos (HU #11558/#11561) y se **copia**, no se rediseña. Fuente:
> `apps/web/src/components/flito/comparendos/ExportarComparendos.tsx` y su punto de montaje en
> `apps/web/src/components/flito/comparendos/VistaRegistrosComparendos.tsx:230-249`. Cada decisión de
> abajo cita la línea de donde sale.
>
> **Fuera de alcance, escrito para que nadie lo amplíe de paso:** no se toca la tabla (ni columnas ni
> orden), ni el buscador, ni las pastillas de estado, ni los presets, ni el modal «Ver», ni
> `columnasComunes.tsx` (lo comparten cuatro pantallas), ni el esqueleto/banda de error de las colas
> (dos deudas preexistentes que esta HU **declara** y **no paga**, ver «Estados»).

---

## Superficie tocada

| | SOAT | Impuestos |
|---|---|---|
| Página | `/flito/soat` | `/flito/impuestos` |
| Archivo | `apps/web/src/pages/FlitoSoat.tsx` | `apps/web/src/pages/FlitoImpuestos.tsx` |
| Superficie 1 — **filtro nuevo** | barra de filtros, `FlitoSoat.tsx:330-374` (junto a los dos `RangoFechas` de las líneas 361-364) | barra de filtros, `FlitoImpuestos.tsx:288-331` (junto a los `RangoFechas` de 317-320) |
| Superficie 2 — **acción nueva** | slot `actions` de `PageHeaderCard`, `FlitoSoat.tsx:288-306` | slot `actions` de `PageHeaderCard`, `FlitoImpuestos.tsx:265-273` |
| Superficie 3 — **banda de resultado** | debajo de la cabecera, antes de la tarjeta de filtros | ídem |
| Slug / permiso | `flito_soat` — **sin cambios** | `flito_impuestos` — **sin cambios** |
| Componentes | `components/flit/RangoFechas.tsx` + botón/banda clonados del vecino | los mismos |

**Cero componentes visuales nuevos.** El filtro es `RangoFechas`, que estas dos páginas ya usan dos
veces cada una; el botón es `flitBtnSecondary` + `flitBtnSecondaryStyle` del kit; la banda es la misma
tarjeta blanca con `--flit-border-soft` y `--flit-shadow-card` de `ExportarComparendos.tsx:346-355`.

---

## El patrón que se copia (y de dónde exactamente)

| Elemento | Fuente | Qué se copia tal cual |
|---|---|---|
| Rótulo del botón | `ExportarComparendos.tsx:301` | **«Exportar a Excel»**, y en curso **«Preparando el archivo…»** |
| **Icono** | `ExportarComparendos.tsx:291-304` | **No hay icono.** El vecino no lo lleva; no se añade uno aquí «para que se vea que descarga» |
| Estilo y jerarquía | `ExportarComparendos.tsx:295-296` | `flitBtnSecondary` — **secundario**, nunca primario: en estas dos colas el primario ya está ocupado por «Cargar facturas (masivo)» / «Cargar recibos (masivo)», que es la acción del día |
| Ubicación | `VistaRegistrosComparendos.tsx:230-239` | slot `actions` del `PageHeaderCard`, dentro de un `div className="flex flex-col items-end gap-1"` con la línea de ayuda debajo |
| Línea de ayuda | `VistaRegistrosComparendos.tsx:236-238` | **«Se exporta el conjunto filtrado que estás viendo, no solo esta página.»** — texto literal, `text-xs`, `--flit-text-secondary` |
| Estado ocupado | `ExportarComparendos.tsx:260-283` | candado con `useRef` **además** del `disabled`: el `disabled` se escribe en el commit siguiente al clic y entre medias cabe un segundo clic. El `disabled` es lo que se ve; la `ref` es lo que impide la segunda petición |
| Banda de resultado | `ExportarComparendos.tsx:322-389` | separada del botón (el mensaje del tope es largo y dentro de la cabecera aplasta el título), con `role="status"` sr-only siempre montada + `role="alert"` en la banda visible |
| Botones de la banda | `ExportarComparendos.tsx:365-386` | **«Reintentar la descarga»** (solo si el error es reintentable) y **«Cerrar el aviso»**, ambos `flitBtnSecondarySm` |
| Nombre del archivo | `ExportarComparendos.tsx:19-21, 91-120` | **lo pone el servidor** por `Content-Disposition`, con sello en hora de Colombia, y el cliente lo **valida** contra una forma esperada antes de aceptarlo. Uno fabricado en el navegador llevaría la hora del equipo de quien descarga |

**Orden dentro de la cabecera:** primero el botón primario que ya está («Cargar facturas (masivo)» /
«Cargar recibos (masivo)»), después el secundario de exportar. No se reordena nada.

---

## El filtro «Creado» — y la colisión de rótulo que hay que resolver antes de escribir código

El AC3 pide **fecha de creación del registro** (`flito_soat.created_at` / `flito_impuestos.created_at`).
Pero las dos tablas **ya pintan una columna rotulada «Creado»** que es **otra fecha**: la del trámite
en FLIT (`CeldaFechas`, `columnasComunes.tsx:93-96`, alimentada con `f.fechaCreacion` en
`FlitoSoat.tsx:473` y `FlitoImpuestos.tsx:404`). Un filtro «Creado: 1–5 ago» sobre filas que dicen
«Creado 12/03/26» es una contradicción en pantalla, y la va a reportar QA o el usuario.

> **Decisión 1 — el filtro se rotula «Creado en FLITO», no «Creado».**
> Es la etiqueta del `RangoFechas` (`etiqueta="Creado en FLITO"`), que además es su `aria-label`
> (`RangoFechas.tsx:116`), así que el rótulo resuelve a la vez lo visual y lo accesible. **No se
> renombra ni se toca la columna de la tabla**: es de `columnasComunes.tsx`, la comparten cuatro
> pantallas y esta HU no hereda cambios a nadie.
>
> Descartes: (a) *«Creado» a secas* — dos cosas distintas con el mismo nombre en la misma pantalla;
> (b) *renombrar la columna* — toca el archivo compartido, alcance de otra HU; (c) *añadir una columna
> con la fecha de registro* — la tabla ya venía apretada y el AC no lo pide.

> **Pregunta abierta para el PO (bloquea el copy, no la implementación).**
> `columnasComunes.tsx:90-91` deja escrito que en la carga masiva inicial **todos los históricos
> comparten el mismo día de `created_at`**. Filtrar por fecha de registro sobre ese tramo devuelve un
> bloque enorme en un solo día y vacío en el resto — que es justo el caso que va a chocar contra el
> tope del AC4. Si lo que el usuario quiere es «lo que entró esta semana», `created_at` sirve; si
> quiere «los trámites de esta semana», la fecha correcta sería la de FLIT (el molde ya existe:
> `COALESCE(fecha_creacion_flit, created_at)`, `flito-tramites.service.ts:535`). **Se implementa lo
> que dice el AC3 —`created_at`— y se pregunta**; si el PO cambia de criterio, cambia una línea del
> backend y el rótulo pasa a ser «Creado».

### Cableado del filtro (para que no se olvide ninguna de las cinco puntadas)

Se inserta **antes** de «Solicitado» (orden cronológico del ciclo: creado → solicitado → pagado):

```
[Creado en FLITO ▾]  [Solicitado ▾]  [Pagado ▾]
```

1. Estado propio `creado = { desde, hasta }`, como en `FlitoTramites.tsx:131` (mismo nombre de
   parámetros que ya usa el producto: `creadoDesde` / `creadoHasta`, `FlitoTramites.tsx:202-203`).
2. Va en el query de la cola (`FlitoSoat.tsx:232-247` / `FlitoImpuestos.tsx:164-180`) y en las
   dependencias del efecto.
3. **Entra en `hayFiltros`** (`FlitoSoat.tsx:190-191` / `FlitoImpuestos.tsx:123-124`). Si se olvida,
   el vacío filtrado dice «No hay SOAT en esta vista. Sincroniza desde el Tablero…» —una afirmación
   falsa— y **no aparece «Limpiar filtros»**. Es el error más probable de esta HU.
4. **Entra en `limpiarFiltros`** (`FlitoSoat.tsx:193-198` / `FlitoImpuestos.tsx:126-130`) y, por tanto,
   en `aplicarPreset`, que lo llama primero.
5. **Entra en el efecto que devuelve a la página 1** (`FlitoSoat.tsx:228` / `FlitoImpuestos.tsx:162`):
   sin eso, acotar por fecha desde la página 4 deja al usuario en una página que ya no existe.

El rango es **inclusivo por día** en el backend (`>= desde::date` y `< hasta::date + 1 día`, molde
`flito-tramites.service.ts:533-537`): un rango «5 ago → 5 ago» trae lo de ese día entero.

---

## Estados (4) + copy

### Superficie 1 — filtro «Creado en FLITO»

| Estado | Qué se ve | Copy |
|---|---|---|
| **Por defecto / vacío** | El `summary` cerrado con el rótulo y el resumen | **«Cualquier fecha»** (`RangoFechas.tsx:106`, ya existe) |
| **Cargando** | El filtro **no tiene carga propia**. Al elegir un rango, la cola vuelve a página 1 y entra en su estado de carga: en SOAT, `PageContentSkeleton` (`FlitoSoat.tsx:394`); en **Impuestos no hay esqueleto** y se ven solo cabecera y filtros | — |
| **Error** | El del listado, tal cual está hoy: en SOAT, banda con mensaje y **«Reintentar»** (`FlitoSoat.tsx:380-389`); en Impuestos, solo el párrafo rojo (`FlitoImpuestos.tsx:333`) | Sin cambios |
| **Lleno / sin resultados** | Rango elegido → `summary` con `5 ago 2026 → 12 ago 2026`; sin resultados, el vacío **filtrado** y el botón «Limpiar filtros» | **«Ningún SOAT coincide con los filtros.»** / **«Ningún impuesto coincide con los filtros.»** — ya existen (`FlitoSoat.tsx:405`, `FlitoImpuestos.tsx:351`), no se tocan |

> **Deuda declarada y no pagada aquí:** Impuestos no tiene esqueleto de carga y su banda de error no
> ofrece reintento. Son anteriores a esta HU. **No se arreglan en la #11909** (sería pantalla nueva,
> no un filtro) y se anotan para que nadie las cuente como regresión de esta HU.

### Superficie 2 — botón «Exportar a Excel» y su banda

**(a) Reposo / por defecto**

```
┌ PageHeaderCard ────────────────────────────────────────────────────────────┐
│ SOAT                                     [Cargar facturas (masivo)]        │
│ Cola de adquisición del SOAT…                    [Exportar a Excel]        │
│                       Se exporta el conjunto filtrado que estás viendo,    │
│                       no solo esta página.                                 │
└────────────────────────────────────────────────────────────────────────────┘
```

Habilitado siempre salvo mientras trabaja, exactamente como el vecino (`disabled={ocupado}` y nada
más, `ExportarComparendos.tsx:298`). **No se deshabilita por «cola vacía»**: sería una condición que
el vecino no tiene y que además compite con el aviso de carga (`data === null` no es «no hay filas»).

**(b) Cargando**

- El rótulo pasa a **«Preparando el archivo…»**, `disabled` y `aria-busy` (`ExportarComparendos.tsx:299-301`).
- Anuncio sr-only en la región `role="status"` siempre montada: **«Preparando el archivo de SOAT.»** /
  **«Preparando el archivo de impuestos.»** (molde: `ExportarComparendos.tsx:327-329`). Hace falta
  porque lo único que cambia al empezar es el **nombre accesible del botón**, y eso no se anuncia solo.
- La cola de abajo **no se bloquea**: se puede seguir paginando y leyendo mientras se genera.

**(c) Éxito** — la descarga del navegador **no basta**: en un navegador con la barra de descargas
oculta no hay ninguna señal de que algo pasó. Se pinta la banda neutra, y el `role="status"` la lee:

> **«Archivo descargado: soat_20260830-1412.xlsx»** &nbsp;&nbsp; `[Cerrar el aviso]`

(molde `ExportarComparendos.tsx:272`; el nombre lo escribe el servidor, ver «Datos»).

**(d) Error** — banda `role="alert"`, tinta `--flit-danger-ink` (nunca `--flit-danger` como texto de
14 px: se queda en 4,19 de contraste, Bug #11604).

| Caso | Copy | ¿Reintentar? |
|---|---|---|
| **AC4 — tope excedido** (422 `export_demasiado_grande`) | Lo escribe el **servidor**, con la cifra del entorno, y la pantalla lo hace eco: **«El filtro aplicado supera las 2.000 filas que admite un export. Acota la búsqueda —por estado, por compañía, por organismo o por fecha de creación— y vuelve a intentarlo.»** | **No.** Repetir da el mismo 422; lo que hay que cambiar es el filtro |
| **AC4 — respaldo del cliente**, si el 422 llega sin texto propio | **«El filtro que tienes puesto trae más filas de las que admite un archivo. Acota la búsqueda —por ejemplo, con un rango de "Creado en FLITO" más corto— y vuelve a exportar.»** — **sin cifra**: el tope es una variable de entorno y cualquier número escrito en el front puede ser mentira en cualquier despliegue | No |
| Demasiadas descargas seguidas (429) | Texto del servidor; respaldo: **«Se descargaron demasiados archivos seguidos. Espera 1 minuto y vuelve a intentarlo.»** | Sí |
| Sin permiso (403) | **«Tu usuario ya no puede exportar. Habla con un administrador.»** | No |
| Se cortó la conexión / tardó demasiado | **«El archivo tardó demasiado en generarse. Vuelve a intentarlo con un filtro más estrecho.»** | Sí |
| Fallo genérico | **«No se pudo generar el archivo. Vuelve a intentarlo; si sigue fallando, avisa a soporte.»** | Sí |

**Nunca se descarga un archivo recortado** (AC4): o sale el conjunto filtrado entero, o sale el error.
Un Excel truncado en silencio es peor que un fallo — quien concilia cree tener todo.

**AC7 no tiene superficie de UI:** una celda sin dato sale vacía o «—» dentro del archivo y **no se
avisa de nada** en pantalla. Ni banner, ni contador de huecos, ni tono de advertencia en el éxito. Un
dato que falta en una fila no es un fallo de la descarga.

---

## Permiso / slug y visibilidad por rol

`flito_soat` y `flito_impuestos`, **sin cambios** (`packages/shared-types/src/permissions.ts:117-118`).
No se crea ningún slug ni ningún predicado de rol nuevo: la condición que hay que reutilizar **ya está
escrita dos líneas más arriba en cada archivo**.

```
SOAT       →  {(esOperaciones || esGestor) && <BotónExportar …/>}   // misma guarda que FlitoSoat.tsx:290
Impuestos  →  {(esOperaciones || esGestor) && <BotónExportar …/>}   // misma guarda que FlitoImpuestos.tsx:268
```

`esOperaciones` es `puedeOperar(user?.role)` → `role === 'admin'` (`lib/permissions.ts:38-41`);
`esGestor` es `proveedor` en SOAT (`FlitoSoat.tsx:139`) y `gestor_impuestos` en Impuestos
(`FlitoImpuestos.tsx:93`).

| Rol | Filtro «Creado en FLITO» | Botón «Exportar a Excel» |
|---|---|---|
| `admin` | Sí | **Sí** |
| `proveedor` (solo SOAT) | Sí | **Sí** — su cola ya viene acotada a su proveedor por el servidor, así que exporta lo suyo |
| `gestor_impuestos` (solo Impuestos) | Sí | **Sí** |
| `auditor` | **Sí** — filtrar es leer, y el auditor ya usa todos los demás filtros | **NO** (AC6). No aparece; no es un botón que falle al pulsarlo |
| `cliente` (solo SOAT, Feature #11912) | Sí | **NO** — cae fuera de `esOperaciones \|\| esGestor` por construcción |

> **Decisión 2 — al `cliente` tampoco se le ofrece, y se declara.** El AC6 solo nombra a auditoría,
> pero la guarda reutilizada lo deja fuera de paso, y es lo correcto: el backend le **recorta** de cada
> fila el proveedor, quién despachó y lo que FLITO pagó (`FlitoSoat.tsx:47-53`), así que un export para
> él sería otro archivo, con otras columnas y otra decisión de privacidad. **No se hace en esta HU.**
> Si el PO lo quiere, es HU aparte.

**La banda de resultado se monta solo donde se monta el botón.** Un `role="alert"` colgado en la
pantalla del auditor no puede dispararse, pero sí aparece en el árbol de accesibilidad y en los
conteos de QA.

---

## Datos — dos endpoints que **no existen** (requerimiento para backend/architecture)

| Necesidad | Estado hoy | Qué hace falta |
|---|---|---|
| `creadoDesde` / `creadoHasta` en `GET /flito/soat` y `GET /flito/impuestos` | **No existe** | Filtro por `created_at` del registro, inclusivo por día. Molde exacto: `flito-tramites.service.ts:533-537` |
| `POST /flito/soat/export` y `POST /flito/impuestos/export` | **No existen** (lo verificado: solo `POST /flito/comparendos/registros/export`) | Molde: `flito-comparendos.routes.ts:1104` + `flito-comparendos.export.service.ts` |
| Tope de filas + 422 | — | `codigo: 'export_demasiado_grande'`, mensaje con la cifra del entorno. Molde: `flito-comparendos.errors.ts:497-506`, ADR-0004 |
| Limitador propio del export | — | Cuota separada de la del listado (5/min por usuario en el vecino) |
| Nombre del archivo | — | `Content-Disposition` con sello en hora de Colombia, `soat_AAAAMMDD-HHmm.xlsx` / `impuestos_AAAAMMDD-HHmm.xlsx`, **sin placa, VIN, NIT ni documento en el nombre**: un archivo se reenvía por correo y su nombre acaba en asuntos y carpetas compartidas |

> **PII — la línea que no se cruza (AGENTS.md §14).** El buscador de estas dos colas admite **nombre y
> documento del comprador** (`FlitoSoat.tsx:326`, `FlitoImpuestos.tsx:285`). En el export ese texto
> **viaja en el cuerpo del POST, nunca en el query string**, exactamente como el vecino separa `nit` y
> `placa` (`ExportarComparendos.tsx:11-15, 128-136`). El resto de filtros (estado, compañía, organismo,
> fechas, página) pueden ir en la query. **No hay variante `GET` de este endpoint y no la puede haber.**
>
> Y el `page`/`cursor` **no viaja**: un export no pagina. Entrega el conjunto filtrado o no entrega nada.

**El archivo debe traer una columna con la fecha de registro** («Creado en FLITO»). Sin ella el AC3 no
es comprobable: no habría forma de mirar el `.xlsx` y decir si el filtro se aplicó.

---

## Accesibilidad (lo que hace el vecino, ni más ni menos)

- **Botón:** nombre accesible = su texto; `disabled` + `aria-busy` mientras trabaja
  (`ExportarComparendos.tsx:298-299`). Sin `title`, sin `aria-label` que contradiga al rótulo.
- **Dos regiones, no una:** `role="status"` sr-only **siempre montada** para «preparando» y «archivo
  descargado» (una región polite que se monta ya rellena no se anuncia en varios lectores), y
  `role="alert"` para el error, que sí se anuncia al insertarse. **El error no se repite en la región
  polite**: dicho dos veces se oye dos veces.
- **El foco no se mueve** al empezar ni al terminar: se queda en el botón, que sigue existiendo. La
  banda es una región anunciada, no un diálogo.
- **«Reintentar la descarga»**, no «Reintentar» a secas: en SOAT ya hay un «Reintentar» en la banda de
  error de la cola (`FlitoSoat.tsx:386`) que puede estar en pantalla a la vez — dos botones con el
  mismo nombre accesible y dos efectos distintos.
- **Filtro:** `RangoFechas` ya trae `aria-label={etiqueta}` (`RangoFechas.tsx:116`); con «Creado en
  FLITO» los tres rangos de la pantalla tienen nombres distintos. El `<details name="flit-rango-fechas">`
  agrupa los tres, así que abrir uno cierra los otros — comportamiento que ya existe, no se toca.
- axe: recordar `QA_AXE_CDN=1` o salen ~10 rojos que no son regresión de nada.

---

## Notas para QA (10)

1. **AC6 en las dos pantallas, y como ausencia del DOM.** Con `auditor`:
   `expect(page.getByRole('button', { name: 'Exportar a Excel' })).toHaveCount(0)` en `/flito/soat` y
   en `/flito/impuestos`. *Mutante:* pintar el botón `disabled` en vez de no pintarlo — `toBeDisabled()`
   lo daría por bueno; `toHaveCount(0)` lo mata. Comprobar además que el **auditor sí ve el filtro**:
   sin ese segundo aserto, «esconder toda la barra de filtros» también pasaría.
2. **AC6 por el lado positivo, o el test no prueba nada.** El mismo aserto con `admin` (las dos
   pantallas), `proveedor` (SOAT) y `gestor_impuestos` (Impuestos) exigiendo `toHaveCount(1)`.
   *Mutante:* `{esOperaciones && …}` a secas — deja al gestor sin su botón y solo se ve probando con él.
3. **AC3 — el filtro acota la cola.** Con un rango que deje fuera una fila conocida: esa fila
   desaparece, el contador de `Paginacion` baja, y **aparece «Limpiar filtros»**. *Mutante:* no meter
   `creado` en `hayFiltros` — la fila desaparece igual (el aserto obvio pasa) pero el botón de limpiar
   no sale y el vacío miente. El aserto sobre «Limpiar filtros» es el que mata este mutante.
4. **AC3 — el filtro acota el ARCHIVO, comprobado sobre el archivo.** Poner el rango, anotar el total
   que dice `Paginacion` («N SOAT»), exportar y verificar en el `.xlsx`: (a) filas = N, y (b) **todos**
   los valores de la columna «Creado en FLITO» caen dentro del rango. *Mutante:* que el export ignore
   `creadoDesde/creadoHasta` — sin el punto (b) el test verde no dice nada.
5. **El export no pagina.** Exportar desde la página 1 y desde la página 3 con el mismo filtro: mismo
   número de filas. *Mutante:* colar `page`/`cursor` en la petición del export.
6. **AC4 — el tope no descarga nada.** Con el tope bajado por entorno y un filtro amplio: **no hay
   descarga**, sale la banda `role="alert"` con el mensaje del tope y **no** hay «Reintentar la
   descarga». Comprobar también que el botón vuelve a **«Exportar a Excel»** (reposo). *Mutantes:*
   entregar un archivo recortado; ofrecer reintento en el 422 (repetiría el mismo error).
7. **AC4 — el número lo dice el servidor.** El mensaje visible debe traer la cifra del 422; el
   respaldo del cliente **no lleva ninguna**. *Mutante:* escribir «2.000» a mano en el front — queda
   verde hoy y miente el día que se mueva la variable de entorno.
8. **Doble clic = una sola petición.** Dos clics seguidos sobre el botón → **una** petición a la red.
   *Mutante:* quitar la `ref` y dejar solo el `disabled`; el `disabled` llega un commit tarde.
9. **Los cuatro estados de la acción, en orden y anunciados.** Reposo → «Preparando el archivo…» con
   `aria-busy` → banda «Archivo descargado: …» → «Cerrar el aviso» la retira. Y con un fallo: banda de
   error → «Reintentar la descarga» vuelve a lanzar. *Mutante:* quedarse solo con la descarga del
   navegador y sin banda de éxito.
10. **AC7 — nada que avisar.** Con una fila a la que le falten datos: el archivo se descarga, la celda
    sale vacía o «—», y en pantalla **no aparece ningún aviso ni cambia el tono del mensaje de éxito**.
    *Mutante:* añadir un «se exportaron N filas con datos incompletos» que el AC no pide.

> **Recordatorio de infraestructura:** el CI solo corre **un** spec E2E (el visor de PDF). Cualquier
> spec de estas dos colas está en la lista fija del **nocturno**: verde en el PR no significa que nadie
> lo haya ejecutado. Quien cierre la HU lo corre a mano.

---

## Decisiones y descartes (citables en el PR)

| # | Decisión | Descarte |
|---|---|---|
| 1 | El filtro se rotula **«Creado en FLITO»** | «Creado» a secas — colisiona con la columna de la tabla, que es la fecha del trámite |
| 2 | El botón **no lo ve** ni `auditor` ni `cliente`, reutilizando la guarda `esOperaciones \|\| esGestor` que ya existe | Escribir un predicado de rol nuevo solo para esta acción |
| 3 | Botón **secundario**, sin icono, en el slot de acciones; la línea de ayuda debajo con el texto literal del vecino | Botón primario o icono de descarga «para que se note» — patrón nuevo donde ya hay uno |
| 4 | Banda de resultado **separada** del botón | Meter el mensaje del tope en la cabecera: aplasta el título al estrechar |
| 5 | El copy del tope lo escribe el **servidor** con su cifra; el front tiene respaldo **sin número** | Compilar el tope en el front: caduca en silencio |
| 6 | El texto del buscador viaja en el **cuerpo** del POST | Un `GET …?buscar=<documento>` — PII en URL, historial y `Referer` (Ley 1581, AGENTS.md §14) |
| 7 | AC7 **no** produce ningún aviso en pantalla | Contador de celdas vacías o tono de advertencia en el éxito |
| 8 | El esqueleto de Impuestos y su banda de error sin reintento **se declaran y no se pagan aquí** | Colarlos en esta HU como «ya que estamos» |

---

## Handoff

```
HANDOFF
  Modo: slim
  Resultado: OK
  Entrega: docs/ux/flito-soat-impuestos-export-excel.md
  Pantallas: 2 (FlitoSoat, FlitoImpuestos) | Requerimientos nuevos de datos: 2 endpoints de export
             + filtro creadoDesde/creadoHasta en las dos colas
  Siguiente: architecture-agent / backend (endpoints, tope, limitador, nombre de archivo) →
             frontend-agent. Pregunta al PO: created_at vs. fecha de creación en FLIT (ver «Pregunta
             abierta»), y confirmación de que el rol `cliente` queda fuera del export.
```
