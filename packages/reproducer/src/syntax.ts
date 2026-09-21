import ts from "typescript";

/** Validate generated TypeScript syntax without shelling out to tsc. */
export function validateGeneratedSyntax(code: string): {
  ok: boolean;
  errors: string[];
} {
  const file = ts.createSourceFile(
    "repro.spec.ts",
    code,
    ts.ScriptTarget.ES2022,
    true,
  );
  const errors: string[] = [];
  const checkNode = (node: ts.Node): void => {
    // Parse diagnostics surface as unknown nodes only in edge cases;
    // primary signal: transpile + syntactic diagnostics.
    ts.forEachChild(node, checkNode);
  };
  checkNode(file);
  const transpile = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
    reportDiagnostics: true,
  });
  for (const d of transpile.diagnostics ?? []) {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
    errors.push(msg.slice(0, 300));
  }
  return { ok: errors.length === 0, errors: errors.slice(0, 10) };
}
