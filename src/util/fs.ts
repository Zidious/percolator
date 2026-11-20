import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { Document, LineCounter, parseDocument } from 'yaml';

export async function writeFileAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, data, 'utf8');
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

export async function readYamlFile(
  file: string,
): Promise<{ doc: Document; lineCounter: LineCounter; text: string }> {
  const text = await fs.readFile(file, 'utf8');
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  return { doc, lineCounter, text };
}
