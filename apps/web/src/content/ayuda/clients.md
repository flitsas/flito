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
4. Pulse **Tarifas** para **Nueva tarifa** o **Editar**. Pulse **Datos fiscales** para los datos de **emisión electrónica**. El chip **Lista**, **Por clasificar** o **Faltan N** resume si la compañía puede emitirse después.
5. En **Proveedores**, **Nuevo proveedor** (o **Editar**): nombre, estrategia, umbral OCR, ANS pactado y **Activo**. **Guardar**.

## Estados

- Cargando: **Cargando…** en tarifas o en el listado de proveedores.
- Error: aviso al fallar el guardado (el listado de compañías no se cae si falla el informe de facturación).
- Vacío: **No hay clientes.** / **No hay proveedores SOAT.**
- Lleno: tabla **Empresa**, documento, ciudad, autogestión, **Facturación** y acciones.

## Qué no hace

- No despacha trámites, SOAT ni impuestos: solo parametriza la compañía y el proveedor.
- No **Factura** la liquidación de un trámite. **Lista** habla de **emisión electrónica**, no de Facturar.
- No es el catálogo de NIT vigilados de **Comparendos** (puede coincidir el NIT, pero es otro listado).
- Un Gestor de Impuestos o un Proveedor no administran compañías desde aquí.
