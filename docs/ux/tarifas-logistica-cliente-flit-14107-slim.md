# UX slim — Tarifas · precios de logística «Entrega a cliente» y «Entrega a FLIT» (HU #14107)

Feature B #14090 · Épica #13758. Público: Finanzas (operador interno, escritorio; a veces móvil). Tono: el de la pantalla actual, que **tutea** («revísala», «Tienes un valor sin guardar»).

## Superficie tocada
`Finanzas › Tarifas` (`FlitTarifas.tsx` + `tarifas/MatrizTarifas.tsx`). Se extiende el panel del cliente elegido. No hay ruta ni `PageSlug` nuevos. Cabecera, lista de clientes, historial y modales de cero y de «Dejar de cobrar» se reutilizan tal cual.

## Delta de claridad (qué se ve / qué se calla)
- **Trabajo de la visita:** abrir un cliente, ver qué precio de logística le falta y fijarlo o cambiarlo.
- **Qué se ve primero:** por cliente, el aviso existente «Faltan n valores» y, dentro de la tarjeta, el grupo «Logística» con los dos precios **lado a lado** (manual de UI kit de la Épica). La fila vieja «Negociación logística» (un valor) desaparece; no se muestra el nombre técnico `logistica`.
- **Disposición recomendada:** la tabla conserva solo las filas de trámite digital. «Logística» pasa a un bloque de **dos paneles en rejilla** (`grid-cols-1 sm:grid-cols-2`), bajo el rótulo de grupo «Logística» ya existente, uno por destino. Cada panel muestra: rótulo («Entrega a cliente» / «Entrega a FLIT»), valor en `$` o **«Sin configurar»**, «Desde <fecha> · <quién>» y sus botones. Se descartó mantener dos filas de tabla (no cumple el manual y esconde que son hermanas); si el PO prefiere filas, es solo maquetación, el comportamiento no cambia.
- **«Sin configurar» vs cero:** «Sin configurar» en texto con `--flit-warning-ink` más `StatusChip` tono warning «Falta» (hoy solo es texto atenuado; aquí debe destacar porque bloquea el registro del viaje). Nunca se pinta `$0` por ausencia. Un precio en `$0` se ve `$0`, sin chip.
- **Vigencia:** solo la vigente («Desde 3 nov 2026 · Ana P.»). Las anteriores viven en «Historial» (ya existe, filtrado por ese concepto). No se muestra «hasta».
- **Se calla:** id de vigencia (queda en `data-vigencia`), valor anterior (va al toast) y el chip «Gestiona FLITO / Autogestiona el cliente» sale del panel (ver pregunta 1).
- **Densidad:** de 1 fila de logística a 2 paneles: sube una unidad, justificada por el AC. Sin columnas nuevas.

## Acción primaria
Sin cambio de peso: **«Guardar»** del panel/fila en edición, única primaria. «Fijar valor» / «Cambiar» / «Historial» / «Dejar de cobrar» son secundarios (`flitBtnSecondarySm`). Edición en sitio, un panel a la vez; los demás botones se apagan mientras tanto (comportamiento actual).

## Edición y cero
- Sin valor: «Fijar valor» → campo `$` con foco. Con valor: «Cambiar» → campo con el valor preescrito y seleccionado, más «Antes: $X».
- Guardar crea una vigencia nueva desde ahora (AC2). Lo ya cobrado no cambia; la nota de pie existente se mantiene.
- Guardar `0` abre el modal existente «Cobrar cero por <Entrega a cliente | Entrega a FLIT>» (primaria «Cobrar $0») antes de guardar (AC3). Solo cambia el rótulo.
- Validación en línea bajo el campo (`role="alert"`), no toast.

## Estados (4) + copy
| Estado | Qué se ve |
|---|---|
| Cargando | Esqueleto de la estructura: barras de tabla de trámite + 2 bloques lado a lado de logística. `aria-busy`, `aria-label="Cargando los valores de {cliente}"`. |
| Error | «No se pudieron cargar los valores de {cliente}.» + **Reintentar**; detalle en lenguaje de producto, no el texto crudo del API. Si falla solo un refresco: aviso en línea con «Reintentar». |
| Vacío | Cliente sin precio de logística: ambos paneles «Sin configurar» + chip «Falta» + «Faltan 2 valores» (más los de trámite que falten). Texto en cada panel: «Sin este precio no se puede registrar un viaje con este destino.» y botón «Fijar valor». Sin clientes: copy actual («Todavía no hay clientes…» + «Ir a Clientes y proveedores»). |
| Lleno | Dos paneles con valor, desde y quién, con sus acciones. |

## Responsive + feedback + notificaciones
- **<lg:** la lista de clientes ya se pliega a selector. Los paneles caen a **una columna**; botones con `flex-wrap`; campo `$` a ancho completo; sin `min-w` fijos. Tabla de trámite con el scroll del kit.
- **Feedback:** botones del kit con hover y `flit-focus`; «Sin configurar» y el panel no son interactivos (solo sus botones). Disabled distinguible durante edición/refresco.
- **Toast** (cerrable, ~6 s, una frase): éxito «Entrega a FLIT de {Cliente}: Sin configurar → $12.000. Rige desde ahora.»; mismo valor «Ese ya era el valor vigente. No hay nada que guardar.»; fallo de red/500 «No se pudo guardar. Lo que escribiste sigue aquí; vuelve a intentarlo.» (sin concatenar `e.message`, a diferencia del código actual: ajustar en las filas tocadas).
- **Aviso en página** (`role="alert"`): conflicto 409 «Alguien cambió este valor hace un momento. Ya está actualizado: revísalo y vuelve a intentarlo.»; «Faltan n valores» persistente.

## Accesibilidad
Cada panel es `<section aria-labelledby>` con su rótulo; campo `$` con `<label>` (sr-only) «Valor de Entrega a FLIT de {Cliente}»; botones con `aria-label` que incluyen destino y cliente (patrón actual); el foco vuelve al botón del panel al guardar/cancelar; «Sin configurar» es texto + chip, no solo color; tokens `*-ink` con contraste ≥ 4,5:1 en ambos temas; `role="status"` sr-only anuncia «Faltan n valores».

## Permiso/slug
Existente: `flito_tarifas`. Editar y ver historial por `capacidades` del servidor, no por nombre de rol; sin `capacidades.editar` no hay «Fijar valor»/«Cambiar»/«Dejar de cobrar».

## Datos y dependencia técnica (sin diseñarla)
Endpoints existentes (`GET /tarifas/companias/:id`, `POST /tarifas`, `PATCH /tarifas/:vigenciaId`, historial). **B2 debe** añadir `logistica_flit` a `LLAVES_TARIFA` (shared-types) y a la vista por compañía en `flito-tarifas.service.ts`; hoy `logistica_cliente` llega como `logistica` (alias de lectura) y `etiquetaLlave` debe devolver «Entrega a cliente» / «Entrega a FLIT». `grep` de usos en `apps/web` obligatorio (regla 7). Sin PII nueva.

## Preguntas abiertas (no asumidas)
1. El chip «Gestiona FLITO / Autogestiona el cliente» hoy cuelga de la fila logística. ¿Se conserva (una vez, en el rótulo del grupo)? ¿Un cliente que autogestiona sigue necesitando ambos precios? Propuesta mientras tanto: mostrarlo solo en el rótulo del grupo.
2. Los textos «sus cuatro valores fijados» y el conteo «Faltan n» pasan a incluir `logistica_flit`: ¿se cuenta como faltante para todos los clientes, aunque nunca usen ese camino?
3. «Dejar de cobrar» en «Entrega a FLIT»: ¿se permite (cierra la vigencia y bloquea viajes) o solo cambiar valor? Se asumió que sí, igual que hoy.

## Notas para QA
- Ambos precios visibles lado a lado con desde/quién (AC1).
- Sin precio de FLIT: panel «Sin configurar»/«Falta»; guardar abre vigencia y el valor queda visible y en Historial (AC2).
- Guardar 0: modal «Cobrar cero…» antes de guardar; cancelar no guarda (AC3).
- 4 estados con Reintentar funcional (AC4); 409 y mismo valor.
- Móvil 360 px: una columna, sin scroll horizontal de página.
- Enter guarda, Esc cancela; el foco vuelve al botón.
- Tema oscuro: «Sin configurar» legible.
- Nunca se ve «logistica» ni «logistica_flit»; toasts sin texto crudo del API.

## BRIEF DE MOCKUP VISUAL (el hilo publica Artifact `design` con el Artifact «Design System» de FLITO)
- **Pantalla:** una vista, `Finanzas › Tarifas` con cliente ficticio «Transportes Andina S.A.S.» elegido; escritorio y móvil (<lg), claro y oscuro.
- **Kit:** `PageHeaderCard` («Tarifas»), `FlitCard`, `FlitTable`/`FlitTr`/`FlitTh`, `StatusChip` warning «Falta», `flitBtnPrimary`/`flitBtnSecondary(Sm)`, `flitInp`, `FlitModal`, `FlitEmpty`, tokens `--flit-*` (nunca HEX).
- **Estructura:** lista de clientes a la izquierda (300 px) → tarjeta: nombre, «Faltan 1 valor», «Historial del cliente» (secundario); tabla de trámite digital; rótulo «LOGÍSTICA»; dos paneles lado a lado; nota de pie.
- **Datos ficticios:** Entrega a cliente `$38.000`, «Desde 2 oct 2026 · Ana P.»; Entrega a FLIT «Sin configurar» + chip «Falta»; trámite digital inventado. Sin PII real.
- **Estados navegables:** cargando (esqueleto); error («No se pudieron cargar los valores de Transportes Andina S.A.S.» + Reintentar); vacío (ambos «Sin configurar», «Faltan 2 valores»); lleno; más edición en sitio (`$ 12000`, «Guardar» primaria), modal «Cobrar cero por Entrega a FLIT» y toast cerrable «Entrega a FLIT de Transportes Andina S.A.S.: Sin configurar → $12.000. Rige desde ahora.».
- **Móvil:** selector de cliente en vez de lista; paneles apilados; botones envueltos.
- **No mostrar:** vigencias anteriores, ids, valor anterior fuera del toast, columnas nuevas, animaciones o sombras extra.

Mockup: (pendiente; lo publica el hilo y exige «ok» humano antes de `frontend-agent`).

## Oficio (resumen)
Visita: ver/fijar el precio que falta · Primero: el faltante · Primaria: «Guardar» · Vacío/error con siguiente paso: sí · Sin efectos: sí · Móvil: dicho · Feedback: dicho · Notificación: toast vs aviso elegidos.

## Mockup aprobado (2026-10-27)

Mockup B2 aprobado por el humano: https://claude.ai/artifact/9V14mvzuEVyMsg3LA5AxDy (privado). Ajuste pedido en la aprobación: las acciones de «Entrega a cliente» (Cambiar/Fijar valor, Historial, Dejar de cobrar) existen **también** en «Entrega a FLIT». «Dejar de cobrar» va deshabilitado mientras no haya valor (aria-label «…disponible cuando haya un valor»). El chip «Gestiona FLITO» aparece una sola vez, junto al rótulo del grupo Logística.
