# UX slim — Logística operada por el proveedor: consola y Mi ruta (HU #14353)

Feature #14326 · PR 2 · ADR-0039 §6.2, §6.3, §6.5, §7.2, §14.
Maqueta: `docs/ux/mockups/logistica-proveedor-14353.png` (resumen de las capturas). **Aprobada por David el 2026-11-06.**

**Por qué slim:** no hay ruta ni `PageSlug` nuevos. Se extienden `FlitoLogistica` y `FlitoRuta`.

---

## Superficie tocada

| Archivo | Cambio |
|---|---|
| `pages/FlitoLogistica.tsx` | Pestañas y acciones por función y por enlace; estados de Trámites y Actas; búsqueda por `POST /buscar`; modal de despacho; 403/404 con copy propio |
| `components/flito/logistica/ViajesACliente.tsx`, `ModalEnviarACliente.tsx` | Variante sin precio |
| `components/flito/logistica/TabEntregas.tsx` | Vacío según permiso; el campo Placa no se deshabilita al cargar |
| `pages/FlitoRuta.tsx`, `components/flito/ruta/*` | Tarjeta de viaje a FLIT sin firma; copy; sin «dejar pendiente»; mensaje único de no encontrado |

Sin efectos, sin patrón nuevo. El móvil de Actas usa la tarjeta que ya existe en `TarjetaEntrega`.

---

## Qué se ve y qué se calla

**Coordinador.** Viene a ver qué tiene a cargo y a despachar. Ve primero la placa, el estado y la acción de la fila.
**Mensajero.** Viene a recoger y a entregar. Ve primero «Recoger licencias» y sus entregas.
**Operaciones.** Viene a lo de siempre, más la contingencia. Su pantalla no pierde nada.

### Pregunta 1 — Quitar sin dejar huecos

Las columnas de precio no son el problema: **ninguna tabla de la consola tiene precio**. Los precios solo están en Viajes. Lo que sí deja huecos son cuatro cosas, y cada una se resuelve así:

| Hueco posible | Decisión |
|---|---|
| Pestañas cerradas | **Se quitan de la barra**, no se deshabilitan ni se muestran vacías. El coordinador ve cuatro: Trámites, Viajes, Entregas, Actas. Con una sola pestaña visible, no se pinta la barra |
| Línea de precios en la tarjeta de Viajes | Desaparece la línea completa, con su «·». La tarjeta queda: compañía, LT, botón. El botón **ya no depende de que haya precio** (hoy `hayOrg && alguno` lo ocultaría siempre) |
| Modal de registrar viaje | Salen el total, «Este precio queda congelado…», «Ir a Tarifas» y «Este tramo no tiene costo». Entra una frase de conteo |
| Columna Acciones | **Se mantiene:** el proveedor siempre tiene «Ver» o «Detalle» |

### Delta de densidad: aliviada

- **Propietario sale de las listas del proveedor** (tabla de Trámites y tabla de licencias del acta). No decide nada en esa visita y es un tercero quien mira. Sigue en el Detalle del trámite. Ver decisión H2.
- La barra de la consola pierde hasta tres pestañas.
- El selector de empresa no se pinta si el usuario tiene una sola compañía.
- Operaciones: sin cambio de densidad.

---

## Flujo por rol

| Pantalla | Mensajero de proveedor | Coordinador de proveedor | Operaciones |
|---|---|---|---|
| **Menú** (AC1) | Mi ruta. Sin Logística en el proveedor: nada | Logística y Mi ruta. Sin Logística en el proveedor: nada | Sin cambio |
| **URL directa sin acceso** | `NoAccess` | `NoAccess` | Sin cambio |
| **Mi ruta · Recoger** | Escanear, ingresar a mano, firma. **No ve** «dejar pendiente» ni compañías ajenas | Igual, sobre lo de su proveedor | Igual que hoy; «dejar pendiente» solo con `logistica.documento.dejar_pendiente` |
| **Mi ruta · Entregas** | Las suyas. Viaje a cliente: Entregar y Devolver. **Viaje a FLIT: tarjeta sin firma** (H1) | Las de su proveedor | Igual que hoy, con «Firmar llegada» |
| **Consola · Trámites** | No entra | Placa, Empresa, Secretaría, N.º LT, Estado, Acciones. **No ve** Propietario en la lista | Igual, con Propietario |
| **Detalle del trámite** | No entra | Nombre del propietario. **No ve** su documento ni foto, ni viajes adicionales | Igual que hoy |
| **Consola · Viajes** | Ver H3 | Compañías con LT, sin ningún precio. Registrar viaje, Enviar a cliente | Igual que hoy, con precios |
| **Consola · Entregas** | No entra | Sus viajes; Anular con función | Igual que hoy |
| **Consola · Actas** | No entra | Las suyas desde la fecha de corte. Ver, Firmar y despachar, Devolver. **No ve** Firmar llegada | Todas, **también las anteriores al corte** |
| **Despachar** | No entra | **Solo sus mensajeros**, sin etiqueta | FLITO + proveedor dueño del acta, **con etiqueta** |
| **Nunca al proveedor** (AC4) | LT pendientes, candidatos, resolver trámite, reversa, cierre de lote, Viajes adicionales, Motivos de llegada (gestión), firma de llegada a FLIT, dejar pendiente | Igual | Los conserva según su función |

**El gate debe cambiar.** Hoy `esOperaciones = hasFuncion('logistica.lote.cerrar')` gobierna despachar, novedad y devolver. El proveedor no tiene esa función, así que el coordinador **no podría despachar** (AC3). Se reemplaza por:

| Acción | Función |
|---|---|
| Firmar y despachar | `logistica.actas.despachar` |
| Devolver | `logistica.actas.devolver` |
| Novedad | `logistica.documento.reportar_novedad` |
| Ver acta · Descargar PDF · Detalle del trámite | `logistica.actas.ver` · `logistica.actas.descargar` · `logistica.documento.ver` |

**Doble cerradura en AC4.** Las pestañas y acciones cerradas exigen la función **y** `tipoEnlace !== 'proveedor'`. Así no aparecen aunque un administrador asigne esa función a un rol de proveedor.

---

## Pregunta 2 — Actas anteriores a la fecha de corte

**Decisión: la pantalla no dice nada.** Sin aviso, sin fecha, sin filtro «anteriores», sin contador.

- El proveedor nunca tuvo esas actas a la vista, así que nada le «desaparece».
- Un aviso condicionado a que existan actas viejas sería un oráculo: revelaría que existen.
- Vacío, búsqueda sin resultado y lista corta usan el mismo copy con o sin actas anteriores.

**Lo único permitido es texto constante, igual para todos los proveedores.** Se propone una frase en la ficha de Ayuda (`flit-ayuda-flito`):

> Logística muestra la operación de su empresa desde que empezó a operar en FLITO. Si necesita algo anterior, escríbale a Operaciones de FLITO.

Ver decisión H4.

**Otros textos que no pueden filtrar datos:**

| Prohibido al proveedor | Por qué | Se usa |
|---|---|---|
| «Esta licencia es de otro proveedor», «no está a su cargo» | Confirma que existe | Mensaje único de AC6 |
| Nombre de otro proveedor, compañía ajena o `idFlit` en un error | Dato ajeno | Nada |
| «Esta acta es anterior a…» | Confirma que existe | Mismo 404 |
| Actor ajeno en la bitácora del acta | §7.2 | «—», igual que hoy cuando `actorNombre` es `null` |
| Conteo de candidatos fuera de alcance | §8.2 | Solo en `audit()` |

---

## Pregunta 3 — 404 ajeno e inexistente

Ambos se ven **idénticos** porque el cliente no distingue el caso: un solo helper traduce el estado HTTP, sin leer el cuerpo del error y sin usar `errorMessage(e)`.

| Situación | Patrón | Copy exacto (consola, usted) |
|---|---|---|
| Lectura 404 · trámite | Toast de error + recarga silenciosa de la lista | No encontramos este trámite. Revise la lista actualizada. |
| Lectura 404 · acta o PDF | Toast de error + recarga silenciosa | No encontramos esta acta. Revise la lista actualizada. |
| Lectura 403 (perdió la función) | Toast de error | No tiene permiso para ver este detalle. |
| Escritura 403 o 404 (mismo texto) | `role="alert"` dentro del modal; si no hay modal, toast. Recarga la lista | No se pudo hacer este cambio sobre este registro. Revise la lista actualizada. |
| Red o 5xx | Toast con Reintentar | No se pudo abrir el detalle. Inténtelo de nuevo. |

En Mi ruta (tú): entregar o devolver con 403 o 404 → «Este viaje ya no está en tu ruta. Revisa la lista actualizada.» y se recarga.

**Verificación:** los textos se comparan en un E2E con el mismo mock de 404 sobre dos filas. La diferencia de existencia solo puede salir del API, y eso ya lo cubre el test de `security-agent`.

---

## Pregunta 4 — Selector de mensajero

| | Proveedor | Operaciones |
|---|---|---|
| **Opciones** | Solo los suyos | FLITO + proveedor dueño de **esta** acta |
| **Etiqueta de pertenencia** | Ninguna | `<optgroup>` nativo: «Mensajeros de FLITO» y «Mensajeros de {proveedor}». Siempre, también con un solo grupo |
| **Vacío** | Su empresa aún no tiene mensajeros activos. Pídale a Operaciones de FLITO que cree el usuario. | No hay mensajeros disponibles para esta acta. Cree un usuario con rol Mensajero. |

- Se usa `<select>` con `<optgroup>`: es del navegador, se lee con lector de pantalla y funciona bien en móvil. No hace falta componente nuevo.
- Con vacío, el campo se reemplaza por el aviso y «Firmar y despachar» queda deshabilitado.
- El proveedor recibe «Pídale a Operaciones» porque, según ADR §6.2, él no gestiona sus usuarios.

---

## Wireframes — Consola

### Trámites · coordinador · escritorio

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Logística                                                                │
│ Trámites, licencias y actas de su operación: de la recogida en el        │
│ organismo a la entrega firmada.                                          │
└──────────────────────────────────────────────────────────────────────────┘
 Trámites (2)   Viajes (3)   Entregas   Actas (1)
 ─────────
┌──────────────────────────────────────────────────────────────────────────┐
│ Buscar                            Empresa                                │
│ [ Placa, VIN o trámite FLIT… ]    [ Todas las empresas      ▾ ]          │
│ (Pendiente)(Registrada)(En FLIT)(Despachada)(Entregada)(Con novedad)     │
├──────────────────────────────────────────────────────────────────────────┤
│ Placa        Empresa            Secretaría   N.º LT         Estado  Acc. │
│ ZZA101       Concesionario      Manizales    LT90000000101  Regis-  Deta-│
│ FLIT-DEMO-1  Demo Norte                                     trada   lle  │
│                                                                  Novedad │
│ ZZB202       Concesionario      Manizales    —              Pendi-  Deta-│
│ FLIT-DEMO-2  Demo Sur                                       ente    lle  │
└──────────────────────────────────────────────────────────────────────────┘
```
Operaciones ve lo mismo, con la columna **Propietario** y sus pestañas adicionales. La cabecera conserva su subtítulo actual.

### Trámites · 375 px

```
┌───────────────────────────────────┐
│ Logística                         │
│ Trámites, licencias y actas de su │
│ operación: de la recogida a la    │
│ entrega firmada.                  │
└───────────────────────────────────┘
 Trámites (2)  Viajes (3)
 Entregas      Actas (1)
┌───────────────────────────────────┐
│ Buscar                            │
│ [ Placa, VIN o trámite FLIT… ]    │
│ Empresa                           │
│ [ Todas las empresas          ▾ ] │
│ (Pendiente)(Registrada)(En FLIT)  │
│ (Despachada)(Entregada)(Novedad)  │
└───────────────────────────────────┘
┌───────────────────────────────────┐
│ ZZA101            [Registrada]    │
│ FLIT-DEMO-1 · LT90000000101       │
│ Concesionario Demo Norte          │
│ [ Detalle ]            Novedad    │
└───────────────────────────────────┘
```

### Viajes · proveedor · escritorio y 375 px

```
┌───────────────────────────────────┐
│ Concesionario Demo Norte · 3 LT   │   ← sin línea de precios
│ Clasificadas (2)                  │
│ ZZA101 · LT 90000000101           │
│ ZZB202 · LT 90000000202           │
│ En FLIT (1)                       │
│ ZZC303 · LT 90000000303 [En FLIT] │
│ [        Registrar viaje        ] │   ← primaria de la tarjeta
│ [        Enviar a cliente       ] │
└───────────────────────────────────┘
```
Escritorio: botones a la derecha en fila (`lg:flex-row-reverse`, como hoy).

### Modal Registrar viaje · proveedor

```
 Registrar viaje a Concesionario Demo Norte          [×]
 Destino del viaje   (Cliente)(FLIT)
 Se registrará un viaje a cliente con 2 LT.
 ZZA101 · LT 90000000101                 (Cliente)(FLIT)
 ZZB202 · LT 90000000202                 (Cliente)(FLIT)
                         [ Cancelar ] [ Confirmar viaje ]
```
- A FLIT: «Se registrará un viaje a FLIT con 2 LT.», más el motivo de llegada y la nota, como hoy.
- Repartido: «Se registrarán dos viajes: 1 LT a FLIT y 1 a cliente.»
- Operaciones sigue viendo sus precios sin cambios.

### Actas · coordinador · escritorio

```
 Actas
 Empresa                    Licencias  Mensajero      Estado       Acciones
 Concesionario Demo Norte       2      —              [Generada]   Ver · Firmar y despachar
 Concesionario Demo Sur         1      Mensajero Demo [Despachada] Ver · Devolver
 Concesionario Demo Sur         3      Andrés Demo    [Despachada] Ver · Devolver
   A FLIT. Operaciones de FLITO firma la llegada.
```
Operaciones: igual, con «Firmar llegada» y las actas anteriores al corte.

### Actas · 375 px

La tabla sería usable solo con scroll hasta la última columna. Por debajo de `lg` cada fila es una tarjeta (mismo marcado que `TarjetaEntrega`). Aplica también a Operaciones.

```
┌───────────────────────────────────┐
│ Concesionario Demo Norte          │
│ [Generada]  2 licencias           │
│ Sin mensajero                     │
│ [      Firmar y despachar       ] │   ← primaria de la tarjeta
│ [ Ver ]                           │
└───────────────────────────────────┘
┌───────────────────────────────────┐
│ Concesionario Demo Sur            │
│ [Despachada]  3 licencias · A FLIT│
│ Mensajero: Andrés Demo            │
│ Operaciones de FLITO firma la     │
│ llegada.                          │
│ [ Ver ]                  Devolver │
└───────────────────────────────────┘
```

### Modal Firmar y despachar

```
 PROVEEDOR                                 OPERACIONES
 Firmar entrega y despachar        [×]     Firmar entrega y despachar        [×]
 Mensajero                                 Mensajero
 [ Elija…                         ▾ ]      [ Elija…                         ▾ ]
    Mensajero Demo                           ┄ Mensajeros de FLITO ┄
    Andrés Demo                                 Laura Demo
                                             ┄ Mensajeros de Proveedor Demo Uno ┄
 Nombre de quien entrega                        Mensajero Demo
 [ Opcional: por defecto, su usuario ]          Andrés Demo
                                           Nombre de quien entrega
 Firma de quien entrega                    [ Opcional: por defecto, su usuario ]
 ┌─────────────────────────────────┐
 │                                 │       Firma de quien entrega
 └─────────────────────────────────┘       ┌─────────────────────────────────┐
              [Cancelar] [Firmar y         │                                 │
                          despachar]       └─────────────────────────────────┘
                                                [Cancelar] [Firmar y despachar]

 375 px: FlitModal a todo el ancho; botones apilados, primaria arriba.

 PROVEEDOR SIN MENSAJEROS
 Firmar entrega y despachar        [×]
 Su empresa aún no tiene mensajeros activos.
 Pídale a Operaciones de FLITO que cree el usuario.
                [Cancelar] [Firmar y despachar: deshabilitado]
```
El rótulo pierde «(Operaciones)» para todos: ahora despachan los dos.

---

## Wireframes — Mi ruta (375 px)

En escritorio es **la misma columna** centrada (`max-w-md`): no hay variante propia.

### Lleno · mensajero de proveedor

```
┌───────────────────────────────────┐
│ Mi ruta             Mis recogidas›│
│ Escanea las LT en el organismo y  │
│ entrégalas firmadas.              │
│                                   │
│ RECOGER LICENCIAS                 │
│ [ ▣ Escanear LT                 ] │
│ [ ✎ Ingresar a mano             ] │
│ Aún no has escaneado licencias.   │
│ Pulsa Escanear LT y apunta al     │
│ código de barras del reverso.     │
│                                   │
│ ENTREGAS (2)                      │
│ ┌───────────────────────────────┐ │
│ │ Concesionario Demo Norte      │ │
│ │ Calle Demo 1 # 2-3            │ │
│ │ ZZA101, ZZB202                │ │
│ │ [ Entregar     ] Devolver el  │ │
│ │                  viaje        │ │
│ └───────────────────────────────┘ │
│ ┌───────────────────────────────┐ │
│ │ Concesionario Demo Sur [A FLIT]│ │  ← H1: sin primaria
│ │ ZZC303                        │ │
│ │ Lleva estas LT a FLIT. Allí   │ │
│ │ firman la llegada.            │ │
│ │              Devolver el viaje│ │
│ └───────────────────────────────┘ │
└───────────────────────────────────┘
```

Operaciones: igual que hoy, «Firmar llegada» como primaria de la tarjeta a FLIT.

### Licencia fuera de alcance (AC6)

```
┌───────────────────────────────────┐
│ ZZD404          [Sin trámite] [×] │
│ N.º de LT  LT90000000404          │
│ No se encontró un trámite para    │
│ esta licencia                     │
│ Revisa los datos o quita esta LT. │
│ Ver datos ⌄                       │
└───────────────────────────────────┘
```
- El mensaje sale de `MENSAJE_LT_NO_ENCONTRADA`, sin variantes. La segunda línea es fija y da el siguiente paso.
- «Ver datos» solo muestra lo que trae el código que el mensajero tiene en la mano.
- En Ingresar a mano: mismo mensaje + «Revisa la placa e inténtalo de nuevo.»; reemplaza «Esta placa no coincide con ningún trámite.»

### Hoja «Elige el trámite» · sin `dejar_pendiente`

```
│ ▔▔▔                               │
│ ZZA101 tiene varios trámites      │
│ ¿A cuál corresponde esta LT?      │
│ Si no sabes cuál es, quita esta   │
│ LT y consúltalo antes de seguir.  │
│ ┌───────────────────────────────┐ │
│ │ FLIT-DEMO-1 · Concesionario   │ │
│ │ Demo Norte · Org. 17001       │ │
│ └───────────────────────────────┘ │
│ ┌───────────────────────────────┐ │
│ │ FLIT-DEMO-2 · Concesionario   │ │
│ │ Demo Norte · Org. 17001       │ │
│ └───────────────────────────────┘ │
│       Cancelar (quitar esta LT)   │
```
Sin el botón «No sé cuál: dejar pendiente» y sin la frase sobre Operaciones. Solo aparecen trámites propios.

---

## Estados (4) + copy exacto

Consola: **usted**. Se pasan a usted los textos tocados que hoy tutean (Actas, modal de despacho). Mi ruta: **tú**, como está.

### Consola

| Vista | Cargando | Error + reintento | Vacío | Lleno |
|---|---|---|---|---|
| **Trámites** (hoy sin cargando y con error crudo) | Esqueleto de 3 filas, `aria-label="Cargando trámites…"`. Al filtrar: filas visibles con `aria-busy`, sin esqueleto, sin perder el foco | No se pudieron cargar los trámites. Inténtelo de nuevo. **[Reintentar]** | **Sin filtros, proveedor:** No hay trámites aprobados asignados a su proveedor en esta vista. Los trámites en estado «Aprobado» aparecen aquí a la espera de su licencia de tránsito. (helper actual) · **Con filtros, todos:** Ningún trámite coincide con estos filtros. Pruebe otra placa o VIN, o quite un filtro. **[Limpiar filtros]** | Wireframe |
| **Viajes** | Sin cambio | Sin cambio | Sin cambio | Sin precios. Subtítulo proveedor: Elija el destino de cada compañía y registre el viaje. |
| **Entregas** | Sin cambio | Sin cambio | **Con `traslado.registrar`:** copy actual · **Sin ella:** Aún no hay viajes registrados. Cuando los registren, aparecen aquí. | Sin cambio |
| **Actas** (hoy el error se ve como vacío) | Esqueleto de 3 filas, `aria-label="Cargando actas…"` | No se pudieron cargar las actas. Inténtelo de nuevo. **[Reintentar]** | **Proveedor:** Aún no hay actas. Cuando haya un viaje registrado o una recogida confirmada, su acta aparece aquí. · **Operaciones:** Aún no hay actas. Vaya a «Viajes» y registre el viaje de una compañía con LT clasificadas. | Wireframe |
| **Modal despacho** | Select deshabilitado: Cargando mensajeros… | No se pudieron cargar los mensajeros. **[Reintentar]** (`role="alert"`) | Ver Pregunta 4 | Wireframe |
| **Refresco fallido con datos a la vista** | — | Aviso existente: No se pudo actualizar. **[Reintentar]**. Lo visible no se borra | — | — |

**Sección perdida (403 con la página abierta):** se conserva el aviso actual, «Ya no tiene acceso a esta sección. Vuelva a iniciar sesión si cree que es un error.» Sin pestañas: `NoAccess`.

**Viaje que no se puede registrar (proveedor, sin tarifa):** sin la palabra «precio» y sin enlace a Tarifas. El botón queda fuera y la tarjeta dice:
> Este viaje aún no se puede registrar. Avísele a Operaciones de FLITO para que complete la configuración de la compañía.

**Mensajero que dejó de ser asignable al enviar:** dentro del modal, `role="alert"`: Este mensajero ya no está disponible. Elija otro. Se recarga la lista.

### Mi ruta

| Vista | Cargando | Error + reintento | Vacío | Lleno |
|---|---|---|---|---|
| **Entregas** | Sin cambio | No se pudieron cargar tus entregas. **[Reintentar]** | No tienes viajes despachados para entregar. Cuando te despachen un viaje, aparece aquí. | Wireframe |
| **Entregas · 403** | — | Tu usuario ya no tiene acceso a las entregas. Pide a Operaciones de FLITO que lo revise. (sin reintento; hoy dice «No tienes entregas asignadas», que es falso) | — | — |
| **Recoger** | Chip «Validando…» | Sin cambio | Sin cambio | Tarjetas |
| **Mis recogidas** | Sin cambio | Sin cambio | Sin cambio | Sin cambio |

**«Operaciones» → «Operaciones de FLITO»** en los textos de Mi ruta que puede leer un proveedor (`mensajeEscanear`, `mensajeConfirmar`, novedad, «Guardamos tus LT…», `MisRecogidas`). Es el mismo texto para todos: no hay rama, y para un tercero «Operaciones» sería ambiguo.

---

## Responsive (<`lg`)

| Superficie | Comportamiento |
|---|---|
| Barra de pestañas | Envuelve (`flex-wrap`, ya está) |
| Filtros | Campos a todo el ancho, uno por línea; las píldoras envuelven |
| **Trámites y Actas** | Tarjetas apiladas; desde `lg`, `FlitTable` |
| Entregas | `FlitTable` con scroll del kit: es consulta y solo tiene una acción ocasional |
| Modales | `FlitModal` a todo el ancho; botones apilados, primaria arriba; altura mínima 44 px |
| Mi ruta (375 px) | Columna única sin scroll horizontal. Botones ≥ 44 px; la barra de acción de firma y entrega es `sticky` (ya está) |
| Tarjeta a FLIT | «Devolver el viaje» alineado a la derecha, ≥ 44 px |
| `Firmar y despachar` en tarjeta | A todo el ancho |

---

## Feedback y notificaciones

**Controles.** Los botones de texto de las filas (`Detalle`, `Novedad`, `Ver`, `Firmar y despachar`, `Devolver`) hoy no tienen hover ni foco. Al tocarlos llevan `flit-focus`, `rounded-lg`, `transition-colors` y `hover:bg-[var(--flit-bg-hover)]`, con `aria-label` que incluye la placa o la compañía.

**A11y.**
- Buscar y Empresa pasan a `FlitField` con `<label>`: hoy solo tienen placeholder.
- `<optgroup>` lleva `label`.
- Colores por token con par oscuro; `--flit-danger-ink` para errores.
- `rgba` sueltos de las píldoras de firma no se tocan en esta HU.

| Acción | Patrón | Copy |
|---|---|---|
| Despachar OK | Toast ~4 s, cerrable | Viaje despachado a {nombre}. (actual) |
| Registrar viaje OK | Toast | Actuales, sin monto |
| Enviar a cliente OK | Toast | Viaje a cliente de {compañía} registrado ({n} LT). Despáchelo desde Actas. (actual) |
| Entregar / devolver OK | Toast | Actuales |
| Error de detalle o PDF | Toast de error ≥ 6 s | Ver Pregunta 3. PDF: No se pudo descargar el PDF. Inténtelo de nuevo. |
| Error dentro de modal | `role="alert"` en el modal, sin toast | Ver Estados |
| Licencia no encontrada | Texto en la tarjeta, sin toast | AC6 |
| Lista desactualizada, sin conexión | Aviso en página | Actuales |

Nunca `errorMessage(e)` en esta consola. Los `setError` actuales de detalle, acta, PDF y acciones se reemplazan.

---

## AC5 — Búsqueda

- La pestaña Trámites deja de usar `GET /flito/logistica?buscar=…` y llama a `POST /flito/logistica/buscar`, para **proveedor y Operaciones**.
- Se envían en el cuerpo **todos** los filtros (`buscar`, `estados`, `empresas`, paginación). Así el NIT tampoco queda en la query, sin esperar a ADR-0036.
- El estado vive en `useState`. No se sincroniza con el router: la URL sigue siendo `/flito/logistica`.
- Debounce de 400 ms, como en Entregas.

---

## Requerimientos de datos (para `backend-agent`, que trabaja en paralelo)

| # | Qué necesita la UI | Por qué | Si no llega |
|---|---|---|---|
| **R1** | Mensajeros **por acta**: `GET /actas/:id/mensajeros` → `{ id, nombre, grupo: 'flito'\|'proveedor', proveedorNombre? }`. `grupo` y `proveedorNombre` solo para Operaciones | `/facetas` es global y hoy devuelve `[]` a todo enlace. No puede responder «los del proveedor dueño **de esta acta**» (AC3). Tampoco sirve a quien tiene `actas.despachar` sin `consola.filtrar` | Alternativa: `/facetas` con `proveedorId` en cada mensajero y `proveedorLogisticaId` en `ActaFila`, filtrando en el cliente |
| **R2** | Por compañía, al proveedor: `destinos: { cliente: boolean; flit: boolean }`, sin ningún precio | Sin cifras, la web no distingue «oculto» de «sin tarifa» | Se muestra siempre el botón y el 409 `PRECIO_TRASLADO_NO_CONFIGURADO` pinta el aviso genérico en el modal. Peor: el usuario lo descubre al confirmar |
| **R3** | `POST /buscar` `.strict()` con los filtros del cuerpo y la misma forma que `GET /` | AC5 | Bloquea AC5 |
| **R4** | `GET /mi-ruta` incluye los viajes a FLIT al mensajero de proveedor | Tarjeta de H1 | Depende de H1 |
| **R5** | `TramiteFila.actaId` en `null` al proveedor si el acta es anterior al corte | No revelar que existe | Nota para `security-agent` |

No se necesitan otros endpoints.

---

## Permiso / slug

Sin slugs nuevos: `flito_logistica` y `flito_logistica_ruta`. Menú desde `allowedPages`, que el API ya filtra por servicio (ADR §6.1). Funciones: las de la tabla de gate y las de ADR §12.

---

## Oficio

| Pregunta | Respuesta |
|---|---|
| ¿Qué vino a hacer? | Coordinador: ver lo suyo y despachar. Mensajero: recoger y entregar |
| ¿Qué se ve primero, qué se calla? | Placa, estado y acción. Propietario va al detalle. Precio y datos ajenos no existen para el proveedor |
| ¿Única primaria? | Consola y Mi ruta no tienen primaria de página. Por tarjeta: «Registrar viaje», «Firmar y despachar» o «Entregar». En modal: su confirmación. La tarjeta a FLIT no tiene |
| ¿Vacío y error con siguiente paso? | Sí, en las tablas de Estados |
| ¿Efectos o patrón nuevo? | No. `<optgroup>` es nativo; las tarjetas móviles ya existen |
| ¿Móvil? | Sección Responsive |
| ¿Feedback? | Se añade a los botones de fila que hoy no lo tienen |
| ¿Notificación? | Tabla de notificaciones |

---

## Componentes reutilizados

`PageHeaderCard` · `FlitCard` · `FlitTable`, `FlitTh`, `FlitTr` · `FlitEmpty` · `FlitField` · `flitInp` · `flitBtnPrimary`, `flitBtnSecondary` · `FlitPillGroup`, `FlitPillButton` · `FlitModal` · `StatusChip` · `toastOk`, `toastError` · `NoAccess` · `FirmaCanvas` · `vacioConEnlace` · tarjeta `article` de `TarjetaEntrega` · `TarjetaLtRecogida`, `HojaElegirTramite`, `PanelRecogida`, `PasoEntrega`.

**Nuevos:** ninguno en el kit. Un helper de mensajes HTTP por recurso en `lib/`.

---

## Notas para QA (≤10)

1. Proveedor sin Logística: ni Logística ni Mi ruta en el menú; por URL, `NoAccess`.
2. Rol de proveedor con `lote.cerrar`, `resolver_tramite` o `firmar_flit` asignadas a mano: ninguna acción cerrada aparece.
3. Coordinador: **cero** «$», «precio», «tarifa» o «costo» en consola, modales y toasts; ningún documento de propietario. Revisar también la respuesta de red.
4. Mock de 404 sobre dos filas: mismo toast, carácter por carácter.
5. Los cuatro casos de R18 en escaneo: mismo mensaje, sin compañía. Sin «No la recoge FLITO».
6. Búsqueda de placa y VIN en proveedor y Operaciones: ni la URL de la página ni la de red llevan placa, VIN o NIT.
7. Despacho: el proveedor ve solo los suyos, sin etiqueta. Operaciones ve dos grupos y **no** los de otro proveedor. Sin mensajeros: aviso y botón deshabilitado.
8. Operaciones con los permisos actuales sigue despachando, devolviendo y reportando novedad tras cambiar el gate `esOperaciones`.
9. Actas: un 500 ya no se ve como «Aún no hay actas»; aparece Reintentar. Operaciones ve actas anteriores al corte; el proveedor no, y su vacío es el mismo con o sin ellas.
10. Cambios en la cola offline rechazados con 403 o 404: revisar que no salga el error crudo. Mi ruta a 375 px sin scroll horizontal; claro y oscuro.

---

## Decisiones y descartes

| Descartado | Por qué |
|---|---|
| Aviso «solo ve actas desde {fecha}» en pantalla | No aporta al trabajo de la visita y abre la puerta a preguntar por lo anterior. Queda como frase constante en Ayuda (H4) |
| Pestañas cerradas visibles y deshabilitadas | Parecen rotas y enseñan funciones ajenas |
| Chip o columna «Proveedor» en la consola del proveedor | Dato sin decisión asociada. Operaciones tampoco lo pide en esta HU |
| Componente nuevo de selector con chips de pertenencia | `<optgroup>` lo resuelve |
| Pantalla propia para el proveedor | Duplicaría la consola. La frontera y las funciones ya la recortan |
| Firma de quien llega a FLIT en móvil del proveedor | AC4 y N4 |
| Scroll horizontal para despachar en móvil | Se usaba `FlitTable` tal cual, pero la acción quedaba fuera de pantalla |

**Decisiones del agente, no del humano:** usted en toda la consola tocada; «Operaciones de FLITO» en Mi ruta; tarjetas en móvil también para Operaciones.

**Decidido por David (2026-11-06):**

| | Decisión |
|---|---|
| H1 | Viaje a FLIT en Mi ruta: tarjeta sin firma |
| H2 | Propietario solo en el Detalle: fuera de las listas, de «Ver datos» y de la respuesta de las listas |
| H3 | El mensajero ve Viajes si tiene el permiso; no hay regla por rol y no exige `consola.filtrar` |
| H4 | Frase fija en la ficha de Ayuda, sin fecha (valor por defecto, aprobado con la maqueta) |
| H5 | PDF del acta: sujeto a lo que decida `security-agent` (valor por defecto, aprobado con la maqueta) |
| D7 | `POST /actas/:id/despachar` rechaza con 403 al usuario con enlace `compania` |
| Motivos | Operaciones ve el motivo específico del escaneo; el proveedor, el mensaje único |

---

## Brief de mockup

**Archivo:** `docs/ux/mockups/logistica-proveedor-14353.html`, autocontenido, con clases y tokens del kit, sin red. Capturas a 1366×768 y 375×812; **lleno en claro y oscuro**, el resto en claro.

**Datos ficticios:** placas `ZZA101`, `ZZB202`, `ZZC303`, `ZZD404`. LT `LT90000000101`, etc. Trámites `FLIT-DEMO-1`, `FLIT-DEMO-2`. Compañías `Concesionario Demo Norte`, `Concesionario Demo Sur`. Personas `Mensajero Demo`, `Andrés Demo`, `Laura Demo`. Proveedor `Proveedor Demo Uno`. Dirección `Calle Demo 1 # 2-3`.

| # | Vista | Estados | Anchos |
|---|---|---|---|
| 1 | Consola proveedor · Trámites | Lleno, cargando, error, vacío sin filtros, vacío con filtros | 1366, 375 |
| 2 | Consola proveedor · Viajes + modal Registrar | Lleno, sin tarifa | 1366, 375 |
| 3 | Consola proveedor · Actas | Lleno, cargando, error, vacío | 1366, 375 (tarjetas) |
| 4 | Modal despacho · proveedor | Lleno, cargando, error, sin mensajeros | 1366, 375 |
| 5 | Modal despacho · Operaciones | Lleno con dos grupos | 1366, 375 |
| 6 | Operaciones · Actas y Trámites | Lleno, con Propietario, precios y Firmar llegada | 1366 |
| 7 | Mi ruta · mensajero de proveedor | Lleno (cliente + tarjeta a FLIT), cargando, error, 403, vacío | 375, 1366 |
| 8 | Mi ruta · fuera de alcance y hoja de trámites | Tarjeta AC6, ingreso manual AC6, hoja sin «dejar pendiente» | 375 |
| 9 | Toast de 404 | Trámite y acta | 1366, 375 |

**No mostrar al proveedor:** precios, cifras, «Tarifas», «Pídale a Finanzas», documento de propietario, Propietario en listas, LT pendientes, Viajes adicionales, Motivos de llegada, Firmar llegada, dejar pendiente, nombres de otro proveedor, fecha de corte.

Para el «ok» de David, poner lado a lado los modales 4 y 5, y dejar a la vista la tarjeta a FLIT de la vista 7 (decisión H1).
