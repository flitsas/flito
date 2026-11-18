// Selector «Columnas» (ADR-0043): control de la barra de filtros (chip h-10 del kit) + panel flotante.
//
// Una sola cosa por panel: qué columnas se ven. Arriba la vista (sistema, mías, para todos), en medio
// las casillas en orden del catálogo (las fijas marcadas y deshabilitadas), abajo las acciones.
// La confirmación de borrar vive en el propio panel: nunca `confirm()`.
// Escape o un clic fuera cierran y devuelven el foco al botón.
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { claseBoton } from '../../flit/GradientButton';
import { flitInp } from '../../flit/flitPageKit';
import type { VistasColumnas } from './useVistasColumnas';

const MAX_NOMBRE = 60;
const ANCHO = 352; // 22rem
// Reserva inferior: el dock flotante de navegación tapa el pie de la ventana (~76 px + aire).
const RESERVA_DOCK = 104;
const RESERVA_TOPBAR = 72;
const MARGEN = 16;
const ALTO_COMODO = 360;

/** Caja fija pegada al botón, dentro de la ventana y por encima del dock (también a 360 px). */
function posicion(boton: HTMLElement): CSSProperties {
  const r = boton.getBoundingClientRect();
  const ancho = Math.min(ANCHO, window.innerWidth - 2 * MARGEN);
  const left = Math.max(MARGEN, Math.min(r.left, window.innerWidth - ancho - MARGEN));
  const abajo = window.innerHeight - r.bottom - 4 - RESERVA_DOCK;
  const arriba = r.top - 4 - RESERVA_TOPBAR;
  // Abre hacia abajo salvo que no quepa cómodo y arriba haya más sitio.
  // Superficie propia con tokens y no `.menu-flotante`: esa clase del kit es de listas de enlaces
  // (aplana los botones y fija `absolute`), y aquí hay casillas, un campo y acciones.
  const base: CSSProperties = { position: 'fixed', left, right: 'auto', width: ancho, minWidth: 0 };
  if (abajo >= ALTO_COMODO || abajo >= arriba) return { ...base, top: r.bottom + 4, bottom: 'auto', maxHeight: Math.max(200, abajo) };
  return { ...base, top: 'auto', bottom: window.innerHeight - r.top + 4, maxHeight: arriba };
}
const tenue = 'text-xs text-[color:var(--color-text-tertiary)]';
const fila = 'flex min-h-9 cursor-pointer items-center gap-2 rounded-[7px] px-2 text-sm transition-colors hover:bg-[var(--kit-hover)]';

export default function PanelColumnas({ vc, esAdmin }: { vc: VistasColumnas; esAdmin: boolean }) {
  const [abierto, setAbierto] = useState(false);
  const [modo, setModo] = useState<'normal' | 'nueva' | 'borrar'>('normal');
  const [nombre, setNombre] = useState('');
  const [paraTodos, setParaTodos] = useState(false);
  const [errNombre, setErrNombre] = useState<string | null>(null);
  const boton = useRef<HTMLButtonElement>(null);
  const caja = useRef<HTMLDivElement>(null);
  const idPanel = useId();
  const idNombre = useId();
  const [estilo, setEstilo] = useState<CSSProperties>({});

  // Se recoloca al abrir, al desplazar y al cambiar el tamaño de la ventana.
  useLayoutEffect(() => {
    if (!abierto || !boton.current) return;
    const colocar = () => { if (boton.current) setEstilo(posicion(boton.current)); };
    colocar();
    window.addEventListener('scroll', colocar, true);
    window.addEventListener('resize', colocar);
    return () => { window.removeEventListener('scroll', colocar, true); window.removeEventListener('resize', colocar); };
  }, [abierto]);

  const cerrar = (devolverFoco = true) => {
    setAbierto(false); setModo('normal'); setErrNombre(null);
    if (devolverFoco) boton.current?.focus();
  };

  useEffect(() => {
    if (!abierto) return;
    const tecla = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); cerrar(); } };
    const fuera = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!caja.current?.contains(t) && !boton.current?.contains(t)) cerrar(false);
    };
    document.addEventListener('keydown', tecla);
    document.addEventListener('mousedown', fuera);
    return () => { document.removeEventListener('keydown', tecla); document.removeEventListener('mousedown', fuera); };
  }, [abierto]);

  const { datos, estado, activa, ocupado } = vc;
  const personales = datos?.vistas.filter((v) => v.alcance === 'personal') ?? [];
  const generales = datos?.vistas.filter((v) => v.alcance === 'compartida') ?? [];
  const ocultas = vc.disponibles.filter((c) => !vc.marcadas.has(c.clave)).length;
  // Predeterminada personal: «(predeterminada)». General (vistas para todos): «(predeterminada para todos)».
  const marca = (id: number | null, general = false) =>
    id === vc.predeterminadaPersonalId && (id !== null || datos?.vistaActiva.origen === 'sistema') ? ' (predeterminada)'
      : general ? ' (predeterminada para todos)' : '';

  const guardarNueva = async () => {
    const n = nombre.trim();
    if (n.length < 1 || n.length > MAX_NOMBRE) { setErrNombre(`Escriba un nombre de 1 a ${MAX_NOMBRE} caracteres.`); return; }
    if (await vc.guardarNueva(n, esAdmin && paraTodos)) { setModo('normal'); setNombre(''); setParaTodos(false); }
  };

  return (
    <div className="relative">
      <button ref={boton} type="button" className={`chip flit-focus h-10 min-h-0 gap-2 text-sm transition-colors${ocultas > 0 ? ' filtro-activo' : ''}`}
        aria-expanded={abierto} aria-controls={abierto ? idPanel : undefined} aria-haspopup="dialog"
        onClick={() => (abierto ? cerrar() : setAbierto(true))}>
        Columnas
        {ocultas > 0 && <span className={tenue} aria-label={`${ocultas} ocultas`}>({ocultas} ocultas)</span>}
      </button>

      {abierto && (
        <div ref={caja} id={idPanel} role="dialog" aria-label="Columnas de la tabla"
          style={estilo} className="fixed z-40 flex flex-col gap-3 overflow-y-auto overscroll-contain rounded-[9px] border border-[color:var(--color-border)] bg-[var(--color-surface-elevated)] p-3 shadow-[var(--shadow-modal)]">
          {estado === 'cargando' && <p role="status" className="m-0 text-sm">Cargando vistas…</p>}

          {estado === 'error' && (
            <div role="status" className="flex flex-col gap-2">
              <p className="m-0 text-sm text-[color:var(--flit-danger-ink)]">No se pudieron cargar sus vistas. La tabla usa la vista del sistema.</p>
              <button type="button" className={claseBoton('secondary', 'sm')} onClick={vc.recargar}>Reintentar</button>
            </div>
          )}

          {estado === 'listo' && datos && (
            <>
              <label className="flex flex-col gap-1 text-xs font-semibold text-[color:var(--color-text-secondary)]">
                Vista
                <select className={flitInp} disabled={ocupado} value={vc.elegidaId ?? ''}
                  onChange={(e) => vc.elegir(e.target.value === '' ? null : Number(e.target.value))}>
                  <option value="">Vista del sistema{marca(null)}</option>
                  {personales.length > 0 && (
                    <optgroup label="Mis vistas">
                      {personales.map((v) => <option key={v.id} value={v.id}>{v.nombre}{marca(v.id)}</option>)}
                    </optgroup>
                  )}
                  {generales.length > 0 && (
                    <optgroup label="Vistas para todos">
                      {generales.map((v) => <option key={v.id} value={v.id}>{v.nombre}{marca(v.id, v.esPredeterminada)}</option>)}
                    </optgroup>
                  )}
                </select>
              </label>
              {datos.vistas.length === 0 && (
                <p className={`m-0 ${tenue}`}>Aún no tiene vistas guardadas. Marque las columnas que quiere ver y use «Guardar como nueva vista».</p>
              )}

              <p id={`${idPanel}-cols`} className="m-0 -mb-2 text-xs font-semibold text-[color:var(--color-text-secondary)]">Columnas visibles</p>
              <div role="group" aria-labelledby={`${idPanel}-cols`} className="flex flex-col gap-0.5">
                {vc.disponibles.map((c) => (
                  <label key={c.clave} className={`${fila}${c.fija ? ' cursor-default opacity-80' : ''}`}>
                    <input type="checkbox" className="size-4" checked={vc.marcadas.has(c.clave)} disabled={c.fija || ocupado}
                      onChange={() => vc.alternar(c.clave)} />
                    <span>{c.etiqueta}</span>
                    {c.fija && <span className={tenue}>(fija)</span>}
                  </label>
                ))}
              </div>
              {vc.hayCambios && <p role="status" className={`m-0 ${tenue}`}>Cambios sin guardar: solo duran mientras siga en esta página.</p>}

              {modo === 'nueva' && (
                <div className="flex flex-col gap-2 border-t border-[color:var(--color-border)] pt-3">
                  <label htmlFor={idNombre} className="text-xs font-semibold text-[color:var(--color-text-secondary)]">Nombre de la vista</label>
                  <input id={idNombre} className={flitInp} maxLength={MAX_NOMBRE} value={nombre} autoFocus
                    aria-invalid={errNombre ? true : undefined} aria-describedby={errNombre ? `${idNombre}-err` : undefined}
                    onChange={(e) => { setNombre(e.target.value); setErrNombre(null); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void guardarNueva(); } }} />
                  {errNombre && <p id={`${idNombre}-err`} className="m-0 text-xs text-[color:var(--flit-danger-ink)]">{errNombre}</p>}
                  {esAdmin && (
                    <label className={fila}>
                      <input type="checkbox" className="size-4" checked={paraTodos} onChange={(e) => setParaTodos(e.target.checked)} />
                      Vista para todos
                    </label>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className={claseBoton('primary', 'sm')} disabled={ocupado} onClick={() => void guardarNueva()}>Guardar</button>
                    <button type="button" className={claseBoton('ghost', 'sm')} onClick={() => { setModo('normal'); setErrNombre(null); }}>Cancelar</button>
                  </div>
                </div>
              )}

              {modo === 'borrar' && activa && (
                <div role="alertdialog" aria-label="Confirmar eliminación" className="flex flex-col gap-2 border-t border-[color:var(--color-border)] pt-3">
                  <p className="m-0 text-sm">¿Eliminar la vista «{activa.nombre}»? No se puede deshacer.</p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className={claseBoton('primary', 'sm')} disabled={ocupado}
                      onClick={async () => { if (await vc.eliminar()) setModo('normal'); }}>Sí, eliminar</button>
                    <button type="button" className={claseBoton('ghost', 'sm')} onClick={() => setModo('normal')}>Cancelar</button>
                  </div>
                </div>
              )}

              {modo === 'normal' && (
                <div className="flex flex-wrap gap-2 border-t border-[color:var(--color-border)] pt-3">
                  {activa?.puedeEditar && vc.hayCambios && (
                    <button type="button" className={claseBoton('primary', 'sm')} disabled={ocupado} onClick={() => void vc.guardarCambios()}>Guardar cambios</button>
                  )}
                  <button type="button" className={claseBoton(activa?.puedeEditar && vc.hayCambios ? 'secondary' : 'primary', 'sm')}
                    disabled={ocupado} onClick={() => setModo('nueva')}>Guardar como nueva vista</button>
                  {activa && activa.id !== vc.predeterminadaPersonalId && (
                    <button type="button" className={claseBoton('secondary', 'sm')} disabled={ocupado} onClick={() => void vc.usarPredeterminada()}>Usar como predeterminada</button>
                  )}
                  {esAdmin && activa?.alcance === 'compartida' && !activa.esPredeterminada && (
                    <button type="button" className={claseBoton('secondary', 'sm')} disabled={ocupado} onClick={() => void vc.predeterminadaTodos()}>Predeterminada para todos</button>
                  )}
                  {(activa || vc.hayCambios || vc.predeterminadaPersonalId !== null) && (
                    <button type="button" className={claseBoton('ghost', 'sm')} disabled={ocupado} onClick={() => void vc.restablecer()}>Restablecer</button>
                  )}
                  {activa?.puedeEditar && (
                    <button type="button" className={claseBoton('ghost', 'sm')} disabled={ocupado} onClick={() => setModo('borrar')}>Eliminar vista</button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
