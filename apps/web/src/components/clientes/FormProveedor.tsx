// Modal de proveedor: alta con selector de tipo SOAT | Logística, edición y detalle de solo lectura
// (HU #14105). Un solo formulario: los campos del otro tipo ni se muestran ni se envían.
//
// El estado (activo/inactivo) de un proveedor ya existente NO se cambia aquí sino en el ⋮ de la fila
// (HU #13958/#13961). En el ALTA de Logística sí hay «Activo»: el POST no lo recibe, así que si se
// deja apagado se hace el PATCH de estado justo después de crear.

import { useEffect, useId, useRef, useState } from 'react';
import { toastOk } from '../flit/ToastFlito';
import { api, ApiError } from '../../lib/api';
import FlitModal from '../flit/FlitModal';
import FlitSwitch from '../flit/FlitSwitch';
import StatusChip from '../flit/StatusChip';
import {
  flitInp, FlitField, FlitPillGroup, FlitPillButton,
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../flit/flitPageKit';
import { ErrorNit as ErrorCampo } from './nitDuplicado';
import { rutaProveedor, type Proveedor, type TipoProveedor } from './proveedoresDatos';

const NIT_VALIDO = /^\d{5,15}(-\d)?$/;
const ERROR_NIT = 'Escriba el NIT solo con números, con dígito de verificación opcional (ej. 900123456-7).';
const AVISO_LOGISTICA = 'Presta el servicio de logística a las compañías que lo tengan asignado.';
const normalizarNit = (v: string) => v.replace(/[.\s]/g, '').replace(/–|—/g, '-');

const DUPLICADO = /^Ya existe un proveedor (SOAT|de logística) con el (nombre|NIT) .+\.$/;

/** El 409 de nombre o NIT repetido: único texto del API que se muestra tal cual, bajo su campo. */
export function duplicadoProveedor(e: unknown): { campo: 'nombre' | 'nit'; texto: string } | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const cuerpo = e.rawDetails as { error?: unknown } | null | undefined;
  const texto = (typeof cuerpo?.error === 'string' ? cuerpo.error : e.message).trim();
  const m = DUPLICADO.exec(texto);
  return m ? { campo: m[2] === 'NIT' ? 'nit' : 'nombre', texto } : null;
}

/** AC3 de #13962 (compatibilidad): solo el duplicado de nombre. */
export function mensajeNombreDuplicado(e: unknown): string | null {
  const d = duplicadoProveedor(e);
  return d?.campo === 'nombre' ? d.texto : null;
}

/** Cualquier otro fallo al guardar: frase propia, nunca el texto crudo del API. */
export function mensajeErrorGuardar(e: unknown): string {
  const status = e instanceof ApiError ? e.status : 0;
  if (status === 403) return 'No tiene permiso para esta acción.';
  if (status === 404) return 'Este proveedor ya no existe. Cierre y vuelva a cargar la lista.';
  if (status === 400) return 'Revise los datos: el umbral OCR va de 0 a 1 y el ANS pactado es un número de horas mayor que cero.';
  if (status === 0) return 'No pudimos conectar con FLITO. Revise su conexión e inténtelo de nuevo.';
  return 'No pudimos guardar el proveedor. Inténtelo de nuevo.';
}

interface Props {
  proveedor?: Proveedor;
  /** Detalle: campos deshabilitados, solo «Cerrar». */
  soloLectura?: boolean;
  tipoInicial?: TipoProveedor;
  /** Cuántas compañías lo tienen asignado (lo cuenta el servidor; solo se muestra en edición y detalle). */
  companiasAsignadas?: number | null;
  onClose: () => void;
  onGuardado: () => void;
}

export default function FormProveedor({ proveedor, soloLectura = false, tipoInicial = 'SOAT', companiasAsignadas, onClose, onGuardado }: Props) {
  const [tipo, setTipo] = useState<TipoProveedor>(proveedor?.tipo ?? tipoInicial);
  const [nombre, setNombre] = useState(proveedor?.nombre ?? '');
  const [estrategia, setEstrategia] = useState(proveedor?.estrategia ?? '');
  const [umbral, setUmbral] = useState(proveedor?.umbralOcr != null ? String(proveedor.umbralOcr) : '');
  const [sla, setSla] = useState(proveedor?.slaHoras != null ? String(proveedor.slaHoras) : '');
  const [nit, setNit] = useState(proveedor?.nit ?? '');
  const [contacto, setContacto] = useState(proveedor?.contacto ?? '');
  const [telefono, setTelefono] = useState(proveedor?.telefono ?? '');
  const [activo, setActivo] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorNombre, setErrorNombre] = useState<string | null>(null);
  const [errorNit, setErrorNit] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const refNombre = useRef<HTMLInputElement>(null);
  const refNit = useRef<HTMLInputElement>(null);
  const idErrorNombre = useId();
  const idErrorNit = useId();
  const idTipo = useId();
  const esLogistica = tipo === 'LOGISTICA';
  const edicion = !!proveedor;
  useEffect(() => { if (errorNombre) refNombre.current?.focus(); }, [errorNombre]);
  useEffect(() => { if (errorNit) refNit.current?.focus(); }, [errorNit]);

  const validarNit = (): boolean => {
    const ok = NIT_VALIDO.test(normalizarNit(nit));
    setErrorNit(ok ? null : ERROR_NIT);
    return ok;
  };

  const cambiarTipo = (t: TipoProveedor) => {
    if (t === tipo) return;
    // Cambiar de tipo limpia los campos del otro: no se muestran ni se envían.
    setTipo(t); setError(null); setErrorNombre(null); setErrorNit(null);
    setEstrategia(''); setUmbral(''); setSla(''); setNit(''); setContacto(''); setTelefono('');
  };

  const guardar = async () => {
    setError(null); setErrorNombre(null);
    if (esLogistica && !validarNit()) return;
    setGuardando(true);
    const base = '/flito/parametrizacion';
    try {
      if (esLogistica) {
        const body = {
          nombre: nombre.trim(), nit: normalizarNit(nit),
          contacto: contacto.trim() || null, telefono: telefono.trim() || null,
        };
        if (proveedor) await api.patch(`${rutaProveedor(proveedor)}/${proveedor.id}`, body);
        else {
          const creado = await api.post<{ id: string }>(`${base}/proveedores-logistica`, body);
          if (!activo && creado?.id) await api.patch(`${base}/proveedores-logistica/${creado.id}/estado`, { activo: false });
        }
      } else {
        const body: Record<string, unknown> = {
          nombre: nombre.trim(),
          estrategia: estrategia.trim() || undefined,
          umbralOcr: umbral.trim() === '' ? null : Number(umbral),
          slaHoras: sla.trim() === '' ? null : Number(sla),
        };
        if (proveedor) await api.patch(`${base}/proveedores-soat/${proveedor.id}`, body);
        else await api.post(`${base}/proveedores-soat`, body);
      }
      toastOk(edicion ? 'Cambios guardados.' : 'Proveedor creado.', { id: 'guardar-proveedor' });
      onGuardado();
    } catch (e) {
      const dup = duplicadoProveedor(e);
      if (dup?.campo === 'nit') setErrorNit(dup.texto);
      else if (dup) setErrorNombre(dup.texto);
      else if (e instanceof ApiError && e.status === 422 && (e.rawDetails as { campo?: string } | null)?.campo === 'nit') setErrorNit(ERROR_NIT);
      else setError(mensajeErrorGuardar(e));
    } finally { setGuardando(false); }
  };

  const titulo = soloLectura ? `Detalle de ${proveedor?.nombre ?? 'proveedor'}` : edicion ? 'Editar proveedor' : 'Nuevo proveedor';
  const ro = soloLectura;

  return (
    <FlitModal title={titulo} onClose={onClose}>
      <form className="space-y-3" noValidate onSubmit={(e) => { e.preventDefault(); if (!ro) void guardar(); }}>
        {edicion || ro ? (
          <p className="flex items-center gap-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
            Tipo <StatusChip tone="neutral">{esLogistica ? 'Logística' : 'SOAT'}</StatusChip>
          </p>
        ) : (
          <fieldset className="min-w-0">
            <legend id={idTipo} className="mb-1 text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Tipo de proveedor</legend>
            <FlitPillGroup>
              <FlitPillButton active={!esLogistica} pressed={!esLogistica} onClick={() => cambiarTipo('SOAT')}>SOAT</FlitPillButton>
              <FlitPillButton active={esLogistica} pressed={esLogistica} onClick={() => cambiarTipo('LOGISTICA')}>Logística</FlitPillButton>
            </FlitPillGroup>
          </fieldset>
        )}
        {esLogistica && !ro && <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{AVISO_LOGISTICA}</p>}

        <FlitField label="Nombre *">
          <input ref={refNombre} className={flitInp} value={nombre} readOnly={ro} required aria-required="true"
            onChange={(e) => { setNombre(e.target.value); setErrorNombre(null); }}
            aria-invalid={errorNombre ? true : undefined} aria-describedby={errorNombre ? idErrorNombre : undefined} />
        </FlitField>
        {errorNombre && <ErrorCampo id={idErrorNombre}>{errorNombre}</ErrorCampo>}

        {esLogistica ? (
          <>
            <FlitField label="NIT *">
              <input ref={refNit} className={flitInp} value={nit} readOnly={ro} required aria-required="true" inputMode="text"
                placeholder="900123456-7"
                onChange={(e) => { setNit(e.target.value); setErrorNit(null); }}
                onBlur={() => { if (nit.trim() && !ro) validarNit(); }}
                aria-invalid={errorNit ? true : undefined} aria-describedby={errorNit ? idErrorNit : undefined} />
            </FlitField>
            {errorNit && <ErrorCampo id={idErrorNit}>{errorNit}</ErrorCampo>}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FlitField label={ro ? 'Contacto' : 'Contacto (opcional)'}>
                <input className={flitInp} value={contacto} readOnly={ro} onChange={(e) => setContacto(e.target.value)} />
              </FlitField>
              <FlitField label={ro ? 'Teléfono' : 'Teléfono (opcional)'}>
                <input className={flitInp} type="tel" value={telefono} readOnly={ro} onChange={(e) => setTelefono(e.target.value)} />
              </FlitField>
            </div>
            {!edicion && !ro && (
              <div className="flex items-center gap-3">
                <FlitSwitch checked={activo} onToggle={setActivo} etiqueta="Activo" />
                <span className="text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>Activo</span>
              </div>
            )}
          </>
        ) : (
          <>
            <FlitField label="Estrategia"><input className={flitInp} value={estrategia} readOnly={ro} onChange={(e) => setEstrategia(e.target.value)} placeholder={ro ? undefined : 'p.ej. portal, correo'} /></FlitField>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FlitField label="Umbral OCR (0–1)"><input className={flitInp} type="number" step="0.01" min="0" max="1" value={umbral} readOnly={ro} onChange={(e) => setUmbral(e.target.value)} /></FlitField>
              <FlitField label="ANS pactado (horas)"><input className={flitInp} type="number" min="1" value={sla} readOnly={ro} onChange={(e) => setSla(e.target.value)} /></FlitField>
            </div>
          </>
        )}

        {(edicion || ro) && companiasAsignadas != null && (
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            {companiasAsignadas === 0 ? 'Sin compañías asignadas.'
              : `Asignado a ${companiasAsignadas} ${companiasAsignadas === 1 ? 'compañía' : 'compañías'}.`}
          </p>
        )}

        {error && <p role="alert" className="text-sm font-semibold" style={{ color: 'var(--flit-danger-text)' }}>{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>{ro ? 'Cerrar' : 'Cancelar'}</button>
          {!ro && (
            <button type="submit" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={guardando || !nombre.trim()}>
              {guardando ? 'Guardando…' : edicion ? 'Guardar cambios' : 'Crear proveedor'}
            </button>
          )}
        </div>
      </form>
    </FlitModal>
  );
}
