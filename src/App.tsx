import React, { useState, useEffect, useCallback } from 'react';
import { io, Socket } from "socket.io-client";
import {
  Search,
  Users,
  MessageSquare,
  Settings,
  LayoutDashboard,
  Plus,
  Trash2,
  Send,
  CheckCircle2,
  XCircle,
  QrCode,
  RefreshCw,
  MapPin,
  Bot,
  MessagesSquare,
  Calendar,
  LogOut,
  Building2,
  Lock,
  Mail,
  User,
  Smartphone,
  CheckCircle,
  AlertCircle,
  Paperclip,
  Image as ImageIcon,
  ShieldCheck,
  Activity,
  BarChart3,
  CreditCard,
  Server,
  Flag,
  FileText,
  Globe2,
  LifeBuoy,
  Database,
  Webhook,
  UserCog,
  KeyRound,
  Clock,
  Bug,
  Puzzle,
  Loader2
} from 'lucide-react';
import InstanceTester from './components/InstanceTester';
import IntegrationManager from './components/IntegrationManager';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Types ---
interface Lead {
  id?: number;
  name: string;
  phone: string;
  address: string;
  niche: string;
  status: string;
  kanban_status?: string;
}

interface Instance {
  id: number;
  name: string;
  engine?: 'wooapi';
  status: 'created' | 'qr_pending' | 'connecting' | 'connected' | 'disconnected' | 'logged_out' | 'error' | 'blocked' | 'paused' | 'none' | 'qr' | 'open' | 'close' | 'reconnecting';
  qr?: string;
  phone?: string;
  phoneConnected?: string;
  phone_connected?: string;
  jid?: string;
  profileName?: string;
  profile_name?: string;
  profilePictureUrl?: string;
  profile_picture_url?: string;
  api_key?: string;
  webhook_endpoint?: string;
  webhook_secret?: string;
  webhook?: {
    webhooks_url?: string;
    webhook_events_url?: string;
    webhook_logs_url?: string;
    webhook_test_url?: string;
    configured_url?: string | null;
    secret?: string | null;
  };
  operational_status?: string;
}

interface Conversation {
  id: number;
  instance_id: number;
  title: string;
  type: 'contact' | 'group';
  remote_jid?: string;
  contact_phone?: string;
  group_jid?: string;
  contact_profile_picture_url?: string;
  last_message?: string;
  last_message_preview?: string;
  last_message_at: string;
  unread_count: number;
  tags_json?: string;
  status?: 'open' | 'pending' | 'closed';
  assigned_to?: string;
}

interface WhatsAppGroup {
  id: number;
  account_id: number;
  instance_id: number;
  group_jid: string;
  name?: string;
  topic?: string;
  participant_count?: number;
  announce?: number;
  locked?: number;
  invite_link?: string;
  picture_url?: string;
  synced_at?: string;
  participants?: GroupParticipant[];
}

interface GroupParticipant {
  id?: number;
  participant_jid: string;
  phone?: string;
  name?: string;
  is_admin?: number;
}

interface GroupRule {
  id?: number;
  instance_id: number;
  group_jid?: string;
  name: string;
  rule_type: 'keyword' | 'regex' | 'link' | 'media';
  pattern: string;
  action: 'log' | 'warn' | 'delete_message' | 'remove_participant' | 'warn_and_remove';
  warning_text?: string;
  threshold: number;
  window_minutes: number;
  enabled: number;
}

interface Message {
  id: number;
  conversation_id?: number;
  lead_id?: number;
  lead_name?: string;
  direction?: 'inbound' | 'outbound';
  chat_type?: 'contact' | 'group';
  author_phone?: string;
  author_push_name?: string;
  sender?: 'ai' | 'human' | 'lead';
  content?: string;
  content_type?: 'text' | 'image' | 'video' | 'audio' | 'document';
  content_text?: string;
  message_id?: string;
  delivery_status?: 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'received';
  from_me?: boolean;
  created_at: string;
}

interface TeamMember {
  id?: number;
  name: string;
  role: string;
  email: string;
}

interface LLMCredential {
  id?: number;
  provider: string;
  name: string;
  api_key: string;
  model_name?: string;
  is_active: number;
}

interface Schedule {
  id?: number;
  name: string;
  agent_id?: number;
  member_id?: number;
  agent_name?: string;
  member_name?: string;
  description?: string;
  created_at?: string;
}

interface Agent {
  id?: number;
  name: string;
  system_instruction: string;
  personality?: string;
  faq_json?: string;
  handoff_trigger?: string;
}

interface Campaign {
  id?: number;
  name: string;
  agent_id: number;
  initial_method: 'ai' | 'direct';
  transition_rules: any;
}

interface WhatsAppStatus {
  status: 'connecting' | 'connected' | 'disconnected' | 'qr_pending' | 'logged_out' | 'open' | 'close' | 'qr' | 'none';
  qr: string | null;
}

const isConnectedStatus = (status?: string) => status === 'connected' || status === 'open';
const isQrStatus = (status?: string) => status === 'qr_pending' || status === 'qr';
const isDisconnectedStatus = (status?: string) => ['created', 'disconnected', 'logged_out', 'none', 'close', 'error'].includes(String(status || ''));
const findConnectedInstance = (instances: Instance[], preferredId?: number) =>
  instances.find(inst => inst.id === preferredId && isConnectedStatus(inst.status)) ||
  instances.find(inst => isConnectedStatus(inst.status));

const instanceStatusLabel = (status?: string) => {
  if (isConnectedStatus(status)) return 'Conectado';
  if (isQrStatus(status)) return 'Aguardando QR';
  if (status === 'connecting') return 'Conectando...';
  if (status === 'reconnecting') return 'Reconectando...';
  if (status === 'blocked') return 'Bloqueada';
  if (status === 'paused') return 'Pausada';
  if (status === 'error') return 'Erro';
  return 'Desconectado';
};

const displayText = (value: any, fallback = '-') => {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => displayText(item, '')).filter(Boolean).join(', ') || fallback;
  if (typeof value === 'object') {
    return value.name || value.label || value.title || value.email || value.id || fallback;
  }
  return String(value);
};

const parseList = (value: any): any[] => {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

const displayNumber = (value: any, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

// --- Components ---

const SidebarItem = ({ icon: Icon, label, active, onClick, href }: { icon: any, label: string, active: boolean, onClick?: () => void, href?: string }) => (
  <a
    href={href || "#"}
    onClick={(e) => {
      if (onClick) {
        e.preventDefault();
        onClick();
      }
    }}
    className={cn(
      "flex items-center gap-3 w-full px-4 py-3 rounded-md transition-all duration-200 cursor-pointer no-underline",
      active
        ? "bg-primary text-white font-semibold"
        : "text-sidebar-item hover:bg-sidebar-item-active-bg hover:text-white"
    )}
  >
    <Icon size={20} />
    <span className="text-sm">{label}</span>
  </a>
);

const Card = ({ children, className }: { children: React.ReactNode, className?: string }) => (
  <div className={cn("bg-white border border-slate-200 rounded-md shadow-sm overflow-hidden", className)}>
    {children}
  </div>
);

// --- Main App ---

// --- Super Admin Component ---
const SuperAdmin = ({ apiFetch, onImpersonate }: { apiFetch: any, onImpersonate: (session: any) => void }) => {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [plans, setPlans] = useState<any[]>([]);
  const [overview, setOverview] = useState<any>(null);
  const [activeSubTab, setActiveSubTab] = useState<'accounts' | 'plans' | 'monitor'>('accounts');
  const [newPlan, setNewPlan] = useState({
    name: '',
    price: 0,
    max_agents: 0,
    max_campaigns: 0,
    max_leads: 0,
    max_instances: 1,
    max_users: 2,
    max_messages: 5000,
    max_client_accounts: 0,
    features: ''
  });
  const [newAccount, setNewAccount] = useState({
    name: '',
    owner_name: '',
    owner_email: '',
    password: '',
    plan_id: '',
    account_type: 'client',
    instance_quota: 1,
    max_client_accounts: 0
  });

  const fetchData = async () => {
    const accs = await apiFetch('/api/admin/accounts');
    const pls = await apiFetch('/api/admin/plans');
    const ovw = await apiFetch('/api/admin/overview');
    if (Array.isArray(accs)) setAccounts(accs);
    if (Array.isArray(pls)) setPlans(pls);
    if (ovw) setOverview(ovw);
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, []);

  const createPlan = async () => {
    if (!newPlan.name) return;
    await apiFetch('/api/admin/plans', {
      method: 'POST',
      body: JSON.stringify({
        ...newPlan,
        features_json: newPlan.features.split(',').map(f => f.trim())
      })
    });
    setNewPlan({ name: '', price: 0, max_agents: 0, max_campaigns: 0, max_leads: 0, max_instances: 1, max_users: 2, max_messages: 5000, max_client_accounts: 0, features: '' });
    fetchData();
  };

  const createAccount = async () => {
    if (!newAccount.name || !newAccount.owner_name || !newAccount.owner_email || !newAccount.password) return;
    await apiFetch('/api/admin/accounts', {
      method: 'POST',
      body: JSON.stringify({ ...newAccount, plan_id: newAccount.plan_id ? Number(newAccount.plan_id) : null })
    });
    setNewAccount({ name: '', owner_name: '', owner_email: '', password: '', plan_id: '', account_type: 'client', instance_quota: 1, max_client_accounts: 0 });
    fetchData();
  };

  const updateAccountPlan = async (accountId: number, planId: number) => {
    await apiFetch(`/api/admin/accounts/${accountId}/plan`, {
      method: 'PATCH',
      body: JSON.stringify({ plan_id: planId })
    });
    fetchData();
  };

  const updateAccountStatus = async (accountId: number, status: string) => {
    await apiFetch(`/api/admin/accounts/${accountId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status })
    });
    fetchData();
  };

  const impersonateAccount = async (accountId: number) => {
    const session = await apiFetch(`/api/admin/accounts/${accountId}/impersonate`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Suporte via Super Admin' })
    });
    if (session?.token) onImpersonate(session);
  };

  const statCards = [
    ['Contas', overview?.accounts || 0],
    ['Revendedores', overview?.resellers || 0],
    ['Ativas', overview?.active_accounts || 0],
    ['Instâncias', overview?.instances || 0],
    ['Conectadas', overview?.connected_instances || 0],
    ['Mensagens/mês', overview?.messages_month || 0],
    ['Webhooks falhos', overview?.failed_webhooks || 0]
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold">Super Admin</h2>
          <p className="text-slate-500">Gestão SaaS global: contas, planos, limites, suporte e monitoramento.</p>
        </div>
        <div className="flex bg-white p-1 rounded-md border border-slate-200">
          {[
            ['accounts', 'Contas'],
            ['plans', 'Planos'],
            ['monitor', 'Monitoramento']
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setActiveSubTab(id as any)}
              className={cn(
                "px-4 py-2 text-xs font-bold rounded-md transition-all",
                activeSubTab === id ? "bg-primary text-white" : "text-slate-500 hover:bg-slate-50"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        {statCards.map(([label, value]) => (
          <Card key={String(label)} className="p-4">
            <p className="text-[10px] uppercase tracking-widest font-bold text-slate-400">{label}</p>
            <p className="text-2xl font-black mt-1">{value}</p>
          </Card>
        ))}
      </div>

      {activeSubTab === 'accounts' ? (
        <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
          <Card className="p-5 h-fit">
            <h3 className="text-lg font-bold mb-4">Nova Conta Cliente</h3>
            <div className="space-y-3">
              <input className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm" placeholder="Empresa" value={newAccount.name} onChange={e => setNewAccount({ ...newAccount, name: e.target.value })} />
              <input className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm" placeholder="Nome do admin" value={newAccount.owner_name} onChange={e => setNewAccount({ ...newAccount, owner_name: e.target.value })} />
              <input className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm" placeholder="E-mail do admin" value={newAccount.owner_email} onChange={e => setNewAccount({ ...newAccount, owner_email: e.target.value })} />
              <input className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm" placeholder="Senha inicial" type="password" value={newAccount.password} onChange={e => setNewAccount({ ...newAccount, password: e.target.value })} />
              <select className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm" value={newAccount.plan_id} onChange={e => setNewAccount({ ...newAccount, plan_id: e.target.value })}>
                <option value="">Plano...</option>
                {plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <select className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm" value={newAccount.account_type} onChange={e => setNewAccount({ ...newAccount, account_type: e.target.value })}>
                <option value="client">Cliente final</option>
                <option value="reseller">Revendedor</option>
                <option value="owner">Dono do sistema</option>
              </select>
              <div className="grid grid-cols-2 gap-2">
                <input className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm" placeholder="Instâncias" type="number" value={newAccount.instance_quota} onChange={e => setNewAccount({ ...newAccount, instance_quota: Number(e.target.value) })} />
                <input className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm" placeholder="Clientes" type="number" value={newAccount.max_client_accounts} onChange={e => setNewAccount({ ...newAccount, max_client_accounts: Number(e.target.value) })} />
              </div>
              <button onClick={createAccount} className="w-full py-3 bg-primary text-white font-bold rounded-md">Criar cliente</button>
            </div>
          </Card>

          <Card className="xl:col-span-3">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100 text-slate-400 text-xs font-semibold uppercase tracking-wider">
                  <th className="py-4 px-6">Empresa</th>
                  <th className="py-4 px-6">Plano</th>
                  <th className="py-4 px-6">Uso</th>
                  <th className="py-4 px-6">Status</th>
                  <th className="py-4 px-6">Ações</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {accounts.map((acc) => (
                  <tr key={acc.id} className="border-b border-slate-50 last:border-0">
                    <td className="py-4 px-6">
                      <p className="font-bold">{acc.name}</p>
                      <p className="text-xs text-slate-400">{acc.owner_email || `Conta #${acc.id}`}</p>
                    </td>
                    <td className="py-4 px-6">
                      <select className="text-xs bg-slate-50 border border-slate-200 rounded p-1" value={acc.plan_id || ''} onChange={(e) => updateAccountPlan(acc.id, Number(e.target.value))}>
                        <option value="">Sem plano</option>
                        {plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </td>
                    <td className="py-4 px-6 text-xs text-slate-500">
                      <p>Instâncias: {acc.usage?.instances || 0}/{acc.max_instances || '-'}</p>
                      <p>Usuários: {acc.usage?.users || 0}/{acc.max_users || '-'}</p>
                      <p>Mensagens: {acc.usage?.messages || 0}/{acc.max_messages || '-'}</p>
                    </td>
                    <td className="py-4 px-6">
                      <select className="text-xs bg-slate-50 border border-slate-200 rounded p-1" value={acc.status || 'active'} onChange={(e) => updateAccountStatus(acc.id, e.target.value)}>
                        <option value="active">Ativa</option>
                        <option value="paused">Pausada</option>
                        <option value="blocked">Bloqueada</option>
                      </select>
                    </td>
                    <td className="py-4 px-6">
                      <button onClick={() => impersonateAccount(acc.id)} className="px-3 py-2 bg-primary text-white rounded-md text-xs font-bold">
                        Acessar conta
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      ) : activeSubTab === 'plans' ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <Card className="p-6 h-fit">
            <h3 className="text-lg font-bold mb-4">Novo Plano</h3>
            <div className="space-y-4">
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Nome do Plano</label>
                <input
                  type="text"
                  placeholder="Ex: Pro, Enterprise"
                  className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none"
                  value={newPlan.name}
                  onChange={(e) => setNewPlan({ ...newPlan, name: e.target.value })}
                />
              </div>
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Preço (R$)</label>
                <input
                  type="number"
                  className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none"
                  value={newPlan.price}
                  onChange={(e) => setNewPlan({ ...newPlan, price: Number(e.target.value) })}
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-[10px] font-bold text-slate-400 uppercase mb-1 block">Instâncias</label>
                  <input
                    type="number"
                    className="w-full px-2 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none text-xs"
                    value={newPlan.max_instances}
                    onChange={(e) => setNewPlan({ ...newPlan, max_instances: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-slate-400 uppercase mb-1 block">Usuários</label>
                  <input
                    type="number"
                    className="w-full px-2 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none text-xs"
                    value={newPlan.max_users}
                    onChange={(e) => setNewPlan({ ...newPlan, max_users: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-slate-400 uppercase mb-1 block">Mensagens</label>
                  <input
                    type="number"
                    className="w-full px-2 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none text-xs"
                    value={newPlan.max_messages}
                    onChange={(e) => setNewPlan({ ...newPlan, max_messages: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-slate-400 uppercase mb-1 block">Agentes</label>
                  <input
                    type="number"
                    className="w-full px-2 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none text-xs"
                    value={newPlan.max_agents}
                    onChange={(e) => setNewPlan({ ...newPlan, max_agents: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-slate-400 uppercase mb-1 block">Campanhas</label>
                  <input
                    type="number"
                    className="w-full px-2 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none text-xs"
                    value={newPlan.max_campaigns}
                    onChange={(e) => setNewPlan({ ...newPlan, max_campaigns: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-slate-400 uppercase mb-1 block">Leads</label>
                  <input
                    type="number"
                    className="w-full px-2 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none text-xs"
                    value={newPlan.max_leads}
                    onChange={(e) => setNewPlan({ ...newPlan, max_leads: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-slate-400 uppercase mb-1 block">Clientes</label>
                  <input
                    type="number"
                    className="w-full px-2 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none text-xs"
                    value={newPlan.max_client_accounts}
                    onChange={(e) => setNewPlan({ ...newPlan, max_client_accounts: Number(e.target.value) })}
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Recursos (separados por vírgula)</label>
                <textarea
                  rows={3}
                  placeholder="Suporte 24h, API, Handoff..."
                  className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none resize-none"
                  value={newPlan.features}
                  onChange={(e) => setNewPlan({ ...newPlan, features: e.target.value })}
                />
              </div>
              <button
                onClick={createPlan}
                className="w-full py-3 bg-primary text-white font-bold rounded-xl hover:bg-primary/90 transition-all flex items-center justify-center gap-2"
              >
                <Plus size={20} />
                Criar Plano
              </button>
            </div>
          </Card>

          <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-6">
            {plans.map((plan) => (
              <Card key={plan.id} className="p-6 border-t-4 border-t-primary">
                <div className="flex justify-between items-start mb-4">
                  <h4 className="text-xl font-bold">{plan.name}</h4>
                  <span className="text-2xl font-black text-primary">R$ {plan.price}</span>
                </div>
                <div className="space-y-2 mb-6">
                  <p className="text-xs text-slate-500 flex justify-between">
                    <span>Agentes IA:</span> <span className="font-bold text-slate-700">{plan.max_agents}</span>
                  </p>
                  <p className="text-xs text-slate-500 flex justify-between">
                    <span>Campanhas:</span> <span className="font-bold text-slate-700">{plan.max_campaigns}</span>
                  </p>
                  <p className="text-xs text-slate-500 flex justify-between">
                    <span>Leads:</span> <span className="font-bold text-slate-700">{plan.max_leads}</span>
                  </p>
                  <p className="text-xs text-slate-500 flex justify-between">
                    <span>Instâncias:</span> <span className="font-bold text-slate-700">{plan.max_instances}</span>
                  </p>
                  <p className="text-xs text-slate-500 flex justify-between">
                    <span>Usuários:</span> <span className="font-bold text-slate-700">{plan.max_users}</span>
                  </p>
                  <p className="text-xs text-slate-500 flex justify-between">
                    <span>Mensagens/mês:</span> <span className="font-bold text-slate-700">{plan.max_messages}</span>
                  </p>
                  <p className="text-xs text-slate-500 flex justify-between">
                    <span>Clientes filhos:</span> <span className="font-bold text-slate-700">{plan.max_client_accounts || 0}</span>
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {parseList(plan.features_json).map((f: any, i: number) => (
                    <span key={i} className="px-2 py-1 bg-slate-100 text-slate-600 rounded text-[10px] font-medium">
                      {displayText(f, 'recurso')}
                    </span>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="p-6">
            <h3 className="text-lg font-bold mb-4">Saúde do SaaS</h3>
            <div className="space-y-3 text-sm">
              <p className="flex justify-between"><span className="text-slate-500">API Node</span><span className="font-bold text-primary">Online</span></p>
              <p className="flex justify-between"><span className="text-slate-500">WooAPI Core</span><span className="font-bold">{overview?.connected_instances ? 'Ativo' : 'Monitorar'}</span></p>
              <p className="flex justify-between"><span className="text-slate-500">Webhooks falhos</span><span className="font-bold">{overview?.failed_webhooks || 0}</span></p>
            </div>
          </Card>
          <Card className="p-6 lg:col-span-2">
            <h3 className="text-lg font-bold mb-4">Contas próximas de limite</h3>
            <div className="space-y-3">
              {accounts.filter(acc => (acc.usage?.instances || 0) >= (acc.max_instances || 999999)).map(acc => (
                <div key={acc.id} className="flex items-center justify-between p-3 bg-slate-50 border border-slate-200 rounded-md">
                  <div>
                    <p className="font-bold">{acc.name}</p>
                    <p className="text-xs text-slate-500">Instâncias: {acc.usage?.instances}/{acc.max_instances}</p>
                  </div>
                  <button onClick={() => impersonateAccount(acc.id)} className="px-3 py-2 bg-primary text-white rounded-md text-xs font-bold">Acessar</button>
                </div>
              ))}
              {!accounts.some(acc => (acc.usage?.instances || 0) >= (acc.max_instances || 999999)) && (
                <p className="text-sm text-slate-500">Nenhuma conta estourando limite agora.</p>
              )}
            </div>
          </Card>
        </div>
      )}
    </motion.div>
  );
};

const SuperAdminPanel = ({ apiFetch, onImpersonate, onLogout, onBackToAccount, authUser }: { apiFetch: any, onImpersonate: (session: any) => void, onLogout: () => void, onBackToAccount?: () => void, authUser?: any }) => {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [plans, setPlans] = useState<any[]>([]);
  const [overview, setOverview] = useState<any>(null);
  const [wooapiMonitor, setWooapiMonitor] = useState<any>(null);
  const [externalIntegrations, setExternalIntegrations] = useState<any[]>([]);
  const [integrationAccounts, setIntegrationAccounts] = useState<any[]>([]);
  const [selectedIntegrationId, setSelectedIntegrationId] = useState<number | null>(null);
  const [externalInstances, setExternalInstances] = useState<any>(null);
  const [partners, setPartners] = useState<any[]>([]);
  const [selectedPartnerId, setSelectedPartnerId] = useState<number | null>(null);
  const [partnerCommissions, setPartnerCommissions] = useState<any[]>([]);
  const [activeSubTab, setActiveSubTab] = useState<'dashboard' | 'wooapi' | 'accounts' | 'plans' | 'monitor' | 'webhooks' | 'external_integrations' | 'partners' | 'audit' | 'settings'>('dashboard');
  const [newPlan, setNewPlan] = useState({
    name: '',
    price: 0,
    max_agents: 0,
    max_campaigns: 0,
    max_leads: 0,
    max_instances: 1,
    max_users: 2,
    max_messages: 5000,
    max_client_accounts: 0,
    features: ''
  });
  const [newAccount, setNewAccount] = useState({
    name: '',
    owner_name: '',
    owner_email: '',
    password: '',
    plan_id: '',
    account_type: 'client',
    instance_quota: 1,
    max_client_accounts: 0
  });
  const [newIntegration, setNewIntegration] = useState({
    name: 'Evolution API',
    provider: 'evolution_api',
    base_url: '',
    admin_key: '',
    auth_header: 'apikey',
    auth_prefix: '',
    list_instances_path: '/instance/fetchInstances',
    create_instance_path: '/instance/create',
    notes: ''
  });
  const [newExternalInstance, setNewExternalInstance] = useState({ instanceName: '', qrcode: true, integration: 'WHATSAPP-BAILEYS' });
  const [newPartner, setNewPartner] = useState({ name: '', email: '', phone: '', commission_rate: 10, notes: '' });
  const [newCommission, setNewCommission] = useState({ account_id: '', amount: 0, description: '', status: 'pending' });

  const fetchData = async () => {
    const accs = await apiFetch('/api/admin/accounts');
    const pls = await apiFetch('/api/admin/plans');
    const ovw = await apiFetch('/api/admin/overview');
    const monitor = await apiFetch('/api/admin/wooapi-monitor');
    const integrations = await apiFetch('/api/admin/external-integrations');
    const partnerRows = await apiFetch('/api/admin/partners');
    if (Array.isArray(accs)) setAccounts(accs);
    if (Array.isArray(pls)) setPlans(pls);
    if (ovw) setOverview(ovw);
    if (monitor) setWooapiMonitor(monitor);
    if (Array.isArray(integrations)) {
      setExternalIntegrations(integrations);
      if (!selectedIntegrationId && integrations.length > 0) setSelectedIntegrationId(integrations[0].id);
    }
    if (Array.isArray(partnerRows)) {
      setPartners(partnerRows);
      if (!selectedPartnerId && partnerRows.length > 0) setSelectedPartnerId(partnerRows[0].id);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = window.setInterval(fetchData, 7000);
    return () => window.clearInterval(interval);
  }, []);

  const createPlan = async () => {
    if (!newPlan.name) return;
    await apiFetch('/api/admin/plans', {
      method: 'POST',
      body: JSON.stringify({
        ...newPlan,
        features_json: newPlan.features.split(',').map((f) => f.trim()).filter(Boolean)
      })
    });
    setNewPlan({ name: '', price: 0, max_agents: 0, max_campaigns: 0, max_leads: 0, max_instances: 1, max_users: 2, max_messages: 5000, max_client_accounts: 0, features: '' });
    fetchData();
  };

  const createAccount = async () => {
    if (!newAccount.name || !newAccount.owner_name || !newAccount.owner_email || !newAccount.password) return;
    await apiFetch('/api/admin/accounts', {
      method: 'POST',
      body: JSON.stringify({ ...newAccount, plan_id: newAccount.plan_id ? Number(newAccount.plan_id) : null })
    });
    setNewAccount({ name: '', owner_name: '', owner_email: '', password: '', plan_id: '', account_type: 'client', instance_quota: 1, max_client_accounts: 0 });
    fetchData();
  };

  const updateAccountPlan = async (accountId: number, planId: number | null) => {
    await apiFetch(`/api/admin/accounts/${accountId}/plan`, {
      method: 'PATCH',
      body: JSON.stringify({ plan_id: planId })
    });
    fetchData();
  };

  const updateAccountStatus = async (accountId: number, status: string) => {
    await apiFetch(`/api/admin/accounts/${accountId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status })
    });
    fetchData();
  };

  const impersonateAccount = async (accountId: number) => {
    const session = await apiFetch(`/api/admin/accounts/${accountId}/impersonate`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Suporte via Super Admin' })
    });
    if (session?.token) onImpersonate(session);
  };

  const createExternalIntegration = async () => {
    if (!newIntegration.name || !newIntegration.base_url || !newIntegration.admin_key) return;
    await apiFetch('/api/admin/external-integrations', {
      method: 'POST',
      body: JSON.stringify(newIntegration)
    });
    setNewIntegration({ name: 'Evolution API', provider: 'evolution_api', base_url: '', admin_key: '', auth_header: 'apikey', auth_prefix: '', list_instances_path: '/instance/fetchInstances', create_instance_path: '/instance/create', notes: '' });
    fetchData();
  };

  const fetchIntegrationAccounts = async (integrationId = selectedIntegrationId) => {
    if (!integrationId) return;
    const rows = await apiFetch(`/api/admin/external-integrations/${integrationId}/accounts`);
    if (Array.isArray(rows)) setIntegrationAccounts(rows);
  };

  const toggleIntegrationAccount = async (accountId: number, enabled: boolean) => {
    if (!selectedIntegrationId) return;
    await apiFetch(`/api/admin/external-integrations/${selectedIntegrationId}/accounts/${accountId}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled })
    });
    fetchIntegrationAccounts();
    fetchData();
  };

  const listExternalInstances = async () => {
    if (!selectedIntegrationId) return;
    const data = await apiFetch(`/api/admin/external-integrations/${selectedIntegrationId}/list-instances`, { method: 'POST', body: JSON.stringify({}) });
    if (data) setExternalInstances(data);
  };

  const createExternalInstance = async () => {
    if (!selectedIntegrationId || !newExternalInstance.instanceName.trim()) return;
    const data = await apiFetch(`/api/admin/external-integrations/${selectedIntegrationId}/create-instance`, {
      method: 'POST',
      body: JSON.stringify(newExternalInstance)
    });
    if (data) {
      setExternalInstances(data);
      setNewExternalInstance({ instanceName: '', qrcode: true, integration: 'WHATSAPP-BAILEYS' });
    }
  };

  const createPartner = async () => {
    if (!newPartner.name.trim()) return;
    await apiFetch('/api/admin/partners', { method: 'POST', body: JSON.stringify(newPartner) });
    setNewPartner({ name: '', email: '', phone: '', commission_rate: 10, notes: '' });
    fetchData();
  };

  const fetchPartnerCommissions = async (partnerId = selectedPartnerId) => {
    if (!partnerId) return;
    const rows = await apiFetch(`/api/admin/partners/${partnerId}/commissions`);
    if (Array.isArray(rows)) setPartnerCommissions(rows);
  };

  const createPartnerCommission = async () => {
    if (!selectedPartnerId || Number(newCommission.amount || 0) <= 0) return;
    await apiFetch(`/api/admin/partners/${selectedPartnerId}/commissions`, {
      method: 'POST',
      body: JSON.stringify({ ...newCommission, account_id: newCommission.account_id ? Number(newCommission.account_id) : null })
    });
    setNewCommission({ account_id: '', amount: 0, description: '', status: 'pending' });
    fetchPartnerCommissions();
    fetchData();
  };

  const markCommissionPaid = async (commissionId: number) => {
    await apiFetch(`/api/admin/partner-commissions/${commissionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'paid' })
    });
    fetchPartnerCommissions();
    fetchData();
  };

  useEffect(() => {
    fetchIntegrationAccounts(selectedIntegrationId);
  }, [selectedIntegrationId]);

  useEffect(() => {
    fetchPartnerCommissions(selectedPartnerId);
  }, [selectedPartnerId]);

  const formatNumber = (value: any) => new Intl.NumberFormat('pt-BR').format(Number(value || 0));
  const formatCurrency = (value: any) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value || 0));
  const activeAccounts = Number(overview?.active_accounts || 0);
  const totalAccounts = Number(overview?.accounts || accounts.length || 0);
  const connectedInstances = Number(overview?.connected_instances || 0);
  const totalInstances = Number(overview?.instances || 0);
  const failedWebhooks = Number(overview?.failed_webhooks || 0);
  const estimatedRevenue = plans.reduce((total, plan) => {
    const subscribers = accounts.filter((account) => Number(account.plan_id) === Number(plan.id)).length;
    return total + subscribers * Number(plan.price || 0);
  }, 0);
  const nearLimitAccounts = accounts.filter(acc => Number(acc.usage?.instances || 0) >= Number(acc.max_instances || 999999));
  const latestAccounts = accounts.slice(0, 5);
  const serverStatus = failedWebhooks > 0 ? 'Requer Atencao' : 'Operacional';
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  useEffect(() => {
    if (wooapiMonitor?.generated_at) {
      setLastUpdated(wooapiMonitor.generated_at);
    }
  }, [wooapiMonitor?.generated_at]);
  const wooMetrics = wooapiMonitor?.metrics || {};
  const wooQueues = wooapiMonitor?.queues || [];
  const wooInstances = wooapiMonitor?.instances || [];
  const wooWebhooks = wooapiMonitor?.webhooks || [];
  const wooWebhookLogs = wooapiMonitor?.recent_webhook_logs || [];
  const wooAlerts = wooapiMonitor?.alerts || [];
  const wooLiveLogs = wooapiMonitor?.live_logs || [];
  const wooSupportTickets = wooapiMonitor?.support_tickets || [];
  const wooNoc = wooapiMonitor?.noc || {};

  const navItems = [
    { id: 'dashboard', label: 'Visao Geral', icon: LayoutDashboard },
    { id: 'wooapi', label: 'Saude da Plataforma', icon: Activity },
    { id: 'accounts', label: 'Clientes', icon: Building2 },
    { id: 'plans', label: 'Planos', icon: CreditCard },
    { id: 'monitor', label: 'Monitoramento', icon: Activity },
    { id: 'webhooks', label: 'Webhooks', icon: Webhook },
    { id: 'external_integrations', label: 'Integracoes Externas', icon: Puzzle },
    { id: 'partners', label: 'Parceiros', icon: KeyRound },
    { id: 'audit', label: 'Auditoria', icon: FileText },
    { id: 'settings', label: 'Configuracoes', icon: Settings }
  ] as const;

  const statCards = [
    { label: 'Total de Clientes', value: formatNumber(totalAccounts), icon: Building2, tone: 'bg-blue-600', note: `${formatNumber(activeAccounts)} ativos` },
    { label: 'Assinaturas Ativas', value: formatNumber(activeAccounts), icon: Users, tone: 'bg-emerald-500', note: `${formatNumber(overview?.resellers || 0)} revendedores` },
    { label: 'Receita Mensal Est.', value: formatCurrency(estimatedRevenue), icon: CreditCard, tone: 'bg-violet-500', note: 'baseada nos planos' },
    { label: 'Status do Servidor', value: serverStatus, icon: Server, tone: failedWebhooks > 0 ? 'bg-amber-500' : 'bg-emerald-600', note: `${formatNumber(connectedInstances)}/${formatNumber(totalInstances)} instancias online` }
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="min-h-[calc(100vh-2rem)] overflow-hidden rounded-md border border-slate-200 bg-slate-100 shadow-sm lg:grid lg:grid-cols-[248px_1fr]"
    >
      <aside className="flex flex-col bg-[#101827] text-white">
        <div className="flex h-20 items-center gap-3 border-b border-white/10 px-6">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-red-600">
            <ShieldCheck size={20} />
          </div>
          <div>
            <p className="text-lg font-black text-red-400">Console Global</p>
            <p className="text-[11px] font-semibold text-white/45">Super Admin WooAPI</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-4 py-5">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveSubTab(id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-md px-3 py-3 text-left text-sm font-bold transition-all",
                activeSubTab === id ? "bg-red-600 text-white shadow-lg shadow-red-950/20" : "text-slate-300 hover:bg-white/10 hover:text-white"
              )}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>

        <div className="border-t border-white/10 p-5">
          {onBackToAccount && (
            <button
              onClick={onBackToAccount}
              className="mb-4 flex w-full items-center gap-2 rounded-md bg-white/10 px-3 py-2 text-sm font-bold text-white transition-colors hover:bg-white/15"
            >
              <LayoutDashboard size={16} />
              Voltar ao Painel da Conta
            </button>
          )}
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-600 text-sm font-black">S</div>
            <div className="min-w-0">
              <p className="truncate text-sm font-black">{displayText(authUser?.name, 'Dono do Sistema')}</p>
              <p className="truncate text-xs text-slate-400">{displayText(authUser?.email, 'super admin')}</p>
            </div>
          </div>
          <button
            onClick={onLogout}
            className="mt-5 flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-bold text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            <LogOut size={16} />
            Sair
          </button>
        </div>
      </aside>

      <section className="min-w-0 bg-[#f4f5f7] p-5 lg:p-7">
        <header className="mb-7 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-2xl font-black text-slate-950">Console Global WooAPI</h2>
            <p className="text-sm text-slate-500">Ambiente exclusivo do super admin para clientes, planos, instancias, webhooks e suporte.</p>
          </div>
          <div className={cn("flex w-fit items-center gap-2 rounded-md px-3 py-2 text-xs font-black", failedWebhooks > 0 ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700")}>
            <span className="h-2 w-2 rounded-full bg-current" />
            {serverStatus}
          </div>
        </header>

        <div className="mb-8 grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
          {statCards.map(({ label, value, icon: Icon, tone, note }) => (
            <Card key={label} className="p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-500">{label}</p>
                  <p className="mt-2 truncate text-2xl font-black text-slate-950">{value}</p>
                  <p className="mt-2 text-xs font-semibold text-slate-400">{note}</p>
                </div>
                <div className={cn("flex h-12 w-12 shrink-0 items-center justify-center rounded-md text-white shadow-lg", tone)}>
                  <Icon size={23} />
                </div>
              </div>
            </Card>
          ))}
        </div>

        {activeSubTab === 'dashboard' && (
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Card className="p-6">
              <div className="mb-5 flex items-center gap-3">
                <Activity size={20} className="text-slate-400" />
                <h3 className="text-lg font-black text-slate-950">Atividade Recente</h3>
              </div>
              <div className="space-y-4">
                {latestAccounts.length > 0 ? latestAccounts.map((acc) => (
                  <div key={acc.id} className="flex items-center justify-between rounded-md border border-slate-100 bg-slate-50 px-4 py-3">
                    <div>
                      <p className="font-bold text-slate-900">{displayText(acc.name, `Conta #${acc.id}`)}</p>
                      <p className="text-xs text-slate-500">{displayText(acc.owner_email, `Conta #${acc.id}`)}</p>
                    </div>
                    <span className={cn("rounded-md px-2 py-1 text-[11px] font-black", acc.status === 'active' ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700")}>
                      {acc.status || 'active'}
                    </span>
                  </div>
                )) : (
                  <p className="py-10 text-center text-sm text-slate-500">Nenhuma atividade recente registrada.</p>
                )}
              </div>
            </Card>

            <Card className="p-6">
              <div className="mb-5 flex items-center gap-3">
                <AlertCircle size={20} className="text-slate-400" />
                <h3 className="text-lg font-black text-slate-950">Alertas do Sistema</h3>
              </div>
              <div className="space-y-4">
                <div className="rounded-md border border-slate-100 bg-slate-50 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-bold text-slate-900">Webhooks falhos</p>
                    <span className={cn("rounded-md px-2 py-1 text-xs font-black", failedWebhooks > 0 ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-700")}>{formatNumber(failedWebhooks)}</span>
                  </div>
                  <p className="mt-2 text-sm text-slate-500">{failedWebhooks > 0 ? 'Verifique entregas pendentes e clientes afetados.' : 'Sistema operando normalmente.'}</p>
                </div>
                <div className="rounded-md border border-slate-100 bg-slate-50 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-bold text-slate-900">Instancias conectadas</p>
                    <span className="rounded-md bg-blue-50 px-2 py-1 text-xs font-black text-blue-700">{formatNumber(connectedInstances)}/{formatNumber(totalInstances)}</span>
                  </div>
                  <p className="mt-2 text-sm text-slate-500">Acompanhe quedas de sessao e clientes sem conexao ativa.</p>
                </div>
              </div>
            </Card>
          </div>
        )}

        {activeSubTab === 'wooapi' && (
          <div className="space-y-5">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-2xl font-black text-slate-950">Central de Saude WooAPI</h2>
                  <p className="text-sm text-slate-500">Visao operacional de filas, webhooks, logs, instancias e alertas.</p>
                  {lastUpdated && <p className="mt-1 text-[10px] font-semibold text-slate-400">Ultima atualizacao: {new Date(lastUpdated).toLocaleString('pt-BR')}</p>}
                </div>
                <button onClick={fetchData} className="flex items-center justify-center gap-2 rounded-md bg-slate-900 px-4 py-2.5 text-sm font-black text-white shadow-md transition-all hover:bg-red-600 hover:shadow-lg active:scale-95">
                  <RefreshCw size={16} />
                  Atualizar
                </button>
              </div>

            {wooapiMonitor?.generated_at && (
              <Card className={cn(
                "overflow-hidden border-2",
                wooNoc.severity === 'critical' ? "border-rose-300 bg-rose-50" :
                wooNoc.severity === 'warning' ? "border-amber-300 bg-amber-50" :
                "border-emerald-300 bg-emerald-50"
              )}>
                <div className="grid grid-cols-1 gap-0 xl:grid-cols-[1.1fr_1fr_1fr]">
                  <div className="border-b border-white/70 p-5 xl:border-b-0 xl:border-r">
                    <div className="flex items-center gap-3">
                      <span className={cn(
                        "h-3 w-3 rounded-full",
                        wooNoc.severity === 'critical' ? "bg-rose-600 animate-pulse" :
                        wooNoc.severity === 'warning' ? "bg-amber-500 animate-pulse" :
                        "bg-emerald-600"
                      )} />
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">NOC Command Center</p>
                    </div>
                    <h3 className="mt-2 text-2xl font-black text-slate-950">{wooNoc.headline || 'Operacao nominal'}</h3>
                    <div className="mt-4 grid grid-cols-3 gap-2">
                      <div className="rounded-md bg-white/70 p-3">
                        <p className="text-[10px] font-black uppercase text-slate-400">Criticas</p>
                        <p className="text-xl font-black text-slate-950">{formatNumber(wooNoc.critical_count || 0)}</p>
                      </div>
                      <div className="rounded-md bg-white/70 p-3">
                        <p className="text-[10px] font-black uppercase text-slate-400">Risco</p>
                        <p className="text-xl font-black text-slate-950">{formatNumber(wooNoc.degraded_count || 0)}</p>
                      </div>
                      <div className="rounded-md bg-white/70 p-3">
                        <p className="text-[10px] font-black uppercase text-slate-400">Webhook OK</p>
                        <p className="text-xl font-black text-slate-950">{formatNumber(wooNoc.webhook_success_rate ?? 100)}%</p>
                      </div>
                    </div>
                  </div>
                  <div className="border-b border-white/70 p-5 xl:border-b-0 xl:border-r">
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Acoes preventivas</p>
                    <div className="mt-3 space-y-2">
                      {(wooNoc.next_actions || []).slice(0, 5).map((action: string, index: number) => (
                        <div key={index} className="flex items-start gap-2 rounded-md bg-white/70 px-3 py-2 text-xs font-bold text-slate-700">
                          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />
                          <span>{action}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="p-5">
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Watchlist de instancias</p>
                    <div className="mt-3 space-y-2">
                      {(wooNoc.watchlist || []).slice(0, 5).map((inst: any) => (
                        <div key={inst.id} className="flex items-center justify-between gap-3 rounded-md bg-white/70 px-3 py-2">
                          <div className="min-w-0">
                            <p className="truncate text-xs font-black text-slate-900">{displayText(inst.name, `Instancia #${inst.id}`)}</p>
                            <p className="truncate text-[10px] text-slate-500">{displayText(inst.account_name, `Conta #${inst.account_id}`)} · {inst.recommended_action}</p>
                          </div>
                          <span className={cn(
                            "shrink-0 rounded px-2 py-1 text-[10px] font-black",
                            Number(inst.risk_score || 0) >= 70 ? "bg-rose-100 text-rose-700" :
                            Number(inst.risk_score || 0) >= 35 ? "bg-amber-100 text-amber-700" :
                            "bg-slate-100 text-slate-600"
                          )}>{formatNumber(inst.risk_score || 0)}</span>
                        </div>
                      ))}
                      {(!wooNoc.watchlist || wooNoc.watchlist.length === 0) && (
                        <div className="rounded-md bg-white/70 px-3 py-6 text-center text-xs font-bold text-slate-500">Nenhuma instancia em risco agora.</div>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            )}

            {wooapiMonitor?.generated_at && (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-center gap-2">
                  <span className={cn("inline-block h-3 w-3 rounded-full", wooMetrics.instances_offline > 0 ? "bg-amber-500 animate-pulse" : "bg-emerald-500")} />
                  <span className="text-sm font-black text-slate-700">Plataforma</span>
                </div>
                <div className="flex flex-wrap gap-3 text-xs">
                  <span className="rounded-md bg-emerald-50 px-2 py-1 font-bold text-emerald-700">{formatNumber(wooMetrics.instances_online)} online</span>
                  {wooMetrics.instances_offline > 0 && <span className="rounded-md bg-red-50 px-2 py-1 font-bold text-red-700">{formatNumber(wooMetrics.instances_offline)} offline</span>}
                  {wooMetrics.instances_unstable > 0 && <span className="rounded-md bg-amber-50 px-2 py-1 font-bold text-amber-700">{formatNumber(wooMetrics.instances_unstable)} instaveis</span>}
                  <span className="rounded-md bg-blue-50 px-2 py-1 font-bold text-blue-700">{formatNumber(wooMetrics.messages_24h || 0)} msgs 24h</span>
                  {wooMetrics.webhook_failures_24h > 0 && <span className="rounded-md bg-rose-50 px-2 py-1 font-bold text-rose-700">{formatNumber(wooMetrics.webhook_failures_24h)} falhas webhook</span>}
                  <span className="rounded-md bg-purple-50 px-2 py-1 font-bold text-purple-700">{formatNumber(wooMetrics.open_alerts || 0)} alertas</span>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
              {[
                { label: 'Instancias online', value: wooMetrics.instances_online, icon: CheckCircle2, tone: 'text-emerald-600', bg: 'bg-emerald-50 border-emerald-200' },
                { label: 'Instancias offline', value: wooMetrics.instances_offline, icon: XCircle, tone: 'text-red-600', bg: 'bg-red-50 border-red-200' },
                { label: 'Instancias instaveis', value: wooMetrics.instances_unstable, icon: AlertCircle, tone: 'text-amber-600', bg: 'bg-amber-50 border-amber-200' },
                { label: 'Jobs pendentes', value: wooMetrics.pending_jobs, icon: Server, tone: 'text-blue-600', bg: 'bg-blue-50 border-blue-200' },
                { label: 'Alertas abertos', value: wooAlerts.length || wooMetrics.open_alerts, icon: ShieldCheck, tone: 'text-red-600', bg: 'bg-rose-50 border-rose-200' }
              ].map(({ label, value, icon: Icon, tone, bg }) => (
                <Card key={label} className={cn("border-2 p-4 transition-all hover:shadow-md", bg)}>
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">{label}</p>
                    <Icon size={20} className={tone} />
                  </div>
                  <p className="mt-2 text-3xl font-black text-slate-950">{formatNumber(value || 0)}</p>
                </Card>
              ))}
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { label: 'Mensagens 24h', value: wooMetrics.messages_24h, icon: MessageSquare },
                { label: 'Falhas de msg 24h', value: wooMetrics.message_failures_24h, icon: XCircle },
                { label: 'Webhooks ativos', value: wooMetrics.webhooks_active, icon: Webhook },
                { label: 'Falhas webhook 24h', value: wooMetrics.webhook_failures_24h, icon: AlertCircle },
                { label: 'Eventos WooAPI 24h', value: wooMetrics.wooapi_events_24h, icon: Activity },
                { label: 'Webhook retrying', value: wooMetrics.webhook_retrying, icon: RefreshCw },
                { label: 'Webhook pending', value: wooMetrics.webhook_pending, icon: Clock },
                { label: 'Tempo medio webhook', value: `${formatNumber(wooMetrics.avg_webhook_duration_ms || 0)} ms`, icon: BarChart3 }
              ].map(({ label, value, icon: Icon }) => (
                <div key={label} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 transition-all hover:border-slate-300 hover:shadow-sm">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-slate-50 text-slate-400">
                    <Icon size={18} />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-[10px] font-black uppercase tracking-wider text-slate-400">{label}</p>
                    <p className="mt-0.5 text-lg font-black text-slate-900">{typeof value === 'number' ? formatNumber(value) : value}</p>
                  </div>
                </div>
              ))}
            </div>

            <Card className="p-6">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-black text-slate-950">Arquitetura em operacao</h3>
                  <p className="text-sm text-slate-500">Componentes visiveis da plataforma WooAPI.</p>
                </div>
                <span className="rounded-md bg-emerald-50 px-3 py-1 text-xs font-black text-emerald-700">WooAPI Platform</span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
                {[
                  ['wooapi-api', 'API REST, painel e WebSocket', 'bg-blue-50 border-blue-200', 'text-blue-700'],
                  ['redis', 'Persistencia AOF para filas BullMQ', 'bg-red-50 border-red-200', 'text-red-700'],
                  ['wooapi-webhook-worker', 'Entrega HTTP, HMAC e retry', 'bg-purple-50 border-purple-200', 'text-purple-700'],
                  ['wooapi-message-worker', 'Envio assincrono de mensagens', 'bg-emerald-50 border-emerald-200', 'text-emerald-700'],
                  ['wooapi-monitor-worker', 'Health check periodico das instancias', 'bg-amber-50 border-amber-200', 'text-amber-700'],
                  ['wooapi-alert-worker', 'Regras de alerta e notificacao', 'bg-rose-50 border-rose-200', 'text-rose-700']
                ].map(([name, text, bg, txtColor]) => (
                  <div key={name} className={cn("rounded-md border p-4", bg)}>
                    <p className={cn("text-xs font-black uppercase tracking-wide", txtColor)}>{name}</p>
                    <p className="mt-1 text-[11px] text-slate-500">{text}</p>
                  </div>
                ))}
              </div>
            </Card>

            <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
              <Card className="overflow-hidden">
                <div className="border-b border-slate-100 p-5">
                  <h3 className="text-lg font-black">Filas BullMQ</h3>
                  <p className="text-sm text-slate-500">Redis, backlog e status por responsabilidade.</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 text-[11px] font-black uppercase text-slate-400">
                      <tr>
                        <th className="px-5 py-3">Fila</th>
                        <th className="px-5 py-3">Status</th>
                        <th className="px-5 py-3">Waiting</th>
                        <th className="px-5 py-3">Active</th>
                        <th className="px-5 py-3">Failed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {wooQueues.map((queue: any) => (
                        <tr key={queue.name} className="border-t border-slate-100">
                          <td className="px-5 py-3">
                            <p className="font-black text-slate-900">{queue.label}</p>
                            <p className="text-[11px] text-slate-400">{queue.name}</p>
                          </td>
                          <td className="px-5 py-3">
                            <span className={cn("rounded px-2 py-1 text-[10px] font-black", queue.available ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700")}>
                              {queue.available ? 'ONLINE' : 'OFFLINE'}
                            </span>
                          </td>
                          <td className="px-5 py-3 font-bold">{formatNumber(queue.waiting || 0)}</td>
                          <td className="px-5 py-3 font-bold">{formatNumber(queue.active || 0)}</td>
                          <td className="px-5 py-3">
                            <span className={cn("font-bold", Number(queue.failed || 0) > 0 ? "text-red-600" : "text-slate-900")}>
                              {formatNumber(queue.failed || 0)}
                            </span>
                          </td>
                        </tr>
                      ))}
                      {wooQueues.length === 0 && (
                        <tr><td colSpan={5} className="px-5 py-10 text-center text-sm text-slate-400">Sem metricas de fila ainda.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Card>

            <Card className="overflow-hidden">
                <div className="border-b border-slate-100 p-5">
                  <h3 className="text-lg font-black">Alertas de Suporte</h3>
                  <p className="text-sm text-slate-500">Alertas reais e alertas calculados pela Central WooAPI.</p>
                </div>
                <div className="divide-y divide-slate-100">
                  {wooAlerts.slice(0, 10).map((alert: any) => (
                    <div key={alert.id} className="flex items-start gap-3 p-4">
                      <div className={cn("mt-1 h-2.5 w-2.5 rounded-full shrink-0", alert.severity === 'critical' ? "bg-red-500 animate-pulse" : alert.severity === 'warning' ? "bg-amber-500" : "bg-slate-400")} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-black text-slate-900 truncate">{displayText(alert.title, 'Alerta')}</p>
                          <div className="flex shrink-0 gap-1">
                            {alert.status === 'open' && !String(alert.id).startsWith('synthetic_') && (
                              <>
                                <button
                                  onClick={async () => {
                                    await apiFetch(`/api/admin/alerts/${alert.id}/acknowledge`, { method: 'POST' });
                                    fetchData();
                                  }}
                                  className="rounded bg-slate-100 px-2 py-1 text-[10px] font-black text-slate-600 hover:bg-blue-100 hover:text-blue-700"
                                >Reconhecer</button>
                                <button
                                  onClick={async () => {
                                    await apiFetch(`/api/admin/alerts/${alert.id}/resolve`, { method: 'POST' });
                                    fetchData();
                                  }}
                                  className="rounded bg-slate-100 px-2 py-1 text-[10px] font-black text-slate-600 hover:bg-emerald-100 hover:text-emerald-700"
                                >Resolver</button>
                              </>
                            )}
                          </div>
                        </div>
                        <p className="text-xs text-slate-500">{displayText(alert.description || alert.type, 'Sem descricao')}</p>
                        <div className="mt-1 flex items-center gap-2">
                          <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-black uppercase", alert.severity === 'critical' ? "bg-red-50 text-red-700" : alert.severity === 'warning' ? "bg-amber-50 text-amber-700" : "bg-slate-50 text-slate-600")}>
                            {alert.severity}
                          </span>
                          <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-black uppercase", alert.status === 'open' ? "bg-blue-50 text-blue-700" : alert.status === 'acknowledged' ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700")}>
                            {alert.status}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                  {wooAlerts.length === 0 && <p className="py-12 text-center text-sm text-slate-400">Nenhum alerta aberto agora.</p>}
                </div>
              </Card>
            </div>

            <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
              <Card className="overflow-hidden">
                <div className="border-b border-slate-100 p-5">
                  <h3 className="text-lg font-black">Logs Globais ao Vivo</h3>
                  <p className="text-sm text-slate-500">Erros, desconexoes, API, mensagens e webhooks de todas as instancias.</p>
                </div>
                <div className="h-96 overflow-y-auto bg-slate-950 p-3 font-mono text-xs text-slate-100">
                  {wooLiveLogs.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-slate-500">Aguardando logs operacionais.</div>
                  ) : (
                    <div className="space-y-2">
                      {wooLiveLogs.slice(0, 80).map((log: any, index: number) => {
                        const isError = log.success === false || log.error || Number(log.status_code || 0) >= 400 || String(log.status || '').toLowerCase().includes('fail');
                        return (
                          <div key={`${log.source}-${log.id || index}-${log.created_at}`} className="rounded-md border border-white/10 bg-white/5 p-3">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className={cn("rounded px-2 py-0.5 text-[10px] font-black uppercase", isError ? "bg-red-500/20 text-red-200" : "bg-emerald-500/20 text-emerald-200")}>{log.source}</span>
                                  {log.account_id && <span className="text-[10px] text-slate-400">conta #{log.account_id}</span>}
                                  {log.instance_id && <span className="text-[10px] text-slate-400">inst #{log.instance_id}</span>}
                                </div>
                                <p className="mt-1 break-words font-bold text-white">{log.event || log.path || log.title || log.message_id || 'evento'}</p>
                                <p className="mt-1 break-words text-slate-300">{log.error || log.description || log.status || log.direction || log.method || 'sem detalhes'}</p>
                              </div>
                              <span className="shrink-0 text-[10px] text-slate-500">{log.created_at ? new Date(log.created_at).toLocaleTimeString('pt-BR') : ''}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </Card>

              <Card className="overflow-hidden">
                <div className="border-b border-slate-100 p-5">
                  <h3 className="text-lg font-black">Tickets de Suporte</h3>
                  <p className="text-sm text-slate-500">Escalonamentos abertos pelo agente e chamados dos clientes.</p>
                </div>
                <div className="divide-y divide-slate-100">
                  {wooSupportTickets.slice(0, 12).map((ticket: any) => (
                    <div key={ticket.id} className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-black text-slate-900">#{ticket.id} {ticket.subject}</p>
                          <p className="text-xs text-slate-500">{ticket.account_name || `Conta #${ticket.account_id}`} {ticket.instance_name ? `- ${ticket.instance_name}` : ''}</p>
                          {ticket.ai_summary && <p className="mt-2 text-xs text-slate-500">{ticket.ai_summary}</p>}
                        </div>
                        <span className={cn("shrink-0 rounded px-2 py-1 text-[10px] font-black uppercase", ticket.status === 'resolved' ? "bg-emerald-50 text-emerald-700" : ticket.priority === 'high' ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700")}>
                          {ticket.status}
                        </span>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          onClick={async () => {
                            const text = prompt(`Responder ticket #${ticket.id}`);
                            if (!text) return;
                            await apiFetch(`/api/admin/support/tickets/${ticket.id}/messages`, { method: 'POST', body: JSON.stringify({ message: text }) });
                            fetchData();
                          }}
                          className="rounded bg-slate-900 px-3 py-2 text-xs font-black text-white"
                        >
                          Responder
                        </button>
                        {ticket.status !== 'resolved' && (
                          <button
                            onClick={async () => {
                              await apiFetch(`/api/admin/support/tickets/${ticket.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) });
                              fetchData();
                            }}
                            className="rounded bg-emerald-50 px-3 py-2 text-xs font-black text-emerald-700"
                          >
                            Resolver
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  {wooSupportTickets.length === 0 && <p className="py-12 text-center text-sm text-slate-400">Nenhum ticket aberto.</p>}
                </div>
              </Card>
            </div>

            <Card className="overflow-hidden">
              <div className="border-b border-slate-100 p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-black">Saude das Instancias</h3>
                    <p className="text-sm text-slate-500">Status tecnico, saude operacional, webhooks e falhas recentes.</p>
                  </div>
                  <span className="hidden rounded-md bg-slate-100 px-3 py-1 text-xs font-black text-slate-600 md:inline-block">{formatNumber(wooInstances.length)} instancias</span>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-[11px] font-black uppercase text-slate-400">
                    <tr>
                      <th className="px-4 py-3">Cliente / Instancia</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Saude</th>
                      <th className="px-4 py-3">Webhooks</th>
                      <th className="px-4 py-3">Msgs 24h</th>
                      <th className="px-4 py-3">Falhas 24h</th>
                      <th className="px-4 py-3">Latencia</th>
                      <th className="px-4 py-3">Risco / Acao</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wooInstances.map((inst: any) => {
                      const healthMap: Record<string, { dot: string; bg: string; pulse: boolean }> = {
                        healthy: { dot: "bg-emerald-500", bg: "bg-emerald-50 text-emerald-700", pulse: false },
                        degraded: { dot: "bg-amber-500", bg: "bg-amber-50 text-amber-700", pulse: false },
                        unstable: { dot: "bg-orange-500", bg: "bg-orange-50 text-orange-700", pulse: false },
                        offline: { dot: "bg-red-500", bg: "bg-red-50 text-red-700", pulse: false },
                        critical: { dot: "bg-rose-500", bg: "bg-rose-50 text-rose-700", pulse: true }
                      };
                      const h = healthMap[inst.operational_status] || { dot: "bg-slate-400", bg: "bg-slate-50 text-slate-600", pulse: false };
                      return (
                        <tr key={inst.id} className="border-t border-slate-100 transition-colors hover:bg-slate-50/50">
                          <td className="px-4 py-3">
                            <p className="font-bold text-slate-900">{displayText(inst.name, `Instancia #${inst.id}`)}</p>
                            <p className="text-[11px] text-slate-400">{displayText(inst.account_name, `Conta #${inst.account_id}`)} · {displayText(inst.phone_connected || inst.phone)}</p>
                          </td>
                          <td className="px-4 py-3">
                            <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-black uppercase", isConnectedStatus(inst.status) ? "bg-emerald-50 text-emerald-700" : isQrStatus(inst.status) ? "bg-blue-50 text-blue-700" : inst.status === 'connecting' ? "bg-amber-50 text-amber-700" : "bg-slate-50 text-slate-600")}>
                              {instanceStatusLabel(inst.status)}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1.5">
                              <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", h.dot, h.pulse && "animate-pulse")} />
                              <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-black uppercase", h.bg)}>
                                {inst.operational_status || 'unknown'}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3 font-bold">{formatNumber(inst.active_webhooks || 0)}</td>
                          <td className="px-4 py-3 font-bold">{formatNumber(inst.messages_24h || 0)}</td>
                          <td className="px-4 py-3 font-bold">{formatNumber((inst.message_failures_24h || 0) + (inst.webhook_failures_24h || 0))}</td>
                          <td className="px-4 py-3 font-bold">{formatNumber(inst.avg_webhook_duration_ms || 0)} ms</td>
                          <td className="px-4 py-3">
                            <div className="flex items-start gap-2">
                              <span className={cn(
                                "rounded px-2 py-1 text-[10px] font-black",
                                Number(inst.risk_score || 0) >= 70 ? "bg-rose-50 text-rose-700" :
                                Number(inst.risk_score || 0) >= 35 ? "bg-amber-50 text-amber-700" :
                                "bg-emerald-50 text-emerald-700"
                              )}>{formatNumber(inst.risk_score || 0)}</span>
                              <div className="min-w-[180px]">
                                <p className="text-[11px] font-bold text-slate-700">{inst.recommended_action || 'Sem acao imediata.'}</p>
                                {inst.last_seen_minutes !== null && inst.last_seen_minutes !== undefined && (
                                  <p className="mt-1 text-[10px] text-slate-400">ultima atividade ha {formatNumber(inst.last_seen_minutes)} min</p>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {wooInstances.length === 0 && (
                      <tr><td colSpan={8} className="px-5 py-10 text-center text-sm text-slate-400">Nenhuma instancia cadastrada ainda.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>

            <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
              <Card className="overflow-hidden">
                <div className="border-b border-slate-100 p-5">
                  <h3 className="text-lg font-black">Webhooks por Instancia</h3>
                  <p className="text-sm text-slate-500">Configuracoes cadastradas no novo modulo de webhooks.</p>
                </div>
                <div className="divide-y divide-slate-100">
                  {wooWebhooks.slice(0, 10).map((hook: any) => (
                    <div key={hook.id} className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-black text-slate-900">{displayText(hook.name, 'Webhook WooAPI')}</p>
                          <p className="text-xs text-slate-500">{displayText(hook.account_name, `Conta #${hook.account_id}`)} - {displayText(hook.instance_name, `Instancia #${hook.instance_id}`)}</p>
                        </div>
                        <span className={cn("rounded px-2 py-1 text-[10px] font-black", hook.is_active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500")}>
                          {hook.is_active ? 'ATIVO' : 'PAUSADO'}
                        </span>
                      </div>
                      <p className="mt-2 truncate rounded bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-500">{hook.url}</p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {parseList(hook.events).slice(0, 4).map((event: any, index: number) => (
                          <span key={`${displayText(event, 'event')}_${index}`} className="rounded bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600">{displayText(event, 'evento')}</span>
                        ))}
                        {parseList(hook.events).length === 0 && <span className="rounded bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600">todos os eventos</span>}
                      </div>
                    </div>
                  ))}
                  {wooWebhooks.length === 0 && <p className="py-12 text-center text-sm text-slate-400">Nenhum webhook novo cadastrado ainda.</p>}
                </div>
              </Card>

              <Card className="overflow-hidden">
                <div className="border-b border-slate-100 p-5">
                  <h3 className="text-lg font-black">Logs de Entrega</h3>
                  <p className="text-sm text-slate-500">Cada tentativa do worker aparece aqui.</p>
                </div>
                <div className="divide-y divide-slate-100">
                  {wooWebhookLogs.slice(0, 10).map((log: any) => (
                    <div key={log.id} className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-black text-slate-900">{displayText(log.event, 'Evento')}</p>
                          <p className="text-xs text-slate-500">{displayText(log.webhook_name, 'Webhook')} - tentativa {displayText(log.attempt, '1')}</p>
                        </div>
                        <span className={cn("rounded px-2 py-1 text-[10px] font-black", log.success ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700")}>
                          {log.success ? 'SUCESSO' : 'FALHA'}
                        </span>
                      </div>
                      <p className="mt-2 text-xs text-slate-500">HTTP {log.status_code || '-'} - {formatNumber(log.duration_ms || 0)} ms - {log.instance_name || `Instancia #${log.instance_id}`}</p>
                      {log.error && <p className="mt-1 text-xs font-bold text-red-600">{displayText(log.error)}</p>}
                    </div>
                  ))}
                  {wooWebhookLogs.length === 0 && <p className="py-12 text-center text-sm text-slate-400">Nenhuma tentativa registrada ainda.</p>}
                </div>
              </Card>
            </div>
          </div>
        )}

        {activeSubTab === 'accounts' && (
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[360px_1fr]">
            <Card className="h-fit p-6">
              <div className="mb-5 flex items-center gap-3">
                <UserCog size={20} className="text-red-600" />
                <h3 className="text-lg font-black">Nova Conta</h3>
              </div>
              <div className="space-y-3">
                <input className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" placeholder="Empresa" value={newAccount.name} onChange={e => setNewAccount({ ...newAccount, name: e.target.value })} />
                <input className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" placeholder="Nome do admin" value={newAccount.owner_name} onChange={e => setNewAccount({ ...newAccount, owner_name: e.target.value })} />
                <input className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" placeholder="E-mail do admin" value={newAccount.owner_email} onChange={e => setNewAccount({ ...newAccount, owner_email: e.target.value })} />
                <input className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" placeholder="Senha inicial" type="password" value={newAccount.password} onChange={e => setNewAccount({ ...newAccount, password: e.target.value })} />
                <select className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" value={newAccount.plan_id} onChange={e => setNewAccount({ ...newAccount, plan_id: e.target.value })}>
                  <option value="">Plano...</option>
                  {plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <select className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" value={newAccount.account_type} onChange={e => setNewAccount({ ...newAccount, account_type: e.target.value })}>
                  <option value="client">Cliente final</option>
                  <option value="reseller">Revendedor</option>
                  <option value="owner">Dono do sistema</option>
                </select>
                <div className="grid grid-cols-2 gap-2">
                  <input className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" placeholder="Instancias" type="number" value={newAccount.instance_quota} onChange={e => setNewAccount({ ...newAccount, instance_quota: Number(e.target.value) })} />
                  <input className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" placeholder="Clientes" type="number" value={newAccount.max_client_accounts} onChange={e => setNewAccount({ ...newAccount, max_client_accounts: Number(e.target.value) })} />
                </div>
                <button onClick={createAccount} className="flex w-full items-center justify-center gap-2 rounded-md bg-red-600 py-3 text-sm font-black text-white transition-colors hover:bg-red-700">
                  <Plus size={18} />
                  Criar cliente
                </button>
              </div>
            </Card>

            <Card className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left">
                <thead>
                  <tr className="border-b border-slate-100 bg-white text-xs font-black uppercase text-slate-400">
                    <th className="px-6 py-4">Cliente</th>
                    <th className="px-6 py-4">Plano</th>
                    <th className="px-6 py-4">Uso</th>
                    <th className="px-6 py-4">Status</th>
                    <th className="px-6 py-4">Acoes</th>
                  </tr>
                </thead>
                <tbody className="text-sm">
                  {accounts.map((acc) => (
                    <tr key={acc.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-6 py-4">
                        <p className="font-black text-slate-900">{displayText(acc.name, `Conta #${acc.id}`)}</p>
                        <p className="text-xs text-slate-500">{displayText(acc.owner_email, `Conta #${acc.id}`)}</p>
                      </td>
                      <td className="px-6 py-4">
                        <select className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs font-semibold" value={acc.plan_id || ''} onChange={(e) => updateAccountPlan(acc.id, e.target.value ? Number(e.target.value) : null)}>
                          <option value="">Sem plano</option>
                          {plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      </td>
                      <td className="px-6 py-4 text-xs text-slate-500">
                        <p>Instancias: <strong>{acc.usage?.instances || 0}/{acc.max_instances || '-'}</strong></p>
                        <p>Usuarios: <strong>{acc.usage?.users || 0}/{acc.max_users || '-'}</strong></p>
                        <p>Mensagens: <strong>{formatNumber(acc.usage?.messages || 0)}/{formatNumber(acc.max_messages || 0)}</strong></p>
                      </td>
                      <td className="px-6 py-4">
                        <select className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs font-semibold" value={acc.status || 'active'} onChange={(e) => updateAccountStatus(acc.id, e.target.value)}>
                          <option value="active">Ativa</option>
                          <option value="paused">Pausada</option>
                          <option value="blocked">Bloqueada</option>
                        </select>
                      </td>
                      <td className="px-6 py-4">
                        <button onClick={() => impersonateAccount(acc.id)} className="rounded-md bg-slate-900 px-3 py-2 text-xs font-black text-white hover:bg-red-600">
                          Acessar conta
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        )}

        {activeSubTab === 'plans' && (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[360px_1fr]">
            <Card className="h-fit p-6">
              <div className="mb-5 flex items-center gap-3">
                <CreditCard size={20} className="text-red-600" />
                <h3 className="text-lg font-black">Novo Plano</h3>
              </div>
              <div className="space-y-4">
                <input type="text" placeholder="Nome do plano" className="w-full rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-sm" value={newPlan.name} onChange={(e) => setNewPlan({ ...newPlan, name: e.target.value })} />
                <input type="number" placeholder="Preco" className="w-full rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-sm" value={newPlan.price} onChange={(e) => setNewPlan({ ...newPlan, price: Number(e.target.value) })} />
                <div className="grid grid-cols-2 gap-2">
                  {[
                    ['Instancias', 'max_instances'],
                    ['Usuarios', 'max_users'],
                    ['Mensagens', 'max_messages'],
                    ['Clientes', 'max_client_accounts']
                  ].map(([label, key]) => (
                    <label key={key} className="text-[10px] font-black uppercase text-slate-400">
                      {label}
                      <input
                        type="number"
                        className="mt-1 w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-2 text-xs"
                        value={(newPlan as any)[key]}
                        onChange={(e) => setNewPlan({ ...newPlan, [key]: Number(e.target.value) } as any)}
                      />
                    </label>
                  ))}
                </div>
                <textarea rows={3} placeholder="Recursos separados por virgula" className="w-full resize-none rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-sm" value={newPlan.features} onChange={(e) => setNewPlan({ ...newPlan, features: e.target.value })} />
                <button onClick={createPlan} className="flex w-full items-center justify-center gap-2 rounded-md bg-red-600 py-3 text-sm font-black text-white hover:bg-red-700">
                  <Plus size={18} />
                  Criar Plano
                </button>
              </div>
            </Card>

            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              {plans.map((plan) => (
                <Card key={plan.id} className="border-t-4 border-t-red-600 p-6">
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <h4 className="text-xl font-black">{plan.name}</h4>
                    <span className="text-xl font-black text-red-600">{formatCurrency(plan.price)}</span>
                  </div>
                  <div className="space-y-2 text-xs text-slate-500">
                    <p className="flex justify-between"><span>Instancias</span><strong>{plan.max_instances}</strong></p>
                    <p className="flex justify-between"><span>Usuarios</span><strong>{plan.max_users}</strong></p>
                    <p className="flex justify-between"><span>Mensagens/mes</span><strong>{formatNumber(plan.max_messages)}</strong></p>
                    <p className="flex justify-between"><span>Clientes filhos</span><strong>{plan.max_client_accounts || 0}</strong></p>
                  </div>
                  <div className="mt-5 flex flex-wrap gap-2">
                    {parseList(plan.features_json).map((f: any, i: number) => (
                      <span key={i} className="rounded bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600">{displayText(f, 'recurso')}</span>
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}

        {activeSubTab === 'monitor' && (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <Card className="p-6">
              <h3 className="mb-4 text-lg font-black">Saude do SaaS</h3>
              <div className="space-y-3 text-sm">
                <p className="flex justify-between"><span className="text-slate-500">API Node</span><span className="font-black text-emerald-600">Online</span></p>
                <p className="flex justify-between"><span className="text-slate-500">WooAPI Core</span><span className="font-black">{connectedInstances ? 'Ativo' : 'Monitorar'}</span></p>
                <p className="flex justify-between"><span className="text-slate-500">Webhooks falhos</span><span className="font-black">{formatNumber(failedWebhooks)}</span></p>
                <p className="flex justify-between"><span className="text-slate-500">Mensagens no mes</span><span className="font-black">{formatNumber(overview?.messages_month || 0)}</span></p>
              </div>
            </Card>
            <Card className="p-6 lg:col-span-2">
              <h3 className="mb-4 text-lg font-black">Contas proximas do limite</h3>
              <div className="space-y-3">
                {nearLimitAccounts.map(acc => (
                  <div key={acc.id} className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 p-3">
                    <div>
                      <p className="font-bold">{displayText(acc.name, `Conta #${acc.id}`)}</p>
                      <p className="text-xs text-slate-500">Instancias: {acc.usage?.instances}/{acc.max_instances}</p>
                    </div>
                    <button onClick={() => impersonateAccount(acc.id)} className="rounded-md bg-red-600 px-3 py-2 text-xs font-black text-white">Acessar</button>
                  </div>
                ))}
                {nearLimitAccounts.length === 0 && <p className="py-10 text-center text-sm text-slate-500">Nenhuma conta estourando limite agora.</p>}
              </div>
            </Card>
          </div>
        )}

        {activeSubTab === 'webhooks' && (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <Card className="p-6">
              <Webhook className="mb-4 text-red-600" size={26} />
              <h3 className="text-lg font-black">Entregas de Webhook</h3>
              <p className="mt-2 text-sm text-slate-500">Use esta area para enxergar falhas globais e entrar na conta afetada.</p>
              <p className="mt-6 text-3xl font-black text-slate-950">{formatNumber(failedWebhooks)}</p>
              <p className="text-xs font-bold uppercase text-slate-400">falhas registradas</p>
            </Card>
            <Card className="p-6 lg:col-span-2">
              <h3 className="mb-4 text-lg font-black">Clientes para revisar</h3>
              <div className="space-y-3">
                {(failedWebhooks > 0 ? accounts.slice(0, 6) : []).map((acc) => (
                  <div key={acc.id} className="flex items-center justify-between rounded-md border border-slate-100 bg-slate-50 p-3">
                    <div>
                      <p className="font-bold text-slate-900">{displayText(acc.name, `Conta #${acc.id}`)}</p>
                      <p className="text-xs text-slate-500">{displayText(acc.owner_email)}</p>
                    </div>
                    <button onClick={() => impersonateAccount(acc.id)} className="rounded-md bg-slate-900 px-3 py-2 text-xs font-black text-white">Investigar</button>
                  </div>
                ))}
                {failedWebhooks === 0 && <p className="py-10 text-center text-sm text-slate-500">Nenhuma falha de webhook no momento.</p>}
              </div>
            </Card>
          </div>
        )}

        {activeSubTab === 'external_integrations' && (
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[360px_1fr]">
            <Card className="h-fit p-6">
              <div className="mb-5 flex items-center gap-3">
                <Puzzle size={20} className="text-red-600" />
                <h3 className="text-lg font-black">Nova Integracao</h3>
              </div>
              <div className="space-y-3">
                <input className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" placeholder="Nome" value={newIntegration.name} onChange={e => setNewIntegration({ ...newIntegration, name: e.target.value })} />
                <input className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" placeholder="https://evolution.seudominio.com" value={newIntegration.base_url} onChange={e => setNewIntegration({ ...newIntegration, base_url: e.target.value })} />
                <input className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" placeholder="Chave admin" type="password" value={newIntegration.admin_key} onChange={e => setNewIntegration({ ...newIntegration, admin_key: e.target.value })} />
                <div className="grid grid-cols-2 gap-2">
                  <input className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs" placeholder="Header" value={newIntegration.auth_header} onChange={e => setNewIntegration({ ...newIntegration, auth_header: e.target.value })} />
                  <input className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs" placeholder="Prefixo" value={newIntegration.auth_prefix} onChange={e => setNewIntegration({ ...newIntegration, auth_prefix: e.target.value })} />
                </div>
                <input className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs" placeholder="/instance/fetchInstances" value={newIntegration.list_instances_path} onChange={e => setNewIntegration({ ...newIntegration, list_instances_path: e.target.value })} />
                <input className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs" placeholder="/instance/create" value={newIntegration.create_instance_path} onChange={e => setNewIntegration({ ...newIntegration, create_instance_path: e.target.value })} />
                <button onClick={createExternalIntegration} className="flex w-full items-center justify-center gap-2 rounded-md bg-red-600 py-3 text-sm font-black text-white hover:bg-red-700">
                  <Plus size={18} />
                  Criar integracao
                </button>
              </div>
            </Card>

            <div className="space-y-5">
              <Card className="p-6">
                <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <h3 className="text-lg font-black">Sistemas Externos</h3>
                    <p className="text-sm text-slate-500">Disponivel apenas ao super admin, com liberacao individual por cliente.</p>
                  </div>
                  <select className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold" value={selectedIntegrationId || ''} onChange={e => setSelectedIntegrationId(e.target.value ? Number(e.target.value) : null)}>
                    <option value="">Selecione...</option>
                    {externalIntegrations.map((integration) => <option key={integration.id} value={integration.id}>{integration.name}</option>)}
                  </select>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {externalIntegrations.map((integration) => (
                    <button key={integration.id} onClick={() => setSelectedIntegrationId(integration.id)} className={cn("rounded-md border p-4 text-left transition-colors", selectedIntegrationId === integration.id ? "border-red-200 bg-red-50" : "border-slate-100 bg-slate-50 hover:bg-white")}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-black text-slate-900">{displayText(integration.name, 'Integracao')}</p>
                          <p className="mt-1 text-xs text-slate-500">{displayText(integration.base_url)}</p>
                        </div>
                        <span className={cn("rounded px-2 py-1 text-[10px] font-black", integration.is_active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500")}>{integration.is_active ? 'ATIVA' : 'PAUSADA'}</span>
                      </div>
                      <p className="mt-3 text-xs text-slate-500">Chave {integration.admin_key_masked} - {formatNumber(integration.allowed_accounts || 0)} cliente(s) liberado(s)</p>
                    </button>
                  ))}
                </div>
              </Card>

              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                <Card className="p-6">
                  <h3 className="mb-4 text-lg font-black">Operacao Externa</h3>
                  <div className="space-y-3">
                    <button onClick={listExternalInstances} disabled={!selectedIntegrationId} className="flex w-full items-center justify-center gap-2 rounded-md bg-slate-900 py-3 text-sm font-black text-white disabled:opacity-50">
                      <RefreshCw size={17} />
                      Listar instancias
                    </button>
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_140px]">
                      <input className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" placeholder="Nome da nova instancia" value={newExternalInstance.instanceName} onChange={e => setNewExternalInstance({ ...newExternalInstance, instanceName: e.target.value })} />
                      <button onClick={createExternalInstance} disabled={!selectedIntegrationId} className="rounded-md bg-red-600 px-3 py-2 text-sm font-black text-white disabled:opacity-50">Criar</button>
                    </div>
                    {externalInstances && (
                      <pre className="max-h-80 overflow-auto rounded-md bg-slate-950 p-4 text-xs text-slate-100">{JSON.stringify(externalInstances, null, 2)}</pre>
                    )}
                  </div>
                </Card>

                <Card className="p-6">
                  <h3 className="mb-4 text-lg font-black">Liberar por Cliente</h3>
                  <div className="max-h-[420px] space-y-2 overflow-auto pr-1">
                    {integrationAccounts.map((acc) => (
                      <label key={acc.id} className="flex items-center justify-between gap-3 rounded-md border border-slate-100 bg-slate-50 p-3">
                        <div>
                          <p className="text-sm font-bold text-slate-900">{displayText(acc.name, `Conta #${acc.id}`)}</p>
                          <p className="text-xs text-slate-500">{displayText(acc.owner_email)}</p>
                        </div>
                        <input type="checkbox" checked={Boolean(acc.enabled)} onChange={e => toggleIntegrationAccount(acc.id, e.target.checked)} className="h-5 w-5 accent-red-600" />
                      </label>
                    ))}
                    {!selectedIntegrationId && <p className="py-10 text-center text-sm text-slate-400">Selecione uma integracao para liberar clientes.</p>}
                  </div>
                </Card>
              </div>
            </div>
          </div>
        )}

        {activeSubTab === 'partners' && (
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[360px_1fr]">
            <Card className="h-fit p-6">
              <div className="mb-5 flex items-center gap-3">
                <KeyRound size={20} className="text-red-600" />
                <h3 className="text-lg font-black">Novo Parceiro</h3>
              </div>
              <div className="space-y-3">
                <input className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" placeholder="Nome" value={newPartner.name} onChange={e => setNewPartner({ ...newPartner, name: e.target.value })} />
                <input className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" placeholder="E-mail" value={newPartner.email} onChange={e => setNewPartner({ ...newPartner, email: e.target.value })} />
                <input className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" placeholder="Telefone" value={newPartner.phone} onChange={e => setNewPartner({ ...newPartner, phone: e.target.value })} />
                <label className="text-[10px] font-black uppercase text-slate-400">
                  Comissao %
                  <input className="mt-1 w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" type="number" value={newPartner.commission_rate} onChange={e => setNewPartner({ ...newPartner, commission_rate: Number(e.target.value) })} />
                </label>
                <button onClick={createPartner} className="flex w-full items-center justify-center gap-2 rounded-md bg-red-600 py-3 text-sm font-black text-white hover:bg-red-700">
                  <Plus size={18} />
                  Criar parceiro
                </button>
              </div>
            </Card>

            <div className="space-y-5">
              <Card className="overflow-hidden">
                <div className="border-b border-slate-100 p-5">
                  <h3 className="text-lg font-black">Parceiros e Links</h3>
                  <p className="text-sm text-slate-500">Links de indicacao e resumo financeiro de comissoes.</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-left text-sm">
                    <thead className="bg-slate-50 text-[11px] font-black uppercase text-slate-400">
                      <tr>
                        <th className="px-5 py-3">Parceiro</th>
                        <th className="px-5 py-3">Link</th>
                        <th className="px-5 py-3">Comissao</th>
                        <th className="px-5 py-3">Pendentes</th>
                        <th className="px-5 py-3">Acoes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {partners.map((partner) => (
                        <tr key={partner.id} className="border-t border-slate-100">
                          <td className="px-5 py-4">
                            <p className="font-black text-slate-900">{displayText(partner.name, `Parceiro #${partner.id}`)}</p>
                            <p className="text-xs text-slate-500">{displayText(partner.email)}</p>
                          </td>
                          <td className="px-5 py-4">
                            <p className="max-w-[260px] truncate rounded bg-slate-50 px-2 py-1 font-mono text-xs text-slate-500">{partner.referral_link}</p>
                          </td>
                          <td className="px-5 py-4 font-bold">{formatNumber(partner.commission_rate)}%</td>
                          <td className="px-5 py-4 font-black text-red-600">{formatCurrency(partner.pending_commissions || 0)}</td>
                          <td className="px-5 py-4">
                            <button onClick={() => setSelectedPartnerId(partner.id)} className="rounded-md bg-slate-900 px-3 py-2 text-xs font-black text-white">Comissoes</button>
                          </td>
                        </tr>
                      ))}
                      {partners.length === 0 && <tr><td colSpan={5} className="px-5 py-10 text-center text-sm text-slate-400">Nenhum parceiro criado ainda.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card className="p-6">
                <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <h3 className="text-lg font-black">Gestao de Comissoes</h3>
                    <p className="text-sm text-slate-500">Registre manualmente vendas indicadas e marque pagamentos.</p>
                  </div>
                  <select className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold" value={selectedPartnerId || ''} onChange={e => setSelectedPartnerId(e.target.value ? Number(e.target.value) : null)}>
                    <option value="">Parceiro...</option>
                    {partners.map((partner) => <option key={partner.id} value={partner.id}>{partner.name}</option>)}
                  </select>
                </div>
                <div className="mb-5 grid grid-cols-1 gap-2 md:grid-cols-[1fr_120px_1fr_130px]">
                  <select className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" value={newCommission.account_id} onChange={e => setNewCommission({ ...newCommission, account_id: e.target.value })}>
                    <option value="">Cliente vinculado...</option>
                    {accounts.map((acc) => <option key={acc.id} value={acc.id}>{acc.name}</option>)}
                  </select>
                  <input className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" type="number" placeholder="Valor" value={newCommission.amount} onChange={e => setNewCommission({ ...newCommission, amount: Number(e.target.value) })} />
                  <input className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" placeholder="Descricao" value={newCommission.description} onChange={e => setNewCommission({ ...newCommission, description: e.target.value })} />
                  <button onClick={createPartnerCommission} disabled={!selectedPartnerId} className="rounded-md bg-red-600 px-3 py-2 text-sm font-black text-white disabled:opacity-50">Registrar</button>
                </div>
                <div className="space-y-2">
                  {partnerCommissions.map((commission) => (
                    <div key={commission.id} className="flex flex-col gap-3 rounded-md border border-slate-100 bg-slate-50 p-3 md:flex-row md:items-center md:justify-between">
                      <div>
                        <p className="font-bold text-slate-900">{formatCurrency(commission.amount)} - {displayText(commission.account_name, 'Sem cliente')}</p>
                        <p className="text-xs text-slate-500">{displayText(commission.description, 'Comissao de indicacao')}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={cn("rounded px-2 py-1 text-[10px] font-black", commission.status === 'paid' ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700")}>{commission.status === 'paid' ? 'PAGA' : 'PENDENTE'}</span>
                        {commission.status !== 'paid' && <button onClick={() => markCommissionPaid(commission.id)} className="rounded-md bg-slate-900 px-3 py-2 text-xs font-black text-white">Marcar paga</button>}
                      </div>
                    </div>
                  ))}
                  {selectedPartnerId && partnerCommissions.length === 0 && <p className="py-8 text-center text-sm text-slate-400">Nenhuma comissao registrada para este parceiro.</p>}
                </div>
              </Card>
            </div>
          </div>
        )}

        {activeSubTab === 'audit' && (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <Card className="p-6">
              <FileText className="mb-4 text-red-600" size={26} />
              <h3 className="text-lg font-black">Trilha de Auditoria</h3>
              <p className="mt-2 text-sm text-slate-500">Resumo visual das acoes sensiveis executadas pelo Super Admin.</p>
            </Card>
            <Card className="p-6 lg:col-span-2">
              <div className="space-y-3">
                {[
                  ['support.impersonate', 'Acesso de suporte em contas de clientes', KeyRound],
                  ['admin.account.updated', 'Alteracoes de plano, status e cotas', UserCog],
                  ['admin.account.created', 'Criacao de clientes e revendedores', Building2]
                ].map(([action, description, Icon]: any) => (
                  <div key={action} className="flex items-center gap-4 rounded-md border border-slate-100 bg-slate-50 p-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-md bg-white text-slate-600">
                      <Icon size={18} />
                    </div>
                    <div>
                      <p className="font-black text-slate-900">{action}</p>
                      <p className="text-sm text-slate-500">{description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}

        {activeSubTab === 'settings' && (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            {[
              { title: 'Dominios', text: 'Configure APP_URL, CORS e proxy reverso no Portainer.', icon: Globe2 },
              { title: 'Banco e Volume', text: 'Persistencia principal em /data para SQLite, sessoes e uploads.', icon: Database },
              { title: 'Feature Flags', text: 'Area reservada para ativar recursos por plano ou cliente.', icon: Flag },
              { title: 'Suporte', text: 'Use o acesso por conta para diagnostico sem trocar senha do cliente.', icon: LifeBuoy },
              { title: 'Analytics', text: 'Mensagens, instancias conectadas, churn e receita estimada.', icon: BarChart3 },
              { title: 'Seguranca', text: 'Segredos JWT, webhook e WooAPI Core devem ser fortes em producao.', icon: ShieldCheck }
            ].map(({ title, text, icon: Icon }) => (
              <Card key={title} className="p-6">
                <Icon className="mb-4 text-red-600" size={24} />
                <h3 className="font-black text-slate-950">{title}</h3>
                <p className="mt-2 text-sm text-slate-500">{text}</p>
              </Card>
            ))}
          </div>
        )}
      </section>
    </motion.div>
  );
};

export default function App() {
  const [auth, setAuth] = useState<{ accountId: number, user: any, account?: any, token?: string } | null>(() => {
    const saved = localStorage.getItem('wooapi_auth');
    if (!saved) return null;
    try {
      const parsed = JSON.parse(saved);
      if (!parsed?.token || !parsed?.user || typeof parsed.user !== 'object') return null;
      return parsed;
    } catch {
      localStorage.removeItem('wooapi_auth');
      return null;
    }
  });
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authForm, setAuthForm] = useState({ companyName: '', name: '', email: '', password: '' });

  const [activeTab, setActiveTab] = useState<'dashboard' | 'clients' | 'api_docs' | 'search' | 'leads' | 'agents' | 'whatsapp' | 'wooapi_monitor' | 'campaigns' | 'settings' | 'kanban' | 'messages' | 'groups' | 'agenda' | 'super_admin' | 'integrations' | 'support'>('dashboard');
  const [settingsSubTab, setSettingsSubTab] = useState<'credentials' | 'team'>('credentials');
  const [loading, setLoading] = useState(false);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [credentials, setCredentials] = useState<LLMCredential[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);

  // WhatsApp & Real-time States
  const [instances, setInstances] = useState<Instance[]>([]);
  const [selectedWooInstanceId, setSelectedWooInstanceId] = useState<number | null>(null);
  const [instanceWebhooks, setInstanceWebhooks] = useState<any[]>([]);
  const [webhookLogs, setWebhookLogs] = useState<any[]>([]);
  const [webhookEvents, setWebhookEvents] = useState<any[]>([]);
  const [platformMonitor, setPlatformMonitor] = useState<any>(null);
  const [newWebhook, setNewWebhook] = useState({
    name: 'Webhook n8n',
    url: '',
    events: 'message.received,message.sent,instance.disconnected',
    retry_enabled: true,
    max_attempts: 5
  });
  const [resellerOverview, setResellerOverview] = useState<any>(null);
  const [clientAccounts, setClientAccounts] = useState<any[]>([]);
  const [newClient, setNewClient] = useState({ name: '', owner_name: '', owner_email: '', password: '', instance_quota: 1, max_client_accounts: 0 });
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);
  const [chatMessages, setChatMessages] = useState<Message[]>([]);
  const [groups, setGroups] = useState<WhatsAppGroup[]>([]);
  const [selectedGroupJid, setSelectedGroupJid] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<WhatsAppGroup | null>(null);
  const [groupRules, setGroupRules] = useState<GroupRule[]>([]);
  const [groupModerationEvents, setGroupModerationEvents] = useState<any[]>([]);
  const [newGroup, setNewGroup] = useState({ name: '', participants: '' });
  const [groupParticipantInput, setGroupParticipantInput] = useState('');
  const [groupInviteInput, setGroupInviteInput] = useState('');
  const [newGroupRule, setNewGroupRule] = useState<GroupRule>({
    instance_id: 0,
    group_jid: '',
    name: '',
    rule_type: 'keyword',
    pattern: '',
    action: 'warn',
    warning_text: '',
    threshold: 1,
    window_minutes: 60,
    enabled: 1
  });
  const activeConversationIdRef = React.useRef<number | null>(null);
  const [newMessage, setNewMessage] = useState('');
  const [socket, setSocket] = useState<Socket | null>(null);
  const [wsStatus, setWsStatus] = useState<WhatsAppStatus>({ status: 'none', qr: null });
  const [qrModalInstance, setQrModalInstance] = useState<Instance | null>(null);
  const [testerInstance, setTesterInstance] = useState<Instance | null>(null);
  const [msgFilter, setMsgFilter] = useState<'all' | 'contact' | 'group'>('all');
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [liveMessages, setLiveMessages] = useState<any[]>([]);
  const [liveQueueMetrics, setLiveQueueMetrics] = useState<any>(null);
  const [supportTickets, setSupportTickets] = useState<any[]>([]);
  const [supportChatMessages, setSupportChatMessages] = useState<any[]>([
    { sender: 'ai', message: 'Oi, sou o agente de suporte WooAPI. Me diga o que aconteceu e qual instancia esta afetada; eu vou tentar resolver antes de abrir ticket.', created_at: new Date().toISOString() }
  ]);
  const [supportInput, setSupportInput] = useState('');
  const [supportInstanceId, setSupportInstanceId] = useState<number | ''>('');
  const [supportSending, setSupportSending] = useState(false);

  // Search State
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);

  // Agent Form State
  const [newAgent, setNewAgent] = useState({
    name: '',
    system_instruction: '',
    personality: 'Profissional e amigável',
    faq: [{ q: '', a: '' }],
    handoff_trigger: 'Quero falar com um humano'
  });

  // Campaign Form State
  const [newCampaign, setNewCampaign] = useState({
    name: '',
    agent_id: 0,
    initial_method: 'ai' as 'ai' | 'direct',
    transition_rules: {
      after_first_response: 'continue_ai',
      on_keyword: 'handoff'
    }
  });

  // Team Form State
  const [newMember, setNewMember] = useState({ name: '', role: '', email: '' });

  // Credentials Form State
  const [newCred, setNewCred] = useState({ provider: 'openai', name: '', api_key: '', model_name: '' });

  // Schedule Form State
  const [newSchedule, setNewSchedule] = useState({ name: '', agent_id: 0, member_id: 0, description: '' });

  // formatDate helper

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '';
    try {
      let normalized = dateStr;
      if (normalized.includes(' ') && !normalized.includes('T')) {
        normalized = normalized.replace(' ', 'T') + 'Z';
      } else if (normalized.includes('T') && !normalized.includes('Z') && !normalized.includes('+')) {
        normalized = normalized + 'Z';
      }
      const date = new Date(normalized);
      if (isNaN(date.getTime())) return dateStr;
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return dateStr;
    }
  };

  const API_URL = import.meta.env.VITE_API_URL || '';

  const apiFetch = async (url: string, options: any = {}) => {
    if (!auth) return null;
    const headers = {
      ...options.headers,
      'x-account-id': auth.accountId.toString(),
      ...(auth.token ? { 'Authorization': `Bearer ${auth.token}` } : {}),
      'Content-Type': 'application/json'
    };
    // Ensure absolute URL if API_URL is provided, otherwise relative
    const finalUrl = url.startsWith('http') ? url : `${API_URL}${url}`;
    let res: Response;
    try {
      res = await fetch(finalUrl, { ...options, headers });
    } catch (error) {
      console.error(`API Error: request failed for ${url}`, error);
      return null;
    }
    if (res.status === 401) {
      handleLogout();
      return null;
    }

    const contentType = res.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      const data = await res.json();
      if (data && data.success === true && Object.prototype.hasOwnProperty.call(data, 'data')) return data.data;
      return data;
    }

    // Non-JSON response (likely an error page)
    const text = await res.text();
    console.error(`API Error (${res.status}): Non-JSON response from ${url}`, text.substring(0, 100));
    return null;
  };

  const handleLogin = async () => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: authForm.email, password: authForm.password })
    });
    const data = await res.json();
    if (data.success) {
      const authData = { accountId: data.accountId, user: data.user, account: data.account, token: data.token };
      setAuth(authData);
      localStorage.setItem('wooapi_auth', JSON.stringify(authData));
    } else {
      alert(data.error || 'Erro ao entrar');
    }
  };

  const handleRegister = async () => {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authForm)
    });
    const data = await res.json();
    if (data.success) {
      setAuthMode('login');
      alert('Conta criada com sucesso! Faça login.');
    } else {
      alert(data.error || 'Erro ao criar conta');
    }
  };

  const handleLogout = () => {
    setAuth(null);
    localStorage.removeItem('wooapi_auth');
  };

  const handleImpersonate = (session: any) => {
    const authData = { accountId: session.accountId, user: session.user, account: session.account, token: session.token };
    setAuth(authData);
    localStorage.setItem('wooapi_auth', JSON.stringify(authData));
    setActiveTab('dashboard');
  };

  const fetchLeads = async () => {
    const data = await apiFetch('/api/leads');
    if (data) setLeads(data);
  };

  const fetchAgents = async () => {
    const data = await apiFetch('/api/agents');
    if (data) setAgents(data);
  };

  const fetchCampaigns = async () => {
    const data = await apiFetch('/api/campaigns');
    if (data) setCampaigns(data);
  };

  const fetchTeam = async () => {
    const data = await apiFetch('/api/team');
    if (data) setTeam(data);
  };

  const fetchCredentials = async () => {
    const data = await apiFetch('/api/credentials');
    if (data) setCredentials(data);
  };

  const fetchMessages = async () => {
    const data = await apiFetch('/api/messages');
    if (data) setMessages(data);
  };

  const fetchSchedules = async () => {
    const data = await apiFetch('/api/schedules');
    if (data) setSchedules(data);
  };

  const fetchInstances = async () => {
    const data = await apiFetch('/api/whatsapp/instances');
    if (data) {
      setInstances(data);
      if (!selectedWooInstanceId && data.length > 0) setSelectedWooInstanceId(data[0].id);
    }
  };

  const fetchWooApiPanel = async (instanceId = selectedWooInstanceId) => {
    const monitor = await apiFetch('/api/admin/wooapi-monitor');
    if (monitor) setPlatformMonitor(monitor);
    if (!instanceId) return;
    const [hooks, logs, events] = await Promise.all([
      apiFetch(`/api/whatsapp/instances/${instanceId}/webhooks`),
      apiFetch(`/api/whatsapp/instances/${instanceId}/webhook-logs`),
      apiFetch(`/api/whatsapp/instances/${instanceId}/webhook-events`)
    ]);
    if (Array.isArray(hooks)) setInstanceWebhooks(hooks);
    if (Array.isArray(logs)) setWebhookLogs(logs);
    if (Array.isArray(events)) setWebhookEvents(events);
  };

  const fetchGroups = async (instanceId = selectedWooInstanceId) => {
    if (!instanceId) return;
    const data = await apiFetch(`/api/groups?instance_id=${instanceId}`);
    if (Array.isArray(data)) {
      setGroups(data);
      if (!selectedGroupJid && data.length) setSelectedGroupJid(data[0].group_jid);
    }
  };

  const syncGroups = async () => {
    if (!selectedWooInstanceId) return;
    const data = await apiFetch('/api/groups/sync', {
      method: 'POST',
      body: JSON.stringify({ instance_id: selectedWooInstanceId })
    });
    if (data?.groups) {
      setGroups(data.groups);
      if (!selectedGroupJid && data.groups.length) setSelectedGroupJid(data.groups[0].group_jid);
    } else {
      fetchGroups();
    }
  };

  const fetchGroupDetails = async (jid = selectedGroupJid) => {
    if (!jid) return;
    const [details, rules, events] = await Promise.all([
      apiFetch(`/api/groups/${encodeURIComponent(jid)}`),
      apiFetch(`/api/groups/moderation/rules?instance_id=${selectedWooInstanceId || 0}&group_jid=${encodeURIComponent(jid)}`),
      apiFetch(`/api/groups/moderation/events?instance_id=${selectedWooInstanceId || 0}&group_jid=${encodeURIComponent(jid)}`)
    ]);
    if (details) setSelectedGroup(details);
    if (Array.isArray(rules)) setGroupRules(rules);
    if (Array.isArray(events)) setGroupModerationEvents(events);
  };

  const createGroup = async () => {
    if (!selectedWooInstanceId || !newGroup.name.trim()) return;
    const participants = newGroup.participants.split(/[\n,;]/).map(item => item.trim()).filter(Boolean);
    await apiFetch('/api/groups', {
      method: 'POST',
      body: JSON.stringify({ instance_id: selectedWooInstanceId, name: newGroup.name, participants })
    });
    setNewGroup({ name: '', participants: '' });
    syncGroups();
  };

  const groupAction = async (action: string, body: any = {}) => {
    if (!selectedGroupJid) return;
    const result = await apiFetch(`/api/groups/${encodeURIComponent(selectedGroupJid)}/action`, {
      method: 'POST',
      body: JSON.stringify({ action, ...body })
    });
    if (result) {
      fetchGroups();
      fetchGroupDetails();
    }
  };

  const joinGroupByInvite = async () => {
    if (!selectedWooInstanceId || !groupInviteInput.trim()) return;
    await apiFetch('/api/groups/join', {
      method: 'POST',
      body: JSON.stringify({ instance_id: selectedWooInstanceId, code: groupInviteInput })
    });
    setGroupInviteInput('');
    syncGroups();
  };

  const saveGroupRule = async () => {
    if (!selectedWooInstanceId || !newGroupRule.pattern.trim()) return;
    await apiFetch('/api/groups/moderation/rules', {
      method: 'POST',
      body: JSON.stringify({
        ...newGroupRule,
        instance_id: selectedWooInstanceId,
        group_jid: selectedGroupJid,
        name: newGroupRule.name || newGroupRule.pattern
      })
    });
    setNewGroupRule({ ...newGroupRule, name: '', pattern: '', warning_text: '' });
    fetchGroupDetails();
  };

  const toggleRule = async (rule: GroupRule) => {
    await apiFetch(`/api/groups/moderation/rules/${rule.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...rule, enabled: rule.enabled ? 0 : 1 })
    });
    fetchGroupDetails();
  };

  const deleteRule = async (ruleId?: number) => {
    if (!ruleId) return;
    await apiFetch(`/api/groups/moderation/rules/${ruleId}`, { method: 'DELETE' });
    fetchGroupDetails();
  };

  const assignSelectedInstance = async () => {
    if (!selectedWooInstanceId) return;
    await apiFetch(`/api/admin/platform/instances/${selectedWooInstanceId}/assign`, { method: 'POST', body: JSON.stringify({}) });
    await fetchInstances();
    fetchWooApiPanel(selectedWooInstanceId);
  };

  const transitionSelectedInstance = async (trigger: string) => {
    if (!selectedWooInstanceId) return;
    await apiFetch(`/api/admin/platform/instances/${selectedWooInstanceId}/state`, {
      method: 'POST',
      body: JSON.stringify({ trigger, metadata: { source: 'front_panel' } })
    });
    await fetchInstances();
    fetchWooApiPanel(selectedWooInstanceId);
  };

  const toggleNodeDrain = async (node: any) => {
    await apiFetch(`/api/admin/platform/core-nodes/${encodeURIComponent(node.id)}/drain`, {
      method: 'POST',
      body: JSON.stringify({ enabled: !Number(node.drain_mode || 0) })
    });
    fetchWooApiPanel(selectedWooInstanceId);
  };

  const createWebhook = async () => {
    if (!selectedWooInstanceId || !newWebhook.url) return;
    const events = newWebhook.events.split(',').map(event => event.trim()).filter(Boolean);
    await apiFetch(`/api/whatsapp/instances/${selectedWooInstanceId}/webhooks`, {
      method: 'POST',
      body: JSON.stringify({
        ...newWebhook,
        events,
        max_attempts: Number(newWebhook.max_attempts || 5)
      })
    });
    setNewWebhook({ name: 'Webhook n8n', url: '', events: 'message.received,message.sent,instance.disconnected', retry_enabled: true, max_attempts: 5 });
    fetchWooApiPanel(selectedWooInstanceId);
  };

  const toggleWebhook = async (webhook: any) => {
    await apiFetch(`/api/whatsapp/instances/${webhook.instance_id}/webhooks/${webhook.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ is_active: !webhook.is_active })
    });
    fetchWooApiPanel(webhook.instance_id);
  };

  const deleteWebhook = async (webhook: any) => {
    if (!confirm('Remover este webhook?')) return;
    await apiFetch(`/api/whatsapp/instances/${webhook.instance_id}/webhooks/${webhook.id}`, { method: 'DELETE' });
    fetchWooApiPanel(webhook.instance_id);
  };

  const testWebhook = async (webhook: any) => {
    await apiFetch(`/api/whatsapp/instances/${webhook.instance_id}/webhooks/${webhook.id}/test`, {
      method: 'POST',
      body: JSON.stringify({ source: 'painel', sent_at: new Date().toISOString() })
    });
    fetchWooApiPanel(webhook.instance_id);
  };

  const retryWebhookLog = async (logId: number) => {
    await apiFetch(`/api/whatsapp/webhook-logs/${logId}/retry`, { method: 'POST' });
    fetchWooApiPanel();
  };

  const fetchConversations = async () => {
    const data = await apiFetch('/api/conversations');
    if (data) setConversations(data);
  };

  const fetchSupportTickets = async () => {
    const data = await apiFetch('/api/support/tickets');
    if (Array.isArray(data)) setSupportTickets(data);
  };

  const sendSupportChat = async () => {
    const message = supportInput.trim();
    if (!message || supportSending) return;
    setSupportSending(true);
    setSupportInput('');
    const userMessage = { sender: 'customer', message, created_at: new Date().toISOString() };
    setSupportChatMessages(prev => [...prev, userMessage]);
    const response = await apiFetch('/api/support/chat', {
      method: 'POST',
      body: JSON.stringify({
        message,
        instance_id: supportInstanceId || undefined
      })
    });
    if (response?.reply) {
      setSupportChatMessages(prev => [...prev, {
        sender: 'ai',
        message: response.reply,
        ticket: response.ticket,
        created_at: new Date().toISOString()
      }]);
    } else {
      setSupportChatMessages(prev => [...prev, {
        sender: 'ai',
        message: 'Nao consegui consultar o suporte agora. Tente novamente em alguns segundos.',
        created_at: new Date().toISOString()
      }]);
    }
    if (response?.ticket) fetchSupportTickets();
    setSupportSending(false);
  };

  const fetchResellerOverview = async () => {
    const data = await apiFetch('/api/reseller/overview');
    if (data) setResellerOverview(data);
  };

  const fetchClientAccounts = async () => {
    const data = await apiFetch('/api/reseller/clients');
    if (data) setClientAccounts(data);
  };

  const canUseResellerPanel = () => {
    const role = auth?.user?.role;
    const accountType = auth?.account?.account_type;
    return role === 'super_admin' || accountType === 'owner' || accountType === 'reseller';
  };

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  const fetchChatMessages = async (convId: number) => {
    const data = await apiFetch(`/api/conversations/${convId}/messages`);
    if (data) setChatMessages(data);
  };

  // --- Routing & Navigation ---
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.replace('#', '') as any;
      const validTabs = ['dashboard', 'clients', 'api_docs', 'search', 'leads', 'agents', 'whatsapp', 'wooapi_monitor', 'campaigns', 'settings', 'kanban', 'messages', 'groups', 'agenda', 'super_admin', 'integrations', 'support'];
      if (validTabs.includes(hash)) {
        setActiveTab(hash);
      }
    };

    window.addEventListener('hashchange', handleHashChange);
    // Initial check
    if (window.location.hash) {
      handleHashChange();
    } else {
      window.location.hash = activeTab;
    }

    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  useEffect(() => {
    if (window.location.hash.replace('#', '') !== activeTab) {
      window.location.hash = activeTab;
    }
  }, [activeTab]);

  useEffect(() => {
    if (auth && auth.user?.role !== 'super_admin' && activeTab === 'super_admin') {
      setActiveTab('dashboard');
    }
  }, [auth, activeTab]);

  useEffect(() => {
    if (auth) {
      fetchLeads();
      fetchAgents();
      fetchCampaigns();
      fetchTeam();
      fetchCredentials();
      fetchMessages();
      fetchSchedules();
      fetchInstances();
      fetchConversations();
      fetchSupportTickets();
      if (canUseResellerPanel()) {
        fetchResellerOverview();
        fetchClientAccounts();
      }

      const newSocket = io(API_URL || window.location.origin, {
        query: { accountId: auth.accountId, token: auth.token },
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10000,
        randomizationFactor: 0.5,
        timeout: 20000
      });

      newSocket.on("connect", () => {
        console.log("[WS] connected");
      });

      newSocket.on("disconnect", (reason) => {
        console.log("[WS] disconnected:", reason);
      });

      newSocket.on("connect_error", (err) => {
        console.log("[WS] connection error:", err.message);
      });

      newSocket.on("wooapi:heartbeat", (data: any) => {
      });

      newSocket.on("instance.status", ({ instanceId, status, phoneConnected, profileName, profilePictureUrl }) => {
        setInstances(prev => prev.map(inst =>
          inst.id === instanceId ? {
            ...inst,
            status,
            phoneConnected: isConnectedStatus(status) ? (phoneConnected || inst.phoneConnected) : undefined,
            phone_connected: isConnectedStatus(status) ? (phoneConnected || inst.phone_connected) : undefined,
            profileName: isConnectedStatus(status) ? (profileName || inst.profileName) : undefined,
            profile_name: isConnectedStatus(status) ? (profileName || inst.profile_name) : undefined,
            profilePictureUrl: isConnectedStatus(status) ? (profilePictureUrl || inst.profilePictureUrl) : undefined,
            profile_picture_url: isConnectedStatus(status) ? (profilePictureUrl || inst.profile_picture_url) : undefined,
            qr: isConnectedStatus(status) ? null : inst.qr
          } : inst
        ));

        // Update global wsStatus for sidebar/dashboard compatibility
        if (isConnectedStatus(status)) {
          setQrModalInstance(prev => prev?.id === instanceId ? null : prev);
          setWsStatus({ status: 'connected', qr: null });
        }
      });

      newSocket.on("instance.qr", ({ instanceId, qr }) => {
        setInstances(prev => prev.map(inst =>
          inst.id === instanceId ? { ...inst, qr, status: 'qr_pending' } : inst
        ));
        setWsStatus({ status: 'qr_pending', qr });
        // Re-open or update the QR modal even when it was closed during QR rotation
        setQrModalInstance(prev => {
          if (prev?.id === instanceId) return { ...prev, qr, status: 'qr_pending' };
          // Modal is closed but a new QR arrived — re-open it
          setInstances(current => {
            const targetInst = current.find(i => i.id === instanceId);
            if (targetInst) {
              // Schedule update outside this render to avoid nested setState
              setTimeout(() => setQrModalInstance({ ...targetInst, qr, status: 'qr_pending' }), 0);
            }
            return current;
          });
          return prev;
        });
      });

      newSocket.on("message.new", (data: any) => {
        const { conversationId, message, conversation, instanceId } = data;

        if (conversationId && message && Number(conversationId) === Number(activeConversationIdRef.current)) {
          setChatMessages(prev => {
            if (message.message_id && prev.some((m: any) => m.message_id === message.message_id)) {
              return prev;
            }
            const optimisticIndex = prev.findIndex((m: any) => {
              const isOptimistic = String(m.message_id || "").startsWith("opt_");
              if (!isOptimistic || m.direction !== message.direction) return false;
              if (Number(m.conversation_id) !== Number(conversationId)) return false;
              if (m.content_type !== message.content_type) return false;
              return String(m.content_text || m.content || "") === String(message.content_text || message.content || "");
            });
            if (optimisticIndex >= 0) {
              return prev.map((m, index) => index === optimisticIndex ? { ...m, ...message } : m);
            }
            return [...prev, message];
          });
        }

        // Update conversations list
        if (conversation) {
          setConversations(prev => {
            const exists = prev.find(c => c.id === conversationId);
            if (exists) {
              return prev.map(c => c.id === conversationId
                ? { ...c, last_message_preview: conversation.last_message_preview, last_message_at: new Date().toISOString() }
                : c
              ).sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime());
            } else {
              // New conversation
              return [{ id: conversationId, ...conversation, last_message_at: new Date().toISOString(), unread_count: 1 } as any, ...prev];
            }
          });
        } else {
          // Fallback: refetch
          fetchConversations();
        }

        // Push to live messages feed for the selected instance
        if (message && instanceId && selectedWooInstanceId && Number(instanceId) === selectedWooInstanceId) {
          setLiveMessages(prev => {
            if (message.message_id && prev.some((m: any) => m.message_id === message.message_id)) return prev;
            const next = [{ ...message, receivedAt: new Date().toISOString() }, ...prev];
            return next.slice(0, 50);
          });
        } else if (message && instanceId && selectedWooInstanceId && message.instance_id && Number(message.instance_id) === selectedWooInstanceId) {
          setLiveMessages(prev => {
            if (message.message_id && prev.some((m: any) => m.message_id === message.message_id)) return prev;
            const next = [{ ...message, receivedAt: new Date().toISOString() }, ...prev];
            return next.slice(0, 50);
          });
        }
      });

      newSocket.on("message.status", (data: any) => {
        const { messageId, status } = data;
        setChatMessages(prev => prev.map((m: any) =>
          m.message_id === messageId ? { ...m, delivery_status: status } : m
        ));
      });

      newSocket.on("instance.health.updated", (data: any) => {
        setInstances(prev => prev.map(inst =>
          Number(inst.id) === Number(data.instanceId)
            ? { ...inst, status: data.status, operational_status: data.operational_status || inst.operational_status }
            : inst
        ));
      });

      newSocket.on("queue.metrics.updated", (data: any) => {
        setLiveQueueMetrics(data);
      });

      newSocket.on("support.alert.resolved", (data: any) => {
        setLiveQueueMetrics((prev: any) => prev ? { ...prev, resolvedAlertId: data.alertId, resolvedAlertAt: data.timestamp } : prev);
      });

      newSocket.on("support.ticket.created", (ticket: any) => {
        setSupportTickets(prev => {
          if (prev.some(item => Number(item.id) === Number(ticket.id))) return prev;
          return [ticket, ...prev].slice(0, 100);
        });
      });

      newSocket.on("support.ticket.updated", (ticket: any) => {
        setSupportTickets(prev => prev.map(item => Number(item.id) === Number(ticket.id) ? { ...item, ...ticket } : item));
      });

      newSocket.on("support.ticket.message", (message: any) => {
        if (message?.sender === 'human') {
          setSupportChatMessages(prev => [...prev, { sender: 'human', message: message.message, created_at: message.created_at }]);
        }
      });

      setSocket(newSocket);
      return () => {
        newSocket.close();
      };
    }
  }, [auth]);

  useEffect(() => {
    if (auth && selectedWooInstanceId) {
      fetchWooApiPanel(selectedWooInstanceId);
      if (activeTab === 'groups') fetchGroups(selectedWooInstanceId);
    }
  }, [auth, selectedWooInstanceId, activeTab]);

  useEffect(() => {
    if (auth && activeTab === 'groups' && selectedWooInstanceId) {
      fetchGroups(selectedWooInstanceId);
    }
  }, [auth, activeTab, selectedWooInstanceId]);

  useEffect(() => {
    if (auth && activeTab === 'groups' && selectedGroupJid) {
      fetchGroupDetails(selectedGroupJid);
    }
  }, [auth, activeTab, selectedGroupJid]);

  useEffect(() => {
    if (!auth || !qrModalInstance?.id) return;

    let stopped = false;
    const refreshQrModal = async () => {
      const inst = await apiFetch(`/api/whatsapp/instances/${qrModalInstance.id}`);
      if (stopped || !inst?.id) return;

      setInstances(prev => prev.map(item => item.id === inst.id ? { ...item, ...inst } : item));
      setQrModalInstance(prev => {
        if (!prev || prev.id !== inst.id) return prev;
        if (isConnectedStatus(inst.status)) return null;
        return { ...prev, ...inst };
      });
    };

    refreshQrModal();
    const interval = window.setInterval(refreshQrModal, 2000);
    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
  }, [auth, qrModalInstance?.id]);

  useEffect(() => {
    if (activeConversationId) {
      fetchChatMessages(activeConversationId);
    }
  }, [activeConversationId]);

  useEffect(() => {
    if (activeTab !== 'messages' || conversations.length === 0) return;
    const activeConversationExists = conversations.some(conv => conv.id === activeConversationId);
    if (!activeConversationId || !activeConversationExists) {
      setActiveConversationId(conversations[0].id);
    }
  }, [activeTab, activeConversationId, conversations]);

  const handleSearch = async () => {
    if (!searchQuery) return;
    setLoading(true);
    try {
      const response = await apiFetch('/api/ai/generate', {
        method: 'POST',
        body: JSON.stringify({
          model: "gemini-2.0-flash",
          prompt: `Encontre 10 empresas do nicho "${searchQuery}" com nome, telefone e endereço. Retorne APENAS um array JSON de objetos com as chaves: name, phone, address.`,
          config: {
            tools: [{ googleMaps: {} }],
          }
        })
      });

      if (response && response.text) {
        const text = response.text;
        const jsonMatch = text.match(/\[.*\]/s);
        if (jsonMatch) {
          const data = JSON.parse(jsonMatch[0]);
          setSearchResults(data);
        }
      }
    } catch (error) {
      console.error("Search error:", error);
    } finally {
      setLoading(false);
    }
  };

  const saveLeads = async () => {
    setLoading(true);
    try {
      await apiFetch('/api/leads', {
        method: 'POST',
        body: JSON.stringify({ leads: searchResults.map(r => ({ ...r, niche: searchQuery })) })
      });
      setSearchResults([]);
      fetchLeads();
      setActiveTab('leads');
    } catch (error) {
      console.error("Save error:", error);
    } finally {
      setLoading(false);
    }
  };

  const createAgent = async () => {
    if (!newAgent.name || !newAgent.system_instruction) return;
    await apiFetch('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        ...newAgent,
        faq_json: newAgent.faq.filter(f => f.q && f.a)
      })
    });
    setNewAgent({
      name: '',
      system_instruction: '',
      personality: 'Profissional e amigável',
      faq: [{ q: '', a: '' }],
      handoff_trigger: 'Quero falar com um humano'
    });
    fetchAgents();
  };

  const createInstance = async (name: string, engine: 'wooapi' = 'wooapi') => {
    const data = await apiFetch('/api/whatsapp/instances', {
      method: 'POST',
      body: JSON.stringify({ name, engine })
    });
    if (!data?.id) return;
    const created = {
      id: data.id,
      name,
      engine,
      status: 'connecting' as const,
      qr: null,
      api_key: data.api_key,
      webhook_secret: data.webhook_secret,
      webhook_endpoint: data.webhook?.webhooks_url,
      webhook: data.webhook
    };
    setInstances(prev => [created as Instance, ...prev]);
    setQrModalInstance(created as Instance);
    const connectResult = await apiFetch(`/api/whatsapp/instances/${data.id}/connect`, { method: 'POST', body: JSON.stringify({ forceNewQr: true }) });
    if (connectResult?.qr) {
      setQrModalInstance({ ...created, status: 'qr_pending', qr: connectResult.qr } as Instance);
      setInstances(prev => prev.map(inst => inst.id === data.id ? { ...inst, status: 'qr_pending', qr: connectResult.qr } : inst));
    }
    fetchInstances();
    if (canUseResellerPanel()) fetchResellerOverview();
  };

  const createClientAccount = async () => {
    if (!newClient.name || !newClient.owner_name || !newClient.owner_email || !newClient.password) return;
    const data = await apiFetch('/api/reseller/clients', {
      method: 'POST',
      body: JSON.stringify(newClient)
    });
    if (!data?.id) return;
    setNewClient({ name: '', owner_name: '', owner_email: '', password: '', instance_quota: 1, max_client_accounts: 0 });
    fetchClientAccounts();
    fetchResellerOverview();
  };

  const connectInstance = async (id: number) => {
    const inst = instances.find(i => i.id === id);
    if (inst) setQrModalInstance({ ...inst, status: 'connecting', qr: undefined });
    setInstances(prev => prev.map(i => i.id === id ? { ...i, status: 'connecting', qr: undefined } : i));
    const connectResult = await apiFetch(`/api/whatsapp/instances/${id}/connect`, { method: 'POST', body: JSON.stringify({ forceNewQr: true }) });
    if (connectResult?.qr) {
      // Re-open modal even if it was closed between the POST call and the response (race condition fix)
      setQrModalInstance(prev => {
        if (prev?.id === id) return { ...prev, status: 'qr_pending', qr: connectResult.qr };
        const currentInst = instances.find(i => i.id === id);
        return currentInst ? { ...currentInst, status: 'qr_pending', qr: connectResult.qr } : prev;
      });
      setInstances(prev => prev.map(i => i.id === id ? { ...i, status: 'qr_pending', qr: connectResult.qr } : i));
    }
    fetchInstances();
  };

  const logoutInstance = async (id: number) => {
    await apiFetch(`/api/whatsapp/instances/${id}/logout`, { method: 'POST' });
    fetchInstances();
  };

  const deleteInstance = async (id: number) => {
    await apiFetch(`/api/whatsapp/instances/${id}`, { method: 'DELETE' });
    fetchInstances();
    if (canUseResellerPanel()) fetchResellerOverview();
  };

  const regenerateInstanceApiKey = async (id: number) => {
    if (!confirm('Regenerar a API key desta instância? Integrações antigas vão parar até atualizar a chave.')) return;
    const data = await apiFetch(`/api/whatsapp/instances/${id}/api-key/regenerate`, { method: 'POST' });
    if (data?.api_key) {
      setInstances(prev => prev.map(inst => inst.id === id ? { ...inst, api_key: data.api_key } : inst));
      navigator.clipboard?.writeText(data.api_key).catch(() => null);
      alert('Nova API key gerada e copiada.');
    }
  };

  const copyInstanceApiKey = (apiKey?: string) => {
    if (!apiKey) return alert('API key disponível apenas logo após criar ou regenerar a chave.');
    navigator.clipboard?.writeText(apiKey).catch(() => null);
  };

  const copyInstanceWebhook = (inst: Instance) => {
    const endpoint = inst.webhook?.webhooks_url || inst.webhook_endpoint;
    if (!endpoint) return alert('Endpoint de webhook indisponivel para esta instancia.');
    navigator.clipboard?.writeText(endpoint).catch(() => null);
    alert('Endpoint de webhook copiado.');
  };

  const sendMessage = async () => {
    if (!activeConversationId || !newMessage.trim()) return;
    const conv = conversations.find(c => c.id === activeConversationId);
    if (!conv) {
      console.warn("[SEND] Conversation not found", activeConversationId);
      return;
    }

    const activeInstance = findConnectedInstance(instances, conv.instance_id);
    const instanceId = activeInstance?.id;
    if (!instanceId) {
      alert("Erro: Nenhuma instância conectada.");
      return;
    }

    // Build the target JID
    let targetJid = conv.remote_jid || conv.group_jid || conv.contact_phone || '';
    if (targetJid && !targetJid.includes('@')) {
      // Check if it looks like a phone number (starts with digits, 10-15 chars)
      // or a LID (longer than 15 chars)
      if (targetJid.length >= 15) {
        targetJid = `${targetJid}@lid`;
      } else {
        targetJid = `${targetJid}@s.whatsapp.net`;
      }
    }

    if (!targetJid) {
      alert("Erro: Destinatário inválido");
      return;
    }

    const msgText = newMessage;
    setNewMessage('');

    // Optimistic render
    const optimisticMsg: any = {
      id: Date.now(),
      message_id: `opt_${Date.now()}`,
      conversation_id: activeConversationId,
      direction: 'outbound',
      content_type: 'text',
      content_text: msgText,
      delivery_status: 'pending',
      from_me: true,
      author_push_name: 'Eu',
      created_at: new Date().toISOString()
    };
    setChatMessages(prev => [...prev, optimisticMsg]);

    try {
      const result = await apiFetch('/api/whatsapp/send', {
        method: 'POST',
        body: JSON.stringify({
          instanceId,
          jid: targetJid,
          message: msgText,
          conversationId: activeConversationId
        })
      });
      if (result?.error || result?.success === false) {
        throw new Error(result.error || result.message || 'Falha ao enviar mensagem');
      }

      if (result?.providerMessageId) {
        setChatMessages(prev => prev.map(m =>
          m.message_id === optimisticMsg.message_id
            ? { ...m, message_id: result.providerMessageId, delivery_status: 'sent' }
            : m
        ));
      }
    } catch (e: any) {
      console.error("[SEND_ERROR]", e);
      setChatMessages(prev => prev.map(m =>
        m.message_id === optimisticMsg.message_id
          ? { ...m, delivery_status: 'failed' }
          : m
      ));
    }
  };

  const sendMediaMessage = async (url: string, type: 'image' | 'video' | 'audio' | 'document') => {
    if (!activeConversationId) return;
    const conv = conversations.find(c => c.id === activeConversationId);
    if (!conv) return;
    const activeInstance = findConnectedInstance(instances, conv.instance_id);
    const instanceId = activeInstance?.id;
    if (!instanceId) return;

    let targetJid = conv.remote_jid || conv.group_jid || conv.contact_phone || '';
    if (targetJid && !targetJid.includes('@')) {
      targetJid = targetJid.length >= 15 ? `${targetJid}@lid` : `${targetJid}@s.whatsapp.net`;
    }

    const optimisticMsg: any = {
      id: Date.now(),
      message_id: `opt_media_${Date.now()}`,
      conversation_id: activeConversationId,
      direction: 'outbound',
      content_type: type,
      content_text: url,
      delivery_status: 'pending',
      from_me: true,
      author_push_name: 'Eu',
      created_at: new Date().toISOString()
    };
    setChatMessages(prev => [...prev, optimisticMsg]);

    try {
      const result = await apiFetch('/api/whatsapp/send', {
        method: 'POST',
        body: JSON.stringify({
          instanceId,
          jid: targetJid,
          message: '',
          conversationId: activeConversationId,
          mediaUrl: url,
          contentType: type
        })
      });
      if (result?.error || result?.success === false) {
        throw new Error(result.error || result.message || 'Falha ao enviar midia');
      }
      if (result?.providerMessageId) {
        setChatMessages(prev => prev.map(m => m.message_id === optimisticMsg.message_id ? { ...m, delivery_status: 'sent', message_id: result.providerMessageId } : m));
      }
    } catch (e) {
      setChatMessages(prev => prev.map(m => m.message_id === optimisticMsg.message_id ? { ...m, delivery_status: 'failed' } : m));
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch(`${API_URL}/api/upload`, {
        method: 'POST',
        headers: {
          'x-account-id': auth?.accountId?.toString() || '',
          ...(auth?.token ? { 'Authorization': `Bearer ${auth.token}` } : {})
        },
        body: formData
      });
      const data = await response.json();
      if (data.url) {
        const type = file.type.startsWith('image/') ? 'image' :
                     file.type.startsWith('video/') ? 'video' :
                     file.type.startsWith('audio/') ? 'audio' : 'document';
        sendMediaMessage(data.publicUrl || data.url, type);
      }
    } catch (error) {
      console.error('Upload failed:', error);
      alert('Falha ao enviar arquivo');
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const deleteConversation = async (id: number) => {
    if (!confirm("Tem certeza que deseja excluir esta conversa? Todas as mensagens serão perdidas.")) return;
    await apiFetch(`/api/conversations/${id}`, { method: 'DELETE' });
    if (activeConversationId === id) setActiveConversationId(null);
    fetchConversations();
  };

  const updateConversationMeta = async (id: number, payload: any) => {
    const updated = await apiFetch(`/api/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
    if (updated) {
      setConversations(prev => prev.map(c => c.id === id ? { ...c, ...updated } : c));
    }
  };

  const addConversationTag = async (conv: Conversation, tag: string) => {
    const cleanTag = tag.trim();
    if (!cleanTag) return;
    const tags = JSON.parse(conv.tags_json || '[]');
    if (!tags.includes(cleanTag)) tags.push(cleanTag);
    await updateConversationMeta(conv.id, { tags });
  };

  const isIgnoredConversation = (conv: Conversation) => {
    const jid = `${conv.remote_jid || ''} ${conv.group_jid || ''} ${conv.contact_phone || ''}`.toLowerCase();
    return jid.includes('@newsletter') || jid.includes('@broadcast') || jid.includes('status@broadcast');
  };

  const mediaPreviewKind = (value?: string) => {
    const clean = String(value || '').trim().toLowerCase();
    if (['[image]', '[imagem]', 'image', 'imagem'].includes(clean)) return 'image';
    if (['[video]', 'video'].includes(clean)) return 'video';
    if (['[audio]', 'audio'].includes(clean)) return 'audio';
    if (['[document]', '[documento]', 'document', 'documento'].includes(clean)) return 'document';
    return null;
  };

  const isRenderableMediaUrl = (value?: string) => {
    const url = String(value || '').trim();
    return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:') || url.startsWith('/uploads/');
  };

  const sameOriginMediaUrl = (value?: string) => {
    const url = String(value || '').trim();
    if (!url) return '';
    try {
      const parsed = new URL(url);
      if ((parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') && parsed.pathname.startsWith('/uploads/')) {
        return `${parsed.pathname}${parsed.search}${parsed.hash}`;
      }
    } catch {}
    return url;
  };

  const conversationInitial = (conv?: Conversation) => (conv?.title || conv?.contact_phone || conv?.remote_jid || '?').charAt(0);

  const deleteChatMessage = async (id: number) => {
    if (!confirm("Excluir esta mensagem?")) return;
    await apiFetch(`/api/messages/${id}`, { method: 'DELETE' });
    if (activeConversationId) fetchChatMessages(activeConversationId);
  };

  const createCampaign = async () => {
    if (!newCampaign.name || !newCampaign.agent_id) return;
    await apiFetch('/api/campaigns', {
      method: 'POST',
      body: JSON.stringify(newCampaign)
    });
    setNewCampaign({
      name: '',
      agent_id: 0,
      initial_method: 'ai',
      transition_rules: {
        after_first_response: 'continue_ai',
        on_keyword: 'handoff'
      }
    });
    fetchCampaigns();
  };

  const deleteCampaign = async (id: number) => {
    await apiFetch(`/api/campaigns/${id}`, { method: 'DELETE' });
    fetchCampaigns();
  };

  const createMember = async () => {
    if (!newMember.name) return;
    await apiFetch('/api/team', {
      method: 'POST',
      body: JSON.stringify(newMember)
    });
    setNewMember({ name: '', role: '', email: '' });
    fetchTeam();
  };

  const deleteMember = async (id: number) => {
    await apiFetch(`/api/team/${id}`, { method: 'DELETE' });
    fetchTeam();
  };

  const createCredential = async () => {
    if (!newCred.name || !newCred.api_key) return;
    await apiFetch('/api/credentials', {
      method: 'POST',
      body: JSON.stringify(newCred)
    });
    setNewCred({ provider: 'openai', name: '', api_key: '', model_name: '' });
    fetchCredentials();
  };

  const activateCredential = async (id: number, provider: string) => {
    await apiFetch(`/api/credentials/${id}/activate`, {
      method: 'PATCH',
      body: JSON.stringify({ provider })
    });
    fetchCredentials();
  };

  const deleteCredential = async (id: number) => {
    await apiFetch(`/api/credentials/${id}`, { method: 'DELETE' });
    fetchCredentials();
  };

  const createSchedule = async () => {
    if (!newSchedule.name) return;
    await apiFetch('/api/schedules', {
      method: 'POST',
      body: JSON.stringify(newSchedule)
    });
    setNewSchedule({ name: '', agent_id: 0, member_id: 0, description: '' });
    fetchSchedules();
  };

  const deleteSchedule = async (id: number) => {
    await apiFetch(`/api/schedules/${id}`, { method: 'DELETE' });
    fetchSchedules();
  };

  const updateKanban = async (id: number, status: string) => {
    await apiFetch(`/api/leads/${id}/kanban`, {
      method: 'PATCH',
      body: JSON.stringify({ kanban_status: status })
    });
    fetchLeads();
  };

  const deleteAgent = async (id: number) => {
    await apiFetch(`/api/agents/${id}`, { method: 'DELETE' });
    fetchAgents();
  };

  const sendBroadcast = async (agentId: number) => {
    const agent = agents.find(a => a.id === agentId);
    if (!agent) return;

    // Use the first connected instance
    const activeInstance = instances.find(inst => isConnectedStatus(inst.status));
    if (!activeInstance) {
      alert("Nenhuma instância conectada para realizar o disparo.");
      return;
    }

    setLoading(true);
    for (const lead of leads) {
      if (lead.status === 'pending' && lead.phone) {
        try {
          const aiResponse = await apiFetch('/api/ai/generate', {
            method: 'POST',
            body: JSON.stringify({
              model: "gemini-2.0-flash",
              prompt: `Você é um assistente comercial com a seguinte instrução: "${agent.system_instruction}". Escreva uma mensagem curta e persuasiva para o cliente "${lead.name}" da empresa "${lead.address}". Não use placeholders, escreva a mensagem final.`
            })
          });

          if (aiResponse && aiResponse.text) {
            const message = aiResponse.text;
            const cleanPhone = lead.phone.replace(/\D/g, '');
            const jid = `${cleanPhone}@s.whatsapp.net`;

            await apiFetch('/api/whatsapp/send', {
              method: 'POST',
              body: JSON.stringify({
                instanceId: activeInstance.id,
                jid,
                message
              })
            });

            await apiFetch('/api/messages/save', {
              method: 'POST',
              body: JSON.stringify({ lead_id: lead.id, sender: 'ai', content: message })
            });
          }
        } catch (e) {
          console.error("Broadcast error for lead", lead.name, e);
        }
      }
    }
    setLoading(false);
    fetchMessages();
    alert("Disparo concluído!");
  };

  // Replaced with logoutInstance
  const logoutWhatsApp = async () => {
    const activeInstance = instances.find(inst => isConnectedStatus(inst.status));
    if (activeInstance) {
      await logoutInstance(activeInstance.id);
    }
  };

  if (!auth) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <Card className="w-full max-w-md p-8">
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-primary text-white rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-slate-200">
              <Send size={32} />
            </div>
            <h1 className="text-2xl font-bold text-slate-900">WooAPI</h1>
            <p className="text-slate-500">Acesse sua plataforma de automação</p>
          </div>

          <div className="space-y-4">
            {authMode === 'register' && (
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Nome da Empresa</label>
                <div className="relative">
                  <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                  <input
                    type="text"
                    placeholder="Sua Empresa Ltda"
                    className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-slate-900/10"
                    value={authForm.companyName}
                    onChange={e => setAuthForm({ ...authForm, companyName: e.target.value })}
                  />
                </div>
              </div>
            )}
            {authMode === 'register' && (
            <div>
              <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Seu Nome</label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                <input
                  type="text"
                  placeholder="João Silva"
                  className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-slate-900/10"
                  value={authForm.name}
                  onChange={e => setAuthForm({ ...authForm, name: e.target.value })}
                />
              </div>
            </div>
            )}
            <div>
              <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">E-mail</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                <input
                  type="email"
                  placeholder="seu@email.com"
                  className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-slate-900/10"
                  value={authForm.email}
                  onChange={e => setAuthForm({ ...authForm, email: e.target.value })}
                />
              </div>
            </div>
            <div>
              <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Senha</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                <input
                  type="password"
                  placeholder="••••••••"
                  className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-slate-900/10"
                  value={authForm.password}
                  onChange={e => setAuthForm({ ...authForm, password: e.target.value })}
                />
              </div>
            </div>

            <button
              onClick={authMode === 'login' ? handleLogin : handleRegister}
              className="w-full py-4 bg-primary text-white font-bold rounded-xl hover:bg-primary/90 transition-all shadow-lg shadow-slate-200"
            >
              {authMode === 'login' ? 'Entrar' : 'Criar Conta'}
            </button>

            <div className="text-center pt-4">
              <button
                onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}
                className="text-sm text-primary font-medium hover:underline"
              >
                {authMode === 'login' ? 'Não tem uma conta? Cadastre-se' : 'Já tem uma conta? Faça login'}
              </button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (activeTab === 'super_admin' && auth.user.role === 'super_admin') {
    return (
      <div className="min-h-screen bg-[#f4f5f7] font-sans text-slate-900">
        <SuperAdminPanel
          apiFetch={apiFetch}
          onImpersonate={handleImpersonate}
          onLogout={handleLogout}
          onBackToAccount={() => setActiveTab('dashboard')}
          authUser={auth.user}
        />
      </div>
    );
  }

  const selectedWooInstance = instances.find(inst => inst.id === selectedWooInstanceId) || instances[0];
  const selectedWebhookFailures = webhookLogs.filter(log => !log.success).length;
  const selectedWebhookSuccess = webhookLogs.filter(log => log.success).length;
  const trialEndsAt = auth.account?.trial_ends_at ? new Date(auth.account.trial_ends_at) : null;
  const trialTimeLeft = trialEndsAt
    ? Math.max(0, trialEndsAt.getTime() - Date.now())
    : 0;
  const trialHoursLeft = Math.floor(trialTimeLeft / 3600000);
  const trialMinutesLeft = Math.ceil((trialTimeLeft % 3600000) / 60000);
  const isTrialAccount = auth.account?.status === 'trial';

  return (
    <div className="flex h-screen bg-main-bg font-sans text-slate-900">
      {/* Sidebar */}
      <aside className="w-64 bg-sidebar-bg border-r border-white/10 p-6 flex flex-col gap-8">
        <div className="flex items-center gap-3 px-2">
          <div className="w-10 h-10 bg-primary rounded-md flex items-center justify-center text-white">
            <Send size={24} />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-white">WooAPI</h1>
        </div>

        <nav className="flex flex-col gap-2">
          <SidebarItem icon={LayoutDashboard} label="Dashboard" active={activeTab === 'dashboard'} onClick={() => setActiveTab('dashboard')} href="#dashboard" />
          <SidebarItem icon={QrCode} label="Instâncias API" active={activeTab === 'whatsapp'} onClick={() => setActiveTab('whatsapp')} href="#whatsapp" />
          <SidebarItem icon={Activity} label="Saúde da Plataforma" active={activeTab === 'wooapi_monitor'} onClick={() => setActiveTab('wooapi_monitor')} href="#wooapi_monitor" />
          <SidebarItem icon={Building2} label="Clientes SaaS" active={activeTab === 'clients'} onClick={() => setActiveTab('clients')} href="#clients" />
          <SidebarItem icon={MessagesSquare} label="Mensagens" active={activeTab === 'messages'} onClick={() => setActiveTab('messages')} href="#messages" />
          <SidebarItem icon={Users} label="Grupos" active={activeTab === 'groups'} onClick={() => setActiveTab('groups')} href="#groups" />
          <SidebarItem icon={MessageSquare} label="Integrações" active={activeTab === 'api_docs'} onClick={() => setActiveTab('api_docs')} href="#api_docs" />
          <SidebarItem icon={Puzzle} label="Conectores" active={activeTab === 'integrations'} onClick={() => setActiveTab('integrations')} href="#integrations" />
          <SidebarItem icon={LifeBuoy} label="Suporte" active={activeTab === 'support'} onClick={() => setActiveTab('support')} href="#support" />
          <SidebarItem icon={Settings} label="Configurações" active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} href="#settings" />
          {auth.user.role === 'super_admin' && (
            <SidebarItem icon={Lock} label="Console Global" active={activeTab === 'super_admin'} onClick={() => setActiveTab('super_admin')} href="#super_admin" />
          )}
        </nav>

        <div className="mt-auto pt-6 border-t border-white/10 space-y-4">
          <div className={cn(
            "p-4 rounded-md flex items-center gap-3",
            isConnectedStatus(wsStatus.status) ? "bg-white/10 text-white" : "bg-white/10 text-sidebar-item"
          )}>
            <div className="w-2 h-2 rounded-full bg-primary" />
            <span className="text-xs font-semibold uppercase tracking-wider">
              {isConnectedStatus(wsStatus.status) ? 'WhatsApp Conectado' : 'WhatsApp Desconectado'}
            </span>
          </div>

          <div className="flex items-center gap-3 px-4 py-3">
            <div className="w-8 h-8 bg-white/10 text-white rounded-md flex items-center justify-center font-bold text-xs">
              {displayText(auth.user.name, 'U').charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-white truncate">{displayText(auth.user.name, 'Usuario')}</p>
              <p className="text-[10px] text-white/50 truncate">{displayText(auth.user.email)}</p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 w-full px-4 py-3 text-sidebar-item hover:bg-white/5 hover:text-white rounded-md transition-all"
          >
            <LogOut size={18} />
            <span className="text-sm font-medium">Sair</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className={cn("flex-1 bg-main-bg", activeTab === 'messages' ? "overflow-hidden p-0" : "overflow-y-auto p-6")}>
        {isTrialAccount && activeTab !== 'messages' && (
          <div className="mb-5 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <strong>Conta teste:</strong> esta conta dura 2 dias e sera excluida automaticamente com instancias, mensagens, webhooks e logs criados no teste.
            {trialEndsAt && (
              <span className="ml-1 font-bold">
                Tempo restante aproximado: {trialHoursLeft}h {trialMinutesLeft}min.
              </span>
            )}
          </div>
        )}
        <AnimatePresence mode="wait">
          {activeTab === 'dashboard' && (
            <motion.div
              key="dashboard"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-8"
            >
              <header>
                <h2 className="text-3xl font-bold text-slate-900">Painel da Conta WooAPI</h2>
                <p className="text-slate-500 mt-1">Operacao da sua conta: instancias, mensagens, clientes, integracoes e configuracoes.</p>
              </header>

              {auth.user.role === 'super_admin' && (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                  <strong>Painel da Conta:</strong> use esta area para operar instancias, mensagens e clientes da conta atual. O <strong>Console Global</strong> no menu e reservado para administracao da plataforma inteira.
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <Card className="p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-slate-500">Instâncias</p>
                      <h3 className="text-3xl font-bold mt-1">{instances.length}</h3>
                    </div>
                    <div className="w-12 h-12 bg-slate-50 text-primary rounded-xl flex items-center justify-center">
                      <Smartphone size={24} />
                    </div>
                  </div>
                </Card>
                <Card className="p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-slate-500">Conectadas</p>
                      <h3 className="text-3xl font-bold mt-1">{instances.filter(i => isConnectedStatus(i.status)).length}</h3>
                    </div>
                    <div className="w-12 h-12 bg-slate-50 text-primary rounded-xl flex items-center justify-center">
                      <CheckCircle2 size={24} />
                    </div>
                  </div>
                </Card>
                <Card className="p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-slate-500">Clientes SaaS</p>
                      <h3 className="text-3xl font-bold mt-1">{clientAccounts.length}</h3>
                    </div>
                    <div className="w-12 h-12 bg-slate-50 text-primary rounded-xl flex items-center justify-center">
                      <Building2 size={24} />
                    </div>
                  </div>
                </Card>
              </div>

              <Card className="p-6">
                <h3 className="text-lg font-bold mb-4">Operação SaaS</h3>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div className="p-4 bg-slate-50 border border-slate-100 rounded-md">
                    <p className="text-xs uppercase font-bold text-slate-400">Cota de instâncias</p>
                    <p className="text-2xl font-black mt-1">{displayNumber(resellerOverview?.usage?.instances)}/{displayText(resellerOverview?.plan?.max_instances)}</p>
                  </div>
                  <div className="p-4 bg-slate-50 border border-slate-100 rounded-md">
                    <p className="text-xs uppercase font-bold text-slate-400">Alocadas a clientes</p>
                    <p className="text-2xl font-black mt-1">{displayNumber(resellerOverview?.usage?.allocated_child_instances)}</p>
                  </div>
                  <div className="p-4 bg-slate-50 border border-slate-100 rounded-md">
                    <p className="text-xs uppercase font-bold text-slate-400">Disponíveis</p>
                    <p className="text-2xl font-black mt-1">{displayText(resellerOverview?.available_instances)}</p>
                  </div>
                  <div className="p-4 bg-slate-50 border border-slate-100 rounded-md">
                    <p className="text-xs uppercase font-bold text-slate-400">Integrações</p>
                    <p className="text-2xl font-black mt-1">n8n / Chatwoot / Typebot</p>
                  </div>
                </div>
              </Card>
            </motion.div>
          )}

          {activeTab === 'clients' && (
            <motion.div
              key="clients"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              <header>
                <h2 className="text-3xl font-bold">Clientes SaaS</h2>
                <p className="text-slate-500">Crie contas clientes com cotas próprias de instâncias WooAPI.</p>
              </header>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Card className="p-5">
                  <p className="text-xs uppercase font-bold text-slate-400">Clientes usados</p>
                  <p className="text-3xl font-black mt-1">{displayNumber(resellerOverview?.usage?.client_accounts)}/{displayText(resellerOverview?.plan?.max_client_accounts)}</p>
                </Card>
                <Card className="p-5">
                  <p className="text-xs uppercase font-bold text-slate-400">Instâncias disponíveis</p>
                  <p className="text-3xl font-black mt-1">{displayText(resellerOverview?.available_instances)}</p>
                </Card>
                <Card className="p-5">
                  <p className="text-xs uppercase font-bold text-slate-400">Instâncias alocadas</p>
                  <p className="text-3xl font-black mt-1">{displayNumber(resellerOverview?.usage?.allocated_child_instances)}</p>
                </Card>
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
                <Card className="p-5 h-fit">
                  <h3 className="text-lg font-bold mb-4">Novo cliente</h3>
                  <div className="space-y-3">
                    <input className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm" placeholder="Empresa" value={newClient.name} onChange={e => setNewClient({ ...newClient, name: e.target.value })} />
                    <input className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm" placeholder="Nome do admin" value={newClient.owner_name} onChange={e => setNewClient({ ...newClient, owner_name: e.target.value })} />
                    <input className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm" placeholder="E-mail do admin" value={newClient.owner_email} onChange={e => setNewClient({ ...newClient, owner_email: e.target.value })} />
                    <input className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm" placeholder="Senha inicial" type="password" value={newClient.password} onChange={e => setNewClient({ ...newClient, password: e.target.value })} />
                    <div className="grid grid-cols-2 gap-2">
                      <input className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm" type="number" min="0" value={newClient.instance_quota} onChange={e => setNewClient({ ...newClient, instance_quota: Number(e.target.value) })} />
                      <input className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm" type="number" min="0" value={newClient.max_client_accounts} onChange={e => setNewClient({ ...newClient, max_client_accounts: Number(e.target.value) })} />
                    </div>
                    <button onClick={createClientAccount} className="w-full py-3 bg-primary text-white font-bold rounded-md">Criar cliente</button>
                  </div>
                </Card>

                <Card className="xl:col-span-3 overflow-hidden">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-100 text-slate-400 text-xs font-semibold uppercase tracking-wider">
                        <th className="py-4 px-6">Conta</th>
                        <th className="py-4 px-6">Cota</th>
                        <th className="py-4 px-6">Uso</th>
                        <th className="py-4 px-6">Status</th>
                      </tr>
                    </thead>
                    <tbody className="text-sm">
                      {clientAccounts.map((client) => (
                        <tr key={client.id} className="border-b border-slate-50 last:border-0">
                          <td className="py-4 px-6">
                            <p className="font-bold">{client.name}</p>
                            <p className="text-xs text-slate-400">{client.owner_email}</p>
                          </td>
                          <td className="py-4 px-6">{client.instance_quota || 0} instâncias</td>
                          <td className="py-4 px-6">{client.usage?.instances || 0}/{client.instance_quota || 0}</td>
                          <td className="py-4 px-6">
                            <span className={cn("px-2 py-1 rounded text-xs font-bold", client.status === 'active' ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700")}>
                              {client.status || 'active'}
                            </span>
                          </td>
                        </tr>
                      ))}
                      {clientAccounts.length === 0 && (
                        <tr>
                          <td className="py-8 px-6 text-slate-400 text-center" colSpan={4}>Nenhum cliente criado ainda.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </Card>
              </div>
            </motion.div>
          )}

          {activeTab === 'api_docs' && (
            <motion.div
              key="api_docs"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              <header>
                <h2 className="text-3xl font-bold">Integrações WooAPI</h2>
                <p className="text-slate-500">Use a mesma instância para n8n, Chatwoot, Typebot, webhook e websocket.</p>
              </header>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {[
                  ['n8n', 'Use HTTP Request com a API key da instância para enviar mensagens e receba eventos no webhook do workflow.'],
                  ['Chatwoot', 'Configure o webhook da caixa de entrada apontando para WooAPI ou use a API para entregar mensagens ao inbox.'],
                  ['Typebot', 'Chame endpoints WooAPI em blocos HTTP e use webhooks para continuar fluxos quando uma resposta chegar.']
                ].map(([title, text]) => (
                  <Card key={title} className="p-5">
                    <h3 className="text-lg font-bold">{title}</h3>
                    <p className="text-sm text-slate-500 mt-2">{text}</p>
                  </Card>
                ))}
              </div>

              <Card className="p-6">
                <h3 className="text-lg font-bold mb-4">Endpoints principais</h3>
                <div className="space-y-3 text-sm font-mono">
                  <p><span className="text-primary font-bold">POST</span> /api/v1/instances/:id/send-text</p>
                  <p><span className="text-primary font-bold">POST</span> /api/v1/instances/:id/send-media</p>
                  <p><span className="text-primary font-bold">PATCH</span> /api/whatsapp/instances/:id/webhook</p>
                  <p><span className="text-primary font-bold">WS</span> socket.io eventos instance.status, instance.qr e message.received</p>
                </div>
              </Card>
            </motion.div>
          )}

          {activeTab === 'integrations' && (
            <motion.div
              key="integrations"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <IntegrationManager apiFetch={apiFetch} />
            </motion.div>
          )}

          {activeTab === 'search' && (
            <motion.div
              key="search"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              <header>
                <h2 className="text-3xl font-bold">Captar Leads</h2>
                <p className="text-slate-500">Extraia dados reais do Google Maps por nicho e localização.</p>
              </header>

              <Card className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-bold">Sugestões de Nichos</h3>
                  <span className="text-xs text-slate-400">Palavras-chave para busca</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
                  {[
                    { n: 'Restaurantes', k: 'pizzaria, massa, culinária' },
                    { n: 'Dentistas', k: 'odonto, clareamento, implante' },
                    { n: 'Mecânicas', k: 'oficina, revisão, motor' },
                    { n: 'Estética', k: 'salão, manicure, massagem' },
                    { n: 'Pet Shops', k: 'veterinário, ração, tosa' },
                    { n: 'Academias', k: 'fitness, crossfit, treino' },
                    { n: 'Imobiliárias', k: 'aluguel, venda, corretor' },
                    { n: 'Advogados', k: 'jurídico, causas, direito' },
                    { n: 'Móveis', k: 'planejados, decoração, sofá' },
                    { n: 'Veículos', k: 'carros, seminovos, revenda' }
                  ].map((niche, i) => (
                    <button
                      key={i}
                      onClick={() => setSearchQuery(`${niche.n} em São Paulo`)}
                      className="p-3 bg-slate-50 border border-slate-100 rounded-xl text-left hover:border-primary transition-all group"
                    >
                      <p className="text-sm font-bold group-hover:text-primary">{niche.n}</p>
                      <p className="text-[10px] text-slate-400 truncate">{niche.k}</p>
                    </button>
                  ))}
                </div>
              </Card>

              <Card className="p-6">
                <div className="flex gap-4">
                  <div className="relative flex-1">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={20} />
                    <input
                      type="text"
                      placeholder="Ex: Restaurantes em São Paulo, Dentistas no Rio..."
                      className="w-full pl-12 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-primary transition-all"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>
                  <button
                    onClick={handleSearch}
                    disabled={loading}
                    className="px-8 py-3 bg-primary text-white font-bold rounded-xl hover:bg-primary/90 disabled:opacity-50 transition-all flex items-center gap-2"
                  >
                    {loading ? <RefreshCw className="animate-spin" size={20} /> : <Search size={20} />}
                    Pesquisar
                  </button>
                </div>
              </Card>

              {searchResults.length > 0 && (
                <Card className="p-6">
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="text-lg font-bold">{searchResults.length} Resultados encontrados</h3>
                    <button
                      onClick={saveLeads}
                      disabled={loading}
                      className="px-6 py-2 bg-slate-50 text-slate-700 font-bold rounded-xl hover:bg-slate-100 transition-all flex items-center gap-2"
                    >
                      <Plus size={20} />
                      Salvar na Minha Lista
                    </button>
                  </div>
                  <div className="space-y-4">
                    {searchResults.map((res, i) => (
                      <div key={i} className="flex items-center justify-between p-4 bg-slate-50 rounded-xl border border-slate-100">
                        <div>
                          <h4 className="font-bold">{res.name}</h4>
                          <div className="flex items-center gap-4 mt-1 text-sm text-slate-500">
                            <span className="flex items-center gap-1"><MapPin size={14} /> {res.address}</span>
                            <span className="font-mono">{res.phone}</span>
                          </div>
                        </div>
                        <div className="w-8 h-8 bg-slate-100 text-primary rounded-full flex items-center justify-center">
                          <CheckCircle2 size={18} />
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </motion.div>
          )}

          {activeTab === 'leads' && (
            <motion.div
              key="leads"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              <header className="flex items-center justify-between">
                <div>
                  <h2 className="text-3xl font-bold">Meus Leads</h2>
                  <p className="text-slate-500">Lista de contatos captados e validados.</p>
                </div>
                <div className="flex gap-2">
                   <select
                    className="px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm focus:outline-none"
                    onChange={(e) => {
                      if (e.target.value) sendBroadcast(Number(e.target.value));
                    }}
                   >
                    <option value="">Disparar com Agente...</option>
                    {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                   </select>
                </div>
              </header>

              <Card>
                <table className="w-full text-left">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-100 text-slate-400 text-xs font-semibold uppercase tracking-wider">
                      <th className="py-4 px-6">Nome</th>
                      <th className="py-4 px-6">Telefone</th>
                      <th className="py-4 px-6">Endereço</th>
                      <th className="py-4 px-6">Nicho</th>
                      <th className="py-4 px-6">Status</th>
                    </tr>
                  </thead>
                  <tbody className="text-sm">
                    {leads.map((lead, i) => (
                      <tr key={i} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors">
                        <td className="py-4 px-6 font-medium">{lead.name}</td>
                        <td className="py-4 px-6 text-slate-500 font-mono">{lead.phone}</td>
                        <td className="py-4 px-6 text-slate-400 max-w-xs truncate">{lead.address}</td>
                        <td className="py-4 px-6"><span className="px-2 py-1 bg-slate-100 rounded-lg text-xs">{lead.niche}</span></td>
                        <td className="py-4 px-6">
                          <span className={cn(
                            "px-2 py-1 rounded-lg text-xs font-bold uppercase tracking-tighter",
                            lead.status === 'pending' ? "bg-amber-50 text-amber-600" : "bg-slate-50 text-primary"
                          )}>
                            {lead.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </motion.div>
          )}

          {activeTab === 'groups' && (
            <motion.div
              key="groups"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h2 className="text-3xl font-bold">Grupos WhatsApp</h2>
                  <p className="text-slate-500">Gestão operacional de grupos, participantes, convites e moderação automática.</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
                    value={selectedWooInstanceId || ''}
                    onChange={(e) => setSelectedWooInstanceId(Number(e.target.value))}
                  >
                    {instances.map(inst => <option key={inst.id} value={inst.id}>{inst.name}</option>)}
                  </select>
                  <button onClick={syncGroups} className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-bold text-white">
                    <RefreshCw size={16} /> Sincronizar
                  </button>
                </div>
              </header>

              <div className="grid grid-cols-1 gap-6 xl:grid-cols-[360px_1fr]">
                <div className="space-y-4">
                  <Card className="p-4">
                    <h3 className="mb-3 text-sm font-black uppercase tracking-wider text-slate-500">Novo grupo</h3>
                    <div className="space-y-3">
                      <input className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" placeholder="Nome do grupo" value={newGroup.name} onChange={e => setNewGroup({ ...newGroup, name: e.target.value })} />
                      <textarea className="min-h-[76px] w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" placeholder="Participantes, um por linha" value={newGroup.participants} onChange={e => setNewGroup({ ...newGroup, participants: e.target.value })} />
                      <button onClick={createGroup} className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-sidebar-bg px-4 py-2 text-sm font-bold text-white">
                        <Plus size={16} /> Criar grupo
                      </button>
                    </div>
                  </Card>

                  <Card className="overflow-hidden">
                    <div className="border-b border-slate-100 p-4">
                      <p className="text-xs font-black uppercase tracking-wider text-slate-400">{groups.length} grupos sincronizados</p>
                    </div>
                    <div className="max-h-[620px] overflow-y-auto">
                      {groups.map(group => (
                        <button
                          key={group.group_jid}
                          onClick={() => setSelectedGroupJid(group.group_jid)}
                          className={cn(
                            "flex w-full items-center gap-3 border-b border-slate-50 px-4 py-3 text-left hover:bg-slate-50",
                            selectedGroupJid === group.group_jid && "bg-slate-100"
                          )}
                        >
                          <div className="h-11 w-11 overflow-hidden rounded-md bg-slate-100 text-slate-700 flex items-center justify-center font-black">
                            {group.picture_url ? <img src={sameOriginMediaUrl(group.picture_url)} className="h-full w-full object-cover" /> : <Users size={18} />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-black">{group.name || group.group_jid}</p>
                            <p className="truncate text-xs text-slate-500">{group.participant_count || 0} participantes</p>
                          </div>
                          {(group.announce || group.locked) ? <ShieldCheck size={16} className="text-primary" /> : null}
                        </button>
                      ))}
                    </div>
                  </Card>
                </div>

                <div className="space-y-6">
                  {selectedGroup ? (
                    <>
                      <Card className="p-5">
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                          <div className="flex items-center gap-4">
                            <div className="h-16 w-16 overflow-hidden rounded-md bg-slate-100 flex items-center justify-center">
                              {selectedGroup.picture_url ? <img src={sameOriginMediaUrl(selectedGroup.picture_url)} className="h-full w-full object-cover" /> : <Users size={24} />}
                            </div>
                            <div className="min-w-0">
                              <h3 className="truncate text-2xl font-black">{selectedGroup.name || selectedGroup.group_jid}</h3>
                              <p className="truncate text-sm text-slate-500">{selectedGroup.group_jid}</p>
                              <p className="mt-1 text-xs text-slate-400">{selectedGroup.topic || 'Sem descrição'}</p>
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <button onClick={() => groupAction('name', { name: prompt('Novo nome do grupo', selectedGroup.name || '') || selectedGroup.name })} className="rounded-md border border-slate-200 px-3 py-2 text-xs font-bold">Nome</button>
                            <button onClick={() => groupAction('topic', { topic: prompt('Nova descrição', selectedGroup.topic || '') || selectedGroup.topic })} className="rounded-md border border-slate-200 px-3 py-2 text-xs font-bold">Descrição</button>
                            <button onClick={() => groupAction('invite', { reset: false })} className="rounded-md border border-slate-200 px-3 py-2 text-xs font-bold">Convite</button>
                            <button onClick={() => groupAction('settings', { announce: !selectedGroup.announce, locked: Boolean(selectedGroup.locked) })} className="rounded-md border border-slate-200 px-3 py-2 text-xs font-bold">{selectedGroup.announce ? 'Abrir envio' : 'Só admins'}</button>
                          </div>
                        </div>
                        {selectedGroup.invite_link && (
                          <div className="mt-4 rounded-md border border-slate-100 bg-slate-50 p-3 text-xs text-slate-600">
                            {selectedGroup.invite_link}
                          </div>
                        )}
                      </Card>

                      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                        <Card className="p-5">
                          <div className="mb-4 flex items-center justify-between">
                            <h3 className="font-black">Participantes</h3>
                            <span className="text-xs font-bold text-slate-400">{selectedGroup.participants?.length || 0}</span>
                          </div>
                          <div className="mb-4 flex gap-2">
                            <input className="min-w-0 flex-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" placeholder="Telefone ou JID" value={groupParticipantInput} onChange={e => setGroupParticipantInput(e.target.value)} />
                            <button onClick={() => { groupAction('participants', { participants: [groupParticipantInput], participant_action: 'add' }); setGroupParticipantInput(''); }} className="rounded-md bg-primary px-3 py-2 text-sm font-bold text-white">Adicionar</button>
                          </div>
                          <div className="max-h-[360px] space-y-2 overflow-y-auto">
                            {(selectedGroup.participants || []).map(participant => (
                              <div key={participant.participant_jid} className="flex items-center justify-between gap-3 rounded-md border border-slate-100 px-3 py-2">
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-bold">{participant.name || participant.phone || participant.participant_jid}</p>
                                  <p className="truncate text-xs text-slate-400">{participant.participant_jid}</p>
                                </div>
                                <div className="flex items-center gap-1">
                                  {participant.is_admin ? <span className="rounded bg-emerald-50 px-2 py-1 text-[10px] font-bold text-emerald-700">ADMIN</span> : null}
                                  <button onClick={() => groupAction('participants', { participants: [participant.participant_jid], participant_action: participant.is_admin ? 'demote' : 'promote' })} className="p-2 text-slate-400 hover:text-primary"><UserCog size={15} /></button>
                                  <button onClick={() => groupAction('participants', { participants: [participant.participant_jid], participant_action: 'remove' })} className="p-2 text-slate-400 hover:text-rose-600"><Trash2 size={15} /></button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </Card>

                        <Card className="p-5">
                          <h3 className="mb-4 font-black">Entrar por convite</h3>
                          <div className="flex gap-2">
                            <input className="min-w-0 flex-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" placeholder="https://chat.whatsapp.com/..." value={groupInviteInput} onChange={e => setGroupInviteInput(e.target.value)} />
                            <button onClick={joinGroupByInvite} className="rounded-md bg-sidebar-bg px-3 py-2 text-sm font-bold text-white">Entrar</button>
                          </div>
                          <div className="mt-6 grid grid-cols-2 gap-3">
                            <div className="rounded-md border border-slate-100 p-4">
                              <p className="text-xs font-bold text-slate-400">Modo anúncio</p>
                              <p className="mt-1 text-lg font-black">{selectedGroup.announce ? 'Ativo' : 'Inativo'}</p>
                            </div>
                            <div className="rounded-md border border-slate-100 p-4">
                              <p className="text-xs font-bold text-slate-400">Edição restrita</p>
                              <p className="mt-1 text-lg font-black">{selectedGroup.locked ? 'Ativa' : 'Inativa'}</p>
                            </div>
                          </div>
                        </Card>
                      </div>

                      <Card className="p-5">
                        <div className="mb-4 flex items-center gap-2">
                          <ShieldCheck size={18} className="text-primary" />
                          <h3 className="font-black">Moderação automática</h3>
                        </div>
                        <div className="grid grid-cols-1 gap-3 lg:grid-cols-6">
                          <input className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm lg:col-span-1" placeholder="Nome" value={newGroupRule.name} onChange={e => setNewGroupRule({ ...newGroupRule, name: e.target.value })} />
                          <select className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" value={newGroupRule.rule_type} onChange={e => setNewGroupRule({ ...newGroupRule, rule_type: e.target.value as any })}>
                            <option value="keyword">Palavra</option>
                            <option value="regex">Regex</option>
                            <option value="link">Link</option>
                            <option value="media">Mídia</option>
                          </select>
                          <input className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm lg:col-span-2" placeholder="Palavra, domínio, regex ou *" value={newGroupRule.pattern} onChange={e => setNewGroupRule({ ...newGroupRule, pattern: e.target.value })} />
                          <select className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" value={newGroupRule.action} onChange={e => setNewGroupRule({ ...newGroupRule, action: e.target.value as any })}>
                            <option value="warn">Avisar</option>
                            <option value="remove_participant">Remover</option>
                            <option value="warn_and_remove">Avisar + remover</option>
                            <option value="delete_message">Apagar</option>
                            <option value="log">Log</option>
                          </select>
                          <button onClick={saveGroupRule} className="rounded-md bg-primary px-4 py-2 text-sm font-bold text-white">Salvar</button>
                          <input className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm lg:col-span-3" placeholder="Mensagem de aviso" value={newGroupRule.warning_text || ''} onChange={e => setNewGroupRule({ ...newGroupRule, warning_text: e.target.value })} />
                          <input className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" type="number" min="1" value={newGroupRule.threshold} onChange={e => setNewGroupRule({ ...newGroupRule, threshold: Number(e.target.value) })} />
                          <input className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" type="number" min="1" value={newGroupRule.window_minutes} onChange={e => setNewGroupRule({ ...newGroupRule, window_minutes: Number(e.target.value) })} />
                        </div>
                        <div className="mt-5 grid grid-cols-1 gap-3 xl:grid-cols-2">
                          <div className="space-y-2">
                            {groupRules.map(rule => (
                              <div key={rule.id} className="flex items-center justify-between gap-3 rounded-md border border-slate-100 p-3">
                                <div>
                                  <p className="text-sm font-black">{rule.name}</p>
                                  <p className="text-xs text-slate-500">{rule.rule_type} · {rule.pattern} · {rule.action}</p>
                                </div>
                                <div className="flex gap-1">
                                  <button onClick={() => toggleRule(rule)} className={cn("rounded px-2 py-1 text-xs font-bold", rule.enabled ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500")}>{rule.enabled ? 'ON' : 'OFF'}</button>
                                  <button onClick={() => deleteRule(rule.id)} className="p-2 text-slate-400 hover:text-rose-600"><Trash2 size={15} /></button>
                                </div>
                              </div>
                            ))}
                          </div>
                          <div className="max-h-[320px] space-y-2 overflow-y-auto">
                            {groupModerationEvents.map(event => (
                              <div key={event.id} className="rounded-md border border-slate-100 p-3">
                                <p className="text-sm font-bold">{event.rule_name || `Regra #${event.rule_id}`} <span className="text-xs text-slate-400">{event.status}</span></p>
                                <p className="text-xs text-slate-500">{event.participant_jid} · {event.action} · {formatDate(event.created_at)}</p>
                                {event.error && <p className="mt-1 text-xs text-rose-600">{event.error}</p>}
                              </div>
                            ))}
                          </div>
                        </div>
                      </Card>
                    </>
                  ) : (
                    <Card className="p-10 text-center text-slate-400">Sincronize uma instância para carregar os grupos.</Card>
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'messages' && (
            <motion.div
              key="messages"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="h-full flex flex-col border-0 rounded-none bg-white overflow-hidden shadow-none"
            >
               <div className="hidden">
                <div className="flex items-center gap-5">
                  <div className="w-8 h-8 rounded-md bg-white/10 text-white flex items-center justify-center font-bold text-sm leading-none">W</div>
                  <nav className="hidden xl:flex items-center gap-1 text-[13px] font-semibold">
                    {['Início', 'Tarefas', 'Empresas', 'Pessoas', 'Negócios', 'Relatórios'].map((item) => (
                      <span
                        key={item}
                        className={cn(
                          "px-3 py-2 rounded-lg text-white/75",
                          item === 'Pessoas' && "bg-white/10 text-white"
                        )}
                      >
                        {item}
                      </span>
                    ))}
                  </nav>
                </div>
                <div className="flex items-center gap-3">
                  <div className="relative hidden md:block">
                    <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
                    <input
                      className="w-64 h-9 rounded-md bg-white/95 pl-3 pr-9 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-primary/30"
                      placeholder="Buscar"
                    />
                  </div>
                  <button className="px-4 h-9 rounded-md bg-white text-sidebar-bg text-xs font-bold hover:bg-slate-100 transition-colors">
                    Gerar leads
                  </button>
                  <div className="w-8 h-8 rounded-full border border-white/40 flex items-center justify-center text-[11px] font-bold">GU</div>
                </div>
              </div>
              <div className="grid flex-1 min-h-0 bg-main-bg xl:grid-cols-[minmax(360px,430px)_minmax(0,1fr)_minmax(310px,350px)] lg:grid-cols-[360px_minmax(0,1fr)]">
              {/* Conversations Sidebar */}
              <div className="border-r border-slate-200 flex flex-col bg-white text-slate-900 min-w-0">
                <div className="p-5 border-b border-slate-200 bg-white space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-[18px] font-extrabold text-slate-950">Atendimento</h2>
                      <p className="text-xs text-slate-500">{conversations.length} conversas no workspace</p>
                    </div>
                    <div className="px-3 py-1 rounded-full bg-emerald-50 text-primary text-[10px] font-extrabold uppercase tracking-widest border border-emerald-100">
                      Ao vivo
                    </div>
                  </div>
                  <div className="flex bg-slate-100 p-1 rounded-md gap-1">
                    <button
                      onClick={() => setMsgFilter('all')}
                      className={cn(
                        "flex-1 py-1.5 text-[10px] font-extrabold rounded-md transition-all",
                        msgFilter === 'all' ? "bg-sidebar-bg text-white shadow-sm" : "text-slate-500 hover:text-slate-900"
                      )}
                    >TODOS</button>
                    <button
                      onClick={() => setMsgFilter('contact')}
                      className={cn(
                        "flex-1 py-1.5 text-[10px] font-extrabold rounded-md transition-all",
                        msgFilter === 'contact' ? "bg-sidebar-bg text-white shadow-sm" : "text-slate-500 hover:text-slate-900"
                      )}
                    >CONTATOS</button>
                    <button
                      onClick={() => setMsgFilter('group')}
                      className={cn(
                        "flex-1 py-1.5 text-[10px] font-extrabold rounded-md transition-all",
                        msgFilter === 'group' ? "bg-sidebar-bg text-white shadow-sm" : "text-slate-500 hover:text-slate-900"
                      )}
                    >GRUPOS</button>
                  </div>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                    <input
                      type="text"
                      placeholder="Buscar conversas..."
                      className="w-full pl-9 pr-4 py-3 bg-white border border-slate-200 rounded-md text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-primary focus:ring-3 focus:ring-primary/10"
                    />
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-2">
                  {conversations
                    .filter(c => !isIgnoredConversation(c))
                    .filter(c => msgFilter === 'all' ? true : c.type === msgFilter)
                    .map((conv) => {
                      const preview = conv.last_message || conv.last_message_preview || '';
                      const previewKind = mediaPreviewKind(preview);
                      return (
                    <div key={conv.id} className="group relative">
                      <button
                        onClick={() => setActiveConversationId(conv.id)}
                        className={cn(
                          "w-full p-3.5 flex gap-3 text-left transition-all rounded-md border",
                          activeConversationId === conv.id ? "bg-slate-950 text-white border-slate-950 shadow-sm" : "bg-white border-transparent hover:border-slate-200 hover:bg-slate-50 text-slate-900"
                        )}
                      >
                        <div className="relative shrink-0">
                          <div className={cn(
                            "w-11 h-11 rounded-md flex items-center justify-center font-bold overflow-hidden",
                            activeConversationId === conv.id ? "bg-white/12 text-white" : "bg-slate-100 text-slate-900"
                          )}>
                            {conv.contact_profile_picture_url ? (
                              <img src={sameOriginMediaUrl(conv.contact_profile_picture_url)} alt="" className="h-full w-full object-cover" />
                            ) : (
                              conversationInitial(conv)
                            )}
                          </div>
                          <div className={cn(
                            "absolute -bottom-1 -right-1 p-1 rounded-full shadow-sm border",
                            activeConversationId === conv.id ? "bg-slate-950 border-white/20 text-white" : "bg-white border-slate-200 text-slate-900"
                          )}>
                            {conv.type === 'group' ? <Users size={12} /> : <User size={12} />}
                          </div>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex justify-between items-start mb-0.5 pr-6">
                            <h4 className={cn("font-bold text-[13px] truncate leading-tight", activeConversationId === conv.id ? "text-white" : "text-slate-900")}>{conv.title}</h4>
                            <span className={cn("text-[10px] font-medium whitespace-nowrap ml-2", activeConversationId === conv.id ? "text-white/55" : "text-slate-500")}>
                              {formatDate(conv.last_message_at)}
                            </span>
                          </div>
                          {previewKind ? (
                            <div className={cn("mt-1 flex items-center", activeConversationId === conv.id ? "text-white/65" : "text-slate-500")}>
                              {previewKind === 'image' ? <ImageIcon size={14} /> : <Paperclip size={14} />}
                            </div>
                          ) : (
                            <p className={cn("text-[11px] truncate leading-relaxed", activeConversationId === conv.id ? "text-white/65" : "text-slate-500")}>
                              {preview || 'Inicie uma conversa'}
                            </p>
                          )}
                          <div className="flex gap-1 mt-2">
                            {JSON.parse(conv.tags_json || '[]').slice(0, 2).map((tag: string) => (
                              <span key={tag} className={cn("px-2 py-0.5 rounded text-[10px] font-bold", activeConversationId === conv.id ? "bg-white/12 text-white" : "bg-slate-100 text-slate-700")}>{tag}</span>
                            ))}
                          </div>
                        </div>
                      </button>
                      <button
                         onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id); }}
                         className="absolute right-4 top-1/2 -translate-y-1/2 p-2 text-slate-300 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-all"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  )})}
                  {conversations.length === 0 && (
                    <div className="h-full min-h-[420px] flex flex-col gap-3">
                      <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
                        <div className="flex items-center gap-3">
                          <div className="h-10 w-10 rounded-md bg-white border border-slate-200 text-primary flex items-center justify-center">
                            <MessagesSquare size={20} />
                          </div>
                          <div>
                            <p className="text-sm font-black text-slate-950">Fila limpa</p>
                            <p className="text-xs text-slate-500">Nenhuma conversa no filtro atual.</p>
                          </div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="rounded-md border border-slate-200 bg-white p-4">
                          <p className="text-[10px] font-extrabold uppercase text-slate-500">Contatos</p>
                          <p className="mt-1 text-2xl font-black text-slate-950">{conversations.filter(item => item.type === 'contact').length}</p>
                        </div>
                        <div className="rounded-md border border-slate-200 bg-white p-4">
                          <p className="text-[10px] font-extrabold uppercase text-slate-500">Grupos</p>
                          <p className="mt-1 text-2xl font-black text-slate-950">{conversations.filter(item => item.type === 'group').length}</p>
                        </div>
                      </div>
                      <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
                        <p className="text-[10px] font-extrabold uppercase tracking-widest text-slate-500">Entrada de mensagens</p>
                        {[
                          ['Webhook ativo', selectedWooInstance?.webhook?.webhooks_url || selectedWooInstance?.webhook_endpoint ? 'Configurado' : 'Aguardando'],
                          ['Instancia padrao', selectedWooInstance?.name || 'Sem instancia'],
                          ['Status', selectedWooInstance ? instanceStatusLabel(selectedWooInstance.status) : 'Sem canal']
                        ].map(([label, value]) => (
                          <div key={label} className="flex items-center justify-between gap-3 border-t border-slate-100 pt-3 first:border-t-0 first:pt-0">
                            <span className="text-xs font-bold text-slate-500">{label}</span>
                            <span className="max-w-[160px] truncate text-right text-xs font-black text-slate-950">{value}</span>
                          </div>
                        ))}
                      </div>
                      <div className="mt-auto rounded-md border border-emerald-100 bg-emerald-50 p-4">
                        <p className="text-xs font-black text-primary">Pronto para receber</p>
                        <p className="mt-1 text-xs leading-relaxed text-slate-600">Assim que chegar uma mensagem, ela ocupa esta lista e abre o contexto completo ao lado.</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Chat View */}
              <div className="flex flex-col bg-main-bg min-w-0">
                {activeConversationId ? (
                  <>
                    {/* Chat Header */}
                    <div className="px-6 py-3.5 border-b border-slate-200 bg-white flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-slate-100 text-slate-900 rounded-md flex items-center justify-center font-bold uppercase overflow-hidden">
                          {conversations.find(c => c.id === activeConversationId)?.contact_profile_picture_url ? (
                            <img src={sameOriginMediaUrl(conversations.find(c => c.id === activeConversationId)?.contact_profile_picture_url)} alt="" className="h-full w-full rounded-md object-cover" />
                          ) : (
                            conversationInitial(conversations.find(c => c.id === activeConversationId))
                          )}
                        </div>
                        <div>
                          <h3 className="font-extrabold text-slate-900 text-sm">
                            {conversations.find(c => c.id === activeConversationId)?.title}
                          </h3>
                          <p className="text-[11px] text-slate-500">
                            {conversations.find(c => c.id === activeConversationId)?.remote_jid || conversations.find(c => c.id === activeConversationId)?.contact_phone}
                          </p>
                        </div>
                      </div>
                      <div className="flex gap-2 text-slate-400">
                        <button className="p-2 hover:bg-slate-100 hover:text-slate-900 rounded-md transition-colors"><Smartphone size={20} /></button>
                        <button className="p-2 hover:bg-slate-100 hover:text-slate-900 rounded-md transition-colors"><Search size={20} /></button>
                      </div>
                    </div>

                    {/* Chat Messages */}
                    <div className="flex-1 overflow-y-auto bg-main-bg">
                      <div className="min-h-full flex flex-col justify-end px-8 py-6 space-y-4">
                      <div className="mx-auto mb-2 px-4 py-1.5 rounded-full bg-white border border-slate-200 text-[11px] font-bold text-slate-500 shadow-sm">
                        Conversa sincronizada em tempo real
                      </div>
                      {chatMessages.map((msg) => (
                        <div
                          key={msg.id || msg.message_id}
                          className={cn(
                            "flex flex-col max-w-[68%] group",
                            msg.direction === 'outbound' ? "ml-auto items-end" : "items-start"
                          )}
                        >
                          <div className="flex items-center gap-2 mb-1">
                            {msg.chat_type === 'group' && msg.direction === 'inbound' && (
                              <span className="text-[10px] text-slate-400 ml-1">{msg.author_push_name || msg.author_phone}</span>
                            )}
                            <button
                              onClick={() => deleteChatMessage(msg.id)}
                              className="text-slate-300 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-all"
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                          <div className={cn(
                            "rounded-md text-sm shadow-sm leading-relaxed tracking-tight font-medium overflow-hidden",
                            ['image', 'video'].includes(String(msg.content_type)) ? "p-1" : "px-4 py-3",
                            msg.direction === 'outbound'
                              ? msg.delivery_status === 'failed'
                                ? "bg-rose-500 text-white rounded-tr-none"
                                : "bg-sidebar-bg text-white rounded-tr-none"
                              : "bg-white text-slate-900 border border-slate-200 rounded-tl-none"
                          )}>
                             {msg.content_type === 'image' && isRenderableMediaUrl(msg.content_text) ? (
                               <img src={sameOriginMediaUrl(msg.content_text)} alt="Imagem recebida" className="block w-[min(320px,62vw)] max-h-[360px] rounded-md object-contain bg-slate-100 cursor-pointer hover:opacity-90 transition-opacity" onClick={() => msg.content_text && window.open(sameOriginMediaUrl(msg.content_text), '_blank')} />
                             ) : msg.content_type === 'image' ? (
                               <div className="flex h-24 w-[min(320px,62vw)] items-center justify-center rounded-md bg-slate-100 text-slate-400">
                                 <ImageIcon size={22} />
                               </div>
                             ) : msg.content_type === 'audio' ? (
                               <audio src={sameOriginMediaUrl(msg.content_text)} controls className="max-w-[240px] h-10" />
                             ) : msg.content_type === 'video' && isRenderableMediaUrl(msg.content_text) ? (
                               <video src={sameOriginMediaUrl(msg.content_text)} controls className="block w-[min(320px,62vw)] max-h-[360px] rounded-md bg-black" />
                             ) : msg.content_type === 'video' ? (
                               <div className="flex h-24 w-[min(320px,62vw)] items-center justify-center rounded-md bg-slate-100 text-slate-400">
                                 <Paperclip size={22} />
                               </div>
                             ) : msg.content_type === 'document' ? (
                               <a href={sameOriginMediaUrl(msg.content_text)} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 underline decoration-slate-300">
                                 <Paperclip size={16} /> Ver Documento
                               </a>
                             ) : (
                               msg.content_text || msg.content
                             )}
                          </div>
                          <div className="flex items-center gap-1 mt-1">
                            <span className="text-[10px] text-slate-400">
                              {formatDate(msg.created_at)}
                            </span>
                            {msg.direction === 'outbound' && (
                              <span className="text-[10px]">
                                {msg.delivery_status === 'pending' && <span className="text-amber-400" title="Enviando...">⏳</span>}
                                {msg.delivery_status === 'sent' && <span className="text-slate-400" title="Enviada">✓</span>}
                                {msg.delivery_status === 'delivered' && <span className="text-slate-400" title="Entregue">✓✓</span>}
                                {msg.delivery_status === 'read' && <span className="text-primary" title="Lida">✓✓</span>}
                                {msg.delivery_status === 'failed' && (
                                  <span className="text-rose-500 cursor-pointer" title="Falhou - clique para reenviar">✕</span>
                                )}
                                {!msg.delivery_status && <span className="text-slate-400">✓</span>}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                      {chatMessages.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-full text-center text-slate-400 gap-2">
                           <MessageSquare size={32} />
                           <p className="text-sm">Envie uma mensagem para começar.</p>
                        </div>
                      )}
                      </div>
                    </div>

                    {/* Chat Input */}
                    <div className="p-4 border-t border-slate-200 bg-white">
                      <div className="flex gap-3 items-center">
                        <input
                          type="file"
                          ref={fileInputRef}
                          className="hidden"
                          onChange={handleFileChange}
                        />
                        <button
                          onClick={() => fileInputRef.current?.click()}
                          className="h-11 w-11 flex items-center justify-center bg-slate-100 text-slate-500 hover:text-slate-900 hover:bg-slate-200 rounded-md transition-colors"
                        >
                          <Paperclip size={20} />
                        </button>
                        <div className="flex-1 relative">
                          <input
                            type="text"
                            className="w-full h-11 px-4 bg-main-bg border border-slate-200 rounded-md focus:outline-none focus:border-primary focus:ring-3 focus:ring-primary/10 focus:bg-white transition-all text-sm"
                            placeholder="Digite sua mensagem..."
                            value={newMessage}
                            onChange={(e) => setNewMessage(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                          />
                        </div>
                        <button
                          onClick={sendMessage}
                          disabled={!newMessage.trim()}
                          className="h-11 w-11 flex items-center justify-center bg-sidebar-bg text-white rounded-md hover:bg-slate-800 transition-all disabled:opacity-50"
                        >
                          <Send size={20} />
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="h-full p-5 flex flex-col gap-4 overflow-y-auto">
                    <div className="w-full text-left rounded-md border border-slate-200 bg-white p-5">
                    <div className="w-12 h-12 bg-emerald-50 text-primary rounded-md flex items-center justify-center mb-4 border border-emerald-100 shadow-sm">
                      <MessagesSquare size={32} />
                    </div>
                    <h3 className="text-2xl font-black text-slate-950">Selecione uma conversa</h3>
                    <p className="text-slate-500 max-w-md mt-2 mx-auto">
                      Suas mensagens recebidas e enviadas aparecerão aqui em tempo real.
                    </p>
                    <div className="grid grid-cols-4 gap-3 mt-5 text-left">
                      <div className="rounded-md bg-white border border-slate-200 p-4">
                        <p className="text-[10px] font-extrabold text-slate-500 uppercase">Conversas</p>
                        <p className="text-2xl font-black text-slate-950 mt-1">{conversations.length}</p>
                      </div>
                      <div className="rounded-md bg-white border border-slate-200 p-4">
                        <p className="text-[10px] font-extrabold text-slate-500 uppercase">Nao lidas</p>
                        <p className="text-2xl font-black text-slate-950 mt-1">{conversations.reduce((sum, item) => sum + (item.unread_count || 0), 0)}</p>
                      </div>
                      <div className="rounded-md bg-white border border-slate-200 p-4">
                        <p className="text-[10px] font-extrabold text-slate-500 uppercase">Modo</p>
                        <p className="text-2xl font-black text-primary mt-1">Live</p>
                      </div>
                      <div className="rounded-md bg-white border border-slate-200 p-4">
                        <p className="text-[10px] font-extrabold text-slate-500 uppercase">Canais</p>
                        <p className="text-2xl font-black text-slate-950 mt-1">{instances.filter(item => isConnectedStatus(item.status)).length}/{instances.length}</p>
                      </div>
                    </div>
                    </div>
                    <div className="grid flex-1 min-h-[360px] grid-cols-2 gap-4">
                      <div className="rounded-md border border-slate-200 bg-white p-5 flex flex-col">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-[10px] font-extrabold uppercase tracking-widest text-slate-500">Fila agora</p>
                            <h4 className="mt-1 text-lg font-black text-slate-950">Sem conversas abertas</h4>
                          </div>
                          <Activity size={22} className="text-primary" />
                        </div>
                        <div className="mt-5 space-y-3">
                          {[
                            ['1', 'Conecte uma instancia WhatsApp para entrada em tempo real.'],
                            ['2', 'Configure webhooks para n8n, Chatwoot ou seu CRM.'],
                            ['3', 'Use tags e responsavel quando uma conversa chegar.']
                          ].map(([step, text]) => (
                            <div key={step} className="flex gap-3 rounded-md bg-main-bg border border-slate-200 p-3">
                              <span className="h-7 w-7 shrink-0 rounded-md bg-sidebar-bg text-white flex items-center justify-center text-xs font-black">{step}</span>
                              <p className="text-sm leading-relaxed text-slate-600">{text}</p>
                            </div>
                          ))}
                        </div>
                        <button
                          onClick={() => setActiveTab('whatsapp')}
                          className="mt-auto w-full rounded-md bg-sidebar-bg px-4 py-3 text-sm font-bold text-white hover:bg-slate-800 transition-colors"
                        >
                          Ver instancias
                        </button>
                      </div>

                      <div className="rounded-md border border-slate-200 bg-white p-5 flex flex-col">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-[10px] font-extrabold uppercase tracking-widest text-slate-500">Canal principal</p>
                            <h4 className="mt-1 text-lg font-black text-slate-950 truncate">{selectedWooInstance?.name || 'Nenhuma instancia'}</h4>
                          </div>
                          <Smartphone size={22} className={selectedWooInstance && isConnectedStatus(selectedWooInstance.status) ? 'text-primary' : 'text-slate-400'} />
                        </div>
                        <div className="mt-5 grid grid-cols-2 gap-3">
                          <div className="rounded-md border border-slate-200 bg-main-bg p-4">
                            <p className="text-[10px] font-extrabold uppercase text-slate-500">Status</p>
                            <p className="mt-1 truncate text-sm font-black text-slate-950">{selectedWooInstance ? instanceStatusLabel(selectedWooInstance.status) : 'Sem canal'}</p>
                          </div>
                          <div className="rounded-md border border-slate-200 bg-main-bg p-4">
                            <p className="text-[10px] font-extrabold uppercase text-slate-500">Tipo</p>
                            <p className="mt-1 truncate text-sm font-black text-slate-950">{selectedWooInstance?.engine || 'WooAPI'}</p>
                          </div>
                        </div>
                        <div className="mt-4 rounded-md border border-slate-200 bg-main-bg p-4">
                          <p className="text-[10px] font-extrabold uppercase tracking-widest text-slate-500">Webhook</p>
                          <p className="mt-2 break-all text-xs leading-relaxed text-slate-600">
                            {selectedWooInstance?.webhook?.webhooks_url || selectedWooInstance?.webhook_endpoint || 'Nenhum webhook configurado para a instancia selecionada.'}
                          </p>
                        </div>
                        <div className="mt-auto grid grid-cols-2 gap-3 pt-5">
                          <button
                            onClick={() => setActiveTab('integrations')}
                            className="rounded-md bg-slate-100 px-4 py-3 text-sm font-bold text-slate-900 hover:bg-slate-200 transition-colors"
                          >
                            Conectores
                          </button>
                          <button
                            onClick={() => setActiveTab('api_docs')}
                            className="rounded-md bg-emerald-50 px-4 py-3 text-sm font-bold text-primary hover:bg-emerald-100 transition-colors"
                          >
                            Integracoes
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {(() => {
                const conv = conversations.find(c => c.id === activeConversationId);
                if (!conv) {
                  const filteredConversations = conversations.filter(c => msgFilter === 'all' ? true : c.type === msgFilter);
                  const latestConversation = filteredConversations[0];
                  return (
                    <aside className="hidden xl:flex border-l border-slate-200 bg-white flex-col min-w-0">
                      <div className="p-5 border-b border-slate-200">
                        <p className="text-[10px] font-extrabold text-slate-500 uppercase tracking-widest mb-3">Resumo</p>
                        <h4 className="font-black text-slate-950 text-lg">Fila de atendimento</h4>
                        <p className="text-xs text-slate-500 mt-1">Use a lista para abrir uma conversa e acompanhar dados, tags e acoes.</p>
                      </div>
                      <div className="p-5 space-y-4 overflow-y-auto flex-1">
                        <div className="grid grid-cols-2 gap-3">
                          <div className="rounded-md bg-main-bg border border-slate-200 p-4">
                            <p className="text-[10px] text-slate-500 font-extrabold uppercase">Visiveis</p>
                            <p className="text-2xl font-black text-slate-900 mt-1">{filteredConversations.length}</p>
                          </div>
                          <div className="rounded-md bg-main-bg border border-slate-200 p-4">
                            <p className="text-[10px] text-slate-500 font-extrabold uppercase">Nao lidas</p>
                            <p className="text-2xl font-black text-slate-900 mt-1">{conversations.reduce((sum, item) => sum + (item.unread_count || 0), 0)}</p>
                          </div>
                        </div>
                        <div className="rounded-md bg-main-bg border border-slate-200 p-4">
                          <p className="text-[10px] font-extrabold text-slate-500 uppercase tracking-widest mb-3">Proxima acao</p>
                          <p className="text-sm font-bold text-slate-950">{latestConversation?.title || 'Nenhuma conversa na fila'}</p>
                          <p className="text-xs text-slate-500 mt-1 line-clamp-2">{latestConversation?.last_message || latestConversation?.last_message_preview || 'Quando uma mensagem chegar, ela aparecera aqui.'}</p>
                          {latestConversation && (
                            <button
                              onClick={() => setActiveConversationId(latestConversation.id)}
                              className="mt-4 w-full py-3 bg-sidebar-bg text-white rounded-md text-sm font-bold hover:bg-slate-800 transition-colors"
                            >
                              Abrir conversa
                            </button>
                          )}
                        </div>
                        <div className="rounded-md bg-main-bg border border-slate-200 p-4 space-y-3">
                          <p className="text-[10px] font-extrabold text-slate-500 uppercase tracking-widest">Status do canal</p>
                          <div className="flex items-center gap-2 text-sm font-bold text-slate-950">
                            <span className="h-2.5 w-2.5 rounded-full bg-primary" />
                            Sincronizacao em tempo real
                          </div>
                          <p className="text-xs text-slate-500">Mensagens novas entram na fila automaticamente.</p>
                        </div>
                        <div className="rounded-md bg-main-bg border border-slate-200 p-4 space-y-3">
                          <p className="text-[10px] font-extrabold text-slate-500 uppercase tracking-widest">Checklist</p>
                          {[
                            ['Instancia', selectedWooInstance ? instanceStatusLabel(selectedWooInstance.status) : 'Sem canal'],
                            ['Webhook', selectedWooInstance?.webhook?.webhooks_url || selectedWooInstance?.webhook_endpoint ? 'Configurado' : 'Pendente'],
                            ['Operacao', conversations.length ? 'Com historico' : 'Fila limpa']
                          ].map(([label, value]) => (
                            <div key={label} className="flex items-center justify-between gap-3 border-t border-slate-200 pt-3 first:border-t-0 first:pt-0">
                              <span className="text-xs font-bold text-slate-500">{label}</span>
                              <span className="max-w-[150px] truncate text-right text-xs font-black text-slate-950">{value}</span>
                            </div>
                          ))}
                        </div>
                        <div className="rounded-md bg-sidebar-bg p-4 text-white">
                          <p className="text-[10px] font-extrabold uppercase tracking-widest text-white/45">Atalhos</p>
                          <div className="mt-3 grid grid-cols-2 gap-2">
                            <button
                              onClick={() => setActiveTab('whatsapp')}
                              className="rounded-md bg-white/10 px-3 py-2 text-xs font-bold hover:bg-white/15"
                            >
                              Instancias
                            </button>
                            <button
                              onClick={() => setActiveTab('integrations')}
                              className="rounded-md bg-white/10 px-3 py-2 text-xs font-bold hover:bg-white/15"
                            >
                              Conectores
                            </button>
                          </div>
                        </div>
                        <div className="mt-auto rounded-md border border-emerald-100 bg-emerald-50 p-4">
                          <p className="text-xs font-black text-primary">Tela pronta para operacao</p>
                          <p className="mt-1 text-xs leading-relaxed text-slate-600">O espaco livre agora vira monitoramento, configuracao e proxima acao.</p>
                        </div>
                      </div>
                    </aside>
                  );
                }
                const tags = JSON.parse(conv.tags_json || '[]');
                return (
                  <aside className="hidden xl:flex border-l border-slate-200 bg-main-bg flex-col min-w-0">
                    <div className="p-5 border-b border-slate-200 bg-white">
                      <p className="text-[10px] font-extrabold text-slate-500 uppercase tracking-widest mb-3">Atendimento</p>
                      <div className="flex items-center gap-3">
                        <div className="w-11 h-11 rounded-md bg-slate-100 text-slate-900 flex items-center justify-center font-black uppercase overflow-hidden">
                          {conv.contact_profile_picture_url ? (
                            <img src={sameOriginMediaUrl(conv.contact_profile_picture_url)} alt="" className="h-full w-full object-cover" />
                          ) : (
                            conversationInitial(conv)
                          )}
                        </div>
                        <div className="min-w-0">
                          <h4 className="font-extrabold text-slate-900 text-sm truncate">{conv.title}</h4>
                          <p className="text-[11px] text-slate-500 truncate">{conv.remote_jid || conv.contact_phone || conv.group_jid}</p>
                        </div>
                      </div>
                    </div>

                    <div className="p-5 space-y-4 overflow-y-auto">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="rounded-md bg-white border border-slate-200 p-4">
                          <p className="text-[10px] text-slate-500 font-extrabold uppercase">Mensagens</p>
                          <p className="text-2xl font-black text-slate-900 mt-1">{chatMessages.length}</p>
                        </div>
                        <div className="rounded-md bg-white border border-slate-200 p-4">
                          <p className="text-[10px] text-slate-500 font-extrabold uppercase">Não lidas</p>
                          <p className="text-2xl font-black text-slate-900 mt-1">{conv.unread_count || 0}</p>
                        </div>
                      </div>

                      <div className="rounded-md bg-white border border-slate-200 p-4">
                        <label className="text-[10px] font-extrabold text-slate-500 uppercase tracking-widest block mb-2">Status</label>
                        <select
                          value={conv.status || 'open'}
                          onChange={(e) => updateConversationMeta(conv.id, { status: e.target.value })}
                          className="w-full px-3 py-2 bg-main-bg border border-slate-200 rounded-md text-sm focus:outline-none focus:border-slate-900"
                        >
                          <option value="open">Aberto</option>
                          <option value="pending">Pendente</option>
                          <option value="closed">Resolvido</option>
                        </select>
                      </div>

                      <div className="rounded-md bg-white border border-slate-200 p-4">
                        <label className="text-[10px] font-extrabold text-slate-500 uppercase tracking-widest block mb-2">Responsável</label>
                        <select
                          value={conv.assigned_to || ''}
                          onChange={(e) => updateConversationMeta(conv.id, { assigned_to: e.target.value || null })}
                          className="w-full px-3 py-2 bg-main-bg border border-slate-200 rounded-md text-sm focus:outline-none focus:border-slate-900"
                        >
                          <option value="">Sem responsável</option>
                          {team.map(member => <option key={member.id} value={member.name}>{member.name}</option>)}
                        </select>
                      </div>

                      <div className="rounded-md bg-white border border-slate-200 p-4">
                        <label className="text-[10px] font-extrabold text-slate-500 uppercase tracking-widest block mb-2">Tags</label>
                        <div className="flex flex-wrap gap-2 mb-3">
                          {tags.length ? tags.map((tag: string) => (
                            <button
                              key={tag}
                              onClick={() => updateConversationMeta(conv.id, { tags: tags.filter((t: string) => t !== tag) })}
                              className="px-2.5 py-1 bg-slate-100 text-slate-900 rounded-md text-xs font-bold"
                            >
                              {tag} ×
                            </button>
                          )) : <span className="text-xs text-slate-400">Nenhuma tag</span>}
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          {['suporte', 'vendas', 'urgente', 'financeiro'].map(tag => (
                            <button
                              key={tag}
                              onClick={() => addConversationTag(conv, tag)}
                              className="px-3 py-2 bg-slate-100 hover:bg-slate-200 rounded-md text-xs font-bold text-slate-900 transition-colors"
                            >
                              + {tag}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="rounded-md bg-white border border-slate-200 p-4 space-y-2">
                        <p className="text-[10px] font-extrabold text-slate-500 uppercase tracking-widest mb-2">Ações rápidas</p>
                        <button
                          onClick={() => updateConversationMeta(conv.id, { status: 'pending' })}
                          className="w-full py-3 bg-slate-100 text-slate-900 rounded-md text-sm font-bold hover:bg-slate-200 transition-colors"
                        >
                          Transferir / colocar em espera
                        </button>
                        <button
                          onClick={() => updateConversationMeta(conv.id, { status: 'closed' })}
                          className="w-full py-3 bg-sidebar-bg text-white rounded-md text-sm font-bold hover:bg-slate-800 transition-colors"
                        >
                          Encerrar atendimento
                        </button>
                      </div>
                    </div>
                  </aside>
                );
              })()}
              </div>
            </motion.div>
          )}

          {activeTab === 'agenda' && (
            <motion.div
              key="agenda"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              <header>
                <h2 className="text-3xl font-bold">Agenda</h2>
                <p className="text-slate-500">Crie e gerencie agendas vinculadas a agentes e membros do time.</p>
              </header>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <Card className="p-6 h-fit lg:col-span-1">
                  <h3 className="text-lg font-bold mb-4">Nova Agenda</h3>
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Nome da Agenda</label>
                      <input
                        type="text"
                        placeholder="Ex: Agenda de Vendas"
                        className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none"
                        value={newSchedule.name}
                        onChange={(e) => setNewSchedule({ ...newSchedule, name: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Vincular Agente IA</label>
                      <select
                        className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none"
                        value={newSchedule.agent_id}
                        onChange={(e) => setNewSchedule({ ...newSchedule, agent_id: Number(e.target.value) })}
                      >
                        <option value={0}>Nenhum Agente</option>
                        {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Vincular Membro do Time</label>
                      <select
                        className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none"
                        value={newSchedule.member_id}
                        onChange={(e) => setNewSchedule({ ...newSchedule, member_id: Number(e.target.value) })}
                      >
                        <option value={0}>Nenhum Membro</option>
                        {team.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Descrição</label>
                      <textarea
                        rows={2}
                        placeholder="Opcional..."
                        className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none resize-none"
                        value={newSchedule.description}
                        onChange={(e) => setNewSchedule({ ...newSchedule, description: e.target.value })}
                      />
                    </div>
                    <button
                      onClick={createSchedule}
                      className="w-full py-3 bg-primary text-white font-bold rounded-xl hover:bg-primary/90 transition-all flex items-center justify-center gap-2"
                    >
                      <Plus size={20} />
                      Criar Agenda
                    </button>
                  </div>
                </Card>

                <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-6">
                  {schedules.map((schedule) => (
                    <Card key={schedule.id} className="p-6 flex flex-col">
                      <div className="flex items-start justify-between mb-4">
                        <div className="w-12 h-12 bg-slate-50 text-primary rounded-2xl flex items-center justify-center">
                          <Calendar size={24} />
                        </div>
                        <button
                          onClick={() => schedule.id && deleteSchedule(schedule.id)}
                          className="text-slate-300 hover:text-red-500 transition-colors"
                        >
                          <Trash2 size={18} />
                        </button>
                      </div>
                      <h4 className="text-xl font-bold mb-2">{schedule.name}</h4>
                      {schedule.description && (
                        <p className="text-sm text-slate-500 mb-4 italic">"{schedule.description}"</p>
                      )}
                      <div className="space-y-3 mt-auto">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 bg-slate-100 rounded-lg flex items-center justify-center text-slate-500">
                            <Bot size={14} />
                          </div>
                          <span className="text-xs font-medium text-slate-600">
                            Agente: <span className="font-bold text-primary">{schedule.agent_name || 'Não vinculado'}</span>
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 bg-slate-100 rounded-lg flex items-center justify-center text-slate-500">
                            <Users size={14} />
                          </div>
                          <span className="text-xs font-medium text-slate-600">
                            Equipe: <span className="font-bold text-primary">{schedule.member_name || 'Não vinculado'}</span>
                          </span>
                        </div>
                      </div>
                    </Card>
                  ))}
                  {schedules.length === 0 && (
                    <div className="col-span-full py-12 text-center text-slate-400">
                      Nenhuma agenda criada ainda.
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'agents' && (
            <motion.div
              key="agents"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              <header>
                <h2 className="text-3xl font-bold">Agentes de IA</h2>
                <p className="text-slate-500">Crie personalidades para seus disparos e atendimentos.</p>
              </header>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <Card className="p-6 h-fit lg:col-span-1">
                  <h3 className="text-lg font-bold mb-4">Configurar Agente</h3>
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Nome do Agente</label>
                      <input
                        type="text"
                        placeholder="Ex: Vendedor de Software"
                        className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-slate-900/10"
                        value={newAgent.name}
                        onChange={(e) => setNewAgent({ ...newAgent, name: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Personalidade</label>
                      <select
                        className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none"
                        value={newAgent.personality}
                        onChange={(e) => setNewAgent({ ...newAgent, personality: e.target.value })}
                      >
                        <option value="Amigável e Descontraído">Amigável e Descontraído</option>
                        <option value="Profissional e Direto">Profissional e Direto</option>
                        <option value="Persuasivo e Enérgico">Persuasivo e Enérgico</option>
                        <option value="Empático e Atencioso">Empático e Atencioso</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Instrução de Sistema</label>
                      <textarea
                        rows={3}
                        placeholder="Instruções base para o comportamento..."
                        className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-slate-900/10 resize-none"
                        value={newAgent.system_instruction}
                        onChange={(e) => setNewAgent({ ...newAgent, system_instruction: e.target.value })}
                      />
                    </div>

                    <div>
                      <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">FAQ (Respostas Padrão)</label>
                      <div className="space-y-2">
                        {newAgent.faq.map((f, i) => (
                          <div key={i} className="flex gap-2">
                            <input
                              placeholder="Pergunta"
                              className="flex-1 text-xs p-2 bg-slate-50 border border-slate-100 rounded-lg"
                              value={f.q}
                              onChange={(e) => {
                                const n = [...newAgent.faq];
                                n[i].q = e.target.value;
                                setNewAgent({ ...newAgent, faq: n });
                              }}
                            />
                            <input
                              placeholder="Resposta"
                              className="flex-1 text-xs p-2 bg-slate-50 border border-slate-100 rounded-lg"
                              value={f.a}
                              onChange={(e) => {
                                const n = [...newAgent.faq];
                                n[i].a = e.target.value;
                                setNewAgent({ ...newAgent, faq: n });
                              }}
                            />
                          </div>
                        ))}
                        <button
                          onClick={() => setNewAgent({ ...newAgent, faq: [...newAgent.faq, { q: '', a: '' }] })}
                          className="text-[10px] text-primary font-bold hover:underline"
                        >
                          + Adicionar FAQ
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Gatilho de Transbordo (Humano)</label>
                      <input
                        type="text"
                        placeholder="Palavra-chave para chamar humano"
                        className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none"
                        value={newAgent.handoff_trigger}
                        onChange={(e) => setNewAgent({ ...newAgent, handoff_trigger: e.target.value })}
                      />
                    </div>

                    <button
                      onClick={createAgent}
                      className="w-full py-3 bg-primary text-white font-bold rounded-xl hover:bg-primary/90 transition-all flex items-center justify-center gap-2"
                    >
                      <Plus size={20} />
                      Salvar Agente
                    </button>
                  </div>
                </Card>

                <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-6">
                  {agents.map((agent) => (
                    <Card key={agent.id} className="p-6 flex flex-col">
                      <div className="flex items-start justify-between mb-4">
                        <div className="w-12 h-12 bg-slate-50 text-primary rounded-2xl flex items-center justify-center">
                          <Bot size={24} />
                        </div>
                        <button
                          onClick={() => agent.id && deleteAgent(agent.id)}
                          className="text-slate-300 hover:text-red-500 transition-colors"
                        >
                          <Trash2 size={18} />
                        </button>
                      </div>
                      <h4 className="text-xl font-bold mb-1">{agent.name}</h4>
                      <p className="text-[10px] font-bold text-primary uppercase tracking-widest mb-3">{agent.personality}</p>
                      <p className="text-sm text-slate-500 line-clamp-3 flex-1 italic mb-4">
                        "{agent.system_instruction}"
                      </p>
                      <div className="space-y-1 mb-4">
                        <p className="text-[10px] font-bold text-slate-400 uppercase">Gatilho Humano:</p>
                        <p className="text-xs bg-slate-50 p-2 rounded-lg border border-slate-100">{agent.handoff_trigger}</p>
                      </div>
                      <div className="mt-auto pt-6 border-t border-slate-50 flex items-center justify-between">
                        <span className="text-xs text-slate-400">ID: #{agent.id}</span>
                        <button className="text-primary text-sm font-bold hover:underline">Configurar</button>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'kanban' && (
            <motion.div
              key="kanban"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              <header>
                <h2 className="text-3xl font-bold">Quadro Kanban</h2>
                <p className="text-slate-500">Gerencie o progresso dos seus leads visualmente.</p>
              </header>

              <div className="flex gap-6 overflow-x-auto pb-6 min-h-[600px]">
                {['new', 'contacted', 'negotiating', 'closed', 'lost'].map((status) => (
                  <div key={status} className="flex-1 min-w-[300px] space-y-4 bg-[#f4f5f7] p-4 rounded-2xl h-fit min-h-[500px]">
                    <div className="flex items-center justify-between px-2">
                      <h3 className="text-[11px] font-black uppercase tracking-widest text-slate-900/60">
                        {status === 'new' ? 'Novo' :
                         status === 'contacted' ? 'Contatado' :
                         status === 'negotiating' ? 'Negociando' :
                         status === 'closed' ? 'Fechado' : 'Perdido'}
                      </h3>
                      <span className="bg-white text-slate-900 text-[10px] font-black px-2 py-0.5 rounded-full shadow-sm">
                        {leads.filter(l => l.kanban_status === status).length}
                      </span>
                    </div>

                    <div className="space-y-3">
                      {leads.filter(l => l.kanban_status === status).map((lead) => (
                        <Card key={lead.id} className="p-5 cursor-pointer hover:shadow-lg transition-all group border-none shadow-sm bg-white">
                          <h4 className="font-bold text-sm">{lead.name}</h4>
                          <p className="text-[10px] text-slate-400 mt-1">{lead.address}</p>
                          <div className="mt-4 flex items-center justify-between">
                            <span className="text-[10px] font-mono text-slate-500">{lead.phone}</span>
                            <select
                              className="text-[10px] bg-slate-50 border border-slate-100 rounded p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                              value={lead.kanban_status}
                              onChange={(e) => lead.id && updateKanban(lead.id, e.target.value)}
                            >
                              <option value="new">Novo</option>
                              <option value="contacted">Contatado</option>
                              <option value="negotiating">Negociando</option>
                              <option value="closed">Fechado</option>
                              <option value="lost">Perdido</option>
                            </select>
                          </div>
                        </Card>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          )}

          {activeTab === 'settings' && (
            <motion.div
              key="settings"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              <header className="flex items-center justify-between">
                <div>
                  <h2 className="text-3xl font-bold">Configurações</h2>
                  <p className="text-slate-500">Gerencie seu time e credenciais de IA.</p>
                </div>
                <div className="flex bg-white p-1 rounded-xl border border-slate-200">
                  <button
                    onClick={() => setSettingsSubTab('credentials')}
                    className={cn(
                      "px-4 py-2 text-xs font-bold rounded-lg transition-all",
                      settingsSubTab === 'credentials' ? "bg-slate-50 text-slate-700" : "text-slate-500 hover:bg-slate-50"
                    )}
                  >
                    LLM & APIs
                  </button>
                  <button
                    onClick={() => setSettingsSubTab('team')}
                    className={cn(
                      "px-4 py-2 text-xs font-bold rounded-lg transition-all",
                      settingsSubTab === 'team' ? "bg-slate-50 text-slate-700" : "text-slate-500 hover:bg-slate-50"
                    )}
                  >
                    Membros do Time
                  </button>
                </div>
              </header>

              {settingsSubTab === 'credentials' ? (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                  <Card className="p-6 h-fit lg:col-span-1">
                    <h3 className="text-lg font-bold mb-4">Nova Credencial</h3>
                    <div className="space-y-4">
                      <div>
                        <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Provedor</label>
                        <select
                          className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none"
                          value={newCred.provider}
                          onChange={(e) => setNewCred({ ...newCred, provider: e.target.value })}
                        >
                          <option value="openai">OpenAI</option>
                          <option value="groq">Groq</option>
                          <option value="gemini">Google Gemini</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Nome Amigável</label>
                        <input
                          type="text"
                          placeholder="Ex: Minha Chave Principal"
                          className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none"
                          value={newCred.name}
                          onChange={(e) => setNewCred({ ...newCred, name: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">API Key</label>
                        <input
                          type="password"
                          placeholder="sk-..."
                          className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none"
                          value={newCred.api_key}
                          onChange={(e) => setNewCred({ ...newCred, api_key: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Modelo Padrão (Opcional)</label>
                        <input
                          type="text"
                          placeholder="Ex: gpt-4o, llama-3-70b"
                          className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none"
                          value={newCred.model_name}
                          onChange={(e) => setNewCred({ ...newCred, model_name: e.target.value })}
                        />
                      </div>
                      <button
                        onClick={createCredential}
                        className="w-full py-3 bg-primary text-white font-bold rounded-xl hover:bg-primary/90 transition-all flex items-center justify-center gap-2"
                      >
                        <Plus size={20} />
                        Salvar Credencial
                      </button>
                    </div>
                  </Card>

                  <div className="lg:col-span-2 space-y-4">
                    {['openai', 'groq', 'gemini'].map(provider => (
                      <div key={provider} className="space-y-2">
                        <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest px-2">{provider}</h4>
                        {credentials.filter(c => c.provider === provider).map((cred) => (
                          <Card key={cred.id} className="p-4 flex items-center justify-between">
                            <div className="flex items-center gap-4">
                              <div className={cn(
                                "w-10 h-10 rounded-xl flex items-center justify-center font-bold",
                                cred.is_active ? "bg-slate-50 text-primary" : "bg-slate-50 text-slate-400"
                              )}>
                                {cred.provider.charAt(0).toUpperCase()}
                              </div>
                              <div>
                                <h5 className="font-bold text-sm">{cred.name}</h5>
                                <p className="text-[10px] text-slate-400">{cred.model_name || 'Modelo não definido'}</p>
                              </div>
                            </div>
                            <div className="flex items-center gap-3">
                              {!cred.is_active && (
                                <button
                                  onClick={() => cred.id && activateCredential(cred.id, cred.provider)}
                                  className="text-xs font-bold text-primary hover:underline"
                                >
                                  Ativar
                                </button>
                              )}
                              {cred.is_active && (
                                <span className="text-[10px] bg-slate-100 text-slate-700 px-2 py-0.5 rounded-full font-bold">ATIVO</span>
                              )}
                              <button
                                onClick={() => cred.id && deleteCredential(cred.id)}
                                className="text-slate-300 hover:text-red-500 transition-colors"
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </Card>
                        ))}
                        {credentials.filter(c => c.provider === provider).length === 0 && (
                          <p className="text-[10px] text-slate-400 italic px-2">Nenhuma credencial configurada para {provider}.</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                  <Card className="p-6 h-fit lg:col-span-1">
                    <h3 className="text-lg font-bold mb-4">Novo Membro</h3>
                    <div className="space-y-4">
                      <div>
                        <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Nome</label>
                        <input
                          type="text"
                          placeholder="Nome completo"
                          className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none"
                          value={newMember.name}
                          onChange={(e) => setNewMember({ ...newMember, name: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Cargo</label>
                        <input
                          type="text"
                          placeholder="Ex: Vendedor, Gestor"
                          className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none"
                          value={newMember.role}
                          onChange={(e) => setNewMember({ ...newMember, role: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">E-mail</label>
                        <input
                          type="email"
                          placeholder="email@exemplo.com"
                          className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none"
                          value={newMember.email}
                          onChange={(e) => setNewMember({ ...newMember, email: e.target.value })}
                        />
                      </div>
                      <button
                        onClick={createMember}
                        className="w-full py-3 bg-primary text-white font-bold rounded-xl hover:bg-primary/90 transition-all flex items-center justify-center gap-2"
                      >
                        <Plus size={20} />
                        Adicionar ao Time
                      </button>
                    </div>
                  </Card>

                  <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-6">
                    {team.map((member) => (
                      <Card key={member.id} className="p-6 flex items-center justify-between">
                        <div className="flex items-center gap-4">
                          <div className="w-12 h-12 bg-slate-100 text-slate-500 rounded-full flex items-center justify-center font-bold">
                            {member.name.charAt(0)}
                          </div>
                          <div>
                            <h4 className="font-bold">{member.name}</h4>
                            <p className="text-xs text-slate-500">{member.role}</p>
                            <p className="text-[10px] text-slate-400 mt-1">{member.email}</p>
                          </div>
                        </div>
                        <button
                          onClick={() => member.id && deleteMember(member.id)}
                          className="text-slate-300 hover:text-red-500 transition-colors"
                        >
                          <Trash2 size={18} />
                        </button>
                      </Card>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'campaigns' && (
            <motion.div
              key="campaigns"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              <header>
                <h2 className="text-3xl font-bold">Campanhas</h2>
                <p className="text-slate-500">Configure automações de disparo e transição.</p>
              </header>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <Card className="p-6 h-fit lg:col-span-1">
                  <h3 className="text-lg font-bold mb-4">Nova Campanha</h3>
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Nome da Campanha</label>
                      <input
                        type="text"
                        placeholder="Ex: Lançamento Verão"
                        className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-slate-900/10"
                        value={newCampaign.name}
                        onChange={(e) => setNewCampaign({ ...newCampaign, name: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Agente IA Responsável</label>
                      <select
                        className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none"
                        value={newCampaign.agent_id}
                        onChange={(e) => setNewCampaign({ ...newCampaign, agent_id: Number(e.target.value) })}
                      >
                        <option value={0}>Selecione um Agente</option>
                        {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Método Inicial</label>
                      <select
                        className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none"
                        value={newCampaign.initial_method}
                        onChange={(e) => setNewCampaign({ ...newCampaign, initial_method: e.target.value as 'ai' | 'direct' })}
                      >
                        <option value="ai">IA (Assistente responde primeiro)</option>
                        <option value="direct">Direto (Apenas disparo de mensagem)</option>
                      </select>
                    </div>

                    <div className="pt-4 border-t border-slate-100">
                      <h4 className="text-xs font-bold text-slate-400 uppercase mb-3">Regras de Transição</h4>
                      <div className="space-y-3">
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase mb-1 block">Após primeira resposta</label>
                          <select
                            className="w-full px-3 py-1.5 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none"
                            value={newCampaign.transition_rules.after_first_response}
                            onChange={(e) => setNewCampaign({
                              ...newCampaign,
                              transition_rules: { ...newCampaign.transition_rules, after_first_response: e.target.value }
                            })}
                          >
                            <option value="continue_ai">Continuar com IA</option>
                            <option value="handoff">Handoff Humano Imediato</option>
                            <option value="pause">Pausar Automação</option>
                          </select>
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase mb-1 block">Em palavras-chave (Handoff)</label>
                          <input
                            type="text"
                            placeholder="Ex: falar com humano, ajuda, suporte"
                            className="w-full px-3 py-1.5 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none"
                            value={newCampaign.transition_rules.on_keyword}
                            onChange={(e) => setNewCampaign({
                              ...newCampaign,
                              transition_rules: { ...newCampaign.transition_rules, on_keyword: e.target.value }
                            })}
                          />
                        </div>
                      </div>
                    </div>

                    <button
                      onClick={createCampaign}
                      className="w-full py-3 bg-primary text-white font-bold rounded-xl hover:bg-primary/90 transition-all flex items-center justify-center gap-2 shadow-lg shadow-slate-200"
                    >
                      <Plus size={20} />
                      Criar Campanha
                    </button>
                  </div>
                </Card>

                <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-6">
                  {campaigns.map((campaign) => (
                    <Card key={campaign.id} className="p-6 flex flex-col">
                      <div className="flex items-start justify-between mb-4">
                        <div className="w-12 h-12 bg-slate-50 text-primary rounded-2xl flex items-center justify-center">
                          <MessageSquare size={24} />
                        </div>
                        <button
                          onClick={() => campaign.id && deleteCampaign(campaign.id)}
                          className="text-slate-300 hover:text-red-500 transition-colors"
                        >
                          <Trash2 size={18} />
                        </button>
                      </div>
                      <h4 className="text-xl font-bold mb-1">{campaign.name}</h4>
                      <div className="flex items-center gap-2 mb-4">
                        <span className={cn(
                          "text-[10px] font-bold px-2 py-0.5 rounded-full uppercase",
                          campaign.initial_method === 'ai' ? "bg-slate-100 text-slate-700" : "bg-slate-100 text-slate-700"
                        )}>
                          {campaign.initial_method === 'ai' ? 'IA Ativa' : 'Disparo Direto'}
                        </span>
                      </div>

                      <div className="space-y-3 mt-auto pt-4 border-t border-slate-50">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-slate-400">Agente:</span>
                          <span className="font-bold text-slate-700">
                            {agents.find(a => a.id === campaign.agent_id)?.name || 'Desconhecido'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-slate-400">Handoff:</span>
                          <span className="font-bold text-slate-700">
                            {campaign.transition_rules.on_keyword || 'Não configurado'}
                          </span>
                        </div>
                      </div>
                    </Card>
                  ))}
                  {campaigns.length === 0 && (
                    <div className="col-span-full py-12 text-center text-slate-400">
                      Nenhuma campanha configurada ainda.
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'super_admin' && auth.user.role === 'super_admin' && (
            <SuperAdminPanel apiFetch={apiFetch} onImpersonate={handleImpersonate} onLogout={handleLogout} onBackToAccount={() => setActiveTab('dashboard')} authUser={auth.user} />
          )}

          {activeTab === 'support' && (
            <motion.div
              key="support"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h2 className="text-3xl font-bold">Suporte WooAPI</h2>
                  <p className="text-slate-500">Agente de diagnostico primeiro, ticket humano quando precisar.</p>
                </div>
                <button onClick={fetchSupportTickets} className="flex items-center gap-2 rounded-md bg-slate-900 px-4 py-3 text-sm font-bold text-white hover:bg-primary">
                  <RefreshCw size={16} />
                  Atualizar tickets
                </button>
              </header>

              <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_380px]">
                <Card className="flex min-h-[620px] flex-col overflow-hidden">
                  <div className="border-b border-slate-100 p-5">
                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                      <div>
                        <h3 className="text-lg font-black text-slate-950">Web chat de suporte</h3>
                        <p className="text-sm text-slate-500">O agente consulta status e logs antes de escalar.</p>
                      </div>
                      <select
                        value={supportInstanceId}
                        onChange={(e) => setSupportInstanceId(e.target.value ? Number(e.target.value) : '')}
                        className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-bold"
                      >
                        <option value="">Todas as instancias</option>
                        {instances.map(inst => (
                          <option key={inst.id} value={inst.id}>{inst.name} - {instanceStatusLabel(inst.status)}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="flex-1 space-y-4 overflow-y-auto bg-slate-50 p-5">
                    {supportChatMessages.map((msg, index) => {
                      const isUser = msg.sender === 'customer';
                      const isHuman = msg.sender === 'human';
                      return (
                        <div key={`${msg.created_at}-${index}`} className={cn("flex", isUser ? "justify-end" : "justify-start")}>
                          <div className={cn(
                            "max-w-[82%] rounded-2xl px-4 py-3 shadow-sm",
                            isUser ? "bg-primary text-white" : isHuman ? "bg-slate-900 text-white" : "bg-white text-slate-700"
                          )}>
                            <div className="mb-1 flex items-center gap-2">
                              {!isUser && (isHuman ? <User size={14} /> : <Bot size={14} />)}
                              <span className="text-[10px] font-black uppercase opacity-70">{isUser ? 'voce' : isHuman ? 'humano' : 'agente'}</span>
                            </div>
                            <p className="whitespace-pre-wrap text-sm leading-relaxed">{msg.message}</p>
                            {msg.ticket && <p className="mt-2 text-xs font-black opacity-80">Ticket #{msg.ticket.id} aberto</p>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="border-t border-slate-100 bg-white p-4">
                    <div className="flex gap-3">
                      <input
                        value={supportInput}
                        onChange={(e) => setSupportInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            sendSupportChat();
                          }
                        }}
                        placeholder="Descreva o problema: conexao, envio, webhook, QR, delay..."
                        className="flex-1 rounded-xl border border-slate-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                      />
                      <button
                        onClick={sendSupportChat}
                        disabled={!supportInput.trim() || supportSending}
                        className="flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-black text-white disabled:opacity-50"
                      >
                        {supportSending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
                        Enviar
                      </button>
                    </div>
                  </div>
                </Card>

                <Card className="h-fit overflow-hidden">
                  <div className="border-b border-slate-100 p-5">
                    <h3 className="text-lg font-black text-slate-950">Meus tickets</h3>
                    <p className="text-sm text-slate-500">Chamados escalados para atendimento humano.</p>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {supportTickets.slice(0, 12).map(ticket => (
                      <div key={ticket.id} className="p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate font-black text-slate-900">#{ticket.id} {ticket.subject}</p>
                            <p className="text-xs text-slate-500">{ticket.source || 'suporte'} - {ticket.created_at ? new Date(ticket.created_at).toLocaleString('pt-BR') : ''}</p>
                          </div>
                          <span className={cn("shrink-0 rounded px-2 py-1 text-[10px] font-black uppercase", ticket.status === 'resolved' ? "bg-emerald-50 text-emerald-700" : ticket.priority === 'high' ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700")}>{ticket.status}</span>
                        </div>
                        {ticket.ai_summary && <p className="mt-2 text-xs text-slate-500">{ticket.ai_summary}</p>}
                      </div>
                    ))}
                    {supportTickets.length === 0 && <p className="py-12 text-center text-sm text-slate-400">Nenhum ticket aberto ainda.</p>}
                  </div>
                </Card>
              </div>
            </motion.div>
          )}

          {activeTab === 'wooapi_monitor' && (
            <motion.div
              key="wooapi_monitor"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h2 className="text-3xl font-bold">Central WooAPI</h2>
                  <p className="text-slate-500">Webhooks, eventos, logs de entrega e integrações da sua instância.</p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <select
                    className="min-w-[260px] rounded-md border border-slate-200 bg-white px-4 py-3 text-sm font-bold"
                    value={selectedWooInstance?.id || ''}
                    onChange={(e) => setSelectedWooInstanceId(Number(e.target.value))}
                  >
                    {instances.map(inst => (
                      <option key={inst.id} value={inst.id}>{inst.name} - {instanceStatusLabel(inst.status)}</option>
                    ))}
                  </select>
                  <button onClick={() => fetchWooApiPanel()} className="flex items-center gap-2 rounded-md bg-slate-900 px-4 py-3 text-sm font-bold text-white hover:bg-primary">
                    <RefreshCw size={16} />
                    Atualizar
                  </button>
                </div>
              </header>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
                {[
                  { label: 'Status', value: selectedWooInstance ? instanceStatusLabel(selectedWooInstance.status) : 'Sem instancia', icon: Smartphone },
                  { label: 'Webhooks ativos', value: instanceWebhooks.filter(h => h.is_active).length, icon: Webhook },
                  { label: 'Entregas OK', value: selectedWebhookSuccess, icon: CheckCircle2 },
                  { label: 'Falhas entrega', value: selectedWebhookFailures, icon: AlertCircle },
                  { label: 'Eventos salvos', value: webhookEvents.length, icon: FileText }
                ].map(({ label, value, icon: Icon }) => (
                  <Card key={label} className="p-5">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-black uppercase text-slate-400">{label}</p>
                      <Icon size={19} className="text-primary" />
                    </div>
                    <p className="mt-3 truncate text-2xl font-black text-slate-950">{typeof value === 'number' ? value : value}</p>
                  </Card>
                ))}
              </div>

              <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.1fr_1fr]">
                <Card className="overflow-hidden">
                  <div className="flex items-center justify-between border-b border-slate-100 p-5">
                    <div>
                      <h3 className="text-lg font-bold">Traffic Controller</h3>
                      <p className="text-sm text-slate-500">Limites globais, filas e protecao contra pico.</p>
                    </div>
                    <button onClick={assignSelectedInstance} disabled={!selectedWooInstanceId} className="flex items-center gap-2 rounded-md bg-slate-900 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">
                      <Server size={15} />
                      Assign
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-3 p-5 md:grid-cols-5">
                    {Object.entries(platformMonitor?.traffic_policy || {}).map(([key, value]) => (
                      <div key={key} className="rounded-md border border-slate-200 bg-slate-50 p-3">
                        <p className="text-[10px] font-black uppercase text-slate-400">{key.replace(/_/g, ' ')}</p>
                        <p className="mt-1 text-xl font-black text-slate-950">{displayNumber(value)}</p>
                      </div>
                    ))}
                    {!platformMonitor?.traffic_policy && <p className="col-span-full text-sm text-slate-400">Carregando politica...</p>}
                  </div>
                  <div className="border-t border-slate-100 p-5">
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                      <button onClick={() => transitionSelectedInstance('health_degraded')} disabled={!selectedWooInstanceId} className="rounded-md bg-amber-50 px-3 py-2 text-xs font-black text-amber-700 disabled:opacity-50">Marcar degradada</button>
                      <button onClick={() => transitionSelectedInstance('risk_elevated')} disabled={!selectedWooInstanceId} className="rounded-md bg-orange-50 px-3 py-2 text-xs font-black text-orange-700 disabled:opacity-50">Cooldown</button>
                      <button onClick={() => transitionSelectedInstance('manual_block')} disabled={!selectedWooInstanceId} className="rounded-md bg-red-50 px-3 py-2 text-xs font-black text-red-700 disabled:opacity-50">Bloquear</button>
                    </div>
                  </div>
                </Card>

                <Card className="overflow-hidden">
                  <div className="border-b border-slate-100 p-5">
                    <h3 className="text-lg font-bold">Filas</h3>
                    <p className="text-sm text-slate-500">Backlog por worker e DLQ.</p>
                  </div>
                  <div className="max-h-[290px] divide-y divide-slate-100 overflow-y-auto">
                    {(platformMonitor?.queues || []).map((queue: any) => (
                      <div key={queue.key} className="grid grid-cols-[1fr_auto] gap-3 p-4">
                        <div className="min-w-0">
                          <p className="truncate font-black text-slate-900">{queue.label}</p>
                          <p className="truncate font-mono text-[11px] text-slate-400">{queue.name}</p>
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-right text-[11px] font-bold">
                          <span className="text-slate-500">W {displayNumber(queue.waiting)}</span>
                          <span className="text-blue-600">A {displayNumber(queue.active)}</span>
                          <span className={displayNumber(queue.failed) ? "text-red-600" : "text-slate-500"}>F {displayNumber(queue.failed)}</span>
                        </div>
                      </div>
                    ))}
                    {(!platformMonitor?.queues || platformMonitor.queues.length === 0) && <p className="py-12 text-center text-sm text-slate-400">Sem dados de fila ainda.</p>}
                  </div>
                </Card>
              </div>

              <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                <Card className="overflow-hidden">
                  <div className="border-b border-slate-100 p-5">
                    <h3 className="text-lg font-bold">Core Nodes</h3>
                    <p className="text-sm text-slate-500">Capacidade, perfil, IP pool e drain mode.</p>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {(platformMonitor?.core_nodes || []).slice(0, 8).map((node: any) => (
                      <div key={node.id} className="p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate font-black text-slate-900">{node.id}</p>
                            <p className="text-xs text-slate-500">{node.region} - {node.profile} - {node.ip_pool_id}</p>
                          </div>
                          <button onClick={() => toggleNodeDrain(node)} className={cn("rounded px-3 py-2 text-xs font-black", Number(node.drain_mode || 0) ? "bg-amber-50 text-amber-700" : "bg-slate-900 text-white")}>
                            {Number(node.drain_mode || 0) ? 'Sair drain' : 'Drain'}
                          </button>
                        </div>
                        <div className="mt-3 grid grid-cols-4 gap-2 text-xs">
                          <span className="rounded bg-slate-50 px-2 py-1 font-bold text-slate-600">CPU {displayNumber(node.cpu_percent)}%</span>
                          <span className="rounded bg-slate-50 px-2 py-1 font-bold text-slate-600">RAM {displayNumber(node.memory_percent)}%</span>
                          <span className="rounded bg-slate-50 px-2 py-1 font-bold text-slate-600">{displayNumber(node.active_instances)}/{displayNumber(node.max_instances)}</span>
                          <span className={cn("rounded px-2 py-1 font-bold", node.status === 'ACTIVE' ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700")}>{node.status}</span>
                        </div>
                      </div>
                    ))}
                    {(!platformMonitor?.core_nodes || platformMonitor.core_nodes.length === 0) && <p className="py-12 text-center text-sm text-slate-400">Nenhum core node registrado.</p>}
                  </div>
                </Card>

                <Card className="overflow-hidden">
                  <div className="border-b border-slate-100 p-5">
                    <h3 className="text-lg font-bold">Reputacao e Risco</h3>
                    <p className="text-sm text-slate-500">Scores por numero, tenant e node/IP.</p>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {(platformMonitor?.reputation || []).slice(0, 10).map((item: any) => (
                      <div key={`${item.scope}-${item.subject_id}`} className="flex items-center justify-between gap-3 p-4">
                        <div className="min-w-0">
                          <p className="truncate font-black text-slate-900">{item.subject_id}</p>
                          <p className="text-xs uppercase text-slate-400">{item.scope}</p>
                        </div>
                        <span className={cn("rounded px-3 py-1 text-xs font-black", displayNumber(item.score, 100) >= 90 ? "bg-emerald-50 text-emerald-700" : displayNumber(item.score, 100) >= 70 ? "bg-blue-50 text-blue-700" : displayNumber(item.score, 100) >= 40 ? "bg-amber-50 text-amber-700" : "bg-red-50 text-red-700")}>
                          {displayNumber(item.score, 100)}
                        </span>
                      </div>
                    ))}
                    {(!platformMonitor?.reputation || platformMonitor.reputation.length === 0) && <p className="py-12 text-center text-sm text-slate-400">Reputacao sera calculada apos eventos de envio/monitoramento.</p>}
                  </div>
                </Card>
              </div>

              <div className="grid grid-cols-1 gap-6 xl:grid-cols-[380px_1fr]">
                <Card className="p-6 h-fit">
                  <h3 className="mb-4 text-lg font-bold">Novo Webhook</h3>
                  <div className="space-y-4">
                    <div>
                      <label className="mb-1 block text-xs font-black uppercase text-slate-400">Nome</label>
                      <input className="w-full rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-sm" value={newWebhook.name} onChange={(e) => setNewWebhook({ ...newWebhook, name: e.target.value })} />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-black uppercase text-slate-400">URL</label>
                      <input className="w-full rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-sm" placeholder="https://n8n.cliente.com/webhook/wooapi" value={newWebhook.url} onChange={(e) => setNewWebhook({ ...newWebhook, url: e.target.value })} />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-black uppercase text-slate-400">Eventos</label>
                      <textarea rows={3} className="w-full resize-none rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-sm" value={newWebhook.events} onChange={(e) => setNewWebhook({ ...newWebhook, events: e.target.value })} />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold">
                        <input type="checkbox" checked={newWebhook.retry_enabled} onChange={(e) => setNewWebhook({ ...newWebhook, retry_enabled: e.target.checked })} />
                        Retry
                      </label>
                      <input type="number" min={1} max={20} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" value={newWebhook.max_attempts} onChange={(e) => setNewWebhook({ ...newWebhook, max_attempts: Number(e.target.value) })} />
                    </div>
                    <button onClick={createWebhook} disabled={!selectedWooInstance || !newWebhook.url} className="flex w-full items-center justify-center gap-2 rounded-md bg-primary py-3 text-sm font-bold text-white disabled:opacity-50">
                      <Plus size={18} />
                      Criar webhook
                    </button>
                  </div>
                </Card>

                <Card className="overflow-hidden">
                  <div className="border-b border-slate-100 p-5">
                    <h3 className="text-lg font-bold">Webhooks da Instância</h3>
                    <p className="text-sm text-slate-500">Cada webhook é assinado por HMAC e entregue via fila.</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[820px] text-left text-sm">
                      <thead className="bg-slate-50 text-[11px] font-black uppercase text-slate-400">
                        <tr>
                          <th className="px-5 py-3">Webhook</th>
                          <th className="px-5 py-3">URL</th>
                          <th className="px-5 py-3">Eventos</th>
                          <th className="px-5 py-3">Status</th>
                          <th className="px-5 py-3">Ações</th>
                        </tr>
                      </thead>
                      <tbody>
                        {instanceWebhooks.map((hook) => (
                          <tr key={hook.id} className="border-t border-slate-100">
                            <td className="px-5 py-4">
                              <p className="font-black">{hook.name}</p>
                              <p className="text-[11px] text-slate-400">max {hook.max_attempts} tentativas</p>
                            </td>
                            <td className="max-w-[260px] truncate px-5 py-4 font-mono text-xs text-slate-500">{hook.url}</td>
                            <td className="px-5 py-4">
                              <div className="flex max-w-[260px] flex-wrap gap-1">
                                {(hook.events || []).slice(0, 3).map((event: string) => (
                                  <span key={event} className="rounded bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600">{event}</span>
                                ))}
                                {(hook.events || []).length === 0 && <span className="rounded bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600">todos</span>}
                              </div>
                            </td>
                            <td className="px-5 py-4">
                              <span className={cn("rounded px-2 py-1 text-[10px] font-black", hook.is_active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500")}>{hook.is_active ? 'ATIVO' : 'PAUSADO'}</span>
                            </td>
                            <td className="px-5 py-4">
                              <div className="flex flex-wrap gap-2">
                                <button onClick={() => testWebhook(hook)} className="rounded-md bg-slate-900 px-3 py-2 text-xs font-bold text-white">Testar</button>
                                <button onClick={() => toggleWebhook(hook)} className="rounded-md bg-slate-100 px-3 py-2 text-xs font-bold text-slate-700">{hook.is_active ? 'Pausar' : 'Ativar'}</button>
                                <button onClick={() => deleteWebhook(hook)} className="rounded-md bg-red-50 px-3 py-2 text-xs font-bold text-red-600">Excluir</button>
                              </div>
                            </td>
                          </tr>
                        ))}
                        {instanceWebhooks.length === 0 && (
                          <tr><td colSpan={5} className="px-5 py-12 text-center text-sm text-slate-400">Nenhum webhook cadastrado para esta instância.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </Card>
              </div>

              <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                <Card className="overflow-hidden">
                  <div className="border-b border-slate-100 p-5">
                    <h3 className="text-lg font-bold">Logs de Entrega</h3>
                    <p className="text-sm text-slate-500">Tentativas reais feitas pelo worker de webhook.</p>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {webhookLogs.slice(0, 12).map((log) => (
                      <div key={log.id} className="p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-black text-slate-900">{log.event}</p>
                            <p className="text-xs text-slate-500">{log.webhook_name || 'Webhook'} · tentativa {log.attempt} · HTTP {log.status_code || '-'}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            {!log.success && <button onClick={() => retryWebhookLog(log.id)} className="rounded bg-slate-900 px-2 py-1 text-[10px] font-black text-white">Reenviar</button>}
                            <span className={cn("rounded px-2 py-1 text-[10px] font-black", log.success ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700")}>{log.success ? 'OK' : 'FALHA'}</span>
                          </div>
                        </div>
                        <p className="mt-2 truncate font-mono text-[11px] text-slate-400">{log.url}</p>
                        {log.error && <p className="mt-1 text-xs font-bold text-red-600">{log.error}</p>}
                      </div>
                    ))}
                    {webhookLogs.length === 0 && <p className="py-12 text-center text-sm text-slate-400">Nenhuma tentativa registrada ainda.</p>}
                  </div>
                </Card>

                <Card className="overflow-hidden">
                  <div className="border-b border-slate-100 p-5">
                    <h3 className="text-lg font-bold">Eventos WooAPI</h3>
                    <p className="text-sm text-slate-500">Eventos normalizados que geram entregas e integrações.</p>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {webhookEvents.slice(0, 12).map((event) => (
                      <div key={event.id} className="flex items-center justify-between gap-3 p-4">
                        <div>
                          <p className="font-black text-slate-900">{event.event}</p>
                          <p className="text-xs text-slate-500">{event.created_at}</p>
                        </div>
                        <span className={cn("rounded px-2 py-1 text-[10px] font-black", event.status === 'delivered' ? "bg-emerald-50 text-emerald-700" : event.status === 'failed' ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700")}>{event.status}</span>
                      </div>
                    ))}
                    {webhookEvents.length === 0 && <p className="py-12 text-center text-sm text-slate-400">Nenhum evento registrado ainda.</p>}
                  </div>
                </Card>
              </div>

              <Card className="p-6">
                <h3 className="mb-4 text-lg font-bold">Integrações prontas para copiar</h3>
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                  {[
                    ['n8n', 'Webhook Node recebe eventos WooAPI; HTTP Request responde usando a API key da instância.'],
                    ['Typebot', 'HTTP Request chama /api/v1/messages/send-text com variáveis como {{telefone}} e {{nome}}.'],
                    ['Chatwoot', 'Callback envia respostas para WooAPI; sincronização fica em fila dedicada.']
                  ].map(([title, text]) => (
                    <div key={title} className="rounded-md border border-slate-200 bg-slate-50 p-4">
                      <p className="font-black text-slate-900">{title}</p>
                      <p className="mt-2 text-sm text-slate-500">{text}</p>
                    </div>
                  ))}
                </div>
              </Card>

              <Card className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-lg font-bold">Mensagens ao Vivo</h3>
                    <p className="text-sm text-slate-500">Feed em tempo real das mensagens que chegam e saem nesta instancia.</p>
                  </div>
                  <button onClick={() => setLiveMessages([])} className="rounded-md bg-slate-100 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-red-100 hover:text-red-600">
                    Limpar
                  </button>
                </div>
                <div className="h-80 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50">
                  {liveMessages.length === 0 ? (
                    <div className="flex h-full items-center justify-center">
                      <p className="text-sm text-slate-400">Aguardando mensagens em tempo real...</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-200">
                      {liveMessages.map((msg, idx) => {
                        const isInbound = msg.direction === 'inbound' || msg.from_me === 0;
                        return (
                          <div key={msg.message_id || idx} className="flex items-start gap-3 px-4 py-3 hover:bg-white/80 transition-colors">
                            <div className={cn(
                              "mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-black text-white",
                              isInbound ? "bg-emerald-500" : "bg-blue-500"
                            )}>
                              {isInbound ? 'IN' : 'OUT'}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-2">
                                <p className="truncate text-xs font-bold text-slate-900">
                                  {isInbound ? (msg.author_push_name || msg.author_phone || msg.from || 'Desconhecido') : (msg.to || 'Desconhecido')}
                                </p>
                                <span className="shrink-0 text-[10px] text-slate-400">
                                  {msg.receivedAt ? new Date(msg.receivedAt).toLocaleTimeString('pt-BR') : ''}
                                </span>
                              </div>
                              <p className="mt-0.5 truncate text-sm text-slate-600">
                                {msg.content_type === 'text' ? (msg.content_text || msg.text || '') : `[${msg.content_type || 'media'}]`}
                              </p>
                              {msg.delivery_status && (
                                <span className={cn(
                                  "mt-1 inline-block rounded px-1.5 py-0.5 text-[9px] font-bold uppercase",
                                  msg.delivery_status === 'received' || msg.delivery_status === 'sent' ? "bg-emerald-50 text-emerald-700" :
                                  msg.delivery_status === 'failed' ? "bg-red-50 text-red-700" : "bg-slate-100 text-slate-500"
                                )}>
                                  {msg.delivery_status}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </Card>
            </motion.div>
          )}

          {activeTab === 'whatsapp' && (
            <motion.div
              key="whatsapp"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              <header className="flex items-center justify-between">
                <div>
                  <h2 className="text-3xl font-bold">Instâncias API</h2>
                  <p className="text-slate-500">Gerencie suas instâncias WhatsApp com API key, webhook e websocket próprios.</p>
                </div>
                <button
                  onClick={() => {
                    const name = prompt("Nome da nova instância:");
                    if (name) createInstance(name, 'wooapi');
                  }}
                  className="px-6 py-3 bg-primary text-white font-bold rounded-xl hover:bg-primary/90 transition-all flex items-center gap-2 shadow-lg shadow-slate-200"
                >
                  <Plus size={20} />
                  Nova Instância
                </button>
              </header>

              <Card className="p-5">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-6">
                  {[
                    ['1', 'Crie a instância'],
                    ['2', 'Leia o QR Code'],
                    ['3', 'Copie a API key'],
                    ['4', 'Configure o webhook'],
                    ['5', 'Teste envio'],
                    ['6', 'Integre n8n, Typebot ou Chatwoot']
                  ].map(([step, label]) => (
                    <div key={step} className="flex items-center gap-3 rounded-md border border-slate-100 bg-slate-50 p-3">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-black text-white">{step}</span>
                      <span className="text-xs font-bold text-slate-700">{label}</span>
                    </div>
                  ))}
                </div>
              </Card>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {instances.map((inst) => {
                  const connectedPhone = inst.phoneConnected || inst.phone_connected || inst.phone || '';
                  const profileName = inst.profileName || inst.profile_name || '';
                  const profilePictureUrl = inst.profilePictureUrl || inst.profile_picture_url || '';
                  return (
                  <Card key={inst.id} className="p-6 flex flex-col border-t-4 border-t-primary shadow-lg shadow-slate-100">
                    <div className="flex items-start justify-between mb-6">
                      <div className={cn(
                        "w-12 h-12 rounded-2xl flex items-center justify-center overflow-hidden",
                        isConnectedStatus(inst.status) ? "bg-primary text-white" :
                        isQrStatus(inst.status) ? "bg-amber-50 text-amber-600" : "bg-slate-50 text-slate-400"
                      )}>
                        {profilePictureUrl ? (
                          <img src={profilePictureUrl} alt={profileName || inst.name} className="w-full h-full object-cover" />
                        ) : isConnectedStatus(inst.status) ? <CheckCircle2 size={24} /> : <Smartphone size={24} />}
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => deleteInstance(inst.id)}
                          className="p-2 text-slate-300 hover:text-red-500 transition-colors"
                        >
                          <Trash2 size={18} />
                        </button>
                      </div>
                    </div>

                    <div className="flex-1">
                      <h4 className="text-xl font-bold mb-1">{inst.name}</h4>
                      {(profileName || connectedPhone) && (
                        <p className="text-xs text-slate-500 mb-3">
                          {profileName || 'WhatsApp'} {connectedPhone ? `+${connectedPhone}` : ''}
                        </p>
                      )}
                      <div className="flex items-center gap-2 mb-4">
                        <span className={cn(
                          "px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider",
                          isConnectedStatus(inst.status) ? "bg-primary text-white" :
                          isQrStatus(inst.status) ? "bg-amber-100 text-amber-700" :
                          inst.status === 'connecting' ? "bg-slate-100 text-slate-700" : "bg-slate-100 text-slate-500"
                        )}>
                          {instanceStatusLabel(inst.status)}
                        </span>
                        {connectedPhone && (
                          <span className="text-xs font-mono text-primary font-bold">+{connectedPhone}</span>
                        )}
                      </div>

                      {isQrStatus(inst.status) && inst.qr ? (
                        <button
                          type="button"
                          onClick={() => setQrModalInstance(inst)}
                          className="mt-4 p-4 bg-white border-2 border-slate-200 rounded-2xl flex flex-col items-center gap-4 w-full hover:border-slate-300 transition-colors"
                        >
                           <img src={inst.qr} alt="QR Code" className="w-48 h-48" />
                           <p className="text-[10px] text-primary font-bold text-center px-4">
                              Escaneie com seu WhatsApp para conectar
                           </p>
                        </button>
                      ) : isConnectedStatus(inst.status) ? (
                        <div className="mt-4 flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                          <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-emerald-600 text-white">
                            {profilePictureUrl ? (
                              <img src={profilePictureUrl} alt={profileName || inst.name} className="h-full w-full object-cover" />
                            ) : (
                              <Smartphone size={22} />
                            )}
                          </div>
                          <div className="min-w-0 text-left">
                            <p className="truncate text-sm font-black text-slate-900">{profileName || 'WhatsApp conectado'}</p>
                            <p className="truncate font-mono text-xs font-bold text-emerald-700">
                              {connectedPhone ? `+${connectedPhone}` : 'Numero sincronizando...'}
                            </p>
                          </div>
                        </div>
                      ) : isDisconnectedStatus(inst.status) ? (
                        <button
                          onClick={() => connectInstance(inst.id)}
                          className="mt-4 w-full py-3 bg-primary text-white font-bold rounded-xl hover:bg-primary/90 transition-all shadow-md shadow-slate-200"
                        >
                          Gerar QR Code
                        </button>
                      ) : null}
                      {(inst.webhook?.webhooks_url || inst.webhook_endpoint) && (
                        <div className="mt-4 rounded-md border border-slate-100 bg-slate-50 px-3 py-2">
                          <p className="text-[10px] font-black uppercase text-slate-400">Webhook proprio</p>
                          <p className="mt-1 truncate font-mono text-xs text-slate-600">
                            {inst.webhook?.webhooks_url || inst.webhook_endpoint}
                          </p>
                        </div>
                      )}
                    </div>

                    {isConnectedStatus(inst.status) && (
                      <button
                        onClick={() => logoutInstance(inst.id)}
                        className="mt-6 text-sm font-bold text-red-600 hover:underline"
                      >
                        Desconectar
                      </button>
                    )}
                    <div className="mt-5 grid grid-cols-2 gap-2 border-t border-slate-100 pt-4 sm:grid-cols-4">
                      <button
                        onClick={() => copyInstanceApiKey(inst.api_key)}
                        className="rounded-md bg-slate-100 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-200"
                      >
                        Copiar API key
                      </button>
                      <button
                        onClick={() => copyInstanceWebhook(inst)}
                        className="rounded-md bg-slate-100 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-200"
                      >
                        Copiar webhook
                      </button>
                      <button
                        onClick={() => regenerateInstanceApiKey(inst.id)}
                        className="rounded-md bg-slate-900 px-3 py-2 text-xs font-bold text-white hover:bg-primary"
                      >
                        Regenerar key
                      </button>
                      <button
                        onClick={() => setTesterInstance(inst)}
                        className="rounded-md bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700 hover:bg-emerald-100"
                      >
                        <Bug size={12} className="inline mr-1" /> Testar
                      </button>
                    </div>
                  </Card>
                  );
                })}
                {instances.length === 0 && (
                  <div className="col-span-full py-20 text-center border-2 border-dashed border-slate-200 rounded-3xl">
                    <div className="w-16 h-16 bg-slate-50 text-slate-300 rounded-full flex items-center justify-center mx-auto mb-4">
                      <QrCode size={32} />
                    </div>
                    <h3 className="text-lg font-bold text-slate-800">Nenhuma instância</h3>
                    <p className="text-slate-500 mt-2">Clique em "Nova Instância" para começar.</p>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <AnimatePresence>
        {qrModalInstance && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="bg-white w-full max-w-md rounded-3xl shadow-2xl overflow-hidden"
            >
              <div className="p-8 text-center space-y-6">
                <div className="flex justify-between items-center">
                  <h3 className="text-xl font-bold text-slate-800">Conectar WhatsApp</h3>
                  <button
                    onClick={() => setQrModalInstance(null)}
                    className="p-2 hover:bg-slate-100 rounded-full text-slate-400 transition-colors"
                  >
                    <XCircle size={24} />
                  </button>
                </div>

                <div className="py-4 flex flex-col items-center gap-6">
                  {isQrStatus(qrModalInstance.status) && qrModalInstance.qr ? (
                    <div className="bg-white p-4 rounded-2xl border-4 border-slate-200 shadow-inner">
                      <img src={qrModalInstance.qr} alt="QR Code" className="w-64 h-64" />
                    </div>
                  ) : (
                    <div className="w-64 h-64 bg-slate-50 rounded-2xl flex flex-col items-center justify-center gap-4 text-slate-400">
                      <RefreshCw className="animate-spin" size={48} />
                      <p className="text-sm font-medium">Gerando QR Code...</p>
                    </div>
                  )}

                  <div className="space-y-2">
                    <p className="text-lg font-bold text-slate-900">
                      {qrModalInstance.name}
                    </p>
                    <div className="flex items-center justify-center gap-2">
                       <div className={cn(
                         "w-2 h-2 rounded-full animate-pulse",
                         isQrStatus(qrModalInstance.status) ? "bg-amber-500" : "bg-primary"
                       )} />
                       <p className="text-sm text-slate-500 font-medium">
                         {isQrStatus(qrModalInstance.status) ? 'Escaneie agora' : 'Iniciando conexão...'}
                       </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => connectInstance(qrModalInstance.id)}
                    className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-bold text-white hover:bg-primary transition-colors"
                  >
                    <RefreshCw size={16} />
                    Gerar novo QR
                  </button>
                </div>

                <div className="bg-slate-50 p-4 rounded-2xl">
                   <p className="text-xs text-slate-700 font-medium leading-relaxed">
                     Abra o WhatsApp no seu celular {'>'} Aparelhos conectados {'>'} Conectar um aparelho e aponte a câmera para o código acima.
                   </p>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {testerInstance && (
          <InstanceTester
            instance={testerInstance}
            apiFetch={apiFetch}
            onClose={() => setTesterInstance(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
