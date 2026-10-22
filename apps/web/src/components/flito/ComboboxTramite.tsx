// FLITO — combobox de trámite del panel de asociación (HU #12634, UX slim §2 y wireframe).
//
// Un solo control: el `<input role="combobox">` escribe y elige. La lista va EN FLUJO (empuja
// «Concepto» hacia abajo mientras está abierta; una lista flotante se recorta dentro de la columna
// con `overflow-auto`). Del precedente `FlitOrganismoCombobox` se calca el teclado (↓/↑ con tope,
// Enter elige, Esc cierra la lista y PARA la propagación para que el `useEscape` del modal no lo
// cierre), el `ul role="listbox"` y la fila de dos renglones; no se copia el botón disparador, el
// `<button>` dentro del `li`, la lista `absolute` ni el listener global de `mousedown`.
//
// Sugeridos primero (chip «Sugerido · por {llave}», filtrados en cliente por lo escrito), debajo lo
// que devuelve `POST /tramites/buscar` con ≥ 3 caracteres tras 300 ms; la respuesta que llega tarde
// se descarta (último texto gana). Sin `comprobantes.tramites.buscar` NO se llama nunca al
// buscador: escribir ≥ 3 caracteres pinta el copy del 403 (AC7) con 0 POST.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { CONCEPTO_COSTO_LABEL, type CandidatoTramiteDto, type ConceptoCosto } from '@operaciones/shared-types';
import {
  ADMISION_LABEL, BUSCAR_MAX, BUSCAR_MIN, buscarTramites, coincideCandidato, errorComprobante, type LlaveSugerido,
} from '../../lib/comprobantes';
import { useDebounce } from '../../lib/useDebounce';
import StatusChip from '../flit/StatusChip';
import { flitInp } from '../flit/flitPageKit';

const PELIGRO = { color: 'var(--flit-danger-ink)' } as const;

export const COPY_SIN_FUNCION_BUSCAR = 'Tu usuario no puede buscar trámites: solo puedes elegir uno de los sugeridos. Pídele a un administrador la función “Buscar trámites para un comprobante”.';
export const COPY_SIN_SUGERIDOS = 'Ningún trámite coincide con lo leído. Busca por ID FLIT, placa o VIN.';
export const COPY_ERROR_BUSCAR = 'No se pudo buscar. Vuelve a intentarlo.';

export type Sugerido = { candidato: CandidatoTramiteDto; llave: LlaveSugerido | null };

type Busqueda =
  | { estado: 'inactiva' }
  | { estado: 'buscando' }
  | { estado: 'lista'; texto: string; resultados: CandidatoTramiteDto[] }
  | { estado: 'error'; texto: string };

export default function ComboboxTramite({ inputId, sugeridos, elegido, onElegir, concepto, puedeBuscar, abrirAlMontar, inputRef, invalido, errorId }: {
  /** El `<label for>` visible «Trámite» vive en el panel. */
  inputId: string;
  sugeridos: readonly Sugerido[];
  elegido: CandidatoTramiteDto | null;
  onElegir: (c: CandidatoTramiteDto | null) => void;
  /** Para la 2.ª línea `{Concepto}: {admisión}`; sin concepto elegido solo `tipoTramite · empresa`. */
  concepto: ConceptoCosto | null;
  puedeBuscar: boolean;
  /** D-1: con `tramite = null` y candidatos, el campo arranca vacío con la lista abierta. */
  abrirAlMontar: boolean;
  inputRef: RefObject<HTMLInputElement>;
  invalido: boolean;
  errorId: string;
}) {
  const id = useId();
  const listboxId = `${id}-listbox`;
  const [texto, setTexto] = useState('');
  const [abierta, setAbierta] = useState(abrirAlMontar);
  const [activo, setActivo] = useState(0);
  const [busqueda, setBusqueda] = useState<Busqueda>({ estado: 'inactiva' });
  const diferido = useDebounce(texto, 300);
  const peticion = useRef(0);

  const buscable = texto.trim().length >= BUSCAR_MIN;

  useEffect(() => {
    const t = diferido.trim();
    if (!puedeBuscar || elegido || t.length < BUSCAR_MIN) { setBusqueda({ estado: 'inactiva' }); return undefined; }
    const n = ++peticion.current;
    setBusqueda({ estado: 'buscando' });
    buscarTramites(t)
      .then((r) => { if (n === peticion.current) setBusqueda({ estado: 'lista', texto: t, resultados: r.candidatos }); })
      .catch((e) => {
        if (n !== peticion.current) return;
        const err = errorComprobante(e);
        setBusqueda({ estado: 'error', texto: err?.status === 400 ? err.error : COPY_ERROR_BUSCAR });
      });
    return undefined;
  }, [diferido, puedeBuscar, elegido]);

  const sugeridosVisibles = sugeridos.filter((s) => coincideCandidato(s.candidato, texto));
  const idsSugeridos = new Set(sugeridos.map((s) => s.candidato.tramiteId));
  const resultados = busqueda.estado === 'lista' && busqueda.texto === texto.trim()
    ? busqueda.resultados.filter((c) => !idsSugeridos.has(c.tramiteId))
    : [];
  const opciones: Sugerido[] = [...sugeridosVisibles, ...resultados.map((candidato) => ({ candidato, llave: null }))];
  const hayLista = abierta && !elegido && opciones.length > 0;
  const idOpcion = (i: number) => `${id}-opt-${i}`;

  useEffect(() => { if (activo >= opciones.length) setActivo(0); }, [opciones.length, activo]);

  const elegir = (c: CandidatoTramiteDto) => { onElegir(c); setTexto(''); setAbierta(false); setBusqueda({ estado: 'inactiva' }); };
  const quitar = () => { onElegir(null); setTexto(''); setAbierta(true); setActivo(0); requestAnimationFrame(() => inputRef.current?.focus()); };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (elegido) {
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); quitar(); }
      return;
    }
    if (e.key === 'Escape') {
      // Sin lista visible no se intercepta: llega al modal y lo cierra (slim §2).
      if (!hayLista) return;
      e.preventDefault(); e.stopPropagation(); setAbierta(false);
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!abierta) setAbierta(true); else setActivo((a) => Math.min(a + 1, Math.max(0, opciones.length - 1))); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActivo((a) => Math.max(a - 1, 0)); return; }
    if (e.key === 'Enter' && hayLista && opciones[activo]) { e.preventDefault(); elegir(opciones[activo].candidato); }
  };

  const valor = elegido ? `${elegido.idFlit}${elegido.placa ? ` · ${elegido.placa}` : ''}` : texto;
  const sinFuncionAlEscribir = !puedeBuscar && buscable && !elegido;

  return (
    <div className="space-y-1">
      <div className="relative">
        <input
          ref={inputRef}
          id={inputId}
          role="combobox"
          className={`${flitInp} ${elegido ? 'pr-10' : ''}`}
          value={valor}
          readOnly={!!elegido}
          maxLength={BUSCAR_MAX}
          placeholder={sugeridos.length ? 'Elige un trámite sugerido o busca por ID FLIT, placa o VIN' : 'ID FLIT, placa o VIN'}
          autoComplete="off"
          aria-required="true"
          aria-invalid={invalido || undefined}
          aria-describedby={invalido ? errorId : undefined}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-expanded={hayLista}
          aria-controls={hayLista ? listboxId : undefined}
          aria-activedescendant={hayLista && opciones[activo] ? idOpcion(activo) : undefined}
          onChange={(e) => { setTexto(e.target.value); setAbierta(true); setActivo(0); }}
          onFocus={() => { if (!elegido) setAbierta(true); }}
          onBlur={() => setAbierta(false)}
          onKeyDown={onKeyDown}
        />
        {elegido && (
          <button type="button" aria-label="Quitar trámite" onClick={quitar}
            className="flit-focus absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-base leading-none"
            style={{ color: 'var(--flit-text-muted)' }}>
            ✕
          </button>
        )}
      </div>

      {sinFuncionAlEscribir && <p role="alert" className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{COPY_SIN_FUNCION_BUSCAR}</p>}
      {!elegido && busqueda.estado === 'buscando' && <p role="status" aria-live="polite" className="text-xs">Buscando…</p>}
      {!elegido && busqueda.estado === 'error' && <p role="alert" className="text-xs" style={PELIGRO}>{busqueda.texto}</p>}
      {!elegido && busqueda.estado === 'lista' && opciones.length === 0 && (
        <p role="status" aria-live="polite" className="text-xs">Ningún trámite coincide con «{busqueda.texto}».</p>
      )}
      {!elegido && !sugeridos.length && !buscable && puedeBuscar && busqueda.estado === 'inactiva' && (
        <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{COPY_SIN_SUGERIDOS}</p>
      )}

      {hayLista && (
        <ul id={listboxId} role="listbox" aria-label="Trámites" className="max-h-52 overflow-auto rounded-lg border bg-flit-card py-1"
          style={{ borderColor: 'var(--flit-border-input)' }}>
          {opciones.map((o, i) => {
            const c = o.candidato;
            const esActivo = i === activo;
            const admision = concepto ? c.admite?.[concepto] : undefined;
            return (
              <li key={c.tramiteId} id={idOpcion(i)} role="option" aria-selected={esActivo}
                onMouseEnter={() => setActivo(i)} onMouseDown={(e) => { e.preventDefault(); elegir(c); }}
                className="cursor-pointer border-b px-3 py-2 text-sm last:border-0"
                style={{ borderColor: 'var(--flit-border-soft)', color: 'var(--flit-text-primary)', background: esActivo ? 'var(--flit-bg-app)' : undefined }}>
                <span className="flex flex-wrap items-center gap-2">
                  {(o.llave || idsSugeridos.has(c.tramiteId)) && <StatusChip tone="active">{o.llave ? `Sugerido · por ${o.llave}` : 'Sugerido'}</StatusChip>}
                  <span className="font-medium">{c.idFlit}{c.placa ? ` · ${c.placa}` : ''}</span>
                </span>
                <span className="flex items-center justify-between gap-2 text-[10px]" style={{ color: 'var(--flit-text-secondary)' }}>
                  <span className="truncate">{[c.tipoTramite, c.empresa].filter(Boolean).join(' · ') || '—'}</span>
                  {concepto && admision && <span className="shrink-0">{CONCEPTO_COSTO_LABEL[concepto]}: {ADMISION_LABEL[admision]}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
