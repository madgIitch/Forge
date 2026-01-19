/**
 * Deterministic React Hook fixer
 * Handles common patterns that small models struggle with
 */

const fs = require('fs');
const path = require('path');

/**
 * Detects if this is a "function used in useEffect" error
 */
function isUseEffectFunctionDependencyError(errorText) {
  return /React Hook useEffect has missing dependencies.*function/i.test(errorText) ||
         /missing.*dependency.*function/i.test(errorText);
}

/**
 * Extract function names mentioned in the error
 * E.g., "missing dependencies: 'loadProfile' and 'supabase.auth'"
 * Returns: ['loadProfile', 'supabase.auth']
 */
function extractMissingDependencies(errorText) {
  const match = errorText.match(/missing dependencies?:\s*(.+?)(?:\.|$)/i);
  if (!match) return [];

  const depsStr = match[1];
  // Extract quoted names: 'name1' and 'name2' or "name1", "name2"
  const deps = [...depsStr.matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]);
  return deps;
}

/**
 * Find function definition in file content
 * Returns: { startLine, endLine, functionName, isAsync, params }
 */
function findFunctionDefinition(fileContent, functionName) {
  const lines = fileContent.split('\n');

  // Pattern: const functionName = async? (params) => {
  const pattern = new RegExp(
    `^\\s*const\\s+${functionName}\\s*=\\s*(async\\s+)?\\(([^)]*)\\)\\s*=>\\s*\\{`,
    'gm'
  );

  const match = pattern.exec(fileContent);
  if (!match) return null;

  const startPos = match.index;
  const startLine = fileContent.substring(0, startPos).split('\n').length - 1;

  // Find closing brace (simple matching)
  let braceCount = 1;
  let pos = match.index + match[0].length;
  while (pos < fileContent.length && braceCount > 0) {
    if (fileContent[pos] === '{') braceCount++;
    if (fileContent[pos] === '}') braceCount--;
    pos++;
  }

  const endPos = pos;
  const endLine = fileContent.substring(0, endPos).split('\n').length - 1;

  return {
    startLine,
    endLine,
    functionName,
    isAsync: !!match[1],
    params: match[2].trim()
  };
}

/**
 * Find useEffect that uses the function
 */
function findUseEffectWithFunction(fileContent, functionName) {
  const lines = fileContent.split('\n');

  // Find useEffect blocks
  const useEffectPattern = /useEffect\s*\(\s*\(\s*\)\s*=>\s*\{/g;
  let match;
  const useEffects = [];

  while ((match = useEffectPattern.exec(fileContent)) !== null) {
    const startPos = match.index;
    const startLine = fileContent.substring(0, startPos).split('\n').length - 1;

    // Find the corresponding closing brace and dependency array
    let braceCount = 1;
    let pos = match.index + match[0].length;
    while (pos < fileContent.length && braceCount > 0) {
      if (fileContent[pos] === '{') braceCount++;
      if (fileContent[pos] === '}') braceCount--;
      pos++;
    }

    // Skip whitespace and find dependency array
    while (pos < fileContent.length && /[\s,]/.test(fileContent[pos])) pos++;

    // Check if function is called inside this useEffect
    const useEffectBody = fileContent.substring(match.index, pos);
    if (useEffectBody.includes(functionName)) {
      // Find dependency array line
      const afterClosing = fileContent.substring(pos);
      const depsMatch = afterClosing.match(/^\s*,\s*\[([^\]]*)\]/);

      if (depsMatch) {
        const depsLine = fileContent.substring(0, pos).split('\n').length - 1 +
                        depsMatch[0].substring(0, depsMatch.index + depsMatch[0].indexOf('[')).split('\n').length;

        useEffects.push({
          startLine,
          depsLine,
          currentDeps: depsMatch[1].trim().split(',').map(d => d.trim()).filter(Boolean)
        });
      }
    }
  }

  return useEffects[0]; // Return first match
}

/**
 * Generate unified diff to wrap function in useCallback and update useEffect deps
 */
function generateReactHookFix(filePath, errorLine, errorText) {
  const fileContent = fs.readFileSync(filePath, 'utf8');
  const lines = fileContent.split('\n');

  // Extract missing dependencies
  const missingDeps = extractMissingDependencies(errorText);
  if (missingDeps.length === 0) return null;

  // Filter to only function names (ignore supabase.auth etc)
  const functionDeps = missingDeps.filter(dep => !dep.includes('.'));
  if (functionDeps.length === 0) return null;

  const functionName = functionDeps[0];

  // Find function definition
  const funcDef = findFunctionDefinition(fileContent, functionName);
  if (!funcDef) return null;

  // Find useEffect that uses it
  const useEffectInfo = findUseEffectWithFunction(fileContent, functionName);
  if (!useEffectInfo) return null;

  // Build diff
  const relPath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');

  const diffParts = [];
  diffParts.push(`--- a/${relPath}`);
  diffParts.push(`+++ b/${relPath}`);

  // Part 1: Add useCallback to imports
  const importLine = lines.findIndex(line => line.includes('from "react"') || line.includes("from 'react'"));
  if (importLine >= 0) {
    const oldImport = lines[importLine];
    if (!oldImport.includes('useCallback')) {
      const newImport = oldImport.replace(
        /from\s+["']react["']/,
        match => {
          const beforeMatch = oldImport.substring(0, oldImport.indexOf(match));
          if (beforeMatch.includes('useState')) {
            return oldImport.substring(0, oldImport.lastIndexOf('}')).trimEnd() + ', useCallback }' + match;
          }
          return match;
        }
      );

      if (newImport !== oldImport) {
        diffParts.push(`@@ -${importLine + 1},1 +${importLine + 1},1 @@`);
        diffParts.push(`-${oldImport}`);
        diffParts.push(`+${newImport.replace(/\}\s*,\s*useCallback/, ', useCallback')}`);
      }
    }
  }

  // Part 2: Wrap function in useCallback
  const funcStartLine = funcDef.startLine;
  const oldFuncDecl = lines[funcStartLine];
  const indent = oldFuncDecl.match(/^\s*/)[0];
  const newFuncDecl = oldFuncDecl.replace(
    /const\s+(\w+)\s*=\s*(async\s+)?\(/,
    `const $1 = useCallback($2(`
  );

  // Find function closing and add deps
  const funcEndLine = funcDef.endLine;
  const oldFuncEnd = lines[funcEndLine];
  const newFuncEnd = oldFuncEnd.replace(/};?\s*$/, '}, []); // TODO: add dependencies');

  diffParts.push(`@@ -${funcStartLine + 1},${funcEndLine - funcStartLine + 1} +${funcStartLine + 1},${funcEndLine - funcStartLine + 1} @@`);
  diffParts.push(`-${oldFuncDecl}`);
  diffParts.push(`+${newFuncDecl}`);
  diffParts.push(` ${lines[funcStartLine + 1]}`); // context line
  diffParts.push(` ...`); // indicate more content
  diffParts.push(`-${oldFuncEnd}`);
  diffParts.push(`+${newFuncEnd}`);

  // Part 3: Update useEffect deps
  const depsLineIdx = useEffectInfo.depsLine;
  const oldDeps = lines[depsLineIdx];
  const newDeps = oldDeps.replace(/\[\s*\]/, `[${functionName}]`);

  if (newDeps !== oldDeps) {
    diffParts.push(`@@ -${depsLineIdx + 1},1 +${depsLineIdx + 1},1 @@`);
    diffParts.push(`-${oldDeps}`);
    diffParts.push(`+${newDeps}`);
  }

  return diffParts.join('\n');
}

module.exports = {
  isUseEffectFunctionDependencyError,
  generateReactHookFix
};
