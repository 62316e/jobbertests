import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { parse } from '@babel/parser';
import traverseImport from '@babel/traverse';
import { build as tsupBuild } from 'tsup';

const ROOT = process.cwd();
const NODE_TARGET = process.env.NODE_TARGET || 'esnext';
const DECORATOR_NAME = process.env.JOB_DECORATOR || 'job';
const BUNDLE_DECORATOR_NAME = process.env.BUNDLE_DECORATOR || 'bundleName';

type FoundJob = {
  jobId: string;
  className: string;
  isDefault: boolean;
  isExported: boolean;
  bundleName?: string | null;
};

function findDecoratedJobs(code: string): FoundJob[] {
  const ast = parse(code, {
    sourceType: 'module',
    plugins: ['typescript', 'decorators-legacy'],
  });

  const traverse = (traverseImport as any).default || (traverseImport as any);
  const out: FoundJob[] = [];

  traverse(ast as any, {
    ClassDeclaration(p: any) {
      const node = p.node as any;
      if (!node.decorators || node.decorators.length === 0) return;

      let hasJob = false;
      let jobId: string | null = null;
      let bundleName: string | null = null;

      for (const d of node.decorators) {
        const expr = d.expression;
        if (expr.type === 'Identifier' && expr.name === DECORATOR_NAME) {
          hasJob = true;
        } else if (
          expr.type === 'CallExpression' &&
          expr.callee.type === 'Identifier' &&
          expr.callee.name === DECORATOR_NAME
        ) {
          hasJob = true;
          const a0 = (expr.arguments || [])[0];
          if (a0 && a0.type === 'StringLiteral') jobId = a0.value;
        } else if (
          expr.type === 'CallExpression' &&
          expr.callee.type === 'Identifier' &&
          expr.callee.name === BUNDLE_DECORATOR_NAME
        ) {
          const a0 = (expr.arguments || [])[0];
          if (a0 && a0.type === 'StringLiteral') bundleName = a0.value;
        }
      }
      if (!hasJob) return;

      if (!jobId) {
        if (!node.id?.name) {
          throw new Error(
            `@${DECORATOR_NAME} class must have a name or @${DECORATOR_NAME}("id").`
          );
        }
        jobId = node.id.name;
      }

      const parentNode = p.parentPath.node;
      const isDefault =
        parentNode.type === 'ExportDefaultDeclaration' &&
        parentNode.declaration === node;
      const isNamed =
        parentNode.type === 'ExportNamedDeclaration' &&
        parentNode.declaration === node;
      const isExported = isDefault || isNamed;

      out.push({ jobId, className: node.id!.name, isDefault, isExported, bundleName });
    },
  });

  return out;
}

async function main() {
  // Load fast-glob in a way that works without esModuleInterop
  const fgMod = await import('fast-glob');
  const fg: any = (fgMod as any).default ?? fgMod;

  const files = await fg('src/**/*.job.ts', { absolute: true });
  if (!files.length) {
    console.error('No files matched src/**/*.job.ts');
    process.exit(1);
  }

  const jobs: Array<{ file: string } & FoundJob> = [];
  for (const file of files) {
    const code = await fs.readFile(file, 'utf8');
    const found = findDecoratedJobs(code);
    for (const f of found) {
      jobs.push({ file, ...f });
    }
  }

  if (!jobs.length) {
    console.error(
      `No decorated @${DECORATOR_NAME} classes found. Ensure your job class is exported and decorated.`
    );
    process.exit(1);
  }

  // Validations: exported, jobId format, duplicates
  const JOB_ID_RE = /^[a-zA-Z0-9._-]+$/;
  for (const j of jobs) {
    if (!j.isExported) {
      throw new Error(
        `Job "${j.jobId}" (${j.className}) in ${path.relative(
          ROOT,
          j.file
        )} must be exported. Use 'export class ...' or 'export default class ...'.`
      );
    }
    if (!j.jobId || !JOB_ID_RE.test(j.jobId)) {
      throw new Error(
        `Invalid job id "${j.jobId}" for class ${j.className} in ${path.relative(
          ROOT,
          j.file
        )}. Allowed: ${JOB_ID_RE}.`
      );
    }
  }
  const dupMap = new Map<string, Array<{ file: string; className: string }>>();
  for (const j of jobs) {
    const arr = dupMap.get(j.jobId) || [];
    arr.push({ file: j.file, className: j.className });
    dupMap.set(j.jobId, arr);
  }
  const dups: string[] = [];
  for (const [id, arr] of Array.from(dupMap.entries())) {
    if (arr.length > 1) {
      const lines = arr
        .map(
          (it) => ` - ${id}: ${it.className} (${path.relative(ROOT, it.file)})`
        )
        .join('\n');
      dups.push(lines);
    }
  }
  if (dups.length) {
    throw new Error(`Duplicate job ids detected:\n${dups.join('\n')}`);
  }

  // Parse bundling mode: default per-job; env BUNDLE_MODE=group or argv --bundle=group
  const argvBundleArg = process.argv.find((a) => a.startsWith('--bundle='));
  const bundleMode = (argvBundleArg?.split('=')[1] || process.env.BUNDLE_MODE || 'job') as
    | 'job'
    | 'group';

  // Prepare entries dir
  const entryDir = path.join(ROOT, 'dist', '.edgejobber', 'entries');
  await fs.mkdir(entryDir, { recursive: true });

  const entry: Record<string, string> = {};

  // Build per-job wrappers (skip jobs that are grouped)
  for (const j of jobs) {
    if (bundleMode === 'group' && j.bundleName) continue;
    const outPath = path.join(entryDir, `${j.jobId}.entry.ts`);

    // Simple wrapper: import module as namespace and re-export the job class as default
    let relSrc = path
      .relative(path.dirname(outPath), j.file)
      .split(path.sep)
      .join('/');
    if (!relSrc.startsWith('.')) relSrc = './' + relSrc;
    const ns = 'mod';
    const classRef = j.isDefault ? `${ns}.default` : `${ns}.${j.className}`;
    const moduleText = `// generated by edgejobber (single) for ${j.jobId}\nimport * as ${ns} from '${relSrc}';\nexport default ${classRef};\n`;
    await fs.writeFile(outPath, moduleText, 'utf8');
    entry[`jobs/${j.jobId}`] = outPath;
  }

  // Build grouped wrappers
  if (bundleMode === 'group') {
    const groups = new Map<string, Array<{ file: string } & FoundJob>>();
    for (const j of jobs) {
      if (!j.bundleName) continue;
      groups.set(j.bundleName, [...(groups.get(j.bundleName) || []), j]);
    }
    const tasks: Promise<void>[] = [];
    for (const [groupName, arr] of Array.from(groups.entries())) {
      tasks.push((async () => {
        const outPath = path.join(entryDir, `group-${groupName}.entry.ts`);
        const filesInGroup = Array.from(new Set<string>(arr.map((j) => j.file)));
        const modNames = new Map<string, string>();
        const importLines: string[] = [];
        for (let i = 0; i < filesInGroup.length; i++) {
          const f = filesInGroup[i];
          const ns = `m${i}`;
          let relSrc = path
            .relative(path.dirname(outPath), f)
            .split(path.sep)
            .join('/');
          if (!relSrc.startsWith('.')) relSrc = './' + relSrc;
          importLines.push(`import * as ${ns} from '${relSrc}';`);
          modNames.set(f, ns);
        }
        const regLines: string[] = [];
        for (const j of arr) {
          const ns = modNames.get(j.file)!;
          const ref = j.isDefault ? `${ns}.default` : `${ns}.${j.className}`;
          regLines.push(`  '${j.jobId}': ${ref}`);
        }
        const moduleText = `// generated by edgejobber (group: ${groupName})\n${importLines.join(
          '\n'
        )}\n\nexport const registry: Record<string, any> = {\n${regLines.join(
          ',\n'
        )}\n};\n`;
        await fs.writeFile(outPath, moduleText, 'utf8');
        entry[`groups/${groupName}`] = outPath;
      })());
    }
    await Promise.all(tasks);
  }

  // Determine dependencies to force-bundle (avoid externalizing node_modules)
  const pkgRaw = await fs.readFile(path.join(ROOT, 'package.json'), 'utf8');
  const pkg = JSON.parse(pkgRaw);
  const noExternalDeps: (string | RegExp)[] = Object.keys(pkg.dependencies || {});

  await tsupBuild({
    entry,
    outDir: 'dist',
    format: ['esm'],
    platform: 'node',
    target: NODE_TARGET,
    splitting: false, // ensure fully self-contained bundles per job/group
    treeshake: true,
    minify: false,
    sourcemap: false,
    clean: true,
    noExternal: noExternalDeps, // bundle listed dependencies into each bundle
    external: [
      'node:*',
      'fs',
      'path',
      'crypto',
      'os',
      'util',
      'stream',
      'events',
      'http',
      'https',
      'url',
      'zlib',
      'tty',
      'dns',
      'net',
      'tls',
    ],
  });

  // Write manifest for runner
  const manifestDir = path.join(ROOT, 'dist', 'jobs');
  await fs.mkdir(manifestDir, { recursive: true });
  const manifest: Record<
    string,
    | { mode: 'single'; file: string }
    | { mode: 'group'; file: string; group: string }
  > = {};
  for (const j of jobs) {
    if (bundleMode === 'group' && j.bundleName) {
      manifest[j.jobId] = {
        mode: 'group',
        file: `groups/${j.bundleName}.js`,
        group: j.bundleName,
      };
    } else {
      manifest[j.jobId] = { mode: 'single', file: `jobs/${j.jobId}.js` };
    }
  }
  await fs.writeFile(
    path.join(manifestDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );

  // Logs
  for (const j of jobs) {
    if (bundleMode === 'group' && j.bundleName) {
      console.log(
        `Bundled job ${j.jobId} in group '${j.bundleName}' -> dist/groups/${j.bundleName}.js`
      );
    } else {
      console.log(`Bundled job ${j.jobId} -> dist/jobs/${j.jobId}.js`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
