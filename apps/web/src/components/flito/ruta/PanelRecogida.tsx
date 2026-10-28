// FLITO Logística — Mi ruta · «Recoger licencias» (HU #14111). El mensajero escanea (o ingresa a mano) varias LT,
// las ve en una lista, y al final el funcionario del organismo firma una sola vez: 1 acta por compañía.
//   lista → firma → confirmada. «Confirmar sin firma» NO confirma: las LT quedan escaneadas con el acta
//   pendiente de firma y se firma después con el mismo endpoint. Confirmar exige señal; escanear no.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, PencilLine } from 'lucide-react';
import { parseLicenciaTransito } from '@operaciones/shared-types';
import { api } from '../../../lib/api';
import { submitCampo } from '../../../lib/offlineQueue';
import { obtenerUbicacion } from '../../../lib/geo';
import { precargarOcr } from '../../../lib/ocrLt';
import { toastError } from '../../flit/ToastFlito';
import { FlitEmpty, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary } from '../../flit/flitPageKit';
import Escaner, { escaneoDisponible } from '../Escaner';
import HojaElegirTramite from './HojaElegirTramite';
import IngresoManual from './IngresoManual';
import PasoFirma, { type ResumenRecogida } from './PasoFirma';
import TarjetaLtRecogida from './TarjetaLtRecogida';
import {
  entra, estadoDeEscaneo, estadoDeValidacion, mensajeEscanear, nuevaKey,
  type Candidato, type DatosManual, type FilaLt, type RespuestaConsulta, type RespuestaEscaneo, type RespuestaValidacion,
} from './recogidaTipos';

type Vista = 'lista' | 'firma' | 'confirmada';

/** «Escanear LT» y «Escanear otra LT» son el mismo botón: cambia solo la jerarquía (primaria con la lista vacía). */
function BotonEscanear({ primaria, otra, onClick }: { primaria: boolean; otra: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`${primaria ? flitBtnPrimary : flitBtnSecondary} w-full justify-center`}
      style={{ ...(primaria ? flitBtnPrimaryStyle : {}), minHeight: 48 }}>
      <Camera size={18} aria-hidden="true" /> {otra ? 'Escanear otra LT' : 'Escanear LT'}
    </button>
  );
}

export default function PanelRecogida({ puedeConfirmar, onVerRecogidas }: { puedeConfirmar: boolean; onVerRecogidas: () => void }) {
  const [filas, setFilas] = useState<FilaLt[]>([]);
  const [vista, setVista] = useState<Vista>('lista');
  const [escaneando, setEscaneando] = useState(false);
  const [manual, setManual] = useState(false);
  const [hojaKey, setHojaKey] = useState<string | null>(null);
  const [registrando, setRegistrando] = useState(false);
  const [aviso, setAviso] = useState<{ tipo: 'alert' | 'status'; texto: string } | null>(null);
  const [sinFirma, setSinFirma] = useState(false);
  const [resumen, setResumen] = useState<ResumenRecogida | null>(null);
  const porRaw = useRef<Map<string, string>>(new Map());
  const filasRef = useRef<FilaLt[]>([]);
  filasRef.current = filas;
  const disparador = useRef<HTMLElement | null>(null);

  useEffect(() => { precargarOcr(); }, []);

  const patch = (key: string, p: Partial<FilaLt>) => setFilas((f) => f.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const quitar = (f: FilaLt) => {
    if (f.rawValue) porRaw.current.delete(f.rawValue);
    setFilas((fs) => fs.filter((r) => r.key !== f.key));
  };
  const nueva = (base: Partial<FilaLt> & Pick<FilaLt, 'placa'>): FilaLt => ({
    key: nuevaKey(), manual: null, rawValue: null, vin: null, propietario: null, numeroLicencia: '', combustible: null, numeroLt: '',
    estado: 'validando', motivo: null, candidatos: null, organismoCodigo: null, companiaNombre: null, registro: 'no', ...base,
  });

  // ── Registro en el backend (persistente, con cola offline) ─────────────────
  const cuerpo = (f: FilaLt, geo: { lat?: string; lng?: string }) => ({
    ...(f.manual ? f.manual : { rawValue: f.rawValue, numeroLt: f.numeroLt || undefined }),
    ...(f.tramiteId ? { tramiteId: f.tramiteId } : {}),
    ...(f.dejarPendiente ? { dejarPendiente: true, organismoCodigo: f.organismoCodigo ?? undefined } : {}),
    ...geo,
  });
  const registrarUna = async (f: FilaLt, geo: { lat?: string; lng?: string }): Promise<'ok' | 'elegir' | 'encolada' | 'error'> => {
    patch(f.key, { registro: 'registrando' });
    try {
      const { queued, result } = await submitCampo('/flito/logistica/escanear', cuerpo(f, geo), `LT ${f.placa}`);
      if (queued) { patch(f.key, { registro: 'encolada', estado: 'sin_conexion', motivo: null }); return 'encolada'; }
      const r = result as RespuestaEscaneo;
      const estado = f.dejarPendiente && (r.resultado === 'recogido' || r.resultado === 'novedad') ? 'pendiente' : estadoDeEscaneo(r);
      patch(f.key, {
        estado, motivo: r.motivo ?? null, documentoId: r.documentoId, vin: r.vin ?? f.vin, propietario: r.propietarioNombre ?? f.propietario,
        numeroLicencia: r.numeroLicencia ?? f.numeroLicencia, candidatos: r.candidatos ?? null, registro: estado === 'elegir' ? 'no' : 'registrada',
      });
      if (estado === 'elegir') { setHojaKey(f.key); return 'elegir'; }
      return 'ok';
    } catch (e) {
      patch(f.key, { registro: 'error', estado: 'error', motivo: mensajeEscanear(e) });
      return 'error';
    }
  };

  // ── Escaneo con cámara: valida sin persistir; se registra al continuar ─────
  const enriquecer = async (key: string, placa: string) => {
    try { // compañía y organismo para agrupar las actas; si falla, la LT se avisa en el paso de firma
      const r = await api.post<RespuestaConsulta>('/flito/logistica/consultar-vehiculo', { placa });
      if (r.encontrado && r.candidatos.length === 1) patch(key, { companiaNombre: r.candidatos[0].companiaNombre, organismoCodigo: r.candidatos[0].organismoCodigo });
    } catch { /* silencioso */ }
  };
  const validar = async (f: FilaLt) => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { patch(f.key, { estado: 'sin_conexion' }); return; }
    try {
      const r = await api.post<RespuestaValidacion>('/flito/logistica/validar-lt', { rawValue: f.rawValue });
      const estado = estadoDeValidacion(r);
      patch(f.key, { estado, motivo: r.motivo ?? null, candidatos: r.candidatos ?? null });
      if (estado === 'elegir') setHojaKey(f.key);
      else if (estado === 'lista' || estado === 'novedad') void enriquecer(f.key, f.placa);
    } catch { patch(f.key, { estado: 'error', motivo: 'No pudimos validar la LT. Revisa la señal e inténtalo de nuevo.' }); }
  };
  const procesar = (rawValue: string, numeroLt?: string | null) => {
    const p = parseLicenciaTransito(rawValue);
    if (!p) { toastError('No pudimos leer ese código. Acércate y escanea de nuevo.', undefined, { id: 'lt-ilegible' }); return; }
    const lt = (numeroLt ?? '').trim();
    const existente = porRaw.current.get(rawValue);
    if (existente) { if (lt) patch(existente, { numeroLt: lt }); return; } // mismo código: no duplica
    const f = nueva({ placa: p.placa, rawValue, vin: p.vin, propietario: p.propietarioNombre, numeroLicencia: p.numeroLicencia, combustible: p.combustible, numeroLt: lt });
    porRaw.current.set(rawValue, f.key);
    setAviso(null);
    setFilas((fs) => [f, ...fs]);
    void validar(f);
  };

  // ── Ingreso a mano: se registra de inmediato ───────────────────────────────
  const agregarManual = async (datos: DatosManual, candidato: Candidato | undefined): Promise<string | null> => {
    const f = nueva({
      placa: datos.placa, manual: datos, numeroLicencia: datos.numeroLicencia, numeroLt: datos.numeroLt,
      tramiteId: candidato?.gestionable ? candidato.tramiteId : undefined,
      companiaNombre: candidato?.companiaNombre ?? null, organismoCodigo: candidato?.organismoCodigo ?? null,
    });
    setFilas((fs) => [f, ...fs]);
    const geo = await obtenerUbicacion();
    const res = await registrarUna(f, geo);
    if (res === 'error') {
      const motivo = filasRef.current.find((r) => r.key === f.key)?.motivo ?? null;
      quitar(f);
      return motivo ?? mensajeEscanear(null);
    }
    setAviso(null); setManual(false);
    return null;
  };

  // ── Hoja «Elige el trámite» ────────────────────────────────────────────────
  const filaHoja = filas.find((f) => f.key === hojaKey) ?? null;
  const continuarTrasHoja = async (f: FilaLt, p: Partial<FilaLt>) => {
    setHojaKey(null);
    const actualizada = { ...f, ...p };
    patch(f.key, p);
    if (f.manual) await registrarUna(actualizada, await obtenerUbicacion()); // la manual ya se había intentado: se completa ahora
  };
  const elegirTramite = (c: Candidato) => { if (filaHoja) void continuarTrasHoja(filaHoja, { tramiteId: c.tramiteId, dejarPendiente: false, estado: 'lista', companiaNombre: c.companiaNombre, organismoCodigo: c.organismoCodigo, candidatos: null }); };
  const dejarPendiente = () => {
    if (!filaHoja) return;
    const org = filaHoja.candidatos?.[0]?.organismoCodigo ?? null;
    void continuarTrasHoja(filaHoja, { tramiteId: undefined, dejarPendiente: true, estado: 'pendiente', companiaNombre: null, organismoCodigo: org, candidatos: null });
  };
  const cancelarHoja = () => { if (filaHoja) quitar(filaHoja); setHojaKey(null); };

  // ── Continuar: registra las que faltan y pasa a la firma ───────────────────
  const entran = useMemo(() => filas.filter(entra), [filas]);
  const sinRegistrar = entran.filter((f) => f.registro !== 'registrada');
  const firmables = entran.filter((f) => f.registro === 'registrada' && !f.firmada && f.documentoId);
  const continuar = async () => {
    setAviso(null);
    if (sinRegistrar.length) {
      setRegistrando(true);
      const geo = await obtenerUbicacion(); // RN-07
      let encoladas = 0; let errores = 0;
      for (const f of sinRegistrar) {
        const r = await registrarUna(filasRef.current.find((x) => x.key === f.key) ?? f, geo);
        if (r === 'elegir') { setRegistrando(false); return; } // la hoja ya está abierta; se retoma al terminar
        if (r === 'encolada') encoladas += 1;
        if (r === 'error') errores += 1;
      }
      setRegistrando(false);
      if (errores) { setAviso({ tipo: 'alert', texto: 'No pudimos registrar las LT. Revisa la señal e inténtalo de nuevo.' }); return; }
      if (encoladas) { setAviso({ tipo: 'status', texto: 'Sin señal: las LT quedan guardadas. Se necesita señal para confirmar la recogida.' }); return; }
    }
    if (!puedeConfirmar) { setAviso({ tipo: 'status', texto: 'Guardamos tus LT escaneadas. Tu usuario no puede confirmar recogidas: pide a Operaciones que lo haga.' }); return; }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { setAviso({ tipo: 'status', texto: 'Sin señal: las LT quedan guardadas. Se necesita señal para confirmar la recogida.' }); return; }
    setVista('firma');
  };

  const alConfirmar = (r: ResumenRecogida) => {
    const ids = new Set(firmables.map((f) => f.key));
    setFilas((fs) => fs.map((f) => (ids.has(f.key) ? { ...f, firmada: true } : f)));
    setResumen(r); setSinFirma(false); setVista('confirmada');
  };
  const listo = () => { porRaw.current.clear(); setFilas([]); setResumen(null); setVista('lista'); setAviso(null); };

  if (vista === 'firma') {
    return <PasoFirma filas={firmables} onAtras={() => setVista('lista')} onConfirmado={alConfirmar} onSinFirma={() => { setSinFirma(true); setVista('lista'); }} />;
  }
  if (vista === 'confirmada' && resumen) return <PantallaConfirmada r={resumen} onListo={listo} onVer={onVerRecogidas} />;

  const vacia = filas.length === 0;
  const camara = escaneoDisponible();
  const hayRegistradasSinFirma = sinFirma && firmables.length > 0;
  const etiqueta = !puedeConfirmar ? 'Guardar LT escaneadas' : sinFirma && sinRegistrar.length === 0 && firmables.length > 0 ? 'Firmar acta' : 'Continuar a la firma';
  const abrir = (setter: (v: boolean) => void) => (e: React.MouseEvent) => { disparador.current = e.currentTarget as HTMLElement; setter(true); };

  return (
    <section className="space-y-3" aria-labelledby="recoger-titulo">
      <div className="flex items-center justify-between gap-2">
        <h2 id="recoger-titulo" className="text-sm font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Recoger licencias</h2>
        {!vacia && <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{filas.length} {filas.length === 1 ? 'escaneada' : 'escaneadas'}</span>}
      </div>

      <div className="flex flex-col gap-2">
        {camara && <BotonEscanear primaria={vacia} otra={!vacia} onClick={() => setEscaneando(true)} />}
        <button type="button" onClick={abrir(setManual)} className={`${!camara && vacia ? flitBtnPrimary : flitBtnSecondary} w-full justify-center`}
          style={{ ...(!camara && vacia ? flitBtnPrimaryStyle : {}), minHeight: 48 }}>
          <PencilLine size={18} aria-hidden="true" /> Ingresar a mano
        </button>
      </div>

      {vacia && <FlitEmpty>Aún no has escaneado licencias. Pulsa {camara ? 'Escanear LT y apunta al código de barras del reverso' : 'Ingresar a mano y escribe los datos de la licencia'}.</FlitEmpty>}

      {hayRegistradasSinFirma && (
        <p role="status" className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-card)', color: 'var(--flit-warning-ink)' }}>
          {firmables.length} {firmables.length === 1 ? 'LT escaneada' : 'LT escaneadas'} con el acta pendiente de firma. Pulsa Firmar acta cuando el funcionario pueda firmar.
        </p>
      )}

      {!vacia && (
        <div className="space-y-2">
          {filas.map((f) => (
            <TarjetaLtRecogida key={f.key} fila={f} onChangeLt={(v) => patch(f.key, { numeroLt: v })} onBorrar={() => quitar(f)}
              onReintentar={() => { patch(f.key, { estado: f.manual ? 'lista' : 'validando', registro: 'no', motivo: null }); if (!f.manual) void validar(f); }}
              onElegir={() => setHojaKey(f.key)} />
          ))}
        </div>
      )}

      {aviso && (
        <div role={aviso.tipo} className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-card)', color: aviso.tipo === 'alert' ? 'var(--flit-danger-ink)' : 'var(--flit-text-primary)' }}>
          {aviso.texto}
        </div>
      )}

      {!vacia && (
        <div className="sticky bottom-3 z-10 lg:bottom-24 rounded-xl p-1" style={{ background: 'var(--flit-bg-app)' }}>
          <button type="button" className={`${flitBtnPrimary} w-full justify-center`} style={{ ...flitBtnPrimaryStyle, minHeight: 48 }}
            disabled={registrando || entran.length === 0 || (!puedeConfirmar && sinRegistrar.length === 0)} onClick={() => void continuar()}>
            {registrando ? 'Registrando…' : `${etiqueta} (${entran.length})`}
          </button>
        </div>
      )}

      {escaneando && <Escaner onScan={procesar} onClose={() => { setEscaneando(false); disparador.current?.focus(); }} />}
      {manual && <IngresoManual onAgregar={agregarManual} onCerrar={() => { setManual(false); disparador.current?.focus(); }} />}
      {filaHoja?.candidatos && (
        <HojaElegirTramite placa={filaHoja.placa} candidatos={filaHoja.candidatos} onElegir={elegirTramite} onPendiente={dejarPendiente} onCancelar={cancelarHoja} />
      )}
    </section>
  );
}

function PantallaConfirmada({ r, onListo, onVer }: { r: ResumenRecogida; onListo: () => void; onVer: () => void }) {
  return (
    <section role="status" className="space-y-4 rounded-xl border bg-flit-card p-4" style={{ borderColor: 'var(--flit-border-soft)' }} aria-labelledby="confirmada-titulo">
      <h2 id="confirmada-titulo" className="text-lg font-bold" style={{ color: 'var(--flit-success-ink)' }}>✓ Recogida confirmada</h2>
      <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
        {r.actas === 1 ? '1 acta generada' : `${r.actas} actas generadas`} con una firma.
      </p>
      <ul className="space-y-1 text-sm">
        {r.companias.map((c) => (
          <li key={c.nombre} className="flex justify-between gap-2" style={{ color: 'var(--flit-text-secondary)' }}><span>{c.nombre}</span><span className="shrink-0 tabular-nums">{c.lt} LT</span></li>
        ))}
      </ul>
      {r.pendientes > 0 && (
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          {r.pendientes} {r.pendientes === 1 ? 'LT pendiente' : 'LT pendientes'} de trámite: quedó firmada, sin acta. Operaciones elegirá el trámite.
        </p>
      )}
      <div className="flex flex-col gap-2">
        <button type="button" autoFocus className={`${flitBtnPrimary} w-full justify-center`} style={{ ...flitBtnPrimaryStyle, minHeight: 48 }} onClick={onListo}>Listo</button>
        <button type="button" className="flit-focus mx-auto rounded px-2 py-2 text-sm font-medium underline-offset-2 transition-colors hover:underline" style={{ color: 'var(--flit-blue-text)', minHeight: 40 }} onClick={onVer}>
          Ver en Mis recogidas
        </button>
      </div>
    </section>
  );
}
