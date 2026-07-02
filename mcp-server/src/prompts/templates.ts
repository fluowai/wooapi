export function getPrompts() {
  return [
    {
      name: "customer_support_agent",
      description: "Act as a WhatsApp customer support agent. Use this when you need to handle customer inquiries, answer questions, and provide support via WhatsApp.",
      arguments: [
        { name: "instanceId", description: "The WhatsApp instance ID to use", required: true },
        { name: "language", description: "Language to respond in (pt-BR or en)", required: false },
      ],
    },
    {
      name: "broadcast_campaign",
      description: "Run a WhatsApp broadcast campaign. Send messages to multiple contacts or groups.",
      arguments: [
        { name: "instanceId", description: "The WhatsApp instance ID to use", required: true },
        { name: "audience", description: "Target audience (contacts, groups, or specific JIDs)", required: true },
      ],
    },
    {
      name: "group_management",
      description: "Manage WhatsApp groups - create, add/remove participants, promote/demote admins.",
      arguments: [
        { name: "instanceId", description: "The WhatsApp instance ID to use", required: true },
        { name: "action", description: "Action to perform (create, add, remove, promote, demote)", required: true },
      ],
    },
    {
      name: "contact_research",
      description: "Research contacts - check if numbers are on WhatsApp, get profile info, and list contacts.",
      arguments: [
        { name: "instanceId", description: "The WhatsApp instance ID to use", required: true },
      ],
    },
  ];
}
