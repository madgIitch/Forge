# Planificación de Agente de Código Local (Estilo Claude Code)

**Hardware Target:** RTX 3050 Laptop (Probablemente 4GB VRAM), Ryzen 7 4800H, 16 GB RAM.
**Stack Asumido:** Node.js / TypeScript.

---

## 1. Modelo Exacto Recomendado

Tu limitación real es la VRAM. Se recomiendan dos perfiles de uso:

### Perfil A: Principal Diario (Rápido y Fiable)
*   **Modelo:** `Qwen2.5-Coder 7B Instruct (GGUF)`
*   **Cuantización:** `Q4_K_M`
*   **Motivo:** Muy buen rendimiento en programación, coste razonable, encaja bien en tu VRAM con offload parcial.
*   **Uso:** Agente diario, edición multi-archivo, diffs, debugging.
*   **Contexto sugerido:** 8k (bajar a 4k si hay ralentización).

### Perfil B: Modo Calidad (Más lento)
*   **Modelo:** `Qwen2.5-Coder 14B Instruct (GGUF)`
*   **Cuantización:** `Q4_K_M`
*   **Motivo:** Mejora clara en planificación/refactor, pero mayor presión de RAM/VRAM.
*   **Uso:** Tareas de refactor más grandes, cambios complejos, arquitectura.
*   **Contexto sugerido:** 4k–8k (empezar en 4k).
*   > **Nota:** Con 4 GB VRAM, el modelo 14B funcionará mayormente con offload a RAM del sistema, aumentando la latencia.

---

## 2. Configuración GPU (Runtime)

### Opción 1: Ollama (Simplicidad)
Instalar y usar. Si no usa la GPU automáticamente, revisar drivers.
*   **Temperature:** 0.1–0.2 (reduce alucinación)
*   **Top_p:** 0.9
*   **Repeat Penalty:** 1.1
*   **Num Context:** 4096–8192

### Opción 2: llama.cpp (Control Fino - Recomendado)
Permite ajustar capas exactas para no saturar la VRAM de la 3050.

**Configuración Objetivo (RTX 3050 4GB):**
*   **Cuantización:** `Q4_K_M`
*   **GPU Layers (`-ngl`):** 20–35 (ajustar hasta rozar el límite de VRAM).
*   **Contexto (`-c`):** Empezar en 4096.
*   **Threads (`-t`):** 12–16 (aprovechando el Ryzen 7).

**Ejemplo de ejecución (Windows):**
```bash
llama-cli -m qwen2.5-coder-7b-instruct-q4_k_m.gguf ^
  -ngl 30 ^
  -c 4096 ^
  -t 12 ^
  --temp 0.15 ^
  --top-p 0.9 ^
  --repeat-penalty 1.1
