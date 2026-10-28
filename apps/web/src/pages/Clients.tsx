// Clientes y proveedores (HU #10979).
//
// Fusiona la antigua «Cartera de clientes» con «Parametrización». Eran dos pantallas para una misma
// compañía: en una se marcaba si autogestiona, en la otra se le ponían las tarifas — y el toggle de
// autogestión ya llamaba al endpoint de parametrización. Todo lo que es del cliente vive aquí.
//
// Los checks de servicio se leen «FLITO gestiona este servicio» (HU #13935): marcado = FLITO lo
// gestiona; desmarcado = la compañía lo hace por su cuenta. Es una inversión SOLO de presentación:
// el dato sigue siendo `*Autogestionable` con su sentido de siempre, así que `checked = !dato`.
// Ya no hay check «Parcial» (HU #13936): Logística permite siempre entregas parciales, así que los
// tres servicios que quedan se leen invertidos.
//
// HU #14105: la tabla se simplificó a Empresa, Documento, Servicios (un chip por servicio), Facturación
// y «Editar». SOAT, Impuestos y Logística (con su proveedor) se editan en `ModalCliente`.
//
// Las tarifas ya NO viven aquí (HU #12375): el botón «Tarifas» de la fila lleva al configurador de
// valores (`/flito/tarifas/:companiaId`), que modela cada valor como una vigencia con historial. La
// ventana emergente que dejaba escribir el tipo a mano y marcar «Inactiva» se retiró con esa HU.
//
// Quién puede qué:
//   admin       — todo.
//   financiera  — tarifas sí (en su pantalla), servicios no: qué gestiona FLITO es decisión de Operaciones.
//   auditor     — solo lectura.

import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react';
import toast from 'react-hot-toast';
import { toastError, toastOk } from '../components/flit/ToastFlito';
import { api } from '../lib/api';
import { SUCURSAL_MAXIMA, SUCURSAL_MINIMA } from '@operaciones/shared-types';
import { useAuth } from '../lib/auth';
import { hasPage } from '../lib/permissions';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import {
  flitInp, FlitCard, FlitTable, FlitTh, FlitTr, FlitEmpty, FlitPillGroup, FlitPillButton,
  flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';
import { ChipsServicios, ModalCliente, sinProveedorLogistica, type Client } from '../components/clientes/ServiciosCliente';
import { useCompaniasAsignacion, useProveedoresLogistica } from '../components/clientes/proveedoresDatos';
// Ficha fiscal (HU #11298). Vive en su propio componente desde el primer commit: esta pantalla ya
// tiene dos pestañas, un modal y dos formularios, y no cabe más sin acercarse al techo de 800.
import { ChipFacturable } from '../components/clientes/FichaFiscal';
import type { VeredictoCliente } from '../components/clientes/tipos';
// NIT + sucursal duplicados (HU #13955): error en el campo NIT, cualquier otro fallo → toast pulido.
import { ErrorNit, manejarErrorGuardarCliente } from '../components/clientes/nitDuplicado';
// Estado activo/inactivo y su filtro (HU #13948): piezas compartidas con Proveedores (#13961).
import {
  FiltroEstadoPills, ChipEstado, PieConteo, VacioFiltro, filtrarPorEstado, type FiltroEstado,
} from '../components/clientes/EstadoRegistro';
// Menú ⋮ de la fila y diálogo de desactivar / activar (HU #13949): genéricos, Proveedores los reusa.
import { MenuFila } from '../components/flit/MenuFila';
import { DialogoEstadoRegistro, type ImpactoEstado } from '../components/clientes/DialogoEstadoRegistro';
// HU #13956: «Eliminar» en el mismo ⋮ (impacto al abrir el menú, diálogo y toasts).
import { useEliminarCliente } from '../components/clientes/useEliminarCliente';
// Pestaña Proveedores con estado, filtro y ⋮ (HU #13961), en su propio archivo por el techo de 800.
import TabProveedores from '../components/clientes/TabProveedores';
// El catálogo de gestores de SOAT y su selector con los cuatro estados (HU #12053). Se REUTILIZA y
// no se copia: `ProveedorSoatField` ya resuelve el caso que aquí también hace falta —reinyectar el
// gestor asignado aunque esté desactivado, para que guardar otra cosa no se lo quite a la compañía
// por la espalda— y su copy vive junto al de Usuarios.
import { useProveedoresSoat } from './users/AtaduraFields';

type Tab = 'clientes' | 'proveedores';
type CambioEstado = { c: Client; accion: 'desactivar' | 'activar' };

// Copy de consecuencia verificado contra RN-CLI-3/4 y #13947 (spec UX #13949).
const CONSECUENCIA_DESACTIVAR = 'Mientras esté inactivo no recibirá SOAT, impuestos ni trámites nuevos.';
const CONSECUENCIA_ACTIVAR = 'Vuelve a recibir SOAT, impuestos y trámites, y se liberan los trámites que quedaron retenidos mientras estuvo inactivo.';

export default function Clients() {
  const { user, hasFuncion } = useAuth();
  // HU #13949: Desactivar / Activar desde el ⋮ de la fila.
  const editaEstado = hasFuncion('clients.clientes.estado');
  // Operaciones decide qué gestiona FLITO; Finanzas solo pone precio.
  // HU #12170
  const editaAutogestion = hasFuncion('tramites.autogestion.desbloquear');
  // HU #13968 (AC2): el proveedor de «SOAT sin trámite» tiene su PROPIA acción. `editaAutogestion`
  // sigue gobernando las casillas, Proveedores y la ficha fiscal; esto, solo la celda, el cuadro y
  // la nota al pie.
  const editaSinTramite = hasFuncion('parametrizacion.companias.soat_sin_tramite');
  // HU #13961: Desactivar / Activar un proveedor desde su ⋮ (solo Administrador).
  const editaEstadoProveedor = hasFuncion('parametrizacion.proveedores.estado');
  // HU #14105: crear proveedores (enlace del selector de logística vacío).
  const puedeCrearProveedor = hasFuncion('parametrizacion.proveedores.crear');
  // El enlace al configurador se decide por la PÁGINA, no por el nombre del rol: es el mismo gate
  // que la ruta de destino, así que nadie llega a un `NoAccess` desde aquí.
  const veTarifas = hasPage(user, 'flito_tarifas');
  const [tab, setTab] = useState<Tab>('clientes');

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Clientes y proveedores"
        subtitle="Compañías con los servicios que gestiona FLITO y sus tarifas negociadas, y los proveedores de SOAT y de logística."
      />

      <FlitPillGroup>
        <FlitPillButton active={tab === 'clientes'} onClick={() => setTab('clientes')}>Clientes</FlitPillButton>
        <FlitPillButton active={tab === 'proveedores'} onClick={() => setTab('proveedores')}>Proveedores</FlitPillButton>
      </FlitPillGroup>

      {tab === 'clientes'
        ? <TabClientes editaAutogestion={editaAutogestion} editaSinTramite={editaSinTramite} puedeCrearProveedor={puedeCrearProveedor} veTarifas={veTarifas} editaEstado={editaEstado} />
        : <TabProveedores editable={editaAutogestion} editaEstado={editaEstadoProveedor} />}
    </div>
  );
}

// ───────────────────────────── Clientes ─────────────────────────────────────

function TabClientes({ editaAutogestion, editaSinTramite, puedeCrearProveedor, veTarifas, editaEstado }: {
  editaAutogestion: boolean; editaSinTramite: boolean; puedeCrearProveedor: boolean; veTarifas: boolean; editaEstado: boolean;
}) {
  // `null` = cargando. Antes era `[]` desde el primer render y el `catch` ponía `[]` también, así
  // que un fallo del servidor se leía «No hay clientes.» y no había estado de carga: tres de los
  // cuatro estados colapsados en uno. Se paga aquí porque es sobre ESTA tabla donde se verifica que
  // el flag persiste, y si la recarga falla el admin no puede distinguir «se perdió lo que marqué»
  // de «no cargó».
  const [clientsBase, setClients] = useState<Client[] | null>(null);
  // HU #14105: `GET /clients` aún no entrega el proveedor de logística; se une desde parametrización.
  // Sin la función de lectura la asignación queda desconocida y no se marca ninguna compañía.
  const asignacion = useCompaniasAsignacion();
  const logisticaCat = useProveedoresLogistica(true);
  const clients = useMemo<Client[] | null>(() => {
    if (!clientsBase) return null;
    const mapa = new Map((asignacion.data ?? []).map((a) => [a.id, a.proveedorLogisticaId]));
    return clientsBase.map((c) => (mapa.has(c.id) ? { ...c, proveedorLogisticaId: mapa.get(c.id) ?? null } : c));
  }, [clientsBase, asignacion.data]);
  const nombreProveedor = (id: string | null | undefined) =>
    (id ? logisticaCat.data?.find((p) => p.id === id)?.nombre ?? null : null);
  const [soloSinProveedor, setSoloSinProveedor] = useState(false);
  const sinProveedor = useMemo(() => (clients ?? []).filter((c) => c.active && sinProveedorLogistica(c)), [clients]);
  // Bandera y no el mensaje: el error crudo del API no se pinta (AC5); el copy es fijo.
  const [errorCarga, setErrorCarga] = useState(false);
  // En estado del componente, no en la URL: al cambiar de pestaña y volver, vuelve a «Todos».
  const [filtroEstado, setFiltroEstado] = useState<FiltroEstado>('todos');
  const visibles = useMemo(
    () => (clients ? filtrarPorEstado(clients, filtroEstado, (c) => c.active).filter((c) => !soloSinProveedor || sinProveedorLogistica(c)) : []),
    [clients, filtroEstado, soloSinProveedor],
  );
  const [showForm, setShowForm] = useState(false);
  const [editarDe, setEditarDe] = useState<Client | null>(null);
  const [estadoDe, setEstadoDe] = useState<CambioEstado | null>(null);
  // Respaldo del foco al cerrar el diálogo si la fila salió del filtro (p. ej. «Activos» y se
  // desactivó): la pill marcada del filtro Estado, nunca <body>.
  const refFiltro = useRef<HTMLDivElement>(null);
  const refRespaldoFoco = useMemo<RefObject<HTMLElement | null>>(() => ({
    get current() { return refFiltro.current?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? null; },
  }), []);
  const [veredictos, setVeredictos] = useState<Map<number, VeredictoCliente>>(new Map());
  const FORM_VACIO = { name: '', document: '', documentType: 'NIT', branchOffice: '', phone: '', email: '', address: '', city: '', notes: '' };
  const [form, setForm] = useState(FORM_VACIO);
  // HU #13955: 409 de NIT+sucursal → mensaje bajo el NIT (AC1/AC2); se limpia al tocar NIT o sucursal.
  const [errorNit, setErrorNit] = useState<string | null>(null);
  const refNit = useRef<HTMLInputElement>(null);
  const idErrorNit = useId();

  /**
   * El catálogo de gestores, **una vez por pestaña y solo para quien lo puede leer**.
   *
   * No al abrir cada modal: reabrirlo compañía tras compañía repetiría el `GET` sin que el catálogo
   * haya cambiado. Y no para todos: la ruta es `admin`+`auditor`, así que `financiera` —que ve esta
   * pantalla— recibiría un 403 por un catálogo que ni siquiera se le ofrece.
   */
  const proveedores = useProveedoresSoat(editaSinTramite);

  const load = () => {
    setClients(null); setErrorCarga(false);
    asignacion.recargar();
    api.get<Client[]>('/clients').then(setClients).catch(() => setErrorCarga(true));
  };
  // Recarga SILENCIOSA (HU #13949): sin pasar por «Cargando compañías…» ni perder el filtro.
  const recargar = () => {
    asignacion.recargar();
    api.get<Client[]>('/clients').then(setClients).catch(() => setErrorCarga(true));
  };

  const eliminar = useEliminarCliente<Client>({
    // La fila sale con la respuesta 2xx (de todos los filtros) y la recarga confirma el resto.
    onEliminado: (c) => { setClients((prev) => (prev ?? []).filter((x) => x.id !== c.id)); recargar(); },
    onDesactualizado: recargar,
    restoreFocusRef: refRespaldoFoco,
  });

  const opcionesFila = (c: Client) => [
    ...(editaEstado
      ? [c.active
        ? { id: 'desactivar', texto: 'Desactivar', onElegir: () => setEstadoDe({ c, accion: 'desactivar' }) }
        : { id: 'activar', texto: 'Activar', onElegir: () => setEstadoDe({ c, accion: 'activar' }) }]
      : []),
    ...eliminar.opciones(c),
  ];

  // Quién puede facturarse y quién no (AC5). Se pide aparte del listado: un fallo del informe no
  // puede dejar sin pantalla de clientes a quien solo venía a mirar una tarifa.
  const cargarVeredictos = () => {
    api.get<{ data: VeredictoCliente[] }>('/siigo/clientes/validacion/detalle?incluirFacturables=true&limit=500')
      .then((r) => setVeredictos(new Map((r.data ?? []).map((v) => [v.clienteId, v]))))
      .catch(() => setVeredictos(new Map()));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); cargarVeredictos(); }, []);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const { branchOffice, ...textos } = form;
      const body: Record<string, string | number> = { ...textos };
      Object.keys(body).forEach((k) => { if (!body[k]) delete body[k]; });
      if (branchOffice.trim() !== '') body.branchOffice = Number(branchOffice);
      await api.post('/clients', body);
      toast.success('Cliente creado');
      setShowForm(false);
      setErrorNit(null);
      setForm(FORM_VACIO);
      load();
    } catch (err) {
      // El formulario sigue abierto con lo escrito (AC1): solo se marca el campo o se avisa.
      const nit = manejarErrorGuardarCliente(err);
      setErrorNit(nit);
      if (nit) refNit.current?.focus();
    }
  };

  return (
    <>
      {editaAutogestion && (
        <div><GradientButton type="button" onClick={() => setShowForm(!showForm)}>Nuevo cliente</GradientButton></div>
      )}

      {showForm && (
        <FlitCard>
          <h3 className="mb-3 text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Nuevo cliente</h3>
          <form onSubmit={handleCreate}>
            <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 md:grid-cols-4">
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Nombre o razón social *" className={flitInp} />
              <div>
                <input ref={refNit} value={form.document} aria-label="NIT / Cédula" placeholder="NIT / Cédula" className={flitInp}
                  aria-invalid={errorNit ? true : undefined} aria-describedby={errorNit ? idErrorNit : undefined}
                  onChange={(e) => { setErrorNit(null); setForm({ ...form, document: e.target.value }); }} />
                {errorNit && <ErrorNit id={idErrorNit}>{errorNit}</ErrorNit>}
              </div>
              <input type="number" min={SUCURSAL_MINIMA} max={SUCURSAL_MAXIMA} value={form.branchOffice} aria-label="Sucursal" placeholder="Sucursal (por defecto 0)" className={flitInp}
                onChange={(e) => { setErrorNit(null); setForm({ ...form, branchOffice: e.target.value }); }} />
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Teléfono" className={flitInp} />
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="Email" className={flitInp} />
              <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="Ciudad" className={flitInp} />
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Dirección" className={`${flitInp} sm:col-span-2`} />
            </div>
            <div className="mt-4 flex gap-2">
              <GradientButton type="submit">Guardar</GradientButton>
              <button type="button" onClick={() => { setShowForm(false); setErrorNit(null); }} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>Cancelar</button>
            </div>
          </form>
        </FlitCard>
      )}

      <FlitCard>
        {errorCarga ? (
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>No pudimos cargar los clientes.</p>
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={load}>Reintentar</button>
          </div>
        ) : clients === null ? (
          <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando compañías…</p>
        ) : clients.length === 0 ? (
          // Vacío total: filtro y pie ocultos (filtrar una lista vacía no ayuda).
          <FlitEmpty>No hay clientes.{editaAutogestion && ' Cree el primero con «Nuevo cliente».'}</FlitEmpty>
        ) : (<>
          {sinProveedor.length > 0 && (
            <div role="status" className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg px-3 py-2 text-sm font-semibold"
              style={{ background: 'var(--flit-chip-warning-bg)', color: 'var(--flit-warning-ink)' }}>
              <span>
                {sinProveedor.length === 1
                  ? '1 compañía con logística no tiene proveedor asignado. Asígnele uno para que pueda registrar viajes.'
                  : `${sinProveedor.length} compañías con logística no tienen proveedor asignado. Asígneles uno para que puedan registrar viajes.`}
              </span>
              {editaAutogestion && !soloSinProveedor && (
                <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setSoloSinProveedor(true)}>Ver compañías</button>
              )}
            </div>
          )}
          <div className="mb-3 flex flex-wrap items-end gap-x-6 gap-y-3" ref={refFiltro}>
            <FiltroEstadoPills valor={filtroEstado} onCambio={setFiltroEstado} />
            {sinProveedor.length > 0 && (
              <div role="group" aria-label="Logística" className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>Logística</span>
                <FlitPillGroup>
                  <FlitPillButton active={soloSinProveedor} pressed={soloSinProveedor} onClick={() => setSoloSinProveedor(!soloSinProveedor)}>
                    <span style={{ textTransform: 'none' }}>{`Sin proveedor (${sinProveedor.length})`}</span>
                  </FlitPillButton>
                </FlitPillGroup>
              </div>
            )}
          </div>
          {visibles.length === 0 ? (
            soloSinProveedor
              ? (
                <FlitEmpty>
                  Todas las compañías con logística tienen proveedor.{' '}
                  <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setSoloSinProveedor(false)}>Ver todas</button>
                </FlitEmpty>
              )
              : <VacioFiltro onVerTodos={() => setFiltroEstado('todos')} />
          ) : (
          <FlitTable>
            <thead>
              <FlitTr>
                <FlitTh>Empresa</FlitTh>
                <FlitTh>Documento</FlitTh>
                {/* Un chip por servicio: SOAT, Impuestos y Logística son los tres servicios. */}
                <FlitTh>Servicios</FlitTh>
                <FlitTh>Facturación</FlitTh>
                <FlitTh />
              </FlitTr>
            </thead>
            <tbody>
              {visibles.map((c) => (
                <FlitTr key={c.id}>
                  <td className="px-3 py-2 font-medium" style={{ color: 'var(--flit-text-primary)' }}>
                    {c.name}
                    <div className="mt-1"><ChipEstado activo={c.active} /></div>
                  </td>
                  <td className="px-3 py-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{c.documentType ?? 'NIT'} {c.document || '—'}</td>
                  <td className="min-w-[280px] px-3 py-2">
                    <ChipsServicios c={c} nombreProveedorLogistica={nombreProveedor(c.proveedorLogisticaId)}
                      editaSinTramite={editaSinTramite} puedeAbrir={editaAutogestion} onAbrir={() => setEditarDe(c)} />
                  </td>
                  <td className="px-3 py-2"><ChipFacturable veredicto={veredictos.get(c.id)} /></td>
                  <td className="px-3 py-2">
                    {/* La celda no envuelve (UX #13949): un solo «Editar» y el ⋮ de estado. */}
                    <div className="flex gap-2 whitespace-nowrap">
                      <button className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                        aria-label={`Editar ${c.name}`} onClick={() => setEditarDe(c)}>Editar</button>
                      <MenuFila etiqueta={`Acciones de ${c.name}`} opciones={opcionesFila(c)} onAbrir={() => eliminar.comprobar(c)} />
                    </div>
                  </td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
          )}
          <PieConteo visibles={visibles.length} total={clients.length} />
        </>)}
        {editaAutogestion && (
          <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            En «Editar» se marca «SOAT», «Impuestos» o «Logística» cuando FLITO gestiona ese servicio para la compañía; desmarcado, la compañía lo hace por su cuenta.
          </p>
        )}
      </FlitCard>

      {estadoDe && (
        <DialogoEstadoRegistro
          accion={estadoDe.accion}
          nombre={estadoDe.c.name}
          sustantivo="cliente"
          cargarImpacto={estadoDe.accion === 'desactivar'
            ? () => api.get<ImpactoEstado>(`/clients/${estadoDe.c.id}/impacto`)
            : undefined}
          consecuencia={estadoDe.accion === 'desactivar' ? CONSECUENCIA_DESACTIVAR : CONSECUENCIA_ACTIVAR}
          confirmar={async () => {
            await api.patch(`/clients/${estadoDe.c.id}/estado`, {
              activo: estadoDe.accion === 'activar', activoEsperado: estadoDe.c.active,
            });
          }}
          onHecho={() => {
            const { c, accion } = estadoDe;
            // La fila cambia con la respuesta 2xx (no antes) y la recarga confirma el resto.
            setClients((prev) => (prev ?? []).map((x) => (x.id === c.id ? { ...x, active: accion === 'activar' } : x)));
            setEstadoDe(null);
            toastOk(accion === 'desactivar' ? 'Cliente desactivado.' : 'Cliente activado.', { id: `estado-${c.id}` });
            recargar();
          }}
          onDesactualizado={(motivo) => {
            const id = estadoDe.c.id;
            setEstadoDe(null);
            toastError(motivo === 'cambiado'
              ? 'Otro administrador ya cambió su estado.'
              : 'Este cliente ya no existe. Se actualizó la lista.', undefined, { id: `estado-${id}` });
            recargar();
          }}
          onCerrar={() => setEstadoDe(null)}
          restoreFocusRef={refRespaldoFoco}
        />
      )}

      {eliminar.dialogo}

      {editarDe && (
        <ModalCliente
          // `key` por si la lista se recarga con la ficha abierta: el borrador es del servidor.
          cliente={clients?.find((x) => x.id === editarDe.id) ?? editarDe}
          editaAutogestion={editaAutogestion} editaSinTramite={editaSinTramite}
          puedeCrearProveedor={puedeCrearProveedor} veTarifas={veTarifas} editable={editaAutogestion}
          proveedoresSoat={proveedores}
          onClose={() => setEditarDe(null)}
          // Se recarga el listado entero: nombre y `activo` del gestor los resuelve el servidor.
          onGuardado={() => { setEditarDe(null); load(); }}
          // AC5 — al completar los datos fiscales la señal se actualiza sin recargar la pantalla.
          onFiscalGuardado={() => { load(); cargarVeredictos(); }}
        />
      )}
    </>
  );
}
