// Carga masiva de facturas SOAT (modal), movida tal cual desde `pages/FlitoSoat.tsx` (HU #12819, fase 0).

import { useState } from 'react';
import { enviarCargaEnTandas, validarCargaMasiva } from '../../../lib/carga-masiva';
import useSeleccionCargaMasiva from '../../../lib/useSeleccionCargaMasiva';
import RanuraCargaMasiva from '../RanuraCargaMasiva';
import FlitModal from '../../flit/FlitModal';
import StatusChip, { type ChipTone } from '../../flit/StatusChip';
import { flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';

interface ResultadoMasivo {
  pagados: { archivo: string; detalle: string }[]; enRevision: { archivo: string; detalle: string }[];
  duplicados: { archivo: string; detalle: string }[]; noAsociados: { archivo: string; detalle: string }[];
}

// El ZIP se abre en el navegador (HU #12056): lo que se cuenta, se pesa, se valida y se envía son
// sus ENTRADAS, no el ZIP. `rutas` NO se manda: la ruta solo sirve para deducir la marca de agua y
// SOAT ni la lee (`/flito/soat/facturas` no toca `req.body`); mandarla sería peso muerto por tanda.
export default function CargaMasiva({ onClose, onListo }: { onClose: () => void; onListo: () => void }) {
  const { seleccion, abriendo, error, setError, elegir } = useSeleccionCargaMasiva();
  const [progreso, setProgreso] = useState<{ desde: number; total: number } | null>(null);
  const [resultado, setResultado] = useState<ResultadoMasivo | null>(null);
  const errorValidacion = validarCargaMasiva(seleccion);
  const enviando = progreso !== null;

  const subir = async () => {
    if (seleccion.items.length === 0 || validarCargaMasiva(seleccion)) return;
    setError(null);
    const { resultado: r, error: err } = await enviarCargaEnTandas<ResultadoMasivo>(
      '/flito/soat/facturas', seleccion.items, (desde, total) => setProgreso({ desde, total }),
      undefined, { conRutas: false },
    );
    if (r) setResultado(r);
    if (err) setError(err);
    setProgreso(null);
  };

  return (
    <FlitModal title="Carga masiva de facturas SOAT" onClose={resultado ? onListo : onClose} wide>
      {!resultado ? (
        <div className="space-y-3">
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            Sube varios PDF/imágenes o un ZIP. FLITO abre el ZIP en tu computador y sube sus comprobantes de 5 en 5. El OCR cruza cada comprobante con un SOAT solicitado: los que superan el umbral pasan a Pagado; el resto va a revisión.
          </p>
          <input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.zip" className={flitInp} disabled={enviando}
            aria-label="Facturas o ZIP de la carga masiva"
            onChange={(e) => { void elegir(Array.from(e.target.files ?? [])); }} />
          <RanuraCargaMasiva seleccion={seleccion} abriendo={abriendo}
            errorValidacion={errorValidacion} error={error} progreso={progreso} />
          <div className="flex gap-2">
            <button className={flitBtnPrimary} style={flitBtnPrimaryStyle}
              disabled={enviando || abriendo !== null || seleccion.items.length === 0 || !!errorValidacion} onClick={subir}>
              {enviando ? 'Procesando…' : 'Subir y procesar'}
            </button>
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={enviando} onClick={onClose}>Cancelar</button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <StatusChip tone="success">Pagados {resultado.pagados.length}</StatusChip>
            <StatusChip tone="warning">En revisión {resultado.enRevision.length}</StatusChip>
            <StatusChip tone="neutral">Duplicados {resultado.duplicados.length}</StatusChip>
            <StatusChip tone="danger">Sin asociar {resultado.noAsociados.length}</StatusChip>
          </div>
          <TablaResultadoOcr resultado={resultado} />
          <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={onListo}>Listo</button>
        </div>
      )}
    </FlitModal>
  );
}

// Resultado del OCR masivo en TABLA: cada archivo analizado en su propia fila (archivo · resultado ·
// detalle), en vez de listas apretadas.
function TablaResultadoOcr({ resultado }: { resultado: ResultadoMasivo }) {
  const filas: { archivo: string; detalle: string; resultado: string; tono: ChipTone }[] = [
    ...resultado.pagados.map((i) => ({ ...i, resultado: 'Pagado', tono: 'success' as ChipTone })),
    ...resultado.enRevision.map((i) => ({ ...i, resultado: 'En revisión', tono: 'warning' as ChipTone })),
    ...resultado.duplicados.map((i) => ({ ...i, resultado: 'Duplicado', tono: 'neutral' as ChipTone })),
    ...resultado.noAsociados.map((i) => ({ ...i, resultado: 'Sin asociar', tono: 'danger' as ChipTone })),
  ];
  if (filas.length === 0) return <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>No se procesó ningún archivo.</p>;
  const th = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide';
  return (
    <div className="max-h-[55vh] overflow-auto rounded-lg border" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <table className="w-full text-sm">
        <thead>
          <tr style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>
            <th className={th}>Archivo</th><th className={th}>Resultado</th><th className={th}>Detalle del análisis OCR</th>
          </tr>
        </thead>
        <tbody>
          {filas.map((f, idx) => (
            <tr key={idx} className="border-t" style={{ borderColor: 'var(--flit-border-soft)' }}>
              <td className="px-3 py-2 font-medium align-top" style={{ color: 'var(--flit-text-primary)' }}>{f.archivo}</td>
              <td className="px-3 py-2 align-top"><StatusChip tone={f.tono}>{f.resultado}</StatusChip></td>
              <td className="px-3 py-2 align-top" style={{ color: 'var(--flit-text-secondary)' }}>{f.detalle}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
