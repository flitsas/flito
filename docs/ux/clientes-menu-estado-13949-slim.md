# UX slim — Clientes: menú ⋮ de la fila para desactivar y activar (HU #13949)

Feature #13939 · `apps/web/src/pages/Clients.tsx`, pestaña **Clientes** (`TabClientes`) · Módulo
**legacy** `clients` (`/api/clients`), sin prefijo `flito-`. Extiende el slim de #13948
(`docs/ux/clientes-estado-filtro-13948-slim.md`): la columna Estado y el filtro no cambian.
Menú y diálogo se diseñan para que **Proveedores** (#13961/#13962) los use tal cual.

Público: operador interno (Administrador). **Qué vino a hacer:** sacar de operación a una
compañía, o volver a ponerla en operación, sabiendo antes qué deja abierto. Tratamiento **usted**.

## Superficie tocada

| Superficie | Cambio |
|---|---|
| Celda de acciones de cada fila (la última `FlitTh` vacía) | Botón ⋮ **al final**, después de «Tarifas» y «Datos fiscales» |
| Nuevo `components/flit/MenuFila.tsx` | Menú de acciones de fila (no existe en el kit; ver Decisiones) |
| Nuevo `components/clientes/DialogoEstadoRegistro.tsx` | Diálogo de desactivar / activar sobre `FlitModal` |

Datos (ya existen, #13945): `GET /api/clients/:id/impacto` → `{ activo, procesosAbiertos: { soat,
impuestos, tramites, liquidaciones }, saldoBolsa, usuariosAfectados, puedeEliminar,
motivoNoEliminable }` · `PATCH /api/clients/:id/estado` body `{ activo, activoEsperado }`.
Sin endpoint nuevo.

## Delta de claridad (qué se ve / qué se calla)

```
 Empresa       Estado       …  Facturación                      
 Acme S.A.S.   [Activo]     …  …          [Tarifas] [Datos fiscales] [⋮]
                                                                 ┌──────────────┐
                                                                 │ Desactivar   │
                                                                 │ ──────────── │ ← hueco #13956
                                                                 │ (Eliminar)   │   (no se pinta aún)
                                                                 └──────────────┘
```

- **⋮:** botón de icono, 40 px (`h-10 w-10`, misma altura que «Datos fiscales»), `flit-focus`,
  hover `--flit-bg-hover`, `aria-label="Acciones de {nombre de la compañía}"`,
  `aria-haspopup="menu"`, `aria-expanded`. Icono `aria-hidden`.
- **Opciones según estado:** activo → **Desactivar**; inactivo → **Activar**. Nunca las dos.
  Eliminar (#13956) va **debajo**, separado por un divisor y con tinta de peligro; en esta HU no
  se pinta.
- **Visible solo** con `hasFuncion('clients.clientes.estado') || hasFuncion('clients.clientes.eliminar')`.
  Desactivar/Activar exigen `clients.clientes.estado`. `MenuFila` **no se pinta si no tiene
  opciones**: quien hoy tenga solo `eliminar` no ve un ⋮ vacío; lo verá cuando #13956 sume su opción.
- Panel del menú: mismo aspecto que el menú de usuario de `FlitTopbar` (`bg-flit-card`,
  `--flit-radius-md`, `--flit-border-soft`, `--flit-shadow-card`; ítems `px-3 py-2 text-sm`,
  hover `--flit-bg-hover`). Alineado al borde derecho del ⋮, abre hacia abajo; si no cabe, hacia
  arriba. Colgado en portal para que el scroll horizontal de `FlitTable` no lo recorte.
- **Se calla:** saldo de la bolsa y `puedeEliminar` (son de #13956, no de esta visita); quién
  cambió el estado y cuándo (el API no lo trae).

**Densidad:** +1 botón de icono por fila; sin columna nueva. **Primaria de la página:** sin cambio
(«Nuevo cliente»). Dentro de cada diálogo hay **una** primaria (ver abajo).

### Diálogo «Desactivar» — `FlitModal`, título `Desactivar «{nombre}»`

```
┌ Desactivar «Acme S.A.S.» ───────────────────────── ✕ ┐
│ Este cliente tiene 3 SOAT, 2 trámites en curso.      │  ← AC1 (o «No tiene procesos en curso.», AC2)
│ Mientras esté inactivo no recibirá SOAT, impuestos   │
│ ni trámites nuevos.                                  │
│ Se cerrará la sesión de sus 4 usuarios.              │  ← solo si usuariosAfectados > 0
│                                                      │
│ [⚠ alerta del error, si hay]                         │
│                          [ Cancelar ] [ Desactivar ] │
└──────────────────────────────────────────────────────┘
```

**Formato del conteo** (función pura `fraseProcesos(p)`, exportada para test): solo los tipos con
n > 0, en este orden: SOAT · impuestos · trámites · liquidaciones; unidos con «, » (sin «y», como
el AC1). Singular/plural: `1 SOAT`/`N SOAT` · `1 impuesto`/`N impuestos` · `1 trámite`/`N trámites` ·
`1 liquidación`/`N liquidaciones`. Frase: `Este cliente tiene {lista} en curso.` Todo en 0 →
`No tiene procesos en curso.` Usuarios: `Se cerrará la sesión de su usuario.` (1) /
`… de sus N usuarios.` (N); con 0 la línea no se pinta. Números en texto, nunca solo color.

Botones: **Cancelar** (`flitBtnSecondary`, foco inicial — acción con consecuencia, Intro por
inercia no la ejecuta) · **Desactivar** = la primaria del diálogo, con peso de peligro:
`flitBtnSecondary` + borde `--flit-danger` + tinta `--flit-danger-ink` (patrón de
`siigo/credenciales/DialogoDesactivar.tsx`, **pero** fondo `bg-flit-card`, no `bg-white`).
En vuelo: «Desactivando…», deshabilitado, `cierreBloqueado` en el `FlitModal`.

### Diálogo «Activar» — título `Activar «{nombre}»`

Sin llamada de impacto (no hay nada que advertir). Cuerpo: «Vuelve a recibir SOAT, impuestos y
trámites, y se liberan los trámites que quedaron retenidos mientras estuvo inactivo.» Botones:
**Cancelar** · **Activar** (`flitBtnPrimary`, foco inicial en Activar: no es destructiva). En
vuelo: «Activando…».

## Estados (4) + copy

Diálogo Desactivar (lo único con datos nuevos):

| Estado | Qué se ve | Desactivar |
|---|---|---|
| Cargando impacto | Una línea `role="status"` «Revisando procesos en curso…» en el sitio de la frase (sin spinner genérico) | Deshabilitado |
| Error del impacto | `role="alert"` «No pudimos revisar los procesos en curso de este cliente.» + `flitBtnSecondarySm` **Reintentar** (vuelve a pedir el impacto). 403 → «No tiene permiso para esta acción.» sin Reintentar | Deshabilitado: no se desactiva a ciegas |
| Vacío (todo en 0) | «No tiene procesos en curso.» (AC2) | Habilitado |
| Lleno | Frase del conteo + línea de usuarios | Habilitado |

Lista: al confirmar **no hay cambio optimista**; la fila cambia solo con la respuesta 2xx. La
recarga tras éxito o 409 es **silenciosa** (sin pasar por «Cargando compañías…», sin perder el
filtro).

### Resultado de confirmar (los dos diálogos)

| Respuesta | Dónde | Copy | Efecto |
|---|---|---|---|
| 2xx | **Toast** `toastOk` (~4 s, cerrable) | «Cliente desactivado.» / «Cliente activado.» (AC1/AC3) | Cierra el diálogo; la fila pasa a Inactivo/Activo |
| 409 (AC5) | **Toast** `toastError` (cerrable, ≥6 s, sin Reintentar) | «Otro administrador ya cambió su estado.» | Cierra el diálogo y recarga la lista: la fila muestra el estado real |
| 404 | **Toast** `toastError` | «Este cliente ya no existe. Se actualizó la lista.» | Cierra y recarga |
| Red caída (AC6) | **En el diálogo**, `role="alert"` | «No pudimos conectar con FLITO. Revise su conexión e inténtelo de nuevo.» | El botón de confirmar pasa a decir **Reintentar** (sigue siendo la única primaria); la fila no cambia |
| 403 (AC7) | **En el diálogo**, `role="alert"` | «No tiene permiso para esta acción.» | Se oculta el botón de confirmar; queda solo **Cancelar** |
| Otro (5xx…) | **En el diálogo**, `role="alert"` | «No pudimos cambiar el estado del cliente. Inténtelo de nuevo.» | Confirmar pasa a **Reintentar** |

Nunca `errorMessage(e)` ni el texto crudo del API. Cancelar, ✕, Esc o clic en el velo: cierra
sin llamar al PATCH y sin toast (AC4); si el impacto estaba en vuelo, su respuesta se descarta.

## Responsive + feedback del delta

- **<lg:** el ⋮ vive en la celda de acciones dentro del scroll horizontal de `FlitTable` (la celda
  no envuelve). El panel del menú, en portal, se recoloca para no salirse del viewport (abre a la
  izquierda del ⋮, `max-w-[calc(100vw-2rem)]`). El diálogo es `FlitModal` compacto (`max-w-md`,
  ancho completo menos el padding en 360 px); la fila de botones `flex-wrap justify-end`.
- **Feedback:** ⋮ e ítems del menú con hover `--flit-bg-hover` + `flit-focus`; el ítem resaltado
  por teclado se ve igual que el hover. Botones de los diálogos: los del kit. Sin animación de
  apertura del menú.
- **Notificación:** resultado final = toast (una frase); errores que permiten corregir o reintentar
  = alerta en el diálogo. Un solo aviso por acción.

### Foco y teclado (AC8)

- ⋮ cerrado: Enter / Espacio / ↓ abren y enfocan el primer ítem; ↑ abre y enfoca el último.
- Menú abierto: ↑/↓ mueven (circular), Inicio/Fin, Enter/Espacio eligen, **Esc** cierra y devuelve
  el foco al ⋮; Tab cierra el menú y sigue el orden normal; clic fuera cierra. Ítems
  `role="menuitem"`, `tabIndex=-1`, foco móvil (roving).
- Al elegir: el menú se cierra, el foco vuelve al ⋮ y **luego** abre el diálogo — así la trampa de
  `FlitModal` restaura al ⋮ al cerrar.
- `restoreFocusRef` de respaldo: si la fila sale del filtro tras el cambio (p. ej. filtro
  «Activos» y se desactiva), el ⋮ ya no existe; el foco va a la pill marcada del filtro Estado
  (`FiltroEstadoPills` expone su ref), nunca a `<body>`.

## Componentes reutilizables (para #13961/#13962 y #13956)

```ts
// components/flit/MenuFila.tsx — genérico, sin dominio.
export interface OpcionMenuFila {
  id: string;
  texto: string;                    // «Desactivar», «Activar», «Eliminar»
  onElegir: () => void;
  tono?: 'normal' | 'peligro';      // peligro: tinta --flit-danger-ink, separado por divisor arriba
}
export function MenuFila(props: {
  etiqueta: string;                 // aria-label del ⋮: «Acciones de Acme S.A.S.»
  opciones: OpcionMenuFila[];       // vacío → no se pinta nada
}): JSX.Element | null;

// components/clientes/DialogoEstadoRegistro.tsx — mismo diálogo para cliente y proveedor.
export interface ProcesosAbiertos { soat: number; impuestos: number; tramites: number; liquidaciones: number }
export function fraseProcesos(p: ProcesosAbiertos): string;   // «Este cliente tiene …» / «No tiene procesos en curso.»
export function DialogoEstadoRegistro(props: {
  accion: 'desactivar' | 'activar';
  nombre: string;
  sustantivo: 'cliente' | 'proveedor';       // títulos, toasts («Cliente activado.») y textos
  cargarImpacto?: () => Promise<{ procesosAbiertos: ProcesosAbiertos; usuariosAfectados: number }>; // solo desactivar
  consecuencia: string;                      // la línea «Mientras esté inactivo…» / «Vuelve a recibir…»: difiere en Proveedores
  confirmar: () => Promise<void>;            // el PATCH con { activo, activoEsperado }
  onHecho: () => void;                       // éxito: toast + recarga silenciosa (lo hace la pestaña)
  onDesactualizado: (motivo: 'cambiado' | 'no-existe') => void; // 409 / 404
  onCerrar: () => void;
  restoreFocusRef: RefObject<HTMLElement | null>;
}): JSX.Element;
```

La clasificación del error (409/404/red/403/otro → fila de la tabla de resultados) vive en el
diálogo; las llamadas a `api.ts` las pasa cada pestaña. `sustantivo` cubre «Este cliente / Este
proveedor». Proveedores decide su propio `cargarImpacto` (si su API no lo trae, se omite y el
diálogo se comporta como Activar sin frase de procesos).

## Permiso/slug

- Página y `PageSlug` de Clientes sin cambio. ⋮ con `clients.clientes.estado` **o**
  `clients.clientes.eliminar`; opciones Desactivar/Activar con `clients.clientes.estado`. Quien
  solo ve («Ver clientes y proveedores») no ve el ⋮.
- Sin PII nueva: el nombre de la compañía va en texto y `aria-label` (no es PII de persona); nada
  en URL.

## Notas para QA (≤10)

1. AC1: activo con 3 SOAT y 2 trámites → «Este cliente tiene 3 SOAT, 2 trámites en curso.»; confirmar → chip Inactivo + toast «Cliente desactivado.»
2. AC2: todo en 0 → «No tiene procesos en curso.»; con 1 trámite → «1 trámite» (singular).
3. Impacto lento: «Revisando procesos en curso…» y Desactivar deshabilitado; fallo → alerta + Reintentar del impacto.
4. AC3: inactivo → solo «Activar» en el ⋮; confirmar → Activo + «Cliente activado.»; sin llamada a `/impacto`.
5. AC4: Cancelar / ✕ / Esc / velo en ambos diálogos → sin PATCH, sin toast, fila igual.
6. AC5: forzar 409 → toast «Otro administrador ya cambió su estado.», diálogo cerrado, fila con el estado real, sin «Cargando».
7. AC6: red caída al confirmar → alerta en el diálogo, botón «Reintentar», chip sin cambio. AC7: 403 → «No tiene permiso para esta acción.», solo Cancelar.
8. AC8: ⋮ abre con Enter/Espacio/↓, flechas recorren, Esc cierra y vuelve al ⋮; en el diálogo Tab no sale; al cerrar, foco en el ⋮ (o en la pill del filtro si la fila desapareció).
9. Lector: ⋮ se anuncia «Acciones de {compañía}, menú contraído»; usuario solo con ver no tiene ⋮.
10. Claro y oscuro: menú, botón de peligro y alertas con contraste ≥ 4.5:1; 360 px: menú dentro del viewport, botones del diálogo envuelven.

## Decisiones y descartes

- **`MenuFila` nuevo en `flit/`:** el kit no tiene menú de fila. El de `FlitTopbar` tiene el aspecto
  pero no flechas ni roving focus (AC8) y está atado al usuario; se calca su estilo, no se clona.
  Va en `flit/` porque Proveedores, y luego otras bandejas, lo necesitan.
- **No `window.confirm`:** la pregunta lleva conteo, usuarios y estados de error.
- **Desactivar no se habilita sin impacto:** el diálogo existe para decidir con el dato; si no se
  pudo leer, se reintenta.
- **409/404 en toast y no en el diálogo:** la acción ya no tiene sentido (el estado cambió); se
  cierra, se recarga y se dice una vez. Red/403/5xx sí quedan en el diálogo porque se puede
  reintentar o hay que entender por qué no.
- Copy de consecuencia verificado contra RN-CLI-3/4 y #13947 (no recibe SOAT/impuestos/trámites
  nuevos; sesiones cerradas; retenidos liberados). No se promete «no podrán entrar» porque
  `users.active` no cambia y no se verificó el bloqueo de login.
- Sin animaciones, sin ilustraciones; el peligro se dice con tinta y texto, no con un rojo sólido.
