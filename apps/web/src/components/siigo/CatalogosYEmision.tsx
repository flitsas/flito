// Facturación electrónica — catálogos y configuración global de emisión (HU #11288).
//
// La segunda pestaña de la parametrización. Comparte página, ruta y permiso con el mapeo de
// conceptos (HU #11287): son el mismo trabajo y la misma persona.
//
// Dos reglas que sostienen la pantalla:
//
//   1. **Ningún identificador de Siigo se escribe a mano** (AC4). Los cuatro campos son listas
//      pobladas desde los catálogos sincronizados. Un campo de texto libre para un `id` de Siigo es
//      exactamente cómo se acaba facturando contra el vendedor equivocado.
//   2. **Un valor que dejó de ser válido se ve y BLOQUEA** (AC5). El servidor ya calcula el
//      diagnóstico campo a campo al leer; la pantalla no lo recalcula, lo muestra — y no deja
//      guardar hasta que se elige uno válido.

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import {
  CAMPOS_CATALOGO_EMISION,
  CAMPO_CATALOGO_EMISION_ETIQUETA,
  type CampoCatalogoEmision,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../../lib/api';
import GradientButton from '../flit/GradientButton';
import StatusChip from '../flit/StatusChip';
import { CARD, fecha, inputCls } from './estilos';

// ── Contratos del backend ───────────────────────────────────────────────────

interface ResumenCatalogo {
  tipo: string;
  etiqueta: string;
  total: number;
  activos: number;
  sincronizadoEn: string | null;
}

interface ResultadoCatalogo {
  tipo: string;
  etiqueta: string;
  ok: boolean;
  total: number;
  inactivados: number;
  descartados: number;
  vaciadoMasivo: boolean;
  error: { codigo: string; mensaje: string } | null;
}

interface ResultadoSincronizacion {
  ok: boolean;
  parcial: boolean;
  vaciadoMasivo: boolean;
  catalogos: ResultadoCatalogo[];
}

interface CampoValidado {
  campo: CampoCatalogoEmision;
  etiqueta: string;
  codigo: string | null;
  nombre: string | null;
  validez: string;
  mensaje: string | null;
}

interface ConfigEmision {
  id: string;
  documentoTipoCodigo: string | null;
  vendedorCodigo: string | null;
  formaPagoCodigo: string | null;
  centroCostoCodigo: string | null;
  plazoVencimientoDias: number;
  estrategiaNumeracion: string;
  notas: string | null;
  campos: CampoValidado[];
  utilizable: boolean;
}

interface ElementoCatalogo { codigo: string; nombre: string; activo: boolean }

/** De qué catálogo se puebla cada campo. Mismo mapa que usa el servidor. */
const CATALOGO_DE_CAMPO: Record<CampoCatalogoEmision, string> = {
  documentoTipo: 'document_type',
  vendedor: 'user',
  formaPago: 'payment_type',
  centroCosto: 'cost_center',
};

/** Valideces que significan «este campo está mal» y por tanto impiden guardar (AC5). */
const VALIDEZ_INVALIDA = ['no_existe', 'inactivo', 'catalogo_sin_sincronizar'];

export default function CatalogosYEmision({ ambiente, puedeEditar, onCambio }: {
  ambiente: string;
  puedeEditar: boolean;
  onCambio: () => void;
}) {
  const [resumen, setResumen] = useState<ResumenCatalogo[]>([]);
  const [config, setConfig] = useState<ConfigEmision | null>(null);
  const [opciones, setOpciones] = useState<Partial<Record<CampoCatalogoEmision, ElementoCatalogo[]>>>({});
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [sincronizando, setSincronizando] = useState(false);
  const [ultimaSync, setUltimaSync] = useState<ResultadoSincronizacion | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const [cat, cfg] = await Promise.all([
        api.get<{ data: ResumenCatalogo[] }>(`/siigo/parametrizacion/catalogos?ambiente=${ambiente}`),
        api.get<{ config: ConfigEmision | null }>(`/siigo/config-emision?ambiente=${ambiente}`),
      ]);
      setResumen(cat.data ?? []);
      setConfig(cfg.config);

      // Las opciones de los cuatro campos salen de la copia local: nunca se escriben (AC4).
      const listas = await Promise.all(CAMPOS_CATALOGO_EMISION.map(async (campo) => {
        const r = await api.get<{ elementos: ElementoCatalogo[] }>(
          `/siigo/parametrizacion/catalogos/${CATALOGO_DE_CAMPO[campo]}?ambiente=${ambiente}`,
        ).catch(() => ({ elementos: [] as ElementoCatalogo[] }));
        return [campo, (r.elementos ?? []).filter((e) => e.activo)] as const;
      }));
      setOpciones(Object.fromEntries(listas) as Partial<Record<CampoCatalogoEmision, ElementoCatalogo[]>>);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCargando(false);
    }
  }, [ambiente]);

  useEffect(() => { void cargar(); }, [cargar]);

  const sincronizar = async () => {
    setSincronizando(true);
    setUltimaSync(null);
    try {
      const r = await api.post<ResultadoSincronizacion>(
        `/siigo/parametrizacion/catalogos/sincronizar?ambiente=${ambiente}`,
      );
      setUltimaSync(r);
      if (r.ok && !r.vaciadoMasivo) toast.success('Catálogos sincronizados');
      else if (r.parcial) toast.error('Sincronización parcial: revisa el detalle');
      await cargar();
      onCambio();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSincronizando(false);
    }
  };

  const nuncaSincronizado = resumen.length > 0 && resumen.every((c) => c.sincronizadoEn === null);

  if (cargando) {
    return (
      <p className="px-6 py-10 text-center text-sm" role="status" style={{ color: 'var(--flit-text-muted)' }}>
        Cargando catálogos y configuración…
      </p>
    );
  }

  if (error) {
    return (
      <div className="px-6 py-10 text-center">
        <p role="alert" className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
          <span aria-hidden="true" style={{ color: 'var(--flit-danger)' }}>⚠ </span>{error}
        </p>
        <button
          type="button"
          onClick={() => { void cargar(); }}
          className="flit-focus mt-4 rounded-[10px] border px-4 py-2 text-sm font-semibold"
          style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
        >
          Reintentar
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="bg-white" style={CARD}>
        <header className="flex items-center justify-between border-b px-6 py-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <h2 className="text-base font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            Catálogos de Siigo
          </h2>
          {puedeEditar && (
            <GradientButton
              type="button"
              onClick={() => { void sincronizar(); }}
              // AC3 — deshabilitada mientras corre: dispararla dos veces gasta el doble de cuota
              // de Siigo para traer exactamente lo mismo.
              disabled={sincronizando}
            >
              {sincronizando ? 'Sincronizando…' : 'Sincronizar ahora'}
            </GradientButton>
          )}
        </header>

        {/* AC2 — vacío: invita a sincronizar por primera vez. */}
        {nuncaSincronizado ? (
          <div className="px-6 py-10 text-center">
            <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
              Todavía no se han traído los catálogos de Siigo en este ambiente.
            </p>
            <p className="mt-1 text-sm" style={{ color: 'var(--flit-text-muted)' }}>
              Sin ellos no se puede elegir tipo de comprobante, vendedor, forma de pago ni centro de
              costo: son las listas de las que salen esos valores. Sincroniza para empezar.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Catálogos sincronizados desde Siigo en el ambiente {ambiente}</caption>
              <thead>
                <tr style={{ color: 'var(--flit-text-muted)' }}>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">Catálogo</th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">Activos</th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">Total</th>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">Última sincronización</th>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">Resultado</th>
                </tr>
              </thead>
              <tbody>
                {resumen.map((c) => {
                  const r = ultimaSync?.catalogos.find((x) => x.tipo === c.tipo);
                  return (
                    <tr key={c.tipo} className="border-t" style={{ borderColor: 'var(--flit-border-soft)' }}>
                      <th scope="row" className="px-4 py-3 text-left font-medium" style={{ color: 'var(--flit-text-primary)' }}>
                        {c.etiqueta}
                      </th>
                      <td className="px-4 py-3 text-right">{c.activos}</td>
                      <td className="px-4 py-3 text-right">{c.total}</td>
                      <td className="px-4 py-3">{fecha(c.sincronizadoEn)}</td>
                      <td className="px-4 py-3">
                        {r === undefined && <span style={{ color: 'var(--flit-text-muted)' }}>—</span>}
                        {r?.ok && !r.vaciadoMasivo && <StatusChip tone="success">{`${r.total} traídos`}</StatusChip>}
                        {/* Un catálogo poblado que vuelve vacío es técnicamente un éxito y un
                            problema: sin señalarlo, la pantalla lo anunciaría en verde. */}
                        {r?.vaciadoMasivo && <StatusChip tone="warning">Volvió vacío</StatusChip>}
                        {r && !r.ok && (
                          <>
                            <StatusChip tone="danger">Falló</StatusChip>
                            <span className="mt-1 block text-xs" style={{ color: 'var(--flit-text-primary)' }}>
                              {r.error?.mensaje ?? 'Siigo no respondió.'}
                            </span>
                          </>
                        )}
                        {r && r.descartados > 0 && (
                          <span className="mt-1 block text-xs" style={{ color: 'var(--flit-text-muted)' }}>
                            {r.descartados} descartados por código no utilizable
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <FormularioEmision
        ambiente={ambiente}
        puedeEditar={puedeEditar}
        config={config}
        opciones={opciones}
        onGuardado={async () => { await cargar(); onCambio(); }}
      />
    </div>
  );
}

// ── Configuración global de emisión ─────────────────────────────────────────

function FormularioEmision({ ambiente, puedeEditar, config, opciones, onGuardado }: {
  ambiente: string;
  puedeEditar: boolean;
  config: ConfigEmision | null;
  opciones: Partial<Record<CampoCatalogoEmision, ElementoCatalogo[]>>;
  onGuardado: () => Promise<void>;
}) {
  const [valores, setValores] = useState<Record<CampoCatalogoEmision, string>>({
    documentoTipo: '', vendedor: '', formaPago: '', centroCosto: '',
  });
  const [plazo, setPlazo] = useState(0);
  const [guardando, setGuardando] = useState(false);
  const [fallo, setFallo] = useState<string | null>(null);

  useEffect(() => {
    setValores({
      documentoTipo: config?.documentoTipoCodigo ?? '',
      vendedor: config?.vendedorCodigo ?? '',
      formaPago: config?.formaPagoCodigo ?? '',
      centroCosto: config?.centroCostoCodigo ?? '',
    });
    setPlazo(config?.plazoVencimientoDias ?? 0);
  }, [config]);

  const diagnostico = (campo: CampoCatalogoEmision): CampoValidado | undefined =>
    config?.campos.find((c) => c.campo === campo);

  /**
   * AC5 — con un valor inválido NO se puede guardar.
   *
   * Se mira el valor que hay AHORA en el formulario: si quien parametriza ya eligió otro, el
   * bloqueo desaparece sin necesidad de recargar. Bloquear por el diagnóstico del servidor sin
   * mirar el formulario dejaría la pantalla trabada aunque el problema ya estuviera resuelto.
   */
  const camposInvalidos = CAMPOS_CATALOGO_EMISION.filter((campo) => {
    const d = diagnostico(campo);
    if (d === undefined || !VALIDEZ_INVALIDA.includes(d.validez)) return false;
    return valores[campo] === (d.codigo ?? '');
  });

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    if (camposInvalidos.length > 0) return;
    setGuardando(true);
    setFallo(null);
    try {
      await api.put(`/siigo/config-emision?ambiente=${ambiente}`, {
        documentoTipoCodigo: valores.documentoTipo === '' ? null : valores.documentoTipo,
        vendedorCodigo: valores.vendedor === '' ? null : valores.vendedor,
        formaPagoCodigo: valores.formaPago === '' ? null : valores.formaPago,
        centroCostoCodigo: valores.centroCosto === '' ? null : valores.centroCosto,
        plazoVencimientoDias: plazo,
      });
      toast.success('Configuración de emisión guardada');
      await onGuardado();
    } catch (e2) {
      setFallo(errorMessage(e2));
    } finally {
      setGuardando(false);
    }
  };

  return (
    <section className="bg-white" style={CARD}>
      <header className="border-b px-6 py-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
        <h2 className="text-base font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
          Configuración global de emisión
        </h2>
        <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>
          Con qué tipo de comprobante, vendedor, forma de pago y centro de costo nacen las facturas.
        </p>
      </header>

      <form onSubmit={guardar} className="space-y-4 px-6 py-5">
        {CAMPOS_CATALOGO_EMISION.map((campo) => {
          const d = diagnostico(campo);
          const invalido = camposInvalidos.includes(campo);
          const noAplica = d?.validez === 'no_aplica';
          const id = `campo-${campo}`;
          return (
            <div key={campo}>
              <label htmlFor={id} className="mb-1.5 block text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>
                {CAMPO_CATALOGO_EMISION_ETIQUETA[campo]}
                {noAplica && (
                  <span className="ml-2 text-xs font-normal" style={{ color: 'var(--flit-text-muted)' }}>
                    · no lo exige el comprobante elegido
                  </span>
                )}
              </label>
              {/* AC4 — lista, nunca texto libre: un `id` de Siigo escrito a mano es cómo se acaba
                  facturando contra el vendedor equivocado. */}
              <select
                id={id}
                className={inputCls}
                value={valores[campo]}
                disabled={!puedeEditar}
                aria-invalid={invalido}
                aria-describedby={invalido ? `${id}-error` : undefined}
                onChange={(e) => setValores((v) => ({ ...v, [campo]: e.target.value }))}
              >
                <option value="">Sin configurar</option>
                {(opciones[campo] ?? []).map((o) => (
                  <option key={o.codigo} value={o.codigo}>{o.nombre}</option>
                ))}
              </select>
              {invalido && (
                <p id={`${id}-error`} className="mt-1 text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
                  <span aria-hidden="true" style={{ color: 'var(--flit-danger)' }}>⚠ </span>
                  {d?.mensaje ?? 'Este valor dejó de ser válido en Siigo.'}
                </p>
              )}
              {(opciones[campo] ?? []).length === 0 && (
                <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
                  No hay opciones sincronizadas para este catálogo.
                </p>
              )}
            </div>
          );
        })}

        <div>
          <label htmlFor="plazo" className="mb-1.5 block text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>
            Plazo de vencimiento (días)
          </label>
          <input
            id="plazo"
            type="number"
            min={0}
            max={365}
            className={inputCls}
            value={plazo}
            disabled={!puedeEditar}
            onChange={(e) => setPlazo(Number(e.target.value))}
          />
          <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            Cero significa de contado. Sigue pendiente de confirmación de contabilidad.
          </p>
        </div>

        {camposInvalidos.length > 0 && (
          <p
            role="alert"
            className="rounded-[10px] px-4 py-3 text-sm"
            style={{
              background: 'rgba(228, 61, 48, 0.10)',
              borderLeft: '4px solid var(--flit-danger)',
              color: 'var(--flit-text-primary)',
            }}
          >
            Hay valores que dejaron de ser válidos en Siigo. Elige otros antes de guardar: con uno
            inválido, la factura se rechazaría en el momento de emitir.
          </p>
        )}

        {fallo && (
          <p role="alert" className="rounded-[10px] px-4 py-3 text-sm"
            style={{
              background: 'rgba(228, 61, 48, 0.10)',
              borderLeft: '4px solid var(--flit-danger)',
              color: 'var(--flit-text-primary)',
            }}
          >
            {fallo}
          </p>
        )}

        {puedeEditar && (
          <div className="flex justify-end pt-2">
            <GradientButton type="submit" disabled={guardando || camposInvalidos.length > 0}>
              {guardando ? 'Guardando…' : 'Guardar configuración'}
            </GradientButton>
          </div>
        )}
      </form>
    </section>
  );
}
