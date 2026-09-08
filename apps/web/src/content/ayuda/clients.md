## Qué es

Ficha de las compañías (clientes FLITO) con su autogestión y tarifas negociadas, y de los proveedores de SOAT a los que se enrutan los trámites. La columna **Facturación** indica si la compañía está lista para una **emisión electrónica** posterior; no es **Facturar** en sentido FLITO (congelar la liquidación). Usted parametriza; no despacha.

## Para quién

Administrador (crea compañías, marca autogestión, edita tarifas y proveedores). Financiera (en gestión solo ve esta pantalla, además de finanzas). Auditor (consulta). El Proveedor y el Gestor de Impuestos no entran aquí.

## Cómo se entra

En el menú lateral, sección **Gestión**, ítem **Clientes y proveedores**. Ruta `/clients`.

## Pasos

1. Elija **Clientes** o **Proveedores**.
2. En **Clientes**, pulse **Nuevo cliente**, complete **Nombre o razón social** y **Guardar** (o **Cancelar**).
3. En cada fila, marque autogestión **SOAT**, **Impuestos**, **Logística** y **Parcial** (entregas parciales). Eso decide qué gestiona FLITO y qué queda en autogestión de la compañía.
4. Al final de las banderas, la columna **SOAT sin trámite** dice si el canal de esa compañía está **Cerrado** o **Abierto** y, si lo está, a qué gestor salen sus solicitudes (**Abierto · SURA**). Púlselo para abrir el cuadro **SOAT sin trámite · {compañía}**: marque **Canal abierto** para que los usuarios **Cliente** de esa compañía puedan pedirle un SOAT a FLITO sin que haya un trámite abierto, elija el **Gestor por defecto** de la lista y pulse **Guardar**. Las dos cosas se guardan juntas y en el orden que usted quiera; si abre el canal sin elegir gestor, el cuadro se lo pide y no guarda nada. Es independiente de **SOAT**: marcar o desmarcar una no cambia la otra, y una compañía nueva nace con el canal **Cerrado**. **Financiera** y **Auditor** leen la columna pero no la cambian.
5. Pulse **Tarifas** para **Nueva tarifa** o **Editar**. Pulse **Datos fiscales** para los datos de **emisión electrónica**. El chip **Lista**, **Por clasificar** o **Faltan N** resume si la compañía puede emitirse después.
6. En **Proveedores**, **Nuevo proveedor** (o **Editar**): nombre, estrategia, umbral OCR, ANS pactado y **Activo**. **Guardar**.

## Estados

- Cargando: **Cargando compañías…** mientras llega el listado de clientes; **Cargando…** en tarifas o en el listado de proveedores.
- Error: si el listado de compañías no llega, mensaje en rojo con **Reintentar** sobre la tarjeta; además, aviso al fallar el guardado (el listado no se cae si falla el informe de facturación).
- Vacío: **No hay clientes.** / **No hay proveedores SOAT.**
- Lleno: tabla **Empresa**, documento, ciudad, autogestión, **SOAT sin trámite**, **Facturación** y acciones. Si el gestor por defecto de una compañía está desactivado, la columna lo dice: **Abierto · SURA (inactivo)**, y sus solicitudes nuevas quedan **Gestionado por Operaciones**.
- La columna también puede decir **Abierto · sin gestor**: el canal está abierto pero esa compañía no tiene **Gestor por defecto** configurado. Son compañías a las que se les abrió el canal antes de que elegir gestor fuera obligatorio. Mientras siga así, sus solicitudes nuevas quedan **Gestionado por Operaciones**, igual que si el gestor estuviera desactivado. Púlselo, elija el **Gestor por defecto** y **Guardar**.
- En el cuadro de **SOAT sin trámite**, la lista de gestores tiene sus propios estados: **Cargando gestores…**, **No se pudieron cargar los gestores.** con **Volver a cargar gestores**, y **No hay gestores de SOAT activos. Cree uno en la pestaña Proveedores antes de abrir el canal de esta compañía.**

## Qué no hace

- No despacha trámites, SOAT ni impuestos: solo parametriza la compañía y el proveedor.
- No **Factura** la liquidación de un trámite. **Lista** habla de **emisión electrónica**, no de Facturar.
- No es el catálogo de NIT vigilados de **Comparendos** (puede coincidir el NIT, pero es otro listado).
- Un Gestor de Impuestos o un Proveedor no administran compañías desde aquí.
- **SOAT sin trámite** solo abre el canal y dice a dónde salen sus solicitudes: no crea la solicitud ni compra el SOAT. Eso lo hace el usuario **Cliente** desde la cola **SOAT**.
- Cambiar el **Gestor por defecto** no reasigna nada de lo ya radicado: solo afecta a las solicitudes **nuevas** del canal. Las que ya están en la cola conservan el gestor que tienen.
- Cerrar el canal no borra el gestor configurado: se conserva por si vuelve a abrirlo.
