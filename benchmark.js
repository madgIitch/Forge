const MODEL = "qwen2.5-coder:7b-instruct";
const OLLAMA_URL = "http://localhost:11434/api/chat";

// Generamos texto de relleno para simular un contexto de ~3500 tokens (aprox 14k caracteres)
// para probar la memoria de tu RTX 3050.
const LONG_CONTEXT = "Contexto de prueba: " + "lorem ipsum dolor sit amet ".repeat(1200);

async function runBenchmark(name, messages) {
  console.log(`\n--- Iniciando prueba: ${name} ---`);
  
  const start = performance.now();
  let firstTokenTime = 0;
  let tokenCount = 0;

  try {
    const response = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: messages,
        stream: true, // Importante para medir latencia real
        options: {
          num_ctx: 4096, // Forzamos ventana de 4k
          temperature: 0.1
        }
      }),
    });

    if (!response.ok) throw new Error(`Error Ollama: ${response.statusText}`);
    if (!response.body) throw new Error("No body in response");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      // Ollama envía múltiples objetos JSON por chunk a veces
      const lines = chunk.split("\n").filter(line => line.trim() !== "");

      for (const line of lines) {
        try {
          const json = JSON.parse(line);
          if (json.done === false) {
            if (tokenCount === 0) {
              firstTokenTime = performance.now() - start;
              process.stdout.write("Generando: ");
            }
            process.stdout.write("."); // Feedback visual
            tokenCount++;
          }
        } catch (e) {
          // Ignorar errores de parseo parciales
        }
      }
    }

    const totalTime = performance.now() - start;
    const tokensPerSecond = tokenCount / (totalTime / 1000);

    console.log("\n\nResultados:");
    console.log(`- Latencia 1er token: ${firstTokenTime.toFixed(2)} ms`);
    console.log(`- Velocidad total:    ${tokensPerSecond.toFixed(2)} t/s`);
    console.log(`- Tokens generados:   ${tokenCount}`);
    
    return tokensPerSecond;

  } catch (error) {
    console.error("Error en benchmark:", error);
    return 0;
  }
}

async function main() {
  // Prueba 1: Latencia pura (pregunta corta)
  await runBenchmark("Latencia Rápida", [
    { role: "user", content: "Escribe una función simple en TS para sumar dos números." }
  ]);

  // Prueba 2: Carga de Memoria (Contexto lleno)
  // Esto validará si tu 3050 aguanta el contexto de 4k sin crashear o ir lentísimo.
  await runBenchmark("Estrés de Contexto (4k)", [
    { role: "system", content: LONG_CONTEXT },
    { role: "user", content: "Resume el texto anterior en una frase." }
  ]);
}

main();