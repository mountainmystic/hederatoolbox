/**
 * proxy.js — Remote brain request forwarder
 *
 * The entire job of the npm package is right here: take a tool call,
 * POST it to the HederaIntel remote server, return the result.
 *
 * No @hashgraph/sdk. No private keys. No business logic. Zero IP exposed.
 *
 * Self-hosters: set HEDERAINTEL_ENDPOINT to point at your own Railway deployment.
 * Default: the hosted HederaIntel platform.
 */

const REMOTE_ENDPOINT =
  process.env.HEDERAINTEL_ENDPOINT ||
  "https://hedera-mcp-platform-production.up.railway.app";

/**
 * Forward a tool call to the remote brain.
 *
 * @param {string} toolName  - MCP tool name (e.g. "token_price")
 * @param {object} args      - Tool arguments from the MCP request
 * @returns {Promise<string>} - Raw text result to return in the MCP response
 */
export async function forwardToRemote(toolName, args) {
  const url = `${REMOTE_ENDPOINT}/mcp`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Pass api_key as header too so the server can validate before parsing body
        ...(args.api_key && { "X-API-KEY": args.api_key }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: toolName,
          arguments: args,
        },
      }),
      signal: AbortSignal.timeout(30_000), // 30s — deep analysis tools can be slow
    });
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new Error(
        `HederaIntel: tool '${toolName}' timed out after 30s. ` +
        `Try again or check ${REMOTE_ENDPOINT}/health`
      );
    }
    throw new Error(
      `HederaIntel: network error calling '${toolName}': ${err.message}. ` +
      `Endpoint: ${REMOTE_ENDPOINT}`
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable body)");
    throw new Error(
      `HederaIntel: server returned HTTP ${response.status} for '${toolName}': ${body}`
    );
  }

  const json = await response.json();

  // Surface JSON-RPC level errors cleanly
  if (json.error) {
    const msg = json.error.message || JSON.stringify(json.error);
    throw new Error(`HederaIntel tool error (${toolName}): ${msg}`);
  }

  // Extract the text block from the MCP content array
  const content = json.result?.content;
  if (!content || !Array.isArray(content)) {
    throw new Error(
      `HederaIntel: unexpected response shape from '${toolName}' — missing content array`
    );
  }

  const textBlock = content.find((c) => c.type === "text");
  if (!textBlock?.text) {
    throw new Error(
      `HederaIntel: no text block in response from '${toolName}'`
    );
  }

  return textBlock.text;
}
