// Ficha fiscal del cliente: lo que Siigo exige para poder facturarle (HU #11298, Feature #11241).
//
// Vive en su propio componente desde el primer commit y no dentro de `Clients.tsx`: esa pantalla ya
// tiene dos pestañas, un modal de tarifas y dos formularios en 452 líneas, y meterle esto la
// acercaría al techo de 800 de la regla 19. En la Feature anterior ese refactor hubo que hacerlo a
// última hora; aquí se hace antes de que duela.
//
// Dos ideas sostienen la pantalla:
//
//   1. **El tipo de persona decide la forma del nombre** (AC3), y cambiarlo REINTERPRETA lo que ya
//      hay: la razón social de una compañía pasa a leerse como nombre propio y al revés. Por eso se
//      avisa antes de aplicarlo, no después.
//   2. **Nada que Siigo tenga catalogado se escribe a mano** (AC4, AC6). Los identificadores y la
//      ubicación salen de listas cerradas; lo único que se teclea es lo que de verdad es texto.

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import {
  PERSONA_TIPOS, PERSONA_TIPO_ETIQUETA, RESPONSABILIDADES_FISCALES,
  SIIGO_ID_TIPOS, SUCURSAL_MAXIMA, SUCURSAL_MINIMA,
  type PersonaTipo,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../../lib/api';
import FlitModal from '../flit/FlitModal';
import GradientButton from '../flit/GradientButton';
import StatusChip from '../flit/StatusChip';
import {
  flitInp, FlitField, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../flit/flitPageKit';
import UbicacionFiscal from './UbicacionFiscal';
import type { DatosFiscalesCliente, VeredictoCliente } from './tipos';

interface Props {
  clienteId: number;
  clienteNombre: string;
  editable: boolean;
  onClose: () => void;
  /** Se llama tras guardar para que el listado refresque su señal de «no facturable». */
  onGuardado: () => void;
}

type Formulario = {
  personType: string;
  idType: string;
  document: string;
  checkDigit: string;
  fiscalResponsibilities: string[];
  address: string;
  countryCode: string;
  stateCode: string;
  cityCode: string;
  commercialName: string;
  branchOffice: string;
  name: string;
  contactFirstName: string;
  contactLastName: string;
  contactEmail: string;
  phoneIndicative: string;
  phoneNumber: string;
};


function aFormulario(c: DatosFiscalesCliente): Formulario {
  return {
    personType: c.personType ?? '',
    idType: c.idType ?? '',
    document: c.document ?? '',
    checkDigit: c.checkDigit === null || c.checkDigit === undefined ? '' : String(c.checkDigit),
    fiscalResponsibilities: c.fiscalResponsibilities ?? [],
    address: c.address ?? '',
    countryCode: c.countryCode ?? '',
    stateCode: c.stateCode ?? '',
    cityCode: c.cityCode ?? '',
    commercialName: c.commercialName ?? '',
    branchOffice: String(c.branchOffice ?? 0),
    name: c.name ?? '',
    contactFirstName: c.contactFirstName ?? '',
    contactLastName: c.contactLastName ?? '',
    contactEmail: c.contactEmail ?? '',
    phoneIndicative: c.phoneIndicative ?? '',
    phoneNumber: c.phoneNumber ?? '',
  };
}

/** Validación de formato ANTES de intentar guardar (AC6). Mismos patrones que la ruta. */
function erroresDeFormato(f: Formulario): Record<string, string> {
  const e: Record<string, string> = {};
  if (f.checkDigit !== '' && !/^[0-9]$/.test(f.checkDigit)) e.checkDigit = 'Un solo dígito, de 0 a 9.';
  if (f.phoneIndicative !== '' && !/^[0-9]{1,10}$/.test(f.phoneIndicative)) e.phoneIndicative = 'Solo dígitos, máximo 10.';
  if (f.phoneNumber !== '' && !/^[0-9]{1,10}$/.test(f.phoneNumber)) e.phoneNumber = 'Solo dígitos, máximo 10.';
  if (f.contactEmail !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.contactEmail)) e.contactEmail = 'Correo con formato inválido.';
  const sucursal = Number(f.branchOffice);
  if (!Number.isInteger(sucursal) || sucursal < SUCURSAL_MINIMA || sucursal > SUCURSAL_MAXIMA) {
    e.branchOffice = `Un entero entre ${SUCURSAL_MINIMA} y ${SUCURSAL_MAXIMA}.`;
  }
  return e;
}

export default function FichaFiscal({ clienteId, clienteNombre, editable, onClose, onGuardado }: Props) {
  const [form, setForm] = useState<Formulario | null>(null);
  const [veredicto, setVeredicto] = useState<VeredictoCliente | null>(null);
  const [ciudadTexto, setCiudadTexto] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  /** Tipo de persona que se quiere aplicar, esperando confirmación (AC3). */
  const [cambioPendiente, setCambioPendiente] = useState<PersonaTipo | null>(null);

  const cargar = useCallback(async () => {
    setError(null);
    setForm(null);
    try {
      const [clientes, v] = await Promise.all([
        api.get<DatosFiscalesCliente[]>('/clients?limit=500'),
        api.get<VeredictoCliente>(`/siigo/clientes/${clienteId}/validacion`),
      ]);
      const cliente = clientes.find((c) => c.id === clienteId);
      if (!cliente) throw new Error('El cliente ya no existe.');
      setForm(aFormulario(cliente));
      setCiudadTexto(cliente.city);
      setVeredicto(v);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [clienteId]);

  useEffect(() => { void cargar(); }, [cargar]);

  const errores = form ? erroresDeFormato(form) : {};
  const hayErrores = Object.keys(errores).length > 0;

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    if (!form || hayErrores) return;
    setGuardando(true);
    try {
      await api.patch(`/clients/${clienteId}`, {
        personType: form.personType === '' ? null : form.personType,
        idType: form.idType === '' ? null : form.idType,
        document: form.document === '' ? undefined : form.document,
        checkDigit: form.checkDigit === '' ? null : Number(form.checkDigit),
        fiscalResponsibilities: form.fiscalResponsibilities,
        address: form.address === '' ? undefined : form.address,
        countryCode: form.countryCode === '' ? null : form.countryCode,
        stateCode: form.stateCode === '' ? null : form.stateCode,
        cityCode: form.cityCode === '' ? null : form.cityCode,
        commercialName: form.commercialName === '' ? null : form.commercialName,
        branchOffice: Number(form.branchOffice),
        name: form.name,
        contactFirstName: form.contactFirstName === '' ? null : form.contactFirstName,
        contactLastName: form.contactLastName === '' ? null : form.contactLastName,
        contactEmail: form.contactEmail === '' ? null : form.contactEmail,
        phoneIndicative: form.phoneIndicative === '' ? null : form.phoneIndicative,
        phoneNumber: form.phoneNumber === '' ? null : form.phoneNumber,
      });
      toast.success('Datos fiscales guardados');
      // Se recarga en vez de cerrar: la señal de lo que falta tiene que actualizarse a la vista
      // (AC5), y así se ve qué queda pendiente sin volver a abrir la ficha.
      await cargar();
      onGuardado();
    } catch (e2) {
      toast.error(errorMessage(e2));
    } finally {
      setGuardando(false);
    }
  };

  const esPersona = form?.personType === 'Person';

  return (
    <FlitModal title={`Datos fiscales · ${clienteNombre}`} onClose={onClose}>
      {error && (
        <div className="px-2 py-6 text-center">
          <p role="alert" className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
            <span aria-hidden="true" style={{ color: 'var(--flit-danger)' }}>⚠ </span>{error}
          </p>
          <button type="button" onClick={() => { void cargar(); }} className={`${flitBtnSecondary} mt-4`} style={flitBtnSecondaryStyle}>
            Reintentar
          </button>
        </div>
      )}

      {!error && form === null && (
        <p role="status" className="px-2 py-6 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>
          Cargando datos fiscales…
        </p>
      )}

      {!error && form !== null && (
        <form onSubmit={guardar} className="space-y-5">
          {/* AC5 — qué falta, nombrado uno por uno. */}
          {veredicto && !veredicto.facturable && (
            <section
              aria-labelledby="faltantes-titulo"
              className="rounded-[10px] px-4 py-3"
              style={{ background: 'rgba(228, 61, 48, 0.08)', borderLeft: '4px solid var(--flit-danger)' }}
            >
              <h4 id="faltantes-titulo" className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
                Este cliente todavía no se puede facturar
              </h4>
              <ul className="mt-1 list-disc pl-5 text-xs" style={{ color: 'var(--flit-text-primary)' }}>
                {veredicto.faltantes.map((f) => <li key={f.motivo}>{f.detalle}</li>)}
              </ul>
            </section>
          )}
          {veredicto?.facturable && (
            <p role="status" className="rounded-[10px] px-4 py-3 text-sm font-semibold"
              style={{ background: 'rgba(38, 148, 96, 0.08)', borderLeft: '4px solid var(--flit-success)', color: 'var(--flit-text-primary)' }}>
              Este cliente tiene todo lo que Siigo exige para facturarle.
            </p>
          )}

          {/* AC2 — vacío: cuál es el primer dato a llenar. */}
          {form.personType === '' && (
            <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>
              Empieza por el <strong>tipo de persona</strong>: de él dependen la forma del nombre que
              se le envía a Siigo y qué tipo de identificación corresponde.
            </p>
          )}

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <FlitField label="Tipo de persona">
              <select
                aria-label="Tipo de persona"
                className={flitInp}
                value={form.personType}
                disabled={!editable}
                onChange={(e) => {
                  const nuevo = e.target.value as PersonaTipo | '';
                  // AC3 — si ya había un tipo y hay nombre escrito, cambiarlo reinterpreta lo que
                  // hay: se avisa ANTES de aplicarlo.
                  if (nuevo !== '' && form.personType !== '' && nuevo !== form.personType) {
                    setCambioPendiente(nuevo);
                    return;
                  }
                  setForm({ ...form, personType: nuevo });
                }}
              >
                <option value="">Sin definir</option>
                {PERSONA_TIPOS.map((t) => (
                  <option key={t} value={t}>{PERSONA_TIPO_ETIQUETA[t]}</option>
                ))}
              </select>
            </FlitField>

            <FlitField label="Tipo de identificación">
              <select
                aria-label="Tipo de identificación"
                className={flitInp}
                value={form.idType}
                disabled={!editable}
                onChange={(e) => setForm({ ...form, idType: e.target.value })}
              >
                <option value="">Sin definir</option>
                {Object.entries(SIIGO_ID_TIPOS).map(([codigo, nombre]) => (
                  <option key={codigo} value={codigo}>{nombre}</option>
                ))}
              </select>
            </FlitField>

            <FlitField label="Sucursal en Siigo">
              <input
                aria-label="Sucursal en Siigo"
                type="number"
                min={SUCURSAL_MINIMA}
                max={SUCURSAL_MAXIMA}
                className={flitInp}
                value={form.branchOffice}
                disabled={!editable}
                aria-invalid={Boolean(errores.branchOffice)}
                onChange={(e) => setForm({ ...form, branchOffice: e.target.value })}
              />
              {errores.branchOffice && <ErrorCampo>{errores.branchOffice}</ErrorCampo>}
            </FlitField>
          </div>

          {/* AC6 — el dígito de verificación va junto a la identificación. */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <FlitField label="Identificación">
              <input
                aria-label="Identificación"
                className={`${flitInp} md:col-span-2`}
                value={form.document}
                disabled={!editable}
                onChange={(e) => setForm({ ...form, document: e.target.value })}
              />
            </FlitField>
            <FlitField label="Dígito de verificación">
              <input
                aria-label="Dígito de verificación"
                className={flitInp}
                value={form.checkDigit}
                disabled={!editable}
                aria-invalid={Boolean(errores.checkDigit)}
                onChange={(e) => setForm({ ...form, checkDigit: e.target.value })}
              />
              {errores.checkDigit && <ErrorCampo>{errores.checkDigit}</ErrorCampo>}
            </FlitField>
          </div>

          {/* AC3 — la forma del nombre depende del tipo de persona. */}
          {esPersona ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <FlitField label="Nombres">
                <input aria-label="Nombres" className={flitInp} value={form.contactFirstName} disabled={!editable}
                  onChange={(e) => setForm({ ...form, contactFirstName: e.target.value })} />
              </FlitField>
              <FlitField label="Apellidos">
                <input aria-label="Apellidos" className={flitInp} value={form.contactLastName} disabled={!editable}
                  onChange={(e) => setForm({ ...form, contactLastName: e.target.value })} />
              </FlitField>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <FlitField label="Razón social">
                <input aria-label="Razón social" className={flitInp} value={form.name} disabled={!editable}
                  onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </FlitField>
              <FlitField label="Nombre comercial (opcional)">
                <input aria-label="Nombre comercial (opcional)" className={flitInp} value={form.commercialName} disabled={!editable}
                  onChange={(e) => setForm({ ...form, commercialName: e.target.value })} />
              </FlitField>
            </div>
          )}

          <fieldset>
            <legend className="mb-1.5 text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>
              Responsabilidades fiscales
            </legend>
            <div className="flex flex-wrap gap-3">
              {Object.entries(RESPONSABILIDADES_FISCALES).map(([codigo, nombre]) => (
                <label key={codigo} className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={form.fiscalResponsibilities.includes(codigo)}
                    disabled={!editable}
                    onChange={(e) => setForm({
                      ...form,
                      fiscalResponsibilities: e.target.checked
                        ? [...form.fiscalResponsibilities, codigo]
                        : form.fiscalResponsibilities.filter((r) => r !== codigo),
                    })}
                  />
                  {nombre}
                </label>
              ))}
            </div>
          </fieldset>

          <FlitField label="Dirección">
            <input aria-label="Dirección" className={flitInp} value={form.address} disabled={!editable}
              onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </FlitField>

          <UbicacionFiscal
            clienteId={clienteId}
            countryCode={form.countryCode}
            stateCode={form.stateCode}
            cityCode={form.cityCode}
            ciudadTexto={ciudadTexto}
            editable={editable}
            onCambio={(v) => setForm({ ...form, ...v })}
          />

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <FlitField label="Correo del contacto">
              <input aria-label="Correo del contacto" className={flitInp} value={form.contactEmail} disabled={!editable}
                aria-invalid={Boolean(errores.contactEmail)}
                onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
              {errores.contactEmail && <ErrorCampo>{errores.contactEmail}</ErrorCampo>}
            </FlitField>
            <FlitField label="Indicativo">
              <input aria-label="Indicativo" className={flitInp} value={form.phoneIndicative} disabled={!editable}
                aria-invalid={Boolean(errores.phoneIndicative)}
                onChange={(e) => setForm({ ...form, phoneIndicative: e.target.value })} />
              {errores.phoneIndicative && <ErrorCampo>{errores.phoneIndicative}</ErrorCampo>}
            </FlitField>
            <FlitField label="Teléfono">
              <input aria-label="Teléfono" className={flitInp} value={form.phoneNumber} disabled={!editable}
                aria-invalid={Boolean(errores.phoneNumber)}
                onChange={(e) => setForm({ ...form, phoneNumber: e.target.value })} />
              {errores.phoneNumber && <ErrorCampo>{errores.phoneNumber}</ErrorCampo>}
            </FlitField>
          </div>

          {!esPersona && form.personType === 'Company' && (
            <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
              El contacto es la persona de la empresa con la que se factura; su nombre es obligatorio
              para Siigo. Se captura en los campos de arriba.
            </p>
          )}

          {editable && (
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={onClose} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>
                Cerrar
              </button>
              <GradientButton type="submit" disabled={guardando || hayErrores}>
                {guardando ? 'Guardando…' : 'Guardar datos fiscales'}
              </GradientButton>
            </div>
          )}
          {!editable && (
            <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
              Tu rol puede consultar estos datos, no modificarlos.
            </p>
          )}
        </form>
      )}

      {/* AC3 — advertencia ANTES de reinterpretar los campos. */}
      {cambioPendiente && form && (
        <div role="alertdialog" aria-label="Confirmar cambio de tipo de persona"
          className="mt-4 rounded-[10px] px-4 py-3"
          style={{ background: 'rgba(224, 168, 0, 0.10)', borderLeft: '4px solid var(--flit-warning)' }}>
          <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            Cambiar a {PERSONA_TIPO_ETIQUETA[cambioPendiente]} reinterpreta el nombre
          </p>
          <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-primary)' }}>
            {cambioPendiente === 'Person'
              ? 'La razón social dejará de enviarse como tal: a Siigo irán los nombres y apellidos por separado, sin dígitos ni signos.'
              : 'Los nombres y apellidos dejarán de enviarse por separado: a Siigo irá una sola razón social, conservando dígitos y siglas.'}
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
              onClick={() => setCambioPendiente(null)}>Cancelar</button>
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
              onClick={() => { setForm({ ...form, personType: cambioPendiente }); setCambioPendiente(null); }}>
              Entiendo, cambiar
            </button>
          </div>
        </div>
      )}
    </FlitModal>
  );
}

function ErrorCampo({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-1 text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
      <span aria-hidden="true" style={{ color: 'var(--flit-danger)' }}>⚠ </span>{children}
    </p>
  );
}

/** Señal de «no facturable» para el listado (AC5). */
export function ChipFacturable({ veredicto }: { veredicto: VeredictoCliente | undefined }) {
  if (!veredicto) return <span style={{ color: 'var(--flit-text-muted)' }}>—</span>;
  if (veredicto.facturable) return <StatusChip tone="success">Lista</StatusChip>;
  return (
    <StatusChip tone={veredicto.pendienteClasificacion ? 'warning' : 'danger'}>
      {veredicto.pendienteClasificacion ? 'Por clasificar' : `Faltan ${veredicto.faltantes.length}`}
    </StatusChip>
  );
}
