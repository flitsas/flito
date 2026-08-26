## Qué es

Bandeja de lo que quedó detenido en el camino a la DIAN, con qué hacer en cada caso. Aquí usted reintenta, da por perdido o registra una corrección. No hay columnas de costos ni el listado completo de trámites: para buscar **una** factura concreta vaya al **Reporte de costos**. No es **Facturar** en sentido FLITO (congelar la liquidación): la **emisión electrónica** se dispara desde el reporte; esta pantalla arregla lo que no salió.

## Para quién

Financiera y Administrador (reintentan, reenvían correo, dan por perdido, corrigen). Auditor (consulta: **Tu rol es de consulta: ves todo y no hay acciones disponibles.** Sin casillas ni botones de acción).

## Cómo se entra

En el menú lateral, sección **Finanzas**, ítem **Facturación electrónica · Operación**. Ruta `/siigo/operacion`. En la cabecera: **¿Buscas una factura concreta? Ve al reporte de costos**.

## Pasos

1. Si aparece **La integración con Siigo está frenada**, no se puede reintentar ni reenviar correo. El Administrador pulsa **Reactivar la integración con Siigo** (afecta a toda la facturación). No lo confunda con **Volver a intentarlo** de un caso dado por perdido.
2. Filtre por fuente (**Todas**, **No se pudo emitir**, **Rechazada por la DIAN**, **No le llegó al cliente**), antigüedad (**Toda**, **Más de 2 días**, **Más de 5 días**) y **Qué se muestra** (**Solo lo pendiente** / **Con los dados por perdidos**). **Limpiar los filtros**.
3. En **Casos detenidos**, pulse **Ver**. Según la fuente: **Reintentar la emisión** o **Reenviar el correo**; **Dar por perdido**; **Registrar una corrección** (un rechazo de la DIAN no se reintenta: emitiría un segundo documento); **Copiar enlace**.
4. Para varios casos: marque, pulse **Reintentar N casos**. **Quitar la selección** limpia las casillas.
5. Un caso dado por perdido se devuelve a la cola con **Volver a intentarlo**, no con «reactivar».

## Estados

- Cargando: **Buscando lo que quedó detenido…**
- Error: **No se pudo cargar la bandeja** y **Reintentar la búsqueda**. El error va antes que el vacío.
- Vacío: **No hay nada detenido. Buen día.** (sin filtros). Con filtro: **Ningún caso coincide con este filtro.** y **Quitar los filtros**.
- Lleno: resumen, filtros y tabla **Casos detenidos** (caso, cliente, fuente y estado, guía, antigüedad, **Ver**).

## Qué no hace

- No **Liquida** ni **Factura** (congelar liquidación): eso es **Reporte de costos**.
- No parametriza productos ni terceros: **Facturación electrónica · Parametrización**.
- No lista todos los trámites ni totales de costos. Un vacío con filtros no celebra: puede haber casos fuera del filtro.
- El Auditor observa; no opera. Levantar el freno lo hace un Administrador.
