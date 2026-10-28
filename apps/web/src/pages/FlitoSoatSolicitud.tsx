// FLITO — canal Cliente: alta de una solicitud de SOAT sin trámite (Feature #11912).
//
// Diseño: docs/ux/flito-soat-alta-por-vin-y-ficha-completa.md (HU #12091) — manda sobre los
// anteriores donde discrepen, y discrepan en un punto: **la placa deja de ser un dato que el
// Cliente teclea**. Antes: docs/ux/flito-soat-consulta-runt-compuerta-y-propietario.md (#11967).
// Contrato: docs/diseno-hu-11966-runt-compuerta-excel-cliente.md §2 (ADR-0010).
//
// ── Dónde vive, y por qué es una SUB-RUTA y no un modal ─────────────────────────────────────────
//
// `/flito/soat/solicitud`, bajo el MISMO slug `flito_soat`. Ninguna entrada de menú nueva, ningún
// `PageSlug` nuevo: quien puede ver la cola de su compañía es quien puede pedir un SOAT para ella.
//
// Y es lo que hace que «el Cliente tiene una sola página» siga siendo verdad en la pantalla y no
// solo en el papel — medido, `FlitSidebar.tsx:145`: el `NavLink` lleva `end={it.to === '/'}`, o sea
// que para `/flito/soat` `end` es `false` y cualquier SUB-ruta mantiene el ítem «SOAT» con
// `aria-current="page"`. Con una ruta hermana (`/flito/solicitud`) el ítem se apagaría y el Cliente
// estaría «en ninguna parte» de su propio menú.
//
// Los tres descartes, para que nadie los rehaga: un **modal** sobre la cola no cabe y pierde la
// dirección a la que volver; una **vista por estado sin URL** deja la subsanación sin enlace; y un
// **wizard** promete pasos que se guardan cuando el AC1 dice lo contrario: no hay borrador, crear
// es enviar.
//
// ── La compuerta (HU #11967) ────────────────────────────────────────────────────────────────────
//
// El RUNT vuelve a decidir el alta, y por eso vuelve «Consultar el RUNT». Tres cosas que esta
// pantalla resuelve y que es fácil hacer al revés:
//
//   1. **No vuelve `EnEspera`.** La compuerta es del ENVÍO, no del tecleo: los tres bloques montan
//      sus controles desde el primer paint y lo que el Cliente escriba antes de consultar no se
//      pierde. Doce controles grises que no reciben foco es lo que la #11936 quitó con razón.
//      Y **no hay asistente por pasos ni borrador** (HU #12091, AC2): crear sigue siendo enviar.
//   2. **Se ramifica por `codigo`** (`reaccionA`, en `lib/soatCliente.ts`), nunca por el texto del
//      mensaje, y hay rama por defecto para un código desconocido o retirado.
//   3. **`aria-disabled` y no `disabled`** en el primario de envío. Ver la tarjeta de envío, abajo.
//
// ── El orden de los tres bloques (HU #12091, AC2) ───────────────────────────────────────────────
//
// **1 · Vehículo → 2 · Factura de venta → 3 · Propietario**, y el orden del DOM es el orden visual
// y el del tabulador. La factura se adelanta al propietario porque es el orden en el que el trabajo
// se hace —primero se sube el papel, después se copia lo que dice— y porque es el que la HU #12094
// necesita para precargar el propietario leyendo la factura sin volver a mover la pantalla.
//
// Tres listas ordenadas tienen que cambiar A LA VEZ o el foco y la frase de faltantes apuntarán al
// orden viejo: `ORDEN_FOCO_BASE`, `ORDEN_FALTANTES` y `primerErrorEnfocable`, todas abajo.
//
// ── PII ─────────────────────────────────────────────────────────────────────────────────────────
//
// VIN, documento, correo, celular, dirección, municipio y departamento viajan SIEMPRE en el cuerpo
// de un `POST`. Desde la HU #12079 la URL de esta pantalla no toca **ninguna** PII: era el uuid
// opaco de `/solicitud/:id` —que AGENTS.md §14 permitía— y esa ruta se retiró con la subsanación,
// así que `/flito/soat/solicitud` ya no lleva parámetros; tras crear, se navega a la cola
// (`/flito/soat`) y no al identificador de la solicitud.
// El VIN **no** entra a ningún `aria-label`, ni al título de los dos modales de bloqueo, ni a la
// query: los selectores de axe arrastran valores de atributo, y una frase con 17 caracteres dentro
// no se lee mejor que «este vehículo».

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Car, CircleCheck, FileText, Loader2, RotateCw, Search, UserRound,
} from 'lucide-react';
import { toastOk } from '../components/flit/ToastFlito';
import {
  CodigoErrorSolicitudSoat, PROCEDENCIA_POR_DEFECTO, ProcedenciaDato, TipoSoat,
  type ExtraccionFacturaVenta, type RespuestaAltaSolicitudSoat, type ResultadoDocumentosAdicionales, type SoatActivoRunt,
} from '@operaciones/shared-types';
import { api } from '../lib/api';
import { puedeSolicitarSoat, useAuth } from '../lib/auth';
import {
  avisoVin, camposLeidos, camposQueViajan, errorArchivo, esCampoComprador, esNit,
  leerFallo, normalizarVin, reaccionA, reaccionALectura,
  DESENLACE_SIN_RED, DESENLACE_GENERICO, MENSAJE_ARCHIVO_NO_PDF,
  type CampoComprador, type CampoLeido, type DesenlaceRunt, type FalloCanal, type PreconsultaRunt,
} from '../lib/soatCliente';
import {
  DESENLACE_GENERICO_RENOVACION, MENSAJE_ELIJA_TIPO, esRenovable, subtituloSolicitud,
} from '../lib/mensajesTipoSoat';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import FlitModal from '../components/flit/FlitModal';
import StatusChip from '../components/flit/StatusChip';
import {
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';
import { ModalIncompletaExistente, ModalVinEnCola } from '../components/flito/soat-cliente/ModalesBloqueo';
import TarjetaSolicitudGuardada from '../components/flito/soat-cliente/TarjetaSolicitudGuardada';
import TarjetaSoatActivo from '../components/flito/soat-cliente/TarjetaSoatActivo';
import {
  AvisoLongitudVin, AyudaVin, BandaDesenlace, EsqueletoFicha, VacioVin,
} from '../components/flito/soat-cliente/PasoVin';
import { TarjetaCanalAjeno, TarjetaCanalDeshabilitado } from '../components/flito/soat-cliente/TarjetaCanal';
import FichaRunt from '../components/flito/soat-cliente/FichaRunt';
import SelectorTipoSoat from '../components/flito/soat-cliente/SelectorTipoSoat';
import ModalidadRenovacion from '../components/flito/soat-cliente/masivo/ModalidadRenovacion';
import BloqueVehiculoRenovacion from '../components/flito/soat-cliente/BloqueVehiculoRenovacion';
import BarraEnvioSolicitud from '../components/flito/soat-cliente/BarraEnvioSolicitud';
import {
  ORDEN_FOCO_BASE, ETIQUETA_CAMPO, chipLectura, faltaParaEnviar, frasePendientes, primerErrorEnfocable,
  sinClave, validador, validarTodo, validarVehiculo, type CampoFormulario, type Errores,
} from '../components/flito/soat-cliente/validacionSolicitud';
import { CampoCompaniaSoat, ITEM_COMPANIA, useCompaniaSoat } from '../components/flito/soat-cliente/CampoCompaniaSoat';
import { BloqueDocumentosAdicionales } from '../components/flito/soat/DocumentosAdicionalesSelector';
import {
  TIMEOUT_ALTA_CON_ADICIONALES_MS, adjuntarAdicionales, textoEnviandoAdicionales, textoToastDescartes, validos,
  type ElegidoAdicional,
} from '../components/flito/soat/documentosAdicionales';
import {
  AvisoLectura, BandaSobrescritura, BloqueFactura, BloquePropietario, Campo,
  ID_CAMPO, ID_CONFIRMAR, PROPIETARIO_VACIO, Seccion, useFocoPrimerError,
  type CampoPropietario, type EstadoLectura, type FilaSobrescritura, type Propietario,
} from '../components/flito/soat-cliente/bloques';

const COLA = '/flito/soat';

/** Id de la banda de desenlace, para que el campo VIN pueda apuntar a ella con `aria-describedby`. */
const ID_BANDA_RUNT = 'sol-desenlace-runt';

const TOAST_ENVIADA = 'Solicitud enviada. Ya está en gestión.';
/** HU #12996 (UX §2.2, literal): la frase de la barra en «modo RUNT caído». */
const FRASE_CAIDO = 'El RUNT no respondió: la solicitud quedará pendiente de validar y se consultará de nuevo antes de enviarla al gestor.';
/** No es una lista de lo que falta: no falta nada, está PROHIBIDO. Por eso no pasa por la plantilla. */
const AVISO_VIGENTE = 'Este vehículo tiene SOAT vigente según el RUNT: no se puede radicar la solicitud.';

/**
 * En qué punto está la consulta al RUNT. **Un solo control con cuatro rótulos**, no un botón de
 * consulta más otro de reintento: el AC3 pide que el Cliente lea «vuelva a consultar», y el rótulo
 * del botón al que apunta esa frase ES esa frase.
 */
type Consulta =
  | { fase: 'inicial' }
  | { fase: 'cargando' }
  | { fase: 'ok'; datos: PreconsultaRunt; consultadoEn: Date }
  /** Un desenlace con banda propia en el bloque 1 (los cuatro del RUNT y la rama por defecto). */
  | { fase: 'fallo'; desenlace: DesenlaceRunt }
  /** Un desenlace que ya explicó un MODAL (VIN en cola): la compuerta sigue cerrada. */
  | { fase: 'sin-banda' }
  /**
   * `409 soat_vigente` (HU #12844): la tarjeta de bloqueo EN LÍNEA sustituye al modal. Es un estado
   * que sigue siendo cierto mientras el VIN no cambie; editarlo lo pasa a `invalidada`.
   */
  | { fase: 'vigente'; soatActivo: SoatActivoRunt; fechaVencimiento?: string }
  /** Se editó el VIN después de consultar: lo del RUNT se retira y hay que repetirla (AC5). */
  | { fase: 'invalidada' };

const ROTULO_CONSULTA: Record<Consulta['fase'], string> = {
  inicial: 'Consultar el RUNT',
  cargando: 'Consultando el RUNT…',
  ok: 'Consultar de nuevo',
  fallo: 'Volver a consultar',
  'sin-banda': 'Volver a consultar',
  vigente: 'Volver a consultar',
  invalidada: 'Volver a consultar',
};

/** Un `409` antiguo sin `soatActivo`: seis «—», nunca datos inventados (AC4). */
const SOAT_SIN_DATOS: SoatActivoRunt = {
  poliza: null, fechaExpedicion: null, inicioVigencia: null, vencimiento: null, aseguradora: null, estado: null,
};

/**
 * El gate de la pantalla. **Por capacidad (`puedeSolicitarSoat`), no por rol**: un
 * `if (role !== 'cliente')` sería la lista negra que el ADR §4 acaba de quitar del router.
 *
 * Lo que sí se ramifica por rol es el TEXTO, y solo el texto: `admin`, `auditor` y `proveedor`
 * tienen el slug `flito_soat`, así que la ruta les abre y merecen una explicación distinta a la del
 * Cliente cuya compañía no tiene el canal. Ninguno de los dos es `NoAccess`: «No tienes acceso a
 * SOAT» sería falso en los dos casos.
 */
export default function FlitoSoatSolicitud() {
  const { user, hasFuncion } = useAuth();
  // HU #12170: copy del vacío por función (crear sin enviar = canal cliente), no por rol.
  const esCanalCliente = hasFuncion('soat.solicitud.crear') && !hasFuncion('soat.solicitud.enviar');

  if (!puedeSolicitarSoat(user)) {
    return (
      <div className="space-y-4">
        <PageHeaderCard title="Solicitud de SOAT" />
        {esCanalCliente
          ? <TarjetaCanalDeshabilitado salida={{ to: COLA, texto: 'Volver a mis SOAT' }} />
          : <TarjetaCanalAjeno />}
      </div>
    );
  }

  // Un solo cuerpo desde la HU #12079: la subsanación se retiró con el estado que la originaba
  // (`rechazada`), y con ella la ruta `/flito/soat/solicitud/:id` de `App.tsx`. Sin borrar la ruta,
  // una dirección guardada en marcadores caería aquí y pintaría un alta EN BLANCO prometiendo una
  // solicitud existente.
  return <Alta />;
}

// ───────────────────────────── El alta ───────────────────────────────────────────────────────────

function Alta() {
  const navigate = useNavigate();
  // HU #12874: a nombre de qué compañía se radica. Con enlace compañía es la suya y no viaja.
  const compania = useCompaniaSoat(useAuth().tipoEnlace === 'compania');
  const tituloRef = useRef<HTMLHeadingElement>(null);
  const vinRef = useRef<HTMLInputElement>(null);
  const placaRef = useRef<HTMLInputElement>(null);
  const docVehiculoRef = useRef<HTMLInputElement>(null);
  const consultarRef = useRef<HTMLButtonElement>(null);

  // HU #14019: el TIPO manda. `null` = sin elegir (AC1): ni bloques, ni barra, ni consulta.
  const [tipo, setTipo] = useState<TipoSoat | null>(null);
  const [errorTipo, setErrorTipo] = useState<string | undefined>();
  const [vin, setVin] = useState('');
  // Renovación (bloque 1): placa y documento del propietario. Viajan en el cuerpo del POST, nunca en la URL.
  const [placa, setPlaca] = useState('');
  const [docVehiculo, setDocVehiculo] = useState('');
  /** «Renovar» de la tarjeta «Ya está en FLITO»: continúa el flujo sin consultar de nuevo. */
  const [renovarOk, setRenovarOk] = useState(false);
  const [propietario, setPropietario] = useState<Propietario>(PROPIETARIO_VACIO);
  const [archivo, setArchivo] = useState<File | null>(null);
  // HU #13363: bloque 4. Sobrevive a un error del alta (AC5): ni el `catch` ni el `finally` lo vacían.
  const [adicionales, setAdicionales] = useState<ElegidoAdicional[]>([]);

  const [consulta, setConsulta] = useState<Consulta>({ fase: 'inicial' });
  const [modal, setModal] = useState<FalloCanal | null>(null);
  const tarjetaVigenteRef = useRef<HTMLHeadingElement>(null);
  const [canalCaido, setCanalCaido] = useState(false);

  /**
   * La lectura de la factura (HU #12094), **con su propio estado y su propio turno**.
   *
   * Nada de esto se mezcla con `Consulta`: son dos peticiones distintas y compartir el contador de
   * turno haría que consultar el RUNT cancelara una lectura sana.
   */
  const [lectura, setLectura] = useState<EstadoLectura>({ fase: 'inicial' });
  /**
   * De dónde salió cada uno de los NUEVE campos del comprador. **Solo se guarda lo que puso la
   * lectura**: una clave ausente es `manual`, que es además el defecto del servidor.
   *
   * `correo` no cabe aquí ni por tipo (`CampoComprador` son nueve, no diez) ni por contrato: el
   * esquema del borde es `.strict()` y declarar su procedencia es un `400`.
   */
  const [procedencia, setProcedencia] = useState<Partial<Record<CampoComprador, ProcedenciaDato>>>({});
  /**
   * Los campos que la lectura dejó **por revisar**: prellenados (`valor !== null`) Y con
   * `confiable: false`.
   *
   * Nunca por `confiable` a secas. Cuando el lector no saca nada devuelve las nueve claves en
   * `{valor: null, confianza: 0, confiable: false}`, y marcarlas pondría nueve avisos ámbar y el
   * envío bloqueado sin nada que confirmar: el AC3 tumbando al AC5. La regla se aplica en un solo
   * sitio —`camposLeidos`, que descarta los sin valor— y aquí ya solo entran campos con valor.
   */
  const [porRevisar, setPorRevisar] = useState<Partial<Record<CampoComprador, boolean>>>({});
  /** Los conflictos de la lectura en curso, esperando decisión (AC6). `null` = no hay banda. */
  const [sobrescritura, setSobrescritura] = useState<
    { filas: FilaSobrescritura[]; leidos: Partial<Record<CampoComprador, CampoLeido>> } | null
  >(null);
  /** Qué filas de la banda están marcadas. Nacen todas en `true` (UX §5). */
  const [marcados, setMarcados] = useState<Partial<Record<CampoComprador, boolean>>>({});

  const [errores, setErrores] = useState<Errores>({});
  const [intento, setIntento] = useState(0);
  const [enviando, setEnviando] = useState(false);
  const [avisoEnvio, setAvisoEnvio] = useState<string | null>(null);
  const [envioIncierto, setEnvioIncierto] = useState(false);
  const [confirmarSalida, setConfirmarSalida] = useState(false);
  /**
   * HU #12996 (AC3/AC8): el alta respondió `202 incompleta`. El VIN que se guardó, para la tarjeta de
   * confirmación que REEMPLAZA al formulario. `null` = el formulario sigue en pantalla.
   */
  const [guardada, setGuardada] = useState<{ vin: string | null; placa?: string; adicionales?: ResultadoDocumentosAdicionales } | null>(null);
  /** Sube con «Solicitar otro SOAT»: el efecto enfoca el VIN cuando el formulario vuelve a montarse. */
  const [reinicios, setReinicios] = useState(0);

  /**
   * Turno de la consulta en vuelo: **la segunda de DOS cerraduras**, y las dos son deliberadas.
   *
   * El daño del que se protege es uno: una respuesta que llega tarde, pinta la ficha de OTRO
   * vehículo sobre el VIN ya cambiado y deja la compuerta abierta — es decir, una solicitud cuyo
   * RUNT no corresponde a lo que se envía.
   *
   *   1. **`readOnly={cargando}` en el campo VIN** (abajo, en el bloque 1). Mientras la consulta
   *      está en vuelo el VIN no se puede teclear, así que **la carrera no es alcanzable por
   *      tecleo**. `readOnly` y no `disabled` a propósito: un control deshabilitado pierde el foco
   *      que tuviera y sale del recorrido de tabulación a media consulta.
   *   2. **Este contador.** Cubre lo que la primera no ve: un cambio de valor que **no viene del
   *      teclado** —autocompletado, una extensión, un `input` sintético, cualquier cosa que dispare
   *      `onChange` sin pasar por la edición del usuario— y, sobre todo, sobrevive a que alguien
   *      retire ese `readOnly`. Es una comprobación de la promesa (`turno.current !== mio` antes de
   *      pintar), no de una rama de render.
   *
   * Ninguna de las dos sustituye a la otra, y por eso conviene decirlo aquí: **no borre `turno`
   * creyendo que el `readOnly` ya basta** —basta para el teclado y solo mientras esa prop siga
   * puesta— **ni quite el `readOnly` creyendo que `turno` lo cubre todo**: `turno` evita el estado
   * corrupto, pero no evita que el Cliente edite un campo cuya consulta ya salió y se quede sin
   * saber que tiene que repetirla. Lo que `turno` protege se mide en
   * `soat-vin-unico-ficha-runt.spec.ts` («la CARRERA»), que fuerza el cambio saltándose el
   * `readOnly` justo para ejercitar esta segunda cerradura.
   *
   * Protege un solo campo desde la HU #12091 y hace la misma falta que cuando protegía cuatro.
   */
  const turno = useRef(0);

  /**
   * Turno de la LECTURA en vuelo, con el mismo criterio que `turno` y **un contador propio**.
   *
   * El daño del que protege: se adjunta la factura A, se cambia a la B con la lectura de A todavía
   * en vuelo, y la respuesta tardía de A escribe en el formulario los datos del comprador de OTRA
   * factura. Aquí no hay `readOnly` que ayude —la caja de subida acepta un archivo nuevo en cualquier
   * momento, y bloquearla mientras se lee convertiría la ayuda en un peaje (AC1)—, así que esta es la
   * ÚNICA cerradura de esta carrera. No se reusa `turno`: consultar el RUNT no puede cancelar una
   * lectura sana.
   */
  const turnoLectura = useRef(0);

  /**
   * Espejos de lo que hay escrito AHORA, para la respuesta de la lectura.
   *
   * Entre adjuntar la factura y recibir la extracción pasa hasta un minuto, y el AC1 deja el
   * formulario tecleable durante todo ese rato. La `propietario` que capturó el closure de
   * `leerFactura` es la de ANTES de escribir: decidir con ella qué se sobrescribe pisaría en silencio
   * justo lo que el AC6 protege. Los refs se sincronizan en un efecto, así que van siempre por
   * delante del siguiente evento del usuario.
   */
  const propietarioRef = useRef(propietario);
  const procedenciaRef = useRef(procedencia);
  useEffect(() => { propietarioRef.current = propietario; }, [propietario]);
  useEffect(() => { procedenciaRef.current = procedencia; }, [procedencia]);

  // Tras guardar, el registro ya existe: salir no descarta nada y no pide confirmación (UX §2.3).
  const hayDatos = !guardada && Boolean(vin || placa || docVehiculo || archivo || adicionales.length || Object.values(propietario).some(Boolean));
  const t = tipo ?? TipoSoat.INICIAL;
  const vehiculo = { vin, placa, documentoVehiculo: docVehiculo };
  const renovacion = tipo === TipoSoat.RENOVACION;
  // «Ya está en FLITO» (renovación): la tarjeta ocupa el sitio de la ficha hasta «Renovar»; fuera de ventana no hay salida.
  const flitoCtx = renovacion && consulta.fase === 'ok' ? consulta.datos.flito : undefined;
  const bloqueoFlito = Boolean(flitoCtx?.yaEnFlito) && !renovarOk;
  /**
   * **La compuerta del RUNT, y solo eso.** Hasta la HU #12079 esto se llamaba `puedeEnviar` y
   * decidía DOS cosas: el aspecto del botón y a dónde va el foco al pulsarlo. Redefinirlo para que
   * incluyera los campos que faltan habría mandado el foco al botón «Consultar el RUNT» —un control
   * que no tiene nada de malo— cuando lo que falta es el correo. Por eso son dos nombres: este
   * enruta el foco, `faltantes` decide el aspecto.
   */
  /**
   * HU #12996 (AC6/AC7): **solo** el `503 runt_no_disponible` de la consulta abre la salida de
   * guardar pendiente de validar (`desenlace.guardable`). Editar el VIN pasa la consulta a
   * `invalidada` y la cierra hasta volver a consultar: el 503 era de OTRO VIN.
   */
  const modoCaido = consulta.fase === 'fallo' && consulta.desenlace.guardable === true;
  const compuertaAbierta = (consulta.fase === 'ok' && !bloqueoFlito) || modoCaido;

  useEffect(() => { tituloRef.current?.focus(); }, []);
  // Solo hay un campo de entrada montado (VIN o placa): el que exista recibe el foco.
  useEffect(() => { if (reinicios > 0) (placaRef.current ?? vinRef.current)?.focus(); }, [reinicios]);

  // Foco tras un desenlace con banda: al campo VIN cuando hay algo suyo que corregir —el VIN que no
  // cuadra, el que el RUNT no tiene registrado— y al botón de consulta cuando no lo hay (el servicio
  // caído, el registro sin chasis, un código desconocido). Lo decide `desenlace.foco`, no esta
  // pantalla. Se dispara con cada `setConsulta` nuevo, que es lo que permite que dos desenlaces
  // iguales seguidos vuelvan a llevar el foco.
  useEffect(() => {
    // Bloqueo (HU #12844): el foco va al `h3` de la tarjeta, que anuncia la variante; el lector
    // recorre después la frase y los seis pares en orden. Vale también si el 409 llega al ENVIAR.
    if (consulta.fase === 'vigente') { tarjetaVigenteRef.current?.focus(); return; }
    if (consulta.fase !== 'fallo') return;
    const foco = consulta.desenlace.foco;
    if (foco === 'vin') vinRef.current?.focus();
    else if (foco === 'placa') placaRef.current?.focus();
    else if (foco === 'documento') docVehiculoRef.current?.focus();
    else consultarRef.current?.focus();
  }, [consulta]);

  /**
   * **Se retira todo lo que trajo el RUNT; no se borra nada de lo que tecleó el Cliente** (AC5).
   *
   * Un formulario que conserva la ficha de otro vehículo deja radicar una solicitud con los datos
   * técnicos de un carro y la placa de otro. Y al revés: borrar el propietario y la factura porque
   * se corrigió una letra del VIN castiga al usuario por el error que acaba de arreglar.
   */
  const invalidarConsulta = () => {
    turno.current += 1;
    setRenovarOk(false);
    setConsulta((c) => (c.fase === 'inicial' ? c : { fase: 'invalidada' }));
  };

  /**
   * **El VIN es el único dato que invalida la consulta**, porque es el único que la alimenta
   * (HU #12090). Hasta la #12091 lo hacían también el tipo y el número de documento, que iban en el
   * cuerpo de la preconsulta; ahora pasan por `cambiarPropietario` como cualquier otro campo del
   * bloque 3. Tumbar la ficha por corregir una tilde del documento haría repetir una consulta que
   * no depende de él, y el Cliente no entendería por qué.
   */
  const cambiarVin = (v: string) => {
    setVin(normalizarVin(v));
    setErrores((e) => ({ ...e, vin: undefined }));
    invalidarConsulta();
  };

  const cambiarPlaca = (v: string) => {
    setPlaca(v);
    setErrores((e) => ({ ...e, placa: undefined }));
    invalidarConsulta();
  };

  /** El número del bloque 1 prellena SOLO el número del bloque 3 (editable): nunca pisa lo que la factura o la persona pusieron. */
  const cambiarDocVehiculo = (v: string) => {
    const previo = docVehiculo;
    setDocVehiculo(v);
    setErrores((e) => ({ ...e, documentoVehiculo: undefined }));
    setPropietario((p) => ((p.numeroDocumento === '' || p.numeroDocumento === previo)
      && procedenciaRef.current.numeroDocumento !== ProcedenciaDato.FACTURA ? { ...p, numeroDocumento: v } : p));
    invalidarConsulta();
  };

  const cambiarPropietario = (campo: CampoPropietario, v: string) => {
    setPropietario((p) => ({ ...p, [campo]: v }));
    setErrores((e) => ({ ...e, [campo]: undefined }));
    // **Corregir ES revisar** (AC3, UX §4.2): editar un campo leído lo saca de la cola de pendientes
    // y lo pasa a `manual` (AC7). Obligar a corregir y además confirmar sería cobrar dos veces por el
    // mismo trabajo, y dejarlo como `'factura'` afirmaría ante Operaciones que ese valor lo puso el
    // concesionario cuando lo acaba de teclear una persona.
    if (esCampoComprador(campo)) {
      setProcedencia((m) => (m[campo] === undefined ? m : sinClave(m, campo)));
      setPorRevisar((m) => (m[campo] === undefined ? m : sinClave(m, campo)));
    }
    // El tipo de documento conmuta los campos de nombre, y los errores de los tres se descartan
    // aquí: `useFocoPrimerError` enfoca por `id`, y un error de «Apellido/s» con NIT elegido
    // mandaría el foco a un id que ya no está en el DOM — es decir, a `<body>`.
    if (campo === 'tipoDocumento') {
      setErrores((e) => ({ ...e, nombres: undefined, apellidos: undefined, razonSocial: undefined }));
    }
  };

  // ── La lectura de la factura (AC1, AC5, AC6, AC7) ────────────────────────────────────────────

  /**
   * Escribe en el formulario lo que la lectura trajo para esos campos, **sin pasar por
   * `cambiarPropietario`**: eso los marcaría `manual` y perdería justo la afirmación del AC7.
   *
   * Y limpia su error: un campo que estaba vacío pudo haberse marcado en rojo al salir de él.
   */
  const escribirLeidos = (
    campos: CampoComprador[], leidos: Partial<Record<CampoComprador, CampoLeido>>,
  ) => {
    if (campos.length === 0) return;
    setPropietario((p) => {
      const n = { ...p };
      for (const c of campos) n[c] = leidos[c]!.valor;
      return n;
    });
    setProcedencia((m) => {
      const n = { ...m };
      for (const c of campos) n[c] = ProcedenciaDato.FACTURA;
      return n;
    });
    setPorRevisar((m) => {
      const n = { ...m };
      // Una lectura confiable RETIRA la marca anterior: el valor de ahora es otro, y arrastrar el
      // pendiente de la lectura vieja bloquearía el envío por un dato que ya nadie discute.
      for (const c of campos) { if (leidos[c]!.confiable) delete n[c]; else n[c] = true; }
      return n;
    });
    setErrores((e) => {
      const n = { ...e };
      for (const c of campos) delete n[c];
      return n;
    });
  };

  /**
   * Reparte lo leído entre lo que se escribe directo y lo que va a la banda (UX §5, las cinco reglas).
   *
   *   1. Campo VACÍO + valor leído → se escribe directo. No se pierde nada de nadie.
   *   2. Campo con valor que puso LA PERSONA y que difiere → a la banda. Es lo único que el AC6
   *      protege.
   *   3. Campo que venía de una lectura ANTERIOR → se reemplaza directo: no hay trabajo humano que
   *      defender, y preguntar por él enterraría en ruido las filas del punto 2.
   *   4. Valor leído IGUAL al que ya está → no es conflicto y la procedencia **no cambia**: si lo
   *      tecleó él, sigue siendo `manual`.
   *   5. Valor leído NULO → nunca borra lo que hay (`camposLeidos` ni siquiera lo devuelve).
   *
   * La banda se abre también en la PRIMERA lectura si ya había datos tecleados. El AC6 habla de
   * volver a leer, pero su principio es no perder lo corregido, y el orden en que el Cliente hace las
   * cosas no lo decide esta pantalla: quien escribe el propietario y adjunta después merece el mismo
   * aviso que quien cambia la factura.
   */
  const repartirLectura = (leidos: Partial<Record<CampoComprador, CampoLeido>>) => {
    const claves = Object.keys(leidos) as CampoComprador[];
    if (claves.length === 0) { setLectura({ fase: 'vacia' }); return; }

    const actual = propietarioRef.current;
    const origen = procedenciaRef.current;
    const directos: CampoComprador[] = [];
    const conflictos: CampoComprador[] = [];
    for (const campo of claves) {
      const escrito = actual[campo].trim();
      const deLaPersona = escrito !== '' && origen[campo] !== ProcedenciaDato.FACTURA;
      if (!deLaPersona) directos.push(campo);
      else if (escrito !== leidos[campo]!.valor.trim()) conflictos.push(campo);
    }

    // Qué campos VIAJAN se decide con el tipo de documento que queda tras escribir lo directo
    // (RN-B5). Lo que no viaja se escribe igual en el estado —volver a la otra forma devuelve lo que
    // había, como en la conmutación CC ⇄ NIT— pero ni se cuenta, ni se marca, ni entra a la banda.
    const tipo = directos.includes('tipoDocumento')
      ? leidos.tipoDocumento!.valor
      : actual.tipoDocumento;
    const viajan = camposQueViajan(tipo);

    escribirLeidos(directos, leidos);
    setLectura({ fase: 'ok', escritos: directos.filter((c) => viajan.includes(c)).length });

    const filas = conflictos.filter((c) => viajan.includes(c)).map((campo) => ({
      campo, etiqueta: ETIQUETA_CAMPO[campo], actual: actual[campo], leido: leidos[campo]!.valor,
    }));
    if (filas.length > 0) {
      setSobrescritura({ filas, leidos });
      setMarcados(Object.fromEntries(filas.map((f) => [f.campo, true])));
    }
  };

  /**
   * **Arranca sola al adjuntar** (AC1) y no deshabilita nada mientras dura: la lectura es una ayuda,
   * y bloquear el formulario mientras piensa la convertiría en un peaje (AC5).
   *
   * El campo del multipart es `facturaVenta`, el mismo del alta. `solicitudId` **no se manda**: en el
   * alta no hay solicitud todavía, y el borde lo declara opcional justo para esto.
   */
  const leerFactura = async (f: File, companiaId = compania.companiaId) => {
    turnoLectura.current += 1;
    const mio = turnoLectura.current;
    setSobrescritura(null);
    setLectura({ fase: 'leyendo' });
    try {
      const form = new FormData();
      form.append('facturaVenta', f);
      if (companiaId) form.append('companiaId', String(companiaId));
      // La respuesta va ENVUELTA en `{ extraccion }`, no plana.
      const { extraccion } = await api.post<{ extraccion: ExtraccionFacturaVenta }>(
        '/flito/soat/cliente/factura/lectura', form,
      );
      if (turnoLectura.current !== mio) return;
      repartirLectura(camposLeidos(extraccion ?? {}));
    } catch (e) {
      if (turnoLectura.current !== mio) return;
      const r = reaccionALectura(leerFallo(e), compania.escoge);
      if (r.tipo === 'compania') { setLectura({ fase: 'inicial' }); encajarCompania(r); return; }
      if (r.tipo === 'archivo') {
        // El PDF que no lo es se caza al ADJUNTAR y su superficie es la caja de subida, no una banda
        // de lectura: si el archivo no vale, no hay adjunto **ni** lectura que reintentar. Antes esto
        // solo se sabía al enviar, después de haber subido el PDF entero una segunda vez.
        setArchivo(null);
        setErrores((er) => ({ ...er, archivo: MENSAJE_ARCHIVO_NO_PDF }));
        setLectura({ fase: 'inicial' });
        return;
      }
      setLectura({ fase: 'fallo', desenlace: r.desenlace });
    }
  };

  /** Adjuntar dispara la lectura; un archivo que ni siquiera es PDF por su nombre no gasta subida. */
  const elegirArchivo = (f: File) => {
    const err = errorArchivo(f);
    setErrores((e) => ({ ...e, archivo: err ?? undefined }));
    setArchivo(err ? null : f);
    // HU #12874: sin compañía el servidor no lee (400). Se pide la compañía y la lectura arranca al escogerla.
    if (!err && compania.faltante) compania.pedir();
    else if (!err) void leerFactura(f);
  };

  /**
   * HU #12874: la compañía alimenta la consulta (RN-01 y tenencia son por compañía), así que cambiarla
   * retira lo del RUNT como el VIN — pero a `inicial` y no a `invalidada`, cuyo aviso dice «Cambió el VIN».
   */
  const cambiarCompania = (v: string) => {
    compania.cambiar(v);
    turno.current += 1;
    setConsulta({ fase: 'inicial' });
    if (v && archivo && lectura.fase === 'inicial') void leerFactura(archivo, Number(v));
  };
  const encajarCompania = (r: { mensaje: string; recargar: boolean }) => {
    compania.pedir(r.mensaje);
    if (r.recargar) compania.recargar();
  };

  /**
   * Quitar el archivo **no borra nada de lo que hay escrito**: se descarta la lectura en vuelo, cae
   * el chip y desaparece la banda. Es el mismo criterio con el que la #12091 conserva el propietario
   * al invalidar la consulta del RUNT.
   */
  const quitarArchivo = () => {
    turnoLectura.current += 1;
    setArchivo(null);
    setErrores((e) => ({ ...e, archivo: undefined }));
    setLectura({ fase: 'inicial' });
    setSobrescritura(null);
  };

  /** Confirmar **no cambia la procedencia**: lo leído y no tocado sigue siendo `'factura'` (AC7). */
  const confirmarRevision = (campo: CampoComprador) => {
    setPorRevisar((m) => (m[campo] === undefined ? m : sinClave(m, campo)));
  };

  const reemplazarMarcados = () => {
    if (!sobrescritura) return;
    const aceptados = sobrescritura.filas.map((f) => f.campo).filter((c) => marcados[c]);
    const viajan = camposQueViajan(propietarioRef.current.tipoDocumento);
    escribirLeidos(aceptados, sobrescritura.leidos);
    // Lo NO aceptado conserva valor **y** procedencia `'manual'` (AC6, literal) — y también su estado
    // de revisado: un campo que el usuario defendió no vuelve a la cola de pendientes.
    setSobrescritura(null);
    setLectura((l) => (l.fase === 'ok'
      ? { fase: 'ok', escritos: l.escritos + aceptados.filter((c) => viajan.includes(c)).length }
      : l));
  };

  const validarCampo = (campo: CampoFormulario, valor: string) => {
    const msg = validador(campo, propietario.tipoDocumento)?.(valor) ?? null;
    setErrores((e) => ({ ...e, [campo]: msg ?? undefined }));
  };

  /**
   * Un mismo error del canal, repartido por CÓDIGO, y en el sitio que le toca a cada uno.
   *
   * `origen` no cambia la clasificación —los dos endpoints devuelven lo mismo ante el mismo RUNT—,
   * solo dónde se pinta lo que no es del RUNT: en la consulta no hay tarjeta de envío que usar.
   */
  const encajarFallo = (f: FalloCanal, origen: 'consulta' | 'envio') => {
    const r = reaccionA(f, compania.escoge, tipo);
    switch (r.tipo) {
      case 'compania':
        if (origen === 'consulta') setConsulta({ fase: 'inicial' });
        encajarCompania(r);
        return;
      case 'canal':
        setCanalCaido(true);
        return;
      case 'vin-en-cola':
      case 'incompleta-existente':
        // RN-01 corre ANTES del RUNT cuando hay VIN tecleado, así que este 409 puede llegar también
        // en la consulta. Llegue por donde llegue, la compuerta sigue cerrada.
        setModal(f);
        setConsulta({ fase: 'sin-banda' });
        return;
      case 'soat-vigente':
        setAvisoEnvio(null);
        setConsulta({ fase: 'vigente', soatActivo: f.soatActivo ?? SOAT_SIN_DATOS, fechaVencimiento: f.fechaVencimiento });
        return;
      case 'archivo':
        // Desde la HU #12094 este 400 se caza casi siempre al ADJUNTAR —la lectura sube el mismo PDF
        // y olfatea los mismos bytes—, así que llegar aquí es el caso raro: un archivo que pasó la
        // lectura y no pasa el alta. El mensaje es el mismo y sale de la misma constante.
        setErrores((e) => ({ ...e, archivo: MENSAJE_ARCHIVO_NO_PDF }));
        setIntento((n) => n + 1);
        return;
      case 'runt':
        // **También cuando llega en el ENVÍO.** Entre la consulta y el envío pasa tiempo: el RUNT
        // puede caerse o el vehículo puede aparecer con SOAT vigente, y como el alta vuelve a
        // consultar en el servidor, un 422/409/503 en el `POST` significa que el «✓ Consultado» de
        // la pantalla ya no es verdad. Dejarlo puesto haría resubir el PDF de 15 MB a ciegas.
        setAvisoEnvio(null);
        setConsulta({ fase: 'fallo', desenlace: r.desenlace });
        return;
      case 'incierto':
        // En la consulta no se creó nada, así que reintentar es seguro y se dice así. En el envío no
        // se puede afirmar lo mismo: puede haber llegado.
        if (origen === 'consulta') setConsulta({ fase: 'fallo', desenlace: DESENLACE_SIN_RED });
        else setEnvioIncierto(true);
        return;
      case 'otro':
        // En la CONSULTA se pinta copy propio y **no** el `mensaje` del servidor (UX, decisión 6):
        // el API tutea y una API desfasada nombra campos que esta pantalla ya no tiene. En el ENVÍO
        // sí se conserva: ahí el mensaje es lo único que distingue un fallo desconocido de otro, y
        // la superficie es una tarjeta de aviso, no la banda del bloque 1.
        if (origen === 'consulta') setConsulta({ fase: 'fallo', desenlace: renovacion ? DESENLACE_GENERICO_RENOVACION : DESENLACE_GENERICO });
        // Renovación (HU #14019, AC8): nunca el texto crudo del API; el de Inicial conserva el suyo.
        else setAvisoEnvio(renovacion ? 'No pudimos enviar la solicitud. Revise los datos e inténtelo de nuevo en unos minutos.' : r.mensaje);
    }
  };

  // ── La consulta (AC1, AC4, AC5) ──────────────────────────────────────────────────────────────
  //
  // **El VIN se valida ANTES de pedir nada**, y esa es la mitad que importa: el borde exige un VIN
  // de 11 a 17 caracteres ya normalizado (HU #12090) y contesta con un `400 Datos inválidos` de
  // esquema, que no trae `codigo` del canal y sale por la rama por defecto. El Cliente leería «no
  // pudimos consultar el RUNT» cuando lo que pasa es que le faltan caracteres al VIN.
  const consultar = async () => {
    if (!tipo) { setErrorTipo(MENSAJE_ELIJA_TIPO); return; }
    if (compania.faltante) { compania.pedir(); return; }
    const errs = validarVehiculo(tipo, vehiculo);
    setErrores((e) => ({ ...e, vin: errs.vin, placa: errs.placa, documentoVehiculo: errs.documentoVehiculo }));
    setIntento((n) => n + 1);
    if (Object.keys(errs).length > 0) return;

    turno.current += 1;
    const mio = turno.current;
    setConsulta({ fase: 'cargando' });
    try {
      // **El cuerpo es `{ vin }` y nada más** (HU #12090, AC1): la modalidad de VIN del RUNT no pide
      // documento del propietario, y mandarlo sería entregar un dato personal sin destino. `vin` ya
      // está normalizado en el estado, con la misma función que aplica el borde.
      // Renovación: `{ tipo, placa, numeroDocumento }` y sin VIN (HU #14019, AC2); sin `tipo` = inicial.
      const dedo = renovacion ? { tipo: 'renovacion', placa, numeroDocumento: docVehiculo.trim() } : { vin };
      const datos = await api.post<PreconsultaRunt>('/flito/soat/cliente/preconsulta', { ...dedo, ...(compania.companiaId ? { companiaId: compania.companiaId } : {}) });
      if (turno.current !== mio) return;
      setConsulta({ fase: 'ok', datos, consultadoEn: new Date() });
    } catch (e) {
      if (turno.current !== mio) return;
      encajarFallo(leerFallo(e), 'consulta');
    }
  };

  // ── Envío (AC1: crear ES enviar, sin borrador, y solo con el RUNT resuelto) ───────────────────
  const enviar = async () => {
    const errs = validarTodo(t, vehiculo, propietario, archivo);
    setErrores(errs);
    setIntento((n) => n + 1);
    if (Object.keys(errs).length > 0) {
      setAvisoEnvio('Revise los datos marcados antes de enviar.');
      return;
    }
    // Con los campos válidos pero revisiones pendientes, el primario **no envía** y lleva al primer
    // pendiente en el orden visual (AC3, UX §4.3). Con errores y revisiones a la vez mandan los
    // errores: un campo con valor inválido no se puede dar por revisado.
    if (pendientesRevision.length > 0) {
      const primero = pendientesRevision[0];
      // El tipo de documento no tiene id propio —`FlitSelect` lo genera con `useId()`—, así que su
      // foco va al botón «Confirmar», que es el control que resuelve el pendiente.
      const id = ID_CAMPO[primero as keyof typeof ID_CAMPO] ?? ID_CONFIRMAR[primero];
      document.getElementById(id)?.focus();
      return;
    }
    setAvisoEnvio(null);
    setEnviando(true);
    try {
      const juridica = esNit(propietario.tipoDocumento);
      const form = new FormData();
      // Inicial: sin `placa` (la del alta es la que devuelve el RUNT, HU #12090) y el VIN va SIEMPRE.
      // Renovación (HU #14019): `tipo` + `placa`, sin VIN, y la factura es opcional.
      if (renovacion) { form.append('tipo', 'renovacion'); form.append('placa', placa); } else form.append('vin', vin);
      if (compania.companiaId) form.append('companiaId', String(compania.companiaId));
      form.append('tipoDocumento', propietario.tipoDocumento);
      form.append('numeroDocumento', propietario.numeroDocumento.trim());
      // Razón social XOR nombre/s + apellido/s: el esquema PROHÍBE los que no tocan, y el CHECK de
      // la base también. Lo que el Cliente escribió en la otra forma sigue en el estado, pero no
      // viaja.
      if (juridica) form.append('razonSocial', propietario.razonSocial.trim());
      else {
        form.append('nombres', propietario.nombres.trim());
        form.append('apellidos', propietario.apellidos.trim());
      }
      form.append('correo', propietario.correo.trim());
      form.append('celular', propietario.celular.trim());
      form.append('direccion', propietario.direccion.trim());
      form.append('municipio', propietario.municipio.trim());
      form.append('departamento', propietario.departamento.trim());
      if (archivo) form.append('facturaVenta', archivo);
      const conAdicionales = adjuntarAdicionales(form, adicionales) > 0;
      /**
       * De dónde salió cada dato del comprador (AC7), **como cadena JSON dentro del multipart**.
       *
       * Se declaran solo las claves de los campos que VIAJAN: declarar `'factura'` sobre un campo que
       * no se envía afirma el origen de un dato que no existe, y una clave de más es un `400` del
       * `.strict()`. `'runt'` no se emite nunca: ningún campo del propietario se prellena desde el
       * registro —lo único que devuelve es `nombreCompleto`, y la #12091 lo fija como REFERENCIA—.
       * `correo` no está y no puede estar: no es uno de los nueve.
       */
      const mapa: Partial<Record<CampoComprador, ProcedenciaDato>> = {};
      for (const campo of camposQueViajan(propietario.tipoDocumento)) {
        mapa[campo] = procedencia[campo] === ProcedenciaDato.FACTURA
          ? ProcedenciaDato.FACTURA
          : PROCEDENCIA_POR_DEFECTO;
      }
      form.append('procedencia', JSON.stringify(mapa));
      // `nombreCompleto` ya no viaja (lo deriva el servidor) y marca, línea, modelo, clase,
      // cilindraje, carrocería y organismo NO viajan nunca: los resuelve el servidor consultando
      // otra vez. La pantalla no le reenvía lo que él mismo le mostró en la preconsulta.
      // Con adicionales (hasta 250 MB) el corte de 90 s no alcanza: solo ESTA llamada pide más.
      const resp = conAdicionales
        ? await api.postConTimeout<RespuestaAltaSolicitudSoat | undefined>('/flito/soat/cliente', form, TIMEOUT_ALTA_CON_ADICIONALES_MS)
        : await api.post<RespuestaAltaSolicitudSoat | undefined>('/flito/soat/cliente', form);
      // HU #12996: el `202 incompleta` NO es un éxito de envío. Su `id` no es un SOAT (el detalle
      // daría 404), así que no se navega ni se tuesta: la tarjeta de confirmación reemplaza al
      // formulario (AC8). Vale también si la consulta salió OK y el RUNT cayó al enviar (AC3). Una
      // API anterior sin `desenlace` sigue por el flujo de siempre.
      if (resp?.desenlace === 'incompleta') {
        setGuardada({ vin: renovacion ? null : vin, placa: renovacion ? placa : undefined, adicionales: resp.documentosAdicionales });
        return;
      }
      // Cerrable (HU #12819): `toast.success` no se podía cerrar.
      // HU #13363 (AC4): con descartes, UN toast que sustituye al de éxito.
      const descartes = resp?.documentosAdicionales?.descartados ?? [];
      if (descartes.length) toastOk(textoToastDescartes(descartes), { duracionMs: 10_000 });
      else toastOk(TOAST_ENVIADA);
      navigate(COLA);
    } catch (e) {
      encajarFallo(leerFallo(e), 'envio');
    } finally {
      setEnviando(false);
    }
  };

  /**
   * El primario con la compuerta cerrada **no envía nada y lleva a la acción que sí toca**.
   *
   * Es lo que hace que `aria-disabled` cumpla el AC1 igual que un `disabled`, sin sacar el botón del
   * recorrido de tabulación.
   */
  const intentarEnviar = () => {
    if (compania.faltante) { compania.pedir(); return; }
    if (!compuertaAbierta) { consultarRef.current?.focus(); return; }
    // Con la compuerta abierta se llama a `enviar()` **aunque falten campos**: su primera mitad ya
    // hace `validarTodo` → `setErrores` → `setIntento + 1`, y `useFocoPrimerError` lleva el foco al
    // primer campo inválido. Es lo que hace que pulsar el botón bloqueado siga llevando a la acción
    // que toca, y que esa acción sea la correcta de las dos.
    void enviar();
  };

  /**
   * «Consultar otro vehículo» de la tarjeta de bloqueo: limpia **el VIN, y solo el VIN**, y deja el
   * foco en el campo (HU #12844, AC1).
   *
   * Es el único identificador que queda (HU #12091). El propietario —documento incluido, que hasta
   * ahora se borraba con él— y el archivo se CONSERVAN: no dependen de qué vehículo se consulte, y
   * quien va a pedir el SOAT de otro carro de su flota suele ser el mismo titular.
   */
  const consultarOtroVehiculo = () => {
    setVin('');
    setPlaca('');
    setDocVehiculo('');
    setRenovarOk(false);
    setErrores((e) => ({ ...e, vin: undefined, placa: undefined, documentoVehiculo: undefined }));
    turno.current += 1;
    setConsulta({ fase: 'inicial' });
    (placaRef.current ?? vinRef.current)?.focus();
  };

  const salir = () => (hayDatos ? setConfirmarSalida(true) : navigate(COLA));

  /**
   * «Solicitar otro SOAT» de la tarjeta de confirmación: es OTRA solicitud, así que se limpia el
   * formulario entero —a diferencia de «Consultar otro vehículo»— y el foco va al VIN (AC8).
   */
  const limpiarTodo = () => {
    turno.current += 1;
    turnoLectura.current += 1;
    setVin('');
    setPlaca('');
    setDocVehiculo('');
    setRenovarOk(false);
    setPropietario(PROPIETARIO_VACIO);
    setArchivo(null);
    setAdicionales([]);
    setConsulta({ fase: 'inicial' });
    setLectura({ fase: 'inicial' });
    setProcedencia({});
    setPorRevisar({});
    setSobrescritura(null);
    setErrores({});
    setAvisoEnvio(null);
    setErrorTipo(undefined);
  };
  const solicitarOtro = () => {
    limpiarTodo();
    setGuardada(null);
    setReinicios((n) => n + 1);
  };

  /**
   * Cambiar de tipo limpia todo lo dependiente (AC6): consulta, factura, propietario. La confirmación,
   * si había datos, la pide el selector; aquí ya está decidido. «Renovar» del 409 llega por
   * `renovarDesdeModal`, que no pregunta y deja el foco en «Placa».
   */
  const cambiarTipo = (nuevo: TipoSoat) => { limpiarTodo(); setModal(null); setTipo(nuevo); };
  const renovarDesdeModal = () => { cambiarTipo(TipoSoat.RENOVACION); setReinicios((n) => n + 1); };
  const continuarRenovacion = () => { setRenovarOk(true); requestAnimationFrame(() => consultarRef.current?.focus()); };

  /**
   * Lo que falta para poder enviar, **derivado de `validarTodo`** — la misma función que bloquea el
   * envío— y nunca de un chequeo de vacíos paralelo.
   *
   * No es purismo: `hola@` no está vacío y sigue siendo inválido. Con dos fuentes de verdad el
   * botón se vería activo, la pulsación no enviaría nada y el Cliente no sabría por qué.
   *
   * Se recalcula con cada tecla, y eso es barato: son trece expresiones regulares sobre cadenas
   * cortas. Lo que NO hace es PINTAR: `errores` se sigue poblando en `blur` y al enviar, así que el
   * formulario no se pone rojo mientras se teclea.
   */
  /**
   * Los campos por revisar que de verdad cuentan: los marcados **que además viajan** con el tipo de
   * documento vigente, en el ORDEN VISUAL.
   *
   * Es una sola fuente para las tres cosas que el AC3 pide —cuántos dice la frase, si el envío se
   * bloquea y a cuál va el foco—; un contador aparte se desincroniza en el primer caso raro y deja
   * la frase diciendo «revisar 2» con el botón ya activo. El filtro por `camposQueViajan` no es
   * cosmético: un `nombres` pendiente bajo un NIT no se pinta en ninguna parte, y sin filtrarlo
   * bloquearía el envío sin nada que confirmar en pantalla.
   */
  const pendientesRevision = useMemo(() => {
    const viajan = camposQueViajan(propietario.tipoDocumento);
    return ORDEN_FOCO_BASE.filter((c): c is CampoComprador =>
      esCampoComprador(c) && viajan.includes(c) && porRevisar[c] === true);
  }, [propietario.tipoDocumento, porRevisar]);

  const faltantes = useMemo(
    // En modo RUNT caído la consulta ya no es un pendiente: lo que falta son los datos (UX §2.2).
    () => [
      ...(compania.faltante ? [ITEM_COMPANIA] : []),
      ...faltaParaEnviar(t, modoCaido ? 'ok' : consulta.fase, { vin, placa, documentoVehiculo: docVehiculo }, propietario, archivo, pendientesRevision.length),
    ],
    [compania.faltante, modoCaido, consulta.fase, t, vin, placa, docVehiculo, propietario, archivo, pendientesRevision.length],
  );
  const fraseFaltantes = consulta.fase === 'vigente'
    ? AVISO_VIGENTE
    : frasePendientes(faltantes) ?? (modoCaido ? FRASE_CAIDO : null);

  const idPrimerError = useMemo(() => primerErrorEnfocable(t, errores), [t, errores]);
  useFocoPrimerError(idPrimerError, intento);

  if (canalCaido) {
    return (
      <div className="space-y-4">
        <PageHeaderCard title="Solicitud de SOAT" />
        <TarjetaCanalDeshabilitado avisoCarrera salida={{ to: COLA, texto: 'Volver a mis SOAT' }} />
      </div>
    );
  }

  const cargando = consulta.fase === 'cargando';
  // Lo que decide el ASPECTO del botón. `aria-disabled` y no `disabled`: es la decisión de
  // accesibilidad que esta pantalla ya tomó y que la HU #12079 conserva.
  const bloqueado = faltantes.length > 0;
  const avisoLongitudVin = avisoVin(vin);
  // HU #12213/#12844. **Solo se lee lo que el servidor mandó**: sin umbral local. `null` —o la clave
  // ausente, si la API va por detrás del bundle— no pinta tarjeta (AC5).
  const vigencia = consulta.fase === 'ok' ? consulta.datos.vigenciaProxima ?? null : null;
  // «Volver a consultar» baja a secundaria también cuando, con el RUNT caído, el formulario ya está
  // completo: la primaria pasa a «Guardar pendiente de validar» (UX §1, un solo relevo).
  const consultaResuelta = consulta.fase === 'ok' || consulta.fase === 'vigente' || (modoCaido && !bloqueado);
  const IconoConsulta = cargando ? Loader2 : consulta.fase === 'inicial' ? Search : RotateCw;

  const mostrarFormulario = tipo !== null && !bloqueoFlito;
  const botonConsultar = (
    <button
      type="button" ref={consultarRef}
      className={`${consultaResuelta ? flitBtnSecondary : flitBtnPrimary} w-full justify-center sm:w-auto`}
      style={consultaResuelta ? flitBtnSecondaryStyle : flitBtnPrimaryStyle}
      disabled={cargando}
      onClick={() => { void consultar(); }}
    >
      <IconoConsulta size={16} aria-hidden="true" className={`shrink-0 ${cargando ? 'animate-spin motion-reduce:animate-none' : ''}`} />
      {ROTULO_CONSULTA[consulta.fase]}
    </button>
  );
  const focoEn = consulta.fase === 'fallo' ? consulta.desenlace.foco : null;

  return (
    <div className="space-y-4">
      <div>
        <button type="button" onClick={salir}
          className="flit-focus -mx-1 mb-2 inline-flex items-center gap-1.5 rounded px-1 text-sm font-semibold underline transition-colors hover:bg-[var(--flit-bg-hover)]"
          style={{ color: 'var(--flit-blue-text)' }}>
          <ArrowLeft size={16} aria-hidden="true" className="shrink-0" />
          Volver a mis SOAT
        </button>
        <PageHeaderCard
          titleRef={tituloRef}
          title="Solicitud de SOAT"
          // Una frase (HU #12819): «entra en gestión» vive solo en la barra de envío. Cambia con el tipo (#14019).
          subtitle={subtituloSolicitud(tipo)}
        />
      </div>

      {guardada ? (
        <TarjetaSolicitudGuardada vin={guardada.vin} placa={guardada.placa} adicionales={guardada.adicionales} onIrACola={() => navigate(COLA, { state: { pastilla: 'incompleta' } })} onSolicitarOtro={solicitarOtro} />
      ) : (
      <>
      <CampoCompaniaSoat compania={compania} onCambio={cambiarCompania} />
      {/* ── Tipo de SOAT (HU #14019): sin valor por defecto; hasta elegirlo no hay bloques ni barra. */}
      <SelectorTipoSoat valor={tipo} hayDatos={hayDatos || consulta.fase !== 'inicial'} onCambiar={cambiarTipo} error={errorTipo} />
      <ModalidadRenovacion tipo={tipo} compania={compania}>
      {tipo !== null && (
      <>
      {/* ── Bloque 1 · Vehículo ─────────────────────────────────────────────────────────────────
          Inicial: **un solo campo**, el VIN (HU #12091, AC1). Renovación: placa + documento del
          propietario, sin tipo de documento (HU #14019, AC2). */}
      <Seccion
        titulo="1 · Vehículo"
        icono={<Car size={18} aria-hidden="true" className="shrink-0" />}
        chip={consulta.fase === 'ok' && !bloqueoFlito
          ? <StatusChip tone="success" icono={<CircleCheck size={14} aria-hidden="true" />}>Consultado</StatusChip>
          : undefined}
      >
        {renovacion ? (
          <BloqueVehiculoRenovacion
            placa={placa} documento={docVehiculo} onPlaca={cambiarPlaca} onDocumento={cambiarDocVehiculo}
            onBlurPlaca={() => validarCampo('placa', placa)} onBlurDocumento={() => validarCampo('documentoVehiculo', docVehiculo)}
            errorPlaca={errores.placa} errorDocumento={errores.documentoVehiculo}
            placaRef={placaRef} documentoRef={docVehiculoRef} readOnly={cargando}
            placaInvalida={focoEn === 'placa'} documentoInvalido={focoEn === 'documento'}
            describedByExtra={ID_BANDA_RUNT} accion={botonConsultar}
          />
        ) : (
        <Campo
          id={ID_CAMPO.vin} label="VIN (número de chasis)"
          valor={vin} inputRef={vinRef} codigo
          onCambio={cambiarVin}
          onBlur={() => validarCampo('vin', vin)}
          error={errores.vin}
          ayuda={<AyudaVin vin={vin} />}
          maxLength={25} autoComplete="off"
          readOnly={cargando}
          invalido={focoEn === 'vin'}
          /* Condicionado AQUÍ y no dentro de `Campo` (HU #12094): el VIN solo apunta a la banda
             cuando la banda existe. */
          describedByExtra={focoEn === 'vin' ? ID_BANDA_RUNT : undefined}
          accion={botonConsultar}
        />
        )}

        {!renovacion && avisoLongitudVin && !errores.vin && <AvisoLongitudVin texto={avisoLongitudVin} />}

        {(consulta.fase === 'inicial' || consulta.fase === 'invalidada') && <VacioVin renovacion={renovacion} />}

        {cargando && (
          <>
            <EsqueletoFicha />
            <p role="status" className="mt-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
              La consulta puede tardar hasta un minuto. No cierre esta página.
            </p>
          </>
        )}

        {/* La banda de desenlace vive AQUÍ, junto al campo que hay que corregir: lo que falló es la
            consulta. */}
        {consulta.fase === 'fallo' && <BandaDesenlace id={ID_BANDA_RUNT} desenlace={consulta.desenlace} />}

        {/* `role="status"` y no `alert`: no es un fallo, es la consecuencia de lo que el usuario
            acaba de hacer. */}
        {consulta.fase === 'invalidada' && (
          <p role="status" className="mt-3 text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            {renovacion ? 'Cambió la placa o el documento: vuelva a consultar el RUNT antes de enviar.' : 'Cambió el VIN: vuelva a consultar el RUNT antes de enviar.'}
          </p>
        )}

        {/* Bloqueo (409): la tarjeta ocupa el sitio de la ficha, que el 409 no trae. */}
        {consulta.fase === 'vigente' && (
          <TarjetaSoatActivo
            variante="bloqueo" datos={consulta.soatActivo} venceEl={consulta.fechaVencimiento}
            tituloRef={tarjetaVigenteRef} onConsultarOtro={consultarOtroVehiculo}
          />
        )}

        {/* «Ya está en FLITO» (renovación): tarjeta en línea, `role="status"`, sin mover el foco. «Renovar» solo si es renovable. */}
        {bloqueoFlito && flitoCtx && (
          <TarjetaSoatActivo
            variante="renovar" flito={flitoCtx} onConsultarOtro={consultarOtroVehiculo}
            onRenovar={esRenovable(flitoCtx) ? continuarRenovacion : undefined}
          />
        )}

        {/* Aviso (200 con `vigenciaProxima`): ENCIMA de la ficha, porque responde «¿puedo seguir?»
            antes que once pares etiqueta–valor. `role="status"`, sin mover el foco. */}
        {vigencia && !flitoCtx?.yaEnFlito && <TarjetaSoatActivo variante="aviso" datos={vigencia} venceEl={vigencia.venceEl} />}

        {consulta.fase === 'ok' && !bloqueoFlito && (
          <div className="mt-3">
            <FichaRunt datos={consulta.datos} consultadoEn={consulta.consultadoEn} ocultarVin={renovacion} />
          </div>
        )}
      </Seccion>

      {mostrarFormulario && (
      <>
      {/* ── Bloque 2 · Factura de venta ─────────────────────────────────────────────────────────
          Delante del propietario desde la HU #12091 (AC2), y desde la #12094 es también donde la
          lectura dice de sí misma en qué punto está. En Renovación es opcional (HU #14019). */}
      <Seccion
        titulo={renovacion ? '2 · Factura de venta (opcional)' : '2 · Factura de venta'}
        icono={<FileText size={18} aria-hidden="true" className="shrink-0" />} chip={chipLectura(lectura)}
      >
        <div className="space-y-3">
          {renovacion && (
            <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
              Si la adjunta, FLITO lee el propietario y lo llena. Si no, escríbalo.
            </p>
          )}
          <BloqueFactura rotulo={renovacion ? "Un solo archivo PDF · máximo 15 MB · opcional" : undefined} archivo={archivo} error={errores.archivo} onElegir={elegirArchivo} onQuitar={quitarArchivo} />
          {/* Debajo de la caja del archivo, que es donde el tabulador las encuentra, y sin robar el
              foco: la lectura pudo tardar un minuto y el Cliente puede estar escribiendo abajo. */}
          <AvisoLectura
            lectura={lectura}
            onVolverALeer={archivo ? () => { void leerFactura(archivo); } : undefined}
          />
          {sobrescritura && (
            <BandaSobrescritura
              filas={sobrescritura.filas} marcados={marcados}
              onAlternar={(campo) => setMarcados((m) => ({ ...m, [campo]: !m[campo] }))}
              onReemplazar={reemplazarMarcados}
              onConservar={() => setSobrescritura(null)}
            />
          )}
        </div>
      </Seccion>

      {/* ── Bloque 3 · Propietario ──────────────────────────────────────────────────────────── */}
      <Seccion titulo="3 · Propietario" icono={<UserRound size={18} aria-hidden="true" className="shrink-0" />}>
        <BloquePropietario
          valor={propietario} onCambio={cambiarPropietario} errores={errores}
          onBlur={(campo) => validarCampo(campo, propietario[campo])}
          referenciaRunt={consulta.fase === 'ok' ? consulta.datos.propietario?.nombreCompleto ?? null : null}
          revision={{ porRevisar, onConfirmar: confirmarRevision }}
          prellenado={Object.keys(procedencia).length > 0}
        />
      </Seccion>

      {/* ── Bloque 4 · Documentos adicionales (HU #13363): opcional, no suma a lo que falta. */}
      <BloqueDocumentosAdicionales value={adicionales} onChange={setAdicionales} factura={archivo} />

      {/* Barra de envío ANCLADA al borde inferior (HU #14019, UX §3.5): ver `BarraEnvioSolicitud`. */}
      <BarraEnvioSolicitud
        colaHref={COLA} envioIncierto={envioIncierto} avisoEnvio={avisoEnvio} modoCaido={modoCaido} enviando={enviando}
        textoEnviandoAdicionales={validos(adicionales).length ? textoEnviandoAdicionales(validos(adicionales).length) : null}
        fraseFaltantes={fraseFaltantes} bloqueado={bloqueado} onCancelar={salir} onEnviar={intentarEnviar}
      />
      </>
      )}
      </>
      )}
      </ModalidadRenovacion>
      </>
      )}

      {/* Los dos modales dicen «este vehículo» y NO interpolan identificador alguno (UX §5, decisión
          7). La placa ya no existe como dato tecleado, y el VIN no la sustituye: en `vin_ya_tiene_soat`
          la RN-01 corre ANTES de Kyverum, así que no hay respuesta del RUNT de la que sacarlo — y
          meter 17 caracteres en el `aria-label` de un diálogo es PII en la superficie exacta de la
          que tiran los selectores de axe. `restoreFocusRef` es el campo de entrada del tipo vigente. */}
      {modal?.codigo === CodigoErrorSolicitudSoat.VIN_YA_TIENE_SOAT && (
        <ModalVinEnCola
          propia={modal.propia === true} estado={modal.estado} id={modal.id}
          flito={modal.flito} onRenovar={tipo === TipoSoat.INICIAL ? renovarDesdeModal : undefined}
          restoreFocusRef={renovacion ? placaRef : vinRef} onClose={() => setModal(null)}
        />
      )}
      {modal?.codigo === CodigoErrorSolicitudSoat.SOLICITUD_INCOMPLETA_EXISTENTE && (
        <ModalIncompletaExistente propia={modal.propia === true} restoreFocusRef={renovacion ? placaRef : vinRef} onClose={() => setModal(null)} />
      )}

      {confirmarSalida && (
        <FlitModal title="¿Descartar la solicitud?" onClose={() => setConfirmarSalida(false)}>
          <div className="space-y-3 text-sm">
            <p>Lo que escribió no se guarda: no hay borradores.</p>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                onClick={() => setConfirmarSalida(false)}>Seguir llenando</button>
              <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
                onClick={() => navigate(COLA)}>Descartar</button>
            </div>
          </div>
        </FlitModal>
      )}
    </div>
  );
}
