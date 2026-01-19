# Forge (forge-cli)

CLI para un agente local que entiende repos, genera diffs y puede iterar con lint/test/build usando Ollama.

## Que hace
- Chat con contexto del repo (tree, key files, rg snippets).
- Indexacion RAG local (embeddings) para repos medianos.
- Generacion de diffs unificados con validaciones basicas.
- Loop de auto-fix: ejecuta lint/test/build, parsea errores y reintenta.

## Requisitos
- Node.js (para ejecutar los scripts)
- Git (para aplicar patches de forma segura)
- Ollama corriendo en `http://localhost:11434`

## Instalacion
```bash
npm install
node bin/forge.js help
```

Opcional: usarlo como comando global
```bash
npm link
forge help
```

## Uso rapido
```bash
# Chat con contexto del repo
forge chat --repo . --question "Donde se calcula X?"

# Construir indice RAG
forge index --repo .

# Aplicar diff con guardrails
forge apply --repo . --diff change.diff

# Ejecutar lint y (opcional) auto-fix
forge run --repo . --task lint --auto --auto-warn --attempts 2
```

## Comandos principales
`forge` envuelve scripts en `scripts/`:
- `forge chat` -> `scripts/forge_cli.js`
- `forge index` -> `scripts/rag_index.js`
- `forge apply` -> `scripts/apply_diff.js`
- `forge run` -> `scripts/run_task.js`
- `forge config` -> defaults en `.forge/config.json`

## Variables de entorno
- `OLLAMA_URL` (default `http://localhost:11434`)
- `OLLAMA_MODEL` (default `qwen2.5-coder:7b-instruct`)
- `OLLAMA_EMBED_MODEL` (default `nomic-embed-text`)

## Configuracion
Defaults persistidos en `.forge/config.json`:
```bash
forge config --set repo=C:\path\to\repo
forge config --set model=qwen2.5-coder:7b-instruct
forge config --set ctx=4096
forge config --set predict=256
```

## Flujo de auto-fix (lint/test/build)
`forge run` puede ejecutar un comando y auto-generar un diff para los errores parseados.
Incluye:
- Parseo de rutas/lineas desde logs.
- Prompt estricto para diff unificado.
- Validaciones basicas (formato, no-op, archivos permitidos).
- Post-validacion: re-ejecuta el comando y revierte si no mejora.

Ejemplo:
```bash
forge run --repo . --task lint --auto --auto-warn --attempts 2
```

Flags utiles:
- `--auto-max-files N` limita los archivos a corregir por intento.
- `--auto-verbose` guarda logs y prompts en `.forge/`.
- `--attempts N` maximo de iteraciones.

## RAG (indexacion local)
```bash
forge index --repo .
forge chat --repo . --question "Como funciona X?" --rag
```
El indice se guarda en `.forge/rag_index.json`.

## Estructura
- `bin/forge.js` CLI principal
- `scripts/forge_cli.js` chat con contexto + diffs
- `scripts/run_task.js` loop lint/test/build
- `scripts/apply_diff.js` aplicar diff con backup
- `scripts/rag_index.js` indexacion RAG
- `prompts/agent.md` system prompt

## Notas
- No hay dependencias externas en `package.json`.
- Para mejores resultados de auto-fix, usa un modelo con mas razonamiento.
