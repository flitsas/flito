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
4. Al final de las banderas, marque **SOAT sin trámite** para que los usuarios **Cliente** de esa compañía puedan pedirle un SOAT a FLITO sin que haya un trámite abierto. Es independiente de **SOAT**: marcar o desmarcar una no cambia la otra, y una compañía nueva nace con **SOAT sin trámite** desmarcado.
5. Pulse **Tarifas** para **Nueva tarifa** o **Editar**. Pulse **Datos fiscales** para los datos de **emisión electrónica**. El chip **Lista**, **Por clasificar** o **Faltan N** resume si la compañía puede emitirse después.
6. En **Proveedores**, **Nuevo proveedor** (o **Editar**): nombre, estrategia, umbral OCR, ANS pactado y **Activo**. **Guardar**.

## Estados

- Cargando: **Cargando compañías…** mientras llega el listado de clientes; **Cargando…** en tarifas o en el listado de proveedores.
- Error: si el listado de compañías no llega, mensaje en rojo con **Reintentar** sobre la tarjeta; además, aviso al fallar el guardado (el listado no se cae si falla el informe de facturación).
- Vacío: **No hay clientes.** / **No hay proveedores SOAT.**
- Lleno: tabla **Empresa**, documento, ciudad, autogestión, **SOAT sin trámite**, **Facturación** y acciones.

## Qué no hace

- No despacha trámites, SOAT ni impuestos: solo parametriza la compañía y el proveedor.
- No **Factura** la liquidación de un trámite. **Lista** habla de **emisión electrónica**, no de Facturar.
- No es el catálogo de NIT vigilados de **Comparendos** (puede coincidir el NIT, pero es otro listado).
- Un Gestor de Impuestos o un Proveedor no administran compañías desde aquí.
- **SOAT sin trámite** solo abre el canal: no crea la solicitud ni compra el SOAT. Eso lo hace el usuario **Cliente** desde la cola **SOAT**.
