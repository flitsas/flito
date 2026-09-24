// FLITO — Portal SOAT (Fase 6). Porta packages/client/src/paginas/soat/* al kit flit/ + api.
// Cola con las 3 fronteras (resueltas en el backend), envío atómico al gestor, carga de factura
// (única vía a Pagado, RN-03), rechazo/reactivación/reversa/cambio de proveedor y carga masiva.
// La visibilidad la impone el servidor: Operaciones ve todo; el gestor solo su proveedor y nunca
// los Pendiente; Auditoría es solo lectura.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { CircleAlert, Lock, Plus, RotateCw, Upload } from 'lucide-react';
import { ANS_OPERATIVO, EstadoSoat, type FiltroVigenciaCola } from '@operaciones/shared-types';
import { api, errorMessage } from '../lib/api';
import { puedeSolicitarSoat, useAuth } from '../lib/auth';
import { TarjetaCanalDeshabilitado } from '../components/flito/soat-cliente/TarjetaCanal';
import PageContentSkeleton from '../components/flit/PageContentSkeleton';
import BarraEnvioSoat from '../components/flito/BarraEnvioSoat';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import {
  AvisoExportCola, BotonExportarCola, COLA_SOAT, useExportCola, type FiltrosExportCola,
} from '../components/flito/ExportarCola';
import { AvisoSoportesZip, ZIP_SOAT, useDescargaZip } from '../components/flito/DescargarSoportesZip';
import { useDescargaComprobante } from '../components/flito/DescargarComprobanteSoat';
import useDebounce from '../lib/useDebounce';
import {
  FlitCard, FlitEmpty, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary,
} from '../components/flit/flitPageKit';
import { toastError, toastOk } from '../components/flit/ToastFlito';
// Las piezas de la cola viven en `components/flito/soat/` desde la HU #12819 (techo de 800 líneas).
import {
  ESTADOS_ADMIN, ESTADOS_CLIENTE, ESTADOS_GESTOR, type ColaSoat, type FacetasSoat, type Proveedor,
} from '../components/flito/soat/tipos';
import BarraFiltrosSoat, { type PresetSoat } from '../components/flito/soat/BarraFiltrosSoat';
import TablaColaSoat from '../components/flito/soat/TablaColaSoat';
import DetalleSoat from '../components/flito/soat/DetalleSoat';
import CargaMasiva from '../components/flito/soat/CargaMasivaSoat';

/** Acciones de cabecera: a ancho completo por debajo de `sm`, la primaria primero (§14). */
const ACCION_CABECERA = 'w-full justify-center sm:w-auto';

export default function FlitoSoat() {
  const { user, hasFuncion, funciones } = useAuth();
  // HU #12170: modos de UI derivados de funciones del catálogo, no de `role ===`.
  const esOperaciones = hasFuncion('soat.solicitud.enviar');
  const esGestor = hasFuncion('soat.comprobante.cargar') && !esOperaciones;
  const soloLectura = hasFuncion('soat.cola.ver') && !hasFuncion('soat.comprobante.cargar') && !esOperaciones;
  // Canal cliente: tiene radicar y no envía a gestor (admin tiene ambas → operaciones).
  const esCliente = hasFuncion('soat.solicitud.crear') && !esOperaciones;
  // La capacidad de radicar (HU #11914). Sale de `/auth/me`, así que resuelve ANTES que la cola y el
  // botón no parpadea de «puedo» a «no puedo». No es la frontera: los dos endpoints del canal la
  // vuelven a comprobar y responden 403.
  const puedeSolicitar = puedeSolicitarSoat(user);
  const { state: estadoNavegacion } = useLocation();
  // AC4 / CF-21 (se pinta abajo, tras los hooks).
  const sinFuncionesPantalla = funciones !== null
    && !hasFuncion('soat.cola.ver') && !hasFuncion('soat.solicitud.crear');

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
  const PRESETS: PresetSoat[] = [
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

  const aplicarPreset = (p: PresetSoat) => {
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
  // Bug #12642: la casilla del Excel ampliado. Estado de la PÁGINA y no del hook, porque es parte
  // del cuerpo que se manda, igual que cualquier otro filtro. La función es aparte de la del
  // export: quien puede descargar el archivo del gestor no necesariamente puede ver el pago.
  const puedeExportarPago = hasFuncion('soat.excel.exportar_pago');
  const [incluirPago, setIncluirPago] = useState(false);
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
    // Bug #12642: la clave viaja SOLO marcada —y solo si se tiene la función, que es lo que pinta la
    // casilla—: ausente, el cuerpo es el mismo de siempre. Sin la función no hay forma de marcarla.
    ...(puedeExportarPago && incluirPago ? { incluirPago: true } : {}),
  };
  // El hook se llama SIEMPRE (regla de los hooks); quien decide si la acción existe es el render.
  const exportacion = useExportCola(COLA_SOAT, filtrosExport);
  // Quién puede exportar: la MISMA guarda de la carga masiva, sin predicado nuevo. Deja fuera al
  // auditor (AC6) y al cliente, que además tendría otro archivo —el backend le recorta de cada fila
  // el proveedor, quién despachó y lo que FLITO pagó—: eso sería otra HU, no una condición más.
  const puedeExportar = esOperaciones || esGestor;
  // Quién DESCARGA SOPORTES: la función que exige el POST del ZIP (HU #12815), no el rol. La casilla
  // sirve también para «Enviar al gestor»: sin ninguna de las dos, no hay columna (AC7).
  const puedeDescargar = hasFuncion('soat.soportes.descargar');
  const conCasillas = puedeDescargar || esOperaciones;
  // Descarga INDIVIDUAL (HU #12816): un solo hook para la fila y el detalle, mismo candado y toast.
  const descargaComprobante = useDescargaComprobante();
  // El hook se llama SIEMPRE (regla de los hooks); quien decide si la acción existe es el render.
  const descargaZip = useDescargaZip(ZIP_SOAT);

  const filas = useMemo(() => data?.items ?? [], [data]);
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
  /** Las marcadas PAGADAS: las únicas con comprobante (RN-03), y lo único que viaja en el ZIP. */
  const descargables = useMemo(
    () => filas.filter((f) => seleccion.has(f.id) && f.estado === EstadoSoat.PAGADO).map((f) => f.id),
    [filas, seleccion],
  );
  const detalle = filas.find((f) => f.id === detalleId) ?? null;
  const refrescar = () => setRecarga((n) => n + 1);

  const toggle = (id: string) => setSeleccion((s) => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n;
  });

  return (
    <div className="space-y-4">
      {sinFuncionesPantalla ? (
        <>
          <PageHeaderCard title="SOAT" />
          <FlitCard>
            <p className="flex items-start gap-2 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
              <Lock size={18} aria-hidden="true" className="mt-0.5 shrink-0" style={{ color: 'var(--flit-text-muted)' }} />
              Su usuario no tiene ninguna función habilitada en esta pantalla. Si cree que debería operar aquí, pida a un administrador que revise el cuadro de su rol.
            </p>
          </FlitCard>
        </>
      ) : (
      <>
      <PageHeaderCard
        title="SOAT"
        // El subtítulo de siempre es vocabulario de Operaciones y le habla al Cliente de un proceso que
        // él no ejecuta: se ramifica para él. El de Operaciones perdió en la HU #12819 la regla de
        // negocio (RN-01/RN-03), que no es un título: dice qué es la cola, no cómo se valida.
        subtitle={esCliente
          ? 'Sus solicitudes de SOAT y las pólizas de su compañía.'
          : 'Cola de adquisición del SOAT: de Pendiente a Pagado.'}
        actions={(
          <>
            {(esOperaciones || esGestor) && (
              <button type="button" className={`${flitBtnPrimary} ${ACCION_CABECERA}`} style={flitBtnPrimaryStyle} onClick={() => setCargaMasiva(true)}>
                <Upload size={16} aria-hidden="true" className="shrink-0" />
                Cargar facturas (masivo)
              </button>
            )}
            {/* La ÚNICA acción primaria que el Cliente tiene en todo el producto (HU #11914).
                Es un `<Link>` con aspecto de botón y no un `onClick`: tiene que poder abrirse en
                otra pestaña y salir en el historial. Y no se pinta si la compañía no tiene el canal:
                ofrecer un botón que abre una pantalla que explica que no se puede es justo el patrón
                que el AC5 pide evitar. */}
            {esCliente && puedeSolicitar && (
              <Link to="/flito/soat/solicitud" className={`${flitBtnPrimary} ${ACCION_CABECERA}`} style={flitBtnPrimaryStyle}>
                <Plus size={16} aria-hidden="true" className="shrink-0" />
                Solicitar SOAT
              </Link>
            )}
            {/* Secundario y después del primario: la acción del día de esta cola es cargar facturas,
                no descargar. Al auditor NO se le pinta deshabilitado — no se pinta. */}
            {puedeExportar && (
              <BotonExportarCola
                ocupado={exportacion.ocupado}
                onExportar={exportacion.exportar}
                incluirPago={puedeExportarPago ? { marcado: incluirPago, onCambio: setIncluirPago } : undefined}
              />
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

      <BarraFiltrosSoat refPills={refPills} esGestor={esGestor} esCliente={esCliente}
        estadosDisponibles={estadosDisponibles} estado={estado} setEstado={setEstado}
        texto={texto} setTexto={setTexto} facetas={facetas}
        companiasSel={companiasSel} setCompaniasSel={setCompaniasSel}
        organismosSel={organismosSel} setOrganismosSel={setOrganismosSel}
        proveedoresSel={proveedoresSel} setProveedoresSel={setProveedoresSel}
        gestionSel={gestionSel} setGestionSel={setGestionSel}
        vigenciaSel={vigenciaSel} setVigenciaSel={setVigenciaSel}
        presets={PRESETS} preset={preset} onAplicarPreset={aplicarPreset}
        creadoDesde={creadoDesde} creadoHasta={creadoHasta}
        setCreado={(d, h) => { setCreadoDesde(d); setCreadoHasta(h); }}
        solicitadoDesde={solicitadoDesde} solicitadoHasta={solicitadoHasta}
        setSolicitado={(d, h) => { setSolicitadoDesde(d); setSolicitadoHasta(h); }}
        pagadoDesde={pagadoDesde} pagadoHasta={pagadoHasta}
        setPagado={(d, h) => { setPagadoDesde(d); setPagadoHasta(h); }}
        soloEstancado={soloEstancado} setSoloEstancado={setSoloEstancado}
        hayFiltros={hayFiltros} limpiarFiltros={limpiarFiltros} />

      {/* Estado 2 de los cuatro. Hasta la HU #11914 la banda no traía salida: el único camino era
          recargar la página, y para un rol EXTERNO eso es un callejón. El botón reusa el `refrescar`
          que ya existía y no inventa nada. */}
      {/* HU #12819: solo errores de CARGA de la cola (el envío ya no llega aquí: es un toast) y con
          copy propio — nunca el mensaje crudo del API. */}
      {error && (
        <FlitCard>
          <div className="flex items-start gap-3">
            <CircleAlert size={18} aria-hidden="true" className="mt-0.5 shrink-0" style={{ color: 'var(--flit-danger-text)' }} />
            <div className="space-y-3">
              <div role="alert" className="space-y-1 text-sm">
                <p style={{ color: 'var(--flit-danger-text)' }}>
                  {esCliente ? 'No pudimos cargar sus solicitudes.' : 'No se pudo cargar la cola de SOAT. Revisa tu conexión e intenta de nuevo.'}
                </p>
                {esCliente && <p style={{ color: 'var(--flit-text-secondary)' }}>Intente de nuevo en un momento.</p>}
              </div>
              <button type="button" className={flitBtnSecondary} onClick={refrescar}>
                <RotateCw size={16} aria-hidden="true" className="shrink-0" />
                Reintentar
              </button>
            </div>
          </div>
        </FlitCard>
      )}

      {/* Estado 1 — cargando. Antes la pantalla se veía vacía un instante y el vacío decía «no hay
          SOAT», que es una afirmación distinta de «todavía no sé». El esqueleto ya trae
          `role="status"` y `aria-busy`. */}
      {!data && !error && <PageContentSkeleton />}

      {/* Fuera de la barra a propósito: la descarga NO limpia la selección, pero si el usuario la
          limpia el aviso tiene que seguir en pantalla. Se monta donde se monta el botón. */}
      {puedeDescargar && (
        <AvisoSoportesZip
          ocupado={descargaZip.ocupado}
          marcadas={descargaZip.marcadas}
          aviso={descargaZip.aviso}
          onReintentar={descargaZip.reintentar}
          onDescartar={descargaZip.descartar}
        />
      )}

      {/* La barra de la selección va JUSTO encima de la tabla y pegada arriba mientras se marcan
          filas (HU #12819, §6): antes quedaba sobre el aviso ZIP, lejos de las casillas, y en una
          tabla larga sus acciones se iban de la vista. El `top` salta la barra superior del shell,
          que también es pegajosa: con `top-2` quedaría debajo de ella. */}
      {conCasillas && seleccion.size > 0 && (
        <div className="sticky top-[calc(var(--flit-topbar-height)+0.5rem)] z-20">
          <BarraEnvioSoat marcadas={seleccion.size} enviables={enviables.map((f) => f.id)} descargables={descargables}
            puedeEnviar={esOperaciones} puedeDescargar={puedeDescargar} proveedores={proveedores} zip={descargaZip}
            onQuitar={() => setSeleccion(new Set())}
            onEnviado={(n, aOperaciones) => {
              toastOk(`${n} SOAT enviados ${aOperaciones ? 'a Operaciones' : 'al gestor'}.`);
              setSeleccion(new Set()); refrescar();
            }}
            // El error NO toca el estado de la página: la selección se conserva para reintentar.
            onError={(texto) => toastError(texto)} />
        </div>
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
                        {/* Secundario desde la HU #12819: la primaria ya está en la cabecera. */}
                        <span className="mt-3 block">
                          <Link to="/flito/soat/solicitud" className={flitBtnSecondary}>
                            <Plus size={16} aria-hidden="true" className="shrink-0" />
                            Solicitar SOAT
                          </Link>
                        </span>
                      </p>
                    )}
                  </>
                )
                // HU #12819: el gestor no sincroniza el Tablero (no es suyo) y el auditor no trae nada.
                : esGestor
                  ? 'No tienes SOAT en esta vista. Aparecerán aquí cuando Operaciones te los envíe.'
                  : soloLectura
                    ? 'No hay SOAT en esta vista. Prueba con otro estado en las pastillas de arriba.'
                    : 'No hay SOAT en esta vista. Sincroniza desde el Tablero para traer trámites nuevos.'}
            {(hayFiltros || texto.trim()) && (
              <p className="mt-1">{esCliente ? 'Quite algún filtro o use «Limpiar filtros».' : 'Quita algún filtro o usa «Limpiar filtros».'}</p>
            )}
          </FlitEmpty>
        </FlitCard>
      )}

      {data && filas.length > 0 && (
        <TablaColaSoat data={data} filas={filas} totalPaginas={totalPaginas}
          onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)}
          conCasillas={conCasillas} seleccion={seleccion} setSeleccion={setSeleccion}
          seleccionables={seleccionables} toggle={toggle} esCliente={esCliente}
          conCompania={!esCliente || (facetas?.companias.length ?? 0) > 1}
          puedeDescargar={puedeDescargar} descargaComprobante={descargaComprobante} onVer={setDetalleId} />
      )}

      {detalle && (
        <DetalleSoat soat={detalle} esOperaciones={esOperaciones} esGestor={esGestor} soloLectura={soloLectura}
          esCliente={esCliente} restoreFocusRef={refPills}
          descarga={puedeDescargar ? descargaComprobante : null}
          proveedores={proveedores} onClose={() => setDetalleId(null)}
          onCambio={() => { setDetalleId(null); refrescar(); }} />
      )}

      {cargaMasiva && (
        <CargaMasiva onClose={() => setCargaMasiva(false)} onListo={() => { setCargaMasiva(false); refrescar(); }} />
      )}
      </>
      )}
    </div>
  );
}
