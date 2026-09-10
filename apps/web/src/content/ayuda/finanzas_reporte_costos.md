## Qué es

Costos reales por trámite para contabilidad y cobros. Las filas **Liquidadas** muestran valores sellados; el resto, un **Estimado** con las tarifas vigentes. Desde aquí usted **Liquida** (sella), **Factura** en sentido FLITO (congela la liquidación ya sellada) y puede **Enviar a facturación** (emisión electrónica hacia Siigo/DIAN). Son tres verbos distintos: no los mezcle. La vista **Consolidado** pliega el mismo reporte por cliente y periodo para cerrar el mes.

## Para quién

Financiera y Administrador (liquidan, facturan y envían a emisión). Auditor (solo lectura: ve la tabla con sus tres secciones, el titular, la **OT**, el selector de **Periodo**, el **Consolidado**, los contadores y el detalle de **Factura DIAN**, y puede exportar; no hay casillas ni **Liquidar** / **Facturar** / **Enviar a facturación**).

## Cómo se entra

En el menú lateral, sección **Finanzas**, ítem **Reporte de costos**. Ruta `/finanzas/reporte-costos`. También desde **Facturación electrónica · Operación**, con el enlace **¿Buscas una factura concreta? Ve al reporte de costos**.

## Pasos

1. Al entrar, el reporte ya viene acotado a **Aprobado** y al mes en curso. Filtre por etapa: **Todos**, **Listos para liquidar**, **Incompletos**, **Por facturar** o **Facturados**. Opcional: **Solo con soportes completos**, búsqueda, empresa, tipo, **Estado** y **OT** (organismo de tránsito, por su nombre). **Limpiar filtros** vuelve a **Aprobado** y al mes en curso.
2. Elija el **Periodo**: **Mes** o **Trimestre**, con su año y su índice. Elegirlo rellena el rango de **Aprobación**. Si edita el rango de **Aprobación** a mano, el selector dice **Personalizado** y no lo sobrescribe hasta que vuelva a elegir un mes o un trimestre. **Creación** es un rango aparte.
3. Lea la tabla en tres secciones: **Identificación** (empresa, **Flit**, placa, VIN y el titular con su **Tipo** y **Documento**), **Datos del trámite** (tipo, marca, línea, **OT**, estado, fechas, **Mes**, **Trimestre** y **Factura DIAN**) y **Valores**. **Compactar** / **Mostrar todas** oculta o enseña las columnas de una sección y se recuerda en este navegador. Un concepto vacío se nombra: **No configurado**, **Sin recibo**, **Sin pagar**, **Autogestiona** o **No aplica**; nunca se pinta $0.
4. En **Valores**, **Total reintegro** suma SOAT, impuesto, **Trámite** (derecho de tránsito), GMF y logística; **Servicio** es el trámite digital. Los dos vienen calculados del servidor, también en el pie de totales. Lea los contadores de **Facturación electrónica** (pastillas por estado).
5. Para sellar: marque filas o pulse **Liquidar**. El lote dice cuántos **se pueden liquidar**. Un estimado bloqueado muestra **Falta:** al lado del botón. Con estado **Liquidado**, pulse **Facturar** (congela; no emite ante la DIAN). Con estado **Facturado**, use **Envío a facturación electrónica** o **Enviar a facturación** en la fila; si no aplica, **¿Por qué no?**. **Soporte** abre los documentos. El Administrador puede **Reversar** un liquidado (no un facturado).
6. Conmute entre **Detalle** y **Consolidado** en la cabecera. El **Consolidado** agrupa por cliente y periodo (el tipo del selector) con los mismos filtros, y marca en **Incompletos** cuántos trámites de cada grupo tienen conceptos sin resolver.
7. Exporte: en **Detalle**, **Exportar CSV** descarga el filtro con todas las columnas; en **Consolidado**, **Exportar consolidado** descarga el agrupado. Los dos respetan los filtros y el periodo puestos.

## Estados

- Cargando: filtros visibles; los contadores dicen **Consultando el estado de la facturación electrónica…**; la tarjeta de envío, **Comprobando cuáles se pueden facturar…**. En **Consolidado**, **Calculando el consolidado…**.
- Error: mensaje en rojo sobre la tarjeta. Los contadores: **No se pudo consultar el estado de la facturación** con **Reintentar**. En **Consolidado**: **No se pudo calcular el consolidado** con **Reintentar**.
- Vacío: **No hay trámites que coincidan con los filtros.** En **Consolidado** además ofrece **Limpiar filtros**. Contadores: ningún trámite del filtro se ha enviado todavía a facturación electrónica. El filtro **OT** sin organismos dice **Sin organismos que ofrecer**.
- Lleno: tabla en tres secciones con **Liquidación** (**Estimado** / **Liquidado** / **Facturado**), conceptos, **Total reintegro**, **Servicio**, **Factura DIAN** y acciones. Un total incompleto ofrece **Ver cuáles**. En **Consolidado**, una fila por cliente y periodo con su pie de totales; un periodo sin fecha de aprobación se rotula **Sin aprobar**.

## Qué no hace

- **Facturar** no es emitir ante la DIAN: solo congela la liquidación. La **emisión electrónica** es **Enviar a facturación**.
- El **Total reintegro** de FLITO incluye la **logística** y por eso no coincide con el **Total Reintegro** del Excel manual, que la dejaba fuera.
- Los trámites viejos pueden salir sin **OT** o sin titular (nombres, apellidos, razón social o documento vacíos): FLIT no los traía. Un trámite sin **OT** queda fuera cuando se filtra por organismo.
- No calcula nada en el navegador: reintegro, servicio, mes, trimestre y el consolidado vienen del servidor.
- No carga boletas del portal: el chip de SOAT conciliado enlaza la boleta; el Excel se carga en **Conciliación**.
- No parametriza productos ni terceros de Siigo: eso es **Facturación electrónica · Parametrización**.
- No es la bandeja de casos detenidos: eso es **Facturación electrónica · Operación**.
- El Auditor observa; no liquida, no factura ni envía.
