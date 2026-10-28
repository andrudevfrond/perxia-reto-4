# Solución — agente de registro como proveedor

## 1. Problema en una frase

La analista administrativa transcribe a mano, varias veces al mes, los mismos datos de Periferia en formularios de clientes, y el agente le deja el formulario y los soportes listos para que una persona firme y decida el envío.

## 2. Arquitectura

El navegador habla con un solo proceso Bun. Ese proceso lee el comportamiento y el conocimiento al empezar cada turno, llama a Gemini y ejecuta herramientas. Las herramientas leen `fixtures/reto-01/` y escriben `out/`.

```
web/  --HTTP-->  src/server.ts
                    |-- src/agent/loop.ts
                    |     |-- agent/prompt.md
                    |     |-- src/knowledge/registro-proveedor.md
                    |     |-- src/llm/google.ts
                    |     \-- src/tools/proveedor.ts
                    |           |-- fixtures/reto-01/   (solo lectura)
                    |           \-- out/                (escritura)
```

- Comportamiento: `agent/prompt.md`.
- Conocimiento del proceso: `src/knowledge/registro-proveedor.md`. El servidor los concatena; un cambio de regla no toca el ciclo.
- Ejecución: `src/tools/proveedor.ts`. El registro publica cada export como `proveedor_<nombre>`.
- `modulo/tools/proveedor.ts` reexporta esas mismas funciones. `modulo/agent.md` y `modulo/skill/registro-proveedor/SKILL.md` repiten el prompt y el conocimiento con el frontmatter pedido. `demo.ts` falla si divergen.

## 3. Ciclo del agente

`procesarTurno` guarda el mensaje de la analista, arma el historial en el formato de Gemini y repite: modelo, herramientas, modelo. El tope es `MAX_TOOL_ITERATIONS` (25). Al llegar, responde con la lista de herramientas que alcanzó a consultar. `MAX_SESSION_TOKENS` corta la sesión antes de otra llamada y pide abrir una sesión nueva. Una estimación de cuatro caracteres por token basta para el tope; no es una factura.

Cada `execute` devuelve `{ ok: true, data }` o `{ ok: false, error }` y nunca lanza hacia el modelo. El registro y la propia herramienta atrapan el fallo. Cada ejecución agrega una línea `{ ts, herramienta, ok, resumen }` a `out/log.jsonl` y a `out/<caso>/log.jsonl`. El resumen no copia la cuenta ni el SWIFT.

La confirmación no depende de que el modelo ponga `confirmado: true`. `proveedor_simular_envio` solo escribe `ENVIO-SIMULADO.md` si ese booleano es true y el mensaje de este turno es una confirmación explícita (`sí`, `envía`, `confirmo`, `adelante`, y unas pocas variantes). "No envíes nada todavía" no confirma. Si en el turno se armó el paquete y no hubo envío, el ciclo cierra con la pregunta `¿Confirmas el envío del paquete para firma?`. El front marca ese estado.

Un timeout de 60 segundos, una cuota o una clave rechazada se traducen a una frase clara. La sesión queda guardada en `out/sessions/<id>.json` y el siguiente mensaje puede continuar.

## 4. Elección del modelo

Proveedor Google, modelo por defecto `gemini-2.5-flash`, cambiable con `GEMINI_MODEL`. El adaptador (`src/llm/adapter.ts` y `src/llm/google.ts`) es el único sitio que conoce a Gemini. El ciclo llama `enviar(mensajes, herramientas)`.

Se eligió Flash porque el trabajo es enrutar herramientas y redactar un resumen, no razonar un caso abierto. `thinkingBudget: 0` evita tokens de pensamiento en el bucle; si el modelo rechaza ese parámetro, el adaptador reintenta sin él. La temperatura es 0.

Tarifa pública de pago al 27 de octubre de 2026, según la documentación de Gemini: USD 0,30 por millón de tokens de entrada de texto y USD 2,50 por millón de salida. Un caso usa cuatro herramientas y un resumen. Con un orden de 20 000 tokens de entrada y 2 000 de salida, el costo queda alrededor de USD 0,01. Con holgura de reintentos, menos de USD 0,05 por caso. Doce casos al mes siguen siendo centavos. El nivel gratuito de la API puede ser suficiente para la defensa; en producción conviene el nivel de pago para que las conversaciones no se usen para entrenar el modelo.

## 5. Diseño del portal web

`pa-logistica-istmo` no se automatiza. La herramienta escribe `out/<caso>/valores-portal.md` con etiqueta, estado y valor, y responde `formato no soportado`. El paquete incluye ese archivo, los soportes y el borrador.

En una fase posterior usaría un navegador controlado (Playwright) dentro de un escritorio que la analista ve, no un RPA ciego ni una extensión que guarde la contraseña. El agente rellena los campos con los valores del markdown. La analista escribe usuario y contraseña en el formulario del portal, resuelve CAPTCHA o MFA y pulsa Enviar. Esas dos acciones no tienen herramienta.

Las credenciales viven en un gestor (el de la empresa o el del sistema operativo), las teclea la persona en la página del cliente y no entran al repo, al prompt, a `out/log.jsonl` ni a la respuesta de la API. Si el portal cambia de layout, el agente se detiene y muestra los valores para copiar, que es el mismo respaldo que ya produce este reto. Un cambio de selector no debe inventar un dato.

## 6. Decisiones y trade-offs

1. Un proceso Bun sirve el HTML estático y la API. La alternativa era un front en Vite o React con otro puerto. El chat necesita historial, tarjetas de herramientas y un aviso de confirmación; no necesita un framework, y un solo comando cumple el arranque del reto.
2. `generar_formulario` escribe un valor solo si coincide con el maestro en la ruta declarada. La alternativa era volcar el JSON que devuelve el modelo. Eso habría permitido cambiar un NIT en el argumento y dejarlo impreso en el Excel.
3. Una etiqueta sin entrada exacta en el glosario no se llena. Si el parecido queda entre 0,5 y 0,8, se propone la clave y no se escribe el valor. Por debajo de 0,5 es `faltante`. La alternativa era un fuzzy match que completara "Número de contribuyente especial" con otro campo que empieza por "Número". Eso inventa.
4. La compuerta de envío está en la herramienta y mira el mensaje de la persona. La alternativa era fiarse del prompt y de `confirmado: true`. El modelo puede marcar true en el mismo turno en el que le piden no enviar.
5. PDF con `pdf-lib` (texto generado, no un AcroForm) y Excel con `exceljs`. Se descartó rellenar un PDF de formulario porque el reto acepta un PDF que reproduzca etiqueta y valor en orden, y `pdf-lib` no necesita binarios nativos dentro de la imagen.

Dependencias: `zod` es obligatoria para los argumentos. `zod-to-json-schema` traduce esos esquemas al JSON Schema que pide Gemini. `@google/genai` es el adaptador. `exceljs` escribe las celdas de la plantilla. `pdf-lib` genera el PDF. `typescript` y `@types/bun` solo se usan al desarrollar.

## 7. Supuestos

- El caso portal trae `plantilla-campos.json`, igual que el PDF, aunque el enunciado asocia ese archivo al PDF. Sin esa plantilla no habría valores para copiar.
- `vigencia_hasta` nula no vence. Una fecha anterior al día de ejecución en `America/Bogota` sí vence. El mismo día de la vigencia sigue vigente.
- El umbral 0,5 separa "parecido suficiente para proponer" de "no hay fuente". El 0,8 es el del enunciado para considerar un campo lleno.
- La etiqueta `NIT` se llena con el NIT del maestro. `RUC` y `RTN` fuera de Colombia, y las etiquetas ambiguas "Identificación tributaria" y "Número de identificación fiscal", quedan en confirmación con el NIT propuesto y la nota `identificador extranjero`.
- Un soporte vencido se copia al paquete para que se vea, y aun así bloquea `listo_para_firma`.
- Los valores del maestro que son texto se escriben como texto, para no perder ceros a la izquierda de la cuenta.
- Con la fecha de esta entrega (2026-10-28) la cámara de comercio y los parafiscales ya están vencidos, así que ningún caso queda listo para firma. Eso es la regla de vigencia, no un fallo del llenado.

## 8. Cobertura

| Historia | Estado | Qué falta para producción |
|---|---|---|
| HU-1 Leer la solicitud | Hecho | Entrada real de correo. Hoy el caso ya está normalizado en JSON. |
| HU-2 Mapear campos | Hecho | Un dueño del maestro y un glosario que crezca con plantillas peores que estos fixtures. |
| HU-3 Generar formulario | Hecho en el alcance del reto | Excel y PDF salen solos. El portal queda en markdown, como pide el enunciado. |
| HU-4 Armar el paquete | Hecho | Firma electrónica y envío real. Aquí el cierre es checklist, borrador y `ENVIO-SIMULADO.md`. |
| HU-5 Manejo de errores | Hecho | Caso inexistente, plantilla ilegible y formato no soportado responden `{ ok: false, error }` o siguen con el markdown del portal. Falta observabilidad centralizada. |

`demo.ts` cubre los cuatro casos sin modelo: celdas de Excel, cabecera PDF, portal, RUC/RTN en confirmación, faltantes reales, soporte ausente, borrador sin cuenta ni SWIFT, y las dos formas de rechazar el envío.

## 9. Uso de IA

Construí la solución en Cursor con Grok. Le pedí el plan contra el PRD y luego la implementación: herramientas, ciclo, chat, demo, módulo y documentos.

Descarté que el modelo fuera la fuente del valor impreso. Una primera idea natural del asistente es dejar que `generar_formulario` use el JSON del turno; la versión entregada compara cada valor con el maestro y lo descarta si no coincide. También descarté completar por semejanza los campos que no están en el glosario, y descarté aceptar `confirmado: true` sin mirar el mensaje de la analista. El texto de `agent/prompt.md` y de `src/knowledge/registro-proveedor.md` lo revisé para que no contradiga esas reglas.

## 10. Riesgos de llevar esto a producción

- El modelo puede narrar un valor que la herramienta no dio. Mitigación actual: el archivo solo contiene valores del maestro y el prompt lo prohíbe. En producción añadiría un cotejo del resumen contra el mapeo antes de mostrarlo, y dejaría los datos bancarios fuera del historial visible.
- El maestro puede estar viejo. Hace falta un dueño del dato y una fecha de actualización visible en el checklist.
- La vigencia depende del reloj del servidor. Mitigación: zona `America/Bogota` y la fecha impresa en el checklist.
- La clave de Gemini en un host compartido. Mitigación: secreto del plataforma, tope de iteraciones y de tokens, y nunca registrar la clave ni pegarla en la URL. El nivel de pago evita que el proveedor use las conversaciones para entrenar.
- Un portal con CAPTCHA, MFA o un rediseño. Mitigación: la persona opera el ingreso y el envío; el agente solo prepara valores.
- Doce formularios al mes no justifican una plataforma grande, pero un error de cuenta bancaria sí duele. Por eso el envío sigue siendo una decisión humana aunque el llenado ya no lo sea.
