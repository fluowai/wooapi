import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getConfig, parseConfig } from "./lib/config.js";
import type { ApiConfig } from "./lib/api.js";
import { getMessagingTools } from "./tools/messaging.js";
import { getGroupTools } from "./tools/groups.js";
import { getContactTools } from "./tools/contacts.js";
import { getInstanceTools } from "./tools/instances.js";
import { getConversationResources } from "./resources/conversations.js";
import { getPrompts } from "./prompts/templates.js";

const config = getConfig();
const envConfig: ApiConfig = parseConfig(process.env as Record<string, string | undefined>);

const server = new Server(
  { name: "wooapi-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

// Register all tools
const allTools = [
  ...getMessagingTools(envConfig),
  ...getGroupTools(envConfig),
  ...getContactTools(envConfig),
  ...getInstanceTools(envConfig),
];
const allResources = getConversationResources(envConfig);
const allPrompts = getPrompts();

const toolMap = new Map(allTools.map((t) => [t.name, t]));
const resourceMap = new Map(allResources.map((r) => [r.uri, r]));
const promptMap = new Map(allPrompts.map((p) => [p.name, p]));

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: allTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = toolMap.get(request.params.name);
  if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);
  return tool.execute(request.params.arguments as any);
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: allResources.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType })),
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const resource = resourceMap.get(request.params.uri);
  if (!resource) throw new Error(`Unknown resource: ${request.params.uri}`);
  return resource.execute();
});

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: allPrompts.map(({ name, description, arguments: args }) => ({ name, description, arguments: args })),
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const prompt = promptMap.get(request.params.name);
  if (!prompt) throw new Error(`Unknown prompt: ${request.params.name}`);

  const messages: any[] = [];
  if (request.params.name === "customer_support_agent") {
    const lang = request.params.arguments?.language || "pt-BR";
    const instanceId = request.params.arguments?.instanceId || envConfig.instanceId;
    messages.push({
      role: "system",
      content: {
        type: "text",
        text: lang === "pt-BR"
          ? `Você é um agente de atendimento ao cliente via WhatsApp (instância ${instanceId}). Responda de forma educada, profissional e objetiva. Use as ferramentas disponíveis para consultar conversas, enviar mensagens e gerenciar contatos. Sempre se apresente e pergunte como pode ajudar.`
          : `You are a WhatsApp customer support agent (instance ${instanceId}). Respond politely, professionally, and objectively. Use available tools to check conversations, send messages, and manage contacts. Always introduce yourself and ask how you can help.`,
      },
    });
  } else if (request.params.name === "broadcast_campaign") {
    messages.push({
      role: "system",
      content: {
        type: "text",
        text: `You are running a WhatsApp broadcast campaign using instance ${request.params.arguments?.instanceId || envConfig.instanceId}. Target audience: ${request.params.arguments?.audience || "all contacts"}. Compose an appropriate message and send it to the target audience.`,
      },
    });
  } else if (request.params.name === "group_management") {
    messages.push({
      role: "system",
      content: {
        type: "text",
        text: `You are managing WhatsApp groups using instance ${request.params.arguments?.instanceId || envConfig.instanceId}. Action: ${request.params.arguments?.action || "manage"}. Use appropriate tools.`,
      },
    });
  } else if (request.params.name === "contact_research") {
    messages.push({
      role: "system",
      content: {
        type: "text",
        text: `You are researching WhatsApp contacts using instance ${request.params.arguments?.instanceId || envConfig.instanceId}. Check numbers, get profile info, and list contacts as needed.`,
      },
    });
  }

  return { description: prompt.description, messages };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("WooAPI MCP Server running on stdio");
}

main().catch((err) => {
  console.error("MCP Server fatal error:", err);
  process.exit(1);
});
