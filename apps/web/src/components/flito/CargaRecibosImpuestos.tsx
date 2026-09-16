// FLITO — Carga masiva de recibos de impuesto (modal). Sale de `pages/FlitoImpuestos.tsx` en la HU
// #12592 (la página rozaba `max-lines`) y aquí gana el selector de FASE.
//
// La fase la declara quien carga —o la carpeta del ZIP—, nunca se infiere por la marca de agua del
// documento (HU #12590). El ZIP se abre en el navegador (HU #12056): lo que se cuenta, se pesa, se
// valida y se envía son sus ENTRADAS, no el ZIP; la ruta relativa de cada entrada viaja en el campo
// `rutas` de cada tanda y es lo único con lo que el API deduce la fase por carpeta. Si ese
// emparejamiento se rompe el API no falla: responde 200 y archiva todo con la fase del selector.
// Por eso lo arma `enviarCargaEnTandas` en un solo recorrido.

import { useId, useState } from 'react';
import { FASES_RECIBO, FaseRecibo } from '@operaciones/shared-types';
import { enviarCargaEnTandas, validarCargaMasiva } from '../../lib/carga-masiva';
import useSeleccionCargaMasiva from '../../lib/useSeleccionCargaMasiva';
import RanuraCargaMasiva from './RanuraCargaMasiva';
import FlitModal from '../flit/FlitModal';
import StatusChip, { type ChipTone } from '../flit/StatusChip';
import { flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../flit/flitPageKit';

interface ItemRecibo { archivo: string; detalle: string }
export interface ResultadoRecibos {
  liquidados: ItemRecibo[]; conciliados: ItemRecibo[]; enRevision: ItemRecibo[];
  complementos: ItemRecibo[]; duplicados: ItemRecibo[]; noAsociados: ItemRecibo[];
}

const ROTULO_FASE: Record<FaseRecibo, string> = { liquidacion: 'Liquidación', pago: 'Pago' };

export default function CargaRecibosImpuestos({ onClose, onListo }: { onClose: () => void; onListo: () => void }) {
  const { seleccion, abriendo, error, setError, elegir } = useSeleccionCargaMasiva();
  // Pago por defecto: es lo que se carga a diario; la liquidación es la excepción que se declara.
  const [fase, setFase] = useState<FaseRecibo>(FaseRecibo.PAGO);
  const [progreso, setProgreso] = useState<{ desde: number; total: number } | null>(null);
  const [resultado, setResultado] = useState<ResultadoRecibos | null>(null);
  const idAyudaZip = useId();
  const errorValidacion = validarCargaMasiva(seleccion);
  const enviando = progreso !== null;

  const subir = async () => {
    if (seleccion.items.length === 0 || validarCargaMasiva(seleccion)) return;
    setError(null);
    // `fase` viaja igual en cada tanda; `sinMarcaDeAgua` ya no se manda (el servidor lo tolera por
    // compatibilidad, pero esta pantalla no lo conoce).
    const { resultado: r, error: err } = await enviarCargaEnTandas<ResultadoRecibos>(
      '/flito/impuestos/recibos', seleccion.items, (desde, total) => setProgreso({ desde, total }),
      { fase },
    );
    if (r) setResultado(r);
    if (err) setError(err);
    setProgreso(null);
  };

  return (
    <FlitModal title="Carga masiva de recibos de impuesto" onClose={resultado ? onListo : onClose} wide>
      {!resultado ? (
        <div className="space-y-3">
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            Sube varios PDF/imágenes o un ZIP. FLITO abre el ZIP en tu computador y sube sus recibos de 5 en 5, conservando la carpeta de cada uno. El OCR cruza cada recibo con su impuesto en gestión por la placa. En fase Liquidación deja el impuesto liquidado (valor y fecha) sin pagarlo; en fase Pago, los que cuadran pasan a Pagado y el resto va a revisión.
          </p>
          {/* Radios nativos y no <select>: dos valores, ambos visibles, un solo gesto (flechas). La
              ayuda del ZIP va SIEMPRE bajo el selector: la regla aplica antes de elegir el archivo. */}
          <fieldset className="text-sm" style={{ color: 'var(--flit-text-secondary)' }} aria-describedby={idAyudaZip}>
            {/* `legend` primer hijo directo del `fieldset` (es lo que le da nombre al grupo); flotado
                para que las opciones queden en su misma línea, como la casilla que reemplaza. */}
            <legend className="float-left mr-4 font-semibold">Fase del recibo</legend>
            {FASES_RECIBO.map((f) => (
              <label key={f} className="mr-4 inline-flex cursor-pointer items-center gap-2">
                <input type="radio" name="fase-recibo" value={f} checked={fase === f} disabled={enviando}
                  onChange={() => setFase(f)} />
                {ROTULO_FASE[f]}
              </label>
            ))}
            <p id={idAyudaZip} className="clear-both mt-1 text-xs">
              En un ZIP manda la carpeta de cada recibo («sin marca» → Liquidación; «con marca» o «pagado» → Pago). La fase elegida aplica a los recibos sueltos y a las entradas del ZIP sin carpeta reconocible.
            </p>
          </fieldset>
          <input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.zip" className={flitInp} disabled={enviando}
            aria-label="Recibos o ZIP de la carga masiva"
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
            <StatusChip tone="active">Liquidados {resultado.liquidados?.length ?? 0}</StatusChip>
            <StatusChip tone="success">Conciliados {resultado.conciliados.length}</StatusChip>
            <StatusChip tone="warning">En revisión {resultado.enRevision.length}</StatusChip>
            <StatusChip tone="active">Complementos {resultado.complementos.length}</StatusChip>
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

// Resultado del OCR masivo en TABLA: cada recibo analizado en su propia fila.
function TablaResultadoOcr({ resultado }: { resultado: ResultadoRecibos }) {
  const filas: { archivo: string; detalle: string; resultado: string; tono: ChipTone }[] = [
    ...(resultado.liquidados ?? []).map((i) => ({ ...i, resultado: 'Liquidado', tono: 'active' as ChipTone })),
    ...resultado.conciliados.map((i) => ({ ...i, resultado: 'Conciliado', tono: 'success' as ChipTone })),
    ...resultado.enRevision.map((i) => ({ ...i, resultado: 'En revisión', tono: 'warning' as ChipTone })),
    ...resultado.complementos.map((i) => ({ ...i, resultado: 'Complemento', tono: 'active' as ChipTone })),
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
