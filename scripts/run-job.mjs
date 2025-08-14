#!/usr/bin/env node
import { pathToFileURL, fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error('Usage: node scripts/run-job.mjs <jobId> [--no-build]');
    process.exit(1);
  }

  const noBuild = process.argv.includes('--no-build');

  // Optionally build if the bundle or manifest is missing
  const jobsDir = path.join(__dirname, '..', 'dist', 'jobs');
  const manifestPath = path.join(jobsDir, 'manifest.json');
  let manifest = null;
  let bundlePath = path.join(jobsDir, `${jobId}.js`); // fallback single bundle
  try {
    const m = await fs.readFile(manifestPath, 'utf8').catch(() => null);
    if (m) {
      manifest = JSON.parse(m);
      const entry = manifest[jobId];
      if (entry) {
        bundlePath = path.join(__dirname, '..', 'dist', entry.file);
      }
    }
    await fs.stat(bundlePath);
  } catch {
    if (noBuild) {
      console.error(
        `Job bundle not found: ${path.relative(
          process.cwd(),
          bundlePath
        )}\nRun: tsx scripts/build-jobs.ts`
      );
      process.exit(1);
    }
    console.log('Bundle not found, building jobs...');
    const { spawn } = await import('node:child_process');
    await new Promise((resolve, reject) => {
      const p = spawn(
        process.platform === 'win32' ? 'npx.cmd' : 'npx',
        ['tsx', 'scripts/build-jobs.ts'],
        {
          stdio: 'inherit',
          cwd: path.join(__dirname, '..'),
        }
      );
      p.on('exit', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Build failed with code ${code}`))
      );
    });
    // Re-evaluate manifest and bundle after build
    const m2 = await fs.readFile(manifestPath, 'utf8').catch(() => null);
    if (m2) {
      manifest = JSON.parse(m2);
      const entry = manifest[jobId];
      if (entry) {
        bundlePath = path.join(__dirname, '..', 'dist', entry.file);
      }
    }
    // If still not found, fall back to single bundle path
    try {
      await fs.stat(bundlePath);
    } catch {
      bundlePath = path.join(jobsDir, `${jobId}.js`);
    }
  }

  // Import and run; handle group registry bundles transparently
  const url = pathToFileURL(bundlePath).href;
  const mod = await import(url);
  let Job = mod.default;
  if (!Job && mod.registry && typeof mod.registry === 'object') {
    // It's a grouped bundle - load from registry via manifest
    const m = manifest || JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const entry = m[jobId];
    if (entry && entry.mode === 'group') {
      Job = mod.registry[jobId];
    }
  }
  if (!Job) {
    console.error('Bundle does not have a default export.');
    process.exit(1);
  }
  const inst = new Job();
  if (typeof inst.run !== 'function') {
    console.error('Job instance has no run() method.');
    process.exit(1);
  }
  const result = await inst.run();
  if (result !== undefined) {
    try {
      console.log(JSON.stringify(result));
    } catch {
      console.log(result);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
