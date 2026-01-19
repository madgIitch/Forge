# Forge Auto-fix - Next Steps

## 🎯 Estado actual (Sprint 4)

### ✅ Lo que funciona
1. **Formato de diff**: Modelo genera diffs sintácticamente válidos
2. **Detección de prose**: Ya no genera blog posts
3. **Validación de no-op**: Detecta diffs inútiles
4. **Sistema de retry**: Reintenta con feedback

### ❌ Limitación encontrada
**Qwen2.5-Coder 7B no tiene suficiente razonamiento** para problemas complejos de React Hooks:
- Ignora instrucciones "CRITICAL" en el prompt
- Elige solución simple (agregar deps) en lugar de la correcta (useCallback)
- No diferencia entre "quick fix" y "correct fix"

## 🚀 Plan de acción

### **Opción A: Cambiar a modelo más capaz (RECOMENDADO)**

#### 1. Deepseek-Coder 6.7B
```bash
ollama pull deepseek-coder:6.7b-instruct
```

**Pros:**
- Mejor adherencia a instrucciones
- Mejor en problemas de React/TypeScript
- Similar tamaño a Qwen 7B

**Test:**
```bash
cd c:\Users\peorr\Desktop\Tonal-Field
set OLLAMA_MODEL=deepseek-coder:6.7b-instruct
node c:\Users\peorr\Desktop\Forge\scripts\run_task.js --task lint --auto --auto-verbose
```

#### 2. Qwen2.5-Coder 14B
```bash
ollama pull qwen2.5-coder:14b-instruct
```

**Pros:**
- Mejor razonamiento
- Mismo family que el 7B

**Cons:**
- Más lento en tu hardware (4GB VRAM)
- Mayor latencia

#### 3. CodeLlama 13B
```bash
ollama pull codellama:13b-instruct
```

**Pros:**
- Excelente en código
- Buena adherencia a instrucciones

---

### **Opción B: Simplificar el problema para el modelo**

En lugar de pedirle que genere todo el fix, podemos:

1. **Detectar patrón específico** y generar el diff nosotros
2. **Dar más contexto**: Incluir función `loadProfile` completa en el prompt
3. **Split en 2 pasos**:
   - Paso 1: Agregar import useCallback
   - Paso 2: Wrap función

#### Implementación

```javascript
// run_task.js - Detector de patrón React Hook
function detectReactHookPattern(fileContent, errorLine) {
  // Si el error es "missing dependency: function"
  // Y la función está definida dentro del componente
  // Generar diff directamente sin llamar al modelo

  const functionPattern = /const (\w+) = (async )?\([^)]*\) => \{/;
  // ... generar diff con useCallback
}
```

---

### **Opción C: Post-validación con re-lint**

Aplicar el patch y verificar si el error desapareció:

```javascript
function applyAndValidate(root, patchFile, originalError) {
  // 1. Aplicar patch
  applyPatch(root, patchFile);

  // 2. Re-ejecutar lint
  const result = runCommand('npm run lint', root);

  // 3. Verificar si el error sigue
  if (result.includes(originalError)) {
    // Revertir y reintentar
    git revert;
    return { ok: false, reason: 'Fix did not resolve the error' };
  }

  return { ok: true };
}
```

---

## 📊 Recomendación

**Path forward más pragmático:**

1. **Probar Deepseek-Coder 6.7B** (5 min para pull + test)
   - Si funciona: ✅ problema resuelto
   - Si falla: continuar

2. **Implementar Opción B** (detector de patrones) (30-60 min)
   - Para errores comunes de React Hooks
   - Genera diff sin modelo
   - Fallback al modelo para otros casos

3. **Implementar Opción C** (post-validación) (15-30 min)
   - Catch-all para cualquier fix incorrecto
   - Re-lint después de aplicar
   - Auto-revert si persiste error

---

## 🎓 Lecciones aprendidas

### Lo que funcionó:
- System prompt estricto + few-shot examples
- Validación temprana de formato
- Parámetros restrictivos (temp 0.05)
- Sistema de retry con feedback

### Lo que no funcionó:
- Modelos 7B tienen límites de razonamiento
- Instrucciones "CRITICAL" no son suficientes
- Ejemplos claros no garantizan adherencia

### Insight clave:
**Para auto-fix confiable necesitas:**
- Modelo 10B+ **O**
- Pattern matching + generación determinística **O**
- Post-validación agresiva

---

## 🔨 Próximo comando a ejecutar

```bash
# Test con Deepseek-Coder
ollama pull deepseek-coder:6.7b-instruct
cd c:\Users\peorr\Desktop\Tonal-Field
set OLLAMA_MODEL=deepseek-coder:6.7b-instruct
node c:\Users\peorr\Desktop\Forge\scripts\run_task.js --task lint --auto --auto-verbose
```

Si Deepseek funciona, Sprint 4 está ✅ completo.
Si no, implementar Opción B (pattern detector).
