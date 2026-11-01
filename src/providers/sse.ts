/**
 * Minimal Server-Sent Events reader: yields the payload of each `data:` field.
 * Comment lines (starting with ":", e.g. OpenRouter's keep-alives) and other
 * fields are skipped. Handles events split across network chunks.
 */
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);

      if (line === "") {
        // Blank line terminates an event.
        if (dataLines.length > 0) yield dataLines.join("\n");
        dataLines = [];
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).replace(/^ /, ""));
  if (dataLines.length > 0) yield dataLines.join("\n");
}
