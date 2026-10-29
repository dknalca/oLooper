// Advisory inventory, not a quality score. Uses the project's TypeScript parser.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

function filesUnder(directory, extension) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(file, extension);
    return entry.isFile() && extension.test(entry.name) ? [file] : [];
  }).sort();
}

const frontend = filesUnder("src", /\.(ts|tsx)$/).filter((file) => !/\.(test|spec|d)\.(ts|tsx)$/.test(file));
const rust = filesUnder("src-tauri/src", /\.rs$/);
const fileSizes = (files) => files.map((file) => {
  const text = fs.readFileSync(file, "utf8");
  return { file, lines: text ? text.split(/\r?\n/).length - Number(text.endsWith("\n")) : 0 };
}).sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));

function functionName(node) {
  if (node.name) return node.name.getText();
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) return parent.name.getText();
  return "<anonymous>";
}

function isFunction(node) {
  return ts.isFunctionLike(node) && node.body !== undefined;
}

function isDecision(node) {
  if (ts.isIfStatement(node) || ts.isConditionalExpression(node) || ts.isForStatement(node)
      || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node)
      || ts.isDoStatement(node) || ts.isCaseClause(node) || ts.isCatchClause(node)) return true;
  return ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind);
}

const functions = [];
for (const file of frontend) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if (source.parseDiagnostics.length) throw new Error(`Cannot parse ${file}: ${source.parseDiagnostics.length} error(s)`);
  function visit(node) {
    if (isFunction(node)) {
      let decisions = 0;
      function count(part) {
        if (part !== node && isFunction(part)) return;
        if (isDecision(part)) decisions++;
        ts.forEachChild(part, count);
      }
      count(node.body);
      const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const end = source.getLineAndCharacterOfPosition(node.end).line + 1;
      functions.push({ file, line: start, name: functionName(node), lines: end - start + 1, decisions: decisions + 1 });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
functions.sort((a, b) => b.decisions - a.decisions || b.lines - a.lines || a.file.localeCompare(b.file));
const result = {
  typescriptVersion: ts.version,
  scope: "src production .ts/.tsx excluding .test/.spec/.d files; Rust file sizes include inline tests",
  frontendFiles: frontend.length,
  rustFiles: rust.length,
  frontendFunctions: functions.length,
  frontendFunctionsOver15Decisions: functions.filter((fn) => fn.decisions > 15).length,
  largestFrontendFiles: fileSizes(frontend).slice(0, 10),
  largestRustFiles: fileSizes(rust).slice(0, 10),
  frontendDecisionHotspots: functions.slice(0, 20),
};
console.log(JSON.stringify(result, null, 2));
