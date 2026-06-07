import React, { useState, useEffect } from 'react';

interface IntegrationManagerProps {
  apiFetch: (url: string, options?: any) => Promise<any>;
}

const PROVIDERS = [
  {
    id: 'n8n',
    name: 'n8n',
    description: 'Automatize fluxos de trabalho conectando o WooAPI com centenas de serviços.',
    fields: [
      { key: 'apiUrl', label: 'URL do Webhook n8n', placeholder: 'https://seu-n8n.example.com/webhook/wooapi', type: 'text' },
      { key: 'apiToken', label: 'Token de autenticação', placeholder: 'n8n_token_aqui', type: 'password' }
    ]
  },
  {
    id: 'typebot',
    name: 'Typebot',
    description: 'Crie chatbots conversacionais com Typebot e conecte ao WhatsApp.',
    fields: [
      { key: 'apiUrl', label: 'URL do Typebot', placeholder: 'https://typebot.io', type: 'text' },
      { key: 'publicId', label: 'Public ID do Typebot', placeholder: 'meu-typebot-public-id', type: 'text' },
      { key: 'apiToken', label: 'Token do Typebot', placeholder: 'typebot_token_aqui', type: 'password' }
    ]
  },
  {
    id: 'chatwoot',
    name: 'Chatwoot',
    description: 'Sincronize conversas do WhatsApp com o Chatwoot para atendimento em equipe.',
    fields: [
      { key: 'apiUrl', label: 'URL do Chatwoot', placeholder: 'https://app.chatwoot.com', type: 'text' },
      { key: 'apiToken', label: 'API Access Token', placeholder: 'chatwoot_token_aqui', type: 'password' },
      { key: 'accountId', label: 'Account ID', placeholder: '1', type: 'number' },
      { key: 'inboxId', label: 'Inbox ID', placeholder: '1', type: 'number' }
    ]
  }
];

type IntegrationData = {
  provider: string;
  enabled: boolean;
  config_json: string;
  config?: Record<string, any>;
};

export default function IntegrationManager({ apiFetch }: IntegrationManagerProps) {
  const [instances, setInstances] = useState<any[]>([]);
  const [selectedInstanceId, setSelectedInstanceId] = useState<number | null>(null);
  const [integrations, setIntegrations] = useState<Record<string, IntegrationData>>({});
  const [editing, setEditing] = useState<Record<string, Record<string, string>>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchInstances();
  }, []);

  useEffect(() => {
    if (selectedInstanceId) fetchIntegrations();
  }, [selectedInstanceId]);

  const selectedInstance = instances.find((inst: any) => Number(inst.id) === Number(selectedInstanceId));

  const instanceApiOptions = () => ({
    headers: selectedInstance?.api_key ? { 'x-api-key': selectedInstance.api_key } : {}
  });

  const fetchInstances = async () => {
    try {
      const data = await apiFetch('/api/whatsapp/instances');
      setInstances(Array.isArray(data) ? data : []);
      if (Array.isArray(data) && data.length > 0) {
        setSelectedInstanceId(data[0].id);
      }
    } catch { setInstances([]); }
  };

  const fetchIntegrations = async () => {
    setLoading(true);
    try {
      const result = await apiFetch(`/api/v1/instances/${selectedInstanceId}/integrations`, instanceApiOptions());
      const data = Array.isArray(result) ? result : [];
      const map: Record<string, IntegrationData> = {};
      const editMap: Record<string, Record<string, string>> = {};
      for (const item of data) {
        map[item.provider] = item;
        const config = (() => { try { return JSON.parse(item.config_json || '{}'); } catch { return {}; } })();
        const fields: Record<string, string> = {};
        for (const p of PROVIDERS) {
          if (p.id === item.provider) {
            for (const f of p.fields) {
              fields[f.key] = String(config[f.key] || '');
            }
          }
        }
        editMap[item.provider] = fields;
      }
      for (const p of PROVIDERS) {
        if (!editMap[p.id]) editMap[p.id] = {};
        if (!map[p.id]) map[p.id] = { provider: p.id, enabled: false, config_json: '{}' };
      }
      setIntegrations(map);
      setEditing(editMap);
    } catch { setIntegrations({}); setEditing({}); }
    setLoading(false);
  };

  const saveIntegration = async (provider: string) => {
    setSaving(provider);
    setMessage(null);
    const fields = editing[provider] || {};
    const config: Record<string, any> = {};
    const p = PROVIDERS.find(x => x.id === provider);
    if (p) {
      for (const f of p.fields) {
        const val = fields[f.key] || '';
        if (f.type === 'number') config[f.key] = Number(val) || 0;
        else config[f.key] = val;
      }
    }
    try {
      await apiFetch(`/api/v1/instances/${selectedInstanceId}/integrations/${provider}`, {
        ...instanceApiOptions(),
        method: 'PUT',
        body: JSON.stringify({ enabled: true, config })
      });
      setMessage({ type: 'success', text: `${p?.name || provider} configurado com sucesso` });
      fetchIntegrations();
    } catch (err: any) {
      setMessage({ type: 'error', text: `Erro: ${err?.message || 'Falha ao salvar'}` });
    }
    setSaving(null);
  };

  const toggleEnabled = async (provider: string, enabled: boolean) => {
    setMessage(null);
    try {
      const existing = integrations[provider];
      const config = (() => { try { return JSON.parse(existing?.config_json || '{}'); } catch { return {}; } })();
      await apiFetch(`/api/v1/instances/${selectedInstanceId}/integrations/${provider}`, {
        ...instanceApiOptions(),
        method: 'PUT',
        body: JSON.stringify({ enabled, config })
      });
      setMessage({ type: 'success', text: `${enabled ? 'Ativado' : 'Desativado'}: ${provider}` });
      fetchIntegrations();
    } catch (err: any) {
      setMessage({ type: 'error', text: `Erro: ${err?.message || 'Falha ao alterar'}` });
    }
  };

  const updateField = (provider: string, key: string, value: string) => {
    setEditing(prev => ({
      ...prev,
      [provider]: { ...(prev[provider] || {}), [key]: value }
    }));
  };

  const providerColor = (id: string) => {
    const colors: Record<string, string> = {
      n8n: 'bg-red-50 border-red-200 text-red-700',
      typebot: 'bg-blue-50 border-blue-200 text-blue-700',
      chatwoot: 'bg-emerald-50 border-emerald-200 text-emerald-700'
    };
    return colors[id] || 'bg-slate-50 border-slate-200 text-slate-700';
  };

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold">Conectores</h2>
          <p className="text-slate-500">Configure integrações com n8n, Typebot e Chatwoot.</p>
        </div>
      </header>

      <div className="flex items-center gap-4">
        <label className="text-sm font-bold text-slate-600">Instância:</label>
        <select
          value={selectedInstanceId || ''}
          onChange={e => setSelectedInstanceId(Number(e.target.value))}
          className="px-4 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        >
          {instances.map((inst: any) => (
            <option key={inst.id} value={inst.id}>{inst.name} {inst.phone_connected ? `(+${inst.phone_connected})` : ''}</option>
          ))}
        </select>
      </div>

      {message && (
        <div className={`p-4 rounded-xl ${message.type === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          <p className="text-sm font-bold">{message.text}</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {PROVIDERS.map((provider) => {
          const data = integrations[provider.id];
          const enabled = data?.enabled || false;
          const isSaving = saving === provider.id;
          return (
            <div key={provider.id} className={`rounded-2xl border-2 p-6 flex flex-col ${enabled ? 'border-primary bg-primary/5' : 'border-slate-200 bg-white'}`}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xl font-bold">{provider.name}</h3>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={e => toggleEnabled(provider.id, e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-slate-200 rounded-full peer peer-checked:bg-primary peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:start-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all" />
                </label>
              </div>

              <p className="text-sm text-slate-500 mb-6">{provider.description}</p>

              <div className="flex-1 space-y-4">
                {provider.fields.map((field) => (
                  <div key={field.key}>
                    <label className="text-xs font-bold text-slate-600 mb-1 block">{field.label}</label>
                    <input
                      type={field.type}
                      value={editing[provider.id]?.[field.key] || ''}
                      onChange={e => updateField(provider.id, field.key, e.target.value)}
                      placeholder={field.placeholder}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  </div>
                ))}
              </div>

              <button
                onClick={() => saveIntegration(provider.id)}
                disabled={isSaving}
                className="mt-6 w-full py-3 bg-primary text-white font-bold rounded-xl hover:bg-primary/90 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isSaving ? 'Salvando...' : `Configurar ${provider.name}`}
              </button>
            </div>
          );
        })}
      </div>

      {!selectedInstanceId && (
        <div className="py-20 text-center border-2 border-dashed border-slate-200 rounded-3xl">
          <div className="w-16 h-16 bg-slate-50 text-slate-300 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 20h16"/><path d="M4 20V4"/><path d="M20 20V8"/><path d="M8 12l4-4 4 4"/></svg>
          </div>
          <h3 className="text-lg font-bold text-slate-800">Nenhuma instância</h3>
          <p className="text-slate-500 mt-2">Crie uma instância WhatsApp primeiro.</p>
        </div>
      )}
    </div>
  );
}
