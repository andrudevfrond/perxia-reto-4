import { rm } from "node:fs/promises"
import path from "node:path"
import ExcelJS from "exceljs"
import * as moduloTools from "./modulo/tools/proveedor.ts"
import * as appTools from "./src/tools/proveedor.ts"
import { fechaEjecucion, type ToolContext } from "./src/tools/datos.ts"
import { ejecutar } from "./src/tools/registry.ts"

const directory = import.meta.dir
const ctxBase: ToolContext = { directory, sessionId: "demo", confirmadoPorUsuario: false }
const fallos: string[] = []

const etiquetas = (items: Record<string, unknown>[]) => items.map((item) => String(item.etiqueta ?? ""))

await rm(path.join(directory, "out"), { recursive: true, force: true })
await verificarModulo()

const casos = ["co-industrias-delta", "ec-corp-andina", "hn-agroexport-sula", "pa-logistica-istmo"]
for (const caso of casos) {
  try {
    await procesar(caso)
  } catch (error) {
    fallos.push(`${caso}: ${error instanceof Error ? error.message : "error inesperado"}`)
  }
}

const ausente = await llamar("proveedor_leer_solicitud", { caso: "no-existe" }, ctxBase)
if (ausente.ok) fallos.push("un caso inexistente no debe responder ok")
const simulado = await llamar(
  "proveedor_simular_envio",
  { caso: "co-industrias-delta", confirmado: true },
  { ...ctxBase, confirmadoPorUsuario: true },
)
if (!simulado.ok) fallos.push("el envío simulado con confirmación debió escribir el archivo")
const envio = path.join(directory, "out", "co-industrias-delta", "ENVIO-SIMULADO.md")
if (!(await Bun.file(envio).exists())) fallos.push("falta ENVIO-SIMULADO.md")

if (!(await Bun.file(path.join(directory, "out", "log.jsonl")).exists())) fallos.push("falta out/log.jsonl")

console.log("")
if (fallos.length === 0) {
  console.log("demo: todos los casos cumplieron las reglas.")
  process.exit(0)
}
console.error(`demo: ${fallos.length} fallo(s)`)
for (const fallo of fallos) console.error(`- ${fallo}`)
process.exit(1)

async function procesar(caso: string): Promise<void> {
  const lectura = await llamar("proveedor_leer_solicitud", { caso }, ctxBase)
  const dataLectura = datos(lectura)
  const mapeo = await llamar(
    "proveedor_mapear_campos",
    { caso, campos: dataLectura.campos },
    ctxBase,
  )
  const dataMapeo = datos(mapeo)
  const formulario = await llamar("proveedor_generar_formulario", { caso, mapeo: dataMapeo }, ctxBase)
  const dataFormulario = datos(formulario)
  const paquete = await llamar("proveedor_armar_paquete", { caso }, ctxBase)
  const dataPaquete = datos(paquete)
  const rechazado = await llamar("proveedor_simular_envio", { caso, confirmado: false }, ctxBase)
  if (rechazado.ok || !String(rechazado.error).includes("confirmación")) {
    fallos.push(`${caso}: simular_envio sin confirmación debió rechazarse`)
  }
  const forzado = await llamar(
    "proveedor_simular_envio",
    { caso, confirmado: true },
    ctxBase,
  )
  if (forzado.ok) fallos.push(`${caso}: el modelo no puede confirmar el envío por su cuenta`)

  const llenos = etiquetas(comoLista(dataMapeo.llenos))
  const faltantes = etiquetas(comoLista(dataMapeo.faltantes))
  const confirmar = etiquetas(comoLista(dataMapeo.requiere_confirmacion))
  const checklist = comoLista(dataPaquete.checklist)
  const listoEsperado = checklist.every((item) => item.estado === "presente")
  if (dataPaquete.listo_para_firma !== listoEsperado) {
    fallos.push(`${caso}: listo_para_firma no coincide con los soportes`)
  }
  const borrador = await Bun.file(path.join(directory, "out", caso, "paquete", "borrador-correo.md")).text()
  if (borrador.includes("03100012345") || borrador.includes("COLOCOBM")) {
    fallos.push(`${caso}: el borrador incluye datos bancarios`)
  }

  console.log(
    [
      caso,
      String(dataLectura.formato),
      `llenos=${llenos.length}`,
      `faltantes=${faltantes.length}`,
      `confirmar=${confirmar.length}`,
      `listo_para_firma=${String(dataPaquete.listo_para_firma)}`,
      `soportes=${checklist.map((item) => `${String(item.tipo)}:${String(item.estado)}`).join(",")}`,
    ].join(" | "),
  )

  if (caso === "co-industrias-delta") await verificarColombia(llenos, faltantes, confirmar, dataFormulario)
  if (caso === "ec-corp-andina") await verificarEcuador(llenos, faltantes, confirmar, checklist, dataFormulario)
  if (caso === "hn-agroexport-sula") await verificarHonduras(llenos, faltantes, confirmar, checklist, dataFormulario)
  if (caso === "pa-logistica-istmo") await verificarPanama(llenos, faltantes, confirmar, dataFormulario)
}

async function verificarColombia(
  llenos: string[],
  faltantes: string[],
  confirmar: string[],
  formulario: Record<string, unknown>,
): Promise<void> {
  if (faltantes.length !== 0 || confirmar.length !== 0 || !llenos.includes("NIT")) {
    fallos.push("co-industrias-delta: el NIT colombiano debe quedar lleno y sin faltantes")
  }
  if (formulario.formato !== "xlsx") fallos.push("co-industrias-delta: el formato debe ser xlsx")
  const libro = new ExcelJS.Workbook()
  await libro.xlsx.readFile(path.join(directory, "out", "co-industrias-delta", "formulario.xlsx"))
  const datos = libro.getWorksheet("Datos Proveedor")
  const banco = libro.getWorksheet("Datos Bancarios")
  if (texto(datos?.getCell("C3").value) !== "Periferia IT Group S.A.S.") fallos.push("co: C3 no tiene la razón social")
  if (texto(datos?.getCell("C4").value) !== "900123456") fallos.push("co: C4 no tiene el NIT")
  if (texto(banco?.getCell("C5").value) !== "03100012345") fallos.push("co: la cuenta no quedó en la celda pedida")
}

async function verificarEcuador(
  llenos: string[],
  faltantes: string[],
  confirmar: string[],
  checklist: Record<string, unknown>[],
  formulario: Record<string, unknown>,
): Promise<void> {
  if (llenos.includes("RUC") || !confirmar.includes("RUC")) fallos.push("ec: RUC debe requerir confirmación")
  if (!faltantes.includes("Número de contribuyente especial")) fallos.push("ec: falta el contribuyente especial")
  if (formulario.formato !== "pdf") fallos.push("ec: el formato debe ser pdf")
  const pdf = await Bun.file(path.join(directory, "out", "ec-corp-andina", "formulario.pdf")).bytes()
  if (pdf[0] !== 0x25) fallos.push("ec: el PDF no tiene cabecera válida")
  const tributario = checklist.find((item) => item.tipo === "certificado_cumplimiento_tributario")
  if (tributario?.estado !== "ausente") fallos.push("ec: el certificado tributario debe figurar ausente")
}

async function verificarHonduras(
  llenos: string[],
  faltantes: string[],
  confirmar: string[],
  checklist: Record<string, unknown>[],
  formulario: Record<string, unknown>,
): Promise<void> {
  if (llenos.includes("RTN") || !confirmar.includes("RTN")) fallos.push("hn: RTN debe requerir confirmación")
  if (!faltantes.includes("Referencias comerciales")) fallos.push("hn: referencias comerciales debe faltar")
  if (formulario.formato !== "xlsx") fallos.push("hn: el formato debe ser xlsx")
  const libro = new ExcelJS.Workbook()
  await libro.xlsx.readFile(path.join(directory, "out", "hn-agroexport-sula", "formulario.xlsx"))
  const hoja = libro.getWorksheet("Registro")
  if (texto(hoja?.getCell("B3").value) !== "900123456") fallos.push("hn: el RTN no se propuso con el NIT")
  if (texto(hoja?.getCell("A12").value) !== "Referencias comerciales") fallos.push("hn: falta la etiqueta de referencias")
  if (texto(hoja?.getCell("B12").value) !== "") fallos.push("hn: referencias comerciales no debe inventarse")
  const parafiscales = checklist.find((item) => item.tipo === "parafiscales")
  const esperado = "2026-08-31" < fechaEjecucion() ? "vencido" : "presente"
  if (parafiscales?.estado !== esperado) fallos.push(`hn: parafiscales debería estar ${esperado}`)
}

async function verificarPanama(
  llenos: string[],
  faltantes: string[],
  confirmar: string[],
  formulario: Record<string, unknown>,
): Promise<void> {
  if (llenos.includes("RUC") || !confirmar.includes("RUC") || faltantes.length !== 0) {
    fallos.push("pa: solo el RUC debe quedar en confirmación")
  }
  if (formulario.soportado !== false || formulario.mensaje !== "formato no soportado") {
    fallos.push("pa: el portal debe responder formato no soportado")
  }
  const markdown = await Bun.file(path.join(directory, "out", "pa-logistica-istmo", "valores-portal.md")).text()
  if (!markdown.includes("Formato no soportado")) fallos.push("pa: valores-portal.md no avisa el formato")
  if (await Bun.file(path.join(directory, "out", "pa-logistica-istmo", "formulario.xlsx")).exists()) {
    fallos.push("pa: no debe generarse un Excel de portal")
  }
}

async function verificarModulo(): Promise<void> {
  if (moduloTools.leer_solicitud !== appTools.leer_solicitud) fallos.push("modulo/tools no reexporta las herramientas de la app")
  if (moduloTools.mapear_campos !== appTools.mapear_campos) fallos.push("mapear_campos del módulo divergió")
  if (moduloTools.generar_formulario !== appTools.generar_formulario) fallos.push("generar_formulario del módulo divergió")
  if (moduloTools.armar_paquete !== appTools.armar_paquete) fallos.push("armar_paquete del módulo divergió")
  if (moduloTools.simular_envio !== appTools.simular_envio) fallos.push("simular_envio del módulo divergió")
  const promptTexto = await Bun.file(path.join(directory, "agent", "prompt.md")).text()
  const agentTexto = await Bun.file(path.join(directory, "modulo", "agent.md")).text()
  const conocimientoTexto = await Bun.file(path.join(directory, "src", "knowledge", "registro-proveedor.md")).text()
  const skillTexto = await Bun.file(path.join(directory, "modulo", "skill", "registro-proveedor", "SKILL.md")).text()
  if (cuerpo(agentTexto) !== promptTexto.trim()) fallos.push("modulo/agent.md no coincide con agent/prompt.md")
  if (cuerpo(skillTexto) !== conocimientoTexto.trim()) fallos.push("SKILL.md no coincide con el conocimiento")
}

function cuerpo(markdown: string): string {
  const texto = markdown.replace(/^\uFEFF/, "")
  if (!texto.startsWith("---\n")) return texto.trim()
  const fin = texto.indexOf("\n---\n", 4)
  if (fin < 0) return texto.trim()
  return texto.slice(fin + 5).trim()
}

async function llamar(nombre: string, args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
  const texto = await ejecutar(nombre, args, ctx)
  const valor: unknown = JSON.parse(texto)
  if (valor === null || typeof valor !== "object" || Array.isArray(valor)) {
    throw new Error(`${nombre} no devolvió un objeto`)
  }
  return valor as Record<string, unknown>
}

function datos(resultado: Record<string, unknown>): Record<string, unknown> {
  if (resultado.ok !== true || resultado.data === null || typeof resultado.data !== "object" || Array.isArray(resultado.data)) {
    throw new Error(typeof resultado.error === "string" ? resultado.error : "la herramienta falló")
  }
  return resultado.data as Record<string, unknown>
}

function comoLista(valor: unknown): Record<string, unknown>[] {
  if (!Array.isArray(valor)) return []
  return valor.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
}

function texto(valor: ExcelJS.CellValue): string {
  if (valor === null || valor === undefined) return ""
  if (typeof valor === "string" || typeof valor === "number" || typeof valor === "boolean") return String(valor)
  if (typeof valor === "object" && "text" in valor && typeof valor.text === "string") return valor.text
  return ""
}
