// FLITO — Portal SOAT (Fase 6). Porta packages/client/src/paginas/soat/* al kit flit/ + api.
// Cola con las 3 fronteras (resueltas en el backend), envío atómico al gestor, carga de factura
// (única vía a Pagado, RN-03), rechazo/reactivación/reversa/cambio de proveedor y carga masiva.
// La visibilidad la impone el servidor: Operaciones ve todo; el gestor solo su proveedor y nunca
// los Pendiente; Auditoría es solo lectura.

import { puedeOperar } from '../lib/permissions';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ANS_OPERATIVO, CARGA_MASIVA_OCR_TIMEOUT_MS, ESTADO_SOAT_LABEL, EstadoSoat } from '@operaciones/shared-types';
import { api, errorMessage } from '../lib/api';
import { puedeSolicitarSoat, useAuth } from '../lib/auth';
import { TarjetaCanalDeshabilitado } from '../components/flito/soat-cliente/TarjetaCanal';
import BloqueRevision from '../components/flito/soat-cliente/BloqueRevision';
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
}
interface Proveedor { id: string; nombre: string; activo: boolean }
interface ColaSoat { items: SoatItem[]; total: number; page: number; pageSize: number }
interface FacetasSoat {
  companias: { id: number; nombre: string }[];
  organismos: { codigo: string; nombre: string | null }[];
  proveedores: { id: string; nombre: string }[];
}

// Los dos últimos son del canal Cliente (Feature #11912) y hoy solo los pinta esta cola cuando el
// admin la mira: quien los ESCRIBE es la #11914 (alta) y la #11915 (revisión). Se completan aquí
// porque el `Record<EstadoSoat, …>` exhaustivo lo exige, y esa exigencia es justo la red que impide
// que un estado nuevo salga en blanco. `pendiente_revision` va en `warning` —espera acción de
// Operaciones, como el `pendiente` de la pantalla de trámites— y `rechazada` en `danger`, junto a
// `con_novedad`, que es el otro «esto volvió sin resolverse».
const TONO: Record<EstadoSoat, ChipTone> = {
  pendiente: 'draft', solicitado: 'active', con_novedad: 'danger', pagado: 'success',
  pendiente_revision: 'warning', rechazada: 'danger',
};
const pesos = (v: number | null | undefined) => v === null || v === undefined ? '—'
  : new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(v);
/** Un dato de texto de FLIT, tal cual llega. Ausente —`null` o vacío— se pinta «—» (HU #11906, AC2):
    un hueco en blanco se confunde con un fallo de carga, y esto no lo es. No transforma el valor. */
const dato = (v: string | null) => (v && v.trim() ? v : '—');
const fecha = (iso: string | null) => iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : '—';

/**
 * Los estados a los que el admin puede REVERSAR un SOAT, y NADA MÁS (HU #11915).
 *
 * Hasta esta HU esta lista alimentaba dos cosas a la vez: las pastillas de la cola Y el selector
 * «Estado destino» de la reversa. Añadirle los dos estados del canal Cliente —que es lo que hacía
 * falta para que el admin pudiera FILTRAR por «Pendiente de revisión»— le habría abierto de paso la
 * posibilidad de reversar cualquier SOAT a `pendiente_revision` o a `rechazada`, que es justo lo que
 * el ADR-0008 §8 prohíbe por escrito: devolver a `pendiente_revision` un SOAT ya validado deja al
 * gestor sin la fila y al cliente con una solicitud que creía resuelta. El servicio ya lo niega
 * (`reversar()`), pero la pantalla tampoco debe OFRECERLO.
 *
 * De ahí las dos listas separadas y el nombre nuevo: fundirlas otra vez tendría que costarle a
 * alguien escribir «destino de reversa» donde se lee «pastillas», y eso ya no se hace sin querer.
 */
const ESTADOS_DESTINO_REVERSA: EstadoSoat[] = [EstadoSoat.PENDIENTE, EstadoSoat.SOLICITADO, EstadoSoat.PAGADO, EstadoSoat.CON_NOVEDAD];
const ESTADOS_GESTOR: EstadoSoat[] = [EstadoSoat.SOLICITADO, EstadoSoat.PAGADO];
/**
 * Las pastillas del admin: los SEIS estados, en orden de RECORRIDO (HU #11915).
 *
 * `pendiente_revision` va primero porque es el trabajo del día que esta HU le crea; después el ciclo
 * de siempre (pendiente → solicitado → pagado → con novedad) y al final `rechazada`, que es lo que
 * está esperando al cliente y no a Operaciones.
 *
 * Sin esta pastilla el admin no tenía forma de encontrar lo que la HU le manda revisar salvo paginar:
 * la #11914 se la dio al Cliente (`ESTADOS_CLIENTE`) y dejó al revisor sin ella.
 */
const ESTADOS_ADMIN: EstadoSoat[] = [
  EstadoSoat.PENDIENTE_REVISION, EstadoSoat.PENDIENTE, EstadoSoat.SOLICITADO,
  EstadoSoat.PAGADO, EstadoSoat.CON_NOVEDAD, EstadoSoat.RECHAZADA,
];
/**
 * Los SEIS estados, en orden de recorrido (HU #11914).
 *
 * Hasta esta HU el Cliente caía en `ESTADOS_OPERACIONES`, que **no incluye `pendiente_revision` ni
 * `rechazada`** — precisamente sus dos estados propios. Con la cola paginada, encontrar una
 * rechazada entre las páginas era cuestión de suerte, y el AC4 exige que llegue a ella: sin esta
 * pastilla no hay camino desde la cola hasta la subsanación.
 *
 * Y son los seis, no los dos suyos: el aislamiento del Cliente es **por compañía, no por origen**
 * (`condicionesCola`), así que en su cola conviven los SOAT que nacieron de trámites de FLIT con los
 * que él radica. Ofrecerle solo dos filtros dejaría fuera la mayoría de sus filas.
 *
 * No hace falta además una columna «Origen»: `pendiente_revision` y `rechazada` SOLO existen en el
 * canal Cliente (ADR-0008 §8), así que el estado ya dice de dónde viene cada fila.
 */
const ESTADOS_CLIENTE: EstadoSoat[] = [
  EstadoSoat.PENDIENTE_REVISION, EstadoSoat.RECHAZADA, EstadoSoat.PENDIENTE,
  EstadoSoat.SOLICITADO, EstadoSoat.CON_NOVEDAD, EstadoSoat.PAGADO,
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
    || !!creadoDesde || !!creadoHasta || soloEstancado || !!gestionSel;

  const limpiarFiltros = () => {
    setCompaniasSel([]); setOrganismosSel([]); setProveedoresSel([]);
    setSolicitadoDesde(''); setSolicitadoHasta(''); setPagadoDesde(''); setPagadoHasta('');
    setCreadoDesde(''); setCreadoHasta('');
    setSoloEstancado(false); setGestionSel(''); setTexto(''); setPreset(null);
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
  useEffect(() => { setPage(1); }, [estado, buscar, compKey, orgKey, provKey, solicitadoDesde, solicitadoHasta, pagadoDesde, pagadoHasta, creadoDesde, creadoHasta, soloEstancado, gestionSel]);

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
    q.set('page', String(page));
    api.get<ColaSoat>(`/flito/soat?${q}`).then(setData).catch((e) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estado, buscar, compKey, orgKey, provKey, solicitadoDesde, solicitadoHasta, pagadoDesde, pagadoHasta, creadoDesde, creadoHasta, soloEstancado, gestionSel, page, recarga]);

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
                  <td className="px-3 py-2">
                    <div className="flex flex-col items-start gap-1">
                      <StatusChip tone={TONO[f.estado]}>{ESTADO_SOAT_LABEL[f.estado]}</StatusChip>
                      {f.estancado && <ChipSinGestion desde={f.enviadoEn} />}
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
  // Las dos guardas del canal Cliente (HU #11915), nombradas por ESTADO y nunca por rol: la pregunta
  // es por la FILA, no por quien la mira. `pendiente_revision` y `rechazada` solo existen en el
  // canal (ADR-0008 §8), así que el estado ya dice de dónde viene la solicitud.
  const enRevision = soat.estado === EstadoSoat.PENDIENTE_REVISION;
  const rechazadaCliente = soat.estado === EstadoSoat.RECHAZADA;
  const esFilaDelCanal = enRevision || rechazadaCliente;
  // El bloque de revisión: los lectores INTERNOS siempre que la fila sea del canal —el auditor lo ve
  // en solo lectura, que es su trabajo—; el Cliente solo cuando hay algo que corregir. Al gestor no
  // le llega: los dos estados están fuera de su lista blanca y `GET /:id` le responde 404.
  const verRevision = esFilaDelCanal
    && (esOperaciones || soloLectura || (esCliente && rechazadaCliente));
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
            que él necesita no es la línea de tiempo de la operación sino la causal de SU rechazo,
            que es otra cosa y va en su propio bloque (`CorreccionSolicitud`). */}
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

        {soat.motivoRechazo && <p className="rounded-md bg-red-50 p-2 text-red-700">Motivo de rechazo: {soat.motivoRechazo}</p>}
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
            {/* Las dos acciones heredadas se condicionan ADEMÁS a que la fila no sea del canal
                (HU #11915). «Reversar» se pintaba sin ninguna condición de estado, y llevar una
                `pendiente_revision` a `pendiente` la mete en el alcance de `POST /enviar` —que
                filtra por `pendiente`—: sería despachar al gestor una solicitud que nadie validó,
                el AC1 saltado por la puerta de al lado. El servicio ya lo niega desde esta HU; la
                pantalla no debe ofrecer algo por lo que el admin vaya a recibir un error.
                «Cambiar proveedor» no rompe nada, pero elegir gestor para una solicitud que aún no
                ha entrado en gestión es una acción sin sentido en ese punto del ciclo. */}
            {esOperaciones && !esFilaDelCanal && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('reversar')}>Reversar</button>
            )}
            {esOperaciones && !enAdquisicion && !esFilaDelCanal && (
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

        {/* Al FINAL y después del historial, no arriba: lo primero que hay que hacer es LEER la
            factura de venta («Ver soporte», más arriba), y poner los dos botones antes que el
            soporte invita a validar sin abrirlo. Y no en un modal aparte: el visor de soportes ya se
            abre encima de este modal, y un tercer nivel es el que rompe la pila. */}
        {verRevision && accion === 'idle' && (
          <BloqueRevision
            soatId={soat.id}
            estado={soat.estado}
            esCliente={esCliente}
            puedeRevisar={esOperaciones && !soloLectura && enRevision}
            proveedores={proveedores}
            onCambio={onCambio}
          />
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

function CargaMasiva({ onClose, onListo }: { onClose: () => void; onListo: () => void }) {
  const [archivos, setArchivos] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoMasivo | null>(null);

  const subir = async () => {
    if (archivos.length === 0) return;
    setEnviando(true); setError(null);
    try {
      const form = new FormData();
      for (const f of archivos) form.append('archivos', f);
      // `post` usa el tope compartido de 90 s y no alcanza: el OCR de la tanda va en serie.
      const r = await api.postConTimeout<ResultadoMasivo>('/flito/soat/facturas', form, CARGA_MASIVA_OCR_TIMEOUT_MS);
      setResultado(r);
    } catch (e) { setError(errorMessage(e)); }
    finally { setEnviando(false); }
  };

  return (
    <FlitModal title="Carga masiva de facturas SOAT" onClose={resultado ? onListo : onClose} wide>
      {!resultado ? (
        <div className="space-y-3">
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            Sube varios PDF/imágenes o un ZIP. El OCR cruza cada comprobante con un SOAT solicitado: los que superan el umbral pasan a Pagado; el resto va a revisión.
          </p>
          <input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.zip" className={flitInp}
            onChange={(e) => setArchivos(Array.from(e.target.files ?? []))} />
          {archivos.length > 0 && <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{archivos.length} archivo(s) listos.</p>}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={enviando || archivos.length === 0} onClick={subir}>
              {enviando ? 'Procesando…' : 'Subir y procesar'}
            </button>
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>Cancelar</button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
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
