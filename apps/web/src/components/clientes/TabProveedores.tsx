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

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { toastError, toastOk } from '../flit/ToastFlito';
import { api, ApiError } from '../../lib/api';
import FlitModal from '../flit/FlitModal';
import StatusChip from '../flit/StatusChip';
import {
  FlitCard, FlitTable, FlitTh, FlitTr, FlitEmpty, FlitPillGroup, FlitPillButton,
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../flit/flitPageKit';
import {
  FiltroEstadoPills, ChipEstado, PieConteo, VacioFiltro, filtrarPorEstado, type FiltroEstado,
} from './EstadoRegistro';
import { MenuFila, type OpcionMenuFila } from '../flit/MenuFila';
import { DialogoEstadoRegistro, type ImpactoEstado } from './DialogoEstadoRegistro';
import { useEliminarProveedor } from './useEliminarProveedor';
import FormProveedor from './FormProveedor';
import {
  cargarProveedores, companiasDe, rutaProveedor, textoBajaBloqueada, useCompaniasAsignacion,
  type Proveedor, type TipoProveedor,
} from './proveedoresDatos';

export { mensajeNombreDuplicado, mensajeErrorGuardar } from './FormProveedor';
export type { Proveedor } from './proveedoresDatos';

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
type FiltroTipo = 'todos' | TipoProveedor;
const TIPOS: { valor: FiltroTipo; texto: string }[] = [
  { valor: 'todos', texto: 'Todos' }, { valor: 'SOAT', texto: 'SOAT' }, { valor: 'LOGISTICA', texto: 'Logística' },
];

// Consecuencias verificadas contra RN-PROV-3/4 (los usuarios de un proveedor inactivo no ingresan) y
// el selector de «SOAT sin trámite», que solo ofrece proveedores activos.
const CONSECUENCIA_DESACTIVAR = 'Mientras esté inactivo, sus usuarios no podrán ingresar a FLITO y no aparecerá entre los proveedores a elegir.';
const CONSECUENCIA_ACTIVAR = 'Sus usuarios vuelven a ingresar a FLITO y vuelve a aparecer entre los proveedores a elegir.';
const CONSECUENCIA_DESACTIVAR_LOGISTICA = 'Mientras esté inactivo no aparecerá entre los proveedores de logística a elegir.';
const CONSECUENCIA_ACTIVAR_LOGISTICA = 'Vuelve a aparecer entre los proveedores de logística a elegir.';

/**
 * «4 SOAT en curso, proveedor de SOAT sin trámite de 2 compañías.» — solo los tipos con n > 0, unidos
 * con «, » (AC3). Sin nada: «No tiene procesos en curso.», el mismo tono que Clientes.
 * Logística (HU #14105): `logistica` suma «proveedor de logística de N compañías».
 */
export function fraseImpactoProveedor(
  i: Pick<ImpactoProveedor, 'soatEnCurso' | 'companiasGestorPorDefecto'>, logistica = 0,
): string {
  const partes: string[] = [];
  if (i.soatEnCurso > 0) partes.push(`${i.soatEnCurso} SOAT en curso`);
  const n = i.companiasGestorPorDefecto?.cantidad ?? 0;
  if (n > 0) partes.push(`proveedor de SOAT sin trámite de ${n} ${n === 1 ? 'compañía' : 'compañías'}`);
  if (logistica > 0) partes.push(`proveedor de logística de ${logistica} ${logistica === 1 ? 'compañía' : 'compañías'}`);
  return partes.length === 0 ? 'No tiene procesos en curso.' : `${partes.join(', ')}.`;
}

export default function TabProveedores({ editable, editaEstado }: { editable: boolean; editaEstado: boolean }) {
  // `null` = cargando; el error es bandera (copy fijo, nunca el texto del API).
  const [data, setData] = useState<Proveedor[] | null>(null);
  const [errorCarga, setErrorCarga] = useState(false);
  const [editar, setEditar] = useState<Proveedor | null>(null);
  const [ver, setVer] = useState<Proveedor | null>(null);
  const [crear, setCrear] = useState(false);
  // En estado del componente: al cambiar de pestaña y volver, vuelve a «Todos» (como Clientes).
  const [filtroEstado, setFiltroEstado] = useState<FiltroEstado>('todos');
  const [filtroTipo, setFiltroTipo] = useState<FiltroTipo>('todos');
  const [estadoDe, setEstadoDe] = useState<CambioEstado | null>(null);
  const [bloqueo, setBloqueo] = useState<{ nombre: string; companias: string[] } | null>(null);
  const carreraAsignado = useRef(false);
  const asignacion = useCompaniasAsignacion();
  const visibles = useMemo(
    () => (data ? filtrarPorEstado(data, filtroEstado, (p) => p.activo).filter((p) => filtroTipo === 'todos' || p.tipo === filtroTipo) : []),
    [data, filtroEstado, filtroTipo],
  );
  // Respaldo del foco al cerrar el diálogo si la fila salió del filtro: la pill marcada, nunca <body>.
  const refFiltro = useRef<HTMLDivElement>(null);
  const refRespaldoFoco = useMemo<RefObject<HTMLElement | null>>(() => ({
    get current() { return refFiltro.current?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? null; },
  }), []);

  const load = () => {
    setData(null); setErrorCarga(false); asignacion.recargar();
    cargarProveedores().then(setData).catch(() => setErrorCarga(true));
  };
  // Recarga silenciosa tras cambiar el estado: sin pasar por «Cargando…» ni perder el filtro.
  const recargar = () => { asignacion.recargar(); cargarProveedores().then(setData).catch(() => setErrorCarga(true)); };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const eliminar = useEliminarProveedor<Proveedor>({
    // La fila sale con la respuesta 2xx (de todos los filtros) y la recarga confirma el resto.
    onEliminado: (p) => { setData((prev) => (prev ?? []).filter((x) => x.id !== p.id)); recargar(); },
    onDesactualizado: recargar,
    restoreFocusRef: refRespaldoFoco,
  });

  const nombresDe = (p: Proveedor) => companiasDe(p, asignacion.data)?.map((c) => c.nombre) ?? null;

  // Logística no tiene baja (no hay DELETE en el API): solo SOAT suma «Eliminar».
  const opcionesFila = (p: Proveedor): OpcionMenuFila[] => [
    ...(editaEstado
      ? [p.activo
        ? { id: 'desactivar', texto: 'Desactivar', onElegir: () => {
          const nombres = p.tipo === 'LOGISTICA' ? nombresDe(p) : null;
          if (nombres && nombres.length > 0) setBloqueo({ nombre: p.nombre, companias: nombres });
          else setEstadoDe({ p, accion: 'desactivar' });
        } }
        : { id: 'activar', texto: 'Activar', onElegir: () => setEstadoDe({ p, accion: 'activar' }) }]
      : []),
    ...(p.tipo === 'SOAT' ? eliminar.opciones(p) : []),
  ];

  const cargarImpacto = (p: Proveedor) => async (): Promise<ImpactoEstado> => {
    if (p.tipo === 'LOGISTICA') {
      return { frase: fraseImpactoProveedor({ soatEnCurso: 0, companiasGestorPorDefecto: { cantidad: 0, nombres: [] } }, nombresDe(p)?.length ?? 0), usuariosAfectados: 0 };
    }
    const i = await api.get<ImpactoProveedor>(`${rutaProveedor(p)}/${p.id}/impacto`);
    return { frase: fraseImpactoProveedor(i), usuariosAfectados: i.usuariosAfectados ?? 0 };
  };

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
          <FlitEmpty>
            {editable ? 'No hay proveedores. Cree el primero con «Nuevo proveedor».' : 'No hay proveedores. Pida a un administrador que los registre.'}
          </FlitEmpty>
        ) : (<>
          <div className="mb-3 flex flex-wrap items-end gap-x-6 gap-y-3" ref={refFiltro}>
            <FiltroEstadoPills valor={filtroEstado} onCambio={setFiltroEstado} />
            <div role="group" aria-label="Tipo" className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>Tipo</span>
              <FlitPillGroup>
                {TIPOS.map((t) => (
                  <FlitPillButton key={t.valor} active={filtroTipo === t.valor} pressed={filtroTipo === t.valor} onClick={() => setFiltroTipo(t.valor)}>{t.texto}</FlitPillButton>
                ))}
              </FlitPillGroup>
            </div>
          </div>
          {visibles.length === 0 ? <VacioFiltro onVerTodos={() => { setFiltroEstado('todos'); setFiltroTipo('todos'); }} /> : (
            <FlitTable>
              <thead>
                <FlitTr>
                  <FlitTh>Nombre</FlitTh>
                  <FlitTh>Tipo</FlitTh>
                  <FlitTh>NIT</FlitTh>
                  <FlitTh>Contacto y teléfono</FlitTh>
                  <FlitTh>Compañías asignadas</FlitTh>
                  <FlitTh>Estado</FlitTh>
                  <FlitTh />
                </FlitTr>
              </thead>
              <tbody>
                {visibles.map((p) => {
                  const opciones = opcionesFila(p);
                  const asignadas = nombresDe(p);
                  const contacto = [p.contacto, p.telefono].filter(Boolean).join(' · ');
                  return (
                    <FlitTr key={`${p.tipo}-${p.id}`}>
                      <td className="px-3 py-2 font-medium" style={{ color: 'var(--flit-text-primary)' }}>{p.nombre}</td>
                      <td className="px-3 py-2"><span className="whitespace-nowrap"><StatusChip tone="neutral">{p.tipo === 'LOGISTICA' ? 'Logística' : 'SOAT'}</StatusChip></span></td>
                      <td className="px-3 py-2 text-sm tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>{p.nit ?? '—'}</td>
                      <td className="px-3 py-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{contacto || '—'}</td>
                      <td className="px-3 py-2 text-sm tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>{asignadas ? asignadas.length : '—'}</td>
                      <td className="px-3 py-2"><ChipEstado activo={p.activo} /></td>
                      <td className="px-3 py-2">
                        <div className="flex gap-2 whitespace-nowrap">
                          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                            aria-label={`Ver detalle de ${p.nombre}`} onClick={() => setVer(p)}>Ver detalle</button>
                          {editable && (
                            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                              aria-label={`Editar ${p.nombre}`} onClick={() => setEditar(p)}>Editar</button>
                          )}
                          {opciones.length > 0 && (
                            <MenuFila etiqueta={`Acciones de ${p.nombre}`} opciones={opciones}
                              onAbrir={p.tipo === 'SOAT' ? () => eliminar.comprobar(p) : undefined} />
                          )}
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
          cargarImpacto={estadoDe.accion === 'desactivar' ? cargarImpacto(estadoDe.p) : undefined}
          consecuencia={estadoDe.accion === 'desactivar'
            ? (estadoDe.p.tipo === 'LOGISTICA' ? CONSECUENCIA_DESACTIVAR_LOGISTICA : CONSECUENCIA_DESACTIVAR)
            : (estadoDe.p.tipo === 'LOGISTICA' ? CONSECUENCIA_ACTIVAR_LOGISTICA : CONSECUENCIA_ACTIVAR)}
          confirmar={async () => {
            carreraAsignado.current = false;
            try {
              await api.patch(`${rutaProveedor(estadoDe.p)}/${estadoDe.p.id}/estado`, {
                activo: estadoDe.accion === 'activar', activoEsperado: estadoDe.p.activo,
              });
            } catch (e) {
              // Carrera: alguien asignó el proveedor a una compañía entre el diálogo y el clic.
              const cuerpo = e instanceof ApiError ? (e.rawDetails as { companias?: unknown } | null) : null;
              if (Array.isArray(cuerpo?.companias)) carreraAsignado.current = true;
              throw e;
            }
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
            toastError(carreraAsignado.current
              ? 'Ese proveedor sigue asignado a compañías. Recargamos la lista.'
              : motivo === 'cambiado' ? 'Otro administrador ya cambió su estado.'
                : 'Este proveedor ya no existe. Se actualizó la lista.', undefined, { id: `estado-prov-${id}` });
            recargar();
          }}
          onCerrar={() => setEstadoDe(null)}
          restoreFocusRef={refRespaldoFoco}
        />
      )}

      {bloqueo && (
        <FlitModal title="No se puede inactivar" onClose={() => setBloqueo(null)} restoreFocusRef={refRespaldoFoco}>
          <div className="space-y-4">
            <p role="alert" className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
              {textoBajaBloqueada(bloqueo.nombre, bloqueo.companias)}
            </p>
            <div className="flex justify-end">
              <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={() => setBloqueo(null)}>Entendido</button>
            </div>
          </div>
        </FlitModal>
      )}

      {eliminar.dialogo}

      {crear && <FormProveedor onClose={() => setCrear(false)} onGuardado={() => { setCrear(false); load(); }} />}
      {editar && <FormProveedor proveedor={editar} companias={nombresDe(editar)} onClose={() => setEditar(null)} onGuardado={() => { setEditar(null); recargar(); }} />}
      {ver && <FormProveedor proveedor={ver} soloLectura companias={nombresDe(ver)} onClose={() => setVer(null)} onGuardado={() => setVer(null)} />}
    </>
  );
}
