import { z } from "zod";
import type { ApiConfig } from "../lib/api.js";
import * as api from "../lib/api.js";

export function getMessagingTools(config: ApiConfig) {
  return [
    {
      name: "send_message",
      description: "Send a WhatsApp text message to a phone number or group",
      inputSchema: {
        type: "object",
        properties: {
          instanceId: { type: "number", description: "Instance ID" },
          jid: { type: "string", description: "Recipient JID (number@s.whatsapp.net or group@g.us)" },
          text: { type: "string", description: "Message text content" },
        },
        required: ["instanceId", "jid", "text"],
      },
      execute: async (args: { instanceId: number; jid: string; text: string }) => {
        const result = await api.sendMessage(args.instanceId, args.jid, args.text, config);
        return { content: [{ type: "text", text: JSON.stringify(api.extractResult(result)) }] };
      },
    },
    {
      name: "send_media",
      description: "Send a media file (image, audio, video, document) via WhatsApp",
      inputSchema: {
        type: "object",
        properties: {
          instanceId: { type: "number", description: "Instance ID" },
          jid: { type: "string", description: "Recipient JID" },
          mediaUrl: { type: "string", description: "Public URL of the media file" },
          mimeType: { type: "string", description: "MIME type (image/jpeg, audio/mpeg, application/pdf, etc.)" },
          caption: { type: "string", description: "Optional caption text" },
        },
        required: ["instanceId", "jid", "mediaUrl", "mimeType"],
      },
      execute: async (args: { instanceId: number; jid: string; mediaUrl: string; mimeType: string; caption?: string }) => {
        const result = await api.sendMedia(args.instanceId, args.jid, args.mediaUrl, args.mimeType, args.caption || "", config);
        return { content: [{ type: "text", text: JSON.stringify(api.extractResult(result)) }] };
      },
    },
    {
      name: "send_buttons",
      description: "Send an interactive button message (up to 3 buttons)",
      inputSchema: {
        type: "object",
        properties: {
          instanceId: { type: "number", description: "Instance ID" },
          jid: { type: "string", description: "Recipient JID" },
          title: { type: "string", description: "Message header title" },
          text: { type: "string", description: "Message body text" },
          buttons: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Button ID" },
                text: { type: "string", description: "Button display text" },
              },
              required: ["id", "text"],
            },
            description: "Array of buttons (max 3)",
          },
          footer: { type: "string", description: "Optional footer text" },
        },
        required: ["instanceId", "jid", "title", "text", "buttons"],
      },
      execute: async (args: { instanceId: number; jid: string; title: string; text: string; buttons: { id: string; text: string }[]; footer?: string }) => {
        const result = await api.sendButtons(args.instanceId, args.jid, args.title, args.text, args.buttons, args.footer, config);
        return { content: [{ type: "text", text: JSON.stringify(api.extractResult(result)) }] };
      },
    },
    {
      name: "send_list",
      description: "Send an interactive list message with selectable rows",
      inputSchema: {
        type: "object",
        properties: {
          instanceId: { type: "number", description: "Instance ID" },
          jid: { type: "string", description: "Recipient JID" },
          title: { type: "string", description: "List header title" },
          text: { type: "string", description: "List body description" },
          buttonText: { type: "string", description: "Text on the call-to-action button" },
          sections: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "Section title" },
                rows: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      title: { type: "string" },
                      description: { type: "string" },
                    },
                    required: ["id", "title"],
                  },
                },
              },
              required: ["title", "rows"],
            },
            description: "Array of sections with rows (max 10 total rows)",
          },
        },
        required: ["instanceId", "jid", "title", "text", "buttonText", "sections"],
      },
      execute: async (args: { instanceId: number; jid: string; title: string; text: string; buttonText: string; sections: any[] }) => {
        const result = await api.sendList(args.instanceId, args.jid, args.title, args.text, args.buttonText, args.sections, config);
        return { content: [{ type: "text", text: JSON.stringify(api.extractResult(result)) }] };
      },
    },
    {
      name: "send_reply",
      description: "Reply to a specific message in a conversation",
      inputSchema: {
        type: "object",
        properties: {
          instanceId: { type: "number", description: "Instance ID" },
          jid: { type: "string", description: "Recipient JID" },
          messageId: { type: "string", description: "ID of the message to reply to" },
          text: { type: "string", description: "Reply text" },
        },
        required: ["instanceId", "jid", "messageId", "text"],
      },
      execute: async (args: { instanceId: number; jid: string; messageId: string; text: string }) => {
        const result = await api.sendReply(args.instanceId, args.jid, args.messageId, args.text, config);
        return { content: [{ type: "text", text: JSON.stringify(api.extractResult(result)) }] };
      },
    },
    {
      name: "send_location",
      description: "Share a location via WhatsApp",
      inputSchema: {
        type: "object",
        properties: {
          instanceId: { type: "number", description: "Instance ID" },
          jid: { type: "string", description: "Recipient JID" },
          latitude: { type: "number", description: "Latitude coordinate" },
          longitude: { type: "number", description: "Longitude coordinate" },
          name: { type: "string", description: "Optional location name" },
          address: { type: "string", description: "Optional address" },
        },
        required: ["instanceId", "jid", "latitude", "longitude"],
      },
      execute: async (args: { instanceId: number; jid: string; latitude: number; longitude: number; name?: string; address?: string }) => {
        const result = await api.sendLocation(args.instanceId, args.jid, args.latitude, args.longitude, args.name, args.address, config);
        return { content: [{ type: "text", text: JSON.stringify(api.extractResult(result)) }] };
      },
    },
  ];
}
