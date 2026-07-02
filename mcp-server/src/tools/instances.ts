import type { ApiConfig } from "../lib/api.js";
import * as api from "../lib/api.js";

export function getInstanceTools(config: ApiConfig) {
  return [
    {
      name: "get_instances",
      description: "List all WhatsApp instances for the account",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      execute: async () => {
        const result = await api.getInstances(config);
        return { content: [{ type: "text", text: JSON.stringify(api.extractResult(result)) }] };
      },
    },
    {
      name: "get_instance_status",
      description: "Get the connection status of a WhatsApp instance",
      inputSchema: {
        type: "object",
        properties: {
          instanceId: { type: "number", description: "Instance ID" },
        },
        required: ["instanceId"],
      },
      execute: async (args: { instanceId: number }) => {
        const result = await api.getInstanceStatus(args.instanceId, config);
        return { content: [{ type: "text", text: JSON.stringify(api.extractResult(result)) }] };
      },
    },
    {
      name: "get_conversations",
      description: "List all conversations for the account",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      execute: async () => {
        const result = await api.getConversations(config);
        return { content: [{ type: "text", text: JSON.stringify(api.extractResult(result)) }] };
      },
    },
    {
      name: "get_conversation_messages",
      description: "Get messages from a specific conversation",
      inputSchema: {
        type: "object",
        properties: {
          conversationId: { type: "number", description: "Conversation ID" },
        },
        required: ["conversationId"],
      },
      execute: async (args: { conversationId: number }) => {
        const result = await api.getConversationMessages(args.conversationId, config);
        return { content: [{ type: "text", text: JSON.stringify(api.extractResult(result)) }] };
      },
    },
    {
      name: "get_messages",
      description: "List all messages across the account",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      execute: async () => {
        const result = await api.getMessages(config);
        return { content: [{ type: "text", text: JSON.stringify(api.extractResult(result)) }] };
      },
    },
  ];
}
