// FLITO — canal Cliente: alta de una solicitud de SOAT sin trámite (Feature #11912, HU #11914).
//
// Diseño: docs/ux/alta-solicitud-cliente-y-consulta-runt.md · Contrato: ADR-0008 §6.
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
// Los tres descartes, para que nadie los rehaga: un **modal** sobre la cola no cabe (tres bloques,
// una ficha y dos modales de bloqueo ENCIMA) y pierde la dirección a la que volver; una **vista por
// estado sin URL** deja la subsanación del AC4 sin enlace («abra la solicitud rechazada» sin URL es
// «búsquela usted»); y un **wizard** promete pasos que se guardan cuando el AC1 dice lo contrario:
// no hay borrador, crear es enviar.
//
// ── PII ─────────────────────────────────────────────────────────────────────────────────────────
//
// Placa, VIN y documento del propietario viajan SIEMPRE en el cuerpo de un `POST`. La única PII que
// la URL toca es el uuid opaco de `/solicitud/:id`, que AGENTS.md §14 permite. Nada de «compartir el
// enlace del formulario prellenado» con query params.

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { CodigoErrorSolicitudSoat } from '@operaciones/shared-types';
import { api } from '../lib/api';
import { puedeSolicitarSoat, useAuth } from '../lib/auth';
import {
  errorArchivo, errorCorreo, errorNombre, errorNumeroDocumento, errorPlaca, errorTipoDocumento,
  errorVin, avisoVin, leerFallo, normalizarPlaca, normalizarVin,
  type FalloCanal, type PreconsultaRunt,
} from '../lib/soatCliente';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import FlitModal from '../components/flit/FlitModal';
import StatusChip from '../components/flit/StatusChip';
import {
  FlitCard, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';
import FichaRunt from '../components/flito/soat-cliente/FichaRunt';
import { ModalSoatVigente, ModalVinEnCola } from '../components/flito/soat-cliente/ModalesBloqueo';
import { TarjetaCanalAjeno, TarjetaCanalDeshabilitado } from '../components/flito/soat-cliente/TarjetaCanal';
import {
  BloqueFactura, BloquePropietario, Campo, CamposDocumento, EnEspera, ID_CAMPO, PROPIETARIO_VACIO,
  Seccion, useFocoPrimerError, type CampoPropietario, type Propietario,
} from '../components/flito/soat-cliente/bloques';
import CorreccionSolicitud from '../components/flito/soat-cliente/CorreccionSolicitud';

const COLA = '/flito/soat';

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
  const reintentoRef = useRef<HTMLButtonElement>(null);

  const [placa, setPlaca] = useState('');
  const [vin, setVin] = useState('');
  const [propietario, setPropietario] = useState<Propietario>(PROPIETARIO_VACIO);
  const [prellenados, setPrellenados] = useState<ReadonlySet<CampoPropietario>>(new Set());
  const [archivo, setArchivo] = useState<File | null>(null);

  /** Lo que el RUNT resolvió, junto con CON QUÉ se preguntó: eso es lo que permite invalidarlo. */
  const [runt, setRunt] = useState<{
    datos: PreconsultaRunt; en: Date;
    placa: string; vin: string; tipoDocumento: string; numeroDocumento: string;
  } | null>(null);
  const [consultando, setConsultando] = useState(false);
  const [fallo, setFallo] = useState<FalloCanal | null>(null);
  const [modal, setModal] = useState<FalloCanal | null>(null);
  const [canalCaido, setCanalCaido] = useState(false);

  const [errores, setErrores] = useState<Errores>({});
  const [intento, setIntento] = useState(0);
  const [enviando, setEnviando] = useState(false);
  const [avisoEnvio, setAvisoEnvio] = useState<string | null>(null);
  const [envioIncierto, setEnvioIncierto] = useState(false);
  const [confirmarSalida, setConfirmarSalida] = useState(false);
  /**
   * Contador que pide el foco para el campo Placa DESPUÉS de que el modal se desmonte.
   *
   * No vale llamar a `focus()` dentro del `onClick` de «Consultar otro vehículo»: la limpieza de
   * `useFocusTrap` corre después y devuelve el foco al disparador —que en esta pantalla sigue vivo,
   * porque es el mismo botón «Consultar el RUNT»—, deshaciendo lo que acabáramos de hacer. En un
   * efecto del padre el orden se invierte: React vacía primero las limpiezas del hijo.
   */
  const [pedirFocoPlaca, setPedirFocoPlaca] = useState(0);

  // Cambiar la placa, el VIN o el documento después de una consulta buena INVALIDA el resultado.
  // Sin esto se puede enviar una solicitud con los datos técnicos de un vehículo y la placa de
  // otro, o consultar el RUNT con un documento y radicar otro: el servidor —que consulta de nuevo—
  // la rechazaría con un error que el usuario no sabría explicar.
  const invalidada = runt !== null && (
    runt.placa !== placa.trim()
    || runt.vin !== vin.trim()
    || runt.tipoDocumento !== propietario.tipoDocumento
    || runt.numeroDocumento !== propietario.numeroDocumento.trim()
  );
  const runtListo = runt !== null && !invalidada;

  const hayDatos = Boolean(placa || vin || archivo || Object.values(propietario).some(Boolean));

  // Al entrar, el foco va al `<h1>`: es la referencia desde la que se recorre la pantalla.
  useEffect(() => { tituloRef.current?.focus(); }, []);

  // Al terminar la consulta con éxito, al `<h3>` «Datos del RUNT», que es lo NUEVO que apareció. No
  // al primer campo del bloque 2: saltarse la ficha es saltarse el resultado.
  useEffect(() => { if (runt) document.getElementById('ficha-runt-titulo')?.focus(); }, [runt]);
  // Al fallar, al botón de reintento, que es la salida. La banda es `role="alert"` y se anuncia sola.
  useEffect(() => { if (fallo) reintentoRef.current?.focus(); }, [fallo]);
  useEffect(() => { if (pedirFocoPlaca) placaRef.current?.focus(); }, [pedirFocoPlaca]);

  const cambiarPropietario = (campo: CampoPropietario, v: string) => {
    setPropietario((p) => ({ ...p, [campo]: v }));
    setErrores((e) => ({ ...e, [campo]: undefined }));
  };

  const validarCampo = (campo: CampoFormulario, valor: string) => {
    const msg = validador(campo)?.(valor) ?? null;
    setErrores((e) => ({ ...e, [campo]: msg ?? undefined }));
  };

  // ── Consulta al RUNT (AC2) ──────────────────────────────────────────────────────────────────
  const consultar = async () => {
    const eP = errorPlaca(placa);
    const eV = errorVin(vin);
    const eT = errorTipoDocumento(propietario.tipoDocumento);
    const eN = errorNumeroDocumento(propietario.numeroDocumento);
    if (eP || eV || eT || eN) {
      setErrores((e) => ({
        ...e,
        placa: eP ?? undefined, vin: eV ?? undefined,
        tipoDocumento: eT ?? undefined, numeroDocumento: eN ?? undefined,
      }));
      setIntento((n) => n + 1);
      return;
    }
    setErrores((e) => ({
      ...e, placa: undefined, vin: undefined, tipoDocumento: undefined, numeroDocumento: undefined,
    }));
    setConsultando(true);
    setFallo(null);
    setModal(null);
    try {
      // PII en el cuerpo: la pasarela RUNT del canal Cliente exige el documento junto con la placa
      // (Bug #11927). Sin tipo/número el API responde 400 y la petición no debe salir.
      const datos = await api.post<PreconsultaRunt>('/flito/soat/cliente/preconsulta', {
        placa: placa.trim(),
        vin: vin.trim(),
        tipoDocumento: propietario.tipoDocumento,
        numeroDocumento: propietario.numeroDocumento.trim(),
      });
      setRunt({
        datos, en: new Date(),
        placa: placa.trim(), vin: vin.trim(),
        tipoDocumento: propietario.tipoDocumento,
        numeroDocumento: propietario.numeroDocumento.trim(),
      });
      // Prellenado: el RUNT casi nunca trae propietario y que no lo traiga NO es un fallo. Solo se
      // marca lo que de verdad llegó, y sigue siendo editable — el RUNT va detrás en una compraventa
      // reciente, que es justo el caso de uso de este canal.
      if (datos.propietario?.nombreCompleto) {
        setPropietario((p) => ({ ...p, nombreCompleto: datos.propietario!.nombreCompleto }));
        setPrellenados(new Set<CampoPropietario>(['nombreCompleto']));
      }
    } catch (e) {
      encajarFallo(leerFallo(e), { limpiarRunt: true });
    } finally {
      setConsultando(false);
    }
  };

  /** Un mismo error del canal se reparte en tres sitios distintos según su código. */
  const encajarFallo = (f: FalloCanal, { limpiarRunt }: { limpiarRunt: boolean }) => {
    if (f.codigo === CodigoErrorSolicitudSoat.CANAL_DESACTIVADO
      || f.codigo === CodigoErrorSolicitudSoat.SIN_COMPANIA) {
      setCanalCaido(true);
      return;
    }
    if (f.codigo === CodigoErrorSolicitudSoat.SOAT_VIGENTE
      || f.codigo === CodigoErrorSolicitudSoat.VIN_YA_TIENE_SOAT) {
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
    // Fallo de red o corte de tiempo DURANTE el envío: no se sabe si llegó. Es el mensaje que suele
    // faltar y el que más daño hace: con `flito_soat.vin` UNIQUE, un segundo envío a ciegas produce
    // el modal de «ya está en la cola» y el usuario cree que hizo algo mal cuando la primera sí entró.
    if (!limpiarRunt && f.status === 0) { setEnvioIncierto(true); return; }
    setFallo(f);
    if (limpiarRunt) setRunt(null);
  };

  // ── Envío (AC1: crear ES enviar, sin borrador) ──────────────────────────────────────────────
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
      // El éxito se anuncia UNA vez: por el toast (que ya monta `role="status"`) y no además por la
      // pantalla de destino. Dos regiones vivas para el mismo mensaje se leen dos veces.
      toast.success('Solicitud enviada. FLITO la va a revisar.');
      navigate(COLA);
    } catch (e) {
      encajarFallo(leerFallo(e), { limpiarRunt: false });
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
          subtitle="Consultamos el RUNT con la placa, el VIN y el documento del propietario; después usted completa el resto de sus datos y adjunta la factura de venta. Al enviarla queda en revisión de FLITO."
        />
      </div>

      {/* ── Bloque 1 · Vehículo ─────────────────────────────────────────────────────────────── */}
      <Seccion titulo="1 · Vehículo" chip={runtListo ? <StatusChip tone="success">Consultado</StatusChip> : undefined}>
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

        <div className="mt-3">
          <CamposDocumento
            valor={propietario} onCambio={cambiarPropietario} errores={errores}
            onBlur={(campo) => validarCampo(campo, propietario[campo])}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={runtListo ? flitBtnSecondary : flitBtnPrimary}
            style={runtListo ? flitBtnSecondaryStyle : flitBtnPrimaryStyle}
            disabled={consultando}
            onClick={consultar}
          >
            {consultando ? 'Consultando el RUNT…' : runt ? 'Consultar de nuevo' : 'Consultar el RUNT'}
          </button>
        </div>
        {/* Región viva SOLO mientras se consulta. Informa, no interrumpe: `role="status"`. */}
        {consultando && (
          <p role="status" className="mt-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            La consulta puede tardar hasta un minuto. No cierre esta página.
          </p>
        )}

        {!runt && !fallo && !consultando && (
          <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            La marca, la línea, el modelo, la clase, el servicio, el cilindraje y el organismo de
            tránsito los trae el RUNT. Usted no tiene que escribirlos.
          </p>
        )}

        {fallo && <BandaFalloRunt fallo={fallo} placa={placa} onReintentar={consultar} botonRef={reintentoRef} />}

        {invalidada && (
          <p role="alert" className="mt-3 text-xs font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>
            Cambió la placa, el VIN o el documento: vuelva a consultar el RUNT antes de enviar.
          </p>
        )}

        {runtListo && (
          <div className="mt-3">
            <FichaRunt datos={runt!.datos} consultadoEn={runt!.en} />
          </div>
        )}
      </Seccion>

      {/* ── Bloque 2 · Propietario ──────────────────────────────────────────────────────────── */}
      <Seccion titulo="2 · Propietario">
        {runtListo
          ? (
            <BloquePropietario
              valor={propietario} onCambio={cambiarPropietario} errores={errores}
              onBlur={(campo) => validarCampo(campo, propietario[campo])}
              prellenados={prellenados}
              omitirDocumento
            />
          )
          : <EnEspera />}
      </Seccion>

      {/* ── Bloque 3 · Factura de venta ─────────────────────────────────────────────────────── */}
      <Seccion titulo="3 · Factura de venta">
        {runtListo
          ? (
            <BloqueFactura
              archivo={archivo} error={errores.archivo}
              onElegir={(f) => {
                const err = errorArchivo(f);
                setErrores((e) => ({ ...e, archivo: err ?? undefined }));
                setArchivo(err ? null : f);
              }}
              onQuitar={() => { setArchivo(null); setErrores((e) => ({ ...e, archivo: undefined })); }}
            />
          )
          : <EnEspera />}
      </Seccion>

      {runt && (
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
                <div className="flex flex-wrap justify-end gap-2">
                  <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={salir}>
                    Cancelar
                  </button>
                  {/* Solo `runtListo` y `enviando` deshabilitan. Un bloque 2 incompleto NO: el AC de
                      accesibilidad pide que pulsar Enviar marque los campos y lleve el foco al
                      primero, y un botón muerto no puede hacer ninguna de las dos cosas. */}
                  <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
                    disabled={enviando || !runtListo} onClick={enviar}>
                    {enviando ? 'Enviando…' : 'Enviar la solicitud'}
                  </button>
                </div>
              </div>
            )}
        </FlitCard>
      )}

      {modal?.codigo === CodigoErrorSolicitudSoat.SOAT_VIGENTE && (
        <ModalSoatVigente
          placa={placa} fechaVencimiento={modal.fechaVencimiento}
          restoreFocusRef={placaRef}
          onClose={() => setModal(null)}
          onConsultarOtro={() => {
            setModal(null); setPlaca(''); setVin(''); setRunt(null); setFallo(null);
            setPedirFocoPlaca((n) => n + 1);
          }}
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

// ───────────────────────────── La banda de error de la consulta (AC2) ────────────────────────────

/**
 * **Tres textos distintos y no uno.** Un único «no se pudo consultar el RUNT» dejaría al usuario
 * eligiendo entre esperar, revisar lo que escribió y escribirle a FLIT, que son tres acciones
 * opuestas. Es el mismo criterio que `CertificacionRunt.tsx` ya aplica con sus cinco desenlaces.
 *
 * Lo tecleado **no se borra** en ninguno de los tres: la placa y el VIN siguen en sus campos.
 */
function BandaFalloRunt({ fallo, placa, onReintentar, botonRef }: {
  fallo: FalloCanal; placa: string; onReintentar: () => void;
  botonRef: RefObject<HTMLButtonElement>;
}) {
  const catalogo = fallo.codigo === CodigoErrorSolicitudSoat.ORGANISMO_NO_CATALOGADO;
  const sinRegistro = fallo.codigo === CodigoErrorSolicitudSoat.RUNT_SIN_REGISTRO;

  const titulo = catalogo
    ? 'Todavía no atendemos el organismo de tránsito de este vehículo.'
    : sinRegistro
      ? 'El RUNT no tiene registrado ningún vehículo con esa placa y ese VIN.'
      : 'No pudimos consultar el RUNT.';

  const cuerpo = catalogo
    ? cuerpoOrganismo(fallo, placa)
    : sinRegistro
      ? 'Verifique los dos datos en la tarjeta de propiedad. Si son correctos y el vehículo es nuevo, es posible que el RUNT todavía no lo haya indexado.'
      : 'El servicio no respondió. Vuelva a intentarlo en unos minutos; la placa y el VIN siguen escritos aquí.';

  return (
    <div role="alert" className="mt-3 space-y-2 rounded-[10px] p-3"
      style={{ border: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}>
      <p className="text-sm font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>{titulo}</p>
      <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{cuerpo}</p>
      {/* En el caso del catálogo el reintento es SECUNDARIO: volver a consultar no cambia el
          catálogo de FLITO, así que no se le da la forma de «la acción que resuelve esto». */}
      <button ref={botonRef} type="button" onClick={onReintentar}
        className={catalogo ? flitBtnSecondary : flitBtnPrimary}
        style={catalogo ? flitBtnSecondaryStyle : flitBtnPrimaryStyle}>
        Volver a consultar
      </button>
    </div>
  );
}

/**
 * El cuerpo del 422 de organismo, elegido por el CAMPO `organismoNombre` y no por el texto.
 *
 * Los tres estados del campo son tres cosas distintas y por eso hay tres salidas:
 *
 *   · **nombre** → se nombra: es lo que le permite al usuario reconocer su organismo y citarlo
 *     cuando escriba a FLIT.
 *   · **`null`** → el servidor AFIRMA que el RUNT no lo reporta, así que la pantalla puede
 *     afirmarlo también. Sin ese dato no hay a qué proveedor mandar el caso y no se puede radicar.
 *   · **ausente** → nadie ha afirmado nada sobre el RUNT (un servidor anterior a este contrato). Se
 *     usa el mensaje del servidor tal cual: es correcto y no inventa una afirmación que no se tiene.
 */
function cuerpoOrganismo(fallo: FalloCanal, placa: string): string {
  if (fallo.organismoNombre === undefined) return fallo.mensaje;
  if (fallo.organismoNombre === null) {
    return 'El RUNT no reporta el organismo de tránsito de este vehículo, y sin ese dato no podemos radicar la solicitud.';
  }
  return `El RUNT lo reporta en ${fallo.organismoNombre}, que aún no está habilitado en FLITO. Escríbale a su contacto en FLIT con la placa ${placa}.`;
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
    // Teléfono y dirección son opcionales y sin formato: la longitud la corta `maxLength`.
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
