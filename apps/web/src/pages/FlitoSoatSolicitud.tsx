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

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  CodigoErrorSolicitudSoat, PROCEDENCIA_POR_DEFECTO, ProcedenciaDato,
  type ExtraccionFacturaVenta,
} from '@operaciones/shared-types';
import { api } from '../lib/api';
import { puedeSolicitarSoat, useAuth } from '../lib/auth';
import {
  avisoVin, camposLeidos, camposQueViajan, errorApellidos, errorArchivo, errorCelular, errorCorreo,
  errorDepartamento, errorDireccion, errorMunicipio, errorNombreCompleto, errorNombres,
  errorNumeroDocumento, errorRazonSocial, errorTipoDocumento, errorVin, esCampoComprador, esNit,
  leerFallo, normalizarVin, reaccionA, reaccionALectura, avisoVigenciaProxima,
  AVISO_VIGENCIA_CHIP, DESENLACE_SIN_RED, DESENLACE_GENERICO, MENSAJE_ARCHIVO_NO_PDF,
  type CampoComprador, type CampoLeido, type DesenlaceRunt, type FalloCanal, type PreconsultaRunt,
} from '../lib/soatCliente';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import FlitModal from '../components/flit/FlitModal';
import StatusChip from '../components/flit/StatusChip';
import {
  FlitCard, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';
import { ModalSoatVigente, ModalVinEnCola } from '../components/flito/soat-cliente/ModalesBloqueo';
import { TarjetaCanalAjeno, TarjetaCanalDeshabilitado } from '../components/flito/soat-cliente/TarjetaCanal';
import FichaRunt from '../components/flito/soat-cliente/FichaRunt';
import {
  AvisoLectura, BandaSobrescritura, BloqueFactura, BloquePropietario, CAMPOS_NOMBRE, Campo,
  ID_CAMPO, ID_CONFIRMAR, PROPIETARIO_VACIO, Seccion, useFocoPrimerError,
  type CampoPropietario, type EstadoLectura, type FilaSobrescritura, type Propietario,
} from '../components/flito/soat-cliente/bloques';

const COLA = '/flito/soat';

/** Id de la banda de desenlace, para que el campo VIN pueda apuntar a ella con `aria-describedby`. */
const ID_BANDA_RUNT = 'sol-desenlace-runt';

/** Id de la línea que enumera lo que falta, para el `aria-describedby` del primario. */
const ID_FALTANTES = 'sol-falta';

/**
 * El rótulo del primario (HU #12079, AC2, literal).
 *
 * «Gestor» es vocabulario interno y esta es la primera pantalla donde un rol externo lo lee. Queda
 * como una cadena y no interpolado en el JSX porque hay una pregunta abierta al PO: si prefiere
 * «Enviar la solicitud», se cambia aquí y en la ficha de ayuda, no en la estructura.
 */
const ROTULO_ENVIAR = 'Enviar al gestor';
const TOAST_ENVIADA = 'Solicitud enviada. Ya está en gestión.';
/** No es una lista de lo que falta: no falta nada, está PROHIBIDO. Por eso no pasa por la plantilla. */
const AVISO_VIGENTE = 'Este vehículo tiene SOAT vigente según el RUNT: no se puede radicar la solicitud.';

type CampoFormulario = 'vin' | CampoPropietario | 'archivo';
type Errores = Partial<Record<CampoFormulario, string>>;

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
  /** Un desenlace que ya explicó un MODAL (vigente, VIN en cola): la compuerta sigue cerrada. */
  | { fase: 'sin-banda' }
  /** Se editó el VIN después de consultar: lo del RUNT se retira y hay que repetirla (AC5). */
  | { fase: 'invalidada' };

const ROTULO_CONSULTA: Record<Consulta['fase'], string> = {
  inicial: 'Consultar el RUNT',
  cargando: 'Consultando el RUNT…',
  ok: 'Consultar de nuevo',
  fallo: 'Volver a consultar',
  'sin-banda': 'Volver a consultar',
  invalidada: 'Volver a consultar',
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
  const tituloRef = useRef<HTMLHeadingElement>(null);
  const vinRef = useRef<HTMLInputElement>(null);
  const consultarRef = useRef<HTMLButtonElement>(null);

  const [vin, setVin] = useState('');
  const [propietario, setPropietario] = useState<Propietario>(PROPIETARIO_VACIO);
  const [archivo, setArchivo] = useState<File | null>(null);

  const [consulta, setConsulta] = useState<Consulta>({ fase: 'inicial' });
  const [modal, setModal] = useState<FalloCanal | null>(null);
  const [vigenteCerrado, setVigenteCerrado] = useState(false);
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

  const hayDatos = Boolean(vin || archivo || Object.values(propietario).some(Boolean));
  /**
   * **La compuerta del RUNT, y solo eso.** Hasta la HU #12079 esto se llamaba `puedeEnviar` y
   * decidía DOS cosas: el aspecto del botón y a dónde va el foco al pulsarlo. Redefinirlo para que
   * incluyera los campos que faltan habría mandado el foco al botón «Consultar el RUNT» —un control
   * que no tiene nada de malo— cuando lo que falta es el correo. Por eso son dos nombres: este
   * enruta el foco, `faltantes` decide el aspecto.
   */
  const compuertaAbierta = consulta.fase === 'ok';

  useEffect(() => { tituloRef.current?.focus(); }, []);

  // Foco tras un desenlace con banda: al campo VIN cuando hay algo suyo que corregir —el VIN que no
  // cuadra, el que el RUNT no tiene registrado— y al botón de consulta cuando no lo hay (el servicio
  // caído, el registro sin chasis, un código desconocido). Lo decide `desenlace.foco`, no esta
  // pantalla. Se dispara con cada `setConsulta` nuevo, que es lo que permite que dos desenlaces
  // iguales seguidos vuelvan a llevar el foco.
  useEffect(() => {
    if (consulta.fase !== 'fallo') return;
    if (consulta.desenlace.foco === 'vin') vinRef.current?.focus();
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
    setVigenteCerrado(false);
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
  const leerFactura = async (f: File) => {
    turnoLectura.current += 1;
    const mio = turnoLectura.current;
    setSobrescritura(null);
    setLectura({ fase: 'leyendo' });
    try {
      const form = new FormData();
      form.append('facturaVenta', f);
      // La respuesta va ENVUELTA en `{ extraccion }`, no plana.
      const { extraccion } = await api.post<{ extraccion: ExtraccionFacturaVenta }>(
        '/flito/soat/cliente/factura/lectura', form,
      );
      if (turnoLectura.current !== mio) return;
      repartirLectura(camposLeidos(extraccion ?? {}));
    } catch (e) {
      if (turnoLectura.current !== mio) return;
      const r = reaccionALectura(leerFallo(e));
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
    if (!err) void leerFactura(f);
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
    const r = reaccionA(f);
    switch (r.tipo) {
      case 'canal':
        setCanalCaido(true);
        return;
      case 'vin-en-cola':
        // RN-01 corre ANTES del RUNT cuando hay VIN tecleado, así que este 409 puede llegar también
        // en la consulta. Llegue por donde llegue, la compuerta sigue cerrada.
        setModal(f);
        setConsulta({ fase: 'sin-banda' });
        return;
      case 'soat-vigente':
        setModal(f);
        setConsulta({ fase: 'sin-banda' });
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
        if (origen === 'consulta') setConsulta({ fase: 'fallo', desenlace: DESENLACE_GENERICO });
        else setAvisoEnvio(r.mensaje);
    }
  };

  // ── La consulta (AC1, AC4, AC5) ──────────────────────────────────────────────────────────────
  //
  // **El VIN se valida ANTES de pedir nada**, y esa es la mitad que importa: el borde exige un VIN
  // de 11 a 17 caracteres ya normalizado (HU #12090) y contesta con un `400 Datos inválidos` de
  // esquema, que no trae `codigo` del canal y sale por la rama por defecto. El Cliente leería «no
  // pudimos consultar el RUNT» cuando lo que pasa es que le faltan caracteres al VIN.
  const consultar = async () => {
    const errs = validarVehiculo(vin);
    setErrores((e) => ({ ...e, vin: errs.vin }));
    setIntento((n) => n + 1);
    if (Object.keys(errs).length > 0) return;

    turno.current += 1;
    const mio = turno.current;
    setConsulta({ fase: 'cargando' });
    try {
      // **El cuerpo es `{ vin }` y nada más** (HU #12090, AC1): la modalidad de VIN del RUNT no pide
      // documento del propietario, y mandarlo sería entregar un dato personal sin destino. `vin` ya
      // está normalizado en el estado, con la misma función que aplica el borde.
      const datos = await api.post<PreconsultaRunt>('/flito/soat/cliente/preconsulta', { vin });
      if (turno.current !== mio) return;
      setConsulta({ fase: 'ok', datos, consultadoEn: new Date() });
    } catch (e) {
      if (turno.current !== mio) return;
      encajarFallo(leerFallo(e), 'consulta');
    }
  };

  // ── Envío (AC1: crear ES enviar, sin borrador, y solo con el RUNT resuelto) ───────────────────
  const enviar = async () => {
    const errs = validarTodo(vin, propietario, archivo);
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
      // Sin `placa`: la del alta es la que devuelve el RUNT (HU #12090, AC5) y `EntradaSolicitud` la
      // perdió. El VIN va SIEMPRE, que es lo que dejó de ser opcional.
      form.append('vin', vin);
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
      form.append('facturaVenta', archivo!);
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
      await api.post('/flito/soat/cliente', form);
      toast.success(TOAST_ENVIADA);
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
    if (!compuertaAbierta) { consultarRef.current?.focus(); return; }
    // Con la compuerta abierta se llama a `enviar()` **aunque falten campos**: su primera mitad ya
    // hace `validarTodo` → `setErrores` → `setIntento + 1`, y `useFocoPrimerError` lleva el foco al
    // primer campo inválido. Es lo que hace que pulsar el botón bloqueado siga llevando a la acción
    // que toca, y que esa acción sea la correcta de las dos.
    void enviar();
  };

  /**
   * «Consultar otro vehículo» del modal de vigente: limpia **el VIN, y solo el VIN**.
   *
   * Es el único identificador que queda (HU #12091). El propietario —documento incluido, que hasta
   * ahora se borraba con él— y el archivo se CONSERVAN: no dependen de qué vehículo se consulte, y
   * quien va a pedir el SOAT de otro carro de su flota suele ser el mismo titular.
   */
  const consultarOtroVehiculo = () => {
    setModal(null);
    setVin('');
    setErrores((e) => ({ ...e, vin: undefined }));
    setVigenteCerrado(false);
    turno.current += 1;
    setConsulta({ fase: 'inicial' });
  };

  const salir = () => (hayDatos ? setConfirmarSalida(true) : navigate(COLA));

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
    () => faltaParaEnviar(consulta.fase, vin, propietario, archivo, pendientesRevision.length),
    [consulta.fase, vin, propietario, archivo, pendientesRevision.length],
  );
  const fraseFaltantes = vigenteCerrado ? AVISO_VIGENTE : frasePendientes(faltantes);

  const idPrimerError = useMemo(() => primerErrorEnfocable(errores), [errores]);
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
  // HU #12213. **Solo se lee lo que el servidor mandó**: sin resta de fechas y sin umbral local
  // (AC3). `null` —o la clave ausente, si la API va por detrás del bundle— no pinta nada.
  const aviso = consulta.fase === 'ok' ? avisoVigenciaProxima(consulta.datos.vigenciaProxima) : null;

  return (
    <div className="space-y-4">
      <div>
        <button type="button" onClick={salir}
          className="flit-focus mb-2 rounded text-sm font-semibold underline"
          style={{ color: 'var(--flit-blue-text)' }}>
          ← Volver a mis SOAT
        </button>
        <PageHeaderCard
          titleRef={tituloRef}
          title="Solicitud de SOAT"
          subtitle="Escriba el VIN y FLITO consulta el RUNT. Usted adjunta la factura de venta y completa el propietario. Al enviarla, su SOAT entra en gestión de inmediato."
        />
      </div>

      {/* ── Bloque 1 · Vehículo ─────────────────────────────────────────────────────────────────
          **Un solo campo** (AC1). Placa, tipo y número de documento salieron de aquí: desde la
          HU #12090 el RUNT se interroga por VIN, y un campo que no cambia el resultado de la
          consulta es un campo que sobra. El documento no desapareció —se edita en el bloque 3, con
          el propietario, que es donde se entiende para qué sirve. */}
      <Seccion
        titulo="1 · Vehículo"
        chip={consulta.fase === 'ok' ? <StatusChip tone="success">✓ Consultado</StatusChip> : undefined}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Campo
            id={ID_CAMPO.vin} label="VIN (número de chasis)"
            valor={vin} inputRef={vinRef}
            onCambio={cambiarVin}
            onBlur={() => validarCampo('vin', vin)}
            error={errores.vin}
            ayuda="Está en la tarjeta de propiedad y en la factura de venta. Suele tener 17 caracteres."
            maxLength={25} autoComplete="off"
            readOnly={cargando}
            invalido={consulta.fase === 'fallo' && consulta.desenlace.foco === 'vin'}
            /* Condicionado AQUÍ y no dentro de `Campo` (HU #12094): el componente enlaza
               `describedByExtra` siempre que se le pase, porque la marca de baja confianza necesita
               describir sin marcar inválido. Quien quiere las dos cosas juntas —este campo, cuya
               banda solo existe con el desenlace pintado— lo dice en su llamada. Sin esto, el VIN
               apuntaría a un id que no está en el DOM el 95 % del tiempo. */
            describedByExtra={consulta.fase === 'fallo' && consulta.desenlace.foco === 'vin'
              ? ID_BANDA_RUNT
              : undefined}
          />
        </div>

        {avisoLongitudVin && !errores.vin && (
          <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{avisoLongitudVin}</p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button" ref={consultarRef}
            className={consulta.fase === 'ok' ? flitBtnSecondary : flitBtnPrimary}
            style={consulta.fase === 'ok' ? flitBtnSecondaryStyle : flitBtnPrimaryStyle}
            disabled={cargando}
            onClick={() => { void consultar(); }}
          >
            {ROTULO_CONSULTA[consulta.fase]}
          </button>
          {cargando && (
            <span role="status" className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
              La consulta puede tardar hasta un minuto. No cierre esta página.
            </span>
          )}
        </div>

        {/* La banda de desenlace vive AQUÍ, junto a los campos que hay que corregir, y no en la
            tarjeta de envío: lo que falló es la consulta. */}
        {consulta.fase === 'fallo' && (
          <div
            id={ID_BANDA_RUNT} role="alert" className="mt-3 space-y-1 rounded-[10px] p-3"
            style={{ border: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}
          >
            <p className="text-sm font-semibold" style={{
              color: consulta.desenlace.tono === 'danger' ? 'var(--flit-danger-ink)' : 'var(--flit-warning-ink)',
            }}>
              {consulta.desenlace.titulo}
            </p>
            <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{consulta.desenlace.detalle}</p>
          </div>
        )}

        {/* `role="status"` y no `alert`: no es un fallo, es la consecuencia de lo que el usuario
            acaba de hacer. */}
        {consulta.fase === 'invalidada' && (
          <p role="status" className="mt-3 text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            Cambió el VIN: vuelva a consultar el RUNT antes de enviar.
          </p>
        )}

        {/* ── Aviso de vigencia próxima (HU #12213) ──────────────────────────────────────────
            ENCIMA de la ficha y no dentro: quien acaba de pulsar el botón lee hacia abajo desde él,
            y la respuesta a «¿puedo seguir?» tiene que llegar antes que once pares etiqueta–valor.
            La ficha responde «¿es mi carro?»; esto habla del trámite.

            Es el ÚNICO de los cuatro desenlaces SIN tinta de estado en el título: colorearlo
            —aunque fuera en azul— lo igualaría a las bandas de fallo, y leer esto como un error es
            justo lo que hace abandonar a quien SÍ puede enviar. Lo verde es solo el chip.

            `role="status"` y no `alert`: no es un fallo y llega después de una acción del usuario;
            se anuncia al montarse y **no mueve el foco** (el efecto de foco de la página solo actúa
            en `fase === 'fallo'` y no debe extenderse aquí).

            Nunca coincide con las bandas de error: las fases de `Consulta` son excluyentes, así que
            esto solo existe en `ok` y aquéllas solo en `fallo`. */}
        {consulta.fase === 'ok' && aviso && (
          <div
            role="status" className="mt-3 space-y-1 rounded-[10px] p-3"
            style={{ border: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}
          >
            <StatusChip tone="success">{AVISO_VIGENCIA_CHIP}</StatusChip>
            <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
              {aviso.titulo}
            </p>
            {/* `null` en la redacción de respaldo, que ya dice las tres cosas en una sola frase. */}
            {aviso.detalle && (
              <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{aviso.detalle}</p>
            )}
          </div>
        )}

        {consulta.fase === 'ok' && (
          <div className="mt-3">
            <FichaRunt datos={consulta.datos} consultadoEn={consulta.consultadoEn} />
          </div>
        )}

        <p className="mt-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          Con el VIN, el RUNT nos dice la placa, la marca, la línea, el modelo y la ficha técnica del
          vehículo. Usted no tiene que escribirlos.
        </p>
      </Seccion>

      {/* ── Bloque 2 · Factura de venta ─────────────────────────────────────────────────────────
          Delante del propietario desde la HU #12091 (AC2), y desde la #12094 es también donde la
          lectura dice de sí misma en qué punto está. El chip vive en el encabezado de la sección,
          hermano del «✓ Consultado» del bloque 1: la pantalla ya tiene ese vocabulario. */}
      <Seccion titulo="2 · Factura de venta" chip={chipLectura(lectura)}>
        <div className="space-y-3">
          <BloqueFactura archivo={archivo} error={errores.archivo} onElegir={elegirArchivo} onQuitar={quitarArchivo} />
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
      <Seccion titulo="3 · Propietario">
        <BloquePropietario
          valor={propietario} onCambio={cambiarPropietario} errores={errores}
          onBlur={(campo) => validarCampo(campo, propietario[campo])}
          referenciaRunt={consulta.fase === 'ok' ? consulta.datos.propietario?.nombreCompleto ?? null : null}
          revision={{ porRevisar, onConfirmar: confirmarRevision }}
          prellenado={Object.keys(procedencia).length > 0}
        />
      </Seccion>

      <FlitCard>
        {envioIncierto
          ? (
            <div className="space-y-2">
              <p role="alert" className="text-sm font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>
                No sabemos si la solicitud llegó a FLITO. Vuelva a sus SOAT y busque ese VIN antes de volver a enviarla.
              </p>
              <Link to={COLA} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>Volver a mis SOAT</Link>
            </div>
          )
          : (
            <div className="space-y-3">
              {avisoEnvio && (
                <p role="alert" className="text-sm font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>{avisoEnvio}</p>
              )}
              <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                Al enviarla, su SOAT entra en gestión de inmediato. No se guarda como borrador.
              </p>
              {enviando && <span role="status" className="sr-only">Enviando…</span>}
              <div className="flex flex-wrap items-center justify-end gap-2">
                {/* **Texto plano con `id`, no una región viva.** El botón la referencia con
                    `aria-describedby` mientras está bloqueado, así que el lector anuncia «Enviar al
                    gestor, no disponible, Para enviar falta: …» cuando el foco LLEGA al botón, que
                    es cuando importa. Una `role="status"` aquí se reanunciaría con cada pulsación
                    de tecla del formulario: doce campos interrumpiendo a quien escribe. */}
                {fraseFaltantes && (
                  <p id={ID_FALTANTES} className="mr-auto text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
                    {fraseFaltantes}
                  </p>
                )}
                <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={salir}>
                  Cancelar
                </button>
                {/* **`aria-disabled` y no `disabled`, y es una decisión de accesibilidad.** Un botón
                    `disabled` sale del recorrido de tabulación: quien navega con teclado llega al
                    final del formulario y el primario simplemente NO EXISTE, sin explicación. Con
                    `aria-disabled` el lector anuncia «no disponible», el foco lo alcanza y al
                    pulsarlo la pantalla lo lleva a la acción que sí toca. El AC1 se cumple igual:
                    no se envía nada. La atenuación va EXPLÍCITA porque `aria-disabled` no dispara
                    las variantes `disabled:` de Tailwind. */}
                <button type="button" className={flitBtnPrimary}
                  style={bloqueado
                    ? { ...flitBtnPrimaryStyle, opacity: 0.5, cursor: 'not-allowed' }
                    : flitBtnPrimaryStyle}
                  aria-disabled={bloqueado ? true : undefined}
                  aria-describedby={bloqueado && fraseFaltantes ? ID_FALTANTES : undefined}
                  disabled={enviando} onClick={intentarEnviar}>
                  {enviando ? 'Enviando…' : ROTULO_ENVIAR}
                </button>
              </div>
            </div>
          )}
      </FlitCard>

      {/* Los dos modales dicen «este vehículo» y NO interpolan identificador alguno (UX §5, decisión
          7). La placa ya no existe como dato tecleado, y el VIN no la sustituye: en `vin_ya_tiene_soat`
          la RN-01 corre ANTES de Kyverum, así que no hay respuesta del RUNT de la que sacarlo — y
          meter 17 caracteres en el `aria-label` de un diálogo es PII en la superficie exacta de la
          que tiran los selectores de axe. `restoreFocusRef` es el VIN, el único campo que queda. */}
      {modal?.codigo === CodigoErrorSolicitudSoat.SOAT_VIGENTE && (
        <ModalSoatVigente
          fechaVencimiento={modal.fechaVencimiento}
          onConsultarOtro={consultarOtroVehiculo}
          restoreFocusRef={vinRef}
          onClose={() => { setModal(null); setVigenteCerrado(true); }}
        />
      )}

      {modal?.codigo === CodigoErrorSolicitudSoat.VIN_YA_TIENE_SOAT && (
        <ModalVinEnCola
          propia={modal.propia === true} estado={modal.estado} id={modal.id}
          restoreFocusRef={vinRef} onClose={() => setModal(null)}
        />
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

// ───────────────────────────── Validación ────────────────────────────────────────────────────────

/**
 * El validador de un campo. **El tipo de documento decide cuál se aplica al nombre**: pedirle
 * apellidos a un NIT sería exigir un dato que el servidor rechaza.
 */
function validador(campo: CampoFormulario, tipoDocumento: string): ((v: string) => string | null) | null {
  switch (campo) {
    case 'vin': return errorVin;
    case 'tipoDocumento': return errorTipoDocumento;
    case 'numeroDocumento': return errorNumeroDocumento;
    case 'nombres': return esNit(tipoDocumento) ? null : errorNombres;
    case 'apellidos': return esNit(tipoDocumento) ? null : errorApellidos;
    case 'razonSocial': return esNit(tipoDocumento) ? errorRazonSocial : null;
    case 'correo': return errorCorreo;
    case 'celular': return errorCelular;
    case 'direccion': return errorDireccion;
    case 'municipio': return errorMunicipio;
    case 'departamento': return errorDepartamento;
    default: return null;
  }
}

/**
 * Lo que la CONSULTA necesita: **el VIN y nada más** (HU #12091, AC1).
 *
 * Que sea una función de un solo campo y no una comprobación en línea es lo que mantiene una sola
 * fuente de verdad con `validarTodo`, que la reusa: el día que el VIN gane otra regla, la consulta
 * y el envío la aplican los dos o ninguno.
 */
function validarVehiculo(vin: string): Errores {
  const errs: Errores = {};
  const msg = errorVin(vin);
  if (msg) errs.vin = msg;
  return errs;
}

/** Todas las reglas a la vez, en el ORDEN VISUAL: el primero que falle es al que va el foco. */
function validarTodo(vin: string, p: Propietario, archivo: File | null): Errores {
  const errs = validarVehiculo(vin);
  const poner = (c: CampoFormulario, m: string | null) => { if (m) errs[c] = m; };
  poner('tipoDocumento', errorTipoDocumento(p.tipoDocumento));
  poner('numeroDocumento', errorNumeroDocumento(p.numeroDocumento));
  const campoNombre = (c: 'nombres' | 'apellidos' | 'razonSocial') => poner(c, validador(c, p.tipoDocumento)?.(p[c]) ?? null);
  campoNombre('razonSocial');
  campoNombre('nombres');
  campoNombre('apellidos');
  // La cota del DERIVADO, la misma del borde: `nombres` y `apellidos` son dos topes independientes
  // de 200 sobre una columna de 200, así que el máximo alcanzable es 401. Cuelga de los DOS campos
  // —el usuario acorta el que quiera— y se frena aquí porque el `400` del servidor aterrizaba en el
  // aviso genérico de la tarjeta de envío, que no marca ningún campo, tras subir el PDF entero.
  if (!esNit(p.tipoDocumento) && !errs.nombres && !errs.apellidos) {
    const msg = errorNombreCompleto(p.nombres, p.apellidos);
    if (msg) { errs.nombres = msg; errs.apellidos = msg; }
  }
  poner('correo', errorCorreo(p.correo));
  poner('celular', errorCelular(p.celular));
  poner('direccion', errorDireccion(p.direccion));
  poner('municipio', errorMunicipio(p.municipio));
  poner('departamento', errorDepartamento(p.departamento));
  if (!archivo) errs.archivo = 'Adjunte la factura de venta en PDF.';
  return errs;
}

// ─────────────────── Lo que falta para enviar, dicho por su nombre (HU #12079) ──────────────────

/**
 * El orden VISUAL de los campos ENFOCABLES: el primero que falle es al que va el foco.
 *
 * Reordenado en la HU #12091 (AC2) con la pantalla: el VIN abre —es el único control del bloque 1— y
 * el documento baja al bloque del propietario, delante del nombre. `archivo` **no está aquí** y no
 * es un olvido: la caja de subida no tiene un id en `ID_CAMPO` al que llevar el foco, así que
 * incluirla haría que `primerErrorEnfocable` devolviera `null` —y nadie recibiría el foco— cada vez
 * que faltara la factura y algo más. Su sitio en la enumeración sí cambia, abajo.
 */
const ORDEN_FOCO_BASE: CampoFormulario[] = [
  'vin', 'tipoDocumento', 'numeroDocumento',
  ...CAMPOS_NOMBRE, 'correo', 'celular', 'direccion', 'municipio', 'departamento',
];

/**
 * El nombre VISIBLE de cada campo: el mismo literal que su `<label>` en `bloques.tsx`.
 *
 * Etiquetas y nunca valores — «Correo electrónico», jamás lo que el Cliente escribió en él —: esta
 * frase se lee en voz alta y se pinta en pantalla, y un valor ahí sería PII en una superficie que
 * no la necesita.
 */
const ETIQUETA_CAMPO: Record<CampoFormulario, string> = {
  tipoDocumento: 'Tipo de documento',
  numeroDocumento: 'Número de documento',
  vin: 'VIN',
  razonSocial: 'Razón social',
  nombres: 'Nombre/s',
  apellidos: 'Apellido/s',
  correo: 'Correo electrónico',
  celular: 'Celular',
  direccion: 'Dirección',
  municipio: 'Municipio',
  departamento: 'Departamento',
  archivo: 'Factura de venta',
};

/**
 * El orden de la enumeración: **el del foco, con la factura en su sitio nuevo**.
 *
 * Es el orden visual y el del tabulador, y es lo que hace la frase afirmable en un test: sin un
 * orden fijo, «faltan el correo y el celular» y «faltan el celular y el correo» serían las dos
 * correctas y ninguna comprobable. La factura ya no va al final: desde la HU #12091 su bloque está
 * ENTRE el vehículo y el propietario, y una frase que la nombrara al final mandaría a mirar abajo
 * lo que está arriba.
 */
const ORDEN_FALTANTES: CampoFormulario[] = ['vin', 'archivo', ...ORDEN_FOCO_BASE.slice(1)];

/**
 * El ítem del RUNT, redactado según la fase, y **siempre el primero**.
 *
 * Calca `ROTULO_CONSULTA`, que es el rótulo del botón al que la frase apunta: si el botón dice
 * «Volver a consultar», la frase no puede decir «consultar». `cargando` sigue contando —la
 * compuerta sigue cerrada mientras el RUNT piensa— y se redacta como `inicial` porque «volver a»
 * sería falso: es la primera consulta y está en vuelo.
 */
const ITEM_RUNT: Record<Consulta['fase'], string | null> = {
  inicial: 'consultar el RUNT',
  cargando: 'consultar el RUNT',
  fallo: 'consultar el RUNT',
  'sin-banda': 'consultar el RUNT',
  invalidada: 'volver a consultar el RUNT',
  ok: null,
};

/**
 * Todo lo que impide enviar, en el orden del foco. Lista vacía = el botón está activo.
 *
 * **Se deriva de `validarTodo`**, la función que ya bloquea el envío. Nunca de un `campo === ''`
 * paralelo: con dos fuentes de verdad, un correo mal escrito dejaría el botón activo, la pulsación
 * no enviaría nada y el Cliente no tendría forma de saber por qué.
 */
function faltaParaEnviar(
  fase: Consulta['fase'], vin: string, p: Propietario, archivo: File | null, porRevisar: number,
): string[] {
  const errs = validarTodo(vin, p, archivo);
  const runt = ITEM_RUNT[fase];
  return [
    ...(runt ? [runt] : []),
    ...(porRevisar > 0 ? [itemRevision(porRevisar)] : []),
    ...ORDEN_FALTANTES.filter((c) => errs[c]).map((c) => ETIQUETA_CAMPO[c]),
  ];
}

/**
 * El ítem de la revisión pendiente (HU #12094, AC3), **siempre el SEGUNDO** — detrás del RUNT, y el
 * primero cuando el RUNT ya está resuelto.
 *
 * No es una preferencia de redacción: `frasePendientes` conserva los dos primeros segmentos y resume
 * el resto, así que esa posición es la única que garantiza que el número de campos por revisar nunca
 * caiga dentro del «y N datos más». El AC pide que el botón indique cuántos faltan por revisar; al
 * final de la lista, en el caso más común —formulario a medias y dos lecturas dudosas— dejaría de
 * indicarlo.
 *
 * Es la ÚNICA variante de singular/plural de esta plantilla, y trae su localizador para QA:
 * `/revisar \d+ datos? leídos?/`.
 */
function itemRevision(n: number): string {
  return n === 1 ? 'revisar 1 dato leído' : `revisar ${n} datos leídos`;
}

/** Copia el mapa sin una clave. Un `= undefined` dejaría la clave presente ante `in` y `Object.keys`. */
function sinClave<K extends string, V>(mapa: Partial<Record<K, V>>, clave: K): Partial<Record<K, V>> {
  const n = { ...mapa };
  delete n[clave];
  return n;
}

/**
 * El chip del bloque 2, uno por estado de la LECTURA (UX §3).
 *
 * La lectura vacía **no lleva chip**: un «✓ Factura leída» sobre un bloque 3 en blanco se leería como
 * que los datos están puestos. Lo que hay que decir ahí lo dice la línea de `AvisoLectura`.
 */
function chipLectura(lectura: EstadoLectura): ReactNode {
  switch (lectura.fase) {
    case 'leyendo': return <StatusChip tone="active">Leyendo la factura…</StatusChip>;
    case 'ok': return <StatusChip tone="success">✓ Factura leída</StatusChip>;
    case 'fallo': return <StatusChip tone="warning">No se pudo leer</StatusChip>;
    default: return undefined;
  }
}

/**
 * «Para enviar falta: A, B y C.» — **una sola plantilla**, sin variantes de singular ni de plural,
 * para que exista UN localizador que afirmar en un test.
 *
 * **Tope: tres segmentos.** Con el formulario en blanco faltan doce cosas y enumerarlas todas es un
 * párrafo que nadie lee. Cuando sobran, los dos primeros nombres y «y N datos más» — el corte va en
 * dos y no en tres a propósito: con cuatro pendientes, «A, B, C y 1 datos más» obligaría a la
 * variante de singular que esta plantilla existe para no tener.
 */
function frasePendientes(items: string[]): string | null {
  if (items.length === 0) return null;
  const segmentos = items.length <= 3
    ? items
    : [...items.slice(0, 2), `${items.length - 2} datos más`];
  const ultimo = segmentos[segmentos.length - 1];
  const previos = segmentos.slice(0, -1);
  return `Para enviar falta: ${previos.length ? `${previos.join(', ')} y ${ultimo}` : ultimo}.`;
}



/**
 * El id del primer control inválido, o `null`.
 *
 * `null` también cuando el primero es el tipo de documento: `FlitSelect` se enfoca a sí mismo al
 * recibir `error` y su id lo genera `useId()`. Devolver algo aquí competiría con ese foco.
 */
function primerErrorEnfocable(errores: Errores): string | null {
  const primero = ORDEN_FOCO_BASE.find((c) => errores[c]);
  if (!primero || primero === 'tipoDocumento') return null;
  return ID_CAMPO[primero as keyof typeof ID_CAMPO] ?? null;
}
