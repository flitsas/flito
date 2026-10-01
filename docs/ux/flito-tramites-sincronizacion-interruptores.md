# UX slim — Gestión Trámites · sección «Sincronización» con interruptor por fuente (HU #13238)

Feature #13236 · Épica #12736 · módulo **FLITO** (`flito-sync`, `/api/flito/sync/*`). Contrato: HU #13237,
`docs/diseno/hu-13237-interruptor-sincronizacion.md`. Página existente `FlitoTramites.tsx`, sin slug nuevo.
Público: operador interno (Administrador y equipo de Trámites). El tono de la pantalla es **tú** («Revisa»,
«Pídele»); aquí se mantiene.

---

## Superficie tocada

Solo la **zona de sincronización**: hoy está repartida en las `actions` de `PageHeaderCard` (última
actualización, «Elegir fecha», «Desde», «Sincronizar FLIT», línea de FLIT 2, «Acceso a FLIT 2») y en dos
tarjetas sueltas debajo (`AvisoEstadoFlit2`, resumen de la sincronización). Fuera: tabla, filtros, barra de
selección, «+ Trámite demo» (se queda en la cabecera, igual que hoy) y la tarjeta `error` de la página para
las demás acciones.

**Qué vino a hacer quien abre esto:** gestionar trámites. La sincronización es la segunda pregunta de la
visita: «¿están entrando trámites de cada fuente, y si no, por qué?». Quien tiene permiso, además, la
enciende o la apaga.

---

## Delta de claridad (qué se ve / qué se calla)

### Antes → después

| Antes | Después |
|---|---|
| Siete piezas de dos fuentes mezcladas en la cabecera, sin rótulo de a qué fuente pertenece cada una | Una tarjeta **«Sincronización»** bajo la cabecera, con **dos grupos**: FLIT 1 y FLIT 2 |
| La cabecera tenía una primaria de sincronización compitiendo con su propio título | La cabecera queda con el título, el subtítulo y «+ Trámite demo» |
| Aviso de FLIT 2 y resumen de la sincronización flotando entre la cabecera y la tabla | Cada aviso vive **dentro del grupo de su fuente** |

La densidad **mejora**: no se añade ninguna pieza que no exista hoy, salvo el interruptor y su motivo.

### Orden de cada grupo (mismo esqueleto en los dos)

1. **Fila de cabecera:** nombre de la fuente (`h3`) a la izquierda; interruptor + estado en texto («Encendida» / «Apagada») a la derecha.
2. **Línea de estado:** el dato que se vino a ver.
   - FLIT 1: «Última actualización».
   - FLIT 2: «Última lectura FLIT 2» + el indicador en vivo, que ya existe.
3. **Motivo / aviso** (solo si aplica; aviso de página, `role="status"`, o `role="alert"` para las alertas de FLIT 2 que ya existen).
4. **Barra de acciones**, pegada al fondo del grupo (`mt-auto`) para que las dos barras queden alineadas a 1366. La acción principal del grupo va **al final** de la barra en los dos grupos.

### Qué se calla

- **Quién y cuándo cambió el interruptor:** solo con `tramites.sincronizacion.configurar`, en una línea muted bajo el interruptor. Sin el permiso no se pide (el GET da 403).
- El desglose numérico de la sincronización de FLIT 1 deja de ser una tarjeta permanente y pasa a un toast de una frase (ver Notificaciones).
- `automatica.proximaEn` con FLIT 2 apagada: se oculta la cuenta del indicador (riesgo 2 del diseño). Mostrar «próxima lectura en 3:12» de una lectura que no va a leer sería mentir.

### Primaria por grupo

| Grupo | Acción principal | Peso | Secundarias |
|---|---|---|---|
| FLIT 1 | **Sincronizar FLIT** | `flitBtnPrimary` (la **única** primaria de toda la zona) | «Elegir fecha» (casilla), «Desde» (fecha) |
| FLIT 2 | **Acceso a FLIT 2** | `flitBtnSecondary` | ninguna. «Probar conexión» sigue dentro del modal de Acceso |

**Decisión:** la HU pide «una sola acción primaria por grupo». FLIT 2 no tiene acción de la visita (la
lectura es automática desde la HU #13189), y su acción principal es de configuración. Si se pinta con peso
`flitBtnPrimary` quedan dos primarias en la misma superficie, que es un fallo de oficio (principios §Una
primaria). Por eso «Acceso a FLIT 2» es la acción principal del grupo **por posición** (al final de la barra,
alineada con «Sincronizar FLIT»), pero con peso secundario.

El interruptor **no** es un botón de acción: es un control de estado y no compite por la primaria.

---

## Wireframe — 1366 (claro y oscuro igual; solo cambian los tokens)

```
┌ PageHeaderCard ─────────────────────────────────────────────────────────────────────────────┐
│ Gestión Trámites                                                         [ + Trámite demo ] │
│ Centro de gestión de los trámites de FLIT: …                                               │
└────────────────────────────────────────────────────────────────────────────────────────────┘
┌ FlitCard · <section aria-labelledby="sync-titulo"> ────────────────────────────────────────┐
│ Sincronización                                                                (h2)         │
│ Cada fuente trae trámites a FLITO en este ambiente. Apagarla detiene la entrada; lo que    │
│ ya entró no cambia.                                                                        │
│ ┌ grupo FLIT 1 ───────────────────────────────┐ ┌ grupo FLIT 2 ────────────────────────────┐│
│ │ FLIT 1 (h3)              (●━━) Encendida    │ │ FLIT 2 (h3)             (●━━) Encendida  ││
│ │                Apagada por Ana Pérez el …   │ │                                          ││
│ │ Última actualización                        │ │ Última lectura FLIT 2                    ││
│ │ 1 oct. 2026, 3:20 p. m.                     │ │ 1 oct. 2026, 3:25 p. m. · próxima en 3:12││
│ │                                             │ │ ┌ aviso (status/alert) ────────────────┐ ││
│ │                                             │ │ │ (solo si aplica: apagada / alertas)  │ ││
│ │                                             │ │ └──────────────────────────────────────┘ ││
│ │ [☐ Elegir fecha] [Desde ▢ dd/mm/aaaa]       │ │                                          ││
│ │                         [ Sincronizar FLIT ]│ │                       [ Acceso a FLIT 2 ]││
│ └─────────────────────────────────────────────┘ └──────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────────────────────────────┘
  (barra de selección · filtros · tabla: sin cambio)
```

FLIT 1 apagada (1366, grupo izquierdo):

```
│ FLIT 1 (h3)                (━━○) Apagada    │
│                 Apagada por Ana Pérez el …  │
│ Última actualización                        │
│ 1 oct. 2026, 3:20 p. m.                     │
│ ┌ aviso role=status ──────────────────────┐ │
│ │ FLIT 1 está apagada: no entran trámites │ │
│ │ de FLIT 1 y «Sincronizar FLIT» no está  │ │
│ │ disponible. Enciéndela con el           │ │
│ │ interruptor para volver a sincronizar.  │ │
│ └─────────────────────────────────────────┘ │
│                   [ Sincronizar FLIT ] (aria-disabled, describedby → aviso)
```

Con el **maestro** apagado e interruptor encendido (grupo FLIT 2): el texto de estado dice «Encendida ·
apagada en el servidor» (envuelve debajo del interruptor si no cabe). El aviso «maestro» ocupa el lugar del
aviso. La línea de estado cambia «próxima en m:ss» por «Lectura detenida».

## Wireframe — 375 (sin scroll horizontal)

```
┌ PageHeaderCard ───────────────┐
│ Gestión Trámites              │
│ Centro de gestión de …        │
│ [ + Trámite demo ]            │   ← acciones bajo el título (ya lo hace el kit)
└───────────────────────────────┘
┌ Sincronización ───────────────┐
│ Cada fuente trae trámites …   │
│ ┌ FLIT 1 ───────────────────┐ │
│ │ FLIT 1     (●━━) Encendida│ │
│ │ Apagada por Ana Pérez …   │ │   ← línea quién/cuándo envuelve a ancho completo
│ │ Última actualización      │ │
│ │ 1 oct. 2026, 3:20 p. m.   │ │
│ │ [☐ Elegir fecha]          │ │
│ │ [Desde ▢ dd/mm/aaaa     ] │ │   ← fecha flex-1 min-w-0
│ │ [    Sincronizar FLIT    ]│ │   ← w-full sm:w-auto
│ └───────────────────────────┘ │
│ ┌ FLIT 2 ───────────────────┐ │
│ │ FLIT 2     (●━━) Encendida│ │
│ │ Última lectura FLIT 2     │ │
│ │ 1 oct. 2026, 3:25 p. m.   │ │
│ │ ┌ aviso (si aplica) ────┐ │ │
│ │ └───────────────────────┘ │ │
│ │ [    Acceso a FLIT 2     ]│ │   ← w-full sm:w-auto
│ └───────────────────────────┘ │
└───────────────────────────────┘
```

**Responsive (<`lg`):**
- La rejilla de grupos es `grid grid-cols-1 lg:grid-cols-2 gap-4`: en móvil, FLIT 1 arriba y FLIT 2 debajo.
- Cada fila del grupo es `flex flex-wrap items-center justify-between gap-x-3 gap-y-2`, y las barras envuelven.
- Los botones del final de cada barra son `w-full sm:w-auto`.
- Ningún control lleva `min-w`. El texto de estado del interruptor y la línea quién/cuándo usan `break-words`.
- La cabecera apila «+ Trámite demo» bajo el título, como ya hace el kit.

---

## Estados (4) + copy

La sección se pinta si el usuario tiene **al menos una** de estas funciones: `sync.sync.ver_estado`,
`sync.sync.lanzar` o `tramites.sincronizacion.configurar`. Sin ninguna, no se pinta: no hay nada que ver,
así que tampoco hay vacío.

**De dónde sale cada dato**

| Dato | Con `tramites.sincronizacion.configurar` | Sin ella |
|---|---|---|
| Valor del interruptor + quién/cuándo | `GET /api/flito/sync/interruptores` | — (no se llama) |
| Estado efectivo y motivo FLIT 1 | `GET /api/flito/sync/estado` (`habilitada`, `motivoDeshabilitada`) | igual |
| Estado efectivo y motivo FLIT 2 | `GET /api/flito/sync/flit2/estado` (hook `useEstadoFlit2`, que ya existe) | igual |

| Estado | Qué se ve |
|---|---|
| **Cargando** | Esqueleto de **esta** estructura: dos grupos, cada uno con su rótulo («FLIT 1» / «FLIT 2», texto real) y tres bloques. Los bloques son un hueco del interruptor `h-6 w-11 rounded-full`, dos líneas `h-3` y un hueco de botón `h-10 w-36`, todos con `animate-pulse` y fondo `--flit-bg-hover`, `aria-hidden`. La sección lleva `aria-busy="true"`. Sin spinner. FLIT 2 ya tiene su propio esqueleto de línea (`LineaEstadoFlit2`) y se reutiliza. |
| **Error** (falla el GET de interruptores) | Bajo el subtítulo, una línea `role="alert"` en `--flit-danger-text`: «No se pudo consultar los interruptores de sincronización. **[Reintentar]**». En cada grupo, el hueco del interruptor queda vacío: no se adivina su valor. El resto del grupo sigue funcionando con su propio endpoint. Si falla el estado de FLIT 2, se usa la línea de error que ya existe («No se pudo consultar · Reintentar»). Si falla `GET /flito/sync/estado` (FLIT 1), la línea de estado dice «No se pudo consultar · **[Reintentar]**» (mismo patrón que FLIT 2) y el botón sigue disponible: si la fuente estuviera apagada, el 409 lo cubre. |
| **Vacío útil** | El GET siempre devuelve las dos fuentes, así que no hay «vacío» de interruptores. El vacío de verdad es **FLIT 1 nunca sincronizada**: la línea dice «Nunca sincronizado» y debajo, en muted: «Elige desde qué fecha traer trámites y pulsa Sincronizar FLIT.». El campo «Desde» aparece visible, como ya pasa la primera vez. Si FLIT 1 está apagada, el motivo de apagada sustituye a esta frase. FLIT 2 sin configurar sigue con su aviso actual («FLIT 2 sin configurar: … Configura el acceso en **Acceso a FLIT 2**.»). |
| **Lleno** | Wireframe 1366. Sin banners ni KPIs añadidos. |

### Copy exacto

**Sección**
- Título: `Sincronización`
- Subtítulo: `Cada fuente trae trámites a FLITO en este ambiente. Apagarla detiene la entrada; lo que ya entró no cambia.`

**Interruptor**
- Nombre accesible (`aria-label`, o `<span id>` + `aria-labelledby`): `Recibir trámites de FLIT 1` / `Recibir trámites de FLIT 2`.
- Texto de estado visible (también va en `aria-describedby`):

| Caso | Texto |
|---|---|
| encendido y habilitada | `Encendida` |
| apagado | `Apagada` |
| FLIT 2 encendido + `maestroFlit2=false` | `Encendida · apagada en el servidor` |
| PUT en curso | `Guardando…` |

- Línea quién/cuándo (solo con `tramites.sincronizacion.configurar` y `actualizadoEn ≠ null`), en muted 11 px: `Apagada por {nombre} el {1 oct.} a las {3:20 p. m.}` / `Encendida por {nombre} …`. Si la fecha es de hoy, solo la hora: `… hoy a las 3:20 p. m.`. Con `actualizadoEn = null` (sembrada) no se pinta nada.

**Los tres motivos (aviso de página, `role="status"`, persistente, dentro del grupo)**

| Caso | Con `tramites.sincronizacion.configurar` | Sin ella |
|---|---|---|
| **FLIT 1 apagada por interruptor** | `FLIT 1 está apagada: no entran trámites de FLIT 1 y «Sincronizar FLIT» no está disponible. Enciéndela con el interruptor para volver a sincronizar.` | `FLIT 1 está apagada en este ambiente: no entran trámites de FLIT 1 y «Sincronizar FLIT» no está disponible. Pídele a un administrador que la encienda.` |
| **FLIT 2 apagada por interruptor** (`motivoDeshabilitada='interruptor'`) | `FLIT 2 está apagada: FLITO no lee trámites nuevos de FLIT 2. Al encenderla, la lectura sigue donde quedó.` | `FLIT 2 está apagada en este ambiente: FLITO no lee trámites nuevos de FLIT 2. Pídele a un administrador que la encienda.` |
| **FLIT 2 apagada por el maestro del servidor** (`motivoDeshabilitada='maestro'`) | `La lectura de FLIT 2 está apagada en el servidor de este ambiente. El interruptor no basta para encenderla: avísale a quien administra el ambiente.` | igual |
| **Sin permiso** (motivo de por qué el interruptor no se puede mover) | — | Línea muted bajo el interruptor, enlazada con `aria-describedby`: `Solo lectura: pídele a un administrador si hay que cambiarla.` |

Reglas de los motivos:
- Con `habilitada=false` **no** hay alerta de atraso, ni título rojo, ni cuenta (AC4). El aviso «apagada» sustituye a las frases de alerta y de problema de `AvisoEstadoFlit2`.
- El párrafo de PII enmascarada sí se mantiene, porque sigue siendo cierto.
- `maestro` precede a `interruptor`.

**Diálogo al apagar** (ver Decisiones)

| Fuente | Título | Cuerpo |
|---|---|---|
| FLIT 1 | `¿Apagar FLIT 1?` | `Mientras esté apagada, no entran trámites de FLIT 1 en este ambiente y nadie puede usar «Sincronizar FLIT». Lo que ya entró no cambia.` |
| FLIT 2 | `¿Apagar FLIT 2?` | `Mientras esté apagada, FLITO no lee trámites nuevos de FLIT 2 en este ambiente. Si hay una lectura en curso, termina la página actual y se detiene. Lo que ya entró no cambia y, al encenderla, la lectura sigue donde quedó.` |

- Botones: `[Cancelar]` (secundario) y `[Apagar FLIT 1]` / `[Apagar FLIT 2]` (primaria del modal).
- Encender **no** pide confirmación.

---

## Comportamiento del interruptor

- **Tras la respuesta, no optimista.** Apagar se audita y afecta a todos los usuarios del ambiente. Mostrar «Apagada» antes de que el servidor lo confirme sería decir algo que puede no ser cierto. El PUT tarda poco y se muestra `Guardando…`.
- **Secuencia:**
  1. Clic, Espacio o Enter. Si es **apagar**, se abre el diálogo con el foco inicial en **Cancelar**. Esc o Cancelar cierran sin cambios y devuelven el foco al interruptor.
  2. Al confirmar (o al encender), sale `PUT /api/flito/sync/interruptores/:fuente` con `{ encendido }`. Mientras tanto, el interruptor queda en `aria-disabled="true"` + `aria-busy="true"`, el texto dice `Guardando…` y conserva el valor anterior. No se usa `disabled` nativo, para no perder el foco.
  3. **200:** se pinta el valor devuelto y la línea quién/cuándo, y se refrescan los dos estados (`GET /flito/sync/estado` y `estadoFlit2.refrescar()`). Los motivos y el botón quedan al día, y sale el toast de éxito. El foco **se queda en el interruptor**, también tras cerrar el diálogo.
  4. **Error:** el interruptor vuelve al valor anterior (en realidad nunca lo dejó), el foco sigue en él y sale el toast de error.
- **Sin `tramites.sincronizacion.configurar`:**
  - El interruptor se pinta en `aria-disabled="true"`, con `aria-checked` igual al **estado efectivo** (`habilitada` del endpoint de estado; el maestro apagado se pinta como apagado). Sigue enfocable para que el lector lea el motivo.
  - Cursor `default` y sin velo de hover. La línea «Solo lectura: …» explica el porqué.
  - **No** baja la opacidad, para que el contraste no caiga.
- **«Sincronizar FLIT» con FLIT 1 apagada:**
  - Lleva `aria-disabled="true"` (enfocable, sin acción al pulsar), `aria-describedby` apuntando al aviso del motivo y un estilo deshabilitado del kit.
  - Mientras sincroniza, conserva el `disabled` de hoy.
  - Si el POST responde **409 `FUENTE_APAGADA`** (alguien la apagó con la página abierta): sale el toast de error, se refrescan el estado de FLIT 1 y los interruptores, y el aviso aparece. El foco se queda en el botón, que pasa a `aria-disabled`.

---

## Notificaciones — toast vs aviso

| Acción / estado | Patrón | Copy |
|---|---|---|
| FLIT 1 apagada / FLIT 2 apagada / maestro | **Aviso en página** del grupo (`role="status"`), persistente | ver Motivos |
| Apagar FLIT 1 ok | `toastOk`, ~4 s, id `sync-interruptor-flit1` | `FLIT 1 quedó apagada: «Sincronizar FLIT» queda deshabilitado.` |
| Encender FLIT 1 ok | `toastOk`, ~4 s | `FLIT 1 quedó encendida: ya puedes usar «Sincronizar FLIT».` |
| Apagar FLIT 2 ok | `toastOk`, ~4 s, id `sync-interruptor-flit2` | `FLIT 2 quedó apagada: no entran trámites nuevos de FLIT 2.` |
| Encender FLIT 2 ok | `toastOk`, ~4 s | `FLIT 2 quedó encendida: la lectura sigue donde quedó en la próxima vuelta automática.` |
| Encender FLIT 2 ok con `maestroFlit2=false` | `toastOk`, 6 s | `FLIT 2 quedó encendida aquí, pero el servidor de este ambiente la mantiene apagada: no entra nada hasta que lo enciendan.` |
| PUT 403 | `toastError` (sin Reintentar). Además, el interruptor pasa a solo lectura | `No tienes permiso para cambiar la sincronización. Pídeselo a un administrador.` |
| PUT 400 | `toastError` (sin Reintentar) | `No se pudo guardar el cambio. Recarga la página e inténtalo de nuevo.` |
| PUT red / 5xx | `toastError` **con Reintentar**, que repite el mismo PUT | `No se pudo guardar el cambio de FLIT 1. Inténtalo de nuevo.` (o FLIT 2) |
| POST sincronizar 409 `FUENTE_APAGADA` | `toastError` (sin Reintentar) + el aviso del grupo | `No se sincronizó: FLIT 1 está apagada en este ambiente.` |
| POST sincronizar ok | `toastOk`, 6 s. **Sustituye** la tarjeta «Sincronización: N traídos · …» | `Sincronización lista: {n} nuevos y {m} con cambios.` Si `companiasFaltantes + organismosSinEmparejar > 0`, se añade ` {k} quedaron sin empresa o sin secretaría.` |
| POST sincronizar, otro error | `toastError` con Reintentar | `No se pudo sincronizar con FLIT 1. Inténtalo de nuevo en unos minutos.` |

Las acciones de sincronización dejan de escribir en la tarjeta `error` de la página. Esa tarjeta sigue
sirviendo a las demás acciones, que están fuera de alcance. **Nunca** se pinta `e.message`, el `codigo` ni
el `status`.

---

## Feedback de controles (hover + foco)

| Control | Hover | Foco |
|---|---|---|
| Interruptor (editable) | Área de pulsación `h-10` alrededor del carril (`inline-flex items-center rounded-full px-1`) con velo `hover:bg-[var(--flit-bg-hover)]` y `transition-colors` | `flit-focus` sobre el área completa |
| Interruptor (solo lectura / guardando) | sin velo, cursor `default` / `progress` | `flit-focus` (sigue enfocable) |
| «Elegir fecha» | La etiqueta se vuelve `inline-flex h-10 items-center gap-2 rounded-[999px] px-3` con velo de hover | `flit-focus` en la casilla |
| Fecha «Desde» | `flitInp h-10`, igual que hoy | el del kit |
| «Sincronizar FLIT», «Acceso a FLIT 2» | `flitBtnPrimary` / `flitBtnSecondary`: el hover lo da el kit | el del kit |
| «Reintentar» (líneas de error) | `hover:underline`, como en `LineaEstadoFlit2` | `flit-focus` |

**Una sola altura de control por barra: `h-10`** (botones, casilla con su etiqueta, fecha y área del
interruptor).

---

## Tokens

Todos tienen par oscuro en `flit-tokens.css`. El aviso de página reutiliza `--flit-text-primary`, igual que
`AvisoEstadoFlit2`.

| Uso | Token |
|---|---|
| Carril encendido | `--flit-blue-text` (claro #4D6AB2 / oscuro #9DBCF7; ≥ 3:1 sobre la tarjeta en los dos temas) |
| Carril apagado | `--flit-text-muted` (≥ 3:1 sobre la tarjeta en los dos temas) |
| Botón del interruptor (pulgar) | `--flit-bg-card` |
| Velo hover | `--flit-bg-hover` |
| Borde de grupo y de aviso | `--flit-border-soft` |
| Fondo de grupo y de aviso | `--flit-bg-card` (la sección es `FlitCard`; los grupos, `rounded-lg border p-4`) |
| Títulos h2/h3 | los de `FlitCard` del kit; h3 en `--flit-text-primary` `text-sm font-semibold` |
| Texto de estado / líneas de estado | `--flit-text-secondary` (valor) y `--flit-text-muted` (rótulo, quién/cuándo, «Solo lectura») |
| Error del GET | `--flit-danger-text` (**no** `-ink`: ~2,5:1 en oscuro) |

El desplazamiento del pulgar usa `transition-transform` con `--flit-duration-base` y `motion-reduce:transition-none`:
es feedback de estado, no adorno.

**Prohibido** en esta zona: `bg-white`, HEX, `slate-*`/`gray-*`/`red-*`, `--flit-*-ink` para texto sobre la
tarjeta, sombras y gradientes nuevos.

El interruptor es el **único patrón nuevo**, porque el kit no tiene switch (no hay ningún `role="switch"` en
`apps/web/src`). Va como componente pequeño en `components/flit/` (p. ej. `FlitSwitch.tsx`), con tokens, para
que el próximo no lo reinvente.

---

## Accesibilidad

- `<button type="button" role="switch" aria-checked={…}>` con nombre accesible «Recibir trámites de FLIT n», y `aria-describedby` → texto de estado + motivo / «Solo lectura».
- Espacio y Enter lo accionan (botón nativo).
- El estado no se comunica solo por color: hay texto «Encendida/Apagada» y posición del pulgar.
- `<section aria-labelledby>` con `h2` «Sincronización» y `h3` por grupo.
- Avisos `role="status"`. Las alertas de FLIT 2 que ya existían siguen en `role="alert"`, y solo con `habilitada=true`.
- Diálogo: `FlitModal` (no lateral), con foco atrapado, foco inicial en Cancelar, Esc cierra y el foco vuelve al interruptor.
- Contraste: texto ≥ 4.5:1; carril y foco ≥ 3:1 en claro y oscuro.

---

## Permiso / slug

- Página existente (`FlitoTramites`), **sin `PageSlug` nuevo**.
- Editar el interruptor requiere `hasFuncion('tramites.sincronizacion.configurar')`, sembrada solo a `admin` en la 0217.
- Ver la sección: `sync.sync.ver_estado` **o** `sync.sync.lanzar` **o** la de configurar.
- «Sincronizar FLIT»: misma guarda de hoy (`esOperaciones`), sin cambio.
- «Acceso a FLIT 2»: misma guarda de hoy.
- E2E: añadir `tramites.sincronizacion.configurar` a `FUNCIONES_POR_ROL.admin` en `apps/web/e2e/helpers/auth.ts`.

---

## Notas para QA (≤10)

1. Admin, todo encendido: la cabecera solo tiene «+ Trámite demo». La sección muestra dos grupos alineados a 1366 y las dos barras de acciones terminan a la misma altura.
2. Apagar FLIT 1: aparece el diálogo con el foco en Cancelar. Cancelar no cambia nada; confirmar → «Guardando…» → «Apagada» + toast + aviso. «Sincronizar FLIT» queda `aria-disabled` y anuncia el motivo.
3. Con la página abierta en dos pestañas, apagar FLIT 1 en una y pulsar «Sincronizar FLIT» en la otra → toast «No se sincronizó…», el aviso aparece y no hay texto crudo del API.
4. Apagar FLIT 2: aviso `status`, sin título rojo ni cuenta «próxima en»; la línea dice «Lectura detenida». Encender FLIT 2 → toast; la cuenta vuelve.
5. Maestro apagado (`FLIT2_SYNC_CRON=false`) con el interruptor encendido: texto «Encendida · apagada en el servidor» + aviso del maestro. Encender devuelve el toast del caso maestro.
6. Usuario con `ver_estado` sin configurar: no sale el GET de interruptores (red). El interruptor es solo lectura y enfocable, con la línea «Solo lectura…» y el motivo «Pídele a un administrador…».
7. PUT forzado a 500 → el interruptor conserva su valor, el foco sigue en él y sale el toast con Reintentar. 403 → pasa a solo lectura.
8. GET de interruptores en 500 → línea de error con Reintentar y huecos vacíos. «Sincronizar FLIT» y la línea de FLIT 2 siguen funcionando.
9. Teclado: Tab recorre interruptor 1 → «Elegir fecha» → «Desde» → «Sincronizar FLIT» → interruptor 2 → «Acceso a FLIT 2», con foco visible en todos. Espacio acciona el interruptor.
10. Verificación visual (adjuntar al PR):
    - Captura a 1366 en claro con todo encendido.
    - Captura a 1366 en claro con FLIT 1 apagada y FLIT 2 apagada por el maestro.
    - Captura a 1366 en **oscuro** del mismo par: carriles legibles, sin blancos fosforescentes, error en `-text`.
    - Captura a **375** en claro: sin scroll horizontal (`document.documentElement.scrollWidth <= 375`), botones a ancho completo, grupos apilados FLIT 1 → FLIT 2.
    - Hover visible en el interruptor y en «Elegir fecha».

---

## Decisiones y descartes

- **Diálogo al apagar, sí.** Apagar es un toque de un control pequeño (fácil de rozar en móvil) que afecta a todo el ambiente y cuyo efecto es **silencioso**: nada se rompe a la vista, simplemente dejan de entrar trámites. Un toast después de un error así llega tarde. Encender no pide confirmación porque es la vuelta al estado sembrado.
- **No optimista:** la verdad la tiene el servidor (auditoría y concurrencia por `FOR UPDATE`).
- **El desglose numérico de la sincronización pasa a toast:** es el resultado de una acción puntual, no un estado. La tarjeta permanente contradecía principios §Notificaciones (telemetría fija en página).
- **Descartado** un tercer grupo «General» o una «primaria» para FLIT 2: inflaría la zona sin una acción real de la visita.
- **Descartado** dejar los interruptores en la cabecera: la cabecera ya estaba saturada y es justo lo que la HU pide ordenar.
- **Sin** iconos de fuente, colores de marca por fuente, animación del aviso ni sombras: el carácter es el orden de los dos grupos gemelos.

## Acordeón — 2026-10-01

Pedido de David (2.º PR de la HU #13238): la tarjeta «Sincronización» pasa a ser desplegable.

1. **Contraída en cada visita.** No se recuerda el estado (ni `localStorage`, ni query, ni contexto): la zona es de consulta ocasional y la tabla es lo que se viene a ver.
2. **Resumen por fuente en la cabecera:** «Sincronización · FLIT 1: Encendida · FLIT 2: Apagada», de las mismas fuentes de verdad que los grupos (interruptores con el permiso de configurar; estado efectivo sin él). Cargando → «Cargando…»; error de lectura → «estado no disponible» (el error con Reintentar sigue dentro). FLIT 2 con el maestro apagado → «Apagada en el servidor». Sin permiso para ver el estado de FLIT 2, esa fuente no sale en el resumen.
3. **Todo lo demás vive en el cuerpo:** interruptores, «Sincronizar FLIT», Acceso a FLIT 2, estado y avisos de FLIT 2.
4. **Distintivo de alerta de FLIT 2** («Requiere atención» + ícono, en `--flit-danger-text`, no solo color) con la misma regla que la tarjeta de aviso (`alertaFlit2` en `EstadoFlit2.tsx`: alerta del servidor, anulada con la fuente apagada o sin configurar).
5. **Accesibilidad y kit:** `FlitAcordeon` del kit (ampliado con `resumen`, `nivel` y `testId`): disparador `<button>` dentro de un `<h2>` con `aria-expanded`/`aria-controls`, panel `role="region"` nombrado por el título y **desmontado** al contraer (nada enfocable oculto); hover sutil + foco del kit; el chevron (lucide) solo rota, sin transición con `prefers-reduced-motion`. El resumen envuelve en 375 px; sin separador «·» entre fuentes (al envolver quedaba colgando al final de la línea): las separa el espacio.
