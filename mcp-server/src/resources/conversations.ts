import type { ApiConfig } from "../lib/api.js";
import * as api from "../lib/api.js";

export function getConversationResources(config: ApiConfig) {
  const baseUrl = "wooapi";

  return [
    {
      uri: `${baseUrl}://conversations`,
      name: "All Conversations",
      description: "List of all WhatsApp conversations for the account",
      mimeType: "application/json",
      execute: async () => {
        const result = await api.getConversations(config);
        const data = api.extractResult(result);
        return {
          contents: [{
            uri: `${baseUrl}://conversations`,
            mimeType: "application/json",
            text: JSON.stringify(data, null, 2),
          }],
        };
      },
    },
    {
      uri: `${baseUrl}://instances`,
      name: "All Instances",
      description: "List of all WhatsApp instances for the account",
      mimeType: "application/json",
      execute: async () => {
        const result = await api.getInstances(config);
        const data = api.extractResult(result);
        return {
          contents: [{
            uri: `${baseUrl}://instances`,
            mimeType: "application/json",
            text: JSON.stringify(data, null, 2),
          }],
        };
      },
    },
    {
      uri: `${baseUrl}://messages`,
      name: "All Messages",
      description: "List of all messages for the account",
      mimeType: "application/json",
      execute: async () => {
        const result = await api.getMessages(config);
        const data = api.extractResult(result);
        return {
          contents: [{
            uri: `${baseUrl}://messages`,
            mimeType: "application/json",
            text: JSON.stringify(data, null, 2),
          }],
        };
      },
    },
  ];
}
