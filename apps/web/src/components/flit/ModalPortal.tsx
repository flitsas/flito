// Portal a <body> (trampa del dock §12: paneles y diálogos fuera del árbol que recorta o transforma).
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

export default function ModalPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}
