// FLITO — Portal SOAT (Fase 6). Porta packages/client/src/paginas/soat/* al kit flit/ + api.
// Cola con las 3 fronteras (resueltas en el backend), envío atómico al gestor, carga de factura
// (única vía a Pagado, RN-03), rechazo/reactivación/reversa/cambio de proveedor y carga masiva.
// La visibilidad la impone el servidor: Operaciones ve todo; el gestor solo su proveedor y nunca
// los Pendiente; Auditoría es solo lectura.

import { puedeOperar } from '../lib/permissions';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  ANS_OPERATIVO, ESTADO_SOAT_LABEL, EstadoSoat,
  FILTROS_VIGENCIA_COLA, esFiltroVigenciaCola, type FiltroVigenciaCola,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../lib/api';
import { enviarCargaEnTandas, validarCargaMasiva } from '../lib/carga-masiva';
import useSeleccionCargaMasiva from '../lib/useSeleccionCargaMasiva';
import RanuraCargaMasiva from '../components/flito/RanuraCargaMasiva';
import { puedeSolicitarSoat, useAuth } from '../lib/auth';
import { TarjetaCanalDeshabilitado } from '../components/flito/soat-cliente/TarjetaCanal';
import PageContentSkeleton from '../components/flit/PageContentSkeleton';
import BarraEnvioSoat from '../components/flito/BarraEnvioSoat';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import FlitModal from '../components/flit/FlitModal';
import HistorialEstados from '../components/flit/HistorialEstados';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import AntiguedadPill from '../components/flit/AntiguedadPill';
import ThFiltroMulti from '../components/flit/ThFiltroMulti';
import ChipSinGestion from '../components/flit/ChipSinGestion';
import RangoFechas from '../components/flit/RangoFechas';
import FiltrosInteligentes, { type Preset } from '../components/flit/FiltrosInteligentes';
import {
  AvisoExportCola, BotonExportarCola, COLA_SOAT, useExportCola, type FiltrosExportCola,
} from '../components/flito/ExportarCola';
import {
  AvisoSoportesZip, DescargarSoportesZip, ZIP_SOAT, useDescargaZip,
} from '../components/flito/DescargarSoportesZip';
// Ni `CeldaTramite` ni `ENCABEZADOS_COMUNES`: desde la HU #11905 esta cola dejó de girar sobre el
// trámite (RN-01: un SOAT es por VIN, no por trámite). Las otras tres tablas que comparten ese
// archivo —impuestos, derechos y el reporte de costos— lo siguen enseñando igual, y por eso el
// cambio se queda aquí y no allí. El vehículo lo pinta `CeldaVehiculoSoat`, local a esta página.
import { CeldaFechas, documentoConTipo } from '../components/flit/columnasComunes';
import Paginacion from '../components/flit/Paginacion';
import VisorSoportes from '../components/flit/VisorSoportes';
import useDebounce from '../lib/useDebounce';
import { pintarVigenciaSoat, textoVigenciaSoat, type VigenciaSoatCola } from '../lib/vigenciaSoatCola';
import {
  FlitCard, FlitTable, FlitTh, FlitTr, FlitField, FlitEmpty, FlitPillGroup, FlitPillButton,
  flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';

interface SoatItem {
  id: string; vin: string; placa: string | null; marca: string | null; linea: string | null;
  /** Datos técnicos que FLIT trae del vehículo (HU #11906). `string` a propósito y NO number: la
      fuente es texto siempre, `"0"` significa eléctrico (`vehicles/ocr.routes.ts:76`) y un futuro
      «220 CC» se rompería en silencio al parsearlo. Llegan `null` cuando FLIT no los mandó; el «—»
      lo pinta esta página, no el backend. */
  cilindraje: string | null; carroceria: string | null; tipoServicio: string | null;
  estado: EstadoSoat; esMultiplePropietario: boolean; companiaNombre: string;
  organismoNombre: string | null;
  /** Los cinco campos OPCIONALES son los que el backend NO le manda al rol `cliente` (Feature
      #11912): con qué proveedor tiene FLITO contratada la adquisición, si el caso lo retomó
      Operaciones, qué empleado lo despachó y cuánto pagó FLITO por la póliza. `?` y no `| null`
      porque la diferencia es real y conviene que se note: no llegan vacíos, no llegan. Lo que los
      pinta va detrás de `!esCliente`; el `?` es la red por si alguna vez se olvida una guarda. */
  proveedorSoatId?: string | null; proveedorSoatNombre?: string | null;
  gestionOperaciones?: boolean;
  /**
   * `tipoDocumento` es el CÓDIGO ya resuelto por el API (`'CC' | 'NIT' | 'PP' | 'CE'`) o null, no el
   * `tipo` crudo de FLIT: la traducción vive en el backend y aquí no hay copia (HU #11947, AC6/AC7).
   */
  compradores: Array<{ nombreCompleto: string; numeroDocumento: string; tipoDocumento: string | null; orden: number; porcentajeParticipacion: number | null }>;
  tramitesFlit: string[];
  /** Datos del trámite. Null cuando el SOAT sirve a varios que no coinciden (es por VIN, RN-01). */
  tipoTramite: string | null; fechaAprobacion: string | null; fechaCreacion: string | null;
  enviadoPorNombre?: string | null; enviadoEn: string | null; pagadoEn: string | null;
  valorPagado?: number | null; estancado: boolean; motivoRechazo: string | null; creadoEn: string;
  /**
   * Vigencia frente al RUNT, tal como la dejó la corrida de las 00:10 (Feature #12075).
   *
   * Los DOS huecos significan cosas distintas y ninguno se puede colapsar en el otro:
   *   · `undefined` — el API no lo manda. Al `cliente` nunca (es el sexto de `CAMPOS_SOLO_INTERNOS`)
   *     y a nadie si el bundle va por delante del API, que en DEV no es teórico: el merge es el
   *     deploy. La fila se pinta EXACTAMENTE como antes de esta HU.
   *   · `null` — la fila no tiene comprobante cargado y por tanto no entra en la verificación
   *     diaria. Tampoco se pinta nada: la ausencia es correcta y muda, y un «—» en la mayoría de
   *     las filas sería un hueco que hay que explicar.
   *
   * `verificadaEn` puede ser `null` CON el bloque presente, y no significa «hoy falló» sino «de
   * este SOAT no consta ninguna respuesta del registro». Leerlo sin guarda pinta «Invalid Date».
   */
  vigencia?: VigenciaSoatCola | null;
}
interface Proveedor { id: string; nombre: string; activo: boolean }
interface ColaSoat { items: SoatItem[]; total: number; page: number; pageSize: number }
interface FacetasSoat {
  companias: { id: number; nombre: string }[];
  organismos: { codigo: string; nombre: string | null }[];
  proveedores: { id: string; nombre: string }[];
}

// Cuatro estados y cuatro tonos. Aquí hubo dos entradas más —`pendiente_revision` y `rechazada`, del
// canal Cliente— que la HU #12079 dejó sin escritor y que la #12080 retira del enum y del tipo de
// Postgres (migración 0176, que aborta si queda alguna fila en ellos). No hace falta conservarles un
// tono «por si llega una fila antigua»: no puede llegar ninguna.
const TONO: Record<EstadoSoat, ChipTone> = {
  pendiente: 'draft', solicitado: 'active', con_novedad: 'danger', pagado: 'success',
};
/**
 * Los rótulos de las tres opciones del filtro «Vigencia» (HU #12097, AC2).
 *
 * `Record<FiltroVigenciaCola, string>` y no una lista de literales: el día que el vocabulario
 * compartido gane un cuarto valor, esto no compila — que es justo lo que se quiere, porque una
 * opción sin rótulo se pintaría como un nombre de columna.
 *
 * **Dos de los tres dicen exactamente lo mismo que su chip** para no obligar a traducir en cada
 * barrido. El tercero, «Sin verificar», nombra al CONJUNTO y no a uno de sus miembros: esa lista
 * trae a la vez las filas que dicen «No se pudo consultar» y las que dicen «Sin verificar», así que
 * llamarla «No se pudo consultar» sería falso para la mitad de lo que devuelve. Es además la
 * palabra que usa el AC2.
 */
const VIGENCIA_FILTRO_LABEL: Record<FiltroVigenciaCola, string> = {
  vencido: 'Vencido',
  sin_registro: 'Sin SOAT en el RUNT',
  no_verificado: 'Sin verificar',
};
const pesos = (v: number | null | undefined) => v === null || v === undefined ? '—'
  : new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(v);
/** Un dato de texto de FLIT, tal cual llega. Ausente —`null` o vacío— se pinta «—» (HU #11906, AC2):
    un hueco en blanco se confunde con un fallo de carga, y esto no lo es. No transforma el valor. */
const dato = (v: string | null) => (v && v.trim() ? v : '—');
const fecha = (iso: string | null) => iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : '—';

/**
 * Los estados a los que el admin puede REVERSAR un SOAT, y NADA MÁS.
 *
 * **Sigue siendo una lista aparte aunque su contenido coincida con el de las pastillas del admin, y
 * eso es una decisión, no un descuido.** La razón por la que nació separada —no ofrecer
 * `pendiente_revision` ni `rechazada` como destino de reversa (ADR-0008 §8)— se evaporó del todo con
 * la HU #12080, que retira los dos estados del enum. Pero las dos listas responden a preguntas
 * distintas: «por qué se puede filtrar» y «a dónde se puede devolver un SOAT». Fundirlas porque hoy
 * son iguales le regalaría a la siguiente pastilla que alguien añada un destino de reversa que nadie
 * decidió — que es exactamente lo que acaba de pasar y de deshacerse.
 */
const ESTADOS_DESTINO_REVERSA: EstadoSoat[] = [EstadoSoat.PENDIENTE, EstadoSoat.SOLICITADO, EstadoSoat.PAGADO, EstadoSoat.CON_NOVEDAD];
const ESTADOS_GESTOR: EstadoSoat[] = [EstadoSoat.SOLICITADO, EstadoSoat.PAGADO];
/**
 * Las pastillas del admin, en orden de RECORRIDO del ciclo (HU #12079).
 *
 * `pendiente_revision` y `rechazada` salieron de aquí porque el circuito que los creaba se retiró:
 * una solicitud del canal nace en `solicitado` y sale al gestor de su compañía sin pasar por
 * revisión. Una pastilla que filtra por un estado en el que ya no entra ninguna fila es una pantalla
 * vacía prometida — y desde la HU #12080 sería además un 500: el filtro viaja al API, que ya no
 * acepta esos valores (`ESTADOS` de `flito-soat.routes.ts`).
 */
const ESTADOS_ADMIN: EstadoSoat[] = [
  EstadoSoat.PENDIENTE, EstadoSoat.SOLICITADO, EstadoSoat.PAGADO, EstadoSoat.CON_NOVEDAD,
];
/**
 * Las pastillas del Cliente: **las mismas cuatro, en el orden de SU recorrido** (HU #12079).
 *
 * Son las mismas y no un subconjunto: el aislamiento del Cliente es **por compañía, no por origen**
 * (`condicionesCola`), así que en su cola conviven los SOAT nacidos de trámites de FLIT con los que
 * él radica. `con_novedad` va antes que `pagado` porque es lo único de esta lista que puede estar
 * esperando algo, aunque no sea él quien lo resuelva.
 *
 * ⚠ **Lo que murió con la HU #12079 y sigue muerto:** aquí se leía que «no hace falta una columna
 * Origen porque `pendiente_revision` y `rechazada` solo existen en el canal Cliente, así que el
 * estado ya dice de dónde viene cada fila». Retirados los dos estados —de la pantalla entonces, del
 * enum con la #12080—, **nada distingue en pantalla una solicitud del canal de un SOAT nacido de un
 * trámite**. No se añade columna —la cola ya es densa, el gestor las trabaja igual y ningún AC la
 * pide—; queda preguntado al PO, con `tramitesFlit` vacío como señal ya disponible si algún día se
 * decide.
 */
const ESTADOS_CLIENTE: EstadoSoat[] = [
  EstadoSoat.PENDIENTE, EstadoSoat.SOLICITADO, EstadoSoat.CON_NOVEDAD, EstadoSoat.PAGADO,
];

export default function FlitoSoat() {
  const { user } = useAuth();
  const esOperaciones = puedeOperar(user?.role);
  const esGestor = user?.role === 'proveedor';
  const soloLectura = user?.role === 'auditor';
  // Usuario de una compañía cliente (Feature #11912). No ve nada de la trastienda: ni con qué
  // proveedor trabaja FLITO, ni quién lo despachó, ni lo que FLITO pagó por la póliza. El backend
  // ya no se lo manda —esa es la garantía—; esto es lo que evita que la pantalla pinte columnas
  // vacías de datos que para él no existen.
  const esCliente = user?.role === 'cliente';
  // La capacidad de radicar (HU #11914). Sale de `/auth/me`, así que resuelve ANTES que la cola y el
  // botón no parpadea de «puedo» a «no puedo». No es la frontera: los dos endpoints del canal la
  // vuelven a comprobar y responden 403.
  const puedeSolicitar = puedeSolicitarSoat(user);
  const { state: estadoNavegacion } = useLocation();

  const estadosDisponibles = esGestor ? ESTADOS_GESTOR : esCliente ? ESTADOS_CLIENTE : ESTADOS_ADMIN;
  const [estado, setEstado] = useState<EstadoSoat | 'todos'>(esGestor ? EstadoSoat.SOLICITADO : 'todos');
  const [texto, setTexto] = useState('');
  // Antes se consultaba en cada tecla; con la cola paginada eso es una consulta con COUNT por
  // pulsación. Se espera a que el usuario deje de escribir.
  const buscar = useDebounce(texto, 300);
  const [data, setData] = useState<ColaSoat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [detalleId, setDetalleId] = useState<string | null>(null);
  const [cargaMasiva, setCargaMasiva] = useState(false);
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [recarga, setRecarga] = useState(0);

  const [facetas, setFacetas] = useState<FacetasSoat | null>(null);
  const [companiasSel, setCompaniasSel] = useState<string[]>([]);
  const [organismosSel, setOrganismosSel] = useState<string[]>([]);
  const [proveedoresSel, setProveedoresSel] = useState<string[]>([]);
  const [solicitadoDesde, setSolicitadoDesde] = useState('');
  const [solicitadoHasta, setSolicitadoHasta] = useState('');
  const [pagadoDesde, setPagadoDesde] = useState('');
  const [pagadoHasta, setPagadoHasta] = useState('');
  // «Creado en FLITO» — la fecha de REGISTRO en FLITO (`created_at`), que NO es la que pinta la
  // columna «Creado» de la tabla: aquella es la del trámite en FLIT (`fechaCreacion`). Son dos
  // fechas distintas y por eso el filtro lleva otro rótulo; la columna es de `columnasComunes.tsx`,
  // la comparten cuatro pantallas y esta HU no la toca.
  const [creadoDesde, setCreadoDesde] = useState('');
  const [creadoHasta, setCreadoHasta] = useState('');
  const [soloEstancado, setSoloEstancado] = useState(false);
  // Al gestor no se le ofrece: su frontera ya excluye lo de Operaciones, así que «operaciones» le
  // daría siempre vacío y «proveedor» sería redundante.
  const [gestionSel, setGestionSel] = useState<'' | 'operaciones' | 'proveedor'>('');
  // Vigencia frente al RUNT (HU #12097). Excluyentes por construcción —un `select`, no tres
  // casillas—, que es lo que hace verdadero el «cada uno devuelve exactamente su conjunto» del AC2:
  // «vencido Y sin registro» no lo define ningún AC. `vigente` no se ofrece: nadie barre la cola
  // buscando lo que está bien.
  const [vigenciaSel, setVigenciaSel] = useState<'' | FiltroVigenciaCola>('');
  const [preset, setPreset] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  // Respaldo de foco del detalle (HU #11915). Validar o rechazar cierra el modal y refresca la cola,
  // y la fila SALE de la vista cuando el admin está filtrando justo por «Pendiente de revisión»: el
  // botón «Ver» que abrió el modal deja de existir y `useFocusTrap` no tiene a dónde devolver el
  // foco. Apunta al grupo de pastillas, que es donde ese trabajo continúa.
  const refPills = useRef<HTMLDivElement>(null);

  // Los multiselect se serializan a una clave para las dependencias de los efectos.
  const compKey = companiasSel.join(','); const orgKey = organismosSel.join(','); const provKey = proveedoresSel.join(',');

  // El filtro nuevo entra aquí, y no es un detalle: `hayFiltros` es lo que decide si el vacío dice
  // «Ningún SOAT coincide con los filtros» o «No hay SOAT en esta vista. Sincroniza desde el
  // Tablero…» —una afirmación falsa cuando lo que pasa es que el rango deja fuera todo— y también si
  // aparece «Limpiar filtros», que es la única salida de ese vacío.
  const hayFiltros = companiasSel.length > 0 || organismosSel.length > 0 || proveedoresSel.length > 0
    || !!solicitadoDesde || !!solicitadoHasta || !!pagadoDesde || !!pagadoHasta
    || !!creadoDesde || !!creadoHasta || soloEstancado || !!gestionSel || !!vigenciaSel;

  const limpiarFiltros = () => {
    setCompaniasSel([]); setOrganismosSel([]); setProveedoresSel([]);
    setSolicitadoDesde(''); setSolicitadoHasta(''); setPagadoDesde(''); setPagadoHasta('');
    setCreadoDesde(''); setCreadoHasta('');
    setSoloEstancado(false); setGestionSel(''); setVigenciaSel(''); setTexto(''); setPreset(null);
    setEstado(esGestor ? EstadoSoat.SOLICITADO : 'todos');
  };

  /**
   * Las dos vistas con las que se trabaja la cola. Son combinaciones, no filtros sueltos: «listos
   * para enviar» son dos condiciones y ponerlas a mano cada vez invita a olvidar una.
   *
   * Un gestor no ve «listos para enviar»: los Pendiente están fuera de su frontera (CA-09), así que
   * el preset le devolvería siempre una lista vacía y parecería que no hay trabajo.
   */
  const PRESETS: Array<Preset<{ estado: EstadoSoat | 'todos'; estancado: boolean }>> = [
    ...(esGestor ? [] : [{
      nombre: 'Listos para enviar',
      descripcion: 'Pendientes que ya tienen proveedor asignado.',
      filtros: { estado: EstadoSoat.PENDIENTE as EstadoSoat | 'todos', estancado: false },
    }]),
    {
      nombre: 'Sin gestión',
      descripcion: `Solicitados que superaron el ANS de ${ANS_OPERATIVO.SIN_GESTION_HORAS} horas.`,
      filtros: { estado: EstadoSoat.SOLICITADO, estancado: true },
    },
  ];

  const aplicarPreset = (p: Preset<{ estado: EstadoSoat | 'todos'; estancado: boolean }>) => {
    limpiarFiltros();
    setEstado(p.filtros.estado);
    setSoloEstancado(p.filtros.estancado);
    setPreset(p.nombre);
  };

  // Cualquier cambio de filtro vuelve a la página 1: si no, se queda en una página que ya no existe.
  useEffect(() => { setPage(1); }, [estado, buscar, compKey, orgKey, provKey, solicitadoDesde, solicitadoHasta, pagadoDesde, pagadoHasta, creadoDesde, creadoHasta, soloEstancado, gestionSel, vigenciaSel]);

  useEffect(() => {
    setError(null); setSeleccion(new Set());
    const q = new URLSearchParams();
    if (estado !== 'todos') q.set('estado', estado);
    if (buscar.trim()) q.set('buscar', buscar.trim());
    if (companiasSel.length) q.set('companias', companiasSel.join(','));
    if (organismosSel.length) q.set('organismos', organismosSel.join(','));
    if (proveedoresSel.length) q.set('proveedores', proveedoresSel.join(','));
    if (solicitadoDesde) q.set('solicitadoDesde', solicitadoDesde);
    if (solicitadoHasta) q.set('solicitadoHasta', solicitadoHasta);
    if (pagadoDesde) q.set('pagadoDesde', pagadoDesde);
    if (pagadoHasta) q.set('pagadoHasta', pagadoHasta);
    if (creadoDesde) q.set('creadoDesde', creadoDesde);
    if (creadoHasta) q.set('creadoHasta', creadoHasta);
    if (soloEstancado) q.set('estancado', 'si');
    if (gestionSel) q.set('gestion', gestionSel);
    // Valor MÁQUINA (`vencido|sin_registro|no_verificado`) y no el rótulo visible: es lo que valida
    // el servidor, y además es lo único que puede viajar en una URL — ni placa, ni VIN, ni
    // documento (AC2). El servidor ignora lo que no reconozca.
    if (vigenciaSel) q.set('vigencia', vigenciaSel);
    q.set('page', String(page));
    api.get<ColaSoat>(`/flito/soat?${q}`).then(setData).catch((e) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estado, buscar, compKey, orgKey, provKey, solicitadoDesde, solicitadoHasta, pagadoDesde, pagadoHasta, creadoDesde, creadoHasta, soloEstancado, gestionSel, vigenciaSel, page, recarga]);

  useEffect(() => {
    api.get<FacetasSoat>('/flito/soat/facetas').then(setFacetas).catch(() => setFacetas(null));
  }, []);

  useEffect(() => {
    if (!esOperaciones) return;
    api.get<Proveedor[]>('/flito/parametrizacion/proveedores-soat').then(setProveedores).catch(() => setProveedores([]));
  }, [esOperaciones]);

  // Llegada desde el modal del AC4 con «Ver la solicitud» (HU #11914). El uuid viaja en el ESTADO de
  // navegación y NO en la URL: el detalle de esta cola es un modal y no tiene dirección propia, y
  // meter identificadores en el query sería el primer paso para meter también la placa. Si esa fila
  // no está en la página cargada no se abre nada y el Cliente aterriza en su cola, que es un destino
  // correcto; lo que no puede pasar es que se pierda el intento en silencio con un error.
  useEffect(() => {
    const pedido = (estadoNavegacion as { verSoatId?: string } | null)?.verSoatId;
    if (pedido) setDetalleId(pedido);
  }, [estadoNavegacion]);

  /**
   * Lo que el export tiene que entregar: **los mismos filtros que la consulta de arriba, sin la
   * página**. Se arma del mismo estado, así que no hay forma de que la tabla y el archivo se
   * separen; lo único que aquí no aparece —y no puede aparecer— es `page`.
   *
   * Todo va en el CUERPO del POST, incluido `buscar`: el placeholder de esta cola ofrece buscar por
   * comprador, así que ese campo lleva nombre y documento de una persona (AGENTS.md §14). En la
   * query acabaría en el historial del navegador, en el `Referer` y en el access log del proxy.
   */
  /**
   * `companias` va como NÚMEROS y no como el texto del multiselect, y no es cosmética: el esquema
   * del endpoint es `z.array(z.number())` y además `.strict()`, así que `["1"]` es un 400 —no un
   * filtro ignorado—. El control guarda `String(c.id)` porque un `<input>` no tiene enteros; la
   * conversión se hace aquí, en el único sitio donde se sabe qué espera el otro lado. En la QUERY de
   * la cola no hace falta: allí todo es texto.
   */
  const filtrosExport: FiltrosExportCola = {
    ...(estado !== 'todos' ? { estados: [estado] } : {}),
    ...(buscar.trim() ? { buscar: buscar.trim() } : {}),
    ...(companiasSel.length ? { companias: companiasSel.map(Number) } : {}),
    ...(organismosSel.length ? { organismos: organismosSel } : {}),
    ...(proveedoresSel.length ? { proveedores: proveedoresSel } : {}),
    ...(gestionSel ? { gestion: gestionSel } : {}),
    ...(solicitadoDesde ? { solicitadoDesde } : {}),
    ...(solicitadoHasta ? { solicitadoHasta } : {}),
    ...(pagadoDesde ? { pagadoDesde } : {}),
    ...(pagadoHasta ? { pagadoHasta } : {}),
    ...(creadoDesde ? { creadoDesde } : {}),
    ...(creadoHasta ? { creadoHasta } : {}),
    ...(soloEstancado ? { estancado: true } : {}),
    // El `.xlsx` no gana columnas en esta HU, pero SÍ tiene que traer las mismas filas: el archivo
    // es «lo que estoy viendo», que es el contrato escrito de esta función.
    ...(vigenciaSel ? { vigencia: vigenciaSel } : {}),
  };
  // El hook se llama SIEMPRE (regla de los hooks); quien decide si la acción existe es el render.
  const exportacion = useExportCola(COLA_SOAT, filtrosExport);
  // Quién puede exportar: la MISMA guarda de la carga masiva, sin predicado nuevo. Deja fuera al
  // auditor (AC6) y al cliente, que además tendría otro archivo —el backend le recorta de cada fila
  // el proveedor, quién despachó y lo que FLITO pagó—: eso sería otra HU, no una condición más.
  const puedeExportar = esOperaciones || esGestor;
  // Quién puede DESCARGAR SOPORTES (HU #11910). La MISMA guarda del export, sin predicado nuevo: el
  // gestor gana casillas que hoy no tiene, y son suyas —necesita los comprobantes de sus SOAT—. Al
  // auditor no se le pinta la columna deshabilitada: no se le pinta (AC7).
  const puedeDescargarSoportes = esOperaciones || esGestor;
  // El hook se llama SIEMPRE (regla de los hooks); quien decide si la acción existe es el render.
  const descargaZip = useDescargaZip(ZIP_SOAT);

  const filas = data?.items ?? [];
  const totalPaginas = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  /**
   * Qué filas se pueden MARCAR: **todas las visibles** (HU #11910, AC1). Antes eran solo las
   * Pendiente, porque la casilla existía para una sola acción; ahora existe también para llevarse
   * los soportes, y un Pagado es justo la fila que tiene la evidencia que alguien va a buscar.
   */
  const seleccionables = filas;
  /**
   * Qué filas del marcado se pueden ENVIAR. **Es lo que viaja en el cuerpo del POST**, y por eso se
   * deriva aquí y no dentro de la barra: abrir la casilla sin acotar el envío convertiría «marqué 40
   * y pulsé enviar» en «el servidor envió 6 y no dijo nada de las otras 34». El servidor ya filtra
   * por estado dentro del `SELECT … FOR UPDATE` —no hay agujero de autorización—; lo que se evita
   * aquí es el descarte SILENCIOSO disfrazado de éxito.
   */
  const enviables = useMemo(
    () => filas.filter((f) => seleccion.has(f.id) && f.estado === EstadoSoat.PENDIENTE),
    [filas, seleccion],
  );
  const detalle = filas.find((f) => f.id === detalleId) ?? null;
  const refrescar = () => setRecarga((n) => n + 1);

  const toggle = (id: string) => setSeleccion((s) => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n;
  });

  return (
    <div className="space-y-4">
      <PageHeaderCard
        title="SOAT"
        // El subtítulo de siempre es vocabulario de Operaciones —«cola de adquisición», «RN-01»— y le
        // habla al Cliente de un proceso que él no ejecuta. Se ramifica solo para él; el de
        // Operaciones no se toca.
        subtitle={esCliente
          ? 'Sus solicitudes de SOAT y las pólizas de su compañía.'
          : 'Cola de adquisición del SOAT. El SOAT se ancla al VIN y solo pasa a Pagado con una factura validada.'}
        actions={(
          <>
            {(esOperaciones || esGestor) && (
              <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={() => setCargaMasiva(true)}>
                Cargar facturas (masivo)
              </button>
            )}
            {/* La ÚNICA acción primaria que el Cliente tiene en todo el producto (HU #11914).
                Es un `<Link>` con aspecto de botón y no un `onClick`: tiene que poder abrirse en
                otra pestaña y salir en el historial. Y no se pinta si la compañía no tiene el canal:
                ofrecer un botón que abre una pantalla que explica que no se puede es justo el patrón
                que el AC5 pide evitar. */}
            {esCliente && puedeSolicitar && (
              <Link to="/flito/soat/solicitud" className={flitBtnPrimary} style={flitBtnPrimaryStyle}>
                Solicitar SOAT
              </Link>
            )}
            {/* Secundario y después del primario: la acción del día de esta cola es cargar facturas,
                no descargar. Al auditor NO se le pinta deshabilitado — no se pinta. */}
            {puedeExportar && (
              <BotonExportarCola ocupado={exportacion.ocupado} onExportar={exportacion.exportar} />
            )}
          </>
        )}
      />

      {/* La banda se monta solo donde se monta el botón: un `role="alert"` colgado en la pantalla
          del auditor no puede dispararse, pero sí sale en el árbol de accesibilidad. */}
      {puedeExportar && (
        <AvisoExportCola
          cola={COLA_SOAT}
          ocupado={exportacion.ocupado}
          aviso={exportacion.aviso}
          onReintentar={exportacion.exportar}
          onDescartar={exportacion.descartar}
        />
      )}

      {/* AC5 — tarjeta NEUTRA, no una banda de error: que la compañía no tenga el canal no es un
          fallo del usuario ni del sistema, es una opción comercial de su empresa. La cola de abajo
          sigue funcionando igual. */}
      {esCliente && !puedeSolicitar && <TarjetaCanalDeshabilitado />}

      <FlitCard>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div ref={refPills} tabIndex={-1} className="flit-focus rounded-[999px]">
            <FlitPillGroup>
              {!esGestor && (
                <FlitPillButton active={estado === 'todos'} onClick={() => setEstado('todos')}>Todos</FlitPillButton>
              )}
              {estadosDisponibles.map((e) => (
                <FlitPillButton key={e} active={estado === e} onClick={() => setEstado(e)}>{ESTADO_SOAT_LABEL[e]}</FlitPillButton>
              ))}
            </FlitPillGroup>
          </div>
          <input className={`${flitInp} max-w-xs`} placeholder="Buscar placa, VIN, comprador…"
            value={texto} onChange={(e) => setTexto(e.target.value)} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-3">
          <ThFiltroMulti seleccion={companiasSel} onCambio={setCompaniasSel} placeholder="Compañía"
            vacio="Sin compañías en la cola"
            opciones={(facetas?.companias ?? []).map((c) => ({ value: String(c.id), label: c.nombre }))} />
          <ThFiltroMulti seleccion={organismosSel} onCambio={setOrganismosSel} placeholder="Organismo"
            vacio="Sin organismos en la cola"
            opciones={(facetas?.organismos ?? []).map((o) => ({ value: o.codigo, label: o.nombre ?? o.codigo }))} />
          {/* Al gestor no se le ofrece: ya está atado a su proveedor y elegir otro solo vaciaría la
              cola. Al cliente tampoco: los nombres de los proveedores son justo lo que el backend le
              quita de cada fila, y `facetasCola` se los devuelve vacíos. */}
          {!esGestor && !esCliente && (
            <ThFiltroMulti seleccion={proveedoresSel} onCambio={setProveedoresSel} placeholder="Proveedor"
              vacio="Sin proveedores en la cola"
              opciones={(facetas?.proveedores ?? []).map((p) => ({ value: p.id, label: p.nombre }))} />
          )}

          {!esGestor && !esCliente && (
            <label className="flex items-center gap-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
              Gestiona
              <select className={`${flitInp} max-w-[11rem]`} value={gestionSel}
                onChange={(e) => setGestionSel(e.target.value as '' | 'operaciones' | 'proveedor')}>
                <option value="">Cualquiera</option>
                <option value="operaciones">Operaciones</option>
                <option value="proveedor">Un proveedor</option>
              </select>
            </label>
          )}

          {/* La guarda es `!esCliente` y NO la de «Gestiona» (`!esGestor && !esCliente`): al gestor
              este filtro sí le sirve —es su reclamación—, y al Cliente el backend ni siquiera le
              acepta el parámetro (`filtrosPermitidos`), así que ofrecérselo sería un control que no
              hace nada. El rótulo visible es además el nombre accesible, con el mismo `<label>`
              envolvente del de al lado: cero patrones nuevos en una barra que ya lleva nueve
              controles. */}
          {!esCliente && (
            <label className="flex items-center gap-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
              Vigencia
              <select className={`${flitInp} max-w-[11rem]`} value={vigenciaSel}
                onChange={(e) => setVigenciaSel(esFiltroVigenciaCola(e.target.value) ? e.target.value : '')}>
                <option value="">Cualquiera</option>
                {FILTROS_VIGENCIA_COLA.map((v) => (
                  <option key={v} value={v}>{VIGENCIA_FILTRO_LABEL[v]}</option>
                ))}
              </select>
            </label>
          )}

          <FiltrosInteligentes presets={PRESETS} activo={preset}
            onAplicar={aplicarPreset} onQuitar={limpiarFiltros} />

          {/* Antes de «Solicitado» y «Pagado»: es el orden del ciclo (creado → solicitado → pagado).
              El rótulo es además su `aria-label`, así que los tres rangos de la pantalla tienen
              nombres accesibles distintos. */}
          <RangoFechas etiqueta="Creado en FLITO" valor={{ desde: creadoDesde, hasta: creadoHasta }}
            onCambio={(r) => { setCreadoDesde(r.desde); setCreadoHasta(r.hasta); }} />
          <RangoFechas etiqueta="Solicitado" valor={{ desde: solicitadoDesde, hasta: solicitadoHasta }}
            onCambio={(r) => { setSolicitadoDesde(r.desde); setSolicitadoHasta(r.hasta); }} />
          <RangoFechas etiqueta="Pagado" valor={{ desde: pagadoDesde, hasta: pagadoHasta }}
            onCambio={(r) => { setPagadoDesde(r.desde); setPagadoHasta(r.hasta); }} />

          <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
            <input type="checkbox" checked={soloEstancado} onChange={(e) => setSoloEstancado(e.target.checked)} />
            Solo sin gestión
          </label>

          {(hayFiltros || !!texto) && (
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={limpiarFiltros}>Limpiar filtros</button>
          )}
        </div>
      </FlitCard>

      {/* Estado 2 de los cuatro. Hasta la HU #11914 la banda no traía salida: el único camino era
          recargar la página, y para un rol EXTERNO eso es un callejón. El botón reusa el `refrescar`
          que ya existía y no inventa nada. */}
      {error && (
        <FlitCard>
          <div className="space-y-2">
            <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
              {esCliente ? 'No pudimos cargar sus solicitudes.' : error}
            </p>
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={refrescar}>Reintentar</button>
          </div>
        </FlitCard>
      )}

      {/* Estado 1 — cargando. Antes la pantalla se veía vacía un instante y el vacío decía «no hay
          SOAT», que es una afirmación distinta de «todavía no sé». El esqueleto ya trae
          `role="status"` y `aria-busy`. */}
      {!data && !error && <PageContentSkeleton />}

      {puedeDescargarSoportes && seleccion.size > 0 && (
        <BarraEnvioSoat
          marcadas={seleccion.size}
          enviables={enviables.map((f) => f.id)}
          puedeEnviar={esOperaciones}
          proveedores={proveedores}
          onEnviado={() => { setSeleccion(new Set()); refrescar(); }}
          onError={setError}
          descarga={(
            <DescargarSoportesZip
              superficie={ZIP_SOAT}
              ids={[...seleccion]}
              ocupado={descargaZip.ocupado}
              onDescargar={descargaZip.descargar}
            />
          )}
        />
      )}

      {/* Fuera de la barra a propósito: la descarga NO limpia la selección, pero si el usuario la
          limpia el aviso tiene que seguir en pantalla. Se monta donde se monta el botón. */}
      {puedeDescargarSoportes && (
        <AvisoSoportesZip
          ocupado={descargaZip.ocupado}
          marcadas={descargaZip.marcadas}
          aviso={descargaZip.aviso}
          onReintentar={descargaZip.reintentar}
          onDescartar={descargaZip.descartar}
        />
      )}

      {data && filas.length === 0 && (
        <FlitCard>
          <FlitEmpty>
            {hayFiltros || texto.trim()
              ? 'Ningún SOAT coincide con los filtros.'
              // El vacío sin filtros se ramifica por rol (HU #11914). El texto de Operaciones manda
              // a «Sincroniza desde el Tablero», un sitio al que la HU #11913 le quitó el acceso al
              // Cliente a propósito: era la PRIMERA frase que leía el primer usuario del rol nuevo y
              // le mandaba a una pantalla que para él no existe. El de Operaciones no se toca.
              : esCliente
                ? (
                  <>
                    <p>Todavía no hay ningún SOAT de su compañía en FLITO.</p>
                    {puedeSolicitar && (
                      <p className="mt-2">
                        Solicite el primero con la placa y el VIN del vehículo.
                        <span className="mt-3 block">
                          <Link to="/flito/soat/solicitud" className={flitBtnPrimary} style={flitBtnPrimaryStyle}>
                            Solicitar SOAT
                          </Link>
                        </span>
                      </p>
                    )}
                  </>
                )
                : 'No hay SOAT en esta vista. Sincroniza desde el Tablero para traer trámites nuevos.'}
          </FlitEmpty>
        </FlitCard>
      )}

      {filas.length > 0 && (
        <FlitCard>
          <div className="mb-3">
            <Paginacion total={data!.total} page={data!.page} totalPaginas={totalPaginas} sustantivo="SOAT"
              onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} />
          </div>
          <FlitTable label="Pólizas SOAT">
            <thead>
              <FlitTr>
                {/* Cuelga del PERMISO y no de «hay filas accionables»: para el auditor aquel
                    cálculo daba vacío por casualidad, y lo que se quiere sostener es la afirmación
                    (AC7). El nombre accesible cambia con el sentido: ya no marca «los pendientes». */}
                {puedeDescargarSoportes && (
                  <FlitTh>
                    <input type="checkbox" aria-label="Seleccionar las filas de esta página"
                      checked={seleccion.size > 0 && seleccion.size === seleccionables.length}
                      onChange={(e) => setSeleccion(e.target.checked ? new Set(seleccionables.map((f) => f.id)) : new Set())} />
                  </FlitTh>
                )}
                {/* Rótulos literales y NO `ENCABEZADOS_COMUNES.slice(1)`: atar los encabezados de
                    esta cola a una posición dentro de un array de otras tres pantallas los cambiaría
                    en silencio el día que alguien lo reordene. */}
                <FlitTh>Vehículo</FlitTh><FlitTh>Fechas</FlitTh>
                <FlitTh>Compañía</FlitTh>
                {!esCliente && <FlitTh>Gestiona</FlitTh>}
                <FlitTh>Estado</FlitTh>
                <FlitTh>Solicitado</FlitTh><FlitTh>Pagado</FlitTh>
                {!esCliente && <FlitTh>Valor</FlitTh>}
                <FlitTh />
              </FlitTr>
            </thead>
            <tbody>
              {filas.map((f) => (
                <FlitTr key={f.id}>
                  {puedeDescargarSoportes && (
                    <td className="px-3 py-2">
                      <input type="checkbox" aria-label={`Seleccionar ${f.placa}`}
                        checked={seleccion.has(f.id)} onChange={() => toggle(f.id)} />
                    </td>
                  )}
                  <CeldaVehiculoSoat placa={f.placa} vin={f.vin} marca={f.marca} linea={f.linea}
                    cilindraje={f.cilindraje} carroceria={f.carroceria} tipoServicio={f.tipoServicio}
                    multiplePropietario={f.esMultiplePropietario} />
                  <CeldaFechas creado={f.fechaCreacion} aprobado={f.fechaAprobacion} />
                  <td className="px-3 py-2 text-sm">{f.companiaNombre}</td>
                  {!esCliente && <CeldaGestion soat={f} />}
                  {/* La vigencia entra AQUÍ y no en una columna nueva: esta celda es, desde la HU
                      #11905, donde viven las señales temporales de riesgo del mismo SOAT, y una
                      columna más devolvería la tabla a 11 y con ella el desborde a 1280 px que
                      aquella HU quitó. Las dos ocupaciones son casi disjuntas —«sin gestión» solo
                      sale en `solicitado` estancado y la vigencia solo en filas con comprobante—,
                      así que la celda sigue teniendo como mucho dos pastillas. */}
                  <td className="px-3 py-2">
                    <div className="flex flex-col items-start gap-1">
                      <StatusChip tone={TONO[f.estado]}>{ESTADO_SOAT_LABEL[f.estado]}</StatusChip>
                      {f.estancado && <ChipSinGestion desde={f.enviadoEn} />}
                      {!esCliente && <CeldaVigencia vigencia={f.vigencia} />}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-sm">
                    <div className="tabular-nums">{f.enviadoEn ? fecha(f.enviadoEn) : '—'}</div>
                    {/* Ya pagado: los días transcurridos desde la solicitud dejan de ser una señal
                        de riesgo y solo ensucian. El chip de sin gestión ya desaparece al pagar. */}
                    {f.enviadoEn && f.estado !== EstadoSoat.PAGADO && (
                      <div className="mt-1"><AntiguedadPill desde={f.enviadoEn} /></div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-sm tabular-nums">{f.pagadoEn ? fecha(f.pagadoEn) : '—'}</td>
                  {!esCliente && <td className="px-3 py-2 text-sm tabular-nums">{pesos(f.valorPagado)}</td>}
                  <td className="px-3 py-2">
                    <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setDetalleId(f.id)}>Ver</button>
                  </td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
          <div className="mt-3">
            <Paginacion total={data!.total} page={data!.page} totalPaginas={totalPaginas} sustantivo="SOAT"
              onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} />
          </div>
        </FlitCard>
      )}

      {detalle && (
        <DetalleSoat soat={detalle} esOperaciones={esOperaciones} esGestor={esGestor} soloLectura={soloLectura}
          esCliente={esCliente} restoreFocusRef={refPills}
          proveedores={proveedores} onClose={() => setDetalleId(null)}
          onCambio={() => { setDetalleId(null); refrescar(); }} />
      )}

      {cargaMasiva && (
        <CargaMasiva onClose={() => setCargaMasiva(false)} onListo={() => { setCargaMasiva(false); refrescar(); }} />
      )}
    </div>
  );
}

/**
 * El vehículo, en la versión de esta cola: lo mismo que pinta `CeldaVehiculo` de
 * `components/flit/columnasComunes` MÁS «Múltiple propietario».
 *
 * Es una copia local a propósito (HU #11905). Ese aviso es un atributo del SOAT
 * (`esMultiplePropietario`), no del trámite: viajaba como `extra` de `CeldaTramite` solo porque esa
 * columna era la que tenía sitio, y al retirarla se habría perdido un dato que ningún AC pidió
 * quitar. La alternativa —añadir una prop a la celda compartida— dejaría el aislamiento de las otras
 * tres tablas (impuestos, derechos, reporte de costos) dependiendo de que nadie pase el argumento;
 * aquí depende de que no exista. El precio, ~10 líneas duplicadas del kit, se acepta y se declara.
 *
 * Si el kit cambia el vehículo, esta celda NO lo hereda: es justo lo que la HU #11905 pide, y el
 * eslabón 2 (HU #11906) añadió aquí cilindraje, carrocería y tipo de servicio sin tocar el kit.
 */
function CeldaVehiculoSoat({ placa, vin, marca, linea, cilindraje, carroceria, tipoServicio, multiplePropietario }: {
  placa: string | null; vin: string | null; marca: string | null; linea: string | null;
  cilindraje: string | null; carroceria: string | null; tipoServicio: string | null;
  multiplePropietario: boolean;
}) {
  const vehiculo = [marca, linea].filter(Boolean).join(' ');
  return (
    <td className="px-4 py-2 align-top">
      <div className="text-sm font-semibold">{placa ?? '—'}</div>
      {/* El VIN en monoespaciado: son diecisiete caracteres que se comparan de un vistazo. */}
      <div className="font-mono text-[11px]" style={{ color: 'var(--flit-text-secondary)' }}>{vin ?? '—'}</div>
      {vehiculo && <div className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{vehiculo}</div>}
      {/* HU #11906 — cilindraje, carrocería y tipo de servicio en UNA línea dentro de esta celda, no
          en tres columnas nuevas: serían 13 columnas, más ancha que antes de la HU #11905, que vino
          justo a aligerarla. Las tres ranuras se pintan SIEMPRE y en orden fijo, con rótulo corto;
          la que falta dice «—» en su sitio y la línea no se colapsa, porque `— · — · —` con rótulos
          dice QUÉ falta y sin ellos no diría nada.
          Los valores se pintan tal como llegan: nada de `parseInt` ni separador de miles sobre el
          cilindraje (ver el comentario de `SoatItem`). */}
      <div className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
        Cil. {dato(cilindraje)} · Carr. {dato(carroceria)} · Serv. {dato(tipoServicio)}
      </div>
      {/* Mismo tratamiento tipográfico que tenía como `extra` del trámite: ni más ni menos énfasis. */}
      {multiplePropietario && (
        <div className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Múltiple propietario</div>
      )}
    </td>
  );
}

/**
 * Quién gestiona el SOAT. Reutiliza la columna del proveedor en vez de añadir una nueva: la cola ya
 * va ancha. En los que Operaciones retomó se dice de quién, que es el dato que hace útil el botón
 * de devolver. El distintivo lleva texto y no solo color.
 */
function CeldaGestion({ soat }: { soat: SoatItem }) {
  if (!soat.gestionOperaciones) {
    return <td className="px-3 py-2 text-sm">{soat.proveedorSoatNombre ?? '—'}</td>;
  }
  return (
    <td className="px-3 py-2 text-sm">
      <StatusChip tone="warning">Operaciones</StatusChip>
      {soat.proveedorSoatNombre && (
        <div className="mt-0.5 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
          retomado de {soat.proveedorSoatNombre}
        </div>
      )}
    </td>
  );
}

/**
 * La vigencia frente al RUNT dentro de la celda «Estado» (HU #12097, AC1 y AC3).
 *
 * Devuelve `null` —nada, ni un «—»— cuando la fila no entra en la verificación diaria. Los tres
 * «vacíos por dato» de esta celda se distinguen SIN LEER: nada (sin comprobante), una línea gris
 * (nunca ha habido respuesta) y una pastilla azul con su línea (hoy se intentó y no salió).
 *
 * **Ninguna acción**: el chip es un `<span>` y la línea es texto, así que la fila no gana ni una
 * parada de tabulador. No hay «verificar ahora» y el dato no se edita (AC4, RN-D1): la verificación
 * es del proceso de las 00:10, con su candado y sus reintentos, y un botón que la disparara a mano
 * convertiría eso en N consultas sin control a un registro nacional.
 *
 * Sin `title`: no lo ve quien navega con teclado ni quien está en una tableta, y el AC1 dice que la
 * fila MUESTRA la fecha. La absoluta con hora vive en el modal.
 */
function CeldaVigencia({ vigencia }: { vigencia?: VigenciaSoatCola | null }) {
  const pintada = pintarVigenciaSoat(vigencia);
  if (!pintada) return null;
  return (
    <>
      {pintada.chip && <StatusChip tone={pintada.chip.tono}>{pintada.chip.etiqueta}</StatusChip>}
      {/* Sin color propio: el dato viejo se lee en el texto, y teñirlo sería otro criterio que
          depende del color — justo lo que el AC3 combate. */}
      <span className="text-xs tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{pintada.linea}</span>
    </>
  );
}

type Accion = 'idle' | 'rechazar' | 'reactivar' | 'reversar' | 'proveedor' | 'factura' | 'asumir' | 'devolver';

function DetalleSoat({ soat, esOperaciones, esGestor, soloLectura, esCliente, proveedores, restoreFocusRef, onClose, onCambio }: {
  soat: SoatItem; esOperaciones: boolean; esGestor: boolean; soloLectura: boolean; esCliente: boolean;
  proveedores: Proveedor[]; restoreFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void; onCambio: () => void;
}) {
  const [accion, setAccion] = useState<Accion>('idle');
  const [motivo, setMotivo] = useState('');
  const [estadoDestino, setEstadoDestino] = useState<EstadoSoat>(EstadoSoat.PENDIENTE);
  const [proveedorSoatId, setProveedorSoatId] = useState(soat.proveedorSoatId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  // Visor de los comprobantes de ESTE SOAT (la factura de la aseguradora), encima del detalle.
  const [verSoportes, setVerSoportes] = useState(false);

  const enAdquisicion = soat.estado === EstadoSoat.SOLICITADO;
  const rechazado = soat.estado === EstadoSoat.CON_NOVEDAD;
  // Ni `esFilaDelCanal` ni el bloque de revisión (HU #12079). Una solicitud del canal es, desde que
  // se radica, **un SOAT en gestión como cualquier otro**: el detalle le ofrece las acciones que ya
  // existían para `solicitado` y recupera «Reversar» y «Cambiar proveedor», que la #11915 le había
  // quitado justamente por estar en un estado que ya no existe.
  // El traspaso de gestión solo tiene sentido mientras el SOAT está en gestión y sin pagar: en
  // Pendiente el destino se elige al enviarlo, y en Pagado el dinero ya salió.
  const traspasable = enAdquisicion || rechazado;

  const ejecutar = async (fn: () => Promise<unknown>) => {
    setEnviando(true); setError(null);
    try { await fn(); onCambio(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setEnviando(false); }
  };

  const subirFactura = (file: File) => ejecutar(() => {
    const form = new FormData(); form.append('archivo', file);
    return api.post(`/flito/soat/${soat.id}/factura`, form);
  });

  return (
    <FlitModal title={`SOAT · ${soat.placa ?? soat.vin}`} onClose={onClose} wide restoreFocusRef={restoreFocusRef}>
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={TONO[soat.estado]}>{ESTADO_SOAT_LABEL[soat.estado]}</StatusChip>
          {soat.estancado && <ChipSinGestion desde={soat.enviadoEn} />}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          <Dato k="VIN" v={soat.vin} /><Dato k="Vehículo" v={`${soat.marca ?? ''} ${soat.linea ?? ''}`.trim() || '—'} />
          <Dato k="Compañía" v={soat.companiaNombre} /><Dato k="Organismo" v={soat.organismoNombre ?? '—'} />
          {/* Los tres datos de la trastienda. No se pintan «—» para el cliente: se omiten, porque el
              backend no se los manda y una fila vacía sugiere un dato que existe y no cargó. */}
          {!esCliente && (
            <Dato k="Gestiona" v={soat.gestionOperaciones
              ? `Operaciones${soat.proveedorSoatNombre ? ` · retomado de ${soat.proveedorSoatNombre}` : ''}`
              : soat.proveedorSoatNombre ?? '—'} />
          )}
          {!esCliente && <Dato k="Enviado por" v={soat.enviadoPorNombre ?? '—'} />}
          <Dato k="Enviado" v={fecha(soat.enviadoEn)} />
          {!esCliente && <Dato k="Valor pagado" v={pesos(soat.valorPagado)} />}
          {/* Los dos de la vigencia (HU #12097), de SOLO LECTURA como el resto de la ficha. El
              rótulo es «Último dato del RUNT» en los cuatro estados —siempre es la misma cosa,
              cuándo contestó por última vez— y uno que cambiara con el estado obligaría a leer dos
              veces. Aquí sí va la hora y aquí sí se pinta «—»: es el nivel de auditoría, y el modal
              ya lo hace en todos sus `<Dato>`. El número de póliza del RUNT no está ni aquí ni en
              ninguna parte: no lo pide ningún AC, es cuasi-PII y colisiona de nombre con
              `numero_poliza`, que es otro número. */}
          {!esCliente && <Dato k="Vigencia" v={textoVigenciaSoat(soat.vigencia)} />}
          {!esCliente && <Dato k="Último dato del RUNT" v={fecha(soat.vigencia?.verificadaEn ?? null)} />}
          {/* El soporte del SOAT se carga desde aquí y hasta ahora solo se podía consultar desde el
              reporte de costos, en el que el gestor del proveedor ni siquiera entra: quien abre un
              SOAT pagado quiere ver la factura que lo pagó sin salir del detalle. */}
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Soporte</dt>
            <dd className="text-sm">
              <button type="button" className="font-semibold underline" style={{ color: 'var(--flit-blue-text)' }}
                onClick={() => setVerSoportes(true)}>Ver soporte</button>
            </dd>
          </div>
        </dl>

        {verSoportes && (
          <VisorSoportes ruta={`/flito/soat/${soat.id}/soportes`} titulo={`SOAT ${soat.placa ?? soat.vin}`}
            vacio="Este SOAT no tiene ninguna factura cargada todavía."
            onClose={() => setVerSoportes(false)} />
        )}

        {/* El historial es el REGISTRO INTERNO de la operación —quién movió qué y cuándo— y hasta la
            HU #11914 se pintaba para todo el mundo, incluido el Cliente. El backend ya se lo recorta
            (la #11913 le quitó el actor y el motivo), pero la pantalla tampoco debe ofrecérselo: lo
            que él necesita no es la línea de tiempo de la operación sino el estado de su SOAT y,
            si volvió con novedad, el motivo con su siguiente paso — que van más abajo. */}
        {!esCliente && <HistorialEstados concepto="soat" registroId={soat.id} />}

        {soat.compradores.length > 0 && (
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase" style={{ color: 'var(--flit-text-muted)' }}>Compradores</p>
            <ul className="space-y-0.5">
              {soat.compradores.map((c) => (
                <li key={c.orden} className="flex justify-between gap-3">
                  <span>{c.nombreCompleto} · {documentoConTipo(c.tipoDocumento, c.numeroDocumento)}</span>
                  {c.porcentajeParticipacion !== null && <span className="tabular-nums">{c.porcentajeParticipacion}%</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {soat.motivoRechazo && (
          <div className="rounded-md bg-red-50 p-2 text-red-700">
            <p>Motivo de rechazo: {soat.motivoRechazo}</p>
            {/* Lo ÚNICO que se añade al retirar el circuito de revisión (HU #12079). «Corregir y
                reenviar» se fue con el estado `rechazada` —que la #12080 borra del enum—, y la vía
                por la que al Cliente le vuelve algo es esta: una caja roja con el motivo del GESTOR
                (`flito_soat.motivo_rechazo`, `con_novedad`) y ningún siguiente paso. La frase
                dice lo que de verdad ocurre —Operaciones puede **Reactivar** o **Devolver al
                proveedor**— y no promete un canal de contacto que el producto no tiene. */}
            {esCliente && (
              <p className="mt-1 text-sm">
                Su solicitud sigue abierta: FLITO está resolviendo esta novedad con el gestor. No tiene que hacer nada por ahora.
              </p>
            )}
          </div>
        )}
        {soloLectura && <div className="rounded-md bg-blue-50 p-2 text-blue-800">Solo lectura · Auditoría observa, no ejecuta acciones.</div>}
        {error && <p className="text-sm text-red-600">{error}</p>}

        {!soloLectura && accion === 'idle' && (
          <div className="flex flex-wrap gap-2 pt-1">
            {enAdquisicion && (esOperaciones || esGestor) && (
              <label className={`${flitBtnPrimary} cursor-pointer`} style={flitBtnPrimaryStyle}>
                {enviando ? 'Cargando…' : 'Cargar factura'}
                <input type="file" accept=".pdf,.png,.jpg,.jpeg" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) subirFactura(f); e.target.value = ''; }} />
              </label>
            )}
            {enAdquisicion && (esOperaciones || esGestor) && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('rechazar')}>Rechazar</button>
            )}
            {rechazado && esOperaciones && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('reactivar')}>Reactivar</button>
            )}
            {/* Las dos acciones heredadas se ofrecen sin condición de origen (HU #12079): la #11915
                se las quitaba a las filas del canal porque «Reversar» una `pendiente_revision` a
                `pendiente` la metía en el alcance de `POST /enviar` sin que nadie la hubiera
                validado.
                Desde la HU #12080 no queda ni el estado ni la fila legada: la migración 0176 recrea
                `flito_soat_estado` sin los dos valores del canal y ABORTA si alguna fila sigue en
                ellos, así que el riesgo que la condición cubría no tiene ya dónde ocurrir. Por eso
                `reversar()` también perdió sus dos guardas: no se relajó una regla, se retiró con lo
                que protegía. */}
            {esOperaciones && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('reversar')}>Reversar</button>
            )}
            {esOperaciones && !enAdquisicion && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('proveedor')}>Cambiar proveedor</button>
            )}
            {esOperaciones && traspasable && !soat.gestionOperaciones && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('asumir')}>Asumir en Operaciones</button>
            )}
            {esOperaciones && traspasable && soat.gestionOperaciones && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('devolver')}>Devolver al proveedor</button>
            )}
          </div>
        )}

        {(accion === 'rechazar' || accion === 'reactivar') && (
          <FormMotivo etiqueta={accion === 'rechazar' ? 'Motivo del rechazo' : 'Motivo de la corrección'}
            motivo={motivo} setMotivo={setMotivo} enviando={enviando} onCancelar={() => { setAccion('idle'); setMotivo(''); }}
            onConfirmar={() => ejecutar(() => api.post(`/flito/soat/${soat.id}/${accion}`, { motivo }))} />
        )}

        {accion === 'reversar' && (
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
            <FlitField label="Estado destino">
              <select className={flitInp} value={estadoDestino} onChange={(e) => setEstadoDestino(e.target.value as EstadoSoat)}>
                {ESTADOS_DESTINO_REVERSA.map((e) => <option key={e} value={e}>{ESTADO_SOAT_LABEL[e]}</option>)}
              </select>
            </FlitField>
            <FormMotivo etiqueta="Motivo de la reversa (mín. 5 caracteres)" motivo={motivo} setMotivo={setMotivo}
              enviando={enviando} minLen={5} onCancelar={() => { setAccion('idle'); setMotivo(''); }}
              onConfirmar={() => ejecutar(() => api.post(`/flito/soat/${soat.id}/reversar`, { estadoDestino, motivo }))} />
          </div>
        )}

        {accion === 'asumir' && (
          <FormMotivo etiqueta="Motivo para asumirlo en Operaciones (mín. 5 caracteres)"
            motivo={motivo} setMotivo={setMotivo} enviando={enviando} minLen={5}
            onCancelar={() => { setAccion('idle'); setMotivo(''); }}
            onConfirmar={() => ejecutar(() => api.post(`/flito/soat/${soat.id}/asumir-operaciones`, { motivo }))} />
        )}

        {accion === 'devolver' && (
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
            <FlitField label="Proveedor que lo retoma">
              <select className={flitInp} value={proveedorSoatId} onChange={(e) => setProveedorSoatId(e.target.value)}>
                <option value="">Selecciona…</option>
                {proveedores.filter((p) => p.activo).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
              </select>
            </FlitField>
            <FormMotivo etiqueta="Motivo de la devolución (mín. 5 caracteres)" motivo={motivo} setMotivo={setMotivo}
              enviando={enviando} minLen={5} deshabilitado={!proveedorSoatId}
              onCancelar={() => { setAccion('idle'); setMotivo(''); }}
              onConfirmar={() => ejecutar(() => api.post(`/flito/soat/${soat.id}/devolver-gestor`, { proveedorSoatId, motivo }))} />
          </div>
        )}

        {accion === 'proveedor' && (
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
            <FlitField label="Nuevo proveedor">
              <select className={flitInp} value={proveedorSoatId} onChange={(e) => setProveedorSoatId(e.target.value)}>
                <option value="">Selecciona…</option>
                {proveedores.filter((p) => p.activo).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
              </select>
            </FlitField>
            <FormMotivo etiqueta="Motivo del cambio" motivo={motivo} setMotivo={setMotivo} enviando={enviando}
              deshabilitado={!proveedorSoatId} onCancelar={() => { setAccion('idle'); setMotivo(''); }}
              onConfirmar={() => ejecutar(() => api.post(`/flito/soat/${soat.id}/proveedor`, { proveedorSoatId, motivo }))} />
          </div>
        )}
      </div>
    </FlitModal>
  );
}

function Dato({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[11px] uppercase" style={{ color: 'var(--flit-text-muted)' }}>{k}</dt>
      <dd className="font-medium">{v}</dd>
    </div>
  );
}

function FormMotivo({ etiqueta, motivo, setMotivo, enviando, minLen = 1, deshabilitado = false, onConfirmar, onCancelar }: {
  etiqueta: string; motivo: string; setMotivo: (v: string) => void; enviando: boolean; minLen?: number;
  deshabilitado?: boolean; onConfirmar: () => void; onCancelar: () => void;
}) {
  return (
    <div className="mt-2 space-y-2">
      <FlitField label={etiqueta}>
        <textarea className={`${flitInp} min-h-[64px]`} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
      </FlitField>
      <div className="flex gap-2">
        <button className={flitBtnPrimary} style={flitBtnPrimaryStyle}
          disabled={enviando || deshabilitado || motivo.trim().length < minLen} onClick={onConfirmar}>
          {enviando ? 'Enviando…' : 'Confirmar'}
        </button>
        <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onCancelar}>Cancelar</button>
      </div>
    </div>
  );
}

interface ResultadoMasivo {
  pagados: { archivo: string; detalle: string }[]; enRevision: { archivo: string; detalle: string }[];
  duplicados: { archivo: string; detalle: string }[]; noAsociados: { archivo: string; detalle: string }[];
}

// El ZIP se abre en el navegador (HU #12056): lo que se cuenta, se pesa, se valida y se envía son
// sus ENTRADAS, no el ZIP. `rutas` NO se manda: la ruta solo sirve para deducir la marca de agua y
// SOAT ni la lee (`/flito/soat/facturas` no toca `req.body`); mandarla sería peso muerto por tanda.
function CargaMasiva({ onClose, onListo }: { onClose: () => void; onListo: () => void }) {
  const { seleccion, abriendo, error, setError, elegir } = useSeleccionCargaMasiva();
  const [progreso, setProgreso] = useState<{ desde: number; total: number } | null>(null);
  const [resultado, setResultado] = useState<ResultadoMasivo | null>(null);
  const errorValidacion = validarCargaMasiva(seleccion);
  const enviando = progreso !== null;

  const subir = async () => {
    if (seleccion.items.length === 0 || validarCargaMasiva(seleccion)) return;
    setError(null);
    const { resultado: r, error: err } = await enviarCargaEnTandas<ResultadoMasivo>(
      '/flito/soat/facturas', seleccion.items, (desde, total) => setProgreso({ desde, total }),
      undefined, { conRutas: false },
    );
    if (r) setResultado(r);
    if (err) setError(err);
    setProgreso(null);
  };

  return (
    <FlitModal title="Carga masiva de facturas SOAT" onClose={resultado ? onListo : onClose} wide>
      {!resultado ? (
        <div className="space-y-3">
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            Sube varios PDF/imágenes o un ZIP. FLITO abre el ZIP en tu computador y sube sus comprobantes de 5 en 5. El OCR cruza cada comprobante con un SOAT solicitado: los que superan el umbral pasan a Pagado; el resto va a revisión.
          </p>
          <input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.zip" className={flitInp} disabled={enviando}
            aria-label="Facturas o ZIP de la carga masiva"
            onChange={(e) => { void elegir(Array.from(e.target.files ?? [])); }} />
          <RanuraCargaMasiva seleccion={seleccion} abriendo={abriendo}
            errorValidacion={errorValidacion} error={error} progreso={progreso} />
          <div className="flex gap-2">
            <button className={flitBtnPrimary} style={flitBtnPrimaryStyle}
              disabled={enviando || abriendo !== null || seleccion.items.length === 0 || !!errorValidacion} onClick={subir}>
              {enviando ? 'Procesando…' : 'Subir y procesar'}
            </button>
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={enviando} onClick={onClose}>Cancelar</button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <StatusChip tone="success">Pagados {resultado.pagados.length}</StatusChip>
            <StatusChip tone="warning">En revisión {resultado.enRevision.length}</StatusChip>
            <StatusChip tone="neutral">Duplicados {resultado.duplicados.length}</StatusChip>
            <StatusChip tone="danger">Sin asociar {resultado.noAsociados.length}</StatusChip>
          </div>
          <TablaResultadoOcr resultado={resultado} />
          <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={onListo}>Listo</button>
        </div>
      )}
    </FlitModal>
  );
}

// Resultado del OCR masivo en TABLA: cada archivo analizado en su propia fila (archivo · resultado ·
// detalle), en vez de listas apretadas.
function TablaResultadoOcr({ resultado }: { resultado: ResultadoMasivo }) {
  const filas: { archivo: string; detalle: string; resultado: string; tono: ChipTone }[] = [
    ...resultado.pagados.map((i) => ({ ...i, resultado: 'Pagado', tono: 'success' as ChipTone })),
    ...resultado.enRevision.map((i) => ({ ...i, resultado: 'En revisión', tono: 'warning' as ChipTone })),
    ...resultado.duplicados.map((i) => ({ ...i, resultado: 'Duplicado', tono: 'neutral' as ChipTone })),
    ...resultado.noAsociados.map((i) => ({ ...i, resultado: 'Sin asociar', tono: 'danger' as ChipTone })),
  ];
  if (filas.length === 0) return <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>No se procesó ningún archivo.</p>;
  const th = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide';
  return (
    <div className="max-h-[55vh] overflow-auto rounded-lg border" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <table className="w-full text-sm">
        <thead>
          <tr style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>
            <th className={th}>Archivo</th><th className={th}>Resultado</th><th className={th}>Detalle del análisis OCR</th>
          </tr>
        </thead>
        <tbody>
          {filas.map((f, idx) => (
            <tr key={idx} className="border-t" style={{ borderColor: 'var(--flit-border-soft)' }}>
              <td className="px-3 py-2 font-medium align-top" style={{ color: 'var(--flit-text-primary)' }}>{f.archivo}</td>
              <td className="px-3 py-2 align-top"><StatusChip tone={f.tono}>{f.resultado}</StatusChip></td>
              <td className="px-3 py-2 align-top" style={{ color: 'var(--flit-text-secondary)' }}>{f.detalle}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
