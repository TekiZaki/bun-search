// index.ts
import { WebSocketServer, WebSocket } from "ws";
import { parse } from "node-html-parser";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { dirname } from "path";
import { fileURLToPath } from "url";

const PORT = 8787;
const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), ".cache");

interface SearchResult {
  title: string;
  link: string;
  snippet: string;
  position: number;
  bias?: string;
}

interface SearchResponse {
  results: SearchResult[];
  aiOverview?: string | null;
}

interface WSMessage {
  type: "SEARCH" | "RESULT" | "STATUS" | "DEBUG" | "DEBUG_RESULT";
  query?: string;
  id?: string;
  data?: any;
  error?: string;
  status?: string;
  message?: string;
}

const pendingRequests = new Map<
  string,
  {
    resolve: (val: any) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();

function getCacheKey(query: string): string {
  return query.replace(/[^a-z0-9]/gi, "_").toLowerCase();
}

function getCachedData(query: string): SearchResponse | null {
  const key = getCacheKey(query);
  const filePath = join(CACHE_DIR, `${key}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const { timestamp, data } = JSON.parse(readFileSync(filePath, "utf-8"));
    if (Date.now() - timestamp < 60 * 60 * 1000) return data as SearchResponse;
  } catch (e) {}
  return null;
}

function saveToCache(query: string, data: SearchResponse) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const key = getCacheKey(query);
  writeFileSync(
    join(CACHE_DIR, `${key}.json`),
    JSON.stringify({ timestamp: Date.now(), data }),
  );
}

const BIAS_DB = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "bias.json"), "utf-8"));

function getBias(link: string): string | null {
  try {
    const domain = new URL(link).hostname.replace("www.", "");
    return BIAS_DB[domain] || null;
  } catch (e) {
    return null;
  }
}

const wss = new WebSocketServer({ port: PORT });

console.log(`🌍 WebSocket Server running on ws://localhost:${PORT}`);
console.log(`⏳ Waiting for Chrome Extension to connect...`);

let clientConnected = false;

wss.on("connection", (ws) => {
  console.log("✅ Chrome Extension Connected!");
  clientConnected = true;

  ws.on("message", (raw) => {
    const msg: WSMessage = JSON.parse(raw.toString());

    if ((msg.type === "RESULT" || msg.type === "DEBUG_RESULT") && msg.id) {
      const request = pendingRequests.get(msg.id);
      if (request) {
        clearTimeout(request.timeout);
        pendingRequests.delete(msg.id);

        if (msg.status === "success") {
          request.resolve(msg.data);
        } else {
          const errorMsg = msg.data?.error || msg.error || "Unknown error";
          if (errorMsg.includes("CAPTCHA")) {
            console.warn(
              "⚠️  CAPTCHA Detected! Please solve it in the browser tab.",
            );
            request.reject(
              new Error("CAPTCHA detected. Please solve manually and retry."),
            );
          } else {
            request.reject(new Error(errorMsg));
          }
        }
      }
    }
  });

  ws.on("close", () => {
    console.log("❌ Chrome Extension Disconnected");
    clientConnected = false;
    // Reject all pending requests
    for (const [id, request] of pendingRequests.entries()) {
      clearTimeout(request.timeout);
      request.reject(new Error("Chrome Extension disconnected"));
      pendingRequests.delete(id);
    }
  });
});

function sendToExtension(payload: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const client: WebSocket | undefined = Array.from(wss.clients)[0];
    if (!client) {
      reject(new Error("No active browser connection"));
      return;
    }

    const id = crypto.randomUUID();
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("Request timed out"));
    }, 60000);

    pendingRequests.set(id, { resolve, reject, timeout });
    client.send(JSON.stringify({ ...payload, id }));
  });
}

async function performSearchViaExtension(
  query: string,
  noCache = false,
): Promise<SearchResponse> {
  if (!clientConnected) throw new Error("No Chrome Extension connected.");

  if (!noCache) {
    const cached = getCachedData(query);
    if (cached) {
      console.log("💾 Serving from cache... (use --no-cache to bypass)");
      return cached;
    }
  }

  console.log(`🔍 Request sent to browser for: "${query}"`);
  const data = await sendToExtension({ type: "SEARCH", query });

  // Log which selector strategy worked
  if (data?.tried) {
    const winner = data.tried.find((t: any) => t.count > 0);
    if (winner)
      console.log(
        `   ✅ Matched selector: "${winner.selector}" (${winner.count} items)`,
      );
    else console.log(`   ❌ No selector matched. Raw tried:`, data.tried);
  }

  // Log AI Overview status
  if (data?.aiOverview) {
    const src = data.aiOverviewSelector
      ? ` via ${data.aiOverviewSelector}`
      : "";
    console.log(
      `   🤖 AI Overview captured (${data.aiOverview.length} chars${src})`,
    );
  } else {
    console.log(`   ℹ️  No AI Overview for this query`);
  }

  return {
    results: data?.results ?? [],
    aiOverview: data?.aiOverview ?? null,
  };
}

async function runDebug(query: string): Promise<void> {
  console.log(`\n🔬 DEBUG MODE — inspecting DOM for: "${query}"\n`);
  const data = await sendToExtension({ type: "DEBUG", query });
  if (!data) {
    console.log("No debug data returned.");
    return;
  }

  console.log("CAPTCHA?", data.isCaptcha);
  console.log("URL:", data.url);
  console.log("First <h3>:", data.firstH3);
  console.log("\nSelector counts:");
  for (const [sel, count] of Object.entries(data.counts ?? {})) {
    const mark = (count as number) > 0 ? "✅" : "  ";
    console.log(`  ${mark} ${String(count).padStart(3)}  ${sel}`);
  }
  console.log("\n#rso first children:");
  for (const child of data.rsoChildClasses ?? []) {
    console.log(
      `  <${child.tag}> classes="${child.classes}" children=${child.children}`,
    );
  }

  // Shadow DOM diagnosis
  const si = data.shadowInfo;
  if (si) {
    console.log("\n🔎 AI Overview Shadow DOM:");
    if (!si.found) {
      console.log(
        "  <google-search-x> not found — no shadow DOM for this query",
      );
    } else if (!si.shadowRoot) {
      console.log(
        "  <google-search-x> found but shadow root is CLOSED — cannot pierce",
      );
    } else {
      console.log("  <google-search-x> found with open shadow root");
      for (const { sel, present } of si.innerSelectors ?? []) {
        console.log(`  ${present ? "✅" : "  "}  ${sel}`);
      }
    }
  }

  // AI Overview candidate previews (regular DOM)
  const candidates = data.aiOverviewCandidates ?? [];
  const found = candidates.filter((c: any) => c.found);
  if (found.length === 0) {
    console.log(
      "\n🤖 AI Overview: no candidate selectors matched in regular DOM",
    );
  } else {
    console.log("\n🤖 AI Overview candidates (regular DOM):");
    for (const c of found) {
      console.log(`  ✅  ${c.sel}  (${c.childCount} children)`);
      if (c.preview) console.log(`       "${c.preview.replace(/\n/g, " ")}"`);
    }
  }
}

async function waitForConnection() {
  let waitTime = 0;
  while (!clientConnected && waitTime < 10000) {
    await new Promise((r) => setTimeout(r, 500));
    waitTime += 500;
  }
  if (!clientConnected) {
    console.error("❌ Could not connect to Chrome Extension within 10s.");
    console.error("   1. Load the extension in Chrome (Developer Mode).");
    console.error("   2. Make sure Chrome is running.");
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const isDebug = args.includes("--debug");
  const isScrape = args.includes("--scrape");
  const noCache = args.includes("--no-cache");

  const outputIdx = args.indexOf("--output");
  const outputFile =
    outputIdx !== -1 ? (args[outputIdx + 1] ?? "search.json") : null;

  const queryArgs = args.filter((a, i) => {
    if (a.startsWith("-")) return false;
    if (outputIdx !== -1 && i === outputIdx + 1) return false;
    return true;
  });
  const query = queryArgs.join(" ");

  if (!query) {
    console.log(
      "Usage: bun run index.ts <query> [--output filename.json] [--debug] [--no-cache]",
    );
    process.exit(1);
  }

  await waitForConnection();

  if (isDebug) {
    try {
      await runDebug(query);
    } catch (err) {
      console.error(
        "❌ Debug error:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      setTimeout(() => {
        wss.close();
        process.exit(0);
      }, 500);
    }
    return;
  }

  if (isScrape) {
    await waitForConnection();
    console.log(`📄 Scraping via Browser: ${query}`);
    // 'query' will contain the URL because of how we filter args
    const html = await sendToExtension({ type: "SCRAPE", url: query });

    if (typeof html === "string") {
      const root = parse(html);
      // Remove noise
      root.querySelectorAll("script, style, iframe, noscript").forEach((el: any) => el.remove());
      const cleanText = root.textContent.replace(/\s+/g, " ").trim().slice(0, 20000);
      console.log(cleanText);
    } else {
      console.log(html);
    }

    setTimeout(() => {
      wss.close();
      process.exit(0);
    }, 500);
    return;
  }

  console.log(`🚀 Starting search for: "${query}"`);
  const start = performance.now();

  try {
    const response = await performSearchViaExtension(query, noCache);
    const elapsed = (performance.now() - start).toFixed(2);

    console.log(`⚡ Done in ${elapsed}ms\n`);

    if (response.results.length === 0) {
      console.log("⚠️  No results found.");
      console.log("   → Run with --debug to inspect the live DOM:");
      console.log(`   bun run index.ts "${query}" --debug`);
    } else {
      const biasCounts: Record<string, number> = {};

      response.results.forEach((r) => {
        const lean = getBias(r.link);
        const biasLabel = lean ? `[${lean.toUpperCase()}] ` : "";
        if (lean) biasCounts[lean] = (biasCounts[lean] || 0) + 1;

        console.log(`[${r.position}] ${biasLabel}${r.title}`);
        console.log(`    ${r.link}`);
        console.log(`    ${r.snippet}\n`);
      });

      // Ground News style Percentage Summary
      const biasTotal = Object.values(biasCounts).reduce((a, b) => a + b, 0);
      if (biasTotal > 0) {
        console.log("📰 News Lean Distribution (Ground News style):");
        const summary = Object.entries(biasCounts)
          .sort(([, a], [, b]) => b - a)
          .map(([lean, count]) => {
            const pct = Math.round((count / biasTotal) * 100);
            return `   • ${lean}: ${pct}%`;
          })
          .join("\n");
        console.log(summary + "\n");
      }
    }

    // Always show AI Overview if present, regardless of --output
    if (response.aiOverview) {
      console.log("🤖 AI Overview:");
      console.log(`   ${response.aiOverview}\n`);
    }

    if (outputFile && response.results.length > 0) {
      writeFileSync(
        outputFile,
        JSON.stringify(
          {
            query,
            timestamp: new Date().toISOString(),
            source: "Chrome Extension Scraping",
            aiOverview: response.aiOverview ?? null,
            results: response.results,
          },
          null,
          2,
        ),
      );
      console.log(`✅ Results saved to ${outputFile}`);
    }

    saveToCache(query, response);
  } catch (err) {
    console.error("❌ Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    setTimeout(() => {
      wss.close();
      process.exit(0);
    }, 1000);
  }
}

main();
