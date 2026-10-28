// HU #14137 — completar una solicitud pendiente de la carga masiva, dentro del modal de
// `DetalleIncompletaSoat` (docs/ux/flito-soat-inicial-masiva-y-pendientes.md, «Completar»).
//
//  · Inicial («Falta la factura de venta»): caja de PDF que se envía sola al elegir el archivo; el
//    formulario NO existe hasta leer la factura. Renovación («Faltan datos del propietario»):
//    formulario visible desde el inicio con factura opcional.
//  · Advertencias sobre el formulario: VIN dudoso, OCR caído, documento distinto (el consultado manda).
//  · ÚNICA primaria: «Crear solicitud». Sin ese clic nada sale al gestor (el body lleva `confirmado: true`).
//  · Todo error va en línea con su salida, sin perder lo escrito ni el archivo; nunca el mensaje del API.
//  · Privacidad (ADR-0032): documento, correo, celular y dirección solo viven en el estado; viajan en
//    el cuerpo; nunca en URL, storage, consola ni toasts.
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { CircleAlert, Info, Loader2, RotateCw } from 'lucide-react';
import type { ExtraccionFacturaVenta, PropietarioSolicitudIncompleta, SolicitudIncompletaFila } from '@operaciones/shared-types';
import { ApiError, api } from '../../../lib/api';
import { camposLeidos, esNit } from '../../../lib/soatCliente';
import AvisoProcesando from '../../flit/AvisoProcesando';
import FlitUploadBox from '../../flit/FlitUploadBox';
import { toastOk } from '../../flit/ToastFlito';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import { BloquePropietario, PROPIETARIO_VACIO, type CampoPropietario, type Propietario } from '../soat-cliente/bloques';
import { codigoDe } from '../soat-cliente/masivo/copyMasivo';
import { ORDEN_FOCO_BASE, validador } from '../soat-cliente/validacionSolicitud';

const CAJA = { background: 'var(--flit-bg-app)', borderColor: 'var(--flit-border-soft)' } as const;
const MAX_BYTES = 15 * 1024 * 1024;
const RAZON = 'Complete los datos del propietario para crear la solicitud.';

type ErrorFactura = 'vin' | 'formato' | 'red';
type ErrorCrear = 'runt' | 'red';
interface Lectura { nombre: string; lectura: 'ok' | 'no_disponible'; vinVerificado: boolean; documentoDifiere: boolean }
interface RespuestaFactura {
  extraccion: ExtraccionFacturaVenta; lectura: 'ok' | 'no_disponible'; vinVerificado: boolean; documentoDifiere: boolean;
}

const TEXTO_ERROR_FACTURA: Record<ErrorFactura, string> = {
  vin: 'El VIN de la factura no coincide con el de la solicitud. Cargue la factura correcta.',
  formato: 'Elija la factura en PDF, de hasta 15 MB.',
  red: 'No pudimos leer la factura. Revise su conexión e intente de nuevo.',
};

function inicial(p: PropietarioSolicitudIncompleta | null): Propietario {
  if (!p) return PROPIETARIO_VACIO;
  return {
    ...PROPIETARIO_VACIO,
    tipoDocumento: p.tipoDocumento ?? '', numeroDocumento: p.numeroDocumento ?? '',
    nombres: p.nombres ?? '', apellidos: p.apellidos ?? '', razonSocial: p.razonSocial ?? '',
    correo: p.correo ?? '', celular: p.celular ?? '', direccion: p.direccion ?? '',
    municipio: p.municipio ?? '', departamento: p.departamento ?? '',
  };
}

function Aviso({ tono, children, id }: { tono: 'warning' | 'neutro'; children: ReactNode; id?: string }) {
  const estilo = tono === 'warning'
    ? { background: 'var(--flit-chip-warning-bg)', color: 'var(--flit-warning-ink)' }
    : { background: 'var(--flit-chip-draft-bg)', color: 'var(--flit-chip-draft-ink)' };
  return (
    <div id={id} role="status" className="flex items-start gap-2 rounded-lg px-3 py-2 text-sm font-medium" style={estilo}>
      <Info size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
      <div className="min-w-0 space-y-0.5">{children}</div>
    </div>
  );
}

export default function CompletarIncompletaSoat({ fila, renovacion, propietario, onCompletada, onActualizarLista, onOcupado, onCerrar }: {
  fila: SolicitudIncompletaFila;
  renovacion: boolean;
  propietario: PropietarioSolicitudIncompleta | null;
  onCompletada: () => void;
  onActualizarLista: () => void;
  /** Hay una petición en vuelo: el modal no debe cerrarse. */
  onOcupado: (ocupado: boolean) => void;
  onCerrar: () => void;
}) {
  const [archivo, setArchivo] = useState<File | null>(null);
  const [leyendo, setLeyendo] = useState(false);
  const [lectura, setLectura] = useState<Lectura | null>(null);
  const [errorFactura, setErrorFactura] = useState<ErrorFactura | null>(null);
  const [prop, setProp] = useState<Propietario>(() => inicial(propietario));
  const [errores, setErrores] = useState<Partial<Record<CampoPropietario, string>>>({});
  const [creando, setCreando] = useState(false);
  const [errorCrear, setErrorCrear] = useState<ErrorCrear | null>(null);
  const [yaCambio, setYaCambio] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const hayFormulario = renovacion || lectura !== null;
  const titulo = renovacion ? 'Faltan datos del propietario' : 'Falta la factura de venta';

  const enviarFactura = async (f: File) => {
    setLeyendo(true); onOcupado(true);
    setErrorFactura(null);
    try {
      const form = await api.upload<RespuestaFactura>(`/flito/soat/cliente/incompletas/${encodeURIComponent(fila.id)}/factura`, f, 'facturaVenta');
      const leidos = camposLeidos(form.extraccion ?? {});
      setProp((p) => {
        const sig = { ...p };
        for (const [campo, dato] of Object.entries(leidos)) {
          // El documento ya consultado manda: si la factura trae otro, se avisa y NO se sobrescribe.
          if (form.documentoDifiere && (campo === 'tipoDocumento' || campo === 'numeroDocumento')) continue;
          if (dato && campo in sig) sig[campo as CampoPropietario] = dato.valor;
        }
        return sig;
      });
      setErrores({});
      setLectura({ nombre: f.name, lectura: form.lectura, vinVerificado: form.vinVerificado, documentoDifiere: form.documentoDifiere });
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 409)) setYaCambio(true);
      else if (e instanceof ApiError && e.status === 422 && codigoDe(e) === 'vin_factura_no_coincide') { setArchivo(null); setErrorFactura('vin'); }
      else if (e instanceof ApiError && e.status === 400) { setArchivo(null); setErrorFactura('formato'); }
      else setErrorFactura('red');
    } finally {
      setLeyendo(false); onOcupado(false);
    }
  };

  const elegirFactura = (f: File) => {
    if (leyendo || creando) return;
    if (!/\.pdf$/i.test(f.name) || f.size > MAX_BYTES) { setArchivo(null); setErrorFactura('formato'); return; }
    setArchivo(f);
    void enviarFactura(f);
  };

  const validar = (): Partial<Record<CampoPropietario, string>> => {
    const errs: Partial<Record<CampoPropietario, string>> = {};
    for (const c of ORDEN_FOCO_BASE) {
      const m = validador(c, prop.tipoDocumento)?.(prop[c as CampoPropietario]) ?? null;
      if (m) errs[c as CampoPropietario] = m;
    }
    return errs;
  };
  const completo = Object.keys(validar()).length === 0;

  const crear = async () => {
    const errs = validar();
    setErrores(errs);
    if (Object.keys(errs).length > 0) {
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setCreando(true); onOcupado(true); setErrorCrear(null);
    const juridica = esNit(prop.tipoDocumento);
    try {
      await api.post(`/flito/soat/cliente/incompletas/${encodeURIComponent(fila.id)}/confirmar`, {
        confirmado: true,
        tipoDocumento: prop.tipoDocumento, numeroDocumento: prop.numeroDocumento.trim(),
        ...(juridica ? { razonSocial: prop.razonSocial.trim() } : { nombres: prop.nombres.trim(), apellidos: prop.apellidos.trim() }),
        correo: prop.correo.trim(), celular: prop.celular.trim(), direccion: prop.direccion.trim(),
        municipio: prop.municipio.trim(), departamento: prop.departamento.trim(),
      });
      toastOk('Solicitud creada y enviada al gestor.', { id: 'soat-incompleta-creada' });
      onCompletada();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 409)) setYaCambio(true);
      else if (e instanceof ApiError && e.status === 422) setErrorCrear('runt');
      else setErrorCrear('red');
    } finally {
      setCreando(false); onOcupado(false);
    }
  };

  const onSubmit = (ev: FormEvent) => { ev.preventDefault(); if (!creando) void crear(); };
  const pie = 'mt-4 flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:flex-wrap sm:justify-end';
  const bordePie = { borderColor: 'var(--flit-border-soft)' } as const;
  const botonCerrar = (
    <button type="button" className={`${flitBtnSecondary} w-full justify-center sm:w-auto`} style={flitBtnSecondaryStyle}
      disabled={creando} onClick={onCerrar}>Cerrar</button>
  );

  if (yaCambio) {
    return (
      <section className="space-y-2 rounded-lg border p-3" style={CAJA} aria-label="Solicitud ya completada">
        <p role="alert" className="font-semibold" style={{ color: 'var(--flit-danger-text)' }}>
          Esta solicitud ya fue completada por otra persona. Actualice la lista para verla.
        </p>
        <div className={pie} style={bordePie}>
          <button type="button" className={`${flitBtnPrimary} w-full justify-center sm:w-auto`} style={flitBtnPrimaryStyle} onClick={onActualizarLista}>
            Actualizar lista
          </button>
        </div>
      </section>
    );
  }

  const cajaFactura = (
    <div className="space-y-2">
      <div className={leyendo ? 'pointer-events-none opacity-60' : undefined} aria-busy={leyendo}>
        <FlitUploadBox
          label={archivo?.name ?? (renovacion ? 'Elegir la factura de venta (PDF, opcional)' : 'Elegir la factura de venta (PDF)')}
          state={leyendo ? 'uploading' : errorFactura && errorFactura !== 'red' ? 'rejected' : lectura ? 'verified' : 'idle'}
          count={1} accept=".pdf" hint="PDF · hasta 15 MB" alcanzable
          describedBy={errorFactura ? 'completar-error-factura' : undefined}
          onFile={elegirFactura}
        />
      </div>
      {leyendo && <AvisoProcesando texto="Leyendo la factura…" />}
      {errorFactura && !leyendo && (
        <div className="flex flex-wrap items-center gap-3">
          <p id="completar-error-factura" role="alert" className="min-w-0 text-sm font-semibold" style={{ color: 'var(--flit-danger-text)' }}>
            {TEXTO_ERROR_FACTURA[errorFactura]}
          </p>
          {errorFactura === 'red' && archivo && (
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => { void enviarFactura(archivo); }}>
              <RotateCw size={16} aria-hidden="true" className="shrink-0" />
              Reintentar
            </button>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-lg border p-3" style={CAJA} aria-labelledby="completar-titulo">
        <h3 id="completar-titulo" className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
          {lectura ? 'Revise los datos del propietario' : titulo}
        </h3>
        <p style={{ color: 'var(--flit-text-secondary)' }}>
          {lectura
            ? (lectura.lectura === 'ok'
              ? `Los leímos de la factura de venta (${lectura.nombre}). Revíselos antes de crear la solicitud.`
              : 'Escriba los datos del propietario a mano.')
            : renovacion
              ? 'Si tiene la factura de venta, puede cargarla (opcional) y llenamos los datos por usted.'
              : 'Cargue la factura de venta en PDF. Revisaremos que el VIN coincida y llenaremos los datos del propietario por usted.'}
        </p>
        {cajaFactura}
      </section>

      {lectura && (
        <div className="space-y-2">
          {!lectura.vinVerificado && (
            <Aviso tono="warning">
              <p>No pudimos confirmar el VIN de la factura; compárelo con el de la solicitud.</p>
              {fila.vin && <p className="font-normal">VIN de la solicitud: <span className="font-mono">{fila.vin}</span></p>}
            </Aviso>
          )}
          {lectura.lectura === 'no_disponible' && (
            <Aviso tono="neutro">No pudimos leer la factura, pero quedó guardada. Escriba los datos del propietario a mano.</Aviso>
          )}
          {lectura.documentoDifiere && (
            <Aviso tono="warning">El documento de la factura es distinto al que consultamos en el RUNT. Dejamos el del RUNT; revise que sea correcto.</Aviso>
          )}
        </div>
      )}

      {hayFormulario ? (
        <form ref={formRef} aria-label="Datos del propietario" noValidate onSubmit={onSubmit} aria-busy={creando || undefined}>
          {errorCrear && (
            <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 text-sm font-semibold" style={{ color: 'var(--flit-danger-text)' }}>
              <CircleAlert size={16} aria-hidden="true" className="shrink-0" />
              <p className="min-w-0 flex-1 basis-48">
                {errorCrear === 'runt'
                  ? 'El documento no corresponde al registrado en el RUNT para este vehículo. Revise el número de documento.'
                  : 'No pudimos crear la solicitud. Lo que escribió sigue aquí; intente de nuevo.'}
              </p>
              {errorCrear === 'red' && (
                <button type="button" className={`${flitBtnSecondary} w-full justify-center sm:w-auto`} style={flitBtnSecondaryStyle} disabled={creando} onClick={() => { void crear(); }}>
                  <RotateCw size={16} aria-hidden="true" className="shrink-0" />
                  Reintentar
                </button>
              )}
            </div>
          )}
          <fieldset disabled={creando} className="min-w-0 border-0 p-0">
            <BloquePropietario
              valor={prop} errores={errores} prellenado={lectura?.lectura === 'ok'}
              onCambio={(c, v) => { setProp((p) => ({ ...p, [c]: v })); setErrores((e) => ({ ...e, [c]: undefined })); }}
              onBlur={(c) => {
                const m = validador(c, prop.tipoDocumento)?.(prop[c]) ?? null;
                setErrores((e) => ({ ...e, [c]: m ?? undefined }));
              }}
            />
          </fieldset>
          <p className="mt-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            Al pulsar «Crear solicitud», la solicitud sale al gestor.
          </p>
          {!completo && !creando && <p id="completar-razon" className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{RAZON}</p>}
          <div className={pie} style={bordePie}>
            {botonCerrar}
            <button type="submit" className={`${flitBtnPrimary} w-full justify-center sm:w-auto`} style={flitBtnPrimaryStyle}
              aria-disabled={!completo || creando || undefined} aria-busy={creando || undefined}
              aria-describedby={!completo ? 'completar-razon' : undefined}
              onClick={(ev) => { if (!completo || creando) { ev.preventDefault(); if (!creando) void crear(); } }}>
              {creando && <Loader2 size={16} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />}
              {creando ? 'Creando solicitud…' : 'Crear solicitud'}
            </button>
          </div>
        </form>
      ) : (
        <div className={pie} style={bordePie}>{botonCerrar}</div>
      )}
    </div>
  );
}
