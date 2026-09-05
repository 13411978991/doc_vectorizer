/**
 * src/api/convert-routes.ts — File format conversion (.pdf, .docx, .pptx,
 * .xlsx, .xls, .csv, .html, .htm) to markdown via the in-process Node
 * converter. No external dependencies — works on a fresh Windows install
 * with no Python interpreter, no LibreOffice, no tesseract.
 */

import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { convertFile } from "../watcher/file-converter.js";

const CONVERT_ALLOWED = new Set([
  ".pdf",
  ".docx",
  ".pptx",
  ".xlsx",
  ".xls",
  ".csv",
  ".html",
  ".htm"
]);

const convertBodySchema = z.object({
  fileName: z.string().min(1),
  content: z.string() // base64-encoded file content
});

export function registerConvertRoutes(app: FastifyInstance): void {
  app.post("/api/convert", async (request, reply) => {
    const input = convertBodySchema.parse(request.body);

    const extension = input.fileName.includes(".")
      ? input.fileName.slice(input.fileName.lastIndexOf(".")).toLowerCase()
      : "";
    if (!CONVERT_ALLOWED.has(extension)) {
      return reply.code(400).send({ error: `Unsupported file type for conversion: ${extension}` });
    }

    const tmpDir = path.join(process.cwd(), ".tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const inputPath = path.join(tmpDir, `convert_in_${stamp}_${input.fileName}`);
    const debugOutput = path.join(tmpDir, `convert_out_${stamp}_${input.fileName}.md`);

    try {
      fs.writeFileSync(inputPath, Buffer.from(input.content, "base64"));
      const markdown = await convertFile(inputPath, debugOutput);
      return { markdown };
    } catch (error) {
      return reply.code(422).send({ error: (error as Error).message });
    } finally {
      try { fs.unlinkSync(inputPath); } catch { /* ignore */ }
      try { fs.unlinkSync(debugOutput); } catch { /* ignore */ }
    }
  });
}