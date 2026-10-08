# UX slim — Acceso por permiso: «sin acceso», tablero y menú (HU #12872)

Público: operadores internos de FLITO (admin, financiera, líder PESV, mensajero…). Análogas del
mismo público: shell (`components/shell/navItems.ts`), `components/NoAccess.tsx`, `pages/Dashboard.tsx`.
Tono: estas tres superficies **tutean** hoy («No tienes acceso», «Pulsa ⌘K… tus secciones»); se
calca el tú. Por eso el copy dice «pídele a un administrador», no «pídale».

Regla que gobierna todo el delta: **el producto nunca nombra un rol para explicar un acceso**. Lo que
el usuario ve u oculta depende del permiso; el copy habla de «permiso», nunca de «tu rol».

---

## Superficie tocada

| # | Superficie | Existe | Delta |
|---|---|---|---|
| 1 | Pantalla «sin acceso» (AC2) | Sí: `components/NoAccess.tsx` | Copy sin rol + hover roto + estados de la carga de permisos |
| 2 | Tablero `Dashboard` (AC6) | Sí | Bloques por permiso del módulo, rejilla sin huecos, vacío útil, 4 estados por bloque |
| 3 | Permiso perdido con la página abierta (AC7) | — | Reglas de qué ve el usuario; sin toast salvo acción fallida |
| 4 | Menú lateral | Sí | Sección sin ítems visibles no se pinta |

---

## 1. Pantalla «sin acceso» (AC2)

### Qué vino a hacer

Entró a una URL que no puede abrir (enlace viejo, marcador, URL pegada). Necesita saber **que no es
un error del sistema** y **salir** a donde sí trabaja. Una primaria: volver a su inicio.

### Delta de claridad

- **Se mantiene**: el componente, su lugar (dentro del Layout, conserva el menú), el foco al título,
  la salida a `rutaInicio(user)` con su etiqueta («Volver al tablero» / «Ir a <inicio>»). Es la única
  acción y es primaria.
- **Cambia el copy** (hoy dice «Tu rol actual no incluye esta sección» → nombra el rol, viola AC):

```
┌──────────────────────────────── contenido del Layout ─────────────────────────┐
│                                                                               │
│                                  ( candado )                                  │
│                                                                               │
│                 No tienes acceso a <Nombre de la sección>                     │  h1, foco al montar
│                                                                               │
│      Tu usuario no tiene el permiso para ver esta sección. Si la necesitas    │
│      para tu trabajo, pídele a un administrador que te la habilite.           │
│                                                                               │
│                         [ Volver al tablero ]  ← primaria única               │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

  - Sin sección conocida: «No tienes acceso a esta sección» (ya existe el fallback).
  - Prohibido en el copy: nombre de rol, slug técnico, código 403, «Forbidden».
- **Corrige el hover del botón**: hoy la clase `hover:bg-[color:var(--flit-blue)]-hover` no es una
  utilidad válida → el botón queda plano al puntero. Usar el hover del kit para la primaria
  (`flitBtnPrimary` / token hover del azul ya existente); foco con el anillo actual o `flit-focus`.
- Sin ilustración nueva, sin animación: el candado actual se queda tal cual.

### Estados (4)

La pantalla en sí no consulta datos. Lo que sí consulta es **la carga de permisos** que decide si se
pinta. Los estados son de esa decisión (`ProtectedRoute`/guarda):

| Estado | Qué ve |
|---|---|
| Cargando permisos | `PageContentSkeleton` del kit. **Nunca** un destello de «No tienes acceso» mientras llegan los permisos. |
| Error al cargar permisos | Aviso en página: «No pudimos comprobar tus permisos. Revisa tu conexión e inténtalo de nuevo.» + `[Reintentar]` (primaria). **No** se muestra «sin acceso»: no saber no es no tener. |
| Sin permiso | La pantalla de arriba. |
| Con permiso | La página pedida. |

### Responsive (<lg)

Ya es columna centrada `max-w-md` con `px-6`; en 360 px el texto envuelve y el botón queda centrado
a ancho de contenido. Sin cambio.

---

## 2. Tablero (AC6)

### Qué vino a hacer

Ver, de un vistazo, lo que pide atención **en los módulos que él trabaja**, y saltar ahí. Lo que se ve
primero: la «Atención operativa» y los indicadores de sus módulos. Lo que se calla: todo bloque de un
módulo sin permiso — no deshabilitado, no con candado: **no está**.

(Si el usuario tiene `tablero.tablero.ver`, sigue viendo `FlitoTablero` como hoy; este delta es el
tablero genérico de `Dashboard.tsx`.)

### Regla de visibilidad (una sola, sin roles)

> **Un bloque se pinta si y solo si el usuario puede abrir la página a la que lleva** (`hasPage` del
> slug de su destino, el mismo que usa el menú para ese `to`).

Y su consulta **solo se dispara** si el bloque se pinta (no se piden `/soat/stats` ni
`/rndc/manifiestos` para tirar el resultado ni para cosechar un 403).

| Bloque | Destino → permiso que lo gobierna | Endpoint (existente) |
|---|---|---|
| Métrica «Vehículos» + KpiCard «Flota» | `/vehicles` | `/soat/stats` (`totalVehicles`) |
| Métrica «SOAT vigentes» + KpiCard «Salud SOAT» + alerta «SOAT pendiente» | `/soat` | `/soat/stats` |
| Métrica «Por vencer 60d» + alertas de vencimientos | `/fleet` | `/fleet/documents/expiring?dias=60` |
| Métrica + atajo «RNDC» | `/rndc` | `/rndc/manifiestos?estadoEnvio=error_envio&limit=1` |
| Atajo «Mantenimiento» | `/maintenance` | (usa `totalVehicles`; si no hay permiso de `/vehicles`, el valor es «—», el atajo sigue) |
| Atajos «PESV» / «Tablero ejecutivo» | `/pesv` / `/pesv/tablero` | ninguno |
| Enlaces «Rendimiento (RUM)» / «Métricas trámites» | `/admin/rendimiento` / `/admin/tramites-metricas` | ninguno |

Se elimina todo `user?.role === 'admin'` del archivo: el gate es el permiso de la tabla.

Una sola primaria: «Ver vehículos» (gradiente) se queda **solo** si hay permiso de `/vehicles`. Sin
él, el bloque «Estado operativo» no lleva primaria — no se promueve otro enlace a gradiente.

### Wireframe

Escritorio, permisos completos (sin cambio visual respecto a hoy salvo la rejilla):

```
┌ PageHeaderCard: Buenas tardes, Ana · Panel operativo · miércoles, 08 de octubre ┐
└─────────────────────────────────────────────────────────────────────────────────┘
┌ Estado operativo ───────────────────────────────┐ ┌ Flota ───────────┐
│ [ Ver vehículos → ]  Tablero PESV →  …          │ │ 120  Activa      │
│ ─────────────────────────────────────────────── │ ├ Salud SOAT ──────┤
│ VEHÍCULOS │ SOAT VIGENTES │ POR VENCER │ RNDC   │ │ 92%  Excelente   │
└─────────────────────────────────────────────────┘ └──────────────────┘
┌ Atención operativa ─────────────────────────────────────────────────┐
│ (Pendiente) 3 solicitudes SOAT pendientes de compra      Ir a SOAT → │
└─────────────────────────────────────────────────────────────────────┘
[ Mantenimiento ] [ RNDC ] [ PESV ] [ Tablero ejecutivo ]
```

Solo permiso de PESV (ej. líder PESV): no hay hueco de 8+4 ni columna derecha vacía.

```
┌ PageHeaderCard: Buenos días, Luis · Panel operativo · … ┐
└─────────────────────────────────────────────────────────┘
[ PESV            ] [ Tablero ejecutivo ]
```

Sin ningún bloque (vacío útil):

```
┌ PageHeaderCard: Buenos días, Marta · Panel operativo · … ┐
└──────────────────────────────────────────────────────────┘
┌ tarjeta ─────────────────────────────────────────────────────────────┐
│ Tu tablero no tiene indicadores con tus permisos actuales.           │
│ Pulsa [Ctrl K] o usa el menú para ir a tus secciones. Si te falta    │
│ una, pídele a un administrador que te la habilite.                   │
└──────────────────────────────────────────────────────────────────────┘
```

(Es la tarjeta ⌘K que hoy ven los no-admin, con copy que dice por qué está vacío y qué hacer. Sin
primaria: el siguiente paso es el atajo/menú que ya existe; no se inventa un botón que abra la
paleta si el shell no expone ese disparador.)

### Rejilla sin huecos

- **Estado operativo + columna derecha**: el `lg:col-span-8` / `lg:col-span-4` solo aplica si **ambos**
  lados tienen algo. Si la columna derecha queda sin tarjetas, «Estado operativo» ocupa las 12; si
  «Estado operativo» queda sin métricas, se oculta entero y las KpiCards pasan a la fila de atajos.
- **Métricas internas**: `grid-cols-2 md:grid-cols-4` → con menos de 4 visibles, `md:` usa el número
  visible (1–4), nunca celdas vacías al final.
- **Atención operativa**: se pinta solo si alguna fila visible tiene conteo > 0 (regla actual), y cada
  fila depende de su permiso.
- **Atajos**: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`; con 1–3 visibles, el último no se estira a
  todo el ancho ni deja hueco señalado — las tarjetas conservan su ancho de columna y la fila queda
  alineada a la izquierda (es una fila de atajos, no una tabla).

### Estados (4) — por bloque con datos, no de toda la página

Las tres consultas son independientes (hoy `allSettled`): una que falla no tumba las otras.

| Estado | Qué ve |
|---|---|
| Cargando | El bloque con su estructura y el valor como «·» (patrón actual) o esqueleto del kit; el encabezado y los atajos sin datos se pintan de inmediato. |
| Error | En el bloque afectado: «No pudimos cargar <SOAT / vencimientos / RNDC>.» + `[Reintentar]` (secundario, pequeño) que repite **solo** esa consulta. Hoy el error se traga y se muestra `0`/«OK»: un RNDC «al día» falso es peor que un error. |
| 403 en una consulta | El bloque se oculta (el permiso cambió; ver §3). No es error. |
| Vacío | Por bloque: valores en 0 son dato válido («0 por vencer»), no vacío. Vacío de **página** = ningún bloque con permiso → tarjeta de arriba. |
| Lleno | Como hoy. |

### Responsive (<lg)

Todo cae a una columna: cabecera, «Estado operativo» (métricas en 2 columnas), KpiCards apiladas,
alertas (cada fila envuelve chip+texto sobre el CTA), atajos en 1 columna (2 desde `sm`). La barra de
enlaces del bloque principal envuelve (`flex-wrap`, ya está).

### Feedback

Sin cambio en lo existente: KpiCard, StatItem enlazado, AlertRow y ShortcutCard ya tienen hover +
`flit-focus`. El `[Reintentar]` nuevo: `flitBtnSecondary` (hover y foco del kit).

---

## 3. Permiso perdido con la página abierta (AC7)

Cuando el refresco de permisos (caché ~60 s, por petición) retira algo:

| Lo que se pierde | Qué ve el usuario | Notificación |
|---|---|---|
| Un botón / acción | Desaparece en el siguiente render. | Ninguna. |
| Un bloque del tablero o una sección del menú | Desaparece; la rejilla/menú se reacomoda (§2, §4). | Ninguna. |
| **La página entera en la que está** | La guarda re-evalúa y pinta **«No tienes acceso a <sección>»** en el sitio (misma URL, sin redirigir), con foco al título. | **Ninguna toast**: la pantalla ya es el aviso persistente. |
| La acción **mientras la ejecutaba** (envió y el API respondió 403) | El formulario/modal conserva lo escrito; no se cierra solo. | **Toast de error**, cerrable, ≥ 6 s: «Ya no tienes permiso para esta acción. Pídele a un administrador que te la habilite.» Nunca el mensaje crudo del API. |

Sin efectos: nada se desvanece ni se anima al desaparecer; simplemente no se pinta.

Si el usuario tenía escrito algo en un formulario de la página perdida, se pierde con la página: no se
diseña rescate de borradores en esta HU (fuera de alcance; si el PO lo quiere, es otra conversación).

---

## 4. Menú

- Un encabezado de sección (`SECTION_LABEL`) se pinta solo si tiene **≥ 1 ítem visible**
  (`navItemPermitido`). Mismo criterio en la paleta ⌘K si agrupa por sección.
- Visibilidad del ítem = permiso de página. El filtro `roles` de `NAV_ITEMS` sale (alcance del Feature
  #12871 / AC10 de esta HU); el menú no consulta el nombre del rol.
- Si la sección activa del path actual queda vacía, no se resalta nada; el usuario está ya en «sin
  acceso» (§3).
- Menú con solo «General» (Tablero, Ayuda): válido, sin mensaje extra.
- Móvil: mismo criterio en el cajón; nada nuevo.

---

## Permiso/slug

Sin slug nuevo. `NoAccess` no tiene slug (es estado de la guarda). Tablero: `dashboard` (existente) +
el permiso de página de cada destino (tabla de §2). `FlitoTablero`: `tablero.tablero.ver` (existente).

---

## Notas para QA (≤10)

1. URL directa a una página sin permiso → «No tienes acceso a <sección>», con menú, sin la palabra
   «rol» ni nombre de rol en ningún texto; «Volver al tablero»/«Ir a <inicio>» lleva a una página que sí abre.
2. Recarga dura en una página con permiso: no hay destello de «sin acceso» antes de que llegue la
   página (cargando = esqueleto).
3. Falla la carga de permisos (red cortada) → aviso con Reintentar, **no** «sin acceso».
4. Usuario solo con PESV: tablero con 2 atajos, sin columna vacía ni KpiCards; DevTools → no hay
   peticiones a `/soat/stats`, `/fleet/...` ni `/rndc/...`.
5. Usuario sin ningún bloque: tarjeta de vacío con el copy de §2, sin «0» sueltos.
6. Forzar 500 en `/rndc/manifiestos`: el bloque RNDC muestra error + Reintentar; SOAT y Flota siguen con datos; RNDC **no** dice «OK».
7. Quitar el permiso de la página abierta y esperar el refresco: aparece «sin acceso» en sitio, sin toast.
8. Quitar el permiso de una acción y enviarla con el formulario abierto: toast cerrable con el copy de §3, lo escrito se conserva.
9. Menú: con permisos de una sola sección, ningún encabezado vacío (escritorio, cajón móvil y ⌘K).
10. Tablero y «sin acceso» a 360 px y en tema oscuro: una columna, sin desborde; primaria con hover visible y foco por teclado.

---

## Decisiones y descartes

- **Reusar `NoAccess`**, no pantalla nueva: ya cumple estructura, foco y salida; el defecto era el
  copy (nombra el rol) y el hover inválido.
- **Tú, no usted**: las tres superficies tutean hoy; mezclar sería peor que el ejemplo del pedido.
- **Bloque = permiso del destino**: un indicador que lleva a una página que no abres es un callejón.
  Evita una matriz bloque↔permiso aparte.
- **Ocultar, no deshabilitar** bloques/ítems sin permiso: un candado gris invita a pedir lo que no es de
  su trabajo y satura.
- **Sin toast al perder la página**: la pantalla «sin acceso» es el aviso persistente; un toast
  duplicaría.
- **Errores visibles por bloque**: hoy `allSettled` + `catch` silencioso pintan «0»/«OK»; eso cumple
  «4 estados» de forma falsa.
- **Notas fuera de alcance (no se tocan en esta HU, para el PO):** `useCountUp` (conteo animado) y
  el `transition-transform`/`scale` de la primaria son adorno según `_principios-flito.md`; y el
  tablero usa `bg-white` y `rgba` sueltos que no tienen par oscuro. Si el frontend reescribe un bloque
  por este delta, ese bloque nuevo usa la superficie de tarjeta del kit con par oscuro; el resto queda
  como deuda declarada.
