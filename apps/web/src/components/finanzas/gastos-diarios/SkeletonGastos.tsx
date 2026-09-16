// El estado de carga de Gastos diarios: cinco tarjetas y la banda de total con barras, en las
// mismas medidas que lo real para que los datos no salten al llegar (AC6). El skeleton no es
// contenido: una sola región de estado lo anuncia.

import { FlitCard } from '../../flit/flitPageKit';
import { CATEGORIAS } from './tiposGastosDiarios';

const barra = 'rounded animate-pulse motion-reduce:animate-none';
const tono = { background: 'var(--flit-border-soft)' } as const;

export default function SkeletonGastos() {
  return (
    <div role="status" aria-busy="true" aria-label="Cargando gastos diarios" className="space-y-4">
      <div className={`${barra} h-4 w-72`} style={tono} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {CATEGORIAS.map((c) => (
          <FlitCard key={c.clave}>
            <div className={`${barra} h-3 w-16`} style={tono} />
            <div className={`${barra} mt-2 h-8 w-32`} style={tono} />
            <div className={`${barra} mt-2 h-3 w-24`} style={tono} />
          </FlitCard>
        ))}
      </div>
      <FlitCard>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <div className={`${barra} h-3 w-28`} style={tono} />
            <div className={`${barra} h-4 w-full`} style={tono} />
            <div className={`${barra} h-4 w-full`} style={tono} />
            <div className={`${barra} h-6 w-full`} style={tono} />
          </div>
          <div className={`${barra} h-12 w-full md:self-center`} style={tono} />
        </div>
      </FlitCard>
    </div>
  );
}
