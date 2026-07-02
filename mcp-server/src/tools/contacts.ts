import type { ApiConfig } from "../lib/api.js";
import * as api from "../lib/api.js";

export function getContactTools(config: ApiConfig) {
  return [
    {
      name: "get_contacts",
      description: "List all WhatsApp contacts for an instance",
      inputSchema: {
        type: "object",
        properties: {
          instanceId: { type: "number", description: "Instance ID" },
        },
        required: ["instanceId"],
      },
      execute: async (args: { instanceId: number }) => {
        const result = await api.getContacts(args.instanceId, config);
        return { content: [{ type: "text", text: JSON.stringify(api.extractResult(result)) }] };
      },
    },
    {
      name: "get_contact_info",
      description: "Get detailed information about a specific contact",
      inputSchema: {
        type: "object",
        properties: {
          instanceId: { type: "number", description: "Instance ID" },
          jid: { type: "string", description: "Contact JID" },
        },
        required: ["instanceId", "jid"],
      },
      execute: async (args: { instanceId: number; jid: string }) => {
        const result = await api.getContactInfo(args.instanceId, args.jid, config);
        return { content: [{ type: "text", text: JSON.stringify(api.extractResult(result)) }] };
      },
    },
    {
      name: "check_recipient",
      description: "Check if a phone number is registered on WhatsApp",
      inputSchema: {
        type: "object",
        properties: {
          instanceId: { type: "number", description: "Instance ID" },
          number: { type: "string", description: "Phone number to check (with country code)" },
        },
        required: ["instanceId", "number"],
      },
      execute: async (args: { instanceId: number; number: string }) => {
        const result = await api.checkRecipient(args.instanceId, args.number, config);
        return { content: [{ type: "text", text: JSON.stringify(api.extractResult(result)) }] };
      },
    },
  ];
}
