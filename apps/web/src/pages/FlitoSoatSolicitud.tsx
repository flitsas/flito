// FLITO — canal Cliente: alta de una solicitud de SOAT sin trámite (Feature #11912).
//
// Diseño: docs/ux/flito-soat-consulta-runt-compuerta-y-propietario.md (HU #11967).
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
//   2. **Se ramifica por `codigo`** (`reaccionA`, en `lib/soatCliente.ts`), nunca por el texto del
//      mensaje, y hay rama por defecto para un código desconocido o retirado.
//   3. **`aria-disabled` y no `disabled`** en el primario de envío. Ver la tarjeta de envío, abajo.
//
// ── PII ─────────────────────────────────────────────────────────────────────────────────────────
//
// Placa, VIN, documento, correo, celular, dirección, municipio y departamento viajan SIEMPRE en el
// cuerpo de un `POST`. Desde la HU #12079 la URL de esta pantalla no toca **ninguna** PII: era el
// uuid opaco de `/solicitud/:id` —que AGENTS.md §14 permitía— y esa ruta se retiró con la
// subsanación, así que `/flito/soat/solicitud` ya no lleva parámetros; tras crear, se navega a la
// cola (`/flito/soat`) y no al identificador de la solicitud.
// **El VIN que trae el RUNT no se pinta en ninguna parte**: la respuesta lo devuelve para
// persistirlo, y enseñarlo convertiría la pantalla en un lector de VIN por placa para quien sondee
// placas ajenas.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { CodigoErrorSolicitudSoat } from '@operaciones/shared-types';
import { api } from '../lib/api';
import { puedeSolicitarSoat, useAuth } from '../lib/auth';
import {
  avisoVin, errorApellidos, errorArchivo, errorCelular, errorCorreo, errorDepartamento,
  errorDireccion, errorMunicipio, errorNombres, errorNumeroDocumento, errorPlaca, errorRazonSocial,
  errorTipoDocumento, errorVin, esNit, leerFallo, normalizarPlaca, normalizarVin, reaccionA,
  DESENLACE_SIN_RED, desenlaceGenerico, OPCIONES_TIPO_DOC,
  type DesenlaceRunt, type FalloCanal, type PreconsultaRunt,
} from '../lib/soatCliente';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import FlitModal from '../components/flit/FlitModal';
import FlitSelect from '../components/flit/FlitSelect';
import StatusChip from '../components/flit/StatusChip';
import {
  FlitCard, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';
import { ModalSoatVigente, ModalVinEnCola } from '../components/flito/soat-cliente/ModalesBloqueo';
import { TarjetaCanalAjeno, TarjetaCanalDeshabilitado } from '../components/flito/soat-cliente/TarjetaCanal';
import FichaRunt from '../components/flito/soat-cliente/FichaRunt';
import {
  BloqueFactura, BloquePropietario, CAMPOS_NOMBRE, Campo, ID_CAMPO, PROPIETARIO_VACIO,
  Seccion, useFocoPrimerError, type CampoPropietario, type Propietario,
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

type CampoFormulario = 'placa' | 'vin' | CampoPropietario | 'archivo';
type Errores = Partial<Record<CampoFormulario, string>>;

/**
 * Los cuatro identificadores de la consulta. **Los cuatro**, y el que se olvida es el tipo de
 * documento: cambiarlo cambia a quién le pregunta FLITO por ese vehículo, así que invalida la ficha
 * igual que cambiar la placa.
 */
type Identificador = 'placa' | 'vin' | 'tipoDocumento' | 'numeroDocumento';

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
  /** Se tocó un identificador después de consultar: lo del RUNT se retira y hay que repetirla. */
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
  const { user } = useAuth();

  if (!puedeSolicitarSoat(user)) {
    return (
      <div className="space-y-4">
        <PageHeaderCard title="Solicitud de SOAT" />
        {user?.role === 'cliente'
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
  const placaRef = useRef<HTMLInputElement>(null);
  const vinRef = useRef<HTMLInputElement>(null);
  const consultarRef = useRef<HTMLButtonElement>(null);

  const [placa, setPlaca] = useState('');
  const [vin, setVin] = useState('');
  const [propietario, setPropietario] = useState<Propietario>(PROPIETARIO_VACIO);
  const [archivo, setArchivo] = useState<File | null>(null);

  const [consulta, setConsulta] = useState<Consulta>({ fase: 'inicial' });
  const [modal, setModal] = useState<FalloCanal | null>(null);
  const [vigenteCerrado, setVigenteCerrado] = useState(false);
  const [canalCaido, setCanalCaido] = useState(false);

  const [errores, setErrores] = useState<Errores>({});
  const [intento, setIntento] = useState(0);
  const [enviando, setEnviando] = useState(false);
  const [avisoEnvio, setAvisoEnvio] = useState<string | null>(null);
  const [envioIncierto, setEnvioIncierto] = useState(false);
  const [confirmarSalida, setConfirmarSalida] = useState(false);

  /**
   * Turno de la consulta en vuelo. Los campos NO se deshabilitan mientras se consulta —perderían el
   * foco—, así que el Cliente puede cambiar un identificador antes de que Kyverum conteste: sin este
   * contador, esa respuesta llegaría tarde y pintaría una ficha de OTRO vehículo sobre los datos ya
   * corregidos, con la compuerta abierta.
   */
  const turno = useRef(0);

  const hayDatos = Boolean(placa || vin || archivo || Object.values(propietario).some(Boolean));
  /**
   * **La compuerta del RUNT, y solo eso.** Hasta la HU #12079 esto se llamaba `puedeEnviar` y
   * decidía DOS cosas: el aspecto del botón y a dónde va el foco al pulsarlo. Redefinirlo para que
   * incluyera los campos que faltan habría mandado el foco al botón «Consultar el RUNT» —un control
   * que no tiene nada de malo— cuando lo que falta es el correo. Por eso son dos nombres: este
   * enruta el foco, `faltantes` decide el aspecto.
   */
  const compuertaAbierta = consulta.fase === 'ok';

  useEffect(() => { tituloRef.current?.focus(); }, []);

  // Foco tras un desenlace con banda: al campo VIN cuando es el VIN lo que no cuadra, y al botón de
  // consulta en todos los demás casos. Se dispara con cada `setConsulta` nuevo, que es lo que
  // permite que dos desenlaces iguales seguidos vuelvan a llevar el foco.
  useEffect(() => {
    if (consulta.fase !== 'fallo') return;
    if (consulta.desenlace.foco === 'vin') vinRef.current?.focus();
    else consultarRef.current?.focus();
  }, [consulta]);

  /**
   * **Se retira todo lo que trajo el RUNT; no se borra nada de lo que tecleó el Cliente.**
   *
   * Un formulario que conserva la ficha de otro vehículo deja radicar una solicitud con los datos
   * técnicos de un carro y la placa de otro. Y al revés: borrar el propietario y la factura porque
   * se corrigió una letra de la placa castiga al usuario por el error que acaba de arreglar.
   */
  const invalidarConsulta = () => {
    turno.current += 1;
    setVigenteCerrado(false);
    setConsulta((c) => (c.fase === 'inicial' ? c : { fase: 'invalidada' }));
  };

  const cambiarIdentificador = (campo: Identificador, v: string) => {
    if (campo === 'placa') setPlaca(normalizarPlaca(v));
    else if (campo === 'vin') setVin(normalizarVin(v));
    else setPropietario((p) => ({ ...p, [campo]: v }));
    setErrores((e) => ({ ...e, [campo]: undefined }));
    // El tipo de documento tiene DOS efectos y hay que verlos los dos: invalida la consulta (es
    // entrada del RUNT) y conmuta los campos de nombre. Los errores de los tres se descartan aquí:
    // `useFocoPrimerError` enfoca por `id`, y un error de «Apellido/s» con NIT elegido mandaría el
    // foco a un id que ya no está en el DOM — es decir, a `<body>`.
    if (campo === 'tipoDocumento') {
      setErrores((e) => ({ ...e, nombres: undefined, apellidos: undefined, razonSocial: undefined }));
    }
    invalidarConsulta();
  };

  const cambiarPropietario = (campo: CampoPropietario, v: string) => {
    setPropietario((p) => ({ ...p, [campo]: v }));
    setErrores((e) => ({ ...e, [campo]: undefined }));
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
        setErrores((e) => ({
          ...e,
          archivo: 'Ese archivo no es un PDF válido, aunque se llame así. Si lo exportó desde el celular, vuelva a guardarlo como PDF y súbalo otra vez.',
        }));
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
        if (origen === 'consulta') setConsulta({ fase: 'fallo', desenlace: desenlaceGenerico(r.mensaje) });
        else setAvisoEnvio(r.mensaje);
    }
  };

  // ── La consulta (AC1, AC2, AC3) ──────────────────────────────────────────────────────────────
  const consultar = async () => {
    const errs = validarIdentificadores(placa, vin, propietario);
    setErrores((e) => ({
      ...e, placa: errs.placa, vin: errs.vin,
      tipoDocumento: errs.tipoDocumento, numeroDocumento: errs.numeroDocumento,
    }));
    setIntento((n) => n + 1);
    if (Object.keys(errs).length > 0) return;

    turno.current += 1;
    const mio = turno.current;
    setConsulta({ fase: 'cargando' });
    try {
      const datos = await api.post<PreconsultaRunt>('/flito/soat/cliente/preconsulta', {
        placa: placa.trim(),
        tipoDocumento: propietario.tipoDocumento,
        numeroDocumento: propietario.numeroDocumento.trim(),
        // La clave se OMITE cuando no lo escribió; no se manda vacía. El esquema pide 5–17 «si viene».
        ...(vin.trim() ? { vin: vin.trim() } : {}),
      });
      if (turno.current !== mio) return;
      setConsulta({ fase: 'ok', datos, consultadoEn: new Date() });
    } catch (e) {
      if (turno.current !== mio) return;
      encajarFallo(leerFallo(e), 'consulta');
    }
  };

  // ── Envío (AC1: crear ES enviar, sin borrador, y solo con el RUNT resuelto) ───────────────────
  const enviar = async () => {
    const errs = validarTodo(placa, vin, propietario, archivo);
    setErrores(errs);
    setIntento((n) => n + 1);
    if (Object.keys(errs).length > 0) {
      setAvisoEnvio('Revise los datos marcados antes de enviar.');
      return;
    }
    setAvisoEnvio(null);
    setEnviando(true);
    try {
      const juridica = esNit(propietario.tipoDocumento);
      const form = new FormData();
      form.append('placa', placa.trim());
      if (vin.trim()) form.append('vin', vin.trim());
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

  /** «Consultar otro vehículo» del modal de vigente: limpia los CUATRO identificadores. */
  const consultarOtroVehiculo = () => {
    setModal(null);
    setPlaca('');
    setVin('');
    setPropietario((p) => ({ ...p, tipoDocumento: '', numeroDocumento: '' }));
    setErrores((e) => ({ ...e, placa: undefined, vin: undefined, tipoDocumento: undefined, numeroDocumento: undefined }));
    setVigenteCerrado(false);
    turno.current += 1;
    setConsulta({ fase: 'inicial' });
    // El propietario y el archivo se CONSERVAN: no dependen de qué vehículo se consulte.
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
  const faltantes = useMemo(
    () => faltaParaEnviar(consulta.fase, placa, vin, propietario, archivo),
    [consulta.fase, placa, vin, propietario, archivo],
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
          subtitle="Consultamos el RUNT con la placa y el documento del propietario. Usted completa el propietario y adjunta la factura de venta. Al enviarla, su SOAT entra en gestión de inmediato."
        />
      </div>

      {/* ── Bloque 1 · Vehículo y documento ─────────────────────────────────────────────────────
          El ORDEN de entrada es el del AC1 —placa, tipo, número, VIN— y es también el orden del
          DOM, que es el que recorre el tabulador. Tipo y número viven aquí y NO se repiten en el
          bloque 2 porque son entrada de la consulta: dos controles para el mismo dato es la forma
          más barata de radicar una solicitud consultada con un documento y enviada con otro. */}
      <Seccion
        titulo="1 · Vehículo"
        chip={consulta.fase === 'ok' ? <StatusChip tone="success">✓ Consultado</StatusChip> : undefined}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Campo
            id={ID_CAMPO.placa} label="Placa" valor={placa}
            onCambio={(v) => cambiarIdentificador('placa', v)}
            onBlur={() => validarCampo('placa', placa)} inputRef={placaRef}
            error={errores.placa} ayuda="Sin espacios ni guiones." maxLength={10} autoComplete="off"
            readOnly={cargando}
          />
          <FlitSelect
            label="Tipo de documento"
            value={propietario.tipoDocumento}
            opciones={OPCIONES_TIPO_DOC}
            onChange={(v) => cambiarIdentificador('tipoDocumento', v)}
            ayuda="Del propietario del vehículo."
            error={errores.tipoDocumento ?? null}
            required
          />
          <Campo
            id={ID_CAMPO.numeroDocumento} label="Número de documento" valor={propietario.numeroDocumento}
            onCambio={(v) => cambiarIdentificador('numeroDocumento', v)}
            onBlur={() => validarCampo('numeroDocumento', propietario.numeroDocumento)}
            error={errores.numeroDocumento} maxLength={30} autoComplete="off"
            readOnly={cargando}
          />
          <Campo
            id={ID_CAMPO.vin} label="VIN (número de chasis)" opcional textoOpcional="— opcional"
            valor={vin} inputRef={vinRef}
            onCambio={(v) => cambiarIdentificador('vin', v)}
            onBlur={() => validarCampo('vin', vin)}
            error={errores.vin}
            // Las dos frases hacen falta: sin la segunda, «opcional» se lee como «da igual»; sin la
            // primera, no se entiende por qué escribirlo puede frenar la solicitud.
            ayuda="Si lo escribe, el RUNT lo compara con el del registro. Si lo deja vacío, FLITO usa el que traiga el RUNT."
            readOnly={cargando}
            invalido={consulta.fase === 'fallo' && consulta.desenlace.foco === 'vin'}
            describedByExtra={ID_BANDA_RUNT}
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
            Cambió la placa o el documento: vuelva a consultar el RUNT antes de enviar.
          </p>
        )}

        {consulta.fase === 'ok' && (
          <div className="mt-3">
            <FichaRunt datos={consulta.datos} consultadoEn={consulta.consultadoEn} />
          </div>
        )}

        <p className="mt-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          La marca, la línea, el modelo, la clase, el servicio, el cilindraje y el organismo los trae
          el RUNT. Usted no tiene que escribirlos.
        </p>
      </Seccion>

      {/* ── Bloque 2 · Propietario ──────────────────────────────────────────────────────────── */}
      <Seccion titulo="2 · Propietario">
        <BloquePropietario
          valor={propietario} onCambio={cambiarPropietario} errores={errores}
          onBlur={(campo) => validarCampo(campo, propietario[campo])}
          documento={{ modo: 'eco', dondeSeCambia: 'se cambia en el bloque 1' }}
          referenciaRunt={consulta.fase === 'ok' ? consulta.datos.propietario?.nombreCompleto ?? null : null}
        />
      </Seccion>

      {/* ── Bloque 3 · Factura de venta ─────────────────────────────────────────────────────── */}
      <Seccion titulo="3 · Factura de venta">
        <BloqueFactura
          archivo={archivo} error={errores.archivo}
          onElegir={(f) => {
            const err = errorArchivo(f);
            setErrores((e) => ({ ...e, archivo: err ?? undefined }));
            setArchivo(err ? null : f);
          }}
          onQuitar={() => { setArchivo(null); setErrores((e) => ({ ...e, archivo: undefined })); }}
        />
      </Seccion>

      <FlitCard>
        {envioIncierto
          ? (
            <div className="space-y-2">
              <p role="alert" className="text-sm font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>
                No sabemos si la solicitud llegó a FLITO. Vuelva a sus SOAT y busque la placa {placa || 'del vehículo'} antes de volver a enviarla.
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

      {modal?.codigo === CodigoErrorSolicitudSoat.SOAT_VIGENTE && (
        <ModalSoatVigente
          placa={placa} fechaVencimiento={modal.fechaVencimiento}
          onConsultarOtro={consultarOtroVehiculo}
          restoreFocusRef={placaRef}
          onClose={() => { setModal(null); setVigenteCerrado(true); }}
        />
      )}

      {modal?.codigo === CodigoErrorSolicitudSoat.VIN_YA_TIENE_SOAT && (
        <ModalVinEnCola
          placa={placa} propia={modal.propia === true} estado={modal.estado} id={modal.id}
          restoreFocusRef={placaRef} onClose={() => setModal(null)}
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
    case 'placa': return errorPlaca;
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

/** Lo que la CONSULTA necesita: los cuatro identificadores, con el VIN solo si está escrito. */
function validarIdentificadores(placa: string, vin: string, p: Propietario): Errores {
  const errs: Errores = {};
  const poner = (c: CampoFormulario, m: string | null) => { if (m) errs[c] = m; };
  poner('placa', errorPlaca(placa));
  poner('tipoDocumento', errorTipoDocumento(p.tipoDocumento));
  poner('numeroDocumento', errorNumeroDocumento(p.numeroDocumento));
  poner('vin', errorVin(vin));
  return errs;
}

/** Todas las reglas a la vez, en el ORDEN VISUAL: el primero que falle es al que va el foco. */
function validarTodo(placa: string, vin: string, p: Propietario, archivo: File | null): Errores {
  const errs = validarIdentificadores(placa, vin, p);
  const poner = (c: CampoFormulario, m: string | null) => { if (m) errs[c] = m; };
  const campoNombre = (c: 'nombres' | 'apellidos' | 'razonSocial') => poner(c, validador(c, p.tipoDocumento)?.(p[c]) ?? null);
  campoNombre('razonSocial');
  campoNombre('nombres');
  campoNombre('apellidos');
  poner('correo', errorCorreo(p.correo));
  poner('celular', errorCelular(p.celular));
  poner('direccion', errorDireccion(p.direccion));
  poner('municipio', errorMunicipio(p.municipio));
  poner('departamento', errorDepartamento(p.departamento));
  if (!archivo) errs.archivo = 'Adjunte la factura de venta en PDF.';
  return errs;
}

// ─────────────────── Lo que falta para enviar, dicho por su nombre (HU #12079) ──────────────────

/** El orden VISUAL de los campos: el primero que falle es al que va el foco, y el primero que se nombra. */
const ORDEN_FOCO_BASE: CampoFormulario[] = [
  'placa', 'tipoDocumento', 'numeroDocumento', 'vin',
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
  placa: 'Placa',
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
 * El orden de la enumeración: **el del foco**, más la factura al final.
 *
 * Es el orden visual y el del tabulador, y es lo que hace la frase afirmable en un test: sin un
 * orden fijo, «faltan el correo y el celular» y «faltan el celular y el correo» serían las dos
 * correctas y ninguna comprobable.
 */
const ORDEN_FALTANTES: CampoFormulario[] = [...ORDEN_FOCO_BASE, 'archivo'];

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
  fase: Consulta['fase'], placa: string, vin: string, p: Propietario, archivo: File | null,
): string[] {
  const errs = validarTodo(placa, vin, p, archivo);
  const runt = ITEM_RUNT[fase];
  return [
    ...(runt ? [runt] : []),
    ...ORDEN_FALTANTES.filter((c) => errs[c]).map((c) => ETIQUETA_CAMPO[c]),
  ];
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
