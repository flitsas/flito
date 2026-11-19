// Pestaña «Proveedores» de Clientes y proveedores (HU #10979 → HU #13961).
//
// Vive en su propio archivo desde la HU #13961: `Clients.tsx` rozaba el techo de 800 líneas y esta
// pestaña sumaba estado, filtro, menú ⋮ y diálogo. Reusa TAL CUAL las piezas de Clientes:
//   · `EstadoRegistro` (#13948) — filtro Todos/Activos/Inactivos, chip, pie «Mostrando N de M» y vacío.
//   · `MenuFila` (#13949) — el ⋮ de la fila. Eliminar (HU #13962) se suma a `opcionesFila` con
//     `useEliminarProveedor`, gemelo de `useEliminarCliente` (#13956).
//   · `DialogoEstadoRegistro` (#13949) — confirmar desactivar / activar, con la clasificación de
//     errores (409 → toast y recarga; red/5xx → alerta con «Reintentar»; 403 → sin permiso).
//
// El estado ya NO se cambia desde «Editar» (HU #13958 AC5): el formulario no tiene la casilla
// «Activo» y el PATCH general no envía `activo`. Solo `PATCH /proveedores-soat/:id/estado`.
//
// Quién puede qué:
//   · Ver la pestaña, el estado y el filtro: quien abre la página.
//   · Crear / editar: `editable` (la misma función que gobierna las casillas de Clientes).
//   · Menú ⋮ (Desactivar / Activar): `parametrizacion.proveedores.estado` (solo Administrador).
//   · Menú ⋮ (Eliminar): `parametrizacion.proveedores.eliminar`. El motivo sale del impacto, que exige
//     `estado`: sin ella la opción queda deshabilitada con «No tiene permiso para esta acción.».
//
// Nombre duplicado (HU #13962 AC3): el 409 `Ya existe un proveedor SOAT con el nombre X.` va bajo el
// campo Nombre (aria-invalid + aria-describedby + foco), con el formulario abierto. Cualquier otro
// fallo al guardar dice una frase propia, nunca el texto crudo del API.

import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { toastError, toastOk } from '../flit/ToastFlito';
import { api, ApiError } from '../../lib/api';
import FlitModal from '../flit/FlitModal';
import {
  flitInp, FlitCard, FlitTable, FlitTh, FlitTr, FlitEmpty, FlitField,
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../flit/flitPageKit';
import {
  FiltroEstadoPills, ChipEstado, PieConteo, VacioFiltro, filtrarPorEstado, type FiltroEstado,
} from './EstadoRegistro';
import { MenuFila, type OpcionMenuFila } from '../flit/MenuFila';
import { DialogoEstadoRegistro, type ImpactoEstado } from './DialogoEstadoRegistro';
import { useEliminarProveedor } from './useEliminarProveedor';
import { ErrorNit as ErrorCampo } from './nitDuplicado';

export interface Proveedor {
  id: string; nombre: string; estrategia: string | null;
  umbralOcr: number | null; slaHoras: number | null; activo: boolean;
}

/** Forma real de `GET /flito/parametrizacion/proveedores-soat/:id/impacto` (`ImpactoProveedorSoat`). */
export interface ImpactoProveedor {
  activo: boolean;
  soatEnCurso: number;
  companiasGestorPorDefecto: { cantidad: number; nombres: string[] };
  usuariosAfectados: number;
  puedeEliminar: boolean;
  motivoNoEliminable: string | null;
}

type CambioEstado = { p: Proveedor; accion: 'desactivar' | 'activar' };

// Consecuencias verificadas contra RN-PROV-3/4 (los usuarios de un proveedor inactivo no ingresan) y
// el selector de «SOAT sin trámite», que solo ofrece proveedores activos.
const CONSECUENCIA_DESACTIVAR = 'Mientras esté inactivo, sus usuarios no podrán ingresar a FLITO y no aparecerá entre los proveedores a elegir.';
const CONSECUENCIA_ACTIVAR = 'Sus usuarios vuelven a ingresar a FLITO y vuelve a aparecer entre los proveedores a elegir.';

/**
 * «4 SOAT en curso, proveedor de SOAT sin trámite de 2 compañías.» — solo los tipos con n > 0, unidos
 * con «, » (AC3). Sin nada: «No tiene procesos en curso.», el mismo tono que Clientes.
 */
export function fraseImpactoProveedor(i: Pick<ImpactoProveedor, 'soatEnCurso' | 'companiasGestorPorDefecto'>): string {
  const partes: string[] = [];
  if (i.soatEnCurso > 0) partes.push(`${i.soatEnCurso} SOAT en curso`);
  const n = i.companiasGestorPorDefecto?.cantidad ?? 0;
  if (n > 0) partes.push(`proveedor de SOAT sin trámite de ${n} ${n === 1 ? 'compañía' : 'compañías'}`);
  return partes.length === 0 ? 'No tiene procesos en curso.' : `${partes.join(', ')}.`;
}

export default function TabProveedores({ editable, editaEstado }: { editable: boolean; editaEstado: boolean }) {
  // `null` = cargando; el error es bandera (copy fijo, nunca el texto del API).
  const [data, setData] = useState<Proveedor[] | null>(null);
  const [errorCarga, setErrorCarga] = useState(false);
  const [editar, setEditar] = useState<Proveedor | null>(null);
  const [crear, setCrear] = useState(false);
  // En estado del componente: al cambiar de pestaña y volver, vuelve a «Todos» (como Clientes).
  const [filtroEstado, setFiltroEstado] = useState<FiltroEstado>('todos');
  const [estadoDe, setEstadoDe] = useState<CambioEstado | null>(null);
  const visibles = useMemo(
    () => (data ? filtrarPorEstado(data, filtroEstado, (p) => p.activo) : []),
    [data, filtroEstado],
  );
  // Respaldo del foco al cerrar el diálogo si la fila salió del filtro: la pill marcada, nunca <body>.
  const refFiltro = useRef<HTMLDivElement>(null);
  const refRespaldoFoco = useMemo<RefObject<HTMLElement | null>>(() => ({
    get current() { return refFiltro.current?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? null; },
  }), []);

  const load = () => {
    setData(null); setErrorCarga(false);
    api.get<Proveedor[]>('/flito/parametrizacion/proveedores-soat').then(setData).catch(() => setErrorCarga(true));
  };
  // Recarga silenciosa tras cambiar el estado: sin pasar por «Cargando…» ni perder el filtro.
  const recargar = () => {
    api.get<Proveedor[]>('/flito/parametrizacion/proveedores-soat').then(setData).catch(() => setErrorCarga(true));
  };
  useEffect(() => { load(); }, []);

  const eliminar = useEliminarProveedor<Proveedor>({
    // La fila sale con la respuesta 2xx (de todos los filtros) y la recarga confirma el resto.
    onEliminado: (p) => { setData((prev) => (prev ?? []).filter((x) => x.id !== p.id)); recargar(); },
    onDesactualizado: recargar,
    restoreFocusRef: refRespaldoFoco,
  });

  const opcionesFila = (p: Proveedor): OpcionMenuFila[] => [
    ...(editaEstado
      ? [p.activo
        ? { id: 'desactivar', texto: 'Desactivar', onElegir: () => setEstadoDe({ p, accion: 'desactivar' }) }
        : { id: 'activar', texto: 'Activar', onElegir: () => setEstadoDe({ p, accion: 'activar' }) }]
      : []),
    ...eliminar.opciones(p),
  ];

  return (
    <>
      {editable && (
        <div><button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={() => setCrear(true)}>Nuevo proveedor</button></div>
      )}
      <FlitCard>
        {errorCarga ? (
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-text)' }}>No pudimos cargar los proveedores.</p>
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={load}>Reintentar</button>
          </div>
        ) : data === null ? (
          <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando proveedores…</p>
        ) : data.length === 0 ? (
          // Vacío total: filtro y pie ocultos (filtrar una lista vacía no ayuda).
          <FlitEmpty>No hay proveedores.{editable && ' Cree el primero con «Nuevo proveedor».'}</FlitEmpty>
        ) : (<>
          <div className="mb-3" ref={refFiltro}><FiltroEstadoPills valor={filtroEstado} onCambio={setFiltroEstado} /></div>
          {visibles.length === 0 ? <VacioFiltro onVerTodos={() => setFiltroEstado('todos')} /> : (
            <FlitTable>
              <thead>
                <FlitTr>
                  <FlitTh>Nombre</FlitTh>
                  {/* Identificador + estado juntos, como en Clientes. */}
                  <FlitTh>Estado</FlitTh>
                  <FlitTh>Estrategia</FlitTh>
                  <FlitTh>Umbral OCR</FlitTh>
                  <FlitTh>ANS pactado (h)</FlitTh>
                  <FlitTh />
                </FlitTr>
              </thead>
              <tbody>
                {visibles.map((p) => {
                  const opciones = opcionesFila(p);
                  return (
                    <FlitTr key={p.id}>
                      <td className="px-3 py-2 font-medium" style={{ color: 'var(--flit-text-primary)' }}>{p.nombre}</td>
                      <td className="px-3 py-2"><ChipEstado activo={p.activo} /></td>
                      <td className="px-3 py-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{p.estrategia ?? '—'}</td>
                      <td className="px-3 py-2 text-sm tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>{p.umbralOcr ?? '—'}</td>
                      <td className="px-3 py-2 text-sm tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>{p.slaHoras ?? '—'}</td>
                      <td className="px-3 py-2">
                        <div className="flex gap-2 whitespace-nowrap">
                          {editable && (
                            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                              aria-label={`Editar ${p.nombre}`} onClick={() => setEditar(p)}>Editar</button>
                          )}
                          {opciones.length > 0 && <MenuFila etiqueta={`Acciones de ${p.nombre}`} opciones={opciones} onAbrir={() => eliminar.comprobar(p)} />}
                        </div>
                      </td>
                    </FlitTr>
                  );
                })}
              </tbody>
            </FlitTable>
          )}
          <PieConteo visibles={visibles.length} total={data.length} />
        </>)}
        <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          El ANS de gestión es único para toda la operación: un día desde que se envía la solicitud.
          Estas horas quedan como referencia de lo pactado con cada proveedor, pero ya no deciden
          cuándo un SOAT se marca sin gestión en la cola. El proveedor se elige al enviarlo al gestor.
        </p>
      </FlitCard>

      {estadoDe && (
        <DialogoEstadoRegistro
          accion={estadoDe.accion}
          nombre={estadoDe.p.nombre}
          sustantivo="proveedor"
          cargarImpacto={estadoDe.accion === 'desactivar'
            ? async (): Promise<ImpactoEstado> => {
              const i = await api.get<ImpactoProveedor>(`/flito/parametrizacion/proveedores-soat/${estadoDe.p.id}/impacto`);
              return { frase: fraseImpactoProveedor(i), usuariosAfectados: i.usuariosAfectados ?? 0 };
            }
            : undefined}
          consecuencia={estadoDe.accion === 'desactivar' ? CONSECUENCIA_DESACTIVAR : CONSECUENCIA_ACTIVAR}
          confirmar={async () => {
            await api.patch(`/flito/parametrizacion/proveedores-soat/${estadoDe.p.id}/estado`, {
              activo: estadoDe.accion === 'activar', activoEsperado: estadoDe.p.activo,
            });
          }}
          onHecho={() => {
            const { p, accion } = estadoDe;
            // La fila cambia con la respuesta 2xx (no antes) y la recarga confirma el resto.
            setData((prev) => (prev ?? []).map((x) => (x.id === p.id ? { ...x, activo: accion === 'activar' } : x)));
            setEstadoDe(null);
            toastOk(accion === 'desactivar' ? 'Proveedor desactivado.' : 'Proveedor activado.', { id: `estado-prov-${p.id}` });
            recargar();
          }}
          onDesactualizado={(motivo) => {
            const id = estadoDe.p.id;
            setEstadoDe(null);
            toastError(motivo === 'cambiado'
              ? 'Otro administrador ya cambió su estado.'
              : 'Este proveedor ya no existe. Se actualizó la lista.', undefined, { id: `estado-prov-${id}` });
            recargar();
          }}
          onCerrar={() => setEstadoDe(null)}
          restoreFocusRef={refRespaldoFoco}
        />
      )}

      {eliminar.dialogo}

      {crear && <FormProveedor onClose={() => setCrear(false)} onGuardado={() => { setCrear(false); load(); }} />}
      {editar && <FormProveedor proveedor={editar} onClose={() => setEditar(null)} onGuardado={() => { setEditar(null); recargar(); }} />}
    </>
  );
}

/**
 * Crear / editar. Sin casilla «Activo» (HU #13958 AC5 / HU #13961 AC5): el estado tiene su propia
 * acción en el ⋮ y el PATCH general ya no envía `activo`.
 */
function FormProveedor({ proveedor, onClose, onGuardado }: { proveedor?: Proveedor; onClose: () => void; onGuardado: () => void }) {
  const [nombre, setNombre] = useState(proveedor?.nombre ?? '');
  const [estrategia, setEstrategia] = useState(proveedor?.estrategia ?? '');
  const [umbral, setUmbral] = useState(proveedor?.umbralOcr != null ? String(proveedor.umbralOcr) : '');
  const [sla, setSla] = useState(proveedor?.slaHoras != null ? String(proveedor.slaHoras) : '');
  const [error, setError] = useState<string | null>(null);
  // AC3: el 409 de nombre repetido se dice bajo el campo; se quita en cuanto el nombre cambia.
  const [errorNombre, setErrorNombre] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const refNombre = useRef<HTMLInputElement>(null);
  const idErrorNombre = useId();
  useEffect(() => { if (errorNombre) refNombre.current?.focus(); }, [errorNombre]);

  const guardar = async () => {
    setGuardando(true); setError(null); setErrorNombre(null);
    const body: Record<string, unknown> = {
      nombre: nombre.trim(),
      estrategia: estrategia.trim() || undefined,
      umbralOcr: umbral.trim() === '' ? null : Number(umbral),
      slaHoras: sla.trim() === '' ? null : Number(sla),
    };
    try {
      if (proveedor) await api.patch(`/flito/parametrizacion/proveedores-soat/${proveedor.id}`, body);
      else await api.post('/flito/parametrizacion/proveedores-soat', body);
      onGuardado();
    } catch (e) {
      const duplicado = mensajeNombreDuplicado(e);
      if (duplicado) setErrorNombre(duplicado);
      else setError(mensajeErrorGuardar(e));
    }
    finally { setGuardando(false); }
  };

  return (
    <FlitModal title={proveedor ? 'Editar proveedor' : 'Nuevo proveedor'} onClose={onClose}>
      <div className="space-y-3">
        <FlitField label="Nombre *">
          <input ref={refNombre} className={flitInp} value={nombre}
            onChange={(e) => { setNombre(e.target.value); setErrorNombre(null); }}
            aria-invalid={errorNombre ? true : undefined}
            aria-describedby={errorNombre ? idErrorNombre : undefined} />
        </FlitField>
        {/* Fuera del <label>: el error no debe sumarse al nombre accesible del campo. */}
        {errorNombre && <ErrorCampo id={idErrorNombre}>{errorNombre}</ErrorCampo>}
        <FlitField label="Estrategia"><input className={flitInp} value={estrategia} onChange={(e) => setEstrategia(e.target.value)} placeholder="p.ej. portal, correo" /></FlitField>
        <FlitField label="Umbral OCR (0–1)"><input className={flitInp} type="number" step="0.01" min="0" max="1" value={umbral} onChange={(e) => setUmbral(e.target.value)} /></FlitField>
        <FlitField label="ANS pactado con el proveedor (horas)"><input className={flitInp} type="number" min="1" value={sla} onChange={(e) => setSla(e.target.value)} /></FlitField>
        {error && <p role="alert" className="text-sm font-semibold" style={{ color: 'var(--flit-danger-text)' }}>{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={guardando || !nombre.trim()} onClick={guardar}>{guardando ? 'Guardando…' : 'Guardar'}</button>
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>Cancelar</button>
        </div>
      </div>
    </FlitModal>
  );
}

/** AC3 — el 409 del API (`mensajeNombreProveedorDuplicado`). Único texto del API que se muestra tal cual. */
const NOMBRE_DUPLICADO = /^Ya existe un proveedor SOAT con el nombre .+\.$/;

export function mensajeNombreDuplicado(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const cuerpo = e.rawDetails as { error?: unknown } | null | undefined;
  const texto = (typeof cuerpo?.error === 'string' ? cuerpo.error : e.message).trim();
  return NOMBRE_DUPLICADO.test(texto) ? texto : null;
}

/** Cualquier otro fallo al guardar: frase propia, nunca el texto crudo del API (Nota de #13961). */
export function mensajeErrorGuardar(e: unknown): string {
  const status = e instanceof ApiError ? e.status : 0;
  if (status === 403) return 'No tiene permiso para esta acción.';
  if (status === 404) return 'Este proveedor ya no existe. Cierre y vuelva a cargar la lista.';
  if (status === 400) return 'Revise los datos: el umbral OCR va de 0 a 1 y el ANS pactado es un número de horas mayor que cero.';
  if (status === 0) return 'No pudimos conectar con FLITO. Revise su conexión e inténtelo de nuevo.';
  return 'No pudimos guardar el proveedor. Inténtelo de nuevo.';
}
