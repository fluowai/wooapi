import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clipboard,
  ExternalLink,
  KeyRound,
  Loader2,
  MessageSquareText,
  PlugZap,
  RefreshCw,
  Save,
  Webhook
} from 'lucide-react';

interface IntegrationManagerProps {
  apiFetch: (url: string, options?: any) => Promise<any>;
}

type ProviderId = 'n8n' | 'typebot' | 'chatwoot';

type ProviderField = {
  key: string;
  label: string;
  placeholder: string;
  type: 'text' | 'password' | 'number';
  required?: boolean;
  help: string;
};

type Provider = {
  id: ProviderId;
  name: string;
  tag: string;
  description: string;
  icon: React.ElementType;
  events: string[];
  outcome: string;
  fields: ProviderField[];
  checklist: string[];
};

const PROVIDERS: Provider[] = [
  {
    id: 'n8n',
    name: 'n8n',
    tag: 'Automacao',
    description: 'Recebe eventos do WhatsApp e responde usando nodes HTTP Request prontos.',
    icon: Webhook,
    events: ['message.received', 'message.sent', 'instance.connected', 'instance.disconnected'],
    outcome: 'Workflow recebe mensagens, decide o proximo passo e envia resposta pela API Wozapi.',
    fields: [
      {
        key: 'apiUrl',
        label: 'Production URL do Webhook',
        placeholder: 'https://seu-n8n.com/webhook/wozapi-atendimento',
        type: 'text',
        required: true,
        help: 'Copie a Production URL do node Webhook no n8n. A Wozapi vai enviar os eventos para essa URL.'
      },
      {
        key: 'apiToken',
        label: 'Token opcional do workflow',
        placeholder: 'token-do-workflow-se-existir',
        type: 'password',
        help: 'Use apenas se o seu workflow validar um token proprio. A API key da Wozapi continua sendo usada para responder mensagens.'
      }
    ],
    checklist: ['Crie um node Webhook no n8n', 'Cole a Production URL aqui', 'Clique em criar webhook', 'Use o exemplo de HTTP Request para responder']
  },
  {
    id: 'typebot',
    name: 'Typebot',
    tag: 'Bot conversacional',
    description: 'Encaminha mensagens recebidas para um fluxo Typebot e devolve respostas no WhatsApp.',
    icon: MessageSquareText,
    events: ['message.received'],
    outcome: 'Cada contato ganha uma sessao Typebot e as respostas em texto voltam automaticamente pelo WhatsApp.',
    fields: [
      {
        key: 'apiUrl',
        label: 'URL base do Typebot',
        placeholder: 'https://typebot.io',
        type: 'text',
        required: true,
        help: 'Use a URL do seu Typebot Cloud ou Self-hosted, sem barra no final.'
      },
      {
        key: 'publicId',
        label: 'Public ID do bot',
        placeholder: 'meu-bot-public-id',
        type: 'text',
        required: true,
        help: 'Fica na publicacao/compartilhamento do Typebot. A Wozapi usa esse ID para iniciar o chat.'
      },
      {
        key: 'apiToken',
        label: 'Token da API Typebot',
        placeholder: 'typebot_token_aqui',
        type: 'password',
        required: true,
        help: 'Token com permissao para iniciar e continuar sessoes no Typebot.'
      }
    ],
    checklist: ['Publique o bot', 'Copie o Public ID', 'Informe token da API', 'Ative a integracao']
  },
  {
    id: 'chatwoot',
    name: 'Chatwoot',
    tag: 'Atendimento humano',
    description: 'Sincroniza conversas WhatsApp com inbox Chatwoot e envia respostas dos agentes de volta.',
    icon: PlugZap,
    events: ['message.received', 'message.status'],
    outcome: 'Mensagens entram como conversas no Chatwoot e respostas de agentes saem pela instancia Wozapi.',
    fields: [
      {
        key: 'apiUrl',
        label: 'URL do Chatwoot',
        placeholder: 'https://app.chatwoot.com',
        type: 'text',
        required: true,
        help: 'URL base do Chatwoot Cloud ou Self-hosted.'
      },
      {
        key: 'apiToken',
        label: 'API Access Token',
        placeholder: 'chatwoot_token_aqui',
        type: 'password',
        required: true,
        help: 'Token do usuario/agente com acesso a conta e ao inbox.'
      },
      {
        key: 'accountId',
        label: 'Account ID',
        placeholder: '1',
        type: 'number',
        required: true,
        help: 'Numero da conta no Chatwoot. Aparece na URL /app/accounts/ID.'
      },
      {
        key: 'inboxId',
        label: 'Inbox ID',
        placeholder: '1',
        type: 'number',
        required: true,
        help: 'ID do inbox que recebera as conversas WhatsApp.'
      }
    ],
    checklist: ['Crie ou escolha um inbox', 'Copie Account ID e Inbox ID', 'Informe API Access Token', 'Salve para auto-registrar o webhook']
  }
];

type IntegrationData = {
  provider: string;
  enabled: boolean;
  config_json: string;
  updated_at?: string;
};

type Instance = {
  id: number;
  name: string;
  api_key?: string;
  status?: string;
  phone_connected?: string;
  phoneConnected?: string;
};

type WebhookRow = {
  id: number;
  name?: string;
  url?: string;
  events?: string[] | string;
  is_active?: boolean | number;
  max_attempts?: number;
};

const DEFAULT_FORM: Record<ProviderId, Record<string, string>> = {
  n8n: { apiUrl: '', apiToken: '' },
  typebot: { apiUrl: 'https://typebot.io', publicId: '', apiToken: '' },
  chatwoot: { apiUrl: 'https://app.chatwoot.com', apiToken: '', accountId: '', inboxId: '' }
};

const parseConfig = (value?: string) => {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
};

const parseEvents = (events: WebhookRow['events']) => {
  if (Array.isArray(events)) return events;
  if (!events) return [];
  try {
    const parsed = JSON.parse(events);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return String(events).split(',').map(item => item.trim()).filter(Boolean);
  }
};

const maskSecret = (value?: string) => {
  if (!value) return 'Nao disponivel';
  if (value.length <= 12) return `${value.slice(0, 4)}...`;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
};

export default function IntegrationManager({ apiFetch }: IntegrationManagerProps) {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [selectedInstanceId, setSelectedInstanceId] = useState<number | null>(null);
  const [integrations, setIntegrations] = useState<Record<string, IntegrationData>>({});
  const [webhooks, setWebhooks] = useState<WebhookRow[]>([]);
  const [editing, setEditing] = useState<Record<ProviderId, Record<string, string>>>(DEFAULT_FORM);
  const [activeProvider, setActiveProvider] = useState<ProviderId>('n8n');
  const [saving, setSaving] = useState<string | null>(null);
  const [creatingWebhook, setCreatingWebhook] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchInstances();
  }, []);

  useEffect(() => {
    if (selectedInstanceId) {
      fetchIntegrations();
      fetchWebhooks();
    }
  }, [selectedInstanceId]);

  const selectedInstance = instances.find(inst => Number(inst.id) === Number(selectedInstanceId));
  const selectedProvider = PROVIDERS.find(provider => provider.id === activeProvider) || PROVIDERS[0];
  const publicBaseUrl = typeof window !== 'undefined' ? window.location.origin : 'https://painel.wozapi.com.br';
  const instanceApiUrl = selectedInstance ? `${publicBaseUrl}/api/v1/instances/${selectedInstance.id}` : `${publicBaseUrl}/api/v1/instances/ID`;
  const chatwootWebhookUrl = selectedInstance ? `${publicBaseUrl}/api/v1/integrations/chatwoot/${selectedInstance.id}/webhook` : `${publicBaseUrl}/api/v1/integrations/chatwoot/ID/webhook`;

  const instanceApiOptions = () => ({
    headers: selectedInstance?.api_key ? { 'x-api-key': selectedInstance.api_key } : {}
  });

  const activeWebhook = useMemo(() => {
    return webhooks.find(hook => {
      const url = String(hook.url || '');
      const name = String(hook.name || '').toLowerCase();
      return name.includes(activeProvider) || url.includes(activeProvider) || (activeProvider === 'n8n' && url.includes('/webhook/'));
    });
  }, [webhooks, activeProvider]);

  const readiness = useMemo(() => {
    const form = editing[activeProvider] || {};
    const missingFields = selectedProvider.fields.filter(field => field.required && !String(form[field.key] || '').trim());
    const saved = Boolean(integrations[activeProvider]?.enabled);
    const webhookReady = activeProvider === 'typebot' ? true : activeProvider === 'chatwoot' ? saved : Boolean(activeWebhook);
    const apiKeyReady = Boolean(selectedInstance?.api_key);
    return {
      saved,
      webhookReady,
      apiKeyReady,
      missingFields,
      total: 4,
      done: [apiKeyReady, missingFields.length === 0, saved, webhookReady].filter(Boolean).length
    };
  }, [activeProvider, activeWebhook, editing, integrations, selectedInstance, selectedProvider]);

  const fetchInstances = async () => {
    try {
      const data = await apiFetch('/api/whatsapp/instances');
      const rows = Array.isArray(data) ? data : [];
      setInstances(rows);
      if (rows.length > 0) setSelectedInstanceId(current => current || rows[0].id);
    } catch {
      setInstances([]);
    }
  };

  const fetchIntegrations = async () => {
    if (!selectedInstanceId) return;
    setLoading(true);
    try {
      const result = await apiFetch(`/api/v1/instances/${selectedInstanceId}/integrations`, instanceApiOptions());
      const rows = Array.isArray(result) ? result : [];
      const map: Record<string, IntegrationData> = {};
      const editMap: Record<ProviderId, Record<string, string>> = { ...DEFAULT_FORM };

      for (const provider of PROVIDERS) {
        editMap[provider.id] = { ...DEFAULT_FORM[provider.id] };
      }

      for (const item of rows) {
        map[item.provider] = item;
        const config = parseConfig(item.config_json);
        const provider = PROVIDERS.find(entry => entry.id === item.provider);
        if (provider) {
          editMap[provider.id] = { ...editMap[provider.id] };
          for (const field of provider.fields) {
            editMap[provider.id][field.key] = String(config[field.key] ?? '');
          }
        }
      }

      for (const provider of PROVIDERS) {
        if (!map[provider.id]) map[provider.id] = { provider: provider.id, enabled: false, config_json: '{}' };
      }

      setIntegrations(map);
      setEditing(editMap);
    } catch {
      setIntegrations({});
    }
    setLoading(false);
  };

  const fetchWebhooks = async () => {
    if (!selectedInstanceId) return;
    try {
      const result = await apiFetch(`/api/v1/instances/${selectedInstanceId}/webhooks`, instanceApiOptions());
      setWebhooks(Array.isArray(result) ? result : []);
    } catch {
      setWebhooks([]);
    }
  };

  const updateField = (provider: ProviderId, key: string, value: string) => {
    setEditing(prev => ({
      ...prev,
      [provider]: { ...(prev[provider] || {}), [key]: value }
    }));
  };

  const copyText = async (key: string, text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      setMessage({ type: 'error', text: 'Nao foi possivel copiar automaticamente.' });
    }
  };

  const buildConfig = (provider: ProviderId) => {
    const fields = editing[provider] || {};
    const config: Record<string, any> = {};
    const definition = PROVIDERS.find(item => item.id === provider);
    for (const field of definition?.fields || []) {
      const value = fields[field.key] || '';
      config[field.key] = field.type === 'number' ? Number(value) || 0 : value.trim();
    }
    return config;
  };

  const saveIntegration = async (provider: ProviderId) => {
    if (!selectedInstanceId) return;
    const definition = PROVIDERS.find(item => item.id === provider);
    const config = buildConfig(provider);
    const missing = definition?.fields.filter(field => field.required && !String(config[field.key] || '').trim()) || [];
    if (missing.length) {
      setMessage({ type: 'error', text: `Preencha: ${missing.map(field => field.label).join(', ')}` });
      return;
    }

    setSaving(provider);
    setMessage(null);
    try {
      if (provider === 'chatwoot') {
        await apiFetch('/chatwoot/config', {
          ...instanceApiOptions(),
          method: 'PUT',
          body: JSON.stringify({ ...config, enabled: true })
        });
      } else {
        await apiFetch(`/api/v1/instances/${selectedInstanceId}/integrations/${provider}`, {
          ...instanceApiOptions(),
          method: 'PUT',
          body: JSON.stringify({ enabled: true, config })
        });
      }
      setMessage({ type: 'success', text: `${definition?.name || provider} salvo e ativado.` });
      await fetchIntegrations();
      await fetchWebhooks();
    } catch (err: any) {
      setMessage({ type: 'error', text: `Falha ao salvar: ${err?.message || 'erro inesperado'}` });
    }
    setSaving(null);
  };

  const toggleEnabled = async (provider: ProviderId, enabled: boolean) => {
    if (!selectedInstanceId) return;
    setMessage(null);
    try {
      const config = provider === activeProvider ? buildConfig(provider) : parseConfig(integrations[provider]?.config_json);
      await apiFetch(`/api/v1/instances/${selectedInstanceId}/integrations/${provider}`, {
        ...instanceApiOptions(),
        method: 'PUT',
        body: JSON.stringify({ enabled, config })
      });
      setMessage({ type: 'success', text: `${enabled ? 'Ativado' : 'Pausado'}: ${PROVIDERS.find(item => item.id === provider)?.name || provider}` });
      await fetchIntegrations();
    } catch (err: any) {
      setMessage({ type: 'error', text: `Falha ao alterar status: ${err?.message || 'erro inesperado'}` });
    }
  };

  const createWebhookForProvider = async (provider: ProviderId) => {
    if (!selectedInstanceId) return;
    const definition = PROVIDERS.find(item => item.id === provider);
    const form = editing[provider] || {};
    const url = provider === 'chatwoot' ? chatwootWebhookUrl : String(form.apiUrl || '').trim();
    if (!url) {
      setMessage({ type: 'error', text: 'Informe a URL antes de criar o webhook.' });
      return;
    }

    setCreatingWebhook(provider);
    setMessage(null);
    try {
      await apiFetch(`/api/v1/instances/${selectedInstanceId}/webhooks`, {
        ...instanceApiOptions(),
        method: 'POST',
        body: JSON.stringify({
          name: `${definition?.name || provider} - ${selectedInstance?.name || 'Instancia'}`,
          url,
          events: definition?.events || ['message.received'],
          retry_enabled: true,
          max_attempts: 5
        })
      });
      setMessage({ type: 'success', text: `Webhook de ${definition?.name || provider} criado.` });
      await fetchWebhooks();
    } catch (err: any) {
      setMessage({ type: 'error', text: `Falha ao criar webhook: ${err?.message || 'erro inesperado'}` });
    }
    setCreatingWebhook(null);
  };

  const sendTextExample = `curl -X POST ${instanceApiUrl}/send-text \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: ${selectedInstance?.api_key || 'woo_sua_api_key'}" \\
  -d '{"number":"5548999999999","text":"Ola, tudo certo?"}'`;

  const webhookExample = JSON.stringify({
    event: 'message.received',
    instance_id: selectedInstance?.id || 'ID',
    data: {
      message: {
        from: '5548999999999',
        text: 'Ola, tenho interesse'
      }
    }
  }, null, 2);

  const typebotExample = JSON.stringify({
    apiUrl: editing.typebot.apiUrl || 'https://typebot.io',
    publicId: editing.typebot.publicId || 'meu-bot-public-id',
    flow: 'message.received -> Typebot -> send-text'
  }, null, 2);

  const providerExamples: Record<ProviderId, { title: string; text: string }> = {
    n8n: { title: 'HTTP Request para responder', text: sendTextExample },
    typebot: { title: 'Como a sessao e iniciada', text: typebotExample },
    chatwoot: { title: 'Webhook de volta do Chatwoot', text: chatwootWebhookUrl }
  };

  if (!selectedInstanceId && instances.length === 0) {
    return (
      <div className="space-y-6">
        <header>
          <h2 className="text-3xl font-bold">Conectores</h2>
          <p className="text-slate-500">Crie uma instancia WhatsApp antes de ativar n8n, Typebot ou Chatwoot.</p>
        </header>
        <div className="rounded-md border-2 border-dashed border-slate-200 bg-white py-20 text-center">
          <KeyRound className="mx-auto mb-4 text-slate-300" size={42} />
          <h3 className="text-lg font-bold text-slate-900">Nenhuma instancia encontrada</h3>
          <p className="mt-2 text-sm text-slate-500">A integracao usa a API key e o webhook de uma instancia conectada.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h2 className="text-3xl font-bold">Conectores</h2>
          <p className="text-slate-500">Configure n8n, Typebot e Chatwoot com passos guiados, exemplos e webhooks prontos.</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <select
            value={selectedInstanceId || ''}
            onChange={event => setSelectedInstanceId(Number(event.target.value))}
            className="h-11 min-w-[260px] rounded-md border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none focus:border-primary focus:ring-4 focus:ring-primary/10"
          >
            {instances.map(inst => (
              <option key={inst.id} value={inst.id}>
                {inst.name} {(inst.phone_connected || inst.phoneConnected) ? `(+${inst.phone_connected || inst.phoneConnected})` : ''}
              </option>
            ))}
          </select>
          <button onClick={() => { fetchIntegrations(); fetchWebhooks(); }} className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-4 text-sm font-black text-slate-700 hover:bg-slate-50">
            <RefreshCw size={16} />
            Atualizar
          </button>
        </div>
      </header>

      {message && (
        <div className={`rounded-md border px-4 py-3 text-sm font-bold ${message.type === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
          {message.text}
        </div>
      )}

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-4">
        <div className="rounded-md border border-slate-200 bg-white p-5 xl:col-span-1">
          <p className="text-xs font-black uppercase text-slate-400">Instancia selecionada</p>
          <h3 className="mt-2 text-xl font-black text-slate-950">{selectedInstance?.name || 'Instancia'}</h3>
          <div className="mt-4 space-y-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-500">API key</span>
              <button onClick={() => copyText('api-key', selectedInstance?.api_key || '')} className="font-mono text-xs font-black text-primary">
                {copied === 'api-key' ? 'Copiada' : maskSecret(selectedInstance?.api_key)}
              </button>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-500">Webhooks</span>
              <span className="font-black text-slate-900">{webhooks.length}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-500">Conectores ativos</span>
              <span className="font-black text-slate-900">{Object.values(integrations).filter(item => item.enabled).length}</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3 xl:col-span-3">
          {PROVIDERS.map(provider => {
            const Icon = provider.icon;
            const enabled = Boolean(integrations[provider.id]?.enabled);
            const currentWebhook = webhooks.find(hook => {
              const url = String(hook.url || '');
              const name = String(hook.name || '').toLowerCase();
              return name.includes(provider.id) || url.includes(provider.id) || (provider.id === 'n8n' && url.includes('/webhook/'));
            });
            return (
              <button
                key={provider.id}
                onClick={() => setActiveProvider(provider.id)}
                className={`rounded-md border p-5 text-left transition ${activeProvider === provider.id ? 'border-primary bg-primary/5 ring-4 ring-primary/10' : 'border-slate-200 bg-white hover:border-slate-300'}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-md bg-slate-900 text-white">
                    <Icon size={20} />
                  </div>
                  <span className={`rounded px-2 py-1 text-[10px] font-black uppercase ${enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                    {enabled ? 'ativo' : 'pausado'}
                  </span>
                </div>
                <h3 className="mt-4 text-lg font-black text-slate-950">{provider.name}</h3>
                <p className="mt-1 text-xs font-bold uppercase text-slate-400">{provider.tag}</p>
                <p className="mt-3 min-h-[42px] text-sm text-slate-500">{provider.description}</p>
                <div className="mt-4 flex items-center gap-2 text-xs font-bold text-slate-500">
                  {provider.id === 'chatwoot' && enabled ? <CheckCircle2 size={15} className="text-emerald-600" /> : currentWebhook ? <CheckCircle2 size={15} className="text-emerald-600" /> : <AlertCircle size={15} className="text-amber-500" />}
                  {provider.id === 'typebot' ? 'Sem webhook externo obrigatorio' : provider.id === 'chatwoot' ? (enabled ? 'Auto-registro configurado' : 'Salve para registrar') : currentWebhook ? 'Webhook cadastrado' : 'Webhook pendente'}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_420px]">
        <div className="rounded-md border border-slate-200 bg-white">
          <div className="border-b border-slate-100 p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-xs font-black uppercase text-primary">{selectedProvider.tag}</p>
                <h3 className="mt-1 text-2xl font-black text-slate-950">{selectedProvider.name}</h3>
                <p className="mt-2 max-w-3xl text-sm text-slate-500">{selectedProvider.outcome}</p>
              </div>
              <label className="inline-flex items-center gap-3 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-black text-slate-700">
                <input
                  type="checkbox"
                  checked={Boolean(integrations[activeProvider]?.enabled)}
                  onChange={event => toggleEnabled(activeProvider, event.target.checked)}
                  className="h-5 w-5 accent-primary"
                />
                Integracao ativa
              </label>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 p-6 lg:grid-cols-[1fr_320px]">
            <div className="space-y-4">
              {selectedProvider.fields.map(field => (
                <label key={field.key} className="block">
                  <span className="mb-1 flex items-center gap-2 text-xs font-black uppercase text-slate-500">
                    {field.label}
                    {field.required && <span className="rounded bg-red-50 px-1.5 py-0.5 text-[9px] text-red-600">obrigatorio</span>}
                  </span>
                  <input
                    type={field.type}
                    value={editing[activeProvider]?.[field.key] || ''}
                    onChange={event => updateField(activeProvider, field.key, event.target.value)}
                    placeholder={field.placeholder}
                    className="h-11 w-full rounded-md border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-900 outline-none transition focus:border-primary focus:bg-white focus:ring-4 focus:ring-primary/10"
                  />
                  <span className="mt-1 block text-xs leading-relaxed text-slate-500">{field.help}</span>
                </label>
              ))}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button
                  onClick={() => saveIntegration(activeProvider)}
                  disabled={saving === activeProvider || loading}
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-black text-white shadow-sm hover:bg-primary/90 disabled:opacity-50"
                >
                  {saving === activeProvider ? <Loader2 className="animate-spin" size={18} /> : <Save size={18} />}
                  {saving === activeProvider ? 'Salvando...' : 'Salvar e ativar'}
                </button>
                {activeProvider === 'n8n' && (
                  <button
                    onClick={() => createWebhookForProvider(activeProvider)}
                    disabled={creatingWebhook === activeProvider}
                    className="inline-flex h-12 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-4 text-sm font-black text-slate-800 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {creatingWebhook === activeProvider ? <Loader2 className="animate-spin" size={18} /> : <Webhook size={18} />}
                    Criar webhook
                  </button>
                )}
              </div>
            </div>

            <aside className="space-y-4">
              <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-black text-slate-900">Prontidao</p>
                  <span className="rounded bg-white px-2 py-1 text-xs font-black text-slate-700">{readiness.done}/{readiness.total}</span>
                </div>
                <div className="mt-4 space-y-3">
                  {[
                    ['API key da instancia', readiness.apiKeyReady],
                    ['Campos obrigatorios', readiness.missingFields.length === 0],
                    ['Configuracao salva', readiness.saved],
                    [activeProvider === 'typebot' ? 'Rota interna ativa' : activeProvider === 'chatwoot' ? 'Webhook Chatwoot configurado' : 'Webhook criado', readiness.webhookReady]
                  ].map(([label, ok]) => (
                    <div key={String(label)} className="flex items-center gap-2 text-sm">
                      {ok ? <CheckCircle2 size={16} className="text-emerald-600" /> : <AlertCircle size={16} className="text-amber-500" />}
                      <span className={ok ? 'font-bold text-slate-800' : 'font-bold text-slate-500'}>{label}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-md border border-slate-200 bg-white p-4">
                <p className="text-sm font-black text-slate-900">Passo a passo</p>
                <div className="mt-3 space-y-2">
                  {selectedProvider.checklist.map((item, index) => (
                    <div key={item} className="flex gap-3 rounded-md bg-slate-50 p-3">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-primary text-[10px] font-black text-white">{index + 1}</span>
                      <span className="text-xs font-bold leading-relaxed text-slate-700">{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            </aside>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-md border border-slate-200 bg-white">
            <div className="border-b border-slate-100 p-5">
              <h3 className="text-lg font-black text-slate-950">Copiar e colar</h3>
              <p className="text-sm text-slate-500">Dados que o cliente normalmente pede durante a configuracao.</p>
            </div>
            <div className="divide-y divide-slate-100">
              {[
                ['URL base da API', publicBaseUrl],
                ['Endpoint send-text', `${instanceApiUrl}/send-text`],
                ['Endpoint send-media', `${instanceApiUrl}/send-media`],
                ['API key', selectedInstance?.api_key || '']
              ].map(([label, value]) => (
                <button key={label} onClick={() => copyText(label, value)} className="flex w-full items-center justify-between gap-3 p-4 text-left hover:bg-slate-50">
                  <div className="min-w-0">
                    <p className="text-xs font-black uppercase text-slate-400">{label}</p>
                    <p className="mt-1 truncate font-mono text-xs font-bold text-slate-700">{label === 'API key' ? maskSecret(value) : value}</p>
                  </div>
                  <Clipboard className={copied === label ? 'text-primary' : 'text-slate-400'} size={18} />
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-md border border-slate-200 bg-white p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-black text-slate-950">{providerExamples[activeProvider].title}</h3>
                <p className="text-sm text-slate-500">Exemplo atualizado com a instancia selecionada.</p>
              </div>
              <button onClick={() => copyText(`example-${activeProvider}`, providerExamples[activeProvider].text)} className="rounded-md bg-slate-900 p-2 text-white hover:bg-primary">
                <Clipboard size={18} />
              </button>
            </div>
            <pre className="max-h-72 overflow-auto rounded-md bg-slate-950 p-4 text-xs font-semibold leading-relaxed text-slate-100">
              <code>{providerExamples[activeProvider].text}</code>
            </pre>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div className="rounded-md border border-slate-200 bg-white">
          <div className="flex items-start justify-between gap-4 border-b border-slate-100 p-5">
            <div>
              <h3 className="text-lg font-black text-slate-950">Webhooks cadastrados</h3>
              <p className="text-sm text-slate-500">Teste pelo monitor da plataforma quando precisar validar entrega.</p>
            </div>
            <button onClick={fetchWebhooks} className="rounded-md border border-slate-200 p-2 text-slate-600 hover:bg-slate-50">
              <RefreshCw size={18} />
            </button>
          </div>
          <div className="divide-y divide-slate-100">
            {webhooks.map(hook => (
              <div key={hook.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-black text-slate-900">{hook.name || `Webhook #${hook.id}`}</p>
                    <p className="mt-1 truncate font-mono text-xs text-slate-500">{hook.url}</p>
                  </div>
                  <span className={`shrink-0 rounded px-2 py-1 text-[10px] font-black uppercase ${hook.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                    {hook.is_active ? 'ativo' : 'pausado'}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-1">
                  {parseEvents(hook.events).slice(0, 4).map(event => (
                    <span key={event} className="rounded bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600">{event}</span>
                  ))}
                </div>
              </div>
            ))}
            {webhooks.length === 0 && (
              <div className="p-10 text-center">
                <Webhook className="mx-auto mb-3 text-slate-300" size={34} />
                <p className="text-sm font-bold text-slate-500">Nenhum webhook criado ainda.</p>
              </div>
            )}
          </div>
        </div>

        <div className="rounded-md border border-slate-200 bg-white p-5">
          <h3 className="text-lg font-black text-slate-950">Payload de evento</h3>
          <p className="mt-1 text-sm text-slate-500">Modelo simples para explicar ao integrador o que chega no n8n, CRM ou backend.</p>
          <pre className="mt-4 max-h-80 overflow-auto rounded-md bg-slate-950 p-4 text-xs font-semibold leading-relaxed text-slate-100">
            <code>{webhookExample}</code>
          </pre>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <button onClick={() => copyText('payload-example', webhookExample)} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 hover:bg-slate-50">
              <Clipboard size={16} />
              Copiar payload
            </button>
            <a href="#wooapi_monitor" className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-900 px-4 py-3 text-sm font-black text-white no-underline hover:bg-primary">
              <ExternalLink size={16} />
              Ver logs
            </a>
          </div>
        </div>
      </section>

      <section className="rounded-md border border-amber-200 bg-amber-50 p-5">
        <div className="flex gap-3">
          <AlertCircle className="mt-0.5 shrink-0 text-amber-600" size={20} />
          <div>
            <h3 className="font-black text-amber-900">Diagnostico do que foi simplificado</h3>
            <p className="mt-1 text-sm leading-relaxed text-amber-800">
              Antes a configuracao dependia de copiar endpoints manualmente em abas diferentes. Agora a tela mostra a instancia, API key mascarada, URLs prontas, campos explicados, status de prontidao, webhook n8n e exemplos por conector no mesmo fluxo.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
