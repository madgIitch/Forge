A continuación tienes una planificación por sprints (orientada a un "Claude Code local" acotado pero realmente usable) y, además, un modelo concreto con una configuración razonable para tu **RTX 3050 Laptop (probablemente 4 GB VRAM), Ryzen 7 4800H y 16 GB RAM**.





---





## Modelo exacto recomendado (para tu hardware)





Tu limitación real es la VRAM. Por eso te recomiendo **dos perfiles**: uno "rápido y fiable" y otro "más capaz" para cuando necesites más calidad.





### Perfil A (recomendado como modelo principal diario)





**Qwen2.5-Coder 7B Instruct (GGUF) - cuantizado Q4_K_M**





* Motivo: muy buen rendimiento en programación, coste razonable, encaja bien en tu VRAM con offload parcial.


* Uso: agente diario, edición multi-archivo, diffs, debugging.





**Contexto sugerido:** 8k (si ves que se ralentiza demasiado, baja a 4k).





### Perfil B (modo calidad, más lento)





**Qwen2.5-Coder 14B Instruct (GGUF) - cuantizado Q4_K_M**





* Motivo: mejora clara en planificación/refactor, pero será más lento y con más presión de RAM/VRAM.


* Uso: tareas de refactor más grandes, cambios complejos, arquitectura.





**Contexto sugerido:** 4k-8k (empieza 4k).





> Nota práctica: con 4 GB VRAM, 14B funcionará, pero normalmente con más offload a RAM (latencia mayor). Si tu 3050 fuera 6 GB, este perfil se vuelve mucho más cómodo.





---





## Configuración GPU (Ollama y/o llama.cpp)





### Opción 1: Ollama (lo más simple)





Instala Ollama y usa un modelo "coder" ya empaquetado (si existe el tag), o importa un GGUF.





**Parámetros recomendados (agente):**





* `temperature`: 0.1-0.2 (reduce creatividad y alucinación)


* `top_p`: 0.9


* `repeat_penalty`: 1.1


* `num_ctx`: 4096-8192 (según fluidez)


* `num_predict`: 512-2048 (según tarea)





**Aceleración GPU en Ollama (Windows):**





* Ollama suele usar GPU cuando puede, pero el control fino de "capas en GPU" es más típico en llama.cpp.


* Si notas que no usa GPU, normalmente es por driver/CUDA o por cómo está compilado el runtime. En ese caso, llama.cpp te da control total.





### Opción 2: llama.cpp (control fino de VRAM: recomendado para exprimir la 3050)





Con GGUF + offload parcial.





**Config objetivo para RTX 3050 4GB:**





* Cuantización: **Q4_K_M**


* GPU layers: ajusta hasta rozar VRAM sin petar (típicamente **20-35 layers** en 7B, depende del modelo exacto y del contexto)


* Contexto: empieza en **4096**; sube a 8192 si te va fluido.





Ejemplo (orientativo) de ejecución:





```bash


llama-cli -m qwen2.5-coder-7b-instruct-q4_k_m.gguf ^


  -ngl 30 ^


  -c 4096 ^


  -t 12 ^


  --temp 0.15 ^


  --top-p 0.9 ^


  --repeat-penalty 1.1


```





**Qué tocar si va lento o revienta memoria:**





* Baja `-ngl` (menos capas en GPU) si te quedas sin VRAM.


* Baja `-c` (contexto) si consumes demasiada RAM o cae rendimiento.


* Sube `-t` (threads) hasta ~12-16 (tu CPU lo aguanta) para mejorar throughput en CPU.





**Cómo encontrar el "ngl" óptimo sin adivinar:**





* Arranca con `-ngl 20` y sube de 5 en 5 hasta que:





  * o bien falla por memoria,


  * o bien ves que ya no mejora velocidad.


* Te quedas con el máximo estable.





---





# Planificación por sprints (orientado a un agente usable)





Voy a asumir **stack Node/TypeScript** (por tu perfil full-stack) y CLI primero (más rápido de entregar), con opción de integrar VS Code después.





## Sprint 0 - Setup técnico y baseline (1-2 días)





**Objetivo:** tener el modelo funcionando local con GPU offload + medir rendimiento.





**Tareas**





* Instalar runtime (Ollama o llama.cpp).


* Descargar GGUF del modelo principal:





  * Qwen2.5-Coder 7B Instruct Q4_K_M (GGUF).


* Script de benchmark simple:





  * Latencia primer token


  * tokens/s


  * estabilidad con 4k de contexto


* Plantilla de prompts "agente" (system + reglas).

**Resultados benchmark (Ollama, Qwen2.5-Coder 7B Instruct)**

* Baseline `num_ctx 4096`, `num_predict 256`: first token ~1.0 s, throughput ~5.6 tok/s, 4k estable.
* `num_ctx 8192`: first token 13-25 s; no recomendado para uso diario.
* `num_predict 128` y `512`: sin mejora clara; mantener 256 y subir a 512 solo cuando haga falta.





**DoD**





* Generas respuestas estables.


* Puedes mantener 4k contexto sin errores.


* Tienes una configuración de `ngl` estable (si llama.cpp).





---





## Sprint 1 - CLI básica: lectura del repo + chat con contexto (3-5 días)





**Objetivo:** "chat con repo" decente.





**Tareas**





* CLI que acepta:





  * ruta repo


  * pregunta / instrucción


* Herramientas:





  * listar árbol (limitado por profundidad)


  * leer archivos


  * buscar con ripgrep


* Construcción de contexto:





  * archivos clave: README, package.json, tsconfig, etc.


  * snippets relevantes por grep


* Política:





  * si falta info, el agente debe pedir que se busque X archivo o ejecutar grep.





**DoD**





* Preguntas tipo "¿Dónde se calcula X" y te lleva a archivos correctos.


* No mete archivos enormes completos; usa snippets.

**Resultados Sprint 1**

* CLI funcionando contra repo real (`Tonal-Field`) con contexto (tree + key files + rg).
* Consulta "¿Dónde se calcula X?": `rg` apuntó a `lib/color/accessibility.ts`, `lib/color/theme.ts`, `lib/color/tonal.ts` y `lib/color/hierarchy.ts`.
* Límite actual: la respuesta puede ser genérica si la pregunta es vaga; conviene preguntar por un cálculo específico.

**Test rápido sugerido**

* "¿Dónde se calcula el contraste WCAG?"





---





## Sprint 2 - Indexación semántica (RAG) para repos medianos (4-6 días)





**Objetivo:** mejorar recuperación sin depender solo de grep.





**Tareas**





* Pipeline de embeddings local para:





  * trocear archivos (chunking)


  * vectorizar


  * guardar índice (Chroma / SQLite + vectores)


* Recuperación híbrida:





  * topK semántico + topK grep


* Heurísticas:





  * priorizar archivos cerca de cambios recientes (git diff / git log opcional)





**DoD**





* Para preguntas difusas ("¿cómo funciona el login") encuentra módulos correctos.


* Recuperación consistente en 2-3 consultas seguidas.





---





## Sprint 3 - Edición real: diffs y aplicación segura (5-7 días)





**Objetivo:** pasar de "te explico" a "te lo cambio".





**Tareas**





* Formato obligatorio de salida:





  * unified diff (parches) o instrucciones estructuradas para editar.


* Motor de aplicación:





  * validar que el diff aplica


  * backup / checkpoint


* Guardrails:





  * no borrar masivo


  * no tocar archivos fuera del repo


  * límite de líneas modificadas por iteración (ej. 300)


* "Review mode":





  * antes de aplicar: resumen de cambios





**DoD**





* Cambios pequeños y medianos se aplican automáticamente sin romper el repo.


* Si el diff no aplica, el agente reintenta con contexto actualizado.





---





## Sprint 4 - Loop de agente con tooling: build/test/lint (5-8 días)





**Objetivo:** comportamiento tipo "Claude Code": cambiar → ejecutar → arreglar.





**Tareas**





* Tool "run" para:





  * tests (jest/vitest/etc.)


  * lint (eslint)


  * build


* Parser de errores:





  * extraer stacktraces, rutas y líneas


  * alimentar al modelo con el mínimo contexto necesario


* Estrategia de iteración:





  * máximo N intentos


  * si se atasca: pedir intervención humana con diagnóstico





**DoD**





* Implementas una tarea y el agente itera hasta pasar tests o declarar bloqueo con evidencia.





---





## Sprint 5 - Calidad de producto: perfiles, memoria de sesión y comandos (4-7 días)





**Objetivo:** que sea cómodo para uso diario.





**Tareas**





* "Sessions" con historial y estado del plan.


* Comandos:





  * `/plan`


  * `/apply`


  * `/test`


  * `/explain`


  * `/reset`


* Perfiles:





  * modo "rápido" (7B)


  * modo "calidad" (14B)


* Cache de contexto:





  * mantener índice y snippets por tarea





**DoD**





* Puedes retomar una tarea sin re-explicar todo.


* Cambiar de modelo no rompe el flujo.





---





## Sprint 6 - Integración VS Code (opcional, 1-2 semanas según pulido)





**Objetivo:** UX tipo asistente dentro del editor.





**Tareas**





* Extensión VS Code:





  * panel chat


  * aplicar diffs en workspace


  * botones "run tests", "open file"


* Seguridad:





  * confirmación explícita para cambios grandes


  * "dry run"


* Telemetría local (solo logs) para depurar.





**DoD**





* Flujo end-to-end desde VS Code sin tocar terminal.





---





# Recomendación pragmática para tu caso





Con tu máquina, la estrategia ganadora es:





* **Modelo principal:** Qwen2.5-Coder 7B Instruct Q4_K_M


* **Runtime:** llama.cpp si quieres exprimir GPU layers; Ollama si priorizas simplicidad.


* **Agente robusto:** basado en *diffs + tests*, no en "generar archivos enteros a ciegas".





---





## Próximo paso (sin más preguntas largas)





Para afinar la config al 100% solo falta un dato: **tu VRAM exacta (4 o 6 GB)**.





Si quieres verlo en 10 segundos:





1. **Administrador de tareas → Rendimiento → GPU**


2. Mira "Memoria de GPU dedicada".





Si me lo pegas, te doy:





* `-ngl` recomendado inicial y rango


* `-c` recomendado


* y el "preset" final para tu agente (rápido / calidad).


