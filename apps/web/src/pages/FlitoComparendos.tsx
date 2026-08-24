// FLITO — Comparendos monitoreados: la página, que desde la HU #11633 es solo el orquestador.
//
// Una ruta (`/flito/comparendos`), un permiso (`flito_comparendos`, solo `admin`) y tres vistas
// dentro. Lo único que decide este archivo es CUÁL se monta, leyendo `?vista=` de la URL; el marco
// que las tres comparten —cabecera, pills y panel— vive en `navegacionComparendos.tsx` y el
// contenido, en un componente por vista.
//
// **Se monta una sola vista, no las tres ocultas con CSS.** Es la diferencia entre entrar a
// Configuración y pedir dos catálogos, o entrar y pedir además el listado de comparendos que nadie
// ha mirado —con su fila en el registro de acceso y su parte del limitador de 60 lecturas por
// minuto—. El coste es que volver a Registros vuelve a pedir la primera página; a cambio, ninguna
// pestaña gasta cuota por estar al lado de la que se está usando.
//
// El porqué de las pestañas (y no de subrutas), del parámetro en la URL y del reparto de archivos
// está en `docs/ux/flito-comparendos-config-sync.md`; el de cada vista, en su propio componente.

import { useNavComparendos } from '../components/flito/comparendos/navegacionComparendos';
import VistaConfigComparendos from '../components/flito/comparendos/VistaConfigComparendos';
import VistaRegistrosComparendos from '../components/flito/comparendos/VistaRegistrosComparendos';
import VistaSyncComparendos from '../components/flito/comparendos/VistaSyncComparendos';

export default function FlitoComparendos() {
  const nav = useNavComparendos();
  if (nav.vista === 'configuracion') return <VistaConfigComparendos nav={nav} />;
  if (nav.vista === 'sincronizacion') return <VistaSyncComparendos nav={nav} />;
  // Registros es también donde cae cualquier `?vista=` que no reconozcamos (`leerVista`): un valor
  // inventado no abre una sección vacía, devuelve la pantalla que el operador venía a ver.
  return <VistaRegistrosComparendos nav={nav} />;
}
