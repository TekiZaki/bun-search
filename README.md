# Bun Search Bridge

Bun Search Bridge is a local command-line tool that retrieves Google Search results and AI Overviews without relying on official, rate-limited APIs. It accomplishes this by establishing a WebSocket connection between a Bun-based local server and a custom Google Chrome extension. The extension performs headless-like searches in background tabs and scrapes the DOM, passing the data back to the CLI.

## Key Features

* **Organic Results Extraction:** Captures titles, URLs, and text snippets from standard Google search results.
* **AI Overview Support:** Specifically engineered to pierce Google's Shadow DOM (`<google-search-x>`) to extract AI Overview text.
* **Local Caching:** Automatically caches search results locally in a `.cache` directory for one hour to prevent redundant queries.
* **JSON Export:** Supports exporting parsed search data directly to JSON files for downstream processing.
* **DOM Debugging Tool:** Includes a dedicated debug mode to inspect DOM selectors, classes, and Shadow root accessibility when standard scraping fails.

---

## Prerequisites

To run this project, you must have the following installed on your system:
* **Bun** (JavaScript runtime and package manager)
* **Google Chrome** (for loading the required extension)

---

## Installation and Setup

### 1. Install Dependencies
Navigate to the root directory of the project and install the required Node modules using Bun.

```bash
bun install
bun link
```

### 2. Install the Chrome Extension
The CLI requires the local Chrome extension to function as the scraping engine.

1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Toggle on **Developer mode** in the top right corner.
3. Click the **Load unpacked** button.
4. Select the `localSearchBridge` folder located inside the project directory.
5. Ensure the extension is enabled and active.

---

## Usage

Start the search process by running the `index.ts` file via Bun and providing your search query. The server will automatically wait for the Chrome extension to connect if it has not already.

### Basic Search

```bash
bun run index.ts "how to center a div"
```

### Command Line Options

You can modify the behavior of the search using the following flags:

* **Export to JSON (`--output`):** Saves the search results and AI Overview to a specified JSON file.
    ```bash
    bun run index.ts "latest space news" --output results.json
    ```

* **Bypass Cache (`--no-cache`):** Forces the tool to perform a live search in the browser instead of reading from the local cache.
    ```bash
    bun run index.ts "weather today" --no-cache
    ```

* **Debug Mode (`--debug`):** Instructs the extension to run a diagnostic script on the search page instead of scraping results. This is highly useful for updating selectors if Google changes its DOM structure.
    ```bash
    bun run index.ts "test query" --debug
    ```

---

## How It Works

1.  **Server Initialization:** The Bun script (`index.ts`) launches a WebSocket server on port `8787` and waits for a connection.
2.  **Extension Connection:** The Chrome extension's background service worker (`background.js`) continuously attempts to connect to this WebSocket. A keep-alive alarm ensures the service worker does not sleep.
3.  **Search Execution:** When a query is submitted via the CLI, the server sends a message to the extension.
4.  **Browser Automation:** The extension creates a new, inactive background tab pointed to the Google Search URL.
5.  **Data Extraction:** Once the tab loads, the extension injects a content script that scrapes the standard results and recursively searches Shadow roots for AI Overviews.
6.  **Response:** The scraped data is formatted, sent back through the WebSocket, displayed in the terminal, and saved to the local cache.