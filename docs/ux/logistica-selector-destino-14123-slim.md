# UX slim — Logística · destino del viaje y llegada a FLIT (HU #14123)

Feature del viaje a FLIT (backend HU #14122 ya en este HEAD). Extiende la pestaña de viajes de la consola (HU #14116) y la firma de entrega que ya existe. No hay ruta ni `PageSlug` nuevos. Slug `flito_logistica`. Tono de **estas** superficies: **usted**, una frase. El paso de entrega a cliente no se reescribe y sigue tuteando en la suya.

UI dice **viaje**. No se pinta «traslado». **FLIT** aquí es el destino (las instalaciones), no el nombre de la app: la app sigue siendo **FLITO**.

Mockup: (el hilo pega la URL). **Sin «ok» humano no se lanza `frontend-agent`.**

---

## Oficio

| Pregunta | Respuesta |
|---|---|
| ¿Qué vino a hacer quien abre esto? | En la pestaña: registrar el viaje de una compañía y decidir si las LT van a FLIT, al cliente, o repartidas. En la llegada: firmar que el viaje a FLIT ya llegó, con la sesión, sin pedir cédula. |
| ¿Qué se ve primero? | La compañía, cuántas LT lleva y el precio por LT de cada destino. En la llegada: la compañía, «Llegada a FLIT» y el lienzo de firma. |
| ¿Qué se calla? | VIN, propietario, NIT, proveedor, vigencia, `trasladoId`, cédula, nombre de usuario, geolocalización, mensajero en el registro, catálogo de motivos (eso es la pestaña de la HU #14120). La salida de FLIT hacia el cliente (`origen: 'flit'`) no está en esta pestaña: aquí las LT están clasificadas y el viaje directo no manda `origen`. |
| ¿Primaria única? | En la tarjeta, **Registrar viaje**. En el modal, **Confirmar viaje** (aunque salgan dos POST). En la llegada, **Confirmar llegada**. Cancelar y «Ir a Tarifas» son secundarios. |
| ¿Vacío y error con siguiente paso? | Sí: vacío dice que primero se recogen y clasifican; el error de lista trae **Reintentar**; sin motivo o sin precio el modal dice qué falta y no confirma. |
| ¿Efectos o patrón nuevo? | No. Tarjeta, `FlitModal`, `FlitPillGroup`, `FirmaCanvas`, `FlitEmpty`. |
| ¿Móvil? | La barra de pestañas envuelve; la tarjeta apila precio y primaria a ancho completo; las pastillas de cada LT envuelven; el modal hace scroll; la llegada ocupa el panel, lienzo a ancho completo. |
| ¿Feedback? | Pastilla, fila, select, nota, «+ N más», ✕, atrás, primaria y Reintentar: hover `--flit-bg-hover` y foco `flit-focus`. Disabled con opacidad del kit. |
| ¿Notificación? | Viaje registrado y llegada firmada: **toast** cerrable, una frase. Validación y 422: **en el modal o en el paso**. Carga fallida: aviso en la superficie + Reintentar. |

---

## Superficie tocada

- Pestaña de viajes en `FlitoLogistica.tsx` / `ViajesACliente.tsx`. La etiqueta pasa de «Viajes a cliente» a **Viajes** (sigue siendo la misma pestaña, el mismo gate `logistica.traslado.registrar`). El vacío de Actas que cita esa etiqueta dice «Viajes».
- Modal de confirmar: destino, precios, motivo, nota y reparto.
- Firma de entrega ya existente (`PasoEntrega` en Mi ruta, y la fila de Actas cuando el viaje ya está en ruta): la variante FLIT no pide identidad. La variante cliente no cambia.
- No se toca Tarifas, la pestaña Motivos de llegada, Viajes adicionales, ni el despacho «Firmar y despachar».

---

## Delta de claridad (qué se ve / qué se calla)

**Tarjeta (siempre visible).** Compañía y cantidad. Una línea con los dos unitarios, no un total (el total depende de cómo se repartan):

`Cliente $12.000 por LT · FLIT $8.000 por LT`

Si un destino no tiene precio, esa mitad dice «FLIT: falta el precio» o «Cliente: falta el precio» en `--flit-danger-ink`. Nunca `$0` por ausencia. Un precio configurado en cero sí se ve `$0`. Las placas siguen igual (tres y «+ N más»). La primaria **Registrar viaje** existe si al menos un destino tiene precio. Si faltan los dos, no hay primaria y se mantiene el enlace **Ir a Tarifas** (`hasPage('flito_tarifas')`) o la frase «Pídale a Finanzas que fije el precio.»

**Modal — un destino para el grupo, y se puede separar.** Pastillas `FlitPillGroup` **Cliente | FLIT** (`aria-label="Destino del viaje"`). Al pulsar una, todas las LT quedan en ese destino. Por defecto **Cliente** si ese precio existe; si solo existe el de FLIT, el defecto es FLIT. Cada LT puede cambiarse con sus propias pastillas (envuelven bajo la placa). Si el grupo queda mixto, ninguna pastilla de grupo se ve pulsada.

Al elegir, el precio de **ese** destino queda en una frase: «Se cobrará $8.000 por cada LT. Total $24.000.» Si hay los dos destinos, dos frases y esta: «Se registrarán dos viajes de Transportes Andes.» Debajo, una sola frase de congelado: «Este precio queda congelado en el viaje. Si Finanzas lo cambia después, este viaje no se mueve.»

**FLIT pide motivo; la nota es opcional.** Select **Motivo de llegada** (obligatorio, activos, en el orden del GET). Placeholder «Elija el motivo». Sin motivo, **Confirmar viaje** queda apagado y se lee «Elija el motivo de llegada.» Textarea **Nota (opcional)**, máximo 300, una sola para todas las LT que van a FLIT. A cliente no se pide motivo ni nota.

**Se calla en el modal:** mensajero, `origen`, cédula, foto, catálogo (crear o apagar motivos). Un motivo y una nota para el viaje a FLIT; no un motivo por LT.

**Llegada a FLIT.** Quien no tiene `logistica.actas.firmar_flit` no ve **Firmar llegada**. Quien la tiene la ve en dos sitios, el mismo contenido:

- Mi ruta: la tarjeta del viaje a FLIT (en ruta) abre el paso que ya sustituye el panel. No abre el formulario de nombre y cédula.
- Actas: en la fila `despachada` con destino FLIT, **Firmar llegada** es la acción de esa fila. **Ver** y **Devolver** siguen secundarios. «Firmar y despachar» sigue siendo solo el acta `generada`.

El paso o el modal de llegada muestra compañía, «Llegada a FLIT · N LT», las placas y el lienzo. Una frase: «Su nombre queda el de esta sesión.» No hay nombre, cédula, firmante ni foto. No se marcan LT sueltas: se firma el viaje. La entrega a cliente sigue pidiendo nombre, cédula y firma, con `logistica.actas.entregar`, en el paso que ya existe.

### Wireframe — tarjeta y modal

```
Viajes
Elija el destino de cada compañía y revise el precio antes de registrar.

┌ Transportes Andes · 8 LT ─────────────────────────────────┐
│ Cliente $12.000 por LT · FLIT $8.000 por LT               │
│ QOX858 · LT 10038156339                                   │
│ ABC123 · LT 10038156340                                   │
│ + 6 más                                                   │
│                                    [ Registrar viaje ]    │
└───────────────────────────────────────────────────────────┘

┌ Rápido del Valle · 6 LT ──────────────────────────────────┐
│ Cliente $12.000 por LT · FLIT: falta el precio            │
│ …                                                         │
│                                    [ Registrar viaje ]    │
└───────────────────────────────────────────────────────────┘
```

```
Registrar viaje a Transportes Andes                      [×]
Destino del viaje    ( Cliente )  FLIT

Se cobrará $12.000 por cada LT. Total $96.000.
Este precio queda congelado en el viaje. Si Finanzas lo
cambia después, este viaje no se mueve.

QOX858 · LT 10038156339          Cliente | FLIT
ABC123 · LT 10038156340          Cliente | FLIT

                    [ Cancelar ]  [ Confirmar viaje ]
```

Con destino FLIT y sin motivo (confirmar apagado):

```
Destino del viaje    Cliente  ( FLIT )

Se cobrará $8.000 por cada LT. Total $64.000.

Motivo de llegada *
[ Elija el motivo                            ▾ ]
Elija el motivo de llegada.

Nota (opcional)
[                                              ]
```

Reparto (un botón, dos viajes):

```
Se registrarán dos viajes de Transportes Andes.
A FLIT: 3 LT · $8.000 por LT · Total $24.000.
A cliente: 5 LT · $12.000 por LT · Total $60.000.
Motivo de llegada *  [ Sin dirección de entrega al recoger ▾ ]
```

### Wireframe — llegada a FLIT (390 px; en consola es `FlitModal` con los mismos bloques)

```
‹ Entregas
Transportes Andes
Llegada a FLIT · 8 LT
Su nombre queda el de esta sesión.

QOX858 · LT 10038156339
ABC123 · LT 10038156340

Firma de quien recibe en FLIT *
┌──────────────────────────┐
│      (FirmaCanvas)       │
└──────────────────────────┘

[ Cancelar ] [ Confirmar llegada ]
```

No hay campo de cédula ni de nombre. El paso a cliente, al lado en el mockup, sigue con nombre, cédula y firma, y no se redibuja como cambio.

---

## Estados (4) + copy

### Pestaña Viajes

| Estado | Qué se ve |
|---|---|
| Cargando | Esqueleto de 2 tarjetas. `role="status"` `aria-label="Cargando viajes…"`. |
| Error | `role="alert"`: «No se pudieron cargar las LT listas para viaje.» + **Reintentar**. 403: «No tiene permiso para registrar viajes.» sin Reintentar. Nunca el texto crudo. |
| Vacío | `FlitEmpty`: «No hay LT clasificadas listas para un viaje. Primero deben recogerse y clasificarse en el organismo.» Sin primaria. |
| Lleno | Tarjetas con los dos unitarios (o «falta el precio») y **Registrar viaje** si al menos un destino tiene precio. |

Los motivos no bloquean estos cuatro estados: se piden al abrir el modal con destino FLIT.

| Motivos en el modal | Qué se ve |
|---|---|
| Cargando | El select dice «Cargando motivos…» y, si hay LT a FLIT, confirmar sigue apagado. Cliente sí se puede confirmar. |
| Error | «No se pudieron cargar los motivos de llegada.» + **Reintentar**, junto al select. |
| Sin activos | «No hay motivos de llegada activos. Pídale a quien administra el catálogo que active uno.» Si tiene `logistica.motivos.gestionar`, secundario **Ir a Motivos de llegada** (cambia a esa pestaña; no abre el alta). |
| Con activos | El select, en el orden del GET. |

### Llegada

La lista de Mi ruta y la de Actas conservan sus cuatro estados. El paso de llegada es el lleno de esa visita. Si falta la firma al confirmar: «Falta la firma de quien recibe en FLIT.» junto al lienzo. No hay estado vacío propio: sin la función, la acción no está.

---

## Acciones

**Confirmar viaje** (`logistica.traslado.registrar`). Apagado si falta el precio de algún destino elegido, si hay LT a FLIT sin motivo, o si los motivos de ese destino aún no cargaron. Busy: «Registrando…», el modal no cierra.

Un destino → un POST `/flito/logistica/traslados` + `Idempotency-Key`.

- FLIT: `{ companiaId, destino: 'flit', motivoLlegadaId, lts: [{ documentoId, nota? }] }`. La nota solo si escribieron algo; la misma en cada LT de ese viaje. Sin `origen`, sin `mensajeroId`.
- Cliente: `{ companiaId, destino: 'cliente', lts: [{ documentoId }] }`. Sin `origen` (viaje directo de LT clasificada).

Los dos destinos → **dos POST seguidos**, no un endpoint de reparto. Primero FLIT, luego cliente. Cada uno con su llave. Si FLIT no pasa, no se envía el de cliente. Si FLIT quedó y cliente no, el modal no se cierra: «El viaje a FLIT quedó registrado. El viaje a cliente no. Las LT de cliente siguen aquí.» Reintento solo del que falló, con la misma llave. Toast **solo** cuando los dos quedaron: «Quedaron dos viajes de Transportes Andes: 3 LT a FLIT y 5 al cliente.» Un solo destino: «Viaje a FLIT de Transportes Andes registrado (8 LT).» o «Viaje a cliente de Transportes Andes registrado (8 LT).» y se cierra.

Errores de escritura en el modal (`role="alert"`), no toast:

| Caso | Copy |
|---|---|
| Sin precio (`PRECIO_TRASLADO_NO_CONFIGURADO`) | «La compañía {nombre} no tiene precio de entrega a FLIT.» o «…a cliente.» + **Ir a Tarifas** si tiene la página. |
| Sin motivo (`MOTIVO_LLEGADA_REQUERIDO`) | «Elija el motivo de llegada.» |
| Proveedor | «Esta compañía no tiene proveedor de logística. Asígnele uno antes de registrar el viaje.» |
| Autogestionada | «La logística de esta compañía la gestiona el cliente.» |
| LT ya no lista | «Alguna LT de este grupo ya no está lista. Cierre y recargue la lista.» |
| LT ajena | «Solo puede registrar el viaje de las LT que recogió usted.» |
| Grupo incoherente | «Este grupo no se puede registrar junto. Recargue la lista.» |
| Red o 5xx | «No se pudo registrar el viaje. Las LT siguen aquí; vuelva a intentarlo.» |

**Confirmar llegada** (`logistica.actas.firmar_flit`). POST `/flito/logistica/traslados/:id/entregar` con `{ firma, lat?, lng? }` y `Idempotency-Key`. El `:id` es el uuid del viaje. No se envían `receptorNombre`, `receptorDocumento`, `firmante` ni foto. La ubicación se pide al confirmar y no se pinta. Toast: «Llegada a FLIT registrada.»

| Caso | Copy |
|---|---|
| Sin firma | «Falta la firma de quien recibe en FLIT.» |
| 422 de identidad | «La llegada a FLIT no lleva cédula ni nombre.» |
| 403 | «Esta llegada no es suya.» |
| Estado | «Este viaje ya no está en ruta. Vuelva y recargue.» |
| Red | «No se pudo registrar la llegada. La firma sigue aquí; vuelva a intentarlo.» |

---

## Responsive + feedback del delta

- **&lt;`lg`:** pestañas con `flex-wrap`; tarjeta en una columna; la línea de precios parte en dos si no cabe; primaria a ancho completo, sin `min-w`. Modal a viewport, lista con scroll, pastillas de cada LT bajo la placa. Llegada: panel de una columna, `FirmaCanvas` a ancho completo, primaria al pie.
- Hover `--flit-bg-hover` y `flit-focus` en pastilla, select, nota, «+ N más», ✕, atrás, Reintentar y botones. Disabled distinguible. Tokens `--flit-*` en claro y oscuro; peligro con `--flit-danger-ink`.
- Toast de éxito ~4 s, cerrable, una frase. Error de formulario en la superficie, no toast.

---

## Permiso

- Pestaña **Viajes:** `hasFuncion('logistica.traslado.registrar')`. Sin ella no se pinta. Slug `flito_logistica`.
- **Firmar llegada:** solo `hasFuncion('logistica.actas.firmar_flit')`. No usar `logistica.lote.cerrar` ni el rol.
- Entrega a cliente: `logistica.actas.entregar`. Quien solo tiene esa función no ve la llegada a FLIT; en Mi ruta ese viaje no se lista como entrega (si no, el único botón volvería a pedir cédula).
- **Ir a Tarifas:** `hasPage('flito_tarifas')`. **Ir a Motivos de llegada:** `logistica.motivos.gestionar`.

---

## Datos (endpoints que ya existen)

| Uso | Llamada | Cuerpo |
|---|---|---|
| Registrar | `POST /flito/logistica/traslados` | Ver acciones. Respuesta ya trae `id` y `lts[].precio`. |
| Llegada | `POST /flito/logistica/traslados/:id/entregar` | `{ firma, lat?, lng? }` |
| Motivos | `GET /flito/logistica/motivos-llegada?soloActivos=true` | Se pintan `id` (valor, no texto) y `nombre`. |

**Requerimiento 1.** `GET /flito/logistica/facetas` → cada ítem de `companiasCerrables` debe traer `precioEntregaFlit: number | null` junto al `precioEntregaCliente` que ya trae. Mismo GET. No se lee Tarifas. `null` no es `$0`.

**Requerimiento 2.** Ese GET de motivos hoy exige `logistica.motivos.gestionar` en todos los verbos. Quien registra el viaje tiene que poder leer **solo los activos** con `logistica.traslado.registrar`, en la misma ruta y el mismo query. No es un GET nuevo ni la pestaña de administración (esa sigue pidiendo el catálogo completo).

**Requerimiento 3.** Para no pedir cédula y para armar el path, hace falta el destino y el id del viaje en lecturas que ya existen, sin cédula en el DTO:

- `GET /flito/logistica/mi-ruta` → cada entrega: `destino: 'cliente' | 'flit'` y `trasladoId`.
- `GET /flito/logistica/actas` → cada fila: `punto` y `trasladoId`. El detalle ya trae `punto`; le falta `trasladoId`.

Sin esos tres datos el frontend no cumple AC1, AC2 ni AC4. No se inventa otra ruta.

---

## Notas para QA

1. Al pasar el grupo de Cliente a FLIT, el unitario y el total cambian antes de confirmar; `$0` solo si el precio guardado es cero.
2. Con destino FLIT y el select vacío, Confirmar está apagado y se lee «Elija el motivo de llegada.» La nota puede ir vacía y entonces no viaja en el body.
3. 3 LT a FLIT y 5 a cliente de la misma compañía → dos POST, dos `Idempotency-Key`, sin `origen`. Si el segundo falla, el primero no se repite.
4. La llegada a FLIT no muestra cédula, nombre ni foto, y el body no lleva `receptorNombre`, `receptorDocumento` ni `firmante`.
5. Sin `logistica.actas.firmar_flit` no existe el botón, ni en Mi ruta ni en Actas. La entrega a cliente sigue pidiendo nombre, cédula y firma.
6. Los cuatro estados de la pestaña, Reintentar, y 360 px sin desborde de página, en claro y oscuro.
7. Sin precio de FLIT se puede registrar el viaje a cliente; no al revés si se eligió FLIT. El enlace a Tarifas solo con `flito_tarifas`.
8. La pestaña Motivos de llegada no se abre sola al registrar; el select no lista inactivos.
9. Doble clic reutiliza la llave de ese POST.

---

## Decisiones y descartes

- **Una pestaña, relabelada.** «Viajes a cliente» mentiría al elegir FLIT. No hay segunda pestaña ni slug.
- **Pastillas en el modal, no dos primarias en la tarjeta.** El precio unitario de los dos destinos sí queda en la tarjeta: es lo que decide si se abre.
- **Dos POST.** El contrato no trae un splitter. Una primaria dispara los dos cuando el grupo está repartido.
- **Sin `origen`.** Esta lista es LT clasificada. La salida de FLIT hacia el cliente es otro momento y no se diseña aquí.
- **Un motivo y una nota por viaje a FLIT.** El motivo va en la raíz; la nota, en cada LT de ese POST. No se satura la fila.
- **La llegada reutiliza el lienzo, no el formulario de identidad.** El reparto parcial (`ltsDevueltas`) existe en el API y no se pinta: esta visita firma el viaje entero.
- **La acción de llegar no se cuelga del despacho.** «Firmar y despachar» sigue asignando mensajero. La llegada es después, con otra función.
- Copy de esta pestaña y de la llegada en usted, para no mezclar con los controles nuevos. El paso a cliente se deja como está.

---

## Brief de mockup

El hilo publica un Artifact `design` con el design system del kit FLITO. Vistas navegables, claro y oscuro, escritorio y 390 px. Sin «ok» no hay frontend.

**Vistas**

1. Pestaña Viajes — cargando (2 tarjetas), error + Reintentar, vacío, lleno (Andes con los dos precios y primaria; Valle con «FLIT: falta el precio»).
2. Modal Cliente — todas las LT en Cliente, unitario y total, Confirmar viaje.
3. Modal FLIT sin motivo — confirmar apagado, «Elija el motivo de llegada.», nota vacía.
4. Modal repartido — 3 a FLIT y 5 a cliente, motivo elegido, las dos frases de precio, una primaria.
5. Llegada a FLIT — sin cédula ni nombre, lienzo, «Su nombre queda el de esta sesión.», Confirmar llegada. Al lado, una miniatura del paso a cliente **sin cambios** (nombre, cédula, firma) para ver la diferencia.
6. Cada vista de consola también &lt;`lg`; la llegada en 390 px.

**Kit:** `PageHeaderCard` (sin cambio de título), pestañas de `FlitoLogistica`, tarjeta con borde `--flit-border-soft`, `FlitEmpty`, `FlitModal`, `FlitPillGroup` / `FlitPillButton`, `FlitField`, `flitInp`, `flitBtnPrimary` / `flitBtnSecondary`, `FirmaCanvas`, `ToastFlito`. Tokens `--flit-*`, `--flit-danger-ink`, `--flit-bg-hover`, `--flit-blue-text`. Sin HEX.

**Datos ficticios:** «Transportes Andes», «Rápido del Valle S.A.»; placas `QOX858`, `ABC123`, `DEF456`; LT `10038156339`; cliente `$12.000`; FLIT `$8.000`; motivos «Sin dirección de entrega al recoger» y «Destino lejano (transportadora externa)». Sin cédula, sin nombres de personas, sin teléfonos.

**No mostrar:** campo de cédula en la llegada, `origen`, mensajero en el registro, VIN, propietario, NIT, vigencia, uuid, pantalla de alta de motivos, «cerrar lote», geolocalización, foto en la llegada a FLIT.
