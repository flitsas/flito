// Ayuda FLITO (HU #11893): índice por permiso y superficie de ficha.
// El gate de ruta vive en App.tsx (`AyudaFlitoGate`), no `ProtectedRoute page="flito_ayuda"`.
// Feature #13691 (diseño slim §7): esta página solo decide «índice o ficha»; el índice (HU #13704) y
// la ficha (HU #13705) viven en `components/ayuda/`.

import { useParams } from 'react-router-dom';
import AyudaIndice from '../components/ayuda/AyudaIndice';
import AyudaFicha from '../components/ayuda/AyudaFicha';

export default function FlitoAyuda() {
  const { slug } = useParams<{ slug?: string }>();
  // `key`: Anterior/Siguiente cambia de ficha sin desmontar la ruta; la clave reinicia su estado.
  if (slug) return <AyudaFicha key={slug} slug={slug} />;
  return <AyudaIndice />;
}
