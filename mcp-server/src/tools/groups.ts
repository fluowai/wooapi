import type { ApiConfig } from "../lib/api.js";
import * as api from "../lib/api.js";

export function getGroupTools(config: ApiConfig) {
  return [
    {
      name: "get_groups",
      description: "List all WhatsApp groups for an instance",
      inputSchema: {
        type: "object",
        properties: {
          instanceId: { type: "number", description: "Instance ID" },
        },
        required: ["instanceId"],
      },
      execute: async (args: { instanceId: number }) => {
        const result = await api.getGroups(args.instanceId, config);
        return { content: [{ type: "text", text: JSON.stringify(api.extractResult(result)) }] };
      },
    },
    {
      name: "get_group_info",
      description: "Get detailed information about a specific group",
      inputSchema: {
        type: "object",
        properties: {
          instanceId: { type: "number", description: "Instance ID" },
          jid: { type: "string", description: "Group JID (group@g.us)" },
        },
        required: ["instanceId", "jid"],
      },
      execute: async (args: { instanceId: number; jid: string }) => {
        const result = await api.getGroupInfo(args.instanceId, args.jid, config);
        return { content: [{ type: "text", text: JSON.stringify(api.extractResult(result)) }] };
      },
    },
    {
      name: "create_group",
      description: "Create a new WhatsApp group",
      inputSchema: {
        type: "object",
        properties: {
          instanceId: { type: "number", description: "Instance ID" },
          name: { type: "string", description: "Group name" },
          participants: {
            type: "array",
            items: { type: "string" },
            description: "Array of participant JIDs to add initially",
          },
        },
        required: ["instanceId", "name", "participants"],
      },
      execute: async (args: { instanceId: number; name: string; participants: string[] }) => {
        const result = await api.createGroup(args.instanceId, args.name, args.participants, config);
        return { content: [{ type: "text", text: JSON.stringify(api.extractResult(result)) }] };
      },
    },
    {
      name: "add_group_participants",
      description: "Add participants to a WhatsApp group",
      inputSchema: {
        type: "object",
        properties: {
          instanceId: { type: "number", description: "Instance ID" },
          jid: { type: "string", description: "Group JID" },
          participants: {
            type: "array",
            items: { type: "string" },
            description: "Array of participant JIDs to add",
          },
        },
        required: ["instanceId", "jid", "participants"],
      },
      execute: async (args: { instanceId: number; jid: string; participants: string[] }) => {
        const result = await api.updateGroupParticipants(args.instanceId, args.jid, "add", args.participants, config);
        return { content: [{ type: "text", text: JSON.stringify(api.extractResult(result)) }] };
      },
    },
    {
      name: "remove_group_participants",
      description: "Remove participants from a WhatsApp group",
      inputSchema: {
        type: "object",
        properties: {
          instanceId: { type: "number", description: "Instance ID" },
          jid: { type: "string", description: "Group JID" },
          participants: {
            type: "array",
            items: { type: "string" },
            description: "Array of participant JIDs to remove",
          },
        },
        required: ["instanceId", "jid", "participants"],
      },
      execute: async (args: { instanceId: number; jid: string; participants: string[] }) => {
        const result = await api.updateGroupParticipants(args.instanceId, args.jid, "remove", args.participants, config);
        return { content: [{ type: "text", text: JSON.stringify(api.extractResult(result)) }] };
      },
    },
    {
      name: "promote_group_participants",
      description: "Promote participants to admin in a WhatsApp group",
      inputSchema: {
        type: "object",
        properties: {
          instanceId: { type: "number", description: "Instance ID" },
          jid: { type: "string", description: "Group JID" },
          participants: {
            type: "array",
            items: { type: "string" },
            description: "Array of participant JIDs to promote",
          },
        },
        required: ["instanceId", "jid", "participants"],
      },
      execute: async (args: { instanceId: number; jid: string; participants: string[] }) => {
        const result = await api.updateGroupParticipants(args.instanceId, args.jid, "promote", args.participants, config);
        return { content: [{ type: "text", text: JSON.stringify(api.extractResult(result)) }] };
      },
    },
    {
      name: "demote_group_participants",
      description: "Demote admins to regular participants in a WhatsApp group",
      inputSchema: {
        type: "object",
        properties: {
          instanceId: { type: "number", description: "Instance ID" },
          jid: { type: "string", description: "Group JID" },
          participants: {
            type: "array",
            items: { type: "string" },
            description: "Array of admin JIDs to demote",
          },
        },
        required: ["instanceId", "jid", "participants"],
      },
      execute: async (args: { instanceId: number; jid: string; participants: string[] }) => {
        const result = await api.updateGroupParticipants(args.instanceId, args.jid, "demote", args.participants, config);
        return { content: [{ type: "text", text: JSON.stringify(api.extractResult(result)) }] };
      },
    },
  ];
}
