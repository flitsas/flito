// FLITO Logística — «Firmar entrega y despachar» (HU #14353, R1). Los mensajeros salen de `GET /actas/:id/mensajeros`:
// la lista es por acta, no global. Operaciones los ve en <optgroup> nativo; el proveedor, sin etiqueta de pertenencia.
// Un error deja el modal abierto con la firma trazada: es lo que cuesta rehacer.
import { useEffect, useRef, useState } from 'react';
import type { ActaFilaLogistica, MensajeroDeActa } from '@operaciones/shared-types';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { esRechazoDeAlcance, mensajeLecturaLogistica, MENSAJE_ESCRITURA_RECHAZADA } from '../../../lib/mensajesLogisticaHttp';
import { codigoDe } from '../../../lib/viajesCliente';
import FlitModal from '../../flit/FlitModal';
import { toastError, toastOk } from '../../flit/ToastFlito';
import { FlitField, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle, flitInp } from '../../flit/flitPageKit';
import FirmaCanvas from '../FirmaCanvas';

type Carga = 'cargando' | 'ok' | 'error';

function mensajeDespachar(e: unknown): string {
  if (esRechazoDeAlcance(e)) return MENSAJE_ESCRITURA_RECHAZADA;
  const codigo = codigoDe(e);
  if (codigo === 'MENSAJERO_NO_ASIGNABLE') return 'Este mensajero ya no está disponible. Elija otro.';
  if (codigo === 'LT_DE_OTRO_PROVEEDOR') return 'Alguna licencia de este viaje ya no es del proveedor actual de la compañía. Cierre esta ventana y revise el viaje.';
  return 'No se pudo despachar el viaje. La firma sigue aquí; inténtelo de nuevo.';
}

interface Props {
  acta: ActaFilaLogistica;
  onClose: () => void;
  onDespachado: () => void;
  /** Lo que se ve quedó viejo (403/404): la consola recarga sus listas. */
  onListaVieja: () => void;
}

export default function ModalDespacharActa({ acta, onClose, onDespachado, onListaVieja }: Props) {
  const { tipoEnlace } = useAuth();
  const esProveedor = tipoEnlace === 'proveedor';
  const [carga, setCarga] = useState<Carga>('cargando');
  const [mensajeros, setMensajeros] = useState<MensajeroDeActa[]>([]);
  const [sel, setSel] = useState('');
  const [nombre, setNombre] = useState('');
  const [firma, setFirma] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const vivo = useRef(true);
  useEffect(() => { vivo.current = true; return () => { vivo.current = false; }; }, []);

  /** Silencioso: si este GET falla, la lista ya visible se conserva y el modal no pierde la firma ni el aviso. */
  const cargar = (silencioso = false) => {
    if (!silencioso) setCarga('cargando');
    api.get<MensajeroDeActa[]>(`/flito/logistica/actas/${acta.id}/mensajeros`)
      .then((r) => { if (vivo.current) { setMensajeros(r); setCarga('ok'); } })
      .catch((e: unknown) => {
        if (!vivo.current || silencioso) return;
        if (esRechazoDeAlcance(e)) {
          toastError(mensajeLecturaLogistica(e, 'acta').texto, undefined, { id: 'logistica-acta' });
          onListaVieja();
          onClose();
          return;
        }
        setCarga('error');
      });
  };
  const cargarVigente = useRef(cargar);
  cargarVigente.current = cargar;
  useEffect(() => { cargarVigente.current(); }, [acta.id]);

  // Derivado de la lista: el mensajero que salió de ella (422) deja de contar como elegido.
  const elegido = mensajeros.some((m) => String(m.id) === sel) ? sel : '';
  const agrupar = !esProveedor && mensajeros.some((m) => m.grupo);
  const deFlito = mensajeros.filter((m) => m.grupo !== 'proveedor');
  const delProveedor = mensajeros.filter((m) => m.grupo === 'proveedor');
  const opcion = (m: MensajeroDeActa) => <option key={m.id} value={m.id}>{m.nombre}</option>;

  const despachar = async () => {
    if (busy || !elegido || !firma) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/flito/logistica/actas/${acta.id}/despachar`, { mensajeroId: Number(elegido), firmaEntrega: firma, entregaNombre: nombre.trim() || undefined });
      const m = mensajeros.find((x) => String(x.id) === elegido);
      toastOk(`Viaje despachado a ${m?.nombre ?? 'el mensajero'}.`);
      onDespachado();
    } catch (e) {
      setError(mensajeDespachar(e));
      if (esRechazoDeAlcance(e)) onListaVieja();
      else if (codigoDe(e) === 'MENSAJERO_NO_ASIGNABLE') cargar(true);
    } finally {
      if (vivo.current) setBusy(false);
    }
  };

  const pie = (deshabilitado: boolean) => (
    <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <button type="button" className={`${flitBtnSecondary} w-full justify-center sm:w-auto`} style={flitBtnSecondaryStyle} disabled={busy} onClick={onClose}>Cancelar</button>
      <button type="button" className={`${flitBtnPrimary} w-full justify-center sm:w-auto`} style={flitBtnPrimaryStyle} disabled={deshabilitado} onClick={() => void despachar()}>Firmar y despachar</button>
    </div>
  );

  return (
    <FlitModal title="Firmar entrega y despachar" onClose={onClose} cierreBloqueado={busy}>
      {carga === 'ok' && mensajeros.length === 0 ? (
        <>
          <div role="status" className="rounded-lg border px-3 py-3 text-sm" style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-card)', color: 'var(--flit-text-primary)' }}>
            {esProveedor ? (
              <><p>Su empresa aún no tiene mensajeros activos.</p><p className="mt-1">Pídale a Operaciones de FLITO que cree el usuario.</p></>
            ) : (
              <><p>No hay mensajeros disponibles para esta acta.</p><p className="mt-1">Cree un usuario con rol Mensajero.</p></>
            )}
          </div>
          {pie(true)}
        </>
      ) : (
        <>
          {carga === 'error' ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 text-sm" style={{ color: 'var(--flit-danger-text)' }}>
              <p className="flex-1">No se pudieron cargar los mensajeros.</p>
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => cargar()}>Reintentar</button>
            </div>
          ) : (
            <FlitField label="Mensajero">
              {carga === 'cargando' ? (
                <select className={flitInp} disabled><option>Cargando mensajeros…</option></select>
              ) : (
                <select className={flitInp} value={elegido} onChange={(e) => setSel(e.target.value)}>
                  <option value="">Elija…</option>
                  {agrupar ? (
                    <>
                      {deFlito.length > 0 && <optgroup label="Mensajeros de FLITO">{deFlito.map(opcion)}</optgroup>}
                      {delProveedor.length > 0 && <optgroup label={`Mensajeros de ${delProveedor[0].proveedorNombre ?? 'el proveedor'}`}>{delProveedor.map(opcion)}</optgroup>}
                    </>
                  ) : mensajeros.map(opcion)}
                </select>
              )}
            </FlitField>
          )}
          <div className="mt-3">
            <FlitField label="Nombre de quien entrega">
              <input className={flitInp} value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Opcional: por defecto, su usuario" />
            </FlitField>
          </div>
          <div className="mt-3">
            <span className="mb-1 block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Firma de quien entrega</span>
            <FirmaCanvas label="Firma de quien entrega" onChange={setFirma} />
          </div>
          {error && <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--flit-danger-text)' }}>{error}</p>}
          {pie(busy || carga !== 'ok' || !elegido || !firma)}
        </>
      )}
    </FlitModal>
  );
}
