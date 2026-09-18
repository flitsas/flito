// La banda «Total del periodo» (HU #12624, AC4): tres líneas en un `<dl>` y, al lado, por qué el
// GMF es un estimado. Los tres valores son los del API y suman las CINCO categorías aunque el
// filtro de tipo de gasto oculte alguna; cuando eso pasa, lo dice (RN-08).

import { FlitCard } from '../../flit/flitPageKit';
import Monto from '../Monto';
import { ROTULOS_TOTAL, type TotalPeriodoDatos } from './tiposGastosDiarios';

const ID_TITULO = 'gastos-total-titulo';
const ID_NOTA_GMF = 'gastos-total-nota-gmf';

function Linea({ rotulo, valor, fuerte, describedBy, title }: {
  rotulo: string; valor: string; fuerte?: boolean; describedBy?: string; title?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={fuerte ? 'text-sm font-semibold' : 'text-sm'} aria-describedby={describedBy} title={title}
        style={{ color: fuerte ? 'var(--flit-text-primary)' : 'var(--flit-text-secondary)' }}>
        {rotulo}
      </dt>
      <dd className={`tabular-nums ${fuerte ? 'text-xl font-bold' : 'text-sm'}`} style={{ color: 'var(--flit-text-primary)' }}>
        <Monto v={Number(valor)} />
      </dd>
    </div>
  );
}

export default function TotalPeriodo({ datos }: { datos: TotalPeriodoDatos }) {
  return (
    <section aria-labelledby={ID_TITULO}>
      <FlitCard>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="max-w-md">
            <h2 id={ID_TITULO} className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--flit-text-muted)' }}>
              Total del periodo
            </h2>
            <dl className="mt-2 space-y-1">
              <Linea rotulo={ROTULOS_TOTAL.suma} valor={datos.suma} />
              <Linea rotulo={ROTULOS_TOTAL.gmf} valor={datos.gmf} describedBy={ID_NOTA_GMF} title={ROTULOS_TOTAL.notaGmf} />
              <Linea rotulo={ROTULOS_TOTAL.total} valor={datos.total} fuerte />
            </dl>
            {datos.hayOcultas && (
              <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{ROTULOS_TOTAL.incluyeTodas}</p>
            )}
          </div>
          <p id={ID_NOTA_GMF} className="text-xs md:self-center" style={{ color: 'var(--flit-text-secondary)' }}>
            El GMF es un estimado. {ROTULOS_TOTAL.notaGmf} El banco lo causa por movimiento, no por trámite; puede diferir.
          </p>
        </div>
      </FlitCard>
    </section>
  );
}
