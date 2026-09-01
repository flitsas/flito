## Qué es

Costos reales por trámite para contabilidad y cobros. Las filas **Liquidadas** muestran valores sellados; el resto, un **Estimado** con las tarifas vigentes. Desde aquí usted **Liquida** (sella), **Factura** en sentido FLITO (congela la liquidación ya sellada) y puede **Enviar a facturación** (emisión electrónica hacia Siigo/DIAN). Son tres verbos distintos: no los mezcle.

## Para quién

Financiera y Administrador (liquidan, facturan y envían a emisión). Auditor (solo lectura: ve la tabla, los contadores y el detalle de **Factura DIAN**; no hay casillas ni **Liquidar** / **Facturar** / **Enviar a facturación**).

## Cómo se entra

En el menú lateral, sección **Finanzas**, ítem **Reporte de costos**. Ruta `/finanzas/reporte-costos`. También desde **Facturación electrónica · Operación**, con el enlace **¿Buscas una factura concreta? Ve al reporte de costos**.

## Pasos

1. Filtre por etapa: **Todos**, **Listos para liquidar**, **Incompletos**, **Por facturar** o **Facturados**. Opcional: **Solo con soportes completos**, búsqueda, empresa, tipo, **Estado**, **Creación** y **Aprobación**. **Limpiar filtros** vuelve a **Aprobado**.
2. Lea los contadores de **Facturación electrónica** (pastillas por estado: **Sin enviar**, **En cola**, **Emitida**, **Aceptada por la DIAN**, etc.). Un concepto vacío se nombra: **No configurado**, **Sin recibo**, **Sin pagar**, **Autogestiona** o **No aplica**.
3. Para sellar: marque filas o pulse **Liquidar**. El lote dice cuántos **se pueden liquidar**. Un estimado bloqueado muestra **Falta:** al lado del botón.
4. Con estado **Liquidado**, pulse **Facturar**: marca el trámite como facturado en FLITO (congela). Eso no emite ante la DIAN.
5. Con estado **Facturado**, use **Envío a facturación electrónica** o **Enviar a facturación** en la fila. Si no aplica, **¿Por qué no?**. **Soporte** abre los documentos. **Exportar CSV** descarga el filtro. El Administrador puede **Reversar** un liquidado (no un facturado).

## Estados

- Cargando: filtros visibles; los contadores dicen **Consultando el estado de la facturación electrónica…**; la tarjeta de envío, **Comprobando cuáles se pueden facturar…**.
- Error: mensaje en rojo sobre la tarjeta. Los contadores: **No se pudo consultar el estado de la facturación** con **Reintentar**.
- Vacío: **No hay trámites que coincidan con los filtros.** Contadores: ningún trámite del filtro se ha enviado todavía a facturación electrónica.
- Lleno: tabla con **Liquidación** (**Estimado** / **Liquidado** / **Facturado**), conceptos, **Factura DIAN** y acciones. Un total incompleto ofrece **Ver cuáles**.

## Qué no hace

- **Facturar** no es emitir ante la DIAN: solo congela la liquidación. La **emisión electrónica** es **Enviar a facturación**.
- No carga boletas del portal: el chip de SOAT conciliado enlaza la boleta; el Excel se carga en **Conciliación**.
- No parametriza productos ni terceros de Siigo: eso es **Facturación electrónica · Parametrización**.
- No es la bandeja de casos detenidos: eso es **Facturación electrónica · Operación**.
- El Auditor observa; no liquida, no factura ni envía.
