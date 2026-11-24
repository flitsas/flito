// Torre de Control (Épica #14590) — coincidencias de placa mientras se escribe (spec UX §6, ADR-0044 D4/D8).
//
// La placa viaja SOLO en el cuerpo de `POST /flito/torre/placa/sugerencias` (regla 14, RN-TOR-P6): nunca en la URL,
// en sessionStorage, en el historial ni en la consola. Desde 3 caracteres consulta a los 250 ms sin teclear y gana la
// última respuesta (RN-TOR-P7). La lista es presentacional y lleva la piel de `FlitComboboxBuscable`; el teclado y el
// `role="combobox"` del input los pone `PanelFiltros` (prop `combobox`) y los maneja `BarraFiltrosTorre`.
import { useEffect, useRef, useState } from 'react';
import { SUGERENCIAS_PLACA_TORRE, type SugerenciaPlacaTorre, type SugerenciasPlacaTorre } from '@operaciones/shared-types';
import { api } from '../../lib/api';
import { EtiquetaEstado } from '../flit/Bloques';
import { humanizar } from './formatoTorre';

/** Normaliza la placa: mayúsculas y sin espacios ni guiones. */
export const normalizarPlaca = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');

export type EstadoSugerencias = 'cerrada' | 'pista' | 'cargando' | 'error' | 'lista';

const { MIN_CARACTERES, MAX_CARACTERES } = SUGERENCIAS_PLACA_TORRE;
const DEBOUNCE_MS = 250;

/** Estado de las coincidencias para el texto (crudo) del buscador. */
export function useSugerenciasPlaca(textoCrudo: string) {
  const texto = normalizarPlaca(textoCrudo);
  const consulta = texto.length >= MIN_CARACTERES && texto.length <= MAX_CARACTERES;
  const [datos, setDatos] = useState<SugerenciasPlacaTorre | null>(null);
  const [cargando, setCargando] = useState(false);
  const [fallo, setFallo] = useState(false);
  const [intento, setIntento] = useState(0);
  const ultima = useRef(0);

  useEffect(() => {
    const id = ++ultima.current;
    if (!consulta) { setCargando(false); setFallo(false); setDatos(null); return undefined; }
    setCargando(true);
    setFallo(false);
    const t = setTimeout(() => {
      api.post<SugerenciasPlacaTorre>('/flito/torre/placa/sugerencias', { texto })
        .then((d) => { if (id === ultima.current) { setDatos(d); setCargando(false); } })
        // Sin el error crudo (ni la placa) en ningún lado: la lista muestra su propio texto.
        .catch(() => { if (id === ultima.current) { setFallo(true); setCargando(false); } });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [texto, consulta, intento]);

  const estado: EstadoSugerencias = texto.length === 0 || texto.length > MAX_CARACTERES ? 'cerrada'
    : texto.length < MIN_CARACTERES ? 'pista'
      : fallo ? 'error'
        // Si ya hay una lista, se queda a la vista hasta que llega la nueva.
        : cargando && !datos ? 'cargando' : 'lista';
  return {
    texto, estado, buscando: cargando,
    sugerencias: estado === 'lista' ? datos?.sugerencias ?? [] : [],
    hayMas: estado === 'lista' && !!datos?.hayMas,
    reintentar: () => setIntento((n) => n + 1),
  };
}

/** La placa con la parte que coincide en `<strong>` (peso, no color). */
function PlacaResaltada({ placa, texto }: { placa: string; texto: string }) {
  const i = texto ? placa.indexOf(texto) : -1;
  if (i < 0) return <>{placa}</>;
  return <>{placa.slice(0, i)}<strong className="font-bold">{placa.slice(i, i + texto.length)}</strong>{placa.slice(i + texto.length)}</>;
}

const TACTIL = 'min-h-[44px] lg:min-h-10';

export const nombreSugerencia = (s: SugerenciaPlacaTorre) =>
  [s.placa, s.compania ?? 'Sin compañía', s.flitEstado ? humanizar(s.flitEstado) : null].filter(Boolean).join(' · ');

export default function ListaSugerenciasPlaca({
  visible, listboxId, idOpcion, estado, texto, buscando, sugerencias, hayMas, activo, onResaltar, onElegir, onReintentar,
}: {
  visible: boolean;
  listboxId: string;
  idOpcion: (i: number) => string;
  estado: EstadoSugerencias;
  texto: string;
  buscando: boolean;
  sugerencias: readonly SugerenciaPlacaTorre[];
  hayMas: boolean;
  activo: number;
  onResaltar: (i: number) => void;
  onElegir: (s: SugerenciaPlacaTorre) => void;
  onReintentar: () => void;
}) {
  const conLista = visible && estado === 'lista' && sugerencias.length > 0;
  const n = sugerencias.length;
  const anuncio = !visible ? ''
    : estado === 'pista' ? 'Escriba al menos 3 caracteres para ver coincidencias.'
      : estado === 'cargando' || buscando ? 'Buscando coincidencias…'
        : estado === 'lista' ? (n === 0 ? `Ninguna placa contiene «${texto}». Revise que esté bien escrita.`
          : `${n} ${n === 1 ? 'coincidencia' : 'coincidencias'}. Use las flechas para elegir.`)
          : '';
  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">{anuncio}</p>
      <div className={visible ? 'absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-[9px] border bg-[var(--color-surface-elevated)]' : 'hidden'}
        style={{ borderColor: 'var(--color-border-control)', boxShadow: 'var(--kit-sombra)' }}
        data-torre="sugerencias-placa" data-estado={visible ? estado : 'cerrada'}
        // El input no pierde el foco al pulsar dentro de la lista (opciones y «Reintentar»).
        onMouseDown={(e) => e.preventDefault()}>
        {visible && estado === 'pista' && (
          <p className="px-3 py-3 text-xs" style={{ color: 'var(--color-text-secondary)' }}>Escriba al menos 3 caracteres para ver coincidencias.</p>
        )}
        {visible && estado === 'cargando' && (
          <div aria-hidden className="space-y-3 px-3 py-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-1.5">
                <div className="h-3 w-2/5 rounded" style={{ background: 'var(--kit-hover)' }} />
                <div className="h-2.5 w-3/5 rounded" style={{ background: 'var(--kit-hover)' }} />
              </div>
            ))}
          </div>
        )}
        {visible && estado === 'error' && (
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm">
            <p role="alert" style={{ color: 'var(--kit-rojo-texto)' }}>No pudimos traer coincidencias. Puede escribir la placa completa y pulsar Enter.</p>
            <button type="button" onClick={onReintentar}
              className={`flit-focus rounded-[9px] px-2 text-sm font-medium underline-offset-2 transition-colors hover:bg-[color:var(--kit-hover)] hover:underline ${TACTIL}`}
              style={{ color: 'var(--color-action)' }}>
              Reintentar
            </button>
          </div>
        )}
        {visible && estado === 'lista' && n === 0 && !buscando && (
          <p className="px-3 py-3 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
            Ninguna placa contiene «{texto}». Revise que esté bien escrita.
          </p>
        )}
        <ul id={listboxId} role="listbox" aria-label="Coincidencias de placa" className={`max-h-[60vh] overflow-auto lg:max-h-80 ${conLista ? 'py-1' : 'hidden'}`}>
          {conLista && sugerencias.map((s, i) => (
            <li key={s.placa} id={idOpcion(i)} role="option" aria-selected={i === activo} aria-label={nombreSugerencia(s)}
              onMouseEnter={() => onResaltar(i)} onClick={() => onElegir(s)}
              className="flex min-h-[44px] cursor-pointer flex-col justify-center gap-0.5 border-b px-3 py-2 text-sm transition-colors last:border-0 lg:min-h-0"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-primary)', background: i === activo ? 'var(--kit-hover)' : undefined }}>
              <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                <span className="font-mono font-medium tracking-wide"><PlacaResaltada placa={s.placa} texto={texto} /></span>
                {s.flitEstado && <EtiquetaEstado estado={s.flitEstado}>{humanizar(s.flitEstado)}</EtiquetaEstado>}
              </span>
              <span className="truncate text-xs" style={{ color: 'var(--color-text-secondary)' }}>{s.compania ?? 'Sin compañía'}</span>
            </li>
          ))}
        </ul>
        {conLista && hayMas && (
          <p className="border-t px-3 py-2 text-xs" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}>
            Hay más coincidencias: siga escribiendo.
          </p>
        )}
      </div>
    </>
  );
}
