// HU #14134 (AC1) / #14137 (AC1) — selector «Individual / Masiva» de la solicitud de SOAT, con AMBOS
// tipos: la plantilla la decide el «Tipo de SOAT» ya elegido (no hay selector nuevo).
//
// Punto de montaje único en `FlitoSoatSolicitud.tsx` (render-prop): si no hay tipo o la
// forma es Individual devuelve `children` (el formulario actual, sin tocarlo); si es Masiva pinta el
// panel y NO monta `children` (así tampoco aparece la barra de envío). El estado de los campos
// individuales vive en la página, por lo que alternar no pierde lo digitado.
import { useCallback, useState, type ReactNode } from 'react';
import { Icono } from '../../../flit/kit/Icono';
import { TipoSoat } from '@operaciones/shared-types';
import FlitModal from '../../../flit/FlitModal';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../../../flit/flitPageKit';
import { claseBoton } from '../../../flit/GradientButton';
import type { CompaniaSoat } from '../CampoCompaniaSoat';
import { Seccion } from '../bloques';
import PanelMasivoRenovacion from './PanelMasivoRenovacion';
import type { TipoMasivo } from './tiposMasivo';

type Forma = 'individual' | 'masiva';

const TEXTO_MASIVA: Record<TipoMasivo, string> = {
  renovacion: 'Hasta 200 renovaciones desde un Excel',
  inicial: 'Hasta 200 vehículos desde un Excel',
};

export default function ModalidadRenovacion({ tipo, compania, onMasivoEnCurso, children }: {
  tipo: TipoSoat | null;
  compania: CompaniaSoat;
  /** La página lo usa para pedir confirmación antes de cambiar de tipo con un lote en curso. */
  onMasivoEnCurso?: (enCurso: boolean) => void;
  children: ReactNode;
}) {
  const [forma, setForma] = useState<Forma>('individual');
  const [enCurso, setEnCurso] = useState(false);
  const [confirmar, setConfirmar] = useState(false);
  const alEnCurso = useCallback((v: boolean) => { setEnCurso(v); onMasivoEnCurso?.(v); }, [onMasivoEnCurso]);

  if (tipo === null) return <>{children}</>;
  const tipoMasivo: TipoMasivo = tipo === TipoSoat.RENOVACION ? 'renovacion' : 'inicial';
  const opciones = [
    { forma: 'individual' as Forma, titulo: 'Individual', texto: 'Un vehículo' },
    { forma: 'masiva' as Forma, titulo: 'Masiva', texto: TEXTO_MASIVA[tipoMasivo] },
  ];

  const elegir = (f: Forma) => {
    if (f === forma) return;
    if (f === 'individual' && enCurso) { setConfirmar(true); return; }
    setForma(f);
  };

  return (
    <>
      <Seccion titulo="Forma de cargar" icono={<Icono nombre="lista" size={18} className="shrink-0" />}>
        <div role="radiogroup" aria-label="Forma de cargar" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {opciones.map((o) => {
            const marcada = forma === o.forma;
            return (
              <div
                key={o.forma}
                className="relative flex min-h-[44px] items-start gap-3 rounded-[9px] p-4 transition-colors hover:bg-[var(--kit-hover)] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--kit-azul)]"
                style={{
                  border: marcada ? '2px solid var(--color-action)' : '1px solid var(--color-border)',
                  background: marcada ? 'var(--color-surface)' : undefined,
                  padding: marcada ? 'calc(1rem - 1px)' : undefined,
                }}
              >
                <input
                  id={`forma-${o.forma}`} type="radio" name="forma-cargar" value={o.forma} checked={marcada}
                  aria-describedby={`forma-${o.forma}-desc`} onChange={() => elegir(o.forma)}
                  className="relative z-10 mt-1 h-4 w-4 shrink-0 cursor-pointer accent-[var(--color-action)] outline-none"
                />
                <div className="min-w-0 space-y-1">
                  <label htmlFor={`forma-${o.forma}`} className="block cursor-pointer text-sm font-semibold after:absolute after:inset-0 after:content-['']"
                    style={{ color: 'var(--color-text-primary)' }}>{o.titulo}</label>
                  <p id={`forma-${o.forma}-desc`} className="text-xs text-[color:var(--color-text-secondary)]">{o.texto}</p>
                </div>
              </div>
            );
          })}
        </div>
      </Seccion>

      {forma === 'individual' ? children : (
        <PanelMasivoRenovacion key={tipoMasivo} tipo={tipoMasivo} companiaId={compania.companiaId} faltaCompania={compania.faltante} onEnCurso={alEnCurso} />
      )}

      {confirmar && (
        <FlitModal title="¿Salir de la carga en masa?" icono="alerta" onClose={() => setConfirmar(false)}>
          <div className="space-y-3 text-sm">
            <p>El procesamiento continúa en FLITO, pero no podrá volver a ver este avance.</p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
              <button type="button" className={`${flitBtnSecondary} justify-center`} style={flitBtnSecondaryStyle}
                onClick={() => setConfirmar(false)}>Quedarme</button>
              <button type="button" data-variante="alerta" className={claseBoton('alerta', 'md', 'justify-center')}
                onClick={() => { setConfirmar(false); setForma('individual'); }}>Salir</button>
            </div>
          </div>
        </FlitModal>
      )}
    </>
  );
}
