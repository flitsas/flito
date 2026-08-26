## Qué es

Parametrización de la **emisión electrónica** con Siigo: a qué producto corresponde cada concepto de la liquidación, y revisión de terceros. Encabeza la pregunta de si se puede emitir en producción. Usted no **Factura** trámites aquí (eso congela la liquidación en **Reporte de costos**).

## Para quién

Financiera (consulta el mapeo; sincroniza terceros). Administrador (edita el mapeo, confirma ciudades, recalcula duplicados). Auditor (solo lectura: ve mapeo, terceros y compuerta; no edita ni sincroniza).

## Cómo se entra

En el menú lateral, sección **Finanzas**, ítem **Facturación electrónica · Parametrización**. Ruta `/siigo/parametrizacion`. Las pestañas **Mapeo de conceptos** y **Terceros** son secciones de la misma pantalla.

## Pasos

1. Elija **Ambiente** (**Pruebas** o **Producción**). Lea la compuerta: **La emisión en producción está bloqueada** (con motivos) o **La parametrización está completa: la emisión en producción está habilitada.** Si ve **Modo simulado**, nada llega a Siigo ni a la DIAN.
2. En **Mapeo de conceptos**, tabla **Conceptos facturables**. El Administrador pulsa **Editar** (**Guardar**) o **Crear producto**. Estados de fila: **Sin mapear**, **Mapeado**, **Mapeado y confirmado**. Financiera ve la tabla; no tiene esos botones.
3. Pase a **Terceros**. El resumen dice cuántos clientes pueden recibir factura. Use **Ver los N que no pueden todavía** o **Ver los N que se pueden sincronizar**.
4. Corrija fichas, **Confirmar** equivalencias de ciudad (solo Administrador) y después **Sincronizar terceros con Siigo** (Administrador y Financiera). Sincronizar antes de corregir produce fallidos evitables.
5. El Auditor lee **Sincronizar escribe en Siigo: lo hacen administración y financiera** y no ve la acción.

## Estados

- Cargando: **Cargando la parametrización…**
- Error: aviso y **Reintentar**. Un fallo de la compuerta (**No se pudo consultar el estado de la emisión**) no tumba el mapeo.
- Vacío: **Todavía no hay conceptos en este ambiente.**
- Lleno: tabla de conceptos o bloques de terceros (resumen, no facturables, ciudades, sincronización). El modo simulado se señaliza de forma permanente.

## Qué no hace

- No **Factura** ni **Liquida** trámites, ni reintenta facturas detenidas: eso es **Reporte de costos** y **Facturación electrónica · Operación**.
- No guarda las credenciales de la integración Siigo: ese capítulo es solo Administración y no tiene pantalla publicada en esta versión.
- No edita el tratamiento tributario: lo aplica Siigo desde el producto.
- Comprobante, vendedor, forma de pago y centro de costo se eligen en cada envío, no aquí.
