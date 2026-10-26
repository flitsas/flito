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

import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { toastError } from '../components/flit/ToastFlito';
import { api, ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { hasPage } from '../lib/permissions';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';
import StatusChip from '../components/flit/StatusChip';
import {
  flitInp, FlitCard, FlitTable, FlitTh, FlitTr, FlitEmpty, FlitField, FlitPillGroup, FlitPillButton,
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';
// Ficha fiscal (HU #11298). Vive en su propio componente desde el primer commit: esta pantalla ya
// tiene dos pestañas, un modal y dos formularios, y no cabe más sin acercarse al techo de 800.
import FichaFiscal, { ChipFacturable } from '../components/clientes/FichaFiscal';
import type { VeredictoCliente } from '../components/clientes/tipos';
// El catálogo de gestores de SOAT y su selector con los cuatro estados (HU #12053). Se REUTILIZA y
// no se copia: `ProveedorSoatField` ya resuelve el caso que aquí también hace falta —reinyectar el
// gestor asignado aunque esté desactivado, para que guardar otra cosa no se lo quite a la compañía
// por la espalda— y su copy vive junto al de Usuarios.
import FlitSelect from '../components/flit/FlitSelect';
import { useProveedoresSoat, type CatalogoProveedores } from './users/AtaduraFields';

// Un cliente ES una compañía FLITO: misma tabla. Por eso la autogestión, las tarifas y los datos de
// contacto se administran en el mismo sitio.
//
// Esta interfaz describe lo que `GET /clients` ENTREGA, que ya no es la fila completa sino las 26
// columnas de `COLUMNAS_LISTADO` (`clients.pii.ts`). `notes` y `active` estaban declarados aquí sin
// que nadie los leyera; quedarse con ellos sería prometer en el tipo dos campos que la respuesta no
// trae — y `notes` es texto libre que no debe viajar en un listado de 500 fichas.
interface Client {
  id: number; name: string; document: string | null; documentType: string | null;
  phone: string | null; email: string | null; address: string | null;
  city: string | null;
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
interface Proveedor {
  id: string; nombre: string; estrategia: string | null;
  umbralOcr: number | null; slaHoras: number | null; activo: boolean;
}

// «SOAT sin trámite» no está aquí: desde la HU #13968 es una sola decisión —a qué proveedor salen
// las solicitudes, o a ninguno— y vive en `ModalCanalSoat`.
// Los tres `*Autogestionable` se pintan invertidos (HU #13935): el check dice «FLITO gestiona».
type FlagCampo = 'soatAutogestionable' | 'impuestosAutogestionable' | 'logisticaAutogestionable';
type Tab = 'clientes' | 'proveedores';

export default function Clients() {
  const { user, hasFuncion } = useAuth();
  // Operaciones decide qué gestiona FLITO; Finanzas solo pone precio.
  // HU #12170
  const editaAutogestion = hasFuncion('tramites.autogestion.desbloquear');
  // HU #13968 (AC2): el proveedor de «SOAT sin trámite» tiene su PROPIA acción. `editaAutogestion`
  // sigue gobernando las casillas, Proveedores y la ficha fiscal; esto, solo la celda, el cuadro y
  // la nota al pie.
  const editaSinTramite = hasFuncion('parametrizacion.companias.soat_sin_tramite');
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
        ? <TabClientes editaAutogestion={editaAutogestion} editaSinTramite={editaSinTramite} veTarifas={veTarifas} />
        : <TabProveedores editable={editaAutogestion} />}
    </div>
  );
}

// ───────────────────────────── Clientes ─────────────────────────────────────

function TabClientes({ editaAutogestion, editaSinTramite, veTarifas }: {
  editaAutogestion: boolean; editaSinTramite: boolean; veTarifas: boolean;
}) {
  // `null` = cargando. Antes era `[]` desde el primer render y el `catch` ponía `[]` también, así
  // que un fallo del servidor se leía «No hay clientes.» y no había estado de carga: tres de los
  // cuatro estados colapsados en uno. Se paga aquí porque es sobre ESTA tabla donde se verifica que
  // el flag persiste, y si la recarga falla el admin no puede distinguir «se perdió lo que marqué»
  // de «no cargó».
  const [clients, setClients] = useState<Client[] | null>(null);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [fiscalDe, setFiscalDe] = useState<Client | null>(null);
  const [canalDe, setCanalDe] = useState<Client | null>(null);
  const [veredictos, setVeredictos] = useState<Map<number, VeredictoCliente>>(new Map());
  const [form, setForm] = useState({ name: '', document: '', documentType: 'NIT', phone: '', email: '', address: '', city: '', notes: '' });

  /**
   * El catálogo de gestores, **una vez por pestaña y solo para quien lo puede leer**.
   *
   * No al abrir cada modal: reabrirlo compañía tras compañía repetiría el `GET` sin que el catálogo
   * haya cambiado. Y no para todos: la ruta es `admin`+`auditor`, así que `financiera` —que ve esta
   * pantalla— recibiría un 403 por un catálogo que ni siquiera se le ofrece.
   */
  const proveedores = useProveedoresSoat(editaSinTramite);

  const load = () => {
    setClients(null); setErrorCarga(null);
    api.get<Client[]>('/clients').then(setClients).catch((err) => setErrorCarga(errorMessage(err)));
  };

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
      const body: Record<string, string> = { ...form };
      Object.keys(body).forEach((k) => { if (!body[k]) delete body[k]; });
      await api.post('/clients', body);
      toast.success('Cliente creado');
      setShowForm(false);
      setForm({ name: '', document: '', documentType: 'NIT', phone: '', email: '', address: '', city: '', notes: '' });
      load();
    } catch (err) {
      toast.error(errorMessage(err));
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
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Nombre o razón social *" className={flitInp} />
              <input value={form.document} onChange={(e) => setForm({ ...form, document: e.target.value })} placeholder="NIT / Cédula" className={flitInp} />
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Teléfono" className={flitInp} />
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="Email" className={flitInp} />
              <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="Ciudad" className={flitInp} />
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Dirección" className={`${flitInp} col-span-2`} />
            </div>
            <div className="mt-4 flex gap-2">
              <GradientButton type="submit">Guardar</GradientButton>
              <button type="button" onClick={() => setShowForm(false)} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>Cancelar</button>
            </div>
          </form>
        </FlitCard>
      )}

      <FlitCard>
        {errorCarga ? (
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{errorCarga}</p>
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={load}>Reintentar</button>
          </div>
        ) : clients === null ? (
          <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando compañías…</p>
        ) : clients.length === 0 ? <FlitEmpty>No hay clientes.</FlitEmpty> : (
          <FlitTable>
            <thead>
              <FlitTr>
                <FlitTh>Empresa</FlitTh>
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
              {clients.map((c) => (
                <FlitTr key={c.id}>
                  <td className="px-3 py-2 font-medium" style={{ color: 'var(--flit-text-primary)' }}>{c.name}</td>
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
                    <div className="flex gap-2">
                      {veTarifas && (
                        <Link to={`/flito/tarifas/${c.id}`} className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                          aria-label={`Tarifas de ${c.name}`}>Tarifas</Link>
                      )}
                      <button className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                        aria-label={`Datos fiscales de ${c.name}`}
                        onClick={() => setFiscalDe(c)}>Datos fiscales</button>
                    </div>
                  </td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
        )}
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
   * Los ACTIVOS más el asignado actual si ya no lo está. Filtrar por `activo` a secas dejaría el
   * `<select>` en «Sin proveedor» y **guardar sin tocar le quitaría el proveedor por la espalda**.
   */
  const ofrecidos = useMemo(() => {
    const activos = (data ?? []).filter((p) => p.activo);
    const asignado = cliente.gestorSoatSinTramite;
    return asignado && !activos.some((p) => p.id === asignado.id)
      ? [...activos, { id: asignado.id, nombre: asignado.nombre, activo: asignado.activo }]
      : activos;
  }, [data, cliente.gestorSoatSinTramite]);

  const vacio = data !== null && ofrecidos.length === 0;
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
          opciones={[
            { valor: '', etiqueta: PROVEEDOR_NINGUNO },
            ...ofrecidos.map((p) => ({ valor: p.id, etiqueta: p.nombre, ...(p.activo ? {} : { nota: 'inactivo' }) })),
          ]}
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

// ───────────────────────────── Proveedores SOAT ─────────────────────────────

function TabProveedores({ editable }: { editable: boolean }) {
  const [data, setData] = useState<Proveedor[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);
  const [editar, setEditar] = useState<Proveedor | null>(null);
  const [crear, setCrear] = useState(false);

  useEffect(() => {
    setData(null); setError(null);
    api.get<Proveedor[]>('/flito/parametrizacion/proveedores-soat').then(setData).catch((e) => setError(errorMessage(e)));
  }, [recarga]);

  const refrescar = () => setRecarga((n) => n + 1);

  if (error) return <FlitCard><p className="text-sm text-red-600">{error}</p></FlitCard>;
  if (!data) return <FlitCard><p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando…</p></FlitCard>;

  return (
    <>
      {editable && <div><button className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={() => setCrear(true)}>Nuevo proveedor</button></div>}
      <FlitCard>
        {data.length === 0 ? <FlitEmpty>No hay proveedores. Crea el primero con «Nuevo proveedor».</FlitEmpty> : (
          <FlitTable>
            <thead><FlitTr><FlitTh>Nombre</FlitTh><FlitTh>Estrategia</FlitTh><FlitTh>Umbral OCR</FlitTh><FlitTh>ANS pactado (h)</FlitTh><FlitTh>Estado</FlitTh><FlitTh /></FlitTr></thead>
            <tbody>
              {data.map((p) => (
                <FlitTr key={p.id}>
                  <td className="px-3 py-2 font-medium">{p.nombre}</td>
                  <td className="px-3 py-2 text-sm">{p.estrategia ?? '—'}</td>
                  <td className="px-3 py-2 text-sm tabular-nums">{p.umbralOcr ?? '—'}</td>
                  <td className="px-3 py-2 text-sm tabular-nums">{p.slaHoras ?? '—'}</td>
                  <td className="px-3 py-2"><StatusChip tone={p.activo ? 'success' : 'neutral'}>{p.activo ? 'Activo' : 'Inactivo'}</StatusChip></td>
                  <td className="px-3 py-2">{editable && <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setEditar(p)}>Editar</button>}</td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
        )}
        <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          El ANS de gestión es único para toda la operación: un día desde que se envía la solicitud.
          Estas horas quedan como referencia de lo pactado con cada proveedor, pero ya no deciden
          cuándo un SOAT se marca sin gestión en la cola. El proveedor se elige al enviarlo al gestor.
        </p>
      </FlitCard>
      {crear && <FormProveedor onClose={() => setCrear(false)} onGuardado={() => { setCrear(false); refrescar(); }} />}
      {editar && <FormProveedor proveedor={editar} onClose={() => setEditar(null)} onGuardado={() => { setEditar(null); refrescar(); }} />}
    </>
  );
}

function FormProveedor({ proveedor, onClose, onGuardado }: { proveedor?: Proveedor; onClose: () => void; onGuardado: () => void }) {
  const [nombre, setNombre] = useState(proveedor?.nombre ?? '');
  const [estrategia, setEstrategia] = useState(proveedor?.estrategia ?? '');
  const [umbral, setUmbral] = useState(proveedor?.umbralOcr != null ? String(proveedor.umbralOcr) : '');
  const [sla, setSla] = useState(proveedor?.slaHoras != null ? String(proveedor.slaHoras) : '');
  const [activo, setActivo] = useState(proveedor?.activo ?? true);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const guardar = async () => {
    setGuardando(true); setError(null);
    const body: Record<string, unknown> = {
      nombre: nombre.trim(),
      estrategia: estrategia.trim() || undefined,
      umbralOcr: umbral.trim() === '' ? null : Number(umbral),
      slaHoras: sla.trim() === '' ? null : Number(sla),
    };
    try {
      if (proveedor) { body.activo = activo; await api.patch(`/flito/parametrizacion/proveedores-soat/${proveedor.id}`, body); }
      else await api.post('/flito/parametrizacion/proveedores-soat', body);
      onGuardado();
    } catch (e) { setError(errorMessage(e)); }
    finally { setGuardando(false); }
  };

  return (
    <FlitModal title={proveedor ? 'Editar proveedor' : 'Nuevo proveedor'} onClose={onClose}>
      <div className="space-y-3">
        <FlitField label="Nombre *"><input className={flitInp} value={nombre} onChange={(e) => setNombre(e.target.value)} /></FlitField>
        <FlitField label="Estrategia"><input className={flitInp} value={estrategia} onChange={(e) => setEstrategia(e.target.value)} placeholder="p.ej. portal, correo" /></FlitField>
        <FlitField label="Umbral OCR (0–1)"><input className={flitInp} type="number" step="0.01" min="0" max="1" value={umbral} onChange={(e) => setUmbral(e.target.value)} /></FlitField>
        <FlitField label="ANS pactado con el proveedor (horas)"><input className={flitInp} type="number" min="1" value={sla} onChange={(e) => setSla(e.target.value)} /></FlitField>
        {proveedor && (
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Activo</span>
            <input type="checkbox" checked={activo} onChange={(e) => setActivo(e.target.checked)} />
          </label>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2">
          <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={guardando || !nombre.trim()} onClick={guardar}>{guardando ? 'Guardando…' : 'Guardar'}</button>
          <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>Cancelar</button>
        </div>
      </div>
    </FlitModal>
  );
}
