// FLITO — Trámites: modales de la bandeja (trámite demo, desbloqueo de autogestión, crear
// empresa y elegir aseguradora). Movidos desde `pages/FlitoTramites.tsx` al partirla (rediseño UI Kit
// 2026, Épica #14560): mismos hooks, mismas llamadas y mismos textos; piel del kit. El historial suelto se
// retiró (Épica #14707, bloque 4): el chip de la fila abre el detalle en su sección Historial.

import { useEffect, useState } from 'react';
import { parseLicenciaTransito } from '@operaciones/shared-types';
import { api, errorMessage } from '../../../lib/api';
import FlitModal from '../../flit/FlitModal';
import FlitSelect from '../../flit/FlitSelect';
import GradientButton from '../../flit/GradientButton';
import { opcionesConEstado } from '../../flit/opcionesConEstado';
import { FlitField, flitInp } from '../../flit/flitPageKit';
import { SOAT_REINTENTO, mensajeSelectorSoat, type CatalogoSelector } from '../../clientes/proveedoresDatos';
import type { TramiteFila } from './tiposTramites';

const secundario = 'text-[color:var(--color-text-secondary)]';
const tenue = 'text-[color:var(--color-text-tertiary)]';
const error = 'text-sm text-[color:var(--kit-rojo-texto)]';

// Crea un trámite DEMO aprobado para probar Logística. Se puede pegar el código de la LT para prellenar
// placa/VIN/propietario; empresa y organismo se eligen de las parametrizadas (empresa NO autogestionada).
export function ModalCrearTramiteDemo({ onCerrar, onCreado }: { onCerrar: () => void; onCreado: () => void }) {
  const [empresas, setEmpresas] = useState<{ id: number; nombre: string }[]>([]);
  const [organismos, setOrganismos] = useState<{ codigo: string; nombre: string }[]>([]);
  const [codigoLt, setCodigoLt] = useState('');
  const [placa, setPlaca] = useState('');
  const [vin, setVin] = useState('');
  const [propietario, setPropietario] = useState('');
  const [propietarioDoc, setPropietarioDoc] = useState('');
  const [marca, setMarca] = useState('');
  const [linea, setLinea] = useState('');
  const [modelo, setModelo] = useState('');
  const [companiaId, setCompaniaId] = useState('');
  const [organismoCodigo, setOrganismoCodigo] = useState('');
  const [transitoNombre, setTransitoNombre] = useState('');
  const [flitEstado, setFlitEstado] = useState('Aprobado');
  const [busy, setBusy] = useState(false);
  const [err, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ id: number; nombre: string; logisticaAutogestionable: boolean }[]>('/flito/parametrizacion/companias')
      .then((cs) => setEmpresas(cs.filter((c) => !c.logisticaAutogestionable).map((c) => ({ id: c.id, nombre: c.nombre })))).catch(() => {});
    api.get<{ codigo: string; nombre: string; activo: boolean }[]>('/flito/parametrizacion/organismos')
      .then((os) => setOrganismos(os.filter((o) => o.activo).map((o) => ({ codigo: o.codigo, nombre: o.nombre })))).catch(() => {});
  }, []);

  // Al pegar el código de la LT, prellena placa/VIN/propietario/documento.
  const onCodigo = (v: string) => {
    setCodigoLt(v);
    const p = v.trim() ? parseLicenciaTransito(v.trim()) : null;
    if (p) {
      setPlaca(p.placa); setVin(p.vin);
      if (p.propietarioNombre) setPropietario(p.propietarioNombre);
      if (p.propietarioDocumento) setPropietarioDoc(p.propietarioDocumento);
    }
  };

  const valido = placa.trim().length >= 4 && vin.trim().length === 17 && propietario.trim().length >= 2 && companiaId && organismoCodigo;

  const crear = async () => {
    setBusy(true); setError(null);
    try {
      await api.post('/flito/tramites/demo', {
        placa: placa.trim(), vin: vin.trim(), propietarioNombre: propietario.trim(),
        propietarioDocumento: propietarioDoc.trim() || undefined,
        marca: marca.trim() || undefined, linea: linea.trim() || undefined,
        modelo: modelo.trim() ? Number(modelo.trim()) : undefined,
        companiaId: Number(companiaId), organismoCodigo,
        transitoNombre: transitoNombre.trim() || undefined,
        flitEstado,
      });
      onCreado();
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };

  return (
    <FlitModal title="Crear trámite demo (Logística)" onClose={onCerrar} wide>
      <p className={`mb-3 text-xs ${tenue}`}>
        Crea un trámite <strong>Aprobado</strong> de prueba para escanear su LT en Logística. Pega el código de la LT para prellenar, o llena a mano.
      </p>
      <FlitField label="Contenido del código de la LT (opcional, para prellenar)">
        <textarea className={flitInp} rows={2} placeholder="10038156339 C.C. … QOX858 LRWY… ELECTRICO" value={codigoLt} onChange={(e) => onCodigo(e.target.value)} />
      </FlitField>
      <div className="mt-3">
        <FlitField label="Estado del trámite *">
          <select className={flitInp} value={flitEstado} onChange={(e) => setFlitEstado(e.target.value)}>
            <option value="Aprobado">Aprobado — habilita Logística</option>
            <option value="Asignado">Asignado — habilita SOAT / Impuestos</option>
            <option value="Borrador">Borrador</option>
            <option value="Enviado a OT">Enviado a OT</option>
            <option value="Entregado">Entregado</option>
            <option value="Anulado">Anulado</option>
            <option value="Rechazado">Rechazado</option>
          </select>
        </FlitField>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FlitField label="Placa *"><input className={flitInp} value={placa} onChange={(e) => setPlaca(e.target.value)} /></FlitField>
        <FlitField label="VIN * (17)"><input className={flitInp} value={vin} onChange={(e) => setVin(e.target.value)} /></FlitField>
        <FlitField label="Propietario *"><input className={flitInp} value={propietario} onChange={(e) => setPropietario(e.target.value)} /></FlitField>
        <FlitField label="Documento propietario"><input className={flitInp} value={propietarioDoc} onChange={(e) => setPropietarioDoc(e.target.value)} /></FlitField>
        <FlitField label="Marca"><input className={flitInp} value={marca} onChange={(e) => setMarca(e.target.value)} placeholder="TESLA" /></FlitField>
        <FlitField label="Línea"><input className={flitInp} value={linea} onChange={(e) => setLinea(e.target.value)} placeholder="MODELO Y" /></FlitField>
        <FlitField label="Modelo (año)"><input className={flitInp} inputMode="numeric" value={modelo} onChange={(e) => setModelo(e.target.value)} placeholder="2026" /></FlitField>
        <FlitField label="Empresa gestora *">
          <select className={flitInp} value={companiaId} onChange={(e) => setCompaniaId(e.target.value)}>
            <option value="">Selecciona…</option>
            {empresas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
        </FlitField>
        <FlitField label="Organismo (tránsito) *">
          <select className={flitInp} value={organismoCodigo} onChange={(e) => { setOrganismoCodigo(e.target.value); setTransitoNombre(organismos.find((o) => o.codigo === e.target.value)?.nombre ?? ''); }}>
            <option value="">Selecciona…</option>
            {organismos.map((o) => <option key={o.codigo} value={o.codigo}>{o.nombre}</option>)}
          </select>
        </FlitField>
      </div>
      {err && <p className={`mt-3 ${error}`}>{err}</p>}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <GradientButton variant="alerta" onClick={onCerrar}>Cancelar</GradientButton>
        <GradientButton disabled={busy || !valido} onClick={crear}>
          {busy ? 'Creando…' : 'Crear trámite'}
        </GradientButton>
      </div>
    </FlitModal>
  );
}

/**
 * Desbloqueo excepcional de la autogestión (HU #10980).
 *
 * Solo se ofrece para los conceptos que la compañía SÍ autogestiona: en el resto no hay nada que
 * desbloquear. El motivo es obligatorio porque queda en la auditoría, y las dos advertencias no son
 * decorativas — son las dos consecuencias que sorprenden si no se dicen antes.
 */
export function ModalDesbloqueo({ fila, onCerrar, onHecho }: {
  fila: TramiteFila; onCerrar: () => void; onHecho: () => void;
}) {
  const disponibles = [
    { valor: 'soat', etiqueta: 'SOAT', aplica: fila.soatAutogestionado },
    { valor: 'impuesto', etiqueta: 'Impuestos', aplica: fila.impuestosAutogestionado },
  ].filter((c) => c.aplica && !fila.excepcionesAutogestion.includes(c.valor));

  const vigentes = fila.excepcionesAutogestion;
  const [concepto, setConcepto] = useState(disponibles[0]?.valor ?? '');
  const [motivo, setMotivo] = useState('');
  const [enProceso, setEnProceso] = useState(false);
  const [err, setError] = useState<string | null>(null);

  const ejecutar = async (ruta: 'desbloquear-autogestion' | 'revocar-autogestion', c: string) => {
    setEnProceso(true); setError(null);
    try {
      await api.post(`/flito/tramites/${fila.tramiteId}/${ruta}`, { concepto: c, motivo: motivo.trim() });
      onHecho();
    } catch (e) { setError(errorMessage(e)); }
    finally { setEnProceso(false); }
  };

  return (
    <FlitModal title={`Autogestión de ${fila.idFlit}`} onClose={onCerrar}>
      <div className="space-y-3">
        {vigentes.length > 0 && (
          <div className="rounded-[9px] border border-[color:var(--color-border)] p-3 text-sm">
            <p className="mb-2 font-semibold">Desbloqueado ahora mismo</p>
            {vigentes.map((c) => (
              <div key={c} className="flex items-center justify-between gap-3 py-1">
                <span>{c === 'soat' ? 'SOAT' : c === 'impuesto' ? 'Impuestos' : 'Logística'}</span>
                <GradientButton variant="alerta" size="sm"
                  disabled={enProceso || motivo.trim().length < 5}
                  onClick={() => ejecutar('revocar-autogestion', c)}>Revocar</GradientButton>
              </div>
            ))}
          </div>
        )}

        {disponibles.length === 0 ? (
          <p className={`text-sm ${secundario}`}>
            No queda ningún concepto autogestionado por desbloquear en este trámite.
          </p>
        ) : (
          <>
            <FlitField label="Concepto">
              <select className={flitInp} value={concepto} onChange={(e) => setConcepto(e.target.value)}>
                {disponibles.map((c) => <option key={c.valor} value={c.valor}>{c.etiqueta}</option>)}
              </select>
            </FlitField>

            {/* Las dos consecuencias que sorprenden si no se dicen antes. */}
            {concepto === 'soat' && (
              <p className={`text-xs ${secundario}`}>
                El SOAT se ancla al VIN, no al trámite: el que se cree cubrirá a todos los trámites
                de este vehículo, no solo a este.
              </p>
            )}
            {concepto === 'impuesto' && (
              <p className={`text-xs ${secundario}`}>
                Se creará el impuesto en Pendiente, así que el trámite dejará de estar listo para
                entregar hasta que se pague.
              </p>
            )}
          </>
        )}

        <FlitField label="Motivo (mínimo 5 caracteres) *">
          <input className={flitInp} value={motivo} onChange={(e) => setMotivo(e.target.value)}
            placeholder="p. ej. Renting encarga este trámite puntual a FLITO" />
        </FlitField>

        {err && <p className={error}>{err}</p>}
        <div className="flex flex-wrap gap-2">
          {disponibles.length > 0 && (
            <GradientButton
              disabled={enProceso || motivo.trim().length < 5 || !concepto}
              onClick={() => ejecutar('desbloquear-autogestion', concepto)}>
              {enProceso ? 'Aplicando…' : 'Desbloquear'}
            </GradientButton>
          )}
          <GradientButton variant="secondary" onClick={onCerrar}>Cerrar</GradientButton>
        </div>
      </div>
    </FlitModal>
  );
}

export function ModalCrearEmpresa({ fila, onCerrar, onCreado }: { fila: TramiteFila; onCerrar: () => void; onCreado: () => void }) {
  const [nombre, setNombre] = useState(fila.companiaNombre ?? '');
  // El estado guarda el DATO (`*Autogestionable`); el check lo pinta invertido: «FLITO gestiona» (HU #13935).
  // Arranca en `true`: la empresa nueva nace sin servicios gestionados por FLITO y las casillas, desmarcadas (HU #13937).
  const [soatAuto, setSoatAuto] = useState(true);
  const [impuestosAuto, setImpuestosAuto] = useState(true);
  const [logisticaAuto, setLogisticaAuto] = useState(true);
  const [err, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const crear = async () => {
    setGuardando(true); setError(null);
    try {
      await api.post('/flito/tramites/crear-empresa', {
        nombre, nit: fila.empresaNit,
        soatAutogestionable: soatAuto, impuestosAutogestionable: impuestosAuto, logisticaAutogestionable: logisticaAuto,
      });
      onCreado();
    } catch (e) { setError(errorMessage(e)); }
    finally { setGuardando(false); }
  };

  return (
    <FlitModal title="Crear empresa" onClose={onCerrar}>
      <div className="space-y-3">
        <p className={`text-sm ${secundario}`}>
          Trámite <span className="font-semibold">{fila.idFlit}</span> · la compañía de FLIT aún no existe. Al crearla se
          vinculan automáticamente los trámites con este NIT.
        </p>
        <FlitField label="NIT"><input className={flitInp} value={fila.empresaNit ?? ''} readOnly /></FlitField>
        <FlitField label="Nombre o razón social *">
          <input className={flitInp} value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Razón social de la empresa" autoFocus />
        </FlitField>
        <div>
          <p className={`mb-1 text-xs font-semibold ${tenue}`}>Servicios que gestiona FLITO</p>
          <div className={`flex flex-wrap gap-4 text-sm ${secundario}`}>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={!soatAuto} onChange={(e) => setSoatAuto(!e.target.checked)} /> SOAT</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={!impuestosAuto} onChange={(e) => setImpuestosAuto(!e.target.checked)} /> Impuestos</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={!logisticaAuto} onChange={(e) => setLogisticaAuto(!e.target.checked)} /> Logística</label>
          </div>
        </div>
        {err && <p className={error}>{err}</p>}
        <div className="flex flex-wrap gap-2">
          <GradientButton disabled={guardando || !nombre.trim()} onClick={crear}>{guardando ? 'Creando…' : 'Crear empresa'}</GradientButton>
          <GradientButton variant="alerta" onClick={onCerrar}>Cancelar</GradientButton>
        </div>
      </div>
    </FlitModal>
  );
}

export function DialogoProveedor({ tipo, n, proveedores, enProceso, onConfirmar, onCancelar }: {
  tipo: 'soat' | 'ambos'; n: number; proveedores: CatalogoSelector; enProceso: boolean;
  onConfirmar: (proveedorSoatId: string) => void; onCancelar: () => void;
}) {
  const [proveedorSoatId, setProveedorSoatId] = useState('');
  return (
    <FlitModal title={tipo === 'ambos' ? 'Solicitar SOAT e impuestos' : 'Solicitar SOAT'} onClose={onCancelar}>
      <div className="space-y-3">
        <p className={`text-sm ${secundario}`}>
          Elige la aseguradora a la que se envían los {n} trámite(s). El SOAT va a ese proveedor; los impuestos van a su gestor según el organismo.
        </p>
        <FlitSelect label="Aseguradora" value={proveedorSoatId} onChange={setProveedorSoatId}
          opciones={opcionesConEstado(proveedores.data ?? [], '', { placeholder: 'Elige una aseguradora…' })}
          mensaje={mensajeSelectorSoat(proveedores)} fallo={proveedores.error} disabled={!proveedores.data?.length}
          onReintentar={proveedores.error ? proveedores.recargar : undefined} textoReintento={SOAT_REINTENTO} />
        <div className="flex flex-wrap gap-2">
          <GradientButton disabled={!proveedorSoatId || enProceso} onClick={() => onConfirmar(proveedorSoatId)}>
            {tipo === 'ambos' ? 'Solicitar ambos' : 'Solicitar SOAT'}
          </GradientButton>
          <GradientButton variant="alerta" onClick={onCancelar}>Cancelar</GradientButton>
        </div>
      </div>
    </FlitModal>
  );
}
