import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { UserConfigSchema } from './schema.ts';

export async function writeJsonSchema(outFile: string): Promise<void> {
  const schema = z.toJSONSchema(UserConfigSchema, { io: 'input' });
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeJsonSchema(path.resolve(import.meta.dirname, '..', '..', 'schema', 'percolator.schema.json'));
}
