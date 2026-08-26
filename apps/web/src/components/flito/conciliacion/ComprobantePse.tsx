// FLITO Conciliación — el comprobante del pago PSE (HU #11680, AC6).
//
// Es una tarjeta DENTRO del detalle y no una pantalla aparte: el comprobante pertenece a la boleta, y
// sacarlo a un modal obligaría a abrir algo para ver si existe. Tres momentos —antes de conciliar,
// conciliada sin comprobante, con comprobante— y los cuatro estados de cada uno.
//
// Dos reglas que el AC6 exige por escrito:
//
//   · **El rechazo dice el MOTIVO y la vista NO se queda cargando.** El texto propio de la caja
//     («Rechazado — cargar otro») no es un motivo: el tipo y el tamaño se comprueban aquí mismo,
//     antes de subir nada, y lo que solo se sabe mirando los bytes —un `.exe` renombrado a `.pdf`—
//     lo nombra el servidor.
//   · **La URL firmada NUNCA se pinta como `href` estático.** Caduca a los cinco minutos, y un enlace
//     muerto en pantalla es peor que un botón: el clic pide una firma fresca y abre con `noopener`,
//     el mismo patrón de `abrirSoporteBolsa`.

import { useState } from 'react';
import toast from 'react-hot-toast';
import {
  COMPROBANTE_MAX_BYTES, COMPROBANTE_MIMES, EstadoBoleta,
  type BoletaDetalleDto, type ComprobanteBoletaDto, type ComprobanteDescargaDto,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../../../lib/api';
import { fechaHora } from '../../../lib/bolsas';
import { rechazoDeComprobante, type Rechazo } from '../../../lib/conciliacion';
import FlitUploadBox from '../../flit/FlitUploadBox';
import { FlitCard, flitBtnSecondary, flitBtnSecondarySm, flitBtnSecondaryStyle } from '../../flit/flitPageKit';

const MB = 1024 * 1024;
const TOPE_MB = Math.round(COMPROBANTE_MAX_BYTES / MB);

interface Props {
  boleta: BoletaDetalleDto;
  onComprobante: (comprobante: ComprobanteBoletaDto) => void;
}

export default function ComprobantePse({ boleta, onComprobante }: Props) {
  const [subiendo, setSubiendo] = useState(false);
  const [rechazo, setRechazo] = useState<Rechazo | null>(null);
  const [reemplazando, setReemplazando] = useState(false);

  const conciliada = boleta.estado === EstadoBoleta.CONCILIADA;
  const comprobante = boleta.comprobante;

  async function subir(archivo: File, reemplazar: boolean): Promise<void> {
    const local = rechazoLocal(archivo);
    if (local) { setRechazo(local); return; }
    setSubiendo(true);
    setRechazo(null);
    try {
      const form = new FormData();
      form.append('archivo', archivo);
      const subido = reemplazar
        ? await api.put<ComprobanteBoletaDto>(`/flito/conciliacion/boletas/${boleta.id}/comprobante`, form)
        : await api.post<ComprobanteBoletaDto>(`/flito/conciliacion/boletas/${boleta.id}/comprobante`, form);
      setReemplazando(false);
      onComprobante(subido);
    } catch (e) {
      setRechazo(rechazoDeComprobante(e));
    } finally {
      // Pase lo que pase, la caja sale del estado «Analizando…». Es literalmente lo que pide el AC6.
      setSubiendo(false);
    }
  }

  async function descargar(): Promise<void> {
    try {
      const { url } = await api.get<ComprobanteDescargaDto>(
        `/flito/conciliacion/boletas/${boleta.id}/comprobante`,
      );
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      toast.error(`No se pudo abrir el comprobante. Vuelve a intentarlo. (${errorMessage(e)})`);
    }
  }

  return (
    <FlitCard>
      <h2 className="text-sm font-bold" style={{ color: 'var(--flit-text-primary)' }}>
        Comprobante del pago PSE
      </h2>

      {!conciliada && (
        <p className="mt-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          El comprobante se adjunta después de conciliar la boleta.
        </p>
      )}

      {conciliada && comprobante && !reemplazando && (
        <div className="mt-3 space-y-2">
          <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
            <span aria-hidden="true">📄</span> {comprobante.nombreArchivo}
            {' · '}{etiquetaTipo(comprobante.contentType)}
            {' · subido el '}{fechaHora(comprobante.subidoEn)}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={flitBtnSecondarySm} style={flitBtnSecondaryStyle} onClick={descargar}>
              Descargar
            </button>
            <button
              type="button" className={flitBtnSecondarySm} style={flitBtnSecondaryStyle}
              onClick={() => { setReemplazando(true); setRechazo(null); }}
            >
              Reemplazar
            </button>
          </div>
          <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            Al reemplazarlo, el comprobante actual se descarta.
          </p>
        </div>
      )}

      {conciliada && (!comprobante || reemplazando) && (
        <div className="mt-3 space-y-2">
          <FlitUploadBox
            label={reemplazando ? 'Nuevo comprobante del pago PSE' : 'Comprobante del pago PSE'}
            hint={`PDF, JPG o PNG · máximo ${TOPE_MB} MB`}
            state={subiendo ? 'uploading' : rechazo ? 'rejected' : 'idle'}
            onFile={(f) => { void subir(f, reemplazando); }}
          />
          {!reemplazando && !rechazo && (
            <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
              Todavía no se ha adjuntado el comprobante de este pago. El gestor lo ve desde cada uno de
              sus SOAT.
            </p>
          )}
          {reemplazando && (
            <button
              type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
              disabled={subiendo} onClick={() => { setReemplazando(false); setRechazo(null); }}
            >
              Cancelar el reemplazo
            </button>
          )}
          {rechazo && (
            <div role="alert" className="text-sm">
              <p className="font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>{rechazo.titulo}</p>
              <p style={{ color: 'var(--flit-text-secondary)' }}>{rechazo.detalle}</p>
              <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
                Vuelve a elegir un archivo en la caja de arriba para reintentarlo.
              </p>
            </div>
          )}
        </div>
      )}
    </FlitCard>
  );
}

/**
 * Lo que se puede rechazar sin subir nada: el tipo declarado y el tamaño.
 *
 * Se comprueba aquí además de en el servidor —que es quien decide— porque el motivo llega al
 * instante y nombra el archivo concreto: subir 15 MB para que rebote es tiempo del usuario. Lo que NO
 * se comprueba aquí es el contenido: un `.exe` renombrado a `.pdf` declara `application/pdf` y solo
 * se cae mirando los bytes, que es lo que hace el servidor.
 */
function rechazoLocal(archivo: File): Rechazo | null {
  if (!(COMPROBANTE_MIMES as readonly string[]).includes(archivo.type)) {
    const ext = archivo.name.includes('.') ? archivo.name.split('.').pop() : null;
    return {
      titulo: ext
        ? `Ese archivo es un .${ext.toLowerCase()}. El comprobante tiene que ser PDF, JPG o PNG.`
        : 'Ese archivo no es un PDF, un JPG ni un PNG.',
      detalle: 'Descarga el comprobante del banco en uno de esos tres formatos.',
    };
  }
  if (archivo.size > COMPROBANTE_MAX_BYTES) {
    return {
      titulo: `El archivo pesa ${(archivo.size / MB).toFixed(1)} MB y el máximo son ${TOPE_MB} MB.`,
      detalle: 'Exporta el PDF otra vez o comprímelo.',
    };
  }
  return null;
}

const TIPOS: Record<string, string> = {
  'application/pdf': 'PDF', 'image/jpeg': 'JPG', 'image/png': 'PNG',
};

const etiquetaTipo = (contentType: string): string => TIPOS[contentType] ?? 'Archivo';
