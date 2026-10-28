El registro como proveedor lo pide un cliente por correo. Recepción deja la solicitud en `fixtures/reto-01/casos/<caso>/`. La analista conversa con el agente. El representante legal firma fuera del sistema. El agente prepara; no firma y no envía.

Cada caso trae `solicitud.json`, la plantilla (`plantilla-celdas.json` si el formato es xlsx, `plantilla-campos.json` si es pdf o portal) y `soportes-exigidos.json`. El maestro está en `fixtures/reto-01/repositorio/maestro.json`. Los sinónimos de etiquetas están en `fixtures/reto-01/glosario-campos.json`. Los soportes y su vigencia están en `fixtures/reto-01/repositorio/soportes/index.json`.

Formatos: Excel y PDF se generan. El portal web no se automatiza: se entrega `valores-portal.md` para copiar. Las credenciales del portal las escribe una persona y el clic en Enviar también es humano.

Identificador tributario: en Colombia el campo NIT se llena con el NIT del maestro. En Ecuador, Perú y Panamá el cliente suele pedir RUC, y en Honduras RTN. Periferia solo tiene NIT colombiano. Esos campos se proponen con el NIT y quedan en `requiere_confirmacion` con la nota "identificador extranjero". "Identificación tributaria" y "Número de identificación fiscal" también piden confirmación. Un campo sin entrada en el glosario ni en el maestro queda `faltante`. Nunca se inventa.

Los datos bancarios se escriben en el formulario solo si la plantilla los pide. No van en el borrador de correo ni en el resumen del chat.

Un soporte con `vigencia_hasta` anterior a la fecha de ejecución está vencido. Un soporte exigido que no está en el índice está ausente. Cualquiera de los dos impide `listo_para_firma`. Un campo faltante no lo impide, pero se lista en el checklist. La vigencia nula no vence.

El paquete queda en `out/<caso>/paquete/` con el formulario, las copias de soportes que existan, `checklist.md` y `borrador-correo.md`. El envío simulado solo escribe `out/<caso>/ENVIO-SIMULADO.md` después de una confirmación explícita. Cada ejecución deja una línea en `out/log.jsonl` y en `out/<caso>/log.jsonl`.
