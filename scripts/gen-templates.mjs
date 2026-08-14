// Generates convex/gatherville/templates.ts from prompts/genagents/**/*.txt
//
// Convex bundles modules; it can't read loose .txt files at runtime. Rather than
// hand-copying the research prompts (and silently drifting from upstream), we
// generate a TS module from the vendored files and check the result in.
//
// Run after ANY change to prompts/: `node scripts/gen-templates.mjs`
// CI should run it and fail if the working tree changes — see training/README.md.

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = 'prompts/genagents';
const OUT = 'convex/gatherville/templates.ts';

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.txt')) out.push(full);
  }
  return out;
}

const files = walk(SRC).sort();

// Key by upstream-relative path, preserving directory layout exactly — including
// upstream's `utternace` typo. Keeping the key identical to the upstream path
// means a future `diff -r` against genagents stays trivially readable.
const entries = files.map((file) => {
  const key = relative(SRC, file).replace(/\.txt$/, '');
  const body = readFileSync(file, 'utf8');
  return `  ${JSON.stringify(key)}: ${JSON.stringify(body)},`;
});

const banner = `// GENERATED FILE — DO NOT EDIT.
// Source: ${SRC}/**/*.txt  (vendored verbatim from joonspk-research/genagents, MIT)
// Regenerate: node scripts/gen-templates.mjs
//
// These strings are the research contribution. Editing them here — or "cleaning
// them up" — is the single easiest way to silently deviate from the published
// architecture. Change the .txt files, add a versioned variant, and regenerate.
`;

const source = `${banner}
export const TEMPLATES: Record<string, string> = {
${entries.join('\n')}
};

/**
 * Port of \`simulation_engine/gpt_structure.py:29 generate_prompt\`.
 *
 * Upstream, exactly:
 *   prompt_input = [str(i) for i in prompt_input]
 *   prompt = read(file)
 *   for count, input_text in enumerate(prompt_input):
 *       prompt = prompt.replace(f"!<INPUT {count}>!", input_text)
 *   if "<commentblockmarker>###</commentblockmarker>" in prompt:
 *       prompt = prompt.split("<commentblockmarker>###</commentblockmarker>")[1]
 *   return prompt.strip()
 *
 * Order matters and is preserved: substitution runs over the WHOLE file
 * (header included) and the header is discarded afterwards. Stripping first
 * gives the same bytes in every current template, but diverges the moment a
 * template's header changes or a substituted value contains the marker.
 *
 * \`split(marker)[1]\` takes the segment BETWEEN the first and second marker —
 * not everything after the first. Same thing for a single-marker file; not the
 * same if a template ever gains a second marker.
 */
export function renderTemplate(key: string, inputs: (string | number)[]): string {
  const raw = TEMPLATES[key];
  if (raw === undefined) {
    throw new Error(\`Unknown prompt template: \${key}. Known: \${Object.keys(TEMPLATES).join(', ')}\`);
  }

  let prompt = raw;
  inputs.forEach((value, i) => {
    prompt = prompt.replaceAll(\`!<INPUT \${i}>!\`, String(value));
  });

  const marker = '<commentblockmarker>###</commentblockmarker>';
  if (prompt.includes(marker)) {
    prompt = prompt.split(marker)[1];
  }

  return prompt.trim();
}
`;

writeFileSync(OUT, source);
console.log(`Generated ${OUT} from ${files.length} templates:`);
for (const f of files) console.log(`  ${relative(SRC, f)}`);
