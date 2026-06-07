import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { XCircle, Send, Activity, Webhook, Radio, Loader2, MousePointerClick, ListChecks, Terminal } from 'lucide-react';

interface Instance {
  id: number;
  name: string;
  status: string;
  qr?: string;
  phoneConnected?: string;
  phone_connected?: string;
  profileName?: string;
  profile_name?: string;
  api_key?: string;
}

interface InstanceTesterProps {
  instance: Instance;
  apiFetch: (url: string, options?: any) => Promise<any>;
  onClose: () => void;
}

type TesterTab = 'status' | 'send' | 'interactive' | 'webhook' | 'events' | 'logs';

export default function InstanceTester({ instance, apiFetch, onClose }: InstanceTesterProps) {
  const [activeTab, setActiveTab] = useState<TesterTab>('status');
  const [statusResult, setStatusResult] = useState<any>(null);
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [pingLoading, setPingLoading] = useState(false);

  const [testPhone, setTestPhone] = useState('');
  const [testMessage, setTestMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<any>(null);
  const [interactiveMode, setInteractiveMode] = useState<'buttons' | 'menu'>('buttons');
  const [interactiveTitle, setInteractiveTitle] = useState('Atendimento WooAPI');
  const [interactiveText, setInteractiveText] = useState('Escolha uma opcao para continuar.');
  const [interactiveFooter, setInteractiveFooter] = useState('Mensagem experimental');
  const [buttons, setButtons] = useState([
    { text: 'Falar agora', url: 'https://wa.me/5548933806836' },
    { text: 'Ver planos', url: 'https://wooapi.com.br/planos' },
    { text: 'Encerrar', url: '' }
  ]);
  const [menuRows, setMenuRows] = useState([
    { title: 'Suporte', description: 'Abrir atendimento' },
    { title: 'Comercial', description: 'Ver propostas' },
    { title: 'Financeiro', description: 'Segunda via e pagamentos' }
  ]);
  const [interactiveSending, setInteractiveSending] = useState(false);
  const [interactiveResult, setInteractiveResult] = useState<any>(null);

  const [webhooks, setWebhooks] = useState<any[]>([]);
  const [webhookLoading, setWebhookLoading] = useState(false);
  const [testingWebhook, setTestingWebhook] = useState<number | null>(null);

  const [events, setEvents] = useState<{ time: string; event: string; data: string }[]>([]);
  const eventsEndRef = useRef<HTMLDivElement>(null);
  const [logs, setLogs] = useState<any[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  useEffect(() => {
    if (activeTab === 'status') fetchStatus();
    if (activeTab === 'webhook') fetchWebhooks();
    if (activeTab === 'logs') fetchLogs();
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'logs') return;
    const interval = window.setInterval(fetchLogs, 5000);
    return () => window.clearInterval(interval);
  }, [activeTab, instance.id]);

  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  const fetchStatus = async () => {
    try {
      const result = await apiFetch(`/api/whatsapp/instances/${instance.id}`);
      setStatusResult(result);
    } catch { /* ignore */ }
  };

  const testPing = async () => {
    setPingLoading(true);
    const start = Date.now();
    try {
      await apiFetch(`/api/whatsapp/instances/${instance.id}`);
      setPingMs(Date.now() - start);
    } catch {
      setPingMs(-1);
    }
    setPingLoading(false);
  };

  const fetchWebhooks = async () => {
    setWebhookLoading(true);
    try {
      const result = await apiFetch(`/api/whatsapp/instances/${instance.id}/webhooks`);
      setWebhooks(Array.isArray(result) ? result : []);
    } catch { setWebhooks([]); }
    setWebhookLoading(false);
  };

  const testWebhook = async (webhookId: number) => {
    setTestingWebhook(webhookId);
    try {
      await apiFetch(`/api/whatsapp/instances/${instance.id}/webhooks/${webhookId}/test`, { method: 'POST' });
    } catch { /* ignore */ }
    setTestingWebhook(null);
  };

  const fetchLogs = async () => {
    setLogsLoading(true);
    try {
      const result = await apiFetch(`/api/whatsapp/instances/${instance.id}/live-logs?limit=150`);
      setLogs(Array.isArray(result?.all) ? result.all : []);
    } catch {
      setLogs([]);
    }
    setLogsLoading(false);
  };

  const sendTestMessage = async () => {
    if (!testPhone || !testMessage) return;
    setSending(true);
    setSendResult(null);
    try {
      const result = await apiFetch('/api/whatsapp/send', {
        method: 'POST',
        body: JSON.stringify({
          instanceId: instance.id,
          phone: testPhone.replace(/\D/g, ''),
          message: testMessage
        })
      });
      setSendResult(result);
      addEvent('message.sent', `Test message to ${testPhone}`);
    } catch (err: any) {
      setSendResult({ error: String(err?.message || err) });
    }
    setSending(false);
  };

  const sendInteractiveTest = async () => {
    if (!testPhone || !interactiveText) return;
    setInteractiveSending(true);
    setInteractiveResult(null);
    try {
      const endpoint = interactiveMode === 'buttons' ? '/api/whatsapp/send-buttons' : '/api/whatsapp/send-menu';
      const body = interactiveMode === 'buttons'
        ? {
            instanceId: instance.id,
            phone: testPhone.replace(/\D/g, ''),
            title: interactiveTitle,
            text: interactiveText,
            footer: interactiveFooter,
            buttons: buttons
              .filter(button => button.text.trim())
              .map((button, index) => ({
                id: `btn_${index + 1}`,
                text: button.text.trim(),
                ...(button.url.trim() ? { url: button.url.trim() } : {})
              }))
          }
        : {
            instanceId: instance.id,
            phone: testPhone.replace(/\D/g, ''),
            title: interactiveTitle || 'Menu',
            text: interactiveText,
            footer: interactiveFooter,
            buttonText: 'Ver opcoes',
            rows: menuRows.filter(row => row.title).map((row, index) => ({ id: `row_${index + 1}`, ...row }))
          };
      const result = await apiFetch(endpoint, {
        method: 'POST',
        body: JSON.stringify(body)
      });
      setInteractiveResult(result);
      addEvent(interactiveMode === 'buttons' ? 'buttons.sent' : 'menu.sent', `Interactive test to ${testPhone}`);
    } catch (err: any) {
      setInteractiveResult({ error: String(err?.message || err) });
    }
    setInteractiveSending(false);
  };

  const addEvent = (event: string, data: string) => {
    setEvents(prev => [...prev.slice(-99), { time: new Date().toLocaleTimeString(), event, data }]);
  };

  const tabClass = (tab: TesterTab) =>
    `px-4 py-2 text-xs font-bold rounded-lg transition-colors ${
      activeTab === tab ? 'bg-primary text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
    }`;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.9, opacity: 0, y: 20 }}
        onClick={e => e.stopPropagation()}
        className="bg-white w-full max-w-3xl rounded-3xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col"
      >
        <div className="flex items-center justify-between p-6 border-b border-slate-100">
          <div>
            <h3 className="text-xl font-bold">Testar Instância</h3>
            <p className="text-sm text-slate-500">{instance.name}</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-full text-slate-400 transition-colors">
            <XCircle size={24} />
          </button>
        </div>

        <div className="flex gap-2 px-6 pt-4 pb-2 border-b border-slate-100">
          <button className={tabClass('status')} onClick={() => setActiveTab('status')}>
            <Activity size={14} className="inline mr-1" /> Status
          </button>
          <button className={tabClass('send')} onClick={() => setActiveTab('send')}>
            <Send size={14} className="inline mr-1" /> Enviar
          </button>
          <button className={tabClass('webhook')} onClick={() => setActiveTab('webhook')}>
            <Webhook size={14} className="inline mr-1" /> Webhook
          </button>
          <button className={tabClass('events')} onClick={() => setActiveTab('events')}>
            <Radio size={14} className="inline mr-1" /> Eventos
          </button>
          <button className={tabClass('logs')} onClick={() => setActiveTab('logs')}>
            <Terminal size={14} className="inline mr-1" /> Logs
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'status' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-50 rounded-xl p-4">
                  <p className="text-xs text-slate-500 mb-1">Status</p>
                  <p className="text-lg font-bold">{statusResult?.status || instance.status}</p>
                </div>
                <div className="bg-slate-50 rounded-xl p-4">
                  <p className="text-xs text-slate-500 mb-1">Telefone</p>
                  <p className="text-lg font-bold">{instance.phoneConnected || instance.phone_connected || '-'}</p>
                </div>
                <div className="bg-slate-50 rounded-xl p-4">
                  <p className="text-xs text-slate-500 mb-1">Perfil</p>
                  <p className="text-lg font-bold truncate">{instance.profileName || instance.profile_name || '-'}</p>
                </div>
                <div className="bg-slate-50 rounded-xl p-4">
                  <p className="text-xs text-slate-500 mb-1">API Key</p>
                  <p className="text-xs font-mono truncate">{instance.api_key ? `${instance.api_key.slice(0, 16)}...` : '-'}</p>
                </div>
              </div>
              <button
                onClick={testPing}
                disabled={pingLoading}
                className="w-full py-3 bg-primary text-white font-bold rounded-xl hover:bg-primary/90 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {pingLoading ? <Loader2 size={18} className="animate-spin" /> : <Activity size={18} />}
                {pingLoading ? 'Testando...' : pingMs !== null ? `${pingMs} ms` : 'Testar Conexão'}
              </button>
            </div>
          )}

          {activeTab === 'send' && (
            <div className="space-y-4">
              <div>
                <label className="text-xs font-bold text-slate-600 mb-1 block">Telefone (com DDD)</label>
                <input
                  type="text"
                  value={testPhone}
                  onChange={e => setTestPhone(e.target.value)}
                  placeholder="5511999999999"
                  className="w-full px-4 py-3 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="text-xs font-bold text-slate-600 mb-1 block">Mensagem</label>
                <textarea
                  value={testMessage}
                  onChange={e => setTestMessage(e.target.value)}
                  placeholder="Digite a mensagem de teste..."
                  rows={3}
                  className="w-full px-4 py-3 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
                />
              </div>
              <button
                onClick={sendTestMessage}
                disabled={sending || !testPhone || !testMessage}
                className="w-full py-3 bg-primary text-white font-bold rounded-xl hover:bg-primary/90 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
                {sending ? 'Enviando...' : 'Enviar Mensagem Teste'}
              </button>
              {sendResult && (
                <div className={`p-4 rounded-xl ${sendResult.error ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>
                  <p className="text-sm font-bold">{sendResult.error ? 'Falha' : 'Enviado com sucesso'}</p>
                  <pre className="text-xs mt-1 overflow-auto max-h-20">{JSON.stringify(sendResult, null, 2)}</pre>
                </div>
              )}
            </div>
          )}

          {activeTab === 'interactive' && (
            <div className="space-y-4">
              <div className="flex rounded-xl bg-slate-100 p-1">
                <button
                  onClick={() => setInteractiveMode('buttons')}
                  className={`flex-1 rounded-lg px-3 py-2 text-xs font-bold transition-colors ${interactiveMode === 'buttons' ? 'bg-white text-primary shadow-sm' : 'text-slate-500'}`}
                >
                  <MousePointerClick size={14} className="inline mr-1" /> Botoes
                </button>
                <button
                  onClick={() => setInteractiveMode('menu')}
                  className={`flex-1 rounded-lg px-3 py-2 text-xs font-bold transition-colors ${interactiveMode === 'menu' ? 'bg-white text-primary shadow-sm' : 'text-slate-500'}`}
                >
                  <ListChecks size={14} className="inline mr-1" /> Menu
                </button>
              </div>

              <div className="grid gap-4 md:grid-cols-[1fr_260px]">
                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-bold text-slate-600 mb-1 block">Telefone (com DDD)</label>
                    <input
                      type="text"
                      value={testPhone}
                      onChange={e => setTestPhone(e.target.value)}
                      placeholder="5511999999999"
                      className="w-full px-4 py-3 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-600 mb-1 block">Titulo</label>
                    <input
                      type="text"
                      value={interactiveTitle}
                      onChange={e => setInteractiveTitle(e.target.value)}
                      className="w-full px-4 py-3 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-600 mb-1 block">Texto</label>
                    <textarea
                      value={interactiveText}
                      onChange={e => setInteractiveText(e.target.value)}
                      rows={3}
                      className="w-full px-4 py-3 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-600 mb-1 block">Rodape</label>
                    <input
                      type="text"
                      value={interactiveFooter}
                      onChange={e => setInteractiveFooter(e.target.value)}
                      className="w-full px-4 py-3 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  </div>

                  {interactiveMode === 'buttons' ? (
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-slate-600 block">Botoes</label>
                      {buttons.map((button, index) => (
                        <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1.35fr]">
                          <input
                            type="text"
                            value={button.text}
                            onChange={e => setButtons(prev => prev.map((item, itemIndex) => itemIndex === index ? { ...item, text: e.target.value } : item))}
                            placeholder={`Botao ${index + 1}`}
                            className="w-full px-4 py-3 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                          />
                          <input
                            type="url"
                            value={button.url}
                            onChange={e => setButtons(prev => prev.map((item, itemIndex) => itemIndex === index ? { ...item, url: e.target.value } : item))}
                            placeholder="https://..."
                            className="w-full px-4 py-3 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                          />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-slate-600 block">Linhas do menu</label>
                      {menuRows.map((row, index) => (
                        <div key={index} className="grid grid-cols-2 gap-2">
                          <input
                            type="text"
                            value={row.title}
                            onChange={e => setMenuRows(prev => prev.map((item, itemIndex) => itemIndex === index ? { ...item, title: e.target.value } : item))}
                            placeholder={`Opcao ${index + 1}`}
                            className="px-4 py-3 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                          />
                          <input
                            type="text"
                            value={row.description}
                            onChange={e => setMenuRows(prev => prev.map((item, itemIndex) => itemIndex === index ? { ...item, description: e.target.value } : item))}
                            placeholder="Descricao"
                            className="px-4 py-3 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="rounded-xl bg-white p-4 shadow-sm">
                    {interactiveTitle && <p className="text-sm font-black text-slate-900">{interactiveTitle}</p>}
                    <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{interactiveText}</p>
                    {interactiveMode === 'buttons' ? (
                      <div className="mt-3 space-y-2">
                        {buttons.filter(button => button.text.trim()).map((button, index) => (
                          <div key={index} className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-center text-xs font-black text-primary">
                            {button.text}
                            {button.url.trim() && <span className="ml-1 text-[10px] font-bold text-slate-400">URL</span>}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-3 rounded-lg border border-slate-200">
                        {menuRows.filter(row => row.title).map((row, index) => (
                          <div key={index} className="border-b border-slate-100 px-3 py-2 last:border-b-0">
                            <p className="text-xs font-black text-slate-800">{row.title}</p>
                            <p className="text-[11px] text-slate-500">{row.description}</p>
                          </div>
                        ))}
                      </div>
                    )}
                    {interactiveFooter && <p className="mt-3 text-[11px] font-bold text-slate-400">{interactiveFooter}</p>}
                  </div>
                </div>
              </div>

              <button
                onClick={sendInteractiveTest}
                disabled={interactiveSending || !testPhone || !interactiveText}
                className="w-full py-3 bg-primary text-white font-bold rounded-xl hover:bg-primary/90 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {interactiveSending ? <Loader2 size={18} className="animate-spin" /> : interactiveMode === 'buttons' ? <MousePointerClick size={18} /> : <ListChecks size={18} />}
                {interactiveSending ? 'Enviando...' : interactiveMode === 'buttons' ? 'Enviar botoes' : 'Enviar menu'}
              </button>

              {interactiveResult && (
                <div className={`p-4 rounded-xl ${interactiveResult.error ? 'bg-red-50 text-red-700' : interactiveResult.fallbackUsed ? 'bg-amber-50 text-amber-700' : 'bg-green-50 text-green-700'}`}>
                  <p className="text-sm font-bold">{interactiveResult.error ? 'Falha' : interactiveResult.fallbackUsed ? 'Enviado com fallback' : 'Enviado com sucesso'}</p>
                  <pre className="text-xs mt-1 overflow-auto max-h-24">{JSON.stringify(interactiveResult, null, 2)}</pre>
                </div>
              )}
            </div>
          )}

          {activeTab === 'webhook' && (
            <div className="space-y-3">
              {webhookLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 size={24} className="animate-spin text-slate-400" />
                </div>
              ) : webhooks.length === 0 ? (
                <div className="text-center py-8 text-slate-500">
                  <Webhook size={32} className="mx-auto mb-2 opacity-50" />
                  <p className="text-sm font-bold">Nenhum webhook configurado</p>
                  <p className="text-xs">Configure webhooks na aba de Instâncias</p>
                </div>
              ) : (
                webhooks.map((hook: any) => (
                  <div key={hook.id} className="flex items-center justify-between bg-slate-50 rounded-xl p-4">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold">{hook.name || 'Webhook'}</p>
                      <p className="text-xs text-slate-500 truncate">{hook.url}</p>
                      <p className="text-xs text-slate-400 mt-1">
                        {hook.is_active ? (
                          <span className="text-green-600 font-bold">Ativo</span>
                        ) : (
                          <span className="text-slate-400">Inativo</span>
                        )}
                        {' · '}
                        {hook.events && hook.events.length > 0
                          ? hook.events.join(', ')
                          : 'Todos os eventos'}
                      </p>
                    </div>
                    <button
                      onClick={() => testWebhook(hook.id)}
                      disabled={testingWebhook === hook.id}
                      className="ml-4 px-4 py-2 bg-primary text-white text-xs font-bold rounded-lg hover:bg-primary/90 transition-all disabled:opacity-50"
                    >
                      {testingWebhook === hook.id ? <Loader2 size={14} className="animate-spin" /> : 'Testar'}
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {activeTab === 'events' && (
            <div className="space-y-2">
              <div className="text-xs text-slate-500 mb-2">
                Eventos em tempo real aparecerão abaixo conforme são recebidos via WebSocket.
              </div>
              {events.length === 0 ? (
                <div className="text-center py-8 text-slate-500">
                  <Radio size={32} className="mx-auto mb-2 opacity-50" />
                  <p className="text-sm font-bold">Nenhum evento ainda</p>
                  <p className="text-xs">Envie uma mensagem ou aguarde eventos da instância</p>
                </div>
              ) : (
                <div className="space-y-1 max-h-60 overflow-y-auto">
                  {events.map((ev, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs p-2 bg-slate-50 rounded-lg">
                      <span className="text-slate-400 font-mono shrink-0">{ev.time}</span>
                      <span className="font-bold text-primary shrink-0">{ev.event}</span>
                      <span className="text-slate-600 break-all">{ev.data}</span>
                    </div>
                  ))}
                  <div ref={eventsEndRef} />
                </div>
              )}
            </div>
          )}

          {activeTab === 'logs' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="font-bold text-slate-900">Logs em tempo real</h4>
                  <p className="text-xs text-slate-500">Conexao, mensagens, API, webhooks e alertas desta instancia.</p>
                </div>
                <button onClick={fetchLogs} className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-200">
                  {logsLoading ? 'Atualizando...' : 'Atualizar'}
                </button>
              </div>
              <div className="h-[440px] overflow-y-auto rounded-xl border border-slate-200 bg-slate-950 p-3 font-mono text-xs text-slate-100">
                {logs.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-slate-400">
                    Nenhum log registrado ainda.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {logs.map((log, index) => {
                      const isError = log.success === false || String(log.status || '').toLowerCase().includes('fail') || log.error || Number(log.status_code || 0) >= 400;
                      const label = log.event || log.path || log.message_id || log.type || log.source;
                      const details = log.error || log.description || log.status || log.direction || log.method || '';
                      return (
                        <div key={`${log.source}-${log.id || index}-${log.created_at}`} className="rounded-lg border border-white/10 bg-white/5 p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className={`rounded px-2 py-0.5 text-[10px] font-black uppercase ${isError ? 'bg-red-500/20 text-red-200' : 'bg-emerald-500/20 text-emerald-200'}`}>
                                  {log.source}
                                </span>
                                <span className="truncate font-bold text-white">{label || 'evento'}</span>
                              </div>
                              <p className="mt-1 break-words text-slate-300">{details || 'sem detalhes adicionais'}</p>
                            </div>
                            <span className="shrink-0 text-[10px] text-slate-500">
                              {log.created_at ? new Date(log.created_at).toLocaleTimeString('pt-BR') : ''}
                            </span>
                          </div>
                          {log.details && Object.keys(log.details).length > 0 && (
                            <pre className="mt-2 max-h-28 overflow-auto rounded bg-black/30 p-2 text-[10px] text-slate-300">
                              {JSON.stringify(log.details, null, 2)}
                            </pre>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
