# UX slim (ambicioso) — Tarjeta «SOAT activo» y paso de consulta del VIN (HU #12844)

Feature #12840 · canal **Cliente** · módulo `flito-soat` (canal Cliente, `/api/flito/soat/cliente/*`).
Pantalla: `apps/web/src/pages/FlitoSoatSolicitud.tsx`, bloque **1 · Vehículo**. Contrato: HU #12842.
Modo **slim**: extiende una pantalla que ya existe y reutiliza el kit. Se rediseña a fondo el bloque 1, como pidió David: «que se note».

---

## 1. Superficie tocada

| Qué | Hoy | Después |
|---|---|---|
| Bloqueo `409 soat_vigente` | `ModalSoatVigente` (modal, sin datos de la póliza) | **Tarjeta en línea** `TarjetaSoatActivo` variante `bloqueo`, dentro del bloque 1 |
| Aviso `vigenciaProxima` (200) | Caja con chip «Puede continuar» y una frase | La **misma tarjeta**, variante `aviso`, con los seis datos |
| Paso del VIN | Campo, botón desalineado con `sm:mt-[1.35rem]`, 3 líneas grises sueltas | Jerarquía nueva: campo destacado con contador, ayuda con icono, vacío explicativo, carga con esqueleto y bandas de desenlace con icono |
| `Seccion` (bloques 1-3) | Solo el título | Icono lucide opcional delante del título (bloques 1, 2 y 3, para que se lean igual) |

Fuera de alcance: el bloque 2 (factura), el bloque 3 (propietario), la barra de envío y `ModalVinEnCola`. Solo cambia su icono de sección.

## 2. Qué vino a hacer, qué se ve primero y qué se calla

**Qué vino a hacer:** el concesionario o banco escribe el VIN y quiere saber si puede pedir el SOAT de **ese** vehículo. Después confirma que es el suyo.

**Qué se ve primero:** el campo VIN y su botón. Justo debajo aparece **la respuesta a «¿puedo seguir?»**. Esa respuesta es la tarjeta si hay SOAT activo, o la banda si hubo un fallo. La ficha del vehículo va al final.

**Qué se calla:**
- El texto «Con el VIN, el RUNT nos dice la placa…» sale del pie fijo. Pasa a ser el **estado vacío** y solo se ve antes de la primera consulta.
- La ayuda «Suele tener 17 caracteres» se quita, porque el contador ya dice cuántos caracteres lleva el VIN.
- En la tarjeta no aparece la jerga del RUNT («modalidad», códigos de estado internos) ni el VIN.

**Densidad:** **aliviada.** De tres párrafos grises sueltos se pasa a una sola línea de ayuda y un estado a la vez. La tarjeta añade seis datos, pero **reemplaza** a un modal y a una caja. No se apila encima de nada.

### Decisión 1 — Bloqueo: la tarjeta en línea sustituye al modal

Se descarta el modal `SOAT_VIGENTE` y la tarjeta queda en la página, en el bloque 1. Razones:

1. **Es un estado que sigue siendo cierto** mientras el VIN no cambie. Según `_principios-flito.md` («Notificaciones»), un estado persistente va en un aviso o una tarjeta de la página, no en una superposición que se cierra y desaparece. Hoy, al cerrar el modal, el Cliente pierde la fecha y solo le queda la frase de la barra de envío.
2. **Muestra lo que se vino a ver.** El Cliente quiere los seis datos de la póliza que ya existe, y un modal los tapa en cuanto se cierra.
3. **Aviso y bloqueo usan la misma tarjeta en el mismo sitio** (AC2: «la misma tarjeta»). Si uno fuera modal y el otro fuera en línea, el Cliente aprendería dos lenguajes para un mismo dato.
4. **Una primaria.** El modal traía su propia primaria, «Consultar otro vehículo», que competía con la de la página. En línea, la primaria de la página sigue siendo **Enviar al gestor**, en `aria-disabled`, con la frase `AVISO_VIGENTE`. La acción de la tarjeta es secundaria.

«**Cerrar**» la tarjeta (AC1) es el botón **Consultar otro vehículo**: cierra la tarjeta, limpia el VIN y deja el foco en el campo VIN. También desaparece si el Cliente edita el VIN, que pasa a `invalidada` o `inicial` como hoy. **No** hay un ✕ aparte, porque serían dos formas de cerrar con resultados distintos.

---

## 3. Wireframes (ASCII = contrato)

### 3.1 Bloque 1 · estado vacío (antes de consultar) — ≥ lg

```
┌─ [Car] 1 · Vehículo ─────────────────────────────────────────────────────────┐
│ VIN (número de chasis)                                                        │
│ ┌──────────────────────────────────────────────┐ ┌───────────────────────┐   │
│ │ 9FKRG2222T2042405                     (mono) │ │ [Search] Consultar el │   │  ← misma altura
│ └──────────────────────────────────────────────┘ │          RUNT         │   │
│ [Info] Está en la tarjeta de propiedad    17 de 17└───────────────────────┘   │  ← ayuda + contador
│        y en la factura de venta.                                              │
│                                                                               │
│ ┌ bg-app · border-soft ───────────────────────────────────────────────────┐   │
│ │ [ScanSearch]  Con el VIN, el RUNT le trae la placa, la marca, la línea,  │   │  ← VACÍO
│ │               el modelo y la ficha técnica. Usted no tiene que escribirlos│   │
│ └──────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Cargando

```
│ ┌────────────────────────────── readOnly ───┐ ┌─────────────────────────────┐ │
│ │ 9FKRG2222T2042405                         │ │ [Loader2] Consultando el RUNT…│ │ (disabled)
│ └───────────────────────────────────────────┘ └─────────────────────────────┘ │
│ ┌ esqueleto de la FICHA (misma rejilla que FichaRunt, sin texto) ──────────┐  │
│ │ ▭▭▭▭   ▭▭▭▭▭▭   ▭▭▭▭   ▭▭▭▭▭                                            │  │
│ │ ▭▭▭▭▭  ▭▭▭▭     ▭▭▭▭▭  ▭▭▭▭                                             │  │
│ └──────────────────────────────────────────────────────────────────────────┘  │
│ (role=status) La consulta puede tardar hasta un minuto. No cierre esta página.│
```

### 3.3 Tarjeta — variante BLOQUEO (409 `soat_vigente`)

```
┌ TarjetaSoatActivo · bg-app · border-soft · radius 10px ────────────────────────┐
│ (●ShieldCheck)  Este vehículo ya tiene SOAT activo   [● No hace falta comprar otro]│ ← h3 + chip success
│                 Vence el 14 de marzo de 2027. FLITO podrá tramitar la renovación   │
│                 cuando falten 30 días o menos.                                     │
│ ──────────────────────────────────────────────────────────────────────────────  │
│ ASEGURADORA            VENCE                       PÓLIZA                        │ ← fila 1: text-sm semibold
│ Seguros del Estado     14 de marzo de 2027         AT-1329-2045501               │
│ INICIO DE VIGENCIA     FECHA DE EXPEDICIÓN         ESTADO                        │ ← fila 2: text-sm normal
│ 15 de marzo de 2026    10 de marzo de 2026         VIGENTE                       │
│                                                                                  │
│                                              [ Consultar otro vehículo ]         │ ← flitBtnSecondary
└──────────────────────────────────────────────────────────────────────────────────┘
(No hay ficha del vehículo: el 409 no la trae.)
```

### 3.4 Tarjeta — variante AVISO (200 con `vigenciaProxima`)

```
┌ TarjetaSoatActivo ────────────────────────────────────────────────────────────┐
│ (●CalendarClock) Este vehículo todavía tiene SOAT activo   [● Puede continuar] │ ← h3 + chip active
│                  Vence el 5 de octubre de 2026 · en 11 días.                   │
│                  Como le faltan 30 días o menos, sí puede enviar la solicitud.  │
│ ─────────────────────────────────────────────────────────────────────────────  │
│ ASEGURADORA          VENCE                      PÓLIZA                          │
│ …                    5 de octubre de 2026       …                               │
│ INICIO DE VIGENCIA   FECHA DE EXPEDICIÓN        ESTADO                          │
│ …                    —                          VIGENTE                         │ ← AC4: «—»
└────────────────────────────────────────────────────────────────────────────────┘
┌ FichaRunt (sin cambios de contenido) ─────────────────────────────────────────┐
```
La variante aviso **no tiene botón**: el siguiente paso es seguir bajando por el formulario.

### 3.5 Banda de fallo (reemplaza la actual; mismo sitio)

```
┌ bg-app · border-soft ─────────────────────────────────────────────────────────┐
│ (●CircleAlert)  El RUNT no está disponible, vuelva a consultar.                │ ← título text-primary
│                 No es un problema de sus datos: … pulse Volver a consultar.    │
└────────────────────────────────────────────────────────────────────────────────┘
El botón del renglón pasa a «[RotateCw] Volver a consultar» (primario) y recibe el foco.
```

---

## 4. Estructura de la tarjeta (decisión 2)

**Componente nuevo** `components/flito/soat-cliente/TarjetaSoatActivo.tsx`. Es una composición, no un patrón nuevo: la superficie `bg-app` + `border-soft` + radio 10px **es la de la banda que ya existe**, los pares `dt/dd` son los de `FichaRunt` y el chip es `StatusChip`.

```ts
props: { variante: 'bloqueo' | 'aviso'; datos: SoatActivoRunt; venceEl?: string | null;
         onConsultarOtro?: () => void /* solo bloqueo */; tituloRef?: Ref<HTMLHeadingElement> }
```

### Orden de los datos (fijado)

| # | Rótulo (`dt`) | Campo | Por qué en ese lugar |
|---|---|---|---|
| 1 | Aseguradora | `aseguradora` | Es lo primero que pregunta quien llama a renovar |
| 2 | Vence | `vencimiento` | Es el dato que decide |
| 3 | Póliza | `poliza` | Sirve para identificar el contrato ante la aseguradora |
| 4 | Inicio de vigencia | `inicioVigencia` | Contexto |
| 5 | Fecha de expedición | `fechaExpedicion` | Contexto |
| 6 | Estado | `estado` | Lo que devuelve el RUNT, tal cual. Va en texto y **no** en chip, para no competir con el chip de la variante |

- La fila 1 (1-3) va en `text-sm font-semibold` y la fila 2 (4-6) en `text-sm` normal. Así la jerarquía se lee sin color.
- `dt` usa la clase de `FichaRunt`: `text-[11px] uppercase tracking-wide` con `--flit-text-muted`. `dd` va en `--flit-text-primary`. **Se exporta el par de `FichaRunt`** (`Dato`/par dt-dd) en vez de copiarlo.
- Póliza: `tabular-nums break-all`. Un número de 20 caracteres no debe desbordar a 375 px.
- **AC4:** un valor `null`, vacío o una fecha que no se puede leer se pinta `—`. Ninguna fila se omite: las seis se pintan siempre.

### Fechas

Se usa `fechaLarga(iso)` de `lib/soatCliente.ts`, el formato que ya usa la pantalla, por ejemplo «14 de marzo de 2027». El valor **se valida antes** con la misma `FECHA_ISO` de `avisoVigenciaProxima`: `fechaLarga` no valida y escribiría «Invalid Date». Si no es una fecha válida, se pinta `—`.

### «Vence en N días» (solo en el aviso)

- Helper puro nuevo en `soatCliente.ts`: `diasHasta(iso: string, hoy: Date): number | null`. Parte la fecha por componentes, igual que `fechaLarga`, para no sufrir el desfase UTC→Colombia. Trabaja con días de calendario, sin horas.
- Rótulo: `0` → «vence **hoy**», `1` → «vence **mañana**», `2…30` → «Vence el {fecha} · en {N} días».
- Si el resultado es `null`, negativo o mayor que 30, **se omite la cuenta** y queda solo «Vence el {fecha}». La pantalla **no decide umbrales** (sigue valiendo la regla de la #12213): la cuenta solo rotula lo que el servidor ya decidió y nunca lo contradice.
- Si `venceEl` no sirve pero `vencimiento` sí, se usa `vencimiento`. Si no sirve ninguno, se usa la frase de respaldo completa: «Este vehículo todavía tiene SOAT activo y le faltan 30 días o menos para vencerse, así que sí puede enviar esta solicitud.» Nunca se escribe «hasta el —».
- En el bloqueo la fecha de la frase sale de `soatActivo.vencimiento ?? fechaVencimiento`. Sin ninguna de las dos, la frase es «FLITO podrá tramitar la renovación cuando falten 30 días o menos para que venza.»

### Copy (usted)

| | Bloqueo | Aviso |
|---|---|---|
| Título (`h3`) | Este vehículo ya tiene SOAT activo | Este vehículo todavía tiene SOAT activo |
| Chip | `success` · «No hace falta comprar otro» | `active` · «Puede continuar» |
| Icono (lucide) | `ShieldCheck` | `CalendarClock` |
| Frase | Vence el {fecha}. FLITO podrá tramitar la renovación cuando falten 30 días o menos. | Vence el {fecha} · en {N} días. Como le faltan 30 días o menos, sí puede enviar la solicitud. |
| Acción | `Consultar otro vehículo` (secundaria) | ninguna |

El «todavía» y el «sí» del aviso se conservan. Sin ellos, el aviso se leería como un bloqueo (razón de la #12213). `AVISO_VIGENCIA_DETALLE` y `AVISO_VIGENCIA_SIN_FECHA` pasan de «un mes o menos» a «30 días o menos», que es lo que dice el contrato de la #12842.

### AC3 — distinguir las variantes sin depender del color

Las variantes se distinguen por **título, icono y texto del chip**, y además por el tono. El icono va en una **insignia circular** de 32 px (`h-8 w-8 rounded-full`) con fondo `--flit-chip-{success|active}-bg` y trazo `--flit-{success|blue}-ink`. Son los tokens de `StatusChip`, que mantienen el pastel en los dos temas, así que la insignia mide igual en claro y en oscuro. El icono es `aria-hidden`.

---

## 5. Rediseño del paso del VIN (decisión 3)

1. **Encabezado de sección con icono.** `Seccion` recibe `icono?: ReactNode` opcional, que se pinta a la izquierda del título en `--flit-blue-text`, 18 px y `aria-hidden`. Bloque 1 `Car`, bloque 2 `FileText`, bloque 3 `UserRound`. Es el único cambio en los bloques 2 y 3, y hace que la página entera se lea como un solo asistente. El chip «Consultado» cambia el glifo «✓» por `icono={<CircleCheck size={14} aria-hidden />}`.
2. **Renglón de consulta con una sola altura.** El rótulo va **fuera** del renglón. El renglón es `flex flex-wrap items-stretch gap-3`: el input (`flex-1 basis-64 min-w-0`) y el botón comparten la altura de control del kit (la de `flitBtnPrimary`). Se elimina el `sm:mt-[1.35rem]`. Si `Campo` no permite separar el rótulo, se le añade `ayudaFuera`/`sinAyuda`; no se hace un input suelto.
3. **El VIN se lee como un código.** Input en `font-mono tracking-wider uppercase`, `text-base`, `autoCapitalize="characters"`, `spellCheck={false}`, `inputMode="text"` y `maxLength` 25 como hoy. La normalización no cambia (`normalizarVin`).
4. **Ayuda y contador en una sola línea bajo el renglón.** A la izquierda, `Info` 14 px + «Está en la tarjeta de propiedad y en la factura de venta.». A la derecha, el contador «{n} de 17» (`tabular-nums`, `--flit-text-muted`, calculado sobre el valor **normalizado**). El contador **no** es región viva: forma parte del `aria-describedby` y se lee al enfocar. La línea envuelve en móvil.
5. **Validaciones de AC6 (reglas intactas, cambia su presentación).** El error de campo se pinta con `CircleAlert` 14 px + texto `--flit-danger-text` (tiene par oscuro), el borde del input en error y `aria-invalid`. Casos: I/O/Q, más de 17, menos de 11 o vacío. El **aviso** de 11 a 16 caracteres lleva `TriangleAlert` 14 px en insignia `--flit-chip-warning-bg`/`--flit-warning-ink` + texto en `--flit-text-secondary`. **No** va en `--flit-warning-ink` como texto, porque ese token no tiene par oscuro. El aviso **no** bloquea «Consultar». Si hay error, el aviso no se muestra (esto ya es así).
6. **Estado vacío explicativo.** Es la caja 3.1, con `ScanSearch` y el texto que hoy está suelto al pie. Solo se ve en la fase `inicial` o `invalidada`.
7. **Carga.** El botón muestra `Loader2` con `animate-spin motion-reduce:animate-none` y el texto «Consultando el RUNT…», en `disabled`. El input queda en `readOnly`. En el sitio de la ficha se pinta un **esqueleto de la rejilla de `FichaRunt`**: bloques `--flit-bg-hover` sobre `bg-app`, con el mismo tratamiento que `PageContentSkeleton` (si ese componente pulsa, se pulsa igual con `motion-reduce`; si no, queda estático). Debajo va la frase `role="status"` que ya existe.
8. **Bandas de desenlace (3.5).** Mismo sitio, mismo `role="alert"` y mismo copy de `DESENLACE*`. Cambia la presentación: el icono va en una insignia de chip (`danger` → `--flit-chip-danger-bg`/`--flit-danger-ink`, `warning` → `--flit-chip-warning-bg`/`--flit-warning-ink`) y el título pasa a `--flit-text-primary`. Hoy el título `warning` en `--flit-warning-ink` da ~2,6:1 en oscuro: **es un defecto de contraste que se corrige aquí**. El tono se lee por la insignia y el copy, no por la tinta del texto.
9. **Botón de consulta.** El rótulo sigue `ROTULO_CONSULTA`. Icono `Search` en `inicial`, `RotateCw` en `fallo`/`invalidada`/`sin-banda`. Es primario hasta que la consulta sale bien o bloquea. En `ok` y en bloqueo pasa a secundario, como hoy en `ok`.

---

## 6. Estados (4) del paso 1 + copy

| Estado | Qué se ve | Siguiente paso |
|---|---|---|
| **Vacío** (`inicial`) | Renglón VIN + caja explicativa `ScanSearch` | «Con el VIN, el RUNT le trae la placa, la marca, la línea, el modelo y la ficha técnica. Usted no tiene que escribirlos.» El primario del renglón dice qué hacer |
| **Cargando** | Botón con `Loader2` («Consultando el RUNT…»), input `readOnly`, esqueleto de la ficha, frase `role=status` | «La consulta puede tardar hasta un minuto. No cierre esta página.» |
| **Error** | Banda 3.5. El **503 `runt_no_disponible`** usa tono `warning` y su copy actual. El foco va al botón, que ahora dice «Volver a consultar» (**ese es el reintento**, sin un segundo botón). `runt_no_cuadra` y `sin_registro` son `danger` y el foco va al VIN. Sin red o código desconocido: `DESENLACE_SIN_RED`/`GENERICO` | Copy ya pulido en `soatCliente.ts`; nunca el `mensaje` crudo del API. «VIN no encontrado» (AC6) = `runt_sin_registro`: «El RUNT no tiene registrado ningún vehículo con ese VIN. Compruébelo en la tarjeta de propiedad…» |
| **Lleno** | Chip `CircleCheck` «Consultado» · [tarjeta aviso si llega `vigenciaProxima`] · `FichaRunt` | Seguir al bloque 2. Con aviso, la tarjeta dice «sí puede enviar» |
| **Bloqueo** (desenlace terminal) | Tarjeta 3.3 en el sitio de la ficha, sin ficha. Enviar al gestor en `aria-disabled` con `AVISO_VIGENTE` | «Consultar otro vehículo» (o editar el VIN) |
| Vencido / sin SOAT (AC5) | Lleno normal, **sin tarjeta** | — |

**Foco:**
- **Bloqueo:** al montarse la tarjeta, el foco va a su `h3` (`tabIndex={-1}`, `flit-focus`). Así el lector anuncia la variante y el Cliente recorre en orden la frase y los seis pares `dt/dd`. Esto también aplica cuando el 409 llega en el **envío**: la tarjeta aparece arriba y el foco sube a ella.
- **«Consultar otro vehículo»:** el foco va a `vinRef` (AC1).
- **Aviso:** el contenedor es `role="status"` y el foco no se mueve, igual que en la #12213. El lector lee título, frase y datos en el orden del DOM.
- La tarjeta es `<section aria-labelledby={idTitulo}>`. El `aria-label` **no** interpola póliza, VIN ni aseguradora.

## 7. Responsive (<lg) y tema

- **375 px:** el renglón VIN envuelve y el botón pasa a ancho completo (`w-full sm:w-auto`). La línea de ayuda envuelve y el contador baja a su propio renglón, alineado a la derecha.
- **Tarjeta a 375 px:** `grid-cols-2 sm:grid-cols-3`. Aseguradora ocupa `col-span-2 sm:col-span-1`. La cabecera (insignia + título + chip) es `flex flex-wrap` y el chip baja bajo el título. El botón «Consultar otro vehículo» ocupa el ancho completo.
- **Esqueleto:** la misma rejilla que `FichaRunt` (`grid-cols-2 sm:grid-cols-4`).
- **Oscuro:** todas las superficies usan `--flit-bg-app`, `--flit-border-soft`, `--flit-text-primary`/`-secondary`/`-muted` y `--flit-danger-text`, que tienen par. Insignias y chips usan los tokens `--flit-chip-*` y conservan el pastel en los dos temas. **Prohibido** usar `--flit-success-ink`, `--flit-warning-ink` o `--flit-blue-ink` como tinta de texto sobre la tarjeta, porque no tienen par oscuro. `bg-white`, HEX, `slate-*` y `gray-*` también quedan prohibidos.
- **AC8:** se verifica a 1366 y 375 px en claro y a 1366 px en oscuro, sin desborde horizontal (en 375, una póliza larga debe partirse), con contraste ≥ 4.5:1 en el texto y ≥ 3:1 en la insignia y el foco.

## 8. Feedback de interacción y notificaciones

- **Hover y foco (AC9):** los botones (`flitBtnPrimary/Secondary`) llevan `transition-colors` + `hover:bg-[var(--flit-bg-hover)]` si el kit no lo trae. Todos usan `flit-focus`. El input usa `--flit-border-focus` y el anillo del kit. El `h3` enfocable muestra `flit-focus` solo con teclado (`focus-visible`). Una sola altura de control en el renglón VIN.
- **Toast: ninguno en el paso 1.** Bloqueo, aviso, fallo y consultado son **estados que siguen siendo ciertos**, así que van en la tarjeta o en la banda de la página. El único toast de la pantalla sigue siendo el de envío (`toastOk(TOAST_ENVIADA)`, cerrable, #12819).
- El modal `ModalSoatVigente` **se retira**. `ModalVinEnCola` se queda: es otra causa (RN-01), no se muestra con datos y no entra en esta HU.

## 9. Permiso / slug

Sin cambios: la página y el `PageSlug` del canal Cliente siguen como están. No hay ruta nueva ni migración de siembra. Ningún dato viaja por URL: el VIN va en el body de `POST /flito/soat/cliente/preconsulta`.

## 10. Tokens y componentes del kit

| Uso | Token / clase |
|---|---|
| Superficie de la tarjeta, la banda y el vacío | `background: var(--flit-bg-app)`, `border: 1px solid var(--flit-border-soft)`, `rounded-[10px] p-4` (`sm:p-5`) |
| Separador cabecera/datos | `border-t` en `--flit-border-soft` |
| Título | `text-base font-semibold`, `--flit-text-primary` |
| Frase | `text-sm`, `--flit-text-secondary` |
| `dt` / `dd` | Par exportado de `FichaRunt` (`text-[11px] uppercase tracking-wide` `--flit-text-muted` / `--flit-text-primary`) |
| Insignia del icono | `--flit-chip-success-bg` + `--flit-success-ink` · `--flit-chip-active-bg` + `--flit-blue-ink` · `--flit-chip-danger-bg` + `--flit-danger-ink` · `--flit-chip-warning-bg` + `--flit-warning-ink` |
| Error de campo | `--flit-danger-text` |
| Hover / foco | `--flit-bg-hover`, `flit-focus`, `--flit-border-focus` |

Componentes reutilizados: `StatusChip` (con `icono`), `flitBtnPrimary/Secondary` + estilos, `Seccion`/`Campo` de `soat-cliente/bloques.tsx`, `FichaRunt` (su par dt/dd), el tratamiento de `PageContentSkeleton` y `toastOk` (sin cambios). Iconos lucide: `Car`, `FileText`, `UserRound`, `Search`, `RotateCw`, `Loader2`, `Info`, `ScanSearch`, `CircleAlert`, `TriangleAlert`, `CircleCheck`, `ShieldCheck`, `CalendarClock`.

## 11. Notas para QA (≤10)

1. Un 409 `soat_vigente` muestra la **tarjeta en línea**, no un modal. Tiene seis rótulos en el orden de §4, ningún botón para continuar y Enviar al gestor en `aria-disabled`. El foco cae en el `h3`.
2. «Consultar otro vehículo» limpia el VIN, oculta la tarjeta y deja el foco en `#vin` (AC1). Editar el VIN también retira la tarjeta.
3. Un 200 con `vigenciaProxima` muestra la tarjeta del aviso (`CalendarClock`, chip «Puede continuar»), sin botón, con la ficha debajo, y se puede enviar (AC2).
4. AC3: con los estilos deshabilitados, las variantes siguen diferenciándose por título, icono y chip. El lector anuncia el título y después los pares en orden.
5. AC4: con un campo `null` o una fecha no ISO se ve «—» y nunca «Invalid Date».
6. «En N días»: hoy → «hoy», +1 → «mañana», +11 → «en 11 días». Un `venceEl` a +45 no muestra cuenta. Probar con `TZ=America/Bogota` y con `TZ=UTC`.
7. AC5: vencido o sin SOAT (`vigenciaProxima: null`) → no hay tarjeta.
8. AC6: `…IOQ` da error. 18 o más caracteres normalizados dan error. De 11 a 16 dan aviso y se puede consultar. Menos de 11 da error. `runt_sin_registro` muestra la banda con el foco en el VIN. El contador cuenta sobre el valor normalizado (`9FKRG-2222-T2042405` → 17 de 17).
9. 503 `runt_no_disponible`: banda `warning`, foco en «Volver a consultar», que reintenta. Ningún toast en todo el paso 1.
10. AC8 y AC9: a 1366 y 375 px en claro y a 1366 px en oscuro, sin scroll horizontal. El título de la banda warning cumple 4.5:1 en oscuro. Todos los controles tienen hover y foco visible, y el renglón VIN tiene una sola altura.

## 12. Decisiones y descartes

- **Modal descartado para el bloqueo** (§2): es un estado persistente, está el AC2 de «la misma tarjeta» y hay una sola primaria.
- **Tono del aviso: `active` (azul), no `warning` ni `success`.** `success` ya lo usa el bloqueo, y se necesita otro tono (AC3). `warning` haría que el aviso se leyera como un fallo, que es el error que la #12213 evitó. `active` en el kit significa «en curso / puede seguir».
- **Sin ✕ en la tarjeta:** dos formas de cierre con efectos distintos confunden. Cerrar la tarjeta es consultar otro vehículo.
- **Contador en vez de la frase «Suele tener 17»:** da el mismo dato en vivo y sin repetirlo en tres sitios.
- **Sin adorno:** sin gradientes, sin sombra nueva y sin transición de aparición de la tarjeta. El único movimiento es el giro del `Loader2`, que es feedback de espera y se apaga con `prefers-reduced-motion`.
- **Nota de producto y seguridad, no bloqueante para la UX:** la #12091 y el modal actual callaban **a propósito** la aseguradora y la póliza, porque cualquiera que conozca un VIN obtiene la ficha. Los AC de esta HU los piden y el contrato de la #12842 los entrega, así que la decisión es de esas HUs. Aquí solo se asegura que estos datos no entran en `aria-label`, URL, consola ni toast.
- **La cuenta de días no decide nada:** solo rotula. El umbral sigue siendo del servidor.
