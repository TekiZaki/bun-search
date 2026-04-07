// background.js
let ws = null;
const WS_URL = "ws://localhost:8787";
let reconnectTimer = null;
let heartbeatTimer = null;

// ─── MV3 Service Worker Keepalive ────────────────────────────────────────────
// Chrome MV3 service workers die after ~30s of inactivity.
// chrome.alarms fires every 25s to keep the SW alive and ensure WS stays open.
chrome.alarms.create("keepAlive", { periodInMinutes: 0.4 }); // every ~25s

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive") {
    // Touching chrome API re-activates the service worker.
    // Also check if WebSocket died quietly and reconnect if needed.
    if (
      !ws ||
      ws.readyState === WebSocket.CLOSED ||
      ws.readyState === WebSocket.CLOSING
    ) {
      console.log("⏰ Alarm fired — WebSocket is dead, reconnecting...");
      scheduleReconnect(0);
    } else {
      // Send a ping to detect stale connections early
      try {
        ws.send(JSON.stringify({ type: "PING" }));
      } catch (e) {
        console.warn("Ping failed, reconnecting...", e.message);
        scheduleReconnect(0);
      }
    }
  }
});

// ─── WebSocket Connection ─────────────────────────────────────────────────────
function connect() {
  // Clear any pending reconnect timer
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // Don't double-connect
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  console.log("🔌 Connecting to Bun Search Tool...");
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("🟢 Connected to Bun Search Tool");
    ws.send(JSON.stringify({ type: "STATUS", message: "Extension Ready" }));
    startHeartbeat();
  };

  ws.onclose = (event) => {
    console.log(`🔴 Disconnected (code=${event.code}). Reconnecting in 5s...`);
    stopHeartbeat();
    scheduleReconnect(5000);
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err.message ?? err);
    // onclose will fire after onerror, so reconnect is handled there
  };

  ws.onmessage = async (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      console.error("Failed to parse message:", e);
      return;
    }

    if (data.type === "SEARCH") {
      await performSearch(data.query, data.id);
    } else if (data.type === "DEBUG") {
      await performDebug(data.query, data.id);
    } else if (data.type === "SCRAPE") {
      const tab = await chrome.tabs.create({ url: data.url, active: false });
      await waitForTab(tab.id);
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.body.innerText.slice(0, 15000),
      });
      chrome.tabs.remove(tab.id);
      ws.send(
        JSON.stringify({
          type: "RESULT",
          id: data.id,
          data: result[0].result,
          status: "success",
        }),
      );
    }
    // PONG responses from server (if implemented) are silently ignored
  };
}

function scheduleReconnect(delayMs) {
  if (reconnectTimer) return; // already scheduled
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delayMs);
}

// ─── Heartbeat (client-side ping every 20s) ───────────────────────────────────
// Detects zombie connections where onclose never fires (e.g. OS-level drops).
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      stopHeartbeat();
      return;
    }
    try {
      ws.send(JSON.stringify({ type: "PING" }));
    } catch (e) {
      console.warn("Heartbeat send failed:", e.message);
      stopHeartbeat();
      ws.close();
    }
  }, 20000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ─── Tab Helpers ──────────────────────────────────────────────────────────────
function waitForTab(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Tab load timed out"));
    }, 15000);

    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ─── Search ───────────────────────────────────────────────────────────────────
async function performSearch(query, requestId) {
  let tab;
  try {
    tab = await chrome.tabs.create({
      url: `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10&hl=en`,
      active: false, // open in background — no need to switch tabs
    });
    await waitForTab(tab.id);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeGoogleResults,
    });

    await chrome.tabs.remove(tab.id);

    if (results && results[0] && results[0].result) {
      ws.send(
        JSON.stringify({
          type: "RESULT",
          id: requestId,
          data: results[0].result,
          status: "success",
        }),
      );
    } else {
      throw new Error("executeScript returned nothing");
    }
  } catch (error) {
    if (tab) chrome.tabs.remove(tab.id).catch(() => { });
    ws.send(
      JSON.stringify({
        type: "RESULT",
        id: requestId,
        error: error.message,
        status: "failed",
      }),
    );
  }
}

// ─── Debug ────────────────────────────────────────────────────────────────────
async function performDebug(query, requestId) {
  let tab;
  try {
    tab = await chrome.tabs.create({
      url: `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10&hl=en`,
      active: false,
    });
    await waitForTab(tab.id);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: debugGoogleDOM,
    });

    await chrome.tabs.remove(tab.id);

    ws.send(
      JSON.stringify({
        type: "DEBUG_RESULT",
        id: requestId,
        data: results[0].result,
        status: "success",
      }),
    );
  } catch (error) {
    if (tab) chrome.tabs.remove(tab.id).catch(() => { });
    ws.send(
      JSON.stringify({
        type: "DEBUG_RESULT",
        id: requestId,
        error: error.message,
        status: "failed",
      }),
    );
  }
}

// ─── DOM Scrapers (run inside Google tab) ────────────────────────────────────
function scrapeGoogleResults() {
  if (
    document.body.innerText.includes("unusual traffic") ||
    document.body.innerText.includes("CAPTCHA") ||
    document.querySelector("form#captcha-form")
  ) {
    return { error: "CAPTCHA_DETECTED", results: [], aiOverview: null };
  }

  // ─── AI Overview ──────────────────────────────────────────────────────────
  let aiOverview = null;

  // Helper: recursively pierce shadow roots to find a selector.
  // Google renders the AI Overview inside a <google-search-x> custom element
  // whose content lives in a shadow DOM — regular querySelector stops at the
  // shadow root boundary and can't see inside it.
  function queryShadow(root, selector) {
    const el = root.querySelector(selector);
    if (el) return el;
    for (const node of root.querySelectorAll("*")) {
      if (node.shadowRoot) {
        const found = queryShadow(node.shadowRoot, selector);
        if (found) return found;
      }
    }
    return null;
  }

  const AI_OVERVIEW_SELECTORS = [
    "div.UAj0Zb", // primary confirmed selector (inside shadow DOM)
    "div#m-x-content", // alternate wrapper
    "div[data-attrid='SGE']",
    "div.YzccNe",
    "div.X5OiLe",
    "div[jsname='yEVEwb']",
  ];

  let aiOverviewSelector = null;
  for (const sel of AI_OVERVIEW_SELECTORS) {
    const el = queryShadow(document, sel);
    if (el) {
      aiOverview = el.innerText.trim();
      aiOverviewSelector = sel;
      break;
    }
  }

  // ─── Organic Results (unchanged) ──────────────────────────────────────────
  const organicResults = [];
  const STRATEGIES = [
    "div#rso div.tF2Cxc",
    "div#rso div.Ww4FFb",
    "div#rso div.yuRUbf",
    "div#rso > div > div",
  ];

  let items = [];
  let usedStrategy = "";

  for (const sel of STRATEGIES) {
    const found = document.querySelectorAll(sel);
    if (found.length > 0) {
      items = Array.from(found);
      usedStrategy = sel;
      break;
    }
  }

  items.forEach((item, index) => {
    const titleEl = item.querySelector("h3");
    const linkEl =
      item.querySelector('a[href^="http"]') || item.querySelector("a");
    const snippetEl =
      item.querySelector("div.VwiC3b") ||
      item.querySelector('[data-sncf="1"]') ||
      item.querySelector("span.aCOpRe");

    if (titleEl && linkEl) {
      organicResults.push({
        position: index + 1,
        title: titleEl.innerText.trim(),
        link: linkEl.href,
        snippet: snippetEl ? snippetEl.innerText.trim() : "",
      });
    }
  });

  return {
    results: organicResults,
    strategy: usedStrategy,
    aiOverview,
    aiOverviewSelector,
  };
}

function debugGoogleDOM() {
  const isCaptcha =
    document.body.innerText.includes("unusual traffic") ||
    document.body.innerText.includes("CAPTCHA") ||
    !!document.querySelector("form#captcha-form");

  const probes = [
    "#rso > div",
    "#rso > div > div",
    "div#rso",
    "div#search",
    "div.MjjYud",
    "div.VwiC3b",
    "div.Ww4FFb",
    "div.g",
    "div.tF2Cxc",
    "div.yuRUbf",
    "div[data-async-context]",
    "div[data-hveid]",
    "div[data-sokoban-container]",
    "h3",
    // AI Overview probes
    "div.UAj0Zb",
    "div#m-x-content",
    "div[data-attrid='SGE']",
    "div.YzccNe",
    "div.X5OiLe",
    "google-search-x",
    "div[jsname='yEVEwb']",
  ];

  const counts = {};
  for (const sel of probes) counts[sel] = document.querySelectorAll(sel).length;

  const rso = document.querySelector("div#rso");
  const rsoChildClasses = rso
    ? Array.from(rso.children)
      .slice(0, 5)
      .map((el) => ({
        tag: el.tagName,
        classes: el.className,
        children: el.children.length,
      }))
    : [];

  return {
    isCaptcha,
    counts,
    rsoChildClasses,
    firstH3: document.querySelector("h3")?.innerText ?? "(none)",
    url: location.href,
    // Shadow DOM diagnosis for AI Overview
    shadowInfo: (() => {
      const gsx = document.querySelector("google-search-x");
      if (!gsx) return { found: false };
      const sr = gsx.shadowRoot;
      if (!sr)
        return {
          found: true,
          shadowRoot: false,
          note: "shadow root is closed",
        };
      return {
        found: true,
        shadowRoot: true,
        innerSelectors: [
          "div.UAj0Zb",
          "div#m-x-content",
          "div[jsname='yEVEwb']",
        ].map((sel) => ({ sel, present: !!sr.querySelector(sel) })),
      };
    })(),
    // Preview text from each AI Overview candidate in the regular DOM
    aiOverviewCandidates: [
      "div.UAj0Zb",
      "div#m-x-content",
      "div[data-attrid='SGE']",
      "div.YzccNe",
      "div.X5OiLe",
      "div[jsname='yEVEwb']",
    ].map((sel) => {
      const el = document.querySelector(sel);
      return {
        sel,
        found: !!el,
        childCount: el ? el.children.length : 0,
        preview: el ? el.innerText.trim().slice(0, 200) : null,
      };
    }),
  };
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
connect();
