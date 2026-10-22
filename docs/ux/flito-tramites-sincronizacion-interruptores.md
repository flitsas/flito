# UX slim — Gestión Trámites · sección «Sincronización» con interruptor por fuente (HU #13238)

> Delta HU #13634 (Último aviso, Última lectura buena, avisos_firma, umbral 2R+5): ver `docs/ux/hu-13634-ultimo-aviso-flit2.md`; sustituye las menciones a «30 minutos».

> **Vigencia (2026-10-16).** El delta de la **HU #13630** (al final de este documento) retira la
> sincronización manual de FLIT 1 y añade sus parámetros de lectura. Donde choque con lo anterior
> —«Sincronizar FLIT» como única primaria, «Elegir fecha», «Desde», el toast de la sincronización, el
> 409 `FUENTE_APAGADA`, los motivos y el diálogo que nombran «Sincronizar FLIT»— **manda el delta**.
> Lo demás (interruptores, FLIT 2, acordeón, tokens, accesibilidad del switch) sigue vigente.

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

---
---

# Delta HU #13630 — Lectura automática de FLIT 1, sin sincronización manual (2026-10-16)

UX **slim** · Feature #13612 · Épica #13576 · módulo **FLITO** `flito-sync` (no el legacy). Contrato:
HU #13628, `docs/diseno/hu-13628-parametros-lectura-flit1.md`. Tipos: `ParametrosLecturaFlit1`,
`EstadoLecturaFlit1`, `LIMITES_PARAMETROS_LECTURA_FLIT1` y `DEFAULTS_PARAMETROS_LECTURA_FLIT1` en
`packages/shared-types/src/flito-sync-flit1.ts`. Tono: **tú**, como el resto de la pantalla.

## Superficie tocada

1. **Gestión de Trámites** (`/flito/tramites`): el **grupo FLIT 1** de la sección «Sincronización»
   (`components/flito/tramites/SincronizacionTramites.tsx`) y el resumen del acordeón. El grupo FLIT 2,
   el acordeón, la cabecera de la página, la tabla y los filtros **no cambian**.
2. **Tablero** (`pages/FlitoTablero.tsx`): **solo se quita**. Salen el botón «Sincronizar desde FLIT» de
   `PageHeaderCard`, la tarjeta «Sincronización ejecutada» que solo existía para ese botón y la nota
   «Solo lectura · Auditoría observa el tablero…» (decisión de David, AC7). La cabecera queda con el
   título y el subtítulo, sin `actions`. Los 4 estados del Tablero no cambian.

**Qué vino a hacer quien abre la zona:** responder «¿FLIT 1 está entrando bien?». Solo quien tiene
`configurar` viene, además, a ajustar cada cuánto y hasta dónde lee. Ya no hay nada que *lanzar*.

## Delta de claridad (qué se ve / qué se calla)

### Antes → después (grupo FLIT 1)

| Antes | Después |
|---|---|
| «Última actualización» (de la sincronización manual, `system_kv`) | **«Última lectura» + «Próxima lectura»**, de `GET /flit1/estado-lectura` |
| Casilla «Elegir fecha» + fecha «Desde» + **«Sincronizar FLIT»** (primaria) | Desaparecen (AC6). La fecha de arranque vive ahora en los parámetros |
| Error de la sincronización solo en un toast efímero | **Último fallo** como aviso de página persistente mientras sea cierto (AC5) |
| — | **Parámetros de lectura**: 4 campos + **«Guardar parámetros»**, solo con `configurar` |

**Densidad:** se mantiene. Salen tres controles (casilla, fecha, botón) y entran cuatro campos y un
botón, pero los campos solo los ve quien configura. Quien solo consulta ve **menos** que antes.

### Jerarquía del grupo FLIT 1 (de arriba abajo)

1. **Cabecera:** «FLIT 1» (h3) + interruptor + estado («Encendida» / «Apagada»), igual que hoy, con su línea quién/cuándo.
2. **Explicación de una línea** (AC6): `FLITO lee FLIT 1 automáticamente cada {N} minutos.`
3. **Estado** (lo que se vino a ver), dos pares rótulo/valor en fila: **Última lectura** · **Próxima lectura**.
4. **Aviso** (solo si aplica): FLIT 1 apagada, **o** último fallo vigente. Si FLIT 1 está apagada, el aviso de apagada gana y el fallo pasa a línea muted.
5. **Parámetros de lectura** (solo con `configurar`): separador fino + subtítulo `h4`, la línea quién/cuándo, los 4 campos en rejilla 2×2 y la barra con **«Guardar parámetros»** al fondo (`mt-auto`), alineada con «Acceso a FLIT 2» del grupo vecino.

FLIT 2 conserva su esqueleto: cabecera, línea «Última lectura FLIT 2» con el indicador en vivo, aviso y «Acceso a FLIT 2». Los dos grupos quedan gemelos en lo que importa: **cabecera → estado → aviso → barra**.

### Qué se calla

- **Los parámetros, a quien no puede cambiarlos.** Con solo `sync.sync.ver_estado` no se pinta el bloque ni sale el GET (que exige `configurar`). Ese usuario necesita saber si FLIT 1 entra, no cuántos días abarca la ventana.
- **El código del fallo** (`flit1_http_502`, `base_datos`…): nunca. Cada código tiene su frase.
- **Un fallo ya superado:** si después del fallo hubo una lectura buena, no es aviso, es una línea muted.
- **La cuenta regresiva en vivo:** FLIT 1 lee cada 2–60 min. Con 2 min, un `m:ss` estaría siempre corriendo, y eso es ruido. Se muestra la hora prevista, no la cuenta.

### Inline o plegable: **inline** (recomendado)

Los parámetros se editan **dentro del grupo FLIT 1, sin un segundo plegable**.

- **AC1** pide los campos «junto al interruptor, con sus valores vigentes». Un plegable dentro del acordeón los deja a dos clics y ocultos dos veces.
- La zona **ya** está contraída en cada visita (decisión 1 del acordeón): la tabla no paga ningún coste por mostrarlos.
- Un acordeón dentro de otro es un patrón de navegación que el kit no tiene, y en móvil es difícil de leer.
- El volumen es pequeño: 4 campos en 2×2 a ≥ `sm`, solo para quien configura.

**Descartado:** el panel plegable «Parámetros de lectura» y el modal «Configurar lectura». El modal
esconde los valores vigentes y añade un botón «Configurar» que competiría como acción. Ninguno de los
dos alivia nada que el acordeón exterior no alivie ya.

### Una sola primaria: **«Guardar parámetros»**

| Grupo | Acción | Peso |
|---|---|---|
| FLIT 1 | **Guardar parámetros** (solo con `configurar`) | `flitBtnPrimary`, la **única** primaria de la zona |
| FLIT 2 | Acceso a FLIT 2 | `flitBtnSecondary`, sin cambio |

- Sin `configurar` no queda **ninguna** primaria en la zona. Es correcto: esa visita es de consulta.
- El botón dice la acción completa («Guardar parámetros», no «Guardar»), porque el grupo vecino tiene otra acción.
- Pasa a `aria-disabled` mientras no haya cambios o mientras guarda (ver Estados).
- **No** se añade «Descartar» ni «Restablecer valores por defecto»: el PUT exige los 4 campos y no hay AC para restaurar (riesgo 4 del diseño de la #13628).

## Wireframe — escritorio (1366, acordeón abierto, admin)

```
┌ FlitAcordeon (h2) ──────────────────────────────────────────────────────────────────────────────┐
│ ▾ Sincronización    FLIT 1: Encendida   FLIT 2: Encendida                                       │
│ Cada fuente trae trámites a FLITO en este ambiente. Apagarla detiene la entrada; lo que ya       │
│ entró no cambia.                                                                                 │
│ ┌ grupo FLIT 1 ────────────────────────────────────┐ ┌ grupo FLIT 2 ────────────────────────────┐│
│ │ FLIT 1 (h3)                   (●━━) Encendida    │ │ FLIT 2 (h3)              (●━━) Encendida ││
│ │                 Encendida por Ana Pérez el 1 oct.│ │                                          ││
│ │ FLITO lee FLIT 1 automáticamente cada 2 minutos. │ │ Última lectura FLIT 2                    ││
│ │                                                  │ │ 16 oct. 2026, 3:25 p. m. · próxima 3:12  ││
│ │ Última lectura           Próxima lectura         │ │                                          ││
│ │ hoy a las 3:24 p. m.     hacia las 3:26 p. m.    │ │ ┌ aviso (si aplica) ───────────────────┐ ││
│ │                                                  │ │ └──────────────────────────────────────┘ ││
│ │ ┌ aviso role=status (solo si fallo vigente) ───┐ │ │                                          ││
│ │ │ Falló la última lectura de FLIT 1.  (danger) │ │ │                                          ││
│ │ │ A las 3:22 p. m., FLIT 1 no respondió a      │ │ │                                          ││
│ │ │ tiempo. FLITO vuelve a intentarlo solo en la │ │ │                                          ││
│ │ │ próxima lectura.                             │ │ │                                          ││
│ │ └──────────────────────────────────────────────┘ │ │                                          ││
│ │ ──────────────────────────────────────────────── │ │                                          ││
│ │ Parámetros de lectura (h4)                       │ │                                          ││
│ │ Cambiados por Ana Pérez el 14 oct. a las 9:10 a. m.│                                          ││
│ │ Frecuencia (minutos)     Ventana (días)          │ │                                          ││
│ │ [ 2                 ]    [ 7                 ]   │ │                                          ││
│ │ Cada cuánto lee FLITO    Cuántos días hacia atrás│ │                                          ││
│ │ a FLIT 1. De 2 a 60.     revisa cada lectura.    │ │                                          ││
│ │                          De 1 a 90.              │ │                                          ││
│ │ Ventana nocturna (días)  Fecha de arranque       │ │                                          ││
│ │ [ 60                ]    [ 15/09/2026      ▢ ]   │ │                                          ││
│ │ Días que revisa la       FLITO no lee trámites   │ │                                          ││
│ │ lectura de la noche. De  anteriores a esta fecha.│ │                                          ││
│ │ 7 a 90, no menos que la  Hoy o antes.            │ │                                          ││
│ │ ventana.                                         │ │                                          ││
│ │                            [ Guardar parámetros ]│ │                      [ Acceso a FLIT 2 ] ││
│ └──────────────────────────────────────────────────┘ └──────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Solo lectura (`sync.sync.ver_estado` sin `configurar`), grupo FLIT 1:

```
│ FLIT 1 (h3)                   (●━━) Encendida    │   ← interruptor aria-disabled
│ Solo lectura: pídele a un administrador si hay   │
│ que cambiarla.                                   │
│ FLITO lee FLIT 1 automáticamente.                │   ← sin N: ese usuario no recibe la frecuencia (ver Pregunta)
│ Última lectura           Próxima lectura         │
│ hoy a las 3:24 p. m.     hacia las 3:26 p. m.    │
│ Último fallo: hoy a las 2:10 p. m. · ya leyó     │   ← fallo superado: línea muted
│ bien después.                                    │
└──────────────────────────────────────────────────┘   ← sin parámetros ni barra
```

FLIT 1 apagada (admin): «Próxima lectura» dice `Lectura detenida`; el aviso de apagada (copy abajo) ocupa
el lugar del aviso de fallo; los parámetros **siguen editables**, porque se aplican al encender.

## Wireframe — móvil (375, sin scroll horizontal)

```
┌ Sincronización ─────────────────┐
│ ▾ Sincronización                │
│ FLIT 1: Encendida               │   ← el resumen envuelve (ya lo hace)
│ FLIT 2: Encendida               │
│ Cada fuente trae trámites …     │
│ ┌ FLIT 1 ─────────────────────┐ │
│ │ FLIT 1       (●━━) Encendida│ │
│ │ Encendida por Ana Pérez …   │ │
│ │ FLITO lee FLIT 1            │ │
│ │ automáticamente cada 2 min… │ │
│ │ Última lectura              │ │   ← los dos pares se apilan
│ │ hoy a las 3:24 p. m.        │ │
│ │ Próxima lectura             │ │
│ │ hacia las 3:26 p. m.        │ │
│ │ ┌ aviso (si aplica) ──────┐ │ │
│ │ └─────────────────────────┘ │ │
│ │ ─────────────────────────── │ │
│ │ Parámetros de lectura       │ │
│ │ Cambiados por Ana Pérez …   │ │
│ │ Frecuencia (minutos)        │ │   ← una columna
│ │ [ 2                       ] │ │
│ │ Cada cuánto lee … 2 a 60.   │ │
│ │ Ventana (días)              │ │
│ │ [ 7                       ] │ │
│ │ …                           │ │
│ │ Ventana nocturna (días)     │ │
│ │ [ 60                      ] │ │
│ │ …                           │ │
│ │ Fecha de arranque           │ │
│ │ [ 15/09/2026            ▢ ] │ │
│ │ …                           │ │
│ │ [   Guardar parámetros    ] │ │   ← w-full sm:w-auto
│ └─────────────────────────────┘ │
│ ┌ FLIT 2 ─────────────────────┐ │
│ │ … sin cambio                │ │
│ │ [     Acceso a FLIT 2     ] │ │
│ └─────────────────────────────┘ │
└─────────────────────────────────┘
```

## Estados (4) + copy

### Datos y quién los pide

| Bloque | Endpoint | Quién lo pide |
|---|---|---|
| Interruptor + estado efectivo | `GET /flito/sync/interruptores` y `GET /flito/sync/estado` | sin cambio |
| Estado de la lectura (AC5) | `GET /flito/sync/flit1/estado-lectura` | `configurar` **o** `sync.sync.ver_estado` (la guarda del API es la misma) |
| Parámetros (AC1) | `GET` / `PUT /flito/sync/flit1/parametros-lectura` | solo `tramites.sincronizacion.configurar` |

**Refresco del estado:** igual que el pulso de FLIT 2 (`useEstadoFlit2`). Un GET al montar, otro silencioso
cada 2 min con la pestaña visible y otro al volver a ella, y además tras guardar los parámetros y tras
mover el interruptor. Si un refresco silencioso falla, se conserva el último dato. **No** hay ritmo rápido
de 10–15 s: FLIT 1 no expone «en curso».

### Estado de la lectura (bloque «Última / Próxima»)

| Estado | Qué se ve |
|---|---|
| **Cargando** | Los rótulos reales («Última lectura», «Próxima lectura») y debajo de cada uno una línea `h-3 w-28 animate-pulse` en `--flit-bg-hover`, `aria-hidden`. El interruptor y los parámetros no esperan a este GET |
| **Error** | En el lugar de los dos valores: `No se pudo consultar · [Reintentar]`, con el mismo `Reintentar` de `LineaEstadoFlit2` (`aria-label="Reintentar la consulta del estado de la lectura de FLIT 1"`). Ni el interruptor ni los parámetros se bloquean (AC4) |
| **Vacío útil** (`ultimaLecturaBuenaEn = null`) | Última lectura: `Aún sin lecturas`. Próxima lectura: la hora si llega, si no `En unos minutos`. Debajo, en muted: `La primera lectura trae los trámites desde la fecha de arranque.` Con FLIT 1 apagada, esta frase la sustituye el aviso de apagada |
| **Lleno** | `Última lectura`: `hoy a las 3:24 p. m.` o `el 14 oct. a las 3:24 p. m.` (mismo `aLas` que FLIT 2). `Próxima lectura`: `hacia las 3:26 p. m.`; si ya pasó, `En cualquier momento`; con FLIT 1 apagada, `Lectura detenida` |

### Último fallo (AC5): aviso de página, nunca toast

| Situación | Patrón |
|---|---|
| **Vigente**: `ultimoFallo` existe **y** (`ultimaLecturaBuenaEn` es null **o** `ultimoFallo.en > ultimaLecturaBuenaEn`) **y** FLIT 1 encendida | Aviso del grupo, `role="status"`, mismo `AVISO`/`ESTILO_AVISO` que hoy. Título `Falló la última lectura de FLIT 1.` en `--flit-danger-text` y debajo la frase de su código |
| **Superado** (hubo una lectura buena después) | Línea muted bajo el estado: `Último fallo: {aLas}, ya leyó bien después.` |
| FLIT 1 apagada con fallo vigente | Gana el aviso de apagada; el fallo va como línea muted `Último fallo: {aLas}.` |
| `ultimoFallo = null` | Nada |

Además, el resumen del acordeón muestra el **distintivo «Requiere atención»** junto a «FLIT 1: Encendida»
cuando el fallo está vigente (mismo `ResumenFuente alerta` que FLIT 2). Así, con la zona contraída, un
fallo no queda escondido.

**Copy por código.** `{cuando}` = `aLas(momento(en))` → «a las 3:22 p. m.» / «el 14 oct. a las 3:22 p. m.».
`{Cuando}` es lo mismo con mayúscula inicial. Se calcan los helpers de `EstadoFlit2.tsx`.

| Código | Frase |
|---|---|
| `flit1_http_401`, `flit1_http_403` | `{Cuando}, FLIT 1 rechazó el acceso de FLITO. Avísale a quien administra el ambiente: hay que revisar el acceso a FLIT 1.` |
| `flit1_http_429` | `{Cuando}, FLIT 1 pidió esperar antes de seguir. La lectura automática continúa en la próxima vuelta.` |
| `flit1_http_5xx` (500–599) | `{Cuando}, FLIT 1 tuvo un error de su lado. FLITO vuelve a intentarlo solo; si se repite, avísale a soporte técnico.` |
| `flit1_http_<otro>` | `{Cuando}, FLIT 1 no aceptó la lectura. FLITO vuelve a intentarlo solo; si se repite, avísale a soporte técnico.` |
| `flit1_timeout` | `{Cuando}, FLIT 1 no respondió a tiempo. FLITO vuelve a intentarlo solo en la próxima lectura.` |
| `flit1_red` | `{Cuando}, FLITO no pudo conectarse con FLIT 1. Vuelve a intentarlo solo; si se repite, avísale a quien administra el ambiente.` |
| `flit1_respuesta_invalida` | `{Cuando}, FLIT 1 respondió de forma inesperada. FLITO vuelve a intentarlo solo; si se repite, avísale a soporte técnico.` |
| `base_datos` | `{Cuando}, FLITO leyó FLIT 1 pero no pudo guardar lo leído. Se reintenta sola; si se repite, avísale a soporte técnico.` |
| `tramites_con_fallo` | `{Cuando}, la lectura terminó, pero algunos trámites no se pudieron guardar. Las próximas lecturas los vuelven a intentar mientras estén dentro de la ventana; si se repite, avísale a soporte técnico.` |
| `desconocido` y cualquier código no listado | `{Cuando}, la lectura de FLIT 1 falló en FLITO. Se reintenta sola; si se repite, avísale a soporte técnico.` |

- El status se extrae con `^flit1_http_(\d{3})$`. Si no cuadra, cae en el genérico.
- **Jamás** se pinta el código ni el status.
- La frase de `tramites_con_fallo` («las próximas lecturas los vuelven a intentar…») está **por confirmar** con la #13629 (ver Preguntas).

### Parámetros de lectura (AC4: ninguno bloquea el interruptor)

| Estado | Qué se ve |
|---|---|
| **Cargando** | `h4` real + 4 bloques con su **etiqueta real** y un hueco `h-10 w-full rounded-[10px] animate-pulse` en `--flit-bg-hover`, más un hueco de botón `h-10 w-40`. El bloque lleva `aria-busy="true"` |
| **Error** | Bajo el `h4`, `role="alert"` en `--flit-danger-text`: `No se pudieron cargar los parámetros de lectura. [Reintentar]`. **No** se pintan campos ni botón: no se adivinan valores. El interruptor y el estado siguen funcionando |
| **Vacío útil** (`actualizadoEn = null`) | Los campos llegan con los valores por defecto que manda el GET (2 / 7 / 60 / hoy − 1 mes). Línea muted bajo el `h4`: `Valores por defecto: nadie los ha cambiado en este ambiente.` Con `arranquePorDefecto = true`, la ayuda del arranque añade `Por defecto, un mes antes de hoy.` El siguiente paso es el propio formulario |
| **Lleno** | Valores vigentes. Línea muted: `Cambiados por {nombre} el {14 oct.} a las {9:10 a. m.}.` (si es de hoy, `hoy a las …`). Con `actualizadoPor = null` y fecha: `Cambiados el …` |

### Campos: etiqueta, ayuda (rango visible) y errores

- Los rangos salen de `LIMITES_PARAMETROS_LECTURA_FLIT1`, **no** escritos a mano en el JSX.
- Cada campo: `<label htmlFor>` con el estilo de `FlitField`, input `flitInp h-10` y la ayuda en muted 11 px con `id`.
- El input apunta a ayuda + error con `aria-describedby`.
- Numéricos: `type="number" inputMode="numeric" min max step={1}`.
- Arranque: `type="date" max={hoy en Bogotá}`.

| Campo | Etiqueta | Ayuda (siempre visible) |
|---|---|---|
| `frecuenciaMinutos` | `Frecuencia (minutos)` | `Cada cuánto lee FLITO a FLIT 1. De 2 a 60.` |
| `ventanaDias` | `Ventana (días)` | `Cuántos días hacia atrás revisa cada lectura. De 1 a 90.` |
| `ventanaNocturnaDias` | `Ventana nocturna (días)` | `Días hacia atrás que revisa la lectura de la noche, para recoger cambios tardíos. De 7 a 90 y no menos que la ventana.` |
| `arranque` | `Fecha de arranque` | `FLITO no lee trámites anteriores a esta fecha. Hoy o antes.` (+ `Por defecto, un mes antes de hoy.` si `arranquePorDefecto`) |

La semántica exacta de «ventana nocturna» está **por confirmar** con la #13629: si la lectura de la noche
no es lo que la ayuda dice, se ajusta solo esa frase.

**Errores en el campo (AC3).** Van en `--flit-danger-text`, 11 px, debajo de la ayuda, con `aria-invalid="true"`.
Se validan al salir del campo (blur) y al guardar. Al guardar con errores **no sale el PUT** y el foco va
al primer campo inválido.

| Regla | Mensaje |
|---|---|
| Frecuencia vacía | `Escribe la frecuencia en minutos.` |
| Ventana vacía | `Escribe la ventana en días.` |
| Nocturna vacía | `Escribe la ventana nocturna en días.` |
| Fuera de rango o no entero | `Debe ser un número entero de {min} a {max}.` |
| Nocturna < ventana | `No puede ser menor que la ventana ({v} días).` Se recalcula al cambiar la ventana, si la nocturna ya se había tocado |
| Arranque vacío | `Elige la fecha de arranque.` |
| Arranque futuro (Bogotá) | `No puede ser una fecha futura.` |

**400 `datos_invalidos` del API** (el cliente pasó, pero el servidor discrepa: reloj o huso):
- Cada campo de `campos[]` se marca con el mensaje de su regla. Si la regla local no lo explica, se usa `Revisa este valor.`
- Sobre la barra, `role="alert"`: `No se guardó: revisa los campos marcados.`
- El foco va al primero.
- **Sin toast**: es un error de campo (principios §Notificaciones).
- `faltantes` (texto técnico) **nunca** se pinta.

**Botón «Guardar parámetros»:**

| Situación | Comportamiento |
|---|---|
| Sin cambios respecto a lo vigente | `aria-disabled="true"` (enfocable), estilo deshabilitado del kit; `aria-describedby` → texto `sr-only` `Cambia un valor para guardar.` |
| Con cambios | Activo |
| Guardando | Texto `Guardando…`, `aria-disabled` + `aria-busy`, campos `readOnly` (el kit ya pinta `[readonly]`). No se usa `disabled` nativo, para no perder el foco |

**Borrador:** el estado del formulario vive en `SincronizacionTramites` (fuera del panel del acordeón). Si
se contrae y se vuelve a abrir en la misma visita, lo escrito sigue ahí. Al salir de la página se pierde,
sin diálogo de «cambios sin guardar» (coste bajo).

### Copy que cambia porque «Sincronizar FLIT» ya no existe (sustituye a la sección HU #13238)

| Pieza | Nuevo copy |
|---|---|
| Explicación con `configurar` (N de los parámetros vigentes, se actualiza al guardar) | `FLITO lee FLIT 1 automáticamente cada {N} minutos.` (N = 1 no ocurre: el mínimo es 2) |
| Explicación sin `configurar` | `FLITO lee FLIT 1 automáticamente.` |
| Motivo FLIT 1 apagada, con `configurar` | `FLIT 1 está apagada: FLITO no lee trámites de FLIT 1. Enciéndela con el interruptor para que la lectura automática siga.` |
| Motivo FLIT 1 apagada, sin él | `FLIT 1 está apagada en este ambiente: FLITO no lee trámites de FLIT 1. Pídele a un administrador que la encienda.` |
| Diálogo «¿Apagar FLIT 1?», cuerpo | `Mientras esté apagada, FLITO no lee trámites de FLIT 1 en este ambiente. Lo que ya entró no cambia.` |
| Toast apagar FLIT 1 | `FLIT 1 quedó apagada: FLITO deja de leer trámites de FLIT 1.` |
| Toast encender FLIT 1 | `FLIT 1 quedó encendida: la lectura automática sigue en la próxima vuelta.` |

Se retiran: la frase «Elige desde qué fecha traer trámites y pulsa Sincronizar FLIT.», «Nunca sincronizado»,
los toasts del POST `/flito/sync/sincronizar` y el manejo del 409 `FUENTE_APAGADA` en la UI. El texto del
motivo que hoy está en el código («La sincronización con FLIT 1 está apagada desde Sincronización.») se
sustituye por el de esta tabla.

### Tablero (AC7)

Sin estados nuevos. La cabecera queda sin `actions` y desaparecen `sincronizar`, la tarjeta `sync` y la
nota «Solo lectura». La tarjeta de error de carga del Tablero (`text-red-600`) es **preexistente** y queda
fuera de alcance: va como Nota del PR, no como cambio.

## Responsive + feedback del delta

**Móvil (<`lg`):**
- Los grupos se apilan (sin cambio).
- El par «Última / Próxima» es `flex flex-wrap gap-x-6 gap-y-2` y se apila en 375.
- Los parámetros son `grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3`: una columna en móvil y 2×2 desde `sm`, también dentro del medio ancho a `lg`.
- Los inputs son `w-full`, sin `min-w`.
- La barra es `flex flex-wrap justify-end` con el botón `w-full sm:w-auto`.
- La línea quién/cuándo y los avisos usan `break-words`.

**Hover y foco:**

| Control | Hover | Foco |
|---|---|---|
| Inputs numéricos y fecha | El de `flitInp` (borde a `--flit-text-muted`) | `flit-focus` del kit |
| «Guardar parámetros» | `flitBtnPrimary` (velo `--flit-veil-press-hover`) | el del kit |
| «Reintentar» (estado y parámetros) | `hover:underline`, como en `LineaEstadoFlit2` | `flit-focus` |

Una sola altura por barra: `h-10`.

**Toast o aviso:**

| Acción / estado | Patrón | Copy |
|---|---|---|
| Guardar ok (AC2) | `toastOk` cerrable, ~4 s, id `sync-parametros-flit1`. El formulario adopta la respuesta del PUT (sin cambios), la línea «Cambiados por…» se actualiza y el estado se refresca en silencio | `Parámetros de lectura guardados. FLITO los usa desde la próxima lectura.` |
| 400 `datos_invalidos` | En el campo + `role="alert"` sobre la barra (sin toast) | ver arriba |
| 403 | `toastError` sin Reintentar. El bloque pasa a solo lectura: campos `readOnly`, sin botón y línea muted `Solo lectura: pídele a un administrador si hay que cambiarlos.` | `No tienes permiso para cambiar los parámetros de lectura. Pídeselo a un administrador.` |
| Red / 5xx | `toastError` **con Reintentar** (repite el mismo PUT). Lo escrito se conserva | `No se pudieron guardar los parámetros de lectura. Inténtalo de nuevo.` |
| Fallo de lectura vigente | Aviso de página (`role="status"`) | tabla de códigos |

## Permiso/slug

- Sin `PageSlug` nuevo: siguen `FlitoTramites` y `FlitoTablero`.
- Ver y editar parámetros: `tramites.sincronizacion.configurar`.
- Ver el estado de la lectura: `configurar` **o** `sync.sync.ver_estado`.
- **Visibilidad de la sección.** Sin el botón, `esOperaciones` y `sync.sync.lanzar` dejan de ser motivo para pintarla. La condición pasa a `configurar || sync.sync.ver_estado || tramites.flit2.ver_acceso`. Si no, quien solo tiene `lanzar` vería un grupo FLIT 1 vacío (el GET le daría 403). Es una decisión de UX, se declara en el PR.
- `sync.sync.lanzar` deja de usarse en la web (Trámites y Tablero). Si conviene retirarla del catálogo, es otra conversación.

## Notas para QA (≤10)

1. Admin, zona abierta: no hay «Sincronizar FLIT», «Elegir fecha» ni «Desde». La explicación dice `cada {N} minutos` con el N guardado. La **única** `flitBtnPrimary` de la zona es «Guardar parámetros».
2. Ambiente sin parámetros guardados: 2 / 7 / 60 / hoy − 1 mes, la línea «Valores por defecto…» y la ayuda del arranque con «Por defecto, un mes antes de hoy.».
3. AC3, sin petición en la red: frecuencia 1 y 61, ventana 0, nocturna 6, nocturna 5 con ventana 10, arranque mañana y campo vacío. Cada caso da su mensaje en el campo y el foco va al primero inválido.
4. AC2: cambiar la frecuencia a 5 y guardar → toast cerrable, explicación «cada 5 minutos», línea «Cambiados por {tú}…». Recargar → sigue en 5.
5. 400 simulado con `campos:['arranque']` → campo marcado + «No se guardó: revisa los campos marcados.», sin toast y sin texto de `faltantes`. 500 → toast con Reintentar y lo escrito intacto.
6. AC4: con `parametros-lectura` en 500, error con Reintentar y sin campos; el interruptor se mueve normal. Con `estado-lectura` en 500, «No se pudo consultar · Reintentar» y los parámetros siguen editables.
7. AC5, usuario con `ver_estado` sin `configurar`: no sale el GET de parámetros (red), no hay campos ni botón, y se ven la última lectura, la próxima y el fallo. Fallo vigente `flit1_timeout` → aviso `status` con frase humana y el distintivo «Requiere atención» en el resumen del acordeón contraído. Fallo anterior a la última lectura buena → solo la línea muted. Ningún código visible (probar también `flit1_http_502` y un código inventado).
8. FLIT 1 apagada: «Lectura detenida», aviso de apagada sin mención a «Sincronizar FLIT», parámetros editables.
9. AC7, Tablero: sin botón en la cabecera, sin tarjeta «Sincronización ejecutada» y sin la nota «Solo lectura», con y sin `sync.sync.lanzar`.
10. AC8, visual (adjuntar al PR):
    - Capturas a 1366 en claro y en oscuro, admin con fallo vigente.
    - Captura a 375 sin scroll horizontal (`scrollWidth <= 375`), campos en una columna y botón a ancho completo.
    - Foco visible en los 4 campos, en «Guardar parámetros» y en los Reintentar; hover del input y del botón.

## Preguntas abiertas (no bloquean la implementación)

1. **N para quien no configura (AC6).** `estado-lectura` no trae `frecuenciaMinutos`, y `parametros-lectura` exige `configurar`. Por eso, sin ese permiso, la explicación va sin N. Si el PO quiere «cada N minutos» para todos, es un requerimiento menor para backend/architecture (añadir `frecuenciaMinutos` al GET de estado). No se inventa en el front.
2. **Semántica que fija la #13629:** qué es exactamente la «lectura de la noche» (ayuda de la ventana nocturna) y si `tramites_con_fallo` se reintenta dentro de la ventana. Si difiere, solo cambian esas dos frases.

## Decisiones y descartes del delta

- **Inline y no plegable:** ver «Inline o plegable». El acordeón exterior ya hace de plegable.
- **Hora prevista y no cuenta en vivo:** con 2 min de frecuencia, una cuenta siempre corriendo es ruido. FLIT 2 la tiene porque su ciclo es más largo y tiene «en curso».
- **Fallo vigente vs superado:** un aviso permanente de un fallo ya resuelto sería una falsa alarma. La regla compara con `ultimaLecturaBuenaEn`, no con el reloj.
- **Sin «Restablecer por defecto», sin «Descartar» y sin diálogo de confirmación al guardar:** el cambio es reversible y se audita. Confirmar sería fricción sin riesgo que la justifique, a diferencia de apagar la fuente.
- **Sin componente nuevo:** `FlitAcordeon`, `FlitField` (estilo de etiqueta), `flitInp`, `flitBtnPrimary`, `flitBtnSecondary`, `toastOk`/`toastError` de `ToastFlito`, `FlitSwitch` (ya existe) y los helpers de fecha y el `Reintentar` calcados de `EstadoFlit2.tsx`. Sin iconos, sombras ni animación nueva (solo el `animate-pulse` del esqueleto, que ya existe).
