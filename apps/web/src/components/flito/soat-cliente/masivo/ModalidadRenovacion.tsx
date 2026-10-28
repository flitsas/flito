// HU #14134 (AC1) — selector «Individual / Masiva» de la solicitud de SOAT con tipo Renovación.
//
// Punto de montaje único en `FlitoSoatSolicitud.tsx` (render-prop): si el tipo no es Renovación o la
// forma es Individual devuelve `children` (el formulario actual, sin tocarlo); si es Masiva pinta el
// panel y NO monta `children` (así tampoco aparece la barra de envío). El estado de los campos
// individuales vive en la página, por lo que alternar no pierde lo digitado.
import { useCallback, useState, type ReactNode } from 'react';
import { Layers } from 'lucide-react';
import { TipoSoat } from '@operaciones/shared-types';
import FlitModal from '../../../flit/FlitModal';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../../../flit/flitPageKit';
import type { CompaniaSoat } from '../CampoCompaniaSoat';
import { Seccion } from '../bloques';
import PanelMasivoRenovacion from './PanelMasivoRenovacion';

type Forma = 'individual' | 'masiva';

const OPCIONES: { forma: Forma; titulo: string; texto: string }[] = [
  { forma: 'individual', titulo: 'Individual', texto: 'Un vehículo' },
  { forma: 'masiva', titulo: 'Masiva', texto: 'Hasta 200 renovaciones desde un Excel' },
];

export default function ModalidadRenovacion({ tipo, compania, children }: {
  tipo: TipoSoat | null;
  compania: CompaniaSoat;
  children: ReactNode;
}) {
  const [forma, setForma] = useState<Forma>('individual');
  const [enCurso, setEnCurso] = useState(false);
  const [confirmar, setConfirmar] = useState(false);
  const alEnCurso = useCallback((v: boolean) => setEnCurso(v), []);

  if (tipo !== TipoSoat.RENOVACION) return <>{children}</>;

  const elegir = (f: Forma) => {
    if (f === forma) return;
    if (f === 'individual' && enCurso) { setConfirmar(true); return; }
    setForma(f);
  };

  return (
    <>
      <Seccion titulo="Forma de cargar" icono={<Layers size={18} aria-hidden="true" className="shrink-0" />}>
        <div role="radiogroup" aria-label="Forma de cargar" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {OPCIONES.map((o) => {
            const marcada = forma === o.forma;
            return (
              <div
                key={o.forma}
                className="relative flex min-h-[44px] items-start gap-3 rounded-[10px] p-4 transition-colors hover:bg-[var(--flit-bg-hover)] has-[:focus-visible]:shadow-[0_0_0_3px_var(--flit-border-focus)]"
                style={{
                  border: marcada ? '2px solid var(--flit-blue-text)' : '1px solid var(--flit-border-soft)',
                  background: marcada ? 'var(--flit-bg-app)' : undefined,
                  padding: marcada ? 'calc(1rem - 1px)' : undefined,
                }}
              >
                <input
                  id={`forma-${o.forma}`} type="radio" name="forma-cargar" value={o.forma} checked={marcada}
                  aria-describedby={`forma-${o.forma}-desc`} onChange={() => elegir(o.forma)}
                  className="relative z-10 mt-1 h-4 w-4 shrink-0 cursor-pointer accent-[var(--flit-blue-text)] outline-none"
                />
                <div className="min-w-0 space-y-1">
                  <label htmlFor={`forma-${o.forma}`} className="block cursor-pointer text-sm font-semibold after:absolute after:inset-0 after:content-['']"
                    style={{ color: 'var(--flit-text-primary)' }}>{o.titulo}</label>
                  <p id={`forma-${o.forma}-desc`} className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{o.texto}</p>
                </div>
              </div>
            );
          })}
        </div>
      </Seccion>

      {forma === 'individual' ? children : (
        <PanelMasivoRenovacion tipo="renovacion" companiaId={compania.companiaId} faltaCompania={compania.faltante} onEnCurso={alEnCurso} />
      )}

      {confirmar && (
        <FlitModal title="¿Salir de la carga en masa?" onClose={() => setConfirmar(false)}>
          <div className="space-y-3 text-sm">
            <p>El procesamiento continúa en FLITO, pero no podrá volver a ver este avance.</p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
              <button type="button" className={`${flitBtnSecondary} justify-center`} style={flitBtnSecondaryStyle}
                onClick={() => setConfirmar(false)}>Quedarme</button>
              <button type="button" className={`${flitBtnPrimary} justify-center`} style={flitBtnPrimaryStyle}
                onClick={() => { setConfirmar(false); setForma('individual'); }}>Salir</button>
            </div>
          </div>
        </FlitModal>
      )}
    </>
  );
}
