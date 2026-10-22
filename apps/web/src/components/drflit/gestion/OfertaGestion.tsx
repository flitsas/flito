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
  onConsultar: (id: string) => void;
  onManuales: (id: string) => void;
}

export function OfertaGestion({ mensaje, onConsultar, onManuales }: OfertaGestionProps) {
  const { valor, estado } = mensaje;
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
