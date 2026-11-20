---
resumen: Derecho al olvido de la Ley 1581. Previsualice qué datos guarda FLITO de un documento y, si procede, anonimícelos.
palabras_clave:
  - privacidad y datos
  - derecho al olvido
  - anonimizar
  - anonimización
  - titular de datos
  - Ley 1581
consultas:
  - cómo atiendo una solicitud de derecho al olvido
  - cómo anonimizo los datos de una persona
  - qué datos guarda FLITO de un documento
version: 1.0
fecha: 2026-10-22
---
## Qué es

La pantalla para atender una solicitud de **derecho al olvido** (Ley 1581 de 2012): primero muestra cuántos registros guarda FLITO con un número de documento y, si la solicitud procede, los **anonimiza**. Anonimizar no borra: nombres, correos, teléfonos y direcciones se reemplazan por marcadores y el documento por un código que no se puede revertir. Los registros se conservan para la auditoría LAFT y de seguridad.

## Para quién

Quien tenga el ítem **Privacidad y datos**. Previsualizar pide la acción de previsualizar los datos de un titular (de partida, el Administrador y Cumplimiento). Anonimizar pide además la acción de administrar el olvido, que de partida solo tiene el Administrador. Ambas se reparten desde **Roles y permisos**.

## Cómo se entra

Menú **Administración**, ítem **Privacidad y datos**. La pantalla se titula **Privacidad y datos personales**.

## Pasos

1. Lea el aviso **Política de anonimización** y escriba en **Número de documento** el documento de la persona que hizo la solicitud. ![Pantalla Privacidad y datos personales con la política y un documento demo escrito](./privacy/01-documento.png)
2. Pulse **Previsualizar** (dice **Buscando...** mientras tanto). La tarjeta dice «Documento … — N registros afectados» y cuántos hay de cada tipo: **Clientes**, **Vehículos**, **Solicitudes SOAT**, **Trámites digitales**, **Contrapartes LAFT** y **Beneficiarios finales LAFT**. Previsualizar no cambia nada. ![Previsualización de un documento demo con siete registros afectados repartidos por tipo, antes de anonimizar](./privacy/02-registros-afectados.png)
3. Si hay registros y usted puede ejecutar la anonimización, pulse **Anonimizar este documento**. Sin ese permiso la tarjeta dice «Solo administradores pueden ejecutar la anonimización.»
4. En la ventana **Confirmar anonimización** escriba el **Motivo** (mínimo 10 caracteres; queda en la auditoría) y vuelva a escribir el documento exacto. **Confirmar anonimización** solo se habilita cuando el documento coincide.
5. Al confirmar, el botón dice **Anonimizando...** y luego un aviso confirma «Anonimización completada: N registros». La pantalla queda lista para otra solicitud.

![Diagrama del derecho al olvido: escribir el documento, previsualizar, decidir si hay registros y si usted puede anonimizar, confirmar con motivo y documento, y anonimización registrada](./privacy/derecho-al-olvido.svg)

> [!PRECAUCION]
> La anonimización no se puede deshacer. Antes de confirmar, compruebe que el documento es el de la persona que lo pidió y que la solicitud procede.

## Estados

- **Cargando**: el botón dice **Buscando...** mientras se previsualiza y **Anonimizando...** mientras se aplica.
- **Error**: un aviso arriba explica qué falló y la pantalla conserva lo escrito; si el documento tiene menos de 3 caracteres avisa «Documento muy corto».
- **Vacío**: «No hay registros con este documento. Nada que anonimizar.»
- **Lleno**: la tarjeta con el total y el conteo por tipo; los tipos con registros se resaltan.

## Qué no hace

- No elimina registros: los anonimiza y los conserva para auditoría.
- No muestra los datos de la persona, solo cuántos registros hay de cada tipo.
- No lista las solicitudes atendidas: cada anonimización queda en la auditoría con su motivo.
- No muestra quién consultó los datos de una persona: eso está en **Log accesos PII**.
