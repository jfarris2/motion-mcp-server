import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MotionApiService } from "./services/motionApi";
import { WorkspaceResolver } from "./utils/workspaceResolver";
import { InputValidator } from "./utils/validator";
import { HandlerFactory } from "./handlers/HandlerFactory";
import { ToolRegistry, ToolConfigurator } from "./tools";
import { jsonSchemaToZodShape } from "./utils/jsonSchemaToZod";
import { SERVER_INSTRUCTIONS } from "./utils/serverInstructions";

interface Env {
  MOTION_API_KEY: string;
  MOTION_MCP_SECRET: string;
  MOTION_MCP_TOOLS?: string;
  MCP_OBJECT: DurableObjectNamespace;
}

export class MotionMCPAgent extends McpAgent<Env> {
  server = new McpServer(
    { name: "motion-mcp-server", version: "2.8.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  async init() {
    const motionService = new MotionApiService(this.env.MOTION_API_KEY);
    const workspaceResolver = new WorkspaceResolver(motionService);
    const validator = new InputValidator();
    const context = { motionService, workspaceResolver, validator };
    const handlerFactory = new HandlerFactory(context);

    const registry = new ToolRegistry();
    const configurator = new ToolConfigurator(
      this.env.MOTION_MCP_TOOLS || "complete",
      registry
    );
    const enabledTools = configurator.getEnabledTools();
    validator.initializeValidators(enabledTools);

    for (const tool of enabledTools) {
      const zodShape = jsonSchemaToZodShape(tool.inputSchema as Parameters<typeof jsonSchemaToZodShape>[0]);

      this.server.tool(
        tool.name,
        tool.description,
        zodShape,
        async (params) => {
          const handler = handlerFactory.createHandler(tool.name);
          return await handler.handle(params);
        }
      );
    }
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", server: "motion-mcp-server" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    const pathParts = url.pathname.split("/").filter(Boolean);

    // SSE callback paths — these don't include the secret because they're
    // session-authenticated via the sessionId query param. Pass through as-is.
    const isSSECallback = pathParts[0] === "mcp" && (pathParts[1] === "message" || pathParts[1] === "sse");
    if (isSSECallback) {
      return (
        MotionMCPAgent.mount("/mcp") as { fetch: (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response> }
      ).fetch(request, env, ctx);
    }

    // Validate secret path: /mcp/{secret}/...
    if (pathParts[0] !== "mcp" || pathParts[1] !== env.MOTION_MCP_SECRET) {
      return new Response("Not found", { status: 404 });
    }

    // Rewrite path to strip the secret before passing to McpAgent
    const cleanPath = "/mcp" + (pathParts.length > 2 ? "/" + pathParts.slice(2).join("/") : "");
    const cleanUrl = new URL(cleanPath, url.origin);
    const cleanRequest = new Request(cleanUrl, request);

    return (
      MotionMCPAgent.mount("/mcp") as { fetch: (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response> }
    ).fetch(cleanRequest, env, ctx);
  },
};
