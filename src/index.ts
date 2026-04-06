import "dotenv/config";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { OuraOAuthProvider, createOuraCallbackRouter } from "./auth.js";
import { registerAllTools } from "./tools.js";

// --- Config ---
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const SERVER_URL = process.env.SERVER_URL ?? `http://localhost:${PORT}`;
const OURA_CLIENT_ID = process.env.OURA_CLIENT_ID;
const OURA_CLIENT_SECRET = process.env.OURA_CLIENT_SECRET;

if (!OURA_CLIENT_ID || !OURA_CLIENT_SECRET) {
  console.error(
    "Error: OURA_CLIENT_ID and OURA_CLIENT_SECRET must be set in environment variables."
  );
  process.exit(1);
}

// --- OAuth Provider ---
const oauthProvider = new OuraOAuthProvider(
  OURA_CLIENT_ID,
  OURA_CLIENT_SECRET,
  SERVER_URL
);

// --- Express App ---
const app = createMcpExpressApp({ host: "0.0.0.0" });
app.set("trust proxy", 1); // Trust first proxy (Cloudflare Tunnel)

// Request logger
app.use((req, _res, next) => {
  console.log(`[HTTP] ${req.method} ${req.path}`);
  next();
});

// Mount the Oura callback route (must be before auth router to avoid auth on callback)
app.use(createOuraCallbackRouter(oauthProvider));

// Mount MCP OAuth auth router (handles /.well-known, /authorize, /token, /register)
const serverUrl = new URL(SERVER_URL);
app.use(
  mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl: serverUrl,
    scopesSupported: [
      "email",
      "personal",
      "daily",
      "heartrate",
      "workout",
      "tag",
      "session",
      "spo2",
    ],
  })
);

// Auth middleware for MCP endpoints
const authMiddleware = requireBearerAuth({
  verifier: oauthProvider,
  requiredScopes: [],
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(serverUrl),
});

// --- MCP Server Factory ---
function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "oura-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: { logging: {} },
    }
  );

  registerAllTools(server);
  return server;
}

// --- Transport Management ---
const transports: Record<string, StreamableHTTPServerTransport> = {};

// MCP POST handler
app.post("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const method = req.body?.method ?? req.body?.[0]?.method ?? "unknown";
  console.log(`[MCP POST] method=${method} sessionId=${sessionId ?? "none"}`);

  try {
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          delete transports[sid];
        }
      };

      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// MCP GET handler (SSE streams)
app.get("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

// MCP DELETE handler (session termination)
app.delete("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

// --- Start Server ---
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Oura MCP Server running at ${SERVER_URL}`);
  console.log(`  MCP endpoint: ${SERVER_URL}/mcp`);
  console.log(
    `  OAuth metadata: ${SERVER_URL}/.well-known/oauth-authorization-server`
  );
  console.log(`  Oura callback: ${SERVER_URL}/oura/callback`);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down...");
  for (const sessionId of Object.keys(transports)) {
    try {
      await transports[sessionId].close();
      delete transports[sessionId];
    } catch (error) {
      console.error(`Error closing session ${sessionId}:`, error);
    }
  }
  process.exit(0);
});
