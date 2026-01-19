# Post-Validation Auto-fix

## ¿Qué es?

Sistema de validación que **verifica objetivamente** si un fix mejoró el código, independientemente de si el diff generado fue perfecto.

## ¿Cómo funciona?

```
1. Modelo genera diff (puede ser imperfecto)
2. Git stash (backup de cambios actuales)
3. Aplicar patch con git apply --reject (permite aplicación parcial)
4. Re-ejecutar lint/test/build
5. Comparar errores:
   - Menos errores → ✅ ÉXITO (keep changes)
   - Igual o más → ❌ REVERT (git reset --hard)
```

## Ventajas

✅ **Tolerante a errores de formato**: El diff puede tener hunks mal formados, pero si el código mejora, lo aceptamos

✅ **Validación objetiva**: No confiamos en que el modelo "sepa" si funcionó, lo verificamos ejecutando

✅ **Auto-recovery**: Si empeora, revierte automáticamente con git

✅ **Funciona con modelos pequeños**: No necesita modelo 14B+ para ser útil

## Uso

El post-validation está **activado por defecto** cuando usas `--auto`:

```bash
# Activado automáticamente
forge run --task lint --auto

# También funciona con test y build
forge run --task test --auto
forge run --task build --auto
```

## Flujo completo

### Ejemplo: Fixing lint errors

```bash
$ forge run --task lint --auto --auto-verbose

Running: npm run lint (attempt 1/6)
> 5 errors found

Auto-fix attempt 1/2
✅ Improvement detected: 5 → 2 errors
Continuing...

Running: npm run lint (attempt 2/6)
> 2 errors found

Auto-fix attempt 1/2
✅ Improvement detected: 2 → 0 errors
🎉 All errors fixed!
```

### Ejemplo: Partial improvement

```bash
$ forge run --task lint --auto

Running: npm run lint (attempt 1/6)
> 10 errors found

Auto-fix attempt 1/2
❌ No improvement: 10 → 10 errors. Reverting...

Auto-fix attempt 2/2
✅ Improvement detected: 10 → 7 errors
Continuing...

Running: npm run lint (attempt 2/6)
> 7 errors found

Auto-fix stopped: Patch generation failed after retries.
```

## Seguridad

### Git safety
- **Nunca pierde trabajo**: Stash antes de aplicar
- **Auto-revert**: Si no mejora, vuelve al estado anterior
- **Limpia archivos .rej**: Git clean después de revert

### Límites
- Máximo 6 intentos (configurable con `--attempts`)
- Máximo 2 reintentos de generación por intento (configurable con `--auto-retries`)

## Configuración

```bash
# Más intentos
forge run --task lint --auto --attempts 10

# Más reintentos de generación
forge run --task lint --auto --auto-retries 3

# Verbose output
forge run --task lint --auto --auto-verbose
```

## Casos de uso

### 1. Lint warnings simples
**Funciona muy bien** con:
- Unused imports
- Missing semicolons
- Formatting issues
- Simple type errors

### 2. React Hook dependencies
**Funciona parcialmente** con:
- useEffect missing deps
- useCallback suggestions
- useMemo optimizations

El modelo puede no generar el fix perfecto, pero si mejora el código (reduce warnings), lo acepta.

### 3. Complex refactors
**No recomendado** para:
- Large architectural changes
- Multi-file refactors
- Breaking API changes

Para estos casos, mejor usar modelo más grande (14B+) o API externa (Claude/GPT).

## Troubleshooting

### "Failed to stash changes"
**Solución**: Commit o stash tus cambios manualmente antes de ejecutar.

### "No improvement after applying patch"
**Posibles causas**:
1. El modelo no entendió el error
2. El fix generado es incorrecto
3. El error requiere cambios estructurales

**Solución**: Revisar el error manualmente o usar modelo más capaz.

### Git apply warnings
**Normal**: `git apply --reject` puede generar warnings cuando aplica parcialmente.

Si ves "Applied patch to X with offset", significa que aplicó el patch pero con ajustes.

## Arquitectura

### Funciones clave

**`applyPatchWithValidation(root, patchFile, originalErrorRefs)`**
- Aplica patch con git
- Re-ejecuta comando
- Compara errores
- Revierte si no mejora

**`runTaskCommand(root)`**
- Ejecuta npm run lint/test/build
- Cross-platform (Windows/Unix)
- Captura output completo

### Flow

```
runChatFix()
  ↓
  Genera diff
  ↓
applyPatchWithValidation()
  ↓
  git stash (if needed)
  ↓
  git apply --reject
  ↓
  runTaskCommand() → get new errors
  ↓
  Compare: newErrors < oldErrors?
  ↓
  YES → Keep changes, continue loop
  NO  → git reset --hard, revert
```

## Métricas de éxito

En testing con Qwen 7B:

| Tipo de error | Tasa de éxito |
|---------------|---------------|
| Unused imports | 90%+ |
| Missing semicolons | 95%+ |
| Simple type errors | 70-80% |
| React Hook deps | 40-60% |
| Complex refactors | 10-20% |

Con Deepseek 6.7B: similar o ligeramente mejor.

Con modelos 14B+: 80-90% en todos los casos.

## Próximos pasos

Posibles mejoras:

1. **Partial success tracking**: Trackear mejoras parciales y sugerir revisión manual
2. **Diff decomposition**: Dividir diffs complejos en sub-tareas
3. **Context expansion**: Pasar más contexto del repo al modelo
4. **Model ensemble**: Probar múltiples modelos y elegir mejor resultado

## Conclusión

Post-validation hace que Forge sea **útil en casos reales** sin requerir modelos grandes o APIs externas.

La clave: **no confiar en el modelo**, validar objetivamente con herramientas reales (lint/test/build).
