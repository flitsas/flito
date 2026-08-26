## Qué es

Cola FLITO de adquisición del SOAT. El SOAT se ancla al VIN y solo pasa a **Pagado** cuando usted carga una factura validada. Esta es la cola con rótulo **SOAT** en Gestión (`/flito/soat`). No es el módulo legado de pólizas.

## Para quién

Proveedor (ve **Solicitado** y **Pagado** de su cartera; nunca los **Pendiente**). Administrador (ve toda la cola, envía al gestor y puede asumir por contingencia). Auditor (solo lectura: **Solo lectura · Auditoría observa, no ejecuta acciones.**).

## Cómo se entra

En el menú lateral, sección **Gestión**, ítem **SOAT**. La ruta de esta cola es `/flito/soat`.

## Pasos

1. Filtre con las pastillas **Todos**, **Pendiente**, **Solicitado**, **Con novedad** o **Pagado**. El Proveedor no ve **Todos** ni **Pendiente**.
2. Busque placa, VIN o comprador. Use **Compañía**, **Organismo**, **Proveedor**, **Listos para enviar** o **Sin gestión**, y **Solo sin gestión** si hace falta.
3. Como Administrador, seleccione filas **Pendiente**, elija **Enviar a** (**Gestionado por Operaciones** o un proveedor) y pulse **Enviar al gestor** o **Enviar a Operaciones**.
4. En una fila, pulse **Ver**. En adquisición, **Cargar factura** (un archivo) o, desde el encabezado, **Cargar facturas (masivo)**.
5. Según el caso: **Rechazar**, **Reactivar**, **Reversar**, **Cambiar proveedor**, **Asumir en Operaciones** o **Devolver al proveedor**. **Ver soporte** abre el documento ya cargado.

## Estados

- Cargando: la tabla aún no aparece.
- Error: mensaje en rojo sobre la tarjeta.
- Vacío: **No hay SOAT en esta vista. Sincroniza desde el Tablero para traer trámites nuevos.** Con filtros: **Ningún SOAT coincide con los filtros.**
- Lleno: tabla **Pólizas SOAT** con compañía, quién gestiona, estado, solicitado, pagado y valor. Una fila asumida muestra el chip **Operaciones**.

## Qué no hace

- No despacha el trámite ni solicita el SOAT desde aquí: eso se origina en **Gestión Trámites**.
- No liquida, no **Factura** en sentido FLITO (congelar liquidación) ni hace **emisión electrónica**.
- No gestiona impuestos, derechos de tránsito ni comparendos.
- El Proveedor no ve ni envía los **Pendiente**; esa frontera la resuelve el Administrador.
