// Runs the query embedding model off the main thread. The model (~30 MB, q8) is
// downloaded from the Hugging Face hub on first use and cached by the browser.
import { pipeline, env } from "@huggingface/transformers";

env.allowLocalModels = false;

let extractor: any = null;

self.onmessage = async (e: MessageEvent) => {
  const { id, text, model } = e.data as { id: number; text: string; model: string };
  try {
    extractor ??= await pipeline("feature-extraction", model, {
      dtype: "q8",
      progress_callback: (p: any) => {
        if (p.status === "progress" && p.total) self.postMessage({ type: "progress", loaded: p.loaded, total: p.total });
      },
    });
    const out = await extractor(text, { pooling: "cls", normalize: true });
    self.postMessage({ type: "result", id, vec: out.data as Float32Array });
  } catch (err) {
    self.postMessage({ type: "error", id, error: String(err) });
  }
};
