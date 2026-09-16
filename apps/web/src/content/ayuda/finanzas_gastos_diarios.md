## Qué es

Cuánto se pagó cada día por SOAT, impuestos, derechos, logística y servicios adicionales, y cuánto suma el periodo con el GMF estimado. Es una pantalla de lectura: no liquida, no exporta y no abre trámites. Sirve para que usted cuadre caja o responda «¿cuánto salió esta semana?» sin reconstruirlo desde el **Reporte de costos**.

## Para quién

Administrador y, cuando se le concede la página desde **Roles y permisos**, Financiera y Auditor. Todos ven lo mismo: no hay acciones.

## Cómo se entra

En el menú lateral, sección **Finanzas**, ítem **Gastos diarios**, justo después de **Reporte de costos**.

## Pasos

1. Al entrar, la pantalla muestra los **últimos 30 días** (hoy incluido) para **Todas las empresas**. La línea sobre las tarjetas dice el rango cubierto y la empresa.
2. Lea las cinco tarjetas, siempre en este orden y con la cantidad y el valor en la misma línea (por ejemplo **12 · $ 3.450.000**). Qué cuenta cada una y qué día se toma:
   - **SOAT pagados**: pólizas pagadas, el día del pago del SOAT.
   - **Impuestos pagados**: recibos pagados, el día del pago del impuesto.
   - **Derechos pagados**: derechos de trámite con fecha de pago, ese día.
   - **Trámites con logística**: trámites que llevan logística, el día de aprobación del trámite, con la tarifa vigente ese día.
   - **Servicios asignados**: cada servicio adicional asignado a un trámite, el día en que se asignó, con su valor de entonces.
3. Lea el bloque **Total del periodo**: **Suma de categorías**, **GMF (4×1000) estimado** y **Total con GMF**. El GMF es un estimado calculado sobre la suma del periodo; el banco lo causa por movimiento, no por trámite, y el valor real está en el extracto. La liquidación lo calcula por trámite, así que puede diferir.
4. Filtre con **Empresa** (la misma lista del Reporte de costos) y **Periodo** (un solo calendario, con atajos de 7 y 30 días). Cambiar cualquiera de los dos vuelve a consultar. El periodo no puede superar 366 días ni terminar antes de empezar: si pasa, el aviso sale bajo el campo y no se consulta.
5. Use **Tipo de gasto** para ocultar tarjetas: desmarcar **Impuestos** esconde su tarjeta sin consultar de nuevo. El **Total del periodo** sigue sumando las cinco categorías y lo dice: **Incluye todas las categorías**. Con las cinco desmarcadas, **Ver los cinco** las devuelve.
6. **Limpiar filtros** vuelve a **Todas las empresas**, los últimos 30 días y las cinco categorías. Los filtros van en la dirección de la página: usted puede compartir el enlace y quien lo abra verá la misma vista.

De dónde sale el dato: de cada pago o evento, **no de la liquidación**. Por eso puede no coincidir con el **Reporte de costos**, que agrupa por fecha de aprobación del trámite y usa los valores sellados: si una liquidación corrigió un valor, aquí sigue el del pago.

## Estados

- Cargando: los filtros ya se pueden usar; en el lugar de las tarjetas y del total se ven cinco cuadros y una banda en gris.
- Error: **No se pudo cargar el gasto diario.** con el motivo debajo y **Reintentar**, que repite la misma consulta.
- Vacío: **Sin gastos entre … para …** con el rango y la empresa nombrados, y **Últimos 30 días** para volver al arranque. Si ya está en el arranque: **Sin gastos en los últimos 30 días. Cambia el rango o la empresa arriba.**
- Lleno: cinco tarjetas, la línea del rango, el bloque **Total del periodo** y, debajo, el espacio **Evolución diaria: próximamente**, reservado para la gráfica.
- Sin la página concedida: **No tienes acceso a Finanzas — Gastos diarios**.

## Qué no hace

- No muestra la serie por día ni una gráfica: ese espacio está reservado y llega en una entrega posterior.
- No lista trámites, placas ni comprobantes: solo días, cantidades y sumas.
- No exporta a Excel ni liquida: para eso está el **Reporte de costos**.
- No lee la liquidación: si un sellado corrigió un valor, aquí sigue el del pago.
- El GMF no es el del extracto bancario: es un estimado sobre la suma del periodo.
