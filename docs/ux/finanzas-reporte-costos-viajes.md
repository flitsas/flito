# UX slim — Reporte de costos: columna «Viajes» y panel de solo lectura por viaje (HU #12628 · Feature #12618 · Épica #12244)

> Modo **slim**: extiende `/finanzas/reporte-costos` (`TablaReporteCostos.tsx`, `FinanzasReporteCostos.tsx`). Calco de **solo lectura** del panel de servicios adicionales (`finanzas-reporte-costos-servicios-adicionales.md` §6, `PanelServiciosAdicionales.tsx`). Tono de la pantalla: **tutea** (se calca). Vocabulario de la consola logística (`flito-logistica-viajes.md`): «Viaje N», «Tarifa vigente», «Precio manual», «incluye el viaje 1».
> **Regla dura:** el Excel (32 cabeceras literales) y la vista compacta (9 columnas) **no cambian**. La celda «Viajes» es una **columna aparte** de «Logística»: el chip «documental» de la sesión de comprobantes vive **bajo el importe de Logística** (D-27) y no se pisa con esta celda; el botón «Viajes» va en **Acciones**, no en ninguna celda de valor.

## Superficie tocada
| | |
|---|---|
| Página / slug | `/finanzas/reporte-costos` · `finanzas_reporte_costos`, sin cambio. Sin función nueva: quien ve el reporte ve la columna, el botón y el panel (`admin`, `financiera`, `auditor`) |
| Grupo **Valores**, solo ampliada | Una columna más, **«Viajes»**, inmediatamente **después de «Logística»**, sin `compacta`, **sin pie de totales** (ampliada pasa de 29 a 30). Consolidado: sin cambio |
| Celda **Acciones** (ambos modos) | Un botón secundario más, **«Viajes»** / **«Viajes · n»**, en **todas** las filas, tras «Servicios» (o tras «Soporte» si no se pinta «Servicios») |
| Panel nuevo | `PanelViajesLogistica` sobre `FlitModal lateral` (la variante ya existe): **cero acciones, cero inputs** |

## Delta de claridad (qué se ve / qué se calla)
**A qué se entra (sin cambio):** a cerrar el mes y decidir Liquidar / Facturar. Lo nuevo de esta visita es **una pregunta de consulta**: «¿por qué Logística vale eso? ¿cuántos viajes hubo?». La respuesta corta (**n**) va en la fila ampliada, al lado del importe que explica; la larga (quién, cuándo, a qué precio, por qué) va **a un clic**, en el panel.

| Siempre visible (esta visita) | Se calla, y dónde vive |
|---|---|
| Ampliada: el **conteo** de viajes junto a Logística (`n`, `—`, `Sin dato`) | El desglose por viaje, el precio de cada uno, la tarifa del momento, el motivo y el autor: **en el panel** |
| Ambos modos: que hay viajes de más → el rótulo **«Viajes · n»** solo con n ≥ 2 | El importe de los adicionales en la celda: **no** (Logística ya los suma; dos cifras = dos verdades) |
| En el panel: **Viaje 1 incluido** arriba, los adicionales debajo, **Total logística** al pie (del servidor) | Los `id` uuid: `data-id`, nunca en pantalla ni en la URL. El panel no abre por query param |

**Primaria:** **Liquidar / Facturar** de la fila, sin cambio. «Viajes» es `flitBtnSecondary`, gemelo exacto de «Soporte» y «Servicios». Dentro del panel **no hay primaria** (solo ✕ del kit): es lectura.
**Qué NO se añade:** pie de totales bajo «Viajes» (un conteo de viajes sumado por página no es un dato de cierre; el dinero ya está en el pie de Logística); columna en compacta; columna en el Excel; contador «· 1» ni «· 0» en el botón; «Registrar» o «Quitar» en el panel; chip en la celda de Logística (reservada al documental); KPI de viajes en la cabecera.
**Densidad:** Acciones **empeora un punto** en todas las filas (cuarto botón consultivo en filas con Servicios; envuelve con `flex-wrap`, como ya pasa). Es el precio del AC y se contiene con el mismo peso visual y rótulo de una palabra. Compacta **no gana ancho** de columnas (QA 1 lo mide). Ampliada gana una columna estrecha (3 caracteres): desborda por decisión (D-11).

## Wireframes
### Cabecera ampliada alrededor de Logística / Viajes y la celda en sus tres lecturas
```
│                     Valores                                                              │
│ … GMF     │ Logística   │ Viajes   │ Total reintegro │ Trámite digital │ Serv. adic. │ … │
│ … $ 4.000 │  $ 90.000   │    3     │      $ 610.000  │       $ 80.000  │  $ 125.000  │   │  ← n ≥ 1: «3», tabular-nums, derecha
│ … $ 4.000 │  $ 30.000   │    1     │      $ 550.000  │       $ 80.000  │      —      │   │  ← solo el incluido: «1» (es un dato)
│ … $ 4.000 │ Autogestiona│    —     │      $ 520.000  │       $ 80.000  │      —      │   │  ← 0: guion, title «Autogestiona»
│ … $ 4.000 │  $ 30.000   │ Sin dato │      $ 550.000  │       $ 75.000  │  Sin dato   │   │  ← null: sellada antes de la HU
│ … $ 30.000│  $ 25.000   │    2     │ …                                                    │
│           │ [Difiere de │          │                                                      │  ← el chip documental vive BAJO Logística,
│           │ tarifa −$5.000]│       │                                                      │     nunca en la celda «Viajes»
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ … $ 48 K  │   $ 1,2 M   │          │        $ 24,6 M │         $ 3,1 M │    $ 890 K  │   │  ← pie: «Viajes» queda vacío
```
| Caso | `logisticaViajesCantidad` | Qué se pinta | `aria-label` de la celda / `title` |
|---|---|---|---|
| Con viajes | `n ≥ 1` | **`n`** (`tabular-nums`, derecha, tinta primaria) | `aria-label="n viajes de logística"` («1 viaje de logística» en singular) |
| Autogestiona | `0` | **«—»** (`<Monto v={null} />`, mismo guion del reporte) | `title="Autogestiona"` |
| No se sabe | `null` | **«Sin dato»** (`text-xs`, itálica, `TENUE`, calco de «Serv. adic.») | `title="Se liquidó antes de que FLITO cobrara viajes adicionales."` |

**Nunca «0» para `null`** y nunca «0 viajes»: `0` es «esta compañía autogestiona» y `null` es «la liquidación es anterior al concepto». Son afirmaciones distintas (mismo criterio que §5.3 de servicios adicionales).

### Celda Acciones
```
│ [Soporte] [Servicios · 2] [Viajes · 3] [Liquidar]            │   ← n ≥ 2: contador
│ [Soporte] [Servicios] [Viajes] [Facturar] [Reversar]         │   ← n = 1, 0 o null: solo «Viajes»; sellada incluida
│ [Soporte] [Viajes]  Falta: Logística                         │   ← sin función de servicios: tras «Soporte»
```
Orden de foco: `Soporte → Servicios → Viajes → Aceptar diferencia → Liquidar/Facturar → Reversar → Enviar`. Consultar antes que operar. `aria-label` empieza por el texto visible: **«Viajes de logística de FLIT-10234: 3 viajes»** / **«…: 1 viaje»** / **«…: autogestiona»** / **«…: sin dato»**. El contador **no cuesta petición**: sale de la fila.

### Panel `PanelViajesLogistica` (lleno, origen vigente)
```
┌─ Viajes de logística · FLIT-10234 · ABC123 ─────────── ✕ ─┐
│  Estimado con los viajes registrados                    │   ← línea de origen, text-sm SECUNDARIO (o «Sellado el 12 sep 2026, 9:14 a. m.»)
│                                                         │
│  Viaje 1 · incluido en la tarifa            $ 35.000    │   ← cabecera fija; «Sin tarifa configurada» si tarifa null
│ ─────────────────────────────────────────────────────── │
│  Viaje 2                                    $ 35.000    │   ← valor a la derecha, tabular-nums
│  Tarifa · Tarifa del momento $ 35.000                   │   ← text-xs SECUNDARIO
│  Devolución · Ana Ríos · 15 sep 2026, 10:12 a. m.       │
│ ─────────────────────────────────────────────────────── │
│  Viaje 3                                    $ 62.000    │
│  Precio manual · Tarifa del momento $ 45.000            │   ← o «Precio manual · Sin tarifa»
│  Otro: cliente pidió entrega en sede norte · L. Mora ·… │   ← motivo (label) + «: detalle» solo si hay
├─────────────────────────────────────────────────────────┤
│  3 viajes                    Total logística  $ 132.000 │   ← `totalLogistica` del servidor; sin botón
└─────────────────────────────────────────────────────────┘
```
Sin «Registrar viaje», sin «Quitar», sin aviso «Reversa la liquidación…»: el registro vive en la consola logística de Operaciones y no es trabajo de Finanzas; un panel que solo lee no necesita explicar por qué no escribe.

## Estados (4) + copy exacto (de lo tocado)
| Estado | Panel | Tabla |
|---|---|---|
| Cargando | Esqueleto con la forma (cabecera + 2 filas de 2 renglones + pie sin cifras), `role="status" aria-busy="true" aria-label="Consultando los viajes…"`. Sin spinner | Sin cambio |
| Error red / 5xx | `role="alert"`: **«No se pudieron cargar los viajes de este trámite.»** + mensaje del servidor + **Reintentar** (`flitBtnSecondary`) | Sin cambio |
| 403 | **«Tu usuario ya no puede ver los viajes de este trámite. Vuelve a entrar para actualizar tus permisos.»** Sin Reintentar | — |
| 404 | **«El trámite ya no existe.»** + **Actualizar el reporte** (cierra y `refrescar()`; calco del panel de servicios) | — |
| Vacío · `origen: 'sin_desglose'` | Línea de origen «Sellado el <fecha>»; `FlitEmpty`: **«Sin dato: se liquidó antes de que FLITO cobrara viajes adicionales.»**; pie **Total logística $ X** (el sellado). Sin cabecera de Viaje 1 (no se sabe) | Celda «Sin dato» |
| Vacío · `gestionaLogistica: false` | `FlitEmpty`: **«La logística de esta compañía la gestiona el cliente: no hay viajes que cobrar.»** Sin cabecera, sin pie con cifra (nunca «$ 0» de relleno) | Celda «—» |
| Vacío · `items: []` vigente/sellado | Cabecera **Viaje 1 · incluido en la tarifa · $ 35.000** arriba; `FlitEmpty`: **«Sin viajes adicionales.»**; pie **1 viaje · Total logística $ 35.000** | Celda «1» |
| Lleno | Wireframe. Modo: **«Tarifa»** \| **«Precio manual»**; **«Tarifa del momento $ X»** \| **«Sin tarifa»**; motivo con `MOTIVO_VIAJE_LOGISTICA_LABEL`, «Otro: <detalle>»; autor `registradoPorNombre` (o «Sin autor» si null); `fechaHoraCorta(registradoEn)` | Celda «n», botón «Viajes · n» si n ≥ 2 |

Origen: `vigente` → **«Estimado con los viajes registrados»**; `sellado` → **«Sellado el {fechaHoraCorta(liquidadoEn)}»**; `sin_desglose` → la misma línea «Sellado el …» y el vacío de arriba. Sin `StatusChip`: es una línea de texto, como «Liquidado: estos servicios quedaron sellados.».

## Spec breve
**`PanelViajesLogistica`** (`apps/web/src/components/finanzas/PanelViajesLogistica.tsx`) — props `tramiteId: string`, `idFlit: string`, `placa: string | null`, `onClose(): void`, `restoreFocusRef?: RefObject<HTMLElement | null>`. `GET /api/finanzas/tramites/:id/viajes-logistica` al montar (no cachea entre aperturas); sin `recargaPagina`, sin `onCambio` (no escribe). Título con el mismo `join(' · ')` de `tituloPanel` (sin « · » colgando si no hay placa). **No suma nada**: pinta `totalLogistica` y `totalViajes`. Importa `pesos` de `tiposReporteCostos.ts` y `fechaHoraCorta` de `lib/tarifas.ts`; **no** duplica el `pesos` de la consola logística. Lista `<ul>`/`<li>` con `data-id`; `divide-y` con `--flit-border-soft`. Estilos: `SECUNDARIO`, `PELIGRO`, `TENUE` ya definidos en la carpeta.
**Helper de celda** (`lib/viajesLogisticaReporte.ts`, puro, probable sin DOM): `textoCeldaViajes(n: number | null): { clase: 'viajes' | 'vacio' | 'sin_dato'; texto: string; accesible?: string; title?: string }` y `rotuloBotonViajes(n)` → `'Viajes · n'` si n ≥ 2, `'Viajes'` en otro caso; `nombreAccesibleBotonViajes(idFlit, n)`. Y `lineaOrigen(datos)` para la pastilla. La entrada en `COLUMNAS`: `{ titulo: 'Viajes', grupo: 'valores', center: true, celda: celdaViajes }` **sin `compacta` y sin `total`**.
**Página:** estado `viajesDe: Fila | null` gemelo de `serviciosDe`; ref al botón de la fila para `restoreFocusRef`; `onViajes` en `TablaReporteCostos`/`Acciones`. Sin `hasFuncion` nuevo.
**A11y:** celda con `aria-label` (la cabecera es corta y la celda es un número suelto); botón con nombre que empieza por el texto visible (WCAG 2.5.3); el panel hereda `role="dialog"`, `aria-modal`, trampa de foco y Esc de `FlitModal`; foco inicial en el ✕ (no hay nada que operar); al cerrar, foco al botón «Viajes» de esa fila. **Una sola región viva**: el panel no anuncia nada (`aria-live` solo en el `anuncio` de la página; el esqueleto lleva `role="status"` como el de servicios). Contraste: tokens, sin color como único portador (el modo se dice con palabras).

## Datos
| Qué | Estado |
|---|---|
| `logisticaViajesCantidad: number \| null` en la fila de `GET /finanzas/reporte-costos` | **No existe en develop 9ddae71** → R0: la HU backend de la Feature #12618 debe entregarla antes; semántica `0` = autogestiona, `null` = sellada sin desglose |
| `GET /api/finanzas/tramites/:id/viajes-logistica` (contrato del prompt: `origen`, `tarifa`, `totalViajes`, `totalLogistica`, `items` \| null) | **No existe** → R0 (misma HU backend). Vallado de `finanzas/`: reutilizar `LECTURA`, sin `requireRole` nuevo |
PII: ninguna. `registradoPorNombre` es usuario interno (criterio de «Añadió Ana Pérez»). `motivoDetalle` puede traer texto libre del operador: se pinta tal cual, con `truncado`-no; recortar a una línea con `title` completo.

## Oficio
- **«Viajes» tras «Logística»** porque es la explicación de ese importe: se lee `Logística $ 90.000 · 3` como «tres viajes suman eso». Ponerla lejos (tras Serv. adic.) obligaría a saltar la vista. **No en compacta** (D-14: las nueve son las que deciden «liquido / no» y caben en 1366; el conteo no decide nada, el importe de Logística ya está en Total reintegro). El botón «Viajes» sí está en compacta: ahí vive la puerta al detalle.
- **Panel de solo lectura** porque Finanzas no registra viajes: el alta y la baja son de la consola logística (`logistica.viajes.*`, Operaciones), y un panel con dos dueños es dos verdades. Por eso tampoco lleva aviso de «reversa para cambiar»: no hay nada que cambiar aquí.
- **COP con `pesos` del reporte** («$ 35.000»), para que celda de Logística, panel y pie digan la misma cifra con la misma forma. **Fecha y hora Colombia** con `fechaHoraCorta`. Total **del servidor**, nunca sumado en cliente (calco de `PanelServiciosAdicionales`).
- Sin efectos ni patrón nuevo: `FlitModal lateral`, `FlitEmpty`, `Monto`, botones del kit, dos renglones por fila como en servicios.

## Notas para QA (≤10)
1. **Ancho (gate):** 1366×768, compacta, 10 filas con Soporte + Servicios · 2 + Viajes · 3 + Liquidar + «Falta: SOAT»: `FlitTable` sigue con `scrollWidth === clientWidth`. *Mutante:* `whitespace-nowrap` en Acciones.
2. Compacta: **no** hay `th` «Viajes»; sigue «9 de 30 columnas». Ampliada: `th` «Viajes» es el siguiente de «Logística» y el pie de esa columna está vacío. *Mutante:* `compacta: true` o `total` añadido.
3. Celda: `n=3` → «3» con `aria-label="3 viajes de logística"`; `n=1` → «1 viaje de logística»; `n=0` → «—» con `title="Autogestiona"`; `null` → «Sin dato» con el `title` de la HU y **ningún «0»**. *Mutante:* `?? 0`.
4. Botón: `n=3` → «Viajes · 3»; `n=1`, `0` y `null` → «Viajes»; presente en fila `sellada` y para `auditor`. *Mutante:* gating por `hasFuncion` de servicios.
5. Panel vigente con 2 adicionales: título «Viajes de logística · FLIT-… · ABC123»; línea «Estimado con los viajes registrados»; cabecera «Viaje 1 · incluido en la tarifa · $ 35.000»; fila manual dice «Precio manual · Tarifa del momento $ 45.000»; pie «Total logística» = `totalLogistica` del mock aunque no cuadre con la suma. *Mutante:* sumar en cliente.
6. `origen: 'sin_desglose'`: copy «Sin dato: se liquidó antes…», línea «Sellado el …», total sellado, **sin** cabecera Viaje 1. `gestionaLogistica: false`: copy «La logística de esta compañía la gestiona el cliente: no hay viajes que cobrar.» y **ningún** «$ 0». *Mutante:* pintar Viaje 1 en sin_desglose.
7. `items: []` vigente: Viaje 1 arriba + «Sin viajes adicionales.» + «1 viaje». `tarifa: null` → «Sin tarifa configurada» en la cabecera.
8. 403 sin Reintentar; 404 «El trámite ya no existe.» + «Actualizar el reporte»; red → Reintentar repite el GET. *Mutante:* Reintentar en 403.
9. Foco: Tab entra al ✕; Esc y ✕ devuelven el foco al botón «Viajes» de la misma fila; sin `aria-live` propio en el panel salvo el esqueleto. Ningún `button`/`input` dentro del cuerpo del panel (`toHaveCount(0)`).
10. Excel: cabeceras **sin cambio** (las 32 literales); fila de Logística con chip documental y celda «Viajes» son `td` distintos. *Mutante:* columna «Viajes» en el `.xlsx`.

```
HANDOFF
  Modo: slim
  Resultado: OK (R0: fila y endpoint de la HU backend de #12618 no están en develop 9ddae71; la forma no cambia)
  Entrega: /tmp/claude-1000/-home-david-flit-flito/50da9103-7c0a-4289-9d37-8139a903418e/scratchpad/ux-viajes-reporte-costos.md → docs/ux/finanzas-reporte-costos-viajes.md
  Oficio: primaria única (Liquidar/Facturar; panel sin primaria) | jerarquía dicha (n junto a Logística en ampliada; desglose a un clic) | vacíos con siguiente paso (sin_desglose, autogestiona, sin adicionales) y errores por código | sin efectos ni patrón nuevo
  Densidad: empeora un punto en Acciones (cuarto botón consultivo, envuelve); compacta sin columnas nuevas; QA 1 lo mide
  Pantallas: 1 vista tocada + 1 panel | Requerimientos nuevos de datos: 2 (R0: logisticaViajesCantidad en la fila; GET …/viajes-logistica) — ambos ya previstos en la Feature
  Siguiente: frontend-agent (tras la HU backend) → qa-agent con las 10 notas
```
