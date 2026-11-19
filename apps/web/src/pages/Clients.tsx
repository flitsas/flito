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
// tres checks que quedan son servicios y todos se leen invertidos.
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
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { toastError, toastOk } from '../components/flit/ToastFlito';
import { api, ApiError } from '../lib/api';
import { SUCURSAL_MAXIMA, SUCURSAL_MINIMA } from '@operaciones/shared-types';
import { useAuth } from '../lib/auth';
import { hasPage } from '../lib/permissions';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';
import {
  flitInp, FlitCard, FlitTable, FlitTh, FlitTr, FlitEmpty, FlitPillGroup, FlitPillButton,
  flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';
// Ficha fiscal (HU #11298). Vive en su propio componente desde el primer commit: esta pantalla ya
// tiene dos pestañas, un modal y dos formularios, y no cabe más sin acercarse al techo de 800.
import FichaFiscal, { ChipFacturable } from '../components/clientes/FichaFiscal';
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
import FlitSelect from '../components/flit/FlitSelect';
import { opcionesConEstado } from '../components/flit/opcionesConEstado';
import { useProveedoresSoat, type CatalogoProveedores } from './users/AtaduraFields';

// Un cliente ES una compañía FLITO: misma tabla. Por eso la autogestión, las tarifas y los datos de
// contacto se administran en el mismo sitio.
//
// Esta interfaz describe lo que `GET /clients` ENTREGA, que ya no es la fila completa sino las 26
// columnas de `COLUMNAS_LISTADO` (`clients.pii.ts`). `notes` no está: es texto libre que no debe
// viajar en un listado de 500 fichas. `active` sí (HU #13948): la tabla lo pinta y filtra por él.
interface Client {
  id: number; name: string; document: string | null; documentType: string | null;
  phone: string | null; email: string | null; address: string | null;
  city: string | null;
  /** HU #13948: el listado ya no trae eliminados; `false` = inactivo. */
  active: boolean;
  soatAutogestionable: boolean; impuestosAutogestionable: boolean; logisticaAutogestionable: boolean;
  /**
   * A qué gestor salen las solicitudes de ese canal, ya RESUELTO por `GET /clients` (HU #12079).
   *
   * `null` = la compañía no tiene ninguno configurado. El uuid **sí viaja** dentro de este objeto —el
   * `<select>` lo necesita para preseleccionar—; lo que no sale es la columna de `clients` a secas,
   * sin resolver. El listado la une con `flito_proveedores_soat` y entrega nombre y estado, porque `financiera` y `auditor` ven
   * esta pantalla y **no** pueden leer `GET /flito/parametrizacion/proveedores-soat` con el que
   * cruzarlo.
   *
   * `activo: false` no es un detalle: significa que las solicitudes NUEVAS de esa compañía están
   * cayendo en la contingencia de Operaciones, y esta pantalla es el único sitio donde alguien
   * puede enterarse.
   */
  gestorSoatSinTramite: { id: string; nombre: string; activo: boolean } | null;
  /**
   * HU #13967 (AC7) / #13968 (AC4): la compañía no tiene proveedor y algún usuario suyo ya tiene el
   * permiso de solicitar — un permiso que no surte efecto. Se pinta SOLO en el cuadro, nunca en la
   * fila. `soatSinTramite` (deprecado) ya no se lee: el proveedor ES el canal.
   */
  permisoSinTramiteSinEfecto?: boolean;
}

// «SOAT sin trámite» no está aquí: desde la HU #13968 es una sola decisión —a qué proveedor salen
// las solicitudes, o a ninguno— y vive en `ModalCanalSoat`.
// Los tres `*Autogestionable` se pintan invertidos (HU #13935): el check dice «FLITO gestiona».
type FlagCampo = 'soatAutogestionable' | 'impuestosAutogestionable' | 'logisticaAutogestionable';
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
  // El enlace al configurador se decide por la PÁGINA, no por el nombre del rol: es el mismo gate
  // que la ruta de destino, así que nadie llega a un `NoAccess` desde aquí.
  const veTarifas = hasPage(user, 'flito_tarifas');
  const [tab, setTab] = useState<Tab>('clientes');

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Clientes y proveedores"
        subtitle="Compañías con los servicios que gestiona FLITO y sus tarifas negociadas, y los proveedores de SOAT a los que se enrutan los trámites."
      />

      <FlitPillGroup>
        <FlitPillButton active={tab === 'clientes'} onClick={() => setTab('clientes')}>Clientes</FlitPillButton>
        <FlitPillButton active={tab === 'proveedores'} onClick={() => setTab('proveedores')}>Proveedores</FlitPillButton>
      </FlitPillGroup>

      {tab === 'clientes'
        ? <TabClientes editaAutogestion={editaAutogestion} editaSinTramite={editaSinTramite} veTarifas={veTarifas} editaEstado={editaEstado} />
        : <TabProveedores editable={editaAutogestion} editaEstado={editaEstadoProveedor} />}
    </div>
  );
}

// ───────────────────────────── Clientes ─────────────────────────────────────

function TabClientes({ editaAutogestion, editaSinTramite, veTarifas, editaEstado }: {
  editaAutogestion: boolean; editaSinTramite: boolean; veTarifas: boolean; editaEstado: boolean;
}) {
  // `null` = cargando. Antes era `[]` desde el primer render y el `catch` ponía `[]` también, así
  // que un fallo del servidor se leía «No hay clientes.» y no había estado de carga: tres de los
  // cuatro estados colapsados en uno. Se paga aquí porque es sobre ESTA tabla donde se verifica que
  // el flag persiste, y si la recarga falla el admin no puede distinguir «se perdió lo que marqué»
  // de «no cargó».
  const [clients, setClients] = useState<Client[] | null>(null);
  // Bandera y no el mensaje: el error crudo del API no se pinta (AC5); el copy es fijo.
  const [errorCarga, setErrorCarga] = useState(false);
  // En estado del componente, no en la URL: al cambiar de pestaña y volver, vuelve a «Todos».
  const [filtroEstado, setFiltroEstado] = useState<FiltroEstado>('todos');
  const visibles = useMemo(
    () => (clients ? filtrarPorEstado(clients, filtroEstado, (c) => c.active) : []),
    [clients, filtroEstado],
  );
  const [showForm, setShowForm] = useState(false);
  const [fiscalDe, setFiscalDe] = useState<Client | null>(null);
  const [canalDe, setCanalDe] = useState<Client | null>(null);
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
    api.get<Client[]>('/clients').then(setClients).catch(() => setErrorCarga(true));
  };
  // Recarga SILENCIOSA (HU #13949): sin pasar por «Cargando compañías…» ni perder el filtro.
  const recargar = () => {
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

  // Toggle de un flag: PATCH del flag suelto. Optimista con reversión si falla. Invertir la lectura
  // (HU #13935) no cambia esto: marcar o desmarcar siempre voltea el dato, y lo que viaja es el
  // valor REAL de `*Autogestionable` (marcar «FLITO gestiona» ⇒ `false`).
  const toggleFlag = async (c: Client, campo: FlagCampo, label: string) => {
    const valor = !c[campo];
    setClients((prev) => (prev ?? []).map((x) => (x.id === c.id ? { ...x, [campo]: valor } : x)));
    try {
      // El PATCH manda UNA sola clave y el servidor copia al `set` solo las claves definidas: por
      // eso la independencia del AC3 es por construcción y no por una regla que haya que recordar.
      await api.patch(`/flito/parametrizacion/companias/${c.id}`, { [campo]: valor });
    } catch {
      setClients((prev) => (prev ?? []).map((x) => (x.id === c.id ? { ...x, [campo]: !valor } : x)));
      // Copy propio y no el error crudo del API: qué pasó y qué sigue, en una frase.
      // El toast del kit es cerrable; un id por casilla para que el reintento sustituya y no apile.
      toastError(`No se pudo guardar «${label}» de ${c.name}: la casilla volvió a como estaba. Inténtelo de nuevo.`,
        undefined, { id: `flag-${c.id}-${campo}` });
    }
  };

  const CeldaFlag = ({ c, campo, label }: { c: Client; campo: FlagCampo; label: string }) => (
    <td className="px-3 py-2 text-center">
      <input
        type="checkbox"
        className="h-4 w-4 cursor-pointer align-middle disabled:cursor-not-allowed"
        checked={!c[campo]}
        disabled={!editaAutogestion}
        aria-label={`FLITO gestiona ${label} de ${c.name}`}
        onChange={() => toggleFlag(c, campo, label)}
      />
    </td>
  );

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
          <div className="mb-3" ref={refFiltro}><FiltroEstadoPills valor={filtroEstado} onCambio={setFiltroEstado} /></div>
          {visibles.length === 0 ? <VacioFiltro onVerTodos={() => setFiltroEstado('todos')} /> : (
          <FlitTable>
            <thead>
              <FlitTr>
                <FlitTh>Empresa</FlitTh>
                {/* Identificador + estado siempre visibles: el estado va justo tras «Empresa». */}
                <FlitTh>Estado</FlitTh>
                <FlitTh>Documento</FlitTh>
                <FlitTh>Ciudad</FlitTh>
                <FlitTh>Teléfono</FlitTh>
                <FlitTh>Email</FlitTh>
                <FlitTh center>SOAT</FlitTh>
                <FlitTh center>Impuestos</FlitTh>
                <FlitTh center>Logística</FlitTh>
                {/* Al FINAL del bloque de banderas y no pegada a «SOAT»: contiguas se leerían como
                    dos variantes del mismo interruptor, que es justo el malentendido que el AC3
                    quiere evitar. Separada, se lee como lo que es: otra cosa. */}
                <FlitTh center>SOAT sin trámite</FlitTh>
                <FlitTh>Facturación</FlitTh>
                <FlitTh />
              </FlitTr>
            </thead>
            <tbody>
              {visibles.map((c) => (
                <FlitTr key={c.id}>
                  <td className="px-3 py-2 font-medium" style={{ color: 'var(--flit-text-primary)' }}>{c.name}</td>
                  <td className="px-3 py-2"><ChipEstado activo={c.active} /></td>
                  <td className="px-3 py-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{c.documentType ?? 'NIT'} {c.document || '—'}</td>
                  <td className="px-3 py-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{c.city || '—'}</td>
                  <td className="px-3 py-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{c.phone || '—'}</td>
                  <td className="px-3 py-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{c.email || '—'}</td>
                  <CeldaFlag c={c} campo="soatAutogestionable" label="SOAT" />
                  <CeldaFlag c={c} campo="impuestosAutogestionable" label="Impuestos" />
                  <CeldaFlag c={c} campo="logisticaAutogestionable" label="Logística" />
                  <CeldaCanalSoat c={c} editable={editaSinTramite} onAbrir={() => setCanalDe(c)} />
                  <td className="px-3 py-2"><ChipFacturable veredicto={veredictos.get(c.id)} /></td>
                  <td className="px-3 py-2">
                    {/* La celda no envuelve (UX #13949): con el ⋮, «Datos fiscales» se partía en dos líneas. */}
                    <div className="flex gap-2 whitespace-nowrap">
                      {veTarifas && (
                        <Link to={`/flito/tarifas/${c.id}`} className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                          aria-label={`Tarifas de ${c.name}`}>Tarifas</Link>
                      )}
                      <button className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                        aria-label={`Datos fiscales de ${c.name}`}
                        onClick={() => setFiscalDe(c)}>Datos fiscales</button>
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
            Marca «SOAT», «Impuestos» o «Logística» cuando FLITO gestiona ese servicio para la compañía; desmarcado, la compañía lo hace por su cuenta.
          </p>
        )}
        {editaSinTramite && (
          <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            «SOAT sin trámite» dice a qué proveedor salen las solicitudes que los usuarios Cliente de la
            compañía hacen sin un trámite abierto; «Sin proveedor» deja esa opción cerrada. Es independiente de
            la casilla «SOAT».
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

      {canalDe && (
        <ModalCanalSoat
          cliente={canalDe} proveedores={proveedores}
          onClose={() => setCanalDe(null)}
          // Se recarga el listado entero, como hace la ficha fiscal, en vez de parchear la fila con
          // lo que el modal cree haber guardado: el nombre y el `activo` del gestor los resuelve el
          // servidor, y adivinarlos aquí sería una segunda verdad que se desincroniza en cuanto
          // alguien desactive un proveedor desde la otra pestaña.
          onGuardado={() => { setCanalDe(null); load(); }}
        />
      )}

      {fiscalDe && (
        <FichaFiscal
          clienteId={fiscalDe.id}
          clienteNombre={fiscalDe.name}
          editable={editaAutogestion}
          onClose={() => setFiscalDe(null)}
          // AC5 — al completar los datos la señal se actualiza sin recargar la pantalla.
          onGuardado={() => { load(); cargarVeredictos(); }}
        />
      )}
    </>
  );
}

// ───────────────── «SOAT sin trámite»: el proveedor de la compañía (HU #12079 → #13968) ──────────
//
// Diseño vigente: `docs/ux/clientes-soat-sin-tramite-proveedor-13968-slim.md` (reemplaza el §1 de
// `soat-envio-directo-al-gestor-y-gestor-por-defecto.md` en lo que toca al cuadro y la columna).
//
// Desde la HU #13967 el canal ya no es un interruptor más un gestor: **el proveedor elegido ES el
// canal**. Con proveedor, los usuarios Cliente que tengan el permiso pueden solicitar; con «Sin
// proveedor», nadie de la compañía puede. Una sola decisión, un solo control.
//
// **Por qué sigue siendo un cuadro y no un `<select>` por fila:** `FlitSelect` monta una región
// `role="status"` por instancia y este listado viene sin paginar (cientos de regiones vivas y una
// parada de tabulador más por fila), y la tabla ya es la más densa del producto.
//
// **El error de guardado nunca es `errorMessage(err)` crudo**: con `fieldErrors` antepone el nombre
// del campo («proveedorSoatSinTramiteId: …»). Se traduce por estado HTTP a una frase en usted.

const PROVEEDOR_LABEL = 'Proveedor de SOAT sin trámite';
const PROVEEDOR_NINGUNO = 'Sin proveedor';
const PROVEEDOR_AYUDA = 'A este proveedor salen las solicitudes nuevas. Con «Sin proveedor», los usuarios de la compañía no pueden solicitar SOAT sin trámite. Las ya radicadas conservan su proveedor.';
const PROVEEDOR_CARGANDO = 'Cargando proveedores…';
const PROVEEDOR_ERROR = 'No se pudieron cargar los proveedores.';
const PROVEEDOR_VACIO = 'No hay proveedores de SOAT activos. Cree uno en la pestaña Proveedores.';
const PROVEEDOR_REINTENTO = 'Volver a cargar';
const AVISO_PERMISO_SIN_EFECTO = 'Tiene usuarios con permiso de SOAT sin trámite, pero no tiene proveedor elegido: el permiso no toma efecto hasta elegirlo.';
const ERROR_PROVEEDOR_NO_ACTIVO = 'Ese proveedor ya no está activo. Elija otro o «Sin proveedor».';
const ERROR_SIN_PERMISO = 'No tiene permiso para elegir el proveedor de esta compañía.';
const ERROR_GENERICO = 'No se pudo guardar el proveedor. Intente de nuevo en un momento.';
const TOAST_CON_PROVEEDOR = 'Proveedor de SOAT sin trámite actualizado. Las solicitudes ya radicadas conservan el suyo.';
const toastSinProveedor = (compania: string) =>
  `${compania} queda sin proveedor: sus usuarios no pueden solicitar SOAT sin trámite.`;

/** El copy pulido del guardado fallido (UX §Estados): por estado HTTP, nunca el texto del servidor. */
function mensajeErrorGuardado(err: unknown): string {
  const status = err instanceof ApiError ? err.status : 0;
  if (status === 400 || status === 409) return ERROR_PROVEEDOR_NO_ACTIVO;
  if (status === 403) return ERROR_SIN_PERMISO;
  return ERROR_GENERICO;
}

/**
 * Lo que la celda dice, en una sola frase y **en tono neutro** (HU #13968, AC3): el nombre, el
 * nombre con «(inactivo)» o «Sin proveedor». Sin «Abierto/Cerrado» y sin color de aviso: el
 * proveedor es un dato, no una alarma. Ya no lee `soatSinTramite` (deprecado).
 */
function textoCanal(c: Client): string {
  const g = c.gestorSoatSinTramite;
  if (!g) return PROVEEDOR_NINGUNO;
  return g.activo ? g.nombre : `${g.nombre} (inactivo)`;
}

/**
 * La celda: **un solo control**, la misma cuenta de paradas de tabulador que la casilla que
 * sustituyó, y la tabla sigue con los mismos encabezados.
 *
 * Sin la acción no se pinta un botón muerto sino el mismo texto en un `<span>`.
 *
 * ⚠ El nombre accesible **contiene el texto visible** (WCAG 2.5.3, «Label in Name») y lleva el
 * NOMBRE de la compañía, nunca su NIT.
 */
function CeldaCanalSoat({ c, editable, onAbrir }: { c: Client; editable: boolean; onAbrir: () => void }) {
  const texto = textoCanal(c);
  return (
    <td className="px-3 py-2 text-center">
      {editable ? (
        <button
          type="button"
          className={`${flitBtnSecondary} whitespace-nowrap`}
          style={flitBtnSecondaryStyle}
          aria-label={`SOAT sin trámite de ${c.name}: ${texto}`}
          onClick={onAbrir}
        >
          {texto}
        </button>
      ) : (
        <span className="text-sm whitespace-nowrap" style={{ color: 'var(--flit-text-secondary)' }}>{texto}</span>
      )}
    </td>
  );
}

/**
 * El proveedor de la compañía, en un borrador que se guarda de una vez.
 *
 * «Sin proveedor» es un **valor válido** (se envía `null`), no un vacío: no hay `required` ni
 * combinación inválida que validar. Si el valor no cambió, Guardar cierra sin petición.
 */
function ModalCanalSoat({ cliente, proveedores, onClose, onGuardado }: {
  cliente: Client; proveedores: CatalogoProveedores; onClose: () => void; onGuardado: () => void;
}) {
  const idAviso = useId();
  const actual = cliente.gestorSoatSinTramite?.id ?? '';
  const [proveedorId, setProveedorId] = useState(actual);
  const [errorServidor, setErrorServidor] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const { data, error: errorCarga, recargar } = proveedores;
  const cargando = data === null && !errorCarga;
  const sinEfecto = cliente.permisoSinTramiteSinEfecto === true;

  /**
   * HU #13963: todo el catálogo (los eliminados el API ya no los devuelve), con los inactivos en
   * gris, «Inactivo» y sin poder elegirse (`opcionesConEstado`, HU #13950). El asignado actual se
   * conserva aunque esté inactivo —o aunque ya no venga en el catálogo—: vaciarlo haría que **guardar
   * sin tocar le quitara el proveedor por la espalda** (AC4).
   */
  const ofrecidos = useMemo(() => {
    const catalogo = data ?? [];
    const asignado = cliente.gestorSoatSinTramite;
    return asignado && !catalogo.some((p) => p.id === asignado.id)
      ? [...catalogo, { id: asignado.id, nombre: asignado.nombre, activo: asignado.activo }]
      : catalogo;
  }, [data, cliente.gestorSoatSinTramite]);

  const vacio = data !== null && !ofrecidos.some((p) => p.activo || p.id === actual);
  const mensaje = errorCarga ? PROVEEDOR_ERROR : cargando ? PROVEEDOR_CARGANDO : vacio ? PROVEEDOR_VACIO : null;
  const selectorInutil = cargando || vacio || !!errorCarga;

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    if (selectorInutil) return;
    if (proveedorId === actual) { onClose(); return; }
    setErrorServidor(null); setGuardando(true);
    try {
      // Solo el proveedor (HU #13967): `soatSinTramite` ya no se envía.
      await api.patch(`/flito/parametrizacion/companias/${cliente.id}`, {
        proveedorSoatSinTramiteId: proveedorId || null,
      });
      toast.success(proveedorId ? TOAST_CON_PROVEEDOR : toastSinProveedor(cliente.name));
      onGuardado();
    } catch (err) {
      // El cuadro **no se cierra** y el borrador **no se pierde**: si fue una carrera (alguien
      // desactivó ese proveedor), basta con elegir otro.
      setErrorServidor(mensajeErrorGuardado(err));
    } finally {
      setGuardando(false);
    }
  };

  return (
    <FlitModal title={`SOAT sin trámite · ${cliente.name}`} onClose={onClose}>
      <form onSubmit={guardar} className="space-y-4">
        {sinEfecto && (
          // Aviso en página (es estado, no resultado): se queda mientras el cuadro esté abierto
          // aunque se elija proveedor en el borrador, porque el dato es del servidor.
          <p
            id={idAviso}
            className="rounded-lg px-3 py-2 text-sm font-semibold"
            style={{ background: 'var(--flit-chip-warning-bg)', color: 'var(--flit-warning-ink)' }}
          >
            {AVISO_PERMISO_SIN_EFECTO}
          </p>
        )}

        <FlitSelect
          label={PROVEEDOR_LABEL}
          value={proveedorId}
          onChange={(v) => { setProveedorId(v); setErrorServidor(null); }}
          opciones={opcionesConEstado(ofrecidos, data ? proveedorId : '', { placeholder: PROVEEDOR_NINGUNO })}
          ayuda={PROVEEDOR_AYUDA}
          mensaje={mensaje}
          fallo={!!errorCarga}
          disabled={selectorInutil}
          // Solo el fallo de carga se reintenta: en vacío, recargar no crea proveedores.
          onReintentar={errorCarga ? recargar : undefined}
          textoReintento={PROVEEDOR_REINTENTO}
          describedBy={sinEfecto ? idAviso : undefined}
        />

        {errorServidor && (
          // `--flit-danger-text` y no `-ink`: en claro valen lo mismo, y en oscuro el `-ink` sobre el
          // modal se hunde en ~2,5:1 (HU #12819).
          <p role="alert" className="text-sm font-semibold" style={{ color: 'var(--flit-danger-text)' }}>
            {errorServidor}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>
            Cancelar
          </button>
          <GradientButton type="submit" disabled={guardando || selectorInutil}>
            {guardando ? 'Guardando…' : 'Guardar'}
          </GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}
