// Clientes y proveedores (HU #10979).
//
// Fusiona la antigua «Cartera de clientes» con «Parametrización». Eran dos pantallas para una misma
// compañía: en una se marcaba si autogestiona, en la otra se le ponían las tarifas — y el toggle de
// autogestión ya llamaba al endpoint de parametrización. Todo lo que es del cliente vive aquí.
//
// Las tarifas se abren por fila, en modal: cada compañía puede tener varias (por concepto y por tipo
// de trámite) y meterlas como columnas habría hecho ilegible una tabla que ya tiene nueve.
//
// Quién puede qué:
//   admin       — todo.
//   financiera  — tarifas sí, autogestión no: qué gestiona FLITO es decisión de Operaciones.
//   auditor     — solo lectura.

import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { CONCEPTOS_TARIFA, CONCEPTO_TARIFA_LABEL, type ConceptoTarifa } from '@operaciones/shared-types';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { puedeOperar } from '../lib/permissions';
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
  logisticaPermiteParcial: boolean;
  /**
   * «SOAT sin trámite» (Feature #11912): si los usuarios `cliente` de esta compañía pueden pedirle
   * un SOAT a FLITO sin que haya trámite abierto. Independiente de `soatAutogestionable`.
   *
   * Se LEE por `GET /clients`, como sus cuatro vecinas, y se ESCRIBE por
   * `PATCH /flito/parametrizacion/companias/:id`, también como ellas. Esa asimetría es la que ya
   * existía; lo que no puede haber es una casilla de esta tabla que se lea por una ruta distinta a
   * las de al lado, porque `financiera` ve esta pantalla y NO entra a parametrización.
   */
  soatSinTramite: boolean;
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
}
interface Proveedor {
  id: string; nombre: string; estrategia: string | null;
  umbralOcr: number | null; slaHoras: number | null; activo: boolean;
}
interface Tarifa {
  id: string; companiaId: number; companiaNombre: string | null;
  concepto: ConceptoTarifa; tipoTramite: string | null; valor: number; activo: boolean;
}

// «SOAT sin trámite» YA NO está aquí (HU #12079): dejó de ser un booleano suelto con `PATCH`
// optimista para ser una decisión con un parámetro obligatorio —el gestor—, y un PATCH por control
// no sabe expresar «abre el canal y manda a SURA» de una sola vez. Vive en `ModalCanalSoat`.
type FlagCampo = 'soatAutogestionable' | 'impuestosAutogestionable' | 'logisticaAutogestionable' | 'logisticaPermiteParcial';
type Tab = 'clientes' | 'proveedores';

const pesos = (v: number) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(v);

export default function Clients() {
  const { user } = useAuth();
  // Operaciones decide qué gestiona FLITO; Finanzas solo pone precio.
  const editaAutogestion = puedeOperar(user?.role);
  const editaTarifas = user?.role === 'admin' || user?.role === 'financiera';
  const [tab, setTab] = useState<Tab>('clientes');

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Clientes y proveedores"
        subtitle="Compañías con su autogestión y sus tarifas negociadas, y los proveedores de SOAT a los que se enrutan los trámites."
      />

      <FlitPillGroup>
        <FlitPillButton active={tab === 'clientes'} onClick={() => setTab('clientes')}>Clientes</FlitPillButton>
        <FlitPillButton active={tab === 'proveedores'} onClick={() => setTab('proveedores')}>Proveedores</FlitPillButton>
      </FlitPillGroup>

      {tab === 'clientes'
        ? <TabClientes editaAutogestion={editaAutogestion} editaTarifas={editaTarifas} />
        : <TabProveedores editable={editaAutogestion} />}
    </div>
  );
}

// ───────────────────────────── Clientes ─────────────────────────────────────

function TabClientes({ editaAutogestion, editaTarifas }: { editaAutogestion: boolean; editaTarifas: boolean }) {
  // `null` = cargando. Antes era `[]` desde el primer render y el `catch` ponía `[]` también, así
  // que un fallo del servidor se leía «No hay clientes.» y no había estado de carga: tres de los
  // cuatro estados colapsados en uno. Se paga aquí porque es sobre ESTA tabla donde se verifica que
  // el flag persiste, y si la recarga falla el admin no puede distinguir «se perdió lo que marqué»
  // de «no cargó».
  const [clients, setClients] = useState<Client[] | null>(null);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [tarifasDe, setTarifasDe] = useState<Client | null>(null);
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
  const proveedores = useProveedoresSoat(editaAutogestion);

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

  // Toggle de autogestión: PATCH del flag suelto. Optimista con reversión si falla.
  const toggleFlag = async (c: Client, campo: FlagCampo) => {
    const valor = !c[campo];
    setClients((prev) => (prev ?? []).map((x) => (x.id === c.id ? { ...x, [campo]: valor } : x)));
    try {
      // El PATCH manda UNA sola clave y el servidor copia al `set` solo las claves definidas: por
      // eso la independencia del AC3 es por construcción y no por una regla que haya que recordar.
      await api.patch(`/flito/parametrizacion/companias/${c.id}`, { [campo]: valor });
    } catch (err) {
      setClients((prev) => (prev ?? []).map((x) => (x.id === c.id ? { ...x, [campo]: !valor } : x)));
      toast.error(errorMessage(err));
    }
  };

  const CeldaFlag = ({ c, campo, label, aria }: { c: Client; campo: FlagCampo; label: string; aria?: string }) => (
    <td className="px-3 py-2 text-center">
      <input
        type="checkbox"
        className="h-4 w-4 cursor-pointer align-middle disabled:cursor-not-allowed"
        checked={c[campo]}
        disabled={!editaAutogestion}
        aria-label={aria ?? `Autogestión ${label} de ${c.name}`}
        onChange={() => toggleFlag(c, campo)}
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
                <FlitTh center>Parcial</FlitTh>
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
                  <CeldaFlag c={c} campo="logisticaPermiteParcial" label="Parcial" aria={`Entregas parciales de ${c.name}`} />
                  <CeldaCanalSoat c={c} editable={editaAutogestion} onAbrir={() => setCanalDe(c)} />
                  <td className="px-3 py-2"><ChipFacturable veredicto={veredictos.get(c.id)} /></td>
                  <td className="px-3 py-2">
                    <div className="flex gap-2">
                      <button className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                        onClick={() => setTarifasDe(c)}>Tarifas</button>
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
            Marca «Autogestiona» cuando la compañía tramita SOAT, impuestos o logística por su cuenta (FLITO no la gestiona).
            «Parcial» permite generar el acta de logística con los documentos disponibles; sin marcar, el acta se retiene hasta tenerlos todos (CA-08/09).
          </p>
        )}
        {editaAutogestion && (
          <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            «SOAT» marca que la compañía compra su SOAT por su cuenta y FLITO no lo gestiona. «SOAT sin trámite» dice otra cosa:
            que sus usuarios Cliente pueden pedirle un SOAT a FLITO sin que haya un trámite abierto. Son independientes — marcar una no cambia la otra.
            Para abrir «SOAT sin trámite» hay que decir a qué gestor salen las solicitudes de esa compañía.
          </p>
        )}
      </FlitCard>

      {tarifasDe && (
        <ModalTarifas cliente={tarifasDe} editable={editaTarifas} onClose={() => setTarifasDe(null)} />
      )}

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

// ─────────────────── «SOAT sin trámite» y su gestor por defecto (HU #12079) ─────────────────────
//
// Diseño: `docs/ux/soat-envio-directo-al-gestor-y-gestor-por-defecto.md` §1.
//
// **Por qué un modal y no una 13.ª columna**, que es lo que el AC0 describe al pie de la letra:
//
//   1. `FlitSelect` monta una región `role="status"` POR INSTANCIA. Este listado se pide sin
//      paginar y la ficha fiscal ya lo trae con `limit=500`: serían cientos de regiones vivas
//      anunciando el mismo «Cargando gestores…» y una parada de tabulador más por fila.
//   2. Sin botón de guardar, cada control haría su propio `PATCH` optimista y **el orden de los dos
//      se volvería una adivinanza**: encender primero es un 400 seguro; elegir gestor primero
//      funciona. Es exactamente la trampa que el pedido manda evitar.
//   3. La tabla ya tiene 12 columnas y es la más densa del producto.
//
// La fila ya abre dos modales propios («Tarifas», «Datos fiscales»), así que el patrón no es nuevo.
// Dentro, el interruptor y el gestor son **un borrador que se valida y se guarda de una vez**: el
// orden deja de importar y ninguna combinación imposible llega a existir.
//
// **Divergencia declarada con la letra del AC0.** El AC pide que el motivo que se lea sea «el que
// devuelve el servidor». Con el modal se cumple el EFECTO —el canal no se abre, el interruptor
// queda como estaba y el motivo se lee—, pero el primero que se ve es el del cliente. El del
// servidor sigue apareciendo literal cuando la petición sí sale y la rechazan (una carrera: alguien
// desactivó el gestor entre medias). El motivo es medible: `errorMessage()` antepone el nombre del
// campo cuando el 400 trae `fieldErrors`, así que lo que el admin leería sería
// «proveedorSoatSinTramiteId: …» — un mensaje con un nombre de columna delante es peor que el
// genérico.

const CANAL_ETIQUETA = 'Canal abierto';
const CANAL_AYUDA = 'Sus usuarios Cliente pueden pedirle un SOAT a FLITO sin que haya un trámite abierto.';
const GESTOR_LABEL = 'Gestor por defecto';
const GESTOR_VACIA = 'Seleccione gestor…';
const GESTOR_AYUDA = 'A este gestor salen las solicitudes NUEVAS del canal. Las ya radicadas conservan el gestor que tienen.';
const GESTOR_CARGANDO = 'Cargando gestores…';
const GESTOR_ERROR = 'No se pudieron cargar los gestores.';
const GESTOR_VACIO = 'No hay gestores de SOAT activos. Cree uno en la pestaña Proveedores antes de abrir el canal de esta compañía.';
const GESTOR_REINTENTO = 'Volver a cargar gestores';
const GESTOR_REQUERIDO = 'Elija el gestor por defecto antes de abrir el canal.';
const TOAST_CON_GESTOR = 'Gestor por defecto actualizado. Las solicitudes ya radicadas conservan el suyo.';
const TOAST_SIN_GESTOR = 'Compañía actualizada.';

/**
 * Lo que la celda dice, en una sola frase y sin depender del color.
 *
 * «(inactivo)» va en el TEXTO porque es el aviso de que esa compañía está radicando en la
 * contingencia de Operaciones sin que nadie se haya enterado; el color (`--flit-warning-ink`, no
 * `--flit-warning`: ver abajo) es refuerzo.
 *
 * «Abierto · sin gestor» no lo nombra el diseño y hace falta igual: el gate del servidor es de la
 * HU #12078 y las filas anteriores a ella pueden tener el canal encendido sin gestor. Pintar solo
 * «Abierto» ahí sería callar el mismo problema que «(inactivo)» existe para contar.
 */
function textoCanal(c: Client): { texto: string; aviso: boolean } {
  if (!c.soatSinTramite) return { texto: 'Cerrado', aviso: false };
  const g = c.gestorSoatSinTramite;
  if (!g) return { texto: 'Abierto · sin gestor', aviso: true };
  return g.activo
    ? { texto: `Abierto · ${g.nombre}`, aviso: false }
    : { texto: `Abierto · ${g.nombre} (inactivo)`, aviso: true };
}

/**
 * La celda: **un solo control**, la misma cuenta de paradas de tabulador que la casilla que
 * sustituye, y la tabla sigue teniendo 12 encabezados.
 *
 * Sin permiso de edición no se pinta un botón muerto sino el mismo texto en un `<span>`: hoy
 * `financiera` y `auditor` ven una casilla gris que no dice cuál es el gestor; con esto leen el
 * estado completo y no ganan una parada de tabulador inútil.
 *
 * ⚠ El nombre accesible **contiene el texto visible** (WCAG 2.5.3, «Label in Name»). Un
 * `aria-label="Configurar SOAT sin trámite de X"` sobre un botón que dice «Abierto · SURA» deja a
 * quien maneja el producto por voz diciendo «Abierto» sin que pase nada. Y lleva el NOMBRE de la
 * compañía, nunca su NIT: los selectores de axe arrastran valores de atributo y acabarían en el
 * informe.
 */
function CeldaCanalSoat({ c, editable, onAbrir }: { c: Client; editable: boolean; onAbrir: () => void }) {
  const { texto, aviso } = textoCanal(c);
  // `--flit-warning-ink` y no `--flit-warning`, que es lo que dice el diseño: el naranja de
  // superficie se queda en 3,4:1 sobre tarjeta blanca y esto es TEXTO. Es la lección del Bug #11604,
  // la misma por la que `FlitSelect` pinta sus errores con `--flit-danger-ink`.
  const color = aviso ? 'var(--flit-warning-ink)' : 'var(--flit-text-secondary)';
  return (
    <td className="px-3 py-2 text-center">
      {editable ? (
        <button
          type="button"
          className={flitBtnSecondary}
          style={{ ...flitBtnSecondaryStyle, color }}
          aria-label={`SOAT sin trámite de ${c.name}: ${texto}`}
          onClick={onAbrir}
        >
          {texto}
        </button>
      ) : (
        <span className="text-sm" style={{ color }}>{texto}</span>
      )}
    </td>
  );
}

/**
 * El par completo, en un borrador local que se valida al **Guardar**.
 *
 * **El interruptor NUNCA se deshabilita y el gestor NUNCA se pide en un segundo paso.** Dentro del
 * modal, «canal encendido + gestor vacío» no es un estado inválido: es un borrador a medias. Lo que
 * se valida es la pulsación de «Guardar», y cuando falta el gestor **no sale ninguna petición** y el
 * interruptor del borrador se queda encendido —para que solo haya que elegir el gestor y volver a
 * guardar, no rehacer dos clics—.
 *
 * Los descartes: un interruptor deshabilitado no recibe foco (quien navega con teclado llega y el
 * control no existe, sin explicación), y pedir el gestor en un segundo diálogo sobre este modal es
 * la pila de tres niveles que ya rompió el visor de soportes del detalle de SOAT.
 *
 * Sin `confirm` al cambiar de gestor: la consecuencia no es destructiva —las radicadas no se
 * mueven—, la pantalla lo dice ANTES en la ayuda del campo y lo repite DESPUÉS en el toast.
 */
function ModalCanalSoat({ cliente, proveedores, onClose, onGuardado }: {
  cliente: Client; proveedores: CatalogoProveedores; onClose: () => void; onGuardado: () => void;
}) {
  const idAyudaCanal = useId();
  const [abierto, setAbierto] = useState(cliente.soatSinTramite);
  const [gestorId, setGestorId] = useState(cliente.gestorSoatSinTramite?.id ?? '');
  const [errorGestor, setErrorGestor] = useState<string | null>(null);
  const [errorServidor, setErrorServidor] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const { data, error: errorCarga, recargar } = proveedores;
  const cargando = data === null && !errorCarga;

  /**
   * Los ACTIVOS más el asignado actual si ya no lo está.
   *
   * Filtrar por `activo` a secas dejaría el `<select>` en blanco y **guardar cualquier otra cosa le
   * quitaría el gestor a la compañía por la espalda** — el mismo fallo que la HU #12053 documentó
   * para el proveedor de un usuario. El asignado se conoce por `gestorSoatSinTramite`, que el
   * listado ya resuelve, así que se reinyecta aunque el catálogo no lo traiga.
   */
  const ofrecidos = useMemo(() => {
    const activos = (data ?? []).filter((p) => p.activo);
    const asignado = cliente.gestorSoatSinTramite;
    return asignado && !activos.some((p) => p.id === asignado.id)
      ? [...activos, { id: asignado.id, nombre: asignado.nombre, activo: asignado.activo }]
      : activos;
  }, [data, cliente.gestorSoatSinTramite]);

  const vacio = data !== null && ofrecidos.length === 0;
  const mensaje = errorCarga ? GESTOR_ERROR : cargando ? GESTOR_CARGANDO : vacio ? GESTOR_VACIO : null;
  const selectorInutil = cargando || vacio || !!errorCarga;

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    // La guarda propia, ADEMÁS del `required` nativo: un control `disabled` queda fuera de la
    // validación del navegador, así que con el catálogo caído o vacío el `required` no dispararía y
    // el formulario se enviaría con el canal abierto y el gestor en blanco.
    if (abierto && !gestorId) { setErrorGestor(GESTOR_REQUERIDO); return; }
    setErrorGestor(null); setErrorServidor(null); setGuardando(true);
    try {
      // **Las dos claves en la MISMA petición**: es lo que hace que el orden de los controles deje
      // de importar. El servidor valida el par sobre el estado RESULTANTE (HU #12078), no sobre el
      // previo, así que «abre el canal y manda a SURA» pasa aunque la compañía no tuviera gestor.
      await api.patch(`/flito/parametrizacion/companias/${cliente.id}`, {
        soatSinTramite: abierto,
        proveedorSoatSinTramiteId: gestorId || null,
      });
      toast.success(gestorId === (cliente.gestorSoatSinTramite?.id ?? '') ? TOAST_SIN_GESTOR : TOAST_CON_GESTOR);
      onGuardado();
    } catch (err) {
      // Literal y sobre la botonera. El modal **no se cierra** y el borrador **no se pierde**: si el
      // rechazo es una carrera —alguien desactivó ese gestor hace un segundo—, lo que hay que hacer
      // es cambiar el gestor, no volver a llenar el modal.
      setErrorServidor(errorMessage(err));
    } finally {
      setGuardando(false);
    }
  };

  return (
    <FlitModal title={`SOAT sin trámite · ${cliente.name}`} onClose={onClose}>
      <form onSubmit={guardar} className="space-y-4">
        <div>
          <label className="flex items-start gap-2 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
            <input
              type="checkbox" className="mt-0.5 h-4 w-4 cursor-pointer"
              checked={abierto}
              aria-describedby={idAyudaCanal}
              onChange={(e) => {
                setAbierto(e.target.checked);
                // El rechazo del cliente se retira en cuanto el borrador deja de tenerlo: apagar el
                // canal es una de las dos formas de resolverlo.
                if (!e.target.checked) setErrorGestor(null);
              }}
            />
            <span className="font-semibold">{CANAL_ETIQUETA}</span>
          </label>
          <p id={idAyudaCanal} className="mt-1 pl-6 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            {CANAL_AYUDA}
          </p>
        </div>

        <FlitSelect
          label={GESTOR_LABEL}
          value={gestorId}
          onChange={(v) => { setGestorId(v); setErrorGestor(null); }}
          opciones={[
            { valor: '', etiqueta: GESTOR_VACIA },
            ...ofrecidos.map((p) => ({ valor: p.id, etiqueta: p.nombre, ...(p.activo ? {} : { nota: 'inactivo' }) })),
          ]}
          ayuda={GESTOR_AYUDA}
          mensaje={mensaje}
          fallo={!!errorCarga}
          disabled={selectorInutil}
          // Solo el fallo de carga se reintenta. En vacío NO: volver a pedir la lista no crea
          // gestores, y el mensaje ya nombra la pantalla donde se crean.
          onReintentar={errorCarga ? recargar : undefined}
          textoReintento={GESTOR_REINTENTO}
          // Validación NATIVA, con el globo del navegador suprimido y el texto en español puesto por
          // nosotros. `FlitSelect` lleva el foco al control en cuanto recibe `error`.
          required={abierto}
          error={errorGestor}
          onInvalido={() => setErrorGestor(GESTOR_REQUERIDO)}
        />

        {errorServidor && (
          <p role="alert" className="text-sm font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>
            {errorServidor}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>
            Cancelar
          </button>
          <GradientButton type="submit" disabled={guardando}>
            {guardando ? 'Guardando…' : 'Guardar'}
          </GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}

// ───────────────────────────── Tarifas del cliente ──────────────────────────

function ModalTarifas({ cliente, editable, onClose }: { cliente: Client; editable: boolean; onClose: () => void }) {
  const [tarifas, setTarifas] = useState<Tarifa[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);
  const [crear, setCrear] = useState(false);
  const [editar, setEditar] = useState<Tarifa | null>(null);

  useEffect(() => {
    setTarifas(null); setError(null);
    api.get<Tarifa[]>(`/flito/parametrizacion/tarifas?companiaId=${cliente.id}`)
      .then(setTarifas).catch((e) => setError(errorMessage(e)));
  }, [cliente.id, recarga]);

  const refrescar = () => setRecarga((n) => n + 1);

  return (
    <FlitModal title={`Tarifas de ${cliente.name}`} onClose={onClose}>
      <div className="space-y-3">
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!tarifas && !error && <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando…</p>}

        {tarifas && tarifas.length === 0 && (
          // Sin tarifas el trámite no se puede liquidar: decirlo aquí evita descubrirlo en el reporte.
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            Esta compañía no tiene tarifas configuradas. Sus trámites mostrarán «No configurado» en el
            reporte de costos y no podrán liquidarse.
          </p>
        )}

        {tarifas && tarifas.length > 0 && (
          <FlitTable>
            <thead>
              <FlitTr>
                <FlitTh>Concepto</FlitTh><FlitTh>Tipo de trámite</FlitTh>
                <FlitTh>Valor</FlitTh><FlitTh>Estado</FlitTh><FlitTh />
              </FlitTr>
            </thead>
            <tbody>
              {tarifas.map((t) => (
                <FlitTr key={t.id}>
                  <td className="px-3 py-2 text-sm">{CONCEPTO_TARIFA_LABEL[t.concepto]}</td>
                  <td className="px-3 py-2 text-sm">{t.tipoTramite ?? 'Genérica (cualquier tipo)'}</td>
                  <td className="px-3 py-2 text-sm tabular-nums">{pesos(t.valor)}</td>
                  <td className="px-3 py-2"><StatusChip tone={t.activo ? 'success' : 'neutral'}>{t.activo ? 'Activa' : 'Inactiva'}</StatusChip></td>
                  <td className="px-3 py-2">
                    {editable && <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setEditar(t)}>Editar</button>}
                  </td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
        )}

        {editable && (
          <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={() => setCrear(true)}>Nueva tarifa</button>
        )}
      </div>

      {crear && (
        <FormTarifa cliente={cliente} onClose={() => setCrear(false)}
          onGuardado={() => { setCrear(false); refrescar(); }} />
      )}
      {editar && (
        <FormTarifa cliente={cliente} tarifa={editar} onClose={() => setEditar(null)}
          onGuardado={() => { setEditar(null); refrescar(); }} />
      )}
    </FlitModal>
  );
}

function FormTarifa({ cliente, tarifa, onClose, onGuardado }: {
  cliente: Client; tarifa?: Tarifa; onClose: () => void; onGuardado: () => void;
}) {
  const [concepto, setConcepto] = useState<ConceptoTarifa>(tarifa?.concepto ?? 'tramite_digital');
  const [tipoTramite, setTipoTramite] = useState(tarifa?.tipoTramite ?? '');
  const [valor, setValor] = useState(tarifa ? String(tarifa.valor) : '');
  const [activo, setActivo] = useState(tarifa?.activo ?? true);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const valorNum = Number(valor);
  const valorInvalido = valor.trim() === '' || !Number.isFinite(valorNum) || valorNum < 0;

  const guardar = async () => {
    setGuardando(true); setError(null);
    try {
      if (tarifa) await api.patch(`/flito/parametrizacion/tarifas/${tarifa.id}`, { valor: valorNum, activo });
      else await api.post('/flito/parametrizacion/tarifas', {
        companiaId: cliente.id, concepto,
        tipoTramite: tipoTramite.trim() || null, valor: valorNum,
      });
      onGuardado();
    } catch (e) { setError(errorMessage(e)); }
    finally { setGuardando(false); }
  };

  return (
    <FlitModal title={tarifa ? 'Editar tarifa' : `Nueva tarifa · ${cliente.name}`} onClose={onClose}>
      <div className="space-y-3">
        {/* La llave (compañía + concepto + tipo) no se mueve al editar: cambiarla sería otra tarifa. */}
        {tarifa ? (
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            {CONCEPTO_TARIFA_LABEL[tarifa.concepto]} · {tarifa.tipoTramite ?? 'Genérica'}
          </p>
        ) : (
          <>
            <FlitField label="Concepto *">
              <select className={flitInp} value={concepto} onChange={(e) => setConcepto(e.target.value as ConceptoTarifa)}>
                {CONCEPTOS_TARIFA.map((c) => <option key={c} value={c}>{CONCEPTO_TARIFA_LABEL[c]}</option>)}
              </select>
            </FlitField>
            <FlitField label="Tipo de trámite (vacío = aplica a todos)">
              <input className={flitInp} value={tipoTramite} placeholder="Matricula, Traspaso…"
                onChange={(e) => setTipoTramite(e.target.value)} />
            </FlitField>
          </>
        )}
        <FlitField label="Valor (COP) *">
          <input className={flitInp} type="number" min="0" step="1" value={valor} onChange={(e) => setValor(e.target.value)} />
        </FlitField>
        {valor.trim() !== '' && valorInvalido && (
          <p className="text-sm text-red-600">El valor debe ser un número mayor o igual a cero.</p>
        )}
        {tarifa && (
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Activa</span>
            <input type="checkbox" checked={activo} onChange={(e) => setActivo(e.target.checked)} />
          </label>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2">
          <button className={flitBtnPrimary} style={flitBtnPrimaryStyle}
            disabled={guardando || valorInvalido} onClick={guardar}>
            {guardando ? 'Guardando…' : tarifa ? 'Guardar' : 'Crear'}
          </button>
          <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>Cancelar</button>
        </div>
      </div>
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
        {data.length === 0 ? <FlitEmpty>No hay proveedores SOAT.</FlitEmpty> : (
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
    <FlitModal title={proveedor ? 'Editar proveedor' : 'Nuevo proveedor SOAT'} onClose={onClose}>
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
