// FLITO Logística — «Ingresar a mano» (HU #14111, decisión de David). Formulario a pantalla completa con
// SOLO tres datos: placa, N.º de licencia de tránsito (frente) y N.º de sustrato (reverso, empieza por «LT»).
// Al escribir la placa se consulta el vehículo (`POST /consultar-vehiculo`, placa en el BODY) y se muestra una
// tarjeta de solo lectura para confirmar que es el vehículo. Nada de esto va a la URL, consola ni almacenamiento.

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { api } from '../../../lib/api';
import ModalPortal from '../../flit/ModalPortal';
import { FlitField, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitInp } from '../../flit/flitPageKit';
import { mensajeConsulta, type Candidato, type DatosManual, type RespuestaConsulta } from './recogidaTipos';

type Consulta = { fase: 'inicio' } | { fase: 'cargando' } | { fase: 'sin' } | { fase: 'error'; texto: string } | { fase: 'ok'; candidatos: Candidato[] };

const PLACA_OK = /^[A-Z0-9]{5,7}$/;
const limpiaPlaca = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);
const sustratoOk = (v: string) => /^LT/i.test(v.trim()) && v.trim().length > 2;

interface Props {
  /** Registra la LT; devuelve un texto de error (el formulario sigue abierto) o null si salió bien. */
  onAgregar: (datos: DatosManual, candidato: Candidato | undefined) => Promise<string | null>;
  onCerrar: () => void;
}

export default function IngresoManual({ onAgregar, onCerrar }: Props) {
  const [placa, setPlaca] = useState('');
  const [licencia, setLicencia] = useState('');
  const [sustrato, setSustrato] = useState('');
  const [consulta, setConsulta] = useState<Consulta>({ fase: 'inicio' });
  const [tocoSustrato, setTocoSustrato] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [errorEnvio, setErrorEnvio] = useState<string | null>(null);
  const ultima = useRef('');
  const placaRef = useRef<HTMLInputElement>(null);

  useEffect(() => { placaRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCerrar(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCerrar]);

  const consultar = async (p: string) => {
    if (!PLACA_OK.test(p) || p === ultima.current) return;
    ultima.current = p;
    setConsulta({ fase: 'cargando' });
    try {
      const r = await api.post<RespuestaConsulta>('/flito/logistica/consultar-vehiculo', { placa: p });
      if (ultima.current !== p) return;
      setConsulta(r.encontrado ? { fase: 'ok', candidatos: r.candidatos } : { fase: 'sin' });
    } catch (e) {
      if (ultima.current !== p) return;
      ultima.current = ''; // permite reintentar la misma placa
      setConsulta({ fase: 'error', texto: mensajeConsulta(e) });
    }
  };
  // Consulta al dejar de escribir (700 ms) y al salir del campo.
  useEffect(() => {
    if (!PLACA_OK.test(placa)) { ultima.current = ''; setConsulta({ fase: 'inicio' }); return; }
    const t = setTimeout(() => { void consultar(placa); }, 700);
    return () => clearTimeout(t);
  }, [placa]);

  const encontrado = consulta.fase === 'ok';
  const unico = consulta.fase === 'ok' && consulta.candidatos.length === 1 ? consulta.candidatos[0] : null;
  const sustratoError = tocoSustrato && sustrato.trim() !== '' && !sustratoOk(sustrato);
  const completo = PLACA_OK.test(placa) && licencia.trim().length > 0 && sustratoOk(sustrato) && encontrado;

  const agregar = async () => {
    if (!completo || enviando) return;
    setEnviando(true); setErrorEnvio(null);
    const err = await onAgregar({ placa, numeroLicencia: licencia.trim(), numeroLt: sustrato.trim().toUpperCase() }, unico ?? undefined);
    setEnviando(false);
    if (err) setErrorEnvio(err);
  };

  return (
    <ModalPortal>
    <div role="dialog" aria-modal="true" aria-labelledby="manual-titulo" className="fixed inset-0 z-50 flex flex-col overflow-y-auto"
      style={{ background: 'var(--flit-bg-app)', color: 'var(--flit-text-primary)' }}>
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 p-3">
        <header className="flex items-center gap-2">
          <button type="button" onClick={onCerrar}
            className="flit-focus -ml-1 inline-flex items-center gap-1 rounded-lg px-2 py-2 text-sm font-medium transition-colors hover:bg-[var(--flit-bg-hover)]"
            style={{ color: 'var(--flit-text-secondary)', minHeight: 44 }}>
            <ChevronLeft size={18} aria-hidden="true" /> Atrás
          </button>
          <h2 id="manual-titulo" className="text-lg font-bold" style={{ color: 'var(--flit-blue-text)' }}>Ingresar a mano</h2>
        </header>
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          Escribe estos tres datos de la licencia de tránsito. No hace falta el código de barras.
        </p>

        <div className="space-y-3">
          <FlitField label="Placa">
            <input ref={placaRef} className={`${flitInp} uppercase tabular-nums`} value={placa} autoComplete="off" autoCapitalize="characters" spellCheck={false}
              onChange={(e) => setPlaca(limpiaPlaca(e.target.value))} onBlur={() => void consultar(placa)} aria-describedby="manual-consulta" />
          </FlitField>
          <div id="manual-consulta" aria-live="polite">
            {consulta.fase === 'cargando' && <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Buscando el vehículo…</p>}
            {consulta.fase === 'sin' && (
              <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>Esta placa no coincide con ningún trámite.</p>
            )}
            {consulta.fase === 'error' && (
              <div role="alert" className="flex flex-wrap items-center gap-2 text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
                <span>{consulta.texto}</span>
                <button type="button" className={`${flitBtnSecondary} text-xs`} style={{ minHeight: 40 }} onClick={() => void consultar(placa)}>Reintentar</button>
              </div>
            )}
            {consulta.fase === 'ok' && <TarjetaVehiculo candidatos={consulta.candidatos} />}
          </div>

          <FlitField label="N.º de licencia de tránsito (frente)">
            <input className={`${flitInp} tabular-nums`} value={licencia} inputMode="numeric" autoComplete="off"
              onChange={(e) => setLicencia(e.target.value.replace(/\s/g, ''))} />
          </FlitField>
          <div>
            <FlitField label="N.º de sustrato (reverso)">
              <input className={`${flitInp} uppercase tabular-nums`} value={sustrato} autoComplete="off" autoCapitalize="characters" spellCheck={false}
                aria-invalid={sustratoError} aria-describedby="manual-sustrato-ayuda"
                onChange={(e) => setSustrato(e.target.value.toUpperCase().replace(/\s/g, ''))} onBlur={() => setTocoSustrato(true)} />
            </FlitField>
            <p id="manual-sustrato-ayuda" className="mt-1 text-xs" style={{ color: sustratoError ? 'var(--flit-danger-ink)' : 'var(--flit-text-muted)' }}>
              {sustratoError ? 'El N.º de sustrato empieza siempre por LT. Revísalo en el reverso.' : 'Está en el reverso y empieza por LT.'}
            </p>
          </div>
        </div>

        {errorEnvio && <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{errorEnvio}</p>}

        <div className="sticky bottom-0 mt-auto pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2" style={{ background: 'var(--flit-bg-app)' }}>
          <button type="button" className={`${flitBtnPrimary} w-full justify-center`} style={{ ...flitBtnPrimaryStyle, minHeight: 48 }}
            disabled={!completo || enviando} onClick={() => void agregar()}>
            {enviando ? 'Agregando…' : 'Agregar LT'}
          </button>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}

function TarjetaVehiculo({ candidatos }: { candidatos: Candidato[] }) {
  const c = candidatos[0];
  const v = c.vehiculo;
  const vehiculo = [v?.marca, v?.linea, v?.modelo].filter((x) => x != null && x !== '').join(' ');
  return (
    <section aria-label="Confirma que es el vehículo" className="space-y-1 rounded-xl border bg-flit-card p-3.5" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <h3 className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Confirma que es el vehículo</h3>
      {candidatos.length > 1 ? (
        <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
          Esta placa tiene {candidatos.length} trámites. Al agregar la LT elegirás a cuál corresponde.
        </p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt style={{ color: 'var(--flit-text-muted)' }}>VIN</dt><dd className="break-all tabular-nums">{c.vin ?? '—'}</dd>
          <dt style={{ color: 'var(--flit-text-muted)' }}>Organismo</dt><dd>{c.organismoNombre ?? c.organismoCodigo ?? '—'}</dd>
          <dt style={{ color: 'var(--flit-text-muted)' }}>Vehículo</dt><dd>{vehiculo || '—'}</dd>
        </dl>
      )}
    </section>
  );
}
