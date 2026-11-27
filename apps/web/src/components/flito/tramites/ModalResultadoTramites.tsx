// FLITO — Trámites: resultado de las acciones en lote (solicitar SOAT/impuestos/ambos y entregar).
// Movido desde `pages/FlitoTramites.tsx` al partirla (rediseño UI Kit 2026, Épica #14560).

import type { ReactNode } from 'react';
import FlitModal from '../../flit/FlitModal';
import GradientButton from '../../flit/GradientButton';
import type { ChipTone } from '../../flit/StatusChip';
import type { ResImpuestos, ResSoat, Resultado } from './tiposTramites';

// Punto del manual por tono (relleno, no texto).
const TONO_COLOR: Record<ChipTone, string> = {
  success: 'var(--kit-verde)', active: 'var(--kit-azul)', warning: 'var(--kit-naranja)',
  danger: 'var(--kit-rojo)', draft: 'var(--color-text-tertiary)', neutral: 'var(--color-text-tertiary)',
};

function Linea({ tono, children }: { tono: ChipTone; children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm">
      <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: TONO_COLOR[tono] }} />
      <span>{children}</span>
    </p>
  );
}

/** Épica #14707 §6 (lote parcial): la segunda frase, la misma en SOAT, impuestos y entrega. */
function NoVigentes({ n, verbo = 'no se enviaron' }: { n?: number; verbo?: string }) {
  if (!n) return null;
  return <Linea tono="warning">{n} {verbo} porque su trámite se anuló o se revocó en FLIT.</Linea>;
}

function DetalleSoat({ r }: { r: ResSoat }) {
  const vacio = !r.enviados && !r.yaEnviados && !r.autogestionados && !r.sinRegistro;
  return (
    <div className="space-y-1.5">
      {r.enviados > 0 && <Linea tono="success">{r.enviados} SOAT enviado(s): pasan a «En adquisición».</Linea>}
      {r.yaEnviados > 0 && <Linea tono="neutral">{r.yaEnviados} ya solicitados o pagados: no se reenvían.</Linea>}
      {r.autogestionados > 0 && <Linea tono="neutral">{r.autogestionados} no llevan SOAT: su compañía lo autogestiona.</Linea>}
      {r.sinRegistro > 0 && <Linea tono="neutral">{r.sinRegistro} sin registro de SOAT todavía.</Linea>}
      <NoVigentes n={r.noVigentes} />
      {vacio && <Linea tono="neutral">Ningún trámite tenía SOAT por enviar.</Linea>}
    </div>
  );
}

function DetalleImpuestos({ r }: { r: ResImpuestos }) {
  const vacio = !r.enviados && !r.yaEnviados && !r.noEnviables;
  return (
    <div className="space-y-1.5">
      {r.enviados > 0 && <Linea tono="success">{r.enviados} impuesto(s) enviado(s): pasan a «Solicitado».</Linea>}
      {r.yaEnviados > 0 && <Linea tono="neutral">{r.yaEnviados} ya solicitados o pagados: no se reenvían.</Linea>}
      {r.noEnviables > 0 && <Linea tono="neutral">{r.noEnviables} no enviables: autogestionados o no están en Pendiente.</Linea>}
      <NoVigentes n={r.noVigentes} />
      {vacio && <Linea tono="neutral">Ningún trámite tenía impuesto por enviar.</Linea>}
    </div>
  );
}

const TITULO: Record<Resultado['tipo'], string> = {
  soat: 'Resultado de solicitar SOAT', impuestos: 'Resultado de solicitar Impuestos',
  ambos: 'Resultado de solicitar SOAT e Impuestos', entrega: 'Resultado de la entrega',
};

const antetitulo = 'mb-1 text-xs font-semibold uppercase tracking-[.03em] text-[color:var(--color-text-tertiary)]';

export default function ModalResultado({ resultado, onCerrar }: { resultado: Resultado; onCerrar: () => void }) {
  return (
    <FlitModal title={TITULO[resultado.tipo]} onClose={onCerrar} wide>
      <div className="space-y-3">
        {resultado.tipo === 'soat' && <DetalleSoat r={resultado.soat} />}
        {resultado.tipo === 'impuestos' && <DetalleImpuestos r={resultado.impuestos} />}
        {resultado.tipo === 'ambos' && (
          <>
            <div><p className={antetitulo}>SOAT</p><DetalleSoat r={resultado.soat} /></div>
            <div><p className={antetitulo}>Impuestos</p><DetalleImpuestos r={resultado.impuestos} /></div>
          </>
        )}
        {resultado.tipo === 'entrega' && (
          <div className="space-y-1.5">
            {resultado.entrega.entregados > 0 && <Linea tono="success">{resultado.entrega.entregados} trámite(s) entregado(s).</Linea>}
            <NoVigentes n={resultado.entrega.noVigentes} verbo="no se entregaron" />
            {resultado.entrega.noHabilitados.length > 0 && (
              <div>
                <Linea tono="warning">{resultado.entrega.noHabilitados.length} no estaban habilitados:</Linea>
                <ul className="mt-1 space-y-1">
                  {resultado.entrega.noHabilitados.map((t) => (
                    <li key={t.tramiteId} className="rounded-[9px] border border-[color:var(--color-border)] p-2 text-xs">
                      <span className="font-medium">{t.placa}</span> <span className="text-[color:var(--color-text-tertiary)]">— {t.motivo}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!resultado.entrega.entregados && !resultado.entrega.noHabilitados.length && <Linea tono="neutral">No había trámites por entregar.</Linea>}
          </div>
        )}
        <GradientButton onClick={onCerrar}>Entendido</GradientButton>
      </div>
    </FlitModal>
  );
}
