---
resumen: Bandeja de facturas y acciones del día a día.
palabras_clave:
  - facturación electrónica
  - Siigo
  - bandeja de facturas
  - facturas
consultas:
  - cómo emito una factura
  - por qué falló una factura en Siigo
version: 1.2
fecha: 2026-10-21
---
## Qué es

Bandeja de lo que quedó detenido en el camino a la DIAN, con qué hacer en cada caso. Aquí usted reintenta, da por perdido o registra una corrección. No hay columnas de costos ni el listado completo de trámites: para buscar **una** factura concreta vaya al **Reporte de costos**. No es **Facturar** en sentido FLITO (congelar la liquidación): la **emisión electrónica** se dispara desde el reporte; esta pantalla arregla lo que no salió.

## Para quién

Financiera y Administrador (reintentan, reenvían correo, dan por perdido, corrigen). Auditor (consulta: **Tu rol es de consulta: ves todo y no hay acciones disponibles.** Sin casillas ni botones de acción).

## Cómo se entra

En el menú lateral, sección **Finanzas**, ítem **Facturación electrónica · Operación**. En la cabecera: **¿Buscas una factura concreta? Ve al reporte de costos**.

## Pasos

1. Si aparece **La integración con Siigo está frenada**, no se puede reintentar ni reenviar correo. El Administrador pulsa **Reactivar la integración con Siigo** (afecta a toda la facturación). No lo confunda con **Volver a intentarlo** de un caso dado por perdido.
2. Lea el resumen (**Detenido en total** y uno por fuente) y, debajo, quién lo resuelve. Filtre por fuente (**Todas**, **No se pudo emitir**, **Rechazada por la DIAN**, **No le llegó al cliente**), antigüedad (**Toda**, **Más de 2 días**, **Más de 5 días**) y **Qué se muestra** (**Solo lo pendiente** / **Con los dados por perdidos**). En **Motivo** elija un motivo concreto o **Todos los motivos**; cada opción trae entre paréntesis cuántos casos le corresponden, y se agrupa por el código del error, no por la frase. En **Cliente**, **Todos los clientes** o uno de los que tienen casos en esta página. **Limpiar los filtros**. ![Resumen de casos detenidos por fuente, filtros de fuente, antigüedad, qué se muestra, motivo y cliente, y el inicio de la tabla Casos detenidos](./siigo_operacion/01-bandeja.png)
3. En **Casos detenidos**, pulse **Ver**. Verá qué pasó y qué hacer, el responsable y la línea de tiempo del trámite. Según la fuente: **Reintentar la emisión** o **Reenviar el correo**; **Dar por perdido**; **Registrar una corrección** (un rechazo de la DIAN no se reintenta: emitiría un segundo documento); **Copiar enlace**. ![Detalle de un caso que no se pudo emitir: qué pasó y qué hacer, los botones Reintentar la emisión, Dar por perdido, Registrar una corrección y Copiar enlace, y la línea de tiempo](./siigo_operacion/02-ver-caso.png)
4. Para varios casos: marque sus casillas y pulse **Reintentar N casos**. **Quitar la selección** limpia las casillas. Un rechazo de la DIAN no tiene casilla: dice **No se arregla reintentando**. ![Dos casos marcados, el contador 2 seleccionados y los botones Quitar la selección y Reintentar 2 casos; el caso rechazado por la DIAN no se puede marcar](./siigo_operacion/03-reintentar-varios.png)
5. Un caso dado por perdido se devuelve a la cola con **Volver a intentarlo**, no con «reactivar».

El camino de un caso detenido, de un vistazo:

![Diagrama: un caso detenido se reintenta, se corrige o se da por perdido; un caso dado por perdido vuelve a la cola con Volver a intentarlo](./siigo_operacion/camino-caso-detenido.svg)

## Estados

- Cargando: **Buscando lo que quedó detenido…**
- Error: **No se pudo cargar la bandeja** y **Reintentar la búsqueda**. El error va antes que el vacío.
- Error solo del filtro: **No se pudo cargar el catálogo de motivos.** El selector **Motivo** queda inhabilitado y ofrece **Volver a cargar los motivos**; la tabla y los demás filtros siguen funcionando.
- Vacío: **No hay nada detenido. Buen día.** (sin filtros). Con filtro: **Ningún caso coincide con este filtro.** y **Quitar los filtros**.
- Lleno: resumen, filtros y tabla **Casos detenidos** (caso, cliente, fuente y estado, qué pasó y qué hacer, tiempo detenido, **Ver**).

## Qué no hace

- No **Liquida** ni **Factura** (congelar liquidación): eso es **Reporte de costos**.
- No parametriza productos ni terceros: **Facturación electrónica · Parametrización**.
- No lista todos los trámites ni totales de costos. Un vacío con filtros no celebra: puede haber casos fuera del filtro.
- El Auditor observa; no opera. Levantar el freno lo hace un Administrador.
