---
resumen: Catálogos, mapeo de conceptos y emisión.
palabras_clave:
  - facturación electrónica
  - Siigo
  - parametrización
  - mapeo de conceptos
consultas:
  - cómo mapeo un concepto en Siigo
  - cómo configuro la emisión de facturas
version: 1.1
fecha: 2026-10-21
---
## Qué es

Parametrización de la **emisión electrónica** con Siigo: a qué producto corresponde cada concepto de la liquidación, y revisión de terceros. Encabeza la pregunta de si se puede emitir en producción. Usted no **Factura** trámites aquí (eso congela la liquidación en **Reporte de costos**).

## Para quién

Financiera (consulta el mapeo; sincroniza terceros). Administrador (edita el mapeo, confirma ciudades, recalcula duplicados). Auditor (solo lectura: ve mapeo, terceros y compuerta; no edita ni sincroniza).

## Cómo se entra

En el menú lateral, sección **Finanzas**, ítem **Facturación electrónica · Parametrización**. Las pestañas **Mapeo de conceptos** y **Terceros** son secciones de la misma pantalla.

## Pasos

1. Elija **Ambiente** (**Pruebas** o **Producción**). Lea la compuerta: **La emisión en producción está bloqueada** (con motivos) o **La parametrización está completa: la emisión en producción está habilitada.** Si ve **Modo simulado**, nada llega a Siigo ni a la DIAN. ![Cabecera con el selector Ambiente en Pruebas y el aviso La emisión en producción está bloqueada con su motivo](./siigo_parametrizacion/01-compuerta.png)
2. En **Mapeo de conceptos**, tabla **Conceptos facturables**: cada concepto con su producto en Siigo, unidad, si es ingreso para terceros y su estado (**Sin mapear**, **Mapeado**, **Mapeado y confirmado**). Arriba a la derecha, cuántos están confirmados. El Administrador pulsa **Editar** en cualquier fila o **Crear producto** en una **Sin mapear**. Financiera ve la tabla; no tiene esos botones. ![Tabla Conceptos facturables con conceptos mapeados y confirmados, y GMF sin mapear con los botones Crear producto y Editar](./siigo_parametrizacion/02-mapeo-de-conceptos.png)
3. En **Editar**, elija el **Producto en Siigo** de la lista (o **Escribir el código a mano**), la **Unidad de medida** y si **Es un ingreso recibido para terceros**, y pulse **Guardar**. Si el cambio toca un campo que contabilidad ya firmó, la pantalla avisa antes de guardar que la confirmación se perderá. ![Ventana Editar Logística con el producto elegido, la unidad de medida y los botones Cancelar y Guardar](./siigo_parametrizacion/03-editar-concepto.png)
4. Pase a **Terceros**. **¿A cuántos se les puede facturar?** dice cuántos clientes pueden recibir factura electrónica. Use **Ver los N que no pueden todavía** o **Ver los N que se pueden sincronizar**; **Por dónde empezar** agrupa los pendientes por lo que les falta. ![Pestaña Terceros: tres clientes activos, dos pueden recibir factura y los botones para ver los pendientes y los sincronizables](./siigo_parametrizacion/04-terceros.png)
5. Corrija primero: en **Clientes que todavía no**, **Completar ficha**; en **Equivalencias de ciudad**, **Confirmar** cada municipio (solo Administrador). Después, en **Sincronizar terceros con Siigo**, marque los clientes de **Clientes listos para facturar** y pulse **Sincronizar N en** el ambiente que indica (Administrador y Financiera). Sincronizar antes de corregir produce fallidos evitables. ![Bloque Sincronizar terceros con Siigo con un cliente marcado y el botón Sincronizar 1 en pruebas](./siigo_parametrizacion/05-sincronizar-terceros.png)
6. El Auditor lee **Sincronizar escribe en Siigo: lo hacen administración y financiera** y no ve la acción.

El camino hasta poder emitir en producción, de un vistazo:

![Diagrama: mapear conceptos, corregir fichas, confirmar ciudades y sincronizar terceros; si la compuerta tiene motivos, la emisión en producción sigue bloqueada y se corrige el motivo; si no, queda habilitada](./siigo_parametrizacion/camino-a-produccion.svg)

## Estados

- Cargando: **Cargando la parametrización…**
- Error: aviso y **Reintentar**. Un fallo de la compuerta (**No se pudo consultar el estado de la emisión**) no tumba el mapeo.
- Vacío: **Todavía no hay conceptos en este ambiente.**
- Lleno: tabla de conceptos o bloques de terceros (resumen, no facturables, ciudades, sincronización). El modo simulado se señaliza de forma permanente.

## Qué no hace

- No **Factura** ni **Liquida** trámites, ni reintenta facturas detenidas: eso es **Reporte de costos** y **Facturación electrónica · Operación**.
- No guarda las credenciales de la integración con Siigo: eso se hace en la sección **Administración**, y solo lo ve el Administrador.
- No edita el tratamiento tributario: lo aplica Siigo desde el producto.
- Comprobante, vendedor, forma de pago y centro de costo se eligen en cada envío, no aquí.
