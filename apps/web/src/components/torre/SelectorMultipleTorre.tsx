// Torre de Control (Épica #14590) — selector múltiple de la barra (spec UX §3.3) sobre `FlitComboboxBuscable` en modo
// `multiple`. Aquí vive lo que el kit no decide: la búsqueda local (sin tildes, en cualquier parte), el tope de opciones
// visibles, el texto del botón («A y 2 más») y CUÁNDO aplica la selección: `aplicarAlCerrar` (Compañía en la barra:
// una sola consulta al cerrar) o en cada casilla (dentro de «Más filtros», que ya va a un borrador).
import { useId, useState } from 'react';
import FlitComboboxBuscable, { type OpcionBuscable } from '../flit/FlitComboboxBuscable';
import { listaY, resumenSeleccion } from './formatoTorre';

const sinTildes = (v: string) => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export interface OpcionMultiple { valor: string; etiqueta: string; detalle?: string }

export default function SelectorMultipleTorre({
  label, valor, opciones, onCambio, aplicarAlCerrar = false, todas, sustantivo, elegidas,
  busquedaMinima = 1, maxVisibles, textoTruncado, cargando = false, fallo = false, onReintentar,
}: {
  label: string;
  valor: readonly string[];
  /** En orden alfabético (lo elegido no salta arriba). */
  opciones: readonly OpcionMultiple[];
  onCambio: (valores: string[]) => void;
  aplicarAlCerrar?: boolean;
  /** «Todas las compañías», «Todos los organismos»… */
  todas: string;
  /** Para «Ninguna compañía coincide…»: «Ninguna compañía», «Ningún organismo»… */
  sustantivo: string;
  /** «3 elegidas» / «3 elegidos». */
  elegidas: (n: number) => string;
  /** Letras desde las que el buscador filtra (OT: 2, regla de `FlitOrganismoCombobox`). */
  busquedaMinima?: number;
  maxVisibles?: number;
  textoTruncado?: string;
  cargando?: boolean;
  fallo?: boolean;
  onReintentar?: () => void;
}) {
  const id = useId();
  const idMensaje = `${id}-mensaje`;
  const [abierto, setAbierto] = useState(false);
  const [texto, setTexto] = useState('');
  const [borrador, setBorrador] = useState<readonly string[]>(valor);
  const seleccion = aplicarAlCerrar && abierto ? borrador : valor;

  const abrirCerrar = (v: boolean) => {
    if (v) { setBorrador(valor); setTexto(''); }
    else if (aplicarAlCerrar && abierto) {
      const cambio = borrador.length !== valor.length || borrador.some((x) => !valor.includes(x));
      if (cambio) onCambio([...borrador]);
    }
    setAbierto(v);
  };
  const cambiar = (ids: string[]) => { if (aplicarAlCerrar) setBorrador(ids); else onCambio(ids); };

  const q = sinTildes(texto.trim());
  const filtradas = q.length >= busquedaMinima ? opciones.filter((o) => sinTildes(o.etiqueta).includes(q)) : opciones;
  const visibles = maxVisibles ? filtradas.slice(0, maxVisibles) : filtradas;
  const lista: OpcionBuscable[] = visibles.map((o) => ({ id: o.valor, principal: o.etiqueta, detalle: o.detalle }));

  const nombres = seleccion.map((v) => opciones.find((o) => o.valor === v)?.etiqueta ?? v);
  const mensaje = fallo ? 'No pudimos cargar las opciones de los filtros.' : cargando ? 'Cargando las opciones…' : null;

  return (
    <div className="min-w-0" data-torre-selector={label}>
      <label htmlFor={id} className="mb-1.5 block text-[0.8125rem] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{label}</label>
      <FlitComboboxBuscable
        id={id}
        etiquetaSeleccion={cargando ? 'Cargando las opciones…' : nombres.length ? resumenSeleccion(nombres) : todas}
        placeholder={todas}
        seleccionadoId={null}
        onElegir={() => {}}
        abierto={abierto}
        onAbiertoChange={abrirCerrar}
        texto={texto}
        onTextoChange={setTexto}
        estado={cargando ? 'cargando' : fallo ? 'error' : 'lista'}
        opciones={lista}
        truncado={visibles.length < filtradas.length}
        onReintentar={onReintentar ?? (() => {})}
        disabled={cargando || fallo}
        describedBy={mensaje ? idMensaje : undefined}
        placeholderBusqueda="Buscar…"
        ariaLabelBusqueda={`Buscar en ${label.toLowerCase()}`}
        ariaLabelLista={label}
        ariaLabelTrigger={nombres.length > 1 ? `${label}: ${listaY(nombres)}` : undefined}
        copy={{
          pista: '', cargando: 'Cargando las opciones…', error: 'No pudimos cargar las opciones de los filtros.',
          sinResultados: `${sustantivo} coincide con «${texto.trim()}».`,
          anuncio: (n) => `${n} ${n === 1 ? 'opción' : 'opciones'}. Espacio o Enter para marcar.`,
          truncado: textoTruncado ?? 'Escriba para acotar: hay más opciones.',
        }}
        multiple={{
          seleccionados: seleccion, onCambio: cambiar, opcionTodas: todas, rotuloElegidas: elegidas,
          conBusqueda: opciones.length > 10,
        }}
      />
      {mensaje && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
          <span id={idMensaje} role="status" style={{ color: fallo ? 'var(--flit-danger-text)' : 'var(--flit-text-secondary)' }}>{mensaje}</span>
          {fallo && onReintentar && (
            <button type="button" onClick={onReintentar}
              className="flit-focus rounded-[999px] border bg-flit-card px-2 py-0.5 text-xs font-medium transition-colors hover:bg-[var(--flit-bg-hover)]"
              style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>
              Volver a cargar las opciones
            </button>
          )}
        </div>
      )}
    </div>
  );
}
