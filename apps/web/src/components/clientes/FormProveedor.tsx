// Modal de proveedor: alta, edición y detalle de solo lectura en un solo formulario (HU #14336, ADR-0039 §7.1).
// Diseño: `docs/ux/proveedores-servicios-14324-slim.md`.
//
//   · Los servicios deciden qué más se pide: los datos de SOAT solo se ven y se envían con SOAT marcado, pero lo escrito
//     no se borra al desmarcarlo. Son opcionales.
//   · Datos generales (R9): obligatorios al crear y en edición. Un proveedor antiguo con `datosCompletos = false` puede
//     guardar otros cambios sin completarlos; si cambia uno de ellos o agrega un servicio, se piden los siete. «Cambiar» es
//     que el valor quede distinto del inicial, no enfocar el campo.
//   · Una sola petición: `PATCH /:id` lleva datos, servicios y `versionEsperada` en una transacción.
//   · El estado (activo/inactivo) no se cambia aquí sino en el ⋮ de la fila, y todo proveedor nace activo.
//   · Edición: el detalle se pide al abrir, con cargando y error con reintento dentro del modal (AC9).
//
// Únicos textos del API que se muestran tal cual: NIT o nombre repetido y «No puede quitar…», que el servidor redacta para
// el usuario con el nombre y las cantidades. Cualquier otro fallo dice una frase propia.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  CODIGO_PROVEEDOR_EDITADO_POR_OTRO, MENSAJE_SIN_SERVICIO, SERVICIOS_PROVEEDOR, SERVICIO_PROVEEDOR_LABEL,
  type CrearProveedorBody, type EditarProveedorBody, type ProveedorDetalleDto, type ProveedorGeneralesBody, type ServicioProveedor,
} from '@operaciones/shared-types';
import { toastOk } from '../flit/ToastFlito';
import { api, ApiError } from '../../lib/api';
import FlitModal from '../flit/FlitModal';
import StatusChip from '../flit/StatusChip';
import {
  flitInp, FlitField, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../flit/flitPageKit';
import { ErrorNit as ErrorCampo } from './nitDuplicado';
import { RUTA_UNIFICADA, cargarDetalleProveedor, serviciosEnOrden, textoCompaniasAsignadas, textoUmbral } from './proveedoresDatos';

const NIT_VALIDO = /^\d{5,15}(-\d)?$/;
const CORREO_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ERROR_NIT = 'Escriba el NIT solo con números, con dígito de verificación opcional (ej. 900123456-7).';
const ERROR_CORREO = 'Escriba un correo válido, por ejemplo contacto@empresa.com.';
const ERROR_OBLIGATORIO = 'Este dato es obligatorio.';
const ERROR_SOAT = 'Revise los datos de SOAT: el umbral OCR va de 0 a 1 y el ANS pactado es un número entero de horas mayor que cero.';
const NOTA_EMPRESA = 'Los proveedores de FLITO son empresas: registre el nombre y el NIT de la empresa, no los de una persona natural.';
const normalizarNit = (v: string) => v.replace(/[.\s]/g, '').replace(/–|—/g, '-');

const CAMPOS = ['nombre', 'nit', 'telefono', 'correo', 'direccion', 'ciudad', 'contacto'] as const;
type Campo = (typeof CAMPOS)[number];
const esCampo = (c: unknown): c is Campo => CAMPOS.includes(c as Campo);

const DUPLICADO = /^Ya existe un proveedor con ese (nombre|NIT): .+$/;
const NO_QUITABLE = /^No puede quitar .+: .+$/;

const cuerpoDe = (e: unknown) => (e instanceof ApiError ? (e.rawDetails as Record<string, unknown> | null | undefined) : null);
const textoDe = (e: ApiError) => {
  const error = cuerpoDe(e)?.error;
  return (typeof error === 'string' ? error : e.message).trim();
};

/** El 409 de nombre o NIT repetido: se muestra tal cual, bajo su campo. */
export function duplicadoProveedor(e: unknown): { campo: 'nombre' | 'nit'; texto: string } | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const texto = textoDe(e);
  const m = DUPLICADO.exec(texto);
  return m ? { campo: m[1] === 'NIT' ? 'nit' : 'nombre', texto } : null;
}

/** El 409 de quitar un servicio: el texto compuesto por el servidor y el servicio, que debe volver a quedar marcado. */
export function servicioNoQuitable(e: unknown): { servicio: ServicioProveedor; texto: string } | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const servicio = cuerpoDe(e)?.servicio;
  const texto = textoDe(e);
  return NO_QUITABLE.test(texto) && SERVICIOS_PROVEEDOR.includes(servicio as ServicioProveedor)
    ? { servicio: servicio as ServicioProveedor, texto } : null;
}

const esEdicionSimultanea = (e: unknown) =>
  e instanceof ApiError && e.status === 409 && cuerpoDe(e)?.code === CODIGO_PROVEEDOR_EDITADO_POR_OTRO;

/** Cualquier otro fallo al guardar: frase propia, nunca el texto crudo del API. */
export function mensajeErrorGuardar(e: unknown): string {
  const status = e instanceof ApiError ? e.status : 0;
  if (status === 403) return 'No tiene permiso para esta acción.';
  if (status === 404) return 'Este proveedor ya no existe. Cierre y vuelva a cargar la lista.';
  if (status === 400 || status === 422) return ERROR_SOAT;
  if (status === 0) return 'No pudimos conectar con FLITO. Revise su conexión e inténtelo de nuevo.';
  return 'No pudimos guardar el proveedor. Inténtelo de nuevo.';
}

interface Props {
  /** Sin él, el formulario es de alta. */
  idProveedor?: string;
  /** Para el título del detalle mientras carga. */
  nombre?: string;
  /** Detalle: campos de solo lectura y solo «Cerrar». */
  soloLectura?: boolean;
  onClose: () => void;
  onGuardado: () => void;
}

export default function FormProveedor({ idProveedor, nombre, soloLectura = false, onClose, onGuardado }: Props) {
  const [detalle, setDetalle] = useState<ProveedorDetalleDto | null>(null);
  const [errorCarga, setErrorCarga] = useState(false);
  const [intento, setIntento] = useState(0);
  // Sube al recargar tras un conflicto de edición: el formulario se reconstruye con la versión nueva.
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!idProveedor) return undefined;
    let vivo = true;
    setErrorCarga(false);
    cargarDetalleProveedor(idProveedor)
      .then((d) => { if (vivo) setDetalle(d); })
      .catch(() => { if (vivo) setErrorCarga(true); });
    return () => { vivo = false; };
  }, [idProveedor, intento]);

  const recargarTrasConflicto = async () => {
    const d = await cargarDetalleProveedor(idProveedor!);
    setDetalle(d);
    setRevision((n) => n + 1);
  };

  const titulo = soloLectura ? `Detalle de ${detalle?.nombre ?? nombre ?? 'proveedor'}` : idProveedor ? 'Editar proveedor' : 'Nuevo proveedor';
  const cargando = !!idProveedor && detalle === null;

  return (
    <FlitModal title={titulo} onClose={onClose} wide>
      {cargando ? (
        errorCarga ? (
          <div className="flex flex-col gap-3">
            <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-text)' }}>No pudimos cargar el proveedor.</p>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>Cerrar</button>
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setIntento((n) => n + 1)}>Reintentar</button>
            </div>
          </div>
        ) : (
          <p role="status" className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando proveedor…</p>
        )
      ) : (
        <CuerpoFormulario
          key={revision}
          detalle={detalle}
          soloLectura={soloLectura}
          enfocarServicios={revision > 0}
          onRecargar={recargarTrasConflicto}
          onClose={onClose}
          onGuardado={onGuardado}
        />
      )}
    </FlitModal>
  );
}

interface CuerpoProps {
  detalle: ProveedorDetalleDto | null;
  soloLectura: boolean;
  enfocarServicios: boolean;
  onRecargar: () => Promise<void>;
  onClose: () => void;
  onGuardado: () => void;
}

function CuerpoFormulario({ detalle: d, soloLectura: ro, enfocarServicios, onRecargar, onClose, onGuardado }: CuerpoProps) {
  const edicion = d !== null;
  const iniciales = useMemo<Record<Campo, string>>(() => ({
    nombre: d?.nombre ?? '', nit: d?.nit ?? '', telefono: d?.telefono ?? '', correo: d?.correo ?? '',
    direccion: d?.direccion ?? '', ciudad: d?.ciudad ?? '', contacto: d?.contacto ?? '',
  }), [d]);
  const soatInicial = useMemo(() => ({
    estrategia: d?.soat?.estrategia ?? '',
    umbral: d?.soat?.umbralOcr != null ? String(d.soat.umbralOcr) : '',
    sla: d?.soat?.slaHoras != null ? String(d.soat.slaHoras) : '',
  }), [d]);

  const [servicios, setServicios] = useState<ServicioProveedor[]>(d ? serviciosEnOrden(d.servicios) : ['soat']);
  const [g, setG] = useState(iniciales);
  const [soat, setSoat] = useState(soatInicial);
  const [errores, setErrores] = useState<Partial<Record<Campo, string>>>({});
  const [errorQuitar, setErrorQuitar] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [conflicto, setConflicto] = useState(false);
  const [recargando, setRecargando] = useState(false);
  const [errorRecarga, setErrorRecarga] = useState(false);

  const idBase = useId();
  const idErrorServicios = `${idBase}-servicios`;
  const idError = (c: Campo) => `${idBase}-${c}`;
  const refCampos = useRef<Partial<Record<Campo, HTMLInputElement | null>>>({});
  const refPrimeraCasilla = useRef<HTMLInputElement>(null);
  const refRecargar = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (enfocarServicios) refPrimeraCasilla.current?.focus(); }, [enfocarServicios]);
  useEffect(() => { if (conflicto) refRecargar.current?.focus(); }, [conflicto]);

  const tocado = CAMPOS.some((k) => g[k] !== iniciales[k]);
  const agregaServicio = !!d && servicios.some((s) => !d.servicios.includes(s));
  const pendiente = !!d && !d.datosCompletos;
  const exige = !ro && (!pendiente || tocado || agregaServicio);
  const presentaSoat = servicios.includes('soat');
  const sinServicio = !ro && servicios.length === 0;

  const alternar = (s: ServicioProveedor) => {
    setErrorQuitar(null); setError(null);
    setServicios((v) => serviciosEnOrden(v.includes(s) ? v.filter((x) => x !== s) : [...v, s]));
  };

  const cambiarCampo = (k: Campo, valor: string) => {
    setG((prev) => ({ ...prev, [k]: valor }));
    setErrores((prev) => (prev[k] ? { ...prev, [k]: undefined } : prev));
  };

  const errorDeCampo = (k: Campo): string | null => {
    const v = g[k].trim();
    if (!v) return ERROR_OBLIGATORIO;
    if (k === 'nit' && !NIT_VALIDO.test(normalizarNit(v))) return ERROR_NIT;
    if (k === 'correo' && !CORREO_VALIDO.test(v)) return ERROR_CORREO;
    return null;
  };

  const mostrarErrores = (nuevos: Partial<Record<Campo, string>>) => {
    setErrores(nuevos);
    const primero = CAMPOS.find((c) => nuevos[c]);
    if (primero) refCampos.current[primero]?.focus();
  };

  const soatValido = () => {
    if (!presentaSoat) return true;
    const u = soat.umbral.trim();
    const h = soat.sla.trim();
    if (u !== '' && !(Number(u) >= 0 && Number(u) <= 1)) return false;
    return h === '' || (Number.isInteger(Number(h)) && Number(h) >= 1);
  };

  /** Alta y servicio recién agregado: lo que se haya escrito. */
  const soatEscrito = (): CrearProveedorBody['soat'] | undefined => {
    const b: Partial<NonNullable<CrearProveedorBody['soat']>> = {
      ...(soat.estrategia.trim() ? { estrategia: soat.estrategia.trim() } : {}),
      ...(soat.umbral.trim() ? { umbralOcr: Number(soat.umbral) } : {}),
      ...(soat.sla.trim() ? { slaHoras: Number(soat.sla) } : {}),
    };
    return Object.keys(b).length > 0 ? (b as CrearProveedorBody['soat']) : undefined;
  };

  /** Edición con SOAT ya prestado: solo lo que cambió. Vaciar la estrategia se envía como `''`. */
  const soatCambiado = (): EditarProveedorBody['soat'] | undefined => {
    const b: NonNullable<EditarProveedorBody['soat']> = {
      ...(soat.estrategia.trim() !== soatInicial.estrategia ? { estrategia: soat.estrategia.trim() } : {}),
      ...(soat.umbral.trim() !== soatInicial.umbral ? { umbralOcr: soat.umbral.trim() === '' ? null : Number(soat.umbral) } : {}),
      ...(soat.sla.trim() !== soatInicial.sla ? { slaHoras: soat.sla.trim() === '' ? null : Number(soat.sla) } : {}),
    };
    return Object.keys(b).length > 0 ? b : undefined;
  };

  const generalesAEnviar = (): ProveedorGeneralesBody => ({
    nombre: g.nombre.trim(), nit: normalizarNit(g.nit), telefono: g.telefono.trim(), correo: g.correo.trim(),
    direccion: g.direccion.trim(), ciudad: g.ciudad.trim(), contacto: g.contacto.trim(),
  });

  const guardar = async () => {
    setError(null); setErrorQuitar(null); setErrores({});
    if (servicios.length === 0) { refPrimeraCasilla.current?.focus(); return; }

    // Con los datos completos, los generales solo viajan si cambiaron. Agregar un servicio a uno antiguo también los pide.
    const enviaGenerales = !d || tocado || (agregaServicio && pendiente);
    if (enviaGenerales) {
      const nuevos: Partial<Record<Campo, string>> = {};
      for (const k of CAMPOS) {
        const e = errorDeCampo(k);
        if (e) nuevos[k] = e;
      }
      if (Object.keys(nuevos).length > 0) { mostrarErrores(nuevos); return; }
    }
    if (!soatValido()) { setError(ERROR_SOAT); return; }

    setGuardando(true);
    try {
      if (d) {
        const cambiaServicios = servicios.length !== d.servicios.length || agregaServicio;
        const soatBody = !presentaSoat ? undefined : d.servicios.includes('soat') ? soatCambiado() : soatEscrito();
        const body: EditarProveedorBody = {
          versionEsperada: d.version,
          ...(enviaGenerales ? { generales: generalesAEnviar() } : {}),
          ...(cambiaServicios ? { servicios } : {}),
          ...(soatBody ? { soat: soatBody } : {}),
        };
        await api.patch(`${RUTA_UNIFICADA}/${d.id}`, body);
      } else {
        const soatBody = presentaSoat ? soatEscrito() : undefined;
        const body: CrearProveedorBody = { generales: generalesAEnviar(), servicios, ...(soatBody ? { soat: soatBody } : {}) };
        await api.post(RUTA_UNIFICADA, body);
      }
      toastOk(edicion ? 'Cambios guardados.' : 'Proveedor creado.', { id: 'guardar-proveedor' });
      onGuardado();
    } catch (e) {
      manejarError(e);
    } finally { setGuardando(false); }
  };

  const manejarError = (e: unknown) => {
    if (esEdicionSimultanea(e)) { setConflicto(true); return; }
    const dup = duplicadoProveedor(e);
    if (dup) { mostrarErrores({ [dup.campo]: dup.texto }); return; }
    const quitar = servicioNoQuitable(e);
    if (quitar) {
      setErrorQuitar(quitar.texto);
      setServicios((v) => serviciosEnOrden(v.includes(quitar.servicio) ? v : [...v, quitar.servicio]));
      refPrimeraCasilla.current?.focus();
      return;
    }
    if (e instanceof ApiError && e.status === 422) {
      const campos = cuerpoDe(e)?.campos;
      if (Array.isArray(campos) && campos.some(esCampo)) {
        const nuevos: Partial<Record<Campo, string>> = {};
        for (const c of campos.filter(esCampo)) nuevos[c] = c === 'nit' ? ERROR_NIT : c === 'correo' && g.correo.trim() ? ERROR_CORREO : ERROR_OBLIGATORIO;
        mostrarErrores(nuevos);
        return;
      }
      if (textoDe(e) === MENSAJE_SIN_SERVICIO) { setServicios([]); refPrimeraCasilla.current?.focus(); return; }
    }
    setError(mensajeErrorGuardar(e));
  };

  const recargar = async () => {
    setRecargando(true); setErrorRecarga(false);
    try { await onRecargar(); } catch { setErrorRecarga(true); setRecargando(false); }
  };

  const campo = (k: Campo, label: string, extra?: { placeholder?: string; type?: string }) => (
    <div>
      <FlitField label={`${label}${exige ? ' *' : ''}`}>
        <input
          ref={(el) => { refCampos.current[k] = el; }}
          className={flitInp}
          value={ro ? (g[k] || '—') : g[k]}
          readOnly={ro}
          type={ro ? 'text' : extra?.type}
          placeholder={ro ? undefined : extra?.placeholder}
          aria-required={exige ? true : undefined}
          aria-invalid={errores[k] ? true : undefined}
          aria-describedby={errores[k] ? idError(k) : undefined}
          onChange={(e) => cambiarCampo(k, e.target.value)}
          onBlur={k === 'nit' ? () => { if (exige && g.nit.trim() && errorDeCampo('nit')) setErrores((prev) => ({ ...prev, nit: ERROR_NIT })); } : undefined}
        />
      </FlitField>
      {errores[k] && <ErrorCampo id={idError(k)}>{errores[k]}</ErrorCampo>}
    </div>
  );

  const errorServicios = sinServicio ? MENSAJE_SIN_SERVICIO : errorQuitar;

  return (
    <form className="space-y-3" noValidate onSubmit={(e) => { e.preventDefault(); if (!ro && !conflicto) void guardar(); }}>
      <fieldset className="min-w-0" aria-describedby={errorServicios ? idErrorServicios : undefined}>
        <legend className="mb-1 text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Servicios que presta{ro ? '' : ' *'}</legend>
        {ro ? (
          <div className="flex flex-wrap gap-1">
            {servicios.map((s) => <StatusChip key={s} tone="neutral">{SERVICIO_PROVEEDOR_LABEL[s]}</StatusChip>)}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {SERVICIOS_PROVEEDOR.map((s, i) => (
              <label key={s} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-[var(--flit-bg-hover)]" style={{ color: 'var(--flit-text-primary)' }}>
                <input ref={i === 0 ? refPrimeraCasilla : undefined} type="checkbox" className="flit-focus" checked={servicios.includes(s)} onChange={() => alternar(s)} />
                <span>{SERVICIO_PROVEEDOR_LABEL[s]}</span>
              </label>
            ))}
          </div>
        )}
        {errorServicios && <ErrorCampo id={idErrorServicios}>{errorServicios}</ErrorCampo>}
      </fieldset>

      {!ro && <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{NOTA_EMPRESA}</p>}
      {!ro && pendiente && (
        <p role="status" className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          {exige
            ? 'Como editó los datos, complete todos los campos marcados con *.'
            : 'Faltan datos de esta empresa. Puede guardar otros cambios sin completarlos; si edita alguno de estos datos o agrega un servicio, se piden todos.'}
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {campo('nombre', 'Nombre de la empresa')}
        {campo('nit', 'NIT', { placeholder: '900123456-7' })}
        {campo('telefono', 'Teléfono', { type: 'tel' })}
        {campo('correo', 'Correo', { type: 'email' })}
        {campo('direccion', 'Dirección')}
        {campo('ciudad', 'Ciudad')}
        {campo('contacto', 'Persona de contacto')}
      </div>

      {presentaSoat && (
        <>
          <FlitField label="Estrategia">
            <input className={flitInp} value={ro ? (soat.estrategia || '—') : soat.estrategia} readOnly={ro}
              placeholder={ro ? undefined : 'p.ej. portal, correo'}
              onChange={(e) => setSoat((v) => ({ ...v, estrategia: e.target.value }))} />
          </FlitField>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FlitField label="Umbral OCR (0–1)">
              {ro
                ? <input className={flitInp} value={textoUmbral(d?.soat?.umbralOcr)} readOnly />
                : <input className={flitInp} type="number" step="0.01" min="0" max="1" value={soat.umbral} onChange={(e) => setSoat((v) => ({ ...v, umbral: e.target.value }))} />}
            </FlitField>
            <FlitField label="ANS pactado (horas)">
              {ro
                ? <input className={flitInp} value={soat.sla || '—'} readOnly />
                : <input className={flitInp} type="number" min="1" value={soat.sla} onChange={(e) => setSoat((v) => ({ ...v, sla: e.target.value }))} />}
            </FlitField>
          </div>
        </>
      )}

      {d && <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{textoCompaniasAsignadas(d)}</p>}

      {conflicto && (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p className="text-sm font-semibold" style={{ color: 'var(--flit-danger-text)' }}>
            Otro usuario cambió este proveedor mientras usted editaba. Lo que escribió no se guardó. Al recargar verá los datos actuales y perderá lo que escribió.
          </p>
          <button ref={refRecargar} type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={recargando} onClick={() => { void recargar(); }}>
            {recargando ? 'Recargando…' : 'Recargar datos'}
          </button>
          {errorRecarga && <p className="text-sm font-semibold" style={{ color: 'var(--flit-danger-text)' }}>No pudimos recargar el proveedor. Inténtelo de nuevo.</p>}
        </div>
      )}

      {error && <p role="alert" className="text-sm font-semibold" style={{ color: 'var(--flit-danger-text)' }}>{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>{ro ? 'Cerrar' : 'Cancelar'}</button>
        {!ro && (
          <button type="submit" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={guardando || conflicto}>
            {guardando ? 'Guardando…' : edicion ? 'Guardar cambios' : 'Crear proveedor'}
          </button>
        )}
      </div>
    </form>
  );
}
