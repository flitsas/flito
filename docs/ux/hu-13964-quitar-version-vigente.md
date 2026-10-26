# UX slim — Expediente documental: quitar la versión vigente (HU #13964)

Módulo `flito-bolsas` (detalle de bolsa de compañía, sección «Documentos»). Público: operador
interno (admin, gestión de bolsas). Extiende `FilaDocumento.tsx`, `HistorialDocumento.tsx` y el
modal del kit (`FlitModal`). Sin ruta ni `PageSlug` nuevos.

**Trabajo de esta visita:** el operador ve que el archivo vigente está mal (otra compañía, otro
documento, ilegible) y quiere dejar la fila como pendiente **sin perder la traza**. Lo que se ve
primero no cambia: el nombre del documento, su estado y «Cargar/Reemplazar».

## Superficie tocada

### 1. Dónde vive la acción: botón secundario en la fila (recomendado)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Cámara de comercio  (● Vigente)            [⤒ Reemplazar] [⬇] [Historial ▾] [Quitar] │
│ Expedida el 02/10/2026 · vigente hasta el 01/11/2026  [Corregir]             │
└──────────────────────────────────────────────────────────────────────────────┘
```

- `flitBtnSecondarySm` (h-7, la misma altura que el resto de la barra), texto **«Quitar»**, sin
  icono y con la tinta neutra del kit. Va **al final** de la barra, lejos de «Reemplazar», para
  que no se pulse por error.
- **Por qué no es rojo en la fila:** el expediente tiene 5 o más filas. Un botón de peligro en cada
  una es ruido rojo permanente para una acción ocasional. El peso de peligro va en la confirmación
  del modal, que es donde se decide.
- **Por qué no es un menú «⋯»:** el kit no tiene menú de fila. Sería un patrón nuevo (teclado,
  foco, cierre) para esconder **una** sola acción. Si llega una segunda acción ocasional, se
  reevalúa.
- **La primaria de la fila no cambia:** sigue siendo «Cargar/Reemplazar».
- **Se muestra si** `puedeCargar` (permiso `bolsas.documentos.cargar` **y** bolsa activa: AC5,
  AC6) **y** `vigente !== null` **y** `estado !== 'pendiente'`. Se ofrece también en «Validando…».
  Mientras la fila sube un archivo (`subiendo`), el botón queda `disabled`.

### 2. Modal de confirmación (`FlitModal`, compacto)

```
┌─ ¿Quitar la versión vigente? ──────────────────────── ✕ ┐
│ La Cámara de comercio queda pendiente hasta que cargues │
│ una nueva. La versión 3 se conserva en el historial     │
│ como retirada y la puedes seguir descargando.           │
│ El expediente de la compañía queda incompleto.          │  ← solo si !doc.opcional
│                                                         │
│ Motivo (opcional)                                       │
│ ┌─────────────────────────────────────────────────────┐ │
│ │                                                     │ │
│ └─────────────────────────────────────────────────────┘ │
│ Queda registrado en el historial.              0/300    │
│                                                         │
│ [!] <error en línea, si lo hay>                         │
│                              [Cancelar] [Quitar versión]│
└─────────────────────────────────────────────────────────┘
```

- La única primaria del modal es **«Quitar versión»**: clases de `flitBtnPrimary` con
  `background: var(--flit-gradient-danger)`. Ese token ya existe y ya se usa en botones de peligro
  (`AlcoholTests`, `MiJornada`). «Cancelar» usa `flitBtnSecondary`.
- El textarea lleva `maxLength={300}`. El contador va como texto plano, sin `aria-live`.

## Delta de claridad (qué se ve / qué se calla)

- **Fila tras quitar (AC1):** queda el chip «Pendiente» y «Sin cargar.», con «Cargar» como
  primaria y el botón «Historial», que **se sigue viendo** aunque ya no haya vigente. No se añade
  aviso en la fila: el toast cuenta el resultado y el historial guarda la traza.
- **Historial (AC1, AC2), comparado con la versión reemplazada:**

```
Versión 4 · vigente                                                     [⬇]
  Cargada por ana.ruiz el 20/10/2026 10:12
Versión 3 · retirada el 18/10/2026                                      [⬇]
  Cargada por luis.p el 02/10/2026 09:40 · expedida el 01/10/2026
  Retirada por ana.ruiz el 18/10/2026 16:05
  Motivo: «Era el certificado de otra compañía.»
Versión 2 · reemplazada el 02/10/2026                                   [⬇]
  Cargada por luis.p el 15/09/2026 11:03 · expedida el 14/09/2026
```

  - En la cabecera de la versión cambia la palabra: `retirada el <dd/mm/aaaa>` en lugar de
    `reemplazada el …`. Mismo peso tipográfico y sin chip nuevo: el historial hoy es solo texto y
    así sigue.
  - Una línea más en `--flit-text-secondary`: `Retirada por <usuario> el <dd/mm/aaaa hh:mm>`. Se
    pinta con `fechaHora`, igual que «Cargada…». Si no hay usuario: `Retirada el …`.
  - El motivo, si lo hay, va en su propia línea: `Motivo: «…»`. Es texto plano con `break-words`
    y nunca `dangerouslySetInnerHTML`. Si el motivo viene vacío, la línea no aparece.
  - La descarga se mantiene (`archivoDisponible`). Si la retención borró el archivo, aplica el
    sufijo de hoy: «· archivo eliminado por retención».
- **Densidad:** la fila gana un botón de h-7 que envuelve. Hay más controles, pero no se apilan
  datos ni hay columna nueva. El historial suma 1–2 líneas solo en las versiones retiradas.

## Estados (4) + copy

### Tono: tú, no usted (decisión que se debe confirmar)

El pedido dice «usted», pero el expediente entero **tutea**: «Revisa el expediente», «Hiciste
muchas cargas», «Digítala», «puedes consultar». `_principios-flito.md` prohíbe mezclar
tratamientos en una pantalla, y en operador se calca el tono de esa pantalla. Por eso el copy de
abajo va en **tú**. Pasar a «usted» obligaría a cambiar el tono de todo el expediente, y eso es
otra HU: se le pregunta al PO.

### Copy exacto

| Elemento | Texto |
|---|---|
| Botón en la fila | `Quitar` |
| `aria-label` del botón | `Quitar la versión vigente de <nombre>` (p. ej. «…de la Cámara de comercio», con el `nombreDocumento` de hoy) |
| Título del modal | `¿Quitar la versión vigente?` |
| Cuerpo | `<Nombre> queda pendiente hasta que cargues una nueva. La versión <n> se conserva en el historial como retirada y la puedes seguir descargando.` |
| Cuerpo, 2.ª línea (solo si `!doc.opcional`) | `El expediente de la compañía queda incompleto.` |
| Label del textarea | `Motivo (opcional)` |
| Ayuda | `Queda registrado en el historial.` |
| Contador | `<n>/300` |
| Botones | `Cancelar` · `Quitar versión` · enviando: `Quitando…` |
| Toast de éxito (`toastOk`, 6 s, id `bolsa-doc-retiro-<tipo>`) | `<Nombre> quedó pendiente. La versión <n> queda en el historial como retirada.` |
| 409 / 404: carrera (AC7). Se cierra el modal y se lanza `toastError` cerrable de ≥6 s, sin «Reintentar», más `onCarrera()` | `Algo cambió mientras quitabas la versión: el documento o la bolsa se actualizaron. Ya refrescamos el expediente; revísalo e intenta de nuevo.` |
| 400: en el modal, `role="alert"` | `No pudimos guardar el motivo. Revisa que no pase de 300 caracteres e intenta de nuevo.` |
| 403: en el modal, `role="alert"` (se deshabilita «Quitar versión») | `Ya no tienes permiso para quitar documentos.` |
| 429: en el modal, `role="alert"` | `Hiciste muchos cambios seguidos. Espera unos minutos e intenta de nuevo.` |
| Red o 5xx: en el modal, `role="alert"` | `No pudimos quitar la versión. Revisa tu conexión e intenta de nuevo.` |

Nunca se muestra `e.message` ni el cuerpo del API. Se decide por `status` (`errorBolsa(e)`), como
en la carga.

### Estados del modal y de la acción

| Estado | Qué se ve | Foco |
|---|---|---|
| **Idle** | Modal abierto, motivo vacío, `0/300`, los dos botones activos | Entra en el textarea, que es el primer campo y no hace nada por sí solo |
| **Enviando** | «Quitar versión» → `Quitando…`, `disabled` + `aria-busy`. Textarea `readOnly`. «Cancelar» `disabled`. `FlitModal cierreBloqueado` (el ✕, Esc y el velo no cierran). Se limpia el error previo | Se queda en el botón |
| **Error** (400/403/429/red) | Modal abierto. Alerta en línea encima de los botones, en `--flit-danger-text`. El motivo se conserva. «Quitar versión» vuelve a estar activo y hace de reintento (salvo con 403) | Se queda en el botón. El `role="alert"` se anuncia solo |
| **Error de carrera** (409/404) | El modal se cierra, sale el toast de error y el expediente se refresca. La fila muestra lo que haya hoy | Vuelve a «Quitar» si sigue montado; si no, al control «Cargar/Reemplazar» de la fila |
| **Éxito** | El modal se cierra, sale el toast OK y la fila toma el DTO del API: «Pendiente», «Cargar» y «Historial». Si el historial estaba abierto, se relee y ya muestra «retirada» | Va al control «Cargar» de la fila (`cargaRef`, por `restoreFocusRef` del `FlitModal`), porque «Quitar» se desmonta |
| **Cancelar / ✕ / Esc / velo** | No hay petición ni cambios (AC8) | Vuelve a «Quitar» |

El vacío de este delta es la fila sin vigente: muestra «Sin cargar.» y ofrece «Cargar» como
siguiente paso, así que no hace falta copy nuevo. Los estados de carga y error del historial no
cambian.

## Responsive + feedback del delta

- **<`lg`:** la barra de la fila ya es `flex-wrap`, así que «Quitar» baja de línea con la misma
  altura (h-7). El modal es el `FlitModal` compacto (`p-4`). El pie va en `flex flex-wrap
  justify-end gap-2`, el textarea a ancho completo y el contador alineado a la derecha bajo él.
- **Hover/foco:** «Quitar» hereda `HOVER_SECUNDARIO` y `flit-focus` de `flitBtnSecondarySm`.
  «Quitar versión» tiene el velo inset de `flitBtnPrimary` y su estado deshabilitado. El textarea
  lleva el borde `--flit-border-input` y el foco `--flit-border-focus` de los inputs del kit.
- **Notificación:** el éxito y la carrera van en toast cerrable. Los errores que se corrigen o
  reintentan dentro del modal van en línea con `role="alert"`, no en toast. No hay aviso de página.
- **Tema oscuro:** solo tokens (`--flit-danger-text`, `--flit-text-secondary`,
  `--flit-gradient-danger`). Hay que verificarlo en los dos temas.

## A11y

- Foco al abrir: el textarea. Al cerrar sin cambios: «Quitar». Tras el éxito: «Cargar» de la
  fila (respaldo `restoreFocusRef`). Nunca `<body>`.
- Esc cierra solo el modal (el `FlitModal` ya atiende solo al de más arriba). No cierra durante
  el envío.
- `<label for>` → «Motivo (opcional)». El textarea lleva
  `aria-describedby="<id-ayuda> <id-contador>"` y, si hay error, también `aria-invalid` + el id de
  la alerta.
- El nombre accesible del botón incluye el documento, porque hay un «Quitar» por fila.

## Permiso/slug

Sin slug nuevo: es la página del detalle de bolsa de hoy. La acción depende de
`bolsas.documentos.cargar` y de la bolsa activa, igual que «Cargar/Reemplazar». Roles: los que
hoy tienen esa función. El API valida lo mismo, porque el botón oculto no es la seguridad.

**Datos que hacen falta (para architecture/backend, sin inventar la ruta):**
1. Endpoint de retiro, escritura autenticada. Recibe en el body el id de la versión vigente y
   `motivo?` (≤300). Devuelve 409 si esa versión ya no es la vigente o si la bolsa está inactiva.
   Devuelve el `DocumentoBolsaDto`/expediente actualizado para que la fila no tenga que releer.
2. `DocumentoBolsaVersionDto` + `retiradoEn`, `retiradoPor` y `motivoRetiro` (o un estado de
   versión `vigente | reemplazada | retirada`).
3. `DocumentoExpedienteDto` + un indicador de que hay historial (p. ej. `tieneHistorial`). Hoy
   «Historial» solo se pinta si hay `vigente`: sin ese dato, la versión retirada quedaría
   inalcanzable y fallaría el AC1.

## Notas para QA

- AC5/AC6: no hay botón «Quitar» con la bolsa inactiva ni sin `bolsas.documentos.cargar`. Tampoco
  en una fila «Pendiente».
- Sí aparece con el documento «Validando…».
- AC8: Cancelar, ✕, Esc y el velo no lanzan petición (comprobar en la pestaña de red) y la fila
  no cambia.
- El contador llega a 300 y no deja escribir más. Un motivo vacío se envía sin motivo y en el
  historial no sale la línea «Motivo».
- AC1: tras confirmar, la fila queda «Pendiente» con «Cargar», el «Historial» sigue visible, la
  versión aparece como «retirada el …» (no «reemplazada») y se puede descargar.
- AC2: aparece «Retirada por <usuario> el dd/mm/aaaa hh:mm» y el motivo literal. Un motivo con
  `<b>` sale como texto.
- AC7: forzar el 409 (retirar desde dos pestañas) da un toast cerrable con el copy pulido, sin
  texto del API, y el expediente se refresca.
- Con la red caída, el error queda en el modal, el motivo se conserva y reintentar funciona.
- Foco: al cancelar vuelve a «Quitar»; tras el éxito va a «Cargar» de la misma fila.
- A 375 px, la barra envuelve sin desbordar. Revisar el modal en tema claro y oscuro.
