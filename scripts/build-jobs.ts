import path from "node:path";
import fs from "node:fs/promises";
import fg from "fast-glob";
import { parse } from "@babel/parser";
import traverseImport from "@babel/traverse";
import { build as tsupBuild } from "tsup";

const ROOT = process.cwd();
const NODE_TARGET = process.env.NODE_TARGET || "node20";
const DECORATOR_NAME = process.env.JOB_DECORATOR || "job";

type FoundJob = { jobId: string; className: string; isDefault: boolean };

function findDecoratedJobs(code: string): FoundJob[] {
    const ast = parse(code, {
        sourceType: "module",
        plugins: ["typescript", "decorators-legacy"],
    });

    const traverse = (traverseImport as any).default || (traverseImport as any);
    const out: FoundJob[] = [];

    traverse(ast as any, {
        ClassDeclaration(p: any) {
            const node = p.node as any;
            if (!node.decorators || node.decorators.length === 0) return;

            let hasJob = false;
            let jobId: string | null = null;

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
                    throw new Error(`@${DECORATOR_NAME} class must have a name or @${DECORATOR_NAME}("id").`);
                }
                jobId = node.id.name;
            }

            const isDefault =
                p.parentPath.node.type === "ExportDefaultDeclaration" &&
                p.parentPath.node.declaration === node;

            out.push({ jobId, className: node.id!.name, isDefault });
        },
    });

    return out;
}

async function main() {
    const files = await fg("src/**/*.job.ts", { absolute: true });
    if (!files.length) {
        console.error("No files matched src/**/*.job.ts");
        process.exit(1);
    }

    const jobs: Array<{ file: string } & FoundJob> = [];
    for (const file of files) {
        const code = await fs.readFile(file, "utf8");
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

    // Create per-job wrapper entry files to allow tree-shaking per job
    const entryDir = path.join(ROOT, ".edgejobber", "entries");
    await fs.mkdir(entryDir, { recursive: true });

    const entry: Record<string, string> = {};
    for (const j of jobs) {
        const outPath = path.join(entryDir, `${j.jobId}.entry.ts`);
        const code = await fs.readFile(j.file, "utf8");

        // Parse the source file to find imports and the specific class declaration
        const ast = parse(code, {
            sourceType: "module",
            plugins: ["typescript", "decorators-legacy"],
        }) as any;

        const imports: Array<{
            source: string;
            defaultName?: string;
            namespaceName?: string;
            named: Array<{ imported: string; local: string }>;
            start: number;
            end: number;
        }> = [];
        let classStart = -1;
        let classEnd = -1;
        let isDefault = j.isDefault;

        const t = (traverseImport as any).default || (traverseImport as any);
        t(ast, {
            ImportDeclaration(p: any) {
                const node = p.node;
                const rec = {
                    source: node.source.value as string,
                    defaultName: undefined as string | undefined,
                    namespaceName: undefined as string | undefined,
                    named: [] as Array<{ imported: string; local: string }>,
                    start: node.start as number,
                    end: node.end as number,
                };
                for (const s of node.specifiers) {
                    if (s.type === "ImportDefaultSpecifier") rec.defaultName = s.local.name;
                    else if (s.type === "ImportNamespaceSpecifier") rec.namespaceName = s.local.name;
                    else if (s.type === "ImportSpecifier")
                        rec.named.push({ imported: s.imported.name, local: s.local.name });
                }
                imports.push(rec);
            },
            ClassDeclaration(p: any) {
                const node = p.node;
                if (node.id && node.id.name === j.className) {
                    classStart = node.start as number;
                    classEnd = node.end as number;
                    // If this class is default-exported, prefer to keep default
                    isDefault =
                        p.parentPath.node.type === "ExportDefaultDeclaration" &&
                            p.parentPath.node.declaration === node
                            ? true
                            : false;
                }
            },
        });

        if (classStart < 0 || classEnd < 0) {
            throw new Error(`Unable to locate class ${j.className} in ${j.file}`);
        }

        const classCode = code.slice(classStart, classEnd);
        const neededNames = new Set<string>();
        // Heuristic: determine which imported identifiers appear in the class code string
        const hasWord = (name: string) => new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`).test(classCode);
        for (const imp of imports) {
            if (imp.defaultName && hasWord(imp.defaultName)) neededNames.add(imp.defaultName);
            if (imp.namespaceName && hasWord(imp.namespaceName)) neededNames.add(imp.namespaceName);
            for (const n of imp.named) {
                if (hasWord(n.local)) neededNames.add(n.local);
            }
        }

        // Rebuild minimal import lines containing only used specifiers
        const importLines: string[] = [];
        for (const imp of imports) {
            const parts: string[] = [];
            if (imp.defaultName && neededNames.has(imp.defaultName)) parts.push(imp.defaultName);
            if (imp.namespaceName && neededNames.has(imp.namespaceName)) parts.push(`* as ${imp.namespaceName}`);
            const namedSpecs = imp.named.filter((n) => neededNames.has(n.local));
            const namedStr = namedSpecs
                .map((n) => (n.imported === n.local ? n.local : `${n.imported} as ${n.local}`))
                .join(", ");
            if (namedStr) parts.push(`{ ${namedStr} }`);

            // Rewrite relative import sources to be relative to the wrapper file
            let src = imp.source;
            if (src.startsWith('.')) {
                const abs = path.resolve(path.dirname(j.file), src);
                let rel = path.relative(path.dirname(outPath), abs).split(path.sep).join('/');
                if (!rel.startsWith('.')) rel = './' + rel;
                src = rel;
            }

            if (parts.length) importLines.push(`import ${parts.join(", ")} from '${src}';`);
        }

        let moduleText = `// generated by edgejobber for ${j.jobId}\n`;
        moduleText += importLines.join("\n") + (importLines.length ? "\n\n" : "");
        moduleText += classCode + "\n";
        if (!isDefault) moduleText += `\nexport default ${j.className};\n`;

        await fs.writeFile(outPath, moduleText, "utf8");
        entry[`jobs/${j.jobId}`] = outPath;
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
        splitting: false, // ensure fully self-contained bundles per job
        treeshake: true,
        minify: false,
        sourcemap: false,
        clean: true,
        noExternal: noExternalDeps, // bundle listed dependencies into each job
        external: [
            "node:*",
            "fs",
            "path",
            "crypto",
            "os",
            "util",
            "stream",
            "events",
            "http",
            "https",
            "url",
            "zlib",
            "tty",
            "dns",
            "net",
            "tls",
        ],
    });

    for (const j of jobs) {
        console.log(`Bundled job ${j.jobId} -> dist/jobs/${j.jobId}.js`);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});