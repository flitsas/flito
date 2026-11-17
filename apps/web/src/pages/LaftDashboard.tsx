import { useEffect, useState, useCallback } from 'react';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import KpiCard from '../components/flit/KpiCard';
import { EstadoVista, type EstadoUi } from '../components/flit/Cargador';

// MVP read-only (USR-5): Tablero LAFT. Conectado a GET /api/laft/dashboard
// (laft_dashboard, accesible a admin|compliance|auditor). Solo lectura.
interface Dashboard {
  officerInfo?: { principal?: boolean; suplente?: boolean; principalIso17024?: boolean; ok?: boolean };
  manualVigente?: { version?: number; publicadoAt?: string | null; sha256?: string | null } | null;
  contrapartesAgg?: { total?: number; alto?: number; pendientes?: number; bloqueadas?: number };
  empleadosVencidos?: number;
}

const MIGA = [{ etiqueta: 'Cumplimiento' }, { etiqueta: 'LAFT', to: '/laft' }];

export default function LaftDashboard() {
  const [d, setD] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setD(await api.get<Dashboard>('/laft/dashboard')); }
    catch (e) { setError(errorMessage(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const cp = d?.contrapartesAgg ?? {};
  const estado: EstadoUi = loading ? 'loading' : error ? 'error' : d ? 'ready' : 'empty';

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Estado del cumplimiento"
        subtitle="Indicadores clave del sistema SARLAFT: gobierno, manual vigente, contrapartes y debida diligencia"
        icono="flito-laft"
        miga={MIGA}
      />

      {/* Lo que pide atención (Revisar / Sin publicar / vencidos > 0) va en naranja (`pendiente`); el resto, cifra azul. */}
      <EstadoVista status={estado} cargando="Cargando..." onRetry={load} errorMessage={error ?? undefined}>
        {d && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              label="Oficial de cumplimiento"
              value={d.officerInfo?.ok ? 'Conforme' : 'Revisar'}
              pendiente={!d.officerInfo?.ok}
              icono="perfil"
              hint={`Principal: ${d.officerInfo?.principal ? 'sí' : 'no'} · Suplente: ${d.officerInfo?.suplente ? 'sí' : 'no'} · ISO 17024: ${d.officerInfo?.principalIso17024 ? 'sí' : 'no'}`}
            />
            <KpiCard
              label="Manual SARLAFT vigente"
              value={d.manualVigente?.version != null ? `v${d.manualVigente.version}` : 'Sin publicar'}
              pendiente={d.manualVigente?.version == null}
              icono="documentos"
              hint={d.manualVigente?.publicadoAt ? `Publicado ${new Date(d.manualVigente.publicadoAt).toLocaleDateString('es-CO')}` : 'No hay manual publicado'}
            />
            <KpiCard
              label="Contrapartes"
              value={cp.total ?? 0}
              icono="empresas"
              hint={`Riesgo alto: ${cp.alto ?? 0} · Pendientes: ${cp.pendientes ?? 0} · Bloqueadas: ${cp.bloqueadas ?? 0}`}
            />
            <KpiCard
              label="KYC empleados vencidos"
              value={d.empleadosVencidos ?? 0}
              pendiente={(d.empleadosVencidos ?? 0) > 0}
              icono="vencidos"
              hint="Revisión periódica de debida diligencia"
            />
          </div>
        )}
      </EstadoVista>
    </div>
  );
}
