// FLITO — «Cargar comprobantes» (HU #12612, Feature #12605). Calco de `CargaRecibosImpuestos.tsx`
// SIN selector de fase (el OCR decide qué es) y SIN ZIP (esta puerta recibe PDF e imágenes sueltos).
//
// Lo que cambia respecto a Impuestos vive en `lib/comprobantes.ts`: los PDF de más de una página
// (consolidados, contados con pdf.js antes de enviar) viajan de uno en uno, el resto de 5 en 5, y
// todos con el MISMO `loteId`, que nace al abrir el modal y se renueva si la persona vuelve a elegir
// archivos tras un fallo (lo que ya entró es de la carga anterior, y así lo dirá la cola).
//
// Una sola región `status`: la de `RanuraCargaMasiva` (contador + progreso) mientras se elige y se
// envía; la línea de resumen en el resultado. El `alert` del error va aparte (UX §8).

import { useState } from 'react';
import type { ItemCargaComprobante, ResultadoCargaComprobantes } from '@operaciones/shared-types';
import { esZipCargaMasiva, validarCargaMasiva, type ItemCarga } from '../../lib/carga-masiva';
import { contarPaginasPdf, enviarLoteComprobantes, textoPaginas, textoTamano } from '../../lib/comprobantes';
import useSeleccionCargaMasiva from '../../lib/useSeleccionCargaMasiva';
import RanuraCargaMasiva from './RanuraCargaMasiva';
import FlitModal from '../flit/FlitModal';
import StatusChip, { type ChipTone } from '../flit/StatusChip';
import { flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../flit/flitPageKit';

const COPY_ZIP = 'FLITO no abre ZIP en esta carga: sube los PDF o las imágenes sueltos.';

export default function CargaComprobantes({ onClose, onListo, onVerOriginal }: {
  onClose: () => void;
  /** «Listo»: cierra, refresca la cola y la deja filtrada por esta carga. */
  onListo: (loteId: string) => void;
  /** «Ver el original» de un duplicado: abre el detalle de ese comprobante ENCIMA del modal. */
  onVerOriginal: (comprobanteId: string) => void;
}) {
  const { seleccion, abriendo, error, setError, elegir } = useSeleccionCargaMasiva();
  const [loteId, setLoteId] = useState(() => crypto.randomUUID());
  const [huboFallo, setHuboFallo] = useState(false);
  const [progreso, setProgreso] = useState<{ desde: number; total: number } | null>(null);
  const [resultado, setResultado] = useState<ResultadoCargaComprobantes | null>(null);
  const errorValidacion = validarCargaMasiva(seleccion);
  const enviando = progreso !== null;

  const elegirSinZip = async (elegidos: File[]) => {
    // Otra carga tras un fallo: otro `loteId`. Lo que sí entró ya es de la anterior.
    if (huboFallo) { setLoteId(crypto.randomUUID()); setHuboFallo(false); }
    const sueltos = elegidos.filter((f) => !esZipCargaMasiva(f));
    await elegir(sueltos);
    if (sueltos.length !== elegidos.length) setError(COPY_ZIP);
  };

  const subir = async () => {
    if (seleccion.items.length === 0 || validarCargaMasiva(seleccion)) return;
    setError(null);
    setProgreso({ desde: 1, total: seleccion.items.length });
    const paginas = new Map<ItemCarga, number>();
    for (const item of seleccion.items) paginas.set(item, await contarPaginasPdf(await item.abrir()));
    const { resultado: r, error: err } = await enviarLoteComprobantes(
      seleccion.items, paginas, loteId, (desde, total) => setProgreso({ desde, total }),
    );
    if (r) setResultado(r);
    if (err) { setError(err); setHuboFallo(true); }
    setProgreso(null);
  };

  return (
    <FlitModal title="Cargar comprobantes" onClose={resultado ? () => onListo(loteId) : onClose} wide>
      {!resultado ? (
        <div className="space-y-3">
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            Sube PDF o imágenes de facturas de SOAT, recibos de impuesto o de derechos, facturas de servicios, transferencias o cualquier soporte del trámite. Un PDF con varios documentos se lee documento por documento. Lo leído queda en Pendientes con lo que FLITO entendió de cada uno.
          </p>
          <input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp" className={flitInp} disabled={enviando}
            aria-label="Comprobantes de la carga"
            onChange={(e) => { void elegirSinZip(Array.from(e.target.files ?? [])); }} />
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
          <p role="status" aria-live="polite" className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            {resultado.documentos} documentos leídos en {seleccion.items.length} archivos
          </p>
          {/* «Aplicados» no se pinta en este Feature: la puerta no aplica (#12606 lo añade). */}
          <div className="flex flex-wrap gap-2">
            <StatusChip tone="warning">Pendientes {resultado.pendientes.length}</StatusChip>
            <StatusChip tone="neutral">Duplicados {resultado.duplicados.length}</StatusChip>
            <StatusChip tone="danger">Fallidos {resultado.fallidos.length}</StatusChip>
          </div>
          <TablaResultadoCarga resultado={resultado} items={seleccion.items} onVerOriginal={onVerOriginal} />
          <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={() => onListo(loteId)}>Listo</button>
        </div>
      )}
    </FlitModal>
  );
}

type FilaResultado = ItemCargaComprobante & { resultado: string; tono: ChipTone; esDuplicado: boolean };

/** Resultado por DOCUMENTO (un consolidado de 4 documentos son 4 filas), calco de `TablaResultadoOcr`. */
function TablaResultadoCarga({ resultado, items, onVerOriginal }: {
  resultado: ResultadoCargaComprobantes; items: readonly ItemCarga[]; onVerOriginal: (id: string) => void;
}) {
  const filas: FilaResultado[] = [
    ...resultado.pendientes.map((i) => ({ ...i, resultado: 'Pendiente', tono: 'warning' as ChipTone, esDuplicado: false })),
    ...resultado.duplicados.map((i) => ({ ...i, resultado: 'Duplicado', tono: 'neutral' as ChipTone, esDuplicado: true })),
    ...resultado.fallidos.map((i) => ({ ...i, resultado: 'Fallido', tono: 'danger' as ChipTone, esDuplicado: false })),
  ];
  if (filas.length === 0) return <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>No se procesó ningún archivo.</p>;
  const tamanoDe = (archivo: string): string | null => {
    const item = items.find((i) => i.nombre === archivo);
    return item ? textoTamano(item.size) : null;
  };
  const th = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide';
  return (
    <div className="max-h-[55vh] overflow-auto rounded-lg border" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <table className="w-full text-sm">
        <thead>
          <tr style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>
            <th className={th}>Archivo</th><th className={th}>Resultado</th><th className={th}>Detalle</th>
          </tr>
        </thead>
        <tbody>
          {filas.map((f, idx) => {
            const paginas = textoPaginas(f.paginas);
            const tamano = tamanoDe(f.archivo);
            return (
              <tr key={idx} className="border-t" style={{ borderColor: 'var(--flit-border-soft)' }}>
                <td className="px-3 py-2 align-top" style={{ color: 'var(--flit-text-primary)' }}>
                  <span className="font-medium">{f.archivo}</span>
                  <span className="block text-xs" style={{ color: 'var(--flit-text-muted)' }}>
                    {[tamano, paginas].filter(Boolean).join(' · ')}
                  </span>
                </td>
                <td className="px-3 py-2 align-top"><StatusChip tone={f.tono}>{f.resultado}</StatusChip></td>
                <td className="px-3 py-2 align-top" style={{ color: 'var(--flit-text-secondary)' }}>
                  {f.detalle}
                  {f.esDuplicado && f.comprobanteId && (
                    <>
                      {' · '}
                      <button type="button" className="flit-focus underline" style={{ color: 'var(--flit-blue-text)' }}
                        onClick={() => onVerOriginal(f.comprobanteId!)}>
                        Ver el original
                      </button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
