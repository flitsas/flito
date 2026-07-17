import { BrowserRouter, Routes, Route, Navigate, useSearchParams } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './lib/auth';
import { ThemeProvider } from './lib/theme';
import { hasPage, PageSlug } from './lib/permissions';
import Layout from './components/Layout';
import NoAccess from './components/NoAccess';
import PageContentSkeleton from './components/flit/PageContentSkeleton';
import Login from './pages/Login';
import { lazy, Suspense } from 'react';

// FIONA F1 (perf/login-lazy-routes): páginas post-login en code-split. Antes eran
// imports estáticos → viajaban en el chunk `index` cargado en /login (entrada no
// autenticada). Solo `Login` queda eager; el resto se carga tras autenticar.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Vehicles = lazy(() => import('./pages/Vehicles'));
const Soat = lazy(() => import('./pages/Soat'));
const FlitoTablero = lazy(() => import('./pages/FlitoTablero'));
const FlitoBitacora = lazy(() => import('./pages/FlitoBitacora'));
const FlitoCompuerta = lazy(() => import('./pages/FlitoCompuerta'));
const FlitoRevisiones = lazy(() => import('./pages/FlitoRevisiones'));
const Users = lazy(() => import('./pages/Users'));
const Clients = lazy(() => import('./pages/Clients'));
const TaxReader = lazy(() => import('./pages/TaxReader'));
const TramiteDigital = lazy(() => import('./pages/TramiteDigital'));
const TramiteTraspaso = lazy(() => import('./pages/TramiteTraspaso'));

const TransitoBandeja = lazy(() => import('./pages/TransitoBandeja'));
const TransitoOrganismos = lazy(() => import('./pages/TransitoOrganismos'));
const TransitoTraspasoExpediente = lazy(() => import('./pages/TransitoTraspasoExpediente'));
const DriveViewer = lazy(() => import('./pages/DriveViewer'));
const Laft = lazy(() => import('./pages/Laft'));
const LaftUnusual = lazy(() => import('./pages/LaftUnusual'));
const LaftTrainings = lazy(() => import('./pages/LaftTrainings'));
const LaftManual = lazy(() => import('./pages/LaftManual'));
const LaftOfficer = lazy(() => import('./pages/LaftOfficer'));
const LaftAuditPlan = lazy(() => import('./pages/LaftAuditPlan'));
const LaftDashboard = lazy(() => import('./pages/LaftDashboard'));
const Privacy = lazy(() => import('./pages/Privacy'));
const Fleet = lazy(() => import('./pages/Fleet'));
const FleetVehicleDetail = lazy(() => import('./pages/FleetVehicleDetail'));
const Maintenance = lazy(() => import('./pages/Maintenance'));
const Parts = lazy(() => import('./pages/Parts'));
const Routines = lazy(() => import('./pages/Routines'));
const Schedule = lazy(() => import('./pages/Schedule'));
const WorkOrders = lazy(() => import('./pages/WorkOrders'));
const WorkOrderDetail = lazy(() => import('./pages/WorkOrderDetail'));
const MaintenanceIndicators = lazy(() => import('./pages/MaintenanceIndicators'));
const Drivers = lazy(() => import('./pages/Drivers'));
const DriverDetail = lazy(() => import('./pages/DriverDetail'));
const SafetyTrainings = lazy(() => import('./pages/SafetyTrainings'));
const RoadIncidents = lazy(() => import('./pages/RoadIncidents'));
const PesvDashboard = lazy(() => import('./pages/PesvDashboard'));
const Checklists = lazy(() => import('./pages/Checklists'));
const ChecklistRun = lazy(() => import('./pages/ChecklistRun'));
const AlcoholTests = lazy(() => import('./pages/AlcoholTests'));
const Emergency = lazy(() => import('./pages/Emergency'));
const OperationalIndicators = lazy(() => import('./pages/OperationalIndicators'));
const PesvPolicy = lazy(() => import('./pages/PesvPolicy'));
const PesvComite = lazy(() => import('./pages/PesvComite'));
const PesvPlan = lazy(() => import('./pages/PesvPlan'));
const PesvDiagnostico = lazy(() => import('./pages/PesvDiagnostico'));
const PesvDiagnosticoAuditoria = lazy(() => import('./pages/PesvDiagnosticoAuditoria'));
const PesvTablero = lazy(() => import('./pages/PesvTablero'));
const ReportarIncidente = lazy(() => import('./pages/ReportarIncidente'));
const PesvAuditorias = lazy(() => import('./pages/PesvAuditorias'));
const PesvComunicaciones = lazy(() => import('./pages/PesvComunicaciones'));
const PesvContratistas = lazy(() => import('./pages/PesvContratistas'));
const PesvLogPii = lazy(() => import('./pages/PesvLogPii'));
const PesvRaci = lazy(() => import('./pages/PesvRaci'));
const PesvNormativa = lazy(() => import('./pages/PesvNormativa'));
const PesvRetencion = lazy(() => import('./pages/PesvRetencion'));
const RoadIncidentsStats = lazy(() => import('./pages/RoadIncidentsStats'));
const JornadasConductor = lazy(() => import('./pages/JornadasConductor'));
const MiJornada = lazy(() => import('./pages/MiJornada'));
const PesvRoutes = lazy(() => import('./pages/PesvRoutes'));
const PesvPernocta = lazy(() => import('./pages/PesvPernocta'));
const RndcDashboard = lazy(() => import('./pages/RndcDashboard'));
const RndcRemesas = lazy(() => import('./pages/RndcRemesas'));
const RndcRemesaForm = lazy(() => import('./pages/RndcRemesaForm'));
const RndcManifiestos = lazy(() => import('./pages/RndcManifiestos'));
const RndcManifiestoWizard = lazy(() => import('./pages/RndcManifiestoWizard'));
const RndcManifiestoDetail = lazy(() => import('./pages/RndcManifiestoDetail'));
const RndcMaestros = lazy(() => import('./pages/RndcMaestros'));
const RndcAdminCredenciales = lazy(() => import('./pages/RndcAdminCredenciales'));
const RumSummary = lazy(() => import('./pages/admin/RumSummary'));
const TramitesMetricas = lazy(() => import('./pages/admin/TramitesMetricas'));
const PublicManifiesto = lazy(() => import('./pages/PublicManifiesto'));
const PublicTramiteVerify = lazy(() => import('./pages/PublicTramiteVerify'));
const PublicTramitePortal = lazy(() => import('./pages/PublicTramitePortal'));

function ProtectedRoute({ children, page }: { children: React.ReactNode; page?: PageSlug }) {
  const { user, loading } = useAuth();

  if (loading) return <div className="flex items-center justify-center h-screen text-text-tertiary">Cargando...</div>;
  if (!user) return <Navigate to="/login" />;
  if (page && !hasPage(user, page)) return <NoAccess page={page} />;

  return <>{children}</>;
}

// TRAM-TRASPASO-F5 — gate del wizard de traspaso: el operador STT (role
// `transito`) no usa el wizard del gestor CEA; se le redirige a su expediente
// STT (/transito/traspaso?id=N) o a la bandeja si entra sin id.
function TramiteTraspasoGate() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const id = searchParams.get('id');
  if (user?.role === 'transito') {
    return id ? <Navigate to={`/transito/traspaso?id=${id}`} replace /> : <Navigate to="/transito" replace />;
  }
  if (!user || !hasPage(user, 'tramite')) return <NoAccess page="tramite" />;
  return <TramiteTraspaso />;
}

// Fallback de pantalla completa — para rutas SIN Layout (públicas) o el boot.
const fullScreenLoading = (
  <div className="flex items-center justify-center h-screen text-text-tertiary">Cargando...</div>
);

// SPRINT-PERF-UX-NAV-2026: dentro de Layout, el fallback es un skeleton del área
// de contenido (el sidebar permanece). Las rutas públicas pasan `fallback` propio.
function Lazy({ children, fallback }: { children: React.ReactNode; fallback?: React.ReactNode }) {
  return <Suspense fallback={fallback ?? <PageContentSkeleton />}>{children}</Suspense>;
}

function AppRoutes() {
  const { user, loading } = useAuth();

  if (loading) return <div className="flex items-center justify-center h-screen text-text-tertiary">Cargando...</div>;

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" /> : <Login />} />
      {/* Páginas públicas (sin Layout) → fallback de pantalla completa, no skeleton de contenido. */}
      <Route path="/m/:token" element={<Lazy fallback={fullScreenLoading}><PublicManifiesto /></Lazy>} />
      <Route path="/tramite/verificar" element={<Lazy fallback={fullScreenLoading}><PublicTramiteVerify /></Lazy>} />
      <Route path="/tramite/portal/:token" element={<Lazy fallback={fullScreenLoading}><PublicTramitePortal /></Lazy>} />
      <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route path="/" element={<ProtectedRoute page="dashboard"><Lazy><Dashboard /></Lazy></ProtectedRoute>} />
        <Route path="/vehicles" element={<ProtectedRoute page="vehicles"><Lazy><Vehicles /></Lazy></ProtectedRoute>} />
        <Route path="/clients" element={<ProtectedRoute page="clients"><Lazy><Clients /></Lazy></ProtectedRoute>} />
        <Route path="/soat" element={<ProtectedRoute page="soat"><Lazy><Soat /></Lazy></ProtectedRoute>} />
        <Route path="/tramite" element={<ProtectedRoute page="tramite"><Lazy><TramiteDigital /></Lazy></ProtectedRoute>} />
        <Route path="/tramite/traspaso" element={<ProtectedRoute><Lazy><TramiteTraspasoGate /></Lazy></ProtectedRoute>} />
        <Route path="/tax-reader" element={<ProtectedRoute page="tax_reader"><Lazy><TaxReader /></Lazy></ProtectedRoute>} />
        <Route path="/flito/tablero" element={<ProtectedRoute page="flito_tablero"><Lazy><FlitoTablero /></Lazy></ProtectedRoute>} />
        <Route path="/flito/bitacora" element={<ProtectedRoute page="flito_bitacora"><Lazy><FlitoBitacora /></Lazy></ProtectedRoute>} />
        <Route path="/flito/compuerta" element={<ProtectedRoute page="flito_compuerta"><Lazy><FlitoCompuerta /></Lazy></ProtectedRoute>} />
        <Route path="/flito/revisiones" element={<ProtectedRoute page="flito_revisiones"><Lazy><FlitoRevisiones /></Lazy></ProtectedRoute>} />
        <Route path="/users" element={<ProtectedRoute page="users"><Lazy><Users /></Lazy></ProtectedRoute>} />
        <Route path="/transito" element={<ProtectedRoute page="transito"><Lazy><TransitoBandeja /></Lazy></ProtectedRoute>} />
        <Route path="/transito/traspaso" element={<ProtectedRoute page="transito"><Lazy><TransitoTraspasoExpediente /></Lazy></ProtectedRoute>} />
        <Route path="/transito/organismos" element={<ProtectedRoute page="users"><Lazy><TransitoOrganismos /></Lazy></ProtectedRoute>} />
        <Route path="/drive" element={<ProtectedRoute page="drive"><Lazy><DriveViewer /></Lazy></ProtectedRoute>} />
        <Route path="/laft" element={<ProtectedRoute page="laft"><Lazy><Laft /></Lazy></ProtectedRoute>} />
        <Route path="/laft/unusual" element={<ProtectedRoute page="laft_unusual"><Lazy><LaftUnusual /></Lazy></ProtectedRoute>} />
        <Route path="/laft/trainings" element={<ProtectedRoute page="laft_trainings"><Lazy><LaftTrainings /></Lazy></ProtectedRoute>} />
        <Route path="/laft/manual" element={<ProtectedRoute page="laft_manual"><Lazy><LaftManual /></Lazy></ProtectedRoute>} />
        <Route path="/laft/oficial" element={<ProtectedRoute page="laft_oficial"><Lazy><LaftOfficer /></Lazy></ProtectedRoute>} />
        <Route path="/laft/plan-auditorias" element={<ProtectedRoute page="laft_audit_plan"><Lazy><LaftAuditPlan /></Lazy></ProtectedRoute>} />
        <Route path="/laft/tablero" element={<ProtectedRoute page="laft_dashboard"><Lazy><LaftDashboard /></Lazy></ProtectedRoute>} />
        <Route path="/privacy" element={<ProtectedRoute page="privacy"><Lazy><Privacy /></Lazy></ProtectedRoute>} />
        <Route path="/fleet" element={<ProtectedRoute page="fleet"><Lazy><Fleet /></Lazy></ProtectedRoute>} />
        <Route path="/fleet/:id" element={<ProtectedRoute page="fleet"><Lazy><FleetVehicleDetail /></Lazy></ProtectedRoute>} />
        <Route path="/maintenance" element={<ProtectedRoute page="maintenance"><Lazy><Maintenance /></Lazy></ProtectedRoute>} />
        <Route path="/maintenance/routines" element={<ProtectedRoute page="maintenance"><Lazy><Routines /></Lazy></ProtectedRoute>} />
        <Route path="/maintenance/schedule" element={<ProtectedRoute page="maintenance"><Lazy><Schedule /></Lazy></ProtectedRoute>} />
        <Route path="/parts" element={<ProtectedRoute page="maintenance"><Lazy><Parts /></Lazy></ProtectedRoute>} />
        <Route path="/maintenance/work-orders" element={<ProtectedRoute page="maintenance"><Lazy><WorkOrders /></Lazy></ProtectedRoute>} />
        <Route path="/maintenance/work-orders/:id" element={<ProtectedRoute page="maintenance"><Lazy><WorkOrderDetail /></Lazy></ProtectedRoute>} />
        <Route path="/maintenance/indicators" element={<ProtectedRoute page="maintenance"><Lazy><MaintenanceIndicators /></Lazy></ProtectedRoute>} />
        <Route path="/pesv" element={<ProtectedRoute page="pesv"><Lazy><PesvDashboard /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/conductores" element={<ProtectedRoute page="pesv"><Lazy><Drivers /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/conductores/:id" element={<ProtectedRoute page="pesv"><Lazy><DriverDetail /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/capacitaciones" element={<ProtectedRoute page="pesv"><Lazy><SafetyTrainings /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/incidentes" element={<ProtectedRoute page="pesv"><Lazy><RoadIncidents /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/incidentes/stats" element={<ProtectedRoute page="pesv"><Lazy><RoadIncidentsStats /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/checklists" element={<ProtectedRoute page="pesv"><Lazy><Checklists /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/checklists/nuevo" element={<ProtectedRoute page="pesv"><Lazy><ChecklistRun /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/alcoholimetria" element={<ProtectedRoute page="pesv"><Lazy><AlcoholTests /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/emergencias" element={<ProtectedRoute page="pesv"><Lazy><Emergency /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/operacion-indicadores" element={<ProtectedRoute page="pesv"><Lazy><OperationalIndicators /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/politica" element={<ProtectedRoute page="pesv"><Lazy><PesvPolicy /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/comite" element={<ProtectedRoute page="pesv"><Lazy><PesvComite /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/plan" element={<ProtectedRoute page="pesv"><Lazy><PesvPlan /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/diagnostico" element={<ProtectedRoute page="pesv"><Lazy><PesvDiagnostico /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/diagnostico/:id" element={<ProtectedRoute page="pesv"><Lazy><PesvDiagnostico /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/diagnostico/:id/auditoria" element={<ProtectedRoute page="pesv"><Lazy><PesvDiagnosticoAuditoria /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/tablero" element={<ProtectedRoute page="pesv"><Lazy><PesvTablero /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/reportar" element={<ProtectedRoute page="pesv"><Lazy><ReportarIncidente /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/auditorias" element={<ProtectedRoute page="pesv"><Lazy><PesvAuditorias /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/comunicaciones" element={<ProtectedRoute page="pesv"><Lazy><PesvComunicaciones /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/contratistas" element={<ProtectedRoute page="pesv"><Lazy><PesvContratistas /></Lazy></ProtectedRoute>} />
        <Route path="/privacy/log-pii" element={<ProtectedRoute page="privacy"><Lazy><PesvLogPii /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/jornadas" element={<ProtectedRoute page="pesv"><Lazy><JornadasConductor /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/mi-jornada" element={<ProtectedRoute page="pesv"><Lazy><MiJornada /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/rutas" element={<ProtectedRoute page="pesv"><Lazy><PesvRoutes /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/pernocta" element={<ProtectedRoute page="pesv"><Lazy><PesvPernocta /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/raci" element={<ProtectedRoute page="pesv_raci"><Lazy><PesvRaci /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/normativa" element={<ProtectedRoute page="pesv_normativa"><Lazy><PesvNormativa /></Lazy></ProtectedRoute>} />
        <Route path="/pesv/retencion" element={<ProtectedRoute page="pesv_retencion"><Lazy><PesvRetencion /></Lazy></ProtectedRoute>} />
        <Route path="/rndc" element={<ProtectedRoute page="rndc"><Lazy><RndcDashboard /></Lazy></ProtectedRoute>} />
        <Route path="/rndc/maestros" element={<ProtectedRoute page="rndc"><Lazy><RndcMaestros /></Lazy></ProtectedRoute>} />
        <Route path="/rndc/remesas" element={<ProtectedRoute page="rndc"><Lazy><RndcRemesas /></Lazy></ProtectedRoute>} />
        <Route path="/rndc/remesas/nueva" element={<ProtectedRoute page="rndc"><Lazy><RndcRemesaForm /></Lazy></ProtectedRoute>} />
        <Route path="/rndc/remesas/:id" element={<ProtectedRoute page="rndc"><Lazy><RndcRemesaForm /></Lazy></ProtectedRoute>} />
        <Route path="/rndc/manifiestos" element={<ProtectedRoute page="rndc"><Lazy><RndcManifiestos /></Lazy></ProtectedRoute>} />
        <Route path="/rndc/manifiestos/nuevo" element={<ProtectedRoute page="rndc"><Lazy><RndcManifiestoWizard /></Lazy></ProtectedRoute>} />
        <Route path="/rndc/manifiestos/:id" element={<ProtectedRoute page="rndc"><Lazy><RndcManifiestoDetail /></Lazy></ProtectedRoute>} />
        <Route path="/rndc/admin/credenciales" element={<ProtectedRoute page="rndc_admin"><Lazy><RndcAdminCredenciales /></Lazy></ProtectedRoute>} />
        <Route path="/admin/rendimiento" element={<Lazy><RumSummary /></Lazy>} />
        <Route path="/admin/tramites-metricas" element={<Lazy><TramitesMetricas /></Lazy>} />
      </Route>
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          <AppRoutes />
          <Toaster
            position="top-right"
            toastOptions={{
              style: {
                background: 'var(--color-surface-elevated)',
                color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                boxShadow: 'var(--shadow-floating)',
              },
            }}
          />
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}
