const casos = [
  {
    id: "co-industrias-delta",
    detalle: "Colombia · Excel",
    mensaje:
      'Procesa el caso "co-industrias-delta". Dime qué campos quedaron llenos, cuáles faltan y si el paquete está listo para firma. No envíes nada todavía.',
  },
  {
    id: "ec-corp-andina",
    detalle: "Ecuador · PDF",
    mensaje:
      'Procesa el caso "ec-corp-andina". Dime qué campos quedaron llenos, cuáles faltan, si el paquete está listo para firma y qué soportes debo actualizar. No envíes nada todavía.',
  },
  {
    id: "hn-agroexport-sula",
    detalle: "Honduras · Excel",
    mensaje:
      'Procesa el caso "hn-agroexport-sula". Resume llenos, faltantes, confirmaciones y soportes vencidos. No envíes nada todavía.',
  },
  {
    id: "pa-logistica-istmo",
    detalle: "Panamá · portal",
    mensaje:
      'Procesa el caso "pa-logistica-istmo". El formato es un portal: prepara los valores y el paquete, y dime qué falta. No envíes nada.',
  },
]

const historial = document.querySelector("#historial")
const formulario = document.querySelector("#formulario")
const mensaje = document.querySelector("#mensaje")
const enviar = document.querySelector("#enviar")
const estado = document.querySelector("#estado")
const salud = document.querySelector("#salud")
const nueva = document.querySelector("#nueva")
const listaCasos = document.querySelector("#casos")

let sessionId = localStorage.getItem("registro-session")
if (!sessionId) sessionId = crearSesion()

casos.forEach((caso) => {
  const boton = document.createElement("button")
  boton.type = "button"
  boton.className = "caso"
  boton.innerHTML = `<strong>${caso.id}</strong><span>${caso.detalle}</span>`
  boton.addEventListener("click", () => {
    mensaje.value = caso.mensaje
    mensaje.focus()
  })
  listaCasos.append(boton)
})

nueva.addEventListener("click", () => {
  sessionId = crearSesion()
  historial.replaceChildren()
  pintarVacio()
})

formulario.addEventListener("submit", async (evento) => {
  evento.preventDefault()
  const texto = mensaje.value.trim()
  if (!texto) return
  mensaje.value = ""
  pintarUsuario(texto)
  await consultar(texto)
})

mensaje.addEventListener("keydown", (evento) => {
  if (evento.key === "Enter" && !evento.shiftKey) {
    evento.preventDefault()
    formulario.requestSubmit()
  }
})

pintarVacio()
cargarSalud()
cargarHistorial()

function crearSesion() {
  const id = crypto.randomUUID()
  localStorage.setItem("registro-session", id)
  return id
}

function pintarVacio() {
  if (historial.children.length > 0) return
  const item = document.createElement("li")
  item.className = "vacio"
  item.textContent = "Pide procesar un caso. Verás cada herramienta y, al final, la pregunta de confirmación antes de simular el envío."
  historial.append(item)
}

async function cargarSalud() {
  try {
    const respuesta = await fetch("/api/health")
    const datos = await respuesta.json()
    salud.textContent = datos.ok ? `${datos.provider} · ${datos.model}` : "Servicio no disponible"
  } catch {
    salud.textContent = "Servicio no disponible"
  }
}

async function cargarHistorial() {
  const respuesta = await fetch(`/api/sessions/${sessionId}`)
  if (!respuesta.ok) return
  const sesion = await respuesta.json()
  historial.replaceChildren()
  for (const item of sesion.messages ?? []) {
    if (item.role === "user") pintarUsuario(item.content)
    if (item.role === "assistant") {
      for (const llamada of item.toolCalls ?? []) pintarHerramienta(llamada)
      if (item.content) pintarAsistente(item.content, item.content.includes("¿Confirmas el envío"))
    }
  }
  pintarVacio()
}

async function consultar(texto) {
  enviar.disabled = true
  mensaje.disabled = true
  estado.hidden = false
  try {
    const respuesta = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message: texto }),
    })
    const datos = await respuesta.json()
    if (!respuesta.ok) {
      pintarAsistente(datos.error || "No se pudo enviar el mensaje.", false)
      return
    }
    for (const llamada of datos.toolCalls ?? []) pintarHerramienta(llamada)
    pintarAsistente(datos.reply || "Sin respuesta.", Boolean(datos.needsConfirmation))
  } catch {
    pintarAsistente("No pude hablar con el servidor. La sesión sigue activa.", false)
  } finally {
    enviar.disabled = false
    mensaje.disabled = false
    estado.hidden = true
    mensaje.focus()
  }
}

function pintarUsuario(texto) {
  quitarVacio()
  const item = document.createElement("li")
  item.className = "burbuja usuario"
  item.textContent = texto
  historial.append(item)
  bajar()
}

function pintarAsistente(texto, confirmacion) {
  quitarVacio()
  const item = document.createElement("li")
  item.className = confirmacion ? "burbuja asistente pide-confirmacion" : "burbuja asistente"
  if (confirmacion) {
    const aviso = document.createElement("p")
    aviso.className = "aviso"
    aviso.textContent = "El agente pide confirmación antes de simular el envío."
    item.append(aviso)
  }
  const cuerpo = document.createElement("div")
  cuerpo.textContent = texto
  item.append(cuerpo)
  historial.append(item)
  bajar()
}

function pintarHerramienta(llamada) {
  quitarVacio()
  const item = document.createElement("li")
  item.className = "herramienta"
  const titulo = document.createElement("h3")
  titulo.textContent = llamada.name
  const resumen = document.createElement("p")
  resumen.textContent = resumir(llamada.result)
  const detalles = document.createElement("details")
  const marca = document.createElement("summary")
  marca.textContent = "Argumentos y resultado"
  const pre = document.createElement("pre")
  pre.textContent = JSON.stringify({ args: llamada.args, result: parsear(llamada.result) }, null, 2)
  detalles.append(marca, pre)
  item.append(titulo, resumen, detalles)
  historial.append(item)
  bajar()
}

function resumir(resultado) {
  const cuerpo = parsear(resultado)
  if (!cuerpo || typeof cuerpo !== "object") return "Sin resultado."
  if (cuerpo.ok === false) return cuerpo.error || "La herramienta no pudo completar el paso."
  const data = cuerpo.data || {}
  if (data.pais) return `${data.pais} · ${data.cliente} · ${data.formato} · ${data.campos?.length ?? 0} campos`
  if (Array.isArray(data.llenos)) {
    return `Llenos ${data.llenos.length} · faltantes ${data.faltantes?.length ?? 0} · por confirmar ${data.requiere_confirmacion?.length ?? 0}`
  }
  if (typeof data.listo_para_firma === "boolean") {
    return `${data.ruta} · listo para firma: ${data.listo_para_firma ? "sí" : "no"}`
  }
  if (data.ruta) return `${data.formato ? data.formato + " · " : ""}${data.ruta}${data.mensaje ? " · " + data.mensaje : ""}`
  return "Listo."
}

function parsear(resultado) {
  if (typeof resultado !== "string") return resultado
  try {
    return JSON.parse(resultado)
  } catch {
    return { ok: false, error: resultado }
  }
}

function quitarVacio() {
  const vacio = historial.querySelector(".vacio")
  if (vacio) vacio.remove()
}

function bajar() {
  historial.scrollTop = historial.scrollHeight
}
