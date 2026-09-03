// FLITO — canal Cliente: subsanar una solicitud RECHAZADA (HU #11914, #11936, #11967).
//
// **Aquí NO vuelve «Consultar el RUNT»**, ni siquiera con la compuerta de la HU #11967: ningún AC lo
// pide y las solicitudes ya radicadas no se reescriben desde esta pantalla. Placa y VIN siguen de
// solo lectura; el `<dl>` de vehículo es identidad guardada, no un gate. Lo que sí cambia con la
// #11967 es el propietario: se pide PARTIDO —razón social si es NIT, o nombre/s y apellido/s— con
// contacto y ubicación obligatorios, porque el `subsanacionSchema` del backend cambió igual.
//
// ── El reparto entre HUs ─────────────────────────────────────────────────────────────────────────
//
// La **#11914** entregó esta pantalla: la ruta `/flito/soat/solicitud/:id`, la vista con sus cuatro
// estados y el enlace que llega desde el modal del AC4. Las dos piezas que le faltaban las entregó
// la **#11915**, y ya están:
//
//   · `PATCH /flito/soat/:id/solicitud` — el endpoint al que apunta «Reenviar la solicitud». Existe
//     e **está inscrito en la allowlist del canal** (`canal-cliente.ts`). Hasta la #11915 no existía
//     y un `cliente` que lo llamara recibía un 403; esta nota lo decía y sobrevivió al cambio que la
//     volvió falsa, que es exactamente cómo se pudren estos comentarios.
//   · La **causal y la observación** del rechazo, que viven en la satélite `flito_soat_solicitud`.
//     El detalle ya las trae en `solicitud`, así que el bloque «Por qué se rechazó» se llena.
//
// ── Y lo que NO se reutiliza, aunque esté a mano ────────────────────────────────────────────────
//
// `flito_soat.motivoRechazo` **no** es esto. Ese es el rechazo del GESTOR, el que manda un SOAT a
// `con_novedad` (`flito-soat.service.ts:575`): otro actor, otro estado y otra audiencia. Pintarlo
// aquí mezclaría dos rechazos distintos en un mismo párrafo y le diría al Cliente que corrija algo
// que nadie le ha pedido.

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ESTADO_SOAT_LABEL, EstadoSoat } from '@operaciones/shared-types';
import { ApiError, api, errorMessage } from '../../../lib/api';
import {
  errorApellidos, errorArchivo, errorCelular, errorCorreo, errorDepartamento, errorDireccion,
  errorMunicipio, errorNombres, errorNumeroDocumento, errorRazonSocial, errorTipoDocumento, esNit,
} from '../../../lib/soatCliente';
import PageContentSkeleton from '../../flit/PageContentSkeleton';
import PageHeaderCard from '../../flit/PageHeaderCard';
import StatusChip from '../../flit/StatusChip';
import { FlitCard, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import FichaRunt from './FichaRunt';
import {
  BloqueFactura, BloquePropietario, CAMPOS_NOMBRE, ID_CAMPO, PROPIETARIO_VACIO, Seccion,
  useFocoPrimerError, type CampoPropietario, type Propietario,
} from './bloques';

const COLA = '/flito/soat';

/**
 * Lo que esta vista lee del detalle. Es un SUBCONJUNTO de `SoatItem` a propósito: nombrar aquí los
 * campos de la trastienda —proveedor, valor pagado, quién despachó— sería declarar que existen para
 * este rol, y el servidor no se los manda.
 */
interface DetalleSolicitud {
  id: string;
  estado: EstadoSoat;
  vin: string;
  placa: string | null;
  marca: string | null;
  linea: string | null;
  cilindraje: string | null;
  tipoServicio: string | null;
  carroceria: string | null;
  organismoNombre: string | null;
  compradores: Array<{ nombreCompleto: string; numeroDocumento: string; orden: number }>;
  /**
   * El titular GUARDADO, ya partido (HU #11966). Solo llega para el dueño de la fila y solo cuando
   * la solicitud nació del canal (`origen = 'cliente'`); un gestor no lo recibe nunca por esta ruta.
   *
   * Es lo que evita que la subsanación obligue a reteclear a ciegas el nombre repartido, el
   * municipio y el departamento que ya están en la base. Si no viene —una fila de trámite, o una API
   * anterior a la #11966— los campos salen vacíos y se dice por qué: **el nombre fundido de
   * `compradores` NO se reparte por el espacio**, ni aquí ni en ningún sitio.
   */
  propietarioCanal?: {
    tipoDocumento: string | null;
    nombres: string | null;
    apellidos: string | null;
    razonSocial: string | null;
    numeroDocumento: string;
    correo: string | null;
    celular: string | null;
    direccion: string | null;
    municipio: string | null;
    departamento: string | null;
  } | null;
  /** Lo escribe la HU #11915. Ausente hoy, y su ausencia no rompe nada. */
  solicitud?: { causalNombre: string | null; observacion: string | null; revisadoEn: string | null } | null;
}

export default function CorreccionSolicitud({ id }: { id: string }) {
  const [datos, setDatos] = useState<DetalleSolicitud | null>(null);
  const [error, setError] = useState<{ mensaje: string; noEncontrada: boolean } | null>(null);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    let vivo = true;
    setDatos(null);
    setError(null);
    api.get<DetalleSolicitud>(`/flito/soat/${id}`)
      .then((d) => { if (vivo) setDatos(d); })
      .catch((e) => {
        if (!vivo) return;
        // El aislamiento por compañía devuelve **404 y no 403** (`buscarConAcceso`): que una
        // solicitud sea de otra compañía y que no exista tienen que verse igual, o el 403 confirmaría
        // su existencia a quien prueba uuids.
        setError({ mensaje: errorMessage(e), noEncontrada: e instanceof ApiError && e.status === 404 });
      });
    return () => { vivo = false; };
  }, [id, recarga]);

  if (error) {
    return (
      <Envoltura>
        <FlitCard>
          <div className="space-y-3">
            <p role="alert" className="text-sm font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>
              {error.noEncontrada
                ? 'Esta solicitud no existe o no es de su compañía.'
                : 'No pudimos cargar esta solicitud.'}
            </p>
            <div className="flex flex-wrap gap-2">
              {!error.noEncontrada && (
                <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
                  onClick={() => setRecarga((n) => n + 1)}>Reintentar</button>
              )}
              <Link to={COLA} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>Volver a mis SOAT</Link>
            </div>
          </div>
        </FlitCard>
      </Envoltura>
    );
  }

  // Es la única pantalla del Feature que carga por id y no puede pintar nada antes.
  if (!datos) return <PageContentSkeleton />;

  // El caso real que se olvida: entre que el Cliente abre el enlace y lo edita, un admin pudo
  // revisarla. Sin este texto se vería un error crudo DESPUÉS de rellenar el formulario entero.
  if (datos.estado !== EstadoSoat.RECHAZADA) {
    return (
      <Envoltura>
        <FlitCard>
          <div className="space-y-3">
            <StatusChip tone="warning">{ESTADO_SOAT_LABEL[datos.estado]}</StatusChip>
            <p role="alert" className="text-sm">
              Esta solicitud ya no está rechazada: FLITO la está revisando. No hay nada que corregir
              por ahora.
            </p>
            <Link to={COLA} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>Volver a mis SOAT</Link>
          </div>
        </FlitCard>
      </Envoltura>
    );
  }

  return <Formulario datos={datos} />;
}

function Envoltura({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <PageHeaderCard title="Corregir la solicitud" />
      {children}
    </div>
  );
}

/** Mismo orden VISUAL que el alta, para que el foco caiga siempre en el primer campo que falla. */
const ORDEN_FOCO: Array<CampoPropietario | 'archivo'> = [
  'tipoDocumento', 'numeroDocumento', ...CAMPOS_NOMBRE,
  'correo', 'celular', 'direccion', 'municipio', 'departamento',
];

// ───────────────────────────── El formulario en modo edición ─────────────────────────────────────

function Formulario({ datos }: { datos: DetalleSolicitud }) {
  const navigate = useNavigate();
  const guardado = datos.propietarioCanal ?? null;
  const duenio = datos.compradores.find((c) => c.orden === 0) ?? datos.compradores[0] ?? null;

  // Se prellena con lo PERSISTIDO, que es lo honesto: son sus propios datos, ya guardados, y
  // pedírselos otra vez a ciegas para poder reenviar es peor producto. Del `compradores` solo se
  // rescata el número de documento cuando el detalle no trae el titular partido; el nombre fundido
  // NO se reparte por el espacio.
  const [propietario, setPropietario] = useState<Propietario>({
    ...PROPIETARIO_VACIO,
    tipoDocumento: guardado?.tipoDocumento ?? '',
    numeroDocumento: guardado?.numeroDocumento ?? duenio?.numeroDocumento ?? '',
    nombres: guardado?.nombres ?? '',
    apellidos: guardado?.apellidos ?? '',
    razonSocial: guardado?.razonSocial ?? '',
    correo: guardado?.correo ?? '',
    celular: guardado?.celular ?? '',
    direccion: guardado?.direccion ?? '',
    municipio: guardado?.municipio ?? '',
    departamento: guardado?.departamento ?? '',
  });
  const [archivo, setArchivo] = useState<File | null>(null);
  const [errores, setErrores] = useState<Partial<Record<CampoPropietario | 'archivo', string>>>({});
  const [intento, setIntento] = useState(0);
  const [enviando, setEnviando] = useState(false);
  const [fallo, setFallo] = useState<string | null>(null);

  const juridica = esNit(propietario.tipoDocumento);
  const idPrimerError = useMemo(
    () => {
      const primero = ORDEN_FOCO.find((c) => errores[c]);
      if (!primero || primero === 'tipoDocumento') return null;
      return ID_CAMPO[primero as keyof typeof ID_CAMPO] ?? null;
    },
    [errores],
  );
  useFocoPrimerError(idPrimerError, intento);

  const reenviar = async () => {
    const errs: Partial<Record<CampoPropietario | 'archivo', string>> = {};
    const poner = (c: CampoPropietario, m: string | null) => { if (m) errs[c] = m; };
    poner('tipoDocumento', errorTipoDocumento(propietario.tipoDocumento));
    poner('numeroDocumento', errorNumeroDocumento(propietario.numeroDocumento));
    // El tipo decide qué campo de nombre se exige, igual que el `superRefine` del backend: pedirle
    // apellidos a un NIT sería exigir un dato que el servidor rechaza.
    if (juridica) poner('razonSocial', errorRazonSocial(propietario.razonSocial));
    else {
      poner('nombres', errorNombres(propietario.nombres));
      poner('apellidos', errorApellidos(propietario.apellidos));
    }
    poner('correo', errorCorreo(propietario.correo));
    poner('celular', errorCelular(propietario.celular));
    poner('direccion', errorDireccion(propietario.direccion));
    poner('municipio', errorMunicipio(propietario.municipio));
    poner('departamento', errorDepartamento(propietario.departamento));
    setErrores(errs);
    setIntento((n) => n + 1);
    if (Object.keys(errs).length > 0) { setFallo('Revise los datos marcados antes de enviar.'); return; }

    setFallo(null);
    setEnviando(true);
    try {
      const form = new FormData();
      form.append('tipoDocumento', propietario.tipoDocumento);
      form.append('numeroDocumento', propietario.numeroDocumento.trim());
      // Razón social XOR nombre/s + apellido/s, y `nombreCompleto` ya no viaja: lo deriva el
      // servidor. Mandarlo dejaría dos fuentes de verdad para el mismo nombre.
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
      // Opcional: sin archivo nuevo se conserva el que ya está cargado.
      if (archivo) form.append('facturaVenta', archivo);
      // Placa y VIN NO viajan: cambiarlos convertiría la subsanación en un alta encubierta sobre
      // otro vehículo. Si el vehículo era otro, lo correcto es un alta nueva.
      await api.patch(`/flito/soat/${datos.id}/solicitud`, form);
      toast.success('Solicitud enviada. FLITO la va a revisar.');
      navigate(COLA);
    } catch (e) {
      setFallo(errorMessage(e));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeaderCard
        title="Corregir la solicitud"
        subtitle="Corrija lo que se le indica y vuelva a enviarla. Al reenviarla vuelve a revisión de FLITO."
      />

      {/* El bloque del rechazo va ARRIBA y en tarjeta, no en un modal: es lo que hay que corregir y
          tiene que estar a la vista MIENTRAS se corrige, no dos clics atrás. */}
      {datos.solicitud?.causalNombre && (
        <FlitCard>
          <h2 className="mb-2 text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>Por qué se rechazó</h2>
          <p className="text-sm font-semibold">{datos.solicitud.causalNombre}</p>
          {datos.solicitud.observacion && <p className="mt-1 text-sm">«{datos.solicitud.observacion}»</p>}
          {datos.solicitud.revisadoEn && (
            <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
              {new Date(datos.solicitud.revisadoEn).toLocaleDateString('es-CO', { dateStyle: 'short' })}
            </p>
          )}
        </FlitCard>
      )}

      <Seccion titulo="1 · Vehículo" chip={<StatusChip tone="neutral">No se puede cambiar</StatusChip>}>
        {/* Aquí —y SOLO aquí— la placa y el VIN entran a la ficha: no son el eco de una consulta,
            son lo que ya está guardado. */}
        <FichaRunt
          identificadoresGuardados={{ placa: datos.placa ?? '—', vin: datos.vin }}
          consultadoEn={new Date()}
          datos={{
            vehiculo: {
              placa: datos.placa, vin: datos.vin, marca: datos.marca, linea: datos.linea,
              modelo: null, clase: null, cilindraje: datos.cilindraje, tipoServicio: datos.tipoServicio,
              carroceria: datos.carroceria,
              // El detalle no los proyecta y la ficha no los pinta: no se inventan.
              pasajerosSentados: null, puertas: null,
            },
            organismo: { codigo: null, nombre: datos.organismoNombre },
            propietario: null,
          }}
        />
      </Seccion>

      <Seccion titulo="2 · Propietario">
        {!guardado && (
          <p className="mb-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            Complete los datos del propietario para poder reenviar la solicitud.
          </p>
        )}
        <BloquePropietario
          valor={propietario}
          onCambio={(campo, v) => {
            setPropietario((p) => ({ ...p, [campo]: v }));
            setErrores((e) => ({ ...e, [campo]: undefined }));
            // Al conmutar NIT ⇄ persona natural se descartan los errores de los TRES campos de
            // nombre: `useFocoPrimerError` enfoca por `id`, y un error huérfano de un control que ya
            // no está en el DOM manda el foco a `<body>`.
            if (campo === 'tipoDocumento') {
              setErrores((e) => ({ ...e, nombres: undefined, apellidos: undefined, razonSocial: undefined }));
            }
          }}
          errores={errores}
          // Aquí el documento SÍ es editable: no alimenta ninguna consulta, así que cambiarlo no
          // invalida nada.
          documento={{ modo: 'editable' }}
          onBlur={() => undefined}
        />
      </Seccion>

      <Seccion titulo="3 · Factura de venta">
        <BloqueFactura
          archivo={archivo} error={errores.archivo}
          rotulo="Factura de venta ya cargada. Suba otra solo si la va a cambiar."
          onElegir={(f) => {
            const err = errorArchivo(f);
            setErrores((e) => ({ ...e, archivo: err ?? undefined }));
            setArchivo(err ? null : f);
          }}
          onQuitar={() => { setArchivo(null); setErrores((e) => ({ ...e, archivo: undefined })); }}
        />
      </Seccion>

      <FlitCard>
        <div className="space-y-3">
          {fallo && (
            <p role="alert" className="text-sm font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>{fallo}</p>
          )}
          <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            Al reenviarla vuelve a revisión de FLITO.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Link to={COLA} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>Cancelar</Link>
            <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
              disabled={enviando} onClick={reenviar}>
              {enviando ? 'Enviando…' : 'Reenviar la solicitud'}
            </button>
          </div>
        </div>
      </FlitCard>
    </div>
  );
}
