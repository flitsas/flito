// FLITO — canal Cliente: alta de una solicitud de SOAT sin trámite (Feature #11912).
//
// Diseño: docs/ux/flito-soat-formulario-un-paso-y-ficha-runt.md (HU #11936) · Contrato: ADR-0008 §6.
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
// es enviar. El RUNT ya no es un paso del Cliente (HU #11936): un solo `POST /cliente`.
//
// ── PII ─────────────────────────────────────────────────────────────────────────────────────────
//
// Placa, VIN y documento del propietario viajan SIEMPRE en el cuerpo de un `POST`. La única PII que
// la URL toca es el uuid opaco de `/solicitud/:id`, que AGENTS.md §14 permite.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { CodigoErrorSolicitudSoat } from '@operaciones/shared-types';
import { api } from '../lib/api';
import { puedeSolicitarSoat, useAuth } from '../lib/auth';
import {
  errorArchivo, errorCorreo, errorNombre, errorNumeroDocumento, errorPlaca, errorTipoDocumento,
  errorVin, avisoVin, leerFallo, normalizarPlaca, normalizarVin,
  type FalloCanal,
} from '../lib/soatCliente';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import FlitModal from '../components/flit/FlitModal';
import {
  FlitCard, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';
import { ModalVinEnCola } from '../components/flito/soat-cliente/ModalesBloqueo';
import { TarjetaCanalAjeno, TarjetaCanalDeshabilitado } from '../components/flito/soat-cliente/TarjetaCanal';
import {
  BloqueFactura, BloquePropietario, Campo, ID_CAMPO, PROPIETARIO_VACIO,
  Seccion, useFocoPrimerError, type CampoPropietario, type Propietario,
} from '../components/flito/soat-cliente/bloques';
import CorreccionSolicitud from '../components/flito/soat-cliente/CorreccionSolicitud';

const COLA = '/flito/soat';
const SIN_PRELLENAR: ReadonlySet<CampoPropietario> = new Set();

type CampoFormulario = 'placa' | 'vin' | CampoPropietario | 'archivo';
type Errores = Partial<Record<CampoFormulario, string>>;

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
  const { id } = useParams<{ id: string }>();

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

  return id ? <CorreccionSolicitud id={id} /> : <Alta />;
}

// ───────────────────────────── El alta ───────────────────────────────────────────────────────────

function Alta() {
  const navigate = useNavigate();
  const tituloRef = useRef<HTMLHeadingElement>(null);
  const placaRef = useRef<HTMLInputElement>(null);

  const [placa, setPlaca] = useState('');
  const [vin, setVin] = useState('');
  const [propietario, setPropietario] = useState<Propietario>(PROPIETARIO_VACIO);
  const [archivo, setArchivo] = useState<File | null>(null);

  const [modal, setModal] = useState<FalloCanal | null>(null);
  const [canalCaido, setCanalCaido] = useState(false);

  const [errores, setErrores] = useState<Errores>({});
  const [intento, setIntento] = useState(0);
  const [enviando, setEnviando] = useState(false);
  const [avisoEnvio, setAvisoEnvio] = useState<string | null>(null);
  const [envioIncierto, setEnvioIncierto] = useState(false);
  const [confirmarSalida, setConfirmarSalida] = useState(false);

  const hayDatos = Boolean(placa || vin || archivo || Object.values(propietario).some(Boolean));

  useEffect(() => { tituloRef.current?.focus(); }, []);

  const cambiarPropietario = (campo: CampoPropietario, v: string) => {
    setPropietario((p) => ({ ...p, [campo]: v }));
    setErrores((e) => ({ ...e, [campo]: undefined }));
  };

  const validarCampo = (campo: CampoFormulario, valor: string) => {
    const msg = validador(campo)?.(valor) ?? null;
    setErrores((e) => ({ ...e, [campo]: msg ?? undefined }));
  };

  /** Un mismo error del canal se reparte según su código. El 409 de SOAT vigente ya no abre modal. */
  const encajarFallo = (f: FalloCanal) => {
    if (f.codigo === CodigoErrorSolicitudSoat.CANAL_DESACTIVADO
      || f.codigo === CodigoErrorSolicitudSoat.SIN_COMPANIA) {
      setCanalCaido(true);
      return;
    }
    if (f.codigo === CodigoErrorSolicitudSoat.VIN_YA_TIENE_SOAT) {
      setModal(f);
      return;
    }
    if (f.codigo === CodigoErrorSolicitudSoat.ARCHIVO_NO_PDF) {
      setErrores((e) => ({
        ...e,
        archivo: 'Ese archivo no es un PDF válido, aunque se llame así. Si lo exportó desde el celular, vuelva a guardarlo como PDF y súbalo otra vez.',
      }));
      setIntento((n) => n + 1);
      return;
    }
    if (f.status === 0) { setEnvioIncierto(true); return; }
    setAvisoEnvio(f.mensaje);
  };

  // ── Envío (AC1: crear ES enviar, sin borrador y sin consultar el RUNT) ────────────────────────
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
      const form = new FormData();
      form.append('placa', placa.trim());
      form.append('vin', vin.trim());
      form.append('tipoDocumento', propietario.tipoDocumento);
      form.append('numeroDocumento', propietario.numeroDocumento.trim());
      form.append('nombreCompleto', propietario.nombreCompleto.trim());
      form.append('correo', propietario.correo.trim());
      form.append('celular', propietario.celular.trim());
      form.append('direccion', propietario.direccion.trim());
      form.append('facturaVenta', archivo!);
      await api.post('/flito/soat/cliente', form);
      toast.success('Solicitud enviada. FLITO la va a revisar.');
      navigate(COLA);
    } catch (e) {
      encajarFallo(leerFallo(e));
    } finally {
      setEnviando(false);
    }
  };

  const salir = () => (hayDatos ? setConfirmarSalida(true) : navigate(COLA));

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
          subtitle="Escriba la placa, el VIN y los datos del propietario, y adjunte la factura de venta. Al enviarla queda en revisión de FLITO."
        />
      </div>

      {/* ── Bloque 1 · Vehículo ─────────────────────────────────────────────────────────────── */}
      <Seccion titulo="1 · Vehículo">
        <div className="grid gap-3 sm:grid-cols-2">
          <Campo
            id={ID_CAMPO.placa} label="Placa" valor={placa}
            onCambio={(v) => { setPlaca(normalizarPlaca(v)); setErrores((e) => ({ ...e, placa: undefined })); }}
            onBlur={() => validarCampo('placa', placa)} inputRef={placaRef}
            error={errores.placa} ayuda="Sin espacios ni guiones." maxLength={10} autoComplete="off"
          />
          <Campo
            id={ID_CAMPO.vin} label="VIN (número de chasis)" valor={vin}
            onCambio={(v) => { setVin(normalizarVin(v)); setErrores((e) => ({ ...e, vin: undefined })); }}
            onBlur={() => validarCampo('vin', vin)}
            error={errores.vin} ayuda="17 caracteres. Está en la tarjeta de propiedad." autoComplete="off"
          />
        </div>
        {avisoVin(vin) && !errores.vin && (
          <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{avisoVin(vin)}</p>
        )}
        <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          La marca, la línea, el modelo y el organismo los consulta FLITO después. Usted no tiene
          que escribirlos.
        </p>
      </Seccion>

      {/* ── Bloque 2 · Propietario (tipo + número viven aquí: ya no hay preconsulta) ────────── */}
      <Seccion titulo="2 · Propietario">
        <BloquePropietario
          valor={propietario} onCambio={cambiarPropietario} errores={errores}
          onBlur={(campo) => validarCampo(campo, propietario[campo])}
          prellenados={SIN_PRELLENAR}
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
                Al enviarla, la solicitud pasa a revisión de FLITO. No se guarda como borrador.
              </p>
              {enviando && <span role="status" className="sr-only">Enviando…</span>}
              <div className="flex flex-wrap justify-end gap-2">
                <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={salir}>
                  Cancelar
                </button>
                <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
                  disabled={enviando} onClick={enviar}>
                  {enviando ? 'Enviando…' : 'Enviar la solicitud'}
                </button>
              </div>
            </div>
          )}
      </FlitCard>

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

function validador(campo: CampoFormulario): ((v: string) => string | null) | null {
  switch (campo) {
    case 'placa': return errorPlaca;
    case 'vin': return errorVin;
    case 'tipoDocumento': return errorTipoDocumento;
    case 'numeroDocumento': return errorNumeroDocumento;
    case 'nombreCompleto': return errorNombre;
    case 'correo': return errorCorreo;
    default: return null;
  }
}

/** Todas las reglas a la vez, en el ORDEN VISUAL: el primero que falle es al que va el foco. */
function validarTodo(placa: string, vin: string, p: Propietario, archivo: File | null): Errores {
  const errs: Errores = {};
  const poner = (c: CampoFormulario, m: string | null) => { if (m) errs[c] = m; };
  poner('placa', errorPlaca(placa));
  poner('vin', errorVin(vin));
  poner('tipoDocumento', errorTipoDocumento(p.tipoDocumento));
  poner('numeroDocumento', errorNumeroDocumento(p.numeroDocumento));
  poner('nombreCompleto', errorNombre(p.nombreCompleto));
  poner('correo', errorCorreo(p.correo));
  if (!archivo) errs.archivo = 'Adjunte la factura de venta en PDF.';
  return errs;
}

const ORDEN_FOCO: CampoFormulario[] = [
  'placa', 'vin', 'tipoDocumento', 'numeroDocumento', 'nombreCompleto', 'correo',
];

/**
 * El id del primer control inválido, o `null`.
 *
 * `null` también cuando el primero es el tipo de documento: `FlitSelect` se enfoca a sí mismo al
 * recibir `error` y su id lo genera `useId()`. Devolver algo aquí competiría con ese foco.
 */
function primerErrorEnfocable(errores: Errores): string | null {
  const primero = ORDEN_FOCO.find((c) => errores[c]);
  if (!primero || primero === 'tipoDocumento') return null;
  return ID_CAMPO[primero as keyof typeof ID_CAMPO] ?? null;
}
