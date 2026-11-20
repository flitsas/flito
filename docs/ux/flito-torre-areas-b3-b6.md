# UX slim — Torre de Control: Productos, Logística, Financiera, Equipo y «Para hoy» (Épica #14590, B3–B6)

> Modo **slim**. Sigue el molde aprobado de `docs/ux/flito-torre-detalle-universal.md`: §4 KPI explicable, §5 Detalle, §6.1 estructura de subvistas y §7 «Para hoy». Si algo choca, manda ese documento. Aquí solo se dice **qué cifras, qué tabla y qué copy** lleva cada subvista nueva.
> Diseño técnico: `docs/diseno/epica-14590-torre-detalle-universal.md` §12 (B3–B6) y §13 (AC).
> Oficio: `docs/ux/_principios-flito.md`. Tratamiento: **usted**, como el resto de la Torre.
> Maquetas: **no hay maqueta nueva** (decisión del hilo, molde ya aprobado). Referencias visuales: `docs/ux/mockups/torre-kpi-explicable.html`, `torre-detalle.html`, `torre-operativa-inventario.html` y `torre-360-para-hoy.html`.

---

## 0. Reglas comunes (valen para todas las subvistas de este doc)

Se aplican sin repetirlas en cada sección:

- **Estructura (§6.1).** `PageHeaderCard` del área → `BarraFiltrosTorre` → `Pestanas` → contenido. La pestaña activa va en `?vista=`.
- **Contenido de una subvista.** Arriba una frase guía de una línea. Debajo, KPI explicables en rejilla (máx. 4). Después, **una** tabla principal con «Ver los N» por fila. Un bloque secundario solo donde se dice y se justifica.
- **KPI (§4.1).** Rótulo, cifra, frase de ≤ 2 líneas, chip «Foto de hoy» si no depende del periodo, «¿Cómo se calcula?» como disclosure en línea y «Ver los N». Con cifra 0 no hay «Ver». Sin `torre.detalle.ver` no hay enlace. Las definiciones viven en `CONJUNTOS_TORRE[c].definicion`, con los umbrales ya puestos; el texto de este doc es el que va al catálogo.
- **Filas de la tabla.** El enlace «Ver los N» va en la última columna y no sobre la fila entera. Una fila con 0 muestra «—» y no lleva enlace.
- **Primaria única.** Es la del encabezado del área, «Descargar Excel», y exporta la subvista activa. Si una subvista no tiene export, el botón no se pinta en ella. Las KPI y las filas no llevan peso de primaria.
- **Dinero.** Sin `torre.metricas.dinero`, las columnas de valor no se pintan y las frases cuentan registros en vez de pesos.
- **PII.** En ninguna lista aparecen: nombre ni cédula del titular, VIN completo, póliza completa (solo los 4 últimos), dirección del impuesto, dirección de entrega, receptor, contacto, coordenadas ni storage keys. En B5 solo aparece el nombre del funcionario, nunca su correo.
- **Feedback.** Es el de §9 del molde. Los enlaces se subrayan al pasar el puntero. Las cifras-botón llevan velo `--flit-bg-hover`. Todo control lleva `flit-focus`. Ningún control queda plano.
- **Notificaciones.** Son las de §9 del molde: toast cerrable al descargar el Excel (éxito ~4 s; error ≥ 6 s y sin el error crudo del API). No hay acciones nuevas que notificar.
- **Estados de error.** Si la subvista entera falla, se ve `InlineAlert` + «Reintentar» en el lugar del contenido, y la cabecera, los filtros y las pestañas siguen usables. El esqueleto de carga tiene **la misma estructura**: n tarjetas KPI y la tabla con sus columnas reales.
- **Móvil (< lg).** Las KPI caen a 1 columna (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`). La tabla principal usa el scroll del kit con la primera columna fija. Las `Pestanas` hacen scroll horizontal. La barra envuelve. Abajo, una línea por subvista con lo que cambia.

**Conjunto en la URL.** Solo `?c=` y `&s=` con valores opacos (estado, motivo, severidad, uuid de compañía, de bolsa o de funcionario). La placa nunca va en la URL.

---

## B3 — Área Productos (nueva) · PageSlug `torre_productos`

- **Público.** Coordinación operativa y gerencia, que siguen el ciclo de los productos que FLITO gestiona por trámite.
- **Permiso.** `torre.tablero_productos.ver`. **Propuesta UX:** el mismo reparto que tiene hoy `torre_operativa` en `REPARTO_TORRE`. Lo fija architecture, solo con roles de `USER_ROLES`.
- **Navegación.** Entrada nueva «Productos» en `navEntradas.ts`, después de Operativa.
- **Encabezado.** Título «Productos». Subtítulo: «En qué va cada SOAT, impuesto y derecho, y qué está detenido.» Primaria: «Descargar Excel».
- **Pestañas.** SOAT · Impuestos · Derechos. La pestaña por defecto es SOAT.

### B3.1 SOAT

**Para qué existe.** Para ver qué SOAT están detenidos o por vencer, y cuántos se pagaron en el periodo.

**Frase guía:** «[412] SOAT en gestión hoy; [9] llevan más de [48] horas sin soporte.»

| # | Rótulo | Base | Frase (lleno) | Frase en 0 | ¿Cómo se calcula? | Ver → conjunto |
|---|---|---|---|---|---|---|
| S1 | SOAT sin soporte fuera de ANS | Foto | «[9] gestiones de SOAT llevan más de [48] horas sin soporte; [3] pasan de [96].» | «Todos los SOAT pedidos tienen soporte dentro de [48] horas.» | «Gestiones de SOAT sin soporte cargado [48] horas después de pedidas. El umbral se cambia en Umbrales y alertas. No depende del periodo.» | «Ver las 9» → `soat_sin_gestion` |
| S2 | SOAT por vencer | Foto | «[27] SOAT vencen en los próximos [30] días; [6] vencen esta semana.» | «Ningún SOAT vence en los próximos [30] días.» | «SOAT vigentes cuya fecha de vencimiento cae dentro de los próximos [30] días. El umbral se cambia en Umbrales y alertas. No depende del periodo.» | «Ver los 27» → `soat_por_vencer` |
| S3 | Vigencia sin verificar | Foto | «[15] SOAT aún no tienen la vigencia verificada.» | «Todos los SOAT tienen la vigencia verificada.» | «SOAT cuyo estado de vigencia sigue sin verificar. No depende del periodo.» | «Ver los 15» → `soat_vigencia_no_verificada` |
| S4 | SOAT pagados | P | Con dinero: «[138] SOAT pagados en el periodo por $[96] M.» · Sin dinero: «[138] SOAT pagados en el periodo.» | «No se pagó ningún SOAT en el periodo.» | «SOAT cuya fecha de pago cae en el periodo elegido, con los filtros de arriba. El valor es lo pagado.» | «Ver los 138» → `soat_pagados_periodo` |

> «Ver los 6 que vencen esta semana» **no** es un segundo enlace: el desglose es solo texto. Necesita el conteo a ≤ 7 días en la explicación (ⓡ, §Datos).

**Tabla principal — SOAT por estado (Foto).** Columnas: Estado (`StatusChip`) · SOAT · (sin rótulo, `sr-only` «Registros») «Ver los N →». Las filas son los estados reales de `flito_soat.estado`, en el orden del flujo, más una fila Total. Conjunto: `soat_por_estado` con `s=estado:<clave>`.

**Bloque secundario — Solicitudes incompletas abiertas, por motivo** (`RankingTorre`, que ya existe). Fila: Motivo · Solicitudes · «Ver las N →». Conjunto: `soat_incompletas_abiertas` con `s=motivo:<clave>`. Se justifica como bloque y no como KPI porque es una cola distinta (solicitudes que nunca llegaron a ser SOAT) y su lectura útil es el reparto por motivo, no un total.

Las cargas masivas (`flito_soat_masivo_*`) **no** salen en esta pestaña: son PII efímera (ADR-0032) y no hay conjunto para ellas.

```
┌ Pestanas: [SOAT] · Impuestos · Derechos ───────────────────────────────────────┐
│ 412 SOAT en gestión hoy; 9 llevan más de 48 horas sin soporte.                 │
│ ┌ S1 Sin soporte ┐ ┌ S2 Por vencer ┐ ┌ S3 Vigencia ┐ ┌ S4 Pagados (P) ┐        │
│ │ 9 · Foto       │ │ 27 · Foto     │ │ 15 · Foto   │ │ 138            │        │
│ │ frase…  Ver →  │ │ frase… Ver →  │ │ frase… Ver →│ │ frase…  Ver →  │        │
│ └────────────────┘ └───────────────┘ └─────────────┘ └────────────────┘        │
│ SOAT por estado                                              [Foto de hoy]     │
│ │ Estado          │ SOAT │                                                │    │
│ │ (Solicitado)    │  88  │ Ver los 88 →                                   │    │
│ │ (Enviado)       │ 201  │ Ver los 201 →                                  │    │
│ │ (Expedido)      │ 123  │ Ver los 123 →                                  │    │
│ │ Total           │ 412  │ Ver los 412 →                                  │    │
│ Solicitudes incompletas abiertas, por motivo                                   │
│ │ Falta tarjeta de propiedad │ 7 │ Ver las 7 →                               │    │
└────────────────────────────────────────────────────────────────────────────────┘
```

**Estados.**

| Estado | Copy |
|---|---|
| Cargando | Esqueleto: 4 tarjetas + la tabla de 2 columnas con 5 filas + el ranking con 3 filas |
| Error | «No pudimos cargar los SOAT. Intente de nuevo.» + Reintentar |
| Vacío (sin SOAT en gestión ni pagados) | `FlitEmpty`: «No hay SOAT en gestión ni pagados en el periodo con estos filtros. Amplíe el periodo o quite filtros de compañía u organismo.» |
| Vacío del bloque de incompletas | Una línea dentro del bloque: «No hay solicitudes incompletas abiertas.» |
| Lleno | Wireframe |

**Móvil.** KPI en 1 columna; tabla y ranking a ancho completo (2 columnas, sin scroll). «Ver los N» queda bajo la cifra si no cabe a su lado.

### B3.2 Impuestos

**Para qué existe.** Para ver qué impuestos están detenidos, rechazados o con diferencia, y cuánto se pagó.

**Frase guía:** «[236] impuestos en gestión hoy; [5] llevan más de [48] horas sin soporte.»

| # | Rótulo | Base | Frase (lleno) | Frase en 0 | ¿Cómo se calcula? | Ver → conjunto |
|---|---|---|---|---|---|---|
| I1 | Impuestos sin soporte fuera de ANS | Foto | «[5] gestiones de impuesto llevan más de [48] horas sin soporte; [2] pasan de [96].» | «Todos los impuestos pedidos tienen soporte dentro de [48] horas.» | «Gestiones de impuesto sin soporte cargado [48] horas después de pedidas. El umbral se cambia en Umbrales y alertas. No depende del periodo.» | «Ver las 5» → `impuesto_sin_gestion` |
| I2 | Con diferencia de valor | Foto | «[8] impuestos quedaron marcados con diferencia entre lo liquidado y lo pagado.» | «Ningún impuesto tiene diferencia marcada.» | «Impuestos que FLITO marcó con diferencia de valor y que siguen abiertos. No depende del periodo.» | «Ver los 8» → `impuestos_con_diferencia` |
| I3 | Dirección por revisar | Foto | «[4] impuestos tienen la dirección pendiente de revisión.» | «Ningún impuesto tiene la dirección pendiente.» | «Impuestos marcados para revisar la dirección del propietario antes de liquidar. La lista muestra la placa, no la dirección. No depende del periodo.» | «Ver los 4» → `impuestos_direccion_pendiente` |
| I4 | Impuestos pagados | P | Con dinero: «[97] impuestos pagados en el periodo por $[41] M.» · Sin dinero: «[97] impuestos pagados en el periodo.» | «No se pagó ningún impuesto en el periodo.» | «Impuestos cuya fecha de pago cae en el periodo elegido. Es la misma cifra que la métrica Impuestos pagados del Explorador.» | «Ver los 97» → `impuestos_pagados_periodo` |

**Tabla principal — Impuestos por estado (Foto).** Columnas: Estado (`StatusChip`) · Impuestos · «Ver los N →». Las filas son los estados reales y se cierra con una fila Total. Conjunto: `impuestos_por_estado` con `s=estado:<clave>`.

**Bloque secundario — Rechazados en el periodo, por motivo** (`RankingTorre`). Fila: Motivo · Impuestos · «Ver los N →». Conjunto: `impuestos_rechazados_periodo` con `s=motivo:<clave>`. Va como bloque, igual que las incompletas de SOAT: lo que sirve es saber **por qué** se rechazan. En el encabezado del bloque se ve el chip del periodo, no el de «Foto de hoy».

**Dirección (Ley 1581).** La dirección no aparece en la KPI, ni en la frase, ni en el detalle, ni en el Excel. El detalle de I3 lista Placa · Compañía · Estado · Días en el estado.

```
┌ Pestanas: SOAT · [Impuestos] · Derechos ───────────────────────────────────────┐
│ 236 impuestos en gestión hoy; 5 llevan más de 48 horas sin soporte.            │
│ [I1 Sin soporte 5] [I2 Con diferencia 8] [I3 Dirección por revisar 4] [I4 97]  │
│ Impuestos por estado  … Estado │ Impuestos │ Ver los N →  … Total 236          │
│ Rechazados en el periodo, por motivo                                           │
│ │ Placa no corresponde al organismo │ 6 │ Ver los 6 →                        │  │
└────────────────────────────────────────────────────────────────────────────────┘
```

**Estados.**

| Estado | Copy |
|---|---|
| Cargando | Igual que SOAT |
| Error | «No pudimos cargar los impuestos. Intente de nuevo.» + Reintentar |
| Vacío | «No hay impuestos en gestión ni pagados en el periodo con estos filtros. Amplíe el periodo o quite filtros de compañía u organismo.» |
| Vacío del bloque de rechazados | «No se rechazó ningún impuesto en el periodo.» |
| Lleno | Wireframe |

**Móvil.** Igual que SOAT.

### B3.3 Derechos

**Para qué existe.** Para ver cuántos derechos se pagaron y cuáles no tienen soporte o siguen pendientes.

**Frase guía:** «[184] derechos pagados en el periodo; [11] siguen pendientes sin resolver.»

| # | Rótulo | Base | Frase (lleno) | Frase en 0 | ¿Cómo se calcula? | Ver → conjunto |
|---|---|---|---|---|---|---|
| D1 | Derechos pagados | P | Con dinero: «[184] derechos pagados en el periodo por $[23] M.» · Sin dinero: «[184] derechos pagados en el periodo.» | «No se pagó ningún derecho en el periodo.» | «Derechos registrados con fecha de pago dentro del periodo elegido. Es la misma cifra que la métrica del Explorador.» | «Ver los 184» → `derechos_pagados_periodo` |
| D2 | Derechos sin soporte | Foto | «[7] derechos registrados no tienen soporte cargado.» | «Todos los derechos registrados tienen soporte.» | «Derechos registrados en un trámite que no tienen documento de soporte asociado. No depende del periodo.» | «Ver los 7» → `derechos_sin_soporte` |
| D3 | Pendientes sin resolver | Foto | «[11] pagos de derechos siguen sin asociarse a un trámite; [3] tienen más de [5] intentos.» | «No hay pagos de derechos pendientes.» | «Pagos de derechos que llegaron y aún no se asocian a un trámite. No depende del periodo.» | «Ver los 11» → `derechos_pendientes_sin_resolver` |

**Tabla principal: no hay, y es una decisión.** Derechos tiene 3 conjuntos y ninguno tiene estado ni motivo para repartir. Una tabla repetiría las tres cifras. La pestaña queda en 3 KPI (rejilla de 3 en `lg`). Si el PO quiere el reparto por origen, se pide el segmento `origen` en `derechos_pagados_periodo`: no se inventa aquí.

> El desglose de D3 («[3] con más de [5] intentos») exige el conteo en la explicación (ⓡ). El «5» no es un umbral configurable: si no hay umbral, la frase termina en el total y no lleva desglose.

```
┌ Pestanas: SOAT · Impuestos · [Derechos] ───────────────────────────────────────┐
│ 184 derechos pagados en el periodo; 11 siguen pendientes sin resolver.         │
│ ┌ D1 Pagados (P) 184 ┐ ┌ D2 Sin soporte 7 · Foto ┐ ┌ D3 Pendientes 11 · Foto ┐  │
└────────────────────────────────────────────────────────────────────────────────┘
```

**Estados.**

| Estado | Copy |
|---|---|
| Cargando | 3 tarjetas de esqueleto |
| Error | «No pudimos cargar los derechos. Intente de nuevo.» + Reintentar |
| Vacío (las tres en 0) | Las tres tarjetas con su frase en 0; no se pone `FlitEmpty` encima. Las frases en 0 ya dicen el siguiente paso de cada cifra |
| Lleno | Wireframe |

**Móvil.** 3 KPI en 1 columna.

### B3 — Columna clave del detalle (§5.1 del molde)

| Conjunto | Entidad | Columna clave (orden por defecto) | Columnas propias |
|---|---|---|---|
| `soat_sin_gestion` / `impuesto_sin_gestion` | gestión | Horas sin soporte ↓ | — |
| `soat_por_vencer` | SOAT | Vence el ↑ | Póliza (••••1234) |
| `soat_vigencia_no_verificada` | SOAT | Días en el estado ↓ | — |
| `soat_pagados_periodo` | SOAT | Pagado el ↓ | Valor* |
| `soat_incompletas_abiertas` | solicitud | Solicitada el ↑ | Motivo · Intentos |
| `impuestos_con_diferencia` | impuesto | Diferencia* ↓ (sin dinero: Días en el estado) | Liquidado* · Pagado* |
| `impuestos_direccion_pendiente` | impuesto | Días en el estado ↓ | — (**nunca** la dirección) |
| `impuestos_rechazados_periodo` | impuesto | Rechazado el ↓ | Motivo |
| `impuestos_pagados_periodo` / `derechos_pagados_periodo` | impuesto / derecho | Pagado el ↓ | Valor* |
| `derechos_sin_soporte` | derecho | Registrado el ↑ | N.º de radicado |
| `derechos_pendientes_sin_resolver` | pago pendiente | Fecha de pago ↑ | Intentos |
| `*_por_estado` | SOAT / impuesto | Días en el estado ↓ | — |

\* Solo con `torre.metricas.dinero`. Las entidades distintas de trámite llevan «Abrir trámite» solo si la fila tiene `tramite_id`. Los pagos pendientes no lo tienen, así que van sin acción por fila.

---

## B4 — Área Logística (nueva) · PageSlug `torre_logistica`

- **Público.** Coordinación de logística y gerencia, que siguen los traslados de documentos y las entregas.
- **Permiso.** `torre.tablero_logistica.ver`. **Propuesta UX:** el mismo reparto que `torre_operativa`; lo fija architecture.
- **Navegación.** Entrada «Logística» en `navEntradas.ts`, después de Productos.
- **Encabezado.** Título «Logística». Subtítulo: «Qué documentos se están moviendo y qué entregas están pendientes o volvieron.» Primaria: «Descargar Excel».
- **Pestañas.** Traslados · Entregas.

### B4.1 Traslados

**Para qué existe.** Para ver qué traslados siguen abiertos y cuáles llevan demasiado tiempo.

**Frase guía:** «[58] traslados abiertos hoy; [6] llevan más de [3] días.»

| # | Rótulo | Base | Frase (lleno) | Frase en 0 | ¿Cómo se calcula? | Ver → conjunto |
|---|---|---|---|---|---|---|
| T1 | Traslados abiertos | Foto | «[58] traslados siguen abiertos hoy entre [12] orígenes y destinos.» ⓡ | «No hay traslados abiertos.» | «Traslados registrados que todavía no se cierran como recibidos. No depende del periodo.» | «Ver los 58» → `traslados_por_estado` + `s=estado:<abiertos>` |
| T2 | Abiertos hace más de [3] días | Foto | «[6] traslados llevan abiertos más de [3] días; [2] pasan de [6].» | «Ningún traslado lleva abierto más de [3] días.» | «Traslados abiertos cuya fecha de registro tiene más de [3] días. El umbral se cambia en Umbrales y alertas. No depende del periodo.» | «Ver los 6» → `traslados_abiertos_mas_de_n` |

**Tabla principal — Traslados por estado (Foto).** Columnas: Estado (`StatusChip`) · Traslados · «Ver los N →», con fila Total. Conjunto: `traslados_por_estado` con `s=estado:<clave>`.

**Detalle.** Columnas: Código del traslado · Origen · Destino · Estado · Registrado el · Días abierto (clave ↓) · N.º de trámites. **No** se muestra el nombre del mensajero: es una persona y no responde a esta visita.

```
┌ Pestanas: [Traslados] · Entregas ──────────────────────────────────────────────┐
│ 58 traslados abiertos hoy; 6 llevan más de 3 días.                             │
│ ┌ T1 Traslados abiertos 58 · Foto ┐ ┌ T2 Abiertos > 3 días 6 · Foto ┐          │
│ Traslados por estado  │ (Registrado) 31 │ (En camino) 27 │ (Recibido) 140 … │   │
└────────────────────────────────────────────────────────────────────────────────┘
```

**Estados.**

| Estado | Copy |
|---|---|
| Cargando | 2 tarjetas + la tabla de 2 columnas con 4 filas |
| Error | «No pudimos cargar los traslados. Intente de nuevo.» + Reintentar |
| Vacío | `FlitEmpty`: «No hay traslados registrados con estos filtros. Quite filtros de compañía para ver el resto.» |
| Lleno | Wireframe |

**Móvil.** 2 KPI apiladas; la tabla a ancho completo.

### B4.2 Entregas

**Para qué existe.** Para ver qué actas siguen sin entregar, cuántas volvieron y por qué, y cuánto se entrega al primer intento.

**Frase guía:** «[240] entregas en el periodo; [23] actas siguen pendientes de entrega hoy.»

| # | Rótulo | Base | Frase (lleno) | Frase en 0 | ¿Cómo se calcula? | Ver → conjunto |
|---|---|---|---|---|---|---|
| E1 | Actas pendientes de entrega | Foto | «[23] actas siguen pendientes de entrega hoy.» | «No hay actas pendientes de entrega.» | «Actas de entrega creadas que todavía no tienen fecha de entrega ni devolución. No depende del periodo.» | «Ver las 23» → `actas_pendientes_entrega` |
| E2 | Entregas al primer intento | P | «De las [240] entregas del periodo, [221] se hicieron al primer intento; [19] necesitaron otro viaje.» | «No hubo entregas en el periodo.» (cifra «—») | «Trámites aprobados en el periodo con logística cobrada. Cuentan como primer intento los que no tuvieron un viaje adicional.» (el mismo texto de O4) | «Ver las 19 con reintento» → `entregas_periodo` + `s=nivel:con_viajes` (complemento, §2 del molde) |
| E3 | Actas devueltas | P | «[12] actas volvieron sin entregarse en el periodo; el motivo más común: [Destinatario ausente] ([5]).» | «Ninguna acta volvió en el periodo.» | «Actas con devolución registrada en el periodo, con su motivo.» | «Ver las 12» → `actas_devueltas_periodo` |
| E4 | Viajes adicionales | P | «[26] viajes adicionales en el periodo, en [19] trámites.» | «No hubo viajes adicionales en el periodo.» | «Viajes de logística registrados después del primero, por trámite, dentro del periodo.» | «Ver los 26» → `viajes_adicionales_periodo` |

**Tabla principal — Devueltas en el periodo, por motivo.** Columnas: Motivo · Actas · «Ver las N →». Conjunto: `actas_devueltas_periodo` con `s=motivo:<clave>`. Se elige esta tabla porque los pendientes ya están en E1 y lo que se puede corregir es el motivo de las devoluciones.

**Detalle de actas (Ley 1581).** Columnas: Placa · Compañía · Proveedor de logística · Creada el · Estado · Motivo (solo las devueltas) · Días pendiente (clave ↓). **Nunca** se muestran dirección de entrega, receptor, contacto, nombre de quien entrega, coordenadas ni storage keys.

```
┌ Pestanas: Traslados · [Entregas] ──────────────────────────────────────────────┐
│ 240 entregas en el periodo; 23 actas siguen pendientes de entrega hoy.         │
│ [E1 Pendientes 23 · Foto] [E2 Primer intento 92 %] [E3 Devueltas 12] [E4 26]   │
│ Devueltas en el periodo, por motivo                                            │
│ │ Destinatario ausente     │ 5 │ Ver las 5 →                                │  │
│ │ Dirección no encontrada  │ 4 │ Ver las 4 →                                │  │
└────────────────────────────────────────────────────────────────────────────────┘
```

**Estados.**

| Estado | Copy |
|---|---|
| Cargando | 4 tarjetas + la tabla de 2 columnas con 4 filas |
| Error | «No pudimos cargar las entregas. Intente de nuevo.» + Reintentar |
| Vacío (sin entregas ni actas) | `FlitEmpty`: «No hay entregas ni actas en el periodo con estos filtros. Amplíe el periodo o quite filtros.» |
| Vacío de la tabla | Una línea en su lugar: «Ninguna acta volvió en el periodo.» |
| Lleno | Wireframe |

**Móvil.** KPI en 1 columna; la tabla a ancho completo. El nombre del motivo envuelve; no se trunca.

---

## B4 — Financiera: pestañas Resumen · Facturación · Bolsas

Se amplía un área que ya existe. El slug (`torre_financiera`), la función y el encabezado no cambian. **Resumen** es el tablero de hoy con F1–F4 de §4.2. La pestaña se llama **«Bolsas»** y no «Bolsas y cartera»: la cartera sale de esta Épica (FLITO no registra el pago de las facturas de Siigo). **No** se pone una pestaña ni una cifra de cartera vacía.

### B4.3 Financiera › Facturación

**Para qué existe.** Para ver qué falta por facturar y qué facturas están trabadas en Siigo o en la DIAN.

**Frase guía:** Con dinero: «En el periodo se facturaron $[212] M en [180] facturas.» Sin dinero: «En el periodo se emitieron [180] facturas.» Al final va el enlace «Ver las 180 →» → `facturado_periodo`. Esa cifra informa y no pide acción, así que va en la frase guía y no ocupa una KPI.

| # | Rótulo | Base | Frase (lleno) | Frase en 0 | ¿Cómo se calcula? | Ver → conjunto |
|---|---|---|---|---|---|---|
| FA1 | Trabajo sin facturar | P | La de F2 (§4.2) | La de F2 | La de F2 | «Ver los 63» → `sin_facturar` |
| FA2 | Facturas con error | Foto | «[9] facturas tienen un error de Siigo o quedaron para revisión.» | «Ninguna factura tiene error ni está en revisión.» | «Facturas con código de error de Siigo o marcadas para revisión, que siguen sin corregir. No depende del periodo.» | «Ver las 9» → `facturas_con_error` |
| FA3 | Rechazadas por la DIAN | Foto | «[3] facturas fueron rechazadas por la DIAN y siguen sin corregir.» | «Ninguna factura está rechazada por la DIAN.» | «Facturas cuyo último estado ante la DIAN es rechazada. No depende del periodo.» | «Ver las 3» → `facturas_rechazadas_dian` |
| FA4 | Cola de facturación detenida | Foto | «[5] trámites esperan en la cola de facturación: [3] con el reintento vencido y [2] con los intentos agotados.» | «La cola de facturación avanza sin atascos.» | «Trámites en la cola de facturación cuyo próximo intento ya pasó o que agotaron los intentos. No depende del periodo.» | «Ver los 5» → `cola_facturacion_atascada` |

> «Facturar» es la acción del glosario (lote en Siigo); la DIAN se nombra solo en FA3. No se mezclan.

**Tabla principal — Sin facturar por compañía (P).** Columnas: Compañía · Trámites sin facturar · Valor* · «Ver los N →». Orden: Valor ↓ (sin dinero: Trámites ↓). Conjunto: `sin_facturar` con `s=compania:<uuid>`. Responde a «¿a quién le facturo primero?».

**Detalle de facturas.** Columnas: N.º de factura · Compañía · Estado · Enviada el · Total* · Error (texto **legible** del catálogo de errores, nunca el código crudo; si no hay traducción, «Error de Siigo, ver la factura») · Días (clave ↓).

```
┌ Pestanas: Resumen · [Facturación] · Bolsas ────────────────────────────────────┐
│ En el periodo se facturaron $212 M en 180 facturas.  Ver las 180 →             │
│ [FA1 Sin facturar $48 M] [FA2 Con error 9] [FA3 Rechazadas DIAN 3] [FA4 Cola 5]│
│ Sin facturar por compañía                                                      │
│ │ Compañía            │ Trámites │ Valor*    │                              │  │
│ │ Aseguradora Andina  │    31    │ $ 24,1 M  │ Ver los 31 →                 │  │
│ │ Rentacar Sur        │    18    │ $ 13,6 M  │ Ver los 18 →                 │  │
└────────────────────────────────────────────────────────────────────────────────┘
```

**Estados.**

| Estado | Copy |
|---|---|
| Cargando | Línea guía en esqueleto + 4 tarjetas + la tabla de 4 columnas con 5 filas |
| Error | «No pudimos cargar la facturación. Intente de nuevo.» + Reintentar |
| Vacío de la tabla | En su lugar: «Todo lo aprobado en el periodo ya está facturado.» |
| Sin aprobados ni facturas | `FlitEmpty`: «No hay trámites aprobados ni facturas en el periodo con estos filtros. Amplíe el periodo o quite filtros.» |
| Lleno | Wireframe |

**Móvil.** La frase guía envuelve y su enlace baja a la línea siguiente. KPI en 1 columna. La tabla usa el scroll del kit con Compañía fija.

### B4.4 Financiera › Bolsas

**Para qué existe.** Para ver qué bolsas se están quedando sin saldo y si los pagos hechos con ellas cuadran con las boletas del organismo.

**Frase guía:** «[3] bolsas en crítico y [2] en atención, de [14] activas.»

| # | Rótulo | Base | Frase (lleno) | Frase en 0 | ¿Cómo se calcula? | Ver → conjunto |
|---|---|---|---|---|---|---|
| B1 | Bolsas en crítico | Foto | «[3] bolsas alcanzan para menos de [5] días al ritmo de los últimos 30; la más baja, [Rentacar Sur] ([2] días). [2] más están en atención.» | «Ninguna bolsa está en crítico. [2] están en atención.» (o «Todas las bolsas activas cubren más de [10] días.») | «Saldo de hoy de cada bolsa dividido entre su consumo diario promedio de los últimos 30 días. Bajo [5] días es crítico y bajo [10], atención; se cambia en Umbrales y alertas. No depende del periodo.» | «Ver las 3» → `bolsas_cobertura` + `s=severidad:critico` (B4-AC3) |
| B2 | Bolsas agotadas | Foto | «[1] bolsa activa está sin saldo: [Flota Norte].» (con más de 3: «y N más») | «Ninguna bolsa activa está sin saldo.» | «Bolsas activas con saldo cero o negativo hoy. No depende del periodo.» | «Ver la 1» → `bolsas_agotadas` |
| B3 | Movimientos del periodo | P | Con dinero: «[412] movimientos en el periodo: $[180] M en recargas y $[166] M en consumos.» ⓡ · Sin dinero: «[412] movimientos de bolsa en el periodo.» | «No hubo movimientos de bolsa en el periodo.» | «Recargas, consumos y ajustes de las bolsas con fecha dentro del periodo elegido.» | «Ver los 412» → `movimientos_bolsa_periodo` |

**Tabla principal — Cobertura por bolsa (Foto).** Columnas: Compañía · Saldo* · Consumo diario* · Días de cobertura (clave, ↑) · Semáforo (`StatusChip` con texto «Crítico» / «Atención» / «Al día», nunca solo color) · «Ver los N movimientos →». La última columna exige el segmento `bolsa:<uuid>` en `movimientos_bolsa_periodo` (ⓡ). Si backend no lo da, la columna **no** se pinta: nada de enlaces deshabilitados. Sin dinero, la tabla queda en Compañía · Días de cobertura · Semáforo. Una bolsa sin consumo en 30 días muestra «Sin consumo» en Días y el semáforo «Al día».

**Bloque secundario — Conciliación de boletas.** Una tabla de 2 filas:

| Fila | Frase | Ver → conjunto |
|---|---|---|
| Sin conciliar | «[17] boletas de pago al organismo aún no se cruzan con sus trámites.» | «Ver las 17 →» → `boletas_sin_conciliar` |
| Con diferencia | «[4] boletas tienen diferencia entre el total declarado y el cruzado.» | «Ver las 4 →» → `boletas_con_diferencia` |

En 0: «Todas las boletas están conciliadas y cuadran.» (una línea en lugar de la tabla).

**Decisión: la conciliación va en Bolsas y no en Facturación ni en Resumen.**
- Facturación es el dinero que **entra** (el cliente vía Siigo). Las boletas son el dinero que **sale** hacia el organismo y que, en el caso de las bolsas únicas, se paga con el saldo de la bolsa. Ponerlas juntas mezclaría dos direcciones del dinero en la misma pantalla.
- Resumen ya tiene 4 KPI y la «conciliación» de soportes 3/3 (F4). Una segunda «conciliación» al lado confundiría dos conceptos con el mismo nombre. Por eso el rótulo del bloque dice siempre **«de boletas»**.
- Va como bloque y no como KPI porque son dos conjuntos con un solo tema, y una KPI solo tiene un enlace (§12 del molde).
- **Supuesto a confirmar con el PO** (no está en `docs/dominio.md`): que las boletas de `flito_conciliacion_boletas` son los pagos al organismo, incluidos los hechos con bolsa. Si no tienen relación con las bolsas, el bloque pasa tal cual a Facturación, al final, y nada más cambia.

```
┌ Pestanas: Resumen · Facturación · [Bolsas] ────────────────────────────────────┐
│ 3 bolsas en crítico y 2 en atención, de 14 activas.                            │
│ [B1 En crítico 3 · Foto] [B2 Agotadas 1 · Foto] [B3 Movimientos 412]           │
│ Cobertura por bolsa                                                            │
│ │ Compañía      │ Saldo*  │ Consumo/día* │ Días ↑ │ Semáforo  │             │  │
│ │ Rentacar Sur  │ $ 2,8 M │ $ 1,4 M      │   2    │ (Crítico) │ Ver los 38 →│  │
│ │ Flota Norte   │ $ 0     │ $ 0,6 M      │   0    │ (Crítico) │ Ver los 21 →│  │
│ Conciliación de boletas                                                        │
│ │ Sin conciliar   │ 17 boletas aún no se cruzan…      │ Ver las 17 →       │    │
│ │ Con diferencia  │  4 boletas con diferencia…        │ Ver las 4 →        │    │
└────────────────────────────────────────────────────────────────────────────────┘
```

**Estados.**

| Estado | Copy |
|---|---|
| Cargando | 3 tarjetas + la tabla de cobertura con 5 filas + el bloque con 2 filas |
| Error | «No pudimos cargar las bolsas. Intente de nuevo.» + Reintentar |
| Vacío (no hay bolsas activas) | `FlitEmpty`: «No hay bolsas activas con estos filtros. Si la compañía usa bolsa, revise que esté activa en Bolsas únicas.» El bloque de boletas se sigue mostrando, porque no depende de que haya bolsas |
| Lleno | Wireframe |

**Móvil.** 3 KPI apiladas. La tabla usa el scroll del kit con Compañía fija. El bloque de boletas apila la frase sobre el enlace.

---

## B5 — Operativa › Equipo

- **Público.** Solo `gerencia_general` y `admin` (decisión humana del 2026-11-19), con `torre.equipo.ver`. Sin la función, la pestaña **no se pinta** y la ruta responde 403. Desde B5 la pestaña deja de estar vacía.
- **Para qué existe.** Para ver cómo está repartido el trabajo del equipo y dónde hace falta apoyo. No es un ranking.

**Frase guía:** «[14] funcionarios registraron gestiones en el periodo; hoy tienen [286] gestiones abiertas a su cargo.»

| # | Rótulo | Base | Frase (lleno) | Frase en 0 | ¿Cómo se calcula? | Ver → conjunto |
|---|---|---|---|---|---|---|
| Q1 | Gestiones del periodo | P | «El equipo registró [3.420] gestiones en el periodo.» | «No se registraron gestiones en el periodo.» | «Cambios de estado y gestiones de SOAT, impuesto, derecho, traslado y solicitudes incompletas que registró cada funcionario dentro del periodo elegido.» | «Ver las 3.420» → `gestiones_funcionario_periodo` |
| Q2 | Carga abierta | Foto | «Hay [286] gestiones abiertas cuyo último movimiento lo hizo alguien del equipo.» | «No hay gestiones abiertas a cargo del equipo.» | «Gestiones que siguen abiertas, asignadas al funcionario que las movió por última vez. No depende del periodo.» | «Ver las 286» → `carga_funcionario` |
| Q3 | Pendientes fuera de ANS | Foto | «[31] de esas gestiones abiertas ya pasaron su ANS.» | «Ninguna gestión abierta está fuera de ANS.» | «Gestiones abiertas cuyo último movimiento hizo un funcionario y que superan el ANS operativo o el umbral de Umbrales y alertas. No depende del periodo.» | «Ver las 31» → `fuera_ans_funcionario` |

**Tabla principal — Por funcionario.** Columnas: Funcionario (`users.name`) · Gestiones del periodo · Carga abierta · Pendientes fuera de ANS. **Cada cifra es un `button`**, con el mismo patrón que las celdas de §6.2: velo de hover, `flit-focus` y `aria-label` «Ana Restrepo: 12 pendientes fuera de ANS. Ver cuáles». Abre el conjunto de esa columna con `s=funcionario:<uuid>`. Las celdas en 0 muestran «—» y no se pulsan.

**Copy y forma respetuosos (obligatorio).**
- **Orden por defecto: alfabético por nombre.** Las columnas se pueden ordenar, pero la tabla no abre ordenada por «más pendientes».
- Sin posiciones (1.º, 2.º), sin medallas, sin ▲ ni tinta de peligro en la columna «fuera de ANS» y sin semáforo por persona. Un número alto no es una falta: puede ser la persona con más carga asignada.
- Rótulos permitidos: «Carga abierta», «Pendientes», «Pendientes fuera de ANS». Prohibidos: «peores», «más lentos», «incumplimientos», «ranking».
- Solo salen los funcionarios con alguna cifra > 0 en el periodo o en la foto. No se lista a todo `users`.
- Nunca se muestra `usuario_email` ni otro dato del funcionario aparte del nombre.

**Detalle (entidad gestión).** Columnas: Placa · Qué se gestionó (Trámite · SOAT · Impuesto · Derecho · Traslado · Solicitud) · Estado · Último movimiento el · Horas o días desde el último movimiento (clave ↓) · Abrir trámite. El título del detalle lleva el nombre: «Pendientes fuera de ANS de Ana Restrepo». En la URL va solo el uuid.

**Export.** **Sin «Descargar Excel» en Equipo en v1**: el AC no lo pide y es información de desempeño de personas. En esta pestaña no se pinta el botón, y cada detalle exporta su lista con las reglas de siempre. Si el PO lo quiere, se pregunta.

```
┌ Pestanas: Resumen · Inventario por estado · Soportes · [Equipo] ───────────────┐
│ 14 funcionarios registraron gestiones en el periodo; hoy tienen 286 abiertas.  │
│ [Q1 Gestiones del periodo 3.420] [Q2 Carga abierta 286 · Foto] [Q3 Fuera ANS 31]│
│ Por funcionario                                         Orden: Nombre (A–Z) ▾  │
│ │ Funcionario      │ Gestiones del periodo │ Carga abierta │ Pendientes fuera de ANS │
│ │ Ana Restrepo     │        [412]          │     [38]      │          [12]           │
│ │ Bruno Cárdenas   │        [380]          │     [22]      │           —             │
└────────────────────────────────────────────────────────────────────────────────┘
```

**Estados.**

| Estado | Copy |
|---|---|
| Cargando | 3 tarjetas + la tabla de 4 columnas con 6 filas |
| Error | «No pudimos cargar la información del equipo. Intente de nuevo.» + Reintentar |
| Vacío | `FlitEmpty`: «Nadie del equipo registró gestiones en el periodo ni tiene gestiones abiertas. Amplíe el periodo para ver la actividad anterior.» |
| Lleno | Wireframe |
| Sin `torre.equipo.ver` | La pestaña no existe; `?vista=equipo` cae en Resumen sin aviso |

**Móvil.** KPI en 1 columna. La tabla usa el scroll del kit con Funcionario fijo, y el orden se elige con el `Select` «Ordenar por».

---

## B6 — «Para hoy» y hallazgos en el 360°

### B6.1 «Para hoy»: se confirma §7 del molde

Se confirman sin cambios la ubicación (primero en el 360°), la fila (gravedad · cifra · frase · enlace), el orden (crítico → atención → cifra), el máximo de 8 visibles con disclosure, los permisos (solo los frentes cuyo conjunto puede abrir el usuario), la ausencia de frentes en cero, los 4 estados y el móvil.

**Corrección de copy: borradores (regla unificada de B2).** La regla ya no es «después de creados». Es «días **en** el estado Borrador», contados desde la entrada al estado (último cambio de `flit_estado`, con respaldo en la creación) y con el umbral `dias_borrador_abandonado`. Se reemplazan los textos en **todos** los sitios donde aparecen:

| Dónde | Antes | Ahora |
|---|---|---|
| «Para hoy» (§7) | «12 trámites siguen en Borrador más de 7 días después de creados.» | «12 trámites llevan más de [7] días en Borrador.» |
| KPI O2, frase (§4.2) | «12 trámites siguen en Borrador más de [7] días después de creados; [4] pasan de [14] días.» | «12 trámites llevan más de [7] días en Borrador; [4] pasan de [14].» |
| KPI O2, «¿Cómo se calcula?» y `definicion` del catálogo | «Trámites en estado Borrador cuya fecha de creación tiene más de [7] días…» | «Trámites que llevan más de [7] días en estado Borrador, contados desde que entraron a ese estado (o desde su creación, si nunca cambiaron de estado). El umbral se cambia en Umbrales y alertas. Es la foto de hoy: no depende del periodo elegido.» |
| Detalle, encabezado (§5.1) | «…más de 7 días después de creados.» / «…cuya fecha de creación tiene más de 7 días.» | La frase y la definición de arriba |
| Detalle, vacío (§5.3) | «Hoy ningún borrador pasa de 7 días.» | «Hoy ningún trámite lleva más de [7] días en Borrador. Cuando alguno pase el umbral, aparecerá aquí.» |
| KPI O2 en 0 | «Ningún borrador pasa de [7] días.» | «Ningún trámite lleva más de [7] días en Borrador.» |

> La columna clave del detalle de borradores ya era «Días en el estado», así que no cambia. Las maquetas `torre-kpi-explicable.html`, `torre-detalle.html` y `torre-360-para-hoy.html` conservan el copy viejo: el `frontend-agent` usa el de esta tabla y **no** el de la maqueta.

### B6.2 Frentes candidatos (lista fija, en `flito-torre.ejecutivo.service.ts`)

**Regla de gravedad.** Por defecto, un frente es **Crítico** si tiene registros por encima del doble de su umbral y **Atención** si no (es la regla de `severidad` de hoy). Donde no hay umbral de tiempo, la gravedad es fija y se declara en la tabla. Un frente entra solo con cifra > 0 y solo si el usuario tiene la función de su tablero de origen.

| Bloque | Frente (conjunto) | Gravedad | Frase del frente (sin la cifra, que va en su columna) | Acción |
|---|---|---|---|---|
| B1 | `soat_sin_gestion` + `impuesto_sin_gestion` (radar) | Doble umbral | «gestiones de SOAT e impuestos llevan más de [48] horas sin soporte.» | Ver las N |
| B1 | `borrador_abandonado` | Doble umbral | «trámites llevan más de [7] días en Borrador.» | Ver los N |
| B1 | `estancado_ot` | Doble umbral | «trámites llevan en el organismo más de [10] días.» | Ver los N |
| B1 | `sin_facturar` (mes en curso) | Atención fija | «trámites aprobados este mes aún no tienen factura ($[48] M).» (sin dinero, sin la cifra en pesos) | Ver los N |
| B1 | Clientes en caída (`fuga`) | Atención fija | «compañías crearon al menos [30] % menos trámites que su promedio.» | Revisar → Comercial › Clientes |
| B3 | `soat_por_vencer` | Crítico si alguno vence en ≤ 7 días (ⓡ); si no, atención | «SOAT vencen en los próximos [30] días.» | Ver los N |
| B3 | `soat_vigencia_no_verificada` | Atención fija | «SOAT aún no tienen la vigencia verificada.» | Ver los N |
| B3 | `soat_incompletas_abiertas` | Atención fija | «solicitudes de SOAT siguen incompletas.» | Ver las N |
| B3 | `impuestos_con_diferencia` | Atención fija | «impuestos tienen diferencia entre lo liquidado y lo pagado.» | Ver los N |
| B3 | `impuestos_direccion_pendiente` | Atención fija | «impuestos esperan revisión de la dirección.» | Ver los N |
| B3 | `derechos_pendientes_sin_resolver` | Atención fija | «pagos de derechos siguen sin asociarse a un trámite.» | Ver los N |
| B4 | `traslados_abiertos_mas_de_n` | Doble umbral | «traslados llevan abiertos más de [3] días.» | Ver los N |
| B4 | `actas_pendientes_entrega` | Atención fija | «actas siguen pendientes de entrega.» | Ver las N |
| B4 | `facturas_rechazadas_dian` | **Crítico fijo** (sin corrección no se cobra) | «facturas fueron rechazadas por la DIAN.» | Ver las N |
| B4 | `cola_facturacion_atascada` | Crítico si hay intentos agotados; si no, atención | «trámites están detenidos en la cola de facturación.» | Ver los N |
| B4 | `facturas_con_error` | Atención fija | «facturas tienen un error de Siigo o están en revisión.» | Ver las N |
| B4 | `bolsas_cobertura` + `severidad:critico` | **Crítico fijo** | «bolsas alcanzan para menos de [5] días; la más baja, [Rentacar Sur].» | Ver las N |
| B4 | `bolsas_agotadas` | **Crítico fijo** | «bolsas activas están sin saldo.» | Ver las N |
| B4 | `boletas_con_diferencia` | Atención fija | «boletas de pago al organismo tienen diferencia con lo cruzado.» | Ver las N |

**No son frentes** (informan, no piden acción): los conjuntos `*_por_estado`, `*_pagados_periodo`, `movimientos_bolsa_periodo`, `facturado_periodo`, `entregas_periodo`, `viajes_adicionales_periodo`, `actas_devueltas_periodo`, `impuestos_rechazados_periodo`, `boletas_sin_conciliar` (el atraso normal del cruce; si el PO lo quiere, entra como Atención) y `derechos_sin_soporte` (ya cuenta en Soportes 3/3).

**B5 no aporta frentes, y es una decisión.** «Para hoy» lo ven más roles que Equipo, y un frente del tipo «Ana tiene 12 pendientes fuera de ANS» señalaría a una persona en el 360°. Las gestiones fuera de ANS ya están en los frentes por tema (radar, borradores, organismo).

**Dedupe.** Si están en la lista tanto `bolsas_cobertura:critico` como `bolsas_agotadas`, las agotadas se descuentan de la cifra de cobertura, para que la misma bolsa no aparezca dos veces. La frase de cobertura dice «otras [N] bolsas alcanzan…». (ⓡ backend: `bolsas_cobertura:critico` excluye las de saldo ≤ 0, o se resta.)

**Tope.** Con 19 candidatos, el disclosure «Ver los N frentes restantes» va a aparecer seguido. Es lo previsto: el máximo de 8 visibles no cambia.

### B6.3 Hallazgos (`hallazgos: string[]`)

**Qué son.** De 2 a 4 frases que dicen **qué cambió o qué llama la atención en el periodo**. Responden a «¿cómo vamos?»; «Para hoy» responde a «¿qué muevo hoy?». Por eso no van juntos.

**Dónde van.** En el 360°, **después** de las tres KPI de área y antes del resto de bloques. Es una tarjeta (`card`) con el título «Lo que cambió en el periodo» y una `<ul>` de frases en texto normal. Al final de cada frase va un enlace de texto al área donde se ve esa cifra («Ver en Comercial →»), que lleva a esa área y a su subvista con el mismo filtro. No hay KPI, ni iconos de tendencia, ni flechas de color: la frase ya dice si sube o baja.

**Reglas (deterministas, en `flito-torre.frases.ts`, sin LLM).** Se evalúan en este orden. Entra cada frase que pasa su condición, ordenadas por la magnitud relativa del cambio, con un máximo de 4. Solo se evalúan las de tableros que el usuario puede ver, y sin dinero no sale ninguna con pesos.

| # | Condición | Frase |
|---|---|---|
| H1 | Volumen: \|Δ trámites creados\| ≥ 10 % frente al periodo anterior | «Se crearon [1.240] trámites, [7] % más que en el periodo anterior ([1.155]).» / «…[12] % menos que…» |
| H2 | Concentración: Top 3 ≥ 80 % de los creados | «[3] compañías concentran el [98] % de los trámites creados; la mayor, [Aseguradora Andina], el [61] %.» |
| H3 | Conversión: \|Δ\| ≥ 5 puntos frente al periodo anterior | «La conversión a facturado bajó de [31] % a [25] % frente al periodo anterior.» |
| H4 | Sin facturar: sube ≥ 20 % y al menos 10 trámites | «Lo aprobado sin facturar pasó de [40] a [63] trámites frente al periodo anterior.» (con dinero: «…de $[30] M a $[48] M») |
| H5 | Primer intento: \|Δ\| ≥ 3 puntos | «Las entregas al primer intento bajaron de [95] % a [92] %.» |
| H6 | Productos: \|Δ SOAT o impuestos pagados\| ≥ 15 % | «Se pagaron [138] SOAT, [20] % menos que en el periodo anterior.» |

- Los umbrales de la tabla (10 %, 80 %, 5 puntos…) son **constantes fijas** de `frases.ts`, no umbrales nuevos de Umbrales y alertas. Si el PO quiere configurarlos, se pregunta.
- Los números de cada frase son **los mismos del tablero** (B6-AC2). Hace falta el valor del periodo anterior de H1, H3, H4, H5 y H6 (ⓡ; hoy solo C4 lo trae).
- Con un periodo anterior sin datos, la frase de variación no entra (no se escribe «infinito %»).

**Estados.**

| Estado | Qué se ve |
|---|---|
| Cargando | La tarjeta con 3 líneas de esqueleto |
| Error | Viene en el mismo DTO del 360°, así que es el error de la página (`PaginaTorre` + Reintentar). No hay error propio |
| Vacío (ninguna regla se cumple) | La tarjeta con una línea: «Sin cambios notables frente al periodo anterior. Las cifras de cada área siguen en sus pestañas.» |
| Lleno | De 2 a 4 frases con su enlace |

**Móvil.** Las frases envuelven a ancho completo y el enlace baja a su propia línea.

```
┌ Para hoy: hay 9 frentes por atender ─────────────────────── [Foto de hoy] ┐
│ ● Crítico │ 3 │ facturas fueron rechazadas por la DIAN.        Ver las 3 →│
│ ● Crítico │ 14│ gestiones de SOAT e impuestos llevan más de…   Ver las 14→│
│ ▲ Atención│ 12│ trámites llevan más de 7 días en Borrador.     Ver los 12→│
│ …                              [Ver el frente restante ▾]                │
└──────────────────────────────────────────────────────────────────────────┘
[ KPI Comercial ] [ KPI Operativa ] [ KPI Financiera ]
┌ Lo que cambió en el periodo ─────────────────────────────────────────────┐
│ • Se crearon 1.240 trámites, 7 % más… (no entra: < 10 %)                 │
│ • 3 compañías concentran el 98 % de los trámites creados…  Ver en Comercial →│
│ • La conversión a facturado bajó de 31 % a 25 %…           Ver en Comercial →│
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Datos (requerimientos para backend, marcados ⓡ)

1. **T1:** el número de orígenes y destinos distintos (o se quita esa parte de la frase).
2. **S2:** el conteo de los SOAT que vencen en ≤ 7 días, para el desglose y para la gravedad del frente.
3. **D3:** el conteo por intentos, solo si existe un umbral; si no, la frase va sin desglose.
4. **B3:** recargas y consumos por separado.
5. **Tabla de cobertura:** el segmento `bolsa:<uuid>` en `movimientos_bolsa_periodo`; sin él, no hay columna de enlace.
6. **Dedupe:** entre cobertura crítica y agotadas (B6.2).
7. **Hallazgos:** el valor del periodo anterior para H1, H3, H4, H5 y H6.
8. **FA2:** el texto legible del error de Siigo, de un catálogo de errores, nunca el `error_code` crudo.

## Permisos y slugs

| Superficie | Slug / función | Quién (propuesta UX; lo fija architecture en `REPARTO_TORRE`) |
|---|---|---|
| Productos | `torre_productos` · `torre.tablero_productos.ver` | El mismo reparto que `torre_operativa` |
| Logística | `torre_logistica` · `torre.tablero_logistica.ver` | El mismo reparto que `torre_operativa` |
| Financiera › Facturación / Bolsas | `torre_financiera` (sin cambio) | Sin cambio |
| Operativa › Equipo | `torre_operativa` + `torre.equipo.ver` | `gerencia_general`, `admin` (decidido) |
| «Para hoy» / hallazgos | `torre_360` (sin cambio) | Filtrado por las `funcionesOrigen` de cada frente o hallazgo |

Las dos áreas nuevas se registran en `App.tsx` con `lazy()` + `hasPage`, en `PAGINAS_TORRE`, en `navEntradas.ts` y en `permissions.ts`.

## Notas para QA (≤ 10)

1. Invariante: en cada KPI y cada fila de este doc, la cifra es igual al total de su detalle con el mismo filtro y la caché fría (B3-AC3, B4-AC3, B6-AC1).
2. B3-AC2 / B4-AC1: ninguna lista, Excel ni frase muestra la dirección del impuesto, la dirección de entrega, el receptor, el contacto, las coordenadas, el VIN completo ni la póliza completa (sí sus 4 últimos).
3. Sin `torre.tablero_productos.ver` o `torre.tablero_logistica.ver`, el área no sale en la navegación, la URL directa da 403 y sus frentes no salen en «Para hoy».
4. Equipo: un `financiera` o un `gerencia_comercial` no ven la pestaña y `?vista=equipo` cae en Resumen. La tabla abre en orden alfabético, no muestra correos ni marcas de color por persona, y el encabezado no tiene «Descargar Excel».
5. Bolsas: «Bolsas en crítico» es igual a `bolsas_cobertura` con `severidad:critico`, y una bolsa agotada no aparece dos veces en «Para hoy».
6. Copy de borradores: ningún texto dice «después de creados». Un trámite creado hace 30 días que entró a Borrador hace 2 **no** cuenta.
7. Financiera no tiene pestaña ni cifra de cartera, y la pestaña se llama «Bolsas».
8. «Para hoy»: los frentes en 0 no salen, el orden es crítico → atención → cifra, hay máximo 8 visibles y Equipo no aporta frentes.
9. Hallazgos: con datos fijos, cada frase sale solo si cumple su condición, con los mismos números del tablero; sin dinero no hay pesos, y sin cambios aparece la línea del vacío.
10. Móvil a 375 px y tema oscuro en cada subvista: sin desborde de página, con la primera columna fija en las tablas con scroll y el semáforo legible en los dos temas.

## Decisiones y descartes

- **Máximo 4 KPI y una tabla por subvista.** Las cifras que informan y no piden acción (facturado, pagados) van en la frase guía o en una KPI de «P», nunca como quinta tarjeta.
- **Derechos sin tabla:** con 3 conjuntos sin estado, una tabla repetiría las KPI.
- **Conciliación de boletas en Bolsas** (justificado en B4.4, con el supuesto a confirmar).
- **Equipo sin ranking, sin color por persona y sin Excel en v1;** no aporta frentes a «Para hoy».
- **Hallazgos separados de «Para hoy»:** uno es «¿cómo vamos?» y el otro «¿qué muevo hoy?». Mezclarlos devolvería el feed de alertas que §1 del molde descarta.
- **Sin patrones nuevos.** Todo es `KpiCard` explicable, `DataTable`, `RankingTorre`, `StatusChip`, `FlitEmpty`, `InlineAlert`, `Pestanas` y la celda-botón de §6.2. Sin sombras, gradientes, sparklines ni iconos de tendencia.
- **Preguntas abiertas (no bloquean el inicio de B3):**
  1. Si las boletas se relacionan con las bolsas (B4.4).
  2. Si `boletas_sin_conciliar` debe ser frente.
  3. Si Equipo debe exportar.
  4. Si los umbrales de los hallazgos son fijos (propuesta: sí).
  5. El reparto de los dos slugs nuevos (propuesta: el mismo de Operativa).

## Brief de mockup

**N/A en este bloque:** lo decidió el hilo, porque el molde ya está aprobado y estas subvistas no traen patrones nuevos. Si el humano pide ver alguna, se toman `torre-operativa-inventario.html` (pestañas + KPI + tabla) y `torre-360-para-hoy.html` como base, con los datos ficticios de este doc (Aseguradora Andina, Rentacar Sur, Flota Norte, `FLT 101`…; nombres de funcionario inventados, p. ej. Ana Restrepo y Bruno Cárdenas), los 4 estados y la vista de 375 px. No hay que mostrar: dirección, receptor, coordenadas, correos, cartera, ranking de funcionarios ni una segunda primaria.
