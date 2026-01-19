# Test Plan - Auto-fix Improvements

## Mejoras implementadas (Sprint 4)

### 1. **System Prompt más agresivo** ✅
- Reemplazado prompt genérico por instrucciones ultra-específicas
- Agregado ejemplo de formato válido (few-shot)
- Reglas numeradas y explícitas sobre qué NO hacer

### 2. **Validación temprana** ✅
- Detección en los primeros 50 caracteres
- Abort inmediato si detecta prose patterns: `title:`, `In this`, `Here is`, etc.
- Evita desperdiciar tokens en respuestas claramente inválidas

### 3. **Parámetros más restrictivos** ✅
- `temperature`: 0.15 → 0.05 (modo diff)
- `top_p`: 0.9 → 0.85
- `stop`: agregado para detener en patrones comunes de prosa
- `repeat_penalty`: 1.1 → 1.05

### 4. **Ejemplo específico de React Hooks** ✅
- Detecta errores `useEffect/useCallback/useMemo`
- Agrega ejemplo de fix con `useCallback` al prompt
- Ayuda al modelo a entender el patrón correcto

### 5. **Validación de no-op diffs** ✅
- Detecta diffs que no cambian nada realmente
- Rechaza y reintenta con nota de feedback
- Evita aplicar patches inútiles

## Test commands

```bash
# Test 1: Ejecutar auto-fix en el proyecto Tonal-Field
cd c:\Users\peorr\Desktop\Tonal-Field
node c:\Users\peorr\Desktop\Forge\scripts\run_task.js --task lint --auto --auto-verbose --auto-dump-prompt

# Test 2: Verificar que genera diff válido (no prose)
# Revisar: .forge\auto.last.response.txt debe empezar con "--- a/"

# Test 3: Aplicar el patch y verificar
git diff app/community/page.tsx
```

## Criterios de éxito

✅ La respuesta empieza con `--- a/` (no con prose)
✅ El diff se valida correctamente
✅ El patch se aplica sin errores
✅ Los errores de lint se reducen o desaparecen

## Debugging si falla

1. **Si sigue generando prose:**
   - Revisar `.forge/auto.last.prompt.txt`
   - Verificar que `--include-files` esté presente en la llamada
   - Intentar con `--predict 128` (forzar respuesta corta)

2. **Si genera diff pero inválido:**
   - Revisar `.forge/auto.last.cleaned.diff`
   - Puede ser problema de paths (a/ vs b/)
   - Verificar hunk headers (@@)

3. **Si el modelo no obedece:**
   - Considera cambiar a modelo más pequeño y obediente (3B)
   - O probar con Deepseek-Coder (mejor seguimiento de instrucciones)

## Next steps (si funciona)

- [ ] Agregar retry con temperatura aún más baja (0.01)
- [ ] Implementar "steering" con prefill del inicio del diff
- [ ] Agregar stop sequences más agresivas
- [ ] Considerar formato alternativo (instrucciones de edit en lugar de diff)
