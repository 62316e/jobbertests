import path from "node:path";
import fs from "node:fs/promises";
import fg from "fast-glob";
import { parse } from "@babel/parser";
import traverseImport from "@babel/traverse";
import { build as tsupBuild } from "tsup";

const ROOT = process.cwd();
const NODE_TARGET = process.env.NODE_TARGET || "node20";
const DECORATOR_NAME = process.env.JOB_DECORATOR || "job";

function findDecoratedJobs(code) {
    const ast = parse(code, {
        sourceType: "module",
        plugins: ["typescript", "decorators-legacy"]
    });

    // Support both CJS and ESM shapes of @babel/traverse
    const traverse = (traverseImport as any).default || (traverseImport as any);

    const out = []; // { jobId }
    traverse(ast, {
        ClassDeclaration(p) {
            const node = p.node;
            if (!node.decorators || node.decorators.length === 0) return;

            let hasJob = false;
            let jobId = null;
        const out: Array<{ jobId: string; className: string; isDefault: boolean }> = [];
            for (const d of node.decorators) {
                const expr = d.expression;
                if (expr.type === "Identifier" && expr.name === DECORATOR_NAME) {
                    hasJob = true;
                } else if (
                    expr.type === "CallExpression" &&
                    expr.callee.type === "Identifier" &&
                    expr.callee.name === DECORATOR_NAME
                ) {
                    hasJob = true;
                    const a0 = expr.arguments[0];
                    if (a0 && a0.type === "StringLiteral") jobId = a0.value;
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

            // Allow both default-exported and named-exported decorated classes.

            out.push({ jobId });
        }
    });
    return out;
}

async function main() {
                const isDefault =
                    p.parentPath.node.type === "ExportDefaultDeclaration" &&
                    p.parentPath.node.declaration === node;

                out.push({ jobId, className: node.id!.name, isDefault });
    if (!files.length) {
        console.error("No files matched src/**/*.job.ts");
        process.exit(1);
    }

        const jobs: Array<{ file: string; jobId: string; className: string; isDefault: boolean }> = [];
    for (const file of files) {
        const code = await fs.readFile(file, "utf8");
            const found = findDecoratedJobs(code);
            for (const f of found) {
                jobs.push({ file, jobId: f.jobId, className: f.className, isDefault: f.isDefault });
        }
    }

    if (!jobs.length) {
        console.error(
            "No decorated @job classes found. Ensure your job class is default-exported and decorated."
        );
        process.exit(1);
    }

        // Create per-job wrapper entry files to allow tree-shaking per job
        const entryDir = path.join(ROOT, ".edgejobber", "entries");
        await fs.mkdir(entryDir, { recursive: true });

        const entry: Record<string, string> = {};
        for (const j of jobs) {
            const wrapperPath = path.join(entryDir, `${j.jobId}.entry.ts`);
            const rel = path.relative(path.dirname(wrapperPath), j.file).split(path.sep).join("/");
            const importPath = rel.startsWith(".") ? rel : `./${rel}`;

            let wrapper = `// edgejobber wrapper for ${j.jobId}\n`;
            if (j.isDefault) {
                wrapper += `import Job from '${importPath}';\nexport default Job;\n`;
            } else {
                wrapper += `import { ${j.className} as Job } from '${importPath}';\nexport default Job;\n`;
            }
            await fs.writeFile(wrapperPath, wrapper, "utf8");
            entry[`jobs/${j.jobId}`] = wrapperPath;
        }

    // Determine dependencies to force-bundle (avoid externalizing node_modules)
    const pkgRaw = await fs.readFile(path.join(ROOT, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw);
    const noExternalDeps: (string | RegExp)[] = Object.keys(pkg.dependencies || {});

    await tsupBuild({
        entry,
        outDir: "dist",
        format: ["esm"],
        platform: "node",
        target: NODE_TARGET,
        splitting: false,          // ensure fully self-contained bundles per job
        treeshake: true,
        minify: false,
        sourcemap: false,
        clean: true,
        noExternal: noExternalDeps, // bundle listed dependencies into each job
        external: [
            "node:*",
            "fs", "path", "crypto", "os", "util", "stream", "events",
            "http", "https", "url", "zlib", "tty", "dns", "net", "tls"
        ]
    });

    for (const j of jobs) {
        console.log(`Bundled job ${j.jobId} -> dist/jobs/${j.jobId}.js`);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});