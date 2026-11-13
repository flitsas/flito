// El estado de carga de Gastos diarios: cinco tarjetas, la banda de total y el bloque de la
// gráfica (HU #12625) con barras, en las mismas medidas que lo real para que los datos no salten
// al llegar (AC6). El skeleton no es contenido: una sola región de estado lo anuncia.

import { FlitCard } from '../../flit/flitPageKit';
import { ALTO_SVG } from './geometriaGrafica';
import { CATEGORIAS } from './tiposGastosDiarios';

/** Esqueleto del kit (`.kit-esqueleto`): mismo brillo y reduced-motion en toda la app. */
const barra = 'kit-esqueleto';

export default function SkeletonGastos() {
  return (
    <div role="status" aria-busy="true" aria-label="Cargando gastos diarios" className="space-y-4">
      <div className={`${barra} h-4 w-72`} />
      <div className="metricas !mb-0">
        {CATEGORIAS.map((c) => (
          <div key={c.clave} className="metrica cursor-default">
            <div className={`${barra} h-3 w-16`} />
            <div className={`${barra} mt-2 h-8 w-32`} />
            <div className={`${barra} mt-2 h-3 w-24`} />
          </div>
        ))}
      </div>
      <FlitCard>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <div className={`${barra} h-3 w-28`} />
            <div className={`${barra} h-4 w-full`} />
            <div className={`${barra} h-4 w-full`} />
            <div className={`${barra} h-6 w-full`} />
          </div>
          <div className={`${barra} h-12 w-full md:self-center`} />
        </div>
      </FlitCard>
      {/* La gráfica: título + leyenda, el svg de su alto final, el detalle y el botón de la tabla. */}
      <FlitCard>
        <div className="flex items-center justify-between">
          <div className={`${barra} h-3 w-24`} />
          <div className={`${barra} h-9 w-[28rem]`} />
        </div>
        <div className={`${barra} mt-2 w-full`} style={{ height: ALTO_SVG }} />
        <div className={`${barra} mt-2 h-12 w-full`} />
        <div className={`${barra} mt-3 h-9 w-32`} />
      </FlitCard>
    </div>
  );
}
