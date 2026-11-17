import type { ComponentProps } from 'react';
import FlitModal from './FlitModal';

/** Panel lateral del UI Kit 2026: el modal del kit anclado a la derecha (mismo velo, cabecera y cierre). */
export default function Drawer(props: Omit<ComponentProps<typeof FlitModal>, 'lateral' | 'wide' | 'full'>) {
  return <FlitModal {...props} lateral />;
}
