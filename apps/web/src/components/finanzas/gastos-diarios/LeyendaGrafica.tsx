// La leyenda de la gráfica de Gastos diarios (HU #12625, AC2): cinco pills con la muestra del
// patrón y el rótulo. Pulsar una es EXACTAMENTE marcar o desmarcar ese tipo de gasto en el filtro
// —el mismo `alternarTipo` del hook, el mismo `tipos` de la URL, sin petición—: un solo estado,
// dos controles. La categoría oculta queda como pill inactiva con la muestra atenuada.

import { FlitPillButton, FlitPillGroup } from '../../flit/flitPageKit';
import { colorSerie, idPatron } from './PatronesSerie';
import { CATEGORIAS, type GastosDiariosCategoria } from './tiposGastosDiarios';

export default function LeyendaGrafica({ tipos, onTipo }: {
  tipos: readonly GastosDiariosCategoria[];
  onTipo: (c: GastosDiariosCategoria) => void;
}) {
  return (
    <div role="group" aria-label="Leyenda" className="flex flex-wrap items-center gap-2">
      <FlitPillGroup>
        {CATEGORIAS.map((c) => {
          const visible = tipos.includes(c.clave);
          return (
            <FlitPillButton key={c.clave} active={visible} pressed={visible} onClick={() => onTipo(c.clave)}>
              <svg width={14} height={14} aria-hidden="true" focusable="false" style={{ opacity: visible ? 1 : 0.35 }}>
                <rect x={0.5} y={0.5} width={13} height={13} rx={2} fill={`url(#${idPatron(c.clave)})`}
                  stroke={colorSerie(c.serie.token)} strokeWidth={1} />
              </svg>
              <span className="normal-case">{c.titulo}</span>
            </FlitPillButton>
          );
        })}
      </FlitPillGroup>
    </div>
  );
}
