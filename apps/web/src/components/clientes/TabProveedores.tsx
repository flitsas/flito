// Pestaña «Proveedores» de Clientes y proveedores (HU #14337, ADR-0039 §7.1). Lista única con los servicios de cada
// proveedor. Diseño: `docs/ux/proveedores-servicios-14324-slim.md`.
//
// Reusa TAL CUAL las piezas de Clientes:
//   · `EstadoRegistro` (#13948) — filtro Todos/Activos/Inactivos, chip, pie «Mostrando N de M» y vacío.
//   · `MenuFila` (#13949) — el ⋮ de la fila, con `useEliminarProveedor`.
//   · `DialogoEstadoRegistro` (#13949) — confirmar desactivar / activar, con la clasificación de errores
//     (409 → toast y recarga; red/5xx → alerta con «Reintentar»; 403 → sin permiso).
//
// Quién puede qué:
//   · Ver la pestaña y filtrar: quien abre la página. El listado exige `parametrizacion.proveedores.listar`.
//   · Crear: `parametrizacion.proveedores.crear`. Editar: `parametrizacion.proveedores.editar`.
//   · Menú ⋮ (Desactivar / Activar): `parametrizacion.proveedores.estado`.
//   · Menú ⋮ (Eliminar): `parametrizacion.proveedores.eliminar`. El motivo sale del impacto, que exige `estado`: sin ella la
//     opción queda deshabilitada con «No tiene permiso para esta acción.».
//
// La lista no trae datos personales: teléfono, correo, dirección y contacto solo existen en el detalle.

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  CODIGO_PROVEEDOR_EDITADO_POR_OTRO, SERVICIO_PROVEEDOR_LABEL,
  type CambiarEstadoProveedorBody, type ImpactoProveedorDto, type ProveedorListaItemDto, type ServicioProveedor,
} from '@operaciones/shared-types';
import { toastError, toastOk } from '../flit/ToastFlito';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
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
  RUTA_UNIFICADA, cargarImpactoProveedor, cargarProveedores, fraseImpacto, serviciosEnOrden, textoCompanias, textoUmbral,
} from './proveedoresDatos';

type Fila = ProveedorListaItemDto;
type CambioEstado = { p: Fila; accion: 'desactivar' | 'activar'; impacto?: ImpactoProveedorDto };
type FiltroServicio = 'todos' | ServicioProveedor;
const SERVICIOS: { valor: FiltroServicio; texto: string }[] = [
  { valor: 'todos', texto: 'Todos' },
  { valor: 'soat', texto: SERVICIO_PROVEEDOR_LABEL.soat },
  { valor: 'logistica', texto: SERVICIO_PROVEEDOR_LABEL.logistica },
];

// Inactivar siempre invalida las sesiones de sus usuarios (ADR-0039 §4.2): una sola frase para todos los servicios.
const CONSECUENCIA_DESACTIVAR = 'Mientras esté inactivo, sus usuarios no podrán ingresar a FLITO y no aparecerá entre los proveedores a elegir.';
const CONSECUENCIA_ACTIVAR = 'Sus usuarios vuelven a ingresar a FLITO y vuelve a aparecer entre los proveedores a elegir.';

const celda = 'px-3 py-2 text-sm tabular-nums';
const colorCelda = { color: 'var(--flit-text-secondary)' };

export default function TabProveedores({ editaEstado }: { editaEstado: boolean }) {
  const { hasFuncion } = useAuth();
  const puedeCrear = hasFuncion('parametrizacion.proveedores.crear');
  const puedeEditar = hasFuncion('parametrizacion.proveedores.editar');
  // `null` = cargando; el error es bandera (copy fijo, nunca el texto del API).
  const [data, setData] = useState<Fila[] | null>(null);
  const [errorCarga, setErrorCarga] = useState(false);
  const [editar, setEditar] = useState<Fila | null>(null);
  const [ver, setVer] = useState<Fila | null>(null);
  const [crear, setCrear] = useState(false);
  // En estado del componente: al cambiar de pestaña y volver, vuelve a «Todos» (como Clientes).
  const [filtroEstado, setFiltroEstado] = useState<FiltroEstado>('todos');
  const [filtroServicio, setFiltroServicio] = useState<FiltroServicio>('todos');
  const [estadoDe, setEstadoDe] = useState<CambioEstado | null>(null);
  const [bloqueo, setBloqueo] = useState<string | null>(null);
  // Por qué respondió 409 el cambio de estado: decide el copy del toast.
  const motivoCarrera = useRef<'asignado' | 'version' | null>(null);
  const visibles = useMemo(
    () => (data ? filtrarPorEstado(data, filtroEstado, (p) => p.activo).filter((p) => filtroServicio === 'todos' || p.servicios.includes(filtroServicio)) : []),
    [data, filtroEstado, filtroServicio],
  );
  // Con el filtro «Logística» ninguna fila tiene datos de SOAT: sus dos columnas salen.
  const conSoat = filtroServicio !== 'logistica';
  // Respaldo del foco al cerrar el diálogo si la fila salió del filtro: la pill marcada, nunca <body>.
  const refFiltro = useRef<HTMLDivElement>(null);
  const refRespaldoFoco = useMemo<RefObject<HTMLElement | null>>(() => ({
    get current() { return refFiltro.current?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? null; },
  }), []);

  const load = () => {
    setData(null); setErrorCarga(false);
    cargarProveedores().then(setData).catch(() => setErrorCarga(true));
  };
  // Recarga silenciosa tras cambiar el estado: sin pasar por «Cargando…» ni perder el filtro.
  const recargar = () => { cargarProveedores().then(setData).catch(() => setErrorCarga(true)); };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const eliminar = useEliminarProveedor<Fila>({
    // La fila sale con la respuesta 2xx (de todos los filtros) y la recarga confirma el resto.
    onEliminado: (p) => { setData((prev) => (prev ?? []).filter((x) => x.id !== p.id)); recargar(); },
    onDesactualizado: recargar,
    restoreFocusRef: refRespaldoFoco,
  });

  // Se pregunta el impacto al servidor antes de abrir: con compañías de Logística la baja se bloquea con el motivo y la
  // cantidad (R5); si falla la consulta, se dice sin bloquear a ciegas.
  const intentarDesactivar = (p: Fila) => {
    cargarImpactoProveedor(p.id)
      .then((impacto) => {
        if (!impacto.puedeInactivar) setBloqueo(impacto.motivoNoInactivable ?? `No se puede inactivar a ${p.nombre}.`);
        else setEstadoDe({ p, accion: 'desactivar', impacto });
      })
      .catch(() => toastError('No pudimos comprobar si el proveedor tiene compañías asignadas. Inténtelo de nuevo.', undefined, { id: `impacto-prov-${p.id}` }));
  };

  const opcionesFila = (p: Fila): OpcionMenuFila[] => [
    ...(editaEstado
      ? [p.activo
        ? { id: 'desactivar', texto: 'Desactivar', onElegir: () => intentarDesactivar(p) }
        : { id: 'activar', texto: 'Activar', onElegir: () => setEstadoDe({ p, accion: 'activar' }) }]
      : []),
    ...eliminar.opciones(p),
  ];

  const impactoDelDialogo = (i: ImpactoProveedorDto) => async (): Promise<ImpactoEstado> => (
    { frase: fraseImpacto(i), usuariosAfectados: i.sesionesAfectadas }
  );

  return (
    <>
      {puedeCrear && (
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
            {puedeCrear ? 'No hay proveedores. Cree el primero con «Nuevo proveedor».' : 'No hay proveedores. Pida a un administrador que los registre.'}
          </FlitEmpty>
        ) : (<>
          <div className="mb-3 flex flex-wrap items-end gap-x-6 gap-y-3" ref={refFiltro}>
            <FiltroEstadoPills valor={filtroEstado} onCambio={setFiltroEstado} />
            <div role="group" aria-label="Servicio" className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>Servicio</span>
              <FlitPillGroup>
                {SERVICIOS.map((t) => (
                  <FlitPillButton key={t.valor} active={filtroServicio === t.valor} pressed={filtroServicio === t.valor} onClick={() => setFiltroServicio(t.valor)}>{t.texto}</FlitPillButton>
                ))}
              </FlitPillGroup>
            </div>
          </div>
          {visibles.length === 0 ? <VacioFiltro onVerTodos={() => { setFiltroEstado('todos'); setFiltroServicio('todos'); }} /> : (
            <FlitTable>
              <thead>
                <FlitTr>
                  <FlitTh>Nombre</FlitTh>
                  <FlitTh>Servicios</FlitTh>
                  <FlitTh>NIT</FlitTh>
                  <FlitTh>Compañías asignadas</FlitTh>
                  {conSoat && <FlitTh>Umbral OCR</FlitTh>}
                  {conSoat && <FlitTh>ANS pactado</FlitTh>}
                  <FlitTh>Estado</FlitTh>
                  <FlitTh />
                </FlitTr>
              </thead>
              <tbody>
                {visibles.map((p) => {
                  const opciones = opcionesFila(p);
                  return (
                    <FlitTr key={p.id}>
                      <td className="px-3 py-2 font-medium" style={{ color: 'var(--flit-text-primary)' }}>
                        {p.nombre}
                        {!p.datosCompletos && <div className="text-xs font-normal" style={{ color: 'var(--flit-text-muted)' }}>Datos por completar</div>}
                      </td>
                      <td className="px-3 py-2">
                        <span className="flex flex-wrap gap-1">
                          {serviciosEnOrden(p.servicios).map((s) => <span key={s} className="whitespace-nowrap"><StatusChip tone="neutral">{SERVICIO_PROVEEDOR_LABEL[s]}</StatusChip></span>)}
                        </span>
                      </td>
                      <td className={`${celda} whitespace-nowrap`} style={colorCelda}>{p.nit ?? '—'}</td>
                      <td className={celda} style={colorCelda}>{textoCompanias(p)}</td>
                      {conSoat && <td className={celda} style={colorCelda}>{textoUmbral(p.umbralOcr)}</td>}
                      {conSoat && <td className={celda} style={colorCelda}>{p.slaHoras != null ? `${p.slaHoras} h` : '—'}</td>}
                      <td className="px-3 py-2"><ChipEstado activo={p.activo} /></td>
                      <td className="px-3 py-2">
                        <div className="flex gap-2 whitespace-nowrap">
                          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                            aria-label={`Ver detalle de ${p.nombre}`} onClick={() => setVer(p)}>Ver detalle</button>
                          {puedeEditar && (
                            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                              aria-label={`Editar ${p.nombre}`} onClick={() => setEditar(p)}>Editar</button>
                          )}
                          {opciones.length > 0 && (
                            <MenuFila etiqueta={`Acciones de ${p.nombre}`} opciones={opciones} onAbrir={() => eliminar.comprobar(p)} />
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
          cargarImpacto={estadoDe.impacto ? impactoDelDialogo(estadoDe.impacto) : undefined}
          consecuencia={estadoDe.accion === 'desactivar' ? CONSECUENCIA_DESACTIVAR : CONSECUENCIA_ACTIVAR}
          confirmar={async () => {
            motivoCarrera.current = null;
            try {
              const body: CambiarEstadoProveedorBody = { activo: estadoDe.accion === 'activar', versionEsperada: estadoDe.p.version };
              await api.patch(`${RUTA_UNIFICADA}/${estadoDe.p.id}/estado`, body);
            } catch (e) {
              // Carrera: alguien asignó el proveedor a una compañía o lo cambió entre el diálogo y el clic.
              const cuerpo = e instanceof ApiError ? (e.rawDetails as { companias?: unknown; code?: unknown } | null) : null;
              if (Array.isArray(cuerpo?.companias)) motivoCarrera.current = 'asignado';
              else if (cuerpo?.code === CODIGO_PROVEEDOR_EDITADO_POR_OTRO) motivoCarrera.current = 'version';
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
            toastError(motivoCarrera.current === 'asignado'
              ? 'Ese proveedor sigue asignado a compañías. Recargamos la lista.'
              : motivoCarrera.current === 'version' ? 'Otro usuario cambió este proveedor. Recargamos la lista.'
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
              {bloqueo}
            </p>
            <div className="flex justify-end">
              <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={() => setBloqueo(null)}>Entendido</button>
            </div>
          </div>
        </FlitModal>
      )}

      {eliminar.dialogo}

      {crear && <FormProveedor onClose={() => setCrear(false)} onGuardado={() => { setCrear(false); load(); }} />}
      {/* Cerrar también recarga: tras un conflicto de edición la fila que se ve ya no es la vigente. */}
      {editar && <FormProveedor idProveedor={editar.id} nombre={editar.nombre} onClose={() => { setEditar(null); recargar(); }} onGuardado={() => { setEditar(null); recargar(); }} />}
      {ver && <FormProveedor idProveedor={ver.id} nombre={ver.nombre} soloLectura onClose={() => setVer(null)} onGuardado={() => setVer(null)} />}
    </>
  );
}
