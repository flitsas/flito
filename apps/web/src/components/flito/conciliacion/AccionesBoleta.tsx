// FLITO Conciliación — las dos acciones de una boleta todavía sin conciliar (HU #11680, AC4).
//
// **Volver a cruzar** es la salida del callejón que el AC4 crearía sin ella: el texto bloqueante pide
// resolver las líneas malas, pero «Conciliar» está bloqueado justo en ese estado y volver a cargar el
// mismo archivo choca con el índice único del hash. Re-ejecuta el cruce sobre las líneas ya
// guardadas y no mueve un peso.
//
// **Descartar** lleva confirmación EN LÍNEA y no un modal, a propósito: el único diálogo modal de la
// pantalla es el que descuenta de las bolsas. Si se ponen tres confirmaciones, la que importa se
// pulsa sin leer. No mueve dinero, pero borra el cruce y libera el hash del archivo, así que tampoco
// se hace de un solo clic.
//
// Ninguna de las dos existe sobre una boleta conciliada: es un documento contable con dinero movido
// detrás, y el servidor responde 409 a las dos.

import { useState } from 'react';
import toast from 'react-hot-toast';
import type { BoletaDetalleDto, BoletaResumenDto } from '@operaciones/shared-types';
import { api, errorMessage } from '../../../lib/api';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';

interface Props {
  boletaId: string;
  onCuadreActualizado: (boleta: BoletaDetalleDto) => void;
  onDescartada: (boleta: BoletaResumenDto) => void;
}

export default function AccionesBoleta({ boletaId, onCuadreActualizado, onDescartada }: Props) {
  const [recruzando, setRecruzando] = useState(false);
  const [descartando, setDescartando] = useState(false);
  const [confirmaDescarte, setConfirmaDescarte] = useState(false);

  async function recruzar(): Promise<void> {
    setRecruzando(true);
    try {
      const boleta = await api.post<BoletaDetalleDto>(`/flito/conciliacion/boletas/${boletaId}/recruzar`, {});
      onCuadreActualizado(boleta);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRecruzando(false);
    }
  }

  async function descartar(): Promise<void> {
    setDescartando(true);
    try {
      const boleta = await api.post<BoletaResumenDto>(`/flito/conciliacion/boletas/${boletaId}/descartar`, {});
      onDescartada(boleta);
    } catch (e) {
      toast.error(errorMessage(e));
      setConfirmaDescarte(false);
    } finally {
      setDescartando(false);
    }
  }

  if (confirmaDescarte) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          ¿Descartar? Se pierde el cruce; el archivo se podrá volver a cargar.
        </span>
        <button
          type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
          disabled={descartando} onClick={() => setConfirmaDescarte(false)}
        >
          No
        </button>
        <button
          type="button" className={flitBtnSecondary}
          style={{ ...flitBtnSecondaryStyle, color: 'var(--flit-danger-ink)' }}
          disabled={descartando} onClick={descartar}
        >
          {descartando ? 'Descartando…' : 'Sí, descartar'}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
        disabled={recruzando} onClick={() => setConfirmaDescarte(true)}
      >
        Descartar
      </button>
      <button
        type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
        disabled={recruzando} onClick={recruzar}
      >
        {recruzando ? 'Volviendo a cruzar…' : 'Volver a cruzar'}
      </button>
    </div>
  );
}
