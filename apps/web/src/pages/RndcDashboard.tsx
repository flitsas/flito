import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import KpiCard from '../components/flit/KpiCard';
import { Dona, SERIE_KIT } from '../components/flit/Graficos';
import { Accesos } from '../components/flit/Bloques';
import { EstadoVista } from '../components/flit/Cargador';

interface Resumen {
  rango: { desde: string; hasta: string };
  manifiestos: {
    borradores: string; listos: string; radicados: string;
    aceptados: string; rechazados: string; cumplidos: string;
    anulados: string; total: string;
  };
  remesas: {
    borradores: string; activas_sin_manifiesto: string;
    cumplidas: string; anuladas: string; total: string;
  };
  revenue: {
    revenue_total: string; revenue_facturable: string; anticipos: string;
  };
}

function fmtCop(n: number | string | null | undefined): string {
  if (n == null) return '$ 0';
  const v = typeof n === 'string' ? Number(n) : n;
  return '$ ' + v.toLocaleString('es-CO');
}

export default function RndcDashboard() {
  const [data, setData] = useState<Resumen | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.get<Resumen>('/rndc/indicadores/resumen');
        setData(r);
      } catch (err) { toast.error(errorMessage(err)); }
      finally { setLoading(false); }
    })();
  }, []);

  if (loading) return <EstadoVista status="loading" cargando="Cargando..." />;
  if (!data) return <EstadoVista status="empty" emptyMessage="Sin datos" />;

  const m = data.manifiestos;
  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Despachos y manifiestos RNDC"
        subtitle={`Periodo ${data.rango.desde} → ${data.rango.hasta}`}
        icono="flito-rndc"
        miga={[{ etiqueta: 'Cumplimiento' }, { etiqueta: 'RNDC' }]}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Manifiestos del periodo" value={data.manifiestos.total} hint={`${data.manifiestos.cumplidos} cumplidos`} />
        <KpiCard label="Ingreso facturable" value={fmtCop(data.revenue.revenue_facturable)} hint={`Anticipos ${fmtCop(data.revenue.anticipos)}`} />
        <KpiCard label="Remesas activas sin manifiesto" value={data.remesas.activas_sin_manifiesto} hint={`${data.remesas.total} totales`} pendiente />
        <KpiCard label="Revenue total" value={fmtCop(data.revenue.revenue_total)} />
      </div>

      <section className="card p-5" aria-label="Manifiestos por estado">
        <Dona
          etiqueta="Manifiestos por estado"
          pie="manifiestos"
          partes={[
            { t: 'Borradores', v: Number(m.borradores), c: SERIE_KIT.gris },
            { t: 'Listos', v: Number(m.listos), c: SERIE_KIT.turquesa },
            { t: 'Radicados', v: Number(m.radicados), c: SERIE_KIT.azul },
            { t: 'Cumplidos', v: Number(m.cumplidos), c: SERIE_KIT.verde },
            { t: 'Aceptados', v: Number(m.aceptados), c: SERIE_KIT.amarillo },
            { t: 'Rechazados', v: Number(m.rechazados), c: SERIE_KIT.rojo },
            { t: 'Anulados', v: Number(m.anulados), c: SERIE_KIT.tinta },
          ]}
        />
      </section>

      <Accesos items={[
        { to: '/rndc/remesas', titulo: 'Remesas', detalle: 'Crear, asignar, cumplir remesas de carga', icono: 'documentos' },
        { to: '/rndc/manifiestos', titulo: 'Manifiestos', detalle: 'Generar manifiestos electrónicos para Mintransporte', icono: 'generacion-documental' },
        { to: '/rndc/maestros', titulo: 'Maestros', detalle: 'Tenedores, propietarios y destinatarios de carga', icono: 'empresas' },
      ]} />
    </div>
  );
}
