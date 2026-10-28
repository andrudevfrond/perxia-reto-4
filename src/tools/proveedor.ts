import { copyFile } from "node:fs/promises"
import path from "node:path"
import ExcelJS from "exceljs"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import { z } from "zod"
import {
  type CampoConfirmacion,
  type CampoFaltante,
  type CampoLleno,
  type CampoSolicitado,
  type Mapeo,
  type Solicitud,
  type SoporteIndice,
  type ToolContext,
  casoSeguro,
  dirCaso,
  dirOutCaso,
  esValorEscalar,
  fechaEjecucion,
  jaccard,
  leerJson,
  leerRuta,
  normalizar,
  responder,
  rutaRelativa,
  asegurarDir,
  tokens,
  valorCoincide,
} from "./datos.ts"

const campoSolicitado = z.object({
  etiqueta: z.string().describe("Etiqueta tal como aparece en la plantilla del cliente"),
  hoja: z.string().optional().describe("Hoja de Excel, si el formato es xlsx"),
  celda_etiqueta: z.string().optional().describe("Celda de la etiqueta"),
  celda_valor: z.string().optional().describe("Celda donde se escribe el valor"),
  obligatorio: z.boolean().optional().describe("Si la plantilla marca el campo como obligatorio"),
})

const campoLleno = z.object({
  etiqueta: z.string(),
  clave: z.string(),
  ruta: z.string(),
  valor: z.union([z.string(), z.number(), z.boolean()]),
  confianza: z.number().optional(),
})

const campoFaltante = z.object({
  etiqueta: z.string(),
  motivo: z.string().optional(),
})

const campoConfirmacion = z.object({
  etiqueta: z.string(),
  clave_propuesta: z.string().optional(),
  ruta: z.string().optional(),
  valor_propuesto: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  nota: z.string().optional(),
  confianza: z.number().optional(),
})

const mapeoSchema = z.object({
  llenos: z.array(campoLleno).describe("Campos con valor tomado del maestro"),
  faltantes: z.array(campoFaltante).describe("Campos sin fuente en el maestro"),
  requiere_confirmacion: z.array(campoConfirmacion).describe("Campos que un humano debe confirmar"),
})

type ToolDefinition = {
  description: string
  args: Record<string, z.ZodType>
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>
}

const ETIQUETAS_AMBIGUAS = new Set(["identificacion tributaria", "numero de identificacion fiscal"])
const ETIQUETAS_ID_EXTRANJERO = new Set(["ruc", "rtn"])
const NOTA_ID_EXTRANJERO = "identificador extranjero"
const UMBRAL_PARCIAL = 0.5
const UMBRAL_LLENO = 0.8

function definirHerramienta<S extends z.ZodRawShape>(
  nombre: string,
  def: {
    description: string
    args: S
    execute: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<string>
  },
): ToolDefinition {
  return {
    description: def.description,
    args: def.args,
    async execute(args, ctx) {
      const caso = typeof args.caso === "string" ? args.caso : undefined
      try {
        const parsed = z.object(def.args).safeParse(args)
        if (!parsed.success) {
          const detalle = parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "argumentos"}: ${issue.message}`)
            .join("; ")
          return responder(ctx, nombre, caso, { ok: false, error: `Argumentos inválidos: ${detalle}` })
        }
        return await def.execute(parsed.data, ctx)
      } catch {
        try {
          return await responder(ctx, nombre, caso, {
            ok: false,
            error: "No se pudo completar la operación. Revisa el caso y vuelve a intentar.",
          })
        } catch {
          return JSON.stringify({
            ok: false,
            error: "No se pudo completar la operación. Revisa el caso y vuelve a intentar.",
          })
        }
      }
    },
  }
}

function errorCaso(caso: string): string {
  return `Caso no encontrado: ${caso}.`
}

async function cargarSolicitud(directory: string, caso: string) {
  if (!casoSeguro(caso)) return { ok: false as const, error: errorCaso(caso) }
  const solicitudPath = path.join(dirCaso(directory, caso), "solicitud.json")
  const file = Bun.file(solicitudPath)
  if (!(await file.exists())) return { ok: false as const, error: errorCaso(caso) }
  return leerJson<Solicitud>(solicitudPath)
}

function esCelda(valor: unknown): valor is { hoja: string; celda_etiqueta: string; etiqueta: string; celda_valor: string } {
  if (valor === null || typeof valor !== "object") return false
  const fila = valor as Record<string, unknown>
  return (
    typeof fila.hoja === "string" &&
    typeof fila.celda_etiqueta === "string" &&
    typeof fila.etiqueta === "string" &&
    typeof fila.celda_valor === "string"
  )
}

function esCampoPdf(valor: unknown): valor is { etiqueta: string; obligatorio?: boolean } {
  if (valor === null || typeof valor !== "object") return false
  const fila = valor as Record<string, unknown>
  return typeof fila.etiqueta === "string"
}

async function leerCampos(directory: string, caso: string, formato: string) {
  const base = dirCaso(directory, caso)
  if (formato === "xlsx") {
    const leido = await leerJson<unknown>(path.join(base, "plantilla-celdas.json"))
    if (!leido.ok) return leido
    if (!Array.isArray(leido.data) || !leido.data.every(esCelda)) {
      return { ok: false as const, error: "Plantilla corrupta: plantilla-celdas.json no tiene la forma esperada." }
    }
    const campos: CampoSolicitado[] = leido.data.map((fila) => ({
      etiqueta: fila.etiqueta,
      hoja: fila.hoja,
      celda_etiqueta: fila.celda_etiqueta,
      celda_valor: fila.celda_valor,
    }))
    return { ok: true as const, data: campos }
  }
  if (formato === "pdf" || formato === "portal") {
    const leido = await leerJson<unknown>(path.join(base, "plantilla-campos.json"))
    if (!leido.ok) return leido
    if (!Array.isArray(leido.data) || !leido.data.every(esCampoPdf)) {
      return { ok: false as const, error: "Plantilla corrupta: plantilla-campos.json no tiene la forma esperada." }
    }
    const campos: CampoSolicitado[] = leido.data.map((fila) => ({
      etiqueta: fila.etiqueta,
      obligatorio: fila.obligatorio === true,
    }))
    return { ok: true as const, data: campos }
  }
  return { ok: true as const, data: [] as CampoSolicitado[] }
}

export const leer_solicitud = definirHerramienta("proveedor_leer_solicitud", {
  description: "Lee la solicitud, la plantilla y los soportes exigidos de un caso.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/"),
  },
  async execute(args, ctx) {
    const solicitud = await cargarSolicitud(ctx.directory, args.caso)
    if (!solicitud.ok) return responder(ctx, "proveedor_leer_solicitud", args.caso, solicitud)
    const campos = await leerCampos(ctx.directory, args.caso, solicitud.data.formato)
    if (!campos.ok) return responder(ctx, "proveedor_leer_solicitud", args.caso, campos)
    const soportes = await leerJson<unknown>(path.join(dirCaso(ctx.directory, args.caso), "soportes-exigidos.json"))
    if (!soportes.ok) return responder(ctx, "proveedor_leer_solicitud", args.caso, soportes)
    if (!Array.isArray(soportes.data) || !soportes.data.every((item) => typeof item === "string")) {
      return responder(ctx, "proveedor_leer_solicitud", args.caso, {
        ok: false,
        error: "Plantilla corrupta: soportes-exigidos.json no es una lista de tipos.",
      })
    }
    return responder(ctx, "proveedor_leer_solicitud", args.caso, {
      ok: true,
      data: {
        pais: solicitud.data.pais,
        cliente: solicitud.data.cliente,
        formato: solicitud.data.formato,
        campos: campos.data,
        soportes: soportes.data,
      },
    })
  },
})

function redondear(valor: number): number {
  return Math.round(valor * 100) / 100
}

function esIdentificadorExtranjero(etiqueta: string, pais: string, clave: string): boolean {
  if (clave !== "nit") return false
  const norma = normalizar(etiqueta)
  if (ETIQUETAS_AMBIGUAS.has(norma)) return true
  return pais !== "CO" && ETIQUETAS_ID_EXTRANJERO.has(norma)
}

export const mapear_campos = definirHerramienta("proveedor_mapear_campos", {
  description: "Cruza cada campo solicitado con el glosario y el maestro, sin inventar valores.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    campos: z.array(campoSolicitado).describe("Campos devueltos por proveedor_leer_solicitud"),
  },
  async execute(args, ctx) {
    const solicitud = await cargarSolicitud(ctx.directory, args.caso)
    if (!solicitud.ok) return responder(ctx, "proveedor_mapear_campos", args.caso, solicitud)
    const glosarioPath = path.join(ctx.directory, "fixtures", "reto-01", "glosario-campos.json")
    const maestroPath = path.join(ctx.directory, "fixtures", "reto-01", "repositorio", "maestro.json")
    const glosario = await leerJson<Record<string, string>>(glosarioPath)
    const maestro = await leerJson<Record<string, unknown>>(maestroPath)
    if (!glosario.ok) return responder(ctx, "proveedor_mapear_campos", args.caso, glosario)
    if (!maestro.ok) return responder(ctx, "proveedor_mapear_campos", args.caso, maestro)

    const exactos = new Map<string, string>()
    const entradas = Object.entries(glosario.data)
    for (const [etiqueta, clave] of entradas) exactos.set(normalizar(etiqueta), clave)

    const llenos: CampoLleno[] = []
    const faltantes: CampoFaltante[] = []
    const requiere_confirmacion: CampoConfirmacion[] = []

    for (const campo of args.campos) {
      const norma = normalizar(campo.etiqueta)
      const exacto = exactos.get(norma)
      let clave: string | undefined
      let confianza = 0
      if (exacto) {
        clave = exacto
        confianza = 1
      } else {
        let mejor = 0
        let claveMejor: string | undefined
        const propios = tokens(campo.etiqueta)
        for (const [etiqueta, candidata] of entradas) {
          const puntaje = jaccard(propios, tokens(etiqueta))
          if (puntaje > mejor) {
            mejor = puntaje
            claveMejor = candidata
          }
        }
        if (claveMejor && mejor >= UMBRAL_PARCIAL) {
          clave = claveMejor
          confianza = redondear(mejor)
        }
      }

      if (!clave) {
        faltantes.push({ etiqueta: campo.etiqueta, motivo: "No existe en el maestro ni en el glosario." })
        continue
      }

      const valor = leerRuta(maestro.data, clave)
      if (!esValorEscalar(valor)) {
        faltantes.push({ etiqueta: campo.etiqueta, motivo: "La clave del glosario no tiene un valor en el maestro." })
        continue
      }

      if (esIdentificadorExtranjero(campo.etiqueta, solicitud.data.pais, clave)) {
        requiere_confirmacion.push({
          etiqueta: campo.etiqueta,
          clave_propuesta: clave,
          ruta: clave,
          valor_propuesto: valor,
          nota: NOTA_ID_EXTRANJERO,
          confianza,
        })
        continue
      }

      if (confianza < UMBRAL_LLENO) {
        requiere_confirmacion.push({
          etiqueta: campo.etiqueta,
          clave_propuesta: clave,
          ruta: clave,
          valor_propuesto: null,
          nota: "Coincidencia parcial por debajo de 0.8. Confirma el campo antes de usarlo.",
          confianza,
        })
        continue
      }

      llenos.push({ etiqueta: campo.etiqueta, clave, ruta: clave, valor, confianza })
    }

    const mapeo: Mapeo = { llenos, faltantes, requiere_confirmacion }
    const destino = path.join(dirOutCaso(ctx.directory, args.caso), "mapeo.json")
    await asegurarDir(path.dirname(destino))
    await Bun.write(destino, JSON.stringify(mapeo, null, 2))
    return responder(ctx, "proveedor_mapear_campos", args.caso, { ok: true, data: mapeo })
  },
})

type ValorEscrito = string | number | boolean | null

function buscarMapeo(mapeo: Mapeo, etiqueta: string) {
  const norma = normalizar(etiqueta)
  const lleno = mapeo.llenos.find((item) => normalizar(item.etiqueta) === norma)
  if (lleno) return { estado: "lleno" as const, item: lleno }
  const confirmar = mapeo.requiere_confirmacion.find((item) => normalizar(item.etiqueta) === norma)
  if (confirmar) return { estado: "requiere_confirmacion" as const, item: confirmar }
  const faltante = mapeo.faltantes.find((item) => normalizar(item.etiqueta) === norma)
  if (faltante) return { estado: "faltante" as const, item: faltante }
  return { estado: "faltante" as const, item: { etiqueta, motivo: "No vino en el mapeo." } }
}

function valorParaEscribir(
  estado: ReturnType<typeof buscarMapeo>,
  maestro: Record<string, unknown>,
): { valor: ValorEscrito; descartado?: string } {
  if (estado.estado === "faltante") return { valor: null }
  if (estado.estado === "lleno") {
    const real = leerRuta(maestro, estado.item.ruta)
    if (!valorCoincide(real, estado.item.valor) || !esValorEscalar(real)) {
      return { valor: null, descartado: "El valor no coincide con el maestro y no se escribió." }
    }
    return { valor: real }
  }
  if (estado.item.nota !== NOTA_ID_EXTRANJERO || !estado.item.ruta || estado.item.valor_propuesto == null) {
    return { valor: null }
  }
  const real = leerRuta(maestro, estado.item.ruta)
  if (!valorCoincide(real, estado.item.valor_propuesto) || !esValorEscalar(real)) {
    return { valor: null, descartado: "El identificador propuesto no coincide con el maestro y no se escribió." }
  }
  return { valor: real }
}

function textoPlano(valor: ValorEscrito): string {
  if (valor === null) return ""
  return String(valor)
}

async function escribirExcel(
  directory: string,
  caso: string,
  mapeo: Mapeo,
  maestro: Record<string, unknown>,
): Promise<{ ruta: string; descartados: { etiqueta: string; motivo: string }[] }> {
  const plantilla = await leerJson<unknown>(path.join(dirCaso(directory, caso), "plantilla-celdas.json"))
  if (!plantilla.ok) throw new Error(plantilla.error)
  if (!Array.isArray(plantilla.data) || !plantilla.data.every(esCelda)) {
    throw new Error("Plantilla corrupta: plantilla-celdas.json no tiene la forma esperada.")
  }
  const libro = new ExcelJS.Workbook()
  const descartados: { etiqueta: string; motivo: string }[] = []
  for (const fila of plantilla.data) {
    let hoja = libro.getWorksheet(fila.hoja)
    if (!hoja) hoja = libro.addWorksheet(fila.hoja)
    hoja.getCell(fila.celda_etiqueta).value = fila.etiqueta
    const decision = valorParaEscribir(buscarMapeo(mapeo, fila.etiqueta), maestro)
    if (decision.descartado) descartados.push({ etiqueta: fila.etiqueta, motivo: decision.descartado })
    if (decision.valor !== null) hoja.getCell(fila.celda_valor).value = decision.valor
    hoja.getColumn(fila.celda_etiqueta[0] ?? "A").width = 42
    hoja.getColumn(fila.celda_valor[0] ?? "B").width = 64
  }
  const destino = path.join(dirOutCaso(directory, caso), "formulario.xlsx")
  await asegurarDir(path.dirname(destino))
  await libro.xlsx.writeFile(destino)
  return { ruta: rutaRelativa(directory, destino), descartados }
}

function trocear(texto: string, ancho: number): string[] {
  const palabras = texto.split(/\s+/)
  const lineas: string[] = []
  let actual = ""
  for (const palabra of palabras) {
    const candidato = actual ? `${actual} ${palabra}` : palabra
    if (candidato.length > ancho && actual) {
      lineas.push(actual)
      actual = palabra
    } else {
      actual = candidato
    }
  }
  if (actual) lineas.push(actual)
  return lineas.length > 0 ? lineas : [""]
}

function winAnsi(texto: string): string {
  return texto.replace(/[^\n\r\t\x20-\xFF]/g, "?")
}

async function escribirPdf(
  directory: string,
  caso: string,
  mapeo: Mapeo,
  maestro: Record<string, unknown>,
  solicitud: Solicitud,
): Promise<{ ruta: string; descartados: { etiqueta: string; motivo: string }[] }> {
  const plantilla = await leerJson<unknown>(path.join(dirCaso(directory, caso), "plantilla-campos.json"))
  if (!plantilla.ok) throw new Error(plantilla.error)
  if (!Array.isArray(plantilla.data) || !plantilla.data.every(esCampoPdf)) {
    throw new Error("Plantilla corrupta: plantilla-campos.json no tiene la forma esperada.")
  }
  const doc = await PDFDocument.create()
  doc.setTitle(`Registro proveedor ${caso}`)
  const fuente = await doc.embedFont(StandardFonts.Helvetica)
  const fuenteNegrita = await doc.embedFont(StandardFonts.HelveticaBold)
  const descartados: { etiqueta: string; motivo: string }[] = []
  let pagina = doc.addPage([595, 842])
  let y = 800
  const margen = 48
  const dibujar = (texto: string, tamano: number, negrita = false) => {
    for (const linea of trocear(winAnsi(texto), 90)) {
      if (y < 56) {
        pagina = doc.addPage([595, 842])
        y = 800
      }
      pagina.drawText(linea, {
        x: margen,
        y,
        size: tamano,
        font: negrita ? fuenteNegrita : fuente,
        color: rgb(0.1, 0.12, 0.16),
      })
      y -= tamano + 6
    }
  }
  dibujar(`Formulario de registro — ${solicitud.cliente}`, 14, true)
  dibujar(`Caso ${caso} · país ${solicitud.pais}`, 10)
  y -= 8
  for (const fila of plantilla.data) {
    const decision = valorParaEscribir(buscarMapeo(mapeo, fila.etiqueta), maestro)
    if (decision.descartado) descartados.push({ etiqueta: fila.etiqueta, motivo: decision.descartado })
    const estado = buscarMapeo(mapeo, fila.etiqueta)
    let valor = "(faltante)"
    if (decision.valor !== null) {
      valor = textoPlano(decision.valor)
      if (estado.estado === "requiere_confirmacion") valor += ` (requiere confirmación: ${estado.item.nota})`
    } else if (estado.estado === "requiere_confirmacion") {
      valor = `(requiere confirmación: ${estado.item.nota})`
    }
    dibujar(`${fila.etiqueta}: ${valor}`, 11)
  }
  const destino = path.join(dirOutCaso(directory, caso), "formulario.pdf")
  await asegurarDir(path.dirname(destino))
  await Bun.write(destino, await doc.save())
  return { ruta: rutaRelativa(directory, destino), descartados }
}

async function escribirPortal(
  directory: string,
  caso: string,
  mapeo: Mapeo,
  maestro: Record<string, unknown>,
  solicitud: Solicitud,
): Promise<{ ruta: string; descartados: { etiqueta: string; motivo: string }[] }> {
  const plantilla = await leerJson<unknown>(path.join(dirCaso(directory, caso), "plantilla-campos.json"))
  if (!plantilla.ok) throw new Error(plantilla.error)
  if (!Array.isArray(plantilla.data) || !plantilla.data.every(esCampoPdf)) {
    throw new Error("Plantilla corrupta: plantilla-campos.json no tiene la forma esperada.")
  }
  const descartados: { etiqueta: string; motivo: string }[] = []
  const filas = ["| Etiqueta | Estado | Valor |", "| --- | --- | --- |"]
  for (const fila of plantilla.data) {
    const estado = buscarMapeo(mapeo, fila.etiqueta)
    const decision = valorParaEscribir(estado, maestro)
    if (decision.descartado) descartados.push({ etiqueta: fila.etiqueta, motivo: decision.descartado })
    const valor = decision.valor === null ? "" : textoPlano(decision.valor).replace(/\|/g, "/")
    filas.push(`| ${fila.etiqueta} | ${estado.estado} | ${valor} |`)
  }
  const cuerpo = [
    `# Valores para el portal — ${solicitud.cliente}`,
    "",
    "Formato no soportado para llenado automático. Copia estos valores en el portal. El ingreso de credenciales y el botón Enviar los hace una persona.",
    "",
    ...filas,
    "",
  ].join("\n")
  const destino = path.join(dirOutCaso(directory, caso), "valores-portal.md")
  await asegurarDir(path.dirname(destino))
  await Bun.write(destino, cuerpo)
  return { ruta: rutaRelativa(directory, destino), descartados }
}

function comoMapeo(entrada: z.infer<typeof mapeoSchema>): Mapeo {
  return {
    llenos: entrada.llenos.map((item) => ({ ...item, confianza: item.confianza ?? 1 })),
    faltantes: entrada.faltantes.map((item) => ({
      etiqueta: item.etiqueta,
      motivo: item.motivo ?? "Sin fuente en el maestro.",
    })),
    requiere_confirmacion: entrada.requiere_confirmacion.map((item) => ({
      etiqueta: item.etiqueta,
      clave_propuesta: item.clave_propuesta ?? "",
      ruta: item.ruta ?? "",
      valor_propuesto: item.valor_propuesto ?? null,
      nota: item.nota ?? "",
      confianza: item.confianza ?? 0,
    })),
  }
}

export const generar_formulario = definirHerramienta("proveedor_generar_formulario", {
  description: "Genera el formulario del caso en Excel, PDF o un markdown de portal, solo con valores del maestro.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    mapeo: mapeoSchema.describe("Objeto data devuelto por proveedor_mapear_campos"),
  },
  async execute(args, ctx) {
    const solicitud = await cargarSolicitud(ctx.directory, args.caso)
    if (!solicitud.ok) return responder(ctx, "proveedor_generar_formulario", args.caso, solicitud)
    const maestro = await leerJson<Record<string, unknown>>(
      path.join(ctx.directory, "fixtures", "reto-01", "repositorio", "maestro.json"),
    )
    if (!maestro.ok) return responder(ctx, "proveedor_generar_formulario", args.caso, maestro)
    const formato = solicitud.data.formato
    const mapeo = comoMapeo(args.mapeo)
    try {
      if (formato === "xlsx") {
        const escrito = await escribirExcel(ctx.directory, args.caso, mapeo, maestro.data)
        return responder(ctx, "proveedor_generar_formulario", args.caso, {
          ok: true,
          data: { ruta: escrito.ruta, formato, descartados: escrito.descartados },
        })
      }
      if (formato === "pdf") {
        const escrito = await escribirPdf(ctx.directory, args.caso, mapeo, maestro.data, solicitud.data)
        return responder(ctx, "proveedor_generar_formulario", args.caso, {
          ok: true,
          data: { ruta: escrito.ruta, formato, descartados: escrito.descartados },
        })
      }
      if (formato === "portal") {
        const escrito = await escribirPortal(ctx.directory, args.caso, mapeo, maestro.data, solicitud.data)
        return responder(ctx, "proveedor_generar_formulario", args.caso, {
          ok: true,
          data: {
            ruta: escrito.ruta,
            formato,
            soportado: false,
            mensaje: "formato no soportado",
            descartados: escrito.descartados,
          },
        })
      }
      return responder(ctx, "proveedor_generar_formulario", args.caso, {
        ok: false,
        error: `formato no soportado: ${formato}`,
      })
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : "No se pudo generar el formulario."
      return responder(ctx, "proveedor_generar_formulario", args.caso, { ok: false, error: mensaje })
    }
  },
})

function estadoSoporte(vigencia: string | null, hoy: string): "presente" | "vencido" {
  if (vigencia && vigencia < hoy) return "vencido"
  return "presente"
}

export const armar_paquete = definirHerramienta("proveedor_armar_paquete", {
  description: "Arma la carpeta de firma con formulario, soportes, checklist y borrador de correo.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
  },
  async execute(args, ctx) {
    const solicitud = await cargarSolicitud(ctx.directory, args.caso)
    if (!solicitud.ok) return responder(ctx, "proveedor_armar_paquete", args.caso, solicitud)
    const exigidos = await leerJson<unknown>(path.join(dirCaso(ctx.directory, args.caso), "soportes-exigidos.json"))
    if (!exigidos.ok) return responder(ctx, "proveedor_armar_paquete", args.caso, exigidos)
    if (!Array.isArray(exigidos.data) || !exigidos.data.every((item) => typeof item === "string")) {
      return responder(ctx, "proveedor_armar_paquete", args.caso, {
        ok: false,
        error: "Plantilla corrupta: soportes-exigidos.json no es una lista de tipos.",
      })
    }
    const indice = await leerJson<SoporteIndice[]>(
      path.join(ctx.directory, "fixtures", "reto-01", "repositorio", "soportes", "index.json"),
    )
    if (!indice.ok) return responder(ctx, "proveedor_armar_paquete", args.caso, indice)
    const mapeoLeido = await leerJson<Mapeo>(path.join(dirOutCaso(ctx.directory, args.caso), "mapeo.json"))
    const mapeo = mapeoLeido.ok ? mapeoLeido.data : { llenos: [], faltantes: [], requiere_confirmacion: [] }

    const paquete = path.join(dirOutCaso(ctx.directory, args.caso), "paquete")
    await asegurarDir(paquete)
    const hoy = fechaEjecucion()
    const origenOut = dirOutCaso(ctx.directory, args.caso)
    for (const nombre of ["formulario.xlsx", "formulario.pdf", "valores-portal.md"]) {
      const origen = path.join(origenOut, nombre)
      if (await Bun.file(origen).exists()) await copyFile(origen, path.join(paquete, nombre))
    }

    const checklist: {
      tipo: string
      estado: "presente" | "ausente" | "vencido"
      vigencia_hasta: string | null
      archivo: string | null
    }[] = []
    let bloqueado = false
    for (const tipo of exigidos.data) {
      const soporte = indice.data.find((item) => item.tipo === tipo)
      if (!soporte) {
        checklist.push({ tipo, estado: "ausente", vigencia_hasta: null, archivo: null })
        bloqueado = true
        continue
      }
      const estado = estadoSoporte(soporte.vigencia_hasta, hoy)
      if (estado === "vencido") bloqueado = true
      const origen = path.join(ctx.directory, "fixtures", "reto-01", "repositorio", "soportes", soporte.archivo)
      if (await Bun.file(origen).exists()) await copyFile(origen, path.join(paquete, soporte.archivo))
      checklist.push({ tipo, estado, vigencia_hasta: soporte.vigencia_hasta, archivo: soporte.archivo })
    }

    const lineasSoportes = checklist.map((item) => {
      const vigencia = item.vigencia_hasta ? `, vigencia hasta ${item.vigencia_hasta}` : ""
      const archivo = item.archivo ? `, archivo ${item.archivo}` : ""
      return `- ${item.tipo}: ${item.estado}${vigencia}${archivo}`
    })
    const lineasFaltantes =
      mapeo.faltantes.length > 0 ? mapeo.faltantes.map((item) => `- ${item.etiqueta}`) : ["- Ninguno"]
    const lineasConfirmacion =
      mapeo.requiere_confirmacion.length > 0
        ? mapeo.requiere_confirmacion.map((item) => `- ${item.etiqueta}: ${item.nota}`)
        : ["- Ninguna"]
    const listo = !bloqueado
    const checklistMd = [
      `# Checklist — ${args.caso}`,
      "",
      `Fecha de revisión: ${hoy}`,
      `Listo para firma: ${listo ? "sí" : "no"}`,
      "",
      "## Soportes",
      ...lineasSoportes,
      "",
      "## Campos faltantes",
      ...lineasFaltantes,
      "",
      "## Requieren confirmación",
      ...lineasConfirmacion,
      "",
      "Un campo faltante no impide la firma. Un soporte ausente o vencido sí la impide.",
      "",
    ].join("\n")
    await Bun.write(path.join(paquete, "checklist.md"), checklistMd)

    const actualizar = checklist.filter((item) => item.estado !== "presente").map((item) => `- ${item.tipo} (${item.estado})`)
    const borrador = [
      `Para: ${solicitud.data.de}`,
      `Asunto: Re: ${solicitud.data.asunto}`,
      "",
      "Estimados,",
      "",
      `Preparamos el registro de Periferia IT Group S.A.S. como proveedor de ${solicitud.data.cliente}. El formulario y los soportes disponibles están en el paquete, pendientes de la firma del representante legal.`,
      "",
      "Este mensaje es un borrador. No se ha enviado.",
      "",
      "Soportes por actualizar:",
      ...(actualizar.length > 0 ? actualizar : ["- Ninguno"]),
      "",
      "Campos que no están en el repositorio maestro:",
      ...lineasFaltantes,
      "",
      "Quedamos atentos a la firma para poder responder al cliente.",
      "",
      "Analista administrativa",
      "Periferia IT Group",
      "",
    ].join("\n")
    await Bun.write(path.join(paquete, "borrador-correo.md"), borrador)

    return responder(ctx, "proveedor_armar_paquete", args.caso, {
      ok: true,
      data: {
        ruta: rutaRelativa(ctx.directory, paquete),
        listo_para_firma: listo,
        checklist,
        campos_faltantes: mapeo.faltantes.map((item) => item.etiqueta),
        requiere_confirmacion: mapeo.requiere_confirmacion.map((item) => item.etiqueta),
      },
    })
  },
})

export const simular_envio = definirHerramienta("proveedor_simular_envio", {
  description: "Escribe ENVIO-SIMULADO.md únicamente si el usuario confirmó el envío en este turno.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    confirmado: z.boolean().describe("True solo cuando el mensaje anterior del usuario confirma el envío"),
  },
  async execute(args, ctx) {
    if (!casoSeguro(args.caso)) {
      return responder(ctx, "proveedor_simular_envio", undefined, { ok: false, error: errorCaso(args.caso) })
    }
    const solicitud = await cargarSolicitud(ctx.directory, args.caso)
    if (!solicitud.ok) return responder(ctx, "proveedor_simular_envio", args.caso, solicitud)
    if (args.confirmado !== true || ctx.confirmadoPorUsuario !== true) {
      return responder(ctx, "proveedor_simular_envio", args.caso, {
        ok: false,
        error: "requiere confirmación explícita",
      })
    }
    const destino = path.join(dirOutCaso(ctx.directory, args.caso), "ENVIO-SIMULADO.md")
    await asegurarDir(path.dirname(destino))
    const cuerpo = [
      "# Envío simulado",
      "",
      `Caso: ${args.caso}`,
      `Cliente: ${solicitud.data.cliente}`,
      `Fecha: ${new Date().toISOString()}`,
      "",
      "Una persona confirmó el envío en el chat. No se envió correo, no se firmó el formulario y no se cargó ningún portal.",
      "",
    ].join("\n")
    await Bun.write(destino, cuerpo)
    return responder(ctx, "proveedor_simular_envio", args.caso, {
      ok: true,
      data: { ruta: rutaRelativa(ctx.directory, destino) },
    })
  },
})
