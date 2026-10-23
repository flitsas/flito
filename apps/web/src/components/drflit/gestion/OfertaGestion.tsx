import { flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondarySm } from '../../flit/flitPageKit';
import type {
  MensajeMarcadorGestion, MensajeOfertaGestion, TipoValorGestion,
} from '../../../lib/drFlitGestion';
import { BurbujaDrFlit } from '../DrFlitMensaje';

// Dr. Flit — oferta de consulta de gestión y marcador tras recargar (HU #13836 G1; UX F6.4 A/F,
// F6.9, F6.11). Nada se consulta hasta pulsar la primaria (AC1). Una sola oferta viva: al enviar
// otro mensaje pierde sus botones y queda «No consulté {valor}.».

const NOMBRE_TIPO: Record<TipoValorGestion, string> = {
  placa: 'la placa',
  vin: 'el VIN',
  idFlit: 'el id FLIT',
};

export interface OfertaGestionProps {
  mensaje: MensajeOfertaGestion;
  /** `valor` solo en la oferta de varios valores (HU #13858 IA-6 AC4). */
  onConsultar: (id: string, valor?: string) => void;
  onManuales: (id: string) => void;
}

export function OfertaGestion({ mensaje, onConsultar, onManuales }: OfertaGestionProps) {
  const { valor, estado } = mensaje;
  if (mensaje.varios) return <OfertaGestionVarios mensaje={mensaje} onConsultar={onConsultar} onManuales={onManuales} />;
  if (estado === 'ignorada') {
    return (
      <BurbujaDrFlit>
        <p className="break-words text-flit-secondary">No consulté {valor}.</p>
      </BurbujaDrFlit>
    );
  }
  return (
    <BurbujaDrFlit>
      <p className="break-words">
        Encontré {NOMBRE_TIPO[mensaje.tipoValor]} {valor}. ¿Quiere ver en qué va?
      </p>
      {estado === 'viva' && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/* El texto envuelve: la primaria no trunca ni desborda a 320 px (F6.12). */}
          <button
            type="button"
            onClick={() => onConsultar(mensaje.id)}
            className={`${flitBtnPrimary} h-auto min-h-10 max-w-full whitespace-normal py-2 text-left`}
            style={flitBtnPrimaryStyle}
          >
            Consultar {valor} en sus módulos
          </button>
          <button type="button" onClick={() => onManuales(mensaje.id)} className={flitBtnSecondarySm}>
            Buscar en los manuales
          </button>
        </div>
      )}
    </BurbujaDrFlit>
  );
}

const VARIOS_TIPO: Record<TipoValorGestion, { varios: string; resto: string }> = {
  placa: { varios: 'varias placas', resto: 'Escriba las demás en otro mensaje.' },
  vin: { varios: 'varios VIN', resto: 'Escriba los demás en otro mensaje.' },
  idFlit: { varios: 'varios id FLIT', resto: 'Escriba los demás en otro mensaje.' },
};

/** «Y» en español: «ABC123», «ABC123 ni XYZ789», «A, B ni C». */
function lista(valores: string[]): string {
  return valores.length < 2 ? valores.join('') : `${valores.slice(0, -1).join(', ')} ni ${valores[valores.length - 1]}`;
}

/**
 * HU #13858 (IA-6 AC4, spec IA): varios valores del mismo tipo y la IA no eligió uno. Un botón
 * secundario por valor (ninguno pesa más), nada se consulta sin clic; el pulsado desaparece y los
 * demás siguen vivos hasta el siguiente mensaje («No consulté …», regla de F6).
 */
function OfertaGestionVarios({ mensaje, onConsultar, onManuales }: OfertaGestionProps) {
  const varios = mensaje.varios!;
  const pendientes = varios.valores.filter((v) => !varios.consultados.includes(v));
  const textos = VARIOS_TIPO[mensaje.tipoValor];
  if (mensaje.estado === 'ignorada' && pendientes.length > 0) {
    return (
      <BurbujaDrFlit>
        <p className="break-words text-flit-secondary">No consulté {lista(pendientes)}.</p>
      </BurbujaDrFlit>
    );
  }
  return (
    <BurbujaDrFlit>
      <p className="break-words">Encontré {textos.varios} en su mensaje. ¿Cuál quiere consultar?</p>
      {mensaje.estado === 'viva' && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {pendientes.map((v) => (
            <button key={v} type="button" onClick={() => onConsultar(mensaje.id, v)} className={flitBtnSecondarySm}>
              Consultar {v}
            </button>
          ))}
          {/* Como en F6: tras la primera consulta la Ayuda ya no se ofrece en esta burbuja. */}
          {varios.consultados.length === 0 && (
            <button type="button" onClick={() => onManuales(mensaje.id)} className={flitBtnSecondarySm}>
              Buscar en los manuales
            </button>
          )}
        </div>
      )}
      {mensaje.estado === 'viva' && varios.mas && <p className="mt-2 text-xs text-flit-secondary">{textos.resto}</p>}
    </BurbujaDrFlit>
  );
}

/** Lo que queda de un turno con valor tras recargar: sin valor, sin módulos (AC8, F6.9). */
export function MarcadorGestion({ mensaje, onVolver }: { mensaje: MensajeMarcadorGestion; onVolver: () => void }) {
  if (!mensaje.consulta) {
    return (
      <BurbujaDrFlit>
        <p className="break-words text-flit-secondary">
          Aquí hubo un mensaje con una placa, un VIN o un id FLIT; no se guarda en el navegador.
        </p>
      </BurbujaDrFlit>
    );
  }
  return (
    <BurbujaDrFlit>
      <p className="break-words text-flit-secondary">
        Aquí hubo una consulta de gestión. Por seguridad, sus resultados no se guardan en el navegador.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={onVolver} className={flitBtnSecondarySm}>
          Volver a consultar
        </button>
      </div>
    </BurbujaDrFlit>
  );
}
